import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
await build({ absWorkingDir: fileURLToPath(new URL('.', import.meta.url)), entryPoints: ['src/main.tsx'],
  bundle: true, platform: 'browser', format: 'esm', outfile: 'dist/app.js', jsx: 'automatic', minify: true });
await build({ absWorkingDir: fileURLToPath(new URL('.', import.meta.url)), entryPoints: ['src/style.css'], bundle: true, outfile: 'dist/app.css', minify: true });
await build({ absWorkingDir: fileURLToPath(new URL('.', import.meta.url)), entryPoints: ['src/theme-init.ts'], bundle: true, platform: 'browser', format: 'iife', outfile: 'dist/theme-init.js', minify: true });
await writeFile(new URL('./dist/index.html', import.meta.url), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QualityGate · Local workspace</title><script src="/theme-init.js"></script><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
