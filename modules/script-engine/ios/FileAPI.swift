import Foundation
import UIKit
import UniformTypeIdentifiers

/// FS: whole-file and streaming-friendly helpers, folder bookmarks outside the sandbox, pickers.
enum FileAPI {
  private static let bookmarksURL = Paths.library.appendingPathComponent("folder-bookmarks.plist")
  private static var openBookmarks: [String: URL] = [:]
  private static let bookmarkLock = NSLock()

  static func register(_ r: NativeRegistry) {
    let fm = FileManager.default

    r.sync("fs.dirs") { _, _ in
      [
        "documents": Paths.documents.path,
        "cache": Paths.caches.path,
        "temp": Paths.temp.path,
        "library": Paths.library.path,
      ]
    }

    r.sync("fs.readText") { _, a in
      try String(contentsOf: Paths.resolve(try a.string(0)), encoding: .utf8)
    }
    r.sync("fs.readBytes") { _, a in
      let url = Paths.resolve(try a.string(0))
      guard a.value(1) != nil else { return try Data(contentsOf: url, options: .mappedIfSafe) }
      // Partial read: (path, offset, length) without loading the whole file.
      let handle = try FileHandle(forReadingFrom: url)
      defer { try? handle.close() }
      try handle.seek(toOffset: UInt64(a.double(1, 0)))
      return try handle.read(upToCount: a.int(2, Int.max)) ?? Data()
    }
    r.sync("fs.write") { _, a in
      let url = Paths.resolve(try a.string(0))
      try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try a.data(1).write(to: url, options: .atomic)
      return url.path
    }
    r.sync("fs.append") { _, a in
      let url = Paths.resolve(try a.string(0))
      let data = try a.data(1)
      if !fm.fileExists(atPath: url.path) {
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
        return nil
      }
      let handle = try FileHandle(forWritingTo: url)
      defer { try? handle.close() }
      try handle.seekToEnd()
      try handle.write(contentsOf: data)
      return nil
    }

    r.sync("fs.exists") { _, a in fm.fileExists(atPath: Paths.resolve(try a.string(0)).path) }
    r.sync("fs.isDir") { _, a in
      var isDir: ObjCBool = false
      return fm.fileExists(atPath: Paths.resolve(try a.string(0)).path, isDirectory: &isDir) && isDir.boolValue
    }
    r.sync("fs.list") { _, a in
      try fm.contentsOfDirectory(atPath: Paths.resolve(a.optString(0) ?? "").path).sorted()
    }
    r.sync("fs.stat") { _, a in
      let url = Paths.resolve(try a.string(0))
      let attrs = try fm.attributesOfItem(atPath: url.path)
      return [
        "path": url.path,
        "size": (attrs[.size] as? NSNumber)?.doubleValue ?? 0,
        "isDir": (attrs[.type] as? FileAttributeType) == .typeDirectory,
        "created": ((attrs[.creationDate] as? Date) ?? Date()).timeIntervalSince1970 * 1000,
        "modified": ((attrs[.modificationDate] as? Date) ?? Date()).timeIntervalSince1970 * 1000,
        "type": UTType(filenameExtension: url.pathExtension)?.identifier ?? "public.data",
      ]
    }
    r.sync("fs.mkdir") { _, a in
      let url = Paths.resolve(try a.string(0))
      try fm.createDirectory(at: url, withIntermediateDirectories: true)
      return url.path
    }
    r.sync("fs.remove") { _, a in
      let url = Paths.resolve(try a.string(0))
      if fm.fileExists(atPath: url.path) { try fm.removeItem(at: url) }
      return nil
    }
    r.sync("fs.move") { _, a in
      let to = Paths.output(try a.string(1), ext: "")
      try fm.moveItem(at: Paths.resolve(try a.string(0)), to: to)
      return to.path
    }
    r.sync("fs.copy") { _, a in
      let to = Paths.output(try a.string(1), ext: "")
      try fm.copyItem(at: Paths.resolve(try a.string(0)), to: to)
      return to.path
    }

    r.sync("fs.tempPath") { _, a in Paths.tempFile(a.optString(0) ?? "dat").path }

    // Extended attributes (FileManager.readExtendedAttribute & co. in Scriptable).
    r.sync("fs.xattr") { _, a in
      let path = Paths.resolve(try a.string(0)).path
      let name = try a.string(1)
      let size = getxattr(path, name, nil, 0, 0, 0)
      guard size >= 0 else { return nil }
      var data = Data(count: size)
      let read = data.withUnsafeMutableBytes { getxattr(path, name, $0.baseAddress, size, 0, 0) }
      guard read >= 0 else { return nil }
      return String(decoding: data.prefix(read), as: UTF8.self)
    }
    // (path, name, value | null): null removes the attribute
    r.sync("fs.setXattr") { _, a in
      let path = Paths.resolve(try a.string(0)).path
      let name = try a.string(1)
      guard let value = a.optString(2) else {
        removexattr(path, name, 0)
        return nil
      }
      let data = Data(value.utf8)
      let status = data.withUnsafeBytes { setxattr(path, name, $0.baseAddress, data.count, 0, 0) }
      guard status == 0 else { throw ScriptError("Could not write attribute \(name)") }
      return nil
    }
    r.sync("fs.xattrs") { _, a in
      let path = Paths.resolve(try a.string(0)).path
      let size = listxattr(path, nil, 0, 0)
      guard size > 0 else { return [String]() }
      var buffer = [CChar](repeating: 0, count: size)
      let read = listxattr(path, &buffer, size, 0)
      guard read > 0 else { return [String]() }
      return buffer.prefix(read).split(separator: 0).map { String(decoding: $0.map { UInt8(bitPattern: $0) }, as: UTF8.self) }
    }

    // Zips a file or folder using the system coordinator (no third-party code).
    r.async("fs.zip") { _, a, done in
      do {
        let source = Paths.resolve(try a.string(0))
        let dest = Paths.output(a.optString(1), ext: "zip")
        DispatchQueue.global(qos: .userInitiated).async {
          var coordError: NSError?
          var result: Result<Any?, Error> = .failure(ScriptError("Zip failed"))
          NSFileCoordinator().coordinate(readingItemAt: source, options: .forUploading, error: &coordError) { zipURL in
            do {
              try FileManager.default.copyItem(at: zipURL, to: dest)
              result = .success(dest.path)
            } catch {
              result = .failure(error)
            }
          }
          if let coordError { result = .failure(coordError) }
          done(result)
        }
      } catch { done(.failure(error)) }
    }

    // MARK: Pickers and bookmarks

    r.async("fs.pickFiles") { _, a, done in
      let opts = a.dict(0)
      let types = (opts["types"] as? [String])?.compactMap { UTType($0) ?? UTType(filenameExtension: $0) }
      let multiple = (opts["multiple"] as? Bool) ?? false
      DispatchQueue.main.async {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types ?? [.item], asCopy: true)
        picker.allowsMultipleSelection = multiple
        let delegate = PickerDelegate { urls in
          done(.success(urls.map { $0.path }))
        }
        picker.delegate = delegate
        Presenter.present(picker, retaining: delegate)
      }
    }

