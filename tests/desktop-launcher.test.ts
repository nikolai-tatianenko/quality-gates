import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DesktopBridgeError, DesktopClient, DESKTOP_ORIGIN, type Fetch } from '../packages/desktop/src/client.js';
import { attachBridge, launchBridge } from '../packages/desktop/src/launcher.js';

const fake = resolve('tests/fixtures/fake-bridge.mjs');
const entry = resolve('packages/cli/src/index.ts');
const cli = (mode: string) => ({ command: process.execPath, args: [fake, mode] });
const launch = (mode: string, extra: object = {}) => launchBridge({ cli: cli(mode), configPath: '/x/.qualitygate.yml', cwd: process.cwd(), timeoutMs: 5000, graceMs: 300, ...extra });

test('launching pairs with the code the bridge printed, reads runs with the token and revokes it on stop', async () => {
  const session = await launch('ok');
  assert.equal(session.mode, 'launched');
  assert.deepEqual(await session.client.latestRun(), { runId: 'r1', decision: 'PASS', exitCode: 0 });
  await session.stop();
  await assert.rejects(session.client.latestRun(), (error: DesktopBridgeError) => error.kind === 'down');
});

test('a bridge that ignores SIGTERM is killed after the grace period; a failing revoke does not block the stop', async () => {
  const session = await launch('stubborn');
  await session.stop();
  const failing = await launch('revoke-fails');
  await failing.stop();
});

test('launch failures are explicit and leave no process behind', async () => {
  await assert.rejects(launch('exit'), /exited before it was ready \(exit 3\)/);
  await assert.rejects(launch('silent', { timeoutMs: 200 }), /did not become ready within 200 ms/);
  await assert.rejects(launchBridge({ cli: { command: join(tmpdir(), 'no-such-binary'), args: [] }, configPath: 'c', cwd: process.cwd() }), /could not be started/);
  await assert.rejects(launch('dead-port'), (error: DesktopBridgeError) => error.kind === 'down');
  await assert.rejects(launch('wrong-name'), /does not answer like a QualityGate bridge/);
  await assert.rejects(launch('bad-pair'), (error: DesktopBridgeError) => error.kind === 'unauthorized');
  await assert.rejects(launch('no-token'), /did not return a token/);
});

test('the start-up error carries what the bridge wrote to stderr', async () => {
  const script = join(await mkdtemp(join(tmpdir(), 'qg-desktop-')), 'err.mjs');
  await writeFile(script, 'process.stderr.write("config exploded\\n"); process.exit(2);');
  await assert.rejects(launchBridge({ cli: { command: process.execPath, args: [script] }, configPath: 'c', cwd: process.cwd(), timeoutMs: 5000 }), /exit 2\)\. config exploded/);
});

test('a bridge killed by a signal is reported as exited', async () => {
  const script = join(await mkdtemp(join(tmpdir(), 'qg-desktop-')), 'kill.mjs');
  await writeFile(script, 'process.kill(process.pid, "SIGKILL");');
  await assert.rejects(launchBridge({ cli: { command: process.execPath, args: [script] }, configPath: 'c', cwd: process.cwd(), timeoutMs: 5000 }), /exit signal/);
});

test('attaching needs a valid port and a working code and never kills the bridge it joined', async () => {
  await assert.rejects(attachBridge(0, 'AAAA-BBBB'), (error: DesktopBridgeError) => error.kind === 'invalid');
  await assert.rejects(attachBridge(70000, 'AAAA-BBBB'), /between 1 and 65535/);
  await assert.rejects(attachBridge(1.5, 'AAAA-BBBB'), /between 1 and 65535/);
  await assert.rejects(attachBridge(1, 'AAAA-BBBB'), (error: DesktopBridgeError) => error.kind === 'down');
  const host = await launch('ok');
  const attached = await attachBridge(host.port, 'K7QM-4TXD');
  assert.equal(attached.mode, 'attached');
  assert.equal((await attached.client.latestRun())?.runId, 'r1');
  await attached.stop();
  assert.equal((await host.client.latestRun())?.runId, 'r1', 'the attach did not stop the bridge');
  await host.stop();
});

test('the client maps every status to a kind and sends the desktop origin', async () => {
  const seen: Record<string, string>[] = [];
  const answer = (status: number, body: string): Fetch => async (_url, init) => { seen.push(init?.headers ?? {}); return { status, text: async () => body }; };
  for (const [status, kind] of [[400, 'invalid'], [401, 'unauthorized'], [403, 'forbidden'], [404, 'not-found'], [415, 'invalid'], [500, 'server'], [429, 'server']] as const)
    await assert.rejects(new DesktopClient(1, 't', answer(status, JSON.stringify({ error: 'nope' }))).ping(), (error: DesktopBridgeError) => error.kind === kind && error.message === 'nope');
  await assert.rejects(new DesktopClient(1, undefined, answer(502, '<html>')).ping(), /HTTP 502/);
  await assert.rejects(new DesktopClient(1, undefined, answer(200, '{}')).ping(), /does not answer like/);
  await assert.rejects(new DesktopClient(1, undefined, answer(200, 'not json')).ping(), /does not answer like/);
  assert.equal(seen[0]?.Origin, DESKTOP_ORIGIN);
  assert.equal(seen[0]?.Authorization, 'Bearer t');
  assert.equal(seen.at(-1)?.Authorization, undefined);
  await new DesktopClient(1, undefined).revoke();
  await assert.rejects(new DesktopClient(1, 't', answer(500, '{}')).latestRun(), (error: DesktopBridgeError) => error.kind === 'server');
  assert.equal(await new DesktopClient(1, 't', answer(404, '{}')).latestRun(), undefined);
});

test('against the real bridge: launch, see a run appear, revoke and stop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-desktop-real-'));
  const config = join(dir, '.qualitygate.yml');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, outputDir: 'out', gates: [{ id: 'ok', run: 'true' }] }));
  const real = { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), entry] };
  const session = await launchBridge({ cli: real, configPath: config, cwd: dir, timeoutMs: 30000 });
  try {
    assert.equal(await session.client.latestRun(), undefined, 'no run yet');
    const code = await new Promise<number | null>(done => { const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), entry, 'run', '--config', config], { cwd: dir, stdio: 'ignore' }); child.once('close', done); });
    assert.equal(code, 0);
    const run = await session.client.latestRun();
    assert.equal(run?.decision, 'PASS'); assert.equal(run?.exitCode, 0);
    assert.deepEqual(run?.gates?.map(g => g.id), ['ok']);
  } finally { await session.stop(); }
  await assert.rejects(session.client.latestRun(), (error: DesktopBridgeError) => error.kind === 'down');
});
