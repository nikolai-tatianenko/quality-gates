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

import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
  assert.deepEqual(await loadExternalPlugins(dir, []), { parsers: {}, ecosystems: [], gates: {} });
}));
test('follows pnpm-style symlinks and scoped names', async () => withProject(async dir => {
  await cp(fixture, join(dir, 'store', 'fixture'), { recursive: true });
  await mkdir(join(dir, 'node_modules', '@scope'), { recursive: true });
  await symlink(join(dir, 'store', 'fixture'), join(dir, 'node_modules', '@scope', 'plugin'));
  assert.deepEqual(Object.keys((await loadExternalPlugins(dir, ['@scope/plugin'])).parsers), ['fixture-json']);
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
