import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runResultSchema, type GateResult, type RunResult, type Finding } from '../packages/protocol/src/index.js';
import { trends as buildTrends, type HistoryRun } from '../packages/core/src/history.js';
import { FIX_WARNING, applyFixStart, applyProgress, detailLines, exitCodeOf, handleKey, headerView, initialState, jobFailed, rowView, runFinished, runStarted, sparkline, stateOf, trendLines,
  type GateInfo, type State } from '../packages/ink-ui/src/model.js';
import { isWithheld } from '../packages/ink-ui/src/controller.js';
import { uiRefusal, loadUi } from '../packages/cli/src/ui.js';

const info = (id: string, patch: Partial<GateInfo> = {}): GateInfo => ({ id, command: `run-${id}`, fixable: false, withheld: false, ...patch });
const gate = (id: string, patch: Partial<GateResult> = {}): GateResult => ({ id, command: 'x', execution: 'completed', decision: 'PASS', exitCode: 0, durationMs: 12, outputTail: '', errors: [], findings: [], artifacts: [], ...patch });
const runOf = (gates: GateResult[], patch: Partial<RunResult> = {}): RunResult => runResultSchema.parse({ schemaVersion: 1, runId: 'r', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  execution: 'completed', decision: gates.some(g => g.decision === 'BLOCK') ? 'BLOCK' : 'PASS', results: [], gates, errors: [], findings: [], steps: gates.map(g => ({ id: g.id, kind: 'gate', status: 'passed' })), ...patch });
const keys = (state: State, ...inputs: Parameters<typeof handleKey>[1][]) => inputs.reduce((s, key) => handleKey(s, key).state, state);

test('the table starts from the last stored run and every runner event moves a row', () => {
  const last = runOf([gate('a', { decision: 'BLOCK', exitCode: 1 })]);
  let state = initialState([info('a'), info('b')], last);
  assert.deepEqual(state.rows.map(r => r.state), ['BLOCK', 'idle']);
  assert.equal(state.run, last);
  state = applyProgress(state, { kind: 'plan', ids: ['a', 'b'] }, 0);
  assert.deepEqual(state.rows.map(r => r.state), ['waiting', 'waiting']);
  state = applyProgress(state, { kind: 'start', id: 'a' }, 1000);
  state = applyProgress(state, { kind: 'log', id: 'a', line: 'checking' }, 1500);
  assert.deepEqual([state.rows[0]!.state, state.rows[0]!.line, state.rows[0]!.startedAt], ['running', 'checking', 1000]);
  state = applyProgress(state, { kind: 'end', gate: gate('a', { execution: 'timeout', decision: 'BLOCK' }) }, 2000);
  assert.deepEqual([state.rows[0]!.state, state.rows[0]!.line], ['timeout', '']);
  assert.equal(applyProgress(state, { kind: 'plan', ids: ['b'] }, 0).rows[0]!.state, 'timeout', 'a run of one gate leaves the other rows as they were');
  assert.equal(applyFixStart(state, 'a', 5).rows[0]!.state, 'fixing');
  assert.deepEqual(['skipped', 'error', 'interrupted', 'PASS', 'BLOCK'], [stateOf(gate('s', { skipped: 'dep' })), stateOf(gate('e', { execution: 'error' })), stateOf(gate('i', { execution: 'interrupted' })), stateOf(gate('p')), stateOf(gate('b', { decision: 'BLOCK' }))]);
});

test('job lifecycle helpers set busy, the finished run and notices', () => {
  const base = initialState([info('a')]);
  const started = runStarted({ ...base, confirm: ['a'] }, 'fix');
  assert.deepEqual([started.busy, started.confirm, started.notice], ['fix', undefined, '']);
  const run = runOf([gate('a')]);
  const finished = runFinished({ ...started, cancelling: true }, run, 'done');
  assert.deepEqual([finished.busy, finished.run, finished.notice, finished.cancelling], [undefined, run, 'done', false]);
  assert.equal(jobFailed(started, 'boom').notice, 'boom');
  assert.equal(exitCodeOf(base), 0);
  assert.equal(exitCodeOf({ ...base, run: runOf([gate('a', { decision: 'BLOCK' })]) }), 1);
  assert.equal(exitCodeOf({ ...base, run: runOf([gate('a', { execution: 'timeout', decision: 'BLOCK' })], { execution: 'timeout' }) }), 3);
});

