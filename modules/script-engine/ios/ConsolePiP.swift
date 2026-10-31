import AVFoundation
import AVKit
import CoreMedia
import UIKit

/// Keeps scripts running after leaving the app. While a script (.js or .py) runs, its console is
/// drawn into a sample buffer layer that Picture in Picture can show; leaving the app opens it on
/// its own. iOS does not suspend an app that is showing Picture in Picture, so the script goes on
/// until it ends, and the small window shows its last lines meanwhile. Everything runs on main.
final class ConsolePiP: NSObject, AVPictureInPictureControllerDelegate, AVPictureInPictureSampleBufferPlaybackDelegate {
  static let shared = ConsolePiP()

  private struct Run {
    let name: String
    var lines: [(level: String, text: String)] = []
  }

  private static let size = CGSize(width: 960, height: 540)
  private static let maxLines = 14

  private var runs: [String: Run] = [:]
  /// The run the window shows: the one that started last and is still going.
  private var order: [String] = []
  private var finished: (name: String, error: String?)?
  private var source: UIView?
  private var layer: AVSampleBufferDisplayLayer?
  private var controller: AVPictureInPictureController?
  private var drawScheduled = false
  private var closeWork: DispatchWorkItem?

  override private init() {
    super.init()
    // Back in the app, the console is on screen again: the window is not needed.
    NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      guard let controller = self?.controller, controller.isPictureInPictureActive else { return }
      controller.stopPictureInPicture()
    }
  }

  // MARK: Runs

  func begin(_ id: String, name: String) {
    DispatchQueue.main.async { [self] in
      guard AVPictureInPictureController.isPictureInPictureSupported() else { return }
      closeWork?.cancel()
      closeWork = nil
      finished = nil
      // The Python terminal runs as "<terminal>" and "<pip>".
      runs[id] = Run(name: name.trimmingCharacters(in: CharacterSet(charactersIn: "<>")))
      order.append(id)
      prepare()
      controller?.canStartPictureInPictureAutomaticallyFromInline = true
      draw()
    }
  }

  func log(_ id: String, _ logs: [[String: Any]]) {
    DispatchQueue.main.async { [self] in
      guard var run = runs[id] else { return }
      for log in logs {
        let text = (log["message"] as? String ?? "").replacingOccurrences(of: "\r", with: "")
        // Each line of a message is its own row; only the last ones fit.
        for line in text.split(separator: "\n", omittingEmptySubsequences: false).suffix(Self.maxLines) {
          run.lines.append((log["level"] as? String ?? "log", String(line.prefix(300))))
        }
      }
      run.lines = Array(run.lines.suffix(Self.maxLines))
      runs[id] = run
      scheduleDraw()
    }
  }

  func end(_ id: String, error: String?) {
    DispatchQueue.main.async { [self] in
      guard let run = runs.removeValue(forKey: id) else { return }
      order.removeAll { $0 == id }
      guard order.isEmpty else { return draw() }
      controller?.canStartPictureInPictureAutomaticallyFromInline = false
      finished = (run.name, error == "Stopped" ? "Detenido" : error)
      draw()
      // The last frame stays a moment so the result can be read, then the window goes.
      let work = DispatchWorkItem { [weak self] in
        guard let self, self.order.isEmpty else { return }
        self.controller?.stopPictureInPicture()
        self.closeWork = nil
      }
      closeWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + (controller?.isPictureInPictureActive == true ? 4 : 0.5), execute: work)
    }
  }

  // MARK: Picture in Picture

  private func prepare() {
    if controller != nil, source?.window != nil { return }
    // The playback session lets Picture in Picture start; mixing keeps the user's music playing.
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
    try? AVAudioSession.sharedInstance().setActive(true)
    guard let window = Presenter.topController()?.view.window else { return }
    let view = source ?? UIView(frame: CGRect(x: 0, y: 0, width: 2, height: 2))
    view.isUserInteractionEnabled = false
    if layer == nil {
      let display = AVSampleBufferDisplayLayer()
      display.videoGravity = .resizeAspect
      display.frame = view.bounds
      view.layer.addSublayer(display)
      layer = display
    }
    // Picture in Picture needs its layer in a window and on screen; 2 points in the corner do.
    window.addSubview(view)
    source = view
    if controller == nil, let layer {
      let pip = AVPictureInPictureController(contentSource: .init(sampleBufferDisplayLayer: layer, playbackDelegate: self))
      pip.delegate = self
      pip.requiresLinearPlayback = true
      controller = pip
    }
  }

  private func scheduleDraw() {
    guard !drawScheduled else { return }
    drawScheduled = true
    // At most a few frames a second: enough to follow along, cheap on battery.
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(300)) { [weak self] in
      self?.drawScheduled = false
      self?.draw()
    }
  }

  private func draw() {
    guard let layer, let buffer = frame() else { return }
    if layer.status == .failed { layer.flush() }
    layer.enqueue(buffer)
  }

  // MARK: Drawing

  private func frame() -> CMSampleBuffer? {
    let size = Self.size
    var pixels: CVPixelBuffer?
    let attributes: [String: Any] = [
      kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
      kCVPixelBufferCGImageCompatibilityKey as String: true,
    ]
    guard CVPixelBufferCreate(nil, Int(size.width), Int(size.height), kCVPixelFormatType_32BGRA, attributes as CFDictionary, &pixels) == kCVReturnSuccess,
          let pixels else { return nil }
    CVPixelBufferLockBaseAddress(pixels, [])
    guard let context = CGContext(
      data: CVPixelBufferGetBaseAddress(pixels), width: Int(size.width), height: Int(size.height), bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(pixels), space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ) else {
      CVPixelBufferUnlockBaseAddress(pixels, [])
      return nil
    }
    // UIKit draws top-down; the bitmap's origin is at the bottom.
    context.translateBy(x: 0, y: size.height)
    context.scaleBy(x: 1, y: -1)
    UIGraphicsPushContext(context)
    paint(size)
    UIGraphicsPopContext()
    CVPixelBufferUnlockBaseAddress(pixels, [])

    var format: CMVideoFormatDescription?
    CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: pixels, formatDescriptionOut: &format)
    guard let format else { return nil }
    var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()), decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: pixels, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample)
    if let sample, let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true) {
      let first = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
      CFDictionarySetValue(first, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
    }
    return sample
  }

  private func paint(_ size: CGSize) {
    UIColor(red: 0.07, green: 0.07, blue: 0.09, alpha: 1).setFill()
    UIRectFill(CGRect(origin: .zero, size: size))
    let margin: CGFloat = 32
    let current = order.last.flatMap { runs[$0] }
    let title: String
    let status: String
    let statusColor: UIColor
    if let current {
      title = current.name
      status = order.count > 1 ? "Ejecutando · \(order.count) scripts" : "Ejecutando…"
      statusColor = .systemBlue
    } else if let finished {
      title = finished.name
      if let error = finished.error {
        status = error == "Detenido" ? error : "Error"
        statusColor = .systemRed
      } else {
        status = "Terminado"
        statusColor = .systemGreen
      }
    } else {
      title = "Scriptor"
      status = ""
      statusColor = .secondaryLabel
    }
    let header = UIFont.systemFont(ofSize: 34, weight: .semibold)
    (title as NSString).draw(
      in: CGRect(x: margin, y: 24, width: size.width * 0.6, height: 44),
      withAttributes: [.font: header, .foregroundColor: UIColor.white, .paragraphStyle: Self.truncating])
    let small = UIFont.systemFont(ofSize: 26, weight: .medium)
    let statusSize = (status as NSString).size(withAttributes: [.font: small])
    (status as NSString).draw(
      at: CGPoint(x: size.width - margin - statusSize.width, y: 30), withAttributes: [.font: small, .foregroundColor: statusColor])

    let mono = UIFont.monospacedSystemFont(ofSize: 24, weight: .regular)
    var lines = current?.lines ?? []
    if current == nil, let error = finished?.error, error != "Detenido" { lines = [("error", error)] }
    var y: CGFloat = 92
    let lineHeight: CGFloat = 31
    for line in lines.suffix(Self.maxLines) {
      let color: UIColor = line.level == "error" ? .systemRed : line.level == "warn" ? .systemOrange : line.level == "info" ? .systemBlue : UIColor(white: 0.92, alpha: 1)
      (line.text as NSString).draw(
        in: CGRect(x: margin, y: y, width: size.width - margin * 2, height: lineHeight),
        withAttributes: [.font: mono, .foregroundColor: color, .paragraphStyle: Self.truncating])
      y += lineHeight
      if y > size.height - lineHeight { break }
    }
  }

  private static let truncating: NSParagraphStyle = {
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = .byTruncatingTail
    return style
  }()

  // MARK: AVPictureInPictureSampleBufferPlaybackDelegate

  // A live source with nothing to play or pause: the window only shows the console.
  func pictureInPictureController(_ controller: AVPictureInPictureController, setPlaying playing: Bool) {}

  func pictureInPictureControllerTimeRangeForPlayback(_ controller: AVPictureInPictureController) -> CMTimeRange {
    CMTimeRange(start: .negativeInfinity, duration: .positiveInfinity)
  }

  func pictureInPictureControllerIsPlaybackPaused(_ controller: AVPictureInPictureController) -> Bool { false }

  func pictureInPictureController(_ controller: AVPictureInPictureController, didTransitionToRenderSize newRenderSize: CMVideoDimensions) {}

  func pictureInPictureController(_ controller: AVPictureInPictureController, skipByInterval skipInterval: CMTime, completion completionHandler: @escaping () -> Void) {
    completionHandler()
  }

  // MARK: AVPictureInPictureControllerDelegate

  func pictureInPictureControllerWillStartPictureInPicture(_ controller: AVPictureInPictureController) {
    draw()
  }

  // The window's button back to the app: the app is already there, nothing to restore.
  func pictureInPictureController(_ controller: AVPictureInPictureController, restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
    completionHandler(true)
  }
}
