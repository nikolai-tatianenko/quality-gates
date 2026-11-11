import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configSchema, externalPluginSchema, gateSchema, pluginPackageSchema } from '../packages/protocol/src/index.js';
const base = { schemaVersion: 1, gates: [{ id: 'a', run: 'true' }] };
test('config accepts valid plugin package names', () => {
  assert.deepEqual(configSchema.parse({ ...base, plugins: ['qg-plugin-x', '@scope/qg-plugin-y'] }).plugins, ['qg-plugin-x', '@scope/qg-plugin-y']);
  assert.equal(configSchema.parse(base).plugins, undefined);
});
test('config rejects paths, uppercase names and duplicates in plugins', () => {
  for (const name of ['../x', '/abs', 'a/b', 'UPPER', '', '.hidden', '@scope']) assert.throws(() => configSchema.parse({ ...base, plugins: [name] }), name);
  assert.throws(() => configSchema.parse({ ...base, plugins: ['x', 'x'] }), /Duplicate plugin package/);
});
test('gate type is an id string', () => {
  assert.equal(gateSchema.parse({ id: 'a', type: 'my-gate', run: 'x' }).type, 'my-gate');
  assert.equal(gateSchema.parse({ id: 'a', run: 'x' }).type, 'command');
  assert.throws(() => gateSchema.parse({ id: 'a', type: 'Bad Type', run: 'x' }));
});
test('plugin manifest schema validates kind, apiVersion and required functions', () => {
  const parser = { apiVersion: 1, kind: 'parser', id: 'p', parse: () => [] };
  const ecosystem = { apiVersion: 1, kind: 'ecosystem', id: 'e', detect: async () => null };
  const gate = { apiVersion: 1, kind: 'gate', id: 'g', run: async () => ({}) };
  assert.equal(pluginPackageSchema.parse({ apiVersion: 1, plugins: [parser, ecosystem, gate] }).plugins.length, 3);
  assert.throws(() => pluginPackageSchema.parse({ apiVersion: 2, plugins: [parser] }));
  assert.throws(() => pluginPackageSchema.parse({ apiVersion: 1, plugins: [] }));
  assert.throws(() => externalPluginSchema.parse({ ...parser, parse: 'no' }));
  assert.throws(() => externalPluginSchema.parse({ ...parser, apiVersion: 2 }));
  assert.throws(() => externalPluginSchema.parse({ ...parser, id: 'Bad Id' }));
  assert.throws(() => externalPluginSchema.parse({ apiVersion: 1, kind: 'storage', id: 's' }));
});

