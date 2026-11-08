import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { configSchema, runResultSchema, type FixResult, type GateResult, type RunResult } from '../packages/protocol/src/index.js';
import type { ProgressEvent } from '../packages/core/src/index.js';
import type { Trends } from '../packages/core/src/history.js';
import { startUi } from '../packages/ink-ui/src/index.js';
import { projectController } from '../packages/ink-ui/src/controller.js';
import { Session, type Controller } from '../packages/ink-ui/src/session.js';
import { execute } from '../packages/cli/src/runner.js';
import { runUi, loadUi } from '../packages/cli/src/ui.js';

const gate = (id: string, patch: Partial<GateResult> = {}): GateResult => ({ id, command: 'x', execution: 'completed', decision: 'PASS', exitCode: 0, durationMs: 12, outputTail: '', errors: [], findings: [], artifacts: [], ...patch });
const runOf = (gates: GateResult[], patch: Partial<RunResult> = {}): RunResult => runResultSchema.parse({ schemaVersion: 1, runId: 'r', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  execution: 'completed', decision: gates.some(g => g.decision === 'BLOCK') ? 'BLOCK' : 'PASS', results: [], gates, errors: [], findings: [], steps: [], ...patch });

/** A controller whose jobs finish when the test says so. */
function fake(patch: Partial<Controller> = {}) {
  const jobs: { resolve: (run: RunResult) => void; reject: (error: Error) => void; ids?: string[]; signal: AbortSignal; emit: (event: ProgressEvent) => void }[] = [];
  const controller: Controller = {
    root: '/project', last: async () => runOf([gate('lint', { decision: 'BLOCK', exitCode: 1, outputTail: 'lint failed here' }), gate('tests')]),
    gates: [{ id: 'lint', command: 'eslint . --max-warnings 0', fixable: true, withheld: false }, { id: 'tests', command: 'node --test', fixable: false, withheld: false },
      { id: 'secrets', command: 'gitleaks detect', fixable: false, withheld: true }],
    run: (ids, signal, emit) => new Promise((resolve, reject) => { jobs.push({ resolve, reject, ids, signal, emit }); signal.addEventListener('abort', () => resolve(runOf([], { execution: 'interrupted' }))); }),
    fix: (ids, signal, emit, onFix) => new Promise((resolve, reject) => {
      onFix({ kind: 'fix-start', id: ids[0]!, command: 'eslint --fix' });
      const done = (run: RunResult) => resolve({ schemaVersion: 1, warnings: [], run, diffStat: ' a.ts | 2 +-\n 1 file changed',
        gates: ids.map(id => ({ id, fix: 'eslint --fix', fixExitCode: 0, before: 'BLOCK' as const, after: 'PASS' as const })) } satisfies FixResult);
      jobs.push({ ids, signal, emit, reject, resolve: done });
    }),
    trends: async () => undefined, ...patch,
  };
  return { controller, jobs };
}
const key = (session: Session, input: string, flags: object = {}) => session.key({ input, ...flags });
const tick = () => delay(10);

test('a run job streams progress into the table and the header shows the finished verdict', async () => {
  const { controller, jobs } = fake();
  const session = new Session(controller, () => 5000); await session.load();
  assert.equal(session.root, '/project');
  assert.equal(session.getState().run?.decision, 'BLOCK');
  let changes = 0; const off = session.subscribe(() => { changes++; });
  key(session, 'r'); await tick();
  assert.equal(session.getState().busy, 'run'); assert.equal(jobs[0]!.ids, undefined);
  jobs[0]!.emit({ kind: 'plan', ids: ['lint', 'tests', 'secrets'] }); jobs[0]!.emit({ kind: 'start', id: 'lint' });
  assert.equal(session.getState().rows[0]!.state, 'running'); assert.equal(session.getState().rows[0]!.startedAt, 5000);
  jobs[0]!.resolve(runOf([gate('lint')])); await tick();
  assert.equal(session.getState().busy, undefined); assert.equal(session.getState().run?.decision, 'PASS');
  off(); const seen = changes; key(session, 'd'); assert.equal(changes, seen);
  key(session, '', { down: true }); key(session, '', { enter: true }); await tick();
  assert.deepEqual(jobs[1]!.ids, ['lint']);
  jobs[1]!.reject(new Error('Unknown gate: lint')); await tick();
  assert.equal(session.getState().notice, 'Unknown gate: lint');
});

