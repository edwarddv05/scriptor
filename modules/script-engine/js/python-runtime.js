// The page that runs Python for Scriptor (see PythonEngine.swift). It loads Pyodide, runs one
// script or terminal line at a time and relays calls to Scriptor's API as messages to Swift.
// Embedded in PythonPage.swift by scripts/gen-prelude.mjs; scripts/test-python.mjs runs it in Node.

/** `post` sends a message to Swift; the returned `dispatch` receives Swift's messages. */
function createPythonRuntime({ loadPyodide, post, indexURL, savedLock, helperSource }) {
  let py = null;
  let current = null;
  let queue = Promise.resolve();
  let nextCall = 1;
  const calls = new Map();

  // ------------------------------------------------------------ Scriptor's API

  // Bytes travel as base64 and dates as ISO text, both tagged; a function becomes { __fn: n }
  // and its calls come back as events. The same format as the .jsx miniapps' bridge.
  function toBase64(view) {
    const bytes = new Uint8Array(view.buffer || view, view.byteOffset || 0, view.byteLength);
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(text);
  }
  function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function encode(args, fns) {
    const tag = (value) => {
      if (typeof value === 'function') {
        fns.push(value);
        return { __fn: fns.length - 1 };
      }
      if (value instanceof Date) return { __date: value.toISOString() };
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return { __bytes: toBase64(value) };
      return value;
    };
    // The replacer sees a Date already turned into text, so it reads the raw value from the holder.
    return JSON.stringify(args, function (key, value) {
      return key === '' ? value : tag(this[key]);
    });
  }
  function decode(text) {
    return JSON.parse(text, (_key, value) => {
      if (!value || typeof value !== 'object') return value;
      if (typeof value.__bytes === 'string') return fromBase64(value.__bytes);
      if (typeof value.__date === 'string') return new Date(value.__date);
      return value;
    });
  }

  globalThis.__scriptorCall = (path, args) =>
    new Promise((resolve, reject) => {
      if (!current) return reject(new Error('El script ya terminó.'));
      const id = nextCall++;
      const fns = [];
      const json = encode(Array.from(args), fns);
      calls.set(id, { resolve, reject, fns });
      post({ type: 'call', run: current, id, path: String(path), args: json });
    });
  globalThis.__saveLock = (text) => post({ type: 'saveLock', lock: String(text) });

  function reply({ id, kind, value, fn, reply: answer }) {
    const call = calls.get(id);
    if (!call) return;
    if (kind === 'event') {
      const args = decode(value);
      const message = (e) => String(e && e.message ? e.message : e);
      // What the callback returns (a Net.serve response, perhaps from an async def) goes back
      // through __hostReply; an error goes to the console as well.
      new Promise((resolve) => resolve(call.fns[fn]?.(...(Array.isArray(args) ? args : [args])))).then(
        (result) => {
          if (answer !== undefined) globalThis.__scriptorCall('__hostReply', [answer, result === undefined ? null : result, null]).catch(() => {});
        },
        (e) => {
          post({ type: 'log', run: current, level: 'error', text: message(e) });
          if (answer !== undefined) globalThis.__scriptorCall('__hostReply', [answer, null, message(e)]).catch(() => {});
        }
      );
      return;
    }
    calls.delete(id);
    // Python callables passed as arguments are proxies that must be freed.
    for (const f of call.fns) f.destroy?.();
    if (kind === 'done') call.resolve(decode(value));
    else call.reject(new Error(value));
  }

  // ---------------------------------------------------------------- Loading

  async function load() {
    const output = (level) => ({ batched: (text) => current && post({ type: 'log', run: current, level, text }) });
    const options = { indexURL, stdout: output('log').batched, stderr: output('warn').batched };
    try {
      py = await loadPyodide(savedLock ? { ...options, lockFileContents: savedLock, packageBaseUrl: indexURL } : options);
    } catch (error) {
      // A lockfile pip saved that no longer loads must not keep Python from starting.
      if (!savedLock) throw error;
      py = await loadPyodide(options);
    }
    py.globals.set('__scriptor_source', helperSource);
    py.runPython("import sys, types\n_m = types.ModuleType('_scriptor')\nexec(compile(__scriptor_source, '/lib/_scriptor.py', 'exec'), _m.__dict__)\nsys.modules['_scriptor'] = _m\ndel __scriptor_source, _m");
    return py;
  }
  const ready = load();
  ready.then(
    () => post({ type: 'ready' }),
    (error) => post({ type: 'loadFailed', message: `No se pudo cargar Python. La primera vez se descarga (unos 12 MB): revisa la conexión. (${error && error.message ? error.message : error})` })
  );

  // ---------------------------------------------------------------- Running

  // Pyodide's own frames say nothing about the script; the traceback keeps only the script's.
  function cleanError(error) {
    const text = String(error && error.message ? error.message : error);
    const out = [];
    let skipping = false;
    for (const line of text.split('\n')) {
      if (/^ {2}File "\/lib\//.test(line)) {
        skipping = true;
        continue;
      }
      if (skipping && /^ {4}/.test(line)) continue;
      skipping = false;
      out.push(line);
    }
    return out.join('\n').trim();
  }

  async function execute({ run, name, code, repl, session, args }) {
    current = run;
    try {
      await ready;
      // Packages the code imports (numpy, pandas, what pip installed…) load before it runs.
      await py.loadPackagesFromImports(code, {
        messageCallback: (text) => /^Loaded|^Loading/.test(text) && post({ type: 'log', run, level: 'info', text: text.replace(/^Loading/, 'Cargando').replace(/^Loaded/, 'Cargado') }),
        errorCallback: (text) => post({ type: 'log', run, level: 'warn', text }),
      });
      // pip lives in micropip, which only the terminal's pip lines import, inside _scriptor.
      const PIP = new RegExp('_pip\\(|micropip');
      if (PIP.test(code)) await py.loadPackage('micropip', { messageCallback: () => {} });
      const helpers = py.pyimport('_scriptor');
      if (repl) await helpers._line(session || run, code);
      else await helpers._script(name, code, py.toPy(args || {}));
      helpers.destroy();
      post({ type: 'done', run });
    } catch (error) {
      post({ type: 'done', run, error: cleanError(error) });
    } finally {
      current = null;
      // Calls still waiting belong to a run that ended.
      for (const [id, call] of calls) {
        calls.delete(id);
        call.reject(new Error('El script ya terminó.'));
      }
    }
  }

  return {
    ready,
    dispatch(message) {
      if (message.type === 'run') queue = queue.then(() => execute(message));
      else if (message.type === 'reply') reply(message.reply);
    },
  };
}
