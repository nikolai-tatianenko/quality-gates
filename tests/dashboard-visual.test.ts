import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../packages/dashboard/src/App.js';
import { imageUrl, moveSlider, percent, sortItems, VisualSection, type Visual, type VisualItem } from '../packages/dashboard/src/Visual.js';

function environment() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1:4173', pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = dom.window.document.getElementById('root')!;
  const root = createRoot(container);
  return { dom, container, root, cleanup: async () => { await act(async () => root.unmount()); dom.window.close(); } };
}
type Ui = ReturnType<typeof environment>;
const item = (name: string, status: VisualItem['status'], over: Partial<VisualItem> = {}): VisualItem => ({ name, status, width: 800, height: 600, diffPixels: status === 'changed' ? 480 : 0,
  diffRatio: status === 'changed' ? 0.001 : 0, threshold: 0.1,
  images: { approved: status !== 'new', current: status !== 'missing', diff: status === 'changed' }, ...over });
const visual = (items: VisualItem[]): Visual => ({ enabled: true, runId: '44444444-4444-4444-8444-444444444444', gateId: 'visual', baselineDir: 'qualitygate-visual/approved', items });
const all = visual([item('about', 'match'), item('home', 'changed'), item('fresh', 'new'), item('gone', 'missing')]);
const $ = (ui: Ui, testId: string) => ui.container.querySelector(`[data-test-id="${testId}"]`) as HTMLElement | null;
const byId = (ui: Ui, testId: string) => { const element = $(ui, testId); assert.ok(element, testId); return element; };
async function click(ui: Ui, testId: string) { await act(async () => { byId(ui, testId).dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true })); }); }
async function pointer(ui: Ui, target: HTMLElement, type: string, clientX = 0) {
  const event = new ui.dom.window.Event(type, { bubbles: true }); Object.assign(event, { clientX, pointerId: 1 });
  await act(async () => { target.dispatchEvent(event); });
}
async function key(ui: Ui, target: HTMLElement, name: string, shiftKey = false) {
  await act(async () => { target.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true })); });
}
async function render(ui: Ui, value: Visual) { await act(async () => { ui.root.render(createElement(VisualSection, { visual: value })); }); }
const now = (ui: Ui) => Number(byId(ui, 'visual-slider').getAttribute('aria-valuenow'));

test('helpers: percentages, ordering, urls and slider keys', () => {
  assert.equal(percent(0), '0.00%'); assert.equal(percent(0.0123), '1.23%'); assert.equal(percent(0.00001), '<0.01%'); assert.equal(percent(1), '100.00%');
  assert.deepEqual(sortItems(all.items).map(i => i.name), ['home', 'fresh', 'gone', 'about']);
  assert.deepEqual(sortItems([item('b', 'changed'), item('a', 'changed')]).map(i => i.name), ['a', 'b']);
  assert.equal(imageUrl('r', 'a b', 'diff'), '/api/run/visual?run=r&name=a%20b&image=diff');
  assert.equal(moveSlider('ArrowRight', false, 50), 51); assert.equal(moveSlider('ArrowUp', false, 50), 51);
  assert.equal(moveSlider('ArrowLeft', false, 50), 49); assert.equal(moveSlider('ArrowDown', true, 50), 40);
  assert.equal(moveSlider('PageUp', false, 95), 100); assert.equal(moveSlider('PageDown', false, 5), 0);
  assert.equal(moveSlider('Home', false, 50), 0); assert.equal(moveSlider('End', false, 50), 100); assert.equal(moveSlider('a', false, 50), undefined);
});

test('the list shows every item with a text status chip and its diff ratio, blocking ones first', async () => {
  const ui = environment();
  try {
    await render(ui, all);
    assert.deepEqual([...ui.container.querySelectorAll('.visual-name')].map(e => e.textContent), ['home', 'fresh', 'gone', 'about']);
    assert.equal(byId(ui, 'visual-status-home').textContent, 'Changed'); assert.equal(byId(ui, 'visual-status-fresh').textContent, 'New');
    assert.equal(byId(ui, 'visual-status-gone').textContent, 'Missing'); assert.equal(byId(ui, 'visual-status-about').textContent, 'Match');
    assert.match(byId(ui, 'visual-item-home').textContent!, /0\.10% differs/); assert.match(byId(ui, 'visual-item-about').textContent!, /0\.00% differs/);
    assert.match(byId(ui, 'visual-item-fresh').textContent!, /no diff/);
    assert.equal(byId(ui, 'visual-summary').textContent, '1 changed1 new1 missing1 match');
    assert.equal(byId(ui, 'visual-item-home').getAttribute('aria-pressed'), 'true', 'the first blocking item is selected');
    await click(ui, 'visual-item-about');
    assert.equal(byId(ui, 'visual-item-about').getAttribute('aria-pressed'), 'true'); assert.equal(byId(ui, 'visual-item-home').getAttribute('aria-pressed'), 'false');
    assert.equal(byId(ui, 'visual-scroll').getAttribute('aria-label'), 'Screenshot about');
    assert.match(byId(ui, 'visual-approve-all-command').textContent!, /approve --all/);
    assert.equal($(ui, 'visual-approve-command'), null, 'a matching screenshot has nothing to approve');
  } finally { await ui.cleanup(); }
});

