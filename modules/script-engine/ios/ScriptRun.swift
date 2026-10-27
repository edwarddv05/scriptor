import Foundation
import JavaScriptCore
import UIKit

// Private but exported JavaScriptCore symbols. Fine for a sideloaded app; looked up at
// runtime so a missing symbol only disables the feature.
private typealias ShouldTerminate = @convention(c) (JSContextRef?, UnsafeMutableRawPointer?) -> Bool
private typealias SetTimeLimit = @convention(c) (JSContextGroupRef?, Double, ShouldTerminate?, UnsafeMutableRawPointer?) -> Void
private typealias SetRejectionCallback = @convention(c) (JSGlobalContextRef?, JSObjectRef?, UnsafeMutablePointer<JSValueRef?>?) -> Void

private let jscHandle = dlopen(nil, RTLD_NOW)
private let setTimeLimit: SetTimeLimit? = {
  guard let sym = dlsym(jscHandle, "JSContextGroupSetExecutionTimeLimit") else { return nil }
  return unsafeBitCast(sym, to: SetTimeLimit.self)
}()
private let setRejectionCallback: SetRejectionCallback? = {
  guard let sym = dlsym(jscHandle, "JSGlobalContextSetUnhandledRejectionCallback") else { return nil }
  return unsafeBitCast(sym, to: SetRejectionCallback.self)
}()

/// One execution of a script in its own JSContext. Every JS access happens on `queue`.
final class ScriptRun {
  let id: String
  let name: String
  let source: String
  let input: [String: Any]
  let queue: DispatchQueue
  let context: JSContext

  private(set) var finished = false
  /// Read by the watchdog to interrupt busy loops after stop() or Script.complete().
  fileprivate var cancelled = false
  private var mainSettled = false
  private var mainResult: Any?
  private var pendingOps = 0
  var timers: [Int: DispatchSourceTimer] = [:]
  private var cleanups: [String: () -> Void] = [:]
  private var logBuffer: [[String: Any]] = []
  private var logFlushScheduled = false
  private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

  private let onLogs: ([[String: Any]]) -> Void
  private let onFinish: (ScriptRun, String?, String?) -> Void

  init(
    id: String, name: String, source: String, input: [String: Any],
    onLogs: @escaping ([[String: Any]]) -> Void,
    onFinish: @escaping (ScriptRun, String?, String?) -> Void
  ) {
    self.id = id
    self.name = name
    self.source = source
    self.input = input
    self.onLogs = onLogs
    self.onFinish = onFinish
    queue = DispatchQueue(label: "scriptor.run.\(id)", qos: .userInitiated)
    context = JSContext(virtualMachine: JSVirtualMachine())!
    context.name = name
  }

  // MARK: Lifecycle

