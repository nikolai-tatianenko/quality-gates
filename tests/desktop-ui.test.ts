import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { Transport, HostEvent, TauriGlobal } from '../packages/desktop/src/ui/transport.js';
import type { HostState, Prompt } from '../packages/desktop/src/ui/Launcher.js';

const bootstrap = new JSDOM('<div id="root"></div>');
Object.assign(globalThis, { window: bootstrap.window, document: bootstrap.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: Launcher } = await import('../packages/desktop/src/ui/Launcher.js');
const { tauriTransport } = await import('../packages/desktop/src/ui/transport.js');

const idle: HostState = { recents: [], prefs: { notifications: false }, recovered: false, session: null };
const active: HostState = { ...idle, session: { mode: 'launched', name: 'app', path: '/p/app', port: 4101, dashboardUrl: 'http://127.0.0.1:5001/' } };
const prompt: Prompt = { promptId: 'p1', mode: 'launch', project: { path: '/p/app', name: 'app' }, permissions: ['Start the bridge', 'Serve the dashboard', 'Read verdicts'] };

function fakeTransport(handlers: Record<string, (params: unknown) => unknown>, picked: string | null = '/picked') {
  const calls: [string, unknown][] = []; let emit: (event: HostEvent) => void = () => undefined;
  const transport: Transport = {
    request: async (method, params) => { calls.push([method, params]); const handler = handlers[method]; if (!handler) throw new Error(`no ${method}`); return handler(params) as never; },
    onEvent: handler => { emit = handler; }, pickFolder: async () => { if (picked === 'throw') throw new Error('dialog failed'); return picked; },
  };
  return { transport, calls, emit: (event: HostEvent) => emit(event) };
}
async function open(transport: Transport, navigate: (url: string) => void = () => undefined) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'tauri://localhost/', pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = dom.window.document.getElementById('root')!, root = createRoot(container);
  await act(async () => { root.render(createElement(Launcher, { transport, navigate })); });
  const ui = {
    text: () => container.textContent ?? '',
    all: (id: string) => [...container.querySelectorAll<HTMLElement>(`[data-test-id="${id}"]`)],
    el: (id: string) => container.querySelector<HTMLElement>(`[data-test-id="${id}"]`),
    settle: async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 5)); }); },
    click: async (id: string, index = 0) => { const e = ui.all(id)[index]; assert.ok(e, `missing ${id}`); await act(async () => { e.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); }); await ui.settle(); },
    type: async (id: string, value: string) => { const e = ui.el(id) as HTMLInputElement; assert.ok(e, id);
      await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(e, value); e.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); },
    check: async (id: string) => { await act(async () => { ui.el(id)!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); }); await ui.settle(); },
    close: async () => { await act(async () => root.unmount()); dom.window.close(); },
  };
  await ui.settle();
  return ui;
}

test('first run: no projects, choose a folder, read the permissions, deny, then allow', async () => {
  const { transport, calls } = fakeTransport({ state: () => idle, 'project.prepare': () => prompt, 'project.start': () => active });
  const ui = await open(transport);
  try {
    assert.ok(ui.el('desktop-no-recents')); assert.equal(ui.el('desktop-permission'), null);
    assert.equal((ui.el('desktop-choose') as HTMLButtonElement).disabled, true, 'nothing to start without a path');
    await ui.type('desktop-path', '/p/app'); await ui.click('desktop-choose');
    assert.ok(ui.el('desktop-permission')); assert.match(ui.text(), /Allow QualityGate to use app/); assert.match(ui.text(), /Serve the dashboard/);
    assert.deepEqual(calls.at(-1), ['project.prepare', { path: '/p/app', mode: 'launch' }]);
    await ui.click('desktop-deny'); assert.equal(ui.el('desktop-permission'), null); assert.equal(calls.filter(c => c[0] === 'project.start').length, 0, 'denying starts nothing');
    await ui.click('desktop-choose'); await ui.click('desktop-allow');
    assert.deepEqual(calls.at(-1), ['project.start', { promptId: 'p1', accepted: true }]);
    assert.ok(ui.el('desktop-session')); assert.match(ui.text(), /bridge started by this app on 127\.0\.0\.1:4101/);
  } finally { await ui.close(); }
});

test('browse picks a folder through the native dialog and goes to the same permission prompt; a cancelled dialog does nothing', async () => {
  const picked = fakeTransport({ state: () => idle, 'project.prepare': () => prompt });
  let ui = await open(picked.transport);
  try { await ui.click('desktop-browse'); assert.deepEqual(picked.calls.at(-1), ['project.prepare', { path: '/picked', mode: 'launch' }]); assert.ok(ui.el('desktop-permission')); } finally { await ui.close(); }
  const cancelled = fakeTransport({ state: () => idle }, null);
  ui = await open(cancelled.transport);
  try { await ui.click('desktop-browse'); assert.equal(cancelled.calls.length, 1); assert.equal(ui.el('desktop-error'), null); } finally { await ui.close(); }
  const broken = fakeTransport({ state: () => idle }, 'throw');
  ui = await open(broken.transport);
  try { await ui.click('desktop-browse'); assert.match(ui.el('desktop-error')!.textContent!, /dialog failed/); } finally { await ui.close(); }
});

