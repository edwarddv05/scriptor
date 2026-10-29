import AVFoundation
import MobileVLCKit
import UIKit

/// Video.play: a fullscreen player built on VLC, so AV1 (decoded in software with dav1d), MKV,
/// WebM and everything else VLC reads play on any iPhone, not only those with an AV1 decoder.
enum VideoAPI {
  static func register(_ r: NativeRegistry) {
    // (path | url, { loop, start, muted }) -> { position, duration, ended } when closed or finished
    r.async("video.play") { run, a, done in
      let source: String
      do { source = try a.string(0) } catch { return done(.failure(error)) }
      let opts = a.dict(1)
      let url: URL
      if let remote = URL(string: source), let scheme = remote.scheme?.lowercased(),
        ["http", "https", "rtsp", "rtmp", "ftp"].contains(scheme) {
        url = remote
      } else {
        url = Paths.resolve(source)
        guard FileManager.default.fileExists(atPath: url.path) else {
          return done(.failure(ScriptError("The file \(source) does not exist.")))
        }
      }
      let key = "video.\(a.callId)"
      DispatchQueue.main.async {
        let screen = VideoPlayerController(
          url: url, loop: (opts["loop"] as? Bool) == true, start: num(opts["start"]) ?? 0,
          muted: (opts["muted"] as? Bool) == true)
        screen.run = run
        screen.show(fullscreen: true) {
          run.removeCleanup(key)
          if screen.failed {
            done(.failure(ScriptError("Could not play \(source)")))
          } else {
            done(.success(screen.result))
          }
        }
        run.addCleanup(key) { DispatchQueue.main.async { screen.close() } }
      }
    }
  }
}

final class VideoPlayerController: ScriptScreenController {
  private let player = VLCMediaPlayer()
  private let url: URL
  private let loop: Bool
  private let start: Double
  private let muted: Bool

  private let videoView = UIView()
  private let closeGlass = VideoPlayerController.glass(cornerRadius: 22)
  private let bar = VideoPlayerController.glass(cornerRadius: 26)
  private let playButton = UIButton(type: .system)
  private let slider = UISlider()
  private let timeLabel = UILabel()
  private var timer: Timer?
  private var hideWork: DispatchWorkItem?
  private var controlsHidden = false
  private var scrubbing = false
  private var closing = false

  /// Last known playback time and length, in seconds (VLC resets them once stopped).
  private var position = 0.0
  private var duration = 0.0
  private var ended = false
  private(set) var failed = false

  /// What the script's promise resolves with.
  var result: [String: Any] { ["position": position, "duration": duration, "ended": ended] }

  override var showsExitHint: Bool { false }
  override var prefersStatusBarHidden: Bool { controlsHidden }
  override var prefersHomeIndicatorAutoHidden: Bool { controlsHidden }

