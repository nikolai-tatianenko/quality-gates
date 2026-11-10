import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../packages/dashboard/src/App.js';
import { BarChart, copyText, TeamView, type Team } from '../packages/dashboard/src/Team.js';
import { durationBars, formatMs, greenBars, historyRows, layoutBars, weekBars, CHART } from '../packages/dashboard/src/chart.js';
import { buildTeamReport, teamMarkdown } from '../packages/core/src/team.js';
import type { HistoryGate, HistoryRun } from '../packages/core/src/history.js';
import { runResultSchema } from '../packages/protocol/src/index.js';

const gate = (id: string, status: HistoryGate['status']): HistoryGate => ({ id, status, durationMs: 10, inputsHash: 'same' });
function hrun(n: number, gates: HistoryGate[], over: Partial<HistoryRun> = {}): HistoryRun {
  const start = new Date(Date.UTC(2026, 10, 2, 10 + n)).toISOString();
  return { id: `run${n}-aaaaaaaa-0000`, startedAt: start, finishedAt: new Date(Date.parse(start) + 60_000).toISOString(), execution: 'completed',
    decision: gates.some(g => g.status === 'failed') ? 'BLOCK' : 'PASS', durationMs: 60_000 * n, gates, ...over };
}
const latest = (over: Record<string, unknown> = {}) => runResultSchema.parse({ schemaVersion: 1, runId: 'run4-aaaaaaaa-0000', startedAt: '2026-11-02T14:00:00.000Z', finishedAt: '2026-11-02T14:00:05.000Z',
  execution: 'completed', decision: 'BLOCK', errors: [], findings: [], steps: [],
  gates: [{ id: 'lint', command: 'x', execution: 'completed', decision: 'BLOCK', exitCode: 1, durationMs: 50, outputTail: 'TOKEN=hunter2', errors: [],
    findings: [{ gateId: 'lint', severity: 'error', message: 'too complex', file: 'src/a.ts', line: 3, ruleId: 'complexity', helpUrl: 'https://docs.example/c' },
      { gateId: 'lint', severity: 'warning', message: 'unused', file: 'src/b.ts', line: 9, ruleId: 'no-unused' }] },
  { id: 'empty', command: 'x', execution: 'completed', decision: 'BLOCK', exitCode: 1, durationMs: 1, outputTail: '', errors: [] }],
  results: [{ url: 'http://site', execution: 'completed', decision: 'BLOCK', scores: {}, violations: ['performance 40 < 50'], errors: [] }], ...over });
function team(runs: HistoryRun[], run: ReturnType<typeof latest> | null = latest(), warnings: string[] = []): Team {
  const report = buildTeamReport({ runs, latest: run, warnings });
  return { ...report, markdown: teamMarkdown(report) };
}
const history = () => [hrun(4, [gate('lint', 'failed'), gate('empty', 'failed')]), hrun(3, [gate('lint', 'passed'), gate('empty', 'passed')]), hrun(2, [gate('lint', 'failed'), gate('empty', 'passed')]),
  hrun(1, [gate('lint', 'passed'), gate('empty', 'passed')], { execution: 'interrupted' })];

function environment() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1:4173', pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById('root')!);
  const container = dom.window.document.getElementById('root')!;
  return { dom, container, root, text: () => container.textContent!, cleanup: async () => { await act(async () => root.unmount()); dom.window.close(); } };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const project = { configPath: '/p/.qualitygate.yml', gates: [{ id: 'lint', type: 'eslint', run: 'lint' }], urls: [] };
const withClipboard = async (writeText: ((text: string) => Promise<void>) | undefined, body: () => Promise<void>) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: writeText ? { clipboard: { writeText } } : {}, configurable: true });
  try { await body(); } finally { if (saved) Object.defineProperty(globalThis, 'navigator', saved); }
};

