import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const nativeExec = promisify(childProcess.execFile);
let upstream = ''; let failFetch = false;
const repository = 'https://github.com/cloudflare/security-audit-skill';
mock.module('node:child_process', { namedExports: { ...childProcess,
  execFile: Object.assign(() => { throw new Error('Use promisified Git execution'); }, {
    [promisify.custom]: async (command: string, args: string[], options: childProcess.ExecFileOptionsWithStringEncoding) => {
      assert.equal(command, 'git'); assert.equal(options.env!.GIT_TERMINAL_PROMPT, '0');
      assert.equal(options.env!.GIT_CONFIG_GLOBAL, '/dev/null'); assert.ok(args.includes('core.hooksPath=/dev/null'));
      return nativeExec(command, args.map(arg => arg === repository ? failFetch ? '/no-such-upstream' : upstream : arg), options);
    },
  }),
} });
const { syncSources, restoreSources, listSources, checkSources, readMethodology } = await import('../packages/review-sources/src/index.js');
const { reviewSourceSchema, configSchema, exitCode } = await import('../packages/protocol/src/index.js');
const { execute } = await import('../packages/cli/src/runner.js');
const { createServer } = await import('../packages/mcp/src/index.js');
const source = reviewSourceSchema.parse({ id: 'cloudflare', repository, path: 'skills/security-audit' });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'qg-review-')); upstream = join(dir, 'upstream');
  await mkdir(join(upstream, source.path), { recursive: true });
  await nativeExec('git', ['init', '-b', 'main', upstream]);
  await nativeExec('git', ['-C', upstream, 'config', 'user.email', 'test@example.invalid']);
  await nativeExec('git', ['-C', upstream, 'config', 'user.name', 'QualityGate test']);
  await writeFile(join(upstream, source.path, 'SKILL.md'), '# Local audit fixture\nDo not execute target code without isolation.\n');
  await writeFile(join(upstream, source.path, 'validate-findings.cjs'), 'throw Error("Must only return this as reference text");\n');
  await writeFile(join(upstream, 'LICENSE'), 'MIT fixture license\n'); await commit();
  return dir;
}
async function commit() {
  await nativeExec('git', ['-C', upstream, 'add', '.']); await nativeExec('git', ['-C', upstream, 'commit', '-m', 'fixture update']);
}

test('source sync pins real Git objects, detects upstream changes and preserves the lock on failures', async () => {
  const dir = await setup();
  try {
    const { sources } = await syncSources(dir, [source]); assert.equal(sources.length, 1);
    const original = await readFile(join(dir, 'qualitygate.sources.lock.json'), 'utf8');
    assert.deepEqual(await listSources(dir, [source]), sources);
    assert.deepEqual(await listSources(dir, [{ repository: source.repository, id: source.id, path: source.path, ref: source.ref }]), sources);
    assert.match((await readMethodology(dir, [source], 'cloudflare')).content, /Local audit fixture/);
    assert.match((await readMethodology(dir, [source], 'cloudflare', { file: 'LICENSE' })).content, /MIT fixture/);
    assert.match((await readMethodology(dir, [source], 'cloudflare', { file: 'validate-findings.cjs' })).content, /Must only return/);
    assert.equal((await checkSources(dir, [source]))[0]!.updateAvailable, false);
    await syncSources(dir, [source]); // Existing stores are retained, never deleted underneath readers.
    await writeFile(join(upstream, source.path, 'SKILL.md'), '# Updated methodology\n'); await commit();
    assert.equal((await checkSources(dir, [source]))[0]!.updateAvailable, true);
    assert.equal(await readFile(join(dir, 'qualitygate.sources.lock.json'), 'utf8'), original);
    assert.match((await readMethodology(dir, [source], 'cloudflare')).content, /Local audit fixture/);
    await rm(join(dir, '.qualitygate-review-sources'), { recursive: true });
    await restoreSources(dir, [source]);
    assert.equal(await readFile(join(dir, 'qualitygate.sources.lock.json'), 'utf8'), original);
    assert.match((await readMethodology(dir, [source], 'cloudflare')).content, /Local audit fixture/);
    failFetch = true;
    await assert.rejects(syncSources(dir, [source]));
    assert.equal(await readFile(join(dir, 'qualitygate.sources.lock.json'), 'utf8'), original);
    failFetch = false;
    const updated = await syncSources(dir, [source]); assert.notEqual(updated.sources[0]!.commit, sources[0]!.commit);
    assert.match((await readMethodology(dir, [source], 'cloudflare')).content, /Updated methodology/);
    await assert.rejects(syncSources(dir, [source], AbortSignal.abort()));
    await assert.rejects(readMethodology(dir, [source], 'cloudflare', { file: '../SKILL.md' }), /filename/);
    await assert.rejects(readMethodology(dir, [source], 'unknown'), /Unknown review source/);
    await assert.rejects(readMethodology(dir, [source], 'cloudflare', { file: 'MISSING.md' }));
    await assert.rejects(listSources(dir, [{ ...source, ref: 'other' }]), /changed/);
    await assert.rejects(listSources(dir, [{ ...source, id: 'other' }]), /not locked/);
    await assert.rejects(syncSources(dir, [{ ...source, path: 'missing' }]));
    await assert.rejects(syncSources(dir, [{ ...source, repository: 'file:///tmp/repo' }]));
    const badStore = join(dir, '.qualitygate-review-sources', `cloudflare-${updated.sources[0]!.commit}`);
    await rm(badStore, { recursive: true }); await writeFile(badStore, 'obstruction');
    await assert.rejects(syncSources(dir, [source]));
  } finally { failFetch = false; await rm(dir, { recursive: true, force: true }); }
});

