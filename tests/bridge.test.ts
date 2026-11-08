import { Jobs } from '../packages/bridge/src/jobs.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge, type BridgeOptions, type BridgeService } from '../packages/bridge/src/index.js';
import { runResultSchema, type RunResult } from '../packages/protocol/src/index.js';

const EXT = `chrome-extension://${'a'.repeat(32)}`;
const OTHER_EXT = `chrome-extension://${'b'.repeat(32)}`;
const TAURI = 'tauri://localhost';
type Overrides = Partial<BridgeOptions> & { gates?: unknown[]; thresholds?: boolean };

async function fixture(over: Overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qg-bridge-'));
  const config = join(dir, '.qualitygate.yml');
  const gates = over.gates ?? [{ id: 'ok', run: 'true' }, { id: 'bad', run: 'false' }, { id: 'slow', run: 'sleep 30' },
    { id: 'art', run: 'printf hi > out.txt', artifacts: ['out.txt'] }];
  await writeFile(config, JSON.stringify({ schemaVersion: 1, outputDir: 'out', gates, ...(over.thresholds === false ? {} : { thresholds: { performance: 50, accessibility: 50, seo: 50, 'best-practices': 50 } }) }));
  const options = { ...over }; delete options.gates; delete options.thresholds;
  const bridge = await createBridge({ configPath: config, ...options });
  await new Promise<void>(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  const address = bridge.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  async function call(method: string, path: string, init: { origin?: string | null; token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...init.headers };
    if (init.origin !== null) headers.Origin = init.origin ?? EXT;
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + path, { method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    const text = await response.text();
    const body = (() => { try { return JSON.parse(text); } catch { return text; } })();
    return { status: response.status, headers: response.headers, body, text };
  }
  async function pair(origin = EXT) {
    const code = bridge.issuePairingCode();
    const response = await call('POST', '/v1/pair', { origin, body: { code } });
    assert.equal(response.status, 200); return response.body.token as string;
  }
  async function finished(token: string, jobId: string, origin = EXT) {
    for (let i = 0; i < 200; i++) {
      const job = (await call('GET', `/v1/jobs/${jobId}`, { token, origin })).body;
      if (!['running', 'cancelling'].includes(job.status)) return job;
      await delay(25);
    }
    throw new Error('job did not finish');
  }
  return { ...bridge, dir, config, base, call, pair, finished, out: join(dir, 'out'), cleanup: async () => { await bridge.close(); await rm(dir, { recursive: true, force: true }); } };
}
type App = Awaited<ReturnType<typeof fixture>>;
async function using(over: Overrides, body: (app: App) => Promise<void>) {
  const app = await fixture(over);
  try { await body(app); } finally { await app.cleanup(); }
}
const fakeService = (over: Partial<BridgeService> = {}): BridgeService => ({ list: async () => ({ gates: [{ id: 'ok' }] }), run: async () => { throw new Error('unused'); }, scan: async () => { throw new Error('unused'); }, close: async () => undefined, ...over });
function result(over: Partial<RunResult> = {}): RunResult {
  return runResultSchema.parse({ schemaVersion: 1, runId: '11111111-1111-4111-8111-111111111111', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z',
    execution: 'completed', decision: 'PASS', results: [], gates: [], errors: [], ...over });
}

test('pairing exchanges a single-use code for a token bound to the pairing origin', async () => {
  await using({}, async app => {
    assert.deepEqual((await app.call('GET', '/v1/ping')).body, { name: 'qualitygate-bridge', apiVersion: 1 });
    assert.equal((await app.call('GET', '/v1/gates')).status, 401);
    assert.equal((await app.call('POST', '/v1/pair', { body: { code: 'AAAA-AAAA' } })).status, 401, 'no code issued yet');
    const code = app.issuePairingCode();
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal((await app.call('POST', '/v1/pair', { body: { code: 'WRONG-CODE' } })).status, 401);
    assert.equal((await app.call('POST', '/v1/pair', { body: { code: 'x', extra: 1 } })).status, 400);
    const paired = await app.call('POST', '/v1/pair', { body: { code: code.toLowerCase(), label: 'Chrome' } });
    assert.equal(paired.status, 200); assert.equal(paired.body.origin, EXT);
    assert.ok(paired.body.token.length >= 43); assert.ok(Date.parse(paired.body.expiresAt) > Date.now());
    assert.equal((await app.call('POST', '/v1/pair', { body: { code } })).status, 401, 'the code works once');
    const token = paired.body.token;
    assert.equal((await app.call('GET', '/v1/gates', { token })).status, 200);
    assert.equal((await app.call('GET', '/v1/gates', { token, origin: OTHER_EXT })).status, 401, 'another extension id cannot use the token');
    assert.equal((await app.call('GET', '/v1/gates', { token, origin: TAURI })).status, 401, 'token is pinned to the origin that paired');
    assert.equal((await app.call('GET', '/v1/gates', { token: token + 'x' })).status, 401);
    assert.equal((await app.call('GET', '/v1/gates', { headers: { Authorization: `Basic ${token}` } })).status, 401);
    assert.equal((await app.call('DELETE', '/v1/token', { token })).status, 200);
    assert.equal((await app.call('GET', '/v1/gates', { token })).status, 401, 'revoked');
  });
});

test('every request needs an allow-listed Origin and a loopback Host', async () => {
  await using({}, async app => {
    const token = await app.pair();
    for (const origin of ['https://evil.example', 'http://127.0.0.1:9999', 'http://localhost:4173', 'null', 'chrome-extension://short', `${EXT}/`, '*']) {
      const response = await app.call('GET', '/v1/gates', { token, origin });
      assert.equal(response.status, 403, origin); assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
    assert.equal((await app.call('GET', '/v1/ping', { origin: null })).status, 403, 'no Origin header');
    assert.equal((await app.call('POST', '/v1/pair', { origin: 'https://evil.example', body: { code: app.issuePairingCode() } })).status, 403);
    for (const origin of [TAURI, 'http://tauri.localhost', 'http://127.0.0.1:4173']) assert.equal((await app.call('GET', '/v1/ping', { origin })).status, 200, origin);
    const host = await new Promise<number | undefined>(resolve => {
      const req = request(app.base + '/v1/ping', { headers: { Host: 'rebind.example', Origin: EXT } }, res => { res.resume(); resolve(res.statusCode); }); req.end();
    });
    assert.equal(host, 403);
  });
});

test('a pinned extension id and extra loopback origins are the only ones accepted', async () => {
  await using({ origins: [EXT, 'http://127.0.0.1:5000'] }, async app => {
    assert.equal((await app.call('GET', '/v1/ping', { origin: OTHER_EXT })).status, 403);
    assert.equal((await app.call('GET', '/v1/ping', { origin: EXT })).status, 200);
    assert.equal((await app.call('GET', '/v1/ping', { origin: 'http://127.0.0.1:5000' })).status, 200);
  });
  await assert.rejects(createBridge({ configPath: 'x', origins: ['https://evil.example'] }), /Unsupported origin/);
});

test('CORS is exact-origin only and preflight needs no token', async () => {
  await using({}, async app => {
    const preflight = await app.call('OPTIONS', '/v1/runs', { origin: EXT });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), EXT);
    assert.match(preflight.headers.get('access-control-allow-headers')!, /Authorization/);
    assert.equal(preflight.headers.get('vary'), 'Origin');
    const denied = await app.call('OPTIONS', '/v1/runs', { origin: 'https://evil.example' });
    assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null);
    const rejected = await app.call('GET', '/v1/gates', { origin: EXT });
    assert.equal(rejected.status, 401, 'errors for an allowed origin carry CORS headers so the client can read them');
    assert.equal(rejected.headers.get('access-control-allow-origin'), EXT);
    assert.equal(rejected.headers.get('www-authenticate'), 'Bearer');
  });
});

