import AVFoundation
import AVKit
import CryptoKit
import ExpoModulesCore
import ExpoUI
import ImageIO
import SwiftUI
import UIKit

/// SwiftUI views and modifiers the .jsx miniapps draw with on top of @expo/ui: images from the
/// network with a disk cache, inline video, and gestures (drag, swipe, pinch, press, tap location).
public class ScriptorUIModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ScriptorUI")

    OnCreate {
      GestureModifiers.register()
      DispatchQueue.global(qos: .utility).async { RemoteImages.shared.prune() }
    }

    ExpoUIView(RemoteImageView.self)
    ExpoUIView(InlineVideoView.self)

    /// Downloads images ahead of time (the next stories, say) without drawing them.
    AsyncFunction("prefetchImages") { (urls: [String], headers: [String: String]?) in
      for url in urls {
        Task { _ = try? await RemoteImages.shared.data(url, headers: headers ?? [:]) }
      }
    }

    AsyncFunction("clearImageCache") {
      RemoteImages.shared.clear()
    }
  }
}

// MARK: - Images

/// Downloaded image files in Caches/scriptor-images (named by the URL's SHA-256) and decoded,
/// downsampled images in memory. Requests for the same URL share one download.
final class RemoteImages: @unchecked Sendable {
  static let shared = RemoteImages()

  final class Decoded {
    let image: UIImage
    /// The size of the original file, before downsampling.
    let size: CGSize
    init(image: UIImage, size: CGSize) {
      self.image = image
      self.size = size
    }
  }

  let folder = Paths.caches.appendingPathComponent("scriptor-images", isDirectory: true)
  private let memory = NSCache<NSString, Decoded>()
  private var downloads: [String: Task<Data, Error>] = [:]
  private let lock = NSLock()
  private let session: URLSession = {
    let config = URLSessionConfiguration.default
    // The files are kept here, not in URLCache.
    config.urlCache = nil
    config.httpMaximumConnectionsPerHost = 6
    return URLSession(configuration: config)
  }()

  private init() {
    memory.totalCostLimit = 150 * 1024 * 1024
  }

  private func file(for url: String) -> URL {
    let hash = SHA256.hash(data: Data(url.utf8)).map { String(format: "%02x", $0) }.joined()
    return folder.appendingPathComponent(hash)
  }

