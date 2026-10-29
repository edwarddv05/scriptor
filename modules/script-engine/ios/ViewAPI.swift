import SwiftUI
import WebKit
import UIKit

/// UI.view: interfaces made of SwiftUI controls, with Liquid Glass on iOS 26. The prelude sends the
/// whole tree as a description (NativeView._spec()) and receives control events; each state change
/// on the script's side sends a new tree.
enum ViewAPI {
  /// Presented views keyed by "<run id>#<present call id>". Main thread only.
  private static var screens: [String: ViewScreenController] = [:]

  static func register(_ r: NativeRegistry) {
    // (tree, { title, fullscreen, background }) -> resolves when closed; emits { handler, value, seq }
    r.async("nview.present") { run, a, done in
      let tree = a.dict(0)
      let opts = a.dict(1)
      let callId = a.callId
      let key = "\(run.id)#\(callId)"
      DispatchQueue.main.async {
        let model = ScriptViewModel(tree: tree, background: ViewValue.style(opts["background"])) { [weak run] event in
          run?.emit(callId, event)
        }
        model.run = run
        let screen = ViewScreenController(model: model)
        screen.title = opts["title"] as? String
        screen.run = run
        screens[key] = screen
        screen.show(fullscreen: (opts["fullscreen"] as? Bool) == true) {
          screens[key] = nil
          done(.success(nil))
        }
      }
      run.addCleanup("nview.\(callId)") {
        DispatchQueue.main.async { screens[key]?.close() }
      }
    }

    r.sync("nview.update") { run, a in
      let key = "\(run.id)#\(a.int(0, 0))"
      let tree = a.dict(1)
      DispatchQueue.main.async { screens[key]?.model.update(tree) }
      return nil
    }

    r.sync("nview.close") { run, a in
      let key = "\(run.id)#\(a.int(0, 0))"
      DispatchQueue.main.async { screens[key]?.close() }
      return nil
    }
  }
}

final class ViewScreenController: ScriptScreenController {
  let model: ScriptViewModel

  init(model: ScriptViewModel) {
    self.model = model
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    let host = UIHostingController(rootView: ScriptViewRoot(model: model))
    host.view.backgroundColor = .clear
    addChild(host)
    host.view.frame = view.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(host.view)
    host.didMove(toParent: self)
  }
}

/// One node of the tree: { key, type, props, mods: [[name, args…]], children }.
struct ScriptViewNode: Identifiable {
  let id: String
  let type: String
  let props: [String: Any]
  let mods: [[Any]]
  let children: [ScriptViewNode]

  init(_ d: [String: Any]) {
    id = (d["key"] as? String) ?? "0"
    type = (d["type"] as? String) ?? ""
    props = (d["props"] as? [String: Any]) ?? [:]
    mods = (d["mods"] as? [[Any]]) ?? []
    children = ((d["children"] as? [[String: Any]]) ?? []).map(ScriptViewNode.init)
  }

  func string(_ key: String) -> String? { props[key] as? String }
  func double(_ key: String) -> Double? { ViewValue.double(props[key]) }
  func bool(_ key: String) -> Bool { (props[key] as? Bool) == true }
}

final class ScriptViewModel: ObservableObject {
  @Published private(set) var root: ScriptViewNode
  let background: AnyShapeStyle?
  /// The run that presented the view, for WebContent to find its WebView.
  weak var run: ScriptRun?
  private let onEvent: ([String: Any]) -> Void
  /// Events are numbered; each tree says the last one the script had handled when it was built.
  private var seq = 0
  private var ack = 0
  /// What the user set on a control, shown until a tree built after that event arrives
  /// (an older tree still carries the previous value and would make the control jump back).
  private var local: [String: (value: AnyHashable, seq: Int)] = [:]

  init(tree: [String: Any], background: AnyShapeStyle?, onEvent: @escaping ([String: Any]) -> Void) {
    root = ScriptViewNode(tree)
    self.background = background
    self.onEvent = onEvent
  }

  func update(_ tree: [String: Any]) {
    ack = Int(num(tree["ack"]) ?? 0)
    withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { root = ScriptViewNode(tree) }
  }

