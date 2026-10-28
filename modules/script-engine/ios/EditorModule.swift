import ExpoModulesCore
import UIKit

struct EditorCompletion: Record {
  @Field var label: String = ""
  @Field var detail: String = ""
}

/// Native code editor (UITextView) that loads and saves Documents/<scriptName>.js by itself,
/// so no text crosses the bridge while typing.
public class ScriptEditorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ScriptEditor")

    View(ScriptEditorView.self) {
      Events("onRunShortcut")

      Prop("scriptName") { (view: ScriptEditorView, name: String) in
        view.load(name)
      }

      Prop("completions") { (view: ScriptEditorView, items: [EditorCompletion]) in
        view.completions = items.map { ($0.label, $0.detail) }
      }

      Prop("tint") { (view: ScriptEditorView, color: UIColor?) in
        view.textView.tintColor = color
      }

      /// Writes pending edits to disk and returns the current text.
      AsyncFunction("save") { (view: ScriptEditorView) -> String in
        view.save()
      }.runOnQueue(.main)

      AsyncFunction("blur") { (view: ScriptEditorView) in
        view.textView.resignFirstResponder()
      }.runOnQueue(.main)
    }
  }
}
