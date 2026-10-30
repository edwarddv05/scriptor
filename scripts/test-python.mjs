// Runs the Python page's runtime (js/python-runtime.js + js/scriptor_py.py) in Node with real
// Pyodide and a fake Swift side, to catch mistakes before an iOS build.
// Usage: PYODIDE_DIR=/path/to/node_modules/pyodide node scripts/test-python.mjs
// (install it anywhere with `npm i pyodide@0.29.3`; it matches PythonFiles.version).
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { pythonRuntimeSource, scriptorPySource } from './python-page.mjs';

const dir = process.env.PYODIDE_DIR;
if (!dir) {
  console.log('skipped: set PYODIDE_DIR to a pyodide@0.29.3 install');
  process.exit(0);
}
const { loadPyodide } = await import(pathToFileURL(path.join(dir, 'pyodide.mjs')).href);

const sent = [];
const waiters = [];
const post = (message) => {
  sent.push(message);
  // The fake Swift side answers API calls the way the host run would.
  if (message.type === 'call') setTimeout(() => answer(message), 1);
  waiters.splice(0).forEach((w) => w());
};
const files = {};
function answer({ run, id, path: api, args }) {
  const list = JSON.parse(args);
  const done = (value) => runtime.dispatch({ type: 'reply', run, reply: { id, kind: 'done', value: JSON.stringify(value ?? null) } });
  if (api === 'FS.writeText') { files[list[0]] = list[1]; return done(list[0]); }
  if (api === 'FS.readText') return done(files[list[0]]);
  if (api === 'FS.readBytes') return done({ __bytes: Buffer.from(files[list[0]]).toString('base64') });
  if (api === 'FS.writeBytes') { files[list[0]] = Buffer.from(list[1].__bytes, 'base64').toString(); return done(list[0]); }
  if (api === 'Device.info') return done({ model: 'iPhone', battery: 0.5 });
  if (api === 'Net.download') {
    runtime.dispatch({ type: 'reply', run, reply: { id, kind: 'event', fn: list[2].onProgress.__fn, value: JSON.stringify([{ loaded: 5, total: 10 }]) } });
    return done({ path: list[1], size: 10 });
  }
  runtime.dispatch({ type: 'reply', run, reply: { id, kind: 'error', value: `${api} no existe en Scriptor.` } });
}

const ctx = vm.createContext({ console, setTimeout, btoa, atob, JSON, Promise, Uint8Array, ArrayBuffer, Date, Error });
vm.runInContext(pythonRuntimeSource(), ctx);
const runtime = ctx.createPythonRuntime({ loadPyodide: (o) => loadPyodide({ ...o, indexURL: dir }), post, indexURL: dir, savedLock: null, helperSource: scriptorPySource() });
// Pyodide's `js` module is Node's own global object, not the sandbox's (in the page they are the same).
globalThis.__scriptorCall = ctx.__scriptorCall;
globalThis.__saveLock = ctx.__saveLock;

async function run(id, code, repl = false, args = {}) {
  runtime.dispatch({ type: 'run', run: id, name: `${id}.py`, code, repl, args });
  while (!sent.some((m) => m.type === 'done' && m.run === id)) await new Promise((r) => waiters.push(r));
  const logs = sent.filter((m) => m.type === 'log' && m.run === id && m.level !== 'info').map((m) => m.text);
  return { ...sent.find((m) => m.type === 'done' && m.run === id), logs };
}

const tests = {
  async 'prints and finishes'() {
    const r = await run('a', 'print("hola", 1 + 1)\nimport math\nprint(math.pi > 3)');
    assert.equal(r.error, undefined);
    assert.deepEqual(r.logs, ['hola 2', 'True']);
  },
  async 'the terminal passes argv'() {
    const r = await run('v', 'import sys\nprint(sys.argv)', false, { argv: ['x.py', 'a', 'b'] });
    assert.deepEqual(r.logs, ["['x.py', 'a', 'b']"]);
    const plain = await run('w', 'import sys\nprint(sys.argv)');
    assert.deepEqual(plain.logs, ["['w.py']"]);
  },
  async 'calls Scriptor with await, kwargs and callbacks'() {
    const r = await run('b', [
      'from scriptor import FS, Device, Net, args',
      "await FS.writeText('n.txt', 'texto')",
      "print(await FS.readText('n.txt'), args['k'])",
      'info = await Device.info()',
      "print(info['model'], info['battery'])",
      "data = await FS.readBytes('n.txt')",
      'print(type(data).__name__, data)',
      "r = await Net.download('https://x', 'v.mp4', onProgress=lambda p: print('progreso', p['loaded']))",
      "print(r['size'])",
    ].join('\n'), false, { k: 'v' });
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.logs, ['texto v', 'iPhone 0.5', "bytes b'texto'", 'progreso 5', '10']);
  },
  async 'pull and push copy files'() {
    files['datos.csv'] = 'a,b\n1,2\n';
    const r = await run('c', "import scriptor\np = await scriptor.pull('datos.csv')\nprint(p, open(p).read().splitlines()[1])\nopen('/home/pyodide/out.txt', 'w').write('fin')\nprint(await scriptor.push('/home/pyodide/out.txt'))");
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.logs, ['/home/pyodide/datos.csv 1,2', 'out.txt']);
    assert.equal(files['out.txt'], 'fin');
  },
  async 'errors show the script line only'() {
    const r = await run('d', 'x = 1\nprint(undefined_name)');
    assert.match(r.error, /File "d\.py", line 2/);
    assert.match(r.error, /NameError/);
    assert.doesNotMatch(r.error, /\/lib\//);
    const api = await run('e', 'from scriptor import Nope\nawait Nope.thing()');
    assert.match(api.error, /Nope\.thing no existe en Scriptor/);
  },
  async 'terminal lines keep names and print expressions'() {
    await run('t1', 'x = 21', true);
    const r = await run('t2', 'x * 2', true);
    assert.deepEqual(r.logs, []);
    const s = await run('t3', 'y = 3', true);
    assert.equal(s.error, undefined);
    // Each terminal line is its own run id, but a session keeps its names.
    const same = await run('t4', '_scriptor = __import__("_scriptor")\nawait _scriptor._line("sesion", "z = 5")\nawait _scriptor._line("sesion", "z + 1")');
    assert.deepEqual(same.logs, ['6']);
  },
  async 'pip lists packages'() {
    const r = await run('p', 'import _scriptor\nawait _scriptor._pip(["list"])');
    assert.equal(r.error, undefined, r.error);
    assert.ok(r.logs.some((l) => l.startsWith('micropip')), r.logs.join('\n'));
  },
  async 'imports load packages from the distribution'() {
    const r = await run('n', 'import numpy as np\nprint(int(np.arange(5).sum()))');
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.logs, ['10']);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log('ok  ', name);
  } catch (e) {
    failed++;
    console.log('FAIL', name, '\n    ', e.message);
  }
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