test('keys move the cursor, clamp at the ends and ask for runs', () => {
  const state = initialState([info('a'), info('b'), info('c')]);
  assert.equal(handleKey(state, { input: '', up: true }).state.selected, 2);
  assert.equal(keys(state, { input: '', down: true }).selected, 0);
  assert.equal(keys(state, { input: '', down: true }, { input: '', down: true }, { input: '', down: true }, { input: '', down: true }).selected, 2);
  assert.equal(keys(state, { input: '', down: true }, { input: '', up: true }, { input: '', up: true }).selected, 0);
  assert.equal(handleKey(initialState([]), { input: '', down: true }).state.selected, undefined);
  assert.deepEqual(handleKey(state, { input: 'r' }).command, { kind: 'run' });
  assert.match(handleKey(state, { input: '', enter: true }).state.notice, /Select a gate/);
  assert.deepEqual(handleKey(keys(state, { input: '', down: true }, { input: '', down: true }), { input: '', enter: true }).command, { kind: 'run', ids: ['b'] });
  assert.equal(handleKey(state, { input: 'x' }).command, undefined);
  assert.deepEqual(handleKey(state, { input: 'q' }).command, { kind: 'quit' });
  assert.deepEqual(handleKey(state, { input: 'c', ctrlC: true }).command, { kind: 'cancel-and-quit', code: 130 });
});

test('escape clears the selection or closes a panel; d and t toggle their panels', () => {
  const selected = keys(initialState([info('a')]), { input: '', down: true });
  assert.equal(handleKey(selected, { input: '', escape: true }).state.selected, undefined);
  const details = handleKey(selected, { input: 'd' }).state;
  assert.equal(details.panel, 'details');
  const closed = handleKey(details, { input: '', escape: true }).state;
  assert.deepEqual([closed.panel, closed.selected], ['list', 0]);
  assert.equal(handleKey(details, { input: 'd' }).state.panel, 'list');
  const opened = handleKey(selected, { input: 't' });
  assert.deepEqual([opened.state.panel, opened.command], ['trends', { kind: 'trends' }]);
  const shut = handleKey(opened.state, { input: 't' });
  assert.deepEqual([shut.state.panel, shut.command], ['list', undefined]);
});

test('fix asks first: one selected gate, or every blocked gate that has a fix when nothing is selected', () => {
  const last = runOf([gate('lint', { decision: 'BLOCK' }), gate('fmt', { decision: 'BLOCK' }), gate('tests', { decision: 'BLOCK' }), gate('ok')]);
  const state = initialState([info('lint', { fixable: true }), info('fmt', { fixable: true }), info('tests'), info('ok', { fixable: true })], last);
  const all = handleKey(state, { input: 'f' });
  assert.deepEqual(all.state.confirm, ['lint', 'fmt']); assert.equal(all.command, undefined);
  assert.equal(FIX_WARNING, 'Fix rewrites files in your working tree. y/n');
  assert.deepEqual(handleKey(all.state, { input: 'y' }).command, { kind: 'fix', ids: ['lint', 'fmt'] });
  assert.equal(handleKey(all.state, { input: 'y' }).state.confirm, undefined);
  const no = handleKey(all.state, { input: 'n' });
  assert.deepEqual([no.state.confirm, no.state.notice, no.command], [undefined, 'Fix cancelled.', undefined]);
  assert.equal(handleKey(all.state, { input: 'q' }).command, undefined, 'any other key answers no');
  const one = keys(state, { input: '', down: true }, { input: 'f' });
  assert.deepEqual(one.confirm, ['lint']);
  const without = keys(state, { input: '', down: true }, { input: '', down: true }, { input: '', down: true }, { input: 'f' });
  assert.equal(without.selected, 2); assert.match(without.notice, /Gate tests declares no fix command/);
  assert.match(handleKey(initialState([info('a', { fixable: true })]), { input: 'f' }).state.notice, /Nothing to fix/);
});

test('while a job runs only navigation, panels and Ctrl+C work', () => {
  const busy = runStarted(initialState([info('a', { fixable: true })]), 'run');
  for (const key of [{ input: 'r' }, { input: '', enter: true }, { input: 'f' }]) assert.match(handleKey(busy, key).state.notice, /Wait for the run to finish/);
  assert.equal(handleKey(busy, { input: 'r' }).command, undefined);
  assert.equal(handleKey(busy, { input: 'd' }).state.panel, 'details');
  assert.deepEqual(handleKey(busy, { input: 'c', ctrlC: true }).command, { kind: 'cancel-and-quit', code: 130 });
});

