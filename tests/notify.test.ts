import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { publishStatus, publishComment, notifySlack } from '../packages/ci/src/index.js';
import { verdict, statusPayload, commentBody, slackMessage, slackTarget, commentMarker, reportUrlSchema } from '../packages/ci/src/notify.js';
import type { RunResult } from '../packages/protocol/src/index.js';
const head = 'a'.repeat(40); const runId = '12345678-1234-4123-8123-123456789012'; const exec = promisify(execFile);
const gate = (id: string, decision: 'PASS' | 'BLOCK') => ({ id, command: id, execution: 'completed' as const, decision, exitCode: decision === 'PASS' ? 0 : 1, durationMs: 1, outputTail: 'token=SECRET', errors: ['SECRET error'], findings: [], artifacts: [] });
const base: RunResult = { schemaVersion: 1, runId, startedAt: '2026-10-30T20:00:00.000Z', finishedAt: '2026-10-30T20:01:00.000Z', execution: 'completed', decision: 'BLOCK', steps: [],
  gates: [gate('lint', 'BLOCK'), gate('test', 'PASS')], results: [{ url: 'https://example.com/?token=SECRET', execution: 'completed', decision: 'BLOCK', scores: {}, violations: [], errors: [] }], errors: ['SECRET run error'], findings: [] };
const pass: RunResult = { ...base, decision: 'PASS', gates: [gate('test', 'PASS')], results: [], errors: [] };
const many: RunResult = { ...base, gates: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => gate(id, 'BLOCK')), results: [] };
const url = 'https://reports.example.com/run/1';

test('verdict maps run outcomes to status states without leaking tool output', () => {
  assert.deepEqual([verdict(pass).state, verdict(pass).label], ['success', 'PASS']);
  assert.deepEqual([verdict(base).state, verdict(base).label], ['failure', 'BLOCK']);
  assert.match(verdict(base).summary, /gates lint; 1 URL audit/); assert.match(verdict(many).summary, /\+2 more/);
  assert.deepEqual([verdict({ ...base, execution: 'error' }).state, verdict({ ...base, execution: 'error' }).label], ['error', 'ERROR']);
  assert.equal(verdict({ ...base, execution: 'interrupted' }).label, 'INTERRUPTED');
  assert.match(verdict({ ...base, execution: 'error' }).summary, /exit 2/);
  assert.doesNotMatch(JSON.stringify([verdict(base), statusPayload(base, url), slackMessage(base, url)]), /SECRET/);
  assert.equal(statusPayload(base).target_url, undefined); assert.equal(statusPayload(base, url).target_url, url);
  assert.ok(statusPayload({ ...many, gates: many.gates.map(item => ({ ...item, id: 'x'.repeat(40) })) }).description.length <= 140);
  assert.equal(reportUrlSchema.safeParse(url).success, true);
  for (const bad of ['http://x.test/a', 'https://u:p@x.test/', 'nope']) assert.equal(reportUrlSchema.safeParse(bad).success, false);
});

test('comment body leads with the marker, escapes via the report and refuses reserved markers', () => {
  const metadata = { head, runId, finishedAt: base.finishedAt };
  assert.ok(commentBody('## R', metadata).startsWith(`${commentMarker}\n<!-- qualitygate:metadata `));
  assert.match(commentBody('## R', metadata, url), /\[Full report\]\(https:\/\/reports/);
  assert.doesNotMatch(commentBody('## R', metadata), /Full report/);
  assert.throws(() => commentBody('<!-- qualitygate:x -->', metadata), /reserved/);
});

test('slack message escapes control characters and slack targets must be HTTPS', () => {
  assert.equal(slackMessage({ ...base, gates: [gate('<a&b>', 'BLOCK')], results: [] }).text, 'QualityGate BLOCK: blocked: gates &lt;a&amp;b&gt;');
  assert.match(slackMessage(base, url).text, /<https:\/\/reports.example.com\/run\/1\|Report>/);
  assert.equal(slackTarget('https://hooks.slack.com/services/T/B/X', 'W').hostname, 'hooks.slack.com');
  assert.throws(() => slackTarget(undefined, 'W'), /Missing Slack webhook environment variable: W/);
  for (const bad of ['http://hooks.slack.com/x', 'https://u:p@hooks.slack.com/x']) assert.throws(() => slackTarget(bad, 'W'), /HTTPS/);
  assert.throws(() => slackTarget('not a url', 'W'), /invalid/);
});

function harness() {
  const calls: { url: string; options: RequestInit }[] = []; const state = { respond: (_call: { url: string; options: RequestInit }) => Response.json({}) };
  const fetched = mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => { const call = { url: String(input), options: options! }; calls.push(call); return state.respond(call); });
  return { calls, state, restore: () => fetched.mock.restore() };
}
const signal = () => new AbortController().signal;
const pr = (sha = head, open = true) => ({ body: '', head: { sha }, state: open ? 'open' : 'closed' });