  /// A path or file:// URL is read as it is; anything else is downloaded once.
  func data(_ url: String, headers: [String: String]) async throws -> Data {
    if url.hasPrefix("/") || url.hasPrefix("file://") || !url.contains("://") {
      return try Data(contentsOf: Paths.resolve(url))
    }
    let file = file(for: url)
    if let data = try? Data(contentsOf: file) { return data }

    if let running = runningDownload(url) { return try await running.value }
    let task = Task<Data, Error> {
      guard let address = URL(string: url) else { throw ScriptError("URL no válida: \(url)") }
      var request = URLRequest(url: address)
      for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
      let (data, response) = try await session.data(for: request)
      if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
        throw ScriptError("HTTP \(http.statusCode)")
      }
      try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      try? data.write(to: file, options: .atomic)
      return data
    }
    let shared = startDownload(url, task)
    defer { finishDownload(url) }
    return try await shared.value
  }

  // NSLock only in synchronous helpers: Swift 6 does not allow it across an await.
  private func runningDownload(_ url: String) -> Task<Data, Error>? {
    lock.withLock { downloads[url] }
  }

  /// Keeps the first task when two views asked for the same URL at once.
  private func startDownload(_ url: String, _ task: Task<Data, Error>) -> Task<Data, Error> {
    lock.withLock {
      if let running = downloads[url] {
        task.cancel()
        return running
      }
      downloads[url] = task
      return task
    }
  }

  private func finishDownload(_ url: String) {
    lock.withLock { downloads[url] = nil }
  }

  func cached(_ url: String, pixels: Int) -> Decoded? {
    memory.object(forKey: "\(pixels)#\(url)" as NSString)
  }

  /// The image no larger than `pixels` on its longer side, so a grid of photos stays light.
  func image(_ url: String, headers: [String: String], pixels: Int) async throws -> Decoded {
    if let hit = cached(url, pixels: pixels) { return hit }
    let data = try await data(url, headers: headers)
    let decoded = try await Task.detached(priority: .userInitiated) { () throws -> Decoded in
      guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw ScriptError("No es una imagen") }
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
      var width = (properties?[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue ?? 0
      var height = (properties?[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue ?? 0
      if let orientation = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.intValue, orientation >= 5 {
        swap(&width, &height)
      }
      let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceShouldCacheImmediately: true,
        kCGImageSourceThumbnailMaxPixelSize: pixels,
      ]
      guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
        throw ScriptError("No se pudo leer la imagen")
      }
      return Decoded(image: UIImage(cgImage: cgImage), size: CGSize(width: width, height: height))
    }.value
    let cost = Int(decoded.image.size.width * decoded.image.size.height * 4)
    memory.setObject(decoded, forKey: "\(pixels)#\(url)" as NSString, cost: cost)
    return decoded
  }

  func clear() {
    memory.removeAllObjects()
    try? FileManager.default.removeItem(at: folder)
  }

  /// Keeps the folder under 500 MB, dropping the files used longest ago.
  func prune(limit: Int = 500 * 1024 * 1024) {
    let keys: [URLResourceKey] = [.fileSizeKey, .contentAccessDateKey, .contentModificationDateKey]
    guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys) else { return }
    var entries = files.compactMap { url -> (URL, Int, Date)? in
      guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
      return (url, values.fileSize ?? 0, values.contentAccessDate ?? values.contentModificationDate ?? .distantPast)
    }
    var total = entries.reduce(0) { $0 + $1.1 }
    guard total > limit else { return }
    entries.sort { $0.2 < $1.2 }
    for (url, size, _) in entries where total > limit {
      try? FileManager.default.removeItem(at: url)
      total -= size
    }
  }
}

final class RemoteImageProps: UIBaseViewProps {
  @Field var url: String = ""
  @Field var headers: [String: String] = [:]
  /// "fit" shows the whole image; "fill" covers the view's frame and crops.
  @Field var mode: String = "fit"
  /// Width / height of the view. Without it, "fit" takes the image's own proportions once loaded.
  @Field var ratio: Double?
  @Field var placeholder: Color?
  var onLoad = EventDispatcher()
  var onError = EventDispatcher()
}

private struct SizeKey: PreferenceKey {
  static let defaultValue: CGSize = .zero
  static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}

/// A fixed width / height when there is one; otherwise the view takes the frame it is given.
private struct OptionalAspectRatio: ViewModifier {
  let ratio: CGFloat?

  func body(content: Content) -> some View {
    if let ratio {
      content.aspectRatio(ratio, contentMode: .fit)
    } else {
      content
    }
  }
}

private struct ImageRequest: Equatable {
  let url: String
  let headers: [String: String]
  let pixels: Int
}

struct RemoteImageView: ExpoSwiftUI.View {
  @ObservedObject var props: RemoteImageProps
  @State private var size: CGSize = .zero
  @State private var loaded: RemoteImages.Decoded?
  @State private var loadedURL = ""
  @State private var failed = false

  init(props: RemoteImageProps) {
    self.props = props
  }

  // Decoded sizes come in steps, so a view that resizes a little does not decode again.
  private static let steps = [128, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096]

  private var pixels: Int {
    let longest = max(size.width, size.height) * UIScreen.main.scale
    guard longest > 0 else { return 0 }
    return Self.steps.first { CGFloat($0) >= longest } ?? 4096
  }

  private var shown: RemoteImages.Decoded? {
    if loadedURL == props.url, let loaded { return loaded }
    return pixels > 0 ? RemoteImages.shared.cached(props.url, pixels: pixels) : nil
  }

  private var ratio: CGFloat? {
    if let ratio = props.ratio, ratio > 0 { return CGFloat(ratio) }
    if props.mode == "fill" { return nil }
    guard let size = shown?.size, size.height > 0 else { return 1 }
    return size.width / size.height
  }

