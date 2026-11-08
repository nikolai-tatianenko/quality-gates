import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { configSchema } from '../packages/protocol/src/index.js';
import type { EcosystemPlugin } from '../packages/plugin-sdk/src/index.js';
import { setupProject } from '../packages/cli/src/setup.js';
import { readGatesFile } from '../packages/cli/src/gates-file.js';
import { node, countTestFiles, skipReason } from '../packages/plugins/ecosystems/src/node.js';
import { builtinParsers } from '../packages/plugins/parsers/src/index.js';
import { globFiles } from '../packages/plugins/command/src/artifacts.js';

const entry = resolve('packages/cli/src/index.ts');
async function repo(files: Record<string, string | object>) {
  const dir = await mkdtemp(join(tmpdir(), 'qg-ref-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}
async function withRepo<T>(files: Record<string, string | object>, fn: (dir: string) => Promise<T>) {
  const dir = await repo(files);
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const detect = (files: Record<string, string | object>) => withRepo(files, dir => node.detect(dir));
const cli = (dir: string, args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((res, reject) => {
  const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args, '--config', join(dir, '.qualitygate.yml')]);
  let stdout = ''; let stderr = '';
  child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
  child.once('error', reject); child.once('close', code => res({ code, stdout, stderr }));
});

const referenceRepos: { name: string; files: Record<string, string | object>; gates: string[]; skipped: string[]; ecosystems: string[] }[] = [
  { name: 'pnpm monorepo', ecosystems: ['node'], gates: ['lint', 'typecheck', 'tests'], skipped: ['test-e2e'], files: {
    'package.json': { packageManager: 'pnpm@11.28.9', scripts: { lint: 'eslint .', 'test:e2e': 'playwright test' } },
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'packages/web/package.json': { name: 'web', scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } },
    'packages/api/package.json': { name: 'api', scripts: { test: 'node --test' } } } },
  { name: 'Playwright project', ecosystems: ['node', 'playwright'], gates: ['node-tests', 'playwright-tests'], skipped: ['audit'], files: {
    'package.json': { scripts: { test: 'echo unit' } }, 'package-lock.json': '', 'playwright.config.ts': 'export default {};' } },
  { name: 'Maestro mobile app', ecosystems: ['node', 'maestro'], gates: ['lint'], skipped: ['e2e-mobile'], files: {
    'package.json': { scripts: { lint: 'eslint src' } }, 'maestro/login.yaml': 'appId: com.example.app\n---\n- launchApp\n' } },
  { name: 'Python service', ecosystems: ['python'], gates: ['lint', 'tests', 'typecheck'], skipped: [], files: {
    'pyproject.toml': '[tool.mypy]\nstrict = true\n', 'app/main.py': 'print(1)\n' } },
];
for (const reference of referenceRepos) {
  test(`reference repository: ${reference.name} gets the expected gates`, async () => withRepo(reference.files, async dir => {
    const result = await setupProject(join(dir, '.qualitygate.yml'));
    assert.deepEqual(result.ecosystems, reference.ecosystems);
    assert.deepEqual(result.gates.map(gate => gate.id), reference.gates);
    assert.deepEqual(result.skipped.map(gate => gate.id), reference.skipped);
    configSchema.parse(parse(await readFile(result.configPath, 'utf8')));
  }));
}

test('a pnpm monorepo runs workspace scripts with pnpm -r and a root eslint script gets a report', async () => withRepo(referenceRepos[0]!.files, async dir => {
  const gates = (await node.detect(dir))!;
  assert.deepEqual(gates.map(gate => [gate.id, gate.run]), [
    ['lint', 'pnpm exec eslint . --format json --output-file .qualitygate/node/eslint.json'],
    ['typecheck', 'pnpm -r --if-present run typecheck'], ['tests', 'pnpm -r --if-present run test'],
    ['test-e2e', 'pnpm run test:e2e']]);
  assert.equal(gates[3]!.skip, 'needs a browser and is slow');
}));

test('npm workspaces use --workspaces; yarn workspaces without root scripts propose nothing', async () => {
  const npm = await detect({ 'package.json': { workspaces: ['packages/*', '!packages/legacy', 'tools'], scripts: {} }, 'package-lock.json': '',
    'packages/a/package.json': { scripts: { test: 'x' } }, 'packages/legacy/package.json': { scripts: { test: 'old' } }, 'tools/package.json': { scripts: { lint: 'y' } } });
  assert.deepEqual(npm!.map(gate => gate.run), ['npm run lint --workspaces --if-present', 'npm run test --workspaces --if-present', 'mkdir -p .qualitygate/node && npm audit --json > .qualitygate/node/audit.json']);
  const object = await detect({ 'package.json': { workspaces: { packages: ['pkgs/**'] } }, 'package-lock.json': '', 'pkgs/a/package.json': { scripts: { lint: 'x' } }, 'pkgs/b/notes.txt': '' });
  assert.deepEqual(object!.map(gate => gate.run), ['npm run lint --workspaces --if-present', 'mkdir -p .qualitygate/node && npm audit --json > .qualitygate/node/audit.json']);
  assert.equal(await detect({ 'package.json': { workspaces: ['packages/*'] }, 'yarn.lock': '', 'packages/a/package.json': { scripts: { test: 'x' } } }), null);
  assert.equal(await detect({ 'package.json': { workspaces: ['missing/*'] } }), null);
});

test('eslint, vitest and node --test scripts get a report; other shapes stay untouched', async () => {
  const runs = async (scripts: Record<string, string>) => (await detect({ 'package.json': { packageManager: 'npm@10.0.0', scripts } }))!.map(gate => gate.run);
  assert.deepEqual(await runs({ lint: 'eslint src --fix', test: 'vitest' }), [
    'npx eslint src --fix --format json --output-file .qualitygate/node/eslint.json',
    'npx vitest run --reporter=default --reporter=junit --outputFile.junit=.qualitygate/node/junit.xml']);
  const fixes = async (scripts: Record<string, string>) => (await detect({ 'package.json': { packageManager: 'npm@10.0.0', scripts } }))!.map(gate => gate.fix);
  assert.deepEqual(await fixes({ lint: 'eslint src', test: 'vitest' }), ['npx eslint src --fix', undefined]);
  assert.deepEqual(await fixes({ lint: 'eslint' }), ['npx eslint . --fix']);
  assert.deepEqual(await fixes({ lint: 'eslint src --fix' }), [undefined]);
  assert.deepEqual(await fixes({ lint: 'eslint . && prettier --check .', test: 'vitest' }), [undefined, undefined]);
  assert.deepEqual(await runs({ test: 'vitest run --coverage' }), ['npx vitest run --coverage --reporter=default --reporter=junit --outputFile.junit=.qualitygate/node/junit.xml']);
  assert.deepEqual(await runs({ test: 'node --import tsx --test tests/*.test.ts' }),
    ['mkdir -p .qualitygate/node && node --import tsx --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=.qualitygate/node/junit.xml tests/*.test.ts']);
  assert.deepEqual(await runs({ lint: 'eslint . -f stylish', test: 'vitest --reporter=dot' }), ['npm run lint', 'npm run test']);
  assert.deepEqual(await runs({ lint: 'eslint . && prettier --check .', test: 'vitest --watch', typecheck: 'tsc' }), ['npm run lint', 'npm run typecheck', 'npm run test']);
  assert.deepEqual(await runs({ lint: 'biome check', test: 'jest' }), ['npm run lint', 'npm run test']);
});

test('a vitest config without a test script still proposes tests with a JUnit report', async () => {
  const gates = (await detect({ 'package.json': { scripts: { lint: 'x' } }, 'vitest.config.ts': '', 'pnpm-lock.yaml': '' }))!;
  assert.deepEqual(gates.map(gate => gate.id), ['lint', 'tests', 'audit']);
  assert.equal(gates[1]!.run, 'pnpm exec vitest run --reporter=default --reporter=junit --outputFile.junit=.qualitygate/node/junit.xml');
  assert.deepEqual(gates[1]!.report, { format: 'junit', path: '.qualitygate/node/junit.xml' });
  assert.equal(await detect({ 'package.json': { scripts: {} }, 'vite.config.ts': '' }), null);
});

test('extra test scripts are listed as found but not enabled, each with its reason', async () => {
  const gates = (await detect({ 'package.json': { scripts: { test: 'x', 'test:ci': 'x', 'test:watch': 'x', 'test:ios': 'x', 'test:e2e': 'x', 'test:unit': 'x' } } }))!;
  assert.deepEqual(gates.map(gate => [gate.id, gate.skip]), [['tests', undefined], ['test-watch', 'watch mode never exits'], ['test-ios', 'needs an emulator or simulator'],
    ['test-e2e', 'needs a browser and is slow'], ['test-unit', 'extra test script: enable it if it should block the run']]);
  assert.equal(skipReason('test:cypress'), 'needs a browser and is slow');
});

test('a run over hundreds of test files gets a long timeout and a warning', async () => {
  const files: Record<string, string> = { 'package.json': JSON.stringify({ scripts: { test: 'x' } }) };
  for (let i = 0; i < 310; i++) files[`src/deep/f${i}.test.ts`] = '';
  files['node_modules/dep/skip.test.js'] = '';
  await withRepo(files, async dir => {
    const [tests] = (await node.detect(dir))!;
    assert.equal(tests!.timeoutMs, 1800000); assert.match(tests!.note!, /test files will probably not finish within the default 300 s/);
    assert.equal(await countTestFiles(dir), 310); assert.equal(await countTestFiles(dir, 50) >= 50, true);
  });
  const [small] = (await detect({ 'package.json': { scripts: { test: 'x' } }, 'a.spec.ts': '' }))!;
  assert.equal(small!.timeoutMs, 300000); assert.equal(small!.note, undefined);
  assert.equal((await detect({ 'package.json': { scripts: { lint: 'x' } } }))![0]!.note, undefined);
});

test('setup writes skipped gates as comments, prints notes and lists every changed file', async () => withRepo({
  'package.json': { scripts: { test: 'x', 'test:e2e': 'playwright test' } }, 'package-lock.json': '' }, async dir => {
  const result = await setupProject(join(dir, '.qualitygate.yml'));
  const written = await readFile(result.configPath, 'utf8');
  assert.match(written, /# test-e2e: needs a browser and is slow\n# - id: test-e2e/);
  assert.equal(configSchema.parse(parse(written)).gates.length, 1);
  assert.deepEqual(result.changed, [result.configPath, join(dir, '.gitignore')]);
  const skippedOnly: EcosystemPlugin = { id: 's', apiVersion: 1, kind: 'ecosystem', detect: async () => [{ id: 'e2e', run: 'x', skip: 'slow' }] };
  await assert.rejects(setupProject(join(dir, 'other.yml'), [skippedOnly]), /Every gate found needs a decision \(e2e: slow\)/);
}));

test('setup --no-gitignore leaves .gitignore alone and --from reads the project gate list', async () => withRepo({
  'gates.json': { gates: [{ name: 'Unit Tests', command: ['pnpm', 'test'], timeoutMs: 60000 }, { id: 'lint', run: 'pnpm lint', artifacts: ['out/*.txt'] }] } }, async dir => {
  const result = await cli(dir, ['setup', '--from', join(dir, 'gates.json'), '--no-gitignore']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Ecosystems: file/); assert.match(result.stdout, /unit-tests: pnpm test/);
  assert.match(result.stdout, /Files changed: .*\.qualitygate\.yml$/m); assert.doesNotMatch(result.stdout, /Added to \.gitignore/);
  await assert.rejects(readFile(join(dir, '.gitignore'), 'utf8'), /ENOENT/);
  const config = configSchema.parse(parse(await readFile(join(dir, '.qualitygate.yml'), 'utf8')));
  assert.deepEqual(config.gates.map(gate => [gate.id, gate.run, gate.timeoutMs]), [['unit-tests', 'pnpm test', 60000], ['lint', 'pnpm lint', undefined]]);
  assert.deepEqual(config.gates[1]!.artifacts, ['out/*.txt']);
}));

test('setup text output lists found-but-not-enabled gates and notes', async () => withRepo({
  'package.json': { scripts: { test: 'x', 'test:e2e': 'y' } }, 'package-lock.json': '' }, async dir => {
  const result = await cli(dir, ['setup']);
  assert.match(result.stdout, /Found but not enabled \(listed as comments in the config\):\n {2}test-e2e: needs a browser and is slow/);
  assert.match(result.stdout, /Files changed:/);
}));

test('gate lists are read from JSON, records and ES modules, and bad input is explained', async () => withRepo({
  'list.json': [{ id: 'a', run: 'echo a' }], 'record.json': { 'Lint Code': 'pnpm lint' }, 'cmd.json': [{ name: 'b', cmd: 'echo b', report: { format: 'junit', path: 'r.xml' } }],
  'named.mjs': 'export const gates = [{ id: "m", run: "echo m" }];', 'default.mjs': 'export default { gates: [{ id: "d", run: "echo d" }] };',
  'empty.json': [], 'bad.json': 'oops', 'noid.json': [{ run: 'x' }], 'shape.json': { a: 1 } }, async dir => {
  const read = (name: string) => readGatesFile(join(dir, name));
  assert.deepEqual(await read('list.json'), [{ id: 'a', run: 'echo a' }]);
  assert.deepEqual(await read('record.json'), [{ id: 'lint-code', run: 'pnpm lint' }]);
  assert.deepEqual((await read('cmd.json'))[0]!.report, { format: 'junit', path: 'r.xml' });
  assert.deepEqual(await read('named.mjs'), [{ id: 'm', run: 'echo m' }]);
  assert.deepEqual(await read('default.mjs'), [{ id: 'd', run: 'echo d' }]);
  for (const bad of ['empty.json', 'bad.json', 'noid.json', 'shape.json', 'missing.json']) await assert.rejects(read(bad), /Cannot read gates from/);
  await assert.rejects(read('shape.json'), /expected a list of gates/); await assert.rejects(read('noid.json'), /needs an id/);
  await assert.rejects(read('empty.json'), /no gates found`?|expected a list/);
}));

test('report parsers count passed, failed and skipped tests', () => {
  const parser = (id: string) => builtinParsers[id]!;
  const junit = '<testsuite><testcase name="a"/><testcase name="b"><failure message="x"/></testcase><testcase name="c"><error message="y"/></testcase><testcase name="d"><skipped/></testcase></testsuite>';
  assert.deepEqual(parser('junit').count!(junit), { passed: 1, failed: 2, skipped: 1 });
  const nunit = '<test-run><test-case fullname="a" result="Passed"/><test-case fullname="b" result="Failed"/><test-case fullname="c" result="Skipped"/></test-run>';
  assert.deepEqual(parser('nunit').count!(nunit), { passed: 1, failed: 1, skipped: 1 });
  const playwright = JSON.stringify({ suites: [{ specs: [
    { title: 'ok', tests: [{ results: [{ status: 'passed' }] }] }, { title: 'bad', tests: [{ results: [{ status: 'timedOut' }] }] },
    { title: 'skip', tests: [{ results: [{ status: 'skipped' }] }] }], suites: [{ specs: [{ title: 'nested', tests: [{ results: [{ status: 'passed' }] }] }] }] }] });
  assert.deepEqual(parser('playwright-json').count!(playwright), { passed: 2, failed: 1, skipped: 1 });
  assert.deepEqual(parser('playwright-json').count!('{}'), { passed: 0, failed: 0, skipped: 0 });
});

test('globFiles lists matching regular files only, sorted, and ignores patterns that escape the project', async () => withRepo({
  'src/b.ts': '', 'src/a.ts': '', 'src/deep/c.ts': '', 'src/readme.md': '' }, async dir => {
  assert.deepEqual(await globFiles(dir, ['src/*.ts']), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(await globFiles(dir, ['src/**/*.ts', 'src/readme.md']), ['src/a.ts', 'src/b.ts', 'src/deep/c.ts', 'src/readme.md']);
  assert.deepEqual(await globFiles(dir, ['../*', '/etc/*', 'nothing/*']), []);
}));
