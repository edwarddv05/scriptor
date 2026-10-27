import CryptoKit
import Foundation
import Security

/// Hashes, HMAC, AES-GCM and secure random bytes on top of CryptoKit.
enum CryptoAPI {
  static func register(_ r: NativeRegistry) {
    r.sync("crypto.random") { _, a in
      var bytes = [UInt8](repeating: 0, count: max(0, min(a.int(0, 16), 65_536)))
      guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        throw ScriptError("Random generator failed")
      }
      return Data(bytes)
    }
    r.sync("crypto.uuid") { _, _ in UUID().uuidString.lowercased() }

    // (algorithm, data) -> Uint8Array
    r.sync("crypto.digest") { _, a in
      let data = try a.data(1)
      switch normalize(try a.string(0)) {
      case "sha1": return Data(Insecure.SHA1.hash(data: data))
      case "md5": return Data(Insecure.MD5.hash(data: data))
      case "sha256": return Data(SHA256.hash(data: data))
      case "sha384": return Data(SHA384.hash(data: data))
      case "sha512": return Data(SHA512.hash(data: data))
      case let other: throw ScriptError("Unsupported hash \(other)")
      }
    }

    // (algorithm, key, data) -> Uint8Array
    r.sync("crypto.hmac") { _, a in
      let key = SymmetricKey(data: try a.data(1))
      let data = try a.data(2)
      switch normalize(try a.string(0)) {
      case "sha1": return Data(HMAC<Insecure.SHA1>.authenticationCode(for: data, using: key))
      case "md5": return Data(HMAC<Insecure.MD5>.authenticationCode(for: data, using: key))
      case "sha256": return Data(HMAC<SHA256>.authenticationCode(for: data, using: key))
      case "sha384": return Data(HMAC<SHA384>.authenticationCode(for: data, using: key))
      case "sha512": return Data(HMAC<SHA512>.authenticationCode(for: data, using: key))
      case let other: throw ScriptError("Unsupported HMAC \(other)")
      }
    }

    // (key 16/24/32 bytes, plaintext) -> nonce(12) + ciphertext + tag(16)
    r.sync("crypto.aesEncrypt") { _, a in
      let sealed = try AES.GCM.seal(try a.data(1), using: SymmetricKey(data: try a.data(0)))
      guard let combined = sealed.combined else { throw ScriptError("Encryption failed") }
      return combined
    }
    r.sync("crypto.aesDecrypt") { _, a in
      let box = try AES.GCM.SealedBox(combined: try a.data(1))
      return try AES.GCM.open(box, using: SymmetricKey(data: try a.data(0)))
    }
  }

  private static func normalize(_ name: String) -> String {
    name.lowercased().replacingOccurrences(of: "-", with: "")
  }
}
