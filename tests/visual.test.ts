import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVisual, readVisualImage, VisualImageError } from '../packages/core/src/visual.js';
import { png, RUN_ID, writeVisualRun } from './support/visual.js';

async function withOutput(body: (out: string) => Promise<void>) {
  const out = await mkdtemp(join(tmpdir(), 'qg-visual-'));
  try { await body(out); } finally { await rm(out, { recursive: true, force: true }); }
}
const items = [{ name: 'home', status: 'changed' as const }, { name: 'about', status: 'match' as const }, { name: 'fresh', status: 'new' as const }, { name: 'gone', status: 'missing' as const }];
const failsWith = (status: number) => (error: unknown) => error instanceof VisualImageError && error.status === status;

test('an absent visual.json is an empty "not enabled" answer, not an error', async () => withOutput(async out => {
  assert.deepEqual(await readVisual(out, RUN_ID), { enabled: false, items: [] });
  await mkdir(join(out, RUN_ID), { recursive: true });
  assert.deepEqual(await readVisual(out, RUN_ID), { enabled: false, items: [] });
}));

test('visual.json is validated and served as a public view without file paths', async () => withOutput(async out => {
  await writeVisualRun(out, items);
  const view = await readVisual(out, RUN_ID);
  assert.equal(view.enabled, true); assert.equal(view.runId, RUN_ID); assert.equal(view.gateId, 'visual'); assert.equal(view.baselineDir, 'qualitygate-visual/approved');
  assert.deepEqual(view.items.map(i => [i.name, i.status]), [['home', 'changed'], ['about', 'match'], ['fresh', 'new'], ['gone', 'missing']]);
  assert.deepEqual(view.items[0]!.images, { approved: true, current: true, diff: true });
  assert.deepEqual(view.items[2]!.images, { approved: false, current: true, diff: false });
  assert.equal(JSON.stringify(view).includes('approved/home.png'), false);
}));

test('an invalid visual.json is reported as a warning with no items, and unknown fields are ignored', async () => withOutput(async out => {
  const folder = await writeVisualRun(out, items.slice(0, 1));
  const good = JSON.parse(await readFile(join(folder, 'visual.json'), 'utf8'));
  const write = (value: unknown) => writeFile(join(folder, 'visual.json'), typeof value === 'string' ? value : JSON.stringify(value));
  await write({ ...good, extra: 1, items: [{ ...good.items[0], future: true }] });
  assert.equal((await readVisual(out, RUN_ID)).items.length, 1);
  const bad: unknown[] = ['{broken', { ...good, schemaVersion: 2 }, { ...good, items: [{ ...good.items[0], status: 'other' }] },
    { ...good, items: [{ ...good.items[0], name: '../x' }] }, { ...good, items: [{ ...good.items[0], approved: '../../secret.png' }] },
    { ...good, items: [{ ...good.items[0], approved: 'current/home.png' }] }, { ...good, items: [{ ...good.items[0], diffRatio: 2 }] },
    { ...good, items: [good.items[0], good.items[0]] }, { ...good, items: [{ ...good.items[0], name: '..' }] }];
  for (const value of bad) {
    await write(value);
    const view = await readVisual(out, RUN_ID);
    assert.equal(view.enabled, false); assert.deepEqual(view.items, []); assert.match(view.warning ?? '', /visual\.json/);
  }
  await write('x'.repeat(2_000_000));
  assert.match((await readVisual(out, RUN_ID)).warning ?? '', /too large/);
}));

test('a visual.json that is a symlink is not followed', async () => withOutput(async out => {
  const folder = await writeVisualRun(out, items.slice(0, 1));
  await writeFile(join(out, 'elsewhere.json'), await readFile(join(folder, 'visual.json')));
  await rm(join(folder, 'visual.json')); await symlink(join(out, 'elsewhere.json'), join(folder, 'visual.json'));
  const view = await readVisual(out, RUN_ID);
  assert.equal(view.enabled, false); assert.match(view.warning ?? '', /not a regular file/);
}));

test('run ids that are not UUIDs are refused', async () => withOutput(async out => {
  await assert.rejects(readVisual(out, '../x'), /Invalid run ID/);
  await assert.rejects(readVisualImage(out, '../x', 'home', 'current'), /Invalid run ID/);
}));

test('only listed images are served, by name, as validated PNG bytes', async () => withOutput(async out => {
  await writeVisualRun(out, items);
  assert.deepEqual(await readVisualImage(out, RUN_ID, 'home', 'current'), png(8, 4, [200, 90, 40]));
  for (const [name, image, status] of [['fresh', 'approved', 404], ['gone', 'current', 404], ['about', 'diff', 404], ['nope', 'current', 404],
    ['../home', 'current', 400], ['home', 'secret', 400], ['home', '../current', 400], ['', 'current', 400], ['.hidden', 'current', 400]] as const) {
    await assert.rejects(readVisualImage(out, RUN_ID, name, image), failsWith(status), `${name}/${image}`);
  }
  await assert.rejects(readVisualImage(out, '55555555-5555-4555-8555-555555555555', 'home', 'current'), failsWith(404), 'visual run absent');
}));

