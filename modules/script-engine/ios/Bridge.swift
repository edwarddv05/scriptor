import Foundation
import JavaScriptCore

/// Error thrown by native handlers; its message reaches the script as a JS Error.
struct ScriptError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

typealias SyncHandler = (ScriptRun, Args) throws -> Any?
typealias Completion = (Result<Any?, Error>) -> Void
typealias AsyncHandler = (ScriptRun, Args, @escaping Completion) -> Void

/// Name -> handler table shared by every run. Each API file registers its functions here.
final class NativeRegistry {
  static let shared = NativeRegistry()

  private(set) var sync: [String: SyncHandler] = [:]
  private(set) var async: [String: AsyncHandler] = [:]

  private init() {
    CoreAPI.register(self)
    FileAPI.register(self)
    NetAPI.register(self)
    CryptoAPI.register(self)
    PhotosAPI.register(self)
    MediaAPI.register(self)
    VideoAPI.register(self)
    UIAPI.register(self)
    WebAPI.register(self)
    TableAPI.register(self)
    ViewAPI.register(self)
    GraphicsAPI.register(self)
    FormatAPI.register(self)
    LocationAPI.register(self)
    CalendarAPI.register(self)
    ContactsAPI.register(self)
    ServerAPI.register(self)
    SystemUIAPI.register(self)
  }

  func sync(_ name: String, _ handler: @escaping SyncHandler) { sync[name] = handler }
  func async(_ name: String, _ handler: @escaping AsyncHandler) { async[name] = handler }
}

/// Arguments of one native call. Only read them on the run's queue, before going async.
struct Args {
  let values: [JSValue]
  /// Id of the async call (0 for sync calls); used for emit() and cancellation.
  let callId: Int

  init(_ array: JSValue, callId: Int = 0) {
    self.callId = callId
    var out: [JSValue] = []
    if array.isArray, let length = array.forProperty("length")?.toInt32() {
      for i in 0..<Int(length) { out.append(array.atIndex(i)) }
    }
    values = out
  }

  func value(_ i: Int) -> JSValue? {
    guard i < values.count else { return nil }
    let v = values[i]
    return (v.isUndefined || v.isNull) ? nil : v
  }

  func string(_ i: Int) throws -> String {
    guard let v = value(i) else { throw ScriptError("Argument \(i + 1) is required") }
    return v.toString()
  }

  func optString(_ i: Int) -> String? { value(i)?.toString() }

  func double(_ i: Int, _ fallback: Double) -> Double {
    guard let v = value(i), v.isNumber else { return fallback }
    return v.toDouble()
  }

  func int(_ i: Int, _ fallback: Int) -> Int { Int(double(i, Double(fallback))) }

  func bool(_ i: Int, _ fallback: Bool) -> Bool {
    guard let v = value(i), v.isBoolean else { return fallback }
    return v.toBool()
  }

  func dict(_ i: Int) -> [String: Any] {
    guard let v = value(i), v.isObject else { return [:] }
    return (v.toDictionary() as? [String: Any]) ?? [:]
  }

  func stringArray(_ i: Int) -> [String] {
    guard let v = value(i), v.isArray else { return [] }
    return (v.toArray() ?? []).map { "\($0)" }
  }

  /// Uint8Array / ArrayBuffer bytes, or the UTF-8 bytes of a string.
  func data(_ i: Int) throws -> Data {
    guard let v = value(i) else { throw ScriptError("Argument \(i + 1) is required") }
    if v.isString { return Data(v.toString().utf8) }
    guard let d = JSConvert.data(from: v) else { throw ScriptError("Argument \(i + 1) must be a string or Uint8Array") }
    return d
  }
}

enum JSConvert {
  /// Reads a Uint8Array or ArrayBuffer. The prelude always passes views with byteOffset 0.
  static func data(from value: JSValue) -> Data? {
    guard let ctx = value.context?.jsGlobalContextRef else { return nil }
    var ex: JSValueRef? = nil
    let type = JSValueGetTypedArrayType(ctx, value.jsValueRef, &ex)
    if type == kJSTypedArrayTypeNone { return nil }
    guard let obj = JSValueToObject(ctx, value.jsValueRef, &ex) else { return nil }
    if type == kJSTypedArrayTypeArrayBuffer {
      let length = JSObjectGetArrayBufferByteLength(ctx, obj, &ex)
      guard length > 0, let ptr = JSObjectGetArrayBufferBytesPtr(ctx, obj, &ex) else { return Data() }
      return Data(bytes: ptr, count: length)
    }
    let length = JSObjectGetTypedArrayByteLength(ctx, obj, &ex)
    guard length > 0, let ptr = JSObjectGetTypedArrayBytesPtr(ctx, obj, &ex) else { return Data() }
    return Data(bytes: ptr, count: length)
  }

  static func uint8Array(_ data: Data, in context: JSContext) -> JSValue {
    let ctx = context.jsGlobalContextRef
    var ex: JSValueRef? = nil
    guard let obj = JSObjectMakeTypedArray(ctx, kJSTypedArrayTypeUint8Array, data.count, &ex) else {
      return JSValue(undefinedIn: context)
    }
    if data.count > 0, let ptr = JSObjectGetTypedArrayBytesPtr(ctx, obj, &ex) {
      data.copyBytes(to: ptr.assumingMemoryBound(to: UInt8.self), count: data.count)
    }
    return JSValue(jsValueRef: obj, in: context)
  }

  static func toJS(_ any: Any?, in context: JSContext) -> JSValue {
    switch any {
    case nil:
      return JSValue(nullIn: context)
    case let v as JSValue:
      return v
    case let d as Data:
      return uint8Array(d, in: context)
    case let date as Date:
      return JSValue(object: date, in: context)
    case let dict as [String: Any]:
      let obj = JSValue(newObjectIn: context)!
      for (k, v) in dict { obj.setValue(toJS(v, in: context), forProperty: k) }
      return obj
    case let arr as [Any]:
      let out = JSValue(newArrayIn: context)!
      for (i, v) in arr.enumerated() { out.setValue(toJS(v, in: context), at: i) }
      return out
    case let url as URL:
      return JSValue(object: url.isFileURL ? url.path : url.absoluteString, in: context)
    case is NSNull:
      return JSValue(nullIn: context)
    default:
      return JSValue(object: any, in: context)
    }
  }
}