test('recent projects open or are forgotten; an unavailable one explains why and cannot be opened', async () => {
  const withRecents: HostState = { ...idle, recents: [{ path: '/p/a', name: 'a', lastOpened: '', available: true }, { path: '/p/b', name: 'b', lastOpened: '', available: false, reason: 'The folder does not exist.' }] };
  const { transport, calls } = fakeTransport({ state: () => withRecents, 'project.prepare': () => prompt, 'workspace.forget': () => idle });
  const ui = await open(transport);
  try {
    assert.equal(ui.all('desktop-recent').length, 2); assert.match(ui.text(), /The folder does not exist\./);
    assert.deepEqual(ui.all('desktop-recent-open').map(e => (e as HTMLButtonElement).disabled), [false, true]);
    await ui.click('desktop-recent-open', 0); assert.deepEqual(calls.at(-1), ['project.prepare', { path: '/p/a', mode: 'launch' }]);
    await ui.click('desktop-deny');
    await ui.click('desktop-recent-forget', 1); assert.deepEqual(calls.at(-1), ['workspace.forget', { path: '/p/b' }]); assert.ok(ui.el('desktop-no-recents'));
  } finally { await ui.close(); }
});

test('attaching passes the port and pairing code with the accepted prompt', async () => {
  const attach: Prompt = { ...prompt, mode: 'attach' };
  const { transport, calls } = fakeTransport({ state: () => idle, 'project.prepare': () => attach, 'project.start': () => ({ ...active, session: { ...active.session!, mode: 'attached' } }) });
  const ui = await open(transport);
  try {
    await ui.type('desktop-path', '/p/app'); assert.equal((ui.el('desktop-attach') as HTMLButtonElement).disabled, true);
    await ui.type('desktop-port', '4181'); await ui.type('desktop-code', 'K7QM-4TXD'); await ui.click('desktop-attach');
    assert.deepEqual(calls.at(-1), ['project.prepare', { path: '/p/app', mode: 'attach' }]);
    await ui.click('desktop-allow');
    assert.deepEqual(calls.at(-1), ['project.start', { promptId: 'p1', accepted: true, port: 4181, code: 'K7QM-4TXD' }]);
    assert.match(ui.text(), /attached to an existing bridge/);
  } finally { await ui.close(); }
});

test('an open project: dashboard, folders, last run evidence, stop; run and session events update the page', async () => {
  const navigated: string[] = [];
  const { transport, calls, emit } = fakeTransport({ state: () => active, 'open.folder': () => ({ opened: true }), 'project.stop': () => idle });
  const ui = await open(transport, url => navigated.push(url));
  try {
    assert.equal(ui.el('desktop-last-run'), null);
    await ui.click('desktop-open-dashboard'); assert.deepEqual(navigated, ['http://127.0.0.1:5001/']);
    await ui.click('desktop-open-reports'); assert.deepEqual(calls.at(-1), ['open.folder', { kind: 'reports' }]);
    await act(async () => emit({ event: 'run', runId: 'r1', decision: 'BLOCK', exitCode: 1 })); await ui.settle();
    assert.match(ui.el('desktop-last-run')!.textContent!, /BLOCK \(exit 1\)/);
    await ui.click('desktop-open-evidence'); assert.deepEqual(calls.at(-1), ['open.folder', { kind: 'run', runId: 'r1' }]);
    await act(async () => emit({ event: 'run', runId: 'r2', decision: 'PASS', exitCode: 0 })); await ui.settle();
    assert.match(ui.el('desktop-last-run')!.textContent!, /PASS \(exit 0\)/);
    await ui.click('desktop-stop'); assert.ok(ui.el('desktop-choose')); assert.equal(ui.el('desktop-last-run'), null);
    await act(async () => emit({ event: 'notify', title: 'ignored' })); await ui.settle();
  } finally { await ui.close(); }
});

test('a session that ended is shown with its reason; an unreachable host is an error, not a blank page', async () => {
  const { transport, emit } = fakeTransport({ state: () => idle });
  let ui = await open(transport);
  try { await act(async () => emit({ event: 'session', state: 'stopped', reason: 'down: gone' })); await ui.settle(); assert.match(ui.el('desktop-error')!.textContent!, /Connection ended: down: gone/); } finally { await ui.close(); }
  const quiet = fakeTransport({ state: () => idle });
  ui = await open(quiet.transport);
  try { await act(async () => quiet.emit({ event: 'session', state: 'stopped' })); await ui.settle(); assert.equal(ui.el('desktop-error'), null); } finally { await ui.close(); }
  let calls = 0;
  const flaky = fakeTransport({ state: () => { if (calls++ > 0) throw new Error('host gone'); return idle; } });
  ui = await open(flaky.transport);
  try { await act(async () => flaky.emit({ event: 'session', state: 'stopped' })); await ui.settle(); assert.equal(ui.el('desktop-error'), null, 'a failed refresh is swallowed'); } finally { await ui.close(); }
  ui = await open(fakeTransport({ state: () => { throw new Error('The desktop host did not answer in time.'); } }).transport);
  try { assert.match(ui.el('desktop-error')!.textContent!, /did not answer/); } finally { await ui.close(); }
  ui = await open(fakeTransport({ state: () => { throw 'plain failure'; } }).transport);
  try { assert.match(ui.el('desktop-error')!.textContent!, /plain failure/); } finally { await ui.close(); }
});

