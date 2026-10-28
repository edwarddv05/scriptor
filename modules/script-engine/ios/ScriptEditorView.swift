import ExpoModulesCore
import UIKit

final class ScriptEditorView: ExpoView, UITextViewDelegate, NSTextStorageDelegate {
  let textView = CodeTextView.make()
  let onRunShortcut = EventDispatcher()
  var completions: [(label: String, detail: String)] = []

  private let accessory = EditorAccessoryBar()
  private var scriptName: String?
  private var dirty = false
  private var saveTimer: Timer?
  private var bypassDelegate = false

  private static let pairs: [String: String] = ["{": "}", "(": ")", "[": "]"]

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .systemBackground

    textView.delegate = self
    textView.textStorage.delegate = self
    textView.backgroundColor = .clear
    textView.font = EditorTheme.font
    textView.typingAttributes = EditorTheme.baseAttributes
    textView.autocorrectionType = .no
    textView.autocapitalizationType = .none
    textView.spellCheckingType = .no
    textView.smartQuotesType = .no
    textView.smartDashesType = .no
    textView.smartInsertDeleteType = .no
    textView.keyboardDismissMode = .interactive
    textView.alwaysBounceVertical = true
    textView.contentInsetAdjustmentBehavior = .always
    textView.textContainer.lineFragmentPadding = 0
    // The left inset is set by the line number gutter.
    textView.textContainerInset = UIEdgeInsets(top: 12, left: 18, bottom: 160, right: 18)
    if #available(iOS 16.0, *) { textView.isFindInteractionEnabled = true }
    textView.onRun = { [weak self] in self?.onRunShortcut() }
    textView.onSave = { [weak self] in _ = self?.save() }
    addSubview(textView)

    accessory.onInsert = { [weak self] text in self?.insert(text) }
    accessory.onComplete = { [weak self] label, detail in self?.complete(label, detail: detail) }
    accessory.onDismiss = { [weak self] in self?.textView.resignFirstResponder() }
    textView.inputAccessoryView = accessory

    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    center.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
    center.addObserver(self, selector: #selector(flush), name: UIApplication.willResignActiveNotification, object: nil)
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
  }

  override func willMove(toWindow newWindow: UIWindow?) {
    super.willMove(toWindow: newWindow)
    if newWindow == nil { flush() }
  }

  // MARK: File

  func load(_ name: String) {
    guard name != scriptName else { return }
    flush()
    scriptName = name
    let text = (try? String(contentsOf: Paths.script(name), encoding: .utf8)) ?? ""
    bypassDelegate = true
    textView.text = text
    bypassDelegate = false
    textView.undoManager?.removeAllActions()
    textView.textChanged()
    dirty = false
  }

  @discardableResult
  func save() -> String {
    flush()
    return textView.text
  }

  @objc func flush() {
    saveTimer?.invalidate()
    saveTimer = nil
    guard dirty, let scriptName else { return }
    try? textView.text.write(to: Paths.script(scriptName), atomically: true, encoding: .utf8)
    dirty = false
  }

