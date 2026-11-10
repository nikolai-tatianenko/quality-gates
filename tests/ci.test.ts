import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { renderMarkdown, updateDescription, publishDescription, readReport, type ForgeOptions } from '../packages/ci/src/index.js';
import { markers } from '../packages/ci/src/description.js';
import type { RunResult } from '../packages/protocol/src/index.js';
const head = 'a'.repeat(40); const runId = '12345678-1234-4123-8123-123456789012';
const run: RunResult = { schemaVersion: 1, runId, startedAt: '2026-10-30T20:00:00.000Z', finishedAt: '2026-10-30T20:01:00.000Z',
  execution: 'completed', decision: 'BLOCK', steps: [], gates: [{ id: 'lint', command: 'lint', execution: 'completed', decision: 'BLOCK', exitCode: 1, durationMs: 10,
    outputTail: 'failed @someone <script>bad</script>', errors: ['tool error'], reportPath: 'lint.json', findings: [], artifacts: [] }],
  results: [{ url: 'https://example.com', execution: 'error', decision: 'BLOCK', scores: {}, violations: ['missing metric'], errors: ['offline'], evidencePath: 'audit.json' }],
  errors: ['write failed'], findings: [{ gateId: 'lint', file: 'src/a.ts', line: 2, severity: 'error', message: '<!-- qualitygate:auto:end --> @someone | [link](x)', ruleId: 'rule', evidencePath: 'lint.json' },
    { gateId: 'test', severity: 'warning', message: 'warning' }], reportPath: 'report.json' };
const metadata = { head, runId, finishedAt: run.finishedAt };
const exec = promisify(execFile);

