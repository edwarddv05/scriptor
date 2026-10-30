import ExpoModulesCore
import Foundation
import UIKit

public class ScriptEngineModule: Module {
  private var runs: [String: ScriptRun] = [:]
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("ScriptEngine")

    Events("onLogs", "onFinish", "onHost")

    Constant("documentsPath") { Paths.documents.path }

    OnCreate {
      NotificationHandler.install()
    }

    // Called by the app's x-callback route when another app returns to scriptor://x-callback/<token>/<status>.
    Function("deliverCallback") { (token: String, status: String, params: [String: String]) in
      CallbackURLs.deliver(token: token, status: status, params: params)
    }

    // MARK: Running

    Function("run") { (runId: String, name: String, source: String, input: [String: Any]?) in
      if name.lowercased().hasSuffix(".py") {
        return self.runPython(id: runId, name: name, source: source, input: input ?? [:], repl: false)
      }
      let run = ScriptRun(
        id: runId, name: name, source: source, input: input ?? [:],
        onLogs: { [weak self] logs in
          self?.sendEvent("onLogs", ["runId": runId, "logs": logs])
        },
        onFinish: { [weak self] run, result, error in
          guard let self else { return }
          self.lock.lock()
          self.runs[run.id] = nil
          self.lock.unlock()
          var body: [String: Any] = ["runId": run.id]
          if let result { body["result"] = result }
          if let error { body["error"] = error }
          self.sendEvent("onFinish", body)
        }
      )
      self.lock.lock()
      self.runs[runId] = run
      self.lock.unlock()
      run.start()
    }

    // MARK: Miniapp host

    // A .jsx miniapp runs in the app's React runtime. To reach Scriptor's API it keeps a script
    // run alive in the background (its main never settles) and sends calls to it by global path.
    Function("hostStart") { (runId: String, name: String) in
      let run = ScriptRun(
        id: runId, name: name, source: "await new Promise(() => {});", input: [:],
        onLogs: { [weak self] logs in
          self?.sendEvent("onLogs", ["runId": runId, "logs": logs])
        },
        onFinish: { [weak self] run, _, error in
          guard let self else { return }
          self.lock.lock()
          self.runs[run.id] = nil
          self.lock.unlock()
          var body: [String: Any] = ["runId": run.id]
          if let error { body["error"] = error }
          self.sendEvent("onFinish", body)
        }
      )
      run.onHost = { [weak self] message in
        var body = message
        body["runId"] = runId
        self?.sendEvent("onHost", body)
      }
      self.lock.lock()
      self.runs[runId] = run
      self.lock.unlock()
      run.start()
    }

    Function("hostCall") { (runId: String, callId: Int, path: String, args: String) in
      self.lock.lock()
      let run = self.runs[runId]
      self.lock.unlock()
      guard let run else {
        self.sendEvent("onHost", ["runId": runId, "id": callId, "kind": "error", "value": "La miniapp ya no tiene acceso a Scriptor."])
        return
      }
      run.invoke("__hostCall", callId, ["path": path, "args": args])
    }

    Function("stop") { (runId: String) in
      self.lock.lock()
      let run = self.runs[runId]
      self.lock.unlock()
      if let run { run.stop() } else { PythonEngine.shared.stop(runId) }
    }

    // One line of the Python terminal. Lines with the same `session` share their variables;
    // the output arrives as onLogs and the end as onFinish, both with `runId`.
    Function("pythonLine") { (runId: String, session: String, code: String) in
      self.runPython(id: runId, name: "<terminal>", source: code, input: [:], repl: true, session: session)
    }

    // A pip command from the terminal, as its words: ["install", "pandas"].
    Function("pythonPip") { (runId: String, args: [String]) in
      let list = args.map(Self.pythonString).joined(separator: ", ")
      self.runPython(id: runId, name: "<pip>", source: "import _scriptor\nawait _scriptor._pip([\(list)])", input: [:], repl: false)
    }

    // MARK: Script files (Documents/*.js, visible in the Files app)

    Function("listScripts") { () -> [[String: Any]] in
      let fm = FileManager.default
      let urls = (try? fm.contentsOfDirectory(
        at: Paths.documents, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
        options: [.skipsHiddenFiles])) ?? []
      return urls
        .filter { ["js", "jsx", "tsx", "py"].contains($0.pathExtension.lowercased()) }
        .map { url in
          let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
          // Miniapps (.jsx, .tsx) and Python scripts keep their extension in the name; .js scripts go without it.
          let ext = url.pathExtension.lowercased()
          var item: [String: Any] = [
            "name": ext == "js" ? url.deletingPathExtension().lastPathComponent : url.lastPathComponent,
            "app": ext == "jsx" || ext == "tsx",
            "modified": (values?.contentModificationDate ?? Date()).timeIntervalSince1970 * 1000,
            "size": values?.fileSize ?? 0,
          ]
          item.merge(ScriptHeader.read(url)) { _, new in new }
          return item
        }
    }