test('slider: approved on the left, role=slider with aria-valuenow, pointer drag and keyboard', async () => {
  const ui = environment();
  try {
    await render(ui, all);
    const handle = byId(ui, 'visual-slider');
    assert.equal(handle.getAttribute('role'), 'slider'); assert.equal(handle.getAttribute('aria-valuemin'), '0'); assert.equal(handle.getAttribute('aria-valuemax'), '100');
    assert.match(handle.getAttribute('aria-label')!, /approved on the left, current on the right/); assert.equal(now(ui), 50);
    assert.equal(handle.getAttribute('aria-valuetext'), '50% approved, 50% current');
    const [current, approved] = [...ui.container.querySelectorAll('.visual-compare img')] as HTMLImageElement[];
    assert.match(current!.alt, /^Current/); assert.match(approved!.alt, /^Approved/);
    assert.match(approved!.src, /image=approved/); assert.match(current!.src, /image=current/);
    assert.equal(approved!.style.clipPath, 'inset(0 50% 0 0)', 'the approved image is visible on the left half');
    const stage = byId(ui, 'visual-slider-stage');
    stage.getBoundingClientRect = () => ({ left: 100, width: 400, top: 0, height: 100, right: 500, bottom: 100, x: 100, y: 0, toJSON: () => ({}) });
    await pointer(ui, stage, 'pointermove', 120); assert.equal(now(ui), 50, 'moving without a pressed button does not drag');
    await pointer(ui, stage, 'pointerdown', 200); assert.equal(now(ui), 25); assert.equal(ui.dom.window.document.activeElement, handle, 'a press focuses the divider');
    await pointer(ui, stage, 'pointermove', 400); assert.equal(now(ui), 75); assert.equal(approved!.style.clipPath, 'inset(0 25% 0 0)');
    await pointer(ui, stage, 'pointermove', 9999); assert.equal(now(ui), 100, 'clamped at the right edge');
    await pointer(ui, stage, 'pointermove', -50); assert.equal(now(ui), 0, 'clamped at the left edge');
    await pointer(ui, stage, 'pointerup'); await pointer(ui, stage, 'pointermove', 300); assert.equal(now(ui), 0, 'released');
    await pointer(ui, stage, 'pointerdown', 300); await pointer(ui, stage, 'pointercancel'); await pointer(ui, stage, 'pointermove', 400); assert.equal(now(ui), 50, 'a cancelled drag stops');
    await key(ui, handle, 'ArrowRight'); assert.equal(now(ui), 51); await key(ui, handle, 'ArrowLeft'); await key(ui, handle, 'ArrowLeft'); assert.equal(now(ui), 49);
    await key(ui, handle, 'ArrowRight', true); assert.equal(now(ui), 59);
    await key(ui, handle, 'Home'); assert.equal(now(ui), 0); await key(ui, handle, 'End'); assert.equal(now(ui), 100);
    await key(ui, handle, 'Tab'); assert.equal(now(ui), 100, 'other keys are left to the browser');
  } finally { await ui.cleanup(); }
});

test('a stage without a measurable width ignores pointer input', async () => {
  const ui = environment();
  try {
    await render(ui, all);
    await pointer(ui, byId(ui, 'visual-slider-stage'), 'pointerdown', 50); assert.equal(now(ui), 50);
  } finally { await ui.cleanup(); }
});

