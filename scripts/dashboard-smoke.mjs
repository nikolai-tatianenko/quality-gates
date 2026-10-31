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
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.querySelector('button').disabled);
  await page.click('button');
  await page.waitForFunction(() => document.body.innerText.includes('F401'));
  await page.screenshot({ path: join(directory, 'block.png'), fullPage: true });
  await writeFile(join(directory, 'calculator.py'), source);
  await page.click('button');
  await page.waitForFunction(() => document.body.innerText.includes('All configured gates passed.'));
  await page.screenshot({ path: join(directory, 'pass.png'), fullPage: true });
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: join(directory, 'mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile layout must not overflow');
  assert.deepEqual(errors, []);
  const latest = await (await fetch(`${url}/api/run`)).json();
  assert.equal(latest.decision, 'PASS'); assert.equal(latest.gates.length, 2);
  assert.equal(stderr, '');
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ decision: latest.decision, gates: latest.gates.map(g => g.id), screenshots: ['block.png', 'pass.png', 'mobile.png'], browser: await browser.version(), errors }, null, 2));
  console.log(`React + Python BLOCK → fix → PASS verified in real Chrome. Screenshots: ${directory}`);
} finally {
  try { await browser?.close(); }
  finally {
    if (app.pid && app.exitCode === null && app.signalCode === null) process.kill(-app.pid, 'SIGTERM');
    await closed;
  }
}