  func start() {
    DispatchQueue.main.async {
      self.backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "script \(self.name)") { [weak self] in
        self?.endBackgroundTask()
      }
    }
    queue.async { [self] in
      installBridge()
      installWatchdog()
      context.evaluateScript(Prelude.source, withSourceURL: URL(string: "prelude.js"))
      if finished { return }
      if let cb = setRejectionCallback, let fn = context.objectForKeyedSubscript("__onUnhandledRejection") {
        cb(context.jsGlobalContextRef, JSValueToObject(context.jsGlobalContextRef, fn.jsValueRef, nil), nil)
      }
      let wrapped = "__runMain(async function main() {" + source + "\n});"
      context.evaluateScript(wrapped, withSourceURL: URL(string: name))
    }
  }

  func stop() {
    queue.async { self.finish(error: "Stopped") }
    cancelled = true
  }

  /// Ends the run once the main function settled and nothing is pending (like Node's event loop).
  private func checkDone() {
    if !finished && mainSettled && pendingOps == 0 && timers.isEmpty {
      finish(result: mainResult as? String)
    }
  }

  func finish(result: String? = nil, error: String? = nil) {
    guard !finished else { return }
    finished = true
    cancelled = true
    timers.values.forEach { $0.cancel() }
    timers.removeAll()
    let pendingCleanups = cleanups.values
    cleanups.removeAll()
    pendingCleanups.forEach { $0() }
    flushLogs()
    onFinish(self, result, error)
    DispatchQueue.main.async { self.endBackgroundTask() }
  }

  private func endBackgroundTask() {
    if backgroundTask != .invalid {
      UIApplication.shared.endBackgroundTask(backgroundTask)
      backgroundTask = .invalid
    }
  }

  // MARK: Pending work

  /// Registers something to cancel when the run ends (network task, player...).
  func addCleanup(_ key: String, _ fn: @escaping () -> Void) {
    queue.async { if self.finished { fn() } else { self.cleanups[key] = fn } }
  }

  func removeCleanup(_ key: String) {
    queue.async { self.cleanups[key] = nil }
  }

  /// Sends an intermediate value to an async call (progress, socket messages).
  func emit(_ callId: Int, _ value: Any?) {
    queue.async { [self] in
      guard !finished else { return }
      call("__emit", [callId, JSConvert.toJS(value, in: context)])
    }
  }

  func setTimer(id: Int, ms: Double, repeats: Bool) {
    timers[id]?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    let interval = DispatchTimeInterval.microseconds(Int(max(ms, 0) * 1000))
    timer.schedule(deadline: .now() + interval, repeating: repeats ? interval : .never)
    timer.setEventHandler { [weak self] in
      guard let self, !self.finished else { return }
      if !repeats {
        self.timers[id]?.cancel()
        self.timers[id] = nil
      }
      self.call("__fireTimer", [id])
      self.checkDone()
    }
    timers[id] = timer
    timer.resume()
  }

  func clearTimer(id: Int) {
    timers[id]?.cancel()
    timers[id] = nil
    checkDone()
  }

  @discardableResult
  private func call(_ fn: String, _ args: [Any]) -> JSValue? {
    context.objectForKeyedSubscript(fn)?.call(withArguments: args)
  }

  // MARK: Logs

  func log(_ level: String, _ message: String) {
    let text = message.count > 20_000 ? String(message.prefix(20_000)) + "… (truncated)" : message
    logBuffer.append(["level": level, "message": text, "time": Date().timeIntervalSince1970 * 1000])
    if logBuffer.count >= 200 {
      flushLogs()
    } else if !logFlushScheduled {
      logFlushScheduled = true
      queue.asyncAfter(deadline: .now() + .milliseconds(50)) { [weak self] in self?.flushLogs() }
    }
  }

  private func flushLogs() {
    logFlushScheduled = false
    guard !logBuffer.isEmpty else { return }
    let batch = logBuffer
    logBuffer.removeAll()
    onLogs(batch)
  }

  // MARK: Bridge

  private func installBridge() {
    context.exceptionHandler = { [weak self] _, exception in
      guard let self, let exception, !self.finished else { return }
      let message = ScriptRun.describe(exception)
      self.log("error", message)
      self.finish(error: message)
    }

    let native = JSValue(newObjectIn: context)!

    let callSync: @convention(block) (String, JSValue) -> JSValue = { [weak self] name, argsArray in
      guard let self else { return JSValue(undefinedIn: JSContext.current()) }
      let ctx: JSContext = JSContext.current() ?? self.context
      guard let handler = NativeRegistry.shared.sync[name] else {
        ctx.exception = JSValue(newErrorFromMessage: "Unknown native function \(name)", in: ctx)
        return JSValue(undefinedIn: ctx)
      }
      do {
        return JSConvert.toJS(try handler(self, Args(argsArray)), in: ctx)
      } catch {
        ctx.exception = JSValue(newErrorFromMessage: error.localizedDescription, in: ctx)
        return JSValue(undefinedIn: ctx)
      }
    }

    let callAsync: @convention(block) (String, JSValue, Int) -> Void = { [weak self] name, argsArray, callId in
      guard let self else { return }
      guard let handler = NativeRegistry.shared.async[name] else {
        self.call("__reject", [callId, "Unknown native function \(name)"])
        return
      }
      self.pendingOps += 1
      var done = false
      handler(self, Args(argsArray, callId: callId)) { [weak self] result in
        guard let self else { return }
        self.queue.async {
          guard !done else { return }
          done = true
          self.pendingOps -= 1
          guard !self.finished else { return }
          switch result {
          case .success(let value):
            self.call("__resolve", [callId, JSConvert.toJS(value, in: self.context)])
          case .failure(let error):
            self.call("__reject", [callId, error.localizedDescription])
          }
          self.checkDone()
        }
      }
    }

    let mainDone: @convention(block) (Bool, JSValue) -> Void = { [weak self] ok, value in
      guard let self else { return }
      if ok {
        self.mainSettled = true
        self.mainResult = value.isUndefined ? nil : value.toString()
        self.checkDone()
      } else {
        let message = value.toString() ?? "Error"
        self.log("error", message)
        self.finish(error: message)
      }
    }

    native.setObject(callSync, forKeyedSubscript: "callSync" as NSString)
    native.setObject(callAsync, forKeyedSubscript: "callAsync" as NSString)
    native.setObject(mainDone, forKeyedSubscript: "mainDone" as NSString)
    context.setObject(native, forKeyedSubscript: "__native" as NSString)
  }

  private func installWatchdog() {
    guard let setTimeLimit else { return }
    let group = JSContextGetGroup(context.jsGlobalContextRef)
    let me = Unmanaged.passUnretained(self).toOpaque()
    setTimeLimit(group, 0.25, { _, info in
      guard let info else { return false }
      return Unmanaged<ScriptRun>.fromOpaque(info).takeUnretainedValue().cancelled
    }, me)
  }

  static func describe(_ exception: JSValue) -> String {
    var text = exception.toString() ?? "Error"
    if let line = exception.forProperty("line"), line.isNumber {
      text += " (line \(line.toInt32()))"
    }
    if let stack = exception.forProperty("stack"), stack.isString, !stack.toString().isEmpty {
      text += "\n" + stack.toString()
    }
    return text
  }
}
