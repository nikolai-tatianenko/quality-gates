import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { HOST_METHODS } from '../packages/desktop/src/host.js';

const root = new URL('../packages/desktop/', import.meta.url);
const repo = new URL('../', import.meta.url);
const read = (path: string, base = root) => readFile(new URL(path, base), 'utf8');

test('the Tauri config loads only the local launcher, with a strict CSP and no secrets', async () => {
  const config = JSON.parse(await read('src-tauri/tauri.conf.json'));
  assert.equal(config.build.frontendDist, '../dist/ui');
  assert.equal(config.build.devUrl, undefined, 'no remote dev server');
  assert.deepEqual(config.app.windows.map((w: { label: string }) => w.label), ['main']);
  const csp: string = config.app.security.csp;
  assert.match(csp, /^default-src 'self'; script-src 'self'; /);
  assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline|(^|\s)\*(\s|;|$)|https:\/\/|http:\/\/(?!ipc\.localhost)/);
  assert.match(csp, /frame-src 'none'/);
  const text = JSON.stringify(config);
  assert.doesNotMatch(text, /signingIdentity|certificateThumbprint|password|secret|\bkey\b/i, 'signing material comes from the environment, never from the repository');
  assert.equal(config.bundle.macOS.hardenedRuntime, true);
  assert.equal(config.plugins, undefined);
});

test('the shell has no shell, filesystem, opener or http plugin and the launcher gets only the folder dialog', async () => {
  const capability = JSON.parse(await read('src-tauri/capabilities/default.json'));
  assert.deepEqual(capability.windows, ['main']); assert.equal(capability.remote, undefined, 'the dashboard page is remote and gets nothing');
  assert.deepEqual([...capability.permissions].sort(), ['core:default', 'dialog:allow-open']);
  const cargo = await read('src-tauri/Cargo.toml');
  for (const plugin of ['shell', 'fs', 'opener', 'http', 'process', 'updater', 'global-shortcut']) assert.doesNotMatch(cargo, new RegExp(`tauri-plugin-${plugin}`), plugin);
  const rust = await read('src-tauri/src/main.rs');
  assert.equal(rust.match(/Command::new\(/g)?.length, 1, 'the only process the shell starts is the Node host');
  assert.match(rust, /Command::new\("node"\)/);
  assert.doesNotMatch(rust, /UNBUILT/, 'the shell compiles; the header must not claim otherwise');
});

test('the Rust method allow list equals the host method list', async () => {
  const rust = await read('src-tauri/src/main.rs');
  const block = /ALLOWED_METHODS: \[&str; (\d+)\] = \[([^\]]*)\]/.exec(rust);
  assert.ok(block);
  const listed = [...block[2]!.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(listed, [...HOST_METHODS]);
  assert.equal(Number(block[1]), HOST_METHODS.length);
});

test('the manual smoke-build workflow cannot run on push, uses no secrets and signs nothing', async () => {
  const workflow = (await read('.github/workflows/desktop-smoke.yml', repo)).replace(/\r\n/g, '\n').replace(/^#.*\n/gm, '');
  const triggers = /^on:\n((?:  .*\n)+)/m.exec(workflow)?.[1] ?? '';
  assert.equal(triggers.trim(), 'workflow_dispatch:');
  assert.doesNotMatch(workflow, /secrets\.|APPLE_|TAURI_SIGNING|CERTIFICATE|pull_request|push:|schedule:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /macos-latest, windows-latest/);
  assert.match(workflow, /cargo tauri build --debug/);
});

test('the build produces the launcher with no inline script, remote reference or eval, and a self-contained host', async () => {
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('build.mjs', root))]);
  const html = await read('dist/ui/index.html');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc="launcher\.js")|\son[a-z]+=|https?:\/\//);
  for (const file of ['launcher.js', 'launcher.css']) assert.ok((await stat(new URL(`dist/ui/${file}`, root))).size > 0, file);
  assert.doesNotMatch(await read('dist/ui/launcher.js'), /\beval\(|new Function\(|https?:\/\/(?!www\.w3\.org|react\.dev|reactjs\.org)/);
  assert.doesNotMatch(await read('dist/ui/launcher.css'), /https?:\/\//);
  const host = await read('dist/host.mjs');
  assert.doesNotMatch(host, /from ["'](zod|yaml)["']/, 'bundled, so the packaged app needs no node_modules for the host');
});

test('the placeholder icon is a PNG', async () => {
  const icon = await readFile(new URL('src-tauri/icons/icon.png', root));
  assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('the documentation labels what was not verified', async () => {
  for (const file of ['docs/DESKTOP.md', 'docs/DESKTOP_SIGNING.md']) {
    const text = await read(file, repo);
    assert.match(text, /unverified|not verified|never been built|unbuilt/i, file);
    assert.doesNotMatch(text, /APPLE_PASSWORD=[^\s<]|-----BEGIN|password:\s*\S/i, `${file} contains no secrets`);
  }
});
