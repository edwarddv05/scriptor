import UIKit

/// Runs `body` on the main thread and returns its result. Safe to call from a run's queue.
func onMain<T>(_ body: () throws -> T) rethrows -> T {
  if Thread.isMainThread { return try body() }
  return try DispatchQueue.main.sync(execute: body)
}

/// Number from a bridged JS value (NSNumber), or nil.
func num(_ any: Any?) -> Double? { (any as? NSNumber)?.doubleValue }

/// Base for screens a script presents (web views, tables).
/// Shaking the device shows a bar at the bottom to cancel or leave the script, which is the
/// only way out of a fullscreen presentation without its own close button.
class ScriptScreenController: UIViewController, UIAdaptivePresentationControllerDelegate {
  weak var run: ScriptRun?
  private var onClose: (() -> Void)?
  private var exitBar: UIView?
  private var fullscreen = false

  /// Presents this screen fullscreen (no chrome) or as a sheet with a close button.
  func show(fullscreen: Bool, onClose: @escaping () -> Void) {
    self.onClose = onClose
    self.fullscreen = fullscreen
    let container: UIViewController
    if fullscreen {
      modalPresentationStyle = .fullScreen
      container = self
    } else {
      navigationItem.rightBarButtonItem = UIBarButtonItem(
        systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.close() })
      let nav = UINavigationController(rootViewController: self)
      nav.modalPresentationStyle = .pageSheet
      container = nav
    }
    container.presentationController?.delegate = self
    Presenter.topController()?.present(container, animated: true)
  }

  func close(completion: (() -> Void)? = nil) {
    let finish = { [weak self] in
      self?.didClose()
      completion?()
    }
    if presentingViewController != nil {
      (navigationController ?? self).presentingViewController?.dismiss(animated: true, completion: finish)
    } else {
      finish()
    }
  }

  /// Called once the screen is gone, however it was dismissed.
  func didClose() {
    onClose?()
    onClose = nil
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { didClose() }

  // MARK: Shake to exit

  override var canBecomeFirstResponder: Bool { true }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    becomeFirstResponder()
    if fullscreen { showHint() }
  }

  override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
    if motion == .motionShake { showExitBar() } else { super.motionEnded(motion, with: event) }
  }

  private func showHint() {
    let label = PaddedLabel()
    label.text = "Agita el dispositivo para salir"
    label.font = .preferredFont(forTextStyle: .footnote)
    label.textColor = .white
    label.backgroundColor = UIColor.black.withAlphaComponent(0.7)
    label.layer.cornerRadius = 14
    label.clipsToBounds = true
    label.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      label.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
    ])
    UIView.animate(withDuration: 0.4, delay: 2.5, options: []) { label.alpha = 0 } completion: { _ in
      label.removeFromSuperview()
    }
  }

  private func showExitBar() {
    guard exitBar == nil else { return }
    UINotificationFeedbackGenerator().notificationOccurred(.warning)
    let bar = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterial))
    bar.layer.cornerRadius = 20
    bar.clipsToBounds = true
    bar.translatesAutoresizingMaskIntoConstraints = false

    let title = UILabel()
    title.text = "¿Salir del script?"
    title.font = .preferredFont(forTextStyle: .headline)
    title.textAlignment = .center

    var cancelConfig = UIButton.Configuration.gray()
    cancelConfig.title = "Cancelar"
    cancelConfig.cornerStyle = .large
    let cancel = UIButton(configuration: cancelConfig, primaryAction: UIAction { [weak self] _ in self?.hideExitBar() })

    var exitConfig = UIButton.Configuration.filled()
    exitConfig.title = "Salir"
    exitConfig.baseBackgroundColor = .systemRed
    exitConfig.cornerStyle = .large
    let exit = UIButton(configuration: exitConfig, primaryAction: UIAction { [weak self] _ in self?.exitScript() })

    let buttons = UIStackView(arrangedSubviews: [cancel, exit])
    buttons.axis = .horizontal
    buttons.spacing = 12
    buttons.distribution = .fillEqually
    let stack = UIStackView(arrangedSubviews: [title, buttons])
    stack.axis = .vertical
    stack.spacing = 14
    stack.translatesAutoresizingMaskIntoConstraints = false
    bar.contentView.addSubview(stack)

    view.addSubview(bar)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: bar.contentView.topAnchor, constant: 18),
      stack.bottomAnchor.constraint(equalTo: bar.contentView.bottomAnchor, constant: -18),
      stack.leadingAnchor.constraint(equalTo: bar.contentView.leadingAnchor, constant: 18),
      stack.trailingAnchor.constraint(equalTo: bar.contentView.trailingAnchor, constant: -18),
      bar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 12),
      bar.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
      bar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
    ])
    bar.transform = CGAffineTransform(translationX: 0, y: 200)
    UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0) {
      bar.transform = .identity
    }
    exitBar = bar
  }

  private func hideExitBar() {
    guard let bar = exitBar else { return }
    exitBar = nil
    UIView.animate(withDuration: 0.25) {
      bar.transform = CGAffineTransform(translationX: 0, y: 200)
    } completion: { _ in bar.removeFromSuperview() }
  }

  private func exitScript() {
    hideExitBar()
    let run = self.run
    close { run?.stop() }
  }
}

