import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access, chmod } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { gateSchema } from '../packages/protocol/src/index.js';
import { commandPlugin } from '../packages/plugins/command/src/index.js';
import { builtinParsers } from '../packages/plugins/parsers/src/index.js';
import { unity, unityPrepare } from '../packages/plugins/ecosystems/src/unity.js';
const context = { signal: new AbortController().signal, defer() {} };
const exists = (path: string) => access(path).then(() => true, () => false);
async function withProject(fn: (dir: string) => Promise<void>, version = 'm_EditorVersion: 2022.3.10f1\nm_EditorVersionWithRevision: 2022.3.10f1 (abc)\n') {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'qg-unity-')));
  try {
    await mkdir(join(dir, 'ProjectSettings')); await writeFile(join(dir, 'ProjectSettings', 'ProjectVersion.txt'), version);
    await fn(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const fake = async (dir: string, name: string, body: string) => { const path = join(dir, name); await writeFile(path, `#!/bin/sh\n${body}\n`); await chmod(path, 0o755); return path; };

test('unity proposes a compile gate (unity-log) and an EditMode gate (nunit)', () => withProject(async dir => {
  const gates = (await unity.detect(dir))!;
  assert.deepEqual(gates.map(gate => gate.id), ['unity-compile', 'unity-tests']);
  assert.deepEqual(gates.map(gate => gate.report), [{ format: 'unity-log', path: '.qualitygate/unity/compile.log' }, { format: 'nunit', path: '.qualitygate/unity/editmode.xml' }]);
  assert.ok(gates.every(gate => gate.timeoutMs === 1800000));
  assert.ok(gates.every(gate => gate.run.includes('${UNITY:-/Applications/Unity/Hub/Editor/2022.3.10f1/Unity.app/Contents/MacOS/Unity}')));
  assert.match(gates[1]!.run, /-runTests -testPlatform EditMode -testResults \.qualitygate\/unity\/editmode\.xml/);
  for (const gate of gates) gateSchema.parse({ ...gate, type: 'command' });
}));

test('unity is absent without ProjectVersion.txt and rejects an unreadable version', async () => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'qg-unity-')));
  try { assert.equal(await unity.detect(dir), null); } finally { await rm(dir, { recursive: true, force: true }); }
  await withProject(async project => { await assert.rejects(unity.detect(project), /Unreadable Unity version/); }, 'nothing here\n');
});

/** Runs the prepare prefix with a fake `ps` that lists `lines` until the `done` file exists. */
async function prepare(dir: string, lines: string[], env: Record<string, string> = {}) {
  const bin = join(dir, 'bin'); await mkdir(bin, { recursive: true });
  await fake(bin, 'ps', `[ -f "${join(dir, 'done')}" ] && exit 0\ncat <<'EOF'\n${lines.join('\n')}\nEOF`);
  return { env: { ...process.env, ...env, PATH: `${bin}${delimiter}${process.env.PATH}` }, bin };
}
const batch = (dir: string, pid = 41) => `  ${pid} /Applications/Unity/Unity.app/Contents/MacOS/Unity -batchmode -nographics -projectPath ${dir} -runTests`;

test('the prepare prefix removes a stale lockfile and never waits for other projects', () => withProject(async dir => {
  await mkdir(join(dir, 'Temp')); await writeFile(join(dir, 'Temp', 'UnityLockfile'), '');
  const other = `${dir}-other`;
  const { env } = await prepare(dir, [batch(other), `  42 /Applications/Unity/Unity.app/Contents/MacOS/Unity -projectpath ${other}`, batch(`${dir}2`, 43)]);
  const started = Date.now();
  assert.equal(spawnSync(unityPrepare, { cwd: dir, shell: true, env }).status, 0);
  assert.ok(Date.now() - started < 900, 'must not wait');
  assert.equal(await exists(join(dir, 'Temp', 'UnityLockfile')), false);
  assert.equal(await exists(join(dir, '.qualitygate', 'unity')), true);
}));

