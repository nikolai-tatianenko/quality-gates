import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from '../packages/dashboard/src/server.js';
import { createBridge } from '../packages/bridge/src/index.js';
import { runResultSchema } from '../packages/protocol/src/index.js';
import { png, RUN_ID, writeVisualRun } from './support/visual.js';

const EXT = `chrome-extension://${'a'.repeat(32)}`;
async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'qg-visual-api-'));
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, outputDir: 'out', gates: [{ id: 'check', run: 'true' }] }));
  const out = join(dir, 'out');
  /** A finished run whose evidence folder may hold visual/. */
  const finishRun = async (runId = RUN_ID) => {
    await mkdir(join(out, runId), { recursive: true });
    await writeFile(join(out, runId, 'report.json'), JSON.stringify(runResultSchema.parse({ schemaVersion: 1, runId, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z',
      execution: 'completed', decision: 'BLOCK', errors: [], findings: [], steps: [], gates: [], results: [] })));
  };
  return { dir, config, out, finishRun, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const items = [{ name: 'home', status: 'changed' as const }, { name: 'fresh', status: 'new' as const }];

async function dashboard() {
  const app = await project();
  const server = createDashboard(app.config, app.dir);
  await new Promise<void>(resolve => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address(); assert.ok(address && typeof address !== 'string');
  return { ...app, base: `http://127.0.0.1:${address.port}`, cleanup: async () => { await server.close(); await app.cleanup(); } };
}

test('dashboard GET /api/run/visual answers "not enabled" without a run or a plugin, then lists items of the latest run', async () => {
  const app = await dashboard();
  try {
    const empty = { enabled: false, items: [] };
    assert.deepEqual(await (await fetch(`${app.base}/api/run/visual`)).json(), empty, 'no run yet');
    await app.finishRun();
    assert.deepEqual(await (await fetch(`${app.base}/api/run/visual`)).json(), empty, 'run without the plugin');
    await writeVisualRun(app.out, items);
    const view = await (await fetch(`${app.base}/api/run/visual`)).json();
    assert.equal(view.enabled, true); assert.equal(view.runId, RUN_ID); assert.equal(view.items.length, 2);
    assert.equal((await (await fetch(`${app.base}/api/run/visual?run=${RUN_ID}`)).json()).items.length, 2);
    assert.equal((await fetch(`${app.base}/api/run/visual?run=nope`)).status, 400);
    assert.deepEqual(await (await fetch(`${app.base}/api/run/visual?run=55555555-5555-4555-8555-555555555555`)).json(), empty);
    await writeFile(app.config, 'broken');
    assert.equal((await fetch(`${app.base}/api/run/visual`)).status, 500, 'an unreadable config is an error, not an empty answer');
  } finally { await app.cleanup(); }
});

test('dashboard serves only listed screenshots as image/png and refuses everything else', async () => {
  const app = await dashboard();
  try {
    await app.finishRun(); await writeVisualRun(app.out, items);
    const get = (query: string) => fetch(`${app.base}/api/run/visual?run=${RUN_ID}&${query}`);
    const ok = await get('name=home&image=current');
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'image/png'); assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.match(ok.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), png(8, 4, [200, 90, 40]));
    await writeFile(join(app.dir, 'secret.txt'), 'top secret');
    for (const [query, status] of [['name=fresh&image=approved', 404], ['name=home&image=secret', 400], ['name=..%2f..%2fsecret&image=current', 400],
      ['name=%2e%2e&image=current', 400], ['name=nope&image=current', 404], ['name=home', 400]] as const) {
      const response = await get(query); assert.equal(response.status, status, query); assert.ok(!(await response.text()).includes('top secret'));
    }
    assert.equal((await fetch(`${app.base}/api/run/visual?name=home&image=current`)).status, 400, 'an image needs the run id');
    await rm(join(app.out, RUN_ID, 'visual', 'current', 'home.png')); await symlink(join(app.dir, 'secret.txt'), join(app.out, RUN_ID, 'visual', 'current', 'home.png'));
    assert.equal((await get('name=home&image=current')).status, 404, 'a planted symlink is not followed');
  } finally { await app.cleanup(); }
});

test('bridge GET /v1/visual needs a token, follows the same rules and serves image/png', async () => {
  const app = await project();
  const bridge = await createBridge({ configPath: app.config });
  await new Promise<void>(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  const address = bridge.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const call = (path: string, token?: string) => fetch(base + path, { headers: { Origin: EXT, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  try {
    const paired = await (await fetch(`${base}/v1/pair`, { method: 'POST', headers: { Origin: EXT, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: bridge.issuePairingCode() }) })).json();
    const token = paired.token as string;
    assert.equal((await call('/v1/visual')).status, 401, 'a token is required');
    assert.equal((await fetch(`${base}/v1/visual`, { headers: { Origin: 'https://evil.example', Authorization: `Bearer ${token}` } })).status, 403, 'origin is checked');
    assert.deepEqual(await (await call('/v1/visual', token)).json(), { enabled: false, items: [] });
    await app.finishRun(); await writeVisualRun(app.out, items);
    const view = await (await call('/v1/visual', token)).json();
    assert.equal(view.enabled, true); assert.deepEqual(view.items.map((i: { name: string }) => i.name), ['home', 'fresh']);
    assert.ok(!JSON.stringify(view).includes(app.dir), 'no local path leaves the machine');
    const image = await call(`/v1/visual?run=${RUN_ID}&name=home&image=diff`, token);
    assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png'); assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png(8, 4, [255, 0, 0]));
    for (const [query, status] of [['run=nope', 400], [`run=${RUN_ID}&name=fresh&image=approved`, 404], [`run=${RUN_ID}&name=home&image=x`, 400],
      [`run=${RUN_ID}&name=..%2f..%2fx&image=diff`, 400], ['name=home&image=diff', 400], [`run=${'x'.repeat(100)}`, 400]] as const) {
      assert.equal((await call(`/v1/visual?${query}`, token)).status, status, query);
    }
  } finally { await bridge.close(); await app.cleanup(); }
});

test('bridge reports an unexpected failure as an internal error', async () => {
  const app = await project();
  const bridge = await createBridge({ configPath: app.config });
  await new Promise<void>(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  const address = bridge.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const paired = await (await fetch(`${base}/v1/pair`, { method: 'POST', headers: { Origin: EXT, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: bridge.issuePairingCode() }) })).json();
    await writeFile(app.config, 'broken');
    assert.equal((await fetch(`${base}/v1/visual`, { headers: { Origin: EXT, Authorization: `Bearer ${paired.token}` } })).status, 500);
  } finally { await bridge.close(); await app.cleanup(); }
});
