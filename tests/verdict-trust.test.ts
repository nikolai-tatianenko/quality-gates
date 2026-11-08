import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { configSchema, coverageLine, EXIT, exitCode, runResultSchema, stepStatus, type RunResult } from '../packages/protocol/src/index.js';
import { executionStatus } from '../packages/core/src/execution.js';
import { run } from '../packages/core/src/index.js';
import { commandPlugin } from '../packages/plugins/command/src/index.js';
import { builtinParsers } from '../packages/plugins/parsers/src/index.js';
import { filesystemPlugin } from '../packages/plugins/storage-fs/src/index.js';
import { jsonReporter } from '../packages/plugins/reporter-json/src/index.js';
import { renderHtml, renderMarkdown } from '../packages/ci/src/index.js';
import { verdict } from '../packages/ci/src/notify.js';

const exec = promisify(execFile);
const entry = resolve('packages/cli/src/index.ts');
type Gate = Record<string, unknown> & { id: string; run: string };

async function project(config: Record<string, unknown>, files: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qg-trust-'));
  await writeFile(join(dir, '.qualitygate.yml'), JSON.stringify({ schemaVersion: 1, outputDir: 'out', ...config }));
  for (const [name, content] of Object.entries(files)) { await mkdir(join(dir, name, '..'), { recursive: true }); await writeFile(join(dir, name), content); }
  return dir;
}
function cli(dir: string, args: string[], onStart?: (child: ReturnType<typeof spawn>) => void) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((res, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args, '--config', join(dir, '.qualitygate.yml')]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.once('error', reject); child.once('close', code => res({ code, stdout, stderr }));
    onStart?.(child);
  });
}
async function inProject<T>(config: Record<string, unknown>, files: Record<string, string>, fn: (dir: string) => Promise<T>) {
  const dir = await project(config, files);
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function direct(dir: string, gates: Gate[], extra: Record<string, unknown> = {}, only?: string[]) {
  const config = configSchema.parse({ schemaVersion: 1, gates, outputDir: join(dir, 'out'), ...extra });
  return run(config, { gate: commandPlugin(dir, builtinParsers), storage: filesystemPlugin(config.outputDir), reporter: jsonReporter }, undefined, only);
}
const runJson = async (dir: string, args: string[] = []) => runResultSchema.parse(JSON.parse((await cli(dir, ['run', '--json', ...args])).stdout));

test('exit-code contract: 0 pass, 1 block, 2 error, 3 timeout, 130 interrupted; an error outranks a timeout', () => {
  const code = (execution: RunResult['execution'], decision: RunResult['decision']) => exitCode({ execution, decision } as RunResult);
  assert.deepEqual(EXIT, { pass: 0, block: 1, error: 2, timeout: 3, interrupted: 130 });
  assert.equal(code('completed', 'PASS'), 0); assert.equal(code('completed', 'BLOCK'), 1);
  assert.equal(code('error', 'BLOCK'), 2); assert.equal(code('timeout', 'BLOCK'), 3); assert.equal(code('interrupted', 'BLOCK'), 130);
  const result = (...executions: string[]) => ({ errors: [], results: [], gates: executions.map(execution => ({ execution })) }) as unknown as RunResult;
  const signal = new AbortController().signal;
  assert.equal(executionStatus(result('completed', 'timeout'), signal), 'timeout');
  assert.equal(executionStatus(result('timeout', 'error'), signal), 'error');
  assert.equal(executionStatus(result('completed'), signal), 'completed');
  const aborted = new AbortController(); aborted.abort();
  assert.equal(executionStatus(result('timeout'), aborted.signal), 'interrupted');
});

test('the CLI exits with each documented code', async () => {
  await inProject({ gates: [{ id: 'ok', run: 'true' }] }, {}, async dir => assert.equal((await cli(dir, ['run'])).code, 0));
  await inProject({ gates: [{ id: 'bad', run: 'exit 1' }] }, {}, async dir => assert.equal((await cli(dir, ['run'])).code, 1));
  await inProject({ gates: [{ id: 'slow', run: 'sleep 30', timeoutMs: 400 }] }, {}, async dir => {
    const result = await cli(dir, ['run']);
    assert.equal(result.code, 3); assert.match(result.stdout, /^BLOCK \(timeout\)$/m);
  });
  await inProject({ gates: [{ id: 'ok', run: 'true' }] }, {}, async dir => assert.equal((await cli(dir, ['run', '--gate', 'nope'])).code, 2));
  await inProject({ gates: [{ id: 'hang', run: 'touch started; sleep 30' }] }, {}, async dir => {
    // The gate creates the marker only once the CLI is loaded and running, so SIGINT never races tsx start-up under load.
    const result = await cli(dir, ['run'], child => {
      const poll = setInterval(() => { if (existsSync(join(dir, 'started'))) { clearInterval(poll); child.kill('SIGINT'); } }, 50);
      child.once('close', () => clearInterval(poll));
    });
    assert.equal(result.code, 130);
  });
});

test('a timeout keeps what the partial report showed: passed N, failed 0, stopped by timeout', async () => {
  const xml = '<testsuite><testcase classname="a" name="one"/><testcase classname="a" name="two"/></testsuite>';
  await inProject({}, {}, async dir => {
    const result = await direct(dir, [{ id: 'unit', run: `printf '${xml}' > report.xml; sleep 30`, timeoutMs: 800, report: { format: 'junit', path: 'report.xml' } }]);
    const [gate] = result.gates;
    assert.equal(gate!.execution, 'timeout'); assert.equal(gate!.decision, 'BLOCK'); assert.deepEqual(gate!.counts, { passed: 2, failed: 0, skipped: 0 });
    assert.match(gate!.errors.join(), /timed out after 800ms: passed 2, failed 0, stopped by timeout/);
    assert.equal(result.execution, 'timeout'); assert.equal(exitCode(result), 3);
  });
  await inProject({}, {}, async dir => {
    const garbage = await direct(dir, [{ id: 'unit', run: "printf 'not xml' > report.xml; sleep 30", timeoutMs: 800, report: { format: 'junit', path: 'report.xml' } }]);
    assert.equal(garbage.gates[0]!.execution, 'timeout'); assert.match(garbage.gates[0]!.errors.join(), /timed out after 800ms$/);
    assert.equal(garbage.gates[0]!.counts, undefined);
    const missing = await direct(dir, [{ id: 'none', run: 'sleep 30', timeoutMs: 800, report: { format: 'junit', path: 'absent.xml' } }]);
    assert.equal(missing.gates[0]!.execution, 'timeout'); assert.match(missing.gates[0]!.outputTail, /Report not found: absent\.xml/);
  });
});

test('the step registry lists every configured gate, including the ones that did not run', async () => {
  await inProject({ gates: [{ id: 'a', run: 'true' }, { id: 'b', run: 'exit 1' }, { id: 'c', run: 'true' }] }, {}, async dir => {
    const partial = await runJson(dir, ['--only', 'a']);
    assert.deepEqual(partial.steps, [{ id: 'a', kind: 'gate', status: 'passed' }, { id: 'b', kind: 'gate', status: 'not-run' }, { id: 'c', kind: 'gate', status: 'not-run' }]);
    assert.equal(coverageLine(partial), '1 of 3 steps ran'); assert.equal(partial.decision, 'PASS');
    const text = await cli(dir, ['run', '--gate', 'a']);
    assert.match(text.stdout, /Steps: 1 of 3 steps ran \(not run: b, c\)/);
    const full = await runJson(dir);
    assert.deepEqual(full.steps.map(step => step.status), ['passed', 'failed', 'passed']);
  });
  assert.equal(stepStatus({ execution: 'skipped', decision: 'BLOCK' }), 'skipped');
  assert.equal(stepStatus({ execution: 'error', decision: 'BLOCK' }), 'error');
});

test('a gate whose dependency did not pass is skipped, and the run blocks instead of erroring', async () => {
  await inProject({}, {}, async dir => {
    const result = await direct(dir, [{ id: 'lint', run: 'exit 1' }, { id: 'build', run: 'true', dependsOn: ['lint'] }, { id: 'docs', run: 'true' }]);
    assert.equal(result.gates[1]!.skipped, 'dependency lint did not pass'); assert.equal(result.gates[1]!.decision, 'BLOCK');
    assert.deepEqual(result.steps.map(step => step.status), ['failed', 'skipped', 'passed']);
    assert.equal(result.execution, 'completed'); assert.equal(exitCode(result), 1);
    const selected = await direct(dir, [{ id: 'lint', run: 'exit 1' }, { id: 'build', run: 'true', dependsOn: ['lint'] }], {}, ['build']);
    assert.equal(selected.gates[0]!.decision, 'PASS');
  });
});

test('gate dependencies must name known gates and may not form a cycle', () => {
  const parse = (gates: object[]) => configSchema.safeParse({ schemaVersion: 1, gates });
  assert.ok(parse([{ id: 'a', run: 'true' }, { id: 'b', run: 'true', dependsOn: ['a'] }]).success);
  assert.match(JSON.stringify(parse([{ id: 'a', run: 'true', dependsOn: ['ghost'] }]).error?.issues), /depends on unknown gate: ghost/);
  assert.match(JSON.stringify(parse([{ id: 'a', run: 'true', dependsOn: ['b'] }, { id: 'b', run: 'true', dependsOn: ['a'] }]).error?.issues), /form a cycle/);
  assert.match(JSON.stringify(parse([{ id: 'a', run: 'true', dependsOn: ['a'] }]).error?.issues), /form a cycle/);
});

test('independent gates run in parallel unless concurrency is 1', async () => {
  await inProject({}, {}, async dir => {
    const gates = [{ id: 'one', run: 'sleep 0.7' }, { id: 'two', run: 'sleep 0.7' }, { id: 'three', run: 'sleep 0.7' }];
    const started = Date.now(); const parallel = await direct(dir, gates);
    assert.ok(Date.now() - started < 1900, 'three 0.7 s gates overlap'); assert.deepEqual(parallel.gates.map(gate => gate.id), ['one', 'two', 'three']);
    const limited = Date.now(); await direct(dir, gates, { concurrency: 1 });
    assert.ok(Date.now() - limited >= 2000, 'concurrency 1 runs them one after another');
    const two = Date.now(); await direct(dir, gates, { concurrency: 2 });
    assert.ok(Date.now() - two >= 1300, 'concurrency 2 needs two rounds');
  });
});

test('the terminal shows one line per gate with its log path and keeps npm and pnpm warnings in the log', async () => {
  await inProject({ gates: [{ id: 'ok', run: 'echo fine' }, { id: 'noisy', run: 'echo "npm warn deprecated left-pad"; echo "WARN  Unsupported engine"; echo "real failure"; exit 1' }] }, {}, async dir => {
    const result = await cli(dir, ['run']);
    assert.match(result.stdout, /^PASS gate ok \(completed, exit 0, \d+ms\) log: .*gate-1-ok\.log$/m);
    assert.match(result.stdout, /^BLOCK gate noisy .* log: .*gate-2-noisy\.log$/m);
    assert.match(result.stdout, /\| real failure/); assert.doesNotMatch(result.stdout, /npm warn|WARN {2}Unsupported/);
    const log = await readFile(join(dir, 'out', (await runJson(dir)).gates[1]!.evidencePath!.split('/').slice(-2).join('/')), 'utf8').catch(() => '');
    assert.match(log, /npm warn deprecated left-pad/);
  });
});

test('--only is an alias of --gate and is rejected outside run', async () => {
  await inProject({ gates: [{ id: 'a', run: 'true' }, { id: 'b', run: 'exit 1' }] }, {}, async dir => {
    assert.equal((await cli(dir, ['run', '--only', 'a'])).code, 0);
    assert.match((await cli(dir, ['setup', '--only', 'a'])).stderr, /setup does not accept --gate or --only/);
    assert.match((await cli(dir, ['inspect', '--changed'])).stderr, /inspect does not accept --changed or --cache/);
    assert.match((await cli(dir, ['run', '--no-gitignore'])).stderr, /run does not accept --no-gitignore/);
  });
});

test('--changed runs gates without inputs and gates whose inputs changed, and needs a git repository', async () => {
  const gates = [{ id: 'src', run: 'true', inputs: ['src/**/*.ts'] }, { id: 'docs', run: 'true', inputs: ['docs/*.md'] }, { id: 'always', run: 'true' }];
  await inProject({ gates }, { 'src/a.ts': 'a', 'docs/x.md': 'x' }, async dir => {
    assert.match((await cli(dir, ['run', '--changed'])).stderr, /--changed needs a git repository/);
    const git = (...args: string[]) => exec('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: dir });
    await git('init', '-q'); await git('add', '-A'); await git('commit', '-q', '-m', 'init');
    await writeFile(join(dir, 'src', 'a.ts'), 'changed');
    const changed = await runJson(dir, ['--changed']);
    assert.deepEqual(changed.steps.map(step => [step.id, step.status]), [['src', 'passed'], ['docs', 'not-run'], ['always', 'passed']]);
    await writeFile(join(dir, 'docs', 'new.md'), 'n');
    const both = await runJson(dir, ['--changed']);
    assert.deepEqual(both.steps.map(step => step.status), ['passed', 'passed', 'passed']);
    const narrowed = await runJson(dir, ['--changed', '--only', 'docs', '--only', 'always']);
    assert.deepEqual(narrowed.steps.map(step => step.status), ['not-run', 'passed', 'passed']);
  });
});

test('--cache skips a gate whose inputs are unchanged since it passed, and never caches a failure', async () => {
  const gates = [{ id: 'build', run: 'echo ran >> ran.log', inputs: ['src/*.ts'] }, { id: 'flaky', run: 'exit 1', inputs: ['src/*.ts'] },
    { id: 'empty', run: 'echo ran >> empty.log', inputs: ['nothing/*.ts'] }, { id: 'plain', run: 'true' }];
  await inProject({ gates, concurrency: 1 }, { 'src/a.ts': 'one' }, async dir => {
    const first = await runJson(dir, ['--cache']);
    assert.deepEqual(first.steps.map(step => step.status), ['passed', 'failed', 'passed', 'passed']);
    const second = await runJson(dir, ['--cache']);
    assert.deepEqual(second.steps.map(step => step.status), ['cached', 'failed', 'passed', 'passed']);
    assert.equal(second.gates[0]!.cached, true); assert.match(second.gates[0]!.outputTail, /Cached: inputs unchanged/);
    assert.equal((await readFile(join(dir, 'ran.log'), 'utf8')).trim().split('\n').length, 1);
    assert.equal((await readFile(join(dir, 'empty.log'), 'utf8')).trim().split('\n').length, 2);
    await writeFile(join(dir, 'src', 'a.ts'), 'two');
    assert.equal((await runJson(dir, ['--cache'])).steps[0]!.status, 'passed');
    assert.equal((await readFile(join(dir, 'ran.log'), 'utf8')).trim().split('\n').length, 2);
    await writeFile(join(dir, 'out', 'cache.json'), 'not json');
    assert.equal((await runJson(dir, ['--cache'])).steps[0]!.status, 'passed');
    await writeFile(join(dir, 'out', 'cache.json'), '[]');
    assert.equal((await runJson(dir, ['--cache'])).steps[0]!.status, 'passed');
    assert.equal((await runJson(dir)).steps[0]!.status, 'passed');
  });
});

test('CI reports show the step registry, skipped and cached gates, and a TIMEOUT verdict', async () => {
  await inProject({}, {}, async dir => {
    const partial = await direct(dir, [{ id: 'lint', run: 'exit 1' }, { id: 'build', run: 'true', dependsOn: ['lint'] }, { id: 'docs', run: 'true' }], {}, ['docs', 'build']);
    const markdown = renderMarkdown(partial); const html = renderHtml(partial);
    assert.match(markdown, /### Steps \(2 of 3 steps ran\)/); assert.match(markdown, /\| lint \| gate \| not-run \|/);
    assert.match(html, /Steps \(2 of 3 steps ran\)/); assert.match(html, />not-run<\/td>/);
    assert.match(verdict(partial).summary, /no gate blocked|blocked/);
    const passing = await direct(dir, [{ id: 'a', run: 'true' }, { id: 'b', run: 'true' }], {}, ['a']);
    assert.equal(verdict(passing).label, 'PASS'); assert.match(verdict(passing).summary, /no gate blocked, but only 1 of 2 steps ran/);
    const full = await direct(dir, [{ id: 'a', run: 'true' }]);
    assert.match(verdict(full).summary, /all gates passed/);
    const timeout = await direct(dir, [{ id: 'slow', run: 'sleep 30', timeoutMs: 400 }]);
    assert.equal(verdict(timeout).label, 'TIMEOUT'); assert.match(renderMarkdown(timeout), /## QualityGate: TIMEOUT/);
    const blocked = await direct(dir, [{ id: 'lint', run: 'exit 1' }, { id: 'build', run: 'true', dependsOn: ['lint'] }]);
    assert.match(renderMarkdown(blocked), /skipped \(dependency lint did not pass\)/); assert.match(renderHtml(blocked), /skipped \(dependency lint did not pass\)/);
    const cached = { ...full, gates: [{ ...full.gates[0]!, cached: true }] } as RunResult;
    assert.match(renderMarkdown(cached), /\| cached \|/); assert.match(renderHtml(cached), /<td>cached<\/td>/);
    assert.equal(verdict({ ...full, execution: 'error' } as RunResult).label, 'ERROR');
  });
});

test('dependsOn holds whatever order the gates are listed in', async () => {
  await inProject({}, {}, async dir => {
    // "build" is listed before the gate it depends on; it must still wait for lint and be skipped when lint fails.
    const failing = await direct(dir, [{ id: 'build', run: 'echo built > built.txt', dependsOn: ['lint'] }, { id: 'lint', run: 'sleep 0.3; exit 1' }]);
    assert.equal(failing.gates[0]!.skipped, 'dependency lint did not pass');
    await assert.rejects(readFile(join(dir, 'built.txt'), 'utf8'), /ENOENT/);
    const passing = await direct(dir, [{ id: 'build', run: 'test -f lint.done && echo ok', dependsOn: ['lint'] }, { id: 'lint', run: 'sleep 0.3; touch lint.done' }]);
    assert.deepEqual(passing.gates.map(gate => gate.decision), ['PASS', 'PASS']);
  });
});