test('tokens expire, pairing codes expire and wrong guesses burn the code', async () => {
  let now = 1_000_000;
  await using({ now: () => now, tokenTtlMs: 5000, pairingTtlMs: 2000, maxPairAttempts: 3 }, async app => {
    let code = app.issuePairingCode();
    now += 2000;
    assert.equal((await app.call('POST', '/v1/pair', { body: { code } })).status, 401, 'code expired');
    code = app.issuePairingCode();
    for (let i = 0; i < 3; i++) assert.equal((await app.call('POST', '/v1/pair', { body: { code: 'NOPE-NOPE' } })).status, 401);
    assert.equal((await app.call('POST', '/v1/pair', { body: { code } })).status, 401, 'three wrong guesses spent the code');
    const token = await app.pair();
    assert.equal((await app.call('GET', '/v1/gates', { token })).status, 200);
    now += 5000;
    assert.equal((await app.call('GET', '/v1/gates', { token })).status, 401, 'token expired');
  });
});

test('tokens are stored hashed in a 0600 file, survive a restart and can be revoked in bulk', async () => {
  await using({}, async app => {
    const token = await app.pair();
    const file = join(app.out, 'bridge-tokens.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(app.out)).mode & 0o077, 0, 'state directory is private');
    const text = await readFile(file, 'utf8');
    assert.ok(!text.includes(token), 'the bearer token itself is never written');
    await chmod(file, 0o644);
    const second = await createBridge({ configPath: app.config });
    assert.equal((await stat(file)).mode & 0o777, 0o600, 'loose permissions are tightened on load');
    assert.ok(second.store.verify(token, EXT));
    assert.equal(await second.store.revokeAll(), 1);
    assert.equal(await second.store.revokeAll(), 0);
    assert.equal(await second.store.revoke('missing'), false);
    await writeFile(file, '{"schemaVersion":2}');
    await assert.rejects(createBridge({ configPath: app.config }), /schemaVersion|invalid/i);
  });
});

test('rate limit, request size limit and content checks', async () => {
  let now = 0;
  await using({ now: () => now, rateLimit: 10 }, async app => {
    const token = await app.pair();
    assert.equal((await app.call('POST', '/v1/runs', { token, body: { gates: ['x'.repeat(5000)] } })).status, 413);
    const chunked = await new Promise<number | undefined>(resolve => {
      const req = request(app.base + '/v1/runs', { method: 'POST', headers: { Origin: EXT, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
      req.write('{"gates":["'); req.write('y'.repeat(5000)); req.end('"]}');
    });
    assert.equal(chunked, 413, 'no Content-Length: the body is cut off at the limit');
    assert.equal((await app.call('POST', '/v1/runs', { token, headers: { 'Content-Type': 'text/plain' }, body: undefined })).status, 400);
    const text = await fetch(app.base + '/v1/runs', { method: 'POST', headers: { Origin: EXT, Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: '{"gates":["ok"]}' });
    assert.equal(text.status, 415);
    const badJson = await fetch(app.base + '/v1/runs', { method: 'POST', headers: { Origin: EXT, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(badJson.status, 400);
    const withBody = await fetch(app.base + '/v1/gates', { method: 'GET', headers: { Origin: EXT, Authorization: `Bearer ${token}` }, body: undefined });
    assert.equal(withBody.status, 200);
    const getBody = await new Promise<number | undefined>(resolve => {
      const req = request(app.base + '/v1/gates', { method: 'GET', headers: { Origin: EXT, Authorization: `Bearer ${token}`, 'Content-Length': '2' } }, res => { res.resume(); resolve(res.statusCode); });
      req.end('{}');
    });
    assert.equal(getBody, 400);
    let limited: Awaited<ReturnType<typeof app.call>> | undefined;
    for (let i = 0; i < 12 && !limited; i++) { const r = await app.call('GET', '/v1/ping'); if (r.status === 429) limited = r; }
    assert.ok(limited, 'over the limit');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal(limited.headers.get('access-control-allow-origin'), EXT);
    now += 60_000;
    assert.equal((await app.call('GET', '/v1/ping')).status, 200, 'window passed');
    assert.equal((await app.call('GET', '/v1/ping', { origin: TAURI })).status, 200, 'limits are per origin');
  });
});

test('pairing attempts are rate limited separately and routing errors are explicit', async () => {
  await using({ rateLimit: 100 }, async app => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await app.call('POST', '/v1/pair', { body: { code: 'NOPE-NOPE' } })).status);
    assert.ok(codes.includes(429), JSON.stringify(codes));
    assert.equal((await app.call('POST', '/v1/pair', { body: { code: app.issuePairingCode() } })).status, 429, 'a throttled origin cannot pair even with the right code');
    assert.ok(await app.pair(TAURI), 'another origin is not affected');
    assert.equal((await app.call('GET', '/v1/nothing', { origin: TAURI })).status, 404);
    assert.equal((await app.call('PUT', '/v1/ping', { origin: TAURI })).status, 405);
    assert.equal((await app.call('GET', '/v1/runs/%E0%A4%A', { origin: TAURI })).status, 400);
  });
});

test('lists approved gates, runs only the selected ones and reports the unchanged verdict', async () => {
  await using({}, async app => {
    const token = await app.pair();
    const gates = (await app.call('GET', '/v1/gates', { token })).body;
    assert.deepEqual(gates.gates.map((g: { id: string }) => g.id), ['ok', 'bad', 'slow', 'art']);
    assert.equal(gates.scan.available, true); assert.ok(!JSON.stringify(gates).includes('sleep 30'), 'command lines are not exposed');
    assert.equal((await app.call('POST', '/v1/runs', { token, body: {} })).status, 400, 'gates are required');
    assert.equal((await app.call('POST', '/v1/runs', { token, body: { gates: [] } })).status, 400);
    assert.equal((await app.call('POST', '/v1/runs', { token, body: { gates: ['rm -rf /'] } })).body.error, 'Unknown gate: rm -rf /');
    assert.equal((await app.call('POST', '/v1/runs', { token, body: { command: 'id', gates: ['ok'] } })).status, 400, 'no extra fields');
    const started = await app.call('POST', '/v1/runs', { token, body: { gates: ['ok', 'bad', 'art'] } });
    assert.equal(started.status, 202); assert.equal(started.body.status, 'running');
    const job = await app.finished(token, started.body.jobId);
    assert.equal(job.status, 'finished'); assert.equal(job.decision, 'BLOCK'); assert.equal(job.exitCode, 1);
    const run = (await app.call('GET', `/v1/runs/${job.runId}`, { token })).body;
    assert.equal(run.decision, 'BLOCK'); assert.equal(run.exitCode, 1);
    assert.deepEqual(run.gates.map((g: { id: string }) => g.id).sort(), ['art', 'bad', 'ok']);
    const stored = JSON.parse(await readFile(join(app.out, job.runId, 'report.json'), 'utf8'));
    assert.equal(run.decision, stored.decision, 'the bridge reports the stored verdict as is');
    assert.equal((await app.call('GET', '/v1/runs/latest', { token })).body.runId, job.runId);
    const artifacts = (await app.call('GET', `/v1/runs/${job.runId}/artifacts`, { token })).body.artifacts;
    assert.equal(artifacts.length, 1); assert.equal(artifacts[0].kind, 'gate'); assert.equal(artifacts[0].source, 'art');
    const download = await app.call('GET', `/v1/runs/${job.runId}/artifacts/${encodeURIComponent(artifacts[0].name)}`, { token });
    assert.equal(download.status, 200); assert.equal(download.text, 'hi'); assert.equal(download.headers.get('content-disposition'), 'attachment');
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual((await app.call('GET', `/v1/runs/${job.runId}/findings`, { token })).body, { findings: [] });
    assert.equal((await app.call('GET', '/v1/runs/22222222-2222-4222-8222-222222222222', { token })).status, 404);
    assert.equal((await app.call('GET', '/v1/jobs/unknown', { token })).status, 404);
  });
});

test('history and trends come from the recorded runs', async () => {
  await using({}, async app => {
    const token = await app.pair();
    assert.deepEqual((await app.call('GET', '/v1/history', { token })).body, { runs: [], comparison: null });
    assert.equal((await app.call('GET', '/v1/runs/latest', { token })).status, 404, 'no run yet');
    for (const gates of [['ok'], ['ok', 'bad']]) {
      const started = await app.call('POST', '/v1/runs', { token, body: { gates } });
      await app.finished(token, started.body.jobId);
    }
    const history = (await app.call('GET', '/v1/history?limit=1', { token })).body;
    assert.equal(history.runs.length, 1); assert.deepEqual(history.comparison.newFailures, ['bad']);
    assert.ok(!JSON.stringify(history).includes('inputsHash'));
    const trends = (await app.call('GET', '/v1/trends', { token })).body;
    assert.equal(trends.runs, 2); assert.equal(trends.failingGates[0].id, 'bad');
    assert.equal((await app.call('GET', '/v1/history?limit=0', { token })).status, 400);
    assert.equal((await app.call('GET', '/v1/trends?limit=nope', { token })).status, 400);
    await writeFile(join(app.out, 'history.sqlite'), 'not a database');
    assert.equal((await app.call('GET', '/v1/history', { token })).status, 503);
  });
});

test('only one run at a time, and a run can be cancelled', async () => {
  await using({}, async app => {
    const token = await app.pair();
    const attempts = await Promise.all([1, 2, 3].map(() => app.call('POST', '/v1/runs', { token, body: { gates: ['slow'] } })));
    const statuses = attempts.map(a => a.status).sort();
    assert.deepEqual(statuses, [202, 409, 409], 'exactly one concurrent run is accepted');
    const first = attempts.find(a => a.status === 202)!.body;
    assert.equal((await app.call('POST', '/v1/scans', { token, body: { url: 'https://example.com' } })).status, 409, 'a scan also waits for the active run');
    const cancelled = await app.call('POST', `/v1/jobs/${first.jobId}/cancel`, { token });
    assert.equal(cancelled.status, 202); assert.equal(cancelled.body.status, 'cancelling');
    const job = await app.finished(token, first.jobId);
    assert.equal(job.status, 'cancelled'); assert.equal(job.exitCode, 130);
    assert.equal((await app.call('POST', `/v1/jobs/${first.jobId}/cancel`, { token })).status, 409, 'already finished');
    const next = await app.call('POST', '/v1/runs', { token, body: { gates: ['ok'] } });
    assert.equal(next.status, 202, 'the slot is free again');
    await app.finished(token, next.body.jobId);
  });
});

test('closing the bridge cancels the active run', async () => {
  const app = await fixture();
  const token = await app.pair();
  const started = await app.call('POST', '/v1/runs', { token, body: { gates: ['slow'] } });
  assert.equal(started.status, 202);
  await app.cleanup();
});

test('path traversal in run ids and artifact names is refused', async () => {
  await using({}, async app => {
    const token = await app.pair();
    const started = await app.call('POST', '/v1/runs', { token, body: { gates: ['art'] } });
    const job = await app.finished(token, started.body.jobId);
    await writeFile(join(app.dir, 'secret.txt'), 'top secret');
    for (const id of ['..', '%2e%2e', '..%2f..%2fsecret.txt', '%2e%2e%2f%2e%2e%2f', '..%5c..', 'not-a-uuid']) {
      const response = await app.call('GET', `/v1/runs/${id}`, { token });
      assert.ok([400, 404].includes(response.status), `${id}: ${response.status}`); assert.ok(!response.text.includes('top secret'));
    }
    const base = `/v1/runs/${job.runId}/artifacts/`;
    for (const name of ['..%2f..%2fsecret.txt', '..%2freport.json', '.hidden', 'a%5cb', 'a%00b', encodeURIComponent('../../secret.txt'), encodeURIComponent('/etc/passwd')]) {
      const response = await app.call('GET', base + name, { token });
      assert.equal(response.status, 400, `${name} -> ${response.status} ${response.text}`); assert.ok(!response.text.includes('top secret'));
    }
    assert.equal((await app.call('GET', base + '%2e%2e', { token })).status, 404, 'the URL parser collapses an encoded dot segment before routing');
    assert.equal((await app.call('GET', base + 'report.json', { token })).status, 404, 'files that are not listed artifacts are not served');
    assert.equal((await app.call('GET', base + 'gate-1-art.log', { token })).status, 404, 'logs are never served');
    assert.equal((await app.call('GET', base + 'x'.repeat(300), { token })).status, 400);
    const listed = (await app.call('GET', `/v1/runs/${job.runId}/artifacts`, { token })).body.artifacts[0].name;
    const target = join(app.out, job.runId, listed);
    await rm(target); await symlink(join(app.dir, 'secret.txt'), target);
    const linked = await app.call('GET', base + encodeURIComponent(listed), { token });
    assert.equal(linked.status, 404, 'a symlink planted in the run directory is not followed'); assert.ok(!linked.text.includes('top secret'));
    await rm(target);
    assert.equal((await app.call('GET', base + encodeURIComponent(listed), { token })).status, 404, 'missing file');
  });
});

test('logs and absolute paths never leave the machine, including secret scanner output', async () => {
  await using({}, async app => {
    const token = await app.pair();
    const runId = '33333333-3333-4333-8333-333333333333';
    await mkdir(join(app.out, runId), { recursive: true });
    const stored = result({ runId, decision: 'BLOCK', findings: [{ gateId: 'leaks', severity: 'error', message: 'leak found', evidencePath: join(app.out, runId, 'gate-1-leaks.json') }],
      gates: [{ id: 'leaks', command: 'gitleaks detect', execution: 'completed', decision: 'BLOCK', exitCode: 1, durationMs: 5, outputTail: 'ghp_SUPERSECRETVALUE',
        errors: [], evidencePath: join(app.out, runId, 'gate-1-leaks.log'), reportPath: join(app.out, runId, 'gate-1-leaks.json'), findings: [], artifacts: [] }] });
    await writeFile(join(app.out, runId, 'report.json'), JSON.stringify(stored));
    await writeFile(join(app.out, runId, 'gate-1-leaks.log'), 'ghp_SUPERSECRETVALUE');
    for (const path of [`/v1/runs/${runId}`, `/v1/runs/${runId}/findings`, `/v1/runs/${runId}/artifacts`, '/v1/runs/latest']) {
      const response = await app.call('GET', path, { token });
      assert.equal(response.status, 200, path);
      assert.ok(!response.text.includes('SUPERSECRET'), path); assert.ok(!response.text.includes(app.dir), `${path} leaks a local path`);
      assert.ok(!response.text.includes('gitleaks detect'), 'command lines stay local');
    }
    const finding = (await app.call('GET', `/v1/runs/${runId}/findings`, { token })).body.findings[0];
    assert.equal(finding.evidence, 'gate-1-leaks.json');
    assert.equal((await app.call('GET', `/v1/runs/${runId}/artifacts/gate-1-leaks.log`, { token })).status, 404);
    await writeFile(join(app.out, runId, 'report.json'), '{broken');
    const corrupt = await app.call('GET', `/v1/runs/${runId}`, { token });
    assert.equal(corrupt.status, 500, 'a corrupt report is an error, not an empty run'); assert.deepEqual(corrupt.body, { error: 'Internal error' });
  });
});

test('scanning a URL goes through the configured Lighthouse thresholds', async () => {
  const urls: string[] = [];
  const scan = async (url: string) => { urls.push(url); return result({ results: [{ url, execution: 'completed', decision: 'BLOCK', scores: { performance: 10 }, violations: ['performance 10 < 50'], errors: [] }], decision: 'BLOCK' }); };
  await using({ service: fakeService({ scan }) }, async app => {
    const token = await app.pair();
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'data:text/html,hi', 'https://user:pw@example.com/', 'not a url', 'ftp://example.com', '']) {
      assert.equal((await app.call('POST', '/v1/scans', { token, body: { url } })).status, 400, url);
    }
    assert.equal((await app.call('POST', '/v1/scans', { token, body: { url: 'https://example.com', gates: ['x'] } })).status, 400);
    assert.deepEqual(urls, []);
    const started = await app.call('POST', '/v1/scans', { token, body: { url: 'https://example.com/page?q=1' } });
    assert.equal(started.status, 202); assert.equal(started.body.kind, 'scan'); assert.equal(started.body.url, 'https://example.com/page?q=1');
    const job = await app.finished(token, started.body.jobId);
    assert.deepEqual(urls, ['https://example.com/page?q=1']);
    assert.equal(job.status, 'finished'); assert.equal(job.decision, 'BLOCK'); assert.equal(job.exitCode, 1);
  });
  await using({ service: fakeService(), thresholds: false }, async app => {
    const token = await app.pair();
    assert.equal((await app.call('GET', '/v1/gates', { token })).body.scan.available, false);
    assert.equal((await app.call('POST', '/v1/scans', { token, body: { url: 'https://example.com' } })).status, 409);
  });
});

test('runner failures are reported as an error job and unexpected errors are not leaked', async () => {
  const errors: unknown[] = [];
  await using({ onError: e => errors.push(e), service: fakeService({ run: async () => { throw new Error('boom /Users/secret/path'); } }) }, async app => {
    const token = await app.pair();
    const started = await app.call('POST', '/v1/runs', { token, body: { gates: ['ok'] } });
    const job = await app.finished(token, started.body.jobId);
    assert.equal(job.status, 'error'); assert.equal(job.exitCode, 2); assert.equal(errors.length, 1);
  });
  const hidden: unknown[] = [];
  await using({ onError: e => hidden.push(e), service: fakeService({ list: async () => { throw new Error('db at /Users/secret'); } }) }, async app => {
    const token = await app.pair();
    const response = await app.call('POST', '/v1/runs', { token, body: { gates: ['ok'] } });
    assert.equal(response.status, 500); assert.deepEqual(response.body, { error: 'Internal error' }); assert.equal(hidden.length, 1);
  });
  await using({}, async app => {
    const token = await app.pair();
    await writeFile(app.config, 'invalid: [');
    assert.equal((await app.call('GET', '/v1/gates', { token })).status, 500, 'a broken config is an error, not an empty answer');
  });
});

test('old finished jobs are dropped but running ones stay', async () => {
  let n = 0;
  await using({ service: fakeService({ run: async () => result({ runId: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` }) }), rateLimit: 1000 }, async app => {
    const token = await app.pair();
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      const started = await app.call('POST', '/v1/runs', { token, body: { gates: ['ok'] } });
      ids.push(started.body.jobId); await app.finished(token, started.body.jobId);
    }
    assert.equal((await app.call('GET', `/v1/jobs/${ids[0]}`, { token })).status, 404);
    assert.equal((await app.call('GET', `/v1/jobs/${ids.at(-1)}`, { token })).status, 200);
  });
});

test('the team view is shaped from the recorded runs and never carries gate output', async () => {
  await using({ gates: [{ id: 'ok', run: 'true' }, { id: 'bad', run: 'echo TOKEN=hunter2; false' }] }, async app => {
    const token = await app.pair();
    assert.equal((await app.call('GET', '/v1/team')).status, 401, 'a token is required');
    const empty = (await app.call('GET', '/v1/team', { token })).body;
    assert.equal(empty.current, null); assert.deepEqual(empty.runs, []);
    for (const gates of [['ok'], ['ok', 'bad']]) await app.finished(token, (await app.call('POST', '/v1/runs', { token, body: { gates } })).body.jobId);
    const team = (await app.call('GET', '/v1/team?limit=5', { token })).body;
    assert.equal(team.current.decision, 'BLOCK'); assert.equal(team.current.exitCode, 1);
    assert.deepEqual(team.blockingGates, ['bad']); assert.deepEqual(team.changes.regressions, []); assert.deepEqual(team.changes.newFailures, ['bad']);
    assert.equal(team.engineer[0].reproduce, 'qualitygate run --gate bad');
    assert.equal(team.runs.length, 2); assert.match(team.markdown, /^## QualityGate: BLOCK/);
    assert.ok(!JSON.stringify(team).includes('hunter2'), 'gate output stays out of the team view');
    assert.equal((await app.call('GET', '/v1/team?limit=0', { token })).status, 400);
    await writeFile(join(app.out, 'history.sqlite'), 'not a database');
    const degraded = (await app.call('GET', '/v1/team', { token })).body;
    assert.match(degraded.warnings[0], /Run history is unreadable/); assert.equal(degraded.current.decision, 'BLOCK');
  });
});

test('a failed job tells the client nothing about the cause; the detail goes to the server log', async () => {
  const logged: unknown[] = [];
  const jobs = new Jobs(error => logged.push(error));
  const job = jobs.start('run', ['ok'], () => Promise.reject(new Error('ENOENT /Users/someone/project/secret-path')));
  await job.done;
  assert.deepEqual(jobs.view(job).error, 'The run failed. See the bridge log for details.');
  assert.equal(JSON.stringify(jobs.view(job)).includes('secret-path'), false);
  assert.equal(logged.length, 1);
});
