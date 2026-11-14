import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runResultSchema, type RunResult } from '../packages/protocol/src/index.js';
import { compareRuns, historyPath, migrate, pruneRuns, readRun, readRuns, readTrends, recordRun, SCHEMA_VERSION, toHistoryRun, trends, type HistoryGate, type HistoryRun } from '../packages/core/src/history.js';
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
  assert.deepEqual(t.flakyGates, [{ id: 'flaky', flips: 3, runs: 5 }], 'a gate without a hash proves nothing, a changed hash explains the flip');
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
    for (const [i, status] of (['passed', 'failed', 'passed', 'failed'] as const).entries()) await recordRun(out, hrun(`r${i}`, `2026-11-0${i + 1}T10:00:00.000Z`, [gate('wobble', status, 10, 'same')]));
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

const legacy = (dir: string, version: number) => {
  const db = new DatabaseSync(historyPath(dir));
  db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, execution TEXT NOT NULL, decision TEXT NOT NULL, duration_ms INTEGER NOT NULL);
CREATE TABLE gates (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, position INTEGER NOT NULL, gate_id TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER NOT NULL, inputs_hash TEXT, PRIMARY KEY (run_id, position));
INSERT INTO runs VALUES ('old', '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:01.000Z', 'completed', 'BLOCK', 1000);
INSERT INTO gates VALUES ('old', 0, 'lint', 'failed', 7, 'h');`);
  db.exec(`PRAGMA user_version = ${version}`); db.close();
};
const version = (dir: string) => { const db = new DatabaseSync(historyPath(dir)); try { return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version; } finally { db.close(); } };

test('a database without a schema version migrates on the next write and keeps its data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-history-'));
  try {
    legacy(dir, 0);
    assert.equal((await readRuns(dir, 5))[0]!.id, 'old', 'readable before migration');
    assert.equal(version(dir), 0, 'a read never writes');
    await recordRun(dir, hrun('new', '2026-10-02T10:00:00.000Z', [gate('lint', 'passed')]));
    assert.equal(version(dir), SCHEMA_VERSION);
    const runs = await readRuns(dir, 5);
    assert.deepEqual(runs.map(r => r.id), ['new', 'old']);
    assert.deepEqual(runs[1]!.gates, [gate('lint', 'failed', 7, 'h')]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a database written by a newer schema is refused with a clear error and left untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-history-'));
  try {
    legacy(dir, SCHEMA_VERSION + 1);
    const newer = new RegExp(`newer.*schema ${SCHEMA_VERSION + 1}.*supports ${SCHEMA_VERSION}`, 'i');
    await assert.rejects(readRuns(dir, 5), newer);
    await assert.rejects(recordRun(dir, hrun('x', '2026-10-02T10:00:00.000Z', [])), newer);
    assert.equal(version(dir), SCHEMA_VERSION + 1);
    const warnings: string[] = [];
    assert.equal(await readTrends(dir, 5, w => warnings.push(w)), undefined);
    assert.match(warnings[0]!, newer);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('readRuns filters by gate, since and decision, and readRun finds one run by id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-history-'));
  try {
    await recordRun(dir, hrun('a', '2026-11-01T10:00:00.000Z', [gate('lint', 'passed'), gate('test', 'failed')]));
    await recordRun(dir, hrun('b', '2026-11-03T10:00:00.000Z', [gate('lint', 'passed')]));
    await recordRun(dir, hrun('c', '2026-11-05T10:00:00.000Z', [gate('lint', 'failed')]));
    const ids = async (filter: Parameters<typeof readRuns>[2]) => (await readRuns(dir, 10, filter)).map(r => r.id);
    assert.deepEqual(await ids({ decision: 'BLOCK' }), ['c', 'a']);
    assert.deepEqual(await ids({ since: '2026-11-03T00:00:00.000Z' }), ['c', 'b']);
    assert.deepEqual(await ids({ gates: ['test'] }), ['a']);
    assert.deepEqual(await ids({ gates: ['test', 'lint'], decision: 'PASS' }), ['b']);
    const narrowed = await readRuns(dir, 10, { gates: ['test'] });
    assert.deepEqual(narrowed[0]!.gates, [gate('test', 'failed')], 'only the selected gates remain');
    assert.equal((await readRun(dir, 'b'))!.gates.length, 1);
    assert.equal(await readRun(dir, 'missing'), undefined);
    assert.equal(await readRun(join(dir, 'none'), 'b'), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('history and trends accept --gate, --since, --decision and --baseline; bad values exit 2', async () => {
  const dir = await project([{ id: 'ok', run: 'true' }]);
  try {
    const out = join(dir, 'out');
    await recordRun(out, hrun('r1', '2026-11-01T10:00:00.000Z', [gate('a', 'passed'), gate('b', 'passed')]));
    await recordRun(out, hrun('r2', '2026-11-02T10:00:00.000Z', [gate('a', 'failed'), gate('b', 'passed')]));
    await recordRun(out, hrun('r3', '2026-11-03T10:00:00.000Z', [gate('a', 'failed'), gate('b', 'failed')]));
    const j = async (...args: string[]) => JSON.parse((await cli(dir, [...args, '--json'])).stdout);
    assert.deepEqual((await j('history', '--decision', 'PASS')).runs.map((r: { id: string }) => r.id), ['r1']);
    assert.deepEqual((await j('history', '--since', '2026-11-02')).runs.map((r: { id: string }) => r.id), ['r3', 'r2']);
    const onlyB = await j('history', '--gate', 'b');
    assert.deepEqual(onlyB.runs[0].gates, { passed: 0, blocked: 1, other: 0 }); assert.deepEqual(onlyB.comparison.newFailures, ['b']);
    const base = await j('history', '--baseline', 'r1');
    assert.equal(base.comparison.previous, 'r1'); assert.deepEqual(base.comparison.regressions, ['a', 'b']);
    assert.match((await cli(dir, ['history', '--baseline', 'r1'])).stdout, /Compared with the baseline run r1:/);
    assert.match((await cli(dir, ['history'])).stdout, /Compared with the previous run r2:/);
    const t = await j('trends', '--gate', 'b', '--since', '2026-11-02', '--decision', 'BLOCK');
    assert.equal(t.runs, 2); assert.deepEqual(t.failingGates.map((g: { id: string }) => g.id), ['b']);
    const missing = await cli(dir, ['history', '--baseline', 'nope']);
    assert.equal(missing.code, 2); assert.match(missing.stderr, /baseline run nope/);
    for (const bad of [['--since', 'yesterday'], ['--decision', 'MAYBE'], ['--baseline', '']]) assert.equal((await cli(dir, ['history', ...bad])).code, 2, bad.join(' '));
    assert.equal((await cli(dir, ['trends', '--baseline', 'r1'])).code, 2);
    assert.equal((await cli(dir, ['run', '--since', '2026-11-01'])).code, 2);
    assert.match((await cli(dir, ['history', '--decision', 'BLOCK', '--gate', 'zzz'])).stdout, /No runs/);
    assert.match((await cli(dir, ['history', '--baseline', 'r3'])).stdout, /baseline run is the newest run/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('loading node:sqlite neither swaps process.emitWarning nor prints its warning, and other warnings still get through', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-history-'));
  const script = `import { recordRun } from ${JSON.stringify(resolve('packages/core/src/history.ts'))};
