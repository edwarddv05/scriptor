import { transform } from 'sucrase';
import { parse } from 'sucrase/dist/parser';
import { TokenType as tt } from 'sucrase/dist/parser/tokenizer/types';

// Miniapps are .jsx and .tsx files next to the .js scripts. Each one is transpiled on the
// device (JSX, types and import/export become plain calls) and runs in the app's React
// runtime with the miniapp API as its scope. What it returns is drawn with SwiftUI views.

export type MiniappMeta = { title: string; icon: string; color: string | null };

export class MiniappError extends Error {
  line: number | null;
  constructor(message: string, line: number | null = null) {
    super(message);
    this.name = 'MiniappError';
    this.line = line;
  }
}

export const isMiniapp = (name: string) => /\.[jt]sx$/i.test(name);
export const isTypeScript = (name: string) => /\.tsx$/i.test(name);
export const baseName = (name: string) => name.replace(/\.([jt]sx?)$/i, '');
/** Files starting with "_" are modules other files import; they open in the editor instead of running. */
export const isModule = (name: string) => name.startsWith('_');

function errorLine(error: unknown): number | null {
  const loc = (error as { loc?: { line?: unknown } })?.loc;
  if (typeof loc?.line === 'number') return loc.line;
  // Sucrase ends its messages with "(line:column)"; Hermes starts with "line:column:".
  const message = error instanceof Error ? error.message : '';
  const match = /\((\d+):\d+\)\s*$/.exec(message) ?? /^(\d+):\d+:/.exec(message);
  return match ? Number(match[1]) : null;
}

/**
 * JSX, types and modules to plain JavaScript. Line numbers are kept, so errors point at
 * the file. Loops get a guard that stops one running away (`guard` is off for packages).
 */
export function compile(source: string, options: { typescript?: boolean; guard?: boolean } = {}) {
  let code: string;
  try {
    code = transform(source, {
      transforms: options.typescript ? ['jsx', 'imports', 'typescript'] : ['jsx', 'imports'],
      jsxPragma: 'h',
      jsxFragmentPragma: 'Fragment',
      production: true,
    }).code;
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/\s*\(\d+:\d+\)\s*$/, '') : String(error);
    throw new MiniappError(message, errorLine(error));
  }
  // Sucrase only rewrites JSX and modules; the engine's own parser catches the rest
  // (a stray quote, a missing bracket) without running anything.
  try {
    new Function('exports', 'module', 'require', code);
  } catch (error) {
    throw new MiniappError(error instanceof Error ? error.message.replace(/^\d+:\d+:\s*/, '') : String(error), errorLine(error));
  }
  if (options.guard === false) return code;
  try {
    return guardLoops(code);
  } catch {
    // Code the engine accepts but the tokenizer does not runs unguarded.
    return code;
  }
}

// The iOS keyboard turns quotes into curly ones, "--" into a dash and "..." into an ellipsis.
export const plainPunctuation = (source: string) =>
  source.replace(/[“”„]/g, '"').replace(/[‘’‚]/g, "'").replace(/—/g, '--').replace(/…/g, '...');

/** Compiles a miniapp file; if only the keyboard's punctuation breaks it, the plain text is compiled. */
export function compileFile(source: string, fileName: string) {
  const options = { typescript: isTypeScript(fileName) };
  try {
    return compile(source, options);
  } catch (error) {
    const plain = plainPunctuation(source);
    if (plain === source) throw error;
    try {
      return compile(plain, options);
    } catch {
      throw error;
    }
  }
}

// ─── Runaway loops ─────────────────────────────────────────────────────────

export const LOOP_GUARD = '__miniappLoop';

/**
 * Puts a call to the loop guard in the condition of every while, do…while and three-part
 * for loop, with the loop's line. Nothing goes on new lines, so line numbers still match.
 * for…of and for…in end on their own.
 */
