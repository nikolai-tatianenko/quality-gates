// Loads the built Chrome extension into real Chrome and drives it against a real `qualitygate bridge` and a real Lighthouse scan.
// Not covered (Chrome gives automation no way to do it): clicking the toolbar icon, which is what grants `activeTab`.
// The popup's tab lookup is therefore replaced by one stub, `chrome.tabs.query`; storage, fetch, CORS and the extension origin are real.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { getChromePath } from 'chrome-launcher';

const directory = resolve('.qualitygate/extension-smoke');
await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true });
await import('../packages/chrome-extension/build.mjs');
const extension = resolve('packages/chrome-extension/dist');

const html = await readFile(new URL('../tests/fixture.html', import.meta.url));
const site = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
await new Promise(done => site.listen(0, '127.0.0.1', done));
const pageUrl = `http://127.0.0.1:${site.address().port}/`;

const config = join(directory, '.qualitygate.yml');
await writeFile(config, JSON.stringify({ schemaVersion: 1, outputDir: 'out', gates: [{ id: 'ok', run: 'true' }], thresholds: { performance: 0, accessibility: 0, seo: 100, 'best-practices': 0 } }));
// The built CLI is used because the Lighthouse worker is only bundled by `pnpm build`.
const entry = resolve(process.env.QUALITYGATE_CLI || 'dist/qualitygate.mjs');
const bridge = spawn(process.execPath, [entry, 'bridge', '--config', config, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let stdout = '', stderr = ''; bridge.stderr.on('data', c => { stderr += c; });
const closed = new Promise(done => bridge.once('close', done));
const started = await new Promise((done, fail) => {
  const timer = setTimeout(() => fail(Error(`bridge did not start: ${stderr}`)), 20000);
  bridge.stdout.on('data', chunk => { stdout += chunk; const m = stdout.match(/127\.0\.0\.1:(\d+)[\s\S]*Pairing code: ([A-Z0-9-]+)/); if (m) { clearTimeout(timer); done({ port: m[1], code: m[2] }); } });
});

let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || getChromePath(), headless: true, pipe: true, enableExtensions: true,
    args: process.env.QUALITYGATE_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
  const id = await browser.installExtension(extension);
  assert.match(id, /^[a-p]{32}$/);

  // A normal web page is not an allowed origin: the bridge refuses it before any token is looked at.
  const web = await browser.newPage(); await web.goto(pageUrl);
  const fromWeb = await web.evaluate(async port => { try { const r = await fetch(`http://127.0.0.1:${port}/v1/ping`); return `status ${r.status}`; } catch (e) { return `blocked: ${e.name}`; } }, started.port);
  assert.match(fromWeb, /^blocked/, 'a web page cannot read the bridge');
  await web.close();

  const popupUrl = `chrome-extension://${id}/popup.html`;
  const errors = [];
  async function openPopup() {
    const page = await browser.newPage();
    page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setViewport({ width: 380, height: 700 });
    await page.evaluateOnNewDocument(url => { try { chrome.tabs.query = async () => [{ url }]; } catch { /* reported below */ } }, `${pageUrl}#section`);
    await page.goto(popupUrl, { waitUntil: 'networkidle0' });
    return page;
  }
  const text = page => page.evaluate(() => document.body.innerText);
  const shot = (page, name) => page.screenshot({ path: join(directory, name) });

  let popup = await openPopup();
  assert.equal(await popup.evaluate(() => chrome.tabs.query.toString().includes('url')), true, 'the tab lookup stub is installed');
  await popup.waitForSelector('[data-test-id="code"]'); await shot(popup, 'pair.png');
  await popup.type('[data-test-id="code"]', 'WRONG-CODE'); await popup.$eval('[data-test-id="port"]', e => { e.value = ''; });
  await popup.type('[data-test-id="port"]', started.port); await popup.click('[data-test-id="pair"]');
  await popup.waitForFunction(() => document.body.innerText.includes('Invalid or expired pairing code'));
  await popup.$eval('[data-test-id="code"]', e => { e.value = ''; });
  await popup.type('[data-test-id="code"]', started.code); await popup.click('[data-test-id="pair"]');
  await popup.waitForSelector('[data-test-id="target-url"]');
  assert.equal(await popup.$eval('[data-test-id="target-url"]', e => e.textContent), pageUrl, 'the fragment is dropped');
  assert.equal(await popup.$eval('[data-test-id="scan"]', e => e.disabled), true, 'no scan without consent');
  const saved = await popup.evaluate(() => chrome.storage.local.get('qualitygate'));
  assert.equal(saved.qualitygate.port, Number(started.port)); assert.match(saved.qualitygate.token, /^[A-Za-z0-9_-]{32,}$/);
  await shot(popup, 'consent.png');

  await popup.click('[data-test-id="consent"]'); await popup.click('[data-test-id="scan"]');
  await popup.waitForSelector('[data-test-id="verdict"]', { timeout: 180000 });
  const verdict = await popup.$eval('[data-test-id="verdict"]', e => e.textContent);
  const runId = await popup.$eval('[data-test-id="run-id"]', e => e.textContent);
  const stored = JSON.parse(await readFile(join(directory, 'out', runId, 'report.json'), 'utf8'));
  assert.equal(stored.decision, 'BLOCK', 'seo threshold 100 blocks the fixture');
  assert.equal(verdict, `${stored.decision} exit code 1`, 'the popup shows the stored verdict and exit code');
  const audit = stored.results[0], shown = await popup.$eval('[data-test-id="scores"]', e => e.innerText.replace(/\s+/g, ' '));
  assert.match(shown, new RegExp(`SEO ${audit.scores.seo}`), 'the shown SEO score is the stored one');
  assert.ok((await text(popup)).includes(audit.violations[0]), 'the stored violation is listed');
  assert.ok((await text(popup)).includes('1-audit.json'), 'the evidence file is named');
  assert.equal(await popup.$eval('[data-test-id="open-dashboard"]', e => e.href), 'http://127.0.0.1:4173/');
  await shot(popup, 'result.png');
  await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]); await shot(popup, 'result-dark.png');
  assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow');

  // The popup closes whenever focus moves; reopening shows the same result.
  await popup.close(); popup = await openPopup();
  await popup.waitForSelector('[data-test-id="verdict"]'); assert.equal(await popup.$eval('[data-test-id="run-id"]', e => e.textContent), runId);

  // Revoke the token on the bridge from the extension's own origin; the next open must ask for pairing again.
  await popup.evaluate(async () => { const { qualitygate } = await chrome.storage.local.get('qualitygate'); await fetch(`http://127.0.0.1:${qualitygate.port}/v1/token`, { method: 'DELETE', headers: { Authorization: `Bearer ${qualitygate.token}` } }); });
  await popup.reload({ waitUntil: 'networkidle0' });
  await popup.waitForFunction(() => document.body.innerText.includes('no longer valid'));
  assert.equal(await popup.evaluate(async () => (await chrome.storage.local.get('qualitygate')).qualitygate.token), undefined, 'the dead token is forgotten');
  await shot(popup, 'revoked.png'); await popup.close();

  // Bridge stopped: pairing again reports that nothing is listening instead of failing silently.
  process.kill(-bridge.pid, 'SIGTERM'); await closed;
  popup = await openPopup(); await popup.waitForSelector('[data-test-id="code"]');
  await popup.type('[data-test-id="code"]', 'AAAA-BBBB'); await popup.click('[data-test-id="pair"]');
  await popup.waitForFunction(() => document.body.innerText.includes('not reachable'));
  assert.match(await text(popup), /qualitygate bridge/); await shot(popup, 'down.png');
  assert.deepEqual(errors.filter(e => !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(e)), [], 'no unexpected client errors');
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ chrome: await browser.version(), extensionId: id, decision: stored.decision, runId, activeTabGrant: 'not exercised', screenshots: ['pair.png', 'consent.png', 'result.png', 'result-dark.png', 'revoked.png', 'down.png'] }, null, 2));
  console.log(`Extension verified in ${await browser.version()}: pair, consent, real scan (${stored.decision}), resume, revoke, bridge stopped. Evidence: ${directory}`);
} finally {
  try { await browser?.close(); } finally {
    site.close(); if (bridge.exitCode === null && bridge.signalCode === null) process.kill(-bridge.pid, 'SIGTERM'); await closed;
  }
}
