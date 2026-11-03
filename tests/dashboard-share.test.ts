import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { createDashboard, newShareToken } from '../packages/dashboard/src/server.js';

test('shared dashboard is read-only and needs the random token, which becomes a cookie', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qg-share-'));
  const config = join(cwd, 'config.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'check', run: 'true' }] }));
  await writeFile(join(cwd, 'index.html'), 'fixture');
  const token = newShareToken(); assert.match(token, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(token, newShareToken());
  const dashboard = createDashboard(config, cwd, undefined, token);
  await new Promise<void>(resolve => dashboard.server.listen(0, '127.0.0.1', resolve));
  const address = dashboard.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(base + '/')).status, 401);
    assert.equal((await fetch(base + '/api/project')).status, 401);
    assert.equal((await fetch(base + '/?token=wrong', { redirect: 'manual' })).status, 401);
    assert.equal((await fetch(base + '/?token=' + token.slice(1), { redirect: 'manual' })).status, 401);
    const redirect = await fetch(`${base}/?token=${token}&x=1`, { redirect: 'manual' });
    assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), '/?x=1');
    const cookie = redirect.headers.get('set-cookie')!; assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Secure/);
    const headers = { Cookie: cookie.split(';')[0]! };
    assert.equal(await (await fetch(base + '/', { headers })).text(), 'fixture');
    const project = await (await fetch(base + '/api/project', { headers })).json(); assert.equal(project.readOnly, true);
    assert.equal((await fetch(base + '/api/project', { headers: { Cookie: 'qg_token=bad' } })).status, 401);
    assert.equal((await fetch(base + '/api/project', { headers: { Cookie: 'other=1' } })).status, 401);
    for (const path of ['/api/run', '/api/cancel']) {
      const response = await fetch(base + path, { method: 'POST', headers: { ...headers, Origin: base, 'X-QualityGate-Request': '1' } });
      assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET');
    }
    assert.equal((await fetch(base + '/api/run', { method: 'PUT', headers })).status, 405);
    assert.equal(await (await fetch(base + '/api/run', { headers })).json(), null);
    const foreign = (host: string) => new Promise<number | undefined>(resolve => get(base + '/api/run', { headers: { ...headers, Host: host } }, r => { r.resume(); resolve(r.statusCode); }));
    assert.equal(await foreign('abc.trycloudflare.com'), 403);
    dashboard.trustHost('abc.trycloudflare.com'); assert.equal(await foreign('abc.trycloudflare.com'), 200); assert.equal(await foreign('evil.example'), 403);
  } finally { await dashboard.close(); await rm(cwd, { recursive: true, force: true }); }
});