  @discardableResult
  func send(_ handler: String?, _ value: Any? = nil) -> Int? {
    guard let handler else { return nil }
    seq += 1
    var event: [String: Any] = ["handler": handler, "seq": seq]
    if let value { event["value"] = value }
    onEvent(event)
    return seq
  }

  /// A control's value: the tree's, or the user's while the script has not caught up.
  /// Without a handler the control keeps what the user set.
  func binding<T: Hashable>(_ node: ScriptViewNode, _ value: T, handler: String?, encode: @escaping (T) -> Any = { $0 }) -> Binding<T> {
    let key = node.id
    return Binding(
      get: { [weak self] in
        guard let self, let l = self.local[key], let v = l.value.base as? T, l.seq > self.ack else { return value }
        return v
      },
      set: { [weak self] new in
        guard let self else { return }
        let sent = self.send(handler, encode(new))
        self.local[key] = (AnyHashable(new), sent ?? Int.max)
        self.objectWillChange.send()
      })
  }
}

struct ScriptViewRoot: View {
  @ObservedObject var model: ScriptViewModel

  var body: some View {
    ZStack {
      if let background = model.background {
        Rectangle().fill(background).ignoresSafeArea()
      }
      ScriptNodeView(node: model.root, model: model)
    }
  }
}

struct ScriptNodeView: View {
  let node: ScriptViewNode
  @ObservedObject var model: ScriptViewModel

  var body: some View {
    node.mods.reduce(content) { view, mod in ViewMods.apply(mod, to: view, node: node, model: model) }
  }

  private var children: some View {
    ForEach(node.children) { ScriptNodeView(node: $0, model: model) }
  }

  private var content: AnyView {
    let p = node
    switch node.type {
    case "VStack":
      return AnyView(VStack(alignment: ViewValue.horizontal(p.props["alignment"]), spacing: p.double("spacing").map { CGFloat($0) }) { children })
    case "HStack":
      return AnyView(HStack(alignment: ViewValue.vertical(p.props["alignment"]), spacing: p.double("spacing").map { CGFloat($0) }) { children })
    case "ZStack":
      return AnyView(ZStack(alignment: ViewValue.alignment(p.props["alignment"])) { children })
    case "ScrollView":
      let spacing = p.double("spacing").map { CGFloat($0) }
      if p.string("axis") == "horizontal" {
        return AnyView(ScrollView(.horizontal, showsIndicators: (p.props["indicators"] as? Bool) ?? true) {
          HStack(alignment: ViewValue.vertical(p.props["alignment"]), spacing: spacing) { children }
        })
      }
      return AnyView(ScrollView(.vertical, showsIndicators: (p.props["indicators"] as? Bool) ?? true) {
        VStack(alignment: ViewValue.horizontal(p.props["alignment"]), spacing: spacing) { children }
      })
    case "List":
      return AnyView(List { children })
    case "Form":
      return AnyView(Form { children })
    case "Section":
      let header = p.string("header")
      let footer = p.string("footer")
      return AnyView(Section {
        children
      } header: {
        if let header { Text(verbatim: header) }
      } footer: {
        if let footer { Text(verbatim: footer) }
      })
    case "GlassEffectContainer":
      return glassContainer
    case "Text":
      return AnyView(Text(verbatim: p.string("text") ?? ""))
    case "Label":
      return AnyView(Label(p.string("title") ?? "", systemImage: p.string("systemImage") ?? "circle"))
    case "Image":
      return AnyView(image)
    case "Button":
      let role: ButtonRole? = p.string("role") == "destructive" ? .destructive : p.string("role") == "cancel" ? .cancel : nil
      return AnyView(Button(role: role) { model.send(p.string("action")) } label: { label })
    case "Menu":
      return AnyView(Menu { children } label: { label })
    case "Toggle":
      let isOn = model.binding(p, p.bool("isOn"), handler: p.string("onChange"))
      let title = p.string("title") ?? ""
      if title.isEmpty { return AnyView(Toggle(title, isOn: isOn).labelsHidden()) }
      return AnyView(Toggle(title, isOn: isOn))
    case "Slider":
      let value = model.binding(p, p.double("value") ?? 0, handler: p.string("onChange"))
      let lo = p.double("min") ?? 0
      let hi = max(p.double("max") ?? 1, lo + .ulpOfOne)
      if let step = p.double("step"), step > 0 { return AnyView(Slider(value: value, in: lo...hi, step: step)) }
      return AnyView(Slider(value: value, in: lo...hi))
    case "Stepper":
      let value = model.binding(p, p.double("value") ?? 0, handler: p.string("onChange"))
      let lo = p.double("min") ?? -.infinity
      let hi = max(p.double("max") ?? .infinity, lo)
      return AnyView(Stepper(value: value, in: lo...hi, step: p.double("step") ?? 1) { Text(verbatim: p.string("title") ?? "") })
    case "Picker":
      let selection = model.binding(p, Int(p.double("selection") ?? -1), handler: p.string("onChange"))
      let options = (p.props["options"] as? [[String: Any]]) ?? []
      return AnyView(Picker(selection: selection) {
        ForEach(options.indices, id: \.self) { i in
          let title = (options[i]["label"] as? String) ?? ""
          if let symbol = options[i]["systemImage"] as? String {
            Label(title, systemImage: symbol).tag(i)
          } else {
            Text(verbatim: title).tag(i)
          }
        }
      } label: {
        Text(verbatim: p.string("title") ?? "")
      })
    case "TextField":
      return textField
    case "DatePicker":
      return datePicker
    case "ProgressView":
      let label = p.string("label")
      guard let value = p.double("value") else {
        if let label { return AnyView(ProgressView { Text(verbatim: label) }) }
        return AnyView(ProgressView())
      }
      let total = max(p.double("total") ?? 1, .ulpOfOne)
      if let label { return AnyView(ProgressView(value: min(value, total), total: total) { Text(verbatim: label) }) }
      return AnyView(ProgressView(value: min(value, total), total: total))
    case "Spacer":
      return AnyView(Spacer(minLength: p.double("minLength").map { CGFloat($0) }))
    case "Divider":
      return AnyView(Divider())
    case "WebView":
      let web = model.run.flatMap { WebAPI.web($0, Int(p.double("view") ?? 0)) }
      return AnyView(EmbeddedWebView(web: web))
    case "Shape":
      let fill = ViewValue.style(p.props["fill"]) ?? AnyShapeStyle(Color.primary)
      switch p.string("shape") {
      case "circle": return AnyView(Circle().fill(fill))
      case "capsule": return AnyView(Capsule().fill(fill))
      default:
        if let radius = p.double("cornerRadius") {
          return AnyView(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(fill))
        }
        return AnyView(Rectangle().fill(fill))
      }
    default:
      return AnyView(EmptyView())
    }
  }

