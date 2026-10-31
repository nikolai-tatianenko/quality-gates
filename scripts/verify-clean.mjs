import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const directory = await mkdtemp(join(tmpdir(), 'qualitygate-clean-'));
const root = resolve('.');
async function command(args) {
  const child = spawn('pnpm', args, { cwd: directory, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, `pnpm ${args.join(' ')} failed`);
}
try {
  for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.nvmrc', '.npmrc', 'tsconfig.json', 'eslint.config.mjs', '.c8rc.json', 'LICENSE', 'packages', 'tests', 'scripts']) {
    await cp(join(root, path), join(directory, path), { recursive: true,
      filter: source => !source.split(sep).some(segment => ['node_modules', 'dist', 'coverage'].includes(segment)),
    });
  }
  await command(['install', '--frozen-lockfile']);
  await command(['check']);
  console.log('Clean pnpm install and all checks passed in a fresh temporary directory.');
} finally { await rm(directory, { recursive: true, force: true }); }
