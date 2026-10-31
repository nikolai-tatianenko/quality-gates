import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

await import('../packages/code-analysis/build.mjs');
const directory = await mkdtemp(join(tmpdir(), 'qg-analysis-package-'));
try {
  const output = JSON.parse(execFileSync('pnpm', ['--silent', 'pack', '--json', '--pack-destination', directory], {
    cwd: resolve('packages/code-analysis'), encoding: 'utf8',
  }));
  const pack = Array.isArray(output) ? output[0] : output;
  assert.ok(pack.files.some(file => file.path === 'dist/cli.mjs'));
  assert.ok(pack.files.some(file => file.path === 'dist/index.mjs'));
  execFileSync('npm', ['install', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund', resolve(directory, pack.filename)], { cwd: directory, stdio: 'inherit' });
  const binary = join(directory, 'node_modules/.bin/qualitygate-analyze');
  const invoke = args => spawnSync(binary, args, { cwd: directory, encoding: 'utf8' });
  await writeFile(join(directory, 'source.ts'), `export function classify(x: number) {${Array.from({ length: 17 }, (_, n) => `if(x===${n}) return ${n};`).join('\n')}return -1;}`);
  const blocked = invoke(['source.ts', '--json']); assert.equal(blocked.status, 1, blocked.stderr);
  assert.ok(JSON.parse(blocked.stdout)[0].messages.some(issue => issue.ruleId === 'complexity'));
  await writeFile(join(directory, 'source.ts'), 'export const classify = (x: number) => x;');
  assert.equal(invoke(['source.ts', '--json']).status, 0);
  const api = pathToFileURL(join(directory, 'node_modules/@qualitygate/code-analysis/dist/index.mjs')).href;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e',
    'const {analyze}=await import(process.argv[1]);console.log(JSON.stringify(await analyze({patterns:["source.ts"]})));', api,
  ], { cwd: directory, encoding: 'utf8' });
  assert.equal(JSON.parse(result).decision, 'PASS');
  await writeFile(join(directory, 'source.py'), 'import os\n');
  const python = invoke(['--language', 'python', 'source.py', '--json']); assert.equal(python.status, 1, python.stderr);
  assert.equal(JSON.parse(python.stdout)[0].messages[0].ruleId, 'F401');
  await writeFile(join(directory, 'source.py'), 'value = 1\n');
  assert.equal(invoke(['--language', 'python', 'source.py', '--json']).status, 0);
  console.log('Standalone analyzer tarball: executable, API, TS and Python BLOCK → PASS verified without publication.');
} finally { await rm(directory, { recursive: true, force: true }); }