test('commit status posts the verdict for the exact head only with --write, refuses forks and bad inputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-status-')); const path = join(dir, 'run.json'); await writeFile(path, JSON.stringify(base)); process.env.QG_T = 'tok';
  const h = harness(); const options = { repository: 'owner/repo', head, tokenEnv: 'QG_T', reportUrl: url, headRepository: 'owner/repo' };
  try {
    const dry = await publishStatus(options, path, signal()); assert.equal(dry.write, false); assert.equal(h.calls.length, 0); assert.equal(dry.payload.state, 'failure');
    const sent = await publishStatus({ ...options, write: true }, path, signal()); assert.equal(sent.write, true); assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.url, `https://api.github.com/repos/owner/repo/statuses/${head}`); assert.equal(h.calls[0]!.options.method, 'POST');
    assert.deepEqual(JSON.parse(h.calls[0]!.options.body as string), dry.payload);
    await assert.rejects(publishStatus({ ...options, headRepository: 'fork/repo', write: true }, path, signal()), /fork/); assert.equal(h.calls.length, 1);
    await assert.rejects(publishStatus({ ...options, reportUrl: 'http://x.test/' }, path, signal()), /HTTPS/);
    await assert.rejects(publishStatus({ ...options, repository: 'one', headRepository: 'one' }, path, signal()), /owner\/name/);
    await assert.rejects(publishStatus({ ...options, apiUrl: 'http://remote.test' }, path, signal()), /HTTPS/);
    h.state.respond = () => new Response('no', { status: 403 }); await assert.rejects(publishStatus({ ...options, write: true }, path, signal()), /HTTP 403/);
    await assert.rejects(publishStatus({ ...options, headRepository: undefined, write: true }, path, signal()), /--head-repository/);
    delete process.env.QG_T; await assert.rejects(publishStatus(options, path, signal()), /Missing/);
    process.env.QG_T = 'tok'; const noRepo = { repository: 'owner/repo', head }; delete process.env.GITHUB_TOKEN; await assert.rejects(publishStatus(noRepo, path, signal()), /GITHUB_TOKEN/);
  } finally { h.restore(); delete process.env.QG_T; await rm(dir, { recursive: true, force: true }); }
});

