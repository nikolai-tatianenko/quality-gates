import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesystemPlugin } from '../packages/plugins/storage-fs/src/index.js';
import { normalize } from '../packages/plugins/lighthouse/src/index.js';
import { jsonReporter } from '../packages/plugins/reporter-json/src/index.js';
import { run } from '../packages/core/src/index.js';
import { configSchema, runResultSchema } from '../packages/protocol/src/index.js';
test('normalize scores to 0–100 and preserve absence', () => {
  assert.deepEqual(normalize({ categories: { performance: { score: 0.92 }, seo: { score: null }, accessibility: { score: 0 }, 'best-practices': { score: 1 } } }), { performance: 92, accessibility: 0, 'best-practices': 100 });
});
test('filesystem isolates runs, atomically writes validated report and raw evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-evidence-'));
  try {
    const storage = filesystemPlugin(dir);
    const config = configSchema.parse({ schemaVersion: 1, urls: ['https://example.com'], thresholds: { performance: 0, accessibility: 0, seo: 0, 'best-practices': 0 } });
    const result = await run(config, { storage, reporter: jsonReporter, audit: { id: 'fake', apiVersion: 1, kind: 'audit', async audit() { return { scores: {}, raw: { runtimeError: 'navigation failed' }, error: 'navigation failed' }; } } });
    assert.equal(result.execution, 'error');
    assert.deepEqual(runResultSchema.parse(JSON.parse(await readFile(result.reportPath!, 'utf8'))), result);
    assert.deepEqual(JSON.parse(await readFile(result.results[0]!.evidencePath!, 'utf8')), { runtimeError: 'navigation failed' });
    assert.deepEqual((await readdir(join(dir, result.runId))).sort(), ['1-lighthouse.json', 'report.json']);
    await assert.rejects(storage.createRun(result.runId));
    await assert.rejects(storage.write(dir, '../escape', '{}'));
    const file = join(dir, 'file'); await writeFile(file, 'blocked');
    await assert.rejects(filesystemPlugin(file).createRun('new'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