export function guardLoops(code: string) {
  const { tokens } = parse(code, false, false, false);
  const lineStarts = [0];
  for (let index = 0; index < code.length; index++) if (code[index] === '\n') lineStarts.push(index + 1);
  const lineAt = (position: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= position) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const opens = new Set([tt.parenL, tt.bracketL, tt.braceL, tt.dollarBraceL]);
  const closes = new Set([tt.parenR, tt.bracketR, tt.braceR]);
  const matching = (open: number) => {
    let depth = 0;
    for (let index = open; index < tokens.length; index++) {
      if (opens.has(tokens[index].type)) depth++;
      else if (closes.has(tokens[index].type) && --depth === 0) return index;
    }
    return -1;
  };
  const edits: [number, string][] = [];
  for (let index = 0; index < tokens.length - 1; index++) {
    const kind = tokens[index].type;
    if ((kind !== tt._while && kind !== tt._for) || tokens[index + 1].type !== tt.parenL) continue;
    const end = matching(index + 1);
    if (end < 0) continue;
    const call = `${LOOP_GUARD}(${lineAt(tokens[index].start)})`;
    if (kind === tt._while) {
      edits.push([tokens[index + 1].end, `${call} && (`], [tokens[end].start, ')']);
      continue;
    }
    const semis: number[] = [];
    let depth = 0;
    for (let inner = index + 1; inner <= end; inner++) {
      const type = tokens[inner].type;
      if (opens.has(type)) depth++;
      else if (closes.has(type)) depth--;
      else if (type === tt.semi && depth === 1) semis.push(inner);
    }
    if (semis.length !== 2) continue;
    const [first, second] = semis;
    if (second === first + 1) edits.push([tokens[first].end, ` ${call}`]);
    else edits.push([tokens[first + 1].start, `${call} && (`], [tokens[second].start, ')']);
  }
  edits.sort((a, b) => b[0] - a[0]);
  let result = code;
  for (const [position, text] of edits) result = result.slice(0, position) + text + result.slice(position);
  return result;
}

/**
 * The guard compiled loops call. A loop that keeps the app busy longer than `limitMs`
 * without letting it draw is stopped with an error on its line. The clock restarts each
 * time the app gets a turn.
 */
export function createLoopGuard(limitMs = 3000) {
  let armed = false;
  let start = 0;
  let count = 0;
  return (line: number) => {
    if (!armed) {
      armed = true;
      start = Date.now();
      count = 0;
      setTimeout(() => {
        armed = false;
      }, 0);
    }
    if ((++count & 1023) === 0 && Date.now() - start > limitMs) {
      throw new MiniappError(`Un bucle siguió más de ${Math.round(limitMs / 1000)} s sin terminar y se detuvo.`, line);
    }
    return true;
  };
}

// ─── Running ───────────────────────────────────────────────────────────────

export type MiniappExports = { default?: unknown; meta?: unknown; [key: string]: unknown };

/**
 * Compiled modules a file imports, by id: their code, whether they run with the miniapp's
 * scope (the owner's files) or bare (downloaded packages), and where each import points.
 */
export type ModuleTable = Record<string, { code: string; scoped: boolean; requests: Record<string, string> }>;

/** Runs compiled code with `scope` as its globals; require() serves `modules`, then the files in `table`. */
export function evaluate(code: string, scope: Record<string, unknown>, modules: Record<string, unknown>, table: ModuleTable, requests: Record<string, string>) {
  const loaded = new Map<string, { exports: MiniappExports }>();
  const makeRequire = (paths: Record<string, string>) => (request: string) => {
    if (request in modules) return modules[request];
    const id = paths[request];
    if (id === undefined || !table[id]) throw new MiniappError(`El módulo "${request}" no está disponible.`);
    const cached = loaded.get(id);
    if (cached) return cached.exports;
    const module = { exports: {} as MiniappExports };
    // Cached before it runs, so two modules that import each other still load.
    loaded.set(id, module);
    run(table[id].code, table[id].scoped ? scope : {}, module, makeRequire(table[id].requests), id);
    return module.exports;
  };
  const main = { exports: {} as MiniappExports };
  run(code, scope, main, makeRequire(requests), null);
  return main.exports;
}

function run(code: string, scope: Record<string, unknown>, module: { exports: MiniappExports }, require: (request: string) => unknown, id: string | null) {
  const names = Object.keys(scope);
  const where = (message: string) => (id ? `${id.replace(/^local:/, '')}: ${message}` : message);
  let body: (...args: unknown[]) => void;
  try {
    // The code runs in an inner function on the same first line, so its own declarations may
    // reuse a scope name (a local Row) and lines still match.
    body = new Function(...names, 'exports', 'module', 'require', `(function () {${code}\n})();`) as typeof body;
  } catch (error) {
    throw new MiniappError(where(error instanceof Error ? error.message : String(error)), id ? null : errorLine(error));
  }
  try {
    body(...names.map((name) => scope[name]), module.exports, module, require);
  } catch (error) {
    if (error instanceof MiniappError) throw error;
    throw new MiniappError(where(error instanceof Error ? error.message : String(error)));
  }
}

