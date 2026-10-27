import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// DrawContext rendering, SF Symbols, image encoding and pasteboard images.
enum GraphicsAPI {
  private struct DrawState {
    var fill: UIColor = .black
    var stroke: UIColor = .black
    var lineWidth: CGFloat = 1
    var font: UIFont = .systemFont(ofSize: 17)
    var textColor: UIColor = .black
    var align: NSTextAlignment = .left
    var path = CGMutablePath()
  }

  static func register(_ r: NativeRegistry) {
    // ({ width, height, respectScreenScale, opaque, ops }) -> { path, width, height }
    r.sync("draw.render") { _, a in
      let spec = a.dict(0)
      let size = CGSize(width: num(spec["width"]) ?? 200, height: num(spec["height"]) ?? 200)
      let (screenScale, traits) = onMain { (UIScreen.main.scale, UIScreen.main.traitCollection) }
      let format = UIGraphicsImageRendererFormat()
      format.scale = (spec["respectScreenScale"] as? Bool) == true ? screenScale : 1
      format.opaque = (spec["opaque"] as? Bool) ?? true
      let ops = (spec["ops"] as? [[Any]]) ?? []
      let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
        var state = DrawState()
        traits.performAsCurrent {
          for op in ops { apply(op, ctx.cgContext, &state, traits) }
        }
      }
      guard let png = image.pngData() else { throw ScriptError("Could not render the drawing") }
      let out = Paths.tempFile("png")
      try png.write(to: out)
      return ["path": out.path, "width": size.width, "height": size.height]
    }

    r.sync("symbol.exists") { _, a in UIImage(systemName: try a.string(0)) != nil }

    // (name, { size, weight, font }) -> { path, width, height } rendered black at 3x, used as a template.
    r.sync("symbol.render") { _, a in
      let name = try a.string(0)
      let opts = a.dict(1)
      let config: UIImage.SymbolConfiguration
      if let font = Style.font(opts["font"]) {
        config = UIImage.SymbolConfiguration(font: font)
      } else {
        config = UIImage.SymbolConfiguration(
          pointSize: CGFloat(num(opts["size"]) ?? 17), weight: symbolWeight(opts["weight"] as? String))
      }
      guard let symbol = UIImage(systemName: name, withConfiguration: config)?
        .withTintColor(.black, renderingMode: .alwaysOriginal)
      else { throw ScriptError("No SF Symbol named \(name)") }
      let format = UIGraphicsImageRendererFormat()
      format.scale = 3
      format.opaque = false
      let image = UIGraphicsImageRenderer(size: symbol.size, format: format).image { _ in symbol.draw(at: .zero) }
      guard let png = image.pngData() else { throw ScriptError("Could not render \(name)") }
      let out = Paths.tempFile("png")
      try png.write(to: out)
      return ["path": out.path, "width": symbol.size.width, "height": symbol.size.height]
    }

    // (path, format, quality) -> bytes
    r.sync("image.encode") { _, a in
      try encode(Paths.resolve(try a.string(0)), format: a.optString(1) ?? "png", quality: a.double(2, 0.9))
    }
    // (path, dest, format, quality) -> dest
    r.sync("image.write") { _, a in
      let data = try encode(Paths.resolve(try a.string(0)), format: a.optString(2) ?? "png", quality: a.double(3, 0.9))
      let dest = Paths.resolve(try a.string(1))
      try FileManager.default.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
      try data.write(to: dest, options: .atomic)
      return dest.path
    }

