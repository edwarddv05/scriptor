import Foundation
import QuickLook
import UIKit
import UniformTypeIdentifiers
import UserNotifications

/// Dialogs, share sheet, Quick Look, haptics, pasteboard (any file type), notifications, open URL.
enum UIAPI {
  static func register(_ r: NativeRegistry) {
    // (title, message, { buttons: [..], fields: [{ placeholder, value, secure }], cancel, destructive })
    // -> { index, values } ; index -1 means cancelled
    r.async("ui.alert") { _, a, done in
      let title = a.optString(0)
      let message = a.optString(1)
      let opts = a.dict(2)
      DispatchQueue.main.async {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        let fields = (opts["fields"] as? [[String: Any]]) ?? []
        for field in fields {
          alert.addTextField { tf in
            tf.placeholder = field["placeholder"] as? String
            tf.text = field["value"] as? String
            tf.isSecureTextEntry = (field["secure"] as? Bool) ?? false
          }
        }
        let values = { alert.textFields?.map { $0.text ?? "" } ?? [] }
        let buttons = (opts["buttons"] as? [String]) ?? ["OK"]
        let destructive = opts["destructive"] as? Int
        for (i, label) in buttons.enumerated() {
          alert.addAction(UIAlertAction(title: label, style: i == destructive ? .destructive : .default) { _ in
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

    // ({ title, body, subtitle, at (ms), in (seconds), attachment (path), sound, id }) -> id
    r.async("notify.schedule") { _, a, done in
      let opts = a.dict(0)
      let center = UNUserNotificationCenter.current()
      center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
        guard granted else { return done(.failure(error ?? ScriptError("Notifications not allowed"))) }
        let content = UNMutableNotificationContent()
        content.title = (opts["title"] as? String) ?? ""
        content.body = (opts["body"] as? String) ?? ""
        content.subtitle = (opts["subtitle"] as? String) ?? ""
        if (opts["sound"] as? Bool) ?? true { content.sound = .default }
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
        var seconds = (opts["in"] as? Double) ?? 0
        if let at = opts["at"] as? Double { seconds = at / 1000 - Date().timeIntervalSince1970 }
        let trigger = seconds > 0 ? UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats: false) : nil
        let id = (opts["id"] as? String) ?? UUID().uuidString
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger)) { error in
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
