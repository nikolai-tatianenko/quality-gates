import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { recordRun, historyPath, type HistoryGate, type HistoryRun } from '../packages/core/src/history.js';
import { commandTools, compareVersions, doctorCommand, listCommand, MIN_NODE, runDoctor } from '../packages/cli/src/doctor.js';

const entry = resolve('packages/cli/src/index.ts');
function cli(dir: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((res, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args, '--config', join(dir, '.qualitygate.yml')], { env: { ...process.env, CHROME_PATH: '/qualitygate-no-such-chrome' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.once('error', reject); child.once('close', code => res({ code, stdout, stderr }));
  });
}
async function project(config: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'qg-doctor-'));
  await writeFile(join(dir, '.qualitygate.yml'), JSON.stringify({ schemaVersion: 1, outputDir: 'out', ...config }));
  return dir;
}
const thresholds = { performance: 1, accessibility: 1, seo: 1, 'best-practices': 1 };
const gate = (id: string, status: HistoryGate['status'], durationMs = 10): HistoryGate => ({ id, status, durationMs });
const hrun = (id: string, startedAt: string, gates: HistoryGate[]): HistoryRun => ({ id, startedAt, finishedAt: startedAt, execution: 'completed', decision: 'PASS', durationMs: 1000, gates });
/** An executable named `name` in a fresh directory, to be used as a one-entry PATH. */
async function fakeTool(dir: string, name: string) {
  const bin = join(dir, 'bin'); await mkdir(bin, { recursive: true });
  await writeFile(join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
  return bin;
}
const check = (report: Awaited<ReturnType<typeof runDoctor>>, id: string) => report.checks.find(c => c.id === id)!;
const echo = { gates: [{ id: 'lint', run: 'echo ok' }] };
const NODE = 'v22.30.0';

test('commandTools extracts the programs a shell command line runs', () => {
  assert.deepEqual(commandTools('pnpm lint'), ['pnpm']);
  assert.deepEqual(commandTools('FOO=1 BAR="x y" ruff check . && cd sub; ./scripts/go.sh | tee out || exit 1'), ['ruff', './scripts/go.sh', 'tee']);
  assert.deepEqual(commandTools('cd app && echo "$HOME" && "$TOOL" run && eval x'), []);
  assert.deepEqual(commandTools('  '), []);
  assert.deepEqual(commandTools('node a.js && node b.js'), ['node']);
});

test('compareVersions orders dotted versions numerically', async () => {
  assert.equal(compareVersions('22.23.4', '22.23.4'), 0);
  assert.ok(compareVersions('v22.9.0', '22.23.4') < 0);
  assert.ok(compareVersions('22.23.5', '22.23.4') > 0);
  assert.ok(compareVersions('23.0.0', '22.99.99') > 0);
  assert.equal(`>=${MIN_NODE}`, JSON.parse(await readFile('package.json', 'utf8')).engines.node);
});

test('list shows every gate with the newest recorded result, never the command, in config order', async () => {
  const dir = await project({ gates: [{ id: 'lint', run: 'echo SECRET-RUN-COMMAND' }, { id: 'test', run: 'echo x' }, { id: 'fresh', type: 'eslint', run: 'echo y' }] });
  try {
    await recordRun(join(dir, 'out'), hrun('r1', '2026-11-01T10:00:00.000Z', [gate('lint', 'failed', 5), gate('test', 'passed', 7)]));
    await recordRun(join(dir, 'out'), hrun('r2', '2026-11-02T10:00:00.000Z', [gate('lint', 'passed', 1500)]));
    const parsed = JSON.parse(await listCommand(join(dir, '.qualitygate.yml'), true));
    assert.deepEqual(parsed, { schemaVersion: 1, gates: [
      { id: 'lint', type: 'command', last: { runId: 'r2', startedAt: '2026-11-02T10:00:00.000Z', status: 'passed', durationMs: 1500 } },
      { id: 'test', type: 'command', last: { runId: 'r1', startedAt: '2026-11-01T10:00:00.000Z', status: 'passed', durationMs: 7 } },
      { id: 'fresh', type: 'eslint', last: null }] });
    const text = await listCommand(join(dir, '.qualitygate.yml'), false);
    assert.match(text, /lint\s+command\s+passed\s+2026-11-02T10:00:00.000Z\s+1.5s/);
    assert.match(text, /fresh\s+eslint\s+never run/);
    assert.doesNotMatch(text, /SECRET-RUN-COMMAND/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('list works without history, with a URL-only config and survives a corrupt database', async () => {
  const dir = await project({ urls: ['https://example.com'], thresholds });
  const withGate = await project(echo);
  try {
    const config = join(dir, '.qualitygate.yml');
    assert.deepEqual(JSON.parse(await listCommand(config, true)), { schemaVersion: 1, gates: [] });
    assert.match(await listCommand(config, false), /No gates configured\./);
    for (const where of [dir, withGate]) { await mkdir(join(where, 'out')); await writeFile(historyPath(join(where, 'out')), 'not a database'.repeat(50)); }
    assert.match(JSON.parse(await listCommand(config, true)).warning, /^run history unreadable/);
    const text = await listCommand(join(withGate, '.qualitygate.yml'), false);
    assert.match(text, /lint\s+command\s+never run/); assert.match(text, /Warning: run history unreadable/);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(withGate, { recursive: true, force: true }); }
});

test('list rejects a broken config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-doctor-'));
  try { await assert.rejects(listCommand(join(dir, '.qualitygate.yml'), true)); } finally { await rm(dir, { recursive: true, force: true }); }
});

test('doctor reports a healthy project: node, config, tools, output directory; Chrome skipped without URLs', async () => {
  const dir = await project({ gates: [{ id: 'a', run: 'faketool --x && cd . ', fix: 'faketool --fix' }, { id: 'b', type: 'eslint', run: 'faketool' }] });
  try {
    const bin = await fakeTool(dir, 'faketool');
    const config = join(dir, '.qualitygate.yml');
    const report = await runDoctor(config, { PATH: bin }, NODE);
    assert.equal(report.healthy, true);
    assert.deepEqual(report.checks.map(c => [c.id, c.status]), [['node', 'ok'], ['config', 'ok'], ['chrome', 'skipped'], ['tool:faketool', 'ok'], ['output-dir', 'ok'], ['history', 'skipped']]);
    assert.match(check(report, 'tool:faketool').detail, /gates: a, b/);
    const out = await doctorCommand(config, true, { PATH: bin });
    assert.equal(out.code, 0); assert.equal(JSON.parse(out.text).schemaVersion, 1);
    const plain = await doctorCommand(config, false, { PATH: bin });
    assert.match(plain.text, /ok\s+node/); assert.match(plain.text, /skipped\s+chrome/); assert.match(plain.text, /Everything needed is in place\./);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('doctor fails an old Node, a missing tool and a missing Chrome when URLs are configured', async () => {
  const dir = await project({ urls: ['https://example.com'], thresholds, gates: [{ id: 'a', run: 'no-such-tool-qg --go' }, { id: 'b', run: './missing/script.sh' }, { id: 'c', run: './present.sh' }] });
  try {
    await writeFile(join(dir, 'present.sh'), '#!/bin/sh\n', { mode: 0o755 });
    const config = join(dir, '.qualitygate.yml');
    const env = { PATH: '', CHROME_PATH: '/qualitygate-no-such-chrome' };
    const report = await runDoctor(config, env, 'v22.1.0');
    assert.equal(report.healthy, false);
    assert.equal(check(report, 'node').status, 'fail'); assert.match(check(report, 'node').detail, /22\.1\.0.*22\.23\.4/);
    assert.equal(check(report, 'chrome').status, 'fail');
    assert.equal(check(report, 'tool:no-such-tool-qg').status, 'fail');
    assert.equal(check(report, 'tool:./missing/script.sh').status, 'fail');
    assert.equal(check(report, 'tool:./present.sh').status, 'ok');
    const out = await doctorCommand(config, false, env);
    assert.equal(out.code, 2); assert.match(out.text, /Problems found/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('doctor finds Chrome through CHROME_PATH and rejects a non-executable file', async () => {
  const dir = await project({ urls: ['https://example.com'], thresholds, gates: [{ id: 'a', run: 'faketool' }] });
  try {
    const bin = await fakeTool(dir, 'faketool'); const chrome = join(bin, 'faketool');
    const config = join(dir, '.qualitygate.yml');
    const found = await runDoctor(config, { PATH: bin, CHROME_PATH: chrome }, NODE);
    assert.equal(check(found, 'chrome').status, 'ok'); assert.equal(check(found, 'chrome').detail, chrome);
    await chmod(chrome, 0o644);
    const plain = await runDoctor(config, { PATH: bin, CHROME_PATH: chrome }, NODE);
    assert.equal(check(plain, 'chrome').status, 'fail'); assert.equal(check(plain, 'tool:faketool').status, 'fail');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('doctor falls back to chrome-launcher discovery when CHROME_PATH is unset', async () => {
  const dir = await project({ urls: ['https://example.com'], thresholds });
  try {
    const report = await runDoctor(join(dir, '.qualitygate.yml'), { PATH: '' }, NODE);
    assert.ok(['ok', 'fail'].includes(check(report, 'chrome').status), 'depends on the machine, so only the shape is asserted');
    assert.ok(check(report, 'chrome').detail.length > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('doctor reports a broken config, skips the checks that need it and never echoes file content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-doctor-'));
  try {
    const config = join(dir, '.qualitygate.yml');
    const cases: [string, RegExp][] = [
      ['schemaVersion: 1\ngates:\n  - id: a\n    run: x\n    token: hunter2-secret\n', /Unrecognized key/],
      ['secret: "hunter2-secret\n  bad: [\n', /./],
    ];
    for (const [content, expected] of cases) {
      await writeFile(config, content);
      const report = await runDoctor(config, { PATH: '' }, NODE);
      assert.equal(report.healthy, false);
      assert.equal(check(report, 'config').status, 'fail'); assert.match(check(report, 'config').detail, expected);
      assert.deepEqual(report.checks.map(c => c.id), ['node', 'config']);
      const out = await doctorCommand(config, true, { PATH: '' });
      assert.equal(out.code, 2); assert.doesNotMatch(out.text, /hunter2/);
    }
    await rm(config);
    assert.equal(check(await runDoctor(config, {}, NODE), 'config').status, 'fail');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('doctor checks the output directory without creating it, and the history database', async () => {
  const dir = await project(echo);
  try {
    const config = join(dir, '.qualitygate.yml');
    const env = { PATH: '' };
    assert.equal(check(await runDoctor(config, env, NODE), 'output-dir').status, 'ok');
    await assert.rejects(readFile(join(dir, 'out', 'history.sqlite')), 'doctor creates nothing');
    await recordRun(join(dir, 'out'), hrun('r1', '2026-11-01T10:00:00.000Z', [gate('lint', 'passed')]));
    const seen = await runDoctor(config, env, NODE);
    assert.equal(check(seen, 'history').status, 'ok'); assert.match(check(seen, 'history').detail, /1 run/);
    await writeFile(historyPath(join(dir, 'out')), 'not a database'.repeat(50));
    const corrupt = await runDoctor(config, env, NODE);
    assert.equal(check(corrupt, 'history').status, 'warn'); assert.equal(corrupt.healthy, true);
    await rm(join(dir, 'out'), { recursive: true });
    await writeFile(join(dir, 'out'), 'a file, not a directory');
    const blocked = await runDoctor(config, env, NODE);
    assert.equal(check(blocked, 'output-dir').status, 'fail'); assert.equal(blocked.healthy, false);
    await rm(join(dir, 'out')); await mkdir(join(dir, 'out')); await chmod(join(dir, 'out'), 0o500);
    if (process.getuid?.() !== 0) assert.equal(check(await runDoctor(config, env, NODE), 'output-dir').status, 'fail');
    await chmod(join(dir, 'out'), 0o700);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('doctor checks the nearest existing parent when the output directory is nested and absent', async () => {
  const dir = await project({ ...echo, outputDir: 'a/b/c' });
  try {
    const report = await runDoctor(join(dir, '.qualitygate.yml'), { PATH: '' }, NODE);
    assert.equal(check(report, 'output-dir').status, 'ok');
    await assert.rejects(readFile(join(dir, 'a')), 'nothing was created');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI: list and doctor honour --json, --config, exit codes and reject extra arguments', async () => {
  const dir = await project(echo);
  try {
    const list = await cli(dir, ['list', '--json']);
    assert.equal(list.code, 0); assert.equal(list.stderr, ''); assert.equal(JSON.parse(list.stdout).gates[0].id, 'lint');
    const doctor = await cli(dir, ['doctor', '--json']);
    assert.equal(doctor.code, 0, doctor.stdout); assert.equal(JSON.parse(doctor.stdout).healthy, true);
    assert.match((await cli(dir, ['doctor'])).stdout, /ok\s+config/);
    assert.match((await cli(dir, ['list'])).stdout, /lint\s+command\s+never run/);
    for (const command of ['list', 'doctor']) {
      const extra = await cli(dir, [command, 'surplus', '--json']);
      assert.equal(extra.code, 2); assert.equal(extra.stderr, '');
      assert.equal((await cli(dir, [command, '--limit', '3', '--json'])).code, 2);
    }
    assert.match((await cli(dir, ['--help'])).stdout, /qualitygate list .*\n.*qualitygate doctor /);
    await writeFile(join(dir, '.qualitygate.yml'), 'schemaVersion: 1\nbogus: true\n');
    const broken = await cli(dir, ['doctor', '--json']);
    assert.equal(broken.code, 2); assert.equal(JSON.parse(broken.stdout).checks.find((c: { id: string }) => c.id === 'config').status, 'fail');
    const brokenList = await cli(dir, ['list', '--json']);
    assert.equal(brokenList.code, 2); assert.equal(JSON.parse(brokenList.stdout).execution, 'error');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
