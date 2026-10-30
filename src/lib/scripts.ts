import ScriptEngine, { type ScriptFile } from '../../modules/script-engine';

export type { ScriptFile };

export const listScripts = (): ScriptFile[] =>
  ScriptEngine.listScripts().sort((a, b) => b.modified - a.modified);

export const readScript = (name: string) => ScriptEngine.readScript(name);
export const writeScript = (name: string, content: string) => ScriptEngine.writeScript(name, content);
export const deleteScript = (name: string) => ScriptEngine.deleteScript(name);
export const renameScript = (from: string, to: string) => ScriptEngine.renameScript(from, to);
export const copyScript = (name: string) => ScriptEngine.copyScript(name);

export const isValidName = (name: string) => /^[^/\\:*?"<>|]+$/.test(name) && !name.startsWith('.');

// Every file but a .js script keeps its extension in its name.
const EXTENSION = /\.([jt]sx|py)$/i;

/** The file's type as the tile shows it: JS, JSX, TSX or PY. */
export const fileKind = (name: string) => (EXTENSION.exec(name)?.[1] ?? 'js').toUpperCase();

/** A .jsx/.tsx miniapp. */
export const isApp = (name: string) => /\.[jt]sx$/i.test(name);

/** A Python script. */
export const isPython = (name: string) => /\.py$/i.test(name);

/** The extension a name keeps (".jsx", ".py"), or "" for a .js script. */
export const extensionOf = (name: string) => EXTENSION.exec(name)?.[0] ?? '';

/** The name without its kept extension, as tiles and titles show it. */
export const displayName = (name: string) => name.slice(0, name.length - extensionOf(name).length);

/** The name a rename or copy of `from` gets: it keeps its extension unless `to` gives one. */
export function keepExtension(from: string, to: string) {
  const ext = extensionOf(from);
  return ext && !EXTENSION.test(to) ? `${to}${ext}` : to;
}

/** `base` + `ext` if free, otherwise "base 2", "base 3"… */
export function uniqueName(base: string, ext = ''): string {
  const taken = new Set(ScriptEngine.listScripts().map((s) => s.name));
  if (!taken.has(base + ext)) return base + ext;
  let i = 2;
  while (taken.has(`${base} ${i}${ext}`)) i++;
  return `${base} ${i}${ext}`;
}

const HEADER = /^(\/\/ Variables used by Scriptable\.\n)?(\/\/ These must be at the very top of the file\. Do not edit\.\n)?\/\/ icon-color:[^\n]*\n/;
const PYTHON_HEADER = /^# icon-color:[^\n]*\n/;

/** Writes Scriptable's color/glyph header, so the script keeps its look in Scriptable too. */
export function setAppearance(script: ScriptFile, look: { color?: string; glyph?: string }) {
  const color = look.color ?? script.color ?? 'blue';
  const glyph = look.glyph ?? script.glyph ?? 'code';
  // Python has no Scriptable to stay compatible with: just the line, as a # comment.
  if (isPython(script.name)) {
    const body = readScript(script.name).replace(PYTHON_HEADER, '');
    return writeScript(script.name, `# icon-color: ${color}; icon-glyph: ${glyph};\n${body}`);
  }
  const body = readScript(script.name).replace(HEADER, '');
  writeScript(
    script.name,
    `// Variables used by Scriptable.\n// These must be at the very top of the file. Do not edit.\n// icon-color: ${color}; icon-glyph: ${glyph};\n${body}`,
  );
}

export const NEW_SCRIPT = '';

export const NEW_PYTHON = `# icon-color: yellow; icon-glyph: code;
# Un script de Python: print() sale en la consola y la API de Scriptor se usa con await.
from scriptor import Device, alert

info = await Device.info()
print('Dispositivo:', info['model'], 'iOS', info['systemVersion'])

nombre = input('¿Cómo te llamas?')
await alert(f'Hola, {nombre} 👋')
`;
export { NEW_MINIAPP } from '@/miniapp/runtime';

const EXAMPLES: Record<string, string> = {
  Bienvenida: `// icon-color: deep-purple; icon-glyph: magic;
// Un recorrido rápido por lo que puede hacer Scriptor.
const info = Device.info();
console.log('Dispositivo:', info.model, 'iOS', info.systemVersion);
console.log('Batería:', Math.round(info.battery * 100) + '%', info.batteryState);

// JS moderno: temporizadores, URL, crypto, TextEncoder...
await sleep(200);
const url = new URL('https://example.com/buscar?q=hola');
url.searchParams.set('page', 2);
console.log(url.href);
console.log('sha256("hola") =', Crypto.hash('sha256', 'hola'));

// Archivos: Documents se ve en la app Archivos.
FS.writeJSON('ejemplo/datos.json', { creado: new Date() });
console.log(FS.list('ejemplo'));

const nombre = await prompt('¿Cómo te llamas?');
if (nombre) await alert('Hola, ' + nombre + ' 👋');
`,
  'Guardar video en carrete': `// icon-color: blue; icon-glyph: download;
// Descarga un vídeo en streaming (sin cargarlo en memoria) y lo guarda en Fotos.
const url = await prompt('URL del vídeo (.mp4)', 'https://download.samplelib.com/mp4/sample-5s.mp4');
if (!url) return;

const file = await Net.download(url, 'Descargas/video.mp4', {
  onProgress: (p) => p.total > 0 && console.log('Descargado', Math.round((p.loaded / p.total) * 100) + '%'),
});
console.log('Guardado en', file.path, (file.size / 1e6).toFixed(1), 'MB');

const id = await Photos.save(file.path, { album: 'Scriptor' });
console.log('En el carrete con id', id);
UI.haptic('success');
`,
  'Comprimir video': `// icon-color: orange; icon-glyph: video;
// Elige un vídeo, lo comprime a 720p y lo guarda en el carrete.
const [video] = await Photos.pick({ type: 'video' });
if (!video) return;

const before = await Video.info(video.path);
console.log('Original:', before.width + 'x' + before.height, (before.size / 1e6).toFixed(1), 'MB');

const out = await Video.export(video.path, {
  quality: '720p',
  onProgress: (e) => console.log(Math.round(e.progress * 100) + '%'),
});
const after = await Video.info(out);
console.log('Comprimido:', (after.size / 1e6).toFixed(1), 'MB');

if (await confirm('¿Guardar en el carrete?')) await Photos.save(out);
`,
};

/** Adds the example scripts the first time the app opens with an empty folder. */
export function seedExamples() {
  if (ScriptEngine.listScripts().length > 0) return;
  for (const [name, code] of Object.entries(EXAMPLES)) writeScript(name, code);
}
