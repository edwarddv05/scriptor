import ScriptEngine, { type ScriptFile } from '../../modules/script-engine';

export type { ScriptFile };

export const listScripts = (): ScriptFile[] =>
  ScriptEngine.listScripts().sort((a, b) => b.modified - a.modified);

export const readScript = (name: string) => ScriptEngine.readScript(name);
export const writeScript = (name: string, content: string) => ScriptEngine.writeScript(name, content);
export const deleteScript = (name: string) => ScriptEngine.deleteScript(name);
export const renameScript = (from: string, to: string) => ScriptEngine.renameScript(from, to);

export const isValidName = (name: string) => /^[^/\\:*?"<>|]+$/.test(name) && !name.startsWith('.');

export function uniqueName(base: string): string {
  const taken = new Set(ScriptEngine.listScripts().map((s) => s.name));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

const HEADER = /^(\/\/ Variables used by Scriptable\.\n)?(\/\/ These must be at the very top of the file\. Do not edit\.\n)?\/\/ icon-color:[^\n]*\n/;

/** Writes Scriptable's color/glyph header, so the script keeps its look in Scriptable too. */
export function setAppearance(script: ScriptFile, look: { color?: string; glyph?: string }) {
  const color = look.color ?? script.color ?? 'blue';
  const glyph = look.glyph ?? script.glyph ?? 'code';
  const body = readScript(script.name).replace(HEADER, '');
  writeScript(
    script.name,
    `// Variables used by Scriptable.\n// These must be at the very top of the file. Do not edit.\n// icon-color: ${color}; icon-glyph: ${glyph};\n${body}`,
  );
}

export const NEW_SCRIPT = `// Escribe tu script aquí. Puedes usar await y return en el nivel superior.
const res = await fetch('https://httpbin.org/json');
const data = await res.json();
console.log(data);
`;

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
