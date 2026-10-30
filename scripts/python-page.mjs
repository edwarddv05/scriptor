// Assembles the HTML page PythonEngine.swift loads: python-runtime.js, scriptor_py.py and the
// boot code that fetches Pyodide through the app's scriptor-py:// file cache.
import { readFileSync } from 'node:fs';
import { jsDir } from './prelude-source.mjs';

export const pythonRuntimeSource = () => readFileSync(jsDir + 'python-runtime.js', 'utf8');
export const scriptorPySource = () => readFileSync(jsDir + 'scriptor_py.py', 'utf8');

export function pythonPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<script>
const SCRIPTOR_PY = ${JSON.stringify(scriptorPySource())};
${pythonRuntimeSource()}
(function () {
  const post = (message) => window.webkit.messageHandlers.py.postMessage(message);
  const indexURL = 'scriptor-py://app/cdn/';
  // Wheels pip downloads from PyPI go through the app, which keeps them on disk.
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input && input.url;
    if (url && url.startsWith('https://files.pythonhosted.org/')) return realFetch('scriptor-py://app/cache/' + encodeURIComponent(url), init);
    return realFetch(input, init);
  };
  let runtime = null;
  const early = [];
  window.__dispatch = (message) => (runtime ? runtime.dispatch(message) : early.push(message));
  const script = document.createElement('script');
  script.src = indexURL + 'pyodide.js';
  script.onload = () => {
    runtime = createPythonRuntime({
      loadPyodide, post, indexURL, helperSource: SCRIPTOR_PY,
      savedLock: window.__savedLock ? JSON.stringify(window.__savedLock) : null,
    });
    early.splice(0).forEach((message) => runtime.dispatch(message));
  };
  script.onerror = () => post({ type: 'loadFailed', message: 'No se pudo descargar Python (unos 12 MB la primera vez). Revisa la conexión.' });
  document.head.appendChild(script);
  post({ type: 'page' });
})();
</script>
</body></html>
`;
}
