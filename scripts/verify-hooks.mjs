import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, cp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const exec = promisify(execFile); const root = resolve('.');
const directory = await mkdtemp(join(tmpdir(), 'qualitygate-husky-'));
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  HUSKY: '1', XDG_CONFIG_HOME: join(directory, '.config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
// Gates run in parallel, so the order they append to executed.txt is not defined.
const executed = async () => (await readFile(join(directory, 'executed.txt'), 'utf8')).split('\n').filter(Boolean).sort();
const command = (file, args) => exec(file, args, { cwd: directory, env, timeout: 120000, maxBuffer: 2_000_000 });
const originalHooks = await exec('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root }).then(result => result.stdout).catch(() => '');
try {
  await exec('pnpm', ['build'], { cwd: root, env: process.env });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'qualitygate-hook-fixture', private: true, packageManager: 'pnpm@11.28.9',
    devDependencies: { husky: '9.1.7' }, scripts: { lint: 'node gate.cjs lint', typecheck: 'node gate.cjs typecheck', 'test:ci': 'node gate.cjs tests' } }));
  await writeFile(join(directory, 'pnpm-workspace.yaml'), 'packages: []\nminimumReleaseAge: 10080\nminimumReleaseAgeStrict: true\n');
  await command('pnpm', ['install', '--ignore-scripts']);
  // Link the actual built CLI; the fixture installs only the real Husky package.
  await symlink(join(root, 'dist/qualitygate.mjs'), join(directory, 'node_modules/.bin/qualitygate'));
  await command('git', ['init', '-b', 'main']); await command('git', ['config', 'user.name', 'QualityGate fixture']);
  await command('git', ['config', 'user.email', 'fixture@example.invalid']);
  await command('pnpm', ['exec', 'husky']);
  for (const hook of ['pre-commit', 'pre-push']) await cp(join(root, 'examples/hooks', hook), join(directory, '.husky', hook));
  await cp(join(root, 'examples/hooks/.qualitygate.yml'), join(directory, '.qualitygate.yml'));
  await writeFile(join(directory, 'gate.cjs'), 'const fs=require("node:fs");const name=process.argv[2];fs.appendFileSync("executed.txt",name+"\\n");if(name==="lint"&&fs.existsSync("blocked"))process.exitCode=1;');
  await writeFile(join(directory, 'README.md'), 'Husky fixture\n'); await command('git', ['add', 'README.md']);
  await writeFile(join(directory, 'blocked'), '1');
  await assert.rejects(command('git', ['commit', '-m', 'must be blocked']), error => error.code === 1);
  assert.deepEqual(await executed(), ['lint', 'typecheck'], 'Fast hook skips the tests gate');
  await rm(join(directory, 'blocked')); await command('git', ['commit', '-m', 'passes the hook']);
  assert.equal((await command('git', ['rev-list', '--count', 'HEAD'])).stdout.trim(), '1');
  const remote = join(directory, 'local-remote.git'); await command('git', ['init', '--bare', remote]);
  await writeFile(join(directory, 'executed.txt'), '');
  await command('git', ['push', '--dry-run', remote, 'HEAD:refs/heads/main']);
  assert.deepEqual(await executed(), ['lint', 'tests', 'typecheck']);
  await writeFile(join(directory, 'blocked'), '1');
  await assert.rejects(command('git', ['push', '--dry-run', remote, 'HEAD:refs/heads/main']), error => error.code === 1);
  await assert.rejects(command('git', ['--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/main']), 'Dry-run must not create a remote branch');
  const currentHooks = await exec('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root }).then(result => result.stdout).catch(() => '');
  assert.equal(currentHooks, originalHooks, 'The actual workspace hook configuration stays unchanged');
  await mkdir(join(root, '.qualitygate'), { recursive: true });
  await writeFile(join(root, '.qualitygate/hooks-verification.json'), JSON.stringify({ husky: '9.1.7', preCommitBlocks: true, preCommitPasses: true,
    fastSelection: ['lint', 'typecheck'], prePushRunsAllGates: true, prePushBlocks: true, remoteType: 'temporary local bare Git; dry-run only',
    rootHooksUnchanged: true, cli: 'actual built CLI linked into fixture', status: 'PASS' }, null, 2));
  console.log('Real Husky pre-commit/pre-push fixtures passed. No workspace hooks or remote repositories were changed.');
} finally { await rm(directory, { recursive: true, force: true }); }