test('chart geometry keeps every non-zero bar visible and scales to the tallest', () => {
  assert.deepEqual(layoutBars([]), []);
  const [small, tall, none] = layoutBars([{ label: 'a', value: 1, kind: 'pass', title: 'a' }, { label: 'b', value: 1000, part: 5000, kind: 'block', title: 'b' }, { label: 'c', value: 0, part: 3, kind: 'other', title: 'c' }]);
  const plot = CHART.height - CHART.top - CHART.bottom;
  assert.equal(small!.height, 2); assert.equal(tall!.height, plot); assert.equal(tall!.partHeight, plot, 'the blocked part never exceeds the bar');
  assert.equal(none!.height, 0); assert.equal(none!.partHeight, 0); assert.equal(tall!.y, CHART.top);
  assert.ok(tall!.x > small!.x && small!.width <= CHART.maxBar);
  assert.equal(layoutBars([{ label: 'z', value: 0, kind: 'pass', title: 'z' }])[0]!.height, 0, 'all-zero data does not divide by zero');
  assert.deepEqual([500, 90_000, 5_400_000, 7_200_000].map(formatMs), ['0.5 s', '1.5 min', '1.5 h', '2.0 h']);
});

test('chart data is shaped from the report: kinds, labels, weekly share and history rows', () => {
  const t = team(history());
  const bars = durationBars(t.runs);
  assert.deepEqual(bars.map(b => b.kind), ['other', 'block', 'pass', 'block']);
  assert.match(bars[0]!.title, /interrupted/); assert.match(bars[1]!.title, /BLOCK, 2.0 min/);
  assert.deepEqual(weekBars(t.weeks).map(b => [b.value, b.part]), [[4, 2]]);
  assert.match(weekBars(t.weeks)[0]!.title, /2 of 4 runs blocked/);
  assert.deepEqual(greenBars(t.timeToGreen.spans).map(b => b.kind), ['other']);
  const rows = historyRows(t.runs);
  assert.deepEqual(rows.map(r => r.run.runId.slice(0, 4)), ['run4', 'run3', 'run2', 'run1']);
  assert.deepEqual(rows.map(r => r.newlyBlocked), [['lint', 'empty'], [], ['lint'], []], 'the oldest run has no baseline');
});

