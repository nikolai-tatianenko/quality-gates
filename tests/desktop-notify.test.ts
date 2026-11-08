import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { spawn } from 'node:child_process';
import { DesktopBridgeError, type DesktopClient, type RunView } from '../packages/desktop/src/client.js';
import { classifyRun, notificationFor, watchRuns } from '../packages/desktop/src/notify.js';
import { openDirectory, openerFor, resolveFolder } from '../packages/desktop/src/open.js';

const run = (decision: 'PASS' | 'BLOCK', exitCode: number, gates: RunView['gates'] = []): RunView => ({ runId: 'r', decision, exitCode, gates });

test('the exit-code contract decides the kind, and a contradicting report is an error, never a pass', () => {
  const table: [RunView, string][] = [[run('PASS', 0), 'pass'], [run('BLOCK', 1), 'block'], [run('PASS', 2), 'error'], [run('BLOCK', 2), 'error'], [run('BLOCK', 3), 'timeout'],
    [run('BLOCK', 130), 'interrupted'], [run('PASS', 1), 'error'], [run('BLOCK', 0), 'error'], [run('PASS', 7), 'error']];
  for (const [value, kind] of table) assert.equal(classifyRun(value), kind, `${value.decision}/${value.exitCode}`);
});

test('notifications name the verdict and blocking gate ids only, never output, messages or paths', () => {
  assert.equal(notificationFor('app', run('BLOCK', 130)), undefined);
  assert.deepEqual(notificationFor('app', run('PASS', 0, [{ id: 'lint', decision: 'PASS' }, { id: 'test', decision: 'PASS' }])), { kind: 'pass', runId: 'r', title: 'app: PASS', body: '2 gate(s) checked, none blocked.' });
  assert.equal(notificationFor('app', { runId: 'r', decision: 'PASS', exitCode: 0 })?.body, '0 gate(s) checked, none blocked.');
  const gates = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, decision: 'BLOCK' })).concat([{ id: 'ok', decision: 'PASS' }]);
  assert.equal(notificationFor('app', run('BLOCK', 1, gates.slice(0, 2)))?.body, 'Blocked by a, b.');
  assert.equal(notificationFor('app', run('BLOCK', 1, gates))?.body, 'Blocked by a, b, c and 2 more.');
  assert.equal(notificationFor('app', run('BLOCK', 1))?.body, 'The run was blocked.');
  assert.equal(notificationFor('app', run('BLOCK', 1, [{ id: '', decision: 'BLOCK' }, { id: 5 as unknown as string, decision: 'BLOCK' }]))?.body, 'The run was blocked.');
  const hostile = notificationFor('app', run('BLOCK', 1, [{ id: 'x`rm -rf ~`<b>' + 'y'.repeat(100), decision: 'BLOCK' }]));
  assert.match(hostile!.body, /^Blocked by [\w.:-]{1,64}\.$/);
  assert.ok(hostile!.body.length < 100);
  assert.equal(notificationFor('app', run('PASS', 2))?.kind, 'error');
  assert.match(notificationFor('app', { ...run('PASS', 2), exitCode: 2 })!.body, /exit code 2/);
  assert.match(notificationFor('app', { runId: 'r', decision: 'PASS', exitCode: Number.NaN })!.body, /unknown/);
  assert.equal(notificationFor('app', run('BLOCK', 3))?.kind, 'timeout');
  assert.equal(notificationFor('n'.repeat(200), run('PASS', 0))?.title.length, 86);
  for (const code of [0, 1, 2, 3]) assert.doesNotMatch(JSON.stringify(notificationFor('app', { ...run(code === 0 ? 'PASS' : 'BLOCK', code), errors: ['SECRET=abc'] } as RunView)), /SECRET/);
});

function fakeClient(steps: (RunView | undefined | Error)[]) {
  let i = 0;
  return { latestRun: async () => { const step = steps[Math.min(i++, steps.length - 1)]; if (step instanceof Error) throw step; return step; } } as unknown as DesktopClient;
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };

test('watching ignores the existing run, reports each new run once and stops with a reason when the bridge is lost', async () => {
  const seen: string[] = []; const stops: string[] = [];
  const controller = new AbortController();
  const a = { ...run('PASS', 0), runId: 'a' }; const b = { ...run('BLOCK', 1), runId: 'b' };
  let sleeps = 0;
  await watchRuns(fakeClient([a, a, b, b, new DesktopBridgeError('down', 'gone')]), { onRun: r => seen.push(r.runId), onStop: (why, text) => stops.push(`${why}:${text}`) }, controller.signal,
    { sleep: async () => { sleeps++; } });
  assert.deepEqual(seen, ['b']); assert.deepEqual(stops, ['down:gone']); assert.equal(sleeps, 4);
});

