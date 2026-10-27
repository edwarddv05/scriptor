import AVFoundation
import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// Camera, image processing, video (info, thumbnails, trim/compress) and audio (play, record, speech).
enum MediaAPI {
  static func register(_ r: NativeRegistry) {
    registerCamera(r)
    registerImage(r)
    registerVideo(r)
    registerAudio(r)
  }

  // MARK: Camera

  private static func registerCamera(_ r: NativeRegistry) {
    // ({ video: bool, maxDuration, front: bool }) -> path | null
    r.async("camera.capture") { _, a, done in
      let opts = a.dict(0)
      DispatchQueue.main.async {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
          return done(.failure(ScriptError("Camera not available")))
        }
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        if (opts["video"] as? Bool) == true {
          picker.mediaTypes = [UTType.movie.identifier]
          picker.videoQuality = .typeHigh
          if let max = opts["maxDuration"] as? Double { picker.videoMaximumDuration = max }
        } else {
          picker.mediaTypes = [UTType.image.identifier]
        }
        if (opts["front"] as? Bool) == true, UIImagePickerController.isCameraDeviceAvailable(.front) {
          picker.cameraDevice = .front
        }
        let delegate = CameraDelegate(done: done)
        picker.delegate = delegate
        Presenter.present(picker, retaining: delegate)
      }
    }
  }

  // MARK: Image

  private static func registerImage(_ r: NativeRegistry) {
    r.sync("image.info") { _, a in
      let url = Paths.resolve(try a.string(0))
      guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [String: Any]
      else { throw ScriptError("Not an image: \(url.lastPathComponent)") }
      return [
        "width": props[kCGImagePropertyPixelWidth as String] as? Int ?? 0,
        "height": props[kCGImagePropertyPixelHeight as String] as? Int ?? 0,
        "type": (CGImageSourceGetType(src) as String?) ?? "",
        "frames": CGImageSourceGetCount(src),
      ]
    }

    // (path, { width, height, format, quality, dest }) -> path. Downscales without decoding full size.
    r.async("image.resize") { _, a, done in
      do {
        let url = Paths.resolve(try a.string(0))
        let opts = a.dict(1)
        DispatchQueue.global(qos: .userInitiated).async {
          do {
            guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { throw ScriptError("Not an image") }
            let maxSide = max((opts["width"] as? Double) ?? 0, (opts["height"] as? Double) ?? 0)
            var thumbOpts: [CFString: Any] = [
              kCGImageSourceCreateThumbnailFromImageAlways: true,
              kCGImageSourceCreateThumbnailWithTransform: true,
            ]
            if maxSide > 0 { thumbOpts[kCGImageSourceThumbnailMaxPixelSize] = maxSide }
            guard let image = CGImageSourceCreateThumbnailAtIndex(src, 0, thumbOpts as CFDictionary) else {
              throw ScriptError("Could not decode image")
            }
            done(.success(try write(image, opts: opts, sourceExt: url.pathExtension)))
          } catch { done(.failure(error)) }
        }
      } catch { done(.failure(error)) }
    }

    // (path, { x, y, width, height, format, quality, dest }) -> path
    r.async("image.crop") { _, a, done in
      do {
        let url = Paths.resolve(try a.string(0))
        let opts = a.dict(1)
        DispatchQueue.global(qos: .userInitiated).async {
          do {
            guard let ui = UIImage(contentsOfFile: url.path), let normalized = normalize(ui) else {
              throw ScriptError("Could not decode image")
            }
            let rect = CGRect(
              x: (opts["x"] as? Double) ?? 0, y: (opts["y"] as? Double) ?? 0,
              width: (opts["width"] as? Double) ?? Double(normalized.width),
              height: (opts["height"] as? Double) ?? Double(normalized.height))
            guard let cropped = normalized.cropping(to: rect) else { throw ScriptError("Crop is outside the image") }
            done(.success(try write(cropped, opts: opts, sourceExt: url.pathExtension)))
          } catch { done(.failure(error)) }
        }
      } catch { done(.failure(error)) }
    }

    // (path, { format, quality, dest }) -> path. jpeg / png / heic.
    r.async("image.convert") { _, a, done in
      do {
        let url = Paths.resolve(try a.string(0))
        let opts = a.dict(1)
        DispatchQueue.global(qos: .userInitiated).async {
          do {
            guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(src, 0, nil)
            else { throw ScriptError("Could not decode image") }
            done(.success(try write(image, opts: opts, sourceExt: url.pathExtension)))
          } catch { done(.failure(error)) }
        }
      } catch { done(.failure(error)) }
    }
  }

  private static func normalize(_ image: UIImage) -> CGImage? {
    guard image.imageOrientation != .up else { return image.cgImage }
    let renderer = UIGraphicsImageRenderer(size: image.size, format: {
      let f = UIGraphicsImageRendererFormat()
      f.scale = image.scale
      return f
    }())
    return renderer.image { _ in image.draw(at: .zero) }.cgImage
  }

  private static func write(_ image: CGImage, opts: [String: Any], sourceExt: String) throws -> String {
    let format = ((opts["format"] as? String) ?? (sourceExt.isEmpty ? "jpeg" : sourceExt)).lowercased()
    let type: UTType
    switch format {
    case "png": type = .png
    case "heic", "heif": type = .heic
    default: type = .jpeg
    }
    let ext = type == .png ? "png" : (type == .heic ? "heic" : "jpg")
    let out = Paths.output(opts["dest"] as? String, ext: ext)
    guard let dest = CGImageDestinationCreateWithURL(out as CFURL, type.identifier as CFString, 1, nil) else {
      throw ScriptError("Cannot write \(format)")
    }
    let props: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: (opts["quality"] as? Double) ?? 0.9]
    CGImageDestinationAddImage(dest, image, props as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw ScriptError("Could not save image") }
    return out.path
  }

  // MARK: Video

  private static func registerVideo(_ r: NativeRegistry) {
    r.async("video.info") { _, a, done in
      do {
        let url = Paths.resolve(try a.string(0))
        Task {
          do {
            let asset = AVURLAsset(url: url)
            let (duration, tracks) = try await asset.load(.duration, .tracks)
            var info: [String: Any] = ["duration": duration.seconds, "hasAudio": false, "hasVideo": false]
            for track in tracks {
              if track.mediaType == .audio { info["hasAudio"] = true }
              if track.mediaType == .video {
                info["hasVideo"] = true
                let (size, transform, fps) = try await track.load(.naturalSize, .preferredTransform, .nominalFrameRate)
                let rect = CGRect(origin: .zero, size: size).applying(transform)
                info["width"] = abs(rect.width)
                info["height"] = abs(rect.height)
                info["fps"] = Double(fps)
              }
            }
            let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
            info["size"] = (attrs?[.size] as? NSNumber)?.doubleValue ?? 0
            done(.success(info))
          } catch { done(.failure(error)) }
        }
      } catch { done(.failure(error)) }
    }

    // (path, { time, maxSize, dest, format }) -> image path
    r.async("video.thumbnail") { _, a, done in
      do {
        let url = Paths.resolve(try a.string(0))
        let opts = a.dict(1)
        Task {
          do {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.appliesPreferredTrackTransform = true
            generator.requestedTimeToleranceBefore = .zero
            generator.requestedTimeToleranceAfter = .zero
            if let max = opts["maxSize"] as? Double { generator.maximumSize = CGSize(width: max, height: max) }
            let time = CMTime(seconds: (opts["time"] as? Double) ?? 0, preferredTimescale: 600)
            let (image, _) = try await generator.image(at: time)
            done(.success(try write(image, opts: opts, sourceExt: "jpg")))
          } catch { done(.failure(error)) }
        }
      } catch { done(.failure(error)) }
    }

    // (path, { quality: low|medium|high|hevc|720p|1080p|4k|audio, start, end, dest }) -> path
    r.async("video.export") { run, a, done in
      do {
        let url = Paths.resolve(try a.string(0))
        let opts = a.dict(1)
        let callId = a.callId
        let quality = (opts["quality"] as? String) ?? "medium"
        let presets: [String: String] = [
          "low": AVAssetExportPresetLowQuality, "medium": AVAssetExportPresetMediumQuality,
          "high": AVAssetExportPresetHighestQuality, "hevc": AVAssetExportPresetHEVCHighestQuality,
          "720p": AVAssetExportPreset1280x720, "1080p": AVAssetExportPreset1920x1080,
          "4k": AVAssetExportPreset3840x2160, "audio": AVAssetExportPresetAppleM4A,
          "passthrough": AVAssetExportPresetPassthrough,
        ]
        guard let preset = presets[quality] else { throw ScriptError("Unknown quality \(quality)") }
        let isAudio = quality == "audio"
        let out = Paths.output(opts["dest"] as? String, ext: isAudio ? "m4a" : "mp4")
        guard let session = AVAssetExportSession(asset: AVURLAsset(url: url), presetName: preset) else {
          throw ScriptError("Export not supported for this file")
        }
        session.outputURL = out
        session.outputFileType = isAudio ? .m4a : (out.pathExtension.lowercased() == "mov" ? .mov : .mp4)
        session.shouldOptimizeForNetworkUse = true
        if opts["start"] != nil || opts["end"] != nil {
          let start = CMTime(seconds: (opts["start"] as? Double) ?? 0, preferredTimescale: 600)
          let end = (opts["end"] as? Double).map { CMTime(seconds: $0, preferredTimescale: 600) } ?? .positiveInfinity
          session.timeRange = CMTimeRange(start: start, end: end)
        }
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
        timer.setEventHandler { run.emit(callId, ["type": "progress", "progress": Double(session.progress)]) }
        timer.resume()
        run.addCleanup("video.\(callId)") { session.cancelExport() }
        session.exportAsynchronously {
          timer.cancel()
          run.removeCleanup("video.\(callId)")
          switch session.status {
          case .completed: done(.success(out.path))
          case .cancelled: done(.failure(ScriptError("Export cancelled")))
          default: done(.failure(session.error ?? ScriptError("Export failed")))
          }
        }
      } catch { done(.failure(error)) }
    }
  }

  // MARK: Audio

  private static func registerAudio(_ r: NativeRegistry) {
    // (path, { volume, loop, rate }) -> resolves when playback ends
    r.async("audio.play") { run, a, done in
      do {
        let url = Paths.resolve(try a.string(0))
        let opts = a.dict(1)
        try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try AVAudioSession.sharedInstance().setActive(true)
        let player = try AVAudioPlayer(contentsOf: url)
        player.volume = Float((opts["volume"] as? Double) ?? 1)
        player.numberOfLoops = (opts["loop"] as? Bool) == true ? -1 : 0
        if let rate = opts["rate"] as? Double {
          player.enableRate = true
          player.rate = Float(rate)
        }
        let key = "audio.\(a.callId)"
        let delegate = AudioDelegate { ok in
          run.removeCleanup(key)
          AudioState.remove(key)
          done(ok ? .success(nil) : .failure(ScriptError("Could not decode audio")))
        }
        player.delegate = delegate
        AudioState.add(key, run: run, object: player, delegate: delegate)
        run.addCleanup(key) {
          player.stop()
          AudioState.remove(key)
        }
        guard player.play() else { throw ScriptError("Playback failed") }
      } catch { done(.failure(error)) }
    }

    // Stops every player and recorder of this run; their promises resolve.
    r.sync("audio.stop") { run, _ in
      AudioState.stopAll(run)
      return nil
    }

    // (dest?, { duration }) -> path when recording stops (Audio.stop() or duration reached)
    r.async("audio.record") { run, a, done in
      let dest = a.optString(0)
      let opts = a.dict(1)
      let key = "record.\(a.callId)"
      AVAudioSession.sharedInstance().requestRecordPermission { granted in
        guard granted else { return done(.failure(ScriptError("Microphone access denied"))) }
        do {
          try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
          try AVAudioSession.sharedInstance().setActive(true)
          let out = Paths.output(dest, ext: "m4a")
          let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1, AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
          ]
          let recorder = try AVAudioRecorder(url: out, settings: settings)
          let delegate = AudioDelegate { ok in
            run.removeCleanup(key)
            AudioState.remove(key)
            done(ok ? .success(out.path) : .failure(ScriptError("Recording failed")))
          }
          recorder.delegate = delegate
          AudioState.add(key, run: run, object: recorder, delegate: delegate)
          run.addCleanup(key) { recorder.stop() }
          let started = (opts["duration"] as? Double).map { recorder.record(forDuration: $0) } ?? recorder.record()
          if !started { throw ScriptError("Could not start recording") }
        } catch { done(.failure(error)) }
      }
    }

    // (text, { language, rate, pitch }) -> resolves when speech ends
    r.async("speech.speak") { run, a, done in
      do {
        let utterance = AVSpeechUtterance(string: try a.string(0))
        let opts = a.dict(1)
        if let lang = opts["language"] as? String { utterance.voice = AVSpeechSynthesisVoice(language: lang) }
        if let rate = opts["rate"] as? Double { utterance.rate = Float(rate) * AVSpeechUtteranceDefaultSpeechRate }
        if let pitch = opts["pitch"] as? Double { utterance.pitchMultiplier = Float(pitch) }
        let key = "speech.\(a.callId)"
        let synth = AVSpeechSynthesizer()
        let delegate = SpeechDelegate {
          run.removeCleanup(key)
          AudioState.remove(key)
          done(.success(nil))
        }
        synth.delegate = delegate
        AudioState.add(key, run: run, object: synth, delegate: delegate)
        run.addCleanup(key) { synth.stopSpeaking(at: .immediate) }
        synth.speak(utterance)
      } catch { done(.failure(error)) }
    }
  }
}

