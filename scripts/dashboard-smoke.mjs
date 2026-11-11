import { mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { getChromePath } from 'chrome-launcher';
import { writeVisualRun } from '../tests/support/visual.ts';

const directory = resolve('.qualitygate/dashboard-smoke');
// Start without history: the charts depend on it, and an old local run would make this pass where a clean CI checkout fails.
await rm(join(directory, 'runs'), { recursive: true, force: true });
await mkdir(directory, { recursive: true });
for (const file of ['calculator.py', 'test_calculator.py']) await cp(`examples/python-project/${file}`, join(directory, file));
const source = await readFile(join(directory, 'calculator.py'), 'utf8');
await writeFile(join(directory, 'calculator.py'), 'import os\n' + source);
const config = join(directory, 'project.json');
const analyzer = resolve('packages/code-analysis/dist/cli.mjs');
await writeFile(config, JSON.stringify({ schemaVersion: 1, gates: [
  { id: 'python-analysis', type: 'eslint', run: `${JSON.stringify(process.execPath)} ${JSON.stringify(analyzer)} --language python . --json` },
  { id: 'python-tests', run: 'python3 -m unittest discover -v' },
], outputDir: 'runs' }));
// Exercise the documented workspace command, not just the underlying server factory.
const app = spawn('pnpm', ['--silent', 'dashboard', '--config', config, '--port', '0'], {
  detached: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const closed = new Promise(resolve => app.once('close', resolve));
let stderr = ''; app.stderr.on('data', chunk => { stderr += chunk; });
async function capture(page, filename) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))));
  await page.screenshot({ path: join(directory, filename), fullPage: true });
}
/** `extra` selectors are optional and checked on every element they match (status chips differ in colour). */
async function verifyContrast(page, extra = []) {
  const results = await page.evaluate(extra => {
    const luminance = color => {
      const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255);
      const linear = rgb.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
    };
    const measure = (selector, element) => {
      let surface = element;
      while (getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
      const foreground = luminance(getComputedStyle(element).color); const background = luminance(getComputedStyle(surface).backgroundColor);
      return { selector, ratio: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) };
    };
    // `.changes` and `.risks` only exist once a second run or a blocking gate gives them something to say.
    const optional = new Set(['.changes dt', '.risks small']);
    const fixed = ['.muted', '.metrics small', '.run-checks', '.theme-switcher button[aria-pressed="true"]', '.pill', 'footer', '.lead-decision small', '.changes dt', '.risks small', '.section-description'].filter(selector => !optional.has(selector) || document.querySelector(selector)).map(selector => measure(selector, document.querySelector(selector)));
    return [...fixed, ...extra.flatMap(selector => [...document.querySelectorAll(selector)].map(element => measure(selector, element)))];
  }, extra);
  for (const { selector, ratio } of results) assert.ok(ratio >= 4.5, `${selector}: text contrast ${ratio.toFixed(2)} is below 4.5`);
  return results.length;
}
/** Team view: lead summary, charts, history, engineer view with file:line and reproduce command, keyboard copy and Markdown export. */
/** `charts` is how many are drawn: time to green only gets a chart once a BLOCK has recovered to PASS. */
async function verifyTeamView(page, decision, charts) {
  // The summary and the charts come from one response but are not painted in the same frame on a slow runner.
  await page.waitForFunction((expected, expectedCharts) => document.querySelector('[data-test-id="lead-decision"]')?.textContent.includes(expected)
    && document.querySelectorAll('svg[role="img"]').length === expectedCharts, { timeout: 30000 }, decision, charts);
  const view = await page.evaluate(() => ({
    charts: [...document.querySelectorAll('svg[role="img"]')].map(svg => svg.querySelector('title')?.textContent ?? ''),
    rows: document.querySelectorAll('[data-test-id="history-table"] tbody tr').length,
    engineer: document.querySelector('#engineer')?.textContent ?? '', reproduce: document.querySelector('[data-test-id="reproduce-command"]')?.textContent ?? '',
    unnamed: [...document.querySelectorAll('button, a[href], textarea, meter, [role="region"]')].filter(e => !(e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.textContent.trim())).length,
    markdown: document.querySelector('[data-test-id="markdown-preview"]')?.value ?? '',
    gatesWithSecretOutput: document.body.innerText.includes('outputTail'),
  }));
  assert.equal(view.charts.length, charts, `${charts} charts are drawn: ${JSON.stringify(view.charts)}`);
  assert.ok(view.charts.every(title => title.length > 10), `charts have accessible names: ${JSON.stringify(view.charts)}`);
  assert.ok(view.rows >= 1, 'history table has rows'); assert.equal(view.unnamed, 0, 'every control has an accessible name');
  assert.match(view.markdown, new RegExp(`^## QualityGate: ${decision}`));
  if (decision === 'BLOCK') {
    assert.match(view.engineer, /calculator\.py:\d+/, 'engineer view shows file:line');
    assert.equal(view.reproduce, 'qualitygate run --config project.json --gate python-analysis');
    await page.focus('[data-test-id="copy-reproduce-python-analysis"]');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testId), 'copy-reproduce-python-analysis', 'copy button is keyboard focusable');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Cop(ied|y failed)/.test(document.querySelector('[data-test-id="copy-reproduce-python-analysis"]').parentElement.textContent));
  } else assert.match(view.engineer, /Nothing blocks the latest run/);
}
const VISUAL_CONTRAST = ['.visual-chip', '.visual-ratio', '.visual-notice', '.visual-facts', '.visual-onion', '.visual-side figcaption', '[data-test-id="visual-approve-command"]', '.visual-note', '.visual-item', '.visual-modes button'];
const imagesLoaded = page => page.waitForFunction(() => [...document.querySelectorAll('[data-test-id="visual-section"] img')].every(img => img.complete && img.naturalWidth > 0), { timeout: 30000 });
const sliderValue = page => page.$eval('[data-test-id="visual-slider"]', element => Number(element.getAttribute('aria-valuenow')));
/**
 * Seeds the latest run with the evidence the optional visual-regression plugin writes, then drives the Visual section like a person:
 * drag and keyboard on the slider, every comparison mode, zoom, a new screenshot without baseline, contrast in both themes.
 */
