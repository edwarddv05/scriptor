// CodeMirror 6 editor that runs inside the app's WebView.
// Bundled into src/editor/editor-html.ts by scripts/build-editor.mjs.
import { autocompletion, completeFromList } from '@codemirror/autocomplete';
import { javascript, localCompletionSource, snippets } from '@codemirror/lang-javascript';
import { Compartment, EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';

import { COMPLETIONS } from '../src/lib/api-docs';

const post = (msg) => window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(msg));

const apiOptions = COMPLETIONS.map((c) => ({ label: c.label, detail: c.detail, info: c.info, type: 'function' }));

// Completes dotted names like "Photos.sa" -> Photos.save.
function apiSource(context) {
  const word = context.matchBefore(/[A-Za-z_$][\w$.]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return { from: word.from, options: apiOptions, validFor: /^[\w$.]*$/ };
}

const theme = new Compartment();
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const themeFor = (isDark) => (isDark ? oneDark : []);

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, Menlo, monospace', lineHeight: '1.5' },
  '.cm-content': { paddingBottom: '40vh' },
  '.cm-tooltip-autocomplete ul li': { padding: '4px 6px' },
});

let changeTimer = null;
const view = new EditorView({
  parent: document.getElementById('editor'),
  state: EditorState.create({
    doc: '',
    extensions: [
      basicSetup,
      javascript(),
      autocompletion({ override: [apiSource, localCompletionSource, completeFromList(snippets)], activateOnTyping: true }),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false' }),
      baseTheme,
      theme.of(themeFor(dark.matches)),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        clearTimeout(changeTimer);
        changeTimer = setTimeout(() => post({ type: 'change', text: view.state.doc.toString() }), 400);
      }),
    ],
  }),
});

dark.addEventListener('change', (e) => view.dispatch({ effects: theme.reconfigure(themeFor(e.matches)) }));

window.editorAPI = {
  setText(text) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  },
  insert(text) {
    const { from, to } = view.state.selection.main;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    view.focus();
  },
  flush() {
    clearTimeout(changeTimer);
    post({ type: 'change', text: view.state.doc.toString() });
  },
  focus() { view.focus(); },
  blur() { view.contentDOM.blur(); },
};

post({ type: 'ready' });
