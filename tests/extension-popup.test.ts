import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { Actions, Model } from '../packages/chrome-extension/src/Popup.js';
import type { ChromeApi, FetchLike, StorageArea } from '../packages/chrome-extension/src/types.js';

// React DOM decides at import time whether `input` events exist, so a DOM must exist before it is loaded.
const bootstrap = new JSDOM('<div id="root"></div>');
Object.assign(globalThis, { window: bootstrap.window, document: bootstrap.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: Popup, PopupView, DASHBOARD_URL } = await import('../packages/chrome-extension/src/Popup.js');
const RUN_ID = '11111111-1111-4111-8111-111111111111';
type Handler = (body: unknown) => [number, unknown];
interface Fake { routes: Record<string, Handler>; calls: string[]; bodies: Record<string, unknown[]> }

function fakeBridge(overrides: Record<string, Handler | 'down'> = {}) {
  const bridge: Fake = { calls: [], bodies: {}, routes: {
    'GET /v1/ping': () => [200, { name: 'qualitygate-bridge', apiVersion: 1 }],
    'POST /v1/pair': () => [200, { token: 'tok-1' }],
    'DELETE /v1/token': () => [200, { revoked: true }],
    'GET /v1/gates': () => [200, { gates: [{ id: 'lint', type: 'eslint' }], scan: { available: true, thresholds: { accessibility: 90 } } }],
    'POST /v1/scans': () => [202, { jobId: 'job-1', kind: 'scan', status: 'running', exitCode: 0 }],
    'GET /v1/jobs/job-1': () => [200, { jobId: 'job-1', kind: 'scan', status: 'finished', runId: RUN_ID, decision: 'BLOCK', exitCode: 1 }],
    'POST /v1/jobs/job-1/cancel': () => [202, { jobId: 'job-1', kind: 'scan', status: 'cancelling', exitCode: 0 }],
    [`GET /v1/runs/${RUN_ID}`]: () => [200, { runId: RUN_ID, execution: 'completed', decision: 'BLOCK', exitCode: 1, thresholds: { accessibility: 90 }, errors: ['run note'],
      results: [{ url: 'https://example.com/', execution: 'completed', decision: 'BLOCK', scores: { accessibility: 70, performance: 88 }, violations: ['accessibility 70 < 90'], errors: ['audit note'] }] }],
    [`GET /v1/runs/${RUN_ID}/findings`]: () => [200, { findings: [{ severity: 'error', message: 'Buttons need names', ruleId: 'button-name', helpUrl: 'https://dequeuniversity.com/x' }, { severity: 'warning', message: 'plain' }] }],
    [`GET /v1/runs/${RUN_ID}/artifacts`]: () => [200, { artifacts: [{ kind: 'audit', source: 'https://example.com/', name: 'lh.json' }] }],
  } };
  for (const [key, value] of Object.entries(overrides)) bridge.routes[key] = value === 'down' ? (() => { throw new TypeError('down'); }) : value;
  const fetch: FetchLike = async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
    bridge.calls.push(key); (bridge.bodies[key] ??= []).push(init?.body ? JSON.parse(init.body) : undefined);
    const handler = bridge.routes[key]; if (!handler) return { status: 404, text: async () => JSON.stringify({ error: 'Unknown' }) };
    const [status, body] = handler(init?.body ? JSON.parse(init.body) : undefined);
    return { status, text: async () => JSON.stringify(body) };
  };
  return { bridge, fetch };
}
function storage(initial: Record<string, unknown> = {}): StorageArea & { data: Record<string, unknown> } {
  const data = { ...initial };
  return { data, get: async key => (key in data ? { [key]: data[key] } : {}), set: async items => { Object.assign(data, items); } };
}
const paired = (extra: object = {}) => storage({ qualitygate: { port: 4180, token: 'tok-0', ...extra } });
const chromeWith = (area: StorageArea, url: string | null = 'https://example.com/'): ChromeApi => ({ storage: { local: area }, tabs: { query: async () => (url === null ? [] : [{ url }]) } });

