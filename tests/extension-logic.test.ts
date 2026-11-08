import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, type BridgeService } from '../packages/bridge/src/index.js';
import { runResultSchema, type RunResult } from '../packages/protocol/src/index.js';
import { BridgeClient, BridgeError } from '../packages/chrome-extension/src/client.js';
import { checkTarget } from '../packages/chrome-extension/src/target.js';
import { loadSaved, saveSaved } from '../packages/chrome-extension/src/state.js';
import { scanPage, watchJob } from '../packages/chrome-extension/src/scan.js';
import type { FetchLike, Job, StorageArea } from '../packages/chrome-extension/src/types.js';

const EXT = `chrome-extension://${'a'.repeat(32)}`;
const RUN_ID = '11111111-1111-4111-8111-111111111111';

function memoryStorage(initial: Record<string, unknown> = {}): StorageArea & { data: Record<string, unknown> } {
  const data = { ...initial };
  return { data, get: async key => (key in data ? { [key]: data[key] } : {}), set: async items => { Object.assign(data, items); } };
}
const reply = (status: number, body: unknown): FetchLike => async () => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('checkTarget accepts only plain http(s) pages and explains every refusal', () => {
  const ok = checkTarget('https://example.com/a?b=1#frag');
  assert.ok(ok.ok); assert.equal(ok.url, 'https://example.com/a?b=1', 'the fragment is dropped'); assert.equal(ok.origin, 'https://example.com');
  assert.match(ok.notes.join(' '), /query string/);
  const local = checkTarget('http://localhost:3000/'); assert.ok(local.ok); assert.match(local.notes.join(' '), /local or private/);
  for (const host of ['127.0.0.1', '192.168.1.5', '10.0.0.2', '172.20.1.1', '169.254.169.254', '[::1]', 'app.localhost']) assert.match((checkTarget(`http://${host}/`) as { notes: string[] }).notes[0]!, /local or private/, host);
  assert.match((checkTarget('http://example.com') as { notes: string[] }).notes[0]!, /not served over HTTPS/);
  assert.deepEqual((checkTarget('https://example.com') as { notes: string[] }).notes, []);
  assert.match((checkTarget('http://172.32.0.1') as { notes: string[] }).notes[0]!, /HTTPS/, 'public 172.32 is not private');
  const refused = (url: string | undefined) => { const r = checkTarget(url); assert.equal(r.ok, false, String(url)); return (r as { reason: string }).reason; };
  assert.match(refused(undefined), /toolbar icon/); assert.match(refused(''), /toolbar icon/);
  assert.match(refused('not a url'), /no valid address/);
  for (const url of ['chrome://settings', 'chrome-extension://abc/popup.html', 'file:///etc/passwd', 'about:blank', 'javascript:alert(1)', 'data:text/html,hi', 'blob:https://x/1', 'view-source:https://x', 'ftp://x/']) assert.match(refused(url), /cannot be scanned/, url);
  assert.match(refused('https://user:pw@example.com/'), /username or password/); assert.match(refused('https://:pw@example.com/'), /username or password/);
  assert.match(refused('https://chromewebstore.google.com/detail/x'), /Web Store/); assert.match(refused('https://chrome.google.com/webstore/detail/x'), /Web Store/);
  assert.equal(checkTarget('https://chrome.google.com/other').ok, true);
});

