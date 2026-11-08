import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { setupProject } from '../packages/cli/src/setup.js';

async function project(pkg: object, files: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qg-setup-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

test('setup maps scripts to gates with the declared package manager and ignores output folders', async () => {
  const dir = await project({ packageManager: 'pnpm@11.28.9', scripts: { lint: 'eslint .', 'type-check': 'tsc', test: 'vitest run', 'test:ci': 'vitest run' } });
  try {
    const result = await setupProject(join(dir, '.qualitygate.yml'));
    assert.deepEqual(result.gates, [
      { id: 'lint', run: 'pnpm exec eslint . --format json --output-file .qualitygate/node/eslint.json', fix: 'pnpm exec eslint . --fix' }, { id: 'typecheck', run: 'pnpm run type-check' },
      { id: 'tests', run: 'pnpm exec vitest run --reporter=default --reporter=junit --outputFile.junit=.qualitygate/node/junit.xml' }]);
    const config = parse(await readFile(result.configPath, 'utf8'));
    assert.equal(config.gates[2].timeoutMs, 300000);
    assert.equal(config.gates[0].fix, 'pnpm exec eslint . --fix');
    assert.equal(config.gates[1].fix, undefined);
    assert.deepEqual(config.gates[0].report, { format: 'eslint-json', path: '.qualitygate/node/eslint.json' });
    assert.deepEqual(config.gates[2].report, { format: 'junit', path: '.qualitygate/node/junit.xml' });
    assert.deepEqual(result.changed, [result.configPath, join(dir, '.gitignore')]);
    assert.deepEqual(result.gitignore, ['.qualitygate/', '.qualitygate-ci/', '.qualitygate-review-sources/']);
    assert.match(await readFile(join(dir, '.gitignore'), 'utf8'), /^\.qualitygate\/\n\.qualitygate-ci\/\n/);
    await assert.rejects(setupProject(result.configPath), /already exists/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('setup detects the manager from lockfiles, keeps existing .gitignore lines and falls back to npm', async () => {
  const cases: [Record<string, string>, string][] = [[{ 'yarn.lock': '' }, 'yarn'], [{ 'package-lock.json': '' }, 'npm'], [{}, 'npm']];
  for (const [files, manager] of cases) {
    const dir = await project({ scripts: { test: 'jest --ci' } }, { ...files, '.gitignore': 'node_modules\n.qualitygate/' });
    try {
      const result = await setupProject(join(dir, '.qualitygate.yml'));
      assert.deepEqual(result.gates, [{ id: 'tests', run: `${manager} run test` }]);
      assert.deepEqual(result.gitignore, ['.qualitygate-ci/', '.qualitygate-review-sources/']);
      assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), 'node_modules\n.qualitygate/\n.qualitygate-ci/\n.qualitygate-review-sources/\n');
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('setup leaves a complete .gitignore alone and rejects projects without usable scripts', async () => {
  const dir = await project({ scripts: { lint: 'eslint .' }, packageManager: 42 }, { 'pnpm-lock.yaml': '', '.gitignore': '.qualitygate/\n.qualitygate-ci/\n.qualitygate-review-sources/\n' });
  const bare = await project({});
  try {
    const result = await setupProject(join(dir, '.qualitygate.yml'));
    assert.deepEqual(result.gates, [{ id: 'lint', run: 'pnpm exec eslint . --format json --output-file .qualitygate/node/eslint.json', fix: 'pnpm exec eslint . --fix' }]);
    assert.deepEqual(result.gitignore, []);
    assert.deepEqual(result.changed, [result.configPath]);
    await assert.rejects(setupProject(join(bare, '.qualitygate.yml')), /No lint, typecheck or test script/);
    await assert.rejects(setupProject(join(bare, 'missing', '.qualitygate.yml')), /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(bare, { recursive: true, force: true }); }
});
