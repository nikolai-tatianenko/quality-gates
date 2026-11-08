import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { startDashboard } from '../packages/desktop/src/dashboard.js';
import { runHost } from '../packages/desktop/src/host-main.js';

const entry = resolve('packages/cli/src/index.ts');
const tsx = import.meta.resolve('tsx');
const tmp = () => mkdtemp(join(tmpdir(), 'qg-desktop-main-'));
async function fixture() {
  const root = await tmp();
  const dir = join(root, 'proj'); const assets = join(root, 'assets'); const data = join(root, 'data');
  await mkdir(dir); await mkdir(assets);
  await writeFile(join(assets, 'index.html'), '<!doctype html><title>dash</title>');
  await writeFile(join(dir, '.qualitygate.yml'), JSON.stringify({ schemaVersion: 1, outputDir: 'out', gates: [{ id: 'ok', run: 'true' }] }));
  return { dir, assets, data };
}

test('the shared dashboard is served on loopback for one project', async () => {
  const { dir, assets } = await fixture();
  const dashboard = await startDashboard(join(dir, '.qualitygate.yml'), assets);
  try {
    assert.match(dashboard.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await fetch(dashboard.url);
    assert.equal(page.status, 200); assert.match(await page.text(), /dash/);
  } finally { await dashboard.close(); }
});

test('the dashboard start fails explicitly when the port cannot be bound', async () => {
  const { dir, assets } = await fixture();
  const net = await import('node:net');
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (this: import('node:net').Server) { setImmediate(() => this.emit('error', new Error('EADDRINUSE'))); return this; } as typeof originalListen;
  try { await assert.rejects(startDashboard(join(dir, '.qualitygate.yml'), assets), /EADDRINUSE/); } finally { net.Server.prototype.listen = originalListen; }
});

async function protocol(args: string[]) {
  const input = new PassThrough(); const lines: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  const done = runHost({ input, write: line => { lines.push(JSON.parse(line)); waiters.splice(0).forEach(w => w()); }, args });
  const send = (value: unknown) => input.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
  const waitFor = async (match: (line: Record<string, unknown>) => boolean) => {
    for (;;) { const found = lines.find(match); if (found) return found; await new Promise<void>(resolve => waiters.push(resolve)); }
  };
  return { input, lines, send, waitFor, done };
}

test('the host speaks one JSON line per request and answers errors with the same id', async () => {
  const { dir, assets, data } = await fixture();
  const host = await protocol(['--cli', entry, '--data-dir', data, '--assets', assets]);
  host.send({ id: 1, method: 'state', params: {} });
  const state = await host.waitFor(line => line.id === 1) as { ok: boolean; result: { recents: unknown[]; session: unknown } };
  assert.equal(state.ok, true); assert.deepEqual(state.result.recents, []); assert.equal(state.result.session, null);
  host.send({ id: 2, method: 'rm -rf /' });
  assert.deepEqual(await host.waitFor(line => line.id === 2), { id: 2, ok: false, error: 'Unknown method.' });
  host.send('this is not json');
  assert.equal((await host.waitFor(line => line.id === null)).ok, false);
  host.send({ id: 3, method: 'project.prepare', params: { path: join(dir, 'missing'), mode: 'launch' } });
  assert.match(String((await host.waitFor(line => line.id === 3)).error), /does not exist/);
  host.input.end();
  await host.done;
});

test('end to end with the real bridge, dashboard and CLI: allow, run, get the verdict event and the opt-in notification', async () => {
  const { dir, assets, data } = await fixture();
  const real = join(await tmp(), 'cli.mjs');
  await writeFile(real, `import ${JSON.stringify(tsx)}; await import(${JSON.stringify(pathToFileURL(entry).href)});`);
  const host = await protocol(['--cli', real, '--data-dir', data, '--assets', assets, '--poll-ms', '100']);
  try {
    host.send({ id: 1, method: 'prefs.set', params: { notifications: true } });
    await host.waitFor(line => line.id === 1);
    host.send({ id: 2, method: 'project.prepare', params: { path: dir, mode: 'launch' } });
    const prompt = (await host.waitFor(line => line.id === 2) as { result: { promptId: string } }).result;
    host.send({ id: 3, method: 'project.start', params: { promptId: prompt.promptId, accepted: true } });
    const started = await host.waitFor(line => line.id === 3) as { ok: boolean; error?: string; result: { session: { dashboardUrl: string; mode: string } } };
    assert.equal(started.ok, true, started.error);
    assert.equal(started.result.session.mode, 'launched');
    assert.equal((await fetch(started.result.session.dashboardUrl)).status, 200);
    const code = await new Promise<number | null>(done => { const child = spawn(process.execPath, ['--import', tsx, entry, 'run', '--config', join(dir, '.qualitygate.yml')], { cwd: dir, stdio: 'ignore' }); child.once('close', done); });
    assert.equal(code, 0);
    const run = await host.waitFor(line => line.event === 'run');
    assert.deepEqual([run.decision, run.exitCode], ['PASS', 0]);
    const notify = await host.waitFor(line => line.event === 'notify');
    assert.equal(notify.kind, 'pass'); assert.equal(notify.title, 'proj: PASS');
    assert.doesNotMatch(JSON.stringify(notify), /true|\/tmp|\/var/);
    host.send({ id: 4, method: 'project.stop', params: {} });
    assert.equal((await host.waitFor(line => line.id === 4) as { result: { session: unknown } }).result.session, null);
  } finally { host.input.end(); await host.done; }
});

test('missing options fail before anything starts', async () => {
  await assert.rejects(runHost({ input: new PassThrough(), write: () => undefined, args: ['--cli', 'x'] }), /Missing --data-dir/);
  await assert.rejects(runHost({ input: new PassThrough(), write: () => undefined, args: ['--cli'] }), /Missing --cli/);
});

test('the host program reads requests from stdin and exits when stdin closes; a bad start is exit code 2', async () => {
  const { assets, data } = await fixture();
  const bin = resolve('packages/desktop/src/host-bin.ts');
  const child = spawn(process.execPath, ['--import', tsx, bin, '--cli', entry, '--data-dir', data, '--assets', assets], { stdio: ['pipe', 'pipe', 'pipe'] });
  const reply = new Promise<string>(done => createInterface({ input: child.stdout }).once('line', done));
  child.stdin.write(`${JSON.stringify({ id: 9, method: 'state' })}\n`);
  assert.equal(JSON.parse(await reply).id, 9);
  child.stdin.end();
  assert.equal(await new Promise(done => child.once('close', done)), 0);
  const bad = spawn(process.execPath, ['--import', tsx, bin], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; bad.stderr.on('data', chunk => { stderr += chunk; });
  assert.equal(await new Promise(done => bad.once('close', done)), 2);
  assert.match(stderr, /Missing --cli/);
});