  /// Title and SF Symbol of a button or menu.
  @ViewBuilder private var label: some View {
    let title = node.string("title") ?? ""
    if let symbol = node.string("systemImage") {
      if title.isEmpty { Image(systemName: symbol) } else { Label(title, systemImage: symbol) }
    } else {
      Text(verbatim: title)
    }
  }

  private var image: Image {
    var img: Image
    if let name = node.string("system") {
      img = Image(systemName: name)
    } else if let path = node.string("path"), let ui = UIImage(contentsOfFile: Paths.resolve(path).path) {
      img = Image(uiImage: ui)
    } else {
      img = Image(systemName: "photo")
    }
    if node.bool("resizable") { img = img.resizable() }
    return img
  }

  private var glassContainer: AnyView {
    let spacing = node.double("spacing").map { CGFloat($0) }
    let vertical = node.string("axis") == "vertical"
    let stack = Group {
      if vertical {
        VStack(spacing: spacing) { children }
      } else {
        HStack(spacing: spacing) { children }
      }
    }
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      if let spacing { return AnyView(GlassEffectContainer(spacing: spacing) { stack }) }
      return AnyView(GlassEffectContainer { stack })
    }
    #endif
    return AnyView(stack)
  }

  private var textField: AnyView {
    let p = node
    let text = model.binding(p, p.string("text") ?? "", handler: p.string("onChange"))
    let placeholder = p.string("placeholder") ?? ""
    let field: AnyView
    if p.bool("secure") {
      field = AnyView(SecureField(placeholder, text: text))
    } else {
      field = AnyView(TextField(placeholder, text: text, axis: p.bool("multiline") ? .vertical : .horizontal))
    }
    let keyboard: UIKeyboardType
    switch p.string("keyboard") {
    case "number": keyboard = .numberPad
    case "decimal": keyboard = .decimalPad
    case "email": keyboard = .emailAddress
    case "url": keyboard = .URL
    case "phone": keyboard = .phonePad
    default: keyboard = .default
    }
    let plain = keyboard == .emailAddress || keyboard == .URL || p.bool("secure")
    return AnyView(field
      .keyboardType(keyboard)
      .textInputAutocapitalization(plain ? .never : nil)
      .autocorrectionDisabled(plain)
      .onSubmit { model.send(p.string("onSubmit")) })
  }

  private var datePicker: AnyView {
    let p = node
    let ms = model.binding(p, p.double("date") ?? Date().timeIntervalSince1970 * 1000, handler: p.string("onChange"))
    let date = Binding<Date>(
      get: { Date(timeIntervalSince1970: ms.wrappedValue / 1000) },
      set: { ms.wrappedValue = $0.timeIntervalSince1970 * 1000 })
    let components: DatePickerComponents
    switch p.string("mode") {
    case "date": components = [.date]
    case "time": components = [.hourAndMinute]
    default: components = [.date, .hourAndMinute]
    }
    let title = Text(verbatim: p.string("title") ?? "")
    let lo = p.double("min").map { Date(timeIntervalSince1970: $0 / 1000) }
    let hi = p.double("max").map { Date(timeIntervalSince1970: $0 / 1000) }
    switch (lo, hi) {
    case let (lo?, hi?) where lo <= hi:
      return AnyView(DatePicker(selection: date, in: lo...hi, displayedComponents: components) { title })
    case let (lo?, nil):
      return AnyView(DatePicker(selection: date, in: lo..., displayedComponents: components) { title })
    case let (nil, hi?):
      return AnyView(DatePicker(selection: date, in: ...hi, displayedComponents: components) { title })
    default:
      return AnyView(DatePicker(selection: date, displayedComponents: components) { title })
    }
  }
}

