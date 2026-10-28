import Foundation
import UIKit

/// Scriptable's UITable. The prelude sends the whole table as a description (UITable._spec()) and
/// receives taps as events; reload() sends a new description to the presented table.
enum TableAPI {
  /// Presented tables keyed by "<run id>#<present call id>". Main thread only.
  private static var tables: [String: TableScreenController] = [:]

  static func register(_ r: NativeRegistry) {
    // (spec, fullscreen) -> resolves when dismissed; emits { type: 'tap'|'select', row, cell }
    r.async("table.present") { run, a, done in
      let spec = a.dict(0)
      let fullscreen = a.bool(1, false)
      let callId = a.callId
      let key = "\(run.id)#\(callId)"
      DispatchQueue.main.async {
        let screen = TableScreenController(spec: spec) { [weak run] event in run?.emit(callId, event) }
        screen.run = run
        tables[key] = screen
        screen.show(fullscreen: fullscreen) {
          tables[key] = nil
          done(.success(nil))
        }
      }
      run.addCleanup("table.\(callId)") {
        DispatchQueue.main.async { tables[key]?.close() }
      }
    }

    r.sync("table.update") { run, a in
      let key = "\(run.id)#\(a.int(0, 0))"
      let spec = a.dict(1)
      DispatchQueue.main.async { tables[key]?.update(spec) }
      return nil
    }
  }
}

final class TableScreenController: ScriptScreenController, UITableViewDataSource, UITableViewDelegate {
  private let tableView = UITableView(frame: .zero, style: .plain)
  private var rows: [[String: Any]] = []
  /// UITable.glass (a Scriptor extra): rows as Liquid Glass cards on a grouped background.
  private var glass = false
  private let onEvent: ([String: Any]) -> Void

  init(spec: [String: Any], onEvent: @escaping ([String: Any]) -> Void) {
    self.onEvent = onEvent
    super.init(nibName: nil, bundle: nil)
    apply(spec)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func apply(_ spec: [String: Any]) {
    rows = (spec["rows"] as? [[String: Any]]) ?? []
    glass = (spec["glass"] as? Bool) == true
    tableView.separatorStyle = !glass && (spec["showSeparators"] as? Bool) == true ? .singleLine : .none
  }

  private func applyBackground() {
    view.backgroundColor = glass ? .systemGroupedBackground : .systemBackground
    tableView.backgroundColor = glass ? .clear : .systemBackground
  }

  func update(_ spec: [String: Any]) {
    apply(spec)
    if isViewLoaded { applyBackground() }
    tableView.reloadData()
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    applyBackground()
    tableView.dataSource = self
    tableView.delegate = self
    tableView.register(TableRowCell.self, forCellReuseIdentifier: "row")
    tableView.frame = view.bounds
    tableView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(tableView)
  }

  func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }

  func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
    CGFloat(num(rows[indexPath.row]["height"]) ?? 44)
  }

  func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath) as! TableRowCell
    let row = rows[indexPath.row]
    let index = indexPath.row
    cell.configure(row, glass: glass) { [weak self] cellIndex, dismiss in
      self?.onEvent(["type": "tap", "row": index, "cell": cellIndex])
      if dismiss { self?.close() }
    }
    // Glass cards give their own touch feedback.
    cell.selectionStyle = !glass && (row["selectable"] as? Bool) == true ? .default : .none
    return cell
  }

  func tableView(_ tableView: UITableView, willSelectRowAt indexPath: IndexPath) -> IndexPath? {
    (rows[indexPath.row]["selectable"] as? Bool) == true ? indexPath : nil
  }

  func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    tableView.deselectRow(at: indexPath, animated: true)
    let row = rows[indexPath.row]
    onEvent(["type": "select", "row": indexPath.row])
    if (row["dismissOnSelect"] as? Bool) ?? true { close() }
  }
}

/// One row: cells side by side, each as wide as its widthWeight share.
final class TableRowCell: UITableViewCell {
  private var cellViews: [UIView] = []
  private var weights: [CGFloat] = []
  private var spacing: CGFloat = 0
  private var imageTasks: [URLSessionDataTask] = []
  /// The row's glass card in a glass table; header rows have none.
  private var card: UIVisualEffectView?

  func configure(_ row: [String: Any], glass: Bool, onTap: @escaping (Int, Bool) -> Void) {
    cellViews.forEach { $0.removeFromSuperview() }
    imageTasks.forEach { $0.cancel() }
    imageTasks.removeAll()
    cellViews.removeAll()
    weights.removeAll()
    card?.removeFromSuperview()
    card = nil
    spacing = CGFloat(num(row["cellSpacing"]) ?? 0)
    let isHeader = (row["isHeader"] as? Bool) == true
    if glass {
      backgroundColor = .clear
      if !isHeader {
        let selectable = (row["selectable"] as? Bool) == true
        let v = UIVisualEffectView(effect: Self.cardEffect(tint: Style.color(row["backgroundColor"]), interactive: selectable))
        v.layer.cornerRadius = 18
        v.layer.cornerCurve = .continuous
        v.clipsToBounds = true
        contentView.insertSubview(v, at: 0)
        card = v
      }
    } else {
      backgroundColor = Style.color(row["backgroundColor"]) ?? .clear
    }
    let cells = (row["cells"] as? [[String: Any]]) ?? []
    for (i, cell) in cells.enumerated() {
      let v = makeView(cell, index: i, isHeader: isHeader, onTap: onTap)
      contentView.addSubview(v)
      cellViews.append(v)
      weights.append(CGFloat(num(cell["widthWeight"]) ?? 1))
    }
    setNeedsLayout()
  }

