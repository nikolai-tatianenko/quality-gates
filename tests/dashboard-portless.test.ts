import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { createDashboard } from '../packages/dashboard/src/server.js';
import { portlessOrigin } from '../packages/dashboard/src/address.js';

test('Portless public origins are explicit named loopback origins, never arbitrary remote URLs', () => {
  assert.equal(portlessOrigin(), undefined); assert.equal(portlessOrigin(''), undefined);
  assert.equal(portlessOrigin('http://qualitygate.localhost:1355/'), 'http://qualitygate.localhost:1355');
  assert.equal(portlessOrigin('https://branch.qualitygate.localhost'), 'https://branch.qualitygate.localhost');
  for (const value of ['broken', 'file:///tmp', 'https://evil.example', 'http://localhost', 'http://127.0.0.1:1355',
    'http://qualitygate.localhost/path', 'http://qualitygate.localhost?secret=x', 'http://qualitygate.localhost#x',
    'http://user:password@qualitygate.localhost', 'http://bad..localhost', 'http://-bad.localhost']) {
    assert.throws(() => portlessOrigin(value));
  }
  assert.throws(() => createDashboard('unused', undefined, 'https://remote.example'));
});
test('Portless preserves strict Host/Origin checks and does not trust forwarded headers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qg-portless-origin-'));
  const config = join(directory, 'config.json'); const publicOrigin = 'http://qualitygate.localhost:1355';
  await writeFile(config, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'check', run: 'true' }] }));
  await writeFile(join(directory, 'theme-init.js'), 'bootstrap');
  const dashboard = createDashboard(config, directory, publicOrigin);
  await new Promise<void>(resolve => dashboard.server.listen(0, '127.0.0.1', resolve));
  const address = dashboard.server.address(); assert.ok(address && typeof address !== 'string');
  function send(method: string, headers: Record<string, string>, path = '/api/run') {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: typeof address === 'object' && address ? address.port : 0, method, path, headers }, res => {
        let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, body }));
      }); req.once('error', reject); req.end();
    });
  }
  const valid = { Host: 'qualitygate.localhost:1355', Origin: publicOrigin, 'X-QualityGate-Request': '1' };
  try {
    const result = await send('POST', valid); assert.equal(result.status, 200); assert.equal(JSON.parse(result.body).decision, 'PASS');
    assert.equal((await send('POST', { ...valid, Host: `127.0.0.1:${address.port}` })).status, 200, 'A proxy may rewrite Host to the backend');
    assert.equal((await send('GET', { Host: valid.Host }, '/theme-init.js')).body, 'bootstrap');
    const patches: Record<string, string>[] = [{ Host: 'other.localhost:1355' }, { Origin: 'http://evil.example' }, { Origin: `http://127.0.0.1:${address.port}` },
      { Origin: 'https://qualitygate.localhost:1355' }, { 'X-QualityGate-Request': '' },
      { Host: 'evil.example', 'X-Forwarded-Host': valid.Host, 'X-Forwarded-Proto': 'http' }, { Origin: '', 'X-Forwarded-Origin': publicOrigin }];
    for (const patch of patches) {
      assert.equal((await send('POST', { ...valid, ...patch })).status, 403);
    }
    assert.equal((await send('OPTIONS', valid)).status, 405);
  } finally { await dashboard.close(); await rm(directory, { recursive: true, force: true }); }
});
test('dashboard CLI reads PORT and PORTLESS_URL, while an explicit --port takes precedence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qg-portless-cli-')); const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'check', run: 'true' }] }));
  const entry = resolve('packages/dashboard/src/cli.ts'); const loader = resolve('node_modules/tsx/dist/loader.mjs');
  try {
    for (const named of [true, false]) {
      const child = spawn(process.execPath, ['--import', loader, entry, '--config', config, ...(named ? [] : ['--port', '0'])], {
        env: { ...process.env, PORT: named ? '0' : 'invalid', PORTLESS_URL: named ? 'http://qualitygate.localhost:1355' : '' },
      });
      let output = ''; let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
      const closed = new Promise(resolve => child.once('close', resolve));
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout.on('data', chunk => { output += chunk; if (output.includes('Project:')) resolve(); });
          child.once('error', reject); child.once('exit', () => reject(Error(`Exited before ready: ${stderr}`)));
        });
        assert.match(output, named ? /qualitygate\.localhost:1355/ : /127\.0\.0\.1:\d+/);
      } finally { child.kill('SIGTERM'); await closed; }
      assert.equal(stderr, '');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
