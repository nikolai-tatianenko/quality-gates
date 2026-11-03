import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { configSchema } from '../packages/protocol/src/index.js';
import type { DetectedGate } from '../packages/protocol/src/index.js';
import type { EcosystemPlugin } from '../packages/plugin-sdk/src/index.js';
import { mergeProposals, setupProject } from '../packages/cli/src/setup.js';
const stub = (id: string, gates: DetectedGate[] | null | unknown): EcosystemPlugin => ({ id, apiVersion: 1, kind: 'ecosystem', detect: async () => gates as DetectedGate[] | null });
async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'qg-setup-eco-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
test('colliding ids are prefixed with their ecosystem, unique ids stay', () => {
  const merged = mergeProposals([
    { ecosystem: 'a', gates: [{ id: 'lint', run: 'a-lint' }, { id: 'tests', run: 'a-tests' }] },
    { ecosystem: 'b', gates: [{ id: 'tests', run: 'b-tests' }] }]);
  assert.deepEqual(merged.map(gate => [gate.id, gate.run]), [['lint', 'a-lint'], ['a-tests', 'a-tests'], ['b-tests', 'b-tests']]);
});
test('ids that still collide after prefixing are rejected', () => {
  assert.throws(() => mergeProposals([
    { ecosystem: 'a', gates: [{ id: 'tests', run: 'x' }, { id: 'a-tests', run: 'y' }] },
    { ecosystem: 'b', gates: [{ id: 'tests', run: 'z' }] }]), /Duplicate gate id: a-tests/);
});
test('setup writes merged gates, lists the contributing ecosystems and never overwrites', async () => withDir(async dir => {
  const path = join(dir, '.qualitygate.yml');
  const result = await setupProject(path, [stub('a', [{ id: 'tests', run: 'a' }]), stub('none', null), stub('empty', []), stub('b', [{ id: 'tests', run: 'b', report: { format: 'junit', path: 'r.xml' } }])]);
  assert.deepEqual(result.ecosystems, ['a', 'b']);
  assert.deepEqual(result.gates, [{ id: 'a-tests', run: 'a' }, { id: 'b-tests', run: 'b' }]);
  const written = await readFile(path, 'utf8');
  assert.equal(configSchema.parse(parse(written)).gates.length, 2);
  await assert.rejects(setupProject(path, [stub('c', [{ id: 'x', run: 'c' }])]), /EEXIST/);
  assert.equal(await readFile(path, 'utf8'), written);
}));
test('setup fails clearly when nothing is detected, a plugin proposes an invalid gate, or the folder is missing', async () => withDir(async dir => {
  await assert.rejects(setupProject(join(dir, 'q.yml'), [stub('a', null)]), /No lint, typecheck or test script/);
  await assert.rejects(setupProject(join(dir, 'q.yml'), [stub('a', [{ id: 'Bad Id!', run: 'x' }])]));
  await assert.rejects(setupProject(join(dir, 'missing', 'q.yml'), []), /ENOENT/);
}));
test('a project with Node, Playwright, Python and Maestro gets one valid config', async () => withDir(async dir => {
  await writeFile(join(dir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.5.1', scripts: { lint: 'x', test: 'y' } }));
  await writeFile(join(dir, 'playwright.config.ts'), '');
  await writeFile(join(dir, 'pyproject.toml'), '');
  await mkdir(join(dir, '.maestro')); await writeFile(join(dir, '.maestro', 'a.yaml'), 'appId: x\n');
  const result = await setupProject(join(dir, '.qualitygate.yml'));
  assert.deepEqual(result.ecosystems, ['node', 'python', 'playwright', 'maestro']);
  assert.deepEqual(result.gates.map(gate => gate.id), ['node-lint', 'node-tests', 'python-lint', 'python-tests', 'playwright-tests', 'e2e-mobile']);
  configSchema.parse(parse(await readFile(result.configPath, 'utf8')));
}));
