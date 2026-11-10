import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configSchema, type GateResult, type RunResult } from '../packages/protocol/src/index.js';
import { runWith } from '../packages/core/src/index.js';
import type { ProgressEvent } from '../packages/core/src/index.js';
import type { ParserPlugin, StoragePlugin } from '../packages/plugin-sdk/src/index.js';
import { commandPlugin } from '../packages/plugins/command/src/index.js';
import { liveView, liveEnabled, plainLine } from '../packages/cli/src/live.js';
const storage: StoragePlugin = { id: 'memory', apiVersion: 1, kind: 'storage', async createRun(id) { return id; }, async write(dir, name) { return `${dir}/${name}`; } };
const reporter = { id: 'json', apiVersion: 1, kind: 'reporter', render: JSON.stringify } as const;
const node = (code: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
function gate(id: string, patch: Partial<GateResult> = {}): GateResult {
  return { id, command: 'x', execution: 'completed', decision: 'PASS', exitCode: 0, durationMs: 5, outputTail: '', errors: [], findings: [], artifacts: [], ...patch };
}
function fakeStream(columns = 40, rows = 24) {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  stream.isTTY = true; stream.columns = columns; stream.rows = rows;
  let text = ''; stream.on('data', chunk => { text += chunk; });
  return { stream, text: () => text };
}
test('runWith reports plan, start, log lines and end per gate; skipped and cached gates only end', async () => {
  const config = configSchema.parse({ schemaVersion: 1, concurrency: 1, gates: [
    { id: 'a', type: 'command', run: node('console.log("one"); console.error("two"); process.stdout.write("tail")') },
    { id: 'b', type: 'command', run: node('process.exit(1)') },
    { id: 'c', type: 'command', run: 'true', dependsOn: ['b'] },
    { id: 'd', type: 'command', run: 'true' },
  ] });
  const events: ProgressEvent[] = [];
  await runWith(config, { gate: commandPlugin(process.cwd()), storage, reporter }, { cached: { d: 'unchanged' }, onProgress: event => events.push(event) });
  assert.deepEqual(events[0], { kind: 'plan', ids: ['a', 'b', 'c', 'd'] });
  const lines = events.filter(event => event.kind === 'log').map(event => event.line);
  assert.deepEqual([...lines].sort(), ['one', 'two']);
  assert.deepEqual(events.filter(event => event.kind === 'start').map(event => event.id), ['a', 'b']);
  assert.deepEqual(events.filter(event => event.kind === 'end').map(event => event.gate.id).sort(), ['a', 'b', 'c', 'd']);
});
test('a gate whose report parser declares secrets streams no log lines', async () => {
  const parser: ParserPlugin = { id: 'secretive', apiVersion: 1, kind: 'parser', parse: () => [], secrets: () => [] };
  const config = configSchema.parse({ schemaVersion: 1, gates: [{ id: 'leaks', type: 'command', run: node('console.log("TOPSECRET")'), report: { format: 'secretive', path: 'none.json' } }] });
  const events: ProgressEvent[] = [];
  await runWith(config, { gate: commandPlugin(process.cwd(), { secretive: parser }), storage, reporter }, { onProgress: event => events.push(event) });
  assert.equal(events.some(event => event.kind === 'log'), false);
  assert.equal(events.some(event => event.kind === 'end'), true);
});
test('liveEnabled needs a TTY, no CI, no opt-out, not dumb terminal and text output', () => {
  const tty = { isTTY: true };
  assert.equal(liveEnabled(tty, {}, {}), true);
  assert.equal(liveEnabled({}, {}, {}), false);
  assert.equal(liveEnabled(tty, { CI: 'true' }, {}), false);
  assert.equal(liveEnabled(tty, { CI: '' }, {}), true);
  assert.equal(liveEnabled(tty, { QUALITYGATE_NO_LIVE: '1' }, {}), false);
  assert.equal(liveEnabled(tty, { QUALITYGATE_NO_LIVE: '0' }, {}), true);
  assert.equal(liveEnabled(tty, { TERM: 'dumb' }, {}), false);
  assert.equal(liveEnabled(tty, {}, { noLive: true }), false);
  assert.equal(liveEnabled(tty, {}, { json: true }), false);
});
test('plainLine removes escape sequences and control characters and truncates', () => {
  assert.equal(plainLine('\x1b[31mred\x1b[0m \x1b]0;title\x07ok\x00\x08!', 80), 'red ok!');
  assert.equal(plainLine('abcdefghij', 5), 'abcd…');
  assert.equal(plainLine('abc', 0), '');
});
test('live view redraws in place, shows last log line, hides and restores the cursor and prints a summary', () => {
  const { stream, text } = fakeStream();
  const view = liveView(stream, { interval: 0 });
  assert.match(text(), /\x1b\[\?25l/);
  view.onProgress({ kind: 'plan', ids: ['lint', 'test', 'skipme'] });
  view.onProgress({ kind: 'start', id: 'lint' });
  view.onProgress({ kind: 'log', id: 'lint', line: '\x1b[2Jchecking src' });
  assert.match(text(), /lint.*checking src/);
  assert.doesNotMatch(text(), /\x1b\[2J/);
  view.onProgress({ kind: 'end', gate: gate('lint') });
  view.onProgress({ kind: 'end', gate: gate('test', { decision: 'BLOCK', exitCode: 1 }) });
  view.onProgress({ kind: 'end', gate: gate('skipme', { decision: 'BLOCK', skipped: 'dependency test did not pass' }) });
  view.onProgress({ kind: 'end', gate: gate('late', { cached: true }) });
  view.onProgress({ kind: 'log', id: 'unknown', line: 'ignored' });
  const before = text().length;
  view.stop({ gates: [gate('lint'), gate('test', { decision: 'BLOCK' })], results: [] } as unknown as RunResult);
  const tail = text().slice(before);
  assert.match(tail, /\x1b\[\?25h/);
  assert.match(tail, /1 passed, 1 blocked/);
  view.stop();
  assert.equal(text().slice(before + tail.length), '');
});
test('live view stop without a result only clears and restores the cursor; frames never exceed the width', () => {
  const { stream, text } = fakeStream(20);
  const view = liveView(stream, { interval: 0 });
  view.onProgress({ kind: 'plan', ids: ['a-very-long-gate-identifier'] });
  view.onProgress({ kind: 'log', id: 'a-very-long-gate-identifier', line: 'x'.repeat(100) });
  view.stop();
  for (const row of text().split(/\x1b\[[0-9;?]*[A-Za-z]/).join('\n').split('\n')) assert.ok(row.length <= 20, row);
  assert.match(text(), /\x1b\[\?25h$/);
});
/** The distances of every "cursor up" in the output. */
const ups = (text: string) => [...text.matchAll(/\x1b\[(\d+)A/g)].map(match => Number(match[1]));
test('live view with more gates than terminal rows draws fewer rows than the height, running gates first, and never moves up further than it drew', () => {
  const { stream, text } = fakeStream(40, 5);
  const view = liveView(stream, { interval: 0 });
  const ids = Array.from({ length: 12 }, (_, index) => `gate${index}`);
  view.onProgress({ kind: 'plan', ids });
  view.onProgress({ kind: 'start', id: 'gate11' });
  for (const id of ids.slice(0, 6)) view.onProgress({ kind: 'end', gate: gate(id) });
  const frames = text().split('\x1b[J').pop()!;
  assert.match(frames, /gate11/); assert.match(frames, /\+\d+ more/);
  assert.equal(frames.trimEnd().split('\n').length, 4);
  assert.ok(ups(text()).every(up => up <= 4), String(ups(text())));
  view.stop();
  assert.ok(ups(text()).every(up => up <= 4));
});
test('live view erases wrapped rows after the terminal is made narrower and redraws on resize, and releases the listener', () => {
  const { stream, text } = fakeStream(40);
  const view = liveView(stream, { interval: 0 });
  view.onProgress({ kind: 'plan', ids: ['a'] });
  view.onProgress({ kind: 'log', id: 'a', line: 'x'.repeat(100) });
  const wide = text().length;
  stream.columns = 10; stream.emit('resize');
  assert.deepEqual(ups(text().slice(wide)).slice(0, 1), [4]);
  assert.match(text().slice(wide), /\x1b\[J.*a/s);
  assert.equal(stream.listenerCount('resize'), 1);
  view.stop();
  assert.equal(stream.listenerCount('resize'), 0);
});
test('live view timer redraws while gates run and is released by stop', async () => {
  const { stream, text } = fakeStream();
  const view = liveView(stream, { interval: 5 });
  view.onProgress({ kind: 'plan', ids: ['slow'] }); view.onProgress({ kind: 'start', id: 'slow' });
  const first = text().length;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(text().length > first);
  view.stop();
  const stopped = text().length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(text().length, stopped);
});
const entry = resolve('packages/cli/src/index.ts');
function cli(args: string[], env: Record<string, string | undefined>, cwd: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], { cwd, env: { ...process.env, CI: undefined, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }));
  });
}
test('piped, CI and --json output is byte-for-byte the plain text; --no-live is accepted only by run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-live-'));
  try {
    const path = join(dir, '.qualitygate.yml');
    await writeFile(path, `schemaVersion: 1\ngates:\n  - id: ok\n    type: command\n    run: ${JSON.stringify(node('console.log("fine")'))}\n  - id: bad\n    type: command\n    run: ${JSON.stringify(node('console.log("broke"); process.exit(1)'))}\n`);
    const strip = (text: string) => text.replace(/Report: .*|log: \S+|\d+ms|^Project root: .*/gm, '');
    const piped = await cli(['run', '--config', path], {}, process.cwd());
    const noLive = await cli(['run', '--config', path, '--no-live'], {}, process.cwd());
    const ci = await cli(['run', '--config', path], { CI: 'true' }, process.cwd());
    const off = await cli(['run', '--config', path], { QUALITYGATE_NO_LIVE: '1' }, process.cwd());
    assert.equal(piped.code, 1);
    for (const other of [noLive, ci, off]) { assert.equal(other.code, 1); assert.equal(strip(other.stdout), strip(piped.stdout)); assert.equal(other.stderr, piped.stderr); }
    assert.doesNotMatch(piped.stdout, /\x1b/);
    assert.match(piped.stdout, /^PASS gate ok \(completed, exit 0, /m);
    assert.match(piped.stdout, /^BLOCK gate bad \(completed, exit 1, /m);
    assert.match(piped.stdout, /^  \| broke$/m);
    const json = await cli(['run', '--config', path, '--json', '--no-live'], {}, process.cwd());
    assert.equal(json.code, 1); JSON.parse(json.stdout);
    const wrong = await cli(['history', '--config', path, '--no-live', '--json'], {}, process.cwd());
    assert.equal(wrong.code, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('on a real terminal the live view draws, restores the cursor and keeps the final text and exit code', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-pty-'));
  try {
    const path = join(dir, '.qualitygate.yml');
    await writeFile(path, `schemaVersion: 1\ngates:\n  - id: ok\n    type: command\n    run: ${JSON.stringify(node('console.log("fine")'))}\n`);
    const command = [process.execPath, '--import', 'tsx', entry, 'run', '--config', path];
    const args = process.platform === 'darwin' ? ['-q', '/dev/null', ...command] : ['-qec', command.map(part => JSON.stringify(part)).join(' '), '/dev/null'];
    const result = await new Promise<{ code: number | null; out: string }>((done, reject) => {
      const child = spawn('script', args, { cwd: process.cwd(), env: { ...process.env, CI: undefined, TERM: 'xterm' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; child.stdout.on('data', chunk => { out += chunk; });
      child.once('error', reject); child.once('close', code => done({ code, out }));
    });
    assert.equal(result.code, 0);
    assert.match(result.out, /\x1b\[\?25l/); assert.match(result.out, /\x1b\[\?25h/);
    assert.match(result.out, /PASS gate ok \(completed, exit 0, /);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('a history warning is printed after the live rows are erased and the cursor is restored', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-pty-'));
  try {
    const path = join(dir, '.qualitygate.yml');
    await writeFile(path, `schemaVersion: 1\ngates:\n  - id: ok\n    type: command\n    run: ${JSON.stringify(node('console.log("fine")'))}\n`);
    await mkdir(join(dir, '.qualitygate', 'history.sqlite'), { recursive: true });
    const command = [process.execPath, '--import', 'tsx', entry, 'run', '--config', path];
    const args = process.platform === 'darwin' ? ['-q', '/dev/null', ...command] : ['-qec', command.map(part => JSON.stringify(part)).join(' '), '/dev/null'];
    const out = await new Promise<string>((done, reject) => {
      const child = spawn('script', args, { cwd: process.cwd(), env: { ...process.env, CI: undefined, TERM: 'xterm' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = ''; child.stdout.on('data', chunk => { text += chunk; });
      child.once('error', reject); child.once('close', () => done(text));
    });
    const warning = out.indexOf('run history not saved');
    assert.ok(warning > out.lastIndexOf('\x1b[?25h') && out.lastIndexOf('\x1b[?25h') > out.lastIndexOf('\x1b[J'), out);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('SIGINT on a real terminal (what Ctrl+C sends) cancels the gate, restores the cursor and exits 130', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-pty-'));
  try {
    const path = join(dir, '.qualitygate.yml');
    await writeFile(path, `schemaVersion: 1\ngates:\n  - id: slow\n    type: command\n    run: ${JSON.stringify('echo working; sleep 1; kill -INT $PPID; sleep 30')}\n`);
    const command = [process.execPath, '--import', 'tsx', entry, 'run', '--config', path];
    const args = process.platform === 'darwin' ? ['-q', '/dev/null', ...command] : ['-qec', command.map(part => JSON.stringify(part)).join(' '), '/dev/null'];
    const result = await new Promise<{ code: number | null; out: string }>((done, reject) => {
      const child = spawn('script', args, { cwd: process.cwd(), env: { ...process.env, CI: undefined, TERM: 'xterm' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; child.stdout.on('data', chunk => { out += chunk; });
      child.once('error', reject); child.once('close', code => done({ code, out }));
    });
    assert.equal(result.code, 130);
    assert.match(result.out, /\x1b\[\?25h/);
    assert.match(result.out, /interrupted/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a progress view that throws never changes the verdict', async () => {
  const config = configSchema.parse({ schemaVersion: 1, gates: [{ id: 'ok', type: 'command', run: 'true' }] });
  const result = await runWith(config, { gate: commandPlugin(process.cwd()), storage, reporter }, { onProgress: () => { throw new Error('stdout closed'); } });
  assert.equal(result.decision, 'PASS');
});