  private func scheduleSave() {
    dirty = true
    saveTimer?.invalidate()
    saveTimer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: false) { [weak self] _ in self?.flush() }
  }

  // MARK: Keyboard

  @objc private func keyboardChanged(_ note: Notification) {
    guard let window, let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
    let keyboard = convert(window.convert(frame, from: nil), from: window)
    let hiding = note.name == UIResponder.keyboardWillHideNotification
    let overlap = hiding ? 0 : max(0, bounds.maxY - keyboard.minY - safeAreaInsets.bottom)
    textView.contentInset.bottom = overlap
    textView.verticalScrollIndicatorInsets.bottom = overlap
    if !hiding, textView.isFirstResponder {
      textView.scrollRangeToVisible(textView.selectedRange)
    }
  }

  // MARK: Highlighting

  func textStorage(_ storage: NSTextStorage, didProcessEditing mask: NSTextStorage.EditActions, range: NSRange, changeInLength delta: Int) {
    guard mask.contains(.editedCharacters) else { return }
    let string = storage.string as NSString
    // Small files are re-highlighted whole so multi-line comments and template strings stay right.
    let target = string.length < 40_000 ? NSRange(location: 0, length: string.length) : string.paragraphRange(for: range)
    EditorTheme.highlight(storage, in: target)
  }

  // MARK: Editing

  func textViewDidChange(_ textView: UITextView) {
    self.textView.textChanged()
    scheduleSave()
    updateSuggestions()
  }

  /// iOS only offers "Select All" with an empty selection; keep it when part of the text is selected.
  func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
    guard range.length > 0, range.length < (textView.text as NSString).length else { return nil }
    let selectAll = UIAction(title: "Seleccionar todo", image: UIImage(systemName: "selection.pin.in.out")) { [weak textView] _ in
      textView?.selectAll(nil)
    }
    return UIMenu(children: suggestedActions + [selectAll])
  }

  func textViewDidChangeSelection(_ textView: UITextView) {
    self.textView.gutter.setNeedsDisplay()
    updateSuggestions()
  }

  func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    if bypassDelegate { return true }
    let string = textView.text as NSString
    let nextChar = range.location + range.length < string.length
      ? string.substring(with: NSRange(location: range.location + range.length, length: 1)) : ""

    if text == "\t" {
      insert("  ")
      return false
    }

    if text == "\n" {
      let lineStart = string.lineRange(for: NSRange(location: range.location, length: 0)).location
      let line = string.substring(with: NSRange(location: lineStart, length: range.location - lineStart))
      let indent = String(line.prefix { $0 == " " || $0 == "\t" })
      let last = line.trimmingCharacters(in: .whitespaces).last.map(String.init) ?? ""
      if let closer = Self.pairs[last] {
        let inner = indent + "  "
        if nextChar == closer {
          insert("\n" + inner + "\n" + indent, cursorOffset: 1 + inner.count)
        } else {
          insert("\n" + inner)
        }
      } else {
        insert("\n" + indent)
      }
      return false
    }

    // Typing a closer that is already next to the cursor just steps over it.
    if range.length == 0, Self.pairs.values.contains(text), nextChar == text {
      textView.selectedRange = NSRange(location: range.location + 1, length: 0)
      return false
    }

    if range.length == 0, let closer = Self.pairs[text], nextChar.isEmpty || nextChar.rangeOfCharacter(from: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ")]};,"))) != nil {
      insert(text + closer, cursorOffset: 1)
      return false
    }
    return true
  }

  /// Replaces the selection through UITextInput so the change joins the undo stack.
  func insert(_ text: String, cursorOffset: Int? = nil) {
    guard let range = textView.selectedTextRange else { return }
    let start = textView.offset(from: textView.beginningOfDocument, to: range.start)
    bypassDelegate = true
    textView.replace(range, withText: text)
    bypassDelegate = false
    if let cursorOffset {
      textView.selectedRange = NSRange(location: start + (text as NSString).substring(to: cursorOffset).utf16.count, length: 0)
    }
    if !textView.isFirstResponder { textView.becomeFirstResponder() }
    scheduleSave()
    updateSuggestions()
  }

  // MARK: Completions

  private func currentWord() -> NSRange? {
    let selected = textView.selectedRange
    guard selected.length == 0 else { return nil }
    let string = textView.text as NSString
    var start = selected.location
    while start > 0 {
      let c = string.character(at: start - 1)
      guard let scalar = UnicodeScalar(c), CharacterSet.alphanumerics.contains(scalar) || c == 0x24 || c == 0x5F || c == 0x2E else { break }
      start -= 1
    }
    let range = NSRange(location: start, length: selected.location - start)
    guard range.length >= 2, let first = UnicodeScalar(string.character(at: start)), !CharacterSet.decimalDigits.contains(first) else { return nil }
    return range
  }

  private func updateSuggestions() {
    guard let range = currentWord() else {
      accessory.setSuggestions([])
      return
    }
    let word = (textView.text as NSString).substring(with: range)
    let lower = word.lowercased()
    let prefix = completions.filter { $0.label.hasPrefix(word) && $0.label != word }
    let loose = completions.filter { !$0.label.hasPrefix(word) && $0.label.lowercased().contains(lower) }
    let matches = (prefix.sorted { $0.label.count < $1.label.count } + loose).prefix(16)
    accessory.setSuggestions(Array(matches))
  }

  private func complete(_ label: String, detail: String) {
    guard let range = currentWord(), let start = textView.position(from: textView.beginningOfDocument, offset: range.location),
          let end = textView.position(from: start, offset: range.length),
          let textRange = textView.textRange(from: start, to: end) else { return }
    textView.selectedTextRange = textRange
    if detail.contains(label + "(") {
      insert(label + "()", cursorOffset: label.count + 1)
    } else {
      insert(label)
    }
  }
}

/// UITextView with a line number gutter and hardware keyboard shortcuts for the editor.
final class CodeTextView: UITextView {
  var onRun: (() -> Void)?
  var onSave: (() -> Void)?
  let gutter = LineNumberGutter()
  private(set) var lineCount = 1
  /// A text view built on a container does not own its text storage.
  private var ownedStorage: NSTextStorage?