test('the team view shows the decision, risks, charts, history and the engineer view for the latest run', async () => {
  const ui = environment();
  const t = team(history());
  try {
    await act(async () => ui.root.render(createElement(TeamView, { team: t, error: '' })));
    const c = ui.container;
    assert.match(c.querySelector('[data-test-id="lead-decision"]')!.textContent!, /BLOCK: 2 blocking: lint, empty/);
    assert.match(c.querySelector('[data-test-id="lead-decision"]')!.textContent!, /Exit code 1/);
    assert.equal(c.querySelectorAll('[data-test-id="lead-risks"] li').length, 2);
    assert.deepEqual([...c.querySelectorAll('[data-test-id="lead-blocking"] li')].map(li => li.textContent), ['lint', 'empty']);
    assert.match(c.querySelector('.changes')!.textContent!, /Regressions.*lint.*empty/);
    assert.match(c.querySelector('#lead-green')!.parentElement!.textContent!, /Blocked since 2026-11-02 14:00 UTC/);
    for (const id of ['weeks', 'duration', 'green']) {
      const svg = c.querySelector(`[data-test-id="chart-${id}"]`)!; assert.equal(svg.getAttribute('role'), 'img');
      assert.ok(svg.querySelector('title')!.textContent!.length > 10); assert.ok(svg.querySelector('rect.bar'));
    }
    assert.ok(c.querySelector('[data-test-id="chart-duration"] rect.bar-block[fill^="url(#duration-hatch)"]'), 'blocked bars are hatched, not only red');
    assert.ok(c.querySelector('[data-test-id="chart-weeks"] rect.bar-block'));
    assert.match(c.querySelector('[data-test-id="failing-gates"]')!.textContent!, /lint.*2 of 4/);
    assert.equal(c.querySelector('meter')!.getAttribute('aria-label'), 'lint blocked 2 of 4 runs');
    assert.match(c.querySelector('[data-test-id="flaky-gates"]')!.textContent!, /lint/);
    const table = c.querySelector('[data-test-id="history-table"]')!;
    assert.equal(table.querySelectorAll('tbody tr').length, 4); assert.ok(table.querySelector('caption'));
    assert.deepEqual([...table.querySelectorAll('th')].map(th => th.getAttribute('scope')), Array(5).fill('col'));
    assert.match(table.querySelector('tbody tr')!.textContent!, /run4-aaa.*BLOCK.*2 of 2.*lint, empty/);
    assert.match(table.querySelectorAll('tbody tr')[3]!.textContent!, /interrupted/);
    assert.equal(table.closest('[role="region"]')!.getAttribute('tabindex'), '0');
    const lint = c.querySelector('[data-test-id="engineer-lint"]')!;
    assert.equal(lint.querySelector('[data-test-id="reproduce-command"]')!.textContent, 'qualitygate run --gate lint');
    assert.match(lint.textContent!, /src\/a\.ts:3.*complexity.*too complex/); assert.match(lint.textContent!, /src\/b\.ts:9/);
    assert.equal(lint.querySelector('a')!.getAttribute('href'), 'https://docs.example/c'); assert.match(lint.querySelector('a')!.getAttribute('rel')!, /noopener/);
    assert.match(c.querySelector('[data-test-id="engineer-empty"]')!.textContent!, /no structured findings/);
    assert.match(c.querySelector('[data-test-id="engineer-http://site"]')!.textContent!, /performance 40 < 50/);
    assert.ok(!ui.text().includes('hunter2'), 'gate output is not rendered');
    const download = c.querySelector('a[data-test-id="download-markdown"]')!;
    assert.equal(decodeURIComponent(download.getAttribute('href')!.split(',')[1]!), t.markdown); assert.equal(download.getAttribute('download'), 'qualitygate-summary.md');
    assert.equal((c.querySelector('[data-test-id="markdown-preview"]') as HTMLTextAreaElement).value, t.markdown);
    for (const control of c.querySelectorAll('button, textarea, summary')) assert.ok(control.getAttribute('data-test-id') || control.tagName === 'SUMMARY', `${control.outerHTML} needs a test id`);
  } finally { await ui.cleanup(); }
});

test('an empty project and a passing project render honest empty states', async () => {
  const ui = environment();
  try {
    await act(async () => ui.root.render(createElement(TeamView, { team: team([], null), error: '' })));
    for (const text of ['No run recorded yet', 'Needs at least two recorded runs', 'No risks found', 'No gate blocks the latest run', 'No BLOCK to PASS recovery', 'No runs recorded yet', 'Run the gates to see failures', 'No gate has blocked', 'No flaky gates']) assert.match(ui.text(), new RegExp(text), text);
    assert.equal(ui.container.querySelectorAll('svg[role="img"]').length, 0); assert.equal(ui.container.querySelector('[data-test-id="lead-decision"] .pill'), null);
    const pass = team([hrun(2, [gate('lint', 'passed')]), hrun(1, [gate('lint', 'failed')])], latest({ decision: 'PASS', gates: [], results: [] }));
    await act(async () => ui.root.render(createElement(TeamView, { team: pass, error: '' })));
    assert.match(ui.text(), /PASS: lint fixed since the previous run/); assert.match(ui.text(), /Nothing blocks the latest run/);
    assert.match(ui.text(), /Median over 1 recoveries/);
  } finally { await ui.cleanup(); }
});