test('BridgeClient maps every failure to a kind the popup can act on', async () => {
  const kind = async (fetch: FetchLike) => { try { await new BridgeClient(4180, 't', fetch).gates(); } catch (error) { assert.ok(error instanceof BridgeError); return error; } throw new Error('expected failure'); };
  const down = await kind(async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(down.kind, 'down'); assert.match(down.message, /127\.0\.0\.1:4180.*qualitygate bridge/);
  for (const [status, expected] of [[400, 'invalid'], [401, 'unauthorized'], [403, 'forbidden'], [404, 'not-found'], [409, 'conflict'], [413, 'invalid'], [415, 'invalid'], [429, 'rate-limited'], [500, 'server'], [503, 'server']] as const) {
    const error = await kind(reply(status, { error: `msg ${status}` }));
    assert.equal(error.kind, expected); assert.equal(error.message, `msg ${status}`); assert.equal(error.status, status);
  }
  assert.equal((await kind(reply(502, '<html>bad gateway</html>'))).message, 'HTTP 502', 'a non-JSON error body falls back to the status');
  assert.equal((await kind(reply(500, { error: 7 }))).message, 'HTTP 500');
});

test('BridgeClient sends the token and JSON only where needed, and encodes ids', async () => {
  const seen: { url: string; init?: Parameters<FetchLike>[1] }[] = [];
  const fetch: FetchLike = async (url, init) => { seen.push({ url, init }); return { status: 200, text: async () => JSON.stringify({ findings: [], artifacts: [], name: 'qualitygate-bridge', token: 'tok' }) }; };
  const client = new BridgeClient(5000, 'secret', fetch), anonymous = new BridgeClient(5000, undefined, fetch);
  await client.ping(); await anonymous.pair('K7QM-4TXD'); await client.findings('a/b'); await client.artifacts('x'); await client.job('j 1'); await client.cancel('j'); await client.run('r'); await client.revoke(); await client.startScan('https://e.com/'); await client.gates();
  assert.equal(seen[0]!.init?.headers?.Authorization, 'Bearer secret'); assert.equal(seen[0]!.init?.body, undefined); assert.equal(seen[0]!.init?.headers?.['Content-Type'], undefined);
  assert.equal(seen[1]!.init?.headers?.Authorization, undefined, 'pairing sends no token'); assert.deepEqual(JSON.parse(seen[1]!.init!.body!), { code: 'K7QM-4TXD', label: 'Chrome extension' });
  assert.equal(seen[2]!.url, 'http://127.0.0.1:5000/v1/runs/a%2Fb/findings'); assert.equal(seen[4]!.url, 'http://127.0.0.1:5000/v1/jobs/j%201');
  assert.ok(seen.every(call => call.url.startsWith('http://127.0.0.1:5000/')), 'only loopback is ever contacted');
  assert.equal((await anonymous.pair('x')), 'tok');
});

test('ping refuses a server that is not the QualityGate bridge', async () => {
  await assert.rejects(new BridgeClient(80, undefined, reply(200, { name: 'something-else' })).ping(), (e: BridgeError) => e.kind === 'server' && /does not answer like/.test(e.message));
  await assert.rejects(new BridgeClient(80, undefined, reply(200, 'not json')).ping(), (e: BridgeError) => e.kind === 'server');
});

test('saved state ignores anything malformed', async () => {
  assert.deepEqual(await loadSaved(memoryStorage()), { port: 4180 });
  assert.deepEqual(await loadSaved(memoryStorage({ qualitygate: { port: 99999, token: 5, lastJob: { jobId: 1, url: 'x' } } })), { port: 4180 });
  assert.deepEqual(await loadSaved(memoryStorage({ qualitygate: { port: 1.5, token: '' } })), { port: 4180 });
  assert.deepEqual(await loadSaved(memoryStorage({ qualitygate: 'junk' })), { port: 4180 });
  const area = memoryStorage();
  await saveSaved(area, { port: 4999, token: 't', lastJob: { jobId: 'j', url: 'https://e.com/' } });
  assert.deepEqual(await loadSaved(area), { port: 4999, token: 't', lastJob: { jobId: 'j', url: 'https://e.com/' } });
});

const job = (over: Partial<Job>): Job => ({ jobId: 'j1', kind: 'scan', status: 'running', exitCode: 0, ...over });
function scripted(jobs: Job[], extra: Partial<Record<'cancel' | 'run', unknown>> = {}) {
  const calls: string[] = []; let i = 0;
  const client = {
    job: async () => { calls.push('job'); return jobs[Math.min(++i, jobs.length - 1)]!; },
    cancel: async () => { calls.push('cancel'); if (extra.cancel === 'fail') throw new Error('409'); return job({ status: 'cancelling' }); },
    run: async (id: string) => { calls.push(`run:${id}`); return { runId: id, execution: 'completed', decision: 'BLOCK', exitCode: 1, errors: [], results: [] }; },
    findings: async () => [{ severity: 'error', message: 'm' }], artifacts: async () => [{ kind: 'audit', name: 'lh.json' }],
  };
  return { client: client as unknown as BridgeClient, calls };
}
const sleep = async () => undefined;

test('watchJob polls to the end and returns the bridge verdict unchanged', async () => {
  const { client, calls } = scripted([job({}), job({}), job({ status: 'finished', runId: RUN_ID, decision: 'BLOCK', exitCode: 1 })]);
  const seen: string[] = [];
  const outcome = await watchJob(client, job({}), { sleep, onJob: j => seen.push(j.status) });
  assert.equal(outcome.kind, 'done'); assert.ok(outcome.kind === 'done');
  assert.equal(outcome.run.decision, 'BLOCK', 'the decision is the stored run\'s own'); assert.deepEqual(outcome.artifacts, ['lh.json']); assert.equal(outcome.findings.length, 1);
  assert.deepEqual(seen, ['running', 'running', 'finished']); assert.deepEqual(calls.filter(c => c === 'job').length, 2);
});

test('watchJob reports failed jobs, jobs without a run and cancelled jobs', async () => {
  assert.equal((await watchJob(scripted([job({ status: 'error', exitCode: 2, error: 'Chrome missing' })]).client, job({ status: 'error', exitCode: 2, error: 'Chrome missing' }), { sleep })).kind, 'failed');
  assert.equal((await watchJob(scripted([]).client, job({ status: 'finished' }), { sleep })).kind, 'failed', 'finished without a run id is not success');
  assert.equal((await watchJob(scripted([]).client, job({ status: 'cancelled', exitCode: 130 }), { sleep })).kind, 'cancelled');
});

test('aborting cancels once on the bridge and waits for it to confirm', async () => {
  const controller = new AbortController(); controller.abort();
  const { client, calls } = scripted([job({}), job({ status: 'cancelled', exitCode: 130 })]);
  assert.equal((await watchJob(client, job({}), { sleep, signal: controller.signal })).kind, 'cancelled');
  assert.deepEqual(calls, ['cancel', 'job'], 'one cancel, then polling');
  const failing = scripted([job({}), job({ status: 'finished', runId: RUN_ID, exitCode: 0, decision: 'PASS' })], { cancel: 'fail' });
  assert.equal((await watchJob(failing.client, job({}), { sleep, signal: controller.signal })).kind, 'done', 'a job that ended before the cancel arrived keeps its real result');
});

test('watchJob uses real timers when none are injected', async () => {
  const { client } = scripted([job({ status: 'cancelled', exitCode: 130 })]);
  assert.equal((await watchJob(client, job({}), { intervalMs: 1 })).kind, 'cancelled');
  assert.equal((await watchJob(client, job({}), { intervalMs: 1 })).kind, 'cancelled');
});

test('against the real bridge: pair from an extension origin, scan, read the stored run, and a revoked token is 401', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-ext-'));
  const config = join(dir, '.qualitygate.yml');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, outputDir: 'out', gates: [{ id: 'ok', run: 'true' }], thresholds: { performance: 50, accessibility: 90, seo: 50, 'best-practices': 50 } }));
  const scanned: string[] = [];
  const scan = async (url: string): Promise<RunResult> => {
    scanned.push(url);
    const run = runResultSchema.parse({ schemaVersion: 1, runId: RUN_ID, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', execution: 'completed', decision: 'BLOCK', errors: [], gates: [],
      thresholds: { performance: 50, accessibility: 90, seo: 50, 'best-practices': 50 }, results: [{ url, execution: 'completed', decision: 'BLOCK', scores: { performance: 80, accessibility: 70 }, violations: ['accessibility 70 < 90'], errors: [], evidencePath: join(dir, 'out', RUN_ID, 'lh.json') }],
      findings: [{ gateId: 'lighthouse', severity: 'error', message: 'Buttons need names', ruleId: 'button-name', helpUrl: 'https://dequeuniversity.com/rules/axe/button-name' }] });
    await mkdir(join(dir, 'out', RUN_ID), { recursive: true });
    await writeFile(join(dir, 'out', RUN_ID, 'report.json'), JSON.stringify(run)); await writeFile(join(dir, 'out', RUN_ID, 'lh.json'), '{}');
    return run;
  };
  const service: BridgeService = { list: async () => ({ gates: [{ id: 'ok' }] }), run: async () => { throw new Error('unused'); }, scan, close: async () => undefined };
  const bridge = await createBridge({ configPath: config, service });
  try {
    await new Promise<void>(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
    const address = bridge.server.address(); assert.ok(address && typeof address !== 'string');
    // Node's fetch lets the test send the Origin header a Chrome extension page would send.
    const fetch: FetchLike = (url, init) => globalThis.fetch(url, { ...init, headers: { ...init?.headers, Origin: EXT } }).then(r => ({ status: r.status, text: () => r.text() }));
    const anonymous = new BridgeClient(address.port, undefined, fetch);
    await anonymous.ping();
    await assert.rejects(anonymous.pair('WRONG-CODE'), (e: BridgeError) => e.kind === 'unauthorized');
    const token = await anonymous.pair(bridge.issuePairingCode());
    const client = new BridgeClient(address.port, token, fetch);
    assert.equal((await client.gates()).scan.available, true);
    const outcome = await scanPage(client, 'https://example.com/page', { intervalMs: 10 });
    assert.ok(outcome.kind === 'done'); assert.deepEqual(scanned, ['https://example.com/page']);
    assert.equal(outcome.run.decision, 'BLOCK'); assert.equal(outcome.run.exitCode, 1); assert.equal(outcome.run.results[0]!.scores.accessibility, 70);
    assert.deepEqual(outcome.artifacts, ['lh.json']); assert.equal(outcome.findings[0]!.ruleId, 'button-name');
    assert.ok(!JSON.stringify(outcome).includes(dir), 'no local paths reach the extension');
    await client.revoke();
    await assert.rejects(client.gates(), (e: BridgeError) => e.kind === 'unauthorized');
    await assert.rejects(new BridgeClient(address.port, token, (u, i) => globalThis.fetch(u, { ...i, headers: { ...i?.headers, Origin: 'https://evil.example' } }).then(r => ({ status: r.status, text: () => r.text() }))).gates(), (e: BridgeError) => e.kind === 'forbidden');
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
});
