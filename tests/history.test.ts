import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runResultSchema, type RunResult } from '../packages/protocol/src/index.js';
import { compareRuns, historyPath, readRuns, readTrends, recordRun, toHistoryRun, trends, type HistoryGate, type HistoryRun } from '../packages/core/src/history.js';
import { historyCommand } from '../packages/cli/src/history.js';
import { renderHtml } from '../packages/ci/src/html.js';

const entry = resolve('packages/cli/src/index.ts');
function cli(dir: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((res, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args, '--config', join(dir, '.qualitygate.yml')]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.once('error', reject); child.once('close', code => res({ code, stdout, stderr }));
  });
}
async function project(gates: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), 'qg-history-'));
  await writeFile(join(dir, '.qualitygate.yml'), JSON.stringify({ schemaVersion: 1, outputDir: 'out', gates }));
  return dir;
}
const gate = (id: string, status: HistoryGate['status'], durationMs = 10, inputsHash?: string): HistoryGate => ({ id, status, durationMs, ...(inputsHash ? { inputsHash } : {}) });
function hrun(id: string, startedAt: string, gates: HistoryGate[], over: Partial<HistoryRun> = {}): HistoryRun {
  const blocked = gates.some(g => ['failed', 'timeout', 'error'].includes(g.status));
  return { id, startedAt, finishedAt: startedAt, execution: 'completed', decision: blocked ? 'BLOCK' : 'PASS', durationMs: 1000, gates, ...over };
}

test('toHistoryRun maps gate results to step statuses and input hashes', () => {
  const result: RunResult = runResultSchema.parse({ schemaVersion: 1, runId: 'r1', startedAt: '2026-11-02T10:00:00.000Z', finishedAt: '2026-11-02T10:00:05.000Z',
    execution: 'completed', decision: 'BLOCK', results: [], errors: [], findings: [], gates: [
      { id: 'a', command: 'x', execution: 'completed', decision: 'PASS', exitCode: 0, durationMs: 3, outputTail: '', errors: [] },
      { id: 'b', command: 'x', execution: 'timeout', decision: 'BLOCK', exitCode: null, durationMs: 9, outputTail: '', errors: [] }] });
  const item = toHistoryRun(result, { a: 'h1' });
  assert.equal(item.durationMs, 5000);
  assert.deepEqual(item.gates, [{ id: 'a', status: 'passed', durationMs: 3, inputsHash: 'h1' }, { id: 'b', status: 'timeout', durationMs: 9 }]);
});