export function appComponent(exports: MiniappExports) {
  if (typeof exports.default !== 'function') throw new MiniappError('El archivo no tiene "export default function".');
  return exports.default as (props: Record<string, never>) => unknown;
}

/** `export const meta = { title, icon, color }`, with the file name as title when absent. */
export function readMeta(exports: MiniappExports | null, fileName: string): MiniappMeta {
  const meta = (exports?.meta && typeof exports.meta === 'object' ? exports.meta : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return { title: text(meta.title) ?? baseName(fileName), icon: text(meta.icon) ?? 'app', color: text(meta.color) };
}

// ─── Imports ───────────────────────────────────────────────────────────────

/** Every path the compiled code passes to require(), in order, once each. */
export function moduleRequests(code: string) {
  const found = new Set<string>();
  for (const match of code.matchAll(/\brequire\(\s*(['"])([^'"\n]+)\1\s*\)/g)) found.add(match[2]);
  return [...found];
}

/** The owner's file an import like "./_fechas" names, with or without its extension. */
export function resolveLocalModule(request: string, files: string[]) {
  if (!request.startsWith('./') || request.slice(2).includes('/')) return null;
  const wanted = request.slice(2).toLowerCase();
  return files.find((file) => file.toLowerCase() === wanted) ?? files.find((file) => baseName(file).toLowerCase() === wanted) ?? null;
}

/**
 * Where a package or URL import is downloaded from: "dayjs", "npm:dayjs@1.11" and
 * "dayjs/plugin/utc" come from esm.sh, built for older engines; a path inside a downloaded
 * file is resolved against that file's URL.
 */
export function packageUrl(request: string, base: string | null) {
  if (/^https:\/\//i.test(request)) return request;
  if (base && /^https:\/\//i.test(base)) {
    const origin = /^https:\/\/[^/]+/i.exec(base)![0];
    if (request.startsWith('/')) return `${origin}${request}`;
    if (request.startsWith('./') || request.startsWith('../')) {
      const parts = base.slice(origin.length).split('?')[0].split('/').slice(0, -1);
      for (const part of request.split('/')) {
        if (part === '..') parts.pop();
        else if (part !== '.') parts.push(part);
      }
      return `${origin}${parts.join('/')}`;
    }
  }
  const spec = request.replace(/^npm:/, '');
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*-]+)?(\/[\w./-]*)?$/i.test(spec)) return null;
  return `https://esm.sh/${spec}?bundle&target=es2015`;
}

/** jsDelivr's copy of a package import, tried only when esm.sh fails. Null for paths inside a downloaded file. */
export function packageFallbackUrl(request: string) {
  if (/^(https:|\/|\.)/i.test(request)) return null;
  const spec = request.replace(/^npm:/, '');
  return packageUrl(spec, null) ? `https://cdn.jsdelivr.net/npm/${spec}/+esm` : null;
}

/** Log lines a miniapp writes with console.*: one string per call, objects as JSON. */
export function formatLog(args: unknown[]) {
  return args
    .map((value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      if (value === undefined) return 'undefined';
      if (typeof value === 'function') return `[función ${value.name || 'anónima'}]`;
      try {
        const text = JSON.stringify(value, null, 2);
        return text === undefined ? String(value) : text;
      } catch {
        return String(value);
      }
    })
    .join(' ');
}

export const NEW_MINIAPP = `// icon-color: deep-purple; icon-glyph: magic;
// Una miniapp: React con vistas nativas de SwiftUI y Liquid Glass.
export default function App() {
  const [count, setCount] = useStored('count', 0);

  return (
    <VStack spacing={24} fill maxHeight={Infinity} alignment="center">
      <Text style="largeTitle" weight="bold" mono>{count}</Text>
      <HStack spacing={12}>
        <IconButton icon="minus" label="Restar" onPress={() => setCount(count - 1)} />
        <IconButton icon="plus" label="Sumar" prominent onPress={() => setCount(count + 1)} />
      </HStack>
      <Button title="Info del dispositivo" style="glass" onPress={async () => {
        const info = await Device.info();
        await alert(info.model + ' · iOS ' + info.systemVersion);
      }} />
    </VStack>
  );
}
`;
