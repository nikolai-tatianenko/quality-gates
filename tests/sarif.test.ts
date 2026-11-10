import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSarif } from '../packages/ci/src/sarif.js';
import { runResultSchema } from '../packages/protocol/src/index.js';
const run = (findings: unknown[], extra = {}) => runResultSchema.parse({ schemaVersion: 1, runId: 'r1', startedAt: '2026-11-05T10:00:00.000Z', finishedAt: '2026-11-05T10:00:01.000Z',
  execution: 'completed', decision: 'BLOCK', results: [], errors: [], findings, ...extra });
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
test('a run that is not PASS never looks clean: failed gates become results and executionSuccessful follows the run', () => {
  const gate = (id: string, execution: string, decision: string, extra = {}) => ({ id, command: 'x', execution, decision, exitCode: 1, durationMs: 1, outputTail: '', errors: ['boom'], ...extra });
  const lintFinding = { gateId: 'lint', severity: 'error', message: 'bad' };
  const sarif = JSON.parse(renderSarif(run([lintFinding], { gates: [gate('unit', 'completed', 'BLOCK'), gate('e2e', 'timeout', 'BLOCK'), gate('ok', 'completed', 'PASS'),
    gate('lint', 'completed', 'BLOCK', { findings: [lintFinding] })] })));
  const [only] = sarif.runs;
  assert.equal(only.invocations[0].executionSuccessful, false);
  assert.deepEqual(only.results.map((result: { ruleId: string }) => result.ruleId), ['lint', 'unit', 'e2e']);
  assert.equal(only.results[1].level, 'error'); assert.match(only.results[1].message.text, /BLOCK/); assert.match(only.results[1].message.text, /completed/);
  assert.match(only.results[2].message.text, /timeout/);
  assert.deepEqual(only.tool.driver.rules.map((rule: { id: string }) => rule.id), ['lint', 'unit', 'e2e']);
  const skipped = JSON.parse(renderSarif(run([], { gates: [gate('slow', 'skipped', 'BLOCK', { skipped: 'dependency unit did not pass', errors: [] })] }))).runs[0].results;
  assert.match(skipped[0].message.text, /dependency unit did not pass/); assert.doesNotMatch(skipped[0].message.text, /:\s*$/);
  const url = { url: 'https://example.com/', execution: 'completed', decision: 'BLOCK', scores: {}, violations: ['performance 50 < 80'], errors: [] };
  const audit = JSON.parse(renderSarif(run([], { results: [url] }))).runs[0].results;
  assert.equal(audit.length, 1); assert.match(audit[0].message.text, /performance 50 < 80/);
  const bare = JSON.parse(renderSarif(run([], { results: [{ ...url, violations: [] }] }))).runs[0].results;
  assert.match(bare[0].message.text, /no detail/);
  const passed = JSON.parse(renderSarif(run([], { decision: 'PASS' }))).runs[0];
  assert.equal(passed.invocations[0].executionSuccessful, true); assert.deepEqual(passed.results, []);
  const crashed = JSON.parse(renderSarif(run([], { decision: 'PASS', execution: 'error', errors: ['config broke'] }))).runs[0];
  assert.equal(crashed.invocations[0].executionSuccessful, false); assert.match(crashed.results[0].message.text, /config broke/);
});
test('SARIF file uris are relative and normalised; absolute or escaping paths are emitted without a location', () => {
  const uri = (file: string) => JSON.parse(renderSarif(run([{ gateId: 'l', severity: 'error', message: 'm', file }]))).runs[0].results[0].locations?.[0].physicalLocation.artifactLocation.uri;
  assert.equal(uri('./src//a b.ts'), 'src/a%20b.ts'); assert.equal(uri('src/../lib/x.ts'), 'lib/x.ts');
  assert.equal(uri(join(process.cwd(), 'src', 'a.ts')), 'src/a.ts');
  for (const file of ['/etc/passwd', '../x.ts', 'a/../../x.ts', 'C:\\proj\\a.ts', '\\\\host\\share\\a.ts', '..', '.']) assert.equal(uri(file), undefined, file);
});
test('SARIF uris resolve against the project root, not the working directory, and escape # and ?', () => {
  const root = join(tmpdir(), 'qg-sarif-root');
  const uri = (file: string, base?: string) => JSON.parse(renderSarif(run([{ gateId: 'l', severity: 'error', message: 'm', file }]), base)).runs[0].results[0].locations?.[0].physicalLocation.artifactLocation.uri;
  assert.equal(uri(join(root, 'src', 'a.ts'), root), 'src/a.ts');
  assert.equal(uri(join(process.cwd(), 'src', 'a.ts'), root), undefined);
  assert.equal(uri('src/a#1?.ts'), 'src/a%231%3F.ts');
});
test('a skipped gate is a note, a blocked one stays an error', () => {
  const gate = (id: string, extra = {}) => ({ id, command: 'x', execution: 'skipped', decision: 'BLOCK', exitCode: 0, durationMs: 0, outputTail: '', errors: [], ...extra });
  const results = JSON.parse(renderSarif(run([], { gates: [gate('slow', { skipped: 'skip: needs network' }), gate('dead', { execution: 'error', errors: ['boom'] })] }))).runs[0].results;
  assert.deepEqual(results.map((result: { level: string }) => result.level), ['note', 'error']);
});
test('a help URL that is not http(s) is dropped from the finding without invalidating the run', () => {
  const [bad, good] = run([{ gateId: 'a', severity: 'error', message: 'm', helpUrl: 'javascript:alert(1)' }, { gateId: 'a', severity: 'error', message: 'm', helpUrl: 'http://x.test/r' }]).findings;
  assert.equal(bad?.helpUrl, undefined); assert.equal(JSON.stringify(bad).includes('helpUrl'), false); assert.equal(good?.helpUrl, 'http://x.test/r');
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
    const both = await cli(dir, ['report', '--input', input, '--sarif', '--json']);
    assert.equal(both.code, 0, both.stderr); const payload = JSON.parse(both.stdout);
    assert.equal(JSON.parse(payload.sarif).version, '2.1.0'); assert.equal(payload.markdown, undefined);
    assert.match((await cli(dir, ['--help'])).stdout, /--json prints .*--output/s);
    const target = join(dir, 'out.sarif');
    const written = await cli(dir, ['report', '--input', input, '--sarif', '--output', target, '--json']);
    assert.equal(written.code, 0, written.stderr); assert.equal(JSON.parse(written.stdout).output, target);
    assert.equal(JSON.parse(await readFile(target, 'utf8')).runs[0].results.length, 1);
    const project = join(dir, 'proj');
    await writeFile(input, JSON.stringify(run([{ gateId: 'l', severity: 'error', message: 'm', file: join(project, 'src', 'a.ts') }])));
    const rooted = await cli(dir, ['report', '--input', input, '--sarif', '--config', join(project, '.qualitygate.yml')]);
    assert.equal(rooted.code, 0, rooted.stderr); assert.equal(JSON.parse(rooted.stdout).runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'src/a.ts');
    const bad = await cli(dir, ['export', '--out', dir, '--sarif']);
    assert.notEqual(bad.code, 0); assert.match(bad.stderr, /does not accept --sarif/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
