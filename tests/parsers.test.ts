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
test('junit reports failures and errors for both root shapes', () => {
  const fail = '<testcase classname="A" name="b"><failure message="boom">stack</failure></testcase>';
  const expected = [{ gateId: 'g', severity: 'error', message: 'A.b: boom' }];
  assert.deepEqual(parse('junit', `<testsuite>${fail}</testsuite>`), expected);
  assert.deepEqual(parse('junit', `<testsuites><testsuite>${fail}<testcase name="ok"/></testsuite><testsuite>${fail}</testsuite></testsuites>`).length, 2);
  assert.deepEqual(parse('junit', '<testsuite><testcase classname="A" name="b"><error message="oops"/></testcase></testsuite>'), [{ gateId: 'g', severity: 'error', message: 'A.b: oops' }]);
  assert.deepEqual(parse('junit', '<testsuite><testcase name="b"><failure>text body</failure></testcase></testsuite>'), [{ gateId: 'g', severity: 'error', message: 'b: text body' }]);
  assert.deepEqual(parse('junit', '<testsuite><testcase name="b"><failure/></testcase></testsuite>'), [{ gateId: 'g', severity: 'error', message: 'b: failed' }]);
  assert.deepEqual(parse('junit', '<testsuite><testcase name="s"><skipped/></testcase></testsuite>'), []);
  assert.deepEqual(parse('junit', '<testsuite/>'), []);
  assert.deepEqual(parse('junit', '<testsuite name="x" tests="0"></testsuite>'), []);
});
const nunit = (result: string, failure = '') => `<test-run><test-suite><test-suite><test-case fullname="N.T.m" result="${result}">${failure}</test-case></test-suite></test-suite></test-run>`;
test('nunit reports failed cases with file and line from the stack trace', () => {
  const failure = '<failure><message><![CDATA[expected 1]]></message><stack-trace><![CDATA[at N.T.m () in /proj/Assets/Tests/T.cs:line 42]]></stack-trace></failure>';
  assert.deepEqual(parse('nunit', nunit('Failed', failure)), [{ gateId: 'g', severity: 'error', message: 'N.T.m: expected 1', file: 'Assets/Tests/T.cs', line: 42 }]);
  const outside = failure.replace('/proj/Assets', '/elsewhere/Assets');
  assert.equal(parse('nunit', nunit('Failed', outside))[0]?.file, '/elsewhere/Assets/Tests/T.cs');
  for (const result of ['Passed', 'Skipped', 'Inconclusive']) assert.deepEqual(parse('nunit', nunit(result)), []);
  assert.deepEqual(parse('nunit', nunit('Failed', '<failure><message>no trace</message></failure>')), [{ gateId: 'g', severity: 'error', message: 'N.T.m: no trace' }]);
  assert.deepEqual(parse('nunit', nunit('Failed')), [{ gateId: 'g', severity: 'error', message: 'N.T.m: failed' }]);
  assert.deepEqual(parse('nunit', nunit('Failed', '<failure><message>m</message><stack-trace>no location</stack-trace></failure>')), [{ gateId: 'g', severity: 'error', message: 'N.T.m: m' }]);
  assert.deepEqual(parse('nunit', '<test-run/>'), []);
});
test('xml parsers reject malformed input', () => {
  for (const format of ['junit', 'nunit']) {
    assert.throws(() => parse(format, '<testsuite><oops></testsuite>'), /^Error: Invalid XML/);
    assert.throws(() => parse(format, 'plain text'), /^Error: Invalid XML/);
  }
});
const violation = (extra = {}) => ({ id: 'color-contrast', impact: 'serious', help: 'Elements must have sufficient color contrast', helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/color-contrast',
  nodes: [{ target: ['.btn'] }, { target: ['#host', '.inner'] }], ...extra });
test('axe-json turns each violating node into a finding with impact severity, rule, selector and help URL', () => {
  const findings = parse('axe-json', JSON.stringify({ violations: [violation()], passes: [] }));
  assert.deepEqual(findings[0], { gateId: 'g', severity: 'error', ruleId: 'color-contrast', message: 'Elements must have sufficient color contrast (.btn)',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/color-contrast' });
  assert.equal(findings[1]?.message, 'Elements must have sufficient color contrast (#host .inner)');
  const severity = (impact: unknown) => parse('axe-json', JSON.stringify({ violations: [violation({ impact, nodes: [] })] }))[0]?.severity;
  assert.deepEqual(['critical', 'serious', 'moderate', 'minor', null].map(severity), ['error', 'error', 'warning', 'info', 'warning']);
});
test('axe-json accepts a list of page results, tolerates missing optional fields and rejects bad input', () => {
  const page = JSON.stringify([{ violations: [{ id: 'label', help: 'Form elements need labels', nodes: [{ target: ['input'] }] }] }, { violations: [] }]);
  assert.deepEqual(parse('axe-json', page), [{ gateId: 'g', severity: 'warning', ruleId: 'label', message: 'Form elements need labels (input)' }]);
  assert.deepEqual(parse('axe-json', '{}'), []);
  assert.throws(() => parse('axe-json', 'not json'));
  assert.throws(() => parse('axe-json', '{"violations":[{"impact":"serious"}]}'));
});
test('axe-json falls back to the description, then the rule id, and copes with nodes without a target', () => {
  const raw = JSON.stringify({ violations: [{ id: 'a', description: 'Described', nodes: [{}] }, { id: 'b' }] });
  assert.deepEqual(parse('axe-json', raw).map(finding => finding.message), ['Described', 'b']);
});