  /// A TextKit 1 text view, assembled by hand so the gutter can read line fragments from its
  /// layout manager.
  static func make() -> CodeTextView {
    let storage = NSTextStorage()
    let layout = NSLayoutManager()
    storage.addLayoutManager(layout)
    let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
    container.widthTracksTextView = true
    layout.addTextContainer(container)
    let view = CodeTextView(frame: .zero, textContainer: container)
    view.ownedStorage = storage
    view.gutter.textView = view
    view.addSubview(view.gutter)
    return view
  }

  /// Recounts lines after an edit; the gutter widens when the count gains a digit.
  func textChanged() {
    let string = text as NSString
    var count = 1
    var index = 0
    while index < string.length {
      let found = string.range(of: "\n", range: NSRange(location: index, length: string.length - index))
      if found.location == NSNotFound { break }
      count += 1
      index = found.location + 1
    }
    lineCount = count
    setNeedsLayout()
    gutter.setNeedsDisplay()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let digits = max(2, String(lineCount).count)
    let width = ceil(CGFloat(digits) * gutter.digitWidth) + 20
    if textContainerInset.left != width + 10 { textContainerInset.left = width + 10 }
    // The gutter follows the scroll so it always covers the visible rows.
    gutter.frame = CGRect(x: 0, y: contentOffset.y, width: width, height: bounds.height)
    gutter.setNeedsDisplay()
    if subviews.last !== gutter { bringSubviewToFront(gutter) }
  }

  override var keyCommands: [UIKeyCommand]? {
    let run = UIKeyCommand(title: "Ejecutar", action: #selector(runCommand), input: "r", modifierFlags: .command)
    let save = UIKeyCommand(title: "Guardar", action: #selector(saveCommand), input: "s", modifierFlags: .command)
    run.wantsPriorityOverSystemBehavior = true
    save.wantsPriorityOverSystemBehavior = true
    return (super.keyCommands ?? []) + [run, save]
  }

  @objc private func runCommand() { onRun?() }
  @objc private func saveCommand() { onSave?() }
}

// MARK: - Theme

enum EditorTheme {
  static var font: UIFont {
    let size: CGFloat = UIDevice.current.userInterfaceIdiom == .pad ? 15 : 13.5
    return UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: size, weight: .regular))
  }

  private static func color(_ light: UInt32, _ dark: UInt32) -> UIColor {
    UIColor { $0.userInterfaceStyle == .dark ? hex(dark) : hex(light) }
  }

  private static func hex(_ value: UInt32) -> UIColor {
    UIColor(red: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255, blue: CGFloat(value & 0xFF) / 255, alpha: 1)
  }

  static let plain = color(0x1F2328, 0xE4E4E9)
  static let keyword = color(0xB4246E, 0xFF7AB2)
  static let string = color(0x23784A, 0x8BD49C)
  static let number = color(0x9A5208, 0xF2B46D)
  static let comment = color(0x8A8F98, 0x7A808C)
  static let type = color(0x1E5FC2, 0x7DB4FF)
  static let call = color(0x6B3FB8, 0xC4A2FF)

  static var paragraph: NSParagraphStyle {
    let style = NSMutableParagraphStyle()
    style.lineHeightMultiple = 1.18
    return style
  }

  static var baseAttributes: [NSAttributedString.Key: Any] {
    [.font: font, .foregroundColor: plain, .paragraphStyle: paragraph]
  }

  private static func regex(_ pattern: String) -> NSRegularExpression {
    // The patterns are constants; a typo should fail loudly in development.
    try! NSRegularExpression(pattern: pattern)
  }

  private static let keywords = regex(
    "\\b(await|async|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|void|while|yield)\\b")
  private static let literals = regex("\\b(true|false|null|undefined|NaN|Infinity)\\b|\\b(0[xXbBoO][0-9a-fA-F_]+|\\d[\\d_]*(\\.\\d+)?([eE][+-]?\\d+)?n?)\\b")
  private static let types = regex("\\b[A-Z][\\w$]*\\b")
  private static let calls = regex("[A-Za-z_$][\\w$]*(?=\\s*\\()")
  private static let stringsAndComments = regex(
    "//[^\\n]*|/\\*[\\s\\S]*?(\\*/|$)|\"(\\\\.|[^\"\\\\\\n])*\"?|'(\\\\.|[^'\\\\\\n])*'?|`(\\\\.|[^`\\\\])*`?")

