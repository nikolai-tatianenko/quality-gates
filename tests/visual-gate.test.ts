import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePng } from '../packages/plugins/visual-regression/src/png.js';
import { indexEntries } from '../packages/plugins/visual-regression/src/files.js';
import { settingsOf, visualGate } from '../packages/plugins/visual-regression/src/gate.js';
import { BLACK, WHITE, context, runGate, shot, solid, spec, withProject } from './visual-helpers.js';
const exists = (path: string) => access(path).then(() => true, () => false);
test('PASS only when every screenshot matches, and the evidence folder is self-contained', () => withProject(async project => {
  await shot(project.dir, 'base/home.png'); await shot(project.dir, 'shots/home.png');
  await shot(project.dir, 'base/menu.png', BLACK); await shot(project.dir, 'shots/menu.png', BLACK);
  const result = await runGate(project);
  assert.equal(result.exitCode, 0); assert.equal(result.error, undefined); assert.deepEqual(result.findings, []);
  assert.deepEqual(result.report, { schemaVersion: 1, gateId: 'shots', baselineDir: 'base', items: [
    { name: 'home', status: 'match', approved: 'approved/home.png', current: 'current/home.png', diff: null, width: 10, height: 10, diffPixels: 0, diffRatio: 0, threshold: 0.1 },
    { name: 'menu', status: 'match', approved: 'approved/menu.png', current: 'current/menu.png', diff: null, width: 10, height: 10, diffPixels: 0, diffRatio: 0, threshold: 0.1 }] });
  for (const file of ['approved/home.png', 'current/home.png', 'approved/menu.png', 'current/menu.png']) assert.ok(await exists(join(result.evidence, 'visual', file)), file);
  assert.match(result.output, /2 screenshots: 2 match, 0 changed, 0 new, 0 missing/);
}));
test('a changed screenshot BLOCKs with a diff image and a finding that names the current file', () => withProject(async project => {
  await shot(project.dir, 'base/home.png'); await shot(project.dir, 'shots/home.png', WHITE, { dot: BLACK });
  const result = await runGate(project);
  assert.equal(result.exitCode, 1);
  const [item] = result.report!.items;
  assert.deepEqual([item!.status, item!.diff, item!.diffPixels, item!.diffRatio], ['changed', 'diff/home.png', 1, 0.01]);
  assert.ok(await exists(join(result.evidence, 'visual', 'diff', 'home.png')));
  assert.deepEqual(result.findings, [{ gateId: 'shots', severity: 'error', file: 'shots/home.png', ruleId: 'visual-changed',
    message: 'Screenshot "home" changed: 1.00% of pixels differ (limit 0.00%)' }]);
}));
test('maxDiffRatio tolerates a small difference and threshold ignores tiny colour moves', () => withProject(async project => {
  await shot(project.dir, 'base/home.png'); await shot(project.dir, 'shots/home.png', WHITE, { dot: BLACK });
  assert.equal((await runGate(project, { maxDiffRatio: 0.02 })).exitCode, 0);
  assert.equal((await runGate(project, { maxDiffRatio: 0.005 })).exitCode, 1);
}));
test('a missing baseline is a BLOCK, never a pass', () => withProject(async project => {
  await shot(project.dir, 'shots/home.png');
  const result = await runGate(project);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.report!.items.map(item => [item.name, item.status, item.approved, item.current, item.diff]), [['home', 'new', null, 'current/home.png', null]]);
  assert.match(result.findings![0]!.message, /Screenshot "home" has no approved baseline.*qualitygate visual approve home/);
  assert.equal(result.findings![0]!.file, 'shots/home.png');
}));
test('an approved screenshot the run did not produce is missing and BLOCKs', () => withProject(async project => {
  await shot(project.dir, 'base/home.png');
  const result = await runGate(project);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.report!.items.map(item => [item.status, item.approved, item.current]), [['missing', 'approved/home.png', null]]);
  assert.match(result.findings![0]!.message, /has an approved baseline but the run produced no screenshot/);
  assert.equal(result.findings![0]!.file, 'shots/home.png');
}));
test('a screenshot left over from an earlier run does not count as produced', () => withProject(async project => {
  await shot(project.dir, 'base/home.png'); await shot(project.dir, 'shots/home.png', WHITE, { age: 3_600_000 });
  const result = await runGate(project);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report!.items[0]!.status, 'missing');
  assert.match(result.report!.items[0]!.note!, /not written by this run/);
}));
test('a size change is "changed" with a clear message', () => withProject(async project => {
  await shot(project.dir, 'base/home.png'); await shot(project.dir, 'shots/home.png', WHITE, { size: [12, 10] });
  const result = await runGate(project);
  assert.equal(result.exitCode, 1);
  const [item] = result.report!.items;
  assert.deepEqual([item!.status, item!.diff, item!.width, item!.height, item!.diffRatio, item!.diffPixels], ['changed', null, 12, 10, 1, 120]);
  assert.match(result.findings![0]!.message, /size changed: approved 10x10, current 12x10/i);
}));
test('ignored names are not compared or listed', () => withProject(async project => {
  await shot(project.dir, 'base/home.png'); await shot(project.dir, 'shots/home.png');
  await shot(project.dir, 'shots/clock.png', BLACK);
  const result = await runGate(project, { ignore: ['clock'] });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.report!.items.map(item => item.name), ['home']);
}));
test('PNG kinds the plugin cannot read are an error finding and a BLOCK, never a match', () => withProject(async project => {
  const damaged = Buffer.from(encodePng(solid(1, 1, WHITE)));
  damaged[8 + 8 + 9] = 0; // changes the IHDR color type, which also breaks the chunk checksum
  await shot(project.dir, 'base/a.png'); await mkdir(join(project.dir, 'shots'), { recursive: true }); await writeFile(join(project.dir, 'shots', 'a.png'), damaged);
  await shot(project.dir, 'base/b.png'); await writeFile(join(project.dir, 'shots', 'b.png'), 'not a png');
  const result = await runGate(project);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.report!.items.map(item => [item.name, item.status]), [['a', 'changed'], ['b', 'changed']]);
  assert.match(result.report!.items[0]!.note!, /current image: PNG chunk IHDR has a bad checksum/);
  assert.match(result.report!.items[1]!.note!, /current image: Not a PNG file/);
  assert.match(result.findings![1]!.message, /Screenshot "b" cannot be compared: current image: Not a PNG file/);
  assert.equal(result.findings![1]!.ruleId, 'visual-unreadable');
}));
test('an unreadable approved baseline blocks, and a new unreadable screenshot is still new', () => withProject(async project => {
  await mkdir(join(project.dir, 'base'), { recursive: true });
  await writeFile(join(project.dir, 'base', 'a.png'), 'junk'); await shot(project.dir, 'shots/a.png');
  await writeFile(join(project.dir, 'shots', 'n.png'), 'junk');
  await writeFile(join(project.dir, 'base', 'm.png'), 'junk');
  const result = await runGate(project);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.report!.items.map(item => [item.name, item.status, item.width]), [['a', 'changed', 10], ['m', 'missing', 0], ['n', 'new', 0]]);
  assert.match(result.report!.items[0]!.note!, /approved image: Not a PNG file/);
}));
test('images over the pixel limit are refused', () => withProject(async project => {
  await shot(project.dir, 'base/a.png'); await shot(project.dir, 'shots/a.png');
  const result = await runGate(project, { maxPixels: 50 });
  assert.equal(result.exitCode, 1);
  assert.match(result.report!.items[0]!.note!, /PNG too large: 10x10/);
}));
test('files over the size limit are refused without being read', () => withProject(async project => {
  await shot(project.dir, 'base/a.png'); await mkdir(join(project.dir, 'shots'), { recursive: true });
  await writeFile(join(project.dir, 'shots', 'a.png'), Buffer.alloc(0));
  const { truncate } = await import('node:fs/promises');
  await truncate(join(project.dir, 'shots', 'a.png'), 65 * 1024 * 1024);
  const result = await runGate(project);
  assert.equal(result.exitCode, 1);
  assert.match(result.report!.items[0]!.note!, /file is larger than 64 MB/);
  assert.equal(result.report!.items[0]!.current, null);
}));
test('names are validated, symlinks never followed and collisions refused', () => withProject(async project => {
  await shot(project.dir, 'shots/ok.png'); await shot(project.dir, 'base/ok.png');
  await shot(project.dir, 'shots/with space.png'); await shot(project.dir, 'outside/secret.png');
  await symlink(join(project.dir, 'outside', 'secret.png'), join(project.dir, 'shots', 'link.png'));
  await shot(project.dir, 'shots/sub/inner.png'); await writeFile(join(project.dir, 'shots', 'notes.txt'), 'x');
  const result = await runGate(project);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.report!.items.map(item => item.name), ['ok']);
  assert.equal(result.report!.problems!.length, 2);
  assert.ok(result.report!.problems!.some(text => /link\.png: symbolic links are not followed/.test(text)));
  assert.ok(result.report!.problems!.some(text => /with space\.png: the name must use ASCII letters, digits, dots, dashes or underscores/.test(text)));
  assert.deepEqual(result.findings!.filter(finding => finding.ruleId === 'visual-problem').map(finding => finding.file).sort(), ['shots/link.png', 'shots/with space.png']);
}));
test('names that differ only in case collide, in one folder or across both', () => {
  const fake = (name: string) => ({ name, isFile: () => true, isSymbolicLink: () => false });
  const listing = indexEntries('shots', '/x', ['a.png', 'A.png', 'a.png', 'b.png'].map(fake), () => 0);
  assert.deepEqual([...listing.files.keys()], ['b']);
  assert.deepEqual([...listing.blocked], ['a']);
  assert.equal(listing.problems.length, 2);
  assert.match(listing.problems[0]!, /A\.png: name collides with a\.png/);
  assert.equal(indexEntries('x', '/x', [{ name: 'dir.png', isFile: () => false, isSymbolicLink: () => false }], () => 0).files.size, 0);
});
test('Home in the baseline and home in the run collide instead of being treated as one screenshot', () => withProject(async project => {
  await shot(project.dir, 'base/Home.png'); await shot(project.dir, 'shots/home.png'); await shot(project.dir, 'shots/ok.png'); await shot(project.dir, 'base/ok.png');
  const result = await runGate(project);
  assert.equal(result.exitCode, 1);
  assert.ok(result.report!.problems!.some(text => /shots\/home\.png: name collides with base\/Home\.png/.test(text)));
  assert.deepEqual(result.report!.items.map(item => item.name), ['ok']);
}));
test('a screenshot folder or baseline that leaves the project is an error', () => withProject(async project => {
  const outside = await mkdtemp(join(tmpdir(), 'qg-outside-'));
  await mkdir(join(project.dir, 'shots'), { recursive: true });
  for (const patch of [{ current: '../x' }, { current: '/tmp' }, { baseline: '../x' }, { baseline: '/etc' }]) {
    const result = await runGate(project, patch);
    assert.match(result.error!, /must be a folder inside the project/, JSON.stringify(patch));
    assert.equal(result.exitCode, null);
  }
  await symlink(outside, join(project.dir, 'linked'));
  const viaLink = await runGate(project, { current: 'linked' });
  assert.match(viaLink.error!, /current folder resolves outside the project/);
  const deeper = await runGate(project, { baseline: 'linked/new' });
  assert.match(deeper.error!, /baseline folder resolves outside the project/);
  await writeFile(join(project.dir, 'file'), 'x');
  assert.match((await runGate(project, { current: 'file' })).error!, /current folder is not a folder/);
  await rm(outside, { recursive: true });
}));
test('a gate without `current`, without screenshots at all, or without an evidence folder is an error, not a pass', () => withProject(async project => {
  assert.match((await visualGate.run(spec({ current: undefined }), context(project))).error!, /needs a "current" folder/);
  const empty = await runGate(project);
  assert.match(empty.error!, /No screenshots found in shots and no approved baselines in base/);
  await shot(project.dir, 'shots/a.png');
  const none = await visualGate.run(spec(), context(project, { evidenceDir: undefined }));
  assert.match(none.error!, /no evidence folder/i);
  const ignored = await runGate(project, { ignore: ['a'] });
  assert.match(ignored.error!, /No screenshots found/);
}));
test('only one visual gate may write the run evidence', () => withProject(async project => {
  await shot(project.dir, 'base/a.png'); await shot(project.dir, 'shots/a.png');
  assert.equal((await visualGate.run(spec(), context(project))).exitCode, 0);
  const second = await visualGate.run(spec({ id: 'second' }), context(project));
  assert.match(second.error!, /Only one visual gate can run per run/);
  assert.equal(JSON.parse(await readFile(join(project.evidence, 'visual', 'visual.json'), 'utf8')).gateId, 'shots');
}));
test('the command runs first; a failing command BLOCKs without comparing, and a timeout is reported as one', () => withProject(async project => {
  await shot(project.dir, 'base/a.png'); await shot(project.dir, 'shots/a.png');
  const failing = await runGate(project, { run: 'echo shots failed; exit 3' });
  assert.equal(failing.exitCode, 3);
  assert.match(failing.output, /shots failed/);
  assert.match(failing.output, /not compared/);
  assert.equal(failing.report, undefined);
  const slow = await runGate(project, { run: 'sleep 5', timeoutMs: 100 });
  assert.equal(slow.timedOut, true); assert.match(slow.error!, /timed out/);
}));
test('the command can write the screenshots itself', () => withProject(async project => {
  await shot(project.dir, 'base/a.png');
  await writeFile(join(project.dir, 'make.mjs'), `import { writeFileSync, mkdirSync } from 'node:fs'; mkdirSync('shots', { recursive: true }); writeFileSync('shots/a.png', Buffer.from('${encodePng(solid(10, 10, WHITE)).toString('base64')}', 'base64'));`);
  const result = await runGate(project, { run: 'node make.mjs' });
  assert.equal(result.exitCode, 0, result.output);
}));
test('an interrupted run stops before comparing', () => withProject(async project => {
  await shot(project.dir, 'base/a.png'); await shot(project.dir, 'shots/a.png');
  const controller = new AbortController();
  const pending = visualGate.run(spec({ run: 'sleep 5' }), context(project, { signal: controller.signal, defer: () => {} }));
  controller.abort();
  const result = await pending;
  assert.match(result.error!, /Interrupted/);
}));
test('refused file names are escaped in every message, and the rule names the allowed characters', () => withProject(async project => {
  await shot(project.dir, 'shots/ok.png'); await shot(project.dir, 'base/ok.png');
  await shot(project.dir, 'shots/bad\u001b[31mred\nline.png'); await shot(project.dir, 'shots/café.png');
  const result = await runGate(project);
  assert.equal(result.exitCode, 1);
  const texts = [...result.report!.problems!, ...result.findings!.flatMap(finding => [finding.message, finding.file ?? '']), result.output];
  for (const text of texts.slice(0, -1)) assert.doesNotMatch(text, /[^\x20-\x7e]/, text);
  assert.ok(result.report!.problems!.some(text => text.includes('bad\\u001b[31mred\\nline.png: the name must use ASCII letters, digits, dots, dashes or underscores')));
  assert.ok(result.report!.problems!.some(text => text.includes('caf\\u00e9.png:')));
  assert.doesNotMatch(result.output, /\u001b/);
}));
test('names that start with a dash or a dot are refused, so a name can never read as an option', () => withProject(async project => {
  for (const name of ['-all', '--all', '.hidden', '-']) await shot(project.dir, `shots/${name}.png`);
  await shot(project.dir, 'shots/ok-1.png'); await shot(project.dir, 'base/ok-1.png');
  const result = await runGate(project);
  assert.deepEqual(result.report!.items.map(item => item.name), ['ok-1']);
  assert.equal(result.report!.problems!.length, 4);
}));
test('only a lower-case .png extension counts; any other case is refused with a clear problem', () => withProject(async project => {
  await shot(project.dir, 'base/Home.PNG'); await shot(project.dir, 'shots/Home.png'); await shot(project.dir, 'shots/Other.Png');
  const result = await runGate(project);
  assert.equal(result.exitCode, 1);
  assert.ok(result.report!.problems!.includes('base/Home.PNG: the extension must be lower-case .png'));
  assert.ok(result.report!.problems!.includes('shots/Other.Png: the extension must be lower-case .png'));
  assert.deepEqual(result.report!.items.map(item => [item.name, item.status]), [['Home', 'new']]);
}));
test('identical, nested or aliased current and baseline folders are an error before the command runs', () => withProject(async project => {
  await mkdir(join(project.dir, 'shots', 'inner'), { recursive: true }); await symlink(join(project.dir, 'shots'), join(project.dir, 'alias'));
  for (const patch of [{ baseline: 'shots' }, { baseline: 'shots/' }, { baseline: 'shots/inner' }, { current: 'shots/inner', baseline: 'shots' }, { baseline: 'alias' }, { baseline: './shots' }]) {
    const result = await runGate(project, { run: 'echo ran > ran.txt', ...patch });
    assert.match(result.error!, /current and baseline folders must be different and must not contain each other/, JSON.stringify(patch));
    assert.equal(result.exitCode, null);
    assert.ok(!(await exists(join(project.dir, 'ran.txt'))), JSON.stringify(patch));
  }
}));
test('the default pixel limit is 16 megapixels and the schema caps it at 64', () => {
  assert.equal(settingsOf(spec()).maxPixels, 16_000_000);
  assert.equal(spec({ maxPixels: 64_000_000 }).maxPixels, 64_000_000);
  assert.throws(() => spec({ maxPixels: 64_000_001 }));
});