/// WebContent: a script's WebView shown inside the SwiftUI tree, with native views around or on top.
struct EmbeddedWebView: UIViewRepresentable {
  let web: ScriptWeb?

  final class Coordinator {
    var web: ScriptWeb?
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> UIView {
    let container = UIView()
    container.backgroundColor = .clear
    return container
  }

  func updateUIView(_ container: UIView, context: Context) {
    if let old = context.coordinator.web, old !== web { old.unembed(from: container) }
    context.coordinator.web = web
    if let web, web.webView.superview !== container { web.embed(in: container) }
  }

  static func dismantleUIView(_ container: UIView, coordinator: Coordinator) {
    coordinator.web?.unembed(from: container)
  }
}

/// Modifiers: one [name, args…] entry each, applied in the script's order.
enum ViewMods {
  static func apply(_ mod: [Any], to view: AnyView, node: ScriptViewNode, model: ScriptViewModel) -> AnyView {
    guard let name = mod.first as? String else { return view }
    let args = Array(mod.dropFirst())
    func arg(_ i: Int) -> Any? { i < args.count && !(args[i] is NSNull) ? args[i] : nil }

    switch name {
    case "padding":
      if let d = arg(0) as? [String: Any] {
        func edge(_ key: String, _ axis: String) -> CGFloat { ViewValue.cg(d[key]) ?? ViewValue.cg(d[axis]) ?? 0 }
        return AnyView(view.padding(EdgeInsets(
          top: edge("top", "vertical"), leading: edge("leading", "horizontal"),
          bottom: edge("bottom", "vertical"), trailing: edge("trailing", "horizontal"))))
      }
      if let n = ViewValue.cg(arg(0)) { return AnyView(view.padding(n)) }
      return AnyView(view.padding())
    case "frame":
      let d = (arg(0) as? [String: Any]) ?? [:]
      let alignment = ViewValue.alignment(d["alignment"])
      var out = view
      if d["width"] != nil || d["height"] != nil {
        out = AnyView(out.frame(width: ViewValue.cg(d["width"]), height: ViewValue.cg(d["height"]), alignment: alignment))
      }
      if ["minWidth", "maxWidth", "minHeight", "maxHeight"].contains(where: { d[$0] != nil }) {
        out = AnyView(out.frame(
          minWidth: ViewValue.cg(d["minWidth"]), maxWidth: ViewValue.cg(d["maxWidth"]),
          minHeight: ViewValue.cg(d["minHeight"]), maxHeight: ViewValue.cg(d["maxHeight"]), alignment: alignment))
      }
      return out
    case "font":
      guard let font = ViewValue.font(arg(0)) else { return view }
      return AnyView(view.font(font))
    case "fontWeight":
      return AnyView(view.fontWeight(ViewValue.weight(arg(0) as? String)))
    case "foregroundStyle":
      guard let style = ViewValue.style(arg(0)) else { return view }
      return AnyView(view.foregroundStyle(style))
    case "background":
      guard let style = ViewValue.style(arg(0)) else { return view }
      if let radius = ViewValue.cg(arg(1)) {
        return AnyView(view.background(style, in: RoundedRectangle(cornerRadius: radius, style: .continuous)))
      }
      return AnyView(view.background(style))
    case "tint":
      guard let color = ViewValue.color(arg(0)) else { return view }
      return AnyView(view.tint(color))
    case "cornerRadius":
      return AnyView(view.clipShape(RoundedRectangle(cornerRadius: ViewValue.cg(arg(0)) ?? 12, style: .continuous)))
    case "opacity":
      return AnyView(view.opacity(ViewValue.double(arg(0)) ?? 1))
    case "shadow":
      let d = (arg(1) as? [String: Any]) ?? [:]
      return AnyView(view.shadow(
        color: ViewValue.color(d["color"]) ?? .black.opacity(0.2), radius: ViewValue.cg(arg(0)) ?? 8,
        x: ViewValue.cg(d["x"]) ?? 0, y: ViewValue.cg(d["y"]) ?? 0))
    case "glassEffect":
      return glass(view, (arg(0) as? [String: Any]) ?? [:])
    case "style":
      return style(view, arg(0) as? String ?? "", type: node.type)
    case "disabled":
      return AnyView(view.disabled((arg(0) as? Bool) ?? true))
    case "lineLimit":
      return AnyView(view.lineLimit(ViewValue.double(arg(0)).map { Int($0) }))
    case "multilineTextAlignment":
      let a: TextAlignment = arg(0) as? String == "center" ? .center : arg(0) as? String == "trailing" ? .trailing : .leading
      return AnyView(view.multilineTextAlignment(a))
    case "controlSize":
      switch arg(0) as? String {
      case "mini": return AnyView(view.controlSize(.mini))
      case "small": return AnyView(view.controlSize(.small))
      case "large": return AnyView(view.controlSize(.large))
      case "extraLarge":
        if #available(iOS 17.0, *) { return AnyView(view.controlSize(.extraLarge)) }
        return AnyView(view.controlSize(.large))
      default: return AnyView(view.controlSize(.regular))
      }
    case "onTapGesture":
      let handler = arg(0) as? String
      return AnyView(view.onTapGesture { model.send(handler) })
    case "ignoresSafeArea":
      return AnyView(view.ignoresSafeArea())
    case "scrollContentBackground":
      return AnyView(view.scrollContentBackground(arg(0) as? String == "hidden" ? .hidden : .visible))
    case "aspectRatio":
      return AnyView(view.aspectRatio(contentMode: arg(0) as? String == "fill" ? .fill : .fit))
    default:
      return view
    }
  }