test('modes: side by side, diff, onion and back to slider; zoom to fit toggles real size', async () => {
  const ui = environment();
  try {
    await render(ui, all);
    for (const mode of ['slider', 'side', 'diff', 'onion']) assert.ok($(ui, `visual-mode-${mode}`), mode);
    assert.equal(byId(ui, 'visual-mode-slider').getAttribute('aria-pressed'), 'true');
    await click(ui, 'visual-mode-side');
    assert.equal(byId(ui, 'visual-mode-side').getAttribute('aria-pressed'), 'true'); assert.equal($(ui, 'visual-slider'), null);
    assert.deepEqual([...ui.container.querySelectorAll('.visual-side figcaption')].map(e => e.textContent), ['Approved', 'Current']);
    assert.equal(ui.container.querySelectorAll('.visual-side img').length, 2);
    await click(ui, 'visual-mode-diff');
    const diff = ui.container.querySelector('.visual-scroll img') as HTMLImageElement; assert.match(diff.src, /image=diff/); assert.match(diff.alt, /^Diff/);
    await click(ui, 'visual-mode-onion');
    const opacity = byId(ui, 'visual-onion-opacity') as HTMLInputElement;
    const overlay = ui.container.querySelector('.visual-overlay') as HTMLImageElement; assert.equal(overlay.style.opacity, '0.5'); assert.match(overlay.src, /image=approved/);
    await act(async () => {
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(opacity, '20');
      opacity.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    });
    assert.equal((ui.container.querySelector('.visual-overlay') as HTMLElement).style.opacity, '0.2'); assert.match(ui.container.textContent!, /Approved opacity 20%/);
    await click(ui, 'visual-mode-slider'); assert.equal($(ui, 'visual-onion-opacity'), null);
    const zoom = byId(ui, 'visual-zoom-fit'); assert.equal(zoom.getAttribute('aria-pressed'), 'true'); assert.equal(byId(ui, 'visual-scroll').className, 'visual-scroll');
    await click(ui, 'visual-zoom-fit');
    assert.equal(byId(ui, 'visual-zoom-fit').getAttribute('aria-pressed'), 'false'); assert.match(byId(ui, 'visual-scroll').className, /actual/);
    assert.equal(byId(ui, 'visual-slider-stage').style.width, '800px', 'real size uses the screenshot width');
    await click(ui, 'visual-mode-side'); assert.equal((ui.container.querySelector('.visual-side img') as HTMLElement).style.width, '800px');
    await click(ui, 'visual-mode-diff'); assert.equal(byId(ui, 'visual-scroll').querySelector('.visual-stage')!.getAttribute('style'), 'width: 800px;');
  } finally { await ui.cleanup(); }
});

test('diff mode explains a missing diff image', async () => {
  const ui = environment();
  try {
    await render(ui, visual([item('about', 'match'), item('odd', 'changed', { images: { approved: true, current: true, diff: false } })]));
    await click(ui, 'visual-mode-diff'); assert.match(byId(ui, 'visual-no-diff').textContent!, /No diff image was produced for this item\.$/);
    await click(ui, 'visual-item-about'); await click(ui, 'visual-mode-diff'); assert.match(byId(ui, 'visual-no-diff').textContent!, /it matches its baseline/);
  } finally { await ui.cleanup(); }
});

test('a new screenshot shows only the current image and says there is no approved baseline', async () => {
  const ui = environment();
  try {
    await render(ui, all); await click(ui, 'visual-item-fresh');
    assert.match(byId(ui, 'visual-no-baseline').textContent!, /^No approved baseline/);
    const images = [...ui.container.querySelectorAll('.visual-scroll img')] as HTMLImageElement[];
    assert.equal(images.length, 1); assert.match(images[0]!.src, /image=current/); assert.equal($(ui, 'visual-mode-slider'), null, 'nothing to compare');
    assert.equal(byId(ui, 'visual-approve-command').textContent, 'qualitygate visual approve fresh');
    assert.equal($(ui, 'visual-slider'), null);
  } finally { await ui.cleanup(); }
});

test('a missing screenshot shows only the approved image and is not offered for approval', async () => {
  const ui = environment();
  try {
    await render(ui, all); await click(ui, 'visual-item-gone');
    assert.match(byId(ui, 'visual-incomplete').textContent!, /No current screenshot.*qualitygate-visual\/approved/);
    const images = [...ui.container.querySelectorAll('.visual-scroll img')] as HTMLImageElement[];
    assert.equal(images.length, 1); assert.match(images[0]!.src, /image=approved/); assert.equal($(ui, 'visual-approve-command'), null);
    await render(ui, { ...visual([item('gone', 'missing')]), baselineDir: undefined }); assert.doesNotMatch(byId(ui, 'visual-incomplete').textContent!, / in /);
    await render(ui, visual([item('odd', 'changed', { images: { approved: false, current: false, diff: false } })]));
    assert.match(byId(ui, 'visual-incomplete').textContent!, /Only one of the two/); assert.equal(ui.container.querySelectorAll('.visual-scroll img').length, 0);
  } finally { await ui.cleanup(); }
});

test('the approve command is shown and copyable, and nothing in the page can approve', async () => {
  const ui = environment();
  const written: string[] = [];
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (text: string) => { written.push(text); } } }, configurable: true });
  try {
    await render(ui, all);
    assert.equal(byId(ui, 'visual-approve-command').textContent, 'qualitygate visual approve home');
    await click(ui, 'copy-visual-approve'); assert.deepEqual(written, ['qualitygate visual approve home']);
    assert.match(ui.container.textContent!, /never approves anything/);
    assert.equal(ui.container.querySelector('form'), null);
    await render(ui, visual([item('home', 'changed')])); assert.equal($(ui, 'visual-approve-all-command'), null, 'one pending item needs no approve --all');
  } finally { if (saved) Object.defineProperty(globalThis, 'navigator', saved); await ui.cleanup(); }
});