  static func highlight(_ storage: NSTextStorage, in range: NSRange) {
    let string = storage.string
    storage.setAttributes(baseAttributes, range: range)
    let italic = UIFont(descriptor: font.fontDescriptor.withSymbolicTraits(.traitItalic) ?? font.fontDescriptor, size: font.pointSize)
    calls.enumerateMatches(in: string, range: range) { m, _, _ in if let m { storage.addAttribute(.foregroundColor, value: call, range: m.range) } }
    types.enumerateMatches(in: string, range: range) { m, _, _ in if let m { storage.addAttribute(.foregroundColor, value: type, range: m.range) } }
    keywords.enumerateMatches(in: string, range: range) { m, _, _ in if let m { storage.addAttribute(.foregroundColor, value: keyword, range: m.range) } }
    literals.enumerateMatches(in: string, range: range) { m, _, _ in if let m { storage.addAttribute(.foregroundColor, value: number, range: m.range) } }
    // Last, so keywords inside strings and comments lose their color.
    stringsAndComments.enumerateMatches(in: string, range: range) { m, _, _ in
      guard let m else { return }
      let isComment = (string as NSString).substring(with: NSRange(location: m.range.location, length: 1)) == "/"
      storage.addAttribute(.foregroundColor, value: isComment ? comment : EditorTheme.string, range: m.range)
      if isComment { storage.addAttribute(.font, value: italic, range: m.range) }
    }
  }
}

// MARK: - Keyboard accessory

/// Bar above the keyboard: API completions while typing a name, code symbols otherwise.
final class EditorAccessoryBar: UIInputView {
  var onInsert: ((String) -> Void)?
  var onComplete: ((String, String) -> Void)?
  var onDismiss: (() -> Void)?

  private let scroll = UIScrollView()
  private let stack = UIStackView()
  private let dismissButton = UIButton(type: .system)
  private var suggestions: [(label: String, detail: String)] = []
  private var showingSuggestions = false

  private static let keys = ["⇥", "{", "}", "(", ")", "[", "]", ";", "=", "=>", "'", "\"", "`", ".", ",", ":", "!", "?", "&&", "||", "+", "-", "*", "/", "<", ">", "$", "await ", "const "]

  init() {
    super.init(frame: CGRect(x: 0, y: 0, width: 0, height: 48), inputViewStyle: .keyboard)
    allowsSelfSizing = true
    autoresizingMask = .flexibleWidth

    scroll.showsHorizontalScrollIndicator = false
    scroll.alwaysBounceHorizontal = true
    scroll.translatesAutoresizingMaskIntoConstraints = false
    addSubview(scroll)

    stack.axis = .horizontal
    stack.spacing = 6
    stack.alignment = .center
    stack.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(stack)

    var config = UIButton.Configuration.plain()
    config.image = UIImage(systemName: "keyboard.chevron.compact.down")
    config.baseForegroundColor = .secondaryLabel
    dismissButton.configuration = config
    dismissButton.accessibilityLabel = "Ocultar teclado"
    dismissButton.addAction(UIAction { [weak self] _ in self?.onDismiss?() }, for: .touchUpInside)
    dismissButton.translatesAutoresizingMaskIntoConstraints = false
    addSubview(dismissButton)

    NSLayoutConstraint.activate([
      heightAnchor.constraint(equalToConstant: 48),
      scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
      scroll.topAnchor.constraint(equalTo: topAnchor),
      scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
      scroll.trailingAnchor.constraint(equalTo: dismissButton.leadingAnchor),
      dismissButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
      dismissButton.centerYAnchor.constraint(equalTo: centerYAnchor),
      dismissButton.widthAnchor.constraint(equalToConstant: 44),
      stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 8),
      stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -8),
      stack.centerYAnchor.constraint(equalTo: scroll.frameLayoutGuide.centerYAnchor),
      stack.heightAnchor.constraint(equalToConstant: 36),
    ])
    showKeys()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  func setSuggestions(_ items: [(label: String, detail: String)]) {
    let same = items.map(\.label) == suggestions.map(\.label)
    suggestions = items
    if items.isEmpty {
      if showingSuggestions { showKeys() }
    } else if !same || !showingSuggestions {
      showSuggestions()
    }
  }

  private func reset() {
    stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
    scroll.contentOffset = .zero
  }

  private func showKeys() {
    showingSuggestions = false
    reset()
    for key in Self.keys {
      let button = makeButton(title: key.trimmingCharacters(in: .whitespaces), mono: true, prominent: false)
      button.accessibilityLabel = key == "⇥" ? "Tabulador" : key
      button.addAction(UIAction { [weak self] _ in self?.onInsert?(key == "⇥" ? "  " : key) }, for: .touchUpInside)
      stack.addArrangedSubview(button)
    }
  }

  private func showSuggestions() {
    showingSuggestions = true
    reset()
    for (index, item) in suggestions.enumerated() {
      let button = makeButton(title: item.label, mono: true, prominent: index == 0)
      button.addAction(UIAction { [weak self] _ in self?.onComplete?(item.label, item.detail) }, for: .touchUpInside)
      stack.addArrangedSubview(button)
    }
  }

  private func makeButton(title: String, mono: Bool, prominent: Bool) -> UIButton {
    var config: UIButton.Configuration
    if #available(iOS 26.0, *) {
      config = prominent ? .prominentGlass() : .glass()
    } else {
      config = prominent ? .tinted() : .gray()
    }
    config.cornerStyle = .capsule
    config.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12)
    var attributed = AttributedString(title)
    attributed.font = mono ? .monospacedSystemFont(ofSize: 15, weight: .medium) : .systemFont(ofSize: 15, weight: .medium)
    config.attributedTitle = attributed
    if !prominent { config.baseForegroundColor = .label }
    let button = UIButton(configuration: config)
    button.heightAnchor.constraint(equalToConstant: 36).isActive = true
    button.widthAnchor.constraint(greaterThanOrEqualToConstant: 40).isActive = true
    return button
  }
}

