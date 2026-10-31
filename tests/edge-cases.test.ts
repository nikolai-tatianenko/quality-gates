import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configSchema, gateSchema } from '../packages/protocol/src/index.js';
import { run } from '../packages/core/src/index.js';
import { jsonReporter } from '../packages/plugins/reporter-json/src/index.js';
import { filesystemPlugin } from '../packages/plugins/storage-fs/src/index.js';
import { captureCommand } from '../packages/plugins/command/src/index.js';
import { QualityGateService, getRun } from '../packages/service/src/index.js';
import type { GatePlugin, StoragePlugin } from '../packages/plugin-sdk/src/index.js';

const config = configSchema.parse({ schemaVersion: 1, gates: [{ id: 'test', run: 'true' }] });
const storage: StoragePlugin = { id: 'memory', apiVersion: 1, kind: 'storage', async createRun() { return '/memory'; }, async write(dir, name) { return `${dir}/${name}`; } };
const gate: GatePlugin = { id: 'fake', apiVersion: 1, kind: 'gate', async run() { return { exitCode: 0, output: '' }; } };
test('storage initialization errors retain gate results; cleanup runs in reverse even when one fails', async () => {
  const events: number[] = [];
  const result = await run(config, { reporter: jsonReporter, storage: { ...storage, async createRun() { throw Error('disk unavailable'); } },
    gate: { ...gate, async run(_, ctx) {
      ctx.defer(() => { events.push(1); }); ctx.defer(() => { events.push(2); throw Error('cleanup'); });
      return { exitCode: 0, output: 'evidence', findings: [{ gateId: 'wrong', severity: 'warning', message: 'warning' }] };
    } } });
  assert.deepEqual(events, [2, 1]); assert.equal(result.execution, 'error'); assert.equal(result.decision, 'PASS');
  assert.match(result.errors.join(), /disk unavailable/); assert.equal(result.reportPath, undefined);
  assert.equal(result.findings[0]?.gateId, 'test'); assert.equal(result.findings[0]?.evidencePath, undefined);
  const controller = new AbortController();
  const interrupted = await run(config, { reporter: jsonReporter, gate, storage: { ...storage, async write() { controller.abort(); throw Error('write interrupted'); } } }, controller.signal);
  assert.equal(interrupted.execution, 'interrupted'); assert.equal(interrupted.reportPath, undefined);
});
test('command capture handles spawn failure, pre-abort, separate stderr and bounded output', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qg-command-edges-'));
  async function capture(command: string, directory = cwd, signal = new AbortController().signal) {
    const cleanups: (() => void | Promise<void>)[] = [];
    const result = await captureCommand(directory, gateSchema.parse({ id: 'test', run: command }), { signal, defer: fn => cleanups.push(fn) });
    for (const cleanup of cleanups.reverse()) await cleanup();
    return result;
  }
  try {
    assert.match((await capture('true', join(cwd, 'missing'))).error!, /ENOENT/);
    assert.equal((await capture('sleep 30', cwd, AbortSignal.abort())).error, 'Interrupted');
    const streams = await capture('printf out; printf err >&2');
    assert.equal(streams.stdout, 'out'); assert.equal(streams.stderr, 'err');
    const huge = await capture(`"${process.execPath}" -e 'process.stdout.write("a".repeat(1000001))'`);
    assert.equal(huge.truncated, true); assert.equal(huge.stdout.length, 1000000);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
test('history ignores incomplete runs, chooses newest complete report and propagates filesystem errors', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qg-history-'));
  try {
    const path = join(cwd, '.qualitygate.yml');
    await writeFile(path, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'test', run: 'true' }], outputDir: 'out' }));
    const service = new QualityGateService(path);
    await assert.rejects(service.run({}, AbortSignal.abort()), /abort/i);
    const saved = await service.run(); assert.equal((await service.get()).runId, saved.runId);
    await mkdir(join(cwd, 'out', 'unrelated')); await writeFile(join(cwd, 'out', 'file'), 'ignored');
    await mkdir(join(cwd, 'out', randomUUID()));
    const incomplete = join(cwd, 'out', randomUUID()); await mkdir(join(incomplete, 'report.json'), { recursive: true });
    assert.equal((await getRun(path)).runId, saved.runId);
    const invalid = join(cwd, 'out', randomUUID()); await mkdir(invalid);
    await symlink('report.json', join(invalid, 'report.json'));
    await assert.rejects(getRun(path), /ELOOP/);
    await service.close();
    for (const call of [() => service.list(), () => service.get(), () => service.run()]) await assert.rejects(call(), /closed/);
    await service.close();
    await writeFile(join(cwd, 'not-a-directory'), 'file');
    await writeFile(path, JSON.stringify({ schemaVersion: 1, gates: [{ id: 'test', run: 'true' }], outputDir: 'not-a-directory' }));
    await assert.rejects(getRun(path), /ENOTDIR/);
    await assert.rejects(filesystemPlugin(cwd).createRun('../invalid'), /Invalid run ID/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
