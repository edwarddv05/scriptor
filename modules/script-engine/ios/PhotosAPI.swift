import Foundation
import ImageIO
import Photos
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// Photo library: pick, save images AND videos, albums, export originals, delete, EXIF.
enum PhotosAPI {
  static func register(_ r: NativeRegistry) {
    // (options { type: 'image'|'video'|'any', limit }) -> [{ path, type, filename }]
    r.async("photos.pick") { _, a, done in
      let opts = a.dict(0)
      DispatchQueue.main.async {
        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.selectionLimit = (opts["limit"] as? Int) ?? 1
        config.preferredAssetRepresentationMode = .current
        switch opts["type"] as? String {
        case "image": config.filter = .images
        case "video": config.filter = .videos
        default: config.filter = .any(of: [.images, .videos])
        }
        let picker = PHPickerViewController(configuration: config)
        let delegate = PhotoPickerDelegate(done: done)
        picker.delegate = delegate
        Presenter.present(picker, retaining: delegate)
      }
    }

    // (path, { album }) -> localIdentifier. Works for images and videos.
    r.async("photos.save") { _, a, done in
      do {
        let url = Paths.resolve(try a.string(0))
        guard FileManager.default.fileExists(atPath: url.path) else { throw ScriptError("File not found: \(url.path)") }
        let album = a.dict(1)["album"] as? String
        let type = UTType(filenameExtension: url.pathExtension)
        let isVideo = type?.conforms(to: .movie) == true || type?.conforms(to: .video) == true
        withAuthorization(.addOnly) {
          var placeholderId: String?
          PHPhotoLibrary.shared().performChanges({
            let request = PHAssetCreationRequest.forAsset()
            request.addResource(with: isVideo ? .video : .photo, fileURL: url, options: nil)
            placeholderId = request.placeholderForCreatedAsset?.localIdentifier
            if let album, let placeholder = request.placeholderForCreatedAsset,
              let collection = findAlbum(album)
            {
              PHAssetCollectionChangeRequest(for: collection)?.addAssets([placeholder] as NSArray)
            }
          }) { ok, error in
            if ok { done(.success(placeholderId)) } else { done(.failure(error ?? ScriptError("Save failed"))) }
          }
        } denied: { done(.failure(ScriptError("Photo library access denied"))) }
      } catch { done(.failure(error)) }
    }

    r.async("photos.albums") { _, _, done in
      withAuthorization(.readWrite) {
        var out: [[String: Any]] = []
        for type in [PHAssetCollectionType.album, .smartAlbum] {
          let result = PHAssetCollection.fetchAssetCollections(with: type, subtype: .any, options: nil)
          result.enumerateObjects { c, _, _ in
            out.append([
              "id": c.localIdentifier, "title": c.localizedTitle ?? "",
              "count": PHAsset.fetchAssets(in: c, options: nil).count, "smart": type == .smartAlbum,
            ])
          }
        }
        done(.success(out))
      } denied: { done(.failure(ScriptError("Photo library access denied"))) }
    }

    r.async("photos.createAlbum") { _, a, done in
      do {
        let title = try a.string(0)
        withAuthorization(.readWrite) {
          if let existing = findAlbum(title) { return done(.success(existing.localIdentifier)) }
          var id: String?
          PHPhotoLibrary.shared().performChanges({
            id = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: title)
              .placeholderForCreatedAssetCollection.localIdentifier
          }) { ok, error in
            if ok { done(.success(id)) } else { done(.failure(error ?? ScriptError("Could not create album"))) }
          }
        } denied: { done(.failure(ScriptError("Photo library access denied"))) }
      } catch { done(.failure(error)) }
    }

