import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('dashboard CLI validates arguments and shuts down cleanly on SIGTERM', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qg-dashboard-cli-'));
  const entry = resolve('packages/dashboard/src/cli.ts');
  const loader = resolve('node_modules/tsx/dist/loader.mjs');
  try {
    const config = join(cwd, 'config.json');
    await writeFile(config, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'check', run: 'true' }] }));
    for (const args of [['--port'], ['--unknown', 'value'], ['--port', '99999'], ['--port', 'not-a-port']]) {
      const child = spawn(process.execPath, ['--import', loader, entry, ...args]);
      child.stdout.resume(); child.stderr.resume();
      assert.notEqual(await new Promise(resolve => child.once('close', resolve)), 0);
    }
    const child = spawn(process.execPath, ['--import', loader, entry, '--config', config, '--port', '0']);
    let output = ''; let errors = ''; child.stderr.on('data', b => { errors += b; });
    const closed = new Promise(resolve => child.once('close', resolve));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', b => { output += b; if (output.includes('Project:')) resolve(); }); child.once('error', reject);
    });
    assert.match(output, /http:\/\/127.0.0.1:\d+/); child.kill('SIGTERM');
    assert.equal(await closed, 0); assert.equal(errors, '');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
