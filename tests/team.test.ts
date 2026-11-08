import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runResultSchema, type RunResult } from '../packages/protocol/src/index.js';
import type { HistoryGate, HistoryRun } from '../packages/core/src/history.js';
import { buildTeamReport, reproduceCommand, shellWord, teamMarkdown } from '../packages/core/src/team.js';

const gate = (id: string, status: HistoryGate['status'], durationMs = 100, inputsHash?: string): HistoryGate => ({ id, status, durationMs, ...(inputsHash ? { inputsHash } : {}) });
/** Runs one hour apart starting 2026-11-02T10:00Z, so run n started at hour 10+n. */
function hrun(n: number, gates: HistoryGate[], over: Partial<HistoryRun> = {}): HistoryRun {
  const start = new Date(Date.UTC(2026, 10, 2, 10 + n)).toISOString();
  const blocked = gates.some(g => ['failed', 'timeout', 'error'].includes(g.status));
  return { id: `run-${n}-aaaaaaaa`, startedAt: start, finishedAt: new Date(Date.parse(start) + 60_000).toISOString(), execution: 'completed', decision: blocked ? 'BLOCK' : 'PASS', durationMs: 60_000, gates, ...over };
}
function stored(over: Record<string, unknown> = {}): RunResult {
  return runResultSchema.parse({ schemaVersion: 1, runId: 'run-3-aaaaaaaa', startedAt: '2026-11-02T13:00:00.000Z', finishedAt: '2026-11-02T13:00:04.000Z',
    execution: 'completed', decision: 'BLOCK', errors: [], results: [], findings: [], steps: [],
    gates: [
      { id: 'lint', command: 'eslint SECRET-IN-COMMAND', execution: 'completed', decision: 'BLOCK', exitCode: 1, durationMs: 50, outputTail: 'TOKEN=abc123 leaked', errors: ['boom TOKEN=abc123'],
        findings: [{ gateId: 'lint', severity: 'warning', message: 'unused  variable\nx', file: 'src/b.ts', line: 7, ruleId: 'no-unused' },
          { gateId: 'lint', severity: 'error', message: 'too complex', file: 'src/a.ts', line: 3, column: 9, ruleId: 'complexity', helpUrl: 'https://docs.example/complexity', evidencePath: '/abs/evidence.json' },
          { gateId: 'lint', severity: 'info', message: 'no file here' }, { gateId: 'lint', severity: 'error', message: 'file only', file: 'src/c.ts' }] },
      { id: 'tests', command: 'x', execution: 'completed', decision: 'PASS', exitCode: 0, durationMs: 5, outputTail: '', errors: [] },
      { id: 'dep', command: 'x', execution: 'skipped', decision: 'BLOCK', exitCode: null, durationMs: 0, outputTail: '', errors: [], skipped: 'lint did not pass' },
    ], ...over });
}

test('shell words and reproduce commands are safe to paste', () => {
  assert.equal(shellWord('lint:ts-1.2/a'), 'lint:ts-1.2/a');
  assert.equal(shellWord("it's; rm -rf ~"), "'it'\\''s; rm -rf ~'");
  assert.equal(reproduceCommand('lint'), 'qualitygate run --gate lint');
  assert.equal(reproduceCommand('a b', 'my config.yml'), "qualitygate run --config 'my config.yml' --gate 'a b'");
  assert.equal(reproduceCommand(undefined), 'qualitygate run');
  assert.equal(reproduceCommand('x', '.qualitygate.yml'), 'qualitygate run --gate x');
});

test('an empty project has no current run, no comparison and no risks', () => {
  const report = buildTeamReport({ runs: [] });
  assert.equal(report.current, null); assert.equal(report.headline, 'No run recorded yet');
  assert.deepEqual([report.changes, report.risks, report.runs, report.engineer, report.blockingGates], [null, [], [], [], []]);
  assert.deepEqual(report.timeToGreen, { spans: [], medianMs: null, openSince: null });
  assert.match(teamMarkdown(report), /No run recorded yet/);
  assert.doesNotMatch(teamMarkdown(report), /Top risks|Time to green: median/);
});

