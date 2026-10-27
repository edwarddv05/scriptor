import Foundation
import UIKit
import WebKit

/// Scriptable's WebView: a WKWebView a script can load, evaluate JavaScript in and present.
/// Everything here runs on the main thread; handlers hop there before touching a view.
enum WebAPI {
  /// Keyed by "<run id>#<view id>". Main thread only.
  private static var views: [String: ScriptWeb] = [:]
  private static var nextId = 1
  private static let idLock = NSLock()

  private static func view(_ run: ScriptRun, _ id: Int) throws -> ScriptWeb {
    guard let web = views["\(run.id)#\(id)"] else { throw ScriptError("WebView is gone") }
    return web
  }

  /// Registers an async handler. `prepare` reads the arguments on the run's queue (JSValues must
  /// not be touched from main); `body` then runs on main with the view. The call is tracked so
  /// shouldAllowRequest events can be sent to it.
  private static func handle<P>(
    _ r: NativeRegistry, _ name: String, _ prepare: @escaping (Args) throws -> P,
    _ body: @escaping @MainActor (ScriptWeb, P, @escaping Completion) -> Void
  ) {
    r.async(name) { run, a, done in
      let id = a.int(0, 0)
      let callId = a.callId
      let params: P
      do { params = try prepare(a) } catch { return done(.failure(error)) }
      DispatchQueue.main.async {
        do {
          let web = try view(run, id)
          web.eventCalls.append(callId)
          body(web, params) { result in
            DispatchQueue.main.async { web.eventCalls.removeAll { $0 == callId } }
            done(result)
          }
        } catch { done(.failure(error)) }
      }
    }
  }

  private static func url(_ text: String?) throws -> URL {
    guard let text, let url = URL(string: text) else { throw ScriptError("Invalid URL: \(text ?? "")") }
    return url
  }

  static func register(_ r: NativeRegistry) {
    // The view is created on main; later calls are queued behind it there, so they find it.
    r.sync("web.create") { run, _ in
      idLock.lock()
      let id = nextId
      nextId += 1
      idLock.unlock()
      let key = "\(run.id)#\(id)"
      DispatchQueue.main.async { views[key] = ScriptWeb(run: run) }
      run.addCleanup("web.\(id)") {
        DispatchQueue.main.async { views.removeValue(forKey: key)?.destroy() }
      }
      return id
    }

    r.sync("web.setFilter") { run, a in
      let id = a.int(0, 0)
      let enabled = a.bool(1, false)
      DispatchQueue.main.async { try? view(run, id).filterEnabled = enabled }
      return nil
    }
    r.sync("web.decide") { run, a in
      let id = a.int(0, 0)
      let decision = a.int(1, 0)
      let allow = a.bool(2, true)
      DispatchQueue.main.async { try? view(run, id).decide(decision, allow: allow) }
      return nil
    }

    handle(r, "web.loadHTML", { a in (a.optString(1) ?? "", a.optString(2).flatMap { URL(string: $0) }) }) { web, p, done in
      web.load(done) { $0.loadHTMLString(p.0, baseURL: p.1) }
    }
    handle(r, "web.loadURL", { a in try url(a.optString(1)) }) { web, url, done in
      web.load(done) { $0.load(URLRequest(url: url)) }
    }
    handle(r, "web.loadRequest", { a -> URLRequest in
      var request = URLRequest(url: try url(a.optString(1)))
      request.httpMethod = a.optString(2) ?? "GET"
      for (k, v) in a.dict(3) { request.setValue("\(v)", forHTTPHeaderField: k) }
      if a.value(4) != nil { request.httpBody = try a.data(4) }
      return request
    }) { web, request, done in
      web.load(done) { $0.load(request) }
    }
    handle(r, "web.loadFile", { a in Paths.resolve(a.optString(1) ?? "") }) { web, url, done in
      web.load(done) { $0.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) }
    }
    handle(r, "web.eval", { a in (a.optString(1) ?? "", a.bool(2, false)) }) { web, p, done in
      web.evaluate(p.0, useCallback: p.1, done: done)
    }
    handle(r, "web.waitForLoad", { _ in () }) { web, _, done in
      web.loadWaiters.append(done)
    }
    handle(r, "web.present", { a in a.bool(1, false) }) { web, fullscreen, done in
      web.present(fullscreen: fullscreen) { done(.success(nil)) }
    }
  }
}

/// Forwards script messages without the content controller retaining the ScriptWeb.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
  weak var target: WKScriptMessageHandler?
  init(_ target: WKScriptMessageHandler) { self.target = target }
  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(c, didReceive: message)
  }
}

