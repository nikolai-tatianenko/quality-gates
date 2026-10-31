import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute } from '../packages/cli/src/runner.js';
import { configSchema, exitCode } from '../packages/protocol/src/index.js';
const base = 'http://sonar.test/sonar';
const metadata = `serverUrl=${base}\nceTaskId=task-one\n`;
const task = (status = 'SUCCESS', extra = {}) => ({ task: { id: 'task-one', status, analysisId: 'analysis-one', ...extra } });
const status = (state = 'OK', conditions: unknown[] = []) => ({ projectStatus: { status: state, conditions } });
const condition = { status: 'ERROR', metricKey: 'new_coverage', comparator: 'LT', errorThreshold: '80', actualValue: '60' };

test('SonarQube waits for the exact scanner analysis, saves evidence, redacts tokens and distinguishes BLOCK from errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-sonar-'));
  const old = process.env.QG_SONAR_TEST_TOKEN; process.env.QG_SONAR_TEST_TOKEN = 'secret-sonar-test-value';
  let replies: Response[] = []; const urls: string[] = [];
  const fetched = mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    urls.push(String(url)); assert.equal((options!.headers as Record<string, string>).Authorization, 'Bearer secret-sonar-test-value');
    assert.equal(options!.redirect, 'error'); return replies.shift()!;
  });
  const path = join(dir, 'qg.json');
  async function run(options: { raw?: string; code?: string; responses?: unknown[]; timeoutMs?: number } = {}) {
    replies = (options.responses ?? [task(), status()]).map(value => value instanceof Response ? value : Response.json(value)); urls.length = 0;
    await writeFile(join(dir, 'scanner.cjs'), options.code ?? `require('node:fs').writeFileSync('task.txt', ${JSON.stringify(options.raw ?? metadata)});console.log(process.env.QG_SONAR_TEST_TOKEN);`);
    await writeFile(path, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'sonar', type: 'sonarqube', run: 'node scanner.cjs', timeoutMs: options.timeoutMs,
      sonar: { serverUrl: base, tokenEnv: 'QG_SONAR_TEST_TOKEN', taskFile: 'task.txt' } }] }));
    return execute(path, new AbortController().signal);
  }
  try {
    const passed = await run({ responses: [task('PENDING'), task('IN_PROGRESS'), task(), status()] });
    assert.equal(exitCode(passed), 0); assert.equal(urls.length, 4);
    assert.match(urls.at(-1)!, /analysisId=analysis-one$/); assert.doesNotMatch(urls.join(), /projectKey/);
    const evidence = await readFile(passed.gates[0]!.reportPath!, 'utf8'); assert.match(evidence, /analysis-one/);
    assert.doesNotMatch(JSON.stringify(passed), /secret-sonar-test-value/); assert.match(passed.gates[0]!.outputTail, /REDACTED/);
    const blocked = await run({ responses: [task(), status('ERROR', [condition])] });
    assert.equal(exitCode(blocked), 1); assert.equal(blocked.execution, 'completed');
    assert.equal(blocked.findings[0]!.ruleId, 'sonarqube/new_coverage'); assert.equal(blocked.findings[0]!.evidencePath, blocked.gates[0]!.reportPath);
    assert.equal(exitCode(await run({ responses: [task(), status('ERROR')] })), 1);
    const missing = await run({ responses: [task(), status('OK', [{ ...condition, status: 'NO_VALUE', actualValue: undefined }])] });
    assert.equal(exitCode(missing), 1); assert.match(missing.findings[0]!.message, /missing/);
    for (const scenario of [
      { responses: [task('FAILED')] }, { responses: [task('CANCELED')] }, { responses: [task('SUCCESS', { id: 'wrong' })] },
      { responses: [task('SUCCESS', { analysisId: undefined })] }, { responses: [task(), status('NONE')] },
      { responses: [new Response('unauthorized secret-sonar-test-value', { status: 401 })] },
      { responses: [new Response('x'.repeat(1000001))] }, { responses: [new Response('malformed')] }, { responses: [{ wrong: true }] },
      { responses: [task(), { projectStatus: { status: 'OK' } }] },
      { raw: 'serverUrl=http://different\nceTaskId=a' }, { raw: `serverUrl=${base}` }, { raw: 'x'.repeat(65537) },
      { code: 'console.log(process.env.QG_SONAR_TEST_TOKEN);process.exitCode=7' },
      { code: 'console.log("no metadata")' }, { code: 'setTimeout(()=>{},10000)', timeoutMs: 20 },
    ]) {
      const result = await run(scenario); assert.equal(exitCode(result), 2, JSON.stringify(scenario).slice(0, 200));
      assert.ok(result.gates[0]!.errors.length); assert.doesNotMatch(JSON.stringify(result), /secret-sonar-test-value/);
      assert.ok(result.gates[0]!.reportPath, 'failed scans retain evidence');
    }
    // A stale file from a previous scanner invocation is removed before the command starts.
    await writeFile(join(dir, 'task.txt'), metadata);
    assert.equal(exitCode(await run({ code: '' })), 2);
    delete process.env.QG_SONAR_TEST_TOKEN;
    assert.match((await run()).gates[0]!.errors.join(), /Missing SonarQube token/);
  } finally {
    fetched.mock.restore(); if (old === undefined) delete process.env.QG_SONAR_TEST_TOKEN; else process.env.QG_SONAR_TEST_TOKEN = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test('SonarQube cancellation and deadline abort pending analysis requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-sonar-abort-')); process.env.QG_SONAR_ABORT = 'temporary';
  const fetched = mock.method(globalThis, 'fetch', async () => Response.json(task('PENDING')));
  try {
    await writeFile(join(dir, 'scanner.cjs'), `require('node:fs').writeFileSync('task.txt', ${JSON.stringify(metadata)})`);
    const path = join(dir, '.qualitygate.yml');
    for (const interrupt of [true, false]) {
      await writeFile(path, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'sonar', type: 'sonarqube', run: 'node scanner.cjs', timeoutMs: interrupt ? 5000 : 400,
        sonar: { serverUrl: base, tokenEnv: 'QG_SONAR_ABORT', taskFile: 'task.txt' } }] }));
      const controller = new AbortController(); const timer = interrupt ? setTimeout(() => controller.abort(), 350) : undefined;
      try { assert.equal(exitCode(await execute(path, controller.signal)), interrupt ? 130 : 2); }
      finally { clearTimeout(timer); }
    }
  } finally { fetched.mock.restore(); delete process.env.QG_SONAR_ABORT; await rm(dir, { recursive: true, force: true }); }
});

test('Sonar and review settings are explicit and cannot be silently attached to another gate type', () => {
  for (const gate of [
    { type: 'sonarqube' }, { type: 'review' }, { sonar: { serverUrl: base } }, { review: { sourceId: 'missing' } },
    { type: 'sonarqube', sonar: { serverUrl: 'https://user:password@host' } },
    { type: 'sonarqube', sonar: { serverUrl: 'file:///tmp/server' } },
    { type: 'sonarqube', sonar: { serverUrl: `${base}?token=secret` } },
    { type: 'review', review: { sourceId: 'missing' } },
  ]) assert.throws(() => configSchema.parse({ schemaVersion: 1, gates: [{ id: 'check', run: 'true', ...gate }] }));
});
