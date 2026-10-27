import Foundation

/// fetch, streaming download/upload with progress, WebSocket and cancellation.
enum NetAPI {
  static func register(_ r: NativeRegistry) {
    // (url, options, body) -> { status, statusText, url, headers, body: Uint8Array }
    r.async("net.fetch") { run, a, done in
      do {
        let request = try makeRequest(a)
        let opts = a.dict(1)
        let manual = (opts["redirect"] as? String) == "manual"
        let insecure = (opts["insecure"] as? Bool) == true
        var body: Data?
        if a.value(2) != nil { body = try a.data(2) }
        let task: URLSessionTask
        if let body {
          task = NetSession.shared.session.uploadTask(with: request, from: body)
        } else {
          task = NetSession.shared.session.dataTask(with: request)
        }
        NetSession.shared.track(
          task, run: run, callId: a.callId, kind: .data, manualRedirect: manual, insecure: insecure, done: done)
      } catch { done(.failure(error)) }
    }

    // (url, dest?, options) -> { path, status, headers, size }. Streams to disk.
    r.async("net.download") { run, a, done in
      do {
        var request = try makeRequest(a, optionsIndex: 2)
        request.httpBody = nil
        let task = NetSession.shared.session.downloadTask(with: request)
        let urlString = try a.string(0)
        let fallbackExt = URL(string: urlString)?.pathExtension ?? ""
        let dest = Paths.output(a.optString(1), ext: fallbackExt.isEmpty ? "download" : fallbackExt)
        NetSession.shared.track(task, run: run, callId: a.callId, kind: .download(dest), done: done)
      } catch { done(.failure(error)) }
    }

    // (url, path, options) -> same shape as fetch. Streams the file from disk.
    r.async("net.upload") { run, a, done in
      do {
        var request = try makeRequest(a, optionsIndex: 2)
        if request.httpMethod == "GET" { request.httpMethod = "POST" }
        let file = Paths.resolve(try a.string(1))
        let task = NetSession.shared.session.uploadTask(with: request, fromFile: file)
        NetSession.shared.track(task, run: run, callId: a.callId, kind: .data, done: done)
      } catch { done(.failure(error)) }
    }

    r.sync("net.cancel") { run, a in
      NetSession.shared.cancel(run: run, callId: a.int(0, 0))
      return nil
    }

    // (url, protocols) — stays pending until the socket closes; events go through emit().
    r.async("ws.connect") { run, a, done in
      do {
        let urlString = try a.string(0)
        guard let url = URL(string: urlString) else { throw ScriptError("Invalid URL: \(urlString)") }
        let protocols = a.stringArray(1)
        let task = NetSession.shared.session.webSocketTask(with: url, protocols: protocols)
        NetSession.shared.track(task, run: run, callId: a.callId, kind: .socket, done: done)
        NetSession.shared.receive(task)
      } catch { done(.failure(error)) }
    }
    r.sync("ws.send") { run, a in
      guard let task = NetSession.shared.task(run: run, callId: a.int(0, 0)) as? URLSessionWebSocketTask else {
        throw ScriptError("WebSocket is not open")
      }
      let message: URLSessionWebSocketTask.Message
      if a.value(1)?.isString == true {
        message = .string(try a.string(1))
      } else {
        message = .data(try a.data(1))
      }
      task.send(message) { error in
        if let error { run.log("warn", "WebSocket send failed: \(error.localizedDescription)") }
      }
      return nil
    }
    r.sync("ws.close") { run, a in
      guard let task = NetSession.shared.task(run: run, callId: a.int(0, 0)) as? URLSessionWebSocketTask else {
        return nil
      }
      let code = URLSessionWebSocketTask.CloseCode(rawValue: a.int(1, 1000)) ?? .normalClosure
      task.cancel(with: code, reason: a.optString(2).map { Data($0.utf8) })
      return nil
    }
  }