  init(url: URL, loop: Bool, start: Double, muted: Bool) {
    self.url = url
    self.loop = loop
    self.start = start
    self.muted = muted
    super.init(nibName: nil, bundle: nil)
    overrideUserInterfaceStyle = .dark
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    videoView.frame = view.bounds
    videoView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    videoView.backgroundColor = .black
    videoView.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(toggleControls)))
    view.addSubview(videoView)
    buildControls()

    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    try? AVAudioSession.sharedInstance().setActive(true)

    let media = VLCMedia(url: url)
    if start > 0 { media.addOption(":start-time=\(start)") }
    if loop { media.addOption(":input-repeat=65535") }
    player.media = media
    player.drawable = videoView
    player.play()
    if muted { player.audio?.volume = 0 }

    timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.tick() }
    scheduleHide()
  }

  override func didClose() {
    timer?.invalidate()
    timer = nil
    hideWork?.cancel()
    player.stop()
    super.didClose()
  }

  // MARK: Controls

  /// Liquid Glass on iOS 26, a dark blur before it.
  private static func glass(cornerRadius: CGFloat) -> UIVisualEffectView {
    let v = UIVisualEffectView(effect: glassEffect())
    v.layer.cornerRadius = cornerRadius
    v.layer.cornerCurve = .continuous
    v.clipsToBounds = true
    v.translatesAutoresizingMaskIntoConstraints = false
    return v
  }

  private static func glassEffect() -> UIVisualEffect {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) { return UIGlassEffect() }
    #endif
    return UIBlurEffect(style: .systemUltraThinMaterialDark)
  }

  private func buildControls() {
    let close = UIButton(type: .system)
    close.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(weight: .semibold)), for: .normal)
    close.tintColor = .white
    close.addAction(UIAction { [weak self] _ in self?.close() }, for: .touchUpInside)
    close.translatesAutoresizingMaskIntoConstraints = false
    closeGlass.contentView.addSubview(close)

    playButton.tintColor = .white
    playButton.setImage(UIImage(systemName: "pause.fill"), for: .normal)
    playButton.addAction(UIAction { [weak self] _ in self?.togglePlay() }, for: .touchUpInside)
    playButton.widthAnchor.constraint(equalToConstant: 36).isActive = true

    slider.minimumTrackTintColor = .white
    slider.addAction(UIAction { [weak self] _ in self?.scrubbing = true; self?.hideWork?.cancel() }, for: .touchDown)
    slider.addAction(UIAction { [weak self] _ in self?.previewScrub() }, for: .valueChanged)
    slider.addAction(UIAction { [weak self] _ in self?.endScrub() }, for: [.touchUpInside, .touchUpOutside, .touchCancel])

    timeLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .medium)
    timeLabel.textColor = .white
    timeLabel.text = "0:00 / 0:00"
    timeLabel.setContentHuggingPriority(.required, for: .horizontal)
    timeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

    let row = UIStackView(arrangedSubviews: [playButton, slider, timeLabel])
    row.axis = .horizontal
    row.spacing = 12
    row.alignment = .center
    row.translatesAutoresizingMaskIntoConstraints = false
    bar.contentView.addSubview(row)

    view.addSubview(closeGlass)
    view.addSubview(bar)
    let safe = view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      closeGlass.topAnchor.constraint(equalTo: safe.topAnchor, constant: 12),
      closeGlass.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 16),
      closeGlass.widthAnchor.constraint(equalToConstant: 44),
      closeGlass.heightAnchor.constraint(equalToConstant: 44),
      close.topAnchor.constraint(equalTo: closeGlass.contentView.topAnchor),
      close.bottomAnchor.constraint(equalTo: closeGlass.contentView.bottomAnchor),
      close.leadingAnchor.constraint(equalTo: closeGlass.contentView.leadingAnchor),
      close.trailingAnchor.constraint(equalTo: closeGlass.contentView.trailingAnchor),

      bar.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 16),
      bar.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -16),
      bar.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -12),
      bar.heightAnchor.constraint(equalToConstant: 52),
      row.leadingAnchor.constraint(equalTo: bar.contentView.leadingAnchor, constant: 12),
      row.trailingAnchor.constraint(equalTo: bar.contentView.trailingAnchor, constant: -18),
      row.centerYAnchor.constraint(equalTo: bar.contentView.centerYAnchor),
    ])
  }

  private func togglePlay() {
    if player.isPlaying { player.pause() } else { player.play() }
    scheduleHide()
  }

  @objc private func toggleControls() {
    setControls(hidden: !controlsHidden)
    if !controlsHidden { scheduleHide() }
  }

  private func setControls(hidden: Bool) {
    controlsHidden = hidden
    UIView.animate(withDuration: 0.25) {
      self.closeGlass.alpha = hidden ? 0 : 1
      self.bar.alpha = hidden ? 0 : 1
      self.setNeedsStatusBarAppearanceUpdate()
    }
    setNeedsUpdateOfHomeIndicatorAutoHidden()
  }

  /// Hides the controls after a few seconds of playback without touches.
  private func scheduleHide() {
    hideWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.player.isPlaying, !self.scrubbing else { return }
      self.setControls(hidden: true)
    }
    hideWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
  }

  private func previewScrub() {
    timeLabel.text = "\(Self.format(Double(slider.value) * duration)) / \(Self.format(duration))"
  }

  private func endScrub() {
    player.position = slider.value
    scrubbing = false
    scheduleHide()
  }

  // MARK: Playback state

  private func tick() {
    let length = Double(player.media?.length.intValue ?? 0) / 1000
    let time = Double(player.time.intValue) / 1000
    if length > 0 { duration = length }
    if time > 0 { position = time }
    if !scrubbing {
      if duration > 0 { slider.value = Float(min(position / duration, 1)) }
      timeLabel.text = "\(Self.format(position)) / \(Self.format(duration))"
    }
    playButton.setImage(UIImage(systemName: player.isPlaying ? "pause.fill" : "play.fill"), for: .normal)

    guard !closing else { return }
    switch player.state {
    case .ended:
      ended = true
      closing = true
      close()
    case .error:
      failed = true
      closing = true
      close()
    default:
      break
    }
  }

  private static func format(_ seconds: Double) -> String {
    let s = Int(max(seconds, 0).rounded(.down))
    return s >= 3600
      ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
      : String(format: "%d:%02d", s / 60, s % 60)
  }
}
