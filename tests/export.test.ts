import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runResultSchema, type RunResult } from '../packages/protocol/src/index.js';
import { renderHtml, escapeHtml } from '../packages/ci/src/html.js';

const base = { schemaVersion: 1, runId: 'run-<1>', startedAt: '2026-11-02T10:00:00.000Z', finishedAt: '2026-11-02T10:00:05.000Z',
  execution: 'completed', decision: 'BLOCK', results: [], gates: [], errors: [], findings: [] } as const;
test('renderHtml is self-contained, escapes run data and has no scripts or remote resources', () => {
  const run: RunResult = runResultSchema.parse({ ...base, errors: ['<img src=x onerror=alert(1)>'],
    results: [{ url: 'https://example.com/?a=1&b=2', execution: 'completed', decision: 'BLOCK', scores: { performance: 40 }, violations: ['low <score>'], errors: [], evidencePath: '/ev/a.json' }],
    gates: [{ id: 'lint"<b>', command: 'x', execution: 'completed', decision: 'BLOCK', exitCode: 1, durationMs: 12, outputTail: '<script>alert(1)</script>', errors: ['gate & error'], evidencePath: '/ev/g' },
      { id: 'ok', command: 'x', execution: 'completed', decision: 'PASS', exitCode: 0, durationMs: 1, outputTail: 'quiet', errors: [], reportPath: '/ev/r.xml' },
      { id: 'err', command: 'x', execution: 'error', decision: 'BLOCK', exitCode: null, durationMs: 0, outputTail: '', errors: [] }],
    findings: [{ gateId: 'lint', severity: 'error', message: 'bad <thing>', file: 'src/a.ts', line: 3, ruleId: 'r<1>', evidencePath: '/ev/f' },
      { gateId: 'lint', severity: 'warning', message: 'no file' }] });
  const html = renderHtml(run);
  assert.match(html, /^<!doctype html>/); assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<script/i); assert.doesNotMatch(html, /<img/); assert.doesNotMatch(html, /(?:src|href)=["']?https?:/i);
  assert.doesNotMatch(html, /<link/i); assert.doesNotMatch(html, /@import|url\(/);
  assert.match(html, /run-&lt;1&gt;/); assert.match(html, /lint&quot;&lt;b&gt;/); assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /src\/a\.ts:3/); assert.match(html, /r&lt;1&gt;/); assert.match(html, /low &lt;score&gt;/); assert.match(html, /a=1&amp;b=2/);
  assert.match(html, /prefers-color-scheme: dark/); assert.match(html, /\/ev\/r\.xml/);
  assert.doesNotMatch(html, /quiet/, 'PASS output is not included');
});
test('renderHtml shows execution errors and an empty run', () => {
  const html = renderHtml(runResultSchema.parse({ ...base, execution: 'interrupted', decision: 'PASS' }));
  assert.match(html, /INTERRUPTED/); assert.match(html, /No findings/); assert.equal(escapeHtml(`'`), '&#39;');
  assert.match(renderHtml(runResultSchema.parse({ ...base, execution: 'completed', decision: 'PASS' })), /PASS/);
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
test('qualitygate export writes index.html and report.json for the last run or --input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-export-'));
  try {
    const config = join(dir, '.qualitygate.yml');
    await writeFile(config, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'fail', run: 'echo "<b>boom</b>"; exit 1' }] }));
    const none = await cli(dir, ['export', '--out', join(dir, 'site'), '--config', config]);
    assert.equal(none.code, 2); assert.match(none.stderr, /No runs found/);
    assert.equal((await cli(dir, ['run', '--config', config])).code, 1);
    const out = join(dir, 'site', 'nested');
    const done = await cli(dir, ['export', '--out', out, '--config', config, '--json']);
    assert.equal(done.code, 0); assert.equal(JSON.parse(done.stdout).index, join(out, 'index.html'));
    const html = await readFile(join(out, 'index.html'), 'utf8');
    assert.match(html, /&lt;b&gt;boom&lt;\/b&gt;/); assert.doesNotMatch(html, /<script/);
    const run = runResultSchema.parse(JSON.parse(await readFile(join(out, 'report.json'), 'utf8'))); assert.equal(run.decision, 'BLOCK');
    const input = join(dir, 'run.json'); await writeFile(input, JSON.stringify(run));
    const text = await cli(dir, ['export', '--out', out, '--input', input]);
    assert.equal(text.code, 0); assert.match(text.stdout, /index\.html/);
    for (const args of [['export'], ['export', '--out', out, 'extra'], ['export', '--out', out, '--provider', 'x']]) assert.equal((await cli(dir, args)).code, 2);
    assert.equal((await cli(dir, ['export', '--out', out, '--input', join(dir, 'missing.json')])).code, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