    // ({ type, limit, album, favorites }) -> [asset info], newest first
    r.async("photos.latest") { _, a, done in
      let opts = a.dict(0)
      withAuthorization(.readWrite) {
        let fetch = PHFetchOptions()
        fetch.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        fetch.fetchLimit = (opts["limit"] as? Int) ?? 10
        var predicates: [NSPredicate] = []
        switch opts["type"] as? String {
        case "image": predicates.append(NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue))
        case "video": predicates.append(NSPredicate(format: "mediaType == %d", PHAssetMediaType.video.rawValue))
        case "screenshot":
          predicates.append(NSPredicate(format: "(mediaSubtypes & %d) != 0", PHAssetMediaSubtype.photoScreenshot.rawValue))
        default: break
        }
        if (opts["favorites"] as? Bool) == true { predicates.append(NSPredicate(format: "favorite == YES")) }
        if !predicates.isEmpty { fetch.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: predicates) }
        let assets: PHFetchResult<PHAsset>
        if let album = opts["album"] as? String, let collection = findAlbum(album) {
          assets = PHAsset.fetchAssets(in: collection, options: fetch)
        } else {
          assets = PHAsset.fetchAssets(with: fetch)
        }
        var out: [[String: Any]] = []
        assets.enumerateObjects { asset, _, _ in out.append(describe(asset)) }
        done(.success(out))
      } denied: { done(.failure(ScriptError("Photo library access denied"))) }
    }

    // (assetId, dest?) -> path of the original file (photo, video or Live Photo still)
    r.async("photos.export") { _, a, done in
      do {
        let id = try a.string(0)
        let dest = a.optString(1)
        withAuthorization(.readWrite) {
          guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else {
            return done(.failure(ScriptError("Asset not found")))
          }
          let resources = PHAssetResource.assetResources(for: asset)
          let preferred: [PHAssetResourceType] = asset.mediaType == .video
            ? [.fullSizeVideo, .video] : [.fullSizePhoto, .photo]
          guard let resource = preferred.lazy.compactMap({ t in resources.first { $0.type == t } }).first
            ?? resources.first
          else { return done(.failure(ScriptError("Asset has no data"))) }
          let ext = (resource.originalFilename as NSString).pathExtension
          let out = Paths.output(dest, ext: ext.isEmpty ? "dat" : ext)
          let options = PHAssetResourceRequestOptions()
          options.isNetworkAccessAllowed = true
          PHAssetResourceManager.default().writeData(for: resource, toFile: out, options: options) { error in
            if let error { done(.failure(error)) } else { done(.success(out.path)) }
          }
        } denied: { done(.failure(ScriptError("Photo library access denied"))) }
      } catch { done(.failure(error)) }
    }

    // ([assetId]) -> true. iOS shows its own confirmation.
    r.async("photos.delete") { _, a, done in
      let ids = a.stringArray(0)
      withAuthorization(.readWrite) {
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        PHPhotoLibrary.shared().performChanges({
          PHAssetChangeRequest.deleteAssets(assets)
        }) { ok, error in
          if ok { done(.success(true)) } else { done(.failure(error ?? ScriptError("Delete failed"))) }
        }
      } denied: { done(.failure(ScriptError("Photo library access denied"))) }
    }

    // (path) -> EXIF / GPS / TIFF dictionaries from any image file
    r.sync("photos.metadata") { _, a in
      let url = Paths.resolve(try a.string(0))
      guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]
      else { throw ScriptError("Not an image: \(url.lastPathComponent)") }
      return sanitize(props)
    }
  }

  // MARK: Helpers

  static func withAuthorization(
    _ level: PHAccessLevel, granted: @escaping () -> Void, denied: @escaping () -> Void
  ) {
    let status = PHPhotoLibrary.authorizationStatus(for: level)
    if status == .authorized || status == .limited { return granted() }
    PHPhotoLibrary.requestAuthorization(for: level) { s in
      (s == .authorized || s == .limited) ? granted() : denied()
    }
  }

  static func findAlbum(_ titleOrId: String) -> PHAssetCollection? {
    if let byId = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [titleOrId], options: nil).firstObject {
      return byId
    }
    let options = PHFetchOptions()
    options.predicate = NSPredicate(format: "localizedTitle == %@", titleOrId)
    return PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: options).firstObject
  }

  static func describe(_ asset: PHAsset) -> [String: Any] {
    var info: [String: Any] = [
      "id": asset.localIdentifier,
      "type": asset.mediaType == .video ? "video" : (asset.mediaType == .image ? "image" : "other"),
      "width": asset.pixelWidth,
      "height": asset.pixelHeight,
      "duration": asset.duration,
      "favorite": asset.isFavorite,
      "livePhoto": asset.mediaSubtypes.contains(.photoLive),
      "screenshot": asset.mediaSubtypes.contains(.photoScreenshot),
    ]
    if let date = asset.creationDate { info["date"] = date.timeIntervalSince1970 * 1000 }
    if let loc = asset.location {
      info["location"] = ["latitude": loc.coordinate.latitude, "longitude": loc.coordinate.longitude, "altitude": loc.altitude]
    }
    return info
  }

  /// Keeps only JSON-friendly values from ImageIO dictionaries.
  static func sanitize(_ value: Any) -> Any {
    switch value {
    case let d as [String: Any]:
      var out: [String: Any] = [:]
      for (k, v) in d { out[k.replacingOccurrences(of: "{", with: "").replacingOccurrences(of: "}", with: "")] = sanitize(v) }
      return out
    case let arr as [Any]: return arr.map(sanitize)
    case is String, is NSNumber: return value
    case let date as Date: return date.timeIntervalSince1970 * 1000
    default: return "\(value)"
    }
  }
}

/// Copies picked items into tmp so scripts get plain file paths (videos included).
final class PhotoPickerDelegate: NSObject, PHPickerViewControllerDelegate {
  private var done: Completion?
  init(done: @escaping Completion) { self.done = done }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    Presenter.release(picker)
    guard let done else { return }
    self.done = nil
    if results.isEmpty { return done(.success([])) }

    let group = DispatchGroup()
    let lock = NSLock()
    var items: [(Int, [String: Any])] = []
    for (index, result) in results.enumerated() {
      let provider = result.itemProvider
      let isVideo = provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier)
      let typeId = isVideo
        ? UTType.movie.identifier
        : (provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .image) == true } ?? UTType.image.identifier)
      group.enter()
      provider.loadFileRepresentation(forTypeIdentifier: typeId) { url, _ in
        defer { group.leave() }
        guard let url else { return }
        let ext = url.pathExtension.isEmpty ? (isVideo ? "mov" : "jpg") : url.pathExtension
        let out = Paths.tempFile(ext)
        guard (try? FileManager.default.copyItem(at: url, to: out)) != nil else { return }
        var item: [String: Any] = [
          "path": out.path, "type": isVideo ? "video" : "image",
          "filename": provider.suggestedName.map { "\($0).\(ext)" } ?? url.lastPathComponent,
        ]
        if let id = result.assetIdentifier { item["id"] = id }
        lock.lock()
        items.append((index, item))
        lock.unlock()
      }
    }
    group.notify(queue: .global()) {
      done(.success(items.sorted { $0.0 < $1.0 }.map { $0.1 }))
    }
  }
}