test('notifications are a checkbox that is off by default and reports the saved state; a damaged list is announced', async () => {
  const { transport, calls } = fakeTransport({ state: () => ({ ...idle, recovered: true }), 'prefs.set': () => ({ ...idle, prefs: { notifications: true } }) });
  const ui = await open(transport);
  try {
    assert.ok(ui.el('desktop-recovered'));
    assert.equal((ui.el('desktop-notifications') as HTMLInputElement).checked, false);
    await ui.check('desktop-notifications'); assert.deepEqual(calls.at(-1), ['prefs.set', { notifications: true }]);
    assert.equal((ui.el('desktop-notifications') as HTMLInputElement).checked, true);
  } finally { await ui.close(); }
});

test('accept and the default navigation do nothing sensible without a prompt or window', async () => {
  const { transport } = fakeTransport({ state: () => active });
  const ui = await open(transport, undefined);
  try { assert.ok(ui.el('desktop-open-dashboard')); } finally { await ui.close(); }
});

interface Line { id: number; method: string; params: unknown }
function fakeTauri(answers: (line: Line) => unknown | Promise<unknown>) {
  let handler: ((event: { payload: unknown }) => void) | undefined;
  const sent: Line[] = [];
  const tauri: TauriGlobal = {
    core: { invoke: async (command, args) => { assert.equal(command, 'host_send'); const line = JSON.parse(String(args.line)) as Line; sent.push(line); const answer = await answers(line); if (answer !== undefined) setImmediate(() => handler?.({ payload: JSON.stringify(answer) })); return undefined; } },
    event: { listen: async (_name, cb) => { handler = cb; return () => undefined; } },
    dialog: { open: async () => '/chosen' },
  };
  return { tauri, sent, push: (payload: unknown) => handler?.({ payload }) };
}

test('the Tauri transport matches replies to requests by id, forwards events and ignores noise', async () => {
  const { tauri, sent, push } = fakeTauri(line => ({ id: line.id, ok: true, result: { echoed: line.method } }));
  const transport = tauriTransport(tauri);
  const events: HostEvent[] = []; transport.onEvent(event => events.push(event));
  assert.deepEqual(await transport.request('state'), { echoed: 'state' });
  assert.deepEqual(await transport.request('prefs.set', { notifications: true }), { echoed: 'prefs.set' });
  assert.deepEqual(sent.map(line => [line.id, line.params]), [[1, {}], [2, { notifications: true }]]);
  push(JSON.stringify({ event: 'run', runId: 'r' })); push('not json'); push(JSON.stringify({ id: 99, ok: true })); push(JSON.stringify({ ok: true }));
  assert.deepEqual(events, [{ event: 'run', runId: 'r' }]);
  assert.equal(await transport.pickFolder(), '/chosen');
});

test('the Tauri transport reports host errors, send failures and silence, and tolerates a missing dialog', async () => {
  const { tauri } = fakeTauri(line => (line.method === 'bad' ? { id: line.id, ok: false, error: 'Invalid arguments.' } : line.method === 'odd' ? { id: line.id, ok: false } : undefined));
  const transport = tauriTransport(tauri, 30);
  await assert.rejects(transport.request('bad'), /Invalid arguments\./);
  await assert.rejects(transport.request('odd'), /Request failed\./);
  await assert.rejects(transport.request('silent'), /did not answer in time/);
  const failing: TauriGlobal = { ...tauri, core: { invoke: async () => { throw new Error('ipc down'); } } };
  await assert.rejects(tauriTransport(failing).request('state'), /ipc down/);
  const stringy: TauriGlobal = { ...tauri, core: { invoke: async () => Promise.reject('refused') } };
  await assert.rejects(tauriTransport(stringy).request('state'), /refused/);
  assert.equal(await tauriTransport({ ...tauri, dialog: undefined }).pickFolder(), null);
  assert.equal(await tauriTransport({ ...tauri, dialog: { open: async () => ['a'] } }).pickFolder(), null);
});

test('the page entry mounts the launcher using the Tauri global and asks the host for its state', async () => {
  const { tauri, sent } = fakeTauri(line => ({ id: line.id, ok: true, result: idle }));
  const dom = new JSDOM('<div id="root"></div>', { url: 'tauri://localhost/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, __TAURI__: tauri });
  try {
    await act(async () => { await import('../packages/desktop/src/ui/main.js'); });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 5)); });
    assert.deepEqual(sent.map(line => line.method), ['state']);
    assert.match(dom.window.document.body.textContent ?? '', /No projects yet/);
  } finally { delete (globalThis as { __TAURI__?: unknown }).__TAURI__; dom.window.close(); }
});