final class PaddedLabel: UILabel {
  override func drawText(in rect: CGRect) { super.drawText(in: rect.insetBy(dx: 14, dy: 7)) }
  override var intrinsicContentSize: CGSize {
    let s = super.intrinsicContentSize
    return CGSize(width: s.width + 28, height: s.height + 14)
  }
}

/// Decodes the color and font descriptions the prelude sends (Color._spec(), Font._spec).
enum Style {
  static func color(_ any: Any?) -> UIColor? {
    guard let d = any as? [String: Any] else { return nil }
    if let light = color(d["light"]), let dark = color(d["dark"]) {
      return UIColor { $0.userInterfaceStyle == .dark ? dark : light }
    }
    guard let hex = d["hex"] as? String, let v = UInt64(hex, radix: 16) else { return nil }
    return UIColor(
      red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255,
      alpha: CGFloat(num(d["alpha"]) ?? 1))
  }

  static func weight(_ name: String?) -> UIFont.Weight {
    switch name {
    case "ultraLight": return .ultraLight
    case "thin": return .thin
    case "light": return .light
    case "medium": return .medium
    case "semibold": return .semibold
    case "bold": return .bold
    case "heavy": return .heavy
    case "black": return .black
    default: return .regular
    }
  }

  static func font(_ any: Any?) -> UIFont? {
    guard let d = any as? [String: Any] else { return nil }
    let size = CGFloat(num(d["size"]) ?? 17)
    switch d["kind"] as? String {
    case "named":
      return UIFont(name: (d["name"] as? String) ?? "", size: size) ?? .systemFont(ofSize: size)
    case "style":
      let styles: [String: UIFont.TextStyle] = [
        "largeTitle": .largeTitle, "title1": .title1, "title2": .title2, "title3": .title3, "headline": .headline,
        "subheadline": .subheadline, "body": .body, "callout": .callout, "footnote": .footnote,
        "caption1": .caption1, "caption2": .caption2,
      ]
      return .preferredFont(forTextStyle: styles[(d["style"] as? String) ?? ""] ?? .body)
    default:
      var font = UIFont.systemFont(ofSize: size, weight: weight(d["weight"] as? String))
      var descriptor = font.fontDescriptor
      switch d["design"] as? String {
      case "monospaced": descriptor = descriptor.withDesign(.monospaced) ?? descriptor
      case "rounded": descriptor = descriptor.withDesign(.rounded) ?? descriptor
      default: break
      }
      if (d["italic"] as? Bool) == true {
        descriptor = descriptor.withSymbolicTraits(.traitItalic) ?? descriptor
      }
      font = UIFont(descriptor: descriptor, size: size)
      return font
    }
  }
}