test('fix asks first, runs the fix job, shows before/after and the diff, and a refusal becomes a notice', async () => {
  const { controller, jobs } = fake();
  const session = new Session(controller); await session.load();
  key(session, 'f'); assert.deepEqual(session.getState().confirm, ['lint']); assert.equal(jobs.length, 0);
  key(session, 'y'); await tick();
  assert.equal(session.getState().busy, 'fix'); assert.equal(session.getState().rows[0]!.state, 'fixing');
  jobs[0]!.resolve(runOf([gate('lint')])); await tick();
  assert.match(session.getState().notice, /^Fix done\. lint: BLOCK -> PASS$/);
  assert.match(session.getState().fix!.diffStat!, /a\.ts/);
  const refusing = fake({ fix: async () => { throw new Error('Refusing to fix: the working tree has 1 uncommitted change(s)'); } });
  const second = new Session(refusing.controller); await second.load();
  key(second, 'f'); key(second, 'y'); await tick();
  assert.match(second.getState().notice, /Refusing to fix/);
  const warned = fake({ fix: async (ids, _s, _e, onFix) => { onFix({ kind: 'fix-end', id: ids[0]!, exitCode: 1, error: 'fix exited with 1' }); return { schemaVersion: 1, warnings: ['Not a git repository.'], run: runOf([gate('lint', { decision: 'BLOCK' })]), gates: [{ id: 'lint', fix: 'x', fixExitCode: 1, fixError: 'fix exited with 1' }] }; } });
  const third = new Session(warned.controller); await third.load();
  key(third, 'f'); key(third, 'y'); await tick();
  assert.equal(third.getState().notice, 'Fix done. lint: not run before -> not run (fix exited with 1) Not a git repository.');
});

test('Ctrl+C cancels the running job and ends with 130; q ends with the last verdict and 130 while a job runs', async () => {
  const { controller, jobs } = fake();
  const session = new Session(controller); await session.load();
  key(session, 'r'); await tick();
  key(session, 'c', { ctrlC: true });
  assert.equal(session.getState().cancelling, true); assert.equal(jobs[0]!.signal.aborted, true);
  assert.equal(await session.finished, 130);
  key(session, 'r'); assert.equal(jobs.length, 1, 'no new job after the session has ended');
  const idle = new Session(fake().controller); await idle.load();
  key(idle, 'q'); assert.equal(await idle.finished, 1, 'q ends with the last run exit code (BLOCK)');
  const clean = new Session(fake({ last: async () => undefined }).controller); await clean.load();
  key(clean, 'q'); assert.equal(await clean.finished, 0);
  const busy = fake(); const running = new Session(busy.controller); await running.load();
  key(running, 'r'); await tick(); key(running, 'q'); assert.equal(await running.finished, 130);
  const external = new Session(fake().controller); external.stop(130); assert.equal(await external.finished, 130);
});

test('trends load on demand; a failing history and an unreadable last run are not fatal', async () => {
  const weekly: Trends = { runs: 3, weeks: [{ week: '2026-11-02', runs: 3, blocked: 1 }], failingGates: [{ id: 'lint', failures: 1, runs: 3 }], flakyGates: [] };
  const session = new Session(fake({ trends: async () => weekly }).controller); await session.load();
  key(session, 't'); await tick();
  assert.equal(session.getState().trends, weekly);
  const none = new Session(fake({ trends: async () => undefined }).controller); await none.load();
  key(none, 't'); await tick(); assert.equal(none.getState().trends, 'none');
  const broken = new Session(fake({ trends: async () => { throw new Error('db locked'); }, last: async () => { throw new Error('corrupt'); } }).controller); await broken.load();
  assert.equal(broken.getState().run, undefined);
  key(broken, 't'); await tick(); assert.match(broken.getState().notice, /Trends unavailable: db locked/);
});

