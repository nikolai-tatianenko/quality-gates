import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
execFileSync('pnpm', ['build'], { stdio: 'inherit' });
const directory = await mkdtemp(join(tmpdir(), 'qualitygate-package-'));
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', directory], { encoding: 'utf8' }));
  const files = packed[0].files.map(file => file.path);
  assert.ok(files.includes('dist/qualitygate.mjs')); assert.ok(files.includes('dist/lighthouse-worker.mjs'));
  execFileSync('npm', ['install', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund', join(directory, packed[0].filename)], { stdio: 'inherit' });
  const entry = join(directory, 'node_modules', 'qualitygate-prototype', 'dist', 'qualitygate.mjs');
  const config = join(directory, 'init.yml');
  execFileSync(process.execPath, [entry, 'init', '--config', config], { cwd: directory, stdio: 'inherit' });
  assert.match(await readFile(config, 'utf8'), /schemaVersion: 1/);
  execFileSync(join(directory, 'node_modules', '.bin', 'qualitygate'), ['--help'], { cwd: directory, stdio: 'inherit' });
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/smoke.ts'], {
    cwd: resolve('.'), env: { ...process.env, QUALITYGATE_CLI: entry }, stdio: 'inherit',
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, 'Installed tarball smoke failed');
  console.log('Local tarball installed and verified without publication.');
} finally { await rm(directory, { recursive: true, force: true }); }
