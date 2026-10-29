// Runs prelude.js in Node with a fake __native bridge to catch JS mistakes before an iOS build.
// Usage: node scripts/test-prelude.mjs
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { preludeSource } from './prelude-source.mjs';

const prelude = preludeSource();
const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptor-'));
const resolve = (p) => (p.startsWith('/') || /^[A-Za-z]:/.test(p) ? p : path.join(docs, p));
const u8 = (b) => new CtxUint8Array(b);

const logs = [];
const timers = new Map();
let finished = null;

const sync = {
  'console.write': (level, msg) => logs.push([level, msg]),
  'timer.set': (id, ms, repeat) => {
    const fire = () => ctx.__fireTimer(id);
    timers.set(id, repeat ? setInterval(fire, ms) : setTimeout(() => { timers.delete(id); fire(); }, ms));
  },
  'timer.clear': (id) => { clearTimeout(timers.get(id)); clearInterval(timers.get(id)); timers.delete(id); },
  'script.info': () => ({ name: 'test.js', input: { hello: 1 }, documents: docs }),
  'script.complete': () => {},
  'text.encode': (s) => u8(Buffer.from(s, 'utf8')),
  'text.decode': (b) => Buffer.from(b).toString('utf8'),
  'base64.encode': (d) => Buffer.from(typeof d === 'string' ? Buffer.from(d) : d).toString('base64'),
  'base64.decode': (s) => u8(Buffer.from(s, 'base64')),
  'url.parse': (input, base) => {
    const x = new URL(input, base);
    return { protocol: x.protocol, username: x.username, password: x.password, hostname: x.hostname, port: x.port, pathname: x.pathname, search: x.search, hash: x.hash };
  },
  'crypto.uuid': () => randomUUID(),
  'crypto.random': (n) => u8(Buffer.alloc(n, 7)),
  'crypto.digest': (alg, data) => u8(createHash(alg).update(typeof data === 'string' ? data : Buffer.from(data)).digest()),
  'fs.dirs': () => ({ documents: docs, cache: path.join(docs, '.cache'), temp: os.tmpdir(), library: docs }),
  'fs.exists': (p) => fs.existsSync(resolve(p)),
  'fs.isDir': (p) => fs.existsSync(resolve(p)) && fs.statSync(resolve(p)).isDirectory(),
  'fs.readText': (p) => fs.readFileSync(resolve(p), 'utf8'),
  'fs.readBytes': (p) => u8(fs.readFileSync(resolve(p))),
  'fs.write': (p, d) => { fs.mkdirSync(path.dirname(resolve(p)), { recursive: true }); fs.writeFileSync(resolve(p), typeof d === 'string' ? d : Buffer.from(d)); return resolve(p); },
  'fs.mkdir': (p) => fs.mkdirSync(resolve(p), { recursive: true }),
  'fs.stat': (p) => { const st = fs.statSync(resolve(p)); return { size: st.size, created: st.birthtimeMs, modified: st.mtimeMs, type: 'public.data' }; },
  'fs.tempPath': (ext) => path.join(docs, 'tmp-' + randomUUID() + '.' + ext),
  'image.info': () => ({ width: 4, height: 2 }),
  'device.info': () => ({ darkMode: false, orientation: 1, screen: { width: 390, height: 844, scale: 3 }, languages: ['es-ES'], locale: 'es_ES' }),
  'xml.parse': () => ({ ok: true, events: [['s', 'a', { k: 'v' }], ['c', 'hi'], ['e', 'a']] }),
  'draw.render': (spec) => { lastDraw = spec; return { path: '/tmp/x.png', width: spec.width, height: spec.height }; },
  'web.create': () => 1,
  'web.setFilter': () => {},
  'web.decide': (view, id, allow) => decided.push([view, id, allow]),
  'nview.update': (id, tree) => viewTrees.push(tree),
  'nview.close': () => {},
};
const viewTrees = [];
// Taps sent to the next UI.view while it is presented, then it closes.
let viewEvents = [];
const decided = [];
let lastDraw = null;
let lastHTML = null;
let lastAlert = null;
const asyncMocks = {
  'ui.alert': (args) => { lastAlert = args; return { index: 1, values: ['typed'] }; },
  'web.loadHTML': (args) => { lastHTML = args[1]; return null; },
  'web.present': () => null,
  'video.play': (args) => ({ source: args[0], loop: args[1].loop, position: 3, duration: 10, ended: false }),
};

