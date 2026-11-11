import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countsLine, runResultSchema, type RunResult } from '../packages/protocol/src/index.js';
import { printRun } from '../packages/cli/src/output.js';
import { renderMarkdown } from '../packages/ci/src/report.js';
import { commandPlugin } from '../packages/plugins/command/src/index.js';
import { builtinParsers } from '../packages/plugins/parsers/src/index.js';
const context = { signal: new AbortController().signal, defer() {} };
const gate = (counts?: { passed: number; failed: number; skipped: number }, decision: 'PASS' | 'BLOCK' = 'PASS') => ({ id: 'unit', command: 'x', execution: 'completed' as const, decision,
  exitCode: decision === 'PASS' ? 0 : 1, durationMs: 5, outputTail: '', errors: [], findings: [], artifacts: [], ...(counts ? { counts } : {}) });
const run = (...gates: ReturnType<typeof gate>[]): RunResult => runResultSchema.parse({ schemaVersion: 1, runId: 'r', startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z', execution: 'completed', decision: gates.every(item => item.decision === 'PASS') ? 'PASS' : 'BLOCK', results: [], gates, errors: [], findings: [] });
const printed = (result: RunResult) => {
  const lines: string[] = []; const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try { printRun(result); } finally { console.log = original; }
  return lines.join('\n');
};
test('countsLine says "56 tests passed" and splits the numbers when something failed or was skipped', () => {
  assert.equal(countsLine({ passed: 56, failed: 0, skipped: 0 }), '56 tests passed');
  assert.equal(countsLine({ passed: 1, failed: 0, skipped: 0 }), '1 test passed');
  assert.equal(countsLine({ passed: 54, failed: 1, skipped: 1 }), '56 tests: 54 passed, 1 failed, 1 skipped');
});
test('text and Markdown output show the test counts of a gate without changing the decision', () => {
  const passing = run(gate({ passed: 56, failed: 0, skipped: 0 }));
  assert.match(printed(passing), /PASS gate unit[^\n]*\n {2}56 tests passed/);
  assert.match(renderMarkdown(passing), /Gate unit: 56 tests passed/);
  assert.equal(passing.decision, 'PASS');
  assert.doesNotMatch(printed(run(gate())), /tests? passed/);
  assert.doesNotMatch(renderMarkdown(run(gate())), /tests? passed/);
  assert.match(printed(run(gate({ passed: 2, failed: 1, skipped: 0 }, 'BLOCK'))), /3 tests: 2 passed, 1 failed, 0 skipped/);
});
test('a passing gate with a JUnit report returns the counts and stays PASS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-counts-'));
  try {
    const xml = '<testsuite>' + '<testcase name="a"/>'.repeat(3) + '<testcase name="s"><skipped/></testcase></testsuite>';
    const data = await commandPlugin(dir, builtinParsers).run({ id: 'unit', type: 'command', run: `printf '%s' '${xml}' > r.xml`, report: { format: 'junit', path: 'r.xml' } } as never, context);
    assert.equal(data.exitCode, 0); assert.equal(data.error, undefined);
    assert.deepEqual(data.counts, { passed: 3, failed: 0, skipped: 1 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