test('the current decision and exit code come from the stored run; blocking gates carry sorted findings and a reproduce command', () => {
  const runs = [hrun(3, [gate('lint', 'failed'), gate('tests', 'passed')]), hrun(2, [gate('lint', 'passed'), gate('tests', 'passed')])];
  const report = buildTeamReport({ runs: [...runs], latest: stored(), configName: '.qualitygate.yml' });
  assert.deepEqual(report.current, { runId: 'run-3-aaaaaaaa', startedAt: '2026-11-02T13:00:00.000Z', decision: 'BLOCK', execution: 'completed', exitCode: 1, durationMs: 4000 });
  assert.deepEqual(report.blockingGates, ['lint']);
  assert.equal(report.headline, 'BLOCK: 1 blocking: lint');
  assert.deepEqual(report.changes?.regressions, ['lint']);
  assert.deepEqual(report.risks, [{ gateId: 'lint', kind: 'regression', detail: 'passed in the previous run and blocks now' }]);
  const [lint] = report.engineer; assert.ok(lint);
  assert.equal(lint.reproduce, 'qualitygate run --gate lint'); assert.equal(lint.status, 'failed');
  assert.deepEqual(lint.findings.map(f => f.location), ['src/a.ts:3:9', 'src/c.ts', 'src/b.ts:7', 'lint']);
  assert.deepEqual(lint.findings.map(f => f.severity), ['error', 'error', 'warning', 'info']);
  assert.equal(lint.findings[0]!.helpUrl, 'https://docs.example/complexity'); assert.equal(lint.findings[2]!.message, 'unused variable x');
  const text = JSON.stringify(report);
  for (const secret of ['TOKEN=abc123', 'SECRET-IN-COMMAND', '/abs/evidence.json']) assert.ok(!text.includes(secret), `${secret} must not leave the view`);
});

test('findings beyond the first ten are counted, long messages are clipped, audits list violations', () => {
  const many = Array.from({ length: 13 }, (_, i) => ({ gateId: 'lint', severity: 'error', message: i === 0 ? 'x'.repeat(400) : `m${i}`, file: 'f.ts', line: i + 1 }));
  const latest = stored({ gates: [{ id: 'lint', command: 'x', execution: 'completed', decision: 'BLOCK', exitCode: 1, durationMs: 1, outputTail: '', errors: [], findings: many }],
    results: [{ url: 'http://site', execution: 'completed', decision: 'BLOCK', scores: {}, violations: ['performance 40 < 50'], errors: [] },
      { url: 'http://ok', execution: 'completed', decision: 'PASS', scores: {}, violations: [], errors: [] }] });
  const report = buildTeamReport({ runs: [], latest, configName: 'other.yml' });
  const [lint, audit] = report.engineer; assert.ok(lint && audit);
  assert.equal(lint.findings.length, 10); assert.equal(lint.omittedFindings, 3); assert.equal(lint.findings[0]!.message.length, 300); assert.ok(lint.findings[0]!.message.endsWith('…'));
  assert.deepEqual([audit.kind, audit.id, audit.violations, audit.reproduce], ['audit', 'http://site', ['performance 40 < 50'], 'qualitygate run --config other.yml']);
  assert.deepEqual(report.blockingGates, ['lint']);
  const md = teamMarkdown(report);
  assert.match(md, /and 3 more findings/); assert.match(md, /performance 40 \\< 50/);
});

