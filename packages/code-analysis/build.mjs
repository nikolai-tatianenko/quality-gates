import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
await build({ entryPoints: ['src/index.ts', 'src/cli.ts'], outdir: 'dist', outExtension: { '.js': '.mjs' },
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  bundle: true, platform: 'node', format: 'esm', packages: 'external' });
await chmod(new URL('./dist/cli.mjs', import.meta.url), 0o755);
