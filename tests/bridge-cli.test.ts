import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isKnownOrigin, originPolicy, parseOrigins, serveBridge, revokeAll } from '../packages/bridge/src/index.js';
import { RateLimiter, readBody } from '../packages/bridge/src/limits.js';

const entry = resolve('packages/cli/src/index.ts');
const EXT = `chrome-extension://${'c'.repeat(32)}`;
async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'qg-bridge-cli-'));
  await writeFile(join(dir, '.qualitygate.yml'), JSON.stringify({ schemaVersion: 1, outputDir: 'out', gates: [{ id: 'ok', run: 'true' }] }));
  return dir;
}
function cli(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((res, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.once('error', reject); child.once('close', code => res({ code, stdout, stderr }));
  });
}

test('origin allow list accepts only extension ids, Tauri and the loopback dashboard', () => {
  for (const ok of [EXT, 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'http://127.0.0.1:4173', 'http://127.0.0.1:65535']) assert.equal(isKnownOrigin(ok), true, ok);
  for (const bad of ['*', 'null', '', 'https://example.com', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:70000', 'http://127.0.0.1:80/x', 'http://localhost:4173',
    'chrome-extension://UPPERCASE'.padEnd(46, 'A'), 'chrome-extension://abc', `${EXT}/path`, 'http://[::1]:4173']) assert.equal(isKnownOrigin(bad), false, bad);
  assert.deepEqual(parseOrigins([EXT, EXT]), [EXT]);
  assert.throws(() => parseOrigins(['https://example.com']), /Unsupported origin/);
  const open = originPolicy(); const pinned = originPolicy([EXT]);
  assert.equal(open(EXT), true); assert.equal(open(`chrome-extension://${'d'.repeat(32)}`), true); assert.equal(open(undefined), false);
  assert.equal(pinned(EXT), true); assert.equal(pinned(`chrome-extension://${'d'.repeat(32)}`), false); assert.equal(pinned('tauri://localhost'), true);
});

test('rate limiter windows and bounded body reader', async () => {
  let now = 0;
  const limiter = new RateLimiter(2, 1000, () => now);
  assert.deepEqual([limiter.hit('a'), limiter.hit('a'), limiter.hit('a'), limiter.hit('b')], [0, 0, 1, 0]);
  now = 1000; assert.equal(limiter.hit('a'), 0);
  async function* parts(...text: string[]) { for (const t of text) yield t; }
  assert.equal(await readBody(parts('ab', 'cd'), 4), 'abcd');
  assert.equal(await readBody(parts('ab', 'cde'), 4), undefined);
});

test('serveBridge prints a pairing code, and revokeAll removes stored tokens', async () => {
  const dir = await project(); const config = join(dir, '.qualitygate.yml');
  try {
    const output: string[] = []; const stop = new AbortController();
    const serving = serveBridge({ configPath: config, port: 0, origins: [EXT], out: t => output.push(t), err: t => output.push(t) }, stop.signal);
    for (let i = 0; i < 100 && !output.length; i++) await new Promise(r => setTimeout(r, 20));
    const text = output.join('');
    const base = /http:\/\/127\.0\.0\.1:\d+/.exec(text)![0]; const code = /Pairing code: ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(text)![1]!;
    const pairing = await fetch(`${base}/v1/pair`, { method: 'POST', headers: { Origin: EXT, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(pairing.status, 200);
    stop.abort(); await serving;
    assert.equal(await revokeAll(config), 1);
    assert.equal(JSON.parse(await readFile(join(dir, 'out', 'bridge-tokens.json'), 'utf8')).tokens.length, 0);
    assert.equal(await revokeAll(config), 0);
    const busy = serveBridge({ configPath: config, port: 0, origins: [], out: () => undefined, err: () => undefined }, AbortSignal.abort());
    await busy;
    await assert.rejects(serveBridge({ configPath: config, port: 0, origins: ['bogus'], out: () => undefined, err: () => undefined }, AbortSignal.abort()), /Unsupported origin/);
    const first = new AbortController(); const out: string[] = [];
    const one = serveBridge({ configPath: config, port: 0, origins: [], out: t => out.push(t), err: () => undefined }, first.signal);
    for (let i = 0; i < 100 && !out.length; i++) await new Promise(r => setTimeout(r, 20));
    const port = Number(/:(\d+)\n/.exec(out.join(''))![1]);
    await assert.rejects(serveBridge({ configPath: config, port, origins: [], out: () => undefined, err: () => undefined }, AbortSignal.abort()), /EADDRINUSE/);
    first.abort(); await one;
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('qualitygate bridge: pairs a client, serves, and exits 130 on SIGINT; --revoke-all and bad flags', async () => {
  const dir = await project(); const config = join(dir, '.qualitygate.yml');
  try {
    for (const args of [['bridge', 'extra'], ['bridge', '--port', '70000'], ['bridge', '--origin', 'https://evil.example'], ['run', '--revoke-all'], ['run', '--port', '1'], ['run', '--origin', EXT]]) {
      const failed = await cli([...args, '--config', config]);
      assert.equal(failed.code, 2, args.join(' ')); assert.match(failed.stderr, /QualityGate:/);
    }
    const none = await cli(['bridge', '--revoke-all', '--config', config, '--json']);
    assert.equal(none.code, 0); assert.deepEqual(JSON.parse(none.stdout), { schemaVersion: 1, revoked: 0 });
    assert.match((await cli(['bridge', '--revoke-all', '--config', config])).stdout, /Revoked 0 bridge token/);
    assert.match((await cli(['--help'])).stdout, /qualitygate bridge/);

    const child = spawn(process.execPath, ['--import', 'tsx', entry, 'bridge', '--port', '0', '--origin', EXT, '--config', config]);
    let output = ''; let errors = ''; child.stderr.on('data', b => { errors += b; });
    const closed = new Promise<number | null>(res => child.once('close', res));
    await new Promise<void>((res, reject) => { child.stdout.on('data', b => { output += b; if (output.includes('Press Ctrl+C')) res(); }); child.once('error', reject); });
    const base = /http:\/\/127\.0\.0\.1:\d+/.exec(output)![0]; const code = /Pairing code: (\S+)/.exec(output)![1]!;
    const headers = { Origin: EXT, 'Content-Type': 'application/json' };
    const token = (await (await fetch(`${base}/v1/pair`, { method: 'POST', headers, body: JSON.stringify({ code }) })).json()).token;
    const gates = await (await fetch(`${base}/v1/gates`, { headers: { Origin: EXT, Authorization: `Bearer ${token}` } })).json();
    assert.deepEqual(gates.gates, [{ id: 'ok', type: 'command' }]);
    child.kill('SIGINT');
    assert.equal(await closed, 130); assert.equal(errors, '');
    const revoked = await cli(['bridge', '--revoke-all', '--config', config]);
    assert.match(revoked.stdout, /Revoked 1 bridge token/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
