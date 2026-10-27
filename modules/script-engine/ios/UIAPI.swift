import Foundation
import QuickLook
import UIKit
import UniformTypeIdentifiers
import UserNotifications

/// Dialogs, share sheet, Quick Look, haptics, pasteboard (any file type), notifications, open URL.
enum UIAPI {
  static func register(_ r: NativeRegistry) {
    // (title, message, { buttons: [..] | actions: [{ title, style }], style: 'alert'|'sheet', cancel,
    //   destructive, fields: [{ placeholder, value, secure, keyboard, align, textColor, font }] })
    // -> { index, values } ; index -1 means cancelled
    r.async("ui.alert") { _, a, done in
      let title = a.optString(0)
      let message = a.optString(1)
      let opts = a.dict(2)
      DispatchQueue.main.async {
        let fields = (opts["fields"] as? [[String: Any]]) ?? []
        // Action sheets cannot hold text fields, so those fall back to an alert.
        let sheet = (opts["style"] as? String) == "sheet" && fields.isEmpty
        let alert = UIAlertController(title: title, message: message, preferredStyle: sheet ? .actionSheet : .alert)
        for field in fields {
          alert.addTextField { tf in
            tf.placeholder = field["placeholder"] as? String
            tf.text = field["value"] as? String
            tf.isSecureTextEntry = (field["secure"] as? Bool) ?? false
            tf.keyboardType = keyboard(field["keyboard"] as? String)
            tf.textAlignment = (field["align"] as? String) == "center" ? .center : (field["align"] as? String) == "right" ? .right : .natural
            if let color = Style.color(field["textColor"]) { tf.textColor = color }
            if let font = Style.font(field["font"]) { tf.font = font }
          }
        }
        let values = { alert.textFields?.map { $0.text ?? "" } ?? [] }
        var actions = (opts["actions"] as? [[String: Any]]) ?? []
        if actions.isEmpty {
          let destructive = (opts["destructive"] as? NSNumber)?.intValue
          actions = ((opts["buttons"] as? [String]) ?? ["OK"]).enumerated().map { i, label in
            ["title": label, "style": i == destructive ? "destructive" : "default"]
          }
        }
        for (i, action) in actions.enumerated() {
          let style: UIAlertAction.Style = (action["style"] as? String) == "destructive" ? .destructive : .default
          alert.addAction(UIAlertAction(title: action["title"] as? String, style: style) { _ in
            done(.success(["index": i, "values": values()]))
          })
        }
        if let cancel = opts["cancel"] as? String {
          alert.addAction(UIAlertAction(title: cancel, style: .cancel) { _ in
            done(.success(["index": -1, "values": values()]))
          })
        }
        Presenter.present(alert)
      }
    }

    // (title, options[]) -> index | -1
    r.async("ui.menu") { _, a, done in
      let title = a.optString(0)
      let options = a.stringArray(1)
      DispatchQueue.main.async {
        let sheet = UIAlertController(title: title, message: nil, preferredStyle: .actionSheet)
        for (i, label) in options.enumerated() {
          sheet.addAction(UIAlertAction(title: label, style: .default) { _ in done(.success(i)) })
        }
        sheet.addAction(UIAlertAction(title: "Cancelar", style: .cancel) { _ in done(.success(-1)) })
        Presenter.present(sheet)
      }
    }

    // (items: strings, file paths or URLs) -> activity type | null
    r.async("ui.share") { _, a, done in
      let raw = a.value(0)?.isArray == true ? a.stringArray(0) : [a.optString(0) ?? ""]
      let items: [Any] = raw.map { item -> Any in
        if item.hasPrefix("/") || item.hasPrefix("file://") { return Paths.resolve(item) }
        if let url = URL(string: item), url.scheme?.hasPrefix("http") == true { return url }
        let local = Paths.resolve(item)
        return FileManager.default.fileExists(atPath: local.path) ? local : item
      }
      DispatchQueue.main.async {
        let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
        vc.completionWithItemsHandler = { type, completed, _, _ in
          done(.success(completed ? type?.rawValue : nil))
        }
        Presenter.present(vc)
      }
    }

    // (paths) -> resolves when Quick Look is dismissed. Plays video/audio, shows PDFs, images, docs.
    r.async("ui.preview") { _, a, done in
      let paths = (a.value(0)?.isArray == true ? a.stringArray(0) : [a.optString(0) ?? ""]).map(Paths.resolve)
      DispatchQueue.main.async {
        let ql = QLPreviewController()
        let source = PreviewSource(urls: paths) { done(.success(nil)) }
        ql.dataSource = source
        ql.delegate = source
        Presenter.present(ql, retaining: source)
      }
    }

    r.sync("ui.haptic") { _, a in
      let kind = a.optString(0) ?? "medium"
      DispatchQueue.main.async {
        switch kind {
        case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
        case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
        case "selection": UISelectionFeedbackGenerator().selectionChanged()
        case "light": UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case "heavy": UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        default: UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        }
      }
      return nil
    }

    r.async("ui.openURL") { _, a, done in
      do {
        let text = try a.string(0)
        guard let url = URL(string: text) else { throw ScriptError("Invalid URL: \(text)") }
        DispatchQueue.main.async { UIApplication.shared.open(url) { ok in done(.success(ok)) } }
      } catch { done(.failure(error)) }
    }

    // MARK: Pasteboard

    r.sync("pasteboard.getText") { _, _ in
      var text: String?
      DispatchQueue.main.sync { text = UIPasteboard.general.string }
      return text
    }
    r.sync("pasteboard.setText") { _, a in
      let text = try a.string(0)
      DispatchQueue.main.sync { UIPasteboard.general.string = text }
      return nil
    }
    // Copies any file (video, PDF, zip...) with its real type so other apps can paste it.
    r.sync("pasteboard.copyFile") { _, a in
      let url = Paths.resolve(try a.string(0))
      let data = try Data(contentsOf: url, options: .mappedIfSafe)
      let type = UTType(filenameExtension: url.pathExtension)?.identifier ?? UTType.data.identifier
      DispatchQueue.main.sync { UIPasteboard.general.setData(data, forPasteboardType: type) }
      return nil
    }
    // (dest?) -> { path, type } of the first non-text item, or null
    r.sync("pasteboard.pasteFile") { _, a in
      var found: (Data, String)?
      DispatchQueue.main.sync {
        let pb = UIPasteboard.general
        for type in pb.types where !(UTType(type)?.conforms(to: .text) ?? false) {
          if let data = pb.data(forPasteboardType: type) { found = (data, type); break }
        }
      }
      guard let found else { return nil }
      let (data, type) = found
      let ext = UTType(type)?.preferredFilenameExtension ?? "dat"
      let out = Paths.output(a.optString(0), ext: ext)
      try data.write(to: out)
      return ["path": out.path, "type": type]
    }

    // MARK: Local notifications

    // ({ title, body, subtitle, at (ms), in (seconds), attachment (path), sound, id, badge, threadIdentifier,
    //    userInfo, openURL, scriptName, actions: [{ title, url, destructive }],
    //    trigger: { type: 'date', at } | { type: 'daily'|'weekly', weekday, hour, minute, repeats } }) -> id
    r.async("notify.schedule") { _, a, done in
      let opts = a.dict(0)
      let center = UNUserNotificationCenter.current()
      center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
        guard granted else { return done(.failure(error ?? ScriptError("Notifications not allowed"))) }
        let id = (opts["id"] as? String) ?? UUID().uuidString
        let content = UNMutableNotificationContent()
        content.title = (opts["title"] as? String) ?? ""
        content.body = (opts["body"] as? String) ?? ""
        content.subtitle = (opts["subtitle"] as? String) ?? ""
        if let thread = opts["threadIdentifier"] as? String { content.threadIdentifier = thread }
        if let badge = opts["badge"] as? NSNumber { content.badge = badge }
        // Sound: false/"none" silences it; any other value plays the default sound.
        let sound = opts["sound"]
        if (sound as? Bool) != false && (sound as? String) != "none" { content.sound = .default }
        var info = (opts["userInfo"] as? [String: Any]) ?? [:]
        info["scriptor.openURL"] = opts["openURL"] as? String
        info["scriptor.scriptName"] = opts["scriptName"] as? String
        let actions = (opts["actions"] as? [[String: Any]]) ?? []
        info["scriptor.actions"] = actions
        content.userInfo = info
        if !actions.isEmpty {
          let category = "scriptor.\(id)"
          let buttons = actions.enumerated().map { i, action in
            UNNotificationAction(
              identifier: "action.\(i)", title: (action["title"] as? String) ?? "",
              options: (action["destructive"] as? Bool) == true ? [.destructive, .foreground] : [.foreground])
          }
          let newCategory = UNNotificationCategory(identifier: category, actions: buttons, intentIdentifiers: [])
          center.getNotificationCategories { existing in
            center.setNotificationCategories(existing.filter { $0.identifier != category }.union([newCategory]))
          }
          content.categoryIdentifier = category
        }
        if let path = opts["attachment"] as? String {
          // Notification attachments are moved by iOS, so give it a copy.
          let src = Paths.resolve(path)
          let copy = Paths.tempFile(src.pathExtension)
          if (try? FileManager.default.copyItem(at: src, to: copy)) != nil,
            let attachment = try? UNNotificationAttachment(identifier: "file", url: copy)
          {
            content.attachments = [attachment]
          }
        }
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger(opts))) { error in
          if let error { done(.failure(error)) } else { done(.success(id)) }
        }
      }
    }
    r.sync("notify.cancel") { _, a in
      let id = try a.string(0)
      UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])
      UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [id])
      return nil
    }

    // ('pending' | 'delivered') -> [notification]
    r.async("notify.list") { _, a, done in
      let center = UNUserNotificationCenter.current()
      if a.optString(0) == "delivered" {
        center.getDeliveredNotifications { list in
          done(.success(list.map { describe($0.request, delivered: $0.date) }))
        }
      } else {
        center.getPendingNotificationRequests { list in done(.success(list.map { describe($0, delivered: nil) })) }
      }
    }
    // ('pending' | 'delivered', ids | null): null removes all
    r.sync("notify.remove") { _, a in
      let center = UNUserNotificationCenter.current()
      let ids = a.value(1) == nil ? nil : a.stringArray(1)
      if a.optString(0) == "delivered" {
        if let ids { center.removeDeliveredNotifications(withIdentifiers: ids) } else { center.removeAllDeliveredNotifications() }
      } else {
        if let ids { center.removePendingNotificationRequests(withIdentifiers: ids) } else { center.removeAllPendingNotificationRequests() }
      }
      return nil
    }
  }

  static func keyboard(_ name: String?) -> UIKeyboardType {
    switch name {
    case "numberPad": return .numberPad
    case "decimalPad": return .decimalPad
    case "numbersAndPunctuation": return .numbersAndPunctuation
    case "phonePad": return .phonePad
    case "webSearch": return .webSearch
    case "emailAddress": return .emailAddress
    case "uRL", "url": return .URL
    case "twitter": return .twitter
    default: return .default
    }
  }

  private static func trigger(_ opts: [String: Any]) -> UNNotificationTrigger? {
    if let t = opts["trigger"] as? [String: Any] {
      let repeats = (t["repeats"] as? Bool) ?? false
      switch t["type"] as? String {
      case "daily", "weekly":
        var c = DateComponents()
        c.hour = (t["hour"] as? NSNumber)?.intValue
        c.minute = (t["minute"] as? NSNumber)?.intValue
        if t["type"] as? String == "weekly" { c.weekday = (t["weekday"] as? NSNumber)?.intValue }
        return UNCalendarNotificationTrigger(dateMatching: c, repeats: repeats)
      case "date":
        guard let at = num(t["at"]) else { return nil }
        let c = Calendar.current.dateComponents(
          [.year, .month, .day, .hour, .minute, .second], from: Date(timeIntervalSince1970: at / 1000))
        return UNCalendarNotificationTrigger(dateMatching: c, repeats: false)
      default:
        break
      }
    }
    var seconds = num(opts["in"]) ?? 0
    if let at = num(opts["at"]) { seconds = at / 1000 - Date().timeIntervalSince1970 }
    return seconds > 0 ? UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats: false) : nil
  }

  private static func describe(_ request: UNNotificationRequest, delivered: Date?) -> [String: Any] {
    let c = request.content
    var info = (c.userInfo as? [String: Any]) ?? [:]
    let openURL = info.removeValue(forKey: "scriptor.openURL")
    let scriptName = info.removeValue(forKey: "scriptor.scriptName")
    let actions = info.removeValue(forKey: "scriptor.actions")
    var out: [String: Any] = [
      "id": request.identifier, "title": c.title, "subtitle": c.subtitle, "body": c.body,
      "threadIdentifier": c.threadIdentifier, "userInfo": info, "openURL": openURL ?? NSNull(),
      "scriptName": scriptName ?? NSNull(), "actions": actions ?? [Any](), "badge": c.badge.map { $0 as Any } ?? NSNull(),
    ]
    if let delivered { out["deliveryDate"] = delivered.timeIntervalSince1970 * 1000 }
    let next: Date? = (request.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate()
      ?? (request.trigger as? UNTimeIntervalNotificationTrigger)?.nextTriggerDate()
    if let next { out["nextTriggerDate"] = next.timeIntervalSince1970 * 1000 }
    return out
  }
}

