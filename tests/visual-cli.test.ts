import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { BLACK, shot, withProject, type Project } from './visual-helpers.js';
const PLUGIN = '@qualitygate/plugin-visual-regression';
const pluginEntry = new URL('../packages/plugins/visual-regression/src/index.ts', import.meta.url).href;
function cli(args: string[], cwd: string) {
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('packages/cli/src/index.ts'), ...args], { cwd });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }));
  });
}
/**
 * A project whose node_modules holds a one-line package that re-exports the plugin from this checkout (the workspace is not linked into temporary projects).
 * The screenshot command touches the file, because a screenshot older than the command's start counts as not written. */
async function setup(project: Project, enabled = true) {
  const root = join(project.dir, 'node_modules', '@qualitygate', 'plugin-visual-regression');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: PLUGIN, type: 'module', exports: './index.js' }));
  await writeFile(join(root, 'index.js'), `export * from ${JSON.stringify(pluginEntry)};`);
  await writeFile(join(project.dir, '.qualitygate.yml'), stringify({ schemaVersion: 1, ...(enabled ? { plugins: [PLUGIN] } : {}),
    gates: [{ id: 'shots', ...(enabled ? { type: 'visual' } : {}), run: enabled ? 'touch shots/home.png' : 'true', ...(enabled ? { current: 'shots', baseline: 'qualitygate-visual/approved' } : {}) }] }));
}
test('run blocks on a missing baseline, `visual approve` copies it, the next run passes; the verdict of the first run is untouched', () => withProject(async project => {
  await setup(project);
  await shot(project.dir, 'shots/home.png', BLACK);
  const first = await cli(['run', '--no-live', '--json'], project.dir);
  assert.equal(first.code, 1, first.stderr);
  const run = JSON.parse(first.stdout);
  assert.equal(run.decision, 'BLOCK');
  assert.match(run.findings[0].message, /Screenshot "home" has no approved baseline/);
  assert.equal(run.findings[0].file, 'shots/home.png');
  const visual = JSON.parse(await readFile(join(project.dir, '.qualitygate', run.runId, 'visual', 'visual.json'), 'utf8'));
  assert.equal(visual.items[0].status, 'new');
  const approved = await cli(['visual', 'approve', 'home'], project.dir);
  assert.equal(approved.code, 0, approved.stderr);
  assert.match(approved.stdout, /New: qualitygate-visual\/approved\/home\.png/);
  assert.deepEqual(await readFile(join(project.dir, 'qualitygate-visual', 'approved', 'home.png')), await readFile(join(project.dir, 'shots', 'home.png')));
  const stored = JSON.parse(await readFile(join(project.dir, '.qualitygate', run.runId, 'report.json'), 'utf8'));
  assert.equal(stored.decision, 'BLOCK');
  const second = await cli(['run', '--no-live', '--json'], project.dir);
  assert.equal(second.code, 0, second.stderr);
  const again = await cli(['visual', 'approve', '--all', '--json'], project.dir);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout).lines, ['Nothing to approve: every screenshot matches the baseline']);
  assert.equal(JSON.parse(again.stdout).schemaVersion, 1);
}));
test('`visual` says clearly when the plugin is not enabled, and rejects bad usage with exit 2', () => withProject(async project => {
  await setup(project, false);
  const off = await cli(['visual', 'approve', '--all'], project.dir);
  assert.equal(off.code, 2);
  assert.match(off.stderr, /The visual-regression plugin is not enabled: add "@qualitygate\/plugin-visual-regression" to plugins: in .qualitygate.yml/);
  const json = await cli(['visual', 'approve', '--all', '--json'], project.dir);
  assert.equal(json.code, 2);
  assert.match(JSON.parse(json.stdout).errors[0], /not enabled/);
  await setup(project);
  const usage = await cli(['visual'], project.dir);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /Usage: qualitygate visual approve/);
  const flags = await cli(['run', '--all'], project.dir);
  assert.equal(flags.code, 2);
  assert.match(flags.stderr, /run does not accept --all/);
  const noRun = await cli(['visual', 'approve', '--all'], project.dir);
  assert.equal(noRun.code, 2);
  assert.match(noRun.stderr, /No runs found/);
}));
test('help lists the command', async () => {
  const help = await cli(['--help'], process.cwd());
  assert.match(help.stdout, /qualitygate visual approve <name>\|--all \[--config <path>\] \[--json\]/);
});