test('sticky comment creates one comment, updates in place, removes duplicates, skips stale/closed/older runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-comment-')); const path = join(dir, 'run.json'); await writeFile(path, JSON.stringify(base)); process.env.QG_T = 'tok';
  const h = harness(); const options = { provider: 'github' as const, repository: 'owner/repo', number: 3, head, tokenEnv: 'QG_T', headRepository: 'owner/repo' };
  type Comment = { id: number; body: string; user?: { login: string; type: string } };
  const bot = { login: 'github-actions[bot]', type: 'Bot' }; const stranger = { login: 'mallory', type: 'User' };
  let comments: Comment[] = [];
  h.state.respond = call => {
    if (call.url.includes('/pulls/')) return Response.json(pr());
    if (call.options.method === 'GET') { const page = Number(new URL(call.url).searchParams.get('page')); return Response.json((page === 1 ? comments.slice(0, 100) : comments.slice(100)).map(item => ({ user: bot, ...item }))); }
    return call.options.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({});
  };
  const writes = () => h.calls.filter(call => !['GET'].includes(call.options.method!));
  try {
    const dry = await publishComment(options, path, signal()); assert.equal(dry.write, false); assert.equal(dry.reason, 'created'); assert.ok(dry.body?.startsWith(commentMarker)); assert.equal(writes().length, 0);
    h.calls.length = 0; const created = await publishComment({ ...options, write: true, reportUrl: url }, path, signal());
    assert.equal(created.reason, 'created'); assert.equal(writes().length, 1); assert.equal(writes()[0]!.options.method, 'POST'); assert.match(writes()[0]!.url, /issues\/3\/comments$/);
    const posted = JSON.parse(writes()[0]!.options.body as string).body as string; assert.ok(posted.startsWith(commentMarker));
    // existing: a human comment, our comment (stale) and a duplicate of ours, paginated past 100 entries
    const stale = commentBody('old', { head, runId, finishedAt: '2026-10-30T19:00:00.000Z' });
    comments = [...Array.from({ length: 100 }, (_, id) => ({ id, body: 'human' })), { id: 500, body: stale }, { id: 501, body: stale }, { id: 502, body: `quoted ${commentMarker}` }];
    h.calls.length = 0; const updated = await publishComment({ ...options, write: true }, path, signal());
    assert.equal(updated.reason, 'updated'); assert.deepEqual(writes().map(call => [call.options.method, call.url.split('/').at(-1)]), [['PATCH', '500'], ['DELETE', '501']]);
    h.calls.length = 0; const preview = await publishComment(options, path, signal()); assert.equal(preview.write, false); assert.equal(writes().length, 0);
    comments = [{ id: 7, body: posted }]; h.calls.length = 0; const same = await publishComment({ ...options, write: true, reportUrl: url }, path, signal()); assert.equal(same.reason, 'unchanged'); assert.equal(writes().length, 0);
    comments = [{ id: 7, body: commentBody('newer', { head, runId, finishedAt: '2026-10-30T22:00:00.000Z' }) }];
    assert.equal((await publishComment({ ...options, write: true }, path, signal())).reason, 'older-run');
    comments.unshift({ id: 6, body: stale }); h.calls.length = 0;
    assert.equal((await publishComment({ ...options, write: true }, path, signal())).reason, 'older-run');
    assert.equal(writes().length, 0);
    const paginated = h.state.respond;
    h.state.respond = call => call.url.includes('/pulls/') ? Response.json(pr()) : Response.json(Array.from({ length: 100 }, (_, id) => ({ id, body: 'human' })));
    h.calls.length = 0;
    await assert.rejects(publishComment({ ...options, write: true }, path, signal()), /exceeds 1000/);
    assert.equal(writes().length, 0);
    h.state.respond = paginated;
    comments = [{ id: 7, body: `${commentMarker}\nno metadata` }]; assert.equal((await publishComment({ ...options, write: true }, path, signal())).reason, 'updated');
    comments = [{ id: 7, body: `${commentMarker}\n<!-- qualitygate:metadata ${JSON.stringify({ head: 'b'.repeat(40), runId, finishedAt: '2030-01-01T00:00:00.000Z' })} -->` }];
    assert.equal((await publishComment({ ...options, write: true }, path, signal())).reason, 'updated');
    // malformed or schema-invalid metadata is "not older": the comment is refreshed instead of failing the step
    for (const metadata of ['nope', '{"head":1}']) { comments = [{ id: 7, body: `${commentMarker}\n<!-- qualitygate:metadata ${metadata} -->` }]; assert.equal((await publishComment({ ...options, write: true }, path, signal())).reason, 'updated'); }
    // only the publisher's own (Bot) comments count: a stranger's marker comment cannot pin a stale result nor be deleted
    const forged = commentBody('forged', { head, runId, finishedAt: '2099-01-01T00:00:00.000Z' });
    comments = [{ id: 8, body: forged, user: stranger }, { id: 9, body: `${commentMarker}\n<!-- qualitygate:metadata nope -->`, user: stranger }]; h.calls.length = 0;
    assert.equal((await publishComment({ ...options, write: true }, path, signal())).reason, 'created'); assert.deepEqual(writes().map(call => call.options.method), ['POST']);
    comments = [{ id: 8, body: forged, user: stranger }, { id: 10, body: stale }, { id: 11, body: stale, user: stranger }]; h.calls.length = 0;
    await publishComment({ ...options, write: true }, path, signal()); assert.deepEqual(writes().map(call => [call.options.method, call.url.split('/').at(-1)]), [['PATCH', '10']]);
    // a token that posts as a user can name its login explicitly
    comments = [{ id: 12, body: stale, user: stranger }]; h.calls.length = 0;
    await publishComment({ ...options, write: true, author: 'mallory' }, path, signal()); assert.deepEqual(writes().map(call => [call.options.method, call.url.split('/').at(-1)]), [['PATCH', '12']]);
    comments = [{ id: 13, body: stale, user: null as never }, { id: 14, body: stale, user: bot }]; h.calls.length = 0;
    await publishComment({ ...options, write: true }, path, signal()); assert.deepEqual(writes().map(call => [call.options.method, call.url.split('/').at(-1)]), [['PATCH', '14']]);
    const original = h.state.respond;
    h.state.respond = call => call.url.includes('/pulls/') ? Response.json(pr('b'.repeat(40))) : original(call); assert.equal((await publishComment(options, path, signal())).reason, 'stale-head');
    h.state.respond = call => call.url.includes('/pulls/') ? Response.json(pr(head, false)) : original(call); assert.equal((await publishComment(options, path, signal())).reason, 'closed');
    h.state.respond = original;
    await assert.rejects(publishComment({ ...options, headRepository: 'fork/repo' }, path, signal()), /fork/);
    await assert.rejects(publishComment({ ...options, provider: 'gitlab' }, path, signal()), /GitHub/);
    await assert.rejects(publishComment({ ...options, reportUrl: 'http://x.test' }, path, signal()), /HTTPS/);
    await assert.rejects(publishComment({ ...options, headRepository: undefined, write: true }, path, signal()), /--head-repository/);
    assert.equal((await publishComment({ ...options, headRepository: undefined }, path, signal())).write, false);
    delete process.env.QG_T; await assert.rejects(publishComment(options, path, signal()), /Missing/);
  } finally { h.restore(); delete process.env.QG_T; await rm(dir, { recursive: true, force: true }); }
});

