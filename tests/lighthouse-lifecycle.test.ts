import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

type Mode = 'success' | 'launch-error' | 'worker-error' | 'exit' | 'payload-error' | 'missing' | 'abort' | 'timeout' | 'owned-process' | 'owned-attached';
let mode: Mode = 'success'; let controller = new AbortController();
let directory: string; let killed = 0; let terminated = 0;
const posted: unknown[] = [];
class Browser {
  userDataDir = directory;
  chromeProcess = mode.startsWith('owned-') ? spawn('sleep', ['30'], { detached: mode === 'owned-process' })
    : Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  port = 1234;
  async launch() { if (mode === 'launch-error') throw Error('cannot connect'); }
  kill() {
    const child = this.chromeProcess;
    if ('pid' in child) {
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'Profile cleanup must wait for browser exit');
      assert.throws(() => process.kill(child.pid!, 0), /ESRCH/);
    }
    killed++; this.chromeProcess.emit('close');
  }
}
class TestWorker extends EventEmitter {
  stdout = { resume() {} }; stderr = { resume() {} };
  constructor() {
    super();
    queueMicrotask(() => {
      if (mode === 'worker-error') this.emit('error', Error('worker crashed'));
      else if (mode === 'exit') this.emit('exit', 3);
      else if (mode === 'abort') controller.abort();
      else if (mode !== 'timeout') this.emit('message', mode === 'payload-error' ? { error: 'audit failed' }
        : mode === 'missing' ? {} : { raw: { categories: { performance: { score: 1 } } } });
    });
  }
  async terminate() { terminated++; return 0; }
}
mock.module('chrome-launcher', { namedExports: { Launcher: Browser, getChromePath: () => process.execPath } });
mock.module('node:worker_threads', { namedExports: { Worker: TestWorker,
  parentPort: { postMessage(value: unknown) { posted.push(value); } }, workerData: { url: 'http://fixture', port: 1234 } } });
let raw: unknown = { lhr: { categories: {} } };
mock.module('lighthouse', { defaultExport: async () => { if (raw instanceof Error) throw raw; return raw; } });
const { lighthousePlugin } = await import('../packages/plugins/lighthouse/src/index.js');

test('Lighthouse lifecycle retains errors, handles every worker termination path and always cleans resources', async () => {
  directory = await mkdtemp(join(tmpdir(), 'qg-lighthouse-lifecycle-'));
  const oldChrome = process.env.CHROME_PATH; delete process.env.CHROME_PATH;
  try {
    await writeFile(join(directory, 'chrome-err.log'), 'Running as root without --no-sandbox is not supported');
    for (const scenario of ['success', 'launch-error', 'worker-error', 'exit', 'payload-error', 'missing', 'abort', 'timeout', 'owned-process', 'owned-attached'] as const) {
      mode = scenario; controller = new AbortController();
      const cleanups: (() => void | Promise<void>)[] = [];
      const plugin = lighthousePlugin(50, { noSandbox: true, launchTimeoutMs: 100 });
      const promise = plugin.audit('http://fixture', { signal: controller.signal, defer: fn => cleanups.push(fn) });
      if (scenario === 'success' || scenario.startsWith('owned-')) assert.equal((await promise).scores.performance, 100);
      else await assert.rejects(promise, scenario === 'launch-error' ? /sandbox/i : scenario === 'timeout' ? /timed out/ : /worker|audit|Missing|Interrupted/i);
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
    assert.equal(killed, 10); assert.equal(terminated, 9);
    const cleanup: (() => void | Promise<void>)[] = [];
    await assert.rejects(lighthousePlugin(100).audit('http://fixture', { signal: AbortSignal.abort(), defer: fn => cleanup.push(fn) }), /Interrupted/);
    for (const fn of cleanup) await fn();
  } finally {
    if (oldChrome === undefined) delete process.env.CHROME_PATH; else process.env.CHROME_PATH = oldChrome;
    await rm(directory, { recursive: true, force: true });
  }
});
test('Lighthouse worker posts a raw report, missing result error and runner failure to its parent', async () => {
  const worker = '../packages/plugins/lighthouse/src/worker.js';
  await import(worker + '?case=success');
  raw = undefined;
  await import(worker + '?case=empty');
  raw = new Error('navigation failed');
  await import(worker + '?case=failure');
  assert.deepEqual(posted, [{ raw: { categories: {} } }, { error: 'Lighthouse returned no result' }, { error: 'navigation failed' }]);
});
test('scanUrl audits only the given URL with the configured thresholds, runs no gate or plugin and is not recorded in the history', async () => {
  const { execute } = await import('../packages/cli/src/runner.js');
  const { QualityGateService } = await import('../packages/service/src/index.js');
  const dir = await mkdtemp(join(tmpdir(), 'qg-scan-'));
  const config = join(dir, '.qualitygate.yml');
  const thresholds = { performance: 80, accessibility: 90, seo: 90, 'best-practices': 90 };
  try {
    await writeFile(config, JSON.stringify({ schemaVersion: 1, outputDir: 'out', urls: ['https://configured.example'], thresholds, plugins: ['not-installed'], gates: [{ id: 'marker', run: 'touch ran.txt' }] }));
    mode = 'success'; controller = new AbortController();
    const result = await execute(config, controller.signal, undefined, { scanUrl: 'https://page.example/' });
    assert.deepEqual(result.results.map(r => r.url), ['https://page.example/']);
    assert.deepEqual(result.gates, []);
    assert.equal(result.results[0]!.scores.performance, 100);
    assert.equal(result.decision, 'BLOCK', 'categories the report lacks cannot satisfy their thresholds');
    assert.equal(existsSync(join(dir, 'ran.txt')), false); assert.equal(existsSync(join(dir, 'out', 'history.sqlite')), false);
    const service = new QualityGateService(config);
    assert.equal((await service.scan('https://other.example/')).results[0]!.url, 'https://other.example/');
    await service.close();
    await writeFile(config, JSON.stringify({ schemaVersion: 1, outputDir: 'out', thresholds, gates: [{ id: 'marker', run: 'true' }] }));
    await execute(config, controller.signal, ['marker']);
    assert.equal(existsSync(join(dir, 'out', 'history.sqlite')), true, 'ordinary runs are still recorded');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