  var body: some View {
    let fill = props.mode == "fill"
    Rectangle()
      .fill(Color.clear)
      .modifier(OptionalAspectRatio(ratio: ratio))
      .overlay {
        ZStack {
          if let image = shown?.image {
            Image(uiImage: image)
              .resizable()
              .aspectRatio(contentMode: fill ? .fill : .fit)
              .transition(.opacity)
          } else if failed {
            Image(systemName: "photo")
              .foregroundStyle(.tertiary)
          } else {
            Rectangle().fill(props.placeholder ?? Color(UIColor.secondarySystemFill))
          }
        }
        .animation(.easeOut(duration: 0.2), value: shown != nil)
      }
      .clipped()
      .background(GeometryReader { proxy in Color.clear.preference(key: SizeKey.self, value: proxy.size) })
      .onPreferenceChange(SizeKey.self) { size = $0 }
      .task(id: ImageRequest(url: props.url, headers: props.headers, pixels: pixels)) {
        await load()
      }
  }

  private func load() async {
    let url = props.url
    guard !url.isEmpty, pixels > 0 else { return }
    if loadedURL != url { failed = false }
    do {
      let image = try await RemoteImages.shared.image(url, headers: props.headers, pixels: pixels)
      guard !Task.isCancelled, url == props.url else { return }
      let first = loadedURL != url
      loaded = image
      loadedURL = url
      failed = false
      if first { props.onLoad(["width": image.size.width, "height": image.size.height]) }
    } catch {
      guard !Task.isCancelled, url == props.url else { return }
      failed = true
      props.onError(["message": error.localizedDescription])
    }
  }
}

// MARK: - Video

final class InlineVideoProps: UIBaseViewProps {
  @Field var url: String = ""
  @Field var headers: [String: String] = [:]
  @Field var playing: Bool = true
  @Field var muted: Bool = false
  @Field var loop: Bool = false
  /// The system controls (play, scrubbing, AirPlay, full screen). Without them the miniapp draws its own.
  @Field var controls: Bool = false
  @Field var mode: String = "fit"
  @Field var rate: Double = 1
  /// Seconds to jump to; `seekKey` changes each time so the same time can be asked again.
  @Field var seek: Double?
  @Field var seekKey: Double = 0
  var onReady = EventDispatcher()
  var onProgress = EventDispatcher()
  var onEnd = EventDispatcher()
  var onError = EventDispatcher()
  var onBuffering = EventDispatcher()
}

struct VideoSettings: Equatable {
  var url: String
  var headers: [String: String]
  var playing: Bool
  var muted: Bool
  var loop: Bool
  var rate: Double
  var seek: Double?
  var seekKey: Double
}

/// One AVPlayer per view. It reports to the props' events and follows their settings.
final class VideoModel: ObservableObject {
  let player = AVPlayer()
  weak var props: InlineVideoProps?
  private var settings: VideoSettings?
  private var timeObserver: Any?
  private var observations: [NSKeyValueObservation] = []
  private var statusObservation: NSKeyValueObservation?
  private var endObserver: NSObjectProtocol?
  private var visible = false