async function open(fetch: FetchLike, chromeApi: ChromeApi) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/popup.html', pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = dom.window.document.getElementById('root')!, root = createRoot(container);
  await act(async () => { root.render(createElement(Popup, { chromeApi, fetchImpl: fetch, intervalMs: 1 })); });
  const ui = {
    container, text: () => container.textContent ?? '',
    el: (id: string) => container.querySelector<HTMLElement>(`[data-test-id="${id}"]`),
    settle: async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 5)); }); },
    click: async (id: string) => { const e = ui.el(id); assert.ok(e, `missing ${id}`); await act(async () => { e.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); }); await ui.settle(); },
    type: async (id: string, value: string) => { const e = ui.el(id) as HTMLInputElement; assert.ok(e, id);
      await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(e, value); e.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); },
    submit: async () => { await act(async () => { container.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); }); await ui.settle(); },
    close: async () => { await act(async () => root.unmount()); dom.window.close(); },
  };
  await ui.settle();
  return ui;
}

test('first run with no bridge on the default port still shows the pairing form, so the port can be set', async () => {
  const { bridge, fetch } = fakeBridge({ 'GET /v1/ping': 'down' });
  const ui = await open(fetch, chromeWith(storage()));
  try { assert.ok(ui.el('code')); assert.ok(ui.el('port')); assert.deepEqual(bridge.calls, [], 'nothing is contacted before the person pairs'); } finally { await ui.close(); }
});

test('first run: pairing screen validates input, pairs, remembers the token and shows the page to scan', async () => {
  const { bridge, fetch } = fakeBridge(); const area = storage(); const ui = await open(fetch, chromeWith(area));
  try {
    assert.ok(ui.el('code')); assert.equal(ui.el('unpair'), null, 'nothing to unpair yet');
    await ui.submit(); assert.match(ui.el('notice')!.textContent!, /Pairing code/);
    await ui.type('code', 'K7QM-4TXD'); await ui.type('port', 'abc'); await ui.submit(); assert.match(ui.el('notice')!.textContent!, /1-65535/);
    await ui.type('port', '4999'); await ui.submit();
    assert.deepEqual(bridge.bodies['POST /v1/pair'], [{ code: 'K7QM-4TXD', label: 'Chrome extension' }]);
    assert.deepEqual(area.data.qualitygate, { port: 4999, token: 'tok-1' });
    assert.equal(ui.el('target-url')!.textContent, 'https://example.com/');
    assert.ok(ui.el('unpair'));
  } finally { await ui.close(); }
});

test('a wrong pairing code keeps the pairing screen with the bridge message and the typed port', async () => {
  const { fetch } = fakeBridge({ 'POST /v1/pair': () => [401, { error: 'Invalid or expired pairing code' }] });
  const ui = await open(fetch, chromeWith(storage()));
  try { await ui.type('code', 'NOPE'); await ui.type('port', '4500'); await ui.submit();
    assert.match(ui.text(), /Invalid or expired pairing code/); assert.doesNotMatch(ui.text(), /no longer valid/); assert.ok(ui.el('code')); assert.equal((ui.el('port') as HTMLInputElement).value, '4500'); }
  finally { await ui.close(); }
});

test('pairing while the bridge is unreachable stays on the pairing screen so the port can be fixed', async () => {
  const { fetch } = fakeBridge({ 'POST /v1/pair': 'down' });
  const ui = await open(fetch, chromeWith(storage()));
  try { await ui.type('code', 'K7QM-4TXD'); await ui.submit(); assert.match(ui.el('notice')!.textContent!, /not reachable/); assert.ok(ui.el('code')); }
  finally { await ui.close(); }
});

test('bridge down at start shows how to start it, and Try again recovers', async () => {
  const flaky = fakeBridge({ 'GET /v1/ping': 'down' });
  const ui = await open(flaky.fetch, chromeWith(paired()));
  try {
    assert.match(ui.text(), /Bridge not reachable/); assert.match(ui.el('notice')!.textContent!, /qualitygate bridge/);
    assert.ok(ui.el('unpair'), 'a paired person can switch to another port by unpairing');
    flaky.bridge.routes['GET /v1/ping'] = () => [200, { name: 'qualitygate-bridge' }];
    await ui.click('retry'); assert.ok(ui.el('target-url'));
  } finally { await ui.close(); }
});

