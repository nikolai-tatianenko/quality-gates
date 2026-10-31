import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { analyze } from '../packages/code-analysis/src/index.js';
import { execute } from '../packages/cli/src/runner.js';

const branches = Array.from({ length: 17 }, (_, n) => `if (x === ${n}) return ${n};`).join('\n');
test('TypeScript analysis reports complexity with locations and ignores executable project config', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qg-analysis-ts-'));
  try {
    await writeFile(join(cwd, 'eslint.config.mjs'), 'throw new Error("Must not load project config");');
    await writeFile(join(cwd, 'source.ts'), `export function classify(x: number) {\n${branches}\nreturn -1;\n}`);
    const blocked = await analyze({ cwd, patterns: ['source.ts'] });
    assert.equal(blocked.decision, 'BLOCK');
    assert.ok(blocked.findings.some(f => f.rule === 'complexity' && f.file === 'source.ts' && f.line === 1));
    assert.ok(blocked.findings.some(f => f.rule === 'sonarjs/cognitive-complexity'));
    await writeFile(join(cwd, 'source.ts'), 'export const classify = (x: number) => x;');
    assert.equal((await analyze({ cwd, patterns: ['source.ts'] })).decision, 'PASS');
    await writeFile(join(cwd, 'source.ts'), 'function {');
    assert.equal((await analyze({ cwd, patterns: ['source.ts'] })).decision, 'BLOCK');
    await assert.rejects(analyze({ cwd, patterns: ['absent.ts'] }), /No files matching/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
test('Python analysis invokes real Ruff, normalizes complexity and lint findings, then passes after a fix', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qg-analysis-py-'));
  try {
    const branches = Array.from({ length: 17 }, (_, n) => `    if x == ${n}:\n        return ${n}`).join('\n');
    await writeFile(join(cwd, 'source.py'), `import os\n\ndef classify(x):\n${branches}\n    return -1\n`);
    const blocked = await analyze({ cwd, language: 'python' });
    assert.equal(blocked.decision, 'BLOCK');
    for (const code of ['C901', 'F401']) assert.ok(blocked.findings.some(f => f.rule === code && f.file === 'source.py' && f.line));
    await writeFile(join(cwd, 'source.py'), 'def classify(x):\n    return x\n');
    assert.equal((await analyze({ cwd, language: 'python', patterns: ['source.py'] })).decision, 'PASS');
    await writeFile(join(cwd, 'source.py'), 'def broken(\n');
    assert.equal((await analyze({ cwd, language: 'python' })).decision, 'BLOCK');
    await assert.rejects(analyze({ cwd, language: 'python', ruffPath: '/no-such-ruff' }), /Ruff execution failed/);
    await assert.rejects(analyze({ cwd, language: 'python', patterns: [] }), /at least one/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
test('analysis CLI is consumed as a QualityGate gate with saved structured evidence', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qg-analysis-cli-'));
  const entry = resolve('packages/code-analysis/src/cli.ts');
  const tsx = resolve('node_modules/tsx/dist/loader.mjs');
  const command = `${JSON.stringify(process.execPath)} --import ${JSON.stringify(tsx)} ${JSON.stringify(entry)}`;
  try {
    await writeFile(join(cwd, 'source.py'), 'import os\n');
    const config = join(cwd, '.qualitygate.yml');
    await writeFile(config, JSON.stringify({ schemaVersion: 1,
      gates: [{ id: 'python-analysis', type: 'eslint', run: `${command} --language python . --json` }] }));
    const run = await execute(config, new AbortController().signal);
    assert.equal(run.execution, 'completed'); assert.equal(run.decision, 'BLOCK');
    assert.equal(run.findings[0]?.ruleId, 'F401'); assert.ok(run.findings[0]?.evidencePath);
    for (const args of [['--language', 'ruby'], ['--unknown'], ['--language'], ['absent.ts'], ['--language', 'python', '.']]) {
      const child = spawn(process.execPath, ['--import', tsx, entry, ...args], { cwd });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
      const code = await new Promise(resolve => child.once('close', resolve));
      if (args.includes('python')) { assert.equal(code, 1); assert.match(stdout, /F401/); }
      else { assert.equal(code, 2); assert.ok(stderr); }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
