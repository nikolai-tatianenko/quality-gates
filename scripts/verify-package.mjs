import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
execFileSync('pnpm', ['build'], { stdio: 'inherit' });
const directory = await mkdtemp(join(tmpdir(), 'qualitygate-package-'));
try {
  const output = JSON.parse(execFileSync('pnpm', ['--silent', 'pack', '--json', '--pack-destination', directory], { encoding: 'utf8' }));
  const packed = Array.isArray(output) ? output : [output];
  const files = packed[0].files.map(file => file.path);
  assert.ok(files.includes('scripts/require-pnpm.mjs'));
  assert.ok(files.includes('dist/qualitygate.mjs')); assert.ok(files.includes('dist/lighthouse-worker.mjs')); assert.ok(files.includes('dist/qualitygate-ui.mjs'));
  execFileSync('npm', ['install', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund', resolve(directory, packed[0].filename)], { cwd: directory, stdio: 'inherit' });
  const entry = join(directory, 'node_modules', 'qualitygate-toolbox', 'dist', 'qualitygate.mjs');
  execFileSync(process.execPath, [join(directory, 'node_modules/qualitygate-toolbox/scripts/require-pnpm.mjs')], { cwd: directory, env: { ...process.env, npm_config_user_agent: 'npm/11.0.0' } });
  const config = join(directory, 'init.yml');
  execFileSync(process.execPath, [entry, 'init', '--config', config], { cwd: directory, stdio: 'inherit' });
  assert.match(await readFile(config, 'utf8'), /schemaVersion: 1/);
  execFileSync(join(directory, 'node_modules', '.bin', 'qualitygate'), ['--help'], { cwd: directory, stdio: 'inherit' });
  // `qualitygate ui` needs Ink, which is bundled into qualitygate-ui.mjs: the installed file must load with the package's own dependencies only.
  const ui = await import(pathToFileURL(join(directory, 'node_modules', 'qualitygate-toolbox', 'dist', 'qualitygate-ui.mjs')).href);
  assert.equal(typeof ui.startUi, 'function');
  const refused = spawnSync(process.execPath, [entry, 'ui'], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(refused.status, 2); assert.match(refused.stderr, /ui needs an interactive terminal/);
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/smoke.ts'], {
    cwd: resolve('.'), env: { ...process.env, QUALITYGATE_CLI: entry }, stdio: 'inherit',
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, 'Installed tarball smoke failed');
  console.log('Local tarball installed and verified without publication.');
} finally { await rm(directory, { recursive: true, force: true }); }