test('a revoked or expired token returns to pairing and the dead token is removed from storage', async () => {
  const { fetch } = fakeBridge({ 'GET /v1/gates': () => [401, { error: 'Unauthorized' }] }); const area = paired();
  const ui = await open(fetch, chromeWith(area));
  try { assert.match(ui.el('notice')!.textContent!, /no longer valid/); assert.ok(ui.el('code')); assert.deepEqual(area.data.qualitygate, { port: 4180 }); }
  finally { await ui.close(); }
});

test('a bridge that refuses this extension (403) is reported, not retried as success', async () => {
  const { fetch } = fakeBridge({ 'GET /v1/gates': () => [403, { error: 'Origin not allowed' }] });
  const ui = await open(fetch, chromeWith(paired()));
  try { assert.match(ui.el('notice')!.textContent!, /Origin not allowed/); assert.ok(ui.el('retry')); } finally { await ui.close(); }
});

test('pages that cannot be scanned offer no scan and need no consent', async () => {
  for (const url of ['chrome://settings', null, 'file:///etc/hosts']) {
    const { bridge, fetch } = fakeBridge(); const ui = await open(fetch, chromeWith(paired(), url));
    try { assert.ok(ui.el('target-refused')); assert.equal(ui.el('scan'), null); assert.equal(ui.el('consent'), null); assert.ok(!bridge.calls.includes('POST /v1/scans')); }
    finally { await ui.close(); }
  }
});

test('a project without Lighthouse thresholds explains why scanning is unavailable', async () => {
  const { fetch } = fakeBridge({ 'GET /v1/gates': () => [200, { gates: [], scan: { available: false } }] });
  const ui = await open(fetch, chromeWith(paired()));
  try { assert.match(ui.el('no-scan')!.textContent!, /no Lighthouse thresholds/); assert.equal(ui.el('scan'), null); } finally { await ui.close(); }
});

test('no scan starts without explicit consent for the shown origin; consent is per scan', async () => {
  const { bridge, fetch } = fakeBridge(); const area = paired(); const ui = await open(fetch, chromeWith(area));
  try {
    assert.equal((ui.el('scan') as HTMLButtonElement).disabled, true); assert.match(ui.text(), /https:\/\/example\.com\)/);
    await ui.click('scan'); assert.ok(!bridge.calls.includes('POST /v1/scans'), 'a disabled scan button starts nothing');
    await ui.click('consent'); assert.equal((ui.el('scan') as HTMLButtonElement).disabled, false);
    await ui.click('scan');
    assert.deepEqual(bridge.bodies['POST /v1/scans'], [{ url: 'https://example.com/' }]);
    assert.equal(ui.el('verdict')!.textContent, 'BLOCK exit code 1', 'the verdict is the bridge\'s, with its exit code');
    assert.equal(ui.el('run-id')!.textContent, RUN_ID);
    assert.equal(ui.el('open-dashboard')!.getAttribute('href'), DASHBOARD_URL);
    assert.match(ui.el('scores')!.textContent!, /Accessibility70 · minimum 90/); assert.match(ui.el('scores')!.textContent!, /SEOnot measured/);
    assert.match(ui.el('violations')!.textContent!, /accessibility 70 < 90.*audit note.*run note/);
    assert.match(ui.el('findings')!.textContent!, /Buttons need names.*button-name.*docs/); assert.match(ui.text(), /lh\.json/);
    assert.deepEqual((area.data.qualitygate as { lastJob: unknown }).lastJob, { jobId: 'job-1', url: 'https://example.com/' });
    await ui.click('new-scan'); assert.equal((ui.el('consent') as HTMLInputElement).checked, false, 'consent does not carry over');
    assert.equal((area.data.qualitygate as { lastJob?: unknown }).lastJob, undefined);
  } finally { await ui.close(); }
});

