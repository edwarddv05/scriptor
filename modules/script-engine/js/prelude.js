// Runtime that every script gets before its own code runs.
// It is compiled into Prelude.swift by scripts/gen-prelude.mjs: edit this file, not the Swift one.
(function (global) {
  'use strict';
  const native = global.__native;
  const callSync = (name, ...args) => native.callSync(name, args.map(toNative));
  let nextCallId = 1;
  const calls = new Map();

  // Typed arrays cross the bridge as Uint8Array views starting at offset 0.
  // Data and Image objects cross as their bytes / file path.
  function toNative(v) {
    if (v && typeof v.__nativeValue === 'function') return toNative(v.__nativeValue());
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) {
      const u = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      return u.byteOffset === 0 && u.byteLength === u.buffer.byteLength ? u : u.slice();
    }
    return v;
  }

  function callAsync(name, args, onEvent) {
    return new Promise((resolve, reject) => {
      const id = nextCallId++;
      calls.set(id, { resolve, reject, onEvent });
      native.callAsync(name, args.map(toNative), id);
    });
  }

  /** Like callAsync but also returns the call id (for cancel / socket send). */
  function callAsyncWithId(name, args, onEvent) {
    const id = nextCallId;
    return { id, promise: callAsync(name, args, onEvent) };
  }

  global.__resolve = (id, value) => {
    const c = calls.get(id);
    if (c) { calls.delete(id); c.resolve(value); }
  };
  global.__reject = (id, message) => {
    const c = calls.get(id);
    if (c) { calls.delete(id); c.reject(new Error(message)); }
  };
  global.__emit = (id, value) => {
    const c = calls.get(id);
    if (c && c.onEvent) {
      try { c.onEvent(value); } catch (e) { console.error(e); }
    }
  };

  // ---------------------------------------------------------------- console

  function inspect(value, depth = 0, seen = new Set()) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    const t = typeof value;
    if (t === 'string') return depth === 0 ? value : JSON.stringify(value);
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
    if (t === 'symbol') return value.toString();
    if (t === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (value instanceof Error) return value.stack ? `${value.name}: ${value.message}\n${value.stack}` : `${value.name}: ${value.message}`;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (ArrayBuffer.isView(value)) {
      const head = Array.from(value.slice(0, 32)).join(', ');
      return `${value.constructor.name}(${value.length}) [${head}${value.length > 32 ? ', …' : ''}]`;
    }
    if (seen.has(value)) return '[Circular]';
    if (depth > 4) return Array.isArray(value) ? '[Array]' : '[Object]';
    seen.add(value);
    let out;
    if (Array.isArray(value)) {
      const items = value.slice(0, 100).map((v) => inspect(v, depth + 1, seen));
      if (value.length > 100) items.push(`… ${value.length - 100} more`);
      out = `[${items.join(', ')}]`;
    } else if (value instanceof Map) {
      out = `Map(${value.size}) {${[...value].map(([k, v]) => `${inspect(k, depth + 1, seen)} => ${inspect(v, depth + 1, seen)}`).join(', ')}}`;
    } else if (value instanceof Set) {
      out = `Set(${value.size}) {${[...value].map((v) => inspect(v, depth + 1, seen)).join(', ')}}`;
    } else {
      const name = value.constructor && value.constructor !== Object ? value.constructor.name + ' ' : '';
      const entries = Object.keys(value).map((k) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${inspect(value[k], depth + 1, seen)}`);
      out = entries.length ? `${name}{ ${entries.join(', ')} }` : `${name}{}`;
    }
    seen.delete(value);
    return out;
  }

  const write = (level) => (...args) => callSync('console.write', level, args.map((a) => inspect(a)).join(' '));
  const timers = new Map();
  global.console = {
    log: write('log'),
    info: write('info'),
    debug: write('debug'),
    warn: write('warn'),
    error: write('error'),
    table: (data) => write('log')(inspect(data)),
    time: (label = 'default') => timers.set(label, Date.now()),
    timeEnd: (label = 'default') => {
      const start = timers.get(label);
      if (start !== undefined) { timers.delete(label); write('log')(`${label}: ${Date.now() - start} ms`); }
    },
    assert: (cond, ...args) => { if (!cond) write('error')('Assertion failed', ...args); },
  };
  global.__onUnhandledRejection = (_promise, reason) => {
    write('warn')('Unhandled promise rejection:', reason);
  };

  // ----------------------------------------------------------------- timers

  let nextTimer = 1;
  const timerCallbacks = new Map();
  function addTimer(fn, ms, repeat, args) {
    if (typeof fn !== 'function') throw new TypeError('Callback must be a function');
    const id = nextTimer++;
    timerCallbacks.set(id, { fn, args, repeat });
    callSync('timer.set', id, Number(ms) || 0, repeat);
    return id;
  }
  function clearTimer(id) {
    if (timerCallbacks.delete(id)) callSync('timer.clear', id);
  }
  global.__fireTimer = (id) => {
    const t = timerCallbacks.get(id);
    if (!t) return;
    if (!t.repeat) timerCallbacks.delete(id);
    t.fn(...t.args);
  };
  global.setTimeout = (fn, ms, ...args) => addTimer(fn, ms, false, args);
  global.setInterval = (fn, ms, ...args) => addTimer(fn, ms, true, args);
  global.clearTimeout = clearTimer;
  global.clearInterval = clearTimer;
  global.queueMicrotask = (fn) => Promise.resolve().then(fn);
  global.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------- encoding / base64

  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(text = '') { return callSync('text.encode', String(text)); }
  }
  class TextDecoder {
    constructor(label = 'utf-8') {
      if (!/^utf-?8$/i.test(label)) throw new RangeError('Only utf-8 is supported');
    }
    get encoding() { return 'utf-8'; }
    decode(bytes) { return bytes === undefined ? '' : callSync('text.decode', bytes); }
  }
  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder;

  // atob/btoa work on "binary strings" (one char per byte), as in browsers.
  global.btoa = (s) => {
    s = String(s);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c > 255) throw new Error('btoa: character out of range');
      bytes[i] = c;
    }
    return callSync('base64.encode', bytes);
  };
  global.atob = (b64) => {
    const bytes = callSync('base64.decode', String(b64));
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return s;
  };

  const Base64 = {
    encode: (data) => callSync('base64.encode', typeof data === 'string' ? data : toNative(data)),
    decode: (text) => callSync('base64.decode', text),
    decodeText: (text) => callSync('text.decode', callSync('base64.decode', text)),
  };
  const Hex = {
    encode: (bytes) => Array.from(toNative(bytes), (b) => b.toString(16).padStart(2, '0')).join(''),
    decode: (hex) => {
      const out = new Uint8Array(hex.length >> 1);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
      return out;
    },
  };
  global.Base64 = Base64;
  global.Hex = Hex;

  if (typeof global.structuredClone !== 'function') {
    global.structuredClone = function clone(v, seen = new Map()) {
      if (v === null || typeof v !== 'object') return v;
      if (seen.has(v)) return seen.get(v);
      if (v instanceof Date) return new Date(v.getTime());
      if (v instanceof RegExp) return new RegExp(v.source, v.flags);
      if (ArrayBuffer.isView(v)) return v.slice();
      if (v instanceof ArrayBuffer) return v.slice(0);
      if (v instanceof Map) { const m = new Map(); seen.set(v, m); v.forEach((x, k) => m.set(clone(k, seen), clone(x, seen))); return m; }
      if (v instanceof Set) { const s = new Set(); seen.set(v, s); v.forEach((x) => s.add(clone(x, seen))); return s; }
      const out = Array.isArray(v) ? [] : {};
      seen.set(v, out);
      for (const k of Object.keys(v)) out[k] = clone(v[k], seen);
      return out;
    };
  }

  // ------------------------------------------------------ URL & params

  class URLSearchParams {
    constructor(init = '') {
      this._list = [];
      if (typeof init === 'string') {
        init = init.replace(/^\?/, '');
        if (init) {
          for (const part of init.split('&')) {
            if (!part) continue;
            const i = part.indexOf('=');
            const dec = (s) => decodeURIComponent(s.replace(/\+/g, ' '));
            this._list.push(i < 0 ? [dec(part), ''] : [dec(part.slice(0, i)), dec(part.slice(i + 1))]);
          }
        }
      } else if (init instanceof URLSearchParams) {
        this._list = init._list.map((p) => [...p]);
      } else if (Array.isArray(init)) {
        this._list = init.map(([k, v]) => [String(k), String(v)]);
      } else if (init && typeof init === 'object') {
        this._list = Object.entries(init).map(([k, v]) => [k, String(v)]);
      }
    }
    append(k, v) { this._list.push([String(k), String(v)]); this._changed(); }
    delete(k) { this._list = this._list.filter((p) => p[0] !== k); this._changed(); }
    get(k) { const p = this._list.find((p) => p[0] === k); return p ? p[1] : null; }
    getAll(k) { return this._list.filter((p) => p[0] === k).map((p) => p[1]); }
    has(k) { return this._list.some((p) => p[0] === k); }
    set(k, v) {
      const i = this._list.findIndex((p) => p[0] === k);
      if (i < 0) this._list.push([String(k), String(v)]);
      else { this._list[i][1] = String(v); this._list = this._list.filter((p, j) => j <= i || p[0] !== k); }
      this._changed();
    }
    sort() { this._list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); this._changed(); }
    forEach(fn, thisArg) { this._list.forEach(([k, v]) => fn.call(thisArg, v, k, this)); }
    keys() { return this._list.map((p) => p[0])[Symbol.iterator](); }
    values() { return this._list.map((p) => p[1])[Symbol.iterator](); }
    entries() { return this._list.map((p) => [...p])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    get size() { return this._list.length; }
    toString() {
      const enc = (s) => encodeURIComponent(s).replace(/%20/g, '+');
      return this._list.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
    }
    _changed() { if (this._url) this._url._search = this._list.length ? '?' + this.toString() : ''; }
  }

  class URL {
    constructor(input, base) {
      const p = callSync('url.parse', String(input), base === undefined ? undefined : String(base));
      this.protocol = p.protocol;
      this.username = p.username;
      this.password = p.password;
      this.hostname = p.hostname;
      this.port = p.port;
      this.pathname = p.pathname;
      this._search = p.search;
      this.hash = p.hash;
    }
    get search() { return this._search; }
    set search(v) { v = String(v); this._search = v && !v.startsWith('?') ? '?' + v : v; this._params = null; }
    get searchParams() {
      if (!this._params) { this._params = new URLSearchParams(this._search); this._params._url = this; }
      return this._params;
    }
    get host() { return this.hostname + (this.port ? ':' + this.port : ''); }
    get origin() { return `${this.protocol}//${this.host}`; }
    get href() {
      const auth = this.username ? this.username + (this.password ? ':' + this.password : '') + '@' : '';
      return `${this.protocol}//${auth}${this.host}${this.pathname}${this._search}${this.hash}`;
    }
    toString() { return this.href; }
    toJSON() { return this.href; }
    static canParse(input, base) { try { new URL(input, base); return true; } catch { return false; } }
  }
  global.URL = URL;
  global.URLSearchParams = URLSearchParams;

  // ----------------------------------------------------------------- crypto

  const subtleNames = { 'SHA-1': 'sha1', 'SHA-256': 'sha256', 'SHA-384': 'sha384', 'SHA-512': 'sha512' };
  const algName = (a) => {
    const n = typeof a === 'string' ? a : a && a.name;
    return subtleNames[String(n).toUpperCase()] || String(n);
  };
  const encodeOut = (bytes, enc) => (enc === 'hex' ? Hex.encode(bytes) : enc === 'base64' ? Base64.encode(bytes) : bytes);
  global.crypto = {
    getRandomValues(arr) {
      const bytes = callSync('crypto.random', arr.byteLength);
      new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).set(bytes);
      return arr;
    },
    randomUUID: () => callSync('crypto.uuid'),
    subtle: {
      async digest(alg, data) {
        const out = callSync('crypto.digest', algName(alg), data);
        return out.buffer;
      },
    },
  };
  global.Crypto = {
    hash: (alg, data, enc = 'hex') => encodeOut(callSync('crypto.digest', algName(alg), data), enc),
    hmac: (alg, key, data, enc = 'hex') => encodeOut(callSync('crypto.hmac', algName(alg), key, data), enc),
    randomBytes: (n) => callSync('crypto.random', n),
    uuid: () => callSync('crypto.uuid'),
    /** AES-GCM. key: 16/24/32 bytes. Returns nonce + ciphertext + tag. */
    encrypt: (key, data) => callSync('crypto.aesEncrypt', key, data),
    decrypt: (key, data) => callSync('crypto.aesDecrypt', key, data),
  };

  // ------------------------------------------------------------- networking

  class Headers {
    constructor(init) {
      this._map = new Map();
      if (init instanceof Headers) init.forEach((v, k) => this.set(k, v));
      else if (Array.isArray(init)) init.forEach(([k, v]) => this.append(k, v));
      else if (init) Object.entries(init).forEach(([k, v]) => this.set(k, v));
    }
    append(k, v) { k = k.toLowerCase(); const cur = this._map.get(k); this._map.set(k, cur ? cur + ', ' + v : String(v)); }
    set(k, v) { this._map.set(k.toLowerCase(), String(v)); }
    get(k) { const v = this._map.get(k.toLowerCase()); return v === undefined ? null : v; }
    has(k) { return this._map.has(k.toLowerCase()); }
    delete(k) { this._map.delete(k.toLowerCase()); }
    forEach(fn, thisArg) { this._map.forEach((v, k) => fn.call(thisArg, v, k, this)); }
    keys() { return this._map.keys(); }
    values() { return this._map.values(); }
    entries() { return this._map.entries(); }
    [Symbol.iterator]() { return this._map.entries(); }
    toObject() { return Object.fromEntries(this._map); }
  }

  class Blob {
    constructor(parts = [], opts = {}) {
      const chunks = parts.map((p) => (typeof p === 'string' ? new TextEncoder().encode(p) : p instanceof Blob ? p._bytes : toNative(p)));
      const size = chunks.reduce((n, c) => n + c.length, 0);
      this._bytes = new Uint8Array(size);
      let off = 0;
      for (const c of chunks) { this._bytes.set(c, off); off += c.length; }
      this.type = opts.type || '';
    }
    get size() { return this._bytes.length; }
    async arrayBuffer() { return this._bytes.slice().buffer; }
    async bytes() { return this._bytes.slice(); }
    async text() { return new TextDecoder().decode(this._bytes); }
    slice(start, end, type) { const b = new Blob([], { type }); b._bytes = this._bytes.slice(start, end); return b; }
  }
  class File extends Blob {
    constructor(parts, name, opts = {}) { super(parts, opts); this.name = name; this.lastModified = Date.now(); }
  }
  global.Blob = Blob;
  global.File = File;

  class FormData {
    constructor() { this._list = []; }
    append(name, value, filename) {
      if (value instanceof Blob) this._list.push([name, value, filename || value.name || 'blob']);
      else this._list.push([name, String(value)]);
    }
    /** Adds a file from disk by path. */
    appendFile(name, path, filename, type) {
      const bytes = FS.readBytes(path);
      this.append(name, new File([bytes], filename || path.split('/').pop(), { type: type || 'application/octet-stream' }), filename);
    }
    set(name, value, filename) { this.delete(name); this.append(name, value, filename); }
    get(name) { const e = this._list.find((e) => e[0] === name); return e ? e[1] : null; }
    getAll(name) { return this._list.filter((e) => e[0] === name).map((e) => e[1]); }
    has(name) { return this._list.some((e) => e[0] === name); }
    delete(name) { this._list = this._list.filter((e) => e[0] !== name); }
    entries() { return this._list.map((e) => [e[0], e[1]])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    _encode() {
      const boundary = '----scriptor' + callSync('crypto.uuid').replace(/-/g, '');
      const enc = new TextEncoder();
      const parts = [];
      for (const [name, value, filename] of this._list) {
        let head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
        if (value instanceof Blob) {
          head += `; filename="${filename}"\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`;
          parts.push(enc.encode(head), value._bytes, enc.encode('\r\n'));
        } else {
          parts.push(enc.encode(head + '\r\n\r\n' + value + '\r\n'));
        }
      }
      parts.push(enc.encode(`--${boundary}--\r\n`));
      return { body: new Blob(parts)._bytes, type: `multipart/form-data; boundary=${boundary}` };
    }
  }
  global.FormData = FormData;

  class AbortSignal {
    constructor() { this.aborted = false; this.reason = undefined; this._listeners = []; this.onabort = null; }
    addEventListener(type, fn) { if (type === 'abort') this._listeners.push(fn); }
    removeEventListener(type, fn) { this._listeners = this._listeners.filter((f) => f !== fn); }
    throwIfAborted() { if (this.aborted) throw this.reason; }
    _abort(reason) {
      if (this.aborted) return;
      this.aborted = true;
      this.reason = reason === undefined ? new Error('The operation was aborted') : reason;
      if (this.onabort) this.onabort({ type: 'abort' });
      this._listeners.forEach((fn) => fn({ type: 'abort' }));
    }
    static timeout(ms) { const c = new AbortController(); setTimeout(() => c.abort(new Error('Timeout')), ms); return c.signal; }
  }
  class AbortController {
    constructor() { this.signal = new AbortSignal(); }
    abort(reason) { this.signal._abort(reason); }
  }
  global.AbortController = AbortController;
  global.AbortSignal = AbortSignal;

  class Response {
    constructor(body, init = {}) {
      this._bytes = body instanceof Uint8Array ? body : typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(0);
      this.status = init.status === undefined ? 200 : init.status;
      this.statusText = init.statusText || '';
      this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
      this.url = init.url || '';
      this.redirected = false;
      this.bodyUsed = false;
    }
    get ok() { return this.status >= 200 && this.status < 300; }
    _use() { if (this.bodyUsed) throw new TypeError('Body already used'); this.bodyUsed = true; return this._bytes; }
    async text() { return new TextDecoder().decode(this._use()); }
    async json() { return JSON.parse(await this.text()); }
    async arrayBuffer() { return this._use().slice().buffer; }
    async bytes() { return this._use(); }
    async blob() { return new Blob([this._use()], { type: this.headers.get('content-type') || '' }); }
    clone() { const r = new Response(this._bytes, this); r.url = this.url; return r; }
  }
  global.Response = Response;
  global.Headers = Headers;

  function prepareBody(body, headers) {
    if (body === undefined || body === null) return undefined;
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
      return body.toString();
    }
    if (body instanceof FormData) {
      const { body: bytes, type } = body._encode();
      headers.set('content-type', type);
      return bytes;
    }
    if (body instanceof Blob) {
      if (body.type && !headers.has('content-type')) headers.set('content-type', body.type);
      return body._bytes;
    }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return toNative(body);
    throw new TypeError('Unsupported body type; use JSON.stringify for objects');
  }

  global.fetch = function fetch(input, init = {}) {
    const url = input instanceof URL ? input.href : typeof input === 'object' && input.url ? input.url : String(input);
    const headers = new Headers(init.headers);
    const body = prepareBody(init.body, headers);
    const method = (init.method || (body !== undefined ? 'POST' : 'GET')).toUpperCase();
    const opts = { method, headers: headers.toObject(), redirect: init.redirect, cache: init.cache };
    if (init.timeout) opts.timeout = init.timeout / 1000;
    const onEvent = (e) => { if (e.type === 'progress' && init.onProgress) init.onProgress(e); };
    const { id, promise } = callAsyncWithId('net.fetch', [url, opts, body], onEvent);
    const signal = init.signal;
    if (signal) {
      if (signal.aborted) callSync('net.cancel', id);
      else signal.addEventListener('abort', () => callSync('net.cancel', id));
    }
    return promise.then(
      (r) => new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers, url: r.url }),
      (err) => { throw signal && signal.aborted ? signal.reason : new TypeError('fetch failed: ' + err.message); }
    );
  };

  function transferOpts(init = {}) {
    const headers = new Headers(init.headers);
    const opts = { method: init.method, headers: headers.toObject() };
    if (init.timeout) opts.timeout = init.timeout / 1000;
    return opts;
  }

  global.Net = {
    /** Streams a URL to disk. Memory stays flat even for multi-GB files. */
    download(url, dest, init = {}) {
      if (typeof dest === 'object' && dest !== null) { init = dest; dest = undefined; }
      const onEvent = (e) => { if (init.onProgress) init.onProgress(e); };
      const { id, promise } = callAsyncWithId('net.download', [String(url), dest, transferOpts(init)], onEvent);
      if (init.signal) init.signal.addEventListener('abort', () => callSync('net.cancel', id));
      return promise;
    },
    /** Cookies the in-app web views keep for a domain (and its subdomains): a sign-in done in a WebView. */
    webCookies: (domain) => callAsync('net.webCookies', [domain == null ? null : String(domain)]),
    /** Signs the web views out of a domain, or out of everything without one. Resolves with how many were removed. */
    clearWebCookies: (domain) => callAsync('net.clearWebCookies', [domain == null ? null : String(domain)]),
    /** Streams a file from disk as the request body. */
    async upload(url, path, init = {}) {
      const onEvent = (e) => { if (init.onProgress) init.onProgress(e); };
      const r = await callAsync('net.upload', [String(url), path, transferOpts({ method: 'POST', ...init })], onEvent);
      return new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers, url: r.url });
    },
    /**
     * An HTTP server on `port` (8080; 0 picks a free one) that answers with `handler(request)`.
     * Only this iPhone reaches it unless `lan: true`. The promise settles when it stops: with
     * Net.stopServer(port), options.signal, or the end of the script.
     */
    serve(port, handler, options = {}) {
      if (typeof port === 'function') { options = handler || {}; handler = port; port = 8080; }
      if (typeof handler !== 'function') throw new Error('Net.serve necesita una función que responda cada petición.');
      let actualPort = null;
      const { id, promise } = callAsyncWithId('server.start', [Number(port), { lan: options.lan === true }], (e) => {
        if (e.type === 'start') {
          actualPort = e.port;
          servers.set(e.port, id);
          if (options.onStart) options.onStart({ port: e.port, url: e.url, addresses: e.addresses || [] });
        } else if (e.type === 'request') {
          answer(id, e, handler);
        }
      });
      if (options.signal) options.signal.addEventListener('abort', () => callSync('server.stop', id));
      const forget = () => { if (actualPort !== null) servers.delete(actualPort); };
      return promise.then((value) => { forget(); return value; }, (error) => { forget(); throw error; });
    },
    /** Stops the server on `port`, or every server of this script without one. */
    stopServer(port) {
      for (const [p, id] of [...servers]) if (port == null || p === Number(port)) callSync('server.stop', id);
    },
  };

  // Servers this script has open: port -> call id.
  const servers = new Map();

  function answer(serverId, e, handler) {
    const request = {
      method: e.method, url: e.url, path: e.path, query: e.query, headers: e.headers, address: e.address,
      body: e.body, text: new TextDecoder().decode(e.body),
    };
    const reply = (status, headers, body, file) => callSync('server.respond', serverId, e.id, status, headers, body, file);
    Promise.resolve()
      .then(() => handler(request))
      .then((res) => {
        if (res === undefined || res === null) return reply(404, { 'content-type': 'text/plain; charset=utf-8' }, 'No encontrado', null);
        if (typeof res === 'string') {
          const html = /^\s*</.test(res);
          return reply(200, { 'content-type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' }, res, null);
        }
        if (res instanceof ArrayBuffer || ArrayBuffer.isView(res)) return reply(200, { 'content-type': 'application/octet-stream' }, toNative(res), null);
        // { status, headers, body, file } is a response; any other object or array goes out as JSON.
        const isResponse = typeof res === 'object' && !Array.isArray(res) && ['status', 'headers', 'body', 'file'].some((key) => key in res);
        if (!isResponse) return reply(200, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify(res), null);
        const headers = {};
        for (const [name, value] of Object.entries(res.headers || {})) headers[name.toLowerCase()] = String(value);
        let body = res.body;
        if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof ArrayBuffer || ArrayBuffer.isView(body))) {
          body = JSON.stringify(body);
          if (!headers['content-type']) headers['content-type'] = 'application/json; charset=utf-8';
        }
        if (typeof body === 'string' && !headers['content-type']) headers['content-type'] = /^\s*</.test(body) ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
        return reply(Number(res.status) || 200, headers, body === undefined || body === null ? null : toNative(body), res.file ? String(res.file) : null);
      })
      .catch((err) => {
        console.error(`Net.serve ${e.method} ${e.url}: ${err instanceof Error ? err.message : inspect(err)}`);
        reply(500, { 'content-type': 'text/plain; charset=utf-8' }, 'Error del script: ' + (err instanceof Error ? err.message : inspect(err)), null);
      });
  }

  class WebSocket {
    constructor(url, protocols = []) {
      this.url = String(url);
      this.readyState = WebSocket.CONNECTING;
      this.protocol = '';
      this.binaryType = 'arraybuffer';
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this._listeners = {};
      const list = Array.isArray(protocols) ? protocols : [protocols];
      const { id, promise } = callAsyncWithId('ws.connect', [this.url, list], (e) => {
        if (e.type === 'open') {
          this.readyState = WebSocket.OPEN;
          this.protocol = e.protocol;
          this._dispatch('open', { type: 'open' });
        } else if (e.type === 'message') {
          let data = e.data;
          if (data instanceof Uint8Array && this.binaryType === 'arraybuffer') data = data.buffer;
          this._dispatch('message', { type: 'message', data });
        }
      });
      this._id = id;
      promise.then((r) => {
        this.readyState = WebSocket.CLOSED;
        if (r.error) this._dispatch('error', { type: 'error', message: r.error });
        this._dispatch('close', { type: 'close', code: r.code, reason: r.reason, wasClean: !r.error });
      }, (err) => {
        this.readyState = WebSocket.CLOSED;
        this._dispatch('error', { type: 'error', message: err.message });
        this._dispatch('close', { type: 'close', code: 1006, reason: err.message, wasClean: false });
      });
    }
    send(data) {
      if (this.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open');
      callSync('ws.send', this._id, typeof data === 'string' ? data : toNative(data));
    }
    close(code = 1000, reason = '') {
      if (this.readyState >= WebSocket.CLOSING) return;
      this.readyState = WebSocket.CLOSING;
      callSync('ws.close', this._id, code, reason);
    }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }
    _dispatch(type, event) {
      const handler = this['on' + type];
      if (handler) handler.call(this, event);
      (this._listeners[type] || []).forEach((fn) => fn.call(this, event));
    }
  }
  WebSocket.CONNECTING = 0;
  WebSocket.OPEN = 1;
  WebSocket.CLOSING = 2;
  WebSocket.CLOSED = 3;
  global.WebSocket = WebSocket;

  // ------------------------------------------------------------------- files

  const dirs = callSync('fs.dirs');
  const FS = {
    documents: dirs.documents,
    cache: dirs.cache,
    temp: dirs.temp,
    library: dirs.library,
    join: (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/'),
    readText: (path) => callSync('fs.readText', path),
    readJSON: (path) => JSON.parse(callSync('fs.readText', path)),
    /** Whole file, or a slice with (path, offset, length) without loading the rest. */
    readBytes: (path, offset, length) =>
      offset === undefined ? callSync('fs.readBytes', path) : callSync('fs.readBytes', path, offset, length === undefined ? 2147483647 : length),
    writeText: (path, text) => callSync('fs.write', path, String(text)),
    writeJSON: (path, value) => callSync('fs.write', path, JSON.stringify(value, null, 2)),
    writeBytes: (path, bytes) => callSync('fs.write', path, toNative(bytes)),
    appendText: (path, text) => callSync('fs.append', path, String(text)),
    appendBytes: (path, bytes) => callSync('fs.append', path, toNative(bytes)),
    exists: (path) => callSync('fs.exists', path),
    isDir: (path) => callSync('fs.isDir', path),
    list: (path) => callSync('fs.list', path),
    stat: (path) => callSync('fs.stat', path),
    mkdir: (path) => callSync('fs.mkdir', path),
    remove: (path) => callSync('fs.remove', path),
    move: (from, to) => callSync('fs.move', from, to),
    copy: (from, to) => callSync('fs.copy', from, to),
    zip: (path, dest) => callAsync('fs.zip', [path, dest]),
    pickFiles: (opts = {}) => callAsync('fs.pickFiles', [opts]),
    pickFile: async (opts = {}) => (await callAsync('fs.pickFiles', [{ ...opts, multiple: false }]))[0] || null,
    /** Asks for a folder anywhere in Files and remembers it under `name` for later runs. */
    pickFolder: (name) => callAsync('fs.pickFolder', [name]),
    bookmark: (name) => callSync('fs.bookmark', name),
    bookmarks: () => callSync('fs.bookmarks'),
    removeBookmark: (name) => callSync('fs.removeBookmark', name),
    exportFile: (paths) => callAsync('fs.export', [paths]),
  };
  global.FS = FS;

  // ------------------------------------------------------------------ media

  global.Photos = {
    pick: (opts = {}) => callAsync('photos.pick', [opts]),
    /** Saves an image or a video file to the camera roll. */
    save: (path, opts = {}) => callAsync('photos.save', [path, opts]),
    saveImage: (path, opts) => global.Photos.save(path, opts),
    saveVideo: (path, opts) => global.Photos.save(path, opts),
    albums: () => callAsync('photos.albums', []),
    createAlbum: (title) => callAsync('photos.createAlbum', [title]),
    latest: (opts = {}) => callAsync('photos.latest', [opts]),
    export: (id, dest) => callAsync('photos.export', [id, dest]),
    delete: (ids) => callAsync('photos.delete', [Array.isArray(ids) ? ids : [ids]]),
    metadata: (path) => callSync('photos.metadata', path),
  };

  global.Camera = {
    photo: (opts = {}) => callAsync('camera.capture', [{ ...opts, video: false }]),
    video: (opts = {}) => callAsync('camera.capture', [{ ...opts, video: true }]),
  };

  global.Video = {
    info: (path) => callAsync('video.info', [path]),
    thumbnail: (path, opts = {}) => callAsync('video.thumbnail', [path, opts]),
    /** Compress / trim / re-encode. opts.onProgress receives { progress: 0..1 }. */
    export: (path, opts = {}) => {
      const { onProgress, ...rest } = opts;
      return callAsync('video.export', [path, rest], (e) => { if (onProgress) onProgress(e); });
    },
    extractAudio: (path, dest) => callAsync('video.export', [path, { quality: 'audio', dest }]),
    /** Fullscreen VLC player (AV1, MKV, WebM… on any iPhone). Resolves with { position, duration, ended } when closed. */
    play: (source, opts = {}) => callAsync('video.play', [source, opts]),
  };

  global.Audio = {
    play: (path, opts = {}) => callAsync('audio.play', [path, opts]),
    record: (dest, opts = {}) => callAsync('audio.record', [dest, opts]),
    stop: () => callSync('audio.stop'),
  };
  global.Speech = { speak: (text, opts = {}) => callAsync('speech.speak', [String(text), opts]) };

  // --------------------------------------------------------------------- UI

  global.alert = async (message, title) => { await callAsync('ui.alert', [title, String(message), {}]); };
  global.confirm = async (message, title) =>
    (await callAsync('ui.alert', [title, String(message), { buttons: ['OK'], cancel: 'Cancelar' }])).index === 0;
  global.prompt = async (message, value = '', title) => {
    const r = await callAsync('ui.alert', [title, String(message), { buttons: ['OK'], cancel: 'Cancelar', fields: [{ value }] }]);
    return r.index === 0 ? r.values[0] : null;
  };
  global.UI = {
    /** Full alert: { buttons, cancel, destructive, fields: [{ placeholder, value, secure }] } */
    alert: (title, message, opts = {}) => callAsync('ui.alert', [title, message, opts]),
    menu: (title, options) => callAsync('ui.menu', [title, options]),
    share: (items) => callAsync('ui.share', [items]),
    preview: (paths) => callAsync('ui.preview', [paths]),
    haptic: (kind) => callSync('ui.haptic', kind),
    open: (url) => callAsync('ui.openURL', [String(url)]),
  };
  global.Pasteboard = {
    get text() { return callSync('pasteboard.getText'); },
    set text(v) { callSync('pasteboard.setText', String(v)); },
    copy: (text) => callSync('pasteboard.setText', String(text)),
    paste: () => callSync('pasteboard.getText'),
    copyFile: (path) => callSync('pasteboard.copyFile', path),
    pasteFile: (dest) => callSync('pasteboard.pasteFile', dest),
  };
  global.Notify = {
    schedule: (opts) => callAsync('notify.schedule', [opts]),
    cancel: (id) => callSync('notify.cancel', id),
  };

  global.Device = {
    info: () => callSync('device.info'),
    setBrightness: (v) => callSync('device.setBrightness', v),
  };
  global.Keychain = {
    set: (k, v) => callSync('keychain.set', k, String(v)),
    get: (k) => callSync('keychain.get', k),
    remove: (k) => callSync('keychain.remove', k),
  };

  // ---------------------------------------------------------------- modules

  const moduleCache = new Map();
  const dirname = (p) => p.slice(0, p.lastIndexOf('/')) || '/';

  function resolveModule(name, fromDir) {
    const bases = name.startsWith('/') ? [''] : name.startsWith('.') ? [fromDir] : [FS.join(FS.documents, 'modules'), FS.documents];
    for (const base of bases) {
      const p = base ? FS.join(base, name) : name;
      for (const candidate of [p, p + '.js', p + '.json', FS.join(p, 'index.js')]) {
        if (FS.exists(candidate) && !FS.isDir(candidate)) return candidate;
      }
    }
    throw new Error(`Cannot find module '${name}'`);
  }

  function evaluateModule(code, filename) {
    const module = { exports: {}, filename };
    moduleCache.set(filename, module);
    if (filename.endsWith('.json')) {
      module.exports = JSON.parse(code);
      return module.exports;
    }
    const dir = dirname(filename);
    const localRequire = (name) => requireFrom(name, dir);
    const fn = new Function('module', 'exports', 'require', '__filename', '__dirname', code + '\n//# sourceURL=' + filename);
    fn.call(module.exports, module, module.exports, localRequire, filename, dir);
    return module.exports;
  }

  function requireFrom(name, dir) {
    const path = resolveModule(name, dir);
    const cached = moduleCache.get(path);
    if (cached) return cached.exports;
    return evaluateModule(FS.readText(path), path);
  }

  const info = callSync('script.info');
  global.require = (name) => requireFrom(name, info.documents);
  global.importModule = global.require;

  /**
   * Loads a CommonJS/UMD bundle from a URL (e.g. unpkg.com/lib/dist/lib.umd.js).
   * Cached on disk; pass { reload: true } to download again.
   */
  global.requireURL = async (url, opts = {}) => {
    const key = Crypto.hash('sha256', url);
    const cacheDir = FS.join(FS.cache, 'modules');
    const file = FS.join(cacheDir, key + '.js');
    const cached = moduleCache.get(file);
    if (cached && !opts.reload) return cached.exports;
    if (opts.reload || !FS.exists(file)) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`requireURL ${url}: HTTP ${res.status}`);
      FS.mkdir(cacheDir);
      FS.writeText(file, await res.text());
    }
    return evaluateModule(FS.readText(file), file);
  };

  // ---------------------------------------------------- Script & Scriptable

  // Set by Script.setShortcutOutput(); used as the result when main returns nothing.
  let shortcutOutput;

  // @include scriptable.js
  // @include views.js

  // ---------------------------------------------------------- miniapp host

  // A .jsx miniapp runs in the app's React runtime, not here. Its calls to this API arrive as a
  // global path ("FS.readText") and JSON arguments; the result goes back as JSON. Bytes travel
  // as base64 and dates as ISO text, both tagged; Data and Image become their bytes or path.
  // A function argument arrives as { __fn: n }: calling it sends its arguments back as an event.
  function hostEncode(value) {
    const tag = (v) => {
      if (v && typeof v.__nativeValue === 'function') v = v.__nativeValue();
      if (v instanceof Date) return { __date: v.toISOString() };
      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return { __bytes: Base64.encode(v) };
      return v;
    };
    // The replacer sees Date already turned into text by toJSON, so it reads the raw value from the holder.
    return JSON.stringify(tag(value) ?? null, function (key, v) { return key === '' ? v : tag(this[key]); });
  }
  function hostDecode(text, id) {
    return JSON.parse(text, (_key, v) => {
      if (!v || typeof v !== 'object') return v;
      if (typeof v.__bytes === 'string') return Base64.decode(v.__bytes);
      if (typeof v.__date === 'string') return new Date(v.__date);
      if (typeof v.__fn === 'number') {
        const fn = v.__fn;
        // The other side calls it and answers through __hostReply, so a callback can return a
        // value (Net.serve's handler). Callbacks whose result nobody reads just ignore it.
        return (...xs) => new Promise((resolve, reject) => {
          const reply = nextHostReply++;
          hostReplies.set(reply, { resolve, reject });
          callSync('host.send', { id, kind: 'event', fn, value: hostEncode(xs), reply });
        });
      }
      return v;
    });
  }
  const hostReplies = new Map();
  let nextHostReply = 1;
  global.__hostReply = (reply, value, error) => {
    const pending = hostReplies.get(reply);
    if (!pending) return;
    hostReplies.delete(reply);
    if (error) pending.reject(new Error(error));
    else pending.resolve(value);
  };

  global.__hostCall = (id, request) => {
    const send = (kind, value) => callSync('host.send', { id, kind, value });
    Promise.resolve()
      .then(() => {
        const parts = String(request.path).split('.');
        let owner = global;
        let target = global;
        for (const part of parts) {
          if (target === undefined || target === null || !(part in Object(target))) throw new Error(`${request.path} no existe en Scriptor.`);
          owner = target;
          target = target[part];
        }
        return typeof target === 'function' ? target.apply(owner, hostDecode(request.args || '[]', id)) : target;
      })
      .then(
        (value) => send('done', hostEncode(value)),
        (err) => send('error', err instanceof Error ? err.message : inspect(err))
      );
  };

  global.__runMain = (fn) => {
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          if (value === undefined) value = shortcutOutput;
          native.mainDone(true, value === undefined ? undefined : inspect(value));
        },
        (err) => native.mainDone(false, err instanceof Error ? (err.stack ? `${err.name}: ${err.message}\n${err.stack}` : `${err.name}: ${err.message}`) : 'Uncaught ' + inspect(err))
      );
  };

  delete global.__native;
})(globalThis);
