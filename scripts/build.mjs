import { build } from 'esbuild';
import { chmod, readFile } from 'node:fs/promises';
const { dependencies } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
/** The Ink screen is a separate file so the plain commands never load it; the CLI imports it lazily from next to itself. */
const lazyUi = { name: 'lazy-ui', setup(b) { b.onResolve({ filter: /ink-ui\/src\/index\.js$/ }, () => ({ path: './qualitygate-ui.mjs', external: true })); } };
await build({entryPoints: ['packages/cli/src/index.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'dist/qualitygate.mjs', plugins: [lazyUi]});
await chmod('dist/qualitygate.mjs', 0o755);

// Ink, React and their dependencies are bundled in, so the published package gains no runtime dependency for `qualitygate ui`.
// CommonJS dependencies (signal-exit, stack-utils) need `require`. react-devtools-core is only used when DEV=true and is not shipped:
// it is replaced by an empty module, because a static import of a missing package would stop the screen from loading.
const noDevtools = { name: 'no-devtools', setup(b) { b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'empty' })); b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: 'export default {};' })); } };
await build({entryPoints: ['packages/ink-ui/src/index.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'dist/qualitygate-ui.mjs', jsx: 'automatic',
  plugins: [noDevtools], external: Object.keys(dependencies).flatMap(name => [name, `${name}/*`]), minify: true,
  banner: { js: "import { createRequire as __qgRequire } from 'node:module'; const require = __qgRequire(import.meta.url);" } });

await build({entryPoints: ['packages/plugins/lighthouse/src/worker.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'dist/lighthouse-worker.mjs'});
await import('../packages/code-analysis/build.mjs');
await import('../packages/dashboard/build.mjs');
await import("../packages/chrome-extension/build.mjs");
await import("../packages/desktop/build.mjs");
