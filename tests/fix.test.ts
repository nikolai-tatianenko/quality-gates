import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { configSchema, fixResultSchema, type GateSpec } from '../packages/protocol/src/index.js';
import { dirtyFiles, fixGates, selectFixIds, describeFix, type FixEvent } from '../packages/cli/src/fix.js';
import { readGatesFile } from '../packages/cli/src/gates-file.js';
import { runArgsSchema } from '../packages/service/src/index.js';

const gate = (id: string, patch: Partial<GateSpec> = {}): GateSpec => ({ id, type: 'command', run: 'true', ...patch });
const node = (code: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
// "lint" passes only once a.txt contains FIXED; its fix command writes that word.
const check = node('process.exit(require("fs").readFileSync("a.txt","utf8").includes("FIXED") ? 0 : 1)');
const rewrite = node('require("fs").writeFileSync("a.txt","FIXED\\n")');

async function project(files: Record<string, unknown>, options: { git?: boolean; commit?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qg-fix-'));
  await writeFile(join(dir, 'a.txt'), 'broken\n');
  await writeFile(join(dir, '.gitignore'), '.qualitygate/\n');
  const gates = Object.entries(files).map(([id, patch]) => ({ id, run: 'true', ...(patch as object) }));
  const config = join(dir, '.qualitygate.yml');
  await writeFile(config, stringify(configSchema.parse({ schemaVersion: 1, gates })));
  if (options.git !== false) {
    const run = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' });
    run('init', '-q'); run('add', '-A'); if (options.commit !== false) run('commit', '-q', '-m', 'init');
  }
  return { dir, config, done: () => rm(dir, { recursive: true, force: true }) };
}
const signal = () => new AbortController().signal;

test('selectFixIds prefers blocked gates, falls back to every fixable gate and validates explicit ids', () => {
  const gates = [gate('lint', { fix: 'a' }), gate('fmt', { fix: 'b' }), gate('tests')];
  assert.deepEqual(selectFixIds(gates, undefined, ['fmt', 'tests']), ['fmt']);
  assert.deepEqual(selectFixIds(gates, undefined, []), ['lint', 'fmt']);
  assert.deepEqual(selectFixIds(gates, undefined, ['tests']), ['lint', 'fmt']);
  assert.deepEqual(selectFixIds(gates, ['fmt', 'fmt'], ['lint']), ['fmt']);
  assert.throws(() => selectFixIds(gates, ['nope'], []), /Unknown gate: nope/);
  assert.throws(() => selectFixIds(gates, ['tests'], []), /No fix command is configured for gate: tests/);
  assert.throws(() => selectFixIds([gate('tests')], undefined, []), /No gate declares a fix command/);
});

test('a fix rewrites files, the re-run decides, and before/after plus the diff stat are reported', async () => {
  const p = await project({ lint: { run: check, fix: rewrite }, other: { run: 'true' } });
  try {
    const events: FixEvent[] = []; const ran: string[] = [];
    const result = await fixGates(p.config, signal(), { onFix: e => events.push(e), onProgress: e => { if (e.kind === 'start') ran.push(e.id); } });
    fixResultSchema.parse(result);
    assert.deepEqual(result.gates, [{ id: 'lint', fix: rewrite, fixExitCode: 0, after: 'PASS' }]);
    assert.deepEqual(ran, ['lint'], 'only the fixed gate is run again');
    assert.equal(result.run.decision, 'PASS');
    assert.match(result.diffStat!, /a\.txt/);
    assert.deepEqual(events.map(e => e.kind), ['fix-start', 'fix-end']);
    assert.deepEqual(result.warnings, []);
    assert.match(describeFix(result).join('\n'), /lint: not run before -> PASS[\s\S]*a\.txt/);
  } finally { await p.done(); }
});

test('the decision before comes from the last run and a fix that repairs nothing still blocks', async () => {
  const p = await project({ lint: { run: 'exit 1', fix: 'true' }, ok: { run: 'true', fix: 'true' } });
  try {
    const first = await fixGates(p.config, signal());
    assert.deepEqual(first.gates.map(g => [g.id, g.before, g.after]), [['lint', undefined, 'BLOCK'], ['ok', undefined, 'PASS']]);
    assert.equal(first.run.decision, 'BLOCK');
    // The stored run now says lint blocked and ok passed: a default fix targets only lint.
    const second = await fixGates(p.config, signal());
    assert.deepEqual(second.gates.map(g => [g.id, g.before, g.after]), [['lint', 'BLOCK', 'BLOCK']]);
    assert.match(describeFix(second).join('\n'), /lint: BLOCK -> BLOCK/);
    assert.equal(second.diffStat, '');
    assert.match(describeFix(second).join('\n'), /changed no tracked file/);
  } finally { await p.done(); }
});

test('a failing fix command is reported and the gate is still run again', async () => {
  const p = await project({ lint: { run: check, fix: 'exit 3' } });
  try {
    const result = await fixGates(p.config, signal());
    assert.equal(result.gates[0]!.fixExitCode, 3);
    assert.equal(result.gates[0]!.fixError, 'fix exited with 3');
    assert.equal(result.run.decision, 'BLOCK');
    assert.match(describeFix(result).join('\n'), /fix exited with 3/);
  } finally { await p.done(); }
});

test('the gate timeout applies to the fix command', async () => {
  const p = await project({ lint: { run: 'true', fix: 'sleep 5', timeoutMs: 300 } });
  try {
    const started = Date.now();
    const result = await fixGates(p.config, signal());
    assert.match(result.gates[0]!.fixError!, /timed out after 300ms/);
    assert.ok(Date.now() - started < 4000);
  } finally { await p.done(); }
});

test('uncommitted changes stop the fix unless --allow-dirty, and the output folder does not count', async () => {
  const p = await project({ lint: { run: check, fix: rewrite } });
  try {
    await writeFile(join(p.dir, 'mine.txt'), 'work in progress\n');
    await assert.rejects(fixGates(p.config, signal()), /Refusing to fix: the working tree has 1 uncommitted change\(s\) and fixes rewrite files/);
    assert.equal(await readFile(join(p.dir, 'a.txt'), 'utf8'), 'broken\n', 'nothing was rewritten');
    assert.equal((await fixGates(p.config, signal(), { allowDirty: true })).run.decision, 'PASS');
    assert.deepEqual(await dirtyFiles(p.dir, join(p.dir, '.qualitygate')), ['a.txt', 'mine.txt']);
  } finally { await p.done(); }
});

test('generated files under an output directory that is not git-ignored do not make the tree dirty', async () => {
  const p = await project({ lint: { run: check, fix: rewrite } });
  try {
    await writeFile(join(p.dir, '.gitignore'), '');
    const commit = (text: string) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qam', text], { cwd: p.dir });
    commit('no ignore');
    await fixGates(p.config, signal(), { gates: ['lint'] });
    commit('fixed');
    assert.deepEqual(await dirtyFiles(p.dir, join(p.dir, '.qualitygate')), []);
    assert.ok((await dirtyFiles(p.dir, join(p.dir, 'elsewhere')))!.some(file => file.startsWith('.qualitygate/')), 'without the exclusion the run output shows up');
  } finally { await p.done(); }
});

test('outside a git repository the fix runs with a warning and no diff', async () => {
  const p = await project({ lint: { run: check, fix: rewrite } }, { git: false });
  try {
    const result = await fixGates(p.config, signal());
    assert.match(result.warnings[0]!, /Not a git repository/);
    assert.equal(result.diffStat, undefined);
    assert.equal(result.run.decision, 'PASS');
    assert.match(describeFix(result).join('\n'), /No diff: not a git repository/);
    assert.equal(await dirtyFiles(p.dir, join(p.dir, '.qualitygate')), undefined);
  } finally { await p.done(); }
});

test('an interrupt stops the fix process group and nothing is run again', async () => {
  const p = await project({ lint: { run: 'true', fix: `touch started; sleep 30; touch finished` } });
  try {
    const controller = new AbortController();
    const ran: string[] = [];
    const pending = fixGates(p.config, controller.signal, { onProgress: e => ran.push(e.kind) });
    for (let i = 0; i < 100; i++) { if (await access(join(p.dir, 'started')).then(() => true, () => false)) break; await delay(50); }
    controller.abort();
    await assert.rejects(pending, /Interrupted/);
    assert.deepEqual(ran, []);
    await delay(300);
    assert.equal(await access(join(p.dir, 'finished')).then(() => true, () => false), false);
  } finally { await p.done(); }
});

test('fix is read from the project gate list and never accepted from the service input', async () => {
  const p = await project({ lint: { run: 'true' } });
  try {
    await writeFile(join(p.dir, 'gates.json'), JSON.stringify([{ id: 'Lint', run: 'x', fix: ' x --fix ' }, { id: 'tests', run: 'y' }]));
    assert.deepEqual(await readGatesFile(join(p.dir, 'gates.json')), [{ id: 'lint', run: 'x', fix: 'x --fix' }, { id: 'tests', run: 'y' }]);
  } finally { await p.done(); }
  assert.throws(() => runArgsSchema.parse({ gates: ['lint'], fix: 'rm -rf /' }));
});

const entry = resolve('packages/cli/src/index.ts');
function cli(args: string[], cwd: string) {
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), entry, ...args], { cwd, env: { ...process.env, CI: '1' } });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const closed = new Promise<{ code: number | null; stdout: string; stderr: string }>((res, rej) => { child.once('error', rej); child.once('close', code => res({ code, stdout, stderr })); });
  return Object.assign(closed, { child });
}

