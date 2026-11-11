import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { gateSchema } from '../packages/protocol/src/index.js';
import { loadExternalPlugins } from '../packages/core/src/external.js';
import { execute } from '../packages/cli/src/runner.js';
async function withProject(fn: (dir: string) => Promise<void>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'qg-context-')));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function install(dir: string, name: string, source: string) {
  const root = join(dir, 'node_modules', name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.js' }));
  await writeFile(join(root, 'index.js'), source);
}
test('a gate plugin learns the project folder and the run evidence folder', async () => withProject(async dir => {
  await install(dir, 'ctx', `import { writeFile } from 'node:fs/promises'; import { join } from 'node:path';
export const manifest = { apiVersion: 1, plugins: [{ apiVersion: 1, kind: 'gate', id: 'ctx-gate',
  run: async (spec, ctx) => { await writeFile(join(ctx.evidenceDir, 'mine.txt'), 'x'); return { exitCode: 0, output: ctx.projectDir + '|' + ctx.evidenceDir }; } }] };`);
  await writeFile(join(dir, '.qualitygate.yml'), stringify({ schemaVersion: 1, plugins: ['ctx'], gates: [{ id: 'g', type: 'ctx-gate', run: 'x' }] }));
  const result = await execute(join(dir, '.qualitygate.yml'), new AbortController().signal);
  assert.equal(result.decision, 'PASS');
  const [project, evidence] = result.gates[0]!.outputTail.split('|');
  assert.equal(project, dir);
  assert.equal(evidence, join(dir, '.qualitygate', result.runId));
  assert.equal(await readFile(join(evidence!, 'mine.txt'), 'utf8'), 'x');
}));
test('a plugin package may add commands; duplicates and non-functions are rejected', async () => withProject(async dir => {
  const withCommands = (id: string, commands: string) => `export const manifest = { apiVersion: 1, plugins: [{ apiVersion: 1, kind: 'gate', id: '${id}', run: async () => ({ exitCode: 0, output: '' }) }], commands: ${commands} };`;
  await install(dir, 'cmds', withCommands('cmd-gate', "{ visual: async () => ({ lines: ['hi'] }) }"));
  const loaded = await loadExternalPlugins(dir, ['cmds']);
  assert.deepEqual(Object.keys(loaded.commands), ['visual']);
  assert.deepEqual(await loaded.commands.visual!({ args: [], config: {} as never, directory: dir, signal: new AbortController().signal }), { lines: ['hi'] });
  assert.deepEqual((await loadExternalPlugins(dir, [])).commands, {});
  await install(dir, 'other', withCommands('other-gate', "{ visual: async () => ({ lines: [] }) }"));
  await assert.rejects(loadExternalPlugins(dir, ['cmds', 'other']), /Duplicate plugin command: visual \(other\)/);
  await install(dir, 'bad', withCommands('bad-gate', "{ visual: 'no' }"));
  await assert.rejects(loadExternalPlugins(dir, ['bad']), /Invalid plugin package bad: commands\.visual/);
}));
test('gate settings for plugin gates are optional, bounded and refused on command gates', () => {
  const visual = { id: 'v', type: 'visual', run: 'x', current: 'shots', baseline: 'base', threshold: 0.2, maxDiffRatio: 0.01, ignore: ['a'], maxPixels: 1000 };
  assert.deepEqual(gateSchema.parse(visual).ignore, ['a']);
  assert.equal(gateSchema.parse({ id: 'v', type: 'visual', run: 'x' }).current, undefined);
  for (const patch of [{ threshold: 2 }, { threshold: -1 }, { maxDiffRatio: 1.5 }, { maxPixels: 0 }, { ignore: [''] }, { current: '' }]) assert.throws(() => gateSchema.parse({ ...visual, ...patch }), JSON.stringify(patch));
  assert.throws(() => gateSchema.parse({ ...visual, type: 'command' }), /only for plugin gates/);
});