import { access, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExternalPlugins } from '../packages/core/src/external.js';
const fixture = join(import.meta.dirname, 'fixtures', 'plugin-package');
async function withProject(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'qg-plugins-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function install(dir: string, name: string, pkg: object, files: Record<string, string>) {
  const root = join(dir, 'node_modules', name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, type: 'module', ...pkg }));
  for (const [file, text] of Object.entries(files)) await writeFile(join(root, file), text);
}
const manifestOf = (id: string, kind = 'parser') => `export const manifest = { apiVersion: 1, plugins: [${kind === 'parser' ? `{ apiVersion: 1, kind: 'parser', id: '${id}', parse: () => [] }` : `{ apiVersion: 1, kind: 'gate', id: '${id}', run: async () => ({ exitCode: 0, output: '' }) }`}] };`;
test('loads parser, ecosystem and gate from the fixture package', async () => withProject(async dir => {
  await cp(fixture, join(dir, 'node_modules', 'qg-plugin-fixture'), { recursive: true });
  const loaded = await loadExternalPlugins(dir, ['qg-plugin-fixture']);
  assert.deepEqual(Object.keys(loaded.parsers), ['fixture-json']);
  assert.deepEqual(loaded.ecosystems.map(p => p.id), ['fixture-eco']);
  assert.deepEqual(Object.keys(loaded.gates), ['fixture-gate']);
  assert.deepEqual(await loadExternalPlugins(dir, []), { parsers: {}, ecosystems: [], gates: {}, commands: {} });
}));
test('follows pnpm-style symlinks and scoped names', async () => withProject(async dir => {
  await cp(fixture, join(dir, 'node_modules', '.pnpm', 'fixture@1', 'node_modules', 'fixture'), { recursive: true });
  await mkdir(join(dir, 'node_modules', '@scope'), { recursive: true });
  await symlink(join(dir, 'node_modules', '.pnpm', 'fixture@1', 'node_modules', 'fixture'), join(dir, 'node_modules', '@scope', 'plugin'));
  assert.deepEqual(Object.keys((await loadExternalPlugins(dir, ['@scope/plugin'])).parsers), ['fixture-json']);
}));
test('rejects package names that are paths before importing anything', async () => withProject(async dir => {
  const marker = join(dir, 'pwned');
  await mkdir(join(dir, 'evil'), { recursive: true });
  await writeFile(join(dir, 'evil', 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(join(dir, 'evil', 'index.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x'); export const manifest = {};`);
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  for (const name of ['../evil', '../../evil', '/abs', 'a/b', '..', '@scope', 'UPPER']) await assert.rejects(loadExternalPlugins(dir, [name]), /Invalid plugin package name/, name);
  await assert.rejects(access(marker));
}));
test('rejects a package symlinked outside node_modules', async () => withProject(async dir => {
  const marker = join(dir, 'pwned');
  await cp(fixture, join(dir, 'outside'), { recursive: true });
  await writeFile(join(dir, 'outside', 'index.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x'); export const manifest = {};`);
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await symlink(join(dir, 'outside'), join(dir, 'node_modules', 'linked'));
  await assert.rejects(loadExternalPlugins(dir, ['linked']), /Plugin linked: package resolves outside node_modules/);
  await assert.rejects(access(marker));
}));
test('resolves the entry from exports string, exports default, main and index.js, and default manifest export', async () => withProject(async dir => {
  await install(dir, 'a', { exports: './a.js' }, { 'a.js': manifestOf('pa') });
  await install(dir, 'b', { exports: { '.': { default: './b.js' } } }, { 'b.js': manifestOf('pb') });
  await install(dir, 'c', { main: 'c.js' }, { 'c.js': manifestOf('pc') });
  await install(dir, 'd', {}, { 'index.js': manifestOf('pd').replace('export const manifest =', 'export default') });
  await install(dir, 'e', { exports: { './x': './x.js' }, main: 'e.js' }, { 'e.js': manifestOf('pe') });
  await install(dir, 'f', { exports: './f.js' }, { 'f.js': manifestOf('gf', 'gate') });
  assert.deepEqual(Object.keys((await loadExternalPlugins(dir, ['a', 'b', 'c', 'd', 'e'])).parsers), ['pa', 'pb', 'pc', 'pd', 'pe']);
  assert.deepEqual(Object.keys((await loadExternalPlugins(dir, ['f'])).gates), ['gf']);
}));
test('reports a missing package, unreadable package.json, bad entries and import errors', async () => withProject(async dir => {
  await assert.rejects(loadExternalPlugins(dir, ['nope']), /Plugin package not found: nope/);
  await mkdir(join(dir, 'node_modules', 'bare'), { recursive: true });
  await assert.rejects(loadExternalPlugins(dir, ['bare']), /Cannot load plugin bare/);
  await install(dir, 'throws', {}, { 'index.js': 'throw new Error("boom");' });
  await assert.rejects(loadExternalPlugins(dir, ['throws']), /Cannot load plugin throws: boom/);
  await install(dir, 'noentry', { main: 'missing.js' }, {});
  await assert.rejects(loadExternalPlugins(dir, ['noentry']), /Cannot load plugin noentry/);
  await writeFile(join(dir, 'outside.js'), manifestOf('po'));
  await install(dir, 'escape', { main: 'link.js' }, {});
  await symlink(join(dir, 'outside.js'), join(dir, 'node_modules', 'escape', 'link.js'));
  await assert.rejects(loadExternalPlugins(dir, ['escape']), /Plugin escape: entry outside the package folder/);
  await install(dir, 'empty', {}, { 'index.js': 'export const other = 1;' });
  await assert.rejects(loadExternalPlugins(dir, ['empty']), /Plugin empty exports no manifest/);
}));
test('rejects invalid manifests naming the field', async () => withProject(async dir => {
  await install(dir, 'v2', {}, { 'index.js': "export const manifest = { apiVersion: 2, plugins: [] };" });
  await assert.rejects(loadExternalPlugins(dir, ['v2']), /Invalid plugin package v2: apiVersion/);
  await install(dir, 'nofn', {}, { 'index.js': "export const manifest = { apiVersion: 1, plugins: [{ apiVersion: 1, kind: 'parser', id: 'x' }] };" });
  await assert.rejects(loadExternalPlugins(dir, ['nofn']), /Invalid plugin package nofn: plugins\.0\.parse/);
}));
test('rejects duplicate ids across built-ins, packages and within a package', async () => withProject(async dir => {
  await install(dir, 'p1', {}, { 'index.js': manifestOf('shared') });
  await install(dir, 'p2', {}, { 'index.js': manifestOf('shared') });
  await install(dir, 'twice', {}, { 'index.js': "const p = { apiVersion: 1, kind: 'parser', id: 'same', parse: () => [] }; export const manifest = { apiVersion: 1, plugins: [p, p] };" });
  await assert.rejects(loadExternalPlugins(dir, ['p1'], ['shared']), /Duplicate plugin id: shared \(p1\)/);
  await assert.rejects(loadExternalPlugins(dir, ['p1', 'p2']), /Duplicate plugin id: shared \(p2\)/);
  await assert.rejects(loadExternalPlugins(dir, ['twice']), /Duplicate plugin id: same/);
}));

import { stringify } from 'yaml';
import { execute } from '../packages/cli/src/runner.js';
async function project(dir: string, config: object) {
  await cp(fixture, join(dir, 'node_modules', 'qg-plugin-fixture'), { recursive: true });
  await writeFile(join(dir, '.qualitygate.yml'), stringify({ schemaVersion: 1, ...config }));
  return join(dir, '.qualitygate.yml');
}
test('run uses third-party parsers and gates', async () => withProject(async dir => {
  const path = await project(dir, { plugins: ['qg-plugin-fixture'], gates: [
    { id: 'parsed', run: 'echo \'[{"message":"bad","file":"a.ts","line":3}]\' > r.json; exit 1', report: { format: 'fixture-json', path: 'r.json' } },
    { id: 'custom', type: 'fixture-gate', run: 'whatever' }] });
  const result = await execute(path, new AbortController().signal);
  assert.equal(result.execution, 'completed');
  assert.deepEqual(result.gates.map(g => [g.id, g.decision]), [['parsed', 'BLOCK'], ['custom', 'PASS']]);
  assert.deepEqual(result.gates[0]!.findings.map(f => [f.file, f.line, f.message]), [['a.ts', 3, 'bad']]);
  assert.match(result.gates[1]!.outputTail, /fixture gate ran: whatever/);
}));
test('run rejects unknown gate types, inherited names and missing packages before running anything', async () => withProject(async dir => {
  const marker = join(dir, 'ran');
  const path = await project(dir, { gates: [{ id: 'first', run: `touch ${marker}` }, { id: 'odd', type: 'fixture-gate', run: 'x' }] });
  await assert.rejects(execute(path, new AbortController().signal), /Unknown gate type: fixture-gate/);
  await assert.rejects(access(marker));
  const inherited = await project(dir, { gates: [{ id: 'odd', type: 'constructor', run: 'x' }] });
  await assert.rejects(execute(inherited, new AbortController().signal), /Unknown gate type: constructor/);
  const missing = await project(dir, { plugins: ['absent'], gates: [{ id: 'a', run: 'true' }] });
  await assert.rejects(execute(missing, new AbortController().signal), /Plugin package not found: absent/);
  const reserved = await project(dir, { plugins: ['qg-plugin-fixture'], gates: [{ id: 'a', run: 'true' }] });
  await install(dir, 'clash', {}, { 'index.js': manifestOf('junit') });
  await writeFile(reserved, stringify({ schemaVersion: 1, plugins: ['clash'], gates: [{ id: 'a', run: 'true' }] }));
  await assert.rejects(execute(reserved, new AbortController().signal), /Duplicate plugin id: junit/);
}));
test('projects without plugins still run with built-ins only', async () => withProject(async dir => {
  const path = await project(dir, { gates: [{ id: 'ok', run: 'true' }] });
  assert.equal((await execute(path, new AbortController().signal)).decision, 'PASS');
}));

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { setupProject } from '../packages/cli/src/setup.js';
function cli(args: string[], cwd: string) {
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('packages/cli/src/index.ts'), ...args], { cwd });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }));
  });
}
async function setupDir(dir: string) {
  await cp(fixture, join(dir, 'node_modules', 'qg-plugin-fixture'), { recursive: true });
  await writeFile(join(dir, 'fixture.marker'), '');
  return join(dir, '.qualitygate.yml');
}
test('setup --plugin adds the package ecosystems and writes plugins: into the config', async () => withProject(async dir => {
  const path = await setupDir(dir);
  const result = await setupProject(path, [], ['qg-plugin-fixture']);
  assert.deepEqual(result.plugins, ['qg-plugin-fixture']);
  assert.deepEqual(result.ecosystems, ['fixture-eco']);
  const config = configSchema.parse(parse(await readFile(path, 'utf8')));
  assert.deepEqual(config.plugins, ['qg-plugin-fixture']);
  assert.deepEqual(config.gates.map(g => g.id), ['fixture-check']);
  await assert.rejects(setupProject(path, [], ['qg-plugin-fixture']), /already exists/);
}));
test('setup without --plugin writes no plugins key; a missing package writes nothing', async () => withProject(async dir => {
  const path = await setupDir(dir);
  await assert.rejects(setupProject(path, [], ['absent']), /Plugin package not found: absent/);
  await assert.rejects(access(path));
  const eco = { id: 'e', apiVersion: 1 as const, kind: 'ecosystem' as const, detect: async () => [{ id: 'x', run: 'true' }] };
  const result = await setupProject(path, [eco]);
  assert.deepEqual(result.plugins, []);
  assert.ok(!('plugins' in parse(await readFile(path, 'utf8'))));
}));
test('CLI setup --plugin is repeatable, reported in text and JSON, and only valid for setup', async () => withProject(async dir => {
  await setupDir(dir);
  const json = await cli(['setup', '--plugin', 'qg-plugin-fixture', '--json'], dir);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).plugins, ['qg-plugin-fixture']);
  await rm(join(dir, '.qualitygate.yml'));
  const text = await cli(['setup', '--plugin', 'qg-plugin-fixture'], dir);
  assert.match(text.stdout, /Plugins \(run unsandboxed with your permissions\): qg-plugin-fixture/);
  await rm(join(dir, '.qualitygate.yml'));
  const twice = await cli(['setup', '--plugin', 'qg-plugin-fixture', '--plugin', 'qg-plugin-fixture', '--json'], dir);
  assert.equal(twice.code, 2);
  const run = await cli(['run', '--plugin', 'x', '--json'], dir);
  assert.equal(run.code, 2);
  assert.match(run.stdout, /run does not accept --plugin/);
}));
