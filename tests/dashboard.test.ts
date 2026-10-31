import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { get } from 'node:http';
import { createDashboard } from '../packages/dashboard/src/server.js';

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'qg-dashboard-'));
  const config = join(cwd, 'config.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'check', run: 'true' }] }));
  for (const file of ['index.html', 'app.js', 'app.css']) await writeFile(join(cwd, file), 'fixture');
  const dashboard = createDashboard(config, cwd);
  await new Promise<void>(resolve => dashboard.server.listen(0, '127.0.0.1', resolve));
  const address = dashboard.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, init: RequestInit = {}) => fetch(base + path, { method: 'POST', headers: {
    Origin: base, 'X-QualityGate-Request': '1',
  }, ...init });
  return { ...dashboard, cwd, config, base, post, cleanup: async () => { await dashboard.close(); await rm(cwd, { recursive: true, force: true }); } };
}
test('dashboard serves assets and only declared project gates, with host/origin protection', async () => {
  const app = await fixture();
  try {
    for (const path of ['/', '/app.js', '/app.css']) {
      const response = await fetch(app.base + path); assert.equal(response.status, 200);
      assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/); assert.equal(await response.text(), 'fixture');
    }
    assert.equal(await (await fetch(app.base + '/api/run')).json(), null);
    assert.equal((await (await fetch(app.base + '/api/project')).json()).gates[0].id, 'check');
    assert.equal((await fetch(app.base + '/unknown')).status, 404);
    assert.equal((await fetch(app.base, { method: 'PUT' })).status, 405);
    const invalidHost = await new Promise<number | undefined>(resolve => {
      get(app.base, { headers: { Host: 'evil.local' } }, response => { response.resume(); resolve(response.statusCode); });
    });
    assert.equal(invalidHost, 403);
    assert.equal((await fetch(app.base + '/api/run', { method: 'POST' })).status, 403);
    assert.equal((await app.post('/api/run', { body: 'unexpected' })).status, 400);
    assert.equal((await app.post('/api/unknown')).status, 404);
    assert.deepEqual(await (await app.post('/api/cancel')).json(), { cancelled: false });
    const result = await (await app.post('/api/run')).json(); assert.equal(result.decision, 'PASS');
    assert.equal((await (await fetch(app.base + '/api/run')).json()).runId, result.runId);
    await writeFile(app.config, 'invalid');
    assert.equal((await fetch(app.base + '/api/project')).status, 500);
    assert.equal((await fetch(app.base + '/api/run')).status, 500);
    assert.equal((await app.post('/api/run')).status, 500);
    await rm(join(app.cwd, 'app.css'));
    assert.equal((await fetch(app.base + '/app.css')).status, 500);
  } finally { await app.cleanup(); }
});
test('dashboard rejects concurrent mutations, cancels owned processes and saves interrupted evidence', async () => {
  const app = await fixture();
  try {
    await writeFile(app.config, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'hang', run: 'sleep 30 & echo $! > child.pid; wait' }] }));
    const pending = app.post('/api/run');
    let pid: number | undefined;
    for (let i = 0; i < 100 && !pid; i++) { pid = await readFile(join(app.cwd, 'child.pid'), 'utf8').then(Number).catch(() => undefined); if (!pid) await delay(20); }
    assert.ok(pid);
    assert.equal((await app.post('/api/run')).status, 409);
    assert.deepEqual(await (await app.post('/api/cancel')).json(), { cancelled: true });
    const result = await (await pending).json(); assert.equal(result.execution, 'interrupted'); assert.ok(result.reportPath);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally { await app.cleanup(); }
});
