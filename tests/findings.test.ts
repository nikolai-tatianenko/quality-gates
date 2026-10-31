import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEslintReport } from '../packages/plugins/eslint/src/index.js';
import { execute } from '../packages/cli/src/runner.js';
import { chromeStartupMessage } from '../packages/plugins/lighthouse/src/index.js';
import { runResultSchema } from '../packages/protocol/src/index.js';
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
test('ESLint normalizes locations, severity and rule IDs without inventing missing locations', () => {
  assert.deepEqual(parseEslintReport(JSON.stringify([{ filePath: '/project/src/a.js', messages: [
    { severity: 2, message: 'unused', ruleId: 'no-unused-vars', line: 2, column: 7 },
    { severity: 1, message: 'configuration warning', ruleId: null, line: null, column: 0 },
  ] }]), 'lint', '/project'), [
    { gateId: 'lint', severity: 'error', message: 'unused', ruleId: 'no-unused-vars', file: 'src/a.js', line: 2, column: 7 },
    { gateId: 'lint', severity: 'warning', message: 'configuration warning', file: 'src/a.js' },
  ]);
  for (const raw of ['broken', '{}', '[{"filePath":"a","messages":[{}]}]']) assert.throws(() => parseEslintReport(raw, 'lint', '/project'));
});
test('real ESLint plugin produces BLOCK findings, raw evidence and PASS after a source fix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-eslint-'));
  try {
    const eslint = resolve('node_modules/eslint/bin/eslint.js');
    await writeFile(join(dir, 'eslint.config.mjs'), 'export default [{rules:{"no-unused-vars":"error"}}];\n');
    await writeFile(join(dir, 'source.mjs'), 'const unused = 1;\n');
    const path = join(dir, '.qualitygate.yml');
    await writeFile(path, JSON.stringify({ schemaVersion: 1, gates: [
      { id: 'lint', type: 'eslint', run: `${shellQuote(process.execPath)} ${shellQuote(eslint)} . --format json` },
    ] }));
    const blocked = await execute(path, new AbortController().signal);
    assert.equal(blocked.execution, 'completed'); assert.equal(blocked.decision, 'BLOCK');
    const finding = blocked.findings[0]!;
    assert.equal(finding.file, 'source.mjs'); assert.equal(finding.line, 1); assert.equal(finding.ruleId, 'no-unused-vars');
    assert.equal(finding.evidencePath, blocked.gates[0]!.reportPath);
    const evidence = JSON.parse(await readFile(finding.evidencePath!, 'utf8')) as { messages: unknown[] }[];
    assert.ok(evidence.some(file => file.messages.length > 0));
    assert.deepEqual(runResultSchema.parse(JSON.parse(await readFile(blocked.reportPath!, 'utf8'))), runResultSchema.parse(JSON.parse(JSON.stringify(blocked))));
    await writeFile(join(dir, 'source.mjs'), 'export const value = 1;\n');
    const passed = await execute(path, new AbortController().signal);
    assert.equal(passed.decision, 'PASS'); assert.deepEqual(passed.findings, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('invalid ESLint JSON and missing executables are execution errors with retained evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-eslint-error-'));
  try {
    const config = join(dir, '.qualitygate.yml');
    for (const command of ['printf malformed', 'qualitygate-no-such-eslint']) {
      await writeFile(config, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'lint', type: 'eslint', run: command }] }));
      const result = await execute(config, new AbortController().signal);
      assert.equal(result.execution, 'error'); assert.equal(result.decision, 'BLOCK');
      assert.ok(result.gates[0]!.errors.length); assert.ok(result.gates[0]!.evidencePath);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Chrome diagnostics retain sandbox errors and recommend an explicit isolated-container opt-in', () => {
  const error = chromeStartupMessage(new Error('ECONNREFUSED'), 'Running as root without --no-sandbox is not supported');
  assert.match(error, /ECONNREFUSED/); assert.match(error, /chrome.noSandbox: true/);
  assert.doesNotMatch(chromeStartupMessage('ENOENT', ''), /chrome.noSandbox/);
});
test('captured ESLint JSON preserves UTF-8 characters split across stdout chunks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-eslint-utf8-'));
  try {
    const report = JSON.stringify([{ filePath: join(dir, 'source.mjs'), messages: [{ severity: 2, message: 'caf\u00e9', ruleId: 'test', line: 1 }] }]);
    const data = Buffer.from(report); const split = data.indexOf(Buffer.from('\u00e9')) + 1;
    await writeFile(join(dir, 'writer.cjs'), `const b=Buffer.from(${JSON.stringify(data.toString('base64'))},'base64');process.exitCode=1;process.stdout.write(b.subarray(0,${split}));setTimeout(()=>process.stdout.write(b.subarray(${split})),20);`);
    const config = join(dir, '.qualitygate.yml');
    await writeFile(config, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'lint', type: 'eslint', run: 'node writer.cjs' }] }));
    const result = await execute(config, new AbortController().signal);
    assert.equal(result.execution, 'completed'); assert.equal(result.findings[0]?.message, 'caf\u00e9');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('ESLint distinguishes info findings, inconsistent exit codes and capture overflow', async () => {
  assert.equal(parseEslintReport('[{"filePath":"a.js","messages":[{"severity":0,"message":"info"}]}]', 'lint', '/project')[0]?.severity, 'info');
  const dir = await mkdtemp(join(tmpdir(), 'qg-eslint-limits-'));
  try {
    const cases = [
      { code: 'process.stdout.write("x".repeat(1000001))', error: /1 MB/ },
      { code: 'console.log("[]");process.exitCode=2', error: /exit 2/ },
      { code: 'console.log(JSON.stringify([{filePath:"a.js",messages:[{severity:2,message:"error"}]}]))', error: /exited 0/ },
    ];
    for (const scenario of cases) {
      await writeFile(join(dir, 'writer.cjs'), scenario.code);
      const config = join(dir, '.qualitygate.yml');
      await writeFile(config, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'lint', type: 'eslint', run: 'node writer.cjs' }] }));
      const result = await execute(config, new AbortController().signal);
      assert.equal(result.execution, 'error'); assert.match(result.gates[0]!.errors.join(), scenario.error);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