// ---- the Ink screen itself, driven through fake terminal streams -------------------------------------------------
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
function terminal(columns = 90) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() {}, unref() {} });
  let out = '';
  const stdout = Object.assign(new Writable({ write(chunk, _enc, done) { out += chunk; done(); } }), { isTTY: true, columns, rows: 30 });
  return { stdin, stdout, screen: () => out.replace(ANSI, ''),
    press: async (...inputs: string[]) => { for (const input of inputs) { stdin.write(input); await delay(40); } },
    until: async (text: string | RegExp) => { for (let i = 0; i < 200; i++) { const screen = out.replace(ANSI, ''); if (typeof text === 'string' ? screen.includes(text) : text.test(screen)) return; await delay(25); } assert.fail(`never saw ${text}\n${out.replace(ANSI, '').slice(-1500)}`); } };
}
const ESC = { up: '\x1b[A', down: '\x1b[B', enter: '\r', ctrlC: '\x03' };

test('the Ink screen shows the header, the table, details without secrets, the fix question and ends on q with the verdict', async () => {
  const term = terminal(); const { controller, jobs } = fake();
  const code = startUi('unused', new AbortController().signal, { stdin: term.stdin as never, stdout: term.stdout as never }, controller);
  await term.until('Overall: BLOCK (completed), exit code 1');
  for (const text of ['QualityGate  /project', 'lint [fix]', 'tests', 'secrets', 'r run all | enter run gate | arrows move']) assert.ok(term.screen().includes(text), text);
  await term.press(ESC.down); await term.until('> BLOCK');
  await term.press('d'); await term.until('Reproduce: eslint . --max-warnings 0');
  assert.ok(term.screen().includes('| lint failed here'));
  await term.press(ESC.down, ESC.down); await term.until('Gate secrets');
  assert.ok(term.screen().includes('Reproduce: gitleaks detect'));
  await term.press('d', '\x1b', 'f'); await term.until('Fix rewrites files in your working tree. y/n (lint)');
  await term.press('y'); await term.until('Fixing and re-running...');
  jobs[0]!.resolve(runOf([gate('lint')]));
  await term.until('Fix done. lint: BLOCK -> PASS'); await term.until('1 file changed');
  await term.until('Overall: PASS (completed), exit code 0');
  await term.press('t'); await term.until('No run history yet');
  await term.press('q');
  assert.equal(await code, 0);
});

test('Ctrl+C in the Ink screen cancels a running job and exits 130; an abort signal does the same', async () => {
  const term = terminal(); const { controller, jobs } = fake();
  const code = startUi('unused', new AbortController().signal, { stdin: term.stdin as never, stdout: term.stdout as never }, controller);
  await term.until('Overall: BLOCK');
  await term.press('r'); await term.until('Running...'); jobs[0]!.emit({ kind: 'plan', ids: ['lint'] }); jobs[0]!.emit({ kind: 'start', id: 'lint' }); jobs[0]!.emit({ kind: 'log', id: 'lint', line: 'working on it' });
  await term.until('working on it');
  await term.press(ESC.ctrlC);
  assert.ok(jobs[0]!.signal.aborted);
  assert.equal(await code, 130);
  const aborted = new AbortController(); const second = terminal();
  const result = startUi('unused', aborted.signal, { stdin: second.stdin as never, stdout: second.stdout as never }, fake().controller);
  await second.until('Overall: BLOCK'); aborted.abort();
  assert.equal(await result, 130);
  const early = new AbortController(); early.abort(); const third = terminal();
  assert.equal(await startUi('unused', early.signal, { stdin: third.stdin as never, stdout: third.stdout as never }, fake().controller), 130);
});

test('startUi builds the real controller from the config when none is given, and the lazy loader finds the real module', async () => {
  const p = await project([{ id: 'ok', run: 'true' }]);
  try {
    const term = terminal();
    const code = startUi(p.config, new AbortController().signal, { stdin: term.stdin as never, stdout: term.stdout as never });
    await term.until('Not run yet'); await term.until('ok');
    await term.press('r'); await term.until('Overall: PASS (completed), exit code 0'); await term.until('PASS');
    await term.press('q');
    assert.equal(await code, 0);
    assert.equal(typeof (await loadUi()).startUi, 'function');
  } finally { await p.done(); }
});

// ---- the real controller: same runner, same verdict ---------------------------------------------------------------
async function project(gates: object[]) {
  const dir = await mkdtemp(join(tmpdir(), 'qg-ui-'));
  const config = join(dir, '.qualitygate.yml');
  await writeFile(config, stringify(configSchema.parse({ schemaVersion: 1, gates })));
  return { dir, config, done: () => rm(dir, { recursive: true, force: true }) };
}