  /// Liquid Glass on iOS 26; an ultra-thin material in the same shape before it.
  private static func glass(_ view: AnyView, _ opts: [String: Any]) -> AnyView {
    let radius = ViewValue.cg(opts["cornerRadius"]) ?? 20
    let shape = opts["shape"] as? String ?? "capsule"
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      var glass: Glass = (opts["clear"] as? Bool) == true ? .clear : .regular
      if let tint = ViewValue.color(opts["tint"]) { glass = glass.tint(tint) }
      if (opts["interactive"] as? Bool) == true { glass = glass.interactive() }
      switch shape {
      case "circle": return AnyView(view.glassEffect(glass, in: Circle()))
      case "rect": return AnyView(view.glassEffect(glass, in: RoundedRectangle(cornerRadius: radius, style: .continuous)))
      default: return AnyView(view.glassEffect(glass, in: Capsule()))
      }
    }
    #endif
    switch shape {
    case "circle": return AnyView(view.background(.ultraThinMaterial, in: Circle()))
    case "rect": return AnyView(view.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous)))
    default: return AnyView(view.background(.ultraThinMaterial, in: Capsule()))
    }
  }

  /// .style(name): the style of the controls in this view, picked by name (and by the node's
  /// type where a name means different things, like "plain" or "wheel").
  private static func style(_ view: AnyView, _ name: String, type: String) -> AnyView {
    switch (name, type) {
    case ("plain", "List"), ("plain", "Form"): return AnyView(view.listStyle(.plain))
    case ("plain", "TextField"): return AnyView(view.textFieldStyle(.plain))
    case ("wheel", "DatePicker"): return AnyView(view.datePickerStyle(.wheel))
    case ("button", "Toggle"): return AnyView(view.toggleStyle(.button))
    default: break
    }
    switch name {
    case "glass":
      #if compiler(>=6.2)
      if #available(iOS 26.0, *) { return AnyView(view.buttonStyle(.glass)) }
      #endif
      return AnyView(view.buttonStyle(.bordered))
    case "glassProminent":
      #if compiler(>=6.2)
      if #available(iOS 26.0, *) { return AnyView(view.buttonStyle(.glassProminent)) }
      #endif
      return AnyView(view.buttonStyle(.borderedProminent))
    case "bordered": return AnyView(view.buttonStyle(.bordered))
    case "borderedProminent": return AnyView(view.buttonStyle(.borderedProminent))
    case "borderless": return AnyView(view.buttonStyle(.borderless))
    case "plain": return AnyView(view.buttonStyle(.plain))
    case "segmented": return AnyView(view.pickerStyle(.segmented))
    case "menu": return AnyView(view.pickerStyle(.menu))
    case "wheel": return AnyView(view.pickerStyle(.wheel))
    case "inline": return AnyView(view.pickerStyle(.inline))
    case "switch": return AnyView(view.toggleStyle(.switch))
    case "roundedBorder": return AnyView(view.textFieldStyle(.roundedBorder))
    case "compact": return AnyView(view.datePickerStyle(.compact))
    case "graphical": return AnyView(view.datePickerStyle(.graphical))
    case "linear": return AnyView(view.progressViewStyle(.linear))
    case "circular": return AnyView(view.progressViewStyle(.circular))
    case "insetGrouped": return AnyView(view.listStyle(.insetGrouped))
    case "grouped": return AnyView(view.listStyle(.grouped))
    case "inset": return AnyView(view.listStyle(.inset))
    case "sidebar": return AnyView(view.listStyle(.sidebar))
    default: return view
    }
  }
}