test('every control has an accessible name', async () => {
  const ui = environment();
  try {
    await render(ui, all);
    for (const target of ui.container.querySelectorAll('button, [role="slider"], [role="region"], input, img')) {
      const named = target.getAttribute('aria-label') || target.getAttribute('alt') || target.textContent?.trim() || target.closest('label')?.textContent?.trim();
      assert.ok(named, target.outerHTML);
      if (target.matches('button, [role="slider"], input')) assert.ok(target.getAttribute('data-test-id'), `data-test-id on ${target.outerHTML}`);
    }
  } finally { await ui.cleanup(); }
});

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const project = { configPath: '/p/.qualitygate.yml', gates: [{ id: 'lint', type: 'eslint', run: 'lint' }], urls: [] };

test('the dashboard shows the Visual section only when items exist and refreshes it after a run and on focus', async () => {
  const ui = environment();
  let answer: unknown = { enabled: false, items: [] }; let visualCalls = 0; let failing = false;
  const saved = { schemaVersion: 1, runId: 'r', startedAt: '2026-11-02T14:00:00.000Z', finishedAt: '2026-11-02T14:00:05.000Z', execution: 'completed', decision: 'PASS', errors: [], findings: [], steps: [], gates: [], results: [] };
  const fetch = mock.method(globalThis, 'fetch', async (path: string, init: RequestInit = {}) => {
    if (path === '/api/run/visual') { visualCalls++; if (failing) throw Error('offline'); return json(answer); }
    if (path === '/api/project') return json(project);
    if (path === '/api/team') return json(null);
    return init.method === 'POST' ? json(saved) : json(null);
  });
  try {
    await act(async () => { ui.root.render(createElement(App)); });
    assert.equal($(ui, 'visual-section'), null); assert.equal(ui.container.querySelector('a[href="#visual"]'), null);
    answer = all;
    await act(async () => { ui.dom.window.dispatchEvent(new ui.dom.window.Event('focus')); });
    assert.ok($(ui, 'visual-section'), 'refreshed when the window gets focus'); assert.match(ui.container.querySelector('a[href="#visual"]')!.textContent!, /Visual\s*4/);
    answer = { enabled: false, items: [] };
    await act(async () => { byId(ui, 'visual-item-home'); (ui.container.querySelector('.run-checks') as HTMLElement).dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true })); });
    assert.equal($(ui, 'visual-section'), null, 'refetched after the run finished: the section disappears when no items remain');
    answer = all; failing = true;
    await act(async () => { ui.dom.window.dispatchEvent(new ui.dom.window.Event('focus')); });
    assert.equal($(ui, 'visual-section'), null, 'an unreachable endpoint hides the section instead of breaking the page');
    answer = { error: 'not an answer' }; failing = false;
    await act(async () => { ui.dom.window.dispatchEvent(new ui.dom.window.Event('focus')); });
    assert.equal($(ui, 'visual-section'), null);
    assert.ok(visualCalls >= 5);
  } finally { await ui.cleanup(); fetch.mock.restore(); }
});

test('a visual.json the reader refused shows its warning as a notice instead of hiding the section', async () => {
  const ui = environment();
  const warning = 'visual.json is invalid: baselineDir must be a project-relative path <b>x</b>';
  try {
    await render(ui, { enabled: false, items: [], warning });
    const section = byId(ui, 'visual-section');
    assert.equal(section.getAttribute('aria-labelledby'), 'visual-title');
    const notice = byId(ui, 'visual-warning');
    assert.equal(notice.getAttribute('role'), 'note'); assert.equal(notice.className, 'visual-notice');
    assert.equal(notice.textContent, warning); assert.equal(notice.querySelector('b'), null, 'shown as text, never as markup');
    assert.equal($(ui, 'visual-viewer'), null);
    await render(ui, { enabled: false, items: [] }); assert.equal($(ui, 'visual-section'), null);
  } finally { await ui.cleanup(); }
});

test('the dashboard keeps the Visual section and its link while the answer carries a warning', async () => {
  const ui = environment();
  const fetch = mock.method(globalThis, 'fetch', async (path: string) => {
    if (path === '/api/run/visual') return json({ enabled: false, items: [], warning: 'visual.json is too large' });
    if (path === '/api/project') return json(project);
    return json(null);
  });
  try {
    await act(async () => { ui.root.render(createElement(App)); });
    assert.match(byId(ui, 'visual-warning').textContent!, /too large/);
    assert.match(ui.container.querySelector('a[href="#visual"]')!.textContent!, /^Visual/);
  } finally { await ui.cleanup(); fetch.mock.restore(); }
});