/// Line numbers beside the code. Wrapped lines get a number only on their first row.
final class LineNumberGutter: UIView {
  weak var textView: CodeTextView?

  private var numberFont: UIFont {
    UIFont.monospacedDigitSystemFont(ofSize: EditorTheme.font.pointSize * 0.82, weight: .regular)
  }

  var digitWidth: CGFloat { ("0" as NSString).size(withAttributes: [.font: numberFont]).width }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    backgroundColor = .systemBackground
    contentMode = .redraw
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  override func draw(_ rect: CGRect) {
    guard let textView, textView.window != nil else { return }
    let layout = textView.layoutManager
    let container = textView.textContainer
    let string = textView.text as NSString
    let inset = textView.textContainerInset
    let offsetY = textView.contentOffset.y
    let font = numberFont
    let right = NSMutableParagraphStyle()
    right.alignment = .right
    let caretLine = lineNumber(at: textView.selectedRange.location, in: string)

    func drawNumber(_ number: Int, fragment: CGRect) {
      let current = number == caretLine
      let attributes: [NSAttributedString.Key: Any] = [
        .font: font, .paragraphStyle: right,
        .foregroundColor: current ? UIColor.secondaryLabel : UIColor.tertiaryLabel,
      ]
      // Vertically centered on the code row, which is taller than the smaller number font.
      let y = fragment.minY + inset.top - offsetY + (fragment.height - font.lineHeight) / 2
      ("\(number)" as NSString).draw(in: CGRect(x: 0, y: y, width: bounds.width - 10, height: font.lineHeight), withAttributes: attributes)
    }

    let visible = CGRect(x: 0, y: offsetY - inset.top, width: textView.bounds.width, height: textView.bounds.height)
    let glyphs = layout.glyphRange(forBoundingRect: visible, in: container)
    let firstChar = layout.characterIndexForGlyph(at: glyphs.location)
    var number = lineNumber(at: firstChar, in: string)
    var first = true
    layout.enumerateLineFragments(forGlyphRange: glyphs) { fragment, _, _, glyphRange, _ in
      let start = layout.characterIndexForGlyph(at: glyphRange.location)
      let startsLine = start == 0 || string.character(at: start - 1) == 10
      if startsLine {
        if !first { number += 1 }
        drawNumber(number, fragment: fragment)
      }
      first = false
    }
    // The empty row after a trailing newline is not a line fragment of its own.
    let extra = layout.extraLineFragmentRect
    if !extra.isEmpty, extra.minY + inset.top - offsetY < bounds.height {
      drawNumber(lineNumber(at: string.length, in: string), fragment: extra)
    }
  }

  /// 1-based line of a character index (counts the newlines before it).
  private func lineNumber(at index: Int, in string: NSString) -> Int {
    var count = 1
    var position = 0
    let end = min(index, string.length)
    while position < end {
      let found = string.range(of: "\n", range: NSRange(location: position, length: end - position))
      if found.location == NSNotFound { break }
      count += 1
      position = found.location + 1
    }
    return count
  }
}