/// Reads the prelude's encoded values: numbers ("infinity" too), colors, fonts, gradients, materials.
enum ViewValue {
  static func double(_ any: Any?) -> Double? {
    if let s = any as? String {
      switch s {
      case "infinity": return .infinity
      case "-infinity": return -.infinity
      default: return Double(s)
      }
    }
    return num(any)
  }

  static func cg(_ any: Any?) -> CGFloat? { double(any).map { CGFloat($0) } }

  static func color(_ any: Any?) -> Color? {
    if let s = any as? String {
      switch s {
      case "primary": return .primary
      case "secondary": return .secondary
      case "accent", "accentColor": return .accentColor
      case "red": return .red
      case "orange": return .orange
      case "yellow": return .yellow
      case "green": return .green
      case "mint": return .mint
      case "teal": return .teal
      case "cyan": return .cyan
      case "blue": return .blue
      case "indigo": return .indigo
      case "purple": return .purple
      case "pink": return .pink
      case "brown": return .brown
      case "white": return .white
      case "black": return .black
      case "gray": return .gray
      case "clear": return .clear
      default:
        var hex = s.hasPrefix("#") ? String(s.dropFirst()) : s
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        var alpha = 1.0
        if hex.count == 8, let a = UInt64(hex.suffix(2), radix: 16) {
          alpha = Double(a) / 255
          hex = String(hex.prefix(6))
        }
        guard hex.count == 6, let ui = Style.color(["hex": hex, "alpha": alpha] as [String: Any]) else { return nil }
        return Color(uiColor: ui)
      }
    }
    return Style.color(any).map { Color(uiColor: $0) }
  }

