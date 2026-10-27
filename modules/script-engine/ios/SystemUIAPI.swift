import AVFoundation
import Foundation
import MessageUI
import SafariServices
import Speech
import UIKit

/// Mail, Message, Safari.openInApp, DatePicker, Dictation and CallbackURL.
enum SystemUIAPI {
  static func register(_ r: NativeRegistry) {
    registerCompose(r)

    // (url, fullscreen) -> resolves when the Safari view is closed
    r.async("safari.openInApp") { _, a, done in
      guard let text = a.optString(0), let url = URL(string: text), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
        return done(.failure(ScriptError("Safari only opens http(s) URLs")))
      }
      let fullscreen = a.bool(1, false)
      DispatchQueue.main.async {
        let safari = SFSafariViewController(url: url)
        safari.modalPresentationStyle = fullscreen ? .fullScreen : .pageSheet
        let delegate = SafariDelegate(done: done)
        safari.delegate = delegate
        Presenter.present(safari, retaining: delegate)
      }
    }

    // ({ mode, min, max, initial, minuteInterval, countdown }) -> ms (or seconds for countdown)
    r.async("ui.datePicker") { _, a, done in
      let opts = a.dict(0)
      DispatchQueue.main.async {
        let picker = DatePickerController(opts: opts, done: done)
        let nav = UINavigationController(rootViewController: picker)
        nav.modalPresentationStyle = .pageSheet
        if let sheet = nav.sheetPresentationController { sheet.detents = [.medium(), .large()] }
        nav.presentationController?.delegate = picker
        Presenter.topController()?.present(nav, animated: true)
      }
    }

    // (locale) -> transcribed text
    r.async("dictation.start") { _, a, done in
      let locale = a.optString(0)
      SFSpeechRecognizer.requestAuthorization { status in
        guard status == .authorized else { return done(.failure(ScriptError("Speech recognition not allowed"))) }
        requestMicrophone { granted in
          guard granted else { return done(.failure(ScriptError("Microphone access denied"))) }
          DispatchQueue.main.async {
            let vc = DictationController(locale: locale, done: done)
            let nav = UINavigationController(rootViewController: vc)
            nav.modalPresentationStyle = .pageSheet
            if let sheet = nav.sheetPresentationController { sheet.detents = [.medium()] }
            nav.presentationController?.delegate = vc
            Presenter.topController()?.present(nav, animated: true)
          }
        }
      }
    }

    // (url, token) -> query parameters of the x-success callback
    r.async("callback.open") { _, a, done in
      guard let text = a.optString(0), let url = URL(string: text), let token = a.optString(1) else {
        return done(.failure(ScriptError("Invalid callback URL")))
      }
      CallbackURLs.wait(token, done)
      DispatchQueue.main.async {
        UIApplication.shared.open(url) { ok in
          if !ok { CallbackURLs.deliver(token: token, status: "error", params: ["errorMessage": "No app can open \(text)"]) }
        }
      }
    }
  }

  private static func requestMicrophone(_ completion: @escaping (Bool) -> Void) {
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission(completionHandler: completion)
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission(completion)
    }
  }

  // MARK: Mail and Message

  private static func registerCompose(_ r: NativeRegistry) {
    // ({ to, cc, bcc, subject, body, html, from, attachments: [{ path, mime, name }] }) -> 'sent' | 'saved' | 'cancelled' | 'failed'
    r.async("mail.send") { _, a, done in
      let opts = a.dict(0)
      DispatchQueue.main.async {
        guard MFMailComposeViewController.canSendMail() else {
          return done(.failure(ScriptError("Mail is not set up on this device")))
        }
        let vc = MFMailComposeViewController()
        vc.setToRecipients(opts["to"] as? [String])
        vc.setCcRecipients(opts["cc"] as? [String])
        vc.setBccRecipients(opts["bcc"] as? [String])
        vc.setSubject((opts["subject"] as? String) ?? "")
        vc.setMessageBody((opts["body"] as? String) ?? "", isHTML: (opts["html"] as? Bool) ?? false)
        if let from = opts["from"] as? String { vc.setPreferredSendingEmailAddress(from) }
        for item in (opts["attachments"] as? [[String: Any]]) ?? [] {
          guard let path = item["path"] as? String, let data = try? Data(contentsOf: Paths.resolve(path)) else { continue }
          vc.addAttachmentData(data, mimeType: (item["mime"] as? String) ?? "application/octet-stream", fileName: (item["name"] as? String) ?? "file")
        }
        let delegate = ComposeDelegate(done: done)
        vc.mailComposeDelegate = delegate
        Presenter.present(vc, retaining: delegate)
      }
    }

    // ({ recipients, body, attachments }) -> 'sent' | 'cancelled' | 'failed'
    r.async("message.send") { _, a, done in
      let opts = a.dict(0)
      DispatchQueue.main.async {
        guard MFMessageComposeViewController.canSendText() else {
          return done(.failure(ScriptError("This device cannot send messages")))
        }
        let vc = MFMessageComposeViewController()
        vc.recipients = opts["recipients"] as? [String]
        vc.body = opts["body"] as? String
        for item in (opts["attachments"] as? [[String: Any]]) ?? [] {
          guard let path = item["path"] as? String else { continue }
          vc.addAttachmentURL(Paths.resolve(path), withAlternateFilename: item["name"] as? String)
        }
        let delegate = ComposeDelegate(done: done)
        vc.messageComposeDelegate = delegate
        Presenter.present(vc, retaining: delegate)
      }
    }
  }
}

