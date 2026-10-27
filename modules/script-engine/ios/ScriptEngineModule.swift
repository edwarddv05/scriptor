import ExpoModulesCore
import Foundation

public class ScriptEngineModule: Module {
  private var runs: [String: ScriptRun] = [:]
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("ScriptEngine")

    Events("onLogs", "onFinish")

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

    Function("stop") { (runId: String) in
      self.lock.lock()
      let run = self.runs[runId]
      self.lock.unlock()
      run?.stop()
    }

    // MARK: Script files (Documents/*.js, visible in the Files app)

    Function("listScripts") { () -> [[String: Any]] in
      let fm = FileManager.default
      let urls = (try? fm.contentsOfDirectory(
        at: Paths.documents, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
        options: [.skipsHiddenFiles])) ?? []
      return urls
        .filter { $0.pathExtension.lowercased() == "js" }
        .map { url in
          let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
          return [
            "name": url.deletingPathExtension().lastPathComponent,
            "modified": (values?.contentModificationDate ?? Date()).timeIntervalSince1970 * 1000,
            "size": values?.fileSize ?? 0,
          ]
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

    Function("renameScript") { (from: String, to: String) throws in
      let target = Paths.script(to)
      if FileManager.default.fileExists(atPath: target.path) {
        throw ScriptError("Ya existe un script llamado \(to)")
      }
      try FileManager.default.moveItem(at: Paths.script(from), to: target)
    }
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
    documents.appendingPathComponent(name.hasSuffix(".js") ? name : name + ".js")
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
