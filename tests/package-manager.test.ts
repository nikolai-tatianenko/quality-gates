import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('checkout install guard accepts the pinned pnpm and rejects other managers without a network dependency', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-pm-guard-'));
  try {
    await mkdir(join(dir, 'scripts'));
    await cp(resolve('scripts/require-pnpm.mjs'), join(dir, 'scripts/require-pnpm.mjs'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.5.1' }));
    const workspace = join(dir, 'pnpm-workspace.yaml'); await writeFile(workspace, 'packages: []\n');
    const invoke = (userAgent: string) => spawnSync(process.execPath, [join(dir, 'scripts/require-pnpm.mjs')], {
      encoding: 'utf8', env: { ...process.env, npm_config_user_agent: userAgent },
    });
    assert.equal(invoke('pnpm/11.5.1 npm/? node/v22.19.0').status, 0);
    for (const agent of ['', 'npm/11.0.0', 'yarn/1.22.0', 'bun/1.2.0', 'pnpm/11.5.2']) {
      const result = invoke(agent); assert.equal(result.status, 1); assert.match(result.stderr, /requires pnpm@11.5.1/);
    }
    await rm(workspace);
    assert.equal(invoke('npm/11.0.0').status, 0, 'The installed CLI does not impose our source-checkout manager on consumers');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('npm refuses a checkout install before writing a second lockfile, even with scripts disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-pm-native-'));
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'qualitygate-manager-policy-test', version: '0.0.0',
      devEngines: { packageManager: { name: 'pnpm', version: '11.5.1', onFail: 'error' } } }));
    const result = spawnSync('npm', ['install', '--ignore-scripts', '--package-lock-only', '--offline', '--no-audit', '--no-fund'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, npm_config_cache: join(dir, 'cache') },
    });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /EBADDEVENGINES/);
    await assert.rejects(access(join(dir, 'package-lock.json')), /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