  private static func makeRequest(_ a: Args, optionsIndex: Int = 1) throws -> URLRequest {
    let urlString = try a.string(0)
    guard let url = URL(string: urlString), url.scheme != nil else { throw ScriptError("Invalid URL: \(urlString)") }
    let opts = a.dict(optionsIndex)
    var request = URLRequest(url: url)
    request.httpMethod = ((opts["method"] as? String) ?? "GET").uppercased()
    if let timeout = opts["timeout"] as? Double { request.timeoutInterval = timeout }
    if let headers = opts["headers"] as? [String: Any] {
      for (k, v) in headers { request.setValue("\(v)", forHTTPHeaderField: k) }
    }
    if (opts["cache"] as? String) == "no-store" { request.cachePolicy = .reloadIgnoringLocalCacheData }
    return request
  }
}

final class NetSession: NSObject, URLSessionDataDelegate, URLSessionDownloadDelegate, URLSessionWebSocketDelegate {
  static let shared = NetSession()

  enum Kind {
    case data
    case download(URL)
    case socket
  }

  final class State {
    weak var run: ScriptRun?
    let callId: Int
    let kind: Kind
    let manualRedirect: Bool
    let insecure: Bool
    let done: Completion
    var buffer = Data()
    var downloaded: String?
    var lastProgress = Date.distantPast

    init(run: ScriptRun, callId: Int, kind: Kind, manualRedirect: Bool, insecure: Bool, done: @escaping Completion) {
      self.run = run
      self.callId = callId
      self.kind = kind
      self.manualRedirect = manualRedirect
      self.insecure = insecure
      self.done = done
    }
  }

  private(set) lazy var session: URLSession = {
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    return URLSession(configuration: .default, delegate: self, delegateQueue: queue)
  }()

  private var states: [Int: State] = [:]
  private var tasks: [Int: URLSessionTask] = [:]
  private let lock = NSLock()

  func track(
    _ task: URLSessionTask, run: ScriptRun, callId: Int, kind: Kind, manualRedirect: Bool = false,
    insecure: Bool = false, done: @escaping Completion
  ) {
    lock.lock()
    states[task.taskIdentifier] = State(
      run: run, callId: callId, kind: kind, manualRedirect: manualRedirect, insecure: insecure, done: done)
    tasks[task.taskIdentifier] = task
    lock.unlock()
    run.addCleanup("net.\(callId)") { task.cancel() }
    task.resume()
  }

  func task(run: ScriptRun, callId: Int) -> URLSessionTask? {
    lock.lock()
    defer { lock.unlock() }
    guard let entry = states.first(where: { $0.value.run === run && $0.value.callId == callId }) else { return nil }
    return tasks[entry.key]
  }

  func cancel(run: ScriptRun, callId: Int) {
    task(run: run, callId: callId)?.cancel()
  }

  private func state(_ task: URLSessionTask) -> State? {
    lock.lock()
    defer { lock.unlock() }
    return states[task.taskIdentifier]
  }

  private func finish(_ task: URLSessionTask, _ result: Result<Any?, Error>) {
    lock.lock()
    let st = states.removeValue(forKey: task.taskIdentifier)
    tasks[task.taskIdentifier] = nil
    lock.unlock()
    guard let st else { return }
    st.run?.removeCleanup("net.\(st.callId)")
    st.done(result)
  }

  private func progress(_ st: State, loaded: Int64, total: Int64, final: Bool = false) {
    // At most ~10 events per second so large transfers do not flood the script.
    guard final || Date().timeIntervalSince(st.lastProgress) > 0.1 else { return }
    st.lastProgress = Date()
    st.run?.emit(st.callId, ["type": "progress", "loaded": Double(loaded), "total": Double(max(total, -1))])
  }