/// Pending CallbackURL.open() calls, completed when scriptor://x-callback/<token>/<status> comes back.
enum CallbackURLs {
  private static var pending: [String: Completion] = [:]
  private static let lock = NSLock()

  static func wait(_ token: String, _ done: @escaping Completion) {
    lock.lock()
    pending[token] = done
    lock.unlock()
  }

  static func deliver(token: String, status: String, params: [String: String]) {
    lock.lock()
    let done = pending.removeValue(forKey: token)
    lock.unlock()
    guard let done else { return }
    switch status {
    case "success": done(.success(params))
    case "cancel": done(.failure(ScriptError("The callback was cancelled")))
    default: done(.failure(ScriptError(params["errorMessage"] ?? params["error"] ?? "The callback failed")))
    }
  }
}

private final class SafariDelegate: NSObject, SFSafariViewControllerDelegate {
  private var done: Completion?
  init(done: @escaping Completion) { self.done = done }
  func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
    Presenter.release(controller)
    done?(.success(nil))
    done = nil
  }
}

private final class ComposeDelegate: NSObject, MFMailComposeViewControllerDelegate, MFMessageComposeViewControllerDelegate {
  private var done: Completion?
  init(done: @escaping Completion) { self.done = done }

  private func finish(_ controller: UIViewController, _ result: String) {
    controller.dismiss(animated: true)
    Presenter.release(controller)
    done?(.success(result))
    done = nil
  }

  func mailComposeController(_ controller: MFMailComposeViewController, didFinishWith result: MFMailComposeResult, error: Error?) {
    let names: [MFMailComposeResult: String] = [.sent: "sent", .saved: "saved", .cancelled: "cancelled", .failed: "failed"]
    finish(controller, names[result] ?? "failed")
  }

  func messageComposeViewController(_ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult) {
    let names: [MessageComposeResult: String] = [.sent: "sent", .cancelled: "cancelled", .failed: "failed"]
    finish(controller, names[result] ?? "failed")
  }
}

/// Sheet with a UIDatePicker and Cancel / Done buttons. Cancelling rejects, like Scriptable.
private final class DatePickerController: UIViewController, UIAdaptivePresentationControllerDelegate {
  private let picker = UIDatePicker()
  private let opts: [String: Any]
  private var done: Completion?

