import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { printRun } from '../packages/cli/src/output.js';
import { configSchema } from '../packages/protocol/src/index.js';
import { run } from '../packages/core/src/index.js';
import { jsonReporter } from '../packages/plugins/reporter-json/src/index.js';
import { connectTools } from '../packages/model-client/src/mcp-host.js';

const entry = resolve('packages/cli/src/index.ts');
function cli(args: string[], cwd = process.cwd()) {
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), entry, ...args], {
    cwd, env: { ...process.env, CHROME_PATH: '/no-such-chrome' },
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
}
test('CLI help, defaults, invalid command-specific options and text errors are explicit', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qg-cli-extra-'));
  try {
    assert.match((await cli([], cwd)).stdout, /Usage:/);
    assert.ok(JSON.parse((await cli(['--help', '--json'], cwd)).stdout).help);
    assert.match((await cli(['init'], cwd)).stdout, /Created/);
    assert.match((await cli(['run'], cwd)).stdout, /no-such-chrome/);
    assert.match((await cli(['unknown'], cwd)).stderr, /Unknown command/);
    for (const args of [['run', '--config', 'a', '--config', 'b'], ['run', '--client', 'cursor'], ['init', '--gate', 'lint'],
      ['inspect', 'a', 'b'], ['mcp', 'extra'], ['connect', 'extra'], ['ask', 'extra'], ['connect'], ['ask'],
      ['ask', '--provider', 'ollama', '--model', 'test', '--prompt', 'check', '--api-key-env', 'QG_MISSING_KEY_12345']]) {
      const result = await cli([...args, '--json'], cwd); assert.equal(result.code, 2, args.join(' '));
      assert.equal(result.stderr, ''); assert.equal(JSON.parse(result.stdout).execution, 'error');
    }
    assert.ok(JSON.parse((await cli(['connect', '--client', 'cursor'], cwd)).stdout).mcpServers);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
test('text output includes findings, audit evidence, tool errors and report failures', async () => {
  const result = await run(configSchema.parse({ schemaVersion: 1, gates: [{ id: 'lint', run: 'fake' }],
    urls: ['http://fixture'], thresholds: { performance: 100, accessibility: 100, seo: 100, 'best-practices': 100 } }), {
    gate: { id: 'gate', kind: 'gate', apiVersion: 1, async run() { return { exitCode: 1, output: 'failure', error: 'bad tool',
      findings: [{ gateId: 'lint', severity: 'error', file: 'a.ts', line: 2, ruleId: 'rule', message: 'fix' },
        { gateId: 'lint', severity: 'warning', message: 'warning' }] }; } },
    audit: { id: 'audit', kind: 'audit', apiVersion: 1, async audit() { return { scores: {}, raw: {} }; } },
    storage: { id: 'storage', kind: 'storage', apiVersion: 1, async createRun() { return '/run'; }, async write(_, name) {
      if (name === 'report.json') throw Error('disk full'); return '/evidence';
    } }, reporter: jsonReporter,
  });
  const log = mock.method(console, 'log', () => {}); const error = mock.method(console, 'error', () => {});
  try {
    printRun(result);
    const output = log.mock.calls.map(c => c.arguments.join(' ')).join('\n');
    assert.match(output, /a.ts:2 rule fix/); assert.match(output, /bad tool/); assert.match(output, /Scores:/); assert.match(output, /Evidence:/);
    assert.match(error.mock.calls.flatMap(c => c.arguments).join(), /disk full/);
  } finally { log.mock.restore(); error.mock.restore(); }
});
test('model bridge and ask CLI run through actual stdio MCP; model prose cannot overwrite BLOCK', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qg-ask-cli-')); let request = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    request++;
    res.end(JSON.stringify(request % 2 ? { message: { tool_calls: [{ function: { name: 'run_gates', arguments: {} } }] } }
      : { message: { content: 'Looks good!' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const config = join(cwd, 'project.json');
    await writeFile(config, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'test', run: 'echo failing; exit 1' }] }));
    const connection = await connectTools(entry, config);
    try {
      assert.equal((await connection.host.listTools()).tools.length, 3);
      assert.ok(await connection.host.callTool('list_gates', {}, new AbortController().signal));
    } finally { await connection.close(); }
    for (const json of [true, false]) {
      const result = await cli(['ask', '--provider', 'ollama', '--model', 'test', '--prompt', 'check',
        '--base-url', `http://127.0.0.1:${address.port}`, '--config', config, '--max-turns', '3', '--timeout-ms', '3000', ...(json ? ['--json'] : [])]);
      assert.equal(result.code, 1, result.stderr); assert.equal(result.stderr, '');
      if (json) assert.equal(JSON.parse(result.stdout).decision, 'BLOCK'); else assert.match(result.stdout, /Verified decision: BLOCK/);
    }
    await assert.rejects(connectTools(entry, join(cwd, 'missing.json')), /Cannot connect/);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
});
