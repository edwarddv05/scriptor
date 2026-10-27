// Assembles the runtime source: prelude.js with each `// @include file.js` line replaced by that file.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const jsDir = fileURLToPath(new URL('../modules/script-engine/js/', import.meta.url));

export function preludeSource() {
  return readFileSync(jsDir + 'prelude.js', 'utf8').replace(/^ *\/\/ @include (\S+)$/gm, (_, file) =>
    readFileSync(jsDir + file, 'utf8')
  );
}