async function verifyVisual(page, runId, outputDir, capture) {
  assert.equal(await page.$('[data-test-id="visual-section"]'), null, 'the Visual section stays hidden while the run has no visual evidence');
  await writeVisualRun(outputDir, [{ name: 'home', status: 'changed', diffRatio: 0.0123 }, { name: 'pricing', status: 'new' }, { name: 'about', status: 'match' }, { name: 'legacy', status: 'missing' }], runId, [320, 180]);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForSelector('[data-test-id="visual-section"]', { timeout: 15000 });
  await imagesLoaded(page);
  const chips = await page.$$eval('[data-test-id^="visual-status-"]', elements => elements.map(element => `${element.dataset.testId.slice(14)}:${element.textContent}`));
  assert.deepEqual(chips, ['home:Changed', 'pricing:New', 'legacy:Missing', 'about:Match']);
  assert.match(await page.$eval('[data-test-id="visual-item-home"]', element => element.textContent), /1\.23% differs/);
  // Slider: drag the divider with the mouse and see the position change.
  assert.equal(await sliderValue(page), 50);
  await page.$eval('[data-test-id="visual-slider-stage"]', element => element.scrollIntoView({ block: 'center' }));
  const stage = await (await page.$('[data-test-id="visual-slider-stage"]')).boundingBox();
  const before = await (await page.$('[data-test-id="visual-slider"]')).boundingBox();
  await page.mouse.move(before.x + before.width / 2, stage.y + stage.height / 2); await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * 0.2, stage.y + stage.height / 2, { steps: 5 }); await page.mouse.up();
  const dragged = await sliderValue(page); const after = await (await page.$('[data-test-id="visual-slider"]')).boundingBox();
  assert.ok(Math.abs(dragged - 20) <= 2, `dragging moved the divider to ${dragged}, expected about 20`);
  assert.ok(after.x < before.x - 50, `the divider moved left on screen (${before.x} to ${after.x})`);
  assert.match(await page.$eval('.visual-overlay', element => element.style.clipPath), /inset\(0(px)? 8\d(\.\d+)?%/, 'the approved image is clipped to the left of the divider');
  // Keyboard: the divider is a focusable slider.
  await page.focus('[data-test-id="visual-slider"]'); await page.keyboard.press('End'); assert.equal(await sliderValue(page), 100);
  await page.keyboard.press('Home'); assert.equal(await sliderValue(page), 0); await page.keyboard.press('ArrowRight'); assert.equal(await sliderValue(page), 1);
  await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
  assert.equal(await sliderValue(page), 11);
  await page.evaluate(() => document.querySelector('[data-test-id="visual-slider"]').scrollIntoView({ block: 'center' }));
  await capture(page, 'visual.png');
  // Modes.
  const shown = () => page.$$eval('[data-test-id="visual-scroll"] img', images => images.map(image => image.alt.split(' ')[0]));
  await page.click('[data-test-id="visual-mode-side"]'); await imagesLoaded(page); assert.deepEqual(await shown(), ['Approved', 'Current']);
  await page.click('[data-test-id="visual-mode-diff"]'); await imagesLoaded(page); assert.deepEqual(await shown(), ['Diff']);
  await page.click('[data-test-id="visual-mode-onion"]'); await imagesLoaded(page); assert.deepEqual(await shown(), ['Current', 'Approved']);
  await page.focus('[data-test-id="visual-onion-opacity"]'); await page.keyboard.press('ArrowRight');
  assert.notEqual(await page.$eval('.visual-overlay', element => element.style.opacity), '0.5', 'the onion opacity responds to the keyboard');
  await page.click('[data-test-id="visual-zoom-fit"]');
  assert.equal(await page.$eval('[data-test-id="visual-scroll"]', element => element.classList.contains('actual')), true, 'real size is available');
  await page.click('[data-test-id="visual-zoom-fit"]');
  await page.click('[data-test-id="visual-mode-slider"]');
  // A new screenshot has no baseline to compare with.
  await page.click('[data-test-id="visual-item-pricing"]');
  assert.match(await page.$eval('[data-test-id="visual-no-baseline"]', element => element.textContent), /No approved baseline/);
  assert.equal(await page.$('[data-test-id="visual-slider"]'), null);
  assert.equal(await page.$eval('[data-test-id="visual-approve-command"]', element => element.textContent), 'qualitygate visual approve pricing');
  await page.click('[data-test-id="visual-item-home"]'); await page.click('[data-test-id="visual-mode-side"]');
  const checked = await verifyContrast(page, VISUAL_CONTRAST);
  await page.click('[data-test-id="visual-item-pricing"]');
  await verifyContrast(page, VISUAL_CONTRAST);
  await page.click('[aria-label="Use dark theme"]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await verifyContrast(page, VISUAL_CONTRAST);
  await page.click('[data-test-id="visual-item-home"]'); await page.click('[data-test-id="visual-mode-slider"]'); await imagesLoaded(page);
  await verifyContrast(page, VISUAL_CONTRAST);
  await capture(page, 'visual-dark.png');
  await page.click('[aria-label="Use light theme"]');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  return checked;
}
let browser;
try {
  const url = await new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(Error(`Dashboard did not start: ${stderr}`)), 15000);
    app.stdout.on('data', chunk => {
      stdout += chunk; const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    app.once('error', error => { clearTimeout(timer); reject(error); });
    app.once('close', () => { clearTimeout(timer); reject(Error(`Dashboard exited before readiness: ${stderr}`)); });
  });
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || getChromePath(), headless: true,
    args: process.env.QUALITYGATE_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // A browser asking for /favicon.ico is not a dashboard error; every other console error (failed image, CSP violation) is.
  page.on('console', message => { if (message.type() === 'error' && !message.location().url?.endsWith('/favicon.ico')) errors.push(message.text()); });
  await page.setViewport({ width: 1440, height: 1050 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.querySelector('.run-checks').disabled);
  await page.click('.run-checks');
  await page.waitForFunction(() => document.body.innerText.includes('F401'));
  await verifyTeamView(page, 'BLOCK', 2);
  await capture(page, 'block.png');
  await verifyContrast(page);
  await page.click('[aria-label="Use dark theme"]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'Theme persists after reload');
  await capture(page, 'block-dark.png');
  await verifyContrast(page);
  await page.click('[aria-label="Use system theme"]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.click('[aria-label="Use light theme"]');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');

  const blockedRun = await (await fetch(`${url}/api/run`)).json();
  const contrastChecks = await verifyVisual(page, blockedRun.runId, join(directory, 'runs'), capture);
  await writeFile(join(directory, 'calculator.py'), source);
  await page.click('.run-checks');
  await page.waitForFunction(() => document.body.innerText.includes('All configured gates passed.'));
  await verifyTeamView(page, 'PASS', 3);
  // The run result and the visual refetch are separate requests; the section goes away once the second one answers.
  await page.waitForFunction(() => !document.querySelector('[data-test-id="visual-section"]'), { timeout: 15000 });
  await capture(page, 'pass.png');
  await page.setViewport({ width: 390, height: 844 });
  await capture(page, 'mobile.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile layout must not overflow');
  await page.click('[aria-label="Use dark theme"]');
  await capture(page, 'mobile-dark.png');
  await verifyContrast(page);
  await page.setViewport({ width: 320, height: 740 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '320px layout must not overflow');
  await capture(page, 'mobile-small-dark.png');
  assert.deepEqual(errors, []);
  const latest = await (await fetch(`${url}/api/run`)).json();
  assert.equal(latest.decision, 'PASS'); assert.equal(latest.gates.length, 2);
  assert.equal(stderr, '');
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ decision: latest.decision, gates: latest.gates.map(g => g.id), themes: ['light', 'dark', 'system'], persisted: true, contrastChecked: true, visual: { items: 4, contrastChecks }, screenshots: ['visual.png', 'visual-dark.png', 'block.png', 'block-dark.png', 'pass.png', 'mobile.png', 'mobile-dark.png', 'mobile-small-dark.png'], browser: await browser.version(), errors }, null, 2));
  console.log(`React + Python BLOCK → fix → PASS verified in real Chrome. Screenshots: ${directory}`);
} finally {
  try { await browser?.close(); }
  finally {
    if (app.pid && app.exitCode === null && app.signalCode === null) process.kill(-app.pid, 'SIGTERM');
    await closed;
  }
}
