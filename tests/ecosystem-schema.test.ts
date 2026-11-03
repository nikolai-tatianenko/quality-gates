import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configSchema, detectedGateSchema } from '../packages/protocol/src/index.js';
test('detected gates accept the command-gate subset', () => {
  const gate = { id: 'tests', run: 'x', timeoutMs: 5, report: { format: 'junit', path: 'r.xml' }, artifacts: ['a'] };
  assert.deepEqual(detectedGateSchema.parse(gate), gate);
});
test('detected gates reject unknown keys, bad ids and too many artifacts', () => {
  assert.throws(() => detectedGateSchema.parse({ id: 't', run: 'x', type: 'eslint' }));
  assert.throws(() => detectedGateSchema.parse({ id: 'Bad Id!', run: 'x' }));
  assert.throws(() => detectedGateSchema.parse({ id: 't', run: 'x', artifacts: Array.from({ length: 51 }, (_, i) => `a${i}`) }));
});
test('config gates keep their validation', () => {
  assert.equal(configSchema.parse({ schemaVersion: 1, gates: [{ id: 't', run: 'x' }] }).gates[0]?.type, 'command');
  assert.throws(() => configSchema.parse({ schemaVersion: 1, gates: [{ id: 'Bad Id!', run: 'x' }] }));
});