const emit = process.emitWarning;
const before = process.listeners('warning').length;
process.on('warning', w => { if (w.name === 'CustomWarning') console.log('seen ' + w.message); });
const pending = recordRun(${JSON.stringify(dir)}, { id: 'r', startedAt: 'a', finishedAt: 'a', execution: 'completed', decision: 'PASS', durationMs: 0, gates: [] });
process.emitWarning('during load', 'CustomWarning');
await pending;
console.log('same ' + (process.emitWarning === emit) + ' listeners ' + (process.listeners('warning').length - before));`;
  try {
    await writeFile(join(dir, 'probe.mts'), script);
    const probe = await new Promise<{ stdout: string; stderr: string }>(res => {
      const child = spawn(process.execPath, ['--import', 'tsx', join(dir, 'probe.mts')], { cwd: resolve('.') });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
      child.once('close', () => res({ stdout, stderr }));
    });
    assert.doesNotMatch(probe.stderr, /SQLite/); assert.match(probe.stderr, /CustomWarning: during load/, 'other warnings are printed');
    assert.match(probe.stdout, /same true listeners 1/); assert.match(probe.stdout, /seen during load/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('migrations apply one step at a time from any older version and a failing step rolls the whole upgrade back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-history-'));
  const db = new DatabaseSync(join(dir, 'steps.sqlite'));
  try {
    const steps = ['CREATE TABLE a (x INTEGER);', 'ALTER TABLE a ADD COLUMN y INTEGER;', 'ALTER TABLE a ADD COLUMN z INTEGER;'];
    migrate(db, steps.slice(0, 1));
    db.exec('INSERT INTO a (x) VALUES (1)');
    migrate(db, steps);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);
    assert.deepEqual(db.prepare('SELECT x, y, z FROM a').all().map(r => ({ ...r })), [{ x: 1, y: null, z: null }], 'data survives both later steps');
    migrate(db, steps);
    assert.throws(() => migrate(db, steps.slice(0, 2)), /newer.*schema 3.*supports 2/i);
    const other = new DatabaseSync(join(dir, 'broken.sqlite'));
    try {
      migrate(other, steps.slice(0, 1));
      assert.throws(() => migrate(other, [...steps.slice(0, 1), 'ALTER TABLE a ADD COLUMN y INTEGER;', 'NOT SQL;']));
      assert.equal((other.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1, 'the version is unchanged');
      assert.equal(other.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('a') WHERE name = 'y'").get()!.n, 0, 'the first new step was rolled back too');
    } finally { other.close(); }
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('pruneRuns keeps the newest runs, removes the rest with their gates, and a prune with nothing to remove returns 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-history-'));
  try {
    for (const [id, day] of [['a', '01'], ['b', '02'], ['c', '03']] as const) await recordRun(dir, hrun(id, `2026-11-${day}T10:00:00.000Z`, [gate('lint', 'passed')]));
    assert.equal(await pruneRuns(dir, 5), 0);
    assert.equal(await pruneRuns(dir, 2), 1);
    assert.deepEqual((await readRuns(dir, 10)).map(r => r.id), ['c', 'b']);
    const db = new DatabaseSync(historyPath(dir));
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gates').get()!.n, 2, 'the removed run left no gate rows'); } finally { db.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('qualitygate prune --keep trims the history, reports JSON, and refuses a missing or invalid --keep', async () => {
  const dir = await project([{ id: 'ok', run: 'true' }]);
  try {
    const out = join(dir, 'out');
    for (const [id, day] of [['a', '01'], ['b', '02']] as const) await recordRun(out, hrun(id, `2026-11-${day}T10:00:00.000Z`, [gate('lint', 'passed')]));
    const text = await cli(dir, ['prune', '--keep', '1']);
    assert.equal(text.code, 0, text.stderr); assert.match(text.stdout, /Removed 1 run from the history; kept the newest 1\./);
    assert.deepEqual(JSON.parse((await cli(dir, ['prune', '--keep', '1', '--json'])).stdout), { schemaVersion: 1, kept: 1, removed: 0 });
    assert.match((await cli(dir, ['prune'])).stderr, /needs --keep/);
    assert.notEqual((await cli(dir, ['prune', '--keep', '0'])).code, 0);
    assert.match((await cli(dir, ['prune', '--keep', '1', 'extra'])).stderr, /positional/);
    assert.match((await cli(dir, ['history', '--keep', '1'])).stderr, /does not accept --keep/);
    assert.deepEqual((await readRuns(out, 10)).map(r => r.id), ['b']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
