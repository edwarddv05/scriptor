  // ----------------------------------------------------------- Native views
  // UI.view(state, render): interfaces made of SwiftUI controls (Liquid Glass on iOS 26).
  // render(state) returns a tree of nodes; the tree goes to native as a description, control
  // events come back by handler id, and every change to the state sends a new tree.
  // Inlined into prelude.js after scriptable.js, so it shares the prelude's scope.
  {
    class ViewNode {
      constructor(type, props = {}, children = []) {
        this._type = type;
        this._props = props;
        this._children = children;
        this._mods = [];
        this._id = null;
      }
      _mod(name, ...args) { this._mods.push([name, ...args]); return this; }
      /** Stable identity among its siblings (for lists whose items move). */
      id(value) { this._id = String(value); return this; }
      padding(value) { return this._mod('padding', value === undefined ? null : value); }
      frame(opts) { return this._mod('frame', opts || {}); }
      font(font) { return this._mod('font', font); }
      fontWeight(weight) { return this._mod('fontWeight', weight); }
      foregroundStyle(style) { return this._mod('foregroundStyle', style); }
      foregroundColor(color) { return this._mod('foregroundStyle', color); }
      background(style, cornerRadius) { return this._mod('background', style, cornerRadius === undefined ? null : cornerRadius); }
      tint(color) { return this._mod('tint', color); }
      cornerRadius(radius) { return this._mod('cornerRadius', radius); }
      opacity(value) { return this._mod('opacity', value); }
      shadow(radius = 8, opts = {}) { return this._mod('shadow', radius, opts); }
      /** Liquid Glass behind the view: { tint, interactive, shape: 'capsule'|'circle'|'rect', cornerRadius, clear }. */
      glassEffect(opts = {}) { return this._mod('glassEffect', opts); }
      /** Style of the controls inside: button, picker, toggle, text field, date picker, progress or list style. */
      style(name) { return this._mod('style', String(name)); }
      disabled(value = true) { return this._mod('disabled', !!value); }
      lineLimit(lines) { return this._mod('lineLimit', lines); }
      multilineTextAlignment(alignment) { return this._mod('multilineTextAlignment', alignment); }
      controlSize(size) { return this._mod('controlSize', size); }
      onTapGesture(fn) { return this._mod('onTapGesture', fn); }
      ignoresSafeArea() { return this._mod('ignoresSafeArea'); }
      scrollContentBackground(visibility) { return this._mod('scrollContentBackground', visibility); }
      aspectRatio(mode = 'fit') { return this._mod('aspectRatio', mode); }
      /** Images: stretch to the frame instead of keeping their own size. */
      resizable() { this._props.resizable = true; return this; }
      /** Shapes: fill with a color, gradient or material. */
      fill(style) { this._props.fill = style; return this; }
    }

    // Containers take (children) or (options, children).
    const container = (type) => (opts, children) => {
      if (Array.isArray(opts)) [opts, children] = [{}, opts];
      return new ViewNode(type, opts || {}, children || []);
    };
    const labelProps = (label) => (label && typeof label === 'object' ? { ...label } : { title: label == null ? '' : String(label) });
    const range = (opts, min, max) => ({ min: opts.min == null ? min : Number(opts.min), max: opts.max == null ? max : Number(opts.max), step: opts.step == null ? null : Number(opts.step) });
    const toMs = (d) => (d instanceof Date ? d.getTime() : d == null ? null : new Date(d).getTime());

    const components = {
      VStack: container('VStack'),
      HStack: container('HStack'),
      ZStack: container('ZStack'),
      ScrollView: container('ScrollView'),
      List: container('List'),
      Form: container('Form'),
      GlassEffectContainer: container('GlassEffectContainer'),
      /** Section('Header', children) or Section({ header, footer }, children). */
      Section: (opts, children) => {
        if (Array.isArray(opts)) [opts, children] = [{}, opts];
        if (typeof opts === 'string') opts = { header: opts };
        return new ViewNode('Section', opts || {}, children || []);
      },
      Text: (text) => new ViewNode('Text', { text: text == null ? '' : String(text) }),
      Label: (title, systemImage) => new ViewNode('Label', { title: String(title), systemImage }),
      /** An SF Symbol name, or an Image / file path. */
      Image: (source) =>
        typeof source === 'string' && !source.includes('/') && !/\.(png|jpe?g|gif|heic|webp)$/i.test(source) ? new ViewNode('Image', { system: source }) : new ViewNode('Image', { path: source }),
      /** Button('Title', fn) or Button({ title, systemImage, role: 'destructive'|'cancel' }, fn). */
      Button: (label, action) => new ViewNode('Button', { ...labelProps(label), action }),
      /** Menu('Title' | { title, systemImage }, [Button…]). */
      Menu: (label, children) => new ViewNode('Menu', labelProps(label), children || []),
      Toggle: (title, isOn, onChange) => new ViewNode('Toggle', { title: String(title), isOn: !!isOn, onChange }),
      /** Slider(value, { min, max, step }, onChange) or Slider(value, onChange) for 0…1. */
      Slider: (value, opts, onChange) => {
        if (typeof opts === 'function') [opts, onChange] = [{}, opts];
        return new ViewNode('Slider', { value: Number(value) || 0, ...range(opts || {}, 0, 1), onChange });
      },
      /** Stepper(title, value, { min, max, step }, onChange) or Stepper(title, value, onChange). */
      Stepper: (title, value, opts, onChange) => {
        if (typeof opts === 'function') [opts, onChange] = [{}, opts];
        const r = range(opts || {}, -Infinity, Infinity);
        return new ViewNode('Stepper', { title: String(title), value: Number(value) || 0, ...r, step: r.step || 1, onChange });
      },
      /** Picker(title, selected, options, onChange). Options are values or { label, value, systemImage }. */
      Picker: (title, selection, options, onChange) => {
        const opts = (options || []).map((o) => (o && typeof o === 'object' ? { label: String(o.label ?? o.value), value: o.value, systemImage: o.systemImage } : { label: String(o), value: o }));
        return new ViewNode('Picker', {
          title: String(title),
          selection: opts.findIndex((o) => o.value === selection),
          options: opts.map((o) => ({ label: o.label, systemImage: o.systemImage })),
          onChange: (i) => onChange && opts[i] && onChange(opts[i].value),
        });
      },
      /** TextField(placeholder, text, onChange, { onSubmit, keyboard, multiline }). */
      TextField: (placeholder, text, onChange, opts = {}) =>
        new ViewNode('TextField', { ...opts, placeholder: String(placeholder ?? ''), text: text == null ? '' : String(text), onChange }),
      SecureField: (placeholder, text, onChange, opts = {}) =>
        new ViewNode('TextField', { ...opts, secure: true, placeholder: String(placeholder ?? ''), text: text == null ? '' : String(text), onChange }),
      /** DatePicker(title, date, onChange, { mode: 'date'|'time'|'dateTime', min, max }). */
      DatePicker: (title, date, onChange, opts = {}) =>
        new ViewNode('DatePicker', {
          title: String(title), date: toMs(date) ?? Date.now(), mode: opts.mode || 'dateTime', min: toMs(opts.min), max: toMs(opts.max),
          onChange: (ms) => onChange && onChange(new Date(ms)),
        }),
      /** ProgressView() spins; ProgressView(value, { total, label }) fills. */
      ProgressView: (value, opts = {}) => new ViewNode('ProgressView', { value: value == null ? null : Number(value), total: Number(opts.total) || 1, label: opts.label }),
      Spacer: (minLength) => new ViewNode('Spacer', { minLength: minLength == null ? null : Number(minLength) }),
      Divider: () => new ViewNode('Divider'),
      Rectangle: () => new ViewNode('Shape', { shape: 'rect' }),
      RoundedRectangle: (cornerRadius = 12) => new ViewNode('Shape', { shape: 'rect', cornerRadius: Number(cornerRadius) }),
      Circle: () => new ViewNode('Shape', { shape: 'circle' }),
      Capsule: () => new ViewNode('Shape', { shape: 'capsule' }),
    };

    /** Encodes a prop or modifier argument for the bridge. */
    function encodeValue(v) {
      if (v === Infinity) return 'infinity';
      if (v === -Infinity) return '-infinity';
      if (v == null || typeof v !== 'object') return v;
      if (v instanceof Date) return v.getTime();
      if (v instanceof global.Color) return v._spec();
      if (v instanceof global.Font) return v._spec;
      if (v instanceof global.Image) return v._path;
      if (v instanceof global.LinearGradient) {
        return { gradient: { colors: v.colors.map(encodeValue), locations: v.locations, start: [v.startPoint.x, v.startPoint.y], end: [v.endPoint.x, v.endPoint.y] } };
      }
      if (Array.isArray(v)) return v.map(encodeValue);
      const out = {};
      for (const k of Object.keys(v)) out[k] = encodeValue(v[k]);
      return out;
    }

    class NativeView {
      constructor(state, render) {
        if (typeof state === 'function') [state, render] = [{}, state];
        this._render = render;
        this._handlers = new Map();
        this._id = null;
        this._scheduled = false;
        // Number of the last control event handled; native keeps the user's value on a control
        // until a tree built after that event arrives.
        this._ack = 0;
        this.state = new Proxy(state || {}, {
          set: (target, key, value) => { target[key] = value; this.update(); return true; },
          deleteProperty: (target, key) => { delete target[key]; this.update(); return true; },
        });
      }

      _spec() {
        this._handlers = new Map();
        let tree;
        try {
          tree = this._render(this.state);
        } catch (e) {
          console.error(e);
          tree = components.Text(String(e && e.message ? e.message : e)).foregroundStyle('red').padding();
        }
        const root = tree instanceof ViewNode ? tree : components.Text(tree == null ? '' : tree);
        return { ...this._encode(root, '0'), ack: this._ack };
      }

      _encode(node, key) {
        const handler = (name, fn) => {
          const id = `${key}:${name}`;
          this._handlers.set(id, fn);
          return id;
        };
        const props = {};
        for (const [k, v] of Object.entries(node._props)) props[k] = typeof v === 'function' ? handler(k, v) : encodeValue(v);
        const mods = node._mods.map(([name, ...args], i) => [name, ...args.map((a) => (typeof a === 'function' ? handler('m' + i, a) : encodeValue(a)))]);
        const children = [];
        // Keys follow positions before nulls are dropped, so a view that appears or disappears
        // does not shift the identity (and handlers) of its siblings.
        const walk = (list, prefix) => list.forEach((child, i) => {
          if (Array.isArray(child)) return walk(child, `${prefix}.${i}`);
          if (child == null || child === false || child === true) return;
          if (!(child instanceof ViewNode)) child = components.Text(child);
          children.push(this._encode(child, child._id !== null ? `${key}#${child._id}` : `${prefix}.${i}`));
        });
        walk(node._children, key);
        return { key, type: node._type, props, mods, children };
      }

      _event(e) {
        if (e.seq) this._ack = e.seq;
        const fn = this._handlers.get(e.handler);
        if (fn) fn(e.value);
        // Handlers may change nested objects the state proxy cannot see.
        this.update();
      }

      /** Redraws from the current state. Changes to `state` call this on their own. */
      update() {
        if (this._id === null || this._scheduled) return;
        this._scheduled = true;
        queueMicrotask(() => {
          this._scheduled = false;
          if (this._id !== null) callSync('nview.update', this._id, this._spec());
        });
      }

      /** Shows the view. Options: { title, fullscreen, background }. Resolves when it is closed. */
      present(opts = {}) {
        const options = { title: opts.title == null ? null : String(opts.title), fullscreen: !!opts.fullscreen, background: encodeValue(opts.background) };
        const { id, promise } = callAsyncWithId('nview.present', [this._spec(), options], (e) => this._event(e));
        this._id = id;
        return promise.then(() => { this._id = null; });
      }

      close() { if (this._id !== null) callSync('nview.close', this._id); }
    }

    global.UI.view = (state, render) => new NativeView(state, render);
    /** A gradient for background(), fill() and the present() background: colors from start to end. */
    global.UI.gradient = (colors, start = 'top', end = 'bottom') => ({ gradient: { colors: colors.map(encodeValue), start, end } });
    Object.assign(global.UI, components);
    // Also as globals, except where a name is taken (Image and DatePicker are Scriptable classes).
    for (const [name, fn] of Object.entries(components)) if (!(name in global)) global[name] = fn;
  }