test('rows show state, elapsed time and detail; the header shows the verdict and exit code', () => {
  const rows = initialState([info('lint', { fixable: true })]).rows;
  const row = (patch: object) => ({ ...rows[0]!, ...patch });
  assert.match(rowView(row({ state: 'running', startedAt: 1000, line: 'half way' }), 4500, 80).text, /^\* [|/\\-]\s+lint \[fix\] 3s half way$/);
  assert.equal(rowView(row({ state: 'running', startedAt: 1000 }), 1000, 80).tone, 'busy');
  assert.match(rowView(row({ state: 'fixing', startedAt: 0, line: 'rewriting' }), 2000, 80).text, /^~ .*lint \[fix\] 2s rewriting$/);
  assert.deepEqual(rowView(row({ state: 'waiting' }), 0, 80), { text: '.            lint [fix]', tone: 'dim' });
  assert.equal(rowView(row({ state: 'idle' }), 0, 80).text.startsWith('-'), true);
  const done = (patch: Partial<GateResult>, state: string) => rowView(row({ state, result: gate('lint', patch) }), 0, 80);
  assert.deepEqual(done({}, 'PASS'), { text: 'PASS         lint [fix] 12ms', tone: 'ok' });
  assert.equal(done({ decision: 'BLOCK' }, 'BLOCK').tone, 'bad');
  assert.match(done({ execution: 'error', decision: 'BLOCK' }, 'error').text, /^ERROR/);
  assert.match(done({ execution: 'timeout', decision: 'BLOCK' }, 'timeout').text, /^TIMEOUT/);
  assert.deepEqual([done({ execution: 'interrupted', decision: 'BLOCK' }, 'interrupted').tone, done({ skipped: 'dep' }, 'skipped').text], ['warn', 'SKIPPED      lint [fix] skipped']);
  assert.match(done({ cached: true }, 'PASS').text, /cached$/);
  assert.equal(rowView(row({ state: 'running', startedAt: 0, line: 'x'.repeat(200) }), 0, 30).text.length, 30);
  assert.equal(rowView(row({ state: 'running', startedAt: 0, line: '\x1b[31mred\x07' }), 0, 80).text.includes('\x1b'), false);
});

test('the header says running, cancelling, not run yet, or the verdict with exit code and coverage', () => {
  const base = initialState([info('a')]);
  assert.equal(headerView(base, '/p').title, 'QualityGate  /p');
  assert.deepEqual(headerView(base, '/p').tone, 'dim');
  assert.match(headerView(base, '/p').overall, /Not run yet/);
  assert.equal(headerView(runStarted(base, 'run'), '/p').overall, 'Running...');
  assert.equal(headerView(runStarted(base, 'fix'), '/p').overall, 'Fixing and re-running...');
  assert.equal(headerView({ ...runStarted(base, 'run'), cancelling: true }, '/p').overall, 'Cancelling...');
  const pass = headerView({ ...base, run: runOf([gate('a')]) }, '/p');
  assert.deepEqual([pass.overall, pass.tone], ['Overall: PASS (completed), exit code 0, 1 of 1 steps ran', 'ok']);
  const block = headerView({ ...base, run: runOf([gate('a', { decision: 'BLOCK' })], { steps: [] }) }, '/p');
  assert.deepEqual([block.overall, block.tone], ['Overall: BLOCK (completed), exit code 1', 'bad']);
});

test('details show findings, errors and the reproduce command, and never the output of secret scanners', () => {
  assert.match(detailLines(undefined, 80)[0]!, /Select a gate/);
  const idle = initialState([info('lint', { command: 'eslint . --max-warnings 0' })]).rows[0]!;
  assert.deepEqual(detailLines(idle, 80), ['Gate lint', 'Reproduce: eslint . --max-warnings 0', 'No result yet. Press enter to run this gate.']);
  const findings: Finding[] = Array.from({ length: 14 }, (_, i) => ({ gateId: 'lint', severity: 'error', message: `bad ${i}`, file: 'src/a.ts', line: i + 1, column: 3, ruleId: 'no-x' }));
  const blocked = { ...idle, state: 'BLOCK' as const, result: gate('lint', { decision: 'BLOCK', exitCode: 1, findings, errors: ['Gate lint exited 0 but report contains failures'], outputTail: 'one\n\ntwo\nthree\n', evidencePath: '/p/log.txt' }) };
  const lines = detailLines(blocked, 100);
  assert.ok(lines.includes('error src/a.ts:1:3 no-x bad 0'));
  assert.ok(lines.includes('... and 2 more findings'));
  assert.ok(lines.includes('Error: Gate lint exited 0 but report contains failures'));
  assert.ok(lines.includes('Result: BLOCK (completed, exit 1, 12ms)') && lines.includes('| three') && lines.includes('Log: /p/log.txt'));
  assert.ok(!lines.includes('| '), 'blank output lines are dropped');
  const secret = { ...blocked, withheld: true, result: gate('lint', { decision: 'BLOCK', findings: [{ gateId: 'lint', severity: 'error', message: 'Possible secret (aws)', file: '.env', line: 2 }], outputTail: 'AKIAIOSFODNN7EXAMPLE leaked' }) };
  const hidden = detailLines(secret, 100).join('\n');
  assert.ok(!hidden.includes('AKIA') && /Output withheld/.test(hidden) && /\.env:2/.test(hidden));
  const passed = detailLines({ ...idle, state: 'PASS', result: gate('lint', { outputTail: 'noise', exitCode: null, skipped: 'dependency failed' }) }, 100);
  assert.ok(passed.includes('Skipped: dependency failed') && !passed.some(line => line.includes('noise')) && passed.includes('Result: PASS (completed, 12ms)'));
  assert.equal(detailLines({ ...blocked, result: gate('lint', { decision: 'BLOCK', findings: [{ gateId: 'lint', severity: 'warning', message: 'm\x1b[2J' }] }) }, 100).some(line => line.includes('\x1b')), false);
});