  /// A color, a gradient ({ gradient }) or a material name.
  static func style(_ any: Any?) -> AnyShapeStyle? {
    if let s = any as? String, let m = material(s) { return AnyShapeStyle(m) }
    if let d = any as? [String: Any], let g = d["gradient"] as? [String: Any] { return AnyShapeStyle(gradient(g)) }
    return color(any).map { AnyShapeStyle($0) }
  }

  static func material(_ name: String) -> Material? {
    switch name {
    case "ultraThinMaterial": return .ultraThinMaterial
    case "thinMaterial": return .thinMaterial
    case "regularMaterial", "material": return .regularMaterial
    case "thickMaterial": return .thickMaterial
    case "ultraThickMaterial": return .ultraThickMaterial
    default: return nil
    }
  }

  static func gradient(_ g: [String: Any]) -> LinearGradient {
    let colors = ((g["colors"] as? [Any]) ?? []).compactMap { color($0) }
    let locations = ((g["locations"] as? [Any]) ?? []).compactMap { double($0) }
    let gradient = locations.count == colors.count && !colors.isEmpty
      ? Gradient(stops: zip(colors, locations).map { Gradient.Stop(color: $0, location: $1) })
      : Gradient(colors: colors)
    return LinearGradient(gradient: gradient, startPoint: unitPoint(g["start"]) ?? .top, endPoint: unitPoint(g["end"]) ?? .bottom)
  }

  static func unitPoint(_ any: Any?) -> UnitPoint? {
    if let a = any as? [Any], a.count == 2, let x = double(a[0]), let y = double(a[1]) { return UnitPoint(x: x, y: y) }
    switch any as? String {
    case "top": return .top
    case "bottom": return .bottom
    case "leading": return .leading
    case "trailing": return .trailing
    case "center": return .center
    case "topLeading": return .topLeading
    case "topTrailing": return .topTrailing
    case "bottomLeading": return .bottomLeading
    case "bottomTrailing": return .bottomTrailing
    default: return nil
    }
  }

  /// A text style name, a Scriptable Font, or { size, weight, design }.
  static func font(_ any: Any?) -> Font? {
    if let s = any as? String {
      switch s {
      case "largeTitle": return .largeTitle
      case "title", "title1": return .title
      case "title2": return .title2
      case "title3": return .title3
      case "headline": return .headline
      case "subheadline": return .subheadline
      case "body": return .body
      case "callout": return .callout
      case "footnote": return .footnote
      case "caption", "caption1": return .caption
      case "caption2": return .caption2
      default: return nil
      }
    }
    guard let d = any as? [String: Any] else { return nil }
    if d["kind"] != nil { return Style.font(d).map { Font($0 as CTFont) } }
    let design: Font.Design
    switch d["design"] as? String {
    case "monospaced": design = .monospaced
    case "rounded": design = .rounded
    case "serif": design = .serif
    default: design = .default
    }
    return .system(size: cg(d["size"]) ?? 17, weight: weight(d["weight"] as? String), design: design)
  }

  static func weight(_ name: String?) -> Font.Weight {
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

  static func horizontal(_ any: Any?) -> HorizontalAlignment {
    switch any as? String {
    case "leading": return .leading
    case "trailing": return .trailing
    default: return .center
    }
  }

  static func vertical(_ any: Any?) -> VerticalAlignment {
    switch any as? String {
    case "top": return .top
    case "bottom": return .bottom
    case "firstTextBaseline": return .firstTextBaseline
    default: return .center
    }
  }

  static func alignment(_ any: Any?) -> Alignment {
    switch any as? String {
    case "leading": return .leading
    case "trailing": return .trailing
    case "top": return .top
    case "bottom": return .bottom
    case "topLeading": return .topLeading
    case "topTrailing": return .topTrailing
    case "bottomLeading": return .bottomLeading
    case "bottomTrailing": return .bottomTrailing
    default: return .center
    }
  }
}
