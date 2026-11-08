import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App, request } from '../packages/dashboard/src/App.js';
import { runResultSchema } from '../packages/protocol/src/index.js';

const project = { configPath: '/project/.qualitygate.yml', gates: [{ id: 'lint', type: 'eslint', run: 'lint' }], urls: ['http://fixture'] };
const blocked = runResultSchema.parse({ schemaVersion: 1, runId: 'fixture', startedAt: '2026-10-30T20:00:00.000Z', finishedAt: '2026-10-30T20:00:02.500Z',
  execution: 'error', decision: 'BLOCK', errors: ['disk failure'], reportPath: '/evidence/report.json',
  gates: [{ id: 'lint', command: 'lint', execution: 'completed', decision: 'BLOCK', exitCode: 1, durationMs: 12, outputTail: 'lint output', errors: ['tool failed'] }],
  results: [{ url: 'http://fixture', execution: 'completed', decision: 'BLOCK', scores: {}, violations: ['metric missing'], errors: ['audit failed'] }],
  findings: [{ gateId: 'lint', severity: 'error', message: 'too complex', file: 'src/a.ts', line: 3, ruleId: 'complexity', evidencePath: '/evidence/lint.json' },
    { gateId: 'lint', severity: 'warning', message: 'generic warning' }] });
function environment() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1:4173', pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = dom.window.document.getElementById('root')!;
  const root = createRoot(container);
  return { dom, container, root, cleanup: async () => { await act(async () => root.unmount()); dom.window.close(); } };
}
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
async function click(ui: ReturnType<typeof environment>, label: string) {
  const button = [...ui.container.querySelectorAll('button')].find(b => b.textContent?.includes(label)); assert.ok(button);
  await act(async () => { button.dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true })); });
}
test('React dashboard renders project checks and real findings, runs and cancels through the local API', async () => {
  const ui = environment(); let finish!: (response: Response) => void;
  const fetch = mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    if (path === '/api/project') return response(project);
    if (path === '/api/cancel') return response({ cancelled: true });
    if (init.method === 'POST') return new Promise<Response>(resolve => { finish = resolve; });
    return response(null);
  });
  try {
    await act(async () => { ui.root.render(createElement(App)); });
    assert.match(ui.container.textContent!, /NO RUN/); assert.match(ui.container.textContent!, /lint/);
    await click(ui, 'Run quality'); assert.match(ui.container.textContent!, /Running checks/);
    await click(ui, 'Cancel run');
    await act(async () => { finish(response(blocked)); });
    assert.equal(ui.container.querySelector('.metrics strong')!.textContent, 'ERROR');
    assert.equal(ui.container.querySelector('.metrics article:last-child strong')!.textContent, '2.5s');
    assert.match(ui.container.textContent!, /BLOCK/); assert.match(ui.container.textContent!, /src\/a.ts:3/);
    assert.match(ui.container.textContent!, /complexity/); assert.match(ui.container.textContent!, /disk failure/);
    assert.match(ui.container.textContent!, /lint output/); assert.ok(ui.container.querySelector('a[download]'));
    assert.ok(fetch.mock.calls.some(c => c.arguments[0] === '/api/cancel'));
  } finally { await ui.cleanup(); fetch.mock.restore(); }
});
test('React dashboard handles empty findings, absent evidence, API errors and unmount during loading', async () => {
  for (const mode of ['pass', 'block', 'load-error', 'run-error', 'cancel-error', 'run-http-error', 'cancel-http-error', 'unmount', 'unmount-error'] as const) {
    const ui = environment(); let finish!: (response: Response) => void;
    const loading: (() => void)[] = [];
    const saved = { ...blocked, execution: 'completed', decision: mode === 'pass' ? 'PASS' : 'BLOCK', findings: [], errors: [], gates: [], results: [], reportPath: undefined };
    const fetch = mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
      if (path === '/api/team') return response(null);
      if (mode === 'load-error') return response({ error: 'Cannot load project' }, 500);
      if (mode === 'unmount' || mode === 'unmount-error') return new Promise<Response>((resolve, reject) => {
        loading.push(() => mode === 'unmount-error' ? reject(Error('late error')) : resolve(response(path === '/api/project' ? project : null)));
      });
      if (path === '/api/project') return response(project);
      if (path === '/api/cancel') {
        if (mode === 'cancel-http-error') return response({ error: 'server unavailable' }, 503);
        throw 'cancel unavailable';
      }
      if (init.method === 'POST') {
        if (mode === 'run-error') throw 'network unavailable';
        if (mode === 'run-http-error') return response({ error: 'server unavailable' }, 503);
        if (mode === 'cancel-error' || mode === 'cancel-http-error') return new Promise<Response>(resolve => { finish = resolve; });
      }
      return response(saved);
    });
    try {
      await act(async () => { ui.root.render(createElement(App)); });
      if (mode === 'load-error') assert.match(ui.container.textContent!, /Cannot load project/);
      else if (mode === 'unmount' || mode === 'unmount-error') {
        await act(async () => { ui.root.unmount(); loading.forEach(finish => finish()); });
      } else if (mode === 'run-error' || mode === 'run-http-error') {
        await click(ui, 'Run quality'); assert.match(ui.container.textContent!, mode === 'run-error' ? /network unavailable/ : /server unavailable/);
      } else if (mode === 'cancel-error' || mode === 'cancel-http-error') {
        await click(ui, 'Run quality'); await click(ui, 'Cancel');
        assert.match(ui.container.textContent!, mode === 'cancel-error' ? /cancel unavailable/ : /server unavailable/);
        await act(async () => { finish(response(saved)); });
      } else {
        assert.match(ui.container.textContent!, mode === 'pass' ? /All configured gates passed/ : /A gate blocked/);
        assert.match(ui.container.textContent!, /Report could not be saved/);
      }
    } finally { await ui.cleanup(); fetch.mock.restore(); }
  }
  const fetch = mock.method(globalThis, 'fetch', async () => response({ error: 'API failed' }, 500));
  try { await assert.rejects(request('/api/run'), /API failed/); } finally { fetch.mock.restore(); }
});
test('browser entry mounts the React application', async () => {
  const ui = environment();
  await act(async () => ui.root.unmount());
  const fetch = mock.method(globalThis, 'fetch', async (path: string) => response(path === '/api/project' ? project : null));
  let root: ReturnType<typeof createRoot> | undefined;
  try {
    await act(async () => { ({ root } = await import('../packages/dashboard/src/main.js')); });
    assert.match(ui.container.textContent!, /Quality overview/);
  } finally { await act(async () => root?.unmount()); ui.dom.window.close(); fetch.mock.restore(); }
});

