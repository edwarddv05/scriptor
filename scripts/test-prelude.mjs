// Runs prelude.js in Node with a fake __native bridge to catch JS mistakes before an iOS build.
// Usage: node scripts/test-prelude.mjs
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const prelude = fs.readFileSync(path.join(here, '../modules/script-engine/js/prelude.js'), 'utf8');
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
        status: 200, statusText: 'OK', url, headers: { 'content-type': 'application/json' },
        body: u8(Buffer.from(JSON.stringify({ url, method: opts.method, headers: opts.headers, body: body === undefined ? null : Buffer.from(body).toString() }))),
      }), 1);
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
    assert.equal(v, 'test.js,1,1,0');
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