/// Shows notifications while the app is open and handles taps: opens the notification's URL
/// (or the tapped action's URL), or runs the script that scheduled it.
final class NotificationHandler: NSObject, UNUserNotificationCenterDelegate {
  static let shared = NotificationHandler()

  static func install() {
    DispatchQueue.main.async { UNUserNotificationCenter.current().delegate = shared }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    defer { completionHandler() }
    let info = response.notification.request.content.userInfo
    var target = info["scriptor.openURL"] as? String
    if response.actionIdentifier.hasPrefix("action."), let index = Int(response.actionIdentifier.dropFirst(7)),
      let actions = info["scriptor.actions"] as? [[String: Any]], index < actions.count
    {
      target = actions[index]["url"] as? String
    } else if target == nil, response.actionIdentifier == UNNotificationDefaultActionIdentifier,
      let name = info["scriptor.scriptName"] as? String,
      let encoded = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
    {
      target = "scriptor://run/\(encoded)"
    }
    guard let target, let url = URL(string: target) else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { UIApplication.shared.open(url) }
  }
}

final class PreviewSource: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  private let urls: [URL]
  private var onDismiss: (() -> Void)?

  init(urls: [URL], onDismiss: @escaping () -> Void) {
    self.urls = urls
    self.onDismiss = onDismiss
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { urls.count }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    urls[index] as NSURL
  }

  func previewControllerDidDismiss(_ controller: QLPreviewController) {
    Presenter.release(controller)
    onDismiss?()
    onDismiss = nil
  }
}
