import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSarif } from '../packages/ci/src/sarif.js';
import { runResultSchema } from '../packages/protocol/src/index.js';
const run = (findings: unknown[]) => runResultSchema.parse({ schemaVersion: 1, runId: 'r1', startedAt: '2026-11-05T10:00:00.000Z', finishedAt: '2026-11-05T10:00:01.000Z',
  execution: 'completed', decision: 'BLOCK', results: [], errors: [], findings });
test('SARIF 2.1.0 structure: tool driver, rules, levels, messages and locations only when a file exists', () => {
  const sarif = JSON.parse(renderSarif(run([
    { gateId: 'a11y', severity: 'error', ruleId: 'color-contrast', message: 'Low contrast (.btn)', helpUrl: 'https://example.com/rule' },
    { gateId: 'lint', severity: 'warning', ruleId: 'no-var', message: 'Use let', file: 'src\\a.ts', line: 3, column: 5 },
    { gateId: 'lint', severity: 'info', message: 'Note', file: 'src/b.ts' },
    { gateId: 'lint', severity: 'warning', ruleId: 'no-var', message: 'Again' },
  ])));
  assert.equal(sarif.version, '2.1.0'); assert.match(sarif.$schema, /sarif-schema-2\.1\.0\.json$/);
  const [only] = sarif.runs; assert.equal(sarif.runs.length, 1);
  assert.equal(only.tool.driver.name, 'QualityGate');
  assert.deepEqual(only.tool.driver.rules.map((rule: { id: string }) => rule.id), ['color-contrast', 'no-var', 'lint']);
  assert.equal(only.tool.driver.rules[0].helpUri, 'https://example.com/rule');
  assert.deepEqual(only.results.map((result: { ruleId: string; level: string }) => [result.ruleId, result.level]),
    [['color-contrast', 'error'], ['no-var', 'warning'], ['lint', 'note'], ['no-var', 'warning']]);
  assert.equal(only.results[0].message.text, 'Low contrast (.btn)'); assert.equal(only.results[0].locations, undefined);
  assert.deepEqual(only.results[1].locations[0].physicalLocation, { artifactLocation: { uri: 'src/a.ts', uriBaseId: '%SRCROOT%' }, region: { startLine: 3, startColumn: 5 } });
  assert.deepEqual(only.results[2].locations[0].physicalLocation, { artifactLocation: { uri: 'src/b.ts', uriBaseId: '%SRCROOT%' } });
  assert.equal(only.results[1].ruleIndex, 1);
});
test('a run without findings still yields a valid empty SARIF run', () => {
  assert.deepEqual(JSON.parse(renderSarif(run([]))).runs[0].results, []);
});
const entry = resolve('packages/cli/src/index.ts');
function cli(dir: string, args: string[]) {
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), entry, ...args], { cwd: dir });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((res, reject) => {
    child.once('error', reject); child.once('close', code => res({ code, stdout, stderr }));
  });
}
test('qualitygate report --sarif prints or writes SARIF and is refused on other commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-sarif-'));
  try {
    const input = join(dir, 'run.json');
    await writeFile(input, JSON.stringify(run([{ gateId: 'a11y', severity: 'error', message: 'bad', ruleId: 'x' }])));
    const out = await cli(dir, ['report', '--input', input, '--sarif']);
    assert.equal(out.code, 0, out.stderr); assert.equal(JSON.parse(out.stdout).version, '2.1.0');
    const target = join(dir, 'out.sarif');
    const written = await cli(dir, ['report', '--input', input, '--sarif', '--output', target, '--json']);
    assert.equal(written.code, 0, written.stderr); assert.equal(JSON.parse(written.stdout).output, target);
    assert.equal(JSON.parse(await readFile(target, 'utf8')).runs[0].results.length, 1);
    const bad = await cli(dir, ['export', '--out', dir, '--sarif']);
    assert.notEqual(bad.code, 0); assert.match(bad.stderr, /does not accept --sarif/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