test('without a stored run the history alone gives the decision, the blocking gates and exit codes', () => {
  const codes = { completed: 1, error: 2, timeout: 3, interrupted: 130 } as const;
  for (const [execution, code] of Object.entries(codes) as [HistoryRun['execution'], number][]) {
    const report = buildTeamReport({ runs: [hrun(1, [gate('a', 'failed')], { execution })] });
    assert.equal(report.current?.exitCode, code, execution);
    assert.deepEqual(report.blockingGates, ['a']);
    assert.equal(report.headline, execution === 'completed' ? 'BLOCK: 1 blocking: a' : `Run ${execution}: no verdict from the gates (exit code ${code})`);
  }
  assert.equal(buildTeamReport({ runs: [hrun(1, [gate('a', 'passed')])] }).current?.exitCode, 0);
  assert.equal(buildTeamReport({ runs: [hrun(1, [gate('a', 'passed')])] }).headline, 'PASS: all gates that ran passed');
  const noGates = buildTeamReport({ runs: [hrun(1, [], { decision: 'BLOCK' })] });
  assert.equal(noGates.headline, 'BLOCK: see the run details');
});

test('a fixed gate is named in a PASS headline and a latest run without a recorded history still works', () => {
  const report = buildTeamReport({ runs: [hrun(2, [gate('a', 'passed')]), hrun(1, [gate('a', 'failed')])] });
  assert.equal(report.headline, 'PASS: a fixed since the previous run');
  const latestOnly = buildTeamReport({ runs: [], latest: stored({ decision: 'PASS', gates: [] }) });
  assert.equal(latestOnly.current?.exitCode, 0); assert.deepEqual(latestOnly.engineer, []);
});

test('top three risks are ranked and de-duplicated per gate', () => {
  const flip = (n: number, status: HistoryGate['status']) => hrun(n, [gate('flaky', status), gate('often', n % 2 ? 'failed' : 'passed'), gate('reg', n === 8 ? 'failed' : 'passed'), gate('plain', n === 8 ? 'failed' : 'failed'), gate('slow', 'passed', n === 8 ? 5000 : 100), gate('streaky', n >= 6 ? 'failed' : 'passed')]);
  const runs = [8, 7, 6, 5, 4, 3, 2, 1].map(n => flip(n, n % 2 ? 'passed' : 'failed'));
  const report = buildTeamReport({ runs, latest: stored({ gates: [
    { id: 'reg', command: 'x', execution: 'completed', decision: 'BLOCK', exitCode: 1, durationMs: 1, outputTail: '', errors: [] },
    { id: 'plain', command: 'x', execution: 'completed', decision: 'BLOCK', exitCode: 1, durationMs: 1, outputTail: '', errors: [] }] }) });
  assert.deepEqual(report.risks.map(r => [r.gateId, r.kind]), [['reg', 'regression'], ['plain', 'blocking'], ['flaky', 'flaky']]);
  assert.match(report.risks[2]!.detail, /flips in 8 runs/);
  assert.ok(report.failingGates.some(g => g.id === 'often'));
  // Gates that rank below the first three show up once fewer gates block.
  const calm = buildTeamReport({ runs: runs.map(r => ({ ...r, gates: r.gates.filter(g => ['often', 'slow', 'streaky'].includes(g.id)) })), latest: stored({ decision: 'PASS', gates: [] }) });
  assert.deepEqual(calm.risks.map(r => [r.gateId, r.kind]), [['often', 'flaky'], ['streaky', 'failing-often'], ['slow', 'slower']]);
  assert.equal(calm.risks[2]!.detail, '0.1s to 5.0s');
});

