import Foundation
import UIKit
import WebKit

/// Runs .py scripts with Pyodide (CPython compiled to WebAssembly) in a hidden WKWebView.
/// iOS does not let an app load native code it downloads, but WebAssembly is not native code,
/// so Python and compiled packages (numpy, pandas…) can be fetched on first use and kept on disk.
///
/// One web view serves every run, one at a time, so packages imported once stay loaded. A run
/// talks to Scriptor's API through a script engine run of its own (the same host bridge the
/// .jsx miniapps use). Stopping a run tears the web view down, the only way to stop Python
/// stuck in a loop; the next run loads it again.
final class PythonEngine: NSObject, WKScriptMessageHandler, WKUIDelegate {
  static let shared = PythonEngine()

  struct Job {
    let id: String
    let name: String
    let source: String
    let input: [String: Any]
    let repl: Bool
    let onLogs: ([[String: Any]]) -> Void
    let onFinish: (String?, String?) -> Void
    var host: ScriptRun?
    var logs: [[String: Any]] = []
    var flushScheduled = false
  }

  private var web: WKWebView?
  private var loaded = false
  /// Messages wait here until the page's script is running, then in the page until Pyodide is ready.
  private var pageReady = false
  private var outbox: [[String: Any]] = []
  private var jobs: [String: Job] = [:]
  private let files = PythonFiles()

  // MARK: Runs (main thread)

  /// Runs `source` as a script (`repl` false) or as a line in the terminal session `id`
  /// (`repl` true: globals persist between lines and a last expression is printed).
  func run(id: String, name: String, source: String, input: [String: Any], repl: Bool, session: String? = nil,
           onLogs: @escaping ([[String: Any]]) -> Void, onFinish: @escaping (String?, String?) -> Void) {
    DispatchQueue.main.async { [self] in
      var job = Job(id: id, name: name, source: source, input: input, repl: repl, onLogs: onLogs, onFinish: onFinish)
      job.host = makeHost(for: id, name: name)
      jobs[id] = job
      ensureWebView()
      if !loaded { log(id, "info", "Preparando Python…") }
      send([
        "type": "run", "run": id, "name": name, "code": source, "repl": repl, "session": session ?? id,
        "args": JSONSerialization.isValidJSONObject(input) ? input : [:],
      ])
    }
  }

  func isRunning(_ id: String) -> Bool {
    if Thread.isMainThread { return jobs[id] != nil }
    return DispatchQueue.main.sync { jobs[id] != nil }
  }

  /// Stops the run `id`. Python cannot be interrupted inside the page, so the page goes, and
  /// any other run waiting in it ends too.
  func stop(_ id: String) {
    DispatchQueue.main.async { [self] in
      guard jobs[id] != nil else { return }
      teardown()
      for other in Array(jobs.keys) where other != id { finish(other, error: "Python se reinició al detener otro script.") }
      finish(id, error: "Stopped")
    }
  }

  private func finish(_ id: String, result: String? = nil, error: String? = nil) {
    guard var job = jobs.removeValue(forKey: id) else { return }
    if let error, error != "Stopped" { job.logs.append(entry("error", error)) }
    if !job.logs.isEmpty { job.onLogs(job.logs) }
    job.host?.stop()
    job.host = nil
    job.onFinish(result, error)
  }

  private func entry(_ level: String, _ text: String) -> [String: Any] {
    let message = text.count > 20_000 ? String(text.prefix(20_000)) + "… (truncated)" : text
    return ["level": level, "message": message, "time": Date().timeIntervalSince1970 * 1000]
  }

