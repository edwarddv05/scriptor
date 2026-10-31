import Foundation
import Network
import UniformTypeIdentifiers

/// Net.serve: a small HTTP server that lives as long as the script that opened it. Each request
/// goes to the script as an event; the script answers with server.respond. One request per
/// connection (Connection: close), which is all a browser or curl on the same phone needs.
enum ServerAPI {
  static func register(_ r: NativeRegistry) {
    // (port, { lan }) — stays pending until the server stops; the start and each request go through emit().
    r.async("server.start") { run, a, done in
      do {
        let server = try LocalServer(run: run, callId: a.callId, port: a.int(0, 8080), lan: (a.dict(1)["lan"] as? Bool) == true, done: done)
        run.addCleanup("server-\(a.callId)") { server.stop() }
        server.start()
      } catch { done(.failure(error)) }
    }

    // (server, request, status, headers, body?, file?)
    r.sync("server.respond") { run, a in
      guard let server = LocalServer.find(run: run, callId: a.int(0, 0)) else { return nil }
      let body: Data? = a.value(4) == nil ? nil : try a.data(4)
      server.respond(a.int(1, 0), status: a.int(2, 200), headers: a.dict(3), body: body, file: a.optString(5))
      return nil
    }

    r.sync("server.stop") { run, a in
      LocalServer.find(run: run, callId: a.int(0, 0))?.stop()
      return nil
    }
  }
}

final class LocalServer {
  private static var servers: [String: LocalServer] = [:]
  private static let lock = NSLock()

  static func find(run: ScriptRun, callId: Int) -> LocalServer? {
    lock.lock()
    defer { lock.unlock() }
    return servers["\(run.id)#\(callId)"]
  }

  private static let maxHeader = 64 * 1024
  private static let maxBody = 50 * 1024 * 1024

  private weak var run: ScriptRun?
  private let key: String
  private let callId: Int
  private let lan: Bool
  private let listener: NWListener
  private let queue: DispatchQueue
  private var done: Completion?
  private var connections: [Int: NWConnection] = [:]
  private var nextRequest = 1

  init(run: ScriptRun, callId: Int, port: Int, lan: Bool, done: @escaping Completion) throws {
    guard (0...65535).contains(port), let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else {
      throw ScriptError("Puerto no válido: \(port)")
    }
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    // Without lan only this iPhone reaches it, and iOS does not ask for local network access.
    if !lan { parameters.requiredInterfaceType = .loopback }
    listener = try NWListener(using: parameters, on: nwPort)
    self.run = run
    self.callId = callId
    self.lan = lan
    self.done = done
    key = "\(run.id)#\(callId)"
    queue = DispatchQueue(label: "scriptor.server.\(key)")
    Self.lock.lock()
    Self.servers[key] = self
    Self.lock.unlock()
  }