const ctx = vm.createContext({});
const CtxUint8Array = vm.runInContext('Uint8Array', ctx);
const CtxError = vm.runInContext('Error', ctx);
ctx.__native = {
  callSync(name, args) {
    const fn = sync[name];
    if (!fn) throw new CtxError('unmocked ' + name);
    try {
      return fn(...args);
    } catch (e) {
      throw new CtxError(`${name}: ${e.message}`);
    }
  },
  callAsync(name, args, id) {
    if (name === 'net.fetch') {
      const [url, opts, body] = args;
      setTimeout(() => ctx.__resolve(id, {
        status: 200, statusText: 'OK', url, headers: { 'content-type': 'application/json' }, rawHeaders: { 'Content-Type': 'application/json' },
        body: u8(Buffer.from(JSON.stringify({ url, method: opts.method, headers: opts.headers, body: body === undefined ? null : Buffer.from(body).toString() }))),
      }), 1);
    } else if (name === 'nview.present') {
      viewTrees.length = 0;
      viewTrees.push(args[0]);
      const events = viewEvents;
      setTimeout(async () => {
        for (const [i, e] of events.entries()) {
          ctx.__emit(id, { ...e, seq: i + 1 });
          await new Promise((r) => setTimeout(r, 2));
        }
        ctx.__resolve(id, null);
      }, 1);
    } else if (asyncMocks[name]) {
      setTimeout(() => ctx.__resolve(id, asyncMocks[name](args)), 1);
    } else {
      setTimeout(() => ctx.__reject(id, 'unmocked ' + name), 1);
    }
  },
  mainDone(ok, value) { finished = { ok, value }; },
};
vm.runInContext(prelude, ctx, { filename: 'prelude.js' });

