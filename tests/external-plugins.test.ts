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