  func start() {
    listener.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        let port = Int(self.listener.port?.rawValue ?? 0)
        var info: [String: Any] = ["type": "start", "port": port, "url": "http://localhost:\(port)"]
        if self.lan { info["addresses"] = Self.lanAddresses().map { "http://\($0):\(port)" } }
        self.run?.emit(self.callId, info)
      case .failed(let error):
        let message: String
        if case .posix(let code) = error, code == .EADDRINUSE {
          message = "El puerto \(self.listener.port.map { "\($0.rawValue)" } ?? "") ya está en uso."
        } else {
          message = "El servidor se detuvo: \(error.localizedDescription)"
        }
        self.finish(.failure(ScriptError(message)))
      case .cancelled:
        self.finish(.success(nil))
      default:
        break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in
      guard let self else { return connection.cancel() }
      let id = self.nextRequest
      self.nextRequest += 1
      self.connections[id] = connection
      connection.stateUpdateHandler = { [weak self] state in
        switch state {
        case .failed, .cancelled: self?.connections[id] = nil
        default: break
        }
      }
      connection.start(queue: self.queue)
      self.receive(id, connection, Data())
    }
    listener.start(queue: queue)
  }

  func stop() {
    queue.async { [self] in
      listener.cancel()
      connections.values.forEach { $0.cancel() }
      connections.removeAll()
      finish(.success(nil))
    }
  }

  private func finish(_ result: Result<Any?, Error>) {
    Self.lock.lock()
    Self.servers[key] = nil
    Self.lock.unlock()
    if case .failure = result { listener.cancel() }
    done?(result)
    done = nil
  }

  // MARK: Requests

  /// Reads until the headers and the body they announce have arrived, then hands the request on.
  private func receive(_ id: Int, _ connection: NWConnection, _ buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] chunk, _, complete, error in
      guard let self else { return }
      var data = buffer
      if let chunk { data.append(chunk) }
      guard let end = data.range(of: Data("\r\n\r\n".utf8)) else {
        if data.count > Self.maxHeader { return self.reply(id, status: 431, text: "Cabeceras demasiado grandes") }
        if complete || error != nil { connection.cancel(); return }
        return self.receive(id, connection, data)
      }
      let head = String(decoding: data[data.startIndex..<end.lowerBound], as: UTF8.self)
      var lines = head.components(separatedBy: "\r\n")
      let start = lines.removeFirst().split(separator: " ")
      guard start.count >= 2 else { return self.reply(id, status: 400, text: "Petición no válida") }
      var headers: [String: String] = [:]
      for line in lines {
        guard let colon = line.firstIndex(of: ":") else { continue }
        let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
        let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        headers[name] = headers[name].map { "\($0), \(value)" } ?? value
      }
      let length = Int(headers["content-length"] ?? "") ?? 0
      if length > Self.maxBody { return self.reply(id, status: 413, text: "Cuerpo demasiado grande") }
      let body = data[end.upperBound...]
      if body.count < length {
        if complete || error != nil { connection.cancel(); return }
        return self.receive(id, connection, data)
      }
      let target = String(start[1])
      let components = URLComponents(string: target)
      var query: [String: String] = [:]
      for item in components?.queryItems ?? [] { query[item.name] = item.value ?? "" }
      var request: [String: Any] = [
        "type": "request", "id": id, "method": String(start[0]).uppercased(),
        "url": target, "path": components?.percentEncodedPath.removingPercentEncoding ?? target,
        "query": query, "headers": headers, "body": Data(body.prefix(length)),
      ]
      if case .hostPort(let host, _) = connection.endpoint { request["address"] = "\(host)" }
      self.run?.emit(self.callId, request)
    }
  }

  func respond(_ id: Int, status: Int, headers: [String: Any], body: Data?, file: String?) {
    queue.async { [self] in
      var headers = Dictionary(headers.map { ($0.key.lowercased(), "\($0.value)") }, uniquingKeysWith: { _, last in last })
      var content = body ?? Data()
      var code = status
      if let file {
        let url = Paths.resolve(file)
        if let data = try? Data(contentsOf: url, options: .mappedIfSafe) {
          content = data
          if headers["content-type"] == nil {
            headers["content-type"] = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
          }
        } else {
          code = 404
          content = Data("No existe \(file)".utf8)
          headers["content-type"] = "text/plain; charset=utf-8"
        }
      }
      send(id, status: code, headers: headers, body: content)
    }
  }

  private func reply(_ id: Int, status: Int, text: String) {
    send(id, status: status, headers: ["content-type": "text/plain; charset=utf-8"], body: Data(text.utf8))
  }

  /// Writes the response and closes the connection. Runs on the server's queue.
  private func send(_ id: Int, status: Int, headers: [String: String], body: Data) {
    guard let connection = connections[id] else { return }
    var head = "HTTP/1.1 \(status) \(Self.reasons[status] ?? "Status")\r\n"
    var headers = headers
    headers["content-length"] = "\(body.count)"
    headers["connection"] = "close"
    if headers["content-type"] == nil { headers["content-type"] = "application/octet-stream" }
    for (name, value) in headers { head += "\(name): \(value)\r\n" }
    head += "\r\n"
    var data = Data(head.utf8)
    data.append(body)
    connection.send(content: data, completion: .contentProcessed { [weak self] _ in
      connection.cancel()
      self?.queue.async { self?.connections[id] = nil }
    })
  }

  // The status line stays in plain English whatever the phone's language.
  private static let reasons: [Int: String] = [
    200: "OK", 201: "Created", 204: "No Content", 301: "Moved Permanently", 302: "Found", 304: "Not Modified",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
    413: "Payload Too Large", 431: "Request Header Fields Too Large", 500: "Internal Server Error", 503: "Service Unavailable",
  ]

  // MARK: Addresses

  /// IPv4 addresses on Wi-Fi and wired interfaces, for the URLs other devices can open.
  private static func lanAddresses() -> [String] {
    var result: [String] = []
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return result }
    defer { freeifaddrs(list) }
    for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let entry = pointer.pointee
      guard let address = entry.ifa_addr, address.pointee.sa_family == UInt8(AF_INET) else { continue }
      let name = String(cString: entry.ifa_name)
      guard name.hasPrefix("en") else { continue }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      if getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
        result.append(String(cString: host))
      }
    }
    return result
  }
}
