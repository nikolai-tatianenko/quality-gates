import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer as mcpServer } from '../packages/mcp/src/index.js';
import { clientConfig, clients } from '../packages/integrations/src/index.js';
import { askModel, modelEndpoint, type Provider, type ToolHost } from '../packages/model-client/src/index.js';
async function endpoint(handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void) {
  const server = createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(Buffer.from(part));
    handler(req, res, JSON.parse(Buffer.concat(parts).toString('utf8')));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
async function project(command = 'echo gate-output; exit 1') {
  const dir = await mkdtemp(join(tmpdir(), 'qg-model-'));
  await writeFile(join(dir, '.qualitygate.yml'), JSON.stringify({ schemaVersion: 1, gates: [{ id: 'test', run: command }] }));
  const [a, b] = InMemoryTransport.createLinkedPair(); const server = mcpServer(join(dir, '.qualitygate.yml')); await server.connect(b);
  const client = new Client({ name: 'provider-test', version: '1' }); await client.connect(a);
  const host: ToolHost = {
    listTools: () => client.listTools(), async callTool(name, args, signal) {
      const response = await client.callTool({ name, arguments: args }, undefined, { signal });
      return JSON.parse((response.content as { text: string }[])[0]!.text);
    },
  };
  return { host, close: async () => { await client.close(); await rm(dir, { recursive: true, force: true }); } };
}
test('client snippets use absolute argument arrays and correct native configuration envelopes', () => {
  for (const client of clients) {
    const result = clientConfig(client, '/project with spaces/config.yml', '/qg path/qualitygate.mjs');
    if (client === 'codex') {
      assert.match(result.content, /\[mcp_servers.qualitygate\]/); assert.match(result.content, /tool_timeout_sec = 600/);
      assert.match(result.content, /"\/project with spaces\/config.yml"/);
    } else {
      const doc = JSON.parse(result.content); const server = doc.mcpServers?.qualitygate ?? doc.servers.qualitygate;
      assert.deepEqual(server.args, ['/qg path/qualitygate.mjs', 'mcp', '--config', '/project with spaces/config.yml']);
      assert.equal(server.command, process.execPath);
    }
  }
});
for (const provider of ['ollama', 'vllm', 'openai-compatible'] as const) {
  test(`${provider}: real HTTP tool-call roundtrip through MCP preserves BLOCK despite a misleading model answer`, async () => {
    const fixture = await project(); let count = 0;
    const http = await endpoint((req, res, body) => {
      assert.equal(req.url, provider === 'ollama' ? '/api/chat' : '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer test-token'); assert.equal(body.model, 'test-model');
      assert.equal(body.stream, false); assert.ok(Array.isArray(body.tools));
      const messages = body.messages as { role: string; content: string; tool_call_id?: string; tool_name?: string }[];
      count++;
      if (count === 1) {
        const call = { function: { name: 'run_gates', arguments: provider === 'ollama' ? {} : '{}' } };
        res.end(JSON.stringify(provider === 'ollama' ? { message: { content: '', tool_calls: [call] } }
          : { choices: [{ message: { content: null, tool_calls: [{ id: 't1', type: 'function', ...call }] } }] }));
      } else {
        const result = messages.find(m => m.role === 'tool'); assert.ok(result);
        assert.equal(JSON.parse(result.content).decision, 'BLOCK');
        if (provider === 'ollama') assert.equal(result.tool_name, 'run_gates'); else assert.equal(result.tool_call_id, 't1');
        res.end(JSON.stringify(provider === 'ollama' ? { message: { content: 'Everything passed!' } }
          : { choices: [{ message: { content: 'Everything passed!' } }] }));
      }
    });
    try {
      const result = await askModel({ provider, model: 'test-model', prompt: 'Check the project', apiKey: 'test-token',
        baseUrl: http.url + (provider === 'ollama' ? '' : '/v1') }, fixture.host, new AbortController().signal);
      assert.equal(count, 2); assert.equal(result.decision, 'BLOCK'); assert.equal(result.run.gates[0]?.id, 'test');
      assert.match(result.run.gates[0]!.outputTail, /gate-output/); assert.equal(result.toolCalls[0]?.name, 'run_gates');
    } finally { await http.close(); await fixture.close(); }
  });
}
test('a model cannot produce a verified PASS without actually running a gate', async () => {
  const fixture = await project(); const http = await endpoint((_req, res) => res.end(JSON.stringify({ message: { content: 'PASS' } })));
  try {
    await assert.rejects(askModel({ provider: 'ollama', model: 'test', prompt: 'Check', baseUrl: http.url }, fixture.host, new AbortController().signal), /without a verified/);
  } finally { await http.close(); await fixture.close(); }
});
test('unknown model tools are not executed and repeated calls are bounded', async () => {
  const fixture = await project('true'); let calls = 0;
  const host: ToolHost = { ...fixture.host, async callTool() { calls++; throw new Error('Must not execute'); } };
  const http = await endpoint((_req, res) => res.end(JSON.stringify({ choices: [{ message: { tool_calls: [
    { id: 'a', type: 'function', function: { name: 'shell', arguments: '{"command":"touch unsafe"}' } },
  ] } }] })));
  try {
    await assert.rejects(askModel({ provider: 'vllm', model: 'test', prompt: 'Check', baseUrl: http.url + '/v1', maxTurns: 2 }, host, new AbortController().signal), /exceeded 2 turns/);
    assert.equal(calls, 0);
  } finally { await http.close(); await fixture.close(); }
});
test('provider errors and timeouts are explicit; no credentials in a URL or redirect', async () => {
  for (const provider of ['ollama', 'vllm', 'openai-compatible'] as Provider[]) assert.throws(() => modelEndpoint(provider, 'https://user:secret@example.com'));
  assert.throws(() => modelEndpoint('openai-compatible'), /requires --base-url/);
  const fixture = await project();
  for (const scenario of ['error', 'malformed', 'timeout', 'redirect']) {
    const http = await endpoint((_req, res) => {
      if (scenario === 'error') { res.writeHead(503); res.end('unavailable'); }
      if (scenario === 'malformed') res.end('not-json');
      if (scenario === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/credentials' }); res.end(); }
    });
    try {
      await assert.rejects(askModel({ provider: 'ollama', model: 'test', prompt: 'Check', baseUrl: http.url, timeoutMs: 100 }, fixture.host, new AbortController().signal));
    } finally { await http.close(); }
  }
  await fixture.close();
});
test('CLI connect emits native config without changing project files; inspect replays a saved run', async () => {
  const { spawn } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const { readFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'qg-cli-integration-'));
  const config = join(directory, 'project.json');
  const original = JSON.stringify({ schemaVersion: 1, gates: [{ id: 'check', run: 'echo run >> marker; exit 1' }] });
  await writeFile(config, original);
  const cli = (args: string[]) => new Promise<{ code: number | null; stdout: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('packages/cli/src/index.ts'), ...args, '--config', config]);
    let stdout = ''; child.stdout.on('data', c => { stdout += c; });
    child.once('error', reject); child.once('close', code => resolveResult({ code, stdout }));
  });
  try {
    const snippet = await cli(['connect', '--client', 'cursor', '--json']);
    assert.equal(snippet.code, 0); assert.equal(JSON.parse(snippet.stdout).filename, '.cursor/mcp.json');
    assert.equal(await readFile(config, 'utf8'), original);
    const run = await cli(['run', '--json']); const record = JSON.parse(run.stdout); assert.equal(run.code, 1);
    const replay = await cli(['inspect', record.runId, '--json']); assert.equal(replay.code, 1);
    assert.equal(JSON.parse(replay.stdout).runId, record.runId);
    assert.equal(await readFile(join(directory, 'marker'), 'utf8'), 'run\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('model protocol rejects oversized responses, missing bodies, duplicate IDs and malformed arguments', async () => {
  const fixture = await project();
  for (const scenario of ['oversize', 'empty', 'duplicate', 'arguments']) {
    const http = await endpoint((_req, res) => {
      if (scenario === 'oversize') { res.end('x'.repeat(1000001)); return; }
      if (scenario === 'empty') { res.writeHead(204); res.end(); return; }
      const call = { id: 'duplicate', type: 'function', function: { name: 'run_gates', arguments: scenario === 'arguments' ? '[' : '{}' } };
      res.end(JSON.stringify({ choices: [{ message: { tool_calls: scenario === 'duplicate' ? [call, call] : [call] } }] }));
    });
    try {
      await assert.rejects(askModel({ provider: 'vllm', model: 'test', prompt: 'Check', baseUrl: http.url }, fixture.host, new AbortController().signal),
        scenario === 'oversize' ? /1 MB/ : scenario === 'empty' ? /no response body/ : scenario === 'duplicate' ? /duplicate/ : /JSON|Unexpected/);
    } finally { await http.close(); }
  }
  await assert.rejects(askModel({ provider: 'ollama', model: 'test', prompt: 'Check' }, {
    ...fixture.host, async listTools() { return { tools: [] }; },
  }, new AbortController().signal), /unavailable/);
  assert.equal(modelEndpoint('ollama'), 'http://127.0.0.1:11434/api/chat');
  assert.equal(modelEndpoint('vllm'), 'http://127.0.0.1:8000/v1/chat/completions');
  await fixture.close();
});
test('a later failed run invalidates an earlier PASS; missing answer content does not change the verified verdict', async () => {
  const fixture = await project('true');
  for (const failLater of [true, false]) {
    let turn = 0; let runs = 0;
    const host: ToolHost = { ...fixture.host, async callTool(name, args, signal) {
      runs++; return runs > 1 ? { error: 'second run failed' } : fixture.host.callTool(name, args, signal);
    } };
    const http = await endpoint((_req, res) => {
      turn++;
      res.end(JSON.stringify(turn <= (failLater ? 2 : 1)
        ? { message: { tool_calls: [{ function: { name: 'run_gates', arguments: {} } }] } } : { message: {} }));
    });
    try {
      const pending = askModel({ provider: 'ollama', model: 'test', prompt: 'Check', baseUrl: http.url }, host, new AbortController().signal);
      if (failLater) await assert.rejects(pending, /without a verified/);
      else { const result = await pending; assert.equal(result.decision, 'PASS'); assert.equal(result.answer, ''); }
    } finally { await http.close(); }
  }
  await fixture.close();
});
