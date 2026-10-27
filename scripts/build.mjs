import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';
await build({entryPoints: ['packages/cli/src/index.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'dist/qualitygate.mjs'});
await chmod('dist/qualitygate.mjs', 0o755);