/// Keeps players, recorders and their delegates alive while they run.
enum AudioState {
  private struct Entry {
    weak var run: ScriptRun?
    let object: AnyObject
    let delegate: AnyObject
  }
  private static var entries: [String: Entry] = [:]
  private static let lock = NSLock()

  static func add(_ key: String, run: ScriptRun, object: AnyObject, delegate: AnyObject) {
    lock.lock()
    entries[key] = Entry(run: run, object: object, delegate: delegate)
    lock.unlock()
  }

  static func remove(_ key: String) {
    lock.lock()
    entries[key] = nil
    lock.unlock()
  }

  static func stopAll(_ run: ScriptRun) {
    lock.lock()
    let mine = entries.values.filter { $0.run === run }
    lock.unlock()
    for entry in mine {
      switch entry.object {
      case let p as AVAudioPlayer:
        p.stop()
        (entry.delegate as? AudioDelegate)?.finish(true)
      case let r as AVAudioRecorder: r.stop()
      case let s as AVSpeechSynthesizer: s.stopSpeaking(at: .immediate)
      default: break
      }
    }
  }
}

final class AudioDelegate: NSObject, AVAudioPlayerDelegate, AVAudioRecorderDelegate {
  private var onEnd: ((Bool) -> Void)?
  init(_ onEnd: @escaping (Bool) -> Void) { self.onEnd = onEnd }