test('reopening the popup resumes a scan that finished (or is still running) in the meantime', async () => {
  const { fetch } = fakeBridge(); const area = paired({ lastJob: { jobId: 'job-1', url: 'https://example.com/' } });
  const ui = await open(fetch, chromeWith(area, 'https://other.example/'));
  try { assert.equal(ui.el('verdict')!.textContent, 'BLOCK exit code 1'); } finally { await ui.close(); }
  const forgotten = fakeBridge({ 'GET /v1/jobs/job-1': () => [404, { error: 'Unknown job' }] }); const area2 = paired({ lastJob: { jobId: 'job-1', url: 'https://example.com/' } });
  const again = await open(forgotten.fetch, chromeWith(area2));
  try { assert.ok(again.el('consent')); assert.equal((area2.data.qualitygate as { lastJob?: unknown }).lastJob, undefined, 'a job the bridge forgot is dropped'); } finally { await again.close(); }
  const broken = fakeBridge({ 'GET /v1/jobs/job-1': () => [500, { error: 'Internal error' }] });
  const third = await open(broken.fetch, chromeWith(paired({ lastJob: { jobId: 'job-1', url: 'https://example.com/' } })));
  try { assert.match(third.el('notice')!.textContent!, /Internal error/); } finally { await third.close(); }
});