  init() {
    player.automaticallyWaitsToMinimizeStalling = true
    timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] time in
      guard let self, let item = self.player.currentItem, self.player.rate != 0 else { return }
      let duration = item.duration.seconds
      self.props?.onProgress(["time": time.seconds, "duration": duration.isFinite ? duration : 0])
    }
    observations.append(player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
      DispatchQueue.main.async {
        self?.props?.onBuffering(["buffering": player.timeControlStatus == .waitingToPlayAtSpecifiedRate])
      }
    })
  }

  deinit {
    if let timeObserver { player.removeTimeObserver(timeObserver) }
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    player.pause()
  }

  func apply(_ next: VideoSettings) {
    let previous = settings
    settings = next
    if previous?.url != next.url || previous?.headers != next.headers { load(next) }
    player.isMuted = next.muted
    if !next.muted, next.playing {
      try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
      try? AVAudioSession.sharedInstance().setActive(true)
    }
    if let seek = next.seek, previous?.seekKey != next.seekKey {
      player.seek(to: CMTime(seconds: seek, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }
    updatePlayback()
  }

  func setVisible(_ value: Bool) {
    visible = value
    updatePlayback()
  }

  private func updatePlayback() {
    guard let settings else { return }
    if settings.playing, visible {
      player.playImmediately(atRate: Float(settings.rate))
    } else {
      player.pause()
    }
  }

  private func load(_ settings: VideoSettings) {
    statusObservation = nil
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    endObserver = nil
    guard !settings.url.isEmpty else {
      player.replaceCurrentItem(with: nil)
      return
    }
    let address: URL
    if settings.url.contains("://") {
      guard let url = URL(string: settings.url) else {
        props?.onError(["message": "URL no válida: \(settings.url)"])
        return
      }
      address = url
    } else {
      address = Paths.resolve(settings.url)
    }
    // AVFoundation's key for request headers (Referer, cookies…), used widely though undocumented.
    let options: [String: Any] = settings.headers.isEmpty ? [:] : ["AVURLAssetHTTPHeaderFieldsKey": settings.headers]
    let item = AVPlayerItem(asset: AVURLAsset(url: address, options: options))
    statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
      DispatchQueue.main.async {
        guard let self else { return }
        switch item.status {
        case .readyToPlay:
          let duration = item.duration.seconds
          let size = item.presentationSize
          self.props?.onReady(["duration": duration.isFinite ? duration : 0, "width": size.width, "height": size.height])
        case .failed:
          self.props?.onError(["message": item.error?.localizedDescription ?? "No se pudo reproducir el vídeo"])
        default:
          break
        }
      }
    }
    endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
      guard let self else { return }
      if self.settings?.loop == true {
        self.player.seek(to: .zero)
        self.updatePlayback()
      } else {
        self.props?.onEnd([:])
      }
    }
    player.replaceCurrentItem(with: item)
  }
}

/// AVPlayerLayer without controls, for miniapps that draw their own.
private struct PlayerLayerView: UIViewRepresentable {
  let player: AVPlayer
  let fill: Bool

  final class LayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
  }

  func makeUIView(context: Context) -> LayerView {
    let view = LayerView()
    view.backgroundColor = .black
    view.playerLayer.player = player
    return view
  }

  func updateUIView(_ view: LayerView, context: Context) {
    view.playerLayer.videoGravity = fill ? .resizeAspectFill : .resizeAspect
  }
}

struct InlineVideoView: ExpoSwiftUI.View {
  @ObservedObject var props: InlineVideoProps
  @StateObject private var model = VideoModel()

  init(props: InlineVideoProps) {
    self.props = props
  }

  private var settings: VideoSettings {
    VideoSettings(url: props.url, headers: props.headers, playing: props.playing, muted: props.muted, loop: props.loop, rate: props.rate, seek: props.seek, seekKey: props.seekKey)
  }

  var body: some View {
    Group {
      if props.controls {
        VideoPlayer(player: model.player)
      } else {
        PlayerLayerView(player: model.player, fill: props.mode == "fill")
      }
    }
    .clipped()
    .onAppear {
      model.props = props
      model.apply(settings)
      model.setVisible(true)
    }
    .onDisappear { model.setVisible(false) }
    .onChange(of: settings) { next in
      model.props = props
      model.apply(next)
    }
  }
}

// MARK: - Gestures

enum GestureModifiers {
  static func register() {
    ViewModifierRegistry.register("scriptorDrag") { params, appContext, dispatcher in
      try DragModifier(from: params, appContext: appContext, eventDispatcher: dispatcher)
    }
    ViewModifierRegistry.register("scriptorSwipe") { params, appContext, dispatcher in
      try SwipeModifier(from: params, appContext: appContext, eventDispatcher: dispatcher)
    }
    ViewModifierRegistry.register("scriptorZoom") { params, appContext, dispatcher in
      try ZoomModifier(from: params, appContext: appContext, eventDispatcher: dispatcher)
    }
    ViewModifierRegistry.register("scriptorPress") { params, appContext, dispatcher in
      try PressModifier(from: params, appContext: appContext, eventDispatcher: dispatcher)
    }
    ViewModifierRegistry.register("scriptorTapAt") { params, appContext, dispatcher in
      try TapAtModifier(from: params, appContext: appContext, eventDispatcher: dispatcher)
    }
    ViewModifierRegistry.register("scriptorRotation3D") { params, appContext, _ in
      try Rotation3DModifier(from: params, appContext: appContext)
    }
  }
}