test('recordRun and readRuns round trip, newest first, honouring the limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-history-'));
  try {
    assert.deepEqual(await readRuns(dir, 10), [], 'no database yet');
    await recordRun(dir, hrun('r1', '2026-11-01T10:00:00.000Z', [gate('lint', 'passed', 5, 'h'), gate('test', 'failed')]));
    await recordRun(dir, hrun('r2', '2026-11-02T10:00:00.000Z', [gate('lint', 'passed')]));
    await recordRun(dir, hrun('r2', '2026-11-02T10:00:00.000Z', [gate('lint', 'cached')]));
    const runs = await readRuns(dir, 10);
    assert.deepEqual(runs.map(r => r.id), ['r2', 'r1'], 'same id replaces');
    assert.deepEqual(runs[1]!.gates, [gate('lint', 'passed', 5, 'h'), gate('test', 'failed')]);
    assert.equal(runs[0]!.gates[0]!.status, 'cached');
    assert.equal((await readRuns(dir, 1)).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a corrupt or unopenable database throws instead of returning empty history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-history-'));
  try {
    await writeFile(historyPath(dir), 'this is not a database'.repeat(50));
    await assert.rejects(readRuns(dir, 5));
    await assert.rejects(recordRun(dir, hrun('r1', '2026-11-01T10:00:00.000Z', [])));
    await rm(historyPath(dir)); await mkdir(historyPath(dir));
    await assert.rejects(recordRun(dir, hrun('r1', '2026-11-01T10:00:00.000Z', [])));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('compareRuns finds regressions, new failures, fixed gates and newly slow gates', () => {
  const previous = hrun('p', '2026-11-01T10:00:00.000Z', [gate('a', 'passed'), gate('b', 'failed'), gate('c', 'passed', 1000), gate('d', 'failed'), gate('e', 'passed', 100), gate('f', 'cached', 0), gate('g', 'passed')]);
  const current = hrun('c', '2026-11-02T10:00:00.000Z', [gate('a', 'failed'), gate('b', 'passed'), gate('c', 'passed', 2500), gate('d', 'timeout'), gate('e', 'passed', 900),
    gate('f', 'passed', 5000), gate('g', 'skipped'), gate('h', 'error'), gate('i', 'passed')]);
  const diff = compareRuns(current, previous);
  assert.deepEqual(diff, { current: 'c', previous: 'p', regressions: ['a'], newFailures: ['a', 'h'], fixed: ['b'], slower: [{ id: 'c', previousMs: 1000, currentMs: 2500 }] });
});

test('trends: blocks per week, most failing gates and flaky gates', () => {
  const runs = [ // newest first
    hrun('r6', '2026-11-10T10:00:00.000Z', [gate('flaky', 'failed', 1, 'x'), gate('real', 'passed', 1, 'a2'), gate('skip', 'skipped')]),
    hrun('r5', '2026-11-04T10:00:00.000Z', [gate('flaky', 'passed', 1, 'x'), gate('real', 'failed', 1, 'a2'), gate('nohash', 'passed')]),
    hrun('r4', '2026-11-03T10:00:00.000Z', [gate('flaky', 'failed', 1, 'x'), gate('real', 'passed', 1, 'a1'), gate('nohash', 'failed')]),
    hrun('r3', '2026-11-02T10:00:00.000Z', [gate('flaky', 'passed', 1, 'x'), gate('real', 'passed', 1, 'a1'), gate('nohash', 'passed')]),
    hrun('r2', '2026-11-01T10:00:00.000Z', [gate('flaky', 'passed', 1, 'x'), gate('real', 'passed', 1, 'a1'), gate('nohash', 'passed')], { decision: 'PASS' }),
  ];
  const t = trends(runs);
  assert.equal(t.runs, 5);
  assert.deepEqual(t.weeks, [{ week: '2026-10-26', runs: 1, blocked: 0 }, { week: '2026-11-02', runs: 3, blocked: 2 }, { week: '2026-11-09', runs: 1, blocked: 1 }]);
  assert.deepEqual(t.failingGates.map(g => [g.id, g.failures, g.runs]), [['flaky', 2, 5], ['nohash', 1, 4], ['real', 1, 5]]);
  assert.deepEqual(t.flakyGates, [{ id: 'flaky', flips: 3, runs: 5 }, { id: 'nohash', flips: 2, runs: 4 }]);
});

test('readTrends is undefined without history and soft on a broken database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-history-'));
  try {
    assert.equal(await readTrends(dir, 10, () => assert.fail('no warning without history')), undefined);
    await recordRun(dir, hrun('r1', '2026-11-01T10:00:00.000Z', [gate('a', 'failed')]));
    assert.equal((await readTrends(dir, 10, () => assert.fail('readable')))!.runs, 1);
    await rm(historyPath(dir)); await writeFile(historyPath(dir), 'garbage'.repeat(100));
    const warnings: string[] = [];
    assert.equal(await readTrends(dir, 10, w => warnings.push(w)), undefined);
    assert.match(warnings[0]!, /history/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('renderHtml adds an escaped trends section only when history exists', () => {
  const base = runResultSchema.parse({ schemaVersion: 1, runId: 'r', startedAt: '2026-11-02T10:00:00.000Z', finishedAt: '2026-11-02T10:00:05.000Z', execution: 'completed', decision: 'PASS', results: [], errors: [] });
  assert.doesNotMatch(renderHtml(base), /Trends/);
  const html = renderHtml(base, { runs: 4, weeks: [{ week: '2026-11-02', runs: 4, blocked: 2 }, { week: '2026-11-09', runs: 1, blocked: 0 }], failingGates: [{ id: 'l<b>', failures: 2, runs: 4 }], flakyGates: [{ id: 'f&', flips: 2, runs: 4 }] });
  assert.match(html, /Trends \(last 4 recorded runs\)/); assert.match(html, /2026-11-02/); assert.match(html, /l&lt;b&gt;/); assert.match(html, /f&amp;/);
  assert.doesNotMatch(html, /<script/i);
  const empty = renderHtml(base, { runs: 1, weeks: [], failingGates: [], flakyGates: [] });
  assert.match(empty, /No failing gates/); assert.match(empty, /No flaky gates/);
});

test('run records history; history and trends commands report it, with --json', async () => {
  const dir = await project([{ id: 'ok', run: 'true' }, { id: 'flip', run: 'test ! -f flip.flag' }]);
  try {
    assert.match((await cli(dir, ['history'])).stdout, /No runs recorded/);
    assert.deepEqual(JSON.parse((await cli(dir, ['history', '--json'])).stdout), { schemaVersion: 1, runs: [], comparison: null });
    assert.equal((await cli(dir, ['run'])).code, 0);
    assert.match((await cli(dir, ['history'])).stdout, /No previous run to compare/);
    await writeFile(join(dir, 'flip.flag'), '');
    const failed = await cli(dir, ['run']); assert.equal(failed.code, 1); assert.equal(failed.stderr, '');
    const text = await cli(dir, ['history']);
    assert.equal(text.code, 0);
    assert.match(text.stdout, /BLOCK/); assert.match(text.stdout, /PASS/); assert.match(text.stdout, /Regressions \(passed before, blocks now\): flip/);
    const data = JSON.parse((await cli(dir, ['history', '--json', '--limit', '1'])).stdout);
    assert.equal(data.runs.length, 1); assert.deepEqual(data.runs[0].gates, { passed: 1, blocked: 1, other: 0 }); assert.deepEqual(data.comparison.regressions, ['flip']);
    const both = JSON.parse((await cli(dir, ['history', '--json'])).stdout);
    assert.deepEqual(both.comparison.regressions, ['flip']); assert.equal(both.runs.length, 2);
    const t = await cli(dir, ['trends']);
    assert.equal(t.code, 0); assert.match(t.stdout, /Blocks per week/); assert.match(t.stdout, /flip/);
    const tj = JSON.parse((await cli(dir, ['trends', '--json', '--limit', '5'])).stdout);
    assert.equal(tj.runs, 2); assert.equal(tj.failingGates[0].id, 'flip');
    assert.match((await cli(dir, ['trends', '--limit', '0'])).stderr, /QualityGate/);
    assert.equal((await cli(dir, ['history', 'extra'])).code, 2);
    assert.equal((await cli(dir, ['run', '--limit', '3'])).code, 2);
    const exported = await cli(dir, ['export', '--out', join(dir, 'site')]);
    assert.equal(exported.code, 0); assert.match(await readFile(join(dir, 'site', 'index.html'), 'utf8'), /Trends/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('trends text shows a flaky gate and an empty history', async () => {
  const dir = await project([{ id: 'ok', run: 'true' }]);
  try {
    assert.match((await cli(dir, ['trends'])).stdout, /No runs recorded/);
    assert.deepEqual(JSON.parse((await cli(dir, ['trends', '--json'])).stdout), { schemaVersion: 1, runs: 0, weeks: [], failingGates: [], flakyGates: [] });
    const out = join(dir, 'out');
    for (const [i, status] of (['passed', 'failed', 'passed', 'failed'] as const).entries()) await recordRun(out, hrun(`r${i}`, `2026-11-0${i + 1}T10:00:00.000Z`, [gate('wobble', status)]));
    const text = (await cli(dir, ['trends'])).stdout;
    assert.match(text, /Flaky gates/); assert.match(text, /wobble/);
    const none = await project([{ id: 'ok', run: 'true' }]);
    try {
      await recordRun(join(none, 'out'), hrun('r', '2026-11-01T10:00:00.000Z', [gate('a', 'passed')]));
      const clean = (await cli(none, ['trends'])).stdout; assert.match(clean, /failing gates:\n  none/); assert.match(clean, /Flaky gates[^\n]*\n  none/);
      const h = (await cli(none, ['history'])).stdout; assert.match(h, /1 pass/);
    } finally { await rm(none, { recursive: true, force: true }); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a broken history database never changes the verdict or exit code of run', async () => {
  const dir = await project([{ id: 'ok', run: 'true' }, { id: 'bad', run: 'false' }]);
  try {
    await mkdir(join(dir, 'out'), { recursive: true });
    await writeFile(historyPath(join(dir, 'out')), 'not a database'.repeat(100));
    const result = await cli(dir, ['run', '--json']);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).decision, 'BLOCK');
    assert.match(result.stderr, /warning: run history not saved/);
    const read = await cli(dir, ['history']);
    assert.equal(read.code, 2); assert.match(read.stderr, /QualityGate/);
    const exported = await cli(dir, ['export', '--out', join(dir, 'site')]);
    assert.equal(exported.code, 0); assert.match(exported.stderr, /warning/i);
    assert.doesNotMatch(await readFile(join(dir, 'site', 'index.html'), 'utf8'), /Trends/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('history text marks runs that did not complete and names newly slow gates', async () => {
  const dir = await project([{ id: 'ok', run: 'true' }]);
  try {
    const out = join(dir, 'out');
    await recordRun(out, hrun('old', '2026-11-01T10:00:00.000Z', [gate('build', 'passed', 1000)]));
    await recordRun(out, hrun('new', '2026-11-02T10:00:00.000Z', [gate('build', 'passed', 4000)], { execution: 'interrupted' }));
    const text = await historyCommand(join(dir, '.qualitygate.yml'), 10, false);
    assert.match(text, /new  2026-11-02T10:00:00.000Z  PASS \(interrupted\)  1.0s  1 pass, 0 block, 0 other/);
    assert.match(text, /Newly slow: build \(1.0s -> 4.0s\)/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
