import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinParsers } from '../packages/plugins/parsers/src/index.js';
const ctx = { gateId: 'g', cwd: '/proj' };
const parse = (format: string, raw: string) => builtinParsers[format]!.parse(raw, ctx);
test('unity-log reads compiler diagnostics once each', () => {
  const line = "Assets/Scripts/Foo.cs(12,5): error CS0103: The name 'x' does not exist";
  assert.deepEqual(parse('unity-log', `noise\n${line}\n${line}\n`), [{ gateId: 'g', severity: 'error', file: 'Assets/Scripts/Foo.cs', line: 12, column: 5, ruleId: 'CS0103', message: "The name 'x' does not exist" }]);
  assert.equal(parse('unity-log', 'Assets/A.cs(1,1): warning CS0168: unused')[0]?.severity, 'warning');
  assert.deepEqual(parse('unity-log', 'all fine'), []);
});
const spec = (status: string, extra = {}) => JSON.stringify({ suites: [{ title: 'root', suites: [{ title: 'nested', specs: [{ title: 'does it', file: 'tests/a.spec.ts', line: 7, column: 3, tests: [{ results: [{ status, ...extra }] }] }] }] }] });
test('playwright-json reports failed and timed out tests only', () => {
  const failed = parse('playwright-json', spec('failed', { error: { message: 'expected 1' } }));
  assert.deepEqual(failed, [{ gateId: 'g', severity: 'error', file: 'tests/a.spec.ts', line: 7, column: 3, message: 'does it: expected 1' }]);
  assert.equal(parse('playwright-json', spec('timedOut')).length, 1);
  assert.equal(parse('playwright-json', spec('timedOut'))[0]?.message, 'does it');
  assert.deepEqual(parse('playwright-json', spec('passed')), []);
  assert.deepEqual(parse('playwright-json', spec('skipped')), []);
  assert.deepEqual(parse('playwright-json', '{}'), []);
  assert.throws(() => parse('playwright-json', 'not json'));
});
test('playwright-json handles specs without location', () => {
  const raw = JSON.stringify({ suites: [{ specs: [{ title: 't', tests: [{ results: [{ status: 'failed' }] }] }] }] });
  assert.deepEqual(parse('playwright-json', raw), [{ gateId: 'g', severity: 'error', message: 't' }]);
});
test('eslint-json delegates to the ESLint report parser', () => {
  const raw = JSON.stringify([{ filePath: '/proj/a.ts', messages: [{ ruleId: 'r', severity: 2, message: 'bad', line: 1, column: 2 }] }]);
  assert.deepEqual(parse('eslint-json', raw), [{ gateId: 'g', severity: 'error', message: 'bad', file: 'a.ts', line: 1, column: 2, ruleId: 'r' }]);
});