test('Markdown summarizes decisions, execution errors, findings, output and evidence without injected markers or mentions', () => {
  const text = renderMarkdown(run); assert.match(text, /QualityGate: BLOCK/); assert.match(text, /src\/a.ts:2/);
  assert.match(text, /lint.json/); assert.match(text, /audit.json/); assert.match(text, /missing metric/); assert.match(text, /write failed/);
  assert.doesNotMatch(text, /<!-- qualitygate:|@someone|<script>/); assert.match(text, /&#64;someone/);
  assert.match(renderMarkdown({ ...run, execution: 'interrupted' }), /INTERRUPTED/);
  assert.match(renderMarkdown(run, 500), /Report truncated/); assert.ok(Buffer.byteLength(renderMarkdown(run, 500)) <= 500);
  assert.match(renderMarkdown({ ...run, gates: [{ ...run.gates[0]!, reportPath: undefined, evidencePath: 'log.txt' }] }), /log.txt/);
  assert.match(renderMarkdown({ ...run, gates: [{ ...run.gates[0]!, reportPath: undefined, outputTail: '', evidencePath: undefined }], findings: [], results: [] }), /Findings \(0\)/);
});

test('PR migration preserves untagged prose; later runs replace only the automated block', () => {
  for (const human of ['', 'Original text without newline', 'Manual description\r\n\r\n- manual detail\r\n']) {
    const first = updateDescription(human, '## Result\nBLOCK', metadata);
    assert.ok(first.body.includes(human)); assert.ok(first.body.indexOf(markers.manualEnd) < first.body.indexOf(markers.autoStart));
    const second = updateDescription(first.body, '## Result\nPASS', { ...metadata, finishedAt: '2026-10-30T20:02:00.000Z' });
    assert.equal(second.body.split(markers.autoStart).length, 2); assert.doesNotMatch(second.body, /\nBLOCK/);
    assert.equal(second.body.slice(0, second.body.indexOf(markers.autoStart)), first.body.slice(0, first.body.indexOf(markers.autoStart)));
    assert.equal(updateDescription(second.body, '## Result\nPASS', { ...metadata, finishedAt: '2026-10-30T20:02:00.000Z' }).changed, false);
    assert.equal(updateDescription(second.body, 'old', metadata).reason, 'older-run');
  }
  const manual = `${markers.manualStart}\nKeep exactly\n${markers.manualEnd}\n`;
  assert.ok(updateDescription(manual, 'new', metadata).body.startsWith(manual));
  const unmarked = `Before\n${markers.autoStart}\nold generated\n${markers.autoEnd}\nAfter`;
  const migrated = updateDescription(unmarked, 'new', metadata).body; assert.match(migrated, /Before/); assert.match(migrated, /After/); assert.doesNotMatch(migrated, /old generated/);
  const fenced = `Example:\n\`\`\`md\n${markers.autoStart}\n\`\`\`example\n${markers.autoEnd}\n\`\`\`\n`;
  assert.ok(updateDescription(fenced, 'new', metadata).body.includes(fenced));
  assert.ok(updateDescription(`~~~\n${markers.autoStart}\n~~~\n`, 'new', metadata).body.includes(markers.manualStart));
  for (const bad of [markers.autoStart, markers.manualEnd, `${markers.autoEnd}\n${markers.autoStart}`, `${markers.manualStart}\n${markers.manualEnd}\n${markers.manualStart}\n${markers.manualEnd}`,
    `${markers.autoStart}\n${markers.manualStart}\n${markers.autoEnd}\n${markers.manualEnd}`, '```md\nunclosed']) assert.throws(() => updateDescription(bad, 'new', metadata));
  assert.throws(() => updateDescription('human', markers.autoStart, metadata), /reserved/);
  assert.throws(() => updateDescription('x'.repeat(32000), 'report', metadata), /not truncated/);
  assert.equal(updateDescription(`${markers.autoStart}\n<!-- qualitygate:metadata invalid -->\n${markers.autoEnd}`, 'new', metadata).reason, 'updated');
  assert.equal(updateDescription(`${markers.autoStart}\n<!-- qualitygate:metadata {"head":1} -->\n${markers.autoEnd}`, 'new', metadata).reason, 'updated');
});

function payload(provider: ForgeOptions['provider'], body: string | null, sha = head, open = true) {
  if (provider === 'github') return { body, head: { sha }, state: open ? 'open' : 'closed' };
  if (provider === 'gitlab') return { description: body, sha, state: open ? 'opened' : 'closed' };
  return { description: body, source: { commit: { hash: sha } }, state: open ? 'OPEN' : 'MERGED' };
}
test('forge adapters preview and publish only descriptions, preserve intervening edits, skip stale heads and older runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-ci-')); const path = join(dir, 'run.json'); await writeFile(path, JSON.stringify(run));
  process.env.QG_FORGE_TOKEN = 'fixture-token'; let response: () => Response; const calls: { url: string; options: RequestInit }[] = [];
  const fetched = mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), options: options! }); assert.equal(options!.redirect, 'error');
    assert.equal((options!.headers as Record<string, string>).Authorization, 'Bearer fixture-token'); return response();
  });
  try {
    for (const provider of ['github', 'gitlab', 'bitbucket'] as const) {
      const repository = provider === 'gitlab' ? 'org/group/repo' : 'owner/repo';
      const options = { provider, repository, number: 7, head, tokenEnv: 'QG_FORGE_TOKEN', headRepository: repository };
      response = () => Response.json(payload(provider, 'Human text')); calls.length = 0;
      const dry = await publishDescription(options, path, new AbortController().signal); assert.equal(dry.write, false); assert.equal(calls.length, 1);
      assert.match(calls[0]!.url, provider === 'gitlab' ? /projects\/org%2Fgroup%2Frepo\/merge_requests\/7/ : /\/7$/);
      calls.length = 0; let gets = 0;
      response = () => calls.at(-1)!.options.method === 'GET' ? Response.json(payload(provider, ++gets === 1 ? 'Before edit' : 'After edit')) : Response.json({});
      const sent = await publishDescription({ ...options, write: true }, path, new AbortController().signal);
      assert.equal(sent.write, true); const writes = calls.filter(call => call.options.method !== 'GET'); assert.equal(writes.length, 1);
      const update = JSON.parse(writes[0]!.options.body as string); assert.deepEqual(Object.keys(update), [provider === 'github' ? 'body' : 'description']);
      assert.match(JSON.stringify(update), /After edit/); assert.doesNotMatch(JSON.stringify(update), /Before edit/);
      assert.match(JSON.stringify(update), /Source commit:/);
      assert.equal(writes[0]!.options.method, provider === 'github' ? 'PATCH' : 'PUT');
      response = () => Response.json(payload(provider, null, 'b'.repeat(40))); assert.equal((await publishDescription({ ...options, write: true }, path, new AbortController().signal)).reason, 'stale-head');
      response = () => Response.json(payload(provider, null, head, false)); assert.equal((await publishDescription(options, path, new AbortController().signal)).reason, 'closed');
      response = () => Response.json(payload(provider, updateDescription('Human', 'newer', { ...metadata, finishedAt: '2026-10-30T22:00:00.000Z' }).body));
      assert.equal((await publishDescription({ ...options, write: true }, path, new AbortController().signal)).reason, 'older-run');
    }
    const options = { provider: 'github', repository: 'owner/repo', number: 1, head, tokenEnv: 'QG_FORGE_TOKEN', write: true, headRepository: 'owner/repo' };
    let edit = 0; response = () => Response.json(payload('github', `Edit ${++edit}`)); await assert.rejects(publishDescription(options, path, new AbortController().signal), /serialized/);
    for (const value of [new Response('secret', { status: 403 }), new Response('x'.repeat(1000001)), new Response('bad JSON'), Response.json({})]) {
      response = () => value; await assert.rejects(publishDescription(options, path, new AbortController().signal));
    }
    response = () => Response.json(payload('github', 'Human text')); calls.length = 0;
    await assert.rejects(publishDescription({ ...options, write: true, headRepository: undefined }, path, new AbortController().signal), /--head-repository/);
    await assert.rejects(publishDescription({ ...options, write: true, headRepository: 'fork/repo' }, path, new AbortController().signal), /fork/); assert.equal(calls.length, 0);
    for (const apiUrl of ['http://remote.test', 'https://user:password@host', 'https://host/?token=x', 'file:///tmp']) await assert.rejects(publishDescription({ ...options, apiUrl }, path, new AbortController().signal), /HTTPS/);
    await assert.rejects(publishDescription({ ...options, repository: 'one', headRepository: 'one' }, path, new AbortController().signal), /owner\/name/);
    await assert.rejects(publishDescription({ ...options, repository: '../repo', headRepository: 'x/y' }, path, new AbortController().signal));
    delete process.env.QG_FORGE_TOKEN; await assert.rejects(publishDescription(options, path, new AbortController().signal), /Missing/);
    await writeFile(path, 'x'.repeat(5000001)); await assert.rejects(readReport(path), /5 MB/);
    await writeFile(path, '{}'); await assert.rejects(readReport(path));
  } finally { fetched.mock.restore(); delete process.env.QG_FORGE_TOKEN; await rm(dir, { recursive: true, force: true }); }
});