final class ScriptWeb: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  weak var run: ScriptRun?
  let webView: WKWebView
  /// Pending async calls of this view; events (shouldAllowRequest) go to the latest one.
  var eventCalls: [Int] = []
  var loadWaiters: [Completion] = []
  var filterEnabled = false
  private var decisions: [Int: (WKNavigationActionPolicy) -> Void] = [:]
  private var nextDecision = 1
  private var callbacks: [Int: Completion] = [:]
  private var nextCallback = 1
  private var screen: WebScreenController?
  private var presentWaiters: [() -> Void] = []
  /// Off-screen host so pages keep running (timers, layout) while not presented.
  private static let parking: UIView = {
    let v = UIView()
    v.isUserInteractionEnabled = false
    v.alpha = 0.01
    return v
  }()

  /// Injected in every page: log/logError reach the script's console, completion() ends an eval.
  private static let bridgeScript = """
    (function () {
      const post = (m) => window.webkit.messageHandlers.scriptor.postMessage(m);
      const text = (args) => Array.from(args).map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      window.log = function () { post({ type: 'log', level: 'log', message: text(arguments) }); };
      window.logError = function () { post({ type: 'log', level: 'error', message: text(arguments) }); };
      window.completion = function (value) {
        post({ type: 'completion', id: window.__scriptorCallback || 0, value: value === undefined ? null : value });
      };
    })();
    """

  init(run: ScriptRun) {
    self.run = run
    let config = WKWebViewConfiguration()
    config.allowsInlineMediaPlayback = true
    config.mediaTypesRequiringUserActionForPlayback = []
    let content = WKUserContentController()
    content.addUserScript(WKUserScript(source: ScriptWeb.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
    config.userContentController = content
    webView = WKWebView(frame: UIScreen.main.bounds, configuration: config)
    super.init()
    content.add(WeakMessageHandler(self), name: "scriptor")
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    webView.isInspectable = true
    park()
  }

  private func park() {
    let parking = ScriptWeb.parking
    if parking.superview == nil, let window = Presenter.topController()?.view.window {
      parking.frame = window.bounds
      window.insertSubview(parking, at: 0)
    }
    webView.removeFromSuperview()
    webView.frame = parking.bounds.isEmpty ? UIScreen.main.bounds : parking.bounds
    parking.addSubview(webView)
  }

  func destroy() {
    screen?.close()
    screen = nil
    decisions.values.forEach { $0(.allow) }
    decisions.removeAll()
    webView.stopLoading()
    webView.configuration.userContentController.removeScriptMessageHandler(forName: "scriptor")
    webView.removeFromSuperview()
    let stopped = ScriptError("Stopped")
    loadWaiters.forEach { $0(.failure(stopped)) }
    callbacks.values.forEach { $0(.failure(stopped)) }
    loadWaiters.removeAll()
    callbacks.removeAll()
  }

  // MARK: Loading and evaluating

  func load(_ done: @escaping Completion, _ start: (WKWebView) -> Void) {
    loadWaiters.append(done)
    start(webView)
  }

  private func finishLoads(_ result: Result<Any?, Error>) {
    let waiters = loadWaiters
    loadWaiters.removeAll()
    waiters.forEach { $0(result) }
  }

  func evaluate(_ code: String, useCallback: Bool, done: @escaping Completion) {
    guard useCallback else {
      webView.evaluateJavaScript(code) { value, error in
        if let error { done(.failure(ScriptWeb.describe(error))) } else { done(.success(value)) }
      }
      return
    }
    let id = nextCallback
    nextCallback += 1
    callbacks[id] = done
    webView.evaluateJavaScript("window.__scriptorCallback = \(id);\n" + code + "\n;void 0") { [weak self] _, error in
      guard let error, let self, let cb = self.callbacks.removeValue(forKey: id) else { return }
      cb(.failure(ScriptWeb.describe(error)))
    }
  }

  private static func describe(_ error: Error) -> Error {
    let ns = error as NSError
    if let message = ns.userInfo["WKJavaScriptExceptionMessage"] as? String { return ScriptError(message) }
    return error
  }

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any] else { return }
    switch body["type"] as? String {
    case "log":
      let level = (body["level"] as? String) ?? "log"
      let text = (body["message"] as? String) ?? ""
      run?.queue.async { [weak run = self.run] in run?.log(level, text) }
    case "completion":
      let id = (body["id"] as? NSNumber)?.intValue ?? 0
      let value = body["value"].flatMap { $0 is NSNull ? nil : $0 }
      callbacks.removeValue(forKey: id)?(.success(value))
    default:
      break
    }
  }

  // MARK: shouldAllowRequest

  func decide(_ id: Int, allow: Bool) {
    decisions.removeValue(forKey: id)?(allow ? .allow : .cancel)
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard filterEnabled, let run, let callId = eventCalls.last, let url = action.request.url else {
      return decisionHandler(.allow)
    }
    let id = nextDecision
    nextDecision += 1
    decisions[id] = decisionHandler
    run.emit(callId, [
      "type": "request", "id": id, "url": url.absoluteString,
      "method": action.request.httpMethod ?? "GET", "headers": action.request.allHTTPHeaderFields ?? [:],
    ])
  }

  // MARK: Navigation results

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    screen?.navigationItem.title = webView.title
    finishLoads(.success(nil))
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    failLoad(error)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    failLoad(error)
  }

  private func failLoad(_ error: Error) {
    // Cancelled navigations were replaced by a newer load (or blocked by shouldAllowRequest).
    if (error as NSError).code == NSURLErrorCancelled { if !webView.isLoading { finishLoads(.success(nil)) }; return }
    finishLoads(.failure(error))
  }

  // Pages opening new windows (target=_blank) load in place.
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
    return nil
  }

  func webView(
    _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
  ) {
    let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
    Presenter.present(alert)
  }

  func webView(
    _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
  ) {
    let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "Cancelar", style: .cancel) { _ in completionHandler(false) })
    alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
    Presenter.present(alert)
  }

  // MARK: Presenting

  func present(fullscreen: Bool, onClose: @escaping () -> Void) {
    presentWaiters.append(onClose)
    // Already on screen: the promise resolves when that presentation ends.
    guard screen == nil else { return }
    let screen = WebScreenController(webView: webView)
    screen.run = run
    self.screen = screen
    screen.show(fullscreen: fullscreen) { [weak self] in
      guard let self else { return }
      self.screen = nil
      self.park()
      let waiters = self.presentWaiters
      self.presentWaiters.removeAll()
      waiters.forEach { $0() }
    }
  }
}

final class WebScreenController: ScriptScreenController {
  private let webView: WKWebView

  init(webView: WKWebView) {
    self.webView = webView
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    webView.removeFromSuperview()
    webView.frame = view.bounds
    webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.insertSubview(webView, at: 0)
    navigationItem.title = webView.title
  }
}