  private func log(_ id: String, _ level: String, _ text: String) {
    guard jobs[id] != nil else { return }
    jobs[id]!.logs.append(entry(level, text))
    if jobs[id]!.logs.count >= 200 { flush(id); return }
    guard !jobs[id]!.flushScheduled else { return }
    jobs[id]!.flushScheduled = true
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(50)) { [weak self] in self?.flush(id) }
  }

  private func flush(_ id: String) {
    guard var job = jobs[id] else { return }
    job.flushScheduled = false
    let batch = job.logs
    job.logs.removeAll()
    jobs[id] = job
    if !batch.isEmpty { job.onLogs(batch) }
  }

  /// The script engine run that answers this Python run's calls to Scriptor's API.
  private func makeHost(for id: String, name: String) -> ScriptRun {
    let host = ScriptRun(
      id: id + "-host", name: name, source: "await new Promise(() => {});", input: [:],
      onLogs: { [weak self] logs in
        DispatchQueue.main.async {
          for log in logs { self?.log(id, log["level"] as? String ?? "log", log["message"] as? String ?? "") }
        }
      },
      onFinish: { _, _, _ in }
    )
    host.onHost = { [weak self] message in
      DispatchQueue.main.async { self?.send(["type": "reply", "run": id, "reply": message]) }
    }
    host.start()
    return host
  }

  // MARK: Web view

  private func ensureWebView() {
    guard web == nil else { return }
    let config = WKWebViewConfiguration()
    config.setURLSchemeHandler(files, forURLScheme: PythonFiles.scheme)
    config.userContentController.add(WeakHandler(self), name: "py")
    let saved = (try? String(contentsOf: PythonFiles.lockFile, encoding: .utf8)) ?? "null"
    let boot = "window.__savedLock = \(saved.isEmpty ? "null" : saved);"
    config.userContentController.addUserScript(WKUserScript(source: boot, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: config)
    view.uiDelegate = self
    view.isUserInteractionEnabled = false
    view.alpha = 0
    // Attached to a window so iOS keeps its JavaScript running at full speed.
    Presenter.topController()?.view.window?.addSubview(view)
    view.load(URLRequest(url: URL(string: "\(PythonFiles.scheme)://app/index.html")!))
    web = view
    loaded = false
  }

  private func teardown() {
    web?.configuration.userContentController.removeScriptMessageHandler(forName: "py")
    web?.stopLoading()
    web?.removeFromSuperview()
    web = nil
    loaded = false
    pageReady = false
    outbox.removeAll()
  }

  private func send(_ message: [String: Any]) {
    guard pageReady else { return outbox.append(message) }
    guard let web, let data = try? JSONSerialization.data(withJSONObject: message),
          let json = String(data: data, encoding: .utf8) else { return }
    web.evaluateJavaScript("__dispatch(\(json));", completionHandler: nil)
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    let run = body["run"] as? String ?? ""
    switch type {
    case "page":
      pageReady = true
      let waiting = outbox
      outbox.removeAll()
      waiting.forEach(send)
    case "ready":
      loaded = true
    case "loadFailed":
      // Without Python nothing can run: every waiting run ends with the reason.
      let reason = body["message"] as? String ?? "No se pudo cargar Python."
      teardown()
      for id in Array(jobs.keys) { finish(id, error: reason) }
    case "log":
      log(run, body["level"] as? String ?? "log", body["text"] as? String ?? "")
    case "call":
      guard let host = jobs[run]?.host, let id = body["id"] as? Int else { return }
      host.invoke("__hostCall", id, ["path": body["path"] as? String ?? "", "args": body["args"] as? String ?? "[]"])
    case "done":
      flush(run)
      finish(run, result: body["result"] as? String, error: body["error"] as? String)
    case "saveLock":
      if let text = body["lock"] as? String {
        try? FileManager.default.createDirectory(at: PythonFiles.root, withIntermediateDirectories: true)
        try? text.write(to: PythonFiles.lockFile, atomically: true, encoding: .utf8)
      }
    default:
      break
    }
  }

  // input() asks with window.prompt; it becomes an alert with a text field.
  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    let alert = UIAlertController(title: nil, message: prompt.isEmpty ? "Entrada" : prompt, preferredStyle: .alert)
    alert.addTextField { $0.text = defaultText }
    alert.addAction(UIAlertAction(title: "Cancelar", style: .cancel) { _ in completionHandler(nil) })
    alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text ?? "") })
    guard let top = Presenter.topController() else { return completionHandler(nil) }
    top.present(alert, animated: true)
  }
}

