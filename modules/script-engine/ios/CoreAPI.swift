import AVFoundation
import Foundation
import Security
import UIKit

/// console, timers, Script, text encoding, base64, URL parsing, Device and Keychain.
enum CoreAPI {
  static func register(_ r: NativeRegistry) {
    r.sync("console.write") { run, a in
      run.log(try a.string(0), try a.string(1))
      return nil
    }

    r.sync("timer.set") { run, a in
      run.setTimer(id: a.int(0, 0), ms: a.double(1, 0), repeats: a.bool(2, false))
      return nil
    }
    r.sync("timer.clear") { run, a in
      run.clearTimer(id: a.int(0, 0))
      return nil
    }

    r.sync("script.info") { run, _ in
      [
        "name": run.name, "input": run.input, "documents": Paths.documents.path,
        "firstWeekday": Calendar.current.firstWeekday,
      ]
    }
    r.sync("script.complete") { run, a in
      run.finish(result: a.optString(0))
      return nil
    }

    r.sync("text.encode") { _, a in Data(try a.string(0).utf8) }
    r.sync("text.decode") { _, a in
      let data = try a.data(0)
      return String(decoding: data, as: UTF8.self)
    }
    r.sync("base64.encode") { _, a in try a.data(0).base64EncodedString() }
    r.sync("base64.decode") { _, a in
      let text = try a.string(0)
      guard let data = Data(base64Encoded: text, options: .ignoreUnknownCharacters) else {
        throw ScriptError("Invalid base64")
      }
      return data
    }

    r.sync("url.parse") { _, a in
      let input = try a.string(0)
      let base = a.optString(1).flatMap { URL(string: $0) }
      guard let url = URL(string: input, relativeTo: base)?.absoluteURL,
        let c = URLComponents(url: url, resolvingAgainstBaseURL: true), c.scheme != nil
      else { throw ScriptError("Invalid URL: \(input)") }
      return [
        "protocol": (c.scheme ?? "") + ":",
        "username": c.percentEncodedUser ?? "",
        "password": c.percentEncodedPassword ?? "",
        "hostname": c.percentEncodedHost ?? "",
        "port": c.port.map(String.init) ?? "",
        "pathname": c.percentEncodedPath.isEmpty ? "/" : c.percentEncodedPath,
        "search": c.percentEncodedQuery.map { "?" + $0 } ?? "",
        "hash": c.percentEncodedFragment.map { "#" + $0 } ?? "",
      ]
    }

    r.sync("device.info") { _, _ in
      var info: [String: Any] = [:]
      DispatchQueue.main.sync {
        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        if !device.isGeneratingDeviceOrientationNotifications { device.beginGeneratingDeviceOrientationNotifications() }
        let screen = UIScreen.main
        let states = ["unknown", "unplugged", "charging", "full"]
        info = [
          "name": device.name,
          "model": device.model,
          "systemName": device.systemName,
          "systemVersion": device.systemVersion,
          "battery": Double(device.batteryLevel),
          "batteryState": states[min(device.batteryState.rawValue, 3)],
          "lowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled,
          "screen": ["width": screen.bounds.width, "height": screen.bounds.height, "scale": screen.scale],
          "brightness": Double(screen.brightness),
          "darkMode": UITraitCollection.current.userInterfaceStyle == .dark,
          "idiom": device.userInterfaceIdiom == .pad ? "pad" : "phone",
          // UIDeviceOrientation raw values: 1 portrait, 2 upside down, 3/4 landscape, 5/6 face up/down.
          "orientation": device.orientation.rawValue,
        ]
      }
      info["locale"] = Locale.current.identifier
      info["languages"] = Locale.preferredLanguages
      info["timeZone"] = TimeZone.current.identifier
      info["memory"] = Double(ProcessInfo.processInfo.physicalMemory)
      info["volume"] = Double(AVAudioSession.sharedInstance().outputVolume)
      if let values = try? Paths.documents.resourceValues(forKeys: [
        .volumeAvailableCapacityForImportantUsageKey, .volumeTotalCapacityKey,
      ]) {
        info["freeDisk"] = Double(values.volumeAvailableCapacityForImportantUsage ?? 0)
        info["totalDisk"] = Double(values.volumeTotalCapacity ?? 0)
      }
      return info
    }

    r.sync("device.setBrightness") { _, a in
      let value = CGFloat(a.double(0, 0.5))
      DispatchQueue.main.async { UIScreen.main.brightness = value }
      return nil
    }

    r.sync("keychain.set") { _, a in
      let key = try a.string(0)
      let value = Data(try a.string(1).utf8)
      let query = keychainQuery(key)
      SecItemDelete(query as CFDictionary)
      var add = query
      add[kSecValueData as String] = value
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
      let status = SecItemAdd(add as CFDictionary, nil)
      guard status == errSecSuccess else { throw ScriptError("Keychain error \(status)") }
      return nil
    }
    r.sync("keychain.get") { _, a in
      var query = keychainQuery(try a.string(0))
      query[kSecReturnData as String] = true
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      var out: CFTypeRef?
      guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else {
        return nil
      }
      return String(decoding: data, as: UTF8.self)
    }
    r.sync("keychain.remove") { _, a in
      SecItemDelete(keychainQuery(try a.string(0)) as CFDictionary)
      return nil
    }
  }

  private static func keychainQuery(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "scriptor.scripts",
      kSecAttrAccount as String: key,
    ]
  }
}
