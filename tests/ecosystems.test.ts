import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { detectedGateSchema } from '../packages/protocol/src/index.js';
import type { DetectedGate } from '../packages/protocol/src/index.js';
import { builtinEcosystems } from '../packages/plugins/ecosystems/src/index.js';
import { node } from '../packages/plugins/ecosystems/src/node.js';
import { python } from '../packages/plugins/ecosystems/src/python.js';
import { php } from '../packages/plugins/ecosystems/src/php.js';
import { playwright } from '../packages/plugins/ecosystems/src/playwright.js';
import { maestro } from '../packages/plugins/ecosystems/src/maestro.js';
import { execPrefix } from '../packages/plugins/ecosystems/src/shared.js';

async function project(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'qg-eco-'));
  for (const [name, content] of Object.entries(files)) { await mkdir(dirname(join(dir, name)), { recursive: true }); await writeFile(join(dir, name), content); }
  return dir;
}
async function detect(plugin: { detect(dir: string): Promise<DetectedGate[] | null> }, files: Record<string, string>) {
  const dir = await project(files);
  try {
    const gates = await plugin.detect(dir);
    for (const gate of gates ?? []) detectedGateSchema.parse(gate);
    return gates;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('built-in ecosystems are registered in setup order', () => {
  assert.deepEqual(builtinEcosystems.map(plugin => plugin.id), ['node', 'python', 'php', 'unity', 'playwright', 'maestro']);
  assert.ok(builtinEcosystems.every(plugin => plugin.kind === 'ecosystem' && plugin.apiVersion === 1));
});

test('node maps scripts to gates with the detected package manager', async () => {
  const cases: [Record<string, string>, string][] = [
    [{ 'package.json': JSON.stringify({ packageManager: 'yarn@4.0.0', scripts: { lint: 'x' } }) }, 'yarn run lint'],
    [{ 'package.json': JSON.stringify({ scripts: { lint: 'x' } }), 'pnpm-lock.yaml': '' }, 'pnpm run lint'],
    [{ 'package.json': JSON.stringify({ scripts: { lint: 'x' } }), 'package-lock.json': '' }, 'npm run lint'],
    [{ 'package.json': JSON.stringify({ scripts: { lint: 'x' } }) }, 'npm run lint'],
  ];
  for (const [files, run] of cases) assert.deepEqual((await detect(node, files))?.filter(gate => gate.id !== 'audit'), [{ id: 'lint', run }]);
  assert.deepEqual(await detect(node, { 'package.json': JSON.stringify({ scripts: { test: 'a', 'test:ci': 'b', 'check-types': 'c' } }) }),
    [{ id: 'typecheck', run: 'npm run check-types' }, { id: 'tests', run: 'npm run test:ci', timeoutMs: 300000 }]);
});

test('node is absent without package.json or matching scripts and rejects invalid JSON', async () => {
  assert.equal(await detect(node, {}), null);
  assert.equal(await detect(node, { 'package.json': '{}' }), null);
  await assert.rejects(detect(node, { 'package.json': '{' }), SyntaxError);
});

test('python proposes ruff, pytest with a junit report and mypy only when it is mentioned', async () => {
  const base = [{ id: 'lint', run: 'ruff check .' }, { id: 'tests', run: 'pytest --junitxml=.qualitygate/python/pytest.xml',
    timeoutMs: 300000, report: { format: 'junit', path: '.qualitygate/python/pytest.xml' } }];
  assert.deepEqual(await detect(python, { 'pyproject.toml': '[project]\nname = "x"\n' }), base);
  assert.deepEqual(await detect(python, { 'requirements-dev.txt': 'pytest\n' }), base);
  const withMypy = [...base, { id: 'typecheck', run: 'mypy .' }];
  assert.deepEqual(await detect(python, { 'pyproject.toml': '[tool.mypy]\nstrict = true\n' }), withMypy);
  assert.deepEqual(await detect(python, { 'requirements.txt': 'mypy==1.0\n' }), withMypy);
  assert.deepEqual(await detect(python, { 'requirements.txt': 'flask\n', 'mypy.ini': '[mypy]\n' }), withMypy);
  assert.equal(await detect(python, {}), null);
  assert.equal(await detect(python, { 'requirements.md': 'x' }), null);
});

test('playwright proposes a json report and evidence artifacts for each config extension', async () => {
  for (const extension of ['ts', 'js', 'mjs', 'cjs', 'mts', 'cts']) {
    const [gate] = (await detect(playwright, { [`playwright.config.${extension}`]: '' }))!;
    assert.equal(gate!.id, 'tests');
    assert.equal(gate!.run, 'PLAYWRIGHT_JSON_OUTPUT_NAME=.qualitygate/playwright/report.json npx playwright test --reporter=list,json');
    assert.deepEqual(gate!.report, { format: 'playwright-json', path: '.qualitygate/playwright/report.json' });
    assert.deepEqual(gate!.artifacts, ['test-results/**/*.png', 'test-results/**/*.webm', 'test-results/**/*.zip']);
  }
  const [pnpm] = (await detect(playwright, { 'playwright.config.ts': '', 'package.json': JSON.stringify({ packageManager: 'pnpm@11.28.9' }) }))!;
  assert.match(pnpm!.run, /pnpm exec playwright test/);
  const [yarn] = (await detect(playwright, { 'playwright.config.ts': '', 'yarn.lock': '' }))!;
  assert.match(yarn!.run, /yarn playwright test/);
  assert.equal(await detect(playwright, {}), null);
  assert.equal(execPrefix('yarn'), 'yarn');
});

test('maestro needs a flows folder with an appId and prefers .maestro', async () => {
  const flow = 'appId: com.example.app\n---\n- launchApp\n';
  const [hidden] = (await detect(maestro, { '.maestro/login.yaml': flow, 'flows/other.yaml': flow }))!;
  assert.equal(hidden!.id, 'e2e-mobile');
  assert.equal(hidden!.run, 'mkdir -p .qualitygate/maestro && maestro test --format junit --output .qualitygate/maestro/report.xml .maestro');
  assert.deepEqual(hidden!.report, { format: 'junit', path: '.qualitygate/maestro/report.xml' });
  assert.equal(hidden!.timeoutMs, 900000);
  const [plain] = (await detect(maestro, { 'flows/a.yml': flow }))!;
  assert.match(plain!.run, / flows$/);
  assert.equal(await detect(maestro, { 'flows/a.yaml': 'name: not maestro\n' }), null);
  assert.equal(await detect(maestro, { '.maestro/readme.md': 'appId: x' }), null);
  assert.equal(await detect(maestro, {}), null);
});

test('node proposes a dependency audit for the lockfile it finds, never enabled', async () => {
  const manifest = JSON.stringify({ scripts: { test: 'node --test' } });
  const npm = await detect(node, { 'package.json': manifest, 'package-lock.json': '{}' });
  assert.deepEqual(npm?.filter(gate => gate.id === 'audit'), [{ id: 'audit', run: 'mkdir -p .qualitygate/node && npm audit --json > .qualitygate/node/audit.json',
    report: { format: 'npm-audit', path: '.qualitygate/node/audit.json' }, skip: 'dependency audit needs the network and blocks on any known advisory: enable it if it should block' }]);
  const pnpm = await detect(node, { 'package.json': manifest, 'pnpm-lock.yaml': '' });
  assert.deepEqual(pnpm?.filter(gate => gate.id === 'audit'), [{ id: 'audit', run: 'mkdir -p .qualitygate/node && osv-scanner scan source --format json -L pnpm-lock.yaml > .qualitygate/node/osv.json',
    report: { format: 'osv-scanner', path: '.qualitygate/node/osv.json' }, skip: 'dependency audit needs osv-scanner v2 on PATH and blocks on any known advisory: enable it if it should block' }]);
  const yarn = await detect(node, { 'package.json': manifest, 'yarn.lock': '' });
  assert.match(yarn!.find(gate => gate.id === 'audit')!.run, /-L yarn\.lock >/);
  assert.equal((await detect(node, { 'package.json': manifest }))!.some(gate => gate.id === 'audit'), false);
  assert.equal(await detect(node, { 'package.json': '{}', 'package-lock.json': '{}' }), null);
});

const audit = { id: 'audit', run: 'composer audit', skip: 'dependency audit needs the network and blocks on any known advisory: enable it if it should block' };
const phpunit = { id: 'tests', run: 'mkdir -p .qualitygate/php && vendor/bin/phpunit --log-junit .qualitygate/php/junit.xml', timeoutMs: 300000,
  report: { format: 'junit', path: '.qualitygate/php/junit.xml' } };

test('php proposes style, static analysis and a junit test run from the installed packages', async () => {
  const composer = (dev: Record<string, string>, scripts = {}) => ({ 'composer.json': JSON.stringify({ 'require-dev': dev, scripts }), 'vendor/autoload.php': '' });
  assert.deepEqual(await detect(php, composer({ 'laravel/pint': '1', 'phpstan/phpstan': '1', 'phpunit/phpunit': '10' })),
    [{ id: 'lint', run: 'vendor/bin/pint --test' }, { id: 'typecheck', run: 'vendor/bin/phpstan analyse --no-progress' }, phpunit, audit]);
  const others = await detect(php, composer({ 'friendsofphp/php-cs-fixer': '3', 'vimeo/psalm': '5', 'pestphp/pest': '2' }));
  assert.deepEqual(others!.map(gate => gate.run), ['vendor/bin/php-cs-fixer fix --dry-run --diff', 'vendor/bin/psalm --no-progress',
    'mkdir -p .qualitygate/php && vendor/bin/pest --log-junit .qualitygate/php/junit.xml', 'composer audit']);
  assert.equal((await detect(php, composer({ 'squizlabs/php_codesniffer': '3' })))![0]!.run, 'vendor/bin/phpcs');
  assert.deepEqual(await detect(php, composer({}, { lint: 'x', analyse: 'x', test: 'x' })),
    [{ id: 'lint', run: 'composer run lint' }, { id: 'typecheck', run: 'composer run analyse' }, { id: 'tests', run: 'composer run test', timeoutMs: 300000 }, audit]);
});

test('php explains a missing vendor folder and ignores projects with nothing to run', async () => {
  const gates = await detect(php, { 'composer.json': JSON.stringify({ 'require-dev': { 'phpunit/phpunit': '10' } }) });
  assert.match(gates![0]!.note!, /composer install/);
  assert.equal(await detect(php, { 'composer.json': JSON.stringify({ name: 'x/y' }) }), null);
  assert.equal(await detect(php, { 'package.json': '{}' }), null);
});

test('node adds tsc --noEmit for a TypeScript project without a typecheck script', async () => {
  const pkg = (extra: object) => JSON.stringify({ scripts: { lint: 'x' }, devDependencies: { typescript: '5' }, ...extra });
  const gates = await detect(node, { 'package.json': pkg({}), 'tsconfig.json': '{}', 'pnpm-lock.yaml': '' });
  assert.deepEqual(gates!.find(gate => gate.id === 'typecheck'), { id: 'typecheck', run: 'pnpm exec tsc --noEmit' });
  assert.equal((await detect(node, { 'package.json': pkg({}) }))!.some(gate => gate.id === 'typecheck'), false);
  const scripted = await detect(node, { 'package.json': pkg({ scripts: { typecheck: 'tsc' } }), 'tsconfig.json': '{}' });
  assert.equal(scripted!.find(gate => gate.id === 'typecheck')!.run, 'npm run typecheck');
});