test('time to green spans a streak of BLOCK runs up to the next PASS; interrupted runs are ignored', () => {
  const ok = (n: number, over: Partial<HistoryRun> = {}) => hrun(n, [gate('a', 'passed')], over);
  const bad = (n: number, over: Partial<HistoryRun> = {}) => hrun(n, [gate('a', 'failed')], over);
  const runs = [bad(9), bad(8), ok(7), bad(6, { execution: 'interrupted' }), ok(5), bad(4), bad(3), ok(2), ok(1)];
  const { timeToGreen } = buildTeamReport({ runs });
  // oldest first: ok1 ok2 bad3 bad4 ok5 (interrupted 6 skipped) ok7 bad8 bad9
  assert.equal(timeToGreen.spans.length, 1);
  assert.deepEqual(timeToGreen.spans[0], { blockedSince: hrun(3, []).startedAt, greenAt: hrun(5, []).finishedAt, ms: 7_260_000 });
  assert.equal(timeToGreen.medianMs, 7_260_000); assert.equal(timeToGreen.openSince, hrun(8, []).startedAt);
  const two = buildTeamReport({ runs: [ok(6), bad(5), ok(4), bad(2), bad(1)] });
  assert.equal(two.timeToGreen.spans.length, 2); assert.equal(two.timeToGreen.medianMs, (two.timeToGreen.spans[0]!.ms + two.timeToGreen.spans[1]!.ms) / 2);
  const many = Array.from({ length: 30 }, (_, i) => (i % 2 ? bad : ok)(30 - i));
  assert.equal(buildTeamReport({ runs: many }).timeToGreen.spans.length, 10, 'only the latest ten recoveries are kept');
});

test('Markdown is one block of plain, escaped lines usable in a pull request', () => {
  const runs = [hrun(3, [gate('lint', 'failed'), gate('flaky', 'passed')]), hrun(2, [gate('lint', 'passed'), gate('flaky', 'failed')]), hrun(1, [gate('lint', 'failed'), gate('flaky', 'passed')]),
    hrun(0, [gate('lint', 'passed'), gate('flaky', 'failed')])];
  const latest = stored({ gates: [{ id: 'li`nt', command: 'x', execution: 'completed', decision: 'BLOCK', exitCode: 1, durationMs: 1, outputTail: '', errors: [],
    findings: [{ gateId: 'li`nt', severity: 'error', message: '| table *bold* <b>\n# heading', file: 'a`b.ts', line: 2, ruleId: 'r' }] }] });
  const md = teamMarkdown(buildTeamReport({ runs, latest, warnings: ['History > broken'] }));
  assert.match(md, /^## QualityGate: BLOCK/); assert.ok(md.endsWith('\n'));
  assert.match(md, /Since the previous run: regressions `lint`; new failures `lint`; fixed `flaky`; slower none/);
  assert.match(md, /Time to green: no completed BLOCK to PASS recovery recorded; blocked since 2026-11-02T10:00:00.000Z/);
  assert.match(md, /### Top risks\n1\. `` li`nt `` \(blocking\)/);
  assert.ok(md.includes("- error `` a`b.ts:2 `` `r`: \\| table \\*bold\\* \\<b\\> \\# heading"), md);
  assert.ok(md.includes("### Blocking: `` li`nt ``"), md); assert.ok(md.includes("Reproduce: `` qualitygate run --gate 'li`nt' ``"), md);
  assert.match(md, /### Most frequently failing gates\n- `flaky`: 2 of 4 runs\n- `lint`: 2 of 4 runs/); assert.match(md, /### Flaky gates\n- `flaky`: 3 flips in 4 runs\n- `lint`: 3 flips in 4 runs/);
  assert.match(md, /> History \\> broken/);
  // durations are written in the largest sensible unit
  const hours = buildTeamReport({ runs: [hrun(9, [gate('a', 'passed')]), hrun(1, [gate('a', 'failed')])] });
  assert.match(teamMarkdown(hours), /median 8\.0h|median 8\.1h/);
  const minutes = buildTeamReport({ runs: [hrun(2, [gate('a', 'passed')], { finishedAt: hrun(2, []).startedAt }), hrun(2, [gate('a', 'failed')], { startedAt: new Date(Date.UTC(2026, 10, 2, 11, 55)).toISOString() })] });
  assert.match(teamMarkdown(minutes), /median 5min/);
  const quick = buildTeamReport({ runs: [hrun(1, [gate('a', 'passed')], { startedAt: '2026-11-02T10:00:10.000Z', finishedAt: '2026-11-02T10:00:12.000Z' }), hrun(1, [gate('a', 'failed')], { startedAt: '2026-11-02T10:00:00.000Z' })] });
  assert.match(teamMarkdown(quick), /median 12\.0s/);
});