private func point(_ size: CGSize) -> [String: Double] {
  ["x": Double(size.width), "y": Double(size.height)]
}

/// The view follows the finger while dragging (on `axis`) and springs back when let go, unless
/// the miniapp moves or removes it in onDrag's "end". Events: start, change (when `live`), end.
struct DragModifier: ViewModifier, Record {
  @Field var axis: String = "both"
  @Field var follow: Bool = true
  @Field var live: Bool = false
  @Field var minimumDistance: Double = 10
  var eventDispatcher: EventDispatcher?
  @GestureState(resetTransaction: Transaction(animation: .spring(response: 0.35, dampingFraction: 0.8))) private var translation: CGSize = .zero

  init() {}

  init(from params: Dict, appContext: AppContext, eventDispatcher: EventDispatcher) throws {
    try self = .init(from: params, appContext: appContext)
    self.eventDispatcher = eventDispatcher
  }

  private func limit(_ size: CGSize) -> CGSize {
    CGSize(width: axis == "y" ? 0 : size.width, height: axis == "x" ? 0 : size.height)
  }

  private func send(_ phase: String, _ value: DragGesture.Value) {
    eventDispatcher?(["scriptorDrag": [
      "phase": phase,
      "translation": point(limit(value.translation)),
      "predicted": point(limit(value.predictedEndTranslation)),
      "location": ["x": Double(value.location.x), "y": Double(value.location.y)],
    ]])
  }

  func body(content: Content) -> some View {
    content
      .offset(follow ? translation : .zero)
      .gesture(
        DragGesture(minimumDistance: minimumDistance)
          .updating($translation) { value, state, _ in
            if state == .zero { send("start", value) }
            state = limit(value.translation)
          }
          .onChanged { value in if live { send("change", value) } }
          .onEnded { value in send("end", value) }
      )
  }
}

/// A flick in a direction (left, right, up, down), counting the drag's momentum. It does not
/// block scrolling: a vertical list keeps scrolling while horizontal swipes are reported.
struct SwipeModifier: ViewModifier, Record {
  @Field var minimumDistance: Double = 50
  var eventDispatcher: EventDispatcher?

  init() {}

  init(from params: Dict, appContext: AppContext, eventDispatcher: EventDispatcher) throws {
    try self = .init(from: params, appContext: appContext)
    self.eventDispatcher = eventDispatcher
  }

  func body(content: Content) -> some View {
    content.simultaneousGesture(
      DragGesture(minimumDistance: 20).onEnded { value in
        let dx = value.predictedEndTranslation.width
        let dy = value.predictedEndTranslation.height
        guard max(abs(dx), abs(dy)) >= minimumDistance else { return }
        let direction = abs(dx) > abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "up" : "down")
        eventDispatcher?(["scriptorSwipe": ["direction": direction]])
      }
    )
  }
}

/// Pinch to zoom, pan while zoomed and double tap to zoom in or out. "peek" springs back to
/// normal on release (like a feed photo); "zoom" stays where it is left.
struct ZoomModifier: ViewModifier, Record {
  @Field var maxScale: Double = 4
  @Field var mode: String = "zoom"
  @Field var doubleTap: Bool = true
  var eventDispatcher: EventDispatcher?
  @State private var scale: CGFloat = 1
  @State private var offset: CGSize = .zero
  @GestureState(resetTransaction: Transaction(animation: .spring(response: 0.35, dampingFraction: 0.85))) private var pinch: CGFloat = 1
  @GestureState private var pan: CGSize = .zero

  init() {}

  init(from params: Dict, appContext: AppContext, eventDispatcher: EventDispatcher) throws {
    try self = .init(from: params, appContext: appContext)
    self.eventDispatcher = eventDispatcher
  }

  private var peek: Bool { mode == "peek" }

  private func report(_ value: CGFloat) {
    eventDispatcher?(["scriptorZoom": ["scale": Double(value)]])
  }