test('trends: a sparkline of the blocked share per week plus failing and flaky gates', () => {
  assert.equal(sparkline([{ runs: 4, blocked: 0 }, { runs: 4, blocked: 2 }, { runs: 4, blocked: 4 }]), '▁▅█');
  assert.equal(sparkline([]), '');
  assert.deepEqual(trendLines(undefined, 80), ['Loading trends...']);
  assert.match(trendLines('none', 80)[0]!, /No run history/);
  const run = (id: string, startedAt: string, status: 'passed' | 'failed'): HistoryRun => ({ id, startedAt, finishedAt: startedAt, execution: 'completed', decision: status === 'failed' ? 'BLOCK' : 'PASS', durationMs: 1, gates: [{ id: 'lint', status, durationMs: 1 }] });
  const t = buildTrends([run('4', '2026-11-03T00:00:00Z', 'failed'), run('3', '2026-10-27T00:00:00Z', 'passed'), run('2', '2026-10-26T00:00:00Z', 'failed'), run('1', '2026-10-20T00:00:00Z', 'passed')]);
  const lines = trendLines(t, 120);
  assert.match(lines[0]!, /last 4 runs: [▁-█]{3}$/);
  assert.ok(lines.includes('Weeks: 2026-10-19 to 2026-11-02'));
  assert.ok(lines.includes('Failing most: lint 2/4') && lines.includes('Flaky: lint 3 flips'));
  assert.deepEqual(trendLines({ runs: 1, weeks: [], failingGates: [], flakyGates: [] }, 80), ['Blocked share per week, last 1 runs: ', 'Failing most: none', 'Flaky: none']);
});

test('output of gates whose report parser can expose secrets, or is unknown, is withheld', () => {
  const spec = (report?: { format: string; path: string }) => ({ id: 'g', type: 'command', run: 'x', ...(report ? { report } : {}) });
  assert.equal(isWithheld(spec()), false);
  assert.equal(isWithheld(spec({ format: 'junit', path: 'r.xml' })), false);
  assert.equal(isWithheld(spec({ format: 'gitleaks', path: 'r.json' })), true);
  assert.equal(isWithheld(spec({ format: 'third-party', path: 'r.json' })), true);
});

test('the UI refuses a pipe, CI and a dumb terminal instead of hanging, and says so when the Ink build is missing', async () => {
  const tty = { isTTY: true };
  assert.equal(uiRefusal(tty, tty, { TERM: 'xterm-256color' }), undefined);
  assert.match(uiRefusal({}, tty, {})!, /interactive terminal/);
  assert.match(uiRefusal(tty, {}, {})!, /interactive terminal/);
  assert.match(uiRefusal(tty, tty, { CI: 'true' })!, /CI/);
  assert.match(uiRefusal(tty, tty, { TERM: 'dumb' })!, /TERM=dumb/);
  for (const message of [uiRefusal({}, {}, {}), uiRefusal(tty, tty, { CI: '1' }), uiRefusal(tty, tty, { TERM: 'dumb' })]) assert.ok(message && !message.includes('\n'));
  const loaded = { startUi: async () => 0 };
  assert.equal(await loadUi(async () => loaded), loaded);
  await assert.rejects(loadUi(async () => { throw Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' }); }), /interactive UI is not part of this installation/);
  await assert.rejects(loadUi(async () => { throw new Error('syntax'); }), /^Error: syntax$/);
});