test('slack notification fires only for BLOCK or error, reads the webhook from the environment and never echoes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-slack-')); const file = (name: string, run: RunResult) => writeFile(join(dir, name), JSON.stringify(run)).then(() => join(dir, name));
  const blockPath = await file('b.json', base); const passPath = await file('p.json', pass); const errorPath = await file('e.json', { ...base, execution: 'error' });
  const hook = 'https://hooks.slack.com/services/T000/B000/SECRETHOOK'; process.env.QG_HOOK = hook; const h = harness();
  try {
    const dry = await notifySlack({ webhookEnv: 'QG_HOOK', reportUrl: url }, blockPath, signal()); assert.equal(dry.sent, false); assert.equal(dry.reason, 'dry-run'); assert.equal(h.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(dry), /SECRETHOOK/); assert.match(JSON.stringify(dry.message), /Report/);
    const sent = await notifySlack({ webhookEnv: 'QG_HOOK', write: true }, blockPath, signal()); assert.equal(sent.sent, true); assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.url, hook); assert.equal(h.calls[0]!.options.redirect, 'error'); assert.doesNotMatch(String(h.calls[0]!.options.body), /SECRET/);
    assert.equal((await notifySlack({ webhookEnv: 'QG_HOOK', write: true }, errorPath, signal())).sent, true); assert.equal(h.calls.length, 2);
    const skipped = await notifySlack({ webhookEnv: 'QG_HOOK', write: true }, passPath, signal()); assert.equal(skipped.sent, false); assert.equal(skipped.reason, 'pass'); assert.equal(h.calls.length, 2);
    h.state.respond = () => new Response('invalid_token SECRETHOOK', { status: 404 });
    await assert.rejects(notifySlack({ webhookEnv: 'QG_HOOK', write: true }, blockPath, signal()), error => { assert.match(String(error), /HTTP 404/); assert.doesNotMatch(String(error), /SECRETHOOK/); return true; });
    mock.method(globalThis, 'fetch', async () => { throw new Error(`connect failed ${hook}`); });
    await assert.rejects(notifySlack({ webhookEnv: 'QG_HOOK', write: true }, blockPath, signal()), error => { assert.match(String(error), /request failed/); assert.doesNotMatch(String(error), /SECRETHOOK/); return true; });
    await assert.rejects(notifySlack({ webhookEnv: 'bad name' }, blockPath, signal()));
    await assert.rejects(notifySlack({ webhookEnv: 'QG_HOOK', reportUrl: 'http://x.test' }, blockPath, signal()), /HTTPS/);
    process.env.QG_HOOK = 'http://hooks.slack.com/x'; await assert.rejects(notifySlack({ webhookEnv: 'QG_HOOK' }, blockPath, signal()), /HTTPS/);
    delete process.env.SLACK_WEBHOOK_URL; await assert.rejects(notifySlack({}, blockPath, signal()), /SLACK_WEBHOOK_URL/);
  } finally { mock.restoreAll(); delete process.env.QG_HOOK; await rm(dir, { recursive: true, force: true }); }
});