  /// Liquid Glass on iOS 26, a thin blur material before it. The row's backgroundColor tints it.
  private static func cardEffect(tint: UIColor?, interactive: Bool) -> UIVisualEffect {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      let effect = UIGlassEffect()
      effect.tintColor = tint
      effect.isInteractive = interactive
      return effect
    }
    #endif
    return UIBlurEffect(style: .systemThinMaterial)
  }

  private func alignment(_ cell: [String: Any]) -> NSTextAlignment {
    switch cell["align"] as? String {
    case "center": return .center
    case "right": return .right
    default: return .left
    }
  }

  private func makeView(_ cell: [String: Any], index: Int, isHeader: Bool, onTap: @escaping (Int, Bool) -> Void) -> UIView {
    switch cell["type"] as? String {
    case "button":
      let button = UIButton(type: .system)
      button.setTitle(cell["title"] as? String, for: .normal)
      if let font = Style.font(cell["titleFont"]) { button.titleLabel?.font = font }
      if let color = Style.color(cell["titleColor"]) { button.setTitleColor(color, for: .normal) }
      switch alignment(cell) {
      case .center: button.contentHorizontalAlignment = .center
      case .right: button.contentHorizontalAlignment = .right
      default: button.contentHorizontalAlignment = .left
      }
      let dismiss = (cell["dismissOnTap"] as? Bool) == true
      button.addAction(UIAction { _ in onTap(index, dismiss) }, for: .touchUpInside)
      return button
    case "image", "imageURL":
      let iv = UIImageView()
      iv.contentMode = .scaleAspectFit
      iv.clipsToBounds = true
      if let path = cell["image"] as? String {
        iv.image = UIImage(contentsOfFile: Paths.resolve(path).path)
      } else if let text = cell["url"] as? String, let url = URL(string: text) {
        let task = URLSession.shared.dataTask(with: url) { data, _, _ in
          guard let data, let image = UIImage(data: data) else { return }
          DispatchQueue.main.async { iv.image = image }
        }
        imageTasks.append(task)
        task.resume()
      }
      return iv
    default:
      let title = UILabel()
      title.text = cell["title"] as? String
      title.font = Style.font(cell["titleFont"]) ?? .preferredFont(forTextStyle: isHeader ? .headline : .body)
      title.textColor = Style.color(cell["titleColor"]) ?? .label
      title.numberOfLines = 0
      let subtitle = UILabel()
      subtitle.text = cell["subtitle"] as? String
      subtitle.font = Style.font(cell["subtitleFont"]) ?? .preferredFont(forTextStyle: .footnote)
      subtitle.textColor = Style.color(cell["subtitleColor"]) ?? .secondaryLabel
      subtitle.numberOfLines = 0
      subtitle.isHidden = (subtitle.text ?? "").isEmpty
      title.textAlignment = alignment(cell)
      subtitle.textAlignment = alignment(cell)
      let stack = UIStackView(arrangedSubviews: [title, subtitle])
      stack.axis = .vertical
      stack.spacing = 2
      stack.alignment = .fill
      stack.distribution = .fill
      let wrapper = CenteringView(content: stack)
      return wrapper
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    card?.frame = contentView.bounds.inset(by: UIEdgeInsets(top: 3, left: 12, bottom: 3, right: 12))
    let insets = card == nil
      ? UIEdgeInsets(top: 4, left: 16, bottom: 4, right: 16)
      : UIEdgeInsets(top: 7, left: 28, bottom: 7, right: 28)
    let bounds = contentView.bounds.inset(by: insets)
    let total = weights.reduce(0, +)
    guard total > 0 else { return }
    let available = bounds.width - spacing * CGFloat(max(cellViews.count - 1, 0))
    var x = bounds.minX
    for (v, w) in zip(cellViews, weights) {
      let width = available * w / total
      v.frame = CGRect(x: x, y: bounds.minY, width: width, height: bounds.height)
      x += width + spacing
    }
  }
}

/// Centers its content vertically (labels in a row of fixed height).
final class CenteringView: UIView {
  private let content: UIView
  init(content: UIView) {
    self.content = content
    super.init(frame: .zero)
    addSubview(content)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func layoutSubviews() {
    super.layoutSubviews()
    let size = content.systemLayoutSizeFitting(
      CGSize(width: bounds.width, height: UIView.layoutFittingCompressedSize.height),
      withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
    let height = min(size.height, bounds.height)
    content.frame = CGRect(x: 0, y: (bounds.height - height) / 2, width: bounds.width, height: height)
  }
}
