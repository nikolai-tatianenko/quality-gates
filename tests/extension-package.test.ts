import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const root = new URL('../packages/chrome-extension/', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');

test('the manifest asks for the minimum: activeTab and storage, no host access, no scripts injected into pages', async () => {
  const manifest = JSON.parse(await read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'storage']);
  for (const key of ['host_permissions', 'optional_permissions', 'optional_host_permissions', 'content_scripts', 'background', 'web_accessible_resources', 'externally_connectable', 'devtools_page', 'commands', 'omnibox', 'update_url'])
    assert.equal(manifest[key], undefined, `${key} is not requested`);
  assert.deepEqual(manifest.action, { default_title: 'QualityGate', default_popup: 'popup.html' });
  const csp: string = manifest.content_security_policy.extension_pages;
  assert.match(csp, /^default-src 'none'; script-src 'self'; /);
  assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline|(^|\s)\*(\s|;|$)|https?:\/\/(?!127\.0\.0\.1)|wasm-unsafe-eval/);
  assert.match(csp, /connect-src http:\/\/127\.0\.0\.1:\*;/, 'the only network target is the local bridge');
  assert.match(csp, /frame-ancestors 'none'/);
});

test('the build produces a loadable folder: every file the manifest and popup reference exists, with no remote or eval-based code', async () => {
  await promisify(execFile)(process.execPath, [new URL('build.mjs', root).pathname]);
  const manifest = JSON.parse(await read('dist/manifest.json'));
  for (const file of [manifest.action.default_popup, ...Object.values<string>(manifest.icons), 'popup.js', 'popup.css']) assert.ok((await stat(new URL(`dist/${file}`, root))).size > 0, file);
  const html = await read('dist/popup.html');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc="popup\.js")|\son[a-z]+=|https?:\/\//, 'no inline script, handler or remote reference');
  const script = await read('dist/popup.js');
  assert.doesNotMatch(script, /\beval\(|new Function\(|importScripts|document\.write\(|chrome\.(scripting|webRequest|cookies|history|debugger)/);
  assert.doesNotMatch(await read('dist/popup.css'), /url\(\s*['"]?https?:/, 'no remote assets');
  for (const size of ['16', '48', '128']) assert.deepEqual([...(await readFile(new URL(`dist/icon-${size}.png`, root))).subarray(1, 4)], [80, 78, 71], 'valid PNG signature');
});
