import { execFileSync, spawn } from 'node:child_process';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve('.'); const directory = join(root, '.qualitygate/linux-repro');
await mkdir(join(directory, 'bundle'), { recursive: true });
execFileSync('pnpm', ['build'], { stdio: 'inherit' });
for (const path of ['dist', 'tests/fixture.html', 'scripts/linux/repro.mjs']) {
  await cp(join(root, path), join(directory, 'bundle', path), { recursive: true });
}
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile(join(directory, 'bundle/package.json'), JSON.stringify({ name: 'qualitygate-local-linux-verification', version: '0.0.0', private: true, dependencies: manifest.dependencies }));
const image = process.env.QUALITYGATE_LINUX_IMAGE || 'mcr.microsoft.com/playwright:v1.63.0-noble';
// Source is mounted read-only. Only the dedicated artifact directory is writable.
const child = spawn('docker', ['run', '--rm', '--init', '--shm-size=512m',
  '-v', `${join(directory, 'bundle')}:/source:ro`, '-v', `${directory}:/artifacts`,
  '-w', '/work', '--entrypoint', 'sh', image, '-c',
  'cp -R /source/. /work/ && npm install --ignore-scripts --omit=dev --no-audit --no-fund && CHROME_PATH="$(find /ms-playwright -path "*/chrome-linux*/chrome" -type f | head -1)" node scripts/linux/repro.mjs',
], { stdio: 'inherit' });
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
assert.equal(code, 0, 'Local Linux/Chrome verification failed');
