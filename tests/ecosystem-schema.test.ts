import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configSchema, detectedGateSchema } from '../packages/protocol/src/index.js';
test('detected gates accept the command-gate subset', () => {
  const gate = { id: 'tests', run: 'x', timeoutMs: 5, report: { format: 'junit', path: 'r.xml' }, artifacts: ['a'] };
  assert.deepEqual(detectedGateSchema.parse(gate), gate);
});
test('detected gates and config gates accept a fix command only for command gates', () => {
  assert.deepEqual(detectedGateSchema.parse({ id: 'lint', run: 'x', fix: 'x --fix' }), { id: 'lint', run: 'x', fix: 'x --fix' });
  assert.throws(() => detectedGateSchema.parse({ id: 'lint', run: 'x', fix: '' }));
  const base = { schemaVersion: 1 as const };
  assert.equal(configSchema.parse({ ...base, gates: [{ id: 'l', run: 'x', fix: 'x --fix' }] }).gates[0]?.fix, 'x --fix');
  assert.throws(() => configSchema.parse({ ...base, gates: [{ id: 'l', type: 'eslint', run: 'x', fix: 'y' }] }), /fix is only for command gates/);
  assert.throws(() => configSchema.parse({ ...base, gates: [{ id: 'l', run: 'x', fix: '' }] }));
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