test('watching: a project without runs is quiet until the first run; revoked tokens and other errors end the watch; abort ends it silently', async () => {
  const seen: string[] = []; const stops: string[] = [];
  const events = { onRun: (r: RunView) => seen.push(r.runId), onStop: (why: string) => stops.push(why) };
  await watchRuns(fakeClient([undefined, undefined, { ...run('PASS', 0), runId: 'first' }, new DesktopBridgeError('unauthorized', 'revoked')]), events, new AbortController().signal, { sleep: async () => undefined });
  assert.deepEqual(seen, ['first']); assert.deepEqual(stops, ['unauthorized']);
  await watchRuns(fakeClient([new Error('weird')]), events, new AbortController().signal, { sleep: async () => undefined });
  await watchRuns(fakeClient([new DesktopBridgeError('server', 'x')]), events, new AbortController().signal, { sleep: async () => undefined });
  await watchRuns({ latestRun: async () => { throw 'text'; } } as unknown as DesktopClient, events, new AbortController().signal, { sleep: async () => undefined });
  assert.deepEqual(stops, ['unauthorized', 'error', 'error', 'error']);
  const controller = new AbortController(); controller.abort();
  await watchRuns(fakeClient([new Error('late')]), events, controller.signal);
  const during = new AbortController();
  const failing = { latestRun: async () => { during.abort(); throw new Error('cancelled mid call'); } } as unknown as DesktopClient;
  await watchRuns(failing, events, during.signal);
  assert.equal(stops.length, 4, 'an abort is not reported as a failure');
});

test('the default sleep waits the interval and wakes at once on abort', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = { latestRun: async () => { if (++calls === 2) controller.abort(); return undefined; } } as unknown as DesktopClient;
  const started = Date.now();
  await watchRuns(client, { onRun: () => undefined, onStop: () => undefined }, controller.signal, { intervalMs: 20 });
  assert.ok(calls >= 2 && Date.now() - started < 2000);
  const abortedDuringSleep = new AbortController();
  const slow = { latestRun: async () => { setTimeout(() => abortedDuringSleep.abort(), 20); return undefined; } } as unknown as DesktopClient;
  const t = Date.now();
  await watchRuns(slow, { onRun: () => undefined, onStop: () => undefined }, abortedDuringSleep.signal, { intervalMs: 60000 });
  assert.ok(Date.now() - t < 2000);
});

const RUN_ID = '11111111-1111-4111-8111-111111111111';
async function project(outputDir = 'out') {
  const dir = await mkdtemp(join(tmpdir(), 'qg-desktop-open-'));
  const config = join(dir, '.qualitygate.yml');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, outputDir, gates: [{ id: 'ok', run: 'true' }] }));
  return { dir, config };
}

test('only the report folder and a real run folder inside it can be opened', async () => {
  const { dir, config } = await project();
  await assert.rejects(resolveFolder(config, 'reports'), /No reports exist yet/);
  await mkdir(join(dir, 'out', RUN_ID), { recursive: true });
  const reports = await resolveFolder(config, 'reports');
  assert.equal(await resolveFolder(config, 'run', RUN_ID), join(reports, RUN_ID));
  for (const bad of [undefined, '', '..', '../out', RUN_ID + '/..', 'not-a-uuid', '22222222-2222-4222-8222-222222222222']) await assert.rejects(resolveFolder(config, 'run', bad), /Invalid run id|no evidence folder/, String(bad));
  const outside = await mkdtemp(join(tmpdir(), 'qg-desktop-outside-'));
  const planted = '33333333-3333-4333-8333-333333333333';
  await symlink(outside, join(dir, 'out', planted));
  await assert.rejects(resolveFolder(config, 'run', planted), /no evidence folder/);
  await writeFile(join(dir, 'out', '44444444-4444-4444-8444-444444444444'), 'a file');
  await assert.rejects(resolveFolder(config, 'run', '44444444-4444-4444-8444-444444444444'), /no evidence folder/);
});

test('a report folder outside the project or shaped like an application bundle is refused', async () => {
  const outside = await project('../elsewhere');
  await mkdir(join(outside.dir, '..', 'elsewhere'), { recursive: true });
  await assert.rejects(resolveFolder(outside.config, 'reports'), /outside the project/);
  for (const name of ['Evil.app', 'nested/Setup.PKG']) {
    const bundle = await project(name);
    await mkdir(join(bundle.dir, name), { recursive: true });
    await assert.rejects(resolveFolder(bundle.config, 'reports'), /application bundle/, name);
  }
});

test('a report path that is a file is refused, so the file manager never launches it', async () => {
  const { dir, config } = await project('script.sh');
  await writeFile(join(dir, 'script.sh'), '#!/bin/sh\n');
  await assert.rejects(resolveFolder(config, 'reports'), /not a directory/);
});

test('a run folder that is a symlink is refused even when it points inside the report folder', async () => {
  const { dir, config } = await project();
  await mkdir(join(dir, 'out', RUN_ID), { recursive: true });
  const alias = '55555555-5555-4555-8555-555555555555';
  await symlink(join(dir, 'out', RUN_ID), join(dir, 'out', alias));
  await assert.rejects(resolveFolder(config, 'run', alias), /no evidence folder/);
});

test('the file manager is started with one directory argument and no shell', async () => {
  assert.deepEqual([openerFor('darwin'), openerFor('win32'), openerFor('linux')], ['open', 'explorer.exe', 'xdg-open']);
  const calls: unknown[][] = [];
  const fakeSpawn = ((command: string, args: string[], options: object) => {
    calls.push([command, args, options]);
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => undefined;
    setImmediate(() => child.emit(command === 'explorer.exe' ? 'error' : 'spawn', new Error('no explorer')));
    return child;
  }) as unknown as typeof spawn;
  await openDirectory('/tmp/out', 'darwin', fakeSpawn);
  // -R reveals the folder in Finder: whatever LaunchServices thinks it is, it is shown and never launched.
  assert.deepEqual(calls[0], ['open', ['-R', '/tmp/out'], { stdio: 'ignore', detached: true, shell: false }]);
  await assert.rejects(openDirectory('C:\\out', 'win32', fakeSpawn), /could not be started: no explorer/);
  await flush();
});