  func body(content: Content) -> some View {
    let current = min(max(scale * pinch, 1), CGFloat(maxScale))
    let zoomed = scale > 1.01 || pinch > 1.01
    let magnify = MagnificationGesture()
      .updating($pinch) { value, state, _ in state = value }
      .onEnded { value in
        if peek {
          report(1)
          return
        }
        let next = min(max(scale * value, 1), CGFloat(maxScale))
        withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) {
          scale = next
          if next <= 1.01 { offset = .zero }
        }
        report(next)
      }
    let drag = DragGesture()
      .updating($pan) { value, state, _ in state = value.translation }
      .onEnded { value in
        if !peek { offset = CGSize(width: offset.width + value.translation.width, height: offset.height + value.translation.height) }
      }
    return content
      .scaleEffect(current)
      .offset(peek ? .zero : CGSize(width: offset.width + pan.width, height: offset.height + pan.height))
      .zIndex(zoomed ? 1 : 0)
      .gesture(magnify)
      .simultaneousGesture(drag, including: zoomed && !peek ? .all : .subviews)
      .onTapGesture(count: 2) {
        guard doubleTap, !peek else { return }
        let next: CGFloat = scale > 1.01 ? 1 : min(2.5, CGFloat(maxScale))
        withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) {
          scale = next
          offset = .zero
        }
        report(next)
      }
  }
}

/// Touch down and up: { pressing: true } on touch, { pressing: false } on release, and
/// { held: true } after `minimumDuration`. For "hold to pause" in a story viewer.
struct PressModifier: ViewModifier, Record {
  @Field var minimumDuration: Double = 0.25
  var eventDispatcher: EventDispatcher?

  init() {}

  init(from params: Dict, appContext: AppContext, eventDispatcher: EventDispatcher) throws {
    try self = .init(from: params, appContext: appContext)
    self.eventDispatcher = eventDispatcher
  }

  func body(content: Content) -> some View {
    content.onLongPressGesture(minimumDuration: minimumDuration, maximumDistance: 30, perform: {
      eventDispatcher?(["scriptorPress": ["held": true]])
    }, onPressingChanged: { pressing in
      eventDispatcher?(["scriptorPress": ["pressing": pressing]])
    })
  }
}

/// A tap with where it landed and the view's size, to tell the left third from the right.
struct TapAtModifier: ViewModifier, Record {
  @Field var count: Int = 1
  var eventDispatcher: EventDispatcher?
  @State private var size: CGSize = .zero

  init() {}

  init(from params: Dict, appContext: AppContext, eventDispatcher: EventDispatcher) throws {
    try self = .init(from: params, appContext: appContext)
    self.eventDispatcher = eventDispatcher
  }

  func body(content: Content) -> some View {
    content
      .contentShape(Rectangle())
      .background(GeometryReader { proxy in Color.clear.preference(key: SizeKey.self, value: proxy.size) })
      .onPreferenceChange(SizeKey.self) { size = $0 }
      .onTapGesture(count: max(1, count)) { (location: CGPoint) in
        eventDispatcher?(["scriptorTapAt": [
          "x": Double(location.x), "y": Double(location.y),
          "width": Double(size.width), "height": Double(size.height),
        ]])
      }
  }
}

/// Turns the view in 3D around an axis, for card flips and a cube between pages.
struct Rotation3DModifier: ViewModifier, Record {
  @Field var angle: Double = 0
  @Field var axis: String = "y"
  @Field var anchor: String = "center"
  @Field var perspective: Double = 0.5

  init() {}

  func body(content: Content) -> some View {
    let axes: (x: CGFloat, y: CGFloat, z: CGFloat) = axis == "x" ? (1, 0, 0) : axis == "z" ? (0, 0, 1) : (0, 1, 0)
    let point: UnitPoint = anchor == "leading" ? .leading : anchor == "trailing" ? .trailing : anchor == "top" ? .top : anchor == "bottom" ? .bottom : .center
    return content.rotation3DEffect(.degrees(angle), axis: axes, anchor: point, perspective: CGFloat(perspective))
  }
}
