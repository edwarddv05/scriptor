import Foundation

/// DateFormatter, RelativeDateTimeFormatter and XMLParser for Scriptable scripts.
enum FormatAPI {
  private static let styles: [DateFormatter.Style] = [.none, .short, .medium, .long, .full]

  private static func formatter(_ opts: [String: Any]) -> DateFormatter {
    let f = DateFormatter()
    if let locale = opts["locale"] as? String, !locale.isEmpty { f.locale = Locale(identifier: locale) }
    if let format = opts["format"] as? String, !format.isEmpty {
      f.dateFormat = format
    } else {
      f.dateStyle = styles[min(max(Int(num(opts["dateStyle"]) ?? 0), 0), 4)]
      f.timeStyle = styles[min(max(Int(num(opts["timeStyle"]) ?? 0), 0), 4)]
    }
    return f
  }

  static func register(_ r: NativeRegistry) {
    // (opts, ms) -> string
    r.sync("date.format") { _, a in
      formatter(a.dict(0)).string(from: Date(timeIntervalSince1970: a.double(1, 0) / 1000))
    }
    // (opts, string) -> ms | null
    r.sync("date.parse") { _, a in
      formatter(a.dict(0)).date(from: try a.string(1)).map { $0.timeIntervalSince1970 * 1000 }
    }
    // ({ locale, style }, ms, referenceMs) -> string
    r.sync("date.relative") { _, a in
      let opts = a.dict(0)
      let f = RelativeDateTimeFormatter()
      if let locale = opts["locale"] as? String, !locale.isEmpty { f.locale = Locale(identifier: locale) }
      f.dateTimeStyle = (opts["style"] as? String) == "named" ? .named : .numeric
      let date = Date(timeIntervalSince1970: a.double(1, 0) / 1000)
      let reference = Date(timeIntervalSince1970: a.double(2, Date().timeIntervalSince1970 * 1000) / 1000)
      return f.localizedString(for: date, relativeTo: reference)
    }

    // (xml) -> { ok, events: [['s', name, attrs] | ['e', name] | ['c', text]], error }
    r.sync("xml.parse") { _, a in
      let collector = XMLCollector()
      let parser = XMLParser(data: Data(try a.string(0).utf8))
      parser.delegate = collector
      let ok = parser.parse()
      var out: [String: Any] = ["ok": ok, "events": collector.events]
      if !ok { out["error"] = collector.error ?? parser.parserError?.localizedDescription ?? "Parse error" }
      return out
    }
  }
}

private final class XMLCollector: NSObject, XMLParserDelegate {
  var events: [[Any]] = []
  var error: String?

  func parser(
    _ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?,
    qualifiedName qName: String?, attributes attributeDict: [String: String] = [:]
  ) {
    events.append(["s", elementName, attributeDict])
  }

  func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
    events.append(["e", elementName])
  }

  func parser(_ parser: XMLParser, foundCharacters string: String) {
    events.append(["c", string])
  }

  func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) {
    events.append(["c", String(decoding: CDATABlock, as: UTF8.self)])
  }

  func parser(_ parser: XMLParser, parseErrorOccurred parseError: Error) {
    error = parseError.localizedDescription
  }
}