  func finish(_ ok: Bool) {
    onEnd?(ok)
    onEnd = nil
  }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { finish(flag) }
  func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) { finish(false) }
  func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) { finish(flag) }
}

final class SpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
  private var onEnd: (() -> Void)?
  init(_ onEnd: @escaping () -> Void) { self.onEnd = onEnd }

  private func finish() {
    onEnd?()
    onEnd = nil
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { finish() }
  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { finish() }
}

final class CameraDelegate: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
  private var done: Completion?
  init(done: @escaping Completion) { self.done = done }

  func imagePickerController(
    _ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
  ) {
    picker.dismiss(animated: true)
    Presenter.release(picker)
    guard let done else { return }
    self.done = nil
    if let movie = info[.mediaURL] as? URL {
      let out = Paths.tempFile(movie.pathExtension.isEmpty ? "mov" : movie.pathExtension)
      do {
        try FileManager.default.copyItem(at: movie, to: out)
        done(.success(out.path))
      } catch { done(.failure(error)) }
    } else if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.95) {
      let out = Paths.tempFile("jpg")
      do {
        try data.write(to: out)
        done(.success(out.path))
      } catch { done(.failure(error)) }
    } else {
      done(.success(nil))
    }
  }

  func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
    picker.dismiss(animated: true)
    Presenter.release(picker)
    done?(.success(nil))
    done = nil
  }
}