test('review gates preserve verdicts and provenance, block unresolved work and reject incomplete or mismatched reports', async () => {
  const dir = await setup();
  try {
    const lock = await syncSources(dir, [source]); const pin = lock.sources[0]!;
    const context = { schemaVersion: 1, completed: true, methodology: { id: source.id, commit: pin.commit } };
    const path = join(dir, '.qualitygate.yml');
    await writeFile(path, JSON.stringify({ schemaVersion: 1, reviewSources: [source], gates: [
      { id: 'review', type: 'review', run: 'node producer.cjs', review: { sourceId: source.id } },
    ] }));
    async function review(report: unknown, code?: string) {
      await writeFile(join(dir, 'producer.cjs'), code ?? `console.log(${JSON.stringify(JSON.stringify(report))})`);
      return execute(path, new AbortController().signal);
    }
    for (const verdict of ['confirmed', 'needs_validation', 'rejected']) {
      const run = await review({ ...context, findings: [{ verdict, finding: { severity: 'error', file: 'src/auth.ts', line: 12, ruleId: 'auth/bypass', message: 'Missing authorization' } }] });
      assert.equal(exitCode(run), verdict === 'rejected' ? 0 : 1);
      assert.equal(run.findings[0]!.severity, verdict === 'confirmed' ? 'error' : verdict === 'needs_validation' ? 'warning' : 'info');
      assert.match(run.findings[0]!.message, new RegExp(verdict)); assert.equal(run.findings[0]!.line, 12);
      const evidence = JSON.parse(await readFile(run.findings[0]!.evidencePath!, 'utf8'));
      assert.equal(evidence.source.repository, repository); assert.equal(evidence.source.commit, pin.commit);
      assert.equal(JSON.parse(evidence.producerOutput).findings[0].verdict, verdict);
    }
    assert.equal(exitCode(await review({ ...context, findings: [] })), 0);
    assert.equal(exitCode(await review({ ...context, findings: [{ verdict: 'confirmed', finding: { severity: 'info', message: 'Informational' } }] })), 0);
    for (const report of [null, { ...context, completed: false, findings: [] }, { ...context, methodology: { id: 'wrong', commit: pin.commit }, findings: [] },
      { ...context, methodology: { id: source.id, commit: 'a'.repeat(40) }, findings: [] }]) {
      const run = await review(report); assert.equal(exitCode(run), 2); assert.ok(run.gates[0]!.reportPath);
    }
    for (const code of ['process.stdout.write("malformed")', 'process.exitCode=7', 'process.stdout.write("x".repeat(1000001))', 'setTimeout(()=>{},10000)']) {
      if (code.includes('setTimeout')) await writeFile(path, JSON.stringify({ ...configSchema.parse(JSON.parse(await readFile(path, 'utf8'))), gates: [{ id: 'review', type: 'review', run: 'node producer.cjs', timeoutMs: 20, review: { sourceId: source.id } }] }));
      const run = await review({}, code); assert.equal(exitCode(run), 2); assert.ok(run.gates[0]!.errors.length);
    }
    assert.throws(() => configSchema.parse({ schemaVersion: 1, gates: [{ id: 'a', run: 'true' }], reviewSources: [source, source] }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('MCP serves pinned methodology as read-only material and rejects undeclared sources and traversal', async () => {
  const dir = await setup();
  try {
    await syncSources(dir, [source]); const path = join(dir, '.qualitygate.yml');
    await writeFile(path, JSON.stringify({ schemaVersion: 1, reviewSources: [source], gates: [{ id: 'lint', run: 'true' }] }));
    const server = createServer(path); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b);
    const client = new Client({ name: 'methodology-test', version: '1' }); await client.connect(a);
    try {
      const response = await client.callTool({ name: 'get_review_methodology', arguments: { sourceId: source.id } });
      assert.equal(response.isError, false); assert.match(JSON.stringify(response.content), /Local audit fixture/);
      assert.match(JSON.stringify((await client.callTool({ name: 'list_gates', arguments: {} })).content), /reviewSources/);
      for (const args of [{ sourceId: 'unknown' }, { sourceId: source.id, file: '../LICENSE' }]) {
        assert.equal((await client.callTool({ name: 'get_review_methodology', arguments: args })).isError, true);
      }
    } finally { await client.close(); await server.close(); }
    // Exercise the real CLI, reading the locally pinned store (no network in subprocesses).
    const cli = resolve('packages/cli/src/index.ts'); const loader = resolve('node_modules/tsx/dist/loader.mjs');
    for (const args of [['list'], ['read', source.id], ['read', source.id, 'LICENSE']]) {
      const { stdout, stderr } = await nativeExec(process.execPath, ['--import', loader, cli, 'sources', ...args, '--config', path, '--json']);
      assert.equal(stderr, ''); assert.ok(JSON.parse(stdout));
    }
    const text = await nativeExec(process.execPath, ['--import', loader, cli, 'sources', 'list', '--config', path]); assert.match(text.stdout, /cloudflare/);
    for (const args of [[], ['bad'], ['read'], ['list', 'extra'], ['read', source.id, 'LICENSE', 'extra']]) {
      await assert.rejects(nativeExec(process.execPath, ['--import', loader, cli, 'sources', ...args, '--config', path, '--json']), /Command failed/);
    }
    await writeFile(path, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'lint', run: 'true' }] }));
    await nativeExec(process.execPath, ['--import', loader, cli, 'sources', 'sync', '--config', path, '--json']);
    await nativeExec(process.execPath, ['--import', loader, cli, 'sources', 'check', '--config', path, '--json']);
    await nativeExec(process.execPath, ['--import', loader, cli, 'sources', 'restore', '--config', path, '--json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