test('CLI renders reports and updates a fixture PR through real HTTP; JSON output and dry-run/write boundaries hold', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-ci-cli-')); const input = join(dir, 'run.json'); await writeFile(input, JSON.stringify(run));
  let body = 'Handwritten PR'; let writes = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'PATCH') { let raw = ''; for await (const chunk of request) raw += chunk; body = JSON.parse(raw).body; writes++; }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(payload('github', body)));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const entry = resolve(process.env.QUALITYGATE_CLI ?? 'packages/cli/src/index.ts');
  const cli = (args: string[]) => exec(process.execPath, [...(entry.endsWith('.ts') ? ['--import', resolve('node_modules/tsx/dist/loader.mjs')] : []), entry, ...args], { env: { ...process.env, QG_CLI_TOKEN: 'fixture' } });
  try {
    assert.match((await cli(['report', '--input', input])).stdout, /QualityGate: BLOCK/);
    assert.ok(JSON.parse((await cli(['report', '--input', input, '--json'])).stdout).markdown);
    const output = join(dir, 'report.md'); await cli(['report', '--input', input, '--output', output]); assert.match(await readFile(output, 'utf8'), /Findings/);
    assert.ok(JSON.parse((await cli(['report', '--input', input, '--output', output, '--json'])).stdout).output);
    const args = ['pr', '--provider', 'github', '--repository', 'owner/repo', '--number', '1', '--head', head, '--input', input,
      '--api-url', `http://127.0.0.1:${address.port}`, '--token-env', 'QG_CLI_TOKEN'];
    await assert.rejects(cli([...args, '--write']), /--head-repository/); args.push('--head-repository', 'owner/repo');
    assert.match((await cli(args)).stdout, /Handwritten PR/); assert.equal(writes, 0);
    assert.equal(JSON.parse((await cli([...args, '--write', '--json'])).stdout).write, true); assert.equal(writes, 1);
    assert.match((await cli([...args, '--write'])).stdout, /Handwritten PR/); assert.equal(writes, 1);
    await writeFile(input, JSON.stringify({ ...run, finishedAt: '2026-10-30T20:02:00.000Z' })); assert.match((await cli([...args, '--write'])).stdout, /PR: updated/); assert.equal(writes, 2);
    for (const invalid of [['report'], ['report', 'extra', '--input', input], ['pr', '--input', input], ['run', '--write'], ['report', '--input', input, '--limit', '1']]) await assert.rejects(cli([...invalid, '--json']));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