    Function("readScript") { (name: String) throws -> String in
      try String(contentsOf: Paths.script(name), encoding: .utf8)
    }

    Function("writeScript") { (name: String, content: String) throws in
      try content.write(to: Paths.script(name), atomically: true, encoding: .utf8)
    }

    Function("deleteScript") { (name: String) throws in
      try FileManager.default.removeItem(at: Paths.script(name))
    }

    // Puts the file on the pasteboard: Files and Mail paste it as the file, text fields as its code.
    Function("copyScript") { (name: String) throws in
      let url = Paths.script(name)
      let text = try String(contentsOf: url, encoding: .utf8)
      let provider = NSItemProvider(contentsOf: url) ?? NSItemProvider()
      provider.suggestedName = url.lastPathComponent
      provider.registerObject(text as NSString, visibility: .all)
      DispatchQueue.main.async {
        UIPasteboard.general.setItemProviders([provider], localOnly: false, expirationDate: nil)
      }
    }

    Function("renameScript") { (from: String, to: String) throws in
      let target = Paths.script(to)
      if FileManager.default.fileExists(atPath: target.path) {
        throw ScriptError("Ya existe un script llamado \(to)")
      }
      try FileManager.default.moveItem(at: Paths.script(from), to: target)
    }
  }

  /// Python runs report through the same onLogs/onFinish events as JavaScript runs.
  private func runPython(id: String, name: String, source: String, input: [String: Any], repl: Bool, session: String? = nil) {
    PythonEngine.shared.run(
      id: id, name: name, source: source, input: input, repl: repl, session: session,
      onLogs: { [weak self] logs in self?.sendEvent("onLogs", ["runId": id, "logs": logs]) },
      onFinish: { [weak self] result, error in
        var body: [String: Any] = ["runId": id]
        if let result { body["result"] = result }
        if let error { body["error"] = error }
        self?.sendEvent("onFinish", body)
      }
    )
  }

  /// A Python string literal of `text`, for code built here.
  private static func pythonString(_ text: String) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: [text], options: .withoutEscapingSlashes)) ?? Data("[\"\"]".utf8)
    // A JSON string is a valid Python string literal.
    return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
  }
}

enum Paths {
  static var documents: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
  }
  static var caches: URL {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
  }
  static var library: URL {
    FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
  }
  static var temp: URL { FileManager.default.temporaryDirectory }

  static func script(_ name: String) -> URL {
    let lower = name.lowercased()
    let kept = lower.hasSuffix(".js") || lower.hasSuffix(".jsx") || lower.hasSuffix(".tsx") || lower.hasSuffix(".py")
    return documents.appendingPathComponent(kept ? name : name + ".js")
  }

  /// Relative paths resolve against Documents; absolute paths are used as they are.
  static func resolve(_ path: String) -> URL {
    if path.hasPrefix("file://"), let url = URL(string: path) { return url }
    if path.hasPrefix("/") { return URL(fileURLWithPath: path) }
    return documents.appendingPathComponent(path)
  }

  /// A fresh file in tmp with the given extension, for outputs the script did not name.
  static func tempFile(_ ext: String) -> URL {
    let dir = temp.appendingPathComponent("scriptor", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
  }

  static func output(_ dest: String?, ext: String) -> URL {
    guard let dest, !dest.isEmpty else { return tempFile(ext) }
    let url = resolve(dest)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: url)
    return url
  }
}

/// Reads the start of a script for the list: Scriptable's `// icon-color: x; icon-glyph: y;`
/// header and the first ordinary comment line as a summary.
enum ScriptHeader {
  static func read(_ url: URL) -> [String: Any] {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return [:] }
    defer { try? handle.close() }
    let data = (try? handle.read(upToCount: 2048)) ?? Data()
    let head = String(decoding: data, as: UTF8.self)
    var result: [String: Any] = [:]
    for line in head.split(separator: "\n", omittingEmptySubsequences: true).prefix(12) {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      // Python comments start with "#"; a "#!" first line is skipped.
      let marker = trimmed.hasPrefix("//") ? 2 : trimmed.hasPrefix("#!") ? -1 : trimmed.hasPrefix("#") ? 1 : 0
      if marker == -1 { continue }
      guard marker > 0 else {
        if !trimmed.isEmpty { break } else { continue }
      }
      let body = trimmed.dropFirst(marker).trimmingCharacters(in: .whitespaces)
      if body.contains("icon-color:") || body.contains("icon-glyph:") {
        for part in body.split(separator: ";") {
          let pair = part.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
          guard pair.count == 2 else { continue }
          if pair[0] == "icon-color" { result["color"] = pair[1] }
          if pair[0] == "icon-glyph" { result["glyph"] = pair[1] }
        }
      } else if result["summary"] == nil, !body.isEmpty,
                !body.hasPrefix("Variables used by Scriptable"), !body.hasPrefix("These must be at the very top") {
        result["summary"] = body
      }
    }
    return result
  }
}
