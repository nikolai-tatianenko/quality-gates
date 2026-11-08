import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from '../packages/dashboard/src/server.js';
import { teamView } from '../packages/service/src/index.js';

async function project(gates: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), 'qg-team-'));
  const config = join(dir, 'my gates.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, outputDir: 'out', gates }));
  for (const file of ['index.html', 'app.js', 'app.css']) await writeFile(join(dir, file), 'fixture');
  return { dir, config };
}

test('the dashboard serves the team view of the project, including a degraded one when history is unreadable', async () => {
  const { dir, config } = await project([{ id: 'ok', run: 'true' }, { id: 'bad', run: 'false' }]);
  const dashboard = createDashboard(config, dir);
  await new Promise<void>(resolve => dashboard.server.listen(0, '127.0.0.1', resolve));
  const address = dashboard.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const empty = await (await fetch(`${base}/api/team`)).json();
    assert.equal(empty.current, null); assert.equal(empty.headline, 'No run recorded yet');
    const run = await fetch(`${base}/api/run`, { method: 'POST', headers: { Origin: base, 'X-QualityGate-Request': '1' } });
    assert.equal(run.status, 200);
    const team = await (await fetch(`${base}/api/team`)).json();
    assert.equal(team.current.decision, 'BLOCK'); assert.deepEqual(team.blockingGates, ['bad']);
    assert.equal(team.engineer[0].reproduce, "qualitygate run --config 'my gates.json' --gate bad");
    assert.equal(team.runs.length, 1); assert.match(team.markdown, /Reproduce:/);
  } finally { await dashboard.close(); await rm(dir, { recursive: true, force: true }); }
});

test('teamView reports an unreadable history as a warning and rethrows a broken run store', async () => {
  const { dir, config } = await project([{ id: 'ok', run: 'true' }]);
  try {
    await mkdir(join(dir, 'out'), { recursive: true });
    await writeFile(join(dir, 'out', 'history.sqlite'), 'garbage');
    const view = await teamView(config);
    assert.equal(view.current, null); assert.match(view.warnings[0]!, /Run history is unreadable/); assert.match(view.markdown, /Run history is unreadable/);
    await assert.rejects(teamView(join(dir, 'missing.json')), 'an unreadable configuration is an error');
    const id = '11111111-1111-4111-8111-111111111111';
    await mkdir(join(dir, 'out', id)); await writeFile(join(dir, 'out', id, 'report.json'), '{ not json');
    await assert.rejects(teamView(config), 'a corrupt stored run is an error, not an empty view');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
