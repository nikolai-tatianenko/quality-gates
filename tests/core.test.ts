import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configSchema, exitCode, runResultSchema } from '../packages/protocol/src/index.js';
import { evaluate } from '../packages/policy/src/index.js';
import { Registry, run } from '../packages/core/src/index.js';
import type { AuditPlugin, Plugin, StoragePlugin } from '../packages/plugin-sdk/src/index.js';
const scores = { performance: 90, accessibility: 100, seo: 90, 'best-practices': 100 };
const config = configSchema.parse({ schemaVersion: 1, urls: ['https://example.com', 'https://example.org'], thresholds: scores });
const storage: StoragePlugin = { id: 'memory', apiVersion: 1, kind: 'storage', async createRun(id) { return id; }, async write(dir, name) { return `${dir}/${name}`; } };
const reporter = { id: 'json', apiVersion: 1, kind: 'reporter', render: JSON.stringify } as const;
test('strict config rejects unsupported versions, protocols and incomplete thresholds', () => {
  for (const patch of [{ schemaVersion: 2 }, { urls: ['file:///tmp/a'] }, { thresholds: {} }, { timeoutMs: 0 }, { unknown: 1 }]) assert.throws(() => configSchema.parse({ ...config, ...patch }));
});
test('same saved scores evaluate deterministically under different thresholds; missing is BLOCK', () => {
  assert.equal(evaluate(scores, scores).decision, 'PASS');
  assert.equal(evaluate(scores, { ...scores, performance: 91 }).decision, 'BLOCK');
  assert.equal(evaluate({}, { performance: 0, accessibility: 0, seo: 0, 'best-practices': 0 }).decision, 'BLOCK');
});
test('registry rejects duplicates, wrong kind and incompatible versions', () => {
  const r = new Registry(); r.register(storage);
  assert.throws(() => r.register(storage));
  assert.throws(() => r.get('memory', 'audit'));
  assert.throws(() => r.register({ ...storage, apiVersion: 2 } as unknown as Plugin));
});
test('independent audit plugin needs no core changes, runs sequentially and cleans failures', async () => {
  const events: string[] = [];
  const audit: AuditPlugin = { id: 'test-audit', apiVersion: 1, kind: 'audit', async audit(url, ctx) {
    events.push(url); ctx.defer(() => { events.push('cleanup'); });
    if (url.includes('example.org')) throw new Error('audit failed');
    return { scores, raw: { custom: true } };
  } };
  const result = await run(config, { audit, storage, reporter });
  assert.deepEqual(events, [config.urls[0], 'cleanup', config.urls[1], 'cleanup']);
  assert.equal(result.results.length, 2); assert.equal(result.results[0]?.decision, 'PASS');
  assert.equal(result.results[1]?.errors[0], 'audit failed'); assert.equal(exitCode(result), 2);
  assert.ok(runResultSchema.safeParse(result).success);
});
test('cleanup, evidence and report write failures remain explicit', async () => {
  const audit: AuditPlugin = { id: 'test', apiVersion: 1, kind: 'audit', async audit(_, ctx) {
    ctx.defer(() => { throw new Error('cleanup failed'); }); return { scores, raw: {} };
  } };
  const result = await run(config, { audit, reporter, storage: { ...storage, async write() { throw new Error('disk full'); } } });
  assert.equal(exitCode(result), 2); assert.match(result.errors.join(), /Report write: disk full/);
  assert.match(result.results[0]!.errors.join(), /disk full.*Cleanup: cleanup failed/);
  assert.equal(result.results[0]?.decision, 'PASS');
});
test('interruption skips pending URLs and takes exit precedence', async () => {
  const c = new AbortController();
  const audit: AuditPlugin = { id: 'test', apiVersion: 1, kind: 'audit', async audit() { c.abort(); throw new Error('interrupted'); } };
  const result = await run(config, { audit, storage, reporter }, c.signal);
  assert.equal(exitCode(result), 130); assert.equal(result.results[1]?.execution, 'skipped');
});
test('interruption during report write updates both saved report and exit status', async () => {
  const controller = new AbortController();
  const writes: string[] = [];
  const audit: AuditPlugin = { id: 'test', apiVersion: 1, kind: 'audit', async audit() { return { scores }; } };
  const result = await run(config, { audit, reporter, storage: { ...storage, async write(dir, name, data) {
    writes.push(data); controller.abort(); return `${dir}/${name}`;
  } } }, controller.signal);
  assert.equal(exitCode(result), 130);
  assert.equal(writes.length, 2); assert.deepEqual(JSON.parse(writes[1]!), result);
});

test('an evidence write failure does not mask the original audit error', async () => {
  const audit: AuditPlugin = { id: 'test', apiVersion: 1, kind: 'audit', async audit() {
    return { scores: {}, raw: {}, error: 'navigation failed' };
  } };
  const result = await run(config, { audit, reporter, storage: { ...storage, async write(_, name) {
    if (name !== 'report.json') throw new Error('evidence disk full'); return name;
  } } });
  assert.equal(exitCode(result), 2);
  assert.deepEqual(result.results[0]!.errors, ['navigation failed', 'evidence disk full']);
});
