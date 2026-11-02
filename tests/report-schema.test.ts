import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configSchema, gateResultSchema } from '../packages/protocol/src/index.js';
const base = { schemaVersion: 1 };
test('command gates accept report and artifacts', () => {
  const config = configSchema.parse({ ...base, gates: [{ id: 't', run: 'x', report: { format: 'junit', path: 'r.xml' }, artifacts: ['out/**/*.png'] }] });
  assert.deepEqual(config.gates[0]?.report, { format: 'junit', path: 'r.xml' });
  assert.deepEqual(config.gates[0]?.artifacts, ['out/**/*.png']);
});
test('report and artifacts are rejected on non-command gates', () => {
  assert.throws(() => configSchema.parse({ ...base, gates: [{ id: 'l', type: 'eslint', run: 'x', report: { format: 'junit', path: 'r.xml' } }] }), /only for command gates/);
  assert.throws(() => configSchema.parse({ ...base, gates: [{ id: 'l', type: 'eslint', run: 'x', artifacts: ['a'] }] }), /only for command gates/);
});
test('report format and artifact count are validated', () => {
  assert.throws(() => configSchema.parse({ ...base, gates: [{ id: 't', run: 'x', report: { format: 'Bad Format', path: 'r' } }] }));
  assert.throws(() => configSchema.parse({ ...base, gates: [{ id: 't', run: 'x', artifacts: Array.from({ length: 51 }, (_, i) => `a${i}`) }] }));
});
test('old gate results without artifacts parse with an empty list', () => {
  const result = gateResultSchema.parse({ id: 'g', command: 'x', execution: 'completed', decision: 'PASS', exitCode: 0, durationMs: 1, outputTail: '', errors: [] });
  assert.deepEqual(result.artifacts, []);
});
