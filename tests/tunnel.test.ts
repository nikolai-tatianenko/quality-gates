import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startTunnel, type Spawn } from '../packages/dashboard/src/tunnel.js';

function fake() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: string[]; kill(signal: string): boolean };
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.killed = [];
  child.kill = (signal: string) => { child.killed.push(signal); return true; };
  const calls: unknown[][] = [];
  return { child, calls, spawn: ((...args: unknown[]) => { calls.push(args); return child; }) as unknown as Spawn };
}
test('startTunnel runs cloudflared and ngrok with the expected arguments and parses the public URL', async () => {
  const cf = fake();
  const pending = startTunnel('cloudflare', 4173, () => assert.fail('exit'), { spawnProcess: cf.spawn });
  cf.child.stderr.emit('data', Buffer.from('INF | https://random-words.trycloudflare.com |\n'));
  cf.child.stderr.emit('data', Buffer.from('ignored after ready'));
  const tunnel = await pending; assert.equal(tunnel.url, 'https://random-words.trycloudflare.com');
  assert.deepEqual(cf.calls[0]!.slice(0, 2), ['cloudflared', ['tunnel', '--url', 'http://127.0.0.1:4173']]);
  tunnel.close(); assert.deepEqual(cf.child.killed, ['SIGTERM']);
  const ng = fake(); let exited: number | null | undefined;
  const second = startTunnel('ngrok', 80, code => { exited = code; }, { spawnProcess: ng.spawn });
  ng.child.stdout.emit('data', Buffer.from('lvl=info msg="no url yet"\n')); ng.child.stdout.emit('data', Buffer.from('msg="started tunnel" url=https://abc.ngrok-free.app\n'));
  assert.equal((await second).url, 'https://abc.ngrok-free.app');
  assert.deepEqual(ng.calls[0]!.slice(0, 2), ['ngrok', ['http', '127.0.0.1:80', '--log', 'stdout', '--log-format', 'logfmt']]);
  ng.child.emit('close', 3); assert.equal(exited, 3);
});
test('startTunnel reports a missing binary, spawn errors, early exit and silence', async () => {
  const missing = fake(); const a = startTunnel('ngrok', 1, () => {}, { spawnProcess: missing.spawn });
  missing.child.emit('error', Object.assign(Error('spawn ngrok ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(a, /ngrok is not installed or not on PATH/);
  const broken = fake(); const b = startTunnel('cloudflare', 1, () => {}, { spawnProcess: broken.spawn });
  broken.child.emit('error', Object.assign(Error('denied'), { code: 'EACCES' }));
  await assert.rejects(b, /Could not start cloudflared: denied/);
  const early = fake(); const c = startTunnel('cloudflare', 1, () => {}, { spawnProcess: early.spawn }); early.child.emit('close', 1);
  await assert.rejects(c, /exited \(code 1\) before reporting/);
  const silent = fake(); await assert.rejects(startTunnel('ngrok', 1, () => {}, { spawnProcess: silent.spawn, timeoutMs: 10 }), /did not report a public URL within 0.01s/);
  assert.deepEqual(silent.child.killed, ['SIGTERM']);
});
const entry = resolve('packages/dashboard/src/cli.ts');
const loader = resolve('node_modules/tsx/dist/loader.mjs');
async function setup(script?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'qg-tunnel-'));
  const bin = join(dir, 'bin'); await import('node:fs/promises').then(fs => fs.mkdir(bin));
  const config = join(dir, 'c.json'); await writeFile(config, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'check', run: 'true' }] }));
  if (script) { await writeFile(join(bin, 'cloudflared'), script); await chmod(join(bin, 'cloudflared'), 0o755); }
  const start = () => {
    const child = spawn(process.execPath, ['--import', loader, entry, '--config', config, '--port', '0', '--tunnel', 'cloudflare'], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } });
    let stdout = ''; let stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    const closed = new Promise<number | null>(res => child.once('close', res));
    return { child, closed, out: () => stdout, err: () => stderr };
  };
  return { dir, bin, start };
}
test('dashboard --tunnel exits 2 with a clear message when the binary is missing', async () => {
  const t = await setup();
  try { const run = t.start(); assert.equal(await run.closed, 2); assert.match(run.err(), /cloudflared is not installed or not on PATH/); assert.doesNotMatch(run.out(), /token=/); }
  finally { await rm(t.dir, { recursive: true, force: true }); }
});
test('dashboard --tunnel prints the tokenized read-only URL with a warning and closes the tunnel on exit', async () => {
  const t = await setup(`#!/bin/sh\necho $$ > "${tmpdir()}/qg-tunnel-pid-$PPID"\necho "https://fake-name.trycloudflare.com" >&2\nexec sleep 30\n`);
  try {
    const run = t.start();
    await new Promise<void>(res => { const timer = setInterval(() => { if (run.out().includes('Share:')) { clearInterval(timer); res(); } }, 20); });
    assert.match(run.out(), /Share: https:\/\/fake-name\.trycloudflare\.com\/\?token=[A-Za-z0-9_-]{43}\n/);
    assert.match(run.out(), /read-only/i); assert.match(run.out(), /logs, findings and evidence/i);
    const pid = Number((await readFile(join(tmpdir(), `qg-tunnel-pid-${run.child.pid}`), 'utf8')).trim());
    process.kill(pid, 0); run.child.kill('SIGTERM'); assert.equal(await run.closed, 0);
    await delay(100); assert.throws(() => process.kill(pid, 0));
    await rm(join(tmpdir(), `qg-tunnel-pid-${run.child.pid}`), { force: true });
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});
test('dashboard --tunnel exits 2 when the tunnel process dies', async () => {
  const t = await setup(`#!/bin/sh\necho "https://gone.trycloudflare.com" >&2\nsleep 0.3\n`);
  try { const run = t.start(); assert.equal(await run.closed, 2); assert.match(run.err(), /tunnel (?:closed|exited)/i); }
  finally { await rm(t.dir, { recursive: true, force: true }); }
});