test('findings beyond the shown ones, warnings, loading and errors are visible', async () => {
  const ui = environment();
  try {
    const findings = Array.from({ length: 12 }, (_, i) => ({ gateId: 'lint', severity: 'error', message: `m${i}`, file: 'f.ts', line: i + 1 }));
    const many = team([hrun(1, [gate('lint', 'failed')])], latest({ gates: [{ id: 'lint', command: 'x', execution: 'completed', decision: 'BLOCK', exitCode: 1, durationMs: 1, outputTail: '', errors: [], findings }], results: [] }), ['History is unreadable']);
    await act(async () => ui.root.render(createElement(TeamView, { team: many, error: '' })));
    assert.match(ui.text(), /and 2 more findings/); assert.equal(ui.container.querySelector('[role="alert"]')!.textContent, 'History is unreadable');
    await act(async () => ui.root.render(createElement(TeamView, { team: undefined, error: '' })));
    assert.match(ui.container.querySelector('[role="status"]')!.textContent!, /Loading team view/);
    await act(async () => ui.root.render(createElement(TeamView, { team: undefined, error: 'API failed' })));
    assert.match(ui.container.querySelector('[role="alert"]')!.textContent!, /Team view unavailable: API failed/);
    await act(async () => ui.root.render(createElement(BarChart, { id: 'x', label: 'x', bars: [], unit: String })));
    assert.match(ui.text(), /Nothing recorded yet/);
  } finally { await ui.cleanup(); }
});

test('copy buttons announce success and failure and write the exact text', async () => {
  const ui = environment(); const t = team(history());
  const written: string[] = [];
  const click = async (testId: string) => { await act(async () => { ui.container.querySelector(`[data-test-id="${testId}"]`)!.dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true })); }); };
  try {
    await act(async () => ui.root.render(createElement(TeamView, { team: t, error: '' })));
    await withClipboard(async text => { written.push(text); }, async () => {
      await click('copy-markdown'); await click('copy-reproduce-lint');
      assert.deepEqual(written, [t.markdown, 'qualitygate run --gate lint']);
      assert.match(ui.container.querySelector('[data-test-id="copy-markdown"]')!.parentElement!.querySelector('[role="status"]')!.textContent!, /Copied/);
      assert.equal(await copyText('x'), true);
    });
    for (const writeText of [async () => { throw Error('denied'); }, undefined]) {
      await withClipboard(writeText, async () => {
        await click('copy-markdown');
        assert.match(ui.container.querySelector('[data-test-id="copy-markdown"]')!.parentElement!.querySelector('[role="status"]')!.textContent!, /Copy failed/);
        assert.equal(await copyText('x'), false);
      });
    }
  } finally { await ui.cleanup(); }
});

test('the dashboard loads the team view next to the project, reloads it after a run and keeps working when it fails', async () => {
  const ui = environment(); let teamCalls = 0; let teamFails = false;
  const fetch = mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    if (path === '/api/project') return json(project);
    if (path === '/api/team') { teamCalls++; return teamFails ? json({ error: 'history exploded' }, 500) : json(team(history())); }
    if (init?.method === 'POST') return json(latest());
    return json(null);
  });
  try {
    await act(async () => ui.root.render(createElement(App)));
    assert.match(ui.text(), /Summary for leads/); assert.equal(teamCalls, 1);
    assert.ok(ui.container.querySelector('nav a[href="#team"]') && ui.container.querySelector('nav a[href="#engineer"]') && ui.container.querySelector('nav a[href="#history"]'));
    for (const id of ['team', 'trends', 'history', 'engineer', 'checks', 'findings']) assert.ok(ui.container.querySelector(`#${id}`), id);
    teamFails = true;
    const run = [...ui.container.querySelectorAll('button')].find(b => b.textContent?.includes('Run quality'))!;
    await act(async () => { run.dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true })); });
    assert.equal(teamCalls, 2); assert.match(ui.text(), /Team view unavailable: history exploded/);
    assert.match(ui.text(), /Project checks/, 'the rest of the page still renders');
    teamFails = false;
    await act(async () => { run.dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true })); });
    assert.match(ui.text(), /Summary for leads/); assert.doesNotMatch(ui.text(), /Team view unavailable/);
  } finally { await ui.cleanup(); fetch.mock.restore(); }
});
