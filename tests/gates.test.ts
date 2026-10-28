import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { cliOutputSchema, configSchema, exitCode, runResultSchema } from '../packages/protocol/src/index.js';
import { run } from '../packages/core/src/index.js';
import { commandPlugin } from '../packages/plugins/command/src/index.js';
import { filesystemPlugin } from '../packages/plugins/storage-fs/src/index.js';
import { jsonReporter } from '../packages/plugins/reporter-json/src/index.js';
import { createServer, summarize } from '../packages/mcp/src/index.js';
const entry = resolve('packages/cli/src/index.ts');
async function project(gates: { id: string; run: string; timeoutMs?: number }[]) {
  const dir = await mkdtemp(join(tmpdir(), 'qg-gates-'));
  const config = { schemaVersion: 1, gates, outputDir: 'out' };
  await writeFile(join(dir, '.qualitygate.yml'), JSON.stringify(config));
  return { dir };
}
function execute(dir: string, gates: { id: string; run: string; timeoutMs?: number }[], signal?: AbortSignal, only?: string[]) {
  const config = configSchema.parse({ schemaVersion: 1, gates, outputDir: join(dir, 'out') });
  return run(config, { gate: commandPlugin(dir), storage: filesystemPlugin(config.outputDir), reporter: jsonReporter }, signal, only);
}
/** Runs the CLI from the repo (where tsx resolves) against the project's config file. */
function cli(dir: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((res, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args, '--config', join(dir, '.qualitygate.yml')]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.once('error', reject); child.once('close', code => res({ code, stdout, stderr }));
  });
}
test('config accepts gates without URLs and rejects empty, duplicate, unsafe or threshold-less setups', () => {
  assert.ok(configSchema.safeParse({ schemaVersion: 1, gates: [{ id: 'lint', run: 'true' }] }).success);
  const bad = [
    { schemaVersion: 1 },
    { schemaVersion: 1, urls: ['https://example.com'] },
    { schemaVersion: 1, gates: [{ id: 'a', run: 'true' }, { id: 'A', run: 'true' }] },
    { schemaVersion: 1, gates: [{ id: '../x', run: 'true' }] },
    { schemaVersion: 1, gates: [{ id: 'a', run: '' }] },
    { schemaVersion: 1, gates: [{ id: 'a', run: 'true', extra: 1 }] },
  ];
  for (const input of bad) assert.equal(configSchema.safeParse(input).success, false, JSON.stringify(input));
});
test('command gates PASS on exit 0, BLOCK on non-zero with output and evidence, and run in order', async () => {
  const { dir } = await project([]);
  try {
    const result = await execute(dir, [
      { id: 'ok', run: 'echo fine' },
      { id: 'fails', run: 'echo broken-thing >&2; exit 3' },
      { id: 'missing', run: 'qualitygate-no-such-command' },
    ]);
    assert.deepEqual(result.gates.map(g => [g.id, g.decision, g.exitCode]), [['ok', 'PASS', 0], ['fails', 'BLOCK', 3], ['missing', 'BLOCK', 127]]);
    assert.match(result.gates[1]!.outputTail, /broken-thing/);
    assert.equal(result.decision, 'BLOCK'); assert.equal(exitCode(result), 1);
    assert.equal(await readFile(result.gates[1]!.evidencePath!, 'utf8'), 'broken-thing\n');
    assert.ok(runResultSchema.safeParse(JSON.parse(await readFile(result.reportPath!, 'utf8'))).success);
    const passing = await execute(dir, [{ id: 'ok', run: 'true' }]);
    assert.equal(passing.decision, 'PASS'); assert.equal(exitCode(passing), 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('gate commands run in the config directory', async () => {
  const { dir } = await project([]);
  try {
    await writeFile(join(dir, 'marker.txt'), 'here');
    const result = await execute(dir, [{ id: 'cwd', run: 'test -f marker.txt' }]);
    assert.equal(result.gates[0]?.decision, 'PASS');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('a hanging gate times out as an error and its whole process tree is killed', async () => {
  const { dir } = await project([]);
  try {
    const pidFile = join(dir, 'child.pid');
    const started = Date.now();
    const result = await execute(dir, [{ id: 'hang', run: `sleep 30 & echo $! > ${pidFile}; wait`, timeoutMs: 400 }]);
    assert.ok(Date.now() - started < 10000);
    assert.equal(result.gates[0]?.execution, 'error'); assert.equal(result.gates[0]?.decision, 'BLOCK');
    assert.match(result.gates[0]!.errors.join(), /timed out after 400ms/); assert.equal(exitCode(result), 2);
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('interruption stops the running gate, skips the rest and exits 130', async () => {
  const { dir } = await project([]);
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await execute(dir, [{ id: 'hang', run: 'sleep 30' }, { id: 'later', run: 'true' }], controller.signal);
    assert.equal(result.gates[0]?.execution, 'interrupted'); assert.equal(result.gates[1]?.execution, 'skipped');
    assert.equal(result.gates[1]?.decision, 'BLOCK'); assert.equal(exitCode(result), 130);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('only runs the selected gates and rejects unknown ids', async () => {
  const { dir } = await project([]);
  try {
    const gates = [{ id: 'a', run: 'true' }, { id: 'b', run: 'exit 1' }];
    const result = await execute(dir, gates, undefined, ['a']);
    assert.deepEqual(result.gates.map(g => g.id), ['a']); assert.equal(result.decision, 'PASS');
    await assert.rejects(execute(dir, gates, undefined, ['nope']), /Unknown gate: nope/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('CLI runs gates: text and JSON output, --gate filter and exit codes', async () => {
  const { dir } = await project([{ id: 'good', run: 'echo hi' }, { id: 'bad', run: 'echo nope; exit 1' }]);
  try {
    const failing = await cli(dir, ['run', '--json']);
    assert.equal(failing.code, 1); assert.equal(failing.stderr, '');
    const parsed = cliOutputSchema.parse(JSON.parse(failing.stdout));
    assert.ok('gates' in parsed && parsed.gates.length === 2);
    const text = await cli(dir, ['run']);
    assert.equal(text.code, 1); assert.match(text.stdout, /PASS gate good/); assert.match(text.stdout, /BLOCK gate bad[\s\S]*\| nope/);
    const filtered = await cli(dir, ['run', '--gate', 'good']);
    assert.equal(filtered.code, 0);
    const unknown = await cli(dir, ['run', '--gate', 'zzz', '--json']);
    assert.equal(unknown.code, 2); assert.match(unknown.stdout, /Unknown gate: zzz/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
async function mcpClient(dir: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(join(dir, '.qualitygate.yml'));
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const content = response.content as { type: string; text: string }[];
    return { isError: Boolean(response.isError), body: JSON.parse(content[0]!.text) };
  };
  return { client, call };
}
test('MCP exposes only list_gates, run_gates and get_run; none accepts a command or path', async () => {
  const { dir } = await project([{ id: 'good', run: 'true' }]);
  try {
    const { client } = await mcpClient(dir);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['get_run', 'list_gates', 'run_gates']);
    for (const tool of tools) {
      const properties = Object.keys((tool.inputSchema.properties ?? {}) as object);
      assert.ok(properties.every(p => ['gates', 'runId'].includes(p)), `${tool.name}: ${properties}`);
    }
    await client.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('MCP run_gates returns the same verdict as the CLI, trims passing output and get_run replays it', async () => {
  const { dir } = await project([{ id: 'good', run: 'echo secret-pass-log' }, { id: 'bad', run: 'echo why-it-failed; exit 4' }]);
  try {
    const { client, call } = await mcpClient(dir);
    const listed = await call('list_gates');
    assert.deepEqual(listed.body.gates.map((g: { id: string }) => g.id), ['good', 'bad']);
    const ran = await call('run_gates');
    assert.equal(ran.body.decision, 'BLOCK'); assert.equal(ran.isError, false);
    assert.equal(ran.body.gates[0].outputTail, ''); assert.match(ran.body.gates[1].outputTail, /why-it-failed/);
    const cliRun = JSON.parse((await cli(dir, ['run', '--json'])).stdout);
    assert.deepEqual(cliRun.gates.map((g: { id: string; decision: string }) => [g.id, g.decision]),
      ran.body.gates.map((g: { id: string; decision: string }) => [g.id, g.decision]));
    const latest = await call('get_run');
    assert.equal(latest.body.runId, cliRun.runId);
    const byId = await call('get_run', { runId: ran.body.runId });
    assert.equal(byId.body.runId, ran.body.runId);
    const only = await call('run_gates', { gates: ['good'] });
    assert.equal(only.body.decision, 'PASS'); assert.equal(only.body.gates.length, 1);
    assert.equal(summarize(runResultSchema.parse(cliRun)).gates[0]?.outputTail, '');
    assert.ok((await readdir(join(dir, 'out'))).length >= 3);
    await client.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('MCP reports bad input as errors: unknown gate, traversal run id, empty history', async () => {
  const { dir } = await project([{ id: 'good', run: 'true' }]);
  try {
    const { client, call } = await mcpClient(dir);
    const unknown = await call('run_gates', { gates: ['nope'] });
    assert.equal(unknown.isError, true); assert.match(unknown.body.error, /Unknown gate: nope/);
    const traversal = await call('get_run', { runId: '../../etc/passwd' });
    assert.equal(traversal.isError, true); assert.match(traversal.body.error, /Invalid run ID/);
    const empty = await call('get_run');
    assert.equal(empty.isError, true); assert.match(empty.body.error, /No runs found/);
    await client.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('`qualitygate mcp` serves over real stdio, runs a gate and shuts down quietly when the client leaves', async () => {
  const { dir } = await project([{ id: 'good', run: 'echo ok' }]);
  try {
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--import', 'tsx', entry, 'mcp', '--config', join(dir, '.qualitygate.yml')], stderr: 'pipe',
    });
    let stderr = '';
    const client = new Client({ name: 'stdio', version: '0.0.0' });
    await client.connect(transport);
    transport.stderr?.on('data', c => { stderr += c; });
    const child = (transport as unknown as { _process: import('node:child_process').ChildProcess })._process;
    const exited = new Promise<void>(res => child.once('exit', () => res()));
    const response = await client.callTool({ name: 'run_gates', arguments: {} });
    assert.equal(JSON.parse((response.content as { text: string }[])[0]!.text).decision, 'PASS');
    await client.close();
    await exited;
    assert.equal(child.exitCode, 0); assert.equal(stderr, '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
