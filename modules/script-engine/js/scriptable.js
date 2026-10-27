  // =========================================================== Scriptable API
  // Compatibility layer for scripts written for Scriptable (docs.scriptable.app).
  // Inlined into prelude.js by scripts/gen-prelude.mjs, so it shares the prelude's scope.
  {
    const toMs = (d) => (d == null ? null : d instanceof Date ? d.getTime() : Number(d));
    const toDate = (v) => (v == null ? null : new Date(v));
    const tempPath = (ext) => callSync('fs.tempPath', ext);
    const deviceInfo = () => callSync('device.info');
    const notices = new Set();
    const noticeOnce = (key, text) => { if (!notices.has(key)) { notices.add(key); write('warn')(text); } };

    const MIME = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', heic: 'image/heic', webp: 'image/webp',
      pdf: 'application/pdf', txt: 'text/plain', html: 'text/html', json: 'application/json', csv: 'text/csv',
      mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
      zip: 'application/zip', xml: 'application/xml', js: 'text/javascript', svg: 'image/svg+xml',
    };
    const extOf = (name) => { const m = /\.([^./]+)$/.exec(String(name)); return m ? m[1].toLowerCase() : ''; };
    const mimeOf = (name) => MIME[extOf(name)] || 'application/octet-stream';

    /** Detects an image format from its first bytes; null when it is not an image. */
    function sniffImage(b) {
      if (b.length < 12) return null;
      if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
      if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
      if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
      if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'webp';
      if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'heic';
      if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
      if ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d)) return 'tiff';
      if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'ico';
      return null;
    }

    // ------------------------------------------------------------ geometry

    class Point { constructor(x, y) { this.x = x; this.y = y; } }
    class Size { constructor(width, height) { this.width = width; this.height = height; } }
    class Rect {
      constructor(x, y, width, height) { this.x = x; this.y = y; this.width = width; this.height = height; }
      get minX() { return Math.min(this.x, this.x + this.width); }
      get minY() { return Math.min(this.y, this.y + this.height); }
      get maxX() { return Math.max(this.x, this.x + this.width); }
      get maxY() { return Math.max(this.y, this.y + this.height); }
      get origin() { return new Point(this.x, this.y); }
      set origin(p) { this.x = p.x; this.y = p.y; }
      get size() { return new Size(this.width, this.height); }
      set size(s) { this.width = s.width; this.height = s.height; }
    }
    global.Point = Point;
    global.Size = Size;
    global.Rect = Rect;

    // -------------------------------------------------------- Color & Font

    class Color {
      constructor(hex, alpha) {
        let h = String(hex == null ? '000000' : hex).trim().replace(/^#/, '');
        if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
        let a = 1;
        if (h.length === 8) { a = parseInt(h.slice(6, 8), 16) / 255; h = h.slice(0, 6); }
        if (!/^[0-9a-fA-F]{6}$/.test(h)) h = '000000';
        this._hex = h.toUpperCase();
        this.alpha = alpha === undefined || alpha === null ? a : Number(alpha);
        this._dark = null;
      }
      get hex() { return this._hex; }
      get red() { return parseInt(this._hex.slice(0, 2), 16) / 255; }
      get green() { return parseInt(this._hex.slice(2, 4), 16) / 255; }
      get blue() { return parseInt(this._hex.slice(4, 6), 16) / 255; }
      /** A color that changes with light and dark mode. */
      static dynamic(light, dark) {
        const c = new Color(light.hex, light.alpha);
        c._dark = dark;
        return c;
      }
      _spec() {
        const s = { hex: this._hex, alpha: this.alpha };
        return this._dark ? { light: s, dark: this._dark._spec() } : s;
      }
      _resolve(dark) { return dark && this._dark ? this._dark : this; }
      _css(dark) {
        const c = this._resolve(dark);
        return `rgba(${Math.round(c.red * 255)},${Math.round(c.green * 255)},${Math.round(c.blue * 255)},${c.alpha})`;
      }
    }
    const namedColors = {
      black: '000000', darkGray: '555555', lightGray: 'AAAAAA', white: 'FFFFFF', gray: '808080', red: 'FF0000',
      green: '00FF00', blue: '0000FF', cyan: '00FFFF', yellow: 'FFFF00', magenta: 'FF00FF', orange: 'FF8000',
      purple: '800080', brown: '996633',
    };
    for (const [name, hex] of Object.entries(namedColors)) Color[name] = () => new Color(hex);
    Color.clear = () => new Color('000000', 0);
    global.Color = Color;

    const TEXT_STYLES = {
      largeTitle: [34, 400], title1: [28, 400], title2: [22, 400], title3: [20, 400], headline: [17, 600],
      subheadline: [15, 400], body: [17, 400], callout: [16, 400], footnote: [13, 400], caption1: [12, 400], caption2: [11, 400],
    };
    const WEIGHTS = { ultraLight: 100, thin: 200, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, heavy: 800, black: 900 };

    class Font {
      constructor(name, size) { this._spec = { kind: 'named', name: String(name), size: Number(size) }; }
      static _make(spec) { const f = Object.create(Font.prototype); f._spec = spec; return f; }
      get _size() { return this._spec.size || (TEXT_STYLES[this._spec.style] || [17])[0]; }
      _css() {
        const s = this._spec;
        let size = s.size;
        let weight = WEIGHTS[s.weight] || 400;
        let family = '-apple-system, system-ui, sans-serif';
        if (s.kind === 'style') [size, weight] = TEXT_STYLES[s.style] || [17, 400];
        if (s.kind === 'named') family = `"${s.name}", -apple-system, sans-serif`;
        if (s.design === 'monospaced') family = 'ui-monospace, Menlo, monospace';
        if (s.design === 'rounded') family = 'ui-rounded, -apple-system, sans-serif';
        return `${s.italic ? 'italic ' : ''}${weight} ${size}px ${family}`;
      }
    }
    for (const style of Object.keys(TEXT_STYLES)) Font[style] = () => Font._make({ kind: 'style', style });
    Font.systemFont = (size) => Font._make({ kind: 'system', size, weight: 'regular' });
    Font.italicSystemFont = (size) => Font._make({ kind: 'system', size, weight: 'regular', italic: true });
    for (const weight of Object.keys(WEIGHTS)) {
      Font[weight + 'SystemFont'] = (size) => Font._make({ kind: 'system', size, weight });
      Font[weight + 'MonospacedSystemFont'] = (size) => Font._make({ kind: 'system', size, weight, design: 'monospaced' });
      Font[weight + 'RoundedSystemFont'] = (size) => Font._make({ kind: 'system', size, weight, design: 'rounded' });
    }
    global.Font = Font;

    class LinearGradient {
      constructor() { this.colors = []; this.locations = []; this.startPoint = new Point(0, 0); this.endPoint = new Point(0, 1); }
      _css(dark) {
        const dx = this.endPoint.x - this.startPoint.x;
        const dy = this.endPoint.y - this.startPoint.y;
        const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
        const stops = this.colors.map((c, i) => {
          const loc = this.locations[i] !== undefined ? this.locations[i] : this.colors.length > 1 ? i / (this.colors.length - 1) : 0;
          return `${c._css(dark)} ${loc * 100}%`;
        });
        return `linear-gradient(${angle}deg, ${stops.join(', ')})`;
      }
    }
    global.LinearGradient = LinearGradient;

    // -------------------------------------------------------- Data & Image

    class Data {
      constructor(bytes) { this._bytes = bytes || new Uint8Array(0); }
      static fromString(string) { return new Data(new TextEncoder().encode(String(string))); }
      static fromFile(filePath) { return FS.exists(filePath) && !FS.isDir(filePath) ? new Data(FS.readBytes(filePath)) : null; }
      static fromBase64String(base64) { try { return new Data(Base64.decode(String(base64))); } catch (e) { return null; } }
      static fromJPEG(image) { return new Data(callSync('image.encode', image, 'jpeg', 0.9)); }
      static fromPNG(image) { return new Data(callSync('image.encode', image, 'png', 1)); }
      static fromBytes(bytes) { return new Data(Uint8Array.from(bytes)); }
      toRawString() { try { return new TextDecoder().decode(this._bytes); } catch (e) { return null; } }
      toBase64String() { return Base64.encode(this._bytes); }
      getBytes() { return Array.from(this._bytes); }
      get bytes() { return this._bytes; }
      get length() { return this._bytes.length; }
      __nativeValue() { return this._bytes; }
    }
    global.Data = Data;

    class Image {
      constructor(path, size, template) { this._path = path; this._size = size || null; this._template = !!template; }
      static fromFile(filePath) {
        if (!FS.exists(filePath) || FS.isDir(filePath)) return null;
        try { const img = new Image(FS.join(filePath)); img.size; return img; } catch (e) { return null; }
      }
      static fromData(data) {
        const bytes = toNative(data);
        const path = tempPath(sniffImage(bytes) || 'img');
        FS.writeBytes(path, bytes);
        try { const img = new Image(path); img.size; return img; } catch (e) { return null; }
      }
      get size() {
        if (!this._size) { const i = callSync('image.info', this._path); this._size = new Size(i.width, i.height); }
        return this._size;
      }
      /** Path of the file behind the image (Scriptor extra). */
      get path() { return this._path; }
      __nativeValue() { return this._path; }
      // Scriptor helpers: they take a path or an Image and return the path of a new file.
      static info(image) { return callSync('image.info', image); }
      static resize(image, opts = {}) { return callAsync('image.resize', [image, opts]); }
      static crop(image, opts = {}) { return callAsync('image.crop', [image, opts]); }
      static convert(image, opts = {}) { return callAsync('image.convert', [image, typeof opts === 'string' ? { format: opts } : opts]); }
    }
    global.Image = Image;
    const asImage = (path) => (path ? new Image(path) : null);
    const imageSpec = (image) => (image instanceof Image ? image._path : image ? String(image) : null);

    // --------------------------------------------------------- FileManager

    const fileManager = {
      read: (path) => { if (!FS.exists(path)) throw new Error(`The file ${path} does not exist.`); return new Data(FS.readBytes(path)); },
      readString: (path) => (FS.exists(path) ? FS.readText(path) : null),
      readImage: (path) => Image.fromFile(path),
      write: (path, data) => { FS.writeBytes(path, toNative(data)); },
      writeString: (path, content) => { FS.writeText(path, content); },
      writeImage: (path, image) => {
        const ext = extOf(path);
        callSync('image.write', image, path, ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext === 'heic' ? 'heic' : 'png', 0.9);
      },
      remove: (path) => { FS.remove(path); },
      move: (from, to) => { FS.move(from, to); },
      copy: (from, to) => { FS.copy(from, to); },
      fileExists: (path) => FS.exists(path),
      isDirectory: (path) => FS.isDir(path),
      createDirectory: (path, intermediate) => {
        const parent = path.slice(0, path.lastIndexOf('/'));
        if (!intermediate && parent && !FS.exists(parent)) throw new Error(`The folder ${parent} does not exist.`);
        FS.mkdir(path);
      },
      temporaryDirectory: () => FS.temp.replace(/\/$/, ''),
      cacheDirectory: () => FS.cache,
      documentsDirectory: () => FS.documents,
      libraryDirectory: () => FS.library,
      joinPath: (lhs, rhs) => FS.join(lhs, rhs),
      allTags: () => [],
      addTag: () => {},
      removeTag: () => {},
      readExtendedAttribute: (path, name) => callSync('fs.xattr', path, name),
      writeExtendedAttribute: (path, value, name) => { callSync('fs.setXattr', path, name, String(value)); },
      removeExtendedAttribute: (path, name) => { callSync('fs.setXattr', path, name, null); },
      allExtendedAttributes: (path) => callSync('fs.xattrs', path),
      getUTI: (path) => FS.stat(path).type,
      listContents: (path) => FS.list(path).filter((n) => n !== '.DS_Store'),
      fileName: (path, includeFileExtension = false) => {
        const base = String(path).replace(/\/+$/, '').split('/').pop();
        return includeFileExtension ? base : base.replace(/\.[^.]*$/, '') || base;
      },
      fileExtension: (path) => extOf(path),
      bookmarkedPath: (name) => { const p = FS.bookmark(name); if (!p) throw new Error(`No bookmark named ${name}`); return p; },
      bookmarkExists: (name) => FS.bookmarks().includes(name),
      allFileBookmarks: () => FS.bookmarks().map((name) => ({ name, source: 'host' })),
      // There is no iCloud with a free account; everything is local and already downloaded.
      downloadFileFromiCloud: async () => {},
      isFileStoredIniCloud: () => false,
      isFileDownloaded: (path) => FS.exists(path),
      creationDate: (path) => (FS.exists(path) ? new Date(FS.stat(path).created) : null),
      modificationDate: (path) => (FS.exists(path) ? new Date(FS.stat(path).modified) : null),
      fileSize: (path) => FS.stat(path).size / 1000,
    };
    class FileManager {
      static local() { return Object.assign(new FileManager(), fileManager); }
      static iCloud() {
        noticeOnce('icloud', 'FileManager.iCloud() usa la carpeta local de Scriptor (sin iCloud en cuentas gratuitas).');
        return Object.assign(new FileManager(), fileManager);
      }
    }
    global.FileManager = FileManager;

    // ------------------------------------------------------------- Request

    class Request {
      constructor(url) {
        this.url = url;
        this.method = 'GET';
        this.headers = {};
        this.body = undefined;
        this.timeoutInterval = 60;
        this.onRedirect = undefined;
        this.response = undefined;
        this.allowInsecureRequest = false;
        this._form = null;
      }
      _formData() { if (!this._form) this._form = new FormData(); return this._form; }
      addParameterToMultipart(name, value) { this._formData().append(name, String(value)); }
      addFileDataToMultipart(data, mimeType, name, filename) {
        this._formData().append(name, new Blob([toNative(data)], { type: mimeType }), filename);
      }
      addFileToMultipart(filePath, name, filename) {
        const fn = filename || String(filePath).split('/').pop();
        this._formData().append(name, new File([FS.readBytes(filePath)], fn, { type: mimeOf(fn) }), fn);
      }
      addImageToMultipart(image, name, filename = 'image.jpg') {
        const bytes = callSync('image.encode', image, 'jpeg', 0.9);
        this._formData().append(name, new File([bytes], filename, { type: 'image/jpeg' }), filename);
      }
      _raw(manual) {
        const headers = new Headers(this.headers || {});
        let body;
        if (this._form) {
          const enc = this._form._encode();
          body = enc.body;
          headers.set('content-type', enc.type);
        } else if (this.body !== undefined && this.body !== null) {
          body = typeof this.body === 'string' ? this.body : toNative(this.body);
        }
        const opts = {
          method: String(this.method || 'GET').toUpperCase(),
          headers: headers.toObject(),
          timeout: Number(this.timeoutInterval) || 60,
          redirect: manual ? 'manual' : undefined,
          insecure: !!this.allowInsecureRequest,
        };
        return callAsync('net.fetch', [String(this.url), opts, body]);
      }
      async _send() {
        const manual = typeof this.onRedirect === 'function';
        let r = await this._raw(manual);
        for (let hops = 0; manual && hops < 20 && r.status >= 300 && r.status < 400 && r.headers.location; hops++) {
          const next = new Request(new URL(r.headers.location, r.url || this.url).href);
          next.method = r.status === 303 ? 'GET' : this.method;
          next.headers = Object.assign({}, this.headers);
          next.timeoutInterval = this.timeoutInterval;
          next.allowInsecureRequest = this.allowInsecureRequest;
          if (next.method !== 'GET') { next.body = this.body; next._form = this._form; }
          const chosen = this.onRedirect(next);
          if (!chosen) break;
          r = await chosen._raw(true);
        }
        const contentType = r.headers['content-type'] || '';
        const charset = /charset=([^;]+)/i.exec(contentType);
        this.response = {
          url: r.url,
          statusCode: r.status,
          mimeType: contentType.split(';')[0].trim() || null,
          textEncodingName: charset ? charset[1].trim().toLowerCase() : null,
          headers: r.rawHeaders || r.headers,
          cookies: r.cookies || [],
        };
        return r.body;
      }
      async load() { return new Data(await this._send()); }
      async loadString() { return new TextDecoder().decode(await this._send()); }
      async loadJSON() { return JSON.parse(new TextDecoder().decode(await this._send())); }
      async loadImage() {
        const img = Image.fromData(await this._send());
        if (!img) throw new Error('The response is not an image.');
        return img;
      }
    }
    global.Request = Request;

    // ----------------------------------------------------- Alert & TextField

    class TextField {
      constructor(placeholder, text, secure) {
        this.placeholder = placeholder == null ? '' : String(placeholder);
        this.text = text == null ? '' : String(text);
        this.isSecure = !!secure;
        this.textColor = null;
        this.font = null;
        this._keyboard = 'default';
        this._align = 'left';
      }
      _spec() {
        return { placeholder: this.placeholder, value: this.text, secure: this.isSecure, keyboard: this._keyboard, align: this._align,
          textColor: this.textColor ? this.textColor._spec() : null, font: this.font ? this.font._spec : null };
      }
    }
    for (const kb of ['Default', 'NumberPad', 'DecimalPad', 'NumbersAndPunctuation', 'PhonePad', 'WebSearch', 'EmailAddress', 'URL', 'Twitter']) {
      TextField.prototype['set' + kb + 'Keyboard'] = function () { this._keyboard = kb[0].toLowerCase() + kb.slice(1); };
    }
    for (const align of ['left', 'center', 'right']) TextField.prototype[align + 'AlignText'] = function () { this._align = align; };

    class Alert {
      constructor() { this.title = ''; this.message = ''; this._actions = []; this._cancel = null; this._fields = []; this._values = null; }
      addAction(title) { this._actions.push({ title: String(title), style: 'default' }); }
      addDestructiveAction(title) { this._actions.push({ title: String(title), style: 'destructive' }); }
      addCancelAction(title) { this._cancel = String(title); }
      addTextField(placeholder, text) { const f = new TextField(placeholder, text, false); this._fields.push(f); return f; }
      addSecureTextField(placeholder, text) { const f = new TextField(placeholder, text, true); this._fields.push(f); return f; }
      textFieldValue(index) {
        if (this._values && this._values[index] !== undefined) return this._values[index];
        return this._fields[index] ? this._fields[index].text : null;
      }
      present() { return this._present('alert'); }
      presentAlert() { return this._present('alert'); }
      presentSheet() { return this._present('sheet'); }
      async _present(style) {
        const actions = this._actions.length || this._cancel ? this._actions : [{ title: 'OK', style: 'default' }];
        const r = await callAsync('ui.alert', [this.title || null, this.message || null, {
          style, actions, cancel: this._cancel, fields: this._fields.map((f) => f._spec()),
        }]);
        this._values = r.values;
        r.values.forEach((v, i) => { if (this._fields[i]) this._fields[i].text = v; });
        return r.index;
      }
    }
    global.Alert = Alert;

    // ---------------------------------------------------------------- UITable

    class UITableCell {
      constructor(type, props) {
        this._type = type;
        Object.assign(this, props);
        this.widthWeight = 1;
        this.onTap = null;
        this.dismissOnTap = false;
        this.titleColor = null;
        this.subtitleColor = null;
        this.titleFont = null;
        this.subtitleFont = null;
        this._align = 'left';
      }
      static text(title, subtitle) { return new UITableCell('text', { title: title == null ? '' : String(title), subtitle: subtitle == null ? '' : String(subtitle) }); }
      static image(image) { return new UITableCell('image', { image }); }
      static imageAtURL(url) { return new UITableCell('imageURL', { url: String(url) }); }
      static button(title) { return new UITableCell('button', { title: String(title) }); }
      leftAligned() { this._align = 'left'; }
      centerAligned() { this._align = 'center'; }
      rightAligned() { this._align = 'right'; }
      _spec() {
        return {
          type: this._type, title: this.title, subtitle: this.subtitle, image: imageSpec(this.image), url: this.url,
          widthWeight: Number(this.widthWeight) || 1, align: this._align, dismissOnTap: !!this.dismissOnTap,
          titleColor: this.titleColor ? this.titleColor._spec() : null, subtitleColor: this.subtitleColor ? this.subtitleColor._spec() : null,
          titleFont: this.titleFont ? this.titleFont._spec : null, subtitleFont: this.subtitleFont ? this.subtitleFont._spec : null,
        };
      }
    }
    class UITableRow {
      constructor() { this.cellSpacing = 0; this.height = 44; this.isHeader = false; this.dismissOnSelect = true; this.onSelect = null; this.backgroundColor = null; this._cells = []; }
      addCell(cell) { this._cells.push(cell); }
      addText(title, subtitle) { const c = UITableCell.text(title, subtitle); this._cells.push(c); return c; }
      addImage(image) { const c = UITableCell.image(image); this._cells.push(c); return c; }
      addImageAtURL(url) { const c = UITableCell.imageAtURL(url); this._cells.push(c); return c; }
      addButton(title) { const c = UITableCell.button(title); this._cells.push(c); return c; }
    }
    class UITable {
      constructor() { this.showSeparators = false; this._rows = []; this._shown = []; this._id = null; }
      addRow(row) { this._rows.push(row); }
      removeRow(row) { this._rows = this._rows.filter((r) => r !== row); }
      removeAllRows() { this._rows = []; }
      reload() { if (this._id !== null) callSync('table.update', this._id, this._spec()); }
      _spec() {
        this._shown = this._rows.slice();
        return {
          showSeparators: !!this.showSeparators,
          rows: this._shown.map((r) => ({
            height: Number(r.height) || 44, isHeader: !!r.isHeader, cellSpacing: Number(r.cellSpacing) || 0,
            backgroundColor: r.backgroundColor ? r.backgroundColor._spec() : null,
            selectable: typeof r.onSelect === 'function', dismissOnSelect: r.dismissOnSelect !== false,
            cells: r._cells.map((c) => c._spec()),
          })),
        };
      }
      present(fullscreen = false) {
        const { id, promise } = callAsyncWithId('table.present', [this._spec(), !!fullscreen], (e) => {
          const row = this._shown[e.row];
          if (!row) return;
          if (e.type === 'select' && row.onSelect) row.onSelect(e.row);
          if (e.type === 'tap') { const cell = row._cells[e.cell]; if (cell && cell.onTap) cell.onTap(); }
        });
        this._id = id;
        return promise.then(() => { this._id = null; });
      }
    }
    global.UITable = UITable;
    global.UITableRow = UITableRow;
    global.UITableCell = UITableCell;

    // ---------------------------------------------------------------- WebView

    class WebView {
      constructor() { this._id = callSync('web.create'); this._filter = null; }
      get shouldAllowRequest() { return this._filter; }
      set shouldAllowRequest(fn) { this._filter = typeof fn === 'function' ? fn : null; callSync('web.setFilter', this._id, !!this._filter); }
      _call(name, args) {
        return callAsync(name, [this._id, ...args], (e) => {
          if (e.type !== 'request') return;
          let allow = true;
          try {
            const req = new Request(e.url);
            req.method = e.method;
            req.headers = e.headers || {};
            allow = this._filter ? this._filter(req) !== false : true;
          } catch (err) { console.error(err); }
          callSync('web.decide', this._id, e.id, !!allow);
        });
      }
      loadURL(url) { return this._call('web.loadURL', [String(url)]).then(() => undefined); }
      loadRequest(request) {
        const headers = new Headers(request.headers || {});
        const body = request.body == null ? undefined : typeof request.body === 'string' ? request.body : toNative(request.body);
        return this._call('web.loadRequest', [String(request.url), String(request.method || 'GET').toUpperCase(), headers.toObject(), body]).then(() => undefined);
      }
      loadHTML(html, baseURL) { return this._call('web.loadHTML', [String(html), baseURL == null ? null : String(baseURL)]).then(() => undefined); }
      loadFile(fileURL) { return this._call('web.loadFile', [String(fileURL)]).then(() => undefined); }
      evaluateJavaScript(javaScript, useCallback = false) { return this._call('web.eval', [String(javaScript), !!useCallback]); }
      getHTML() { return this._call('web.eval', ['document.documentElement.outerHTML', false]); }
      present(fullscreen = false) { return this._call('web.present', [!!fullscreen]).then(() => undefined); }
      waitForLoad() { return this._call('web.waitForLoad', []); }
      static _show(load, fullscreen) {
        const w = new WebView();
        load(w).catch((e) => console.warn(e));
        return w.present(fullscreen);
      }
      static loadHTML(html, baseURL, preferredSize, fullscreen = false) { return WebView._show((w) => w.loadHTML(html, baseURL), fullscreen); }
      static loadURL(url, preferredSize, fullscreen = false) { return WebView._show((w) => w.loadURL(url), fullscreen); }
      static loadFile(fileURL, preferredSize, fullscreen = false) { return WebView._show((w) => w.loadFile(fileURL), fullscreen); }
    }
    global.WebView = WebView;

    // ---------------------------------------------------- DrawContext & Path

    class Path {
      constructor() { this._ops = []; }
      move(p) { this._ops.push(['move', p.x, p.y]); }
      addLine(p) { this._ops.push(['line', p.x, p.y]); }
      addLines(points) { points.forEach((p, i) => this._ops.push([i === 0 ? 'move' : 'line', p.x, p.y])); }
      addRect(r) { this._ops.push(['rect', r.x, r.y, r.width, r.height]); }
      addRects(rects) { rects.forEach((r) => this.addRect(r)); }
      addEllipse(r) { this._ops.push(['ellipse', r.x, r.y, r.width, r.height]); }
      addRoundedRect(r, cornerWidth, cornerHeight) { this._ops.push(['rounded', r.x, r.y, r.width, r.height, cornerWidth, cornerHeight]); }
      addCurve(point, control1, control2) { this._ops.push(['curve', point.x, point.y, control1.x, control1.y, control2.x, control2.y]); }
      addQuadCurve(point, control) { this._ops.push(['quad', point.x, point.y, control.x, control.y]); }
      closeSubpath() { this._ops.push(['close']); }
    }
    global.Path = Path;

    class DrawContext {
      constructor() { this.size = new Size(200, 200); this.respectScreenScale = false; this.opaque = true; this._ops = []; }
      getImage() {
        const r = callSync('draw.render', {
          width: this.size.width, height: this.size.height, respectScreenScale: !!this.respectScreenScale, opaque: !!this.opaque, ops: this._ops,
        });
        return new Image(r.path, new Size(r.width, r.height));
      }
      drawImageInRect(image, rect) { this._ops.push(['image', imageSpec(image), rect.x, rect.y, rect.width, rect.height]); }
      drawImageAtPoint(image, point) { this._ops.push(['image', imageSpec(image), point.x, point.y]); }
      setFillColor(color) { this._ops.push(['fillColor', color._spec()]); }
      setStrokeColor(color) { this._ops.push(['strokeColor', color._spec()]); }
      setLineWidth(width) { this._ops.push(['lineWidth', Number(width)]); }
      fill(rect) { this._ops.push(['fillRect', rect.x, rect.y, rect.width, rect.height]); }
      fillRect(rect) { this.fill(rect); }
      fillEllipse(rect) { this._ops.push(['fillEllipse', rect.x, rect.y, rect.width, rect.height]); }
      stroke(rect) { this._ops.push(['strokeRect', rect.x, rect.y, rect.width, rect.height]); }
      strokeRect(rect) { this.stroke(rect); }
      strokeEllipse(rect) { this._ops.push(['strokeEllipse', rect.x, rect.y, rect.width, rect.height]); }
      addPath(path) { this._ops.push(['path', path._ops.slice()]); }
      strokePath() { this._ops.push(['strokePath']); }
      fillPath() { this._ops.push(['fillPath']); }
      drawText(text, pos) { this._ops.push(['text', String(text), pos.x, pos.y]); }
      drawTextInRect(text, rect) { this._ops.push(['text', String(text), rect.x, rect.y, rect.width, rect.height]); }
      setFont(font) { this._ops.push(['font', font._spec]); }
      setTextColor(color) { this._ops.push(['textColor', color._spec()]); }
      setTextAlignedLeft() { this._ops.push(['align', 'left']); }
      setTextAlignedCenter() { this._ops.push(['align', 'center']); }
      setTextAlignedRight() { this._ops.push(['align', 'right']); }
    }
    global.DrawContext = DrawContext;

    class SFSymbol {
      constructor(name) { this._name = name; this._config = { size: 17, weight: 'regular' }; }
      static named(symbolName) { return callSync('symbol.exists', String(symbolName)) ? new SFSymbol(String(symbolName)) : null; }
      get image() {
        const r = callSync('symbol.render', this._name, this._config);
        return new Image(r.path, new Size(r.width, r.height), true);
      }
      applyFont(font) { this._config = { ...this._config, font: font._spec, size: font._size }; }
    }
    for (const weight of Object.keys(WEIGHTS)) {
      SFSymbol.prototype['apply' + weight[0].toUpperCase() + weight.slice(1) + 'Weight'] = function () { this._config = { ...this._config, weight }; };
    }
    global.SFSymbol = SFSymbol;

    // ---------------------------------------------------------------- widgets

    class WidgetElement {
      constructor(kind) { this._kind = kind; this.url = null; this._align = null; }
      leftAlignText() { this._align = 'left'; }
      centerAlignText() { this._align = 'center'; }
      rightAlignText() { this._align = 'right'; }
    }
    class WidgetText extends WidgetElement {
      constructor(text) {
        super('text');
        this.text = String(text);
        this.textColor = null; this.font = null; this.textOpacity = 1; this.lineLimit = 0; this.minimumScaleFactor = 1;
        this.shadowColor = null; this.shadowRadius = 0; this.shadowOffset = new Point(0, 0);
      }
    }
    class WidgetDate extends WidgetText {
      constructor(date) { super(''); this._kind = 'date'; this.date = date; this._style = 'date'; }
      applyTimeStyle() { this._style = 'time'; }
      applyDateStyle() { this._style = 'date'; }
      applyRelativeStyle() { this._style = 'relative'; }
      applyOffsetStyle() { this._style = 'offset'; }
      applyTimerStyle() { this._style = 'timer'; }
    }
    class WidgetImage extends WidgetElement {
      constructor(image) {
        super('image');
        this.image = image; this.resizable = true; this.imageSize = null; this.imageOpacity = 1; this.cornerRadius = 0;
        this.borderWidth = 0; this.borderColor = null; this.containerRelativeShape = false; this.tintColor = null; this._mode = 'fit';
      }
      leftAlignImage() { this._align = 'left'; }
      centerAlignImage() { this._align = 'center'; }
      rightAlignImage() { this._align = 'right'; }
      applyFittingContentMode() { this._mode = 'fit'; }
      applyFillingContentMode() { this._mode = 'fill'; }
    }
    class WidgetSpacer { constructor(length) { this._kind = 'spacer'; this.length = length == null ? null : length; } }
    class WidgetContainer {
      constructor() { this._children = []; this.backgroundColor = null; this.backgroundImage = null; this.backgroundGradient = null; this.spacing = 0; this.url = null; }
      addText(text) { const e = new WidgetText(text); this._children.push(e); return e; }
      addDate(date) { const e = new WidgetDate(date); this._children.push(e); return e; }
      addImage(image) { const e = new WidgetImage(image); this._children.push(e); return e; }
      addSpacer(length) { const e = new WidgetSpacer(length); this._children.push(e); return e; }
      addStack() { const e = new WidgetStack(); this._children.push(e); return e; }
      setPadding(top, leading, bottom, trailing) { this._padding = [top, trailing, bottom, leading]; }
    }
    class WidgetStack extends WidgetContainer {
      constructor() {
        super();
        this._kind = 'stack'; this.size = new Size(0, 0); this.cornerRadius = 0; this.borderWidth = 0; this.borderColor = null;
        this._padding = [0, 0, 0, 0]; this._layout = 'row'; this._alignContent = 'center';
      }
      useDefaultPadding() { this._padding = [16, 16, 16, 16]; }
      topAlignContent() { this._alignContent = 'flex-start'; }
      centerAlignContent() { this._alignContent = 'center'; }
      bottomAlignContent() { this._alignContent = 'flex-end'; }
      layoutHorizontally() { this._layout = 'row'; }
      layoutVertically() { this._layout = 'column'; }
    }
    const WIDGET_SIZES = {
      small: [170, 170], medium: [364, 170], large: [364, 382], extraLarge: [715, 382],
      accessoryCircular: [76, 76], accessoryRectangular: [172, 76], accessoryInline: [257, 26],
    };
    class ListWidget extends WidgetContainer {
      constructor() { super(); this._padding = [16, 16, 16, 16]; this.refreshAfterDate = null; this.addAccessoryWidgetBackground = false; }
      useDefaultPadding() { this._padding = [16, 16, 16, 16]; }
      presentSmall() { return presentWidget(this, 'small'); }
      presentMedium() { return presentWidget(this, 'medium'); }
      presentLarge() { return presentWidget(this, 'large'); }
      presentExtraLarge() { return presentWidget(this, 'extraLarge'); }
      presentAccessoryCircular() { return presentWidget(this, 'accessoryCircular'); }
      presentAccessoryRectangular() { return presentWidget(this, 'accessoryRectangular'); }
      presentAccessoryInline() { return presentWidget(this, 'accessoryInline'); }
    }
    global.ListWidget = ListWidget;
    global.WidgetStack = WidgetStack;
    global.WidgetText = WidgetText;
    global.WidgetDate = WidgetDate;
    global.WidgetImage = WidgetImage;
    global.WidgetSpacer = WidgetSpacer;

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const imageURLCache = new Map();
    function imageDataURL(image) {
      const path = imageSpec(image);
      if (!imageURLCache.has(path)) {
        const bytes = FS.readBytes(path);
        imageURLCache.set(path, `data:${MIME[sniffImage(bytes)] || 'image/png'};base64,${Base64.encode(bytes)}`);
      }
      return imageURLCache.get(path);
    }

    function renderWidget(widget, family, dark) {
      const fg = dark ? '#fff' : '#000';
      const pad = (p) => p.map((v) => `${v || 0}px`).join(' ');
      const background = (el, fallback) => {
        const layers = [];
        if (el.backgroundImage) layers.push(`url("${imageDataURL(el.backgroundImage)}") center/cover no-repeat`);
        if (el.backgroundGradient) layers.push(el.backgroundGradient._css(dark));
        if (el.backgroundColor) layers.push(el.backgroundColor._css(dark));
        if (!layers.length && fallback) layers.push(fallback);
        return layers.length ? `background:${layers.join(',')};` : '';
      };
      const selfAlign = (el, axis) => {
        if (axis !== 'column' || !el._align) return '';
        return `align-self:${el._align === 'left' ? 'flex-start' : el._align === 'right' ? 'flex-end' : 'center'};`;
      };
      const textStyle = (el, axis) => {
        let s = `color:${el.textColor ? el.textColor._css(dark) : fg};font:${(el.font || Font.body())._css()};opacity:${el.textOpacity};`;
        if (el._align) s += `text-align:${el._align};`;
        if (el.lineLimit > 0) s += `display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${el.lineLimit};`;
        if (el.shadowColor) s += `text-shadow:${el.shadowOffset.x}px ${el.shadowOffset.y}px ${el.shadowRadius}px ${el.shadowColor._css(dark)};`;
        return s + selfAlign(el, axis);
      };
      const render = (el, axis) => {
        switch (el._kind) {
          case 'text':
            return `<div class="t" style="${textStyle(el, axis)}">${esc(el.text)}</div>`;
          case 'date':
            return `<div class="t" data-date="${toMs(el.date)}" data-style="${el._style}" style="${textStyle(el, axis)}"></div>`;
          case 'spacer': {
            const prop = axis === 'row' ? 'width' : 'height';
            return el.length == null ? '<div style="flex:1 1 0"></div>' : `<div style="flex:0 0 ${el.length}px;${prop}:${el.length}px"></div>`;
          }
          case 'image': {
            const natural = el.image.size;
            const size = el.imageSize || (el.resizable ? null : natural);
            const dims = size ? `width:${size.width}px;height:${size.height}px;` : `max-width:100%;max-height:100%;min-height:0;aspect-ratio:${natural.width}/${natural.height};height:${natural.height}px;`;
            let s = `${dims}flex-shrink:${size ? 0 : 1};opacity:${el.imageOpacity};border-radius:${el.containerRelativeShape ? 16 : el.cornerRadius}px;`;
            if (el.borderWidth) s += `border:${el.borderWidth}px solid ${el.borderColor ? el.borderColor._css(dark) : fg};box-sizing:border-box;`;
            s += selfAlign(el, axis);
            const src = imageDataURL(el.image);
            if (el.tintColor || el.image._template) {
              const tint = el.tintColor ? el.tintColor._css(dark) : fg;
              return `<div style="${s}background:${tint};-webkit-mask:url('${src}') center/contain no-repeat"></div>`;
            }
            return `<img src="${src}" style="${s}object-fit:${el._mode === 'fill' ? 'cover' : 'contain'}">`;
          }
          case 'stack': {
            let s = `display:flex;flex-direction:${el._layout};gap:${el.spacing}px;padding:${pad(el._padding)};flex-shrink:0;box-sizing:border-box;`;
            s += `align-items:${el._layout === 'row' ? el._alignContent : 'flex-start'};`;
            if (el.size.width > 0) s += `width:${el.size.width}px;`;
            if (el.size.height > 0) s += `height:${el.size.height}px;`;
            if (el.cornerRadius) s += `border-radius:${el.cornerRadius}px;overflow:hidden;`;
            if (el.borderWidth) s += `border:${el.borderWidth}px solid ${el.borderColor ? el.borderColor._css(dark) : fg};`;
            s += background(el) + selfAlign(el, axis);
            return `<div style="${s}">${el._children.map((c) => render(c, el._layout)).join('')}</div>`;
          }
          default:
            return '';
        }
      };
      const [w, h] = WIDGET_SIZES[family];
      const accessory = family.startsWith('accessory');
      const radius = family === 'accessoryCircular' ? w / 2 : accessory ? 12 : 22;
      const fallback = accessory ? (widget.addAccessoryWidgetBackground ? 'rgba(127,127,127,.35)' : 'transparent') : dark ? '#1c1c1e' : '#fff';
      const style = `width:${w}px;height:${h}px;padding:${pad(widget._padding)};gap:${widget.spacing}px;border-radius:${radius}px;${background(widget, fallback)}`;
      return `<div class="w" style="${style}">${widget._children.map((c) => render(c, 'column')).join('')}</div>`;
    }

    // Runs inside the preview page: formats WidgetDate elements and keeps timers ticking.
    const WIDGET_PAGE_SCRIPT = `
      const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
      const units = [['year', 31536e6], ['month', 2592e6], ['day', 864e5], ['hour', 36e5], ['minute', 6e4], ['second', 1e3]];
      function rel(diff) { for (const [u, ms] of units) if (Math.abs(diff) >= ms || u === 'second') return rtf.format(Math.round(diff / ms), u); }
      function clock(diff) {
        const t = Math.floor(Math.abs(diff) / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
        return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
      }
      function tick() {
        for (const el of document.querySelectorAll('[data-date]')) {
          const d = new Date(Number(el.dataset.date)), diff = d - Date.now();
          const style = el.dataset.style;
          el.textContent = style === 'time' ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
            : style === 'relative' ? rel(diff)
            : style === 'offset' ? (diff >= 0 ? '+' : '-') + rel(Math.abs(diff)).replace(/^\\D*/, '')
            : style === 'timer' ? clock(diff)
            : d.toLocaleDateString([], { dateStyle: 'long' });
        }
      }
      tick(); setInterval(tick, 1000);
      const w = document.querySelector('.w'), free = innerWidth - 32;
      if (w.offsetWidth > free) w.style.zoom = free / w.offsetWidth;`;

    function presentWidget(widget, family) {
      const dark = !!deviceInfo().darkMode;
      const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
          background:${dark ? '#000' : '#e5e5ea'};font-family:-apple-system,system-ui;-webkit-user-select:none}
        .w{box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;overflow:hidden;
          box-shadow:0 6px 24px rgba(0,0,0,.18)}
        .t{white-space:pre-wrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;max-width:100%}
        .cap{margin-top:18px;font-size:13px;color:#8e8e93;text-align:center;padding:0 24px}
        </style></head><body>${renderWidget(widget, family, dark)}
        <div class="cap">Vista previa del widget (${family})<br>Scriptor no instala widgets en la pantalla de inicio</div>
        <script>${WIDGET_PAGE_SCRIPT}</script></body></html>`;
      return WebView.loadHTML(page, null, null, false);
    }

    // ---------------------------------------------------------- Script & co.

    const scriptName = String(info.name).replace(/\.js$/, '');
    const nameFn = function name() { return scriptName; };
    nameFn.toString = () => scriptName;
    global.Script = {
      name: nameFn,
      input: info.input,
      complete: (result) => callSync('script.complete', result === undefined ? undefined : inspect(result)),
      setShortcutOutput: (value) => { shortcutOutput = value; },
      setWidget: () => noticeOnce('widget', 'Script.setWidget() no hace nada en Scriptor: usa widget.presentSmall()/presentMedium() para verlo.'),
    };
    global.config = {
      runsInApp: true, runsInActionExtension: false, runsWithSiri: false, runsInWidget: false, runsInAccessoryWidget: false,
      runsInNotification: false, runsFromHomeScreen: false, widgetFamily: null,
    };
    global.args = Object.assign(Object.create(null), info.input, {
      plainTexts: [], urls: [], fileURLs: [], images: [], queryParameters: info.input,
      notification: null, shortcutParameter: null, widgetParameter: null, all: [],
    });
    global.module = { filename: FS.join(FS.documents, scriptName + '.js'), exports: {} };
    global.log = (...a) => write('log')(...a);
    global.logWarning = (...a) => write('warn')(...a);
    global.logError = (...a) => write('error')(...a);

    global.URLScheme = {
      allParameters: () => info.input,
      parameter: (name) => (info.input[name] === undefined ? null : info.input[name]),
      forOpeningScript: () => `scriptor://script/${encodeURIComponent(scriptName)}`,
      forOpeningScriptSettings: () => `scriptor://script/${encodeURIComponent(scriptName)}`,
      forRunningScript: () => `scriptor://run/${encodeURIComponent(scriptName)}`,
    };
    global.UUID = { string: () => callSync('crypto.uuid').toUpperCase() };

    class Timer {
      constructor() { this.timeInterval = 0; this.repeats = false; this._id = null; }
      schedule(callback) {
        this.invalidate();
        if (this.repeats) this._id = setInterval(callback, this.timeInterval);
        else this._id = setTimeout(() => { this._id = null; callback(); }, this.timeInterval);
      }
      invalidate() { if (this._id !== null) { clearTimeout(this._id); this._id = null; } }
      static schedule(timeInterval, repeats, callback) {
        const t = new Timer();
        t.timeInterval = timeInterval;
        t.repeats = repeats;
        t.schedule(callback);
        return t;
      }
    }
    global.Timer = Timer;

    // ------------------------------------------------------ device & system

    const di = deviceInfo;
    Object.assign(global.Device, {
      name: () => di().name,
      systemName: () => di().systemName,
      systemVersion: () => di().systemVersion,
      model: () => di().model,
      isPhone: () => di().idiom === 'phone',
      isPad: () => di().idiom === 'pad',
      screenSize: () => { const s = di().screen; return new Size(s.width, s.height); },
      screenResolution: () => { const s = di().screen; return new Size(s.width * s.scale, s.height * s.scale); },
      screenScale: () => di().screen.scale,
      screenBrightness: () => di().brightness,
      setScreenBrightness: (v) => callSync('device.setBrightness', v),
      isInPortrait: () => di().orientation === 1,
      isInPortraitUpsideDown: () => di().orientation === 2,
      isInLandscapeLeft: () => di().orientation === 3,
      isInLandscapeRight: () => di().orientation === 4,
      isFaceUp: () => di().orientation === 5,
      isFaceDown: () => di().orientation === 6,
      isUsingDarkAppearance: () => !!di().darkMode,
      batteryLevel: () => di().battery,
      isDischarging: () => di().batteryState === 'unplugged',
      isCharging: () => di().batteryState === 'charging',
      isFullyCharged: () => di().batteryState === 'full',
      preferredLanguages: () => di().languages,
      locale: () => di().locale,
      language: () => String(di().languages[0] || di().locale).split(/[-_]/)[0],
      volume: () => di().volume,
    });

    Object.assign(global.Keychain, {
      contains: (key) => callSync('keychain.get', key) !== null,
      get: (key) => {
        const v = callSync('keychain.get', key);
        if (v === null) throw new Error(`Could not find the key "${key}" in the keychain.`);
        return v;
      },
    });

    Object.assign(global.Pasteboard, {
      copyString: (s) => callSync('pasteboard.setText', String(s)),
      pasteString: () => callSync('pasteboard.getText'),
      copyImage: (image) => callSync('pasteboard.copyImage', image),
      pasteImage: () => asImage(callSync('pasteboard.pasteImage')),
    });

    let accuracy = 'best';
    global.Location = {
      current: () => callAsync('location.current', [accuracy]),
      setAccuracyToBest: () => { accuracy = 'best'; },
      setAccuracyToTenMeters: () => { accuracy = 'ten'; },
      setAccuracyToHundredMeters: () => { accuracy = 'hundred'; },
      setAccuracyToKilometer: () => { accuracy = 'kilometer'; },
      setAccuracyToThreeKilometers: () => { accuracy = 'threeKilometers'; },
      reverseGeocode: (latitude, longitude, locale) => callAsync('location.reverseGeocode', [latitude, longitude, locale]),
      /** Scriptor extra: address -> placemarks with coordinates. */
      geocode: (address, locale) => callAsync('location.geocode', [String(address), locale]),
    };

    // ------------------------------------------------------- photos & files

    const exportLatest = async (type, count) => {
      const items = await callAsync('photos.latest', [{ type, limit: count }]);
      if (!items.length) throw new Error(type === 'screenshot' ? 'No screenshots found.' : 'No photos found.');
      const out = [];
      for (const item of items) out.push(new Image(await callAsync('photos.export', [item.id, null])));
      return out;
    };
    const removeLatest = async (type, count) => {
      const items = await callAsync('photos.latest', [{ type, limit: count }]);
      if (items.length) await callAsync('photos.delete', [items.map((i) => i.id)]);
    };
    Object.assign(global.Photos, {
      fromLibrary: async () => {
        const [item] = await callAsync('photos.pick', [{ type: 'image', limit: 1 }]);
        if (!item) throw new Error('No image was selected.');
        return new Image(item.path);
      },
      fromCamera: async () => {
        const path = await callAsync('camera.capture', [{ video: false }]);
        if (!path) throw new Error('No photo was taken.');
        return new Image(path);
      },
      latestPhoto: async () => (await exportLatest('image', 1))[0],
      latestPhotos: (count) => exportLatest('image', count),
      latestScreenshot: async () => (await exportLatest('screenshot', 1))[0],
      latestScreenshots: (count) => exportLatest('screenshot', count),
      removeLatestPhoto: () => removeLatest('image', 1),
      removeLatestPhotos: (count) => removeLatest('image', count),
      removeLatestScreenshot: () => removeLatest('screenshot', 1),
      removeLatestScreenshots: (count) => removeLatest('screenshot', count),
    });

    const shareItem = (item) => {
      if (item instanceof Image) return item._path;
      if (item instanceof Data) { const p = tempPath('dat'); FS.writeBytes(p, item._bytes); return p; }
      return String(item);
    };
    global.ShareSheet = {
      present: async (activityItems) => {
        const type = await callAsync('ui.share', [[].concat(activityItems).map(shareItem)]);
        return { completed: !!type, activity_type: type };
      },
    };
    global.QuickLook = {
      present: (item, fullscreen = false) => {
        let path;
        if (item instanceof Image) path = item._path;
        else if (item instanceof Data) { path = tempPath(sniffImage(item._bytes) || 'dat'); FS.writeBytes(path, item._bytes); }
        else if (typeof item === 'string' && item.startsWith('/') && FS.exists(item)) path = item;
        else { path = tempPath('txt'); FS.writeText(path, typeof item === 'string' ? item : JSON.stringify(item, null, 2)); }
        return callAsync('ui.preview', [[path]]).then(() => undefined);
      },
    };

    const writeTemp = (name, write) => { const dir = FS.join(FS.temp, 'scriptor', callSync('crypto.uuid')); FS.mkdir(dir); const p = FS.join(dir, name); write(p); return p; };
    global.DocumentPicker = {
      open: (types) => callAsync('fs.pickFiles', [{ types, multiple: true }]),
      openFile: async () => (await callAsync('fs.pickFiles', [{ multiple: false }]))[0] || null,
      openFolder: () => callAsync('fs.pickFolder', [null]),
      export: (path) => callAsync('fs.export', [path]),
      exportString: (content, name = 'Untitled.txt') => callAsync('fs.export', [writeTemp(name, (p) => FS.writeText(p, content))]),
      exportImage: (image, name = 'Untitled.png') => callAsync('fs.export', [writeTemp(name, (p) => callSync('image.write', image, p, extOf(name) === 'jpg' ? 'jpeg' : 'png', 0.9))]),
      exportData: (data, name = 'Untitled') => callAsync('fs.export', [writeTemp(name, (p) => FS.writeBytes(p, toNative(data)))]),
    };

    // ------------------------------------------------------ pickers & system

    class DatePicker {
      constructor() { this.minimumDate = null; this.maximumDate = null; this.countdownDuration = 0; this.minuteInterval = 1; this.initialDate = new Date(); }
      _pick(mode) {
        return callAsync('ui.datePicker', [{
          mode, min: toMs(this.minimumDate), max: toMs(this.maximumDate), initial: toMs(this.initialDate),
          minuteInterval: this.minuteInterval, countdown: this.countdownDuration,
        }]);
      }
      async pickTime() { return new Date(await this._pick('time')); }
      async pickDate() { return new Date(await this._pick('date')); }
      async pickDateAndTime() { return new Date(await this._pick('dateAndTime')); }
      pickCountdownDuration() { return this._pick('countdown'); }
    }
    global.DatePicker = DatePicker;
    global.Dictation = { start: (locale) => callAsync('dictation.start', [locale]) };

    global.Safari = {
      open: (url) => { callAsync('ui.openURL', [String(url)]).catch(() => {}); },
      openInApp: (url, fullscreen = false) => callAsync('safari.openInApp', [String(url), !!fullscreen]).then(() => undefined),
    };

    const attachment = (path, mime, name) => ({ path: imageSpec(path), mime: mime || mimeOf(name || imageSpec(path)), name: name || String(imageSpec(path)).split('/').pop() });
    class Mail {
      constructor() {
        this.toRecipients = []; this.ccRecipients = []; this.bccRecipients = []; this.subject = ''; this.body = '';
        this.isBodyHTML = false; this.preferredSendingEmailAddress = null; this._attachments = [];
      }
      addImageAttachment(image) { this._attachments.push(attachment(image, null, 'image.' + (extOf(imageSpec(image)) || 'png'))); }
      addFileAttachment(filePath) { this._attachments.push(attachment(filePath)); }
      addDataAttachment(data, mimeType, filename) {
        this._attachments.push(attachment(writeTemp(filename, (p) => FS.writeBytes(p, toNative(data))), mimeType, filename));
      }
      send() {
        return callAsync('mail.send', [{
          to: this.toRecipients, cc: this.ccRecipients, bcc: this.bccRecipients, subject: this.subject, body: this.body,
          html: !!this.isBodyHTML, from: this.preferredSendingEmailAddress, attachments: this._attachments,
        }]);
      }
    }
    class Message {
      constructor() { this.recipients = []; this.body = ''; this._attachments = []; }
      addImageAttachment(image) { this._attachments.push(attachment(image, null, 'image.' + (extOf(imageSpec(image)) || 'png'))); }
      addFileAttachment(filePath) { this._attachments.push(attachment(filePath)); }
      addDataAttachment(data, uti, filename) { this._attachments.push(attachment(writeTemp(filename, (p) => FS.writeBytes(p, toNative(data))), uti, filename)); }
      send() { return callAsync('message.send', [{ recipients: this.recipients, body: this.body, attachments: this._attachments }]); }
    }
    global.Mail = Mail;
    global.Message = Message;

    class CallbackURL {
      constructor(baseURL) { this.baseURL = String(baseURL); this._params = []; }
      addParameter(name, value) { this._params.push([String(name), String(value)]); }
      getURL() {
        const query = this._params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        return query ? this.baseURL + (this.baseURL.includes('?') ? '&' : '?') + query : this.baseURL;
      }
      open() {
        const token = callSync('crypto.uuid');
        const cb = (status) => `x-${status}=${encodeURIComponent(`scriptor://x-callback/${token}/${status}`)}`;
        const url = this.getURL() + (this._params.length || this.baseURL.includes('?') ? '&' : '?') + ['success', 'error', 'cancel'].map(cb).join('&');
        return callAsync('callback.open', [url, token]);
      }
    }
    global.CallbackURL = CallbackURL;

    // ---------------------------------------------------- formatting & XML

    class DateFormatter {
      constructor() { this.dateFormat = null; this.locale = null; this._dateStyle = 0; this._timeStyle = 0; }
      _opts() { return { format: this.dateFormat, locale: this.locale, dateStyle: this._dateStyle, timeStyle: this._timeStyle }; }
      string(date) { return callSync('date.format', this._opts(), toMs(date)); }
      date(str) { const ms = callSync('date.parse', this._opts(), String(str)); return ms === null ? null : new Date(ms); }
    }
    ['No', 'Short', 'Medium', 'Long', 'Full'].forEach((name, i) => {
      DateFormatter.prototype[`use${name}DateStyle`] = function () { this._dateStyle = i; this.dateFormat = null; };
      DateFormatter.prototype[`use${name}TimeStyle`] = function () { this._timeStyle = i; this.dateFormat = null; };
    });
    global.DateFormatter = DateFormatter;

    class RelativeDateTimeFormatter {
      constructor() { this.locale = null; this._style = 'numeric'; }
      string(date, referenceDate) { return callSync('date.relative', { locale: this.locale, style: this._style }, toMs(date), toMs(referenceDate)); }
      useNamedDateTimeStyle() { this._style = 'named'; }
      useNumericDateTimeStyle() { this._style = 'numeric'; }
    }
    global.RelativeDateTimeFormatter = RelativeDateTimeFormatter;

    class XMLParser {
      constructor(string) {
        this.string = string;
        this.didStartDocument = null; this.didEndDocument = null; this.didStartElement = null;
        this.didEndElement = null; this.foundCharacters = null; this.parseErrorOccurred = null;
      }
      parse() {
        const r = callSync('xml.parse', String(this.string));
        if (this.didStartDocument) this.didStartDocument();
        for (const e of r.events) {
          if (e[0] === 's' && this.didStartElement) this.didStartElement(e[1], e[2]);
          else if (e[0] === 'e' && this.didEndElement) this.didEndElement(e[1]);
          else if (e[0] === 'c' && this.foundCharacters) this.foundCharacters(e[1]);
        }
        if (r.error) { if (this.parseErrorOccurred) this.parseErrorOccurred(r.error); }
        else if (this.didEndDocument) this.didEndDocument();
        return true;
      }
    }
    global.XMLParser = XMLParser;

    // ----------------------------------------------------- notifications

    class Notification {
      constructor() {
        this.identifier = callSync('crypto.uuid');
        this.title = ''; this.subtitle = ''; this.body = ''; this.preferredContentHeight = null; this.badge = null;
        this.threadIdentifier = null; this.userInfo = {}; this.sound = null; this.openURL = null;
        this.deliveryDate = null; this.nextTriggerDate = null; this.scriptName = scriptName; this.actions = [];
        this._trigger = null;
      }
      static _from(d) {
        const n = new Notification();
        Object.assign(n, {
          identifier: d.id, title: d.title, subtitle: d.subtitle, body: d.body, badge: d.badge, threadIdentifier: d.threadIdentifier,
          userInfo: d.userInfo || {}, openURL: d.openURL || null, scriptName: d.scriptName || null, actions: d.actions || [],
          deliveryDate: toDate(d.deliveryDate), nextTriggerDate: toDate(d.nextTriggerDate), sound: d.sound || null,
        });
        return n;
      }
      addAction(title, url, destructive = false) { this.actions.push({ title: String(title), url: String(url), destructive: !!destructive }); }
      setTriggerDate(date) { this._trigger = { type: 'date', at: toMs(date) }; }
      setDailyTrigger(hour, minute, repeats = false) { this._trigger = { type: 'daily', hour, minute, repeats }; }
      setWeeklyTrigger(weekday, hour, minute, repeats = false) { this._trigger = { type: 'weekly', weekday, hour, minute, repeats }; }
      schedule() {
        return callAsync('notify.schedule', [{
          id: this.identifier, title: this.title, subtitle: this.subtitle, body: this.body, badge: this.badge,
          threadIdentifier: this.threadIdentifier, userInfo: this.userInfo, sound: this.sound === null ? 'default' : this.sound,
          openURL: this.openURL, actions: this.actions, trigger: this._trigger, scriptName: this.scriptName,
        }]).then(() => undefined);
      }
      remove() { callSync('notify.cancel', this.identifier); return Promise.resolve(); }
      static async allPending() { return (await callAsync('notify.list', ['pending'])).map(Notification._from); }
      static async allDelivered() { return (await callAsync('notify.list', ['delivered'])).map(Notification._from); }
      static async removeAllPending() { callSync('notify.remove', 'pending', null); }
      static async removeAllDelivered() { callSync('notify.remove', 'delivered', null); }
      static async removePending(identifiers) { callSync('notify.remove', 'pending', identifiers); }
      static async removeDelivered(identifiers) { callSync('notify.remove', 'delivered', identifiers); }
      static async current() { return null; }
      static resetCurrent() {}
    }
    global.Notification = Notification;

    // ---------------------------------------------------- calendar & reminders

    const weekBounds = (offset) => {
      const first = info.firstWeekday || 2;
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      const diff = (d.getDay() + 1 - first + 7) % 7;
      d.setDate(d.getDate() - diff + offset * 7);
      const end = new Date(d);
      end.setDate(end.getDate() + 7);
      return [d, end];
    };
    const dayBounds = (offset) => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + offset);
      const end = new Date(d);
      end.setDate(end.getDate() + 1);
      return [d, end];
    };
    const calendarIds = (calendars) => (calendars && calendars.length ? calendars.map((c) => c.identifier) : null);

    class Calendar {
      constructor(d) {
        this.identifier = d.identifier;
        this.title = d.title;
        this.isSubscribed = !!d.isSubscribed;
        this.allowsContentModifications = !!d.allowsContentModifications;
        this.color = new Color(d.color || '808080');
        this._entity = d.entity;
        this._availabilities = d.availabilities || [];
      }
      supportsAvailability(availability) { return this._availabilities.includes(availability); }
      save() { callSync('cal.saveCalendar', { identifier: this.identifier, title: this.title, color: this.color.hex }); }
      remove() { callSync('cal.removeCalendar', this.identifier); }
      static _list(entity) { return callAsync('cal.calendars', [entity]).then((l) => l.map((d) => new Calendar(d))); }
      static forReminders() { return Calendar._list('reminder'); }
      static forEvents() { return Calendar._list('event'); }
      static async _byTitle(entity, title) {
        const c = (await Calendar._list(entity)).find((x) => x.title === title);
        if (!c) throw new Error(`No calendar named "${title}".`);
        return c;
      }
      static forRemindersByTitle(title) { return Calendar._byTitle('reminder', title); }
      static forEventsByTitle(title) { return Calendar._byTitle('event', title); }
      static async createForReminders(title) { return new Calendar(await callAsync('cal.createCalendar', ['reminder', String(title)])); }
      static async findOrCreateForReminders(title) {
        return (await Calendar.forReminders()).find((c) => c.title === title) || Calendar.createForReminders(title);
      }
      static async defaultForReminders() { return new Calendar(await callAsync('cal.defaultCalendar', ['reminder'])); }
      static async defaultForEvents() { return new Calendar(await callAsync('cal.defaultCalendar', ['event'])); }
      static async presentPicker(allowMultiple = false) {
        return (await callAsync('cal.presentPicker', ['event', !!allowMultiple])).map((d) => new Calendar(d));
      }
    }
    global.Calendar = Calendar;

    class RecurrenceRule {
      constructor(spec) { this._spec = spec; }
    }
    const rule = (frequency, interval, extra = {}) => new RecurrenceRule({ frequency, interval, ...extra });
    for (const freq of ['daily', 'weekly', 'monthly', 'yearly']) {
      RecurrenceRule[freq] = (interval) => rule(freq, interval);
      RecurrenceRule[freq + 'EndDate'] = (interval, endDate) => rule(freq, interval, { endDate: toMs(endDate) });
      RecurrenceRule[freq + 'OccurrenceCount'] = (interval, count) => rule(freq, interval, { occurrenceCount: count });
    }
    const complex = {
      Weekly: (interval, daysOfTheWeek, setPositions) => ['weekly', interval, { daysOfTheWeek, setPositions }],
      Monthly: (interval, daysOfTheWeek, daysOfTheMonth, setPositions) => ['monthly', interval, { daysOfTheWeek, daysOfTheMonth, setPositions }],
      Yearly: (interval, daysOfTheWeek, monthsOfTheYear, weeksOfTheYear, daysOfTheYear, setPositions) =>
        ['yearly', interval, { daysOfTheWeek, monthsOfTheYear, weeksOfTheYear, daysOfTheYear, setPositions }],
    };
    for (const [name, build] of Object.entries(complex)) {
      const n = build.length;
      RecurrenceRule['complex' + name] = (...a) => rule(...build(...a.slice(0, n)));
      RecurrenceRule['complex' + name + 'EndDate'] = (...a) => { const [f, i, x] = build(...a.slice(0, n)); return rule(f, i, { ...x, endDate: toMs(a[n]) }); };
      RecurrenceRule['complex' + name + 'OccurrenceCount'] = (...a) => { const [f, i, x] = build(...a.slice(0, n)); return rule(f, i, { ...x, occurrenceCount: a[n] }); };
    }
    global.RecurrenceRule = RecurrenceRule;

    class CalendarEvent {
      constructor(d = {}) {
        this.identifier = d.identifier || null;
        this.title = d.title || '';
        this.location = d.location || '';
        this.notes = d.notes || '';
        this.startDate = toDate(d.startDate) || new Date();
        this.endDate = toDate(d.endDate) || new Date(this.startDate.getTime() + 36e5);
        this.isAllDay = !!d.isAllDay;
        this.attendees = d.attendees || null;
        this.availability = d.availability || 'busy';
        this.timeZone = d.timeZone || null;
        this.calendar = d.calendar ? new Calendar(d.calendar) : null;
        this._rules = (d.recurrenceRules || []).map((r) => new RecurrenceRule(r));
      }
      addRecurrenceRule(recurrenceRule) { this._rules.push(recurrenceRule); }
      removeAllRecurrenceRules() { this._rules = []; }
      _spec() {
        return {
          identifier: this.identifier, title: this.title, location: this.location, notes: this.notes,
          startDate: toMs(this.startDate), endDate: toMs(this.endDate), isAllDay: this.isAllDay, availability: this.availability,
          timeZone: this.timeZone, calendar: this.calendar ? this.calendar.identifier : null, recurrenceRules: this._rules.map((r) => r._spec),
        };
      }
      save() { const d = callSync('cal.saveEvent', this._spec()); this.identifier = d.identifier; this.calendar = new Calendar(d.calendar); }
      remove() { if (this.identifier) callSync('cal.removeEvent', this.identifier); }
      async presentEdit() {
        const d = await callAsync('cal.presentEdit', [this._spec()]);
        return d ? new CalendarEvent(d) : this;
      }
      static async presentCreate() {
        const d = await callAsync('cal.presentEdit', [null]);
        return d ? new CalendarEvent(d) : null;
      }
      static async between(startDate, endDate, calendars) {
        const list = await callAsync('cal.events', [toMs(startDate), toMs(endDate), calendarIds(calendars)]);
        return list.map((d) => new CalendarEvent(d));
      }
      static today(calendars) { const [s, e] = dayBounds(0); return CalendarEvent.between(s, e, calendars); }
      static tomorrow(calendars) { const [s, e] = dayBounds(1); return CalendarEvent.between(s, e, calendars); }
      static yesterday(calendars) { const [s, e] = dayBounds(-1); return CalendarEvent.between(s, e, calendars); }
      static thisWeek(calendars) { const [s, e] = weekBounds(0); return CalendarEvent.between(s, e, calendars); }
      static nextWeek(calendars) { const [s, e] = weekBounds(1); return CalendarEvent.between(s, e, calendars); }
      static lastWeek(calendars) { const [s, e] = weekBounds(-1); return CalendarEvent.between(s, e, calendars); }
    }
    global.CalendarEvent = CalendarEvent;

    class Reminder {
      constructor(d = {}) {
        this.identifier = d.identifier || null;
        this.title = d.title || '';
        this.notes = d.notes || '';
        this.isCompleted = !!d.isCompleted;
        this.priority = d.priority || 0;
        this.dueDate = toDate(d.dueDate);
        this.dueDateIncludesTime = d.dueDateIncludesTime !== false;
        this._completionDate = toDate(d.completionDate);
        this._creationDate = toDate(d.creationDate);
        this.calendar = d.calendar ? new Calendar(d.calendar) : null;
        this._rules = (d.recurrenceRules || []).map((r) => new RecurrenceRule(r));
      }
      get completionDate() { return this._completionDate; }
      get creationDate() { return this._creationDate; }
      get isOverdue() {
        if (this.isCompleted || !this.dueDate) return false;
        if (this.dueDateIncludesTime) return this.dueDate.getTime() < Date.now();
        return this.dueDate.getTime() < dayBounds(0)[0].getTime();
      }
      addRecurrenceRule(recurrenceRule) { this._rules.push(recurrenceRule); }
      removeAllRecurrenceRules() { this._rules = []; }
      save() {
        const d = callSync('cal.saveReminder', {
          identifier: this.identifier, title: this.title, notes: this.notes, isCompleted: this.isCompleted, priority: this.priority,
          dueDate: toMs(this.dueDate), dueDateIncludesTime: this.dueDateIncludesTime,
          calendar: this.calendar ? this.calendar.identifier : null, recurrenceRules: this._rules.map((r) => r._spec),
        });
        this.identifier = d.identifier;
        this.calendar = new Calendar(d.calendar);
        this._completionDate = toDate(d.completionDate);
        this._creationDate = toDate(d.creationDate);
      }
      remove() { if (this.identifier) callSync('cal.removeReminder', this.identifier); }
      static async _fetch(calendars, filter) {
        const list = (await callAsync('cal.reminders', [calendarIds(calendars)])).map((d) => new Reminder(d));
        return filter ? list.filter(filter) : list;
      }
    }
    const inRange = (date, [s, e]) => !!date && date >= s && date < e;
    const reminderQueries = {
      all: () => true,
      allCompleted: (r) => r.isCompleted,
      allIncomplete: (r) => !r.isCompleted,
      scheduled: (r) => !r.isCompleted && !!r.dueDate && r.dueDate < dayBounds(0)[1],
    };
    const dueRanges = { Today: () => dayBounds(0), Tomorrow: () => dayBounds(1), Yesterday: () => dayBounds(-1), ThisWeek: () => weekBounds(0), NextWeek: () => weekBounds(1), LastWeek: () => weekBounds(-1) };
    for (const [name, range] of Object.entries(dueRanges)) {
      reminderQueries['allDue' + name] = (r) => inRange(r.dueDate, range());
      reminderQueries['completedDue' + name] = (r) => r.isCompleted && inRange(r.dueDate, range());
      reminderQueries['incompleteDue' + name] = (r) => !r.isCompleted && inRange(r.dueDate, range());
    }
    for (const name of ['Today', 'ThisWeek', 'LastWeek']) reminderQueries['completed' + name] = (r) => r.isCompleted && inRange(r.completionDate, dueRanges[name]());
    for (const [name, filter] of Object.entries(reminderQueries)) Reminder[name] = (calendars) => Reminder._fetch(calendars, filter);
    Reminder.allDueBetween = (s, e, calendars) => Reminder._fetch(calendars, (r) => inRange(r.dueDate, [s, e]));
    Reminder.completedDueBetween = (s, e, calendars) => Reminder._fetch(calendars, (r) => r.isCompleted && inRange(r.dueDate, [s, e]));
    Reminder.incompleteDueBetween = (s, e, calendars) => Reminder._fetch(calendars, (r) => !r.isCompleted && inRange(r.dueDate, [s, e]));
    Reminder.completedBetween = (s, e, calendars) => Reminder._fetch(calendars, (r) => r.isCompleted && inRange(r.completionDate, [s, e]));
    global.Reminder = Reminder;

    // ------------------------------------------------------------- contacts

    const CONTACT_STRINGS = ['namePrefix', 'givenName', 'middleName', 'familyName', 'nickname', 'organizationName', 'departmentName', 'jobTitle'];
    const CONTACT_LISTS = ['emailAddresses', 'phoneNumbers', 'postalAddresses', 'socialProfiles', 'urlAddresses', 'dates'];
    const contactOps = [];
    const newRef = () => callSync('crypto.uuid');

    class Contact {
      constructor(d = {}) {
        this.identifier = d.identifier || null;
        for (const f of CONTACT_STRINGS) this[f] = d[f] || '';
        for (const f of CONTACT_LISTS) this[f] = (d[f] || []).map((v) => (f === 'dates' ? { ...v, value: toDate(v.value) } : v));
        this.birthday = toDate(d.birthday);
        this.note = '';
        this._hasImage = !!d.isImageAvailable;
        this._image = undefined;
        this._imageChanged = false;
        this._ref = d.identifier || newRef();
        for (const f of [...CONTACT_STRINGS, ...CONTACT_LISTS, 'birthday', 'image']) this['is' + f[0].toUpperCase() + f.slice(1) + 'Available'] = true;
        // Contact notes need an entitlement that sideloaded apps cannot have.
        this.isNoteAvailable = false;
      }
      get image() {
        if (this._image === undefined) this._image = this._hasImage && this.identifier ? asImage(callSync('contacts.image', this.identifier)) : null;
        return this._image;
      }
      set image(v) { this._image = v; this._imageChanged = true; }
      _spec() {
        const s = { identifier: this.identifier, ref: this._ref, birthday: toMs(this.birthday) };
        for (const f of CONTACT_STRINGS) s[f] = this[f] || '';
        for (const f of CONTACT_LISTS) s[f] = (this[f] || []).map((v) => (f === 'dates' ? { ...v, value: toMs(v.value) } : v));
        if (this._imageChanged) s.image = this._image ? imageSpec(this._image) : '';
        return s;
      }
      static async all(containers) {
        const ids = containers && containers.length ? containers.map((c) => c.identifier) : null;
        return (await callAsync('contacts.fetch', [{ containers: ids }])).map((d) => new Contact(d));
      }
      static async inGroups(groups) {
        return (await callAsync('contacts.fetch', [{ groups: groups.map((g) => g.identifier) }])).map((d) => new Contact(d));
      }
      static add(contact, containerIdentifier) { contactOps.push({ op: 'add', target: contact, container: containerIdentifier || null }); }
      static update(contact) { contactOps.push({ op: 'update', target: contact }); }
      static delete(contact) { contactOps.push({ op: 'delete', target: contact }); }
      static async persistChanges() {
        const ops = contactOps.splice(0);
        if (!ops.length) return;
        const ids = await callAsync('contacts.persist', [ops.map((o) => ({
          op: o.op, container: o.container,
          item: o.target._spec(), member: o.member ? { identifier: o.member.identifier, ref: o.member._ref } : null,
        }))]);
        ops.forEach((o, i) => { if (ids[i]) o.target.identifier = ids[i]; });
      }
    }
    global.Contact = Contact;

    class ContactsContainer {
      constructor(d) { this.identifier = d.identifier; this.name = d.name; }
      static async default() { return new ContactsContainer(await callAsync('contacts.defaultContainer', [])); }
      static async all() { return (await callAsync('contacts.containers', [])).map((d) => new ContactsContainer(d)); }
      static async withIdentifier(identifier) {
        const c = (await ContactsContainer.all()).find((x) => x.identifier === identifier);
        if (!c) throw new Error(`No contacts container with identifier ${identifier}`);
        return c;
      }
    }
    global.ContactsContainer = ContactsContainer;

    class ContactsGroup {
      constructor(d = {}) { this.identifier = d.identifier || null; this.name = d.name || ''; this._ref = d.identifier || newRef(); }
      _spec() { return { identifier: this.identifier, ref: this._ref, name: this.name }; }
      addMember(contact) { contactOps.push({ op: 'addMember', target: this, member: contact }); }
      removeMember(contact) { contactOps.push({ op: 'removeMember', target: this, member: contact }); }
      static async all(containers) {
        const ids = containers && containers.length ? containers.map((c) => c.identifier) : null;
        return (await callAsync('contacts.groups', [ids])).map((d) => new ContactsGroup(d));
      }
      static add(group, containerIdentifier) { contactOps.push({ op: 'addGroup', target: group, container: containerIdentifier || null }); }
      static update(group) { contactOps.push({ op: 'updateGroup', target: group }); }
      static delete(group) { contactOps.push({ op: 'deleteGroup', target: group }); }
    }
    global.ContactsGroup = ContactsGroup;
  }