test('the prepare prefix waits until the batch process of this project exits', () => withProject(async dir => {
  await mkdir(join(dir, 'Temp')); await writeFile(join(dir, 'Temp', 'UnityLockfile'), '');
  const { env } = await prepare(dir, [batch(dir)]);
  const child = spawn(unityPrepare, { cwd: dir, shell: true, env, stdio: 'ignore' });
  const exited = new Promise<number | null>(resolve => child.once('close', resolve));
  const started = Date.now();
  await new Promise(resolve => setTimeout(resolve, 1300)); await writeFile(join(dir, 'done'), '');
  assert.equal(await exited, 0); assert.ok(Date.now() - started >= 1300);
  assert.equal(await exists(join(dir, 'Temp', 'UnityLockfile')), false);
}));

test('the prepare prefix fails with a clear message when the batch process never exits', () => withProject(async dir => {
  await mkdir(join(dir, 'Temp')); await writeFile(join(dir, 'Temp', 'UnityLockfile'), '');
  const { env } = await prepare(dir, [batch(dir)], { QUALITYGATE_UNITY_WAIT: '1' });
  const result = spawnSync(unityPrepare, { cwd: dir, shell: true, env, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /still running for this project after 1s/);
  assert.equal(await exists(join(dir, 'Temp', 'UnityLockfile')), true);
}));

test('the prepare prefix refuses at once while an editor has this project open', () => withProject(async dir => {
  const { env } = await prepare(dir, [`  50 /Applications/Unity/Hub/Editor/2022.3.10f1/Unity.app/Contents/MacOS/Unity -projectpath ${dir}`]);
  const started = Date.now();
  const busy = spawnSync(unityPrepare, { cwd: dir, shell: true, env, encoding: 'utf8' });
  assert.equal(busy.status, 1); assert.match(busy.stderr, /open in an editor/);
  assert.ok(Date.now() - started < 900);
}));

test('generated gates name the project by absolute path so its processes can be told apart', () => withProject(async dir => {
  for (const gate of (await unity.detect(dir))!) assert.match(gate.run, /-projectPath "\$\(pwd -P\)"/);
}));

test('gates run the editor named by UNITY and yield findings with file and line', () => withProject(async dir => {
  const [compile, tests] = (await unity.detect(dir))!;
  const plugin = commandPlugin(dir, builtinParsers);
  const failing = await fake(dir, 'unity-compile.sh', "echo 'Assets/A.cs(3,4): error CS0103: nope' > .qualitygate/unity/compile.log; exit 1");
  const previous = process.env.UNITY;
  try {
    process.env.UNITY = failing;
    const compiled = await plugin.run(gateSchema.parse({ ...compile }), context);
    assert.equal(compiled.exitCode, 1); assert.equal(compiled.error, undefined);
    assert.deepEqual(compiled.findings?.map(({ file, line, ruleId }) => ({ file, line, ruleId })), [{ file: 'Assets/A.cs', line: 3, ruleId: 'CS0103' }]);
    const nunit = '<test-run><test-case fullname="N.T.m" result="Failed"><failure><message>bad</message><stack-trace>at N.T.m () in Assets/Tests/T.cs:line 9</stack-trace></failure></test-case></test-run>';
    process.env.UNITY = await fake(dir, 'unity-tests.sh', `printf '%s' '${nunit}' > .qualitygate/unity/editmode.xml; exit 1`);
    const tested = await plugin.run(gateSchema.parse({ ...tests }), context);
    assert.equal(tested.exitCode, 1); assert.equal(tested.findings?.[0]?.line, 9);
  } finally { if (previous === undefined) delete process.env.UNITY; else process.env.UNITY = previous; }
}));

test('unity refuses a version that could carry shell syntax into the generated gate', async () => {
  for (const version of ['1$(touch pwned)', '2022.3.10f1;rm', '2022 3', '`id`']) {
    await withProject(async project => { await assert.rejects(unity.detect(project), /Unreadable Unity version/); }, `m_EditorVersion: ${version}\n`);
  }
});
