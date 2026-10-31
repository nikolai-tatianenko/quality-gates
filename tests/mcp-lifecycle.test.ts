import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../packages/mcp/src/index.js';
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 7000;
  while (Date.now() < end) { const value = await read().catch(() => undefined); if (value !== undefined) return value; await delay(25); }
  throw new Error('Timed out waiting for lifecycle evidence');
}
async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'qg-mcp-lifecycle-'));
  await writeFile(join(dir, '.qualitygate.yml'), JSON.stringify({ schemaVersion: 1,
    gates: [{ id: 'hang', run: 'sleep 30 & echo $! > child.pid; wait' }], outputDir: 'out' }));
  const server = createServer(join(dir, '.qualitygate.yml'));
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b);
  const client = new Client({ name: 'lifecycle-test', version: '1' }); await client.connect(a);
  return { dir, client };
}
async function saved(dir: string) {
  return until(async () => {
    for (const id of await readdir(join(dir, 'out'))) {
      const result = JSON.parse(await readFile(join(dir, 'out', id, 'report.json'), 'utf8'));
      if (result.execution === 'interrupted') return result;
    }
    return undefined;
  });
}
test('MCP rejects overlapping runs while keeping read tools available', async () => {
  const { dir, client } = await project();
  const controller = new AbortController();
  try {
    const first = client.callTool({ name: 'run_gates', arguments: {} }, undefined, { signal: controller.signal });
    const rejected = assert.rejects(first, /abort/i);
    await until(async () => Number(await readFile(join(dir, 'child.pid'), 'utf8')) || undefined);
    const listed = await client.callTool({ name: 'list_gates', arguments: {} }); assert.equal(listed.isError, false);
    const second = await client.callTool({ name: 'run_gates', arguments: {} });
    assert.equal(second.isError, true); assert.match(JSON.stringify(second.content), /already active/);
    controller.abort(); await rejected;
    const result = await saved(dir); assert.equal(result.gates.length, 1);
    assert.equal((await readdir(join(dir, 'out'))).length, 1);
  } finally { controller.abort(); await client.close(); await rm(dir, { recursive: true, force: true }); }
});
test('MCP cancellation stops an active child process and preserves an interrupted report', async () => {
  const { dir, client } = await project(); const controller = new AbortController();
  try {
    const pending = client.callTool({ name: 'run_gates', arguments: {} }, undefined, { signal: controller.signal });
    const rejected = assert.rejects(pending, /abort/i);
    const pid = await until(async () => Number(await readFile(join(dir, 'child.pid'), 'utf8')) || undefined);
    controller.abort(); await rejected;
    const result = await saved(dir); assert.equal(result.gates[0].execution, 'interrupted');
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    const replay = await client.callTool({ name: 'get_run', arguments: { runId: result.runId } }); assert.equal(replay.isError, false);
  } finally { controller.abort(); await client.close(); await rm(dir, { recursive: true, force: true }); }
});
test('client disconnect drains active execution and evidence writes', async () => {
  const { dir, client } = await project();
  try {
    const pending = client.callTool({ name: 'run_gates', arguments: {} });
    const rejected = assert.rejects(pending, /closed/i);
    const pid = await until(async () => Number(await readFile(join(dir, 'child.pid'), 'utf8')) || undefined);
    await client.close(); await rejected;
    await saved(dir); assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});