  init(opts: [String: Any], done: @escaping Completion) {
    self.opts = opts
    self.done = done
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private var isCountdown: Bool { (opts["mode"] as? String) == "countdown" }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    switch opts["mode"] as? String {
    case "time": picker.datePickerMode = .time
    case "date": picker.datePickerMode = .date
    case "countdown": picker.datePickerMode = .countDownTimer
    default: picker.datePickerMode = .dateAndTime
    }
    picker.preferredDatePickerStyle = isCountdown ? .wheels : (picker.datePickerMode == .time ? .wheels : .inline)
    picker.minuteInterval = max(1, min(30, Int(num(opts["minuteInterval"]) ?? 1)))
    if let min = num(opts["min"]) { picker.minimumDate = Date(timeIntervalSince1970: min / 1000) }
    if let max = num(opts["max"]) { picker.maximumDate = Date(timeIntervalSince1970: max / 1000) }
    if isCountdown {
      picker.countDownDuration = num(opts["countdown"]) ?? 0
    } else if let initial = num(opts["initial"]) {
      picker.date = Date(timeIntervalSince1970: initial / 1000)
    }
    picker.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(picker)
    NSLayoutConstraint.activate([
      picker.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
      picker.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 8),
      picker.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -8),
    ])
    navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.cancel() })
    navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in self?.confirm() })
  }

  private func confirm() {
    let value: Double = isCountdown ? picker.countDownDuration : picker.date.timeIntervalSince1970 * 1000
    done?(.success(value))
    done = nil
    dismiss(animated: true)
  }

  private func cancel() {
    done?(.failure(ScriptError("The date picker was cancelled")))
    done = nil
    dismiss(animated: true)
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    done?(.failure(ScriptError("The date picker was cancelled")))
    done = nil
  }
}

/// Live speech-to-text sheet; "Done" returns the transcript.
private final class DictationController: UIViewController, UIAdaptivePresentationControllerDelegate {
  private let recognizer: SFSpeechRecognizer?
  private let engine = AVAudioEngine()
  private let request = SFSpeechAudioBufferRecognitionRequest()
  private var task: SFSpeechRecognitionTask?
  private let label = UILabel()
  private var text = ""
  private var done: Completion?

  init(locale: String?, done: @escaping Completion) {
    recognizer = locale.map { SFSpeechRecognizer(locale: Locale(identifier: $0)) } ?? SFSpeechRecognizer()
    self.done = done
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    title = "Dictado"
    label.numberOfLines = 0
    label.font = .preferredFont(forTextStyle: .title3)
    label.textColor = .secondaryLabel
    label.text = "Habla ahora…"
    label.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(label)
    NSLayoutConstraint.activate([
      label.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 20),
      label.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
      label.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
    ])
    navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.finish(cancelled: true) })
    navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in self?.finish(cancelled: false) })
    start()
  }

  private func start() {
    guard let recognizer, recognizer.isAvailable else {
      label.text = "El reconocimiento de voz no está disponible."
      return
    }
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .measurement, options: .duckOthers)
      try session.setActive(true, options: .notifyOthersOnDeactivation)
      request.shouldReportPartialResults = true
      let input = engine.inputNode
      // The tap runs on an audio thread: give it the request, not the controller.
      let request = self.request
      input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
        request.append(buffer)
      }
      engine.prepare()
      try engine.start()
      task = recognizer.recognitionTask(with: request) { [weak self] result, _ in
        guard let self, let result else { return }
        DispatchQueue.main.async {
          self.text = result.bestTranscription.formattedString
          self.label.text = self.text
          self.label.textColor = .label
        }
      }
    } catch {
      label.text = error.localizedDescription
    }
  }

  private func stopAudio() {
    if engine.isRunning {
      engine.stop()
      engine.inputNode.removeTap(onBus: 0)
    }
    request.endAudio()
    task?.cancel()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func finish(cancelled: Bool) {
    stopAudio()
    if cancelled { done?(.failure(ScriptError("Dictation was cancelled"))) } else { done?(.success(text)) }
    done = nil
    dismiss(animated: true)
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    stopAudio()
    done?(.failure(ScriptError("Dictation was cancelled")))
    done = nil
  }
}