test('symlinks, non-PNG content and oversized files are refused', async () => withOutput(async out => {
  const folder = await writeVisualRun(out, items);
  await writeFile(join(out, 'secret.png'), png(1, 1, [1, 2, 3]));
  await rm(join(folder, 'current/home.png')); await symlink(join(out, 'secret.png'), join(folder, 'current/home.png'));
  await assert.rejects(readVisualImage(out, RUN_ID, 'home', 'current'), failsWith(404), 'a planted file symlink');
  await rm(join(folder, 'approved'), { recursive: true }); await mkdir(join(out, 'other'));
  await writeFile(join(out, 'other', 'home.png'), png(1, 1, [1, 2, 3]));
  await symlink(join(out, 'other'), join(folder, 'approved'));
  await assert.rejects(readVisualImage(out, RUN_ID, 'home', 'approved'), failsWith(404), 'a planted directory symlink');
  await writeFile(join(folder, 'diff/home.png'), 'not a png');
  await assert.rejects(readVisualImage(out, RUN_ID, 'home', 'diff'), failsWith(415));
  await writeFile(join(folder, 'diff/home.png'), Buffer.concat([png(1, 1, [0, 0, 0]), Buffer.alloc(11 * 1024 * 1024)]));
  await assert.rejects(readVisualImage(out, RUN_ID, 'home', 'diff'), failsWith(413));
}));

test('item names cannot start with a dash, so a name never reads as a command option', async () => withOutput(async out => {
  const folder = await writeVisualRun(out, items.slice(0, 1));
  const good = JSON.parse(await readFile(join(folder, 'visual.json'), 'utf8'));
  for (const name of ['--all', '-x', '-']) {
    await writeFile(join(folder, 'visual.json'), JSON.stringify({ ...good, items: [{ ...good.items[0], name }] }));
    const view = await readVisual(out, RUN_ID);
    assert.equal(view.enabled, false, name); assert.match(view.warning ?? '', /visual\.json is invalid/, name);
    await assert.rejects(readVisualImage(out, RUN_ID, name, 'current'), failsWith(400), name);
  }
}));

test('baselineDir must be a project-relative path: no absolute path, drive letter or .. segment', async () => withOutput(async out => {
  const folder = await writeVisualRun(out, items.slice(0, 1));
  const good = JSON.parse(await readFile(join(folder, 'visual.json'), 'utf8'));
  for (const baselineDir of ['/etc', '/', '../x', 'a/../b', 'a\\..\\b', '..', 'C:\\x', 'C:/x', 'c:x', '\\\\server\\share', '', 'a\u0000b']) {
    await writeFile(join(folder, 'visual.json'), JSON.stringify({ ...good, baselineDir }));
    const view = await readVisual(out, RUN_ID);
    assert.equal(view.enabled, false, JSON.stringify(baselineDir)); assert.deepEqual(view.items, []); assert.match(view.warning ?? '', /visual\.json is invalid.*baselineDir/, JSON.stringify(baselineDir));
  }
  for (const baselineDir of ['qualitygate-visual/approved', 'base', './base', 'a..b/c']) {
    await writeFile(join(folder, 'visual.json'), JSON.stringify({ ...good, baselineDir }));
    assert.equal((await readVisual(out, RUN_ID)).enabled, true, baselineDir);
  }
}));

test('a run folder or visual folder that is a symlink is not followed', async () => withOutput(async out => {
  const folder = await writeVisualRun(out, items);
  await mkdir(join(out, 'elsewhere'));
  await rename(join(out, RUN_ID, 'visual'), join(out, 'elsewhere', 'visual'));
  await symlink(join(out, 'elsewhere', 'visual'), folder);
  let view = await readVisual(out, RUN_ID);
  assert.equal(view.enabled, false); assert.match(view.warning ?? '', /visual folder is a symbolic link/);
  await assert.rejects(readVisualImage(out, RUN_ID, 'home', 'current'), failsWith(404));
  await rm(folder); await rename(join(out, RUN_ID), join(out, 'elsewhere', 'run'));
  await symlink(join(out, 'elsewhere', 'run'), join(out, RUN_ID));
  view = await readVisual(out, RUN_ID);
  assert.equal(view.enabled, false); assert.match(view.warning ?? '', /run folder is a symbolic link/);
  await assert.rejects(readVisualImage(out, RUN_ID, 'home', 'current'), failsWith(404));
}));

test('an image is served only when its PNG header size equals the item and stays under the pixel cap', async () => withOutput(async out => {
  const folder = await writeVisualRun(out, items);
  const resize = (file: Buffer, width: number, height: number) => { const copy = Buffer.from(file); copy.writeUInt32BE(width, 16); copy.writeUInt32BE(height, 20); return copy; };
  const big = join(folder, 'current/home.png');
  assert.deepEqual(await readVisualImage(out, RUN_ID, 'home', 'approved'), png(8, 4, [40, 90, 200]));
  await writeFile(big, resize(png(8, 4, [1, 2, 3]), 9, 4));
  await assert.rejects(readVisualImage(out, RUN_ID, 'home', 'current'), (error: unknown) => failsWith(422)(error) && /does not match/.test((error as Error).message));
  await writeFile(big, resize(png(8, 4, [1, 2, 3]), 8, 5));
  await assert.rejects(readVisualImage(out, RUN_ID, 'home', 'current'), failsWith(422));
  // over the cap, even though the item claims the same size
  const document = JSON.parse(await readFile(join(folder, 'visual.json'), 'utf8'));
  document.items[0].width = 8001; document.items[0].height = 5000;
  await writeFile(join(folder, 'visual.json'), JSON.stringify(document));
  await writeFile(big, resize(png(8, 4, [1, 2, 3]), 8001, 5000));
  await assert.rejects(readVisualImage(out, RUN_ID, 'home', 'current'), (error: unknown) => failsWith(422)(error) && /40 megapixels/.test((error as Error).message));
  // a header that is not a 13-byte IHDR first chunk is not a PNG we can size
  const broken = png(8, 4, [1, 2, 3]); broken.write('IDAT', 12);
  await writeFile(join(folder, 'diff/home.png'), broken);
  await assert.rejects(readVisualImage(out, RUN_ID, 'home', 'diff'), failsWith(415));
}));
