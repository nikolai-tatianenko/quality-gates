import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Output: dist/ui (the Tauri frontendDist: launcher page only) and dist/host.mjs (the Node host the shell starts).
const root = fileURLToPath(new URL('.', import.meta.url));
const options = { absWorkingDir: root, bundle: true, minify: true, legalComments: 'none' };
await mkdir(`${root}dist/ui`, { recursive: true });
await build({ ...options, entryPoints: { launcher: 'src/ui/main.tsx' }, platform: 'browser', format: 'iife', outdir: 'dist/ui', jsx: 'automatic' });
await build({ ...options, entryPoints: { launcher: 'src/ui/launcher.css' }, outdir: 'dist/ui' });
await copyFile(`${root}src/ui/index.html`, `${root}dist/ui/index.html`);
await build({ ...options, entryPoints: { host: 'src/host-bin.ts' }, platform: 'node', format: 'esm', outdir: 'dist', outExtension: { '.js': '.mjs' }, banner: { js: "import { createRequire as __qgRequire } from 'node:module'; const require = __qgRequire(import.meta.url);" }, minify: false });