    r.async("fs.pickFolder") { _, a, done in
      let name = a.optString(0)
      DispatchQueue.main.async {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        let delegate = PickerDelegate { urls in
          guard let url = urls.first else { return done(.success(nil)) }
          let access = url.startAccessingSecurityScopedResource()
          defer { if access { url.stopAccessingSecurityScopedResource() } }
          do {
            let key = name ?? url.lastPathComponent
            let data = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            var all = loadBookmarks()
            all[key] = data
            try saveBookmarks(all)
            done(.success(try openBookmark(key)?.path))
          } catch { done(.failure(error)) }
        }
        picker.delegate = delegate
        Presenter.present(picker, retaining: delegate)
      }
    }

    r.sync("fs.bookmark") { _, a in try openBookmark(try a.string(0))?.path }
    r.sync("fs.bookmarks") { _, _ in Array(loadBookmarks().keys).sorted() }
    r.sync("fs.removeBookmark") { _, a in
      let key = try a.string(0)
      var all = loadBookmarks()
      all[key] = nil
      try saveBookmarks(all)
      return nil
    }

    // Lets the user save a copy anywhere in Files (iCloud Drive, USB drive...).
    r.async("fs.export") { _, a, done in
      do {
        let single = try a.string(0)
        let paths = a.value(0)?.isArray == true ? a.stringArray(0) : [single]
        let urls = paths.map(Paths.resolve)
        DispatchQueue.main.async {
          let picker = UIDocumentPickerViewController(forExporting: urls, asCopy: true)
          let delegate = PickerDelegate { picked in done(.success(picked.map { $0.path })) }
          picker.delegate = delegate
          Presenter.present(picker, retaining: delegate)
        }
      } catch { done(.failure(error)) }
    }
  }

  private static func loadBookmarks() -> [String: Data] {
    guard let data = try? Data(contentsOf: bookmarksURL),
      let dict = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Data]
    else { return [:] }
    return dict
  }

  private static func saveBookmarks(_ dict: [String: Data]) throws {
    let data = try PropertyListSerialization.data(fromPropertyList: dict, format: .binary, options: 0)
    try data.write(to: bookmarksURL, options: .atomic)
  }

  /// Resolves a saved folder and keeps security-scoped access open for the app's lifetime.
  private static func openBookmark(_ key: String) throws -> URL? {
    bookmarkLock.lock()
    defer { bookmarkLock.unlock() }
    if let open = openBookmarks[key] { return open }
    guard let data = loadBookmarks()[key] else { return nil }
    var stale = false
    let url = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
    _ = url.startAccessingSecurityScopedResource()
    if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
      var all = loadBookmarks()
      all[key] = fresh
      try? saveBookmarks(all)
    }
    openBookmarks[key] = url
    return url
  }
}

final class PickerDelegate: NSObject, UIDocumentPickerDelegate {
  private var onPick: (([URL]) -> Void)?
  init(_ onPick: @escaping ([URL]) -> Void) { self.onPick = onPick }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    onPick?(urls)
    onPick = nil
    Presenter.release(controller)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    onPick?([])
    onPick = nil
    Presenter.release(controller)
  }
}

/// Presents system controllers from the topmost view controller and keeps their delegates alive.
enum Presenter {
  private static var retained: [ObjectIdentifier: AnyObject] = [:]

  static func topController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.first?.windows.first
    var top = window?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }

  static func present(_ vc: UIViewController, retaining delegate: AnyObject? = nil) {
    if let delegate { retained[ObjectIdentifier(vc)] = delegate }
    if let pop = vc.popoverPresentationController, let view = topController()?.view {
      pop.sourceView = view
      pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
      pop.permittedArrowDirections = []
    }
    topController()?.present(vc, animated: true)
  }

  static func release(_ vc: UIViewController) {
    retained[ObjectIdentifier(vc)] = nil
  }
}