test('cancel stops the scan on the bridge and says it was cancelled', async () => {
  let cancelled = false;
  const { bridge, fetch } = fakeBridge({
    'GET /v1/jobs/job-1': () => [200, { jobId: 'job-1', kind: 'scan', status: cancelled ? 'cancelled' : 'running', exitCode: cancelled ? 130 : 0 }],
    'POST /v1/jobs/job-1/cancel': () => { cancelled = true; return [202, { jobId: 'job-1', kind: 'scan', status: 'cancelling', exitCode: 0 }]; },
  });
  const ui = await open(fetch, chromeWith(paired()));
  try {
    await ui.click('consent'); await act(async () => { ui.el('scan')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    await act(async () => { await new Promise(r => setTimeout(r, 3)); });
    assert.match(ui.el('scanning')!.textContent!, /Scanning https:\/\/example\.com\//);
    await ui.click('cancel'); await ui.settle();
    assert.ok(bridge.calls.includes('POST /v1/jobs/job-1/cancel')); assert.match(ui.el('outcome-note')!.textContent!, /cancelled/);
    await ui.click('new-scan'); assert.ok(ui.el('scan'));
  } finally { await ui.close(); }
});

test('a scan that errors on the bridge is shown as failed, never as a pass', async () => {
  const { fetch } = fakeBridge({ 'GET /v1/jobs/job-1': () => [200, { jobId: 'job-1', kind: 'scan', status: 'error', exitCode: 2, error: 'Chrome could not start' }] });
  const ui = await open(fetch, chromeWith(paired(), 'http://localhost:3000/'));
  try { assert.match(ui.text(), /local or private/); await ui.click('consent'); await ui.click('scan');
    assert.match(ui.el('outcome-note')!.textContent!, /Chrome could not start/); assert.equal(ui.el('verdict'), null); }
  finally { await ui.close(); }
});

test('scan start failures: busy, revoked during the scan and bridge lost', async () => {
  const busy = fakeBridge({ 'POST /v1/scans': () => [409, { error: 'A run is already active' }] });
  let ui = await open(busy.fetch, chromeWith(paired()));
  try { await ui.click('consent'); await ui.click('scan'); assert.match(ui.el('notice')!.textContent!, /already active/); assert.ok(ui.el('scan'), 'the person can retry'); } finally { await ui.close(); }
  const revoked = fakeBridge({ 'POST /v1/scans': () => [401, { error: 'Unauthorized' }] }); const area = paired();
  ui = await open(revoked.fetch, chromeWith(area));
  try { await ui.click('consent'); await ui.click('scan'); assert.ok(ui.el('code')); assert.deepEqual(area.data.qualitygate, { port: 4180 }); } finally { await ui.close(); }
  const lost = fakeBridge({ 'POST /v1/scans': 'down' });
  ui = await open(lost.fetch, chromeWith(paired()));
  try { await ui.click('consent'); await ui.click('scan'); assert.match(ui.text(), /Bridge not reachable/); } finally { await ui.close(); }
  const dies = fakeBridge({ [`GET /v1/runs/${RUN_ID}`]: () => [500, { error: 'Internal error' }] });
  ui = await open(dies.fetch, chromeWith(paired()));
  try { await ui.click('consent'); await ui.click('scan'); assert.match(ui.el('notice')!.textContent!, /Internal error/); } finally { await ui.close(); }
});

test('unpair revokes on the bridge, or locally when the bridge is gone', async () => {
  const { bridge, fetch } = fakeBridge(); const area = paired();
  let ui = await open(fetch, chromeWith(area));
  try { await ui.click('unpair'); assert.ok(bridge.calls.includes('DELETE /v1/token')); assert.deepEqual(area.data.qualitygate, { port: 4180 }); assert.ok(ui.el('code')); } finally { await ui.close(); }
  const gone = fakeBridge(); const area2 = paired();
  ui = await open(gone.fetch, chromeWith(area2));
  try { gone.bridge.routes['DELETE /v1/token'] = () => { throw new TypeError('down'); }; await ui.click('unpair'); assert.deepEqual(area2.data.qualitygate, { port: 4180 }); } finally { await ui.close(); }
});

test('the result view shows empty states, truncates long finding lists and never invents a verdict', async () => {
  const dom = new JSDOM('<div id="root"></div>'); Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const noop = () => undefined; const actions: Actions = { onPair: noop, onRetry: noop, onConsent: noop, onScan: noop, onCancel: noop, onUnpair: noop, onNewScan: noop };
  const job = { jobId: 'j', kind: 'scan', status: 'finished' as const, exitCode: 0, runId: RUN_ID };
  const many = Array.from({ length: 12 }, (_, i) => ({ severity: 'info' as const, message: `finding ${i}` }));
  const render = async (model: Model) => { const root = createRoot(dom.window.document.getElementById('root')!); await act(async () => root.render(createElement(PopupView, { model, actions }))); const text = dom.window.document.body.textContent!; await act(async () => root.unmount()); return text; };
  const pass = await render({ phase: 'result', port: 4180, busy: false, consent: false, outcome: { kind: 'done', job, findings: [], artifacts: [], run: { runId: RUN_ID, execution: 'completed', decision: 'PASS', exitCode: 0, errors: [], results: [] } } });
  assert.match(pass, /PASS/); assert.match(pass, /No findings reported/); assert.doesNotMatch(pass, /Why it was blocked/);
  const long = await render({ phase: 'result', port: 4180, busy: false, consent: false, outcome: { kind: 'done', job, findings: many, artifacts: [], run: { runId: RUN_ID, execution: 'completed', decision: 'PASS', exitCode: 0, errors: [], results: [] } } });
  assert.match(long, /finding 9/); assert.doesNotMatch(long, /finding 10/); assert.match(long, /\+2/);
  assert.match(await render({ phase: 'result', port: 4180, busy: false, consent: false, outcome: { kind: 'failed', job: { ...job, status: 'error', error: undefined } } }), /unknown error/);
  assert.match(await render({ phase: 'scanning', port: 4180, busy: false, consent: false }), /Scanning/);
  dom.window.close();
});

test('the popup entry mounts into #root using the extension\'s own chrome object and the platform fetch', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/popup.html' });
  const requests: string[] = [];
  const original = globalThis.fetch;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, chrome: chromeWith(paired()),
    fetch: async (url: string) => { requests.push(url); return url.endsWith('/v1/ping') ? new Response(JSON.stringify({ name: 'qualitygate-bridge' }), { status: 200 }) : new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }); } });
  try {
    await act(async () => { await import('../packages/chrome-extension/src/main.js'); });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 5)); });
    assert.deepEqual(requests, ['http://127.0.0.1:4180/v1/ping', 'http://127.0.0.1:4180/v1/gates']);
    assert.ok(dom.window.document.querySelector('[data-test-id="pair"]'), 'a rejected token sends the person back to pairing');
  } finally { globalThis.fetch = original; delete (globalThis as { chrome?: unknown }).chrome; dom.window.close(); }
});