test('qualitygate fix: text and JSON output, exit codes, and option validation', async () => {
  const p = await project({ lint: { run: check, fix: rewrite }, stuck: { run: 'exit 1', fix: 'true' } });
  try {
    const refused = await cli(['fix', '--gate', 'stuck', '--json'], p.dir);
    assert.equal(refused.code, 1);
    assert.equal(fixResultSchema.parse(JSON.parse(refused.stdout)).run.decision, 'BLOCK');
    await rm(join(p.dir, '.qualitygate'), { recursive: true, force: true });
    const text = await cli(['fix', '--gate', 'lint'], p.dir);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /lint: not run before -> PASS[\s\S]*a\.txt[\s\S]*PASS \(completed\)/);
    const dirty = await cli(['fix', '--json'], p.dir);
    assert.equal(dirty.code, 2); assert.match(JSON.parse(dirty.stdout).errors[0], /Refusing to fix/);
    for (const args of [['run', '--allow-dirty'], ['fix', 'extra'], ['fix', '--changed'], ['ui', 'x']]) assert.equal((await cli([...args, '--json'], p.dir)).code, 2, args.join(' '));
    assert.match((await cli(['--help'], p.dir)).stdout, /qualitygate fix .*--allow-dirty/);
    assert.equal((await cli(['fix', '--gate', 'nope', '--json'], p.dir)).code, 2);
    const allowed = await cli(['fix', '--allow-dirty', '--gate', 'stuck'], p.dir);
    assert.equal(allowed.code, 1); assert.match(allowed.stdout, /stuck: (BLOCK|not run before) -> BLOCK/);
  } finally { await p.done(); }
});

test('Ctrl+C during qualitygate fix exits 130', async () => {
  const p = await project({ lint: { run: 'true', fix: 'touch started; sleep 30' } });
  try {
    const running = cli(['fix'], p.dir);
    for (let i = 0; i < 200; i++) { if (await access(join(p.dir, 'started')).then(() => true, () => false)) break; await delay(50); }
    running.child.kill('SIGINT');
    const result = await running;
    assert.equal(result.code, 130, result.stderr);
  } finally { await p.done(); }
});
