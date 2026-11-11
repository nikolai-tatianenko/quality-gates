import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type Config } from '../packages/protocol/src/index.js';
import { visualCommand } from '../packages/plugins/visual-regression/src/approve.js';
import { BLACK, runGate, shot, withProject, type Project } from './visual-helpers.js';
const config = (project: Project, gate: Record<string, unknown> = {}): Config =>
  configSchema.parse({ schemaVersion: 1, outputDir: join(project.dir, '.qualitygate'), gates: [{ id: 'shots', type: 'visual', run: 'true', current: 'shots', baseline: 'base', ...gate }] });
const approve = (project: Project, args: string[], cfg = config(project)) => visualCommand({ args, config: cfg, directory: project.dir, signal: new AbortController().signal });
const baseline = (project: Project, name: string) => readFile(join(project.dir, 'base', `${name}.png`));
test('approve <name> copies the latest current screenshot into the baseline and prints each file it changes', () => withProject(async project => {
  await shot(project.dir, 'shots/home.png', BLACK); await shot(project.dir, 'shots/menu.png');
  const run = await runGate(project);
  assert.equal(run.exitCode, 1);
  const result = await approve(project, ['approve', 'home']);
  assert.deepEqual(await baseline(project, 'home'), await readFile(join(project.dir, 'shots', 'home.png')));
  assert.deepEqual(await readdir(join(project.dir, 'base')), ['home.png']);
  assert.deepEqual(result.lines, ['New: base/home.png', 'Approved 1 screenshot from the latest run. Review the change and commit the baseline folder.']);
  assert.deepEqual(result.approved, [{ name: 'home', path: 'base/home.png', change: 'new' }]);
  // approving never touches the stored run or its verdict
  assert.equal(JSON.parse(await readFile(join(run.evidence, 'visual', 'visual.json'), 'utf8')).items[0].status, 'new');
}));
test('approve --all takes every new and changed screenshot, reports missing ones and leaves matches alone', () => withProject(async project => {
  await shot(project.dir, 'base/same.png'); await shot(project.dir, 'shots/same.png');
  await shot(project.dir, 'base/moved.png'); await shot(project.dir, 'shots/moved.png', BLACK);
  await shot(project.dir, 'shots/fresh.png');
  await shot(project.dir, 'base/gone.png');
  await runGate(project);
  const before = await baseline(project, 'same');
  const result = await approve(project, ['approve', '--all']);
  assert.deepEqual(result.lines.slice(0, 3), ['New: base/fresh.png', 'Replaced: base/moved.png', 'Not removed: base/gone.png has no current screenshot (delete the file if the screenshot no longer exists)']);
  assert.deepEqual(await baseline(project, 'moved'), await readFile(join(project.dir, 'shots', 'moved.png')));
  assert.deepEqual(await baseline(project, 'same'), before);
  assert.deepEqual((await readdir(join(project.dir, 'base'))).sort(), ['fresh.png', 'gone.png', 'moved.png', 'same.png']);
  assert.match(result.lines.at(-1)!, /Approved 2 screenshots/);
}));
test('approving a screenshot that already matches, or has nothing to approve, changes nothing', () => withProject(async project => {
  await shot(project.dir, 'base/same.png'); await shot(project.dir, 'shots/same.png');
  await runGate(project);
  assert.deepEqual((await approve(project, ['approve', 'same'])).lines, ['Screenshot same already matches the baseline: nothing to approve']);
  assert.deepEqual((await approve(project, ['approve', '--all'])).lines, ['Nothing to approve: every screenshot matches the baseline']);
}));
test('approve refuses a missing screenshot, an unknown name and bad usage', () => withProject(async project => {
  await shot(project.dir, 'base/gone.png'); await shot(project.dir, 'shots/a.png');
  await runGate(project);
  await assert.rejects(approve(project, ['approve', 'gone']), /Screenshot gone has no current screenshot; delete base\/gone\.png yourself if it should go/);
  await assert.rejects(approve(project, ['approve', 'nope']), /Unknown screenshot nope in the latest run \(known: a, gone\)/);
  await assert.rejects(approve(project, ['approve', '../x']), /Invalid screenshot name/);
  await assert.rejects(approve(project, ['approve']), /Usage: qualitygate visual approve <name>\|--all/);
  await assert.rejects(approve(project, ['approve', 'a', '--all']), /Usage/);
  await assert.rejects(approve(project, ['approve', 'a', 'b']), /Usage/);
  await assert.rejects(approve(project, ['remove', 'a']), /Usage/);
  await assert.rejects(readdir(join(project.dir, 'base', 'a.png')));
}));
test('approve needs a visual gate, a finished run and visual results in the LATEST run', () => withProject(async project => {
  const plain = configSchema.parse({ schemaVersion: 1, outputDir: join(project.dir, '.qualitygate'), gates: [{ id: 'x', run: 'true' }] });
  await assert.rejects(approve(project, ['approve', '--all'], plain), /No visual gate is configured/);
  await assert.rejects(approve(project, ['approve', '--all']), /No runs found/);
  await shot(project.dir, 'shots/a.png');
  const run = await runGate(project);
  await mkdir(join(project.dir, '.qualitygate', '11111111-1111-4111-8111-111111111111'));
  await writeFile(join(project.dir, '.qualitygate', '11111111-1111-4111-8111-111111111111', 'report.json'), '{}');
  const later = new Date(Date.now() + 60_000);
  await utimes(join(project.dir, '.qualitygate', '11111111-1111-4111-8111-111111111111', 'report.json'), later, later);
  await assert.rejects(approve(project, ['approve', '--all']), /The latest run \(11111111-1111-4111-8111-111111111111\) has no visual results.*qualitygate run/);
  await rm(join(project.dir, '.qualitygate', '11111111-1111-4111-8111-111111111111'), { recursive: true });
  await mkdir(join(project.dir, '.qualitygate', 'not-a-run'));
  assert.equal((await approve(project, ['approve', 'a'])).approved!.length, 1);
  await writeFile(join(run.evidence, 'visual', 'visual.json'), '{"schemaVersion":2}');
  await assert.rejects(approve(project, ['approve', 'a']), /visual\.json is not a version 1 visual report/);
  await writeFile(join(run.evidence, 'visual', 'visual.json'), 'not json');
  await assert.rejects(approve(project, ['approve', 'a']), /visual\.json is not a version 1 visual report/);
}));
test('approve refuses when the configuration changed since the run, or the baseline leaves the project', () => withProject(async project => {
  await shot(project.dir, 'shots/a.png');
  const run = await runGate(project);
  await assert.rejects(approve(project, ['approve', 'a'], config(project, { baseline: 'other' })), /The latest run used baseline folder base but the configuration says other: run the gate again/);
  const report = JSON.parse(await readFile(join(run.evidence, 'visual', 'visual.json'), 'utf8'));
  for (const baselineDir of ['../outside', '/tmp/outside']) {
    await writeFile(join(run.evidence, 'visual', 'visual.json'), JSON.stringify({ ...report, baselineDir }));
    await assert.rejects(approve(project, ['approve', 'a'], config(project, { baseline: baselineDir })), /baseline folder must be a folder inside the project/, baselineDir);
  }
  const outside = await mkdtemp(join(tmpdir(), 'qg-outside-'));
  await symlink(outside, join(project.dir, 'linked'));
  await writeFile(join(run.evidence, 'visual', 'visual.json'), JSON.stringify({ ...report, baselineDir: 'linked' }));
  await assert.rejects(approve(project, ['approve', 'a'], config(project, { baseline: 'linked' })), /baseline folder resolves outside the project/);
  assert.deepEqual(await readdir(outside), []);
  await rm(outside, { recursive: true });
}));
test('approve never follows a symlink: not for the baseline file, not for the stored screenshot', () => withProject(async project => {
  await shot(project.dir, 'shots/a.png', BLACK); await shot(project.dir, 'base/a.png');
  const run = await runGate(project);
  const secret = await shot(project.dir, 'elsewhere/secret.png');
  const original = await readFile(secret);
  await rm(join(project.dir, 'base', 'a.png'));
  await symlink(secret, join(project.dir, 'base', 'a.png'));
  await assert.rejects(approve(project, ['approve', 'a']), /base\/a\.png is a symbolic link/);
  assert.deepEqual(await readFile(secret), original);
  await rm(join(project.dir, 'base', 'a.png'));
  const stored = join(run.evidence, 'visual', 'current', 'a.png');
  await rm(stored); await symlink(secret, stored);
  await assert.rejects(approve(project, ['approve', 'a']), /ELOOP|symbolic|Too many levels/i);
  await rm(stored); await mkdir(join(run.evidence, 'elsewhere')); await shot(run.evidence, 'elsewhere/a.png');
  await rm(join(run.evidence, 'visual', 'current'), { recursive: true });
  await symlink(join(run.evidence, 'elsewhere'), join(run.evidence, 'visual', 'current'));
  await assert.rejects(approve(project, ['approve', 'a']), /stored screenshot is not inside the run folder/);
}));
test('approve refuses a stored screenshot that is not a readable PNG', () => withProject(async project => {
  await shot(project.dir, 'shots/a.png');
  const run = await runGate(project);
  await writeFile(join(run.evidence, 'visual', 'current', 'a.png'), 'garbage');
  await assert.rejects(approve(project, ['approve', 'a']), /Cannot approve a: Not a PNG file/);
  assert.equal(await stat(join(project.dir, 'base')).catch(() => null), null);
}));
test('approve --all writes nothing when one screenshot cannot be approved', () => withProject(async project => {
  await shot(project.dir, 'shots/a.png'); await shot(project.dir, 'shots/b.png');
  const run = await runGate(project);
  await writeFile(join(run.evidence, 'visual', 'current', 'b.png'), 'garbage');
  await assert.rejects(approve(project, ['approve', '--all']), /Cannot approve b/);
  assert.equal(await stat(join(project.dir, 'base')).catch(() => null), null);
}));
test('approving the same bytes again reports no change', () => withProject(async project => {
  await shot(project.dir, 'shots/a.png', BLACK);
  await runGate(project);
  await approve(project, ['approve', 'a']);
  const second = await approve(project, ['approve', 'a']);
  assert.deepEqual(second.lines.slice(0, 1), ['Unchanged: base/a.png (already identical)']);
  assert.deepEqual(second.approved, []);
  assert.deepEqual(await readdir(join(project.dir, 'base')), ['a.png']);
}));
test('a re-run after approving matches', () => withProject(async project => {
  await shot(project.dir, 'shots/a.png', BLACK);
  assert.equal((await runGate(project)).exitCode, 1);
  await approve(project, ['approve', '--all']);
  assert.equal((await runGate(project)).exitCode, 0);
}));
test('an invalid name given to approve is shown escaped', () => withProject(async project => {
  await shot(project.dir, 'shots/a.png'); await runGate(project);
  await assert.rejects(approve(project, ['approve', 'x\u001b[2Jy']), (error: Error) => error.message === 'Invalid screenshot name: x\\u001b[2Jy' && !/[^\x20-\x7e]/.test(error.message));
  await assert.rejects(approve(project, ['approve', '-all']), /Invalid screenshot name: -all/);
}));