test('CLI status, comment and notify run against fixture servers and keep dry-run/write boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-notify-cli-')); const input = join(dir, 'run.json'); await writeFile(input, JSON.stringify(base));
  const seen: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk; seen.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url!.includes('/pulls/') ? pr() : request.url!.includes('/comments') && request.method === 'GET' ? [] : {}));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const entry = resolve(process.env.QUALITYGATE_CLI ?? 'packages/cli/src/index.ts');
  const cli = (args: string[]) => exec(process.execPath, [...(entry.endsWith('.ts') ? ['--import', resolve('node_modules/tsx/dist/loader.mjs')] : []), entry, ...args], { env: { ...process.env, QG_CLI_TOKEN: 'fixture', QG_CLI_HOOK: 'https://hooks.slack.com/services/x' } });
  const api = ['--api-url', `http://127.0.0.1:${address.port}`, '--token-env', 'QG_CLI_TOKEN'];
  try {
    const status = ['status', '--repository', 'owner/repo', '--head', head, '--input', input, '--report-url', url, '--head-repository', 'owner/repo', ...api];
    assert.match((await cli(status)).stdout, /QualityGate BLOCK/); assert.equal(seen.length, 0);
    assert.equal(JSON.parse((await cli([...status, '--write', '--json'])).stdout).write, true); assert.deepEqual(seen, [`POST /repos/owner/repo/statuses/${head}`]);
    seen.length = 0; const comment = ['comment', '--repository', 'owner/repo', '--number', '1', '--head', head, '--input', input, '--head-repository', 'owner/repo', ...api];
    assert.match((await cli(comment)).stdout, new RegExp(commentMarker)); assert.equal(seen.filter(item => !item.startsWith('GET')).length, 0);
    assert.match((await cli([...comment, '--write'])).stdout, /Comment: created/); assert.ok(seen.some(item => item.startsWith('POST') && item.includes('/issues/1/comments')));
    assert.equal(JSON.parse((await cli([...comment, '--json'])).stdout).reason, 'created');
    const notify = ['notify', '--input', input, '--webhook-env', 'QG_CLI_HOOK', '--report-url', url];
    assert.match((await cli(notify)).stdout, /QualityGate BLOCK/); assert.equal(JSON.parse((await cli([...notify, '--json'])).stdout).sent, false);
    await writeFile(input, JSON.stringify(pass)); assert.match((await cli([...notify, '--write'])).stdout, /Slack: pass/);
    for (const invalid of [['status', '--input', input], ['comment', '--input', input], ['notify'], ['notify', '--input', input, '--head', head], ['status', 'extra', '--input', input]]) await assert.rejects(cli([...invalid, '--json']));
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(dir, { recursive: true, force: true }); }
});

test('report URLs that could break out of a Markdown or Slack link are refused', () => {
  for (const bad of ['https://a.example/x) [Click](https://evil.example', 'https://a.example/x>|<https://evil.example|Go', 'https://a.example/a b', 'https://a.example/<x>', 'https://a.example/(x)', 'https://a.example/x|y'])
    assert.equal(reportUrlSchema.safeParse(bad).success, false, bad);
  assert.equal(reportUrlSchema.parse('https://A.example/run/1?x=1%29'), 'https://a.example/run/1?x=1%29');
});
