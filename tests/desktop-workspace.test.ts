import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_NAME, MAX_RECENTS, validateWorkspace, WorkspaceStore } from '../packages/desktop/src/workspace.js';

const temp = () => mkdtemp(join(tmpdir(), 'qg-desktop-ws-'));
async function project(name = 'app') {
  const dir = join(await temp(), name);
  await mkdir(dir);
  await writeFile(join(dir, CONFIG_NAME), JSON.stringify({ schemaVersion: 1, outputDir: 'out', gates: [{ id: 'ok', run: 'true' }] }));
  return dir;
}

test('a folder with a valid config is accepted and returned as its resolved real path', async () => {
  const dir = await project('my-app');
  const link = join(await temp(), 'link');
  await symlink(dir, link);
  const result = await validateWorkspace(link);
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.name, 'my-app'); assert.equal(result.path, await realpath(dir)); assert.equal(result.configPath, join(result.path, CONFIG_NAME)); }
});

test('validation refuses relative, missing, non-folder, config-less and invalid-config paths with a reason', async () => {
  const empty = await temp();
  const broken = await temp(); await writeFile(join(broken, CONFIG_NAME), 'gates: not-a-list');
  const file = join(empty, 'f.txt'); await writeFile(file, 'x');
  const asDir = await temp(); await mkdir(join(asDir, CONFIG_NAME));
  const cases: [string, RegExp][] = [['relative/path', /absolute/], ['', /absolute/], ['/tmp/\0x', /absolute/], [join(empty, 'missing'), /does not exist/], [file, /not a folder/],
    [empty, /No \.qualitygate\.yml/], [asDir, /No \.qualitygate\.yml/], [broken, /not valid/]];
  for (const [input, reason] of cases) {
    const result = await validateWorkspace(input);
    assert.equal(result.ok, false, input);
    if (!result.ok) assert.match(result.reason, reason);
  }
  const long = await validateWorkspace(broken, async () => { throw new Error('x'.repeat(500)); });
  assert.equal(long.ok === false && long.reason.length < 300, true);
  const text = await validateWorkspace(broken, async () => { throw 'plain'; });
  assert.equal(text.ok === false && /plain/.test(text.reason), true);
  assert.equal((await validateWorkspace(123 as unknown as string)).ok, false);
});

test('recents are newest first, de-duplicated and capped; preferences persist; the file is private', async () => {
  const dir = await temp(); const file = join(dir, 'data', 'workspaces.json');
  let tick = 0;
  const store = new WorkspaceStore(file, () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
  assert.deepEqual(await store.load(), { recents: [], prefs: { notifications: false }, recovered: false });
  for (let i = 0; i < MAX_RECENTS + 3; i++) await store.remember({ path: `/p/${i}`, name: `p${i}` });
  let recents = await store.remember({ path: '/p/5', name: 'p5' });
  assert.equal(recents.length, MAX_RECENTS);
  assert.deepEqual(recents.slice(0, 2).map(r => r.path), ['/p/5', '/p/12']);
  assert.equal(recents.filter(r => r.path === '/p/5').length, 1);
  assert.deepEqual(await store.setPrefs({ notifications: true }), { notifications: true });
  recents = await store.forget('/p/12');
  assert.equal(recents.some(r => r.path === '/p/12'), false);
  const again = await new WorkspaceStore(file).load();
  assert.equal(again.prefs.notifications, true); assert.equal(again.recents.length, MAX_RECENTS - 1);
  if (process.platform !== 'win32') { assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal((await stat(join(dir, 'data'))).mode & 0o777, 0o700); }
});

test('a damaged or unexpected file is moved aside and reported, never trusted', async () => {
  for (const content of ['{not json', JSON.stringify({ schemaVersion: 2, recents: [], prefs: { notifications: true } }), JSON.stringify({ schemaVersion: 1, recents: [{ path: 5 }], prefs: { notifications: true } })]) {
    const dir = await temp(); const file = join(dir, 'workspaces.json');
    await writeFile(file, content);
    const state = await new WorkspaceStore(file).load();
    assert.deepEqual(state, { recents: [], prefs: { notifications: false }, recovered: true });
    assert.equal(await readFile(`${file}.corrupt`, 'utf8'), content);
  }
});