test('appearance follows the OS, persists explicit themes, ignores invalid preferences and tolerates blocked storage', async () => {
  const { readTheme, initializeTheme, themeStorageKey } = await import('../packages/dashboard/src/appearance.js');
  const { ThemeSwitcher } = await import('../packages/dashboard/src/theme.js');
  const ui = environment();
  const media = Object.assign(new ui.dom.window.EventTarget(), { matches: true });
  Object.defineProperty(ui.dom.window, 'matchMedia', { value: () => media });
  try {
    ui.dom.window.localStorage.setItem(themeStorageKey, 'invalid'); assert.equal(readTheme(), 'system');
    initializeTheme(); assert.equal(ui.dom.window.document.documentElement.dataset.theme, 'dark');
    await act(async () => ui.root.render(createElement(ThemeSwitcher)));
    assert.equal(ui.container.querySelector('[aria-label="Use system theme"]')!.getAttribute('aria-pressed'), 'true');
    await act(async () => { media.matches = false; media.dispatchEvent(new ui.dom.window.Event('change')); });
    assert.equal(ui.dom.window.document.documentElement.dataset.theme, 'light');
    await click(ui, 'Dark'); assert.equal(ui.dom.window.localStorage.getItem(themeStorageKey), 'dark');
    await act(async () => media.dispatchEvent(new ui.dom.window.Event('change')));
    assert.equal(ui.dom.window.document.documentElement.dataset.theme, 'dark', 'An explicit mode overrides the OS');
    initializeTheme(); assert.equal(ui.dom.window.document.documentElement.dataset.theme, 'dark', 'Initialization restores the saved choice');
    await click(ui, 'Light'); assert.equal(ui.dom.window.document.documentElement.dataset.theme, 'light');
    await click(ui, 'Auto'); assert.equal(ui.dom.window.document.documentElement.dataset.theme, 'light');
    const get = mock.method(ui.dom.window.Storage.prototype, 'getItem', () => { throw Error('Storage disabled'); });
    const set = mock.method(ui.dom.window.Storage.prototype, 'setItem', () => { throw Error('Storage disabled'); });
    try { assert.equal(readTheme(), 'system'); await click(ui, 'Dark'); assert.equal(ui.dom.window.document.documentElement.dataset.theme, 'dark'); }
    finally { get.mock.restore(); set.mock.restore(); }
    // The standalone, CSP-compatible bootstrap runs before the stylesheet/React bundle.
    await import('../packages/dashboard/src/theme-init.js');
  } finally { await ui.cleanup(); }
  const fallback = environment();
  try { initializeTheme(); assert.equal(fallback.dom.window.document.documentElement.dataset.theme, 'light'); }
  finally { await fallback.cleanup(); }
});
test('React dashboard hides the run button for a read-only shared project', async () => {
  const ui = environment();
  const fetch = mock.method(globalThis, 'fetch', async (path: string) => response(path === '/api/project' ? { ...project, readOnly: true } : null));
  try {
    await act(async () => { ui.root.render(createElement(App)); });
    assert.match(ui.container.textContent!, /lint/); assert.equal(ui.container.querySelector('.run-checks'), null);
  } finally { await ui.cleanup(); fetch.mock.restore(); }
});
