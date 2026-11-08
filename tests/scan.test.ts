import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute } from '../packages/cli/src/runner.js';
import { QualityGateService } from '../packages/service/src/index.js';

const thresholds = { performance: 80, accessibility: 90, seo: 90, 'best-practices': 90 };
async function project(config: object) {
  const dir = await mkdtemp(join(tmpdir(), 'qg-scan-'));
  await writeFile(join(dir, '.qualitygate.yml'), JSON.stringify({ schemaVersion: 1, outputDir: 'out', ...config }));
  return dir;
}

test('scan refuses a project without thresholds and shares the single-run lock with run', async () => {
  const none = await project({ gates: [{ id: 'a', run: 'true' }] });
  const some = await project({ thresholds, gates: [{ id: 'slow', run: 'sleep 30' }] });
  try {
    await assert.rejects(execute(join(none, '.qualitygate.yml'), new AbortController().signal, undefined, { scanUrl: 'https://page.example/' }), /No Lighthouse thresholds/);
    const service = new QualityGateService(join(some, '.qualitygate.yml'));
    const controller = new AbortController();
    const running = service.run({ gates: ['slow'] }, controller.signal);
    await assert.rejects(service.scan('https://page.example/'), /already active/);
    controller.abort();
    assert.equal((await running).execution, 'interrupted');
    await service.close();
    await assert.rejects(service.scan('https://page.example/'), /closed/);
  } finally { await rm(none, { recursive: true, force: true }); await rm(some, { recursive: true, force: true }); }
});