async function run(name, source) {
  finished = null;
  logs.length = 0;
  vm.runInContext('__runMain(async function main() {' + source + '\n});', ctx, { filename: name });
  for (let i = 0; i < 200 && !finished; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(finished, `${name} did not finish`);
  assert.equal(finished.ok, true, `${name} failed: ${finished.value}`);
  return finished.value;
}

const tests = {
  'console formats values': async () => {
    await run('console', `console.log('a', 1, {b: [1, 'x', null]}, new Map([[1, 2]]), new Uint8Array([1,2]))`);
    assert.equal(logs[0][1], `a 1 { b: [1, "x", null] } Map(1) {1 => 2} Uint8Array(2) [1, 2]`);
  },
  'timers and sleep': async () => {
    await run('timers', `
      const order = [];
      setTimeout(() => order.push('t2'), 20);
      setTimeout(() => order.push('t1'), 5);
      const id = setInterval(() => { order.push('i'); if (order.filter(x => x === 'i').length === 2) clearInterval(id); }, 3);
      await sleep(40);
      console.log(order.join(','));`);
    assert.match(logs[0][1], /t1/);
    assert.match(logs[0][1], /t2$/);
  },
  'base64, hex, TextEncoder': async () => {
    const v = await run('enc', `
      const bytes = new TextEncoder().encode('héllo');
      if (new TextDecoder().decode(bytes) !== 'héllo') throw new Error('utf8');
      if (atob(btoa('ab\\u00ff')) !== 'ab\\u00ff') throw new Error('atob');
      if (Hex.encode(Hex.decode('00ff10')) !== '00ff10') throw new Error('hex');
      return Base64.decodeText(Base64.encode('hola'));`);
    assert.equal(v, 'hola');
  },
  'URL and URLSearchParams': async () => {
    const v = await run('url', `
      const u = new URL('/path?a=1&b=two+words#x', 'https://user@example.com:8080');
      u.searchParams.append('c', 'é');
      u.searchParams.set('a', '9');
      return [u.href, u.origin, u.searchParams.get('b'), new URLSearchParams({x: 1, y: 'a b'}).toString()].join(' | ');`);
    assert.equal(v, 'https://user@example.com:8080/path?a=9&b=two+words&c=%C3%A9#x | https://example.com:8080 | two words | x=1&y=a+b');
  },
  'crypto hash and digest': async () => {
    const v = await run('crypto', `
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
      return Hex.encode(new Uint8Array(buf)) === Crypto.hash('sha256', 'abc') ? Crypto.hash('sha256', 'abc') : 'mismatch';`);
    assert.equal(v, createHash('sha256').update('abc').digest('hex'));
  },
  'fetch json, form and body': async () => {
    const v = await run('fetch', `
      const fd = new FormData();
      fd.append('name', 'x');
      fd.append('file', new Blob(['data'], { type: 'text/plain' }), 'a.txt');
      const r1 = await fetch('https://api.test/a', { method: 'POST', body: fd });
      const j1 = await r1.json();
      if (!j1.headers['content-type'].startsWith('multipart/form-data; boundary=')) throw new Error('ct');
      if (!j1.body.includes('filename="a.txt"')) throw new Error('multipart');
      const r2 = await fetch('https://api.test/b', { body: new URLSearchParams({ q: 1 }) });
      const j2 = await r2.json();
      return [r1.ok, j2.method, j2.body, r2.headers.get('Content-Type')].join(',');`);
    assert.equal(v, 'true,POST,q=1,application/json');
  },
  'require local modules': async () => {
    fs.mkdirSync(path.join(docs, 'modules', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(docs, 'modules', 'lib', 'index.js'), `const h = require('./helper'); module.exports = { twice: (x) => h.mul(x, 2) };`);
    fs.writeFileSync(path.join(docs, 'modules', 'lib', 'helper.js'), `exports.mul = (a, b) => a * b;`);
    fs.writeFileSync(path.join(docs, 'data.json'), `{"n": 21}`);
    const v = await run('require', `return require('lib').twice(require('data.json').n);`);
    assert.equal(v, '42');
  },
  'errors reject main': async () => {
    finished = null;
    vm.runInContext(`__runMain(async function main() { await sleep(1); null.x; });`, ctx);
    for (let i = 0; i < 100 && !finished; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(finished.ok, false);
    assert.match(finished.value, /TypeError/);
  },
  'script input and structuredClone': async () => {
    const v = await run('misc', `const c = structuredClone({ d: new Date(0), m: new Map([[1, {a: 1}]]) }); return [Script.name, args.hello, c.m.get(1).a, c.d.getTime()].join();`);
    assert.equal(v, 'test,1,1,0');
  },
  'Scriptable FileManager and Data': async () => {
    const v = await run('fm', `
      const fm = FileManager.iCloud();
      const p = fm.joinPath(fm.documentsDirectory(), 'notes/a.txt');
      fm.createDirectory(fm.joinPath(fm.documentsDirectory(), 'notes'), true);
      fm.writeString(p, 'hola');
      fm.write(fm.joinPath(fm.documentsDirectory(), 'b.bin'), Data.fromBase64String('AQID'));
      const bytes = fm.read(fm.joinPath(fm.documentsDirectory(), 'b.bin')).getBytes();
      return [fm.readString(p), fm.fileExists(p), fm.fileName(p), fm.fileName(p, true), fm.fileExtension(p), bytes.join('-'),
        Data.fromString('hi').toBase64String(), Script.name(), args.queryParameters.hello].join('|');`);
    assert.equal(v, 'hola|true|a|a.txt|txt|1-2-3|aGk=|test|1');
  },
  'Scriptable Request': async () => {
    const v = await run('req', `
      const r = new Request('https://api.test/x');
      r.method = 'post';
      r.headers = { 'X-A': '1' };
      r.body = JSON.stringify({ a: 1 });
      const j = await r.loadJSON();
      return [j.method, j.headers['x-a'], j.body, r.response.statusCode, r.response.headers['Content-Type'], r.response.mimeType].join('|');`);
    assert.equal(v, 'POST|1|{"a":1}|200|application/json|application/json');
  },
  'Scriptable Alert and TextField': async () => {
    const v = await run('alert', `
      const a = new Alert();
      a.title = 'T';
      a.addAction('Uno');
      a.addDestructiveAction('Borrar');
      a.addCancelAction('No');
      a.addTextField('nombre', 'x').setEmailAddressKeyboard();
      const i = await a.presentAlert();
      return i + ':' + a.textFieldValue(0);`);
    assert.equal(v, '1:typed');
    assert.equal(lastAlert[2].actions[1].style, 'destructive');
    assert.equal(lastAlert[2].fields[0].keyboard, 'emailAddress');
  },
  'Scriptable Color, Font, DrawContext': async () => {
    const v = await run('draw', `
      const c = new Color('#f80', 0.5);
      const ctx = new DrawContext();
      ctx.size = new Size(10, 20);
      ctx.setFillColor(Color.dynamic(Color.white(), Color.black()));
      ctx.fillRect(new Rect(0, 0, 5, 5));
      const p = new Path(); p.move(new Point(0, 0)); p.addLine(new Point(3, 3));
      ctx.addPath(p); ctx.strokePath();
      ctx.setFont(Font.boldSystemFont(12));
      const img = ctx.getImage();
      return [c.hex, c.alpha, Math.round(c.green * 255), img.size.height, Font.title1()._css()].join('|');`);
    assert.equal(v, 'FF8800|0.5|136|20|400 28px -apple-system, system-ui, sans-serif');
    assert.equal(JSON.stringify(lastDraw.ops[0][1]), JSON.stringify({ light: { hex: 'FFFFFF', alpha: 1 }, dark: { hex: '000000', alpha: 1 } }));
    assert.equal(JSON.stringify(lastDraw.ops[2]), JSON.stringify(['path', [['move', 0, 0], ['line', 3, 3]]]));
  },
  'Scriptable widget preview': async () => {
    await run('widget', `
      const w = new ListWidget();
      w.backgroundColor = new Color('#123456');
      const t = w.addText('Hola <b>');
      t.font = Font.headline();
      t.textColor = Color.red();
      const s = w.addStack();
      s.addDate(new Date(0)).applyTimerStyle();
      w.addSpacer();
      await w.presentMedium();`);
    assert.match(lastHTML, /width:364px;height:170px/);
    assert.match(lastHTML, /Hola &lt;b&gt;/);
    assert.match(lastHTML, /rgba\(18,52,86,1\)/);
    assert.match(lastHTML, /data-style="timer"/);
  },
  'WebView shouldAllowRequest without a pending call': async () => {
    await run('webfilter', `
      const wv = new WebView();
      wv.shouldAllowRequest = (req) => !req.url.startsWith('bridge://');`);
    ctx.__webRequest(1, { id: 7, url: 'bridge://kick/1', method: 'GET', headers: {} });
    ctx.__webRequest(1, { id: 8, url: 'https://example.com/', method: 'GET', headers: {} });
    ctx.__webRequest(99, { id: 9, url: 'https://example.com/', method: 'GET', headers: {} });
    assert.deepEqual(decided, [[1, 7, false], [1, 8, true], [99, 9, true]]);
  },
  'Scriptable XMLParser, Timer, misc': async () => {
    const v = await run('xml', `
      const out = [];
      const p = new XMLParser('<a k="v">hi</a>');
      p.didStartElement = (n, attrs) => out.push('<' + n + attrs.k);
      p.foundCharacters = (s) => out.push(s);
      p.didEndElement = (n) => out.push('/' + n);
      p.didEndDocument = () => out.push('end');
      p.parse();
      let ticks = 0;
      await new Promise((done) => { const t = Timer.schedule(2, true, () => { if (++ticks === 3) { t.invalidate(); done(); } }); });
      Script.setShortcutOutput('salida');
      return out.join(',') + '|' + ticks + '|' + config.runsInApp + '|' + Device.screenResolution().width + '|' + Device.language();
    `);
    assert.equal(v, '<av,hi,/a,end|3|true|1170|es');
  },
  'Video.play': async () => {
    const v = await run('video', `const r = await Video.play('clip.mkv', { loop: true }); return [r.source, r.loop, r.position].join();`);
    assert.equal(v, 'clip.mkv,true,3');
  },
  'WebContent and WebView.onMessage': async () => {
    viewEvents = [];
    const v = await run('webcontent', `
      const web = new WebView();
      const got = [];
      web.onMessage = (m) => got.push(m.tipo + ':' + m.url);
      __webMessage(web._id, { tipo: 'enlace', url: 'https://a.test' });
      const ui = UI.view({}, () => ZStack([WebContent(web).ignoresSafeArea(), Text('encima')]));
      await ui.present();
      return got.join() + '|' + web._id;`);
    const [msgs, id] = v.split('|');
    assert.equal(msgs, 'enlace:https://a.test');
    const tree = JSON.parse(JSON.stringify(viewTrees[0]));
    assert.equal(tree.children[0].type, 'WebView');
    assert.equal(tree.children[0].props.view, Number(id));
  },
  'UI.view tree, events and state': async () => {
    viewEvents = [
      { handler: '0.3:action' },
      { handler: '0.2:onChange', value: true },
      { handler: '0.4:onChange', value: 2 },
      { handler: '0.5:onChange', value: 'hola' },
    ];
    const v = await run('view', `
      const ui = UI.view({ n: 1, on: false, pick: 'b', name: '' }, (s) =>
        VStack({ spacing: 8 }, [
          Text('n=' + s.n).font('title').foregroundStyle(Color.red()),
          s.on ? Text('encendido') : null,
          Toggle('On', s.on, (v) => s.on = v),
          Button({ title: 'Más', systemImage: 'plus' }, () => s.n++).style('glassProminent'),
          Picker('P', s.pick, ['a', 'b', { label: 'C', value: 'c' }], (v) => s.pick = v),
          TextField('Nombre', s.name, (t) => s.name = t),
          UI.Image('star.fill'),
          Slider(2, { min: 0, max: Infinity }),
        ]).padding().glassEffect({ interactive: true, tint: '#FF000080' })
      );
      await ui.present({ title: 'Prueba', background: UI.gradient(['blue', Color.white()]) });
      return JSON.stringify(ui.state);`);
    assert.equal(v, '{"n":2,"on":true,"pick":"c","name":"hola"}');
    // Trees come from the script's realm; compare them as plain JSON.
    const first = JSON.parse(JSON.stringify(viewTrees[0]));
    assert.equal(first.ack, 0);
    assert.deepEqual(first.mods, [['padding', null], ['glassEffect', { interactive: true, tint: '#FF000080' }]]);
    assert.deepEqual(first.children.map((c) => c.key), ['0.0', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7']);
    assert.deepEqual(first.children[0].mods[1], ['foregroundStyle', { hex: 'FF0000', alpha: 1 }]);
    assert.equal(first.children[2].props.action, '0.3:action');
    assert.equal(first.children[3].props.selection, 1);
    assert.equal(first.children[5].props.system, 'star.fill');
    assert.equal(first.children[6].props.max, 'infinity');
    const last = JSON.parse(JSON.stringify(viewTrees[viewTrees.length - 1]));
    assert.equal(last.ack, 4);
    assert.deepEqual(last.children.map((c) => c.key), ['0.0', '0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7']);
    assert.equal(last.children[1].props.text, 'encendido');
    assert.equal(last.children[4].props.selection, 2);
    assert.equal(last.children[5].props.text, 'hola');
    assert.equal(typeof ctx.VStack, 'function');
    assert.equal(ctx.Image.name, 'Image');
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
fs.rmSync(docs, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
