import { mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { getChromePath } from 'chrome-launcher';

const directory = resolve('.qualitygate/dashboard-smoke');
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
async function verifyContrast(page) {
  const results = await page.evaluate(() => {
    const luminance = color => {
      const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255);
      const linear = rgb.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
    };
    return ['.muted', '.metrics small', '.run-checks', '.theme-switcher button[aria-pressed="true"]', '.pill', 'footer', '.lead-decision small', '.changes dt', '.risks small', '.section-description'].map(selector => {
      const element = document.querySelector(selector); let surface = element;
      while (getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
      const foreground = luminance(getComputedStyle(element).color); const background = luminance(getComputedStyle(surface).backgroundColor);
      return { selector, ratio: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) };
    });
  });
  for (const { selector, ratio } of results) assert.ok(ratio >= 4.5, `${selector}: text contrast ${ratio.toFixed(2)} is below 4.5`);
}
/** Team view: lead summary, charts, history, engineer view with file:line and reproduce command, keyboard copy and Markdown export. */
async function verifyTeamView(page, decision) {
  await page.waitForFunction(expected => document.querySelector('[data-test-id="lead-decision"]')?.textContent.includes(expected), {}, decision);
  const view = await page.evaluate(() => ({
    charts: [...document.querySelectorAll('svg[role="img"]')].map(svg => svg.querySelector('title')?.textContent ?? ''),
    rows: document.querySelectorAll('[data-test-id="history-table"] tbody tr').length,
    engineer: document.querySelector('#engineer')?.textContent ?? '', reproduce: document.querySelector('[data-test-id="reproduce-command"]')?.textContent ?? '',
    unnamed: [...document.querySelectorAll('button, a[href], textarea, meter, [role="region"]')].filter(e => !(e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.textContent.trim())).length,
    markdown: document.querySelector('[data-test-id="markdown-preview"]')?.value ?? '',
    gatesWithSecretOutput: document.body.innerText.includes('outputTail'),
  }));
  assert.ok(view.charts.length >= 3 && view.charts.every(title => title.length > 10), 'charts have accessible names');
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
  await page.setViewport({ width: 1440, height: 1050 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.querySelector('.run-checks').disabled);
  await page.click('.run-checks');
  await page.waitForFunction(() => document.body.innerText.includes('F401'));
  await verifyTeamView(page, 'BLOCK');
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

  await writeFile(join(directory, 'calculator.py'), source);
  await page.click('.run-checks');
  await page.waitForFunction(() => document.body.innerText.includes('All configured gates passed.'));
  await verifyTeamView(page, 'PASS');
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
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ decision: latest.decision, gates: latest.gates.map(g => g.id), themes: ['light', 'dark', 'system'], persisted: true, contrastChecked: true, screenshots: ['block.png', 'block-dark.png', 'pass.png', 'mobile.png', 'mobile-dark.png', 'mobile-small-dark.png'], browser: await browser.version(), errors }, null, 2));
  console.log(`React + Python BLOCK → fix → PASS verified in real Chrome. Screenshots: ${directory}`);
} finally {
  try { await browser?.close(); }
  finally {
    if (app.pid && app.exitCode === null && app.signalCode === null) process.kill(-app.pid, 'SIGTERM');
    await closed;
  }
}