  private static func describe(_ response: URLResponse?) -> [String: Any] {
    guard let http = response as? HTTPURLResponse else {
      return ["status": 200, "statusText": "OK", "url": response?.url?.absoluteString ?? "", "headers": [:]]
    }
    var headers: [String: String] = [:]
    var rawHeaders: [String: String] = [:]
    for (k, v) in http.allHeaderFields {
      headers["\(k)".lowercased()] = "\(v)"
      rawHeaders["\(k)"] = "\(v)"
    }
    var cookies: [[String: Any]] = []
    if let url = http.url {
      cookies = HTTPCookie.cookies(withResponseHeaderFields: rawHeaders, for: url).map { c in
        [
          "name": c.name, "value": c.value, "domain": c.domain, "path": c.path,
          "httpOnly": c.isHTTPOnly, "sessionOnly": c.isSessionOnly,
        ]
      }
    }
    return [
      "status": http.statusCode,
      "statusText": HTTPURLResponse.localizedString(forStatusCode: http.statusCode),
      "url": http.url?.absoluteString ?? "",
      "headers": headers,
      "rawHeaders": rawHeaders,
      "cookies": cookies,
    ]
  }

  // MARK: WebSocket

  func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self, let st = self.state(task) else { return }
      switch result {
      case .success(let message):
        switch message {
        case .string(let text): st.run?.emit(st.callId, ["type": "message", "data": text])
        case .data(let data): st.run?.emit(st.callId, ["type": "message", "data": data])
        @unknown default: break
        }
        self.receive(task)
      case .failure:
        break  // didCompleteWithError reports the close
      }
    }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    guard let st = state(webSocketTask) else { return }
    st.run?.emit(st.callId, ["type": "open", "protocol": `protocol` ?? ""])
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
  ) {
    finish(webSocketTask, .success([
      "code": closeCode.rawValue, "reason": reason.map { String(decoding: $0, as: UTF8.self) } ?? "",
    ]))
  }

  // MARK: Data / upload

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let st = state(dataTask) else { return }
    st.buffer.append(data)
    progress(st, loaded: dataTask.countOfBytesReceived, total: dataTask.countOfBytesExpectedToReceive)
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
    totalBytesSent: Int64, totalBytesExpectedToSend: Int64
  ) {
    guard let st = state(task) else { return }
    st.run?.emit(st.callId, [
      "type": "uploadProgress", "loaded": Double(totalBytesSent), "total": Double(totalBytesExpectedToSend),
    ])
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(state(task)?.manualRedirect == true ? nil : request)
  }

  // Request.allowInsecureRequest: accept the server's certificate whatever it is.
  func urlSession(
    _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      state(task)?.insecure == true, let trust = challenge.protectionSpace.serverTrust
    {
      return completionHandler(.useCredential, URLCredential(trust: trust))
    }
    completionHandler(.performDefaultHandling, nil)
  }

  // MARK: Download

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
  ) {
    guard let st = state(downloadTask) else { return }
    progress(st, loaded: totalBytesWritten, total: totalBytesExpectedToWrite)
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    // The temp file is deleted when this returns, so move it now.
    guard let st = state(downloadTask), case .download(let dest) = st.kind else { return }
    do {
      try? FileManager.default.removeItem(at: dest)
      try FileManager.default.moveItem(at: location, to: dest)
      st.downloaded = dest.path
    } catch {
      st.run?.log("error", "Could not save download: \(error.localizedDescription)")
    }
  }

  // MARK: Completion

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let st = state(task) else { return }
    if case .socket = st.kind {
      let code = (task as? URLSessionWebSocketTask)?.closeCode.rawValue ?? 1006
      var body: [String: Any] = ["code": code == 0 ? 1006 : code, "reason": ""]
      if let error { body["error"] = error.localizedDescription }
      return finish(task, .success(body))
    }
    if let error { return finish(task, .failure(error)) }
    var out = NetSession.describe(task.response)
    switch st.kind {
    case .download:
      guard let path = st.downloaded else { return finish(task, .failure(ScriptError("Download failed"))) }
      out["path"] = path
      out["size"] = Double(task.countOfBytesReceived)
      progress(st, loaded: task.countOfBytesReceived, total: task.countOfBytesReceived, final: true)
    default:
      out["body"] = st.buffer
    }
    finish(task, .success(out))
  }
}