test('the real controller uses the CLI runner, so the screen and `qualitygate run` agree on the verdict', async () => {
  const p = await project([{ id: 'ok', run: 'true', fix: 'true' }, { id: 'bad', run: 'echo nope; exit 1' }, { id: 'leaks', run: 'true', report: { format: 'gitleaks', path: 'leaks.json' } }]);
  try {
    const controller = await projectController(p.config);
    assert.deepEqual(controller.gates, [{ id: 'ok', command: 'true', fixable: true, withheld: false }, { id: 'bad', command: 'echo nope; exit 1', fixable: false, withheld: false },
      { id: 'leaks', command: 'true', fixable: false, withheld: true }]);
    assert.equal(await controller.last(), undefined);
    assert.equal(await controller.trends(), undefined);
    const events: string[] = [];
    const viaScreen = await controller.run(['ok', 'bad'], new AbortController().signal, event => events.push(event.kind));
    const viaCli = await execute(p.config, new AbortController().signal, ['ok', 'bad']);
    assert.deepEqual([viaScreen.decision, viaScreen.execution, viaScreen.gates.map(g => g.decision)], [viaCli.decision, viaCli.execution, viaCli.gates.map(g => g.decision)]);
    assert.ok(events.includes('plan') && events.includes('end'));
    assert.equal((await controller.last())?.decision, 'BLOCK');
    assert.equal((await controller.trends())?.runs, 2);
    const fixed = await controller.fix(['ok'], new AbortController().signal, () => undefined, () => undefined);
    assert.equal(fixed.run.decision, 'PASS');
    assert.deepEqual(fixed.gates.map(g => [g.id, g.before, g.after]), [['ok', 'PASS', 'PASS']]);
  } finally { await p.done(); }
});

const entry = resolve('packages/cli/src/index.ts');
function cli(args: string[], cwd: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), entry, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((res, rej) => { child.once('error', rej); child.once('close', code => res({ code, stdout, stderr })); });
}

test('qualitygate ui refuses to start without a terminal: one line on stderr, exit 2, no hang', async () => {
  const p = await project([{ id: 'ok', run: 'true' }]);
  try {
    const result = await cli(['ui'], p.dir);
    assert.equal(result.code, 2); assert.equal(result.stdout, '');
    assert.match(result.stderr, /^QualityGate: ui needs an interactive terminal.*\n$/);
    assert.equal(result.stderr.trim().split('\n').length, 1);
    assert.equal((await cli(['ui', '--json'], p.dir)).code, 2);
    assert.match((await cli(['--help'], p.dir)).stdout, /qualitygate ui \[--config <path>\]/);
  } finally { await p.done(); }
});

test('runUi reports the refusal and a missing Ink build with exit code 2', async () => {
  const errors: string[] = []; const original = console.error; console.error = (text: string) => { errors.push(text); };
  const stdin = process.stdin.isTTY; const stdout = process.stdout.isTTY;
  try {
    const controller = new AbortController();
    assert.equal(await runUi('c', controller, { CI: '1' }), 2);
    assert.equal(await runUi('c', controller, {}), 2);
    Object.assign(process.stdin, { isTTY: true }); Object.assign(process.stdout, { isTTY: true });
    assert.equal(await runUi('c', controller, { CI: '1' }), 2);
    assert.equal(await runUi('c', controller, { TERM: 'xterm' }, async () => { throw Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' }); }), 2);
    assert.equal(await runUi('c', controller, {}, async () => ({ startUi: async () => 7 })), 7);
    controller.abort();
    assert.equal(await runUi('c', controller, {}, async () => { throw new Error('boom'); }), 130);
  } finally { console.error = original; Object.assign(process.stdin, { isTTY: stdin }); Object.assign(process.stdout, { isTTY: stdout }); }
  assert.match(errors[0]!, /interactive terminal/); assert.match(errors[1]!, /interactive terminal/); assert.match(errors[2]!, /ui does not run in CI/);
  assert.match(errors[3]!, /not part of this installation/); assert.match(errors[4]!, /boom/);
});