    r.sync("pasteboard.copyImage") { _, a in
      let path = Paths.resolve(try a.string(0)).path
      guard let image = UIImage(contentsOfFile: path) else { throw ScriptError("Not an image") }
      DispatchQueue.main.sync { UIPasteboard.general.image = image }
      return nil
    }
    r.sync("pasteboard.pasteImage") { _, _ in
      guard let image = onMain({ UIPasteboard.general.image }), let png = image.pngData() else { return nil }
      let out = Paths.tempFile("png")
      try png.write(to: out)
      return out.path
    }
  }

  private static func symbolWeight(_ name: String?) -> UIImage.SymbolWeight {
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

  /// Re-encodes an image file as png / jpeg / heic, applying its EXIF orientation.
  static func encode(_ url: URL, format: String, quality: Double) throws -> Data {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { throw ScriptError("Not an image: \(url.lastPathComponent)") }
    let thumbOpts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: 100_000,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(src, 0, thumbOpts as CFDictionary) else {
      throw ScriptError("Could not decode image")
    }
    let type: UTType = format == "jpeg" || format == "jpg" ? .jpeg : format == "heic" ? .heic : .png
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, type.identifier as CFString, 1, nil) else {
      throw ScriptError("Cannot encode \(format)")
    }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw ScriptError("Could not encode image") }
    return data as Data
  }

  // MARK: Drawing

  private static func d(_ op: [Any], _ i: Int) -> CGFloat { CGFloat(i < op.count ? num(op[i]) ?? 0 : 0) }
  private static func rect(_ op: [Any], _ i: Int) -> CGRect { CGRect(x: d(op, i), y: d(op, i + 1), width: d(op, i + 2), height: d(op, i + 3)) }

  private static func apply(_ op: [Any], _ cg: CGContext, _ s: inout DrawState, _ traits: UITraitCollection) {
    guard let name = op.first as? String else { return }
    let color = { (i: Int) -> UIColor? in
      Style.color(i < op.count ? op[i] : nil)?.resolvedColor(with: traits)
    }
    switch name {
    case "fillColor": s.fill = color(1) ?? s.fill
    case "strokeColor": s.stroke = color(1) ?? s.stroke
    case "lineWidth": s.lineWidth = d(op, 1)
    case "textColor": s.textColor = color(1) ?? s.textColor
    case "font": s.font = Style.font(op.count > 1 ? op[1] : nil) ?? s.font
    case "align":
      let a = op.count > 1 ? op[1] as? String : nil
      s.align = a == "center" ? .center : a == "right" ? .right : .left
    case "fillRect":
      cg.setFillColor(s.fill.cgColor)
      cg.fill(rect(op, 1))
    case "fillEllipse":
      cg.setFillColor(s.fill.cgColor)
      cg.fillEllipse(in: rect(op, 1))
    case "strokeRect":
      cg.setStrokeColor(s.stroke.cgColor)
      cg.setLineWidth(s.lineWidth)
      cg.stroke(rect(op, 1))
    case "strokeEllipse":
      cg.setStrokeColor(s.stroke.cgColor)
      cg.setLineWidth(s.lineWidth)
      cg.strokeEllipse(in: rect(op, 1))
    case "path":
      s.path = buildPath((op.count > 1 ? op[1] as? [[Any]] : nil) ?? [])
    case "fillPath":
      cg.addPath(s.path)
      cg.setFillColor(s.fill.cgColor)
      cg.fillPath()
    case "strokePath":
      cg.addPath(s.path)
      cg.setStrokeColor(s.stroke.cgColor)
      cg.setLineWidth(s.lineWidth)
      cg.strokePath()
    case "image":
      guard let path = op.count > 1 ? op[1] as? String : nil,
        let image = UIImage(contentsOfFile: Paths.resolve(path).path)
      else { return }
      if op.count >= 6 { image.draw(in: rect(op, 2)) } else { image.draw(at: CGPoint(x: d(op, 2), y: d(op, 3))) }
    case "text":
      guard let text = op.count > 1 ? op[1] as? String : nil else { return }
      let paragraph = NSMutableParagraphStyle()
      paragraph.alignment = s.align
      let attrs: [NSAttributedString.Key: Any] = [.font: s.font, .foregroundColor: s.textColor, .paragraphStyle: paragraph]
      if op.count >= 6 {
        (text as NSString).draw(in: rect(op, 2), withAttributes: attrs)
      } else {
        (text as NSString).draw(at: CGPoint(x: d(op, 2), y: d(op, 3)), withAttributes: attrs)
      }
    default:
      break
    }
  }

  private static func buildPath(_ ops: [[Any]]) -> CGMutablePath {
    let path = CGMutablePath()
    for op in ops {
      guard let name = op.first as? String else { continue }
      switch name {
      case "move": path.move(to: CGPoint(x: d(op, 1), y: d(op, 2)))
      case "line":
        if path.isEmpty { path.move(to: CGPoint(x: d(op, 1), y: d(op, 2))) } else { path.addLine(to: CGPoint(x: d(op, 1), y: d(op, 2))) }
      case "rect": path.addRect(rect(op, 1))
      case "ellipse": path.addEllipse(in: rect(op, 1))
      case "rounded":
        let r = rect(op, 1)
        path.addRoundedRect(in: r, cornerWidth: min(d(op, 5), r.width / 2), cornerHeight: min(d(op, 6), r.height / 2))
      case "curve":
        path.addCurve(
          to: CGPoint(x: d(op, 1), y: d(op, 2)), control1: CGPoint(x: d(op, 3), y: d(op, 4)),
          control2: CGPoint(x: d(op, 5), y: d(op, 6)))
      case "quad":
        path.addQuadCurve(to: CGPoint(x: d(op, 1), y: d(op, 2)), control: CGPoint(x: d(op, 3), y: d(op, 4)))
      case "close": path.closeSubpath()
      default: break
      }
    }
    return path
  }
}