/// The page's message handler without a retain cycle through the web view's configuration.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
  weak var target: WKScriptMessageHandler?
  init(_ target: WKScriptMessageHandler) { self.target = target }
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(controller, didReceive: message)
  }
}

/// Serves the page, Pyodide and package wheels to the web view from Library/python, and
/// downloads what is missing once: Pyodide from jsDelivr, PyPI wheels from files.pythonhosted.org.
final class PythonFiles: NSObject, WKURLSchemeHandler {
  static let scheme = "scriptor-py"
  static let version = "0.29.3"
  static var root: URL { Paths.library.appendingPathComponent("python", isDirectory: true) }
  /// What `pip install` left installed, as a Pyodide lockfile (micropip.freeze()).
  static var lockFile: URL { root.appendingPathComponent("lock-\(version).json") }
  private static var cdn: URL { root.appendingPathComponent("pyodide-\(version)", isDirectory: true) }
  private static var wheels: URL { root.appendingPathComponent("wheels", isDirectory: true) }

  private var stopped = Set<ObjectIdentifier>()

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url else { return }
    let path = url.path
    if path == "/index.html" {
      return respond(task, Data(PythonPage.html.utf8), type: "text/html")
    }
    if path.hasPrefix("/cdn/") {
      let file = String(path.dropFirst(5))
      guard !file.contains(".."), !file.isEmpty else { return fail(task, 404) }
      let remote = URL(string: "https://cdn.jsdelivr.net/pyodide/v\(Self.version)/full/\(file)")!
      return serve(task, local: Self.cdn.appendingPathComponent(file), remote: remote)
    }
    if path.hasPrefix("/cache/") {
      let encoded = String(url.absoluteString.split(separator: "/cache/", maxSplits: 1).last ?? "")
      guard let raw = encoded.removingPercentEncoding, let remote = URL(string: raw),
            remote.scheme == "https", remote.host == "files.pythonhosted.org" else { return fail(task, 404) }
      return serve(task, local: Self.wheels.appendingPathComponent(remote.lastPathComponent), remote: remote)
    }
    fail(task, 404)
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
    stopped.insert(ObjectIdentifier(task))
  }

  private func serve(_ task: WKURLSchemeTask, local: URL, remote: URL) {
    if let data = try? Data(contentsOf: local, options: .mappedIfSafe) {
      return respond(task, data, type: Self.mime(local.pathExtension))
    }
    URLSession.shared.dataTask(with: remote) { [weak self] data, response, _ in
      DispatchQueue.main.async {
        guard let self else { return }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard let data, status == 200 else { return self.fail(task, status == 0 ? 502 : status) }
        try? FileManager.default.createDirectory(at: local.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: local, options: .atomic)
        self.respond(task, data, type: Self.mime(local.pathExtension))
      }
    }.resume()
  }

  private func respond(_ task: WKURLSchemeTask, _ data: Data, type: String, status: Int = 200) {
    guard !stopped.contains(ObjectIdentifier(task)), let url = task.request.url else { return }
    let headers = ["Content-Type": type, "Content-Length": "\(data.count)", "Access-Control-Allow-Origin": "*"]
    task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
    task.didReceive(data)
    task.didFinish()
  }

  private func fail(_ task: WKURLSchemeTask, _ status: Int) {
    respond(task, Data("HTTP \(status)".utf8), type: "text/plain", status: status)
  }

  private static func mime(_ ext: String) -> String {
    switch ext.lowercased() {
    case "wasm": return "application/wasm"
    case "js", "mjs": return "text/javascript"
    case "json": return "application/json"
    case "html": return "text/html"
    default: return "application/octet-stream"
    }
  }
}
