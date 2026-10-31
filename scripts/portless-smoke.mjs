import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import { getChromePath } from 'chrome-launcher';

const directory = resolve('.qualitygate/portless-smoke'); await mkdir(directory, { recursive: true });
const config = join(directory, 'project.json');
await writeFile(config, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'check', run: `${JSON.stringify(process.execPath)} -e "process.exit(0)"` }], outputDir: 'runs' }));
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const app = spawn('pnpm', ['--silent', 'dev:ui', '--config', config], {
  env: { ...process.env, PORTLESS_PORT: String(port) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const closed = new Promise(resolve => app.once('close', resolve)); let stderr = ''; let browser;
app.stderr.on('data', chunk => { stderr += chunk; });
function send(headers, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/api/run', method, headers }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, portless: res.headers['x-portless'], body }));
    }); req.once('error', reject); req.end();
  });
}
try {
  const url = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(Error(`Portless startup timed out: ${stderr}`)), 30000);
    app.stdout.on('data', chunk => {
      output += chunk; const match = output.match(/QualityGate \(Portless\): (http:\/\/qualitygate\.localhost:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    }); app.once('error', error => { clearTimeout(timer); reject(error); });
    app.once('close', () => { clearTimeout(timer); reject(Error(`Portless exited: ${stderr}`)); });
  });
  const headers = { Host: `qualitygate.localhost:${port}`, Origin: url, 'X-QualityGate-Request': '1' };
  assert.equal((await send({ ...headers, Origin: 'https://evil.example', 'X-Forwarded-Host': headers.Host })).status, 403);
  assert.equal((await send({ ...headers, 'X-QualityGate-Request': '' })).status, 403);
  const passed = await send(headers); assert.equal(passed.status, 200); assert.equal(passed.portless, '1'); assert.equal(JSON.parse(passed.body).decision, 'PASS');
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || getChromePath(), headless: true,
    args: process.env.QUALITYGATE_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 1000 }); await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.run-checks:not([disabled])'); await page.click('.run-checks');
  await page.waitForFunction(() => document.body.innerText.includes('All configured gates passed.'));
  await page.screenshot({ path: join(directory, 'dashboard.png'), fullPage: true });
  assert.deepEqual(errors, []); assert.equal(stderr, '');
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ url, decision: 'PASS', browser: await browser.version(), errors, csrfChecked: true, namedOriginVerified: true, systemCertificatesChanged: false, hostsFileChanged: false }, null, 2));
  console.log(`Portless named origin + real Chrome run verified: ${url}`);
} finally {
  await browser?.close();
  if (app.pid && app.exitCode === null && app.signalCode === null) process.kill(-app.pid, 'SIGTERM');
  const timer = setTimeout(() => { try { process.kill(-app.pid, 'SIGKILL'); } catch { /* Already closed. */ } }, 10000);
  try { await closed; } finally { clearTimeout(timer); }
  let leaked = true;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await send({ Host: `qualitygate.localhost:${port}` }, 'GET'); await delay(100); }
    catch { leaked = false; break; }
  }
  assert.equal(leaked, false, 'Owned Portless proxy must stop with the dashboard');
}
