import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeGate } from '../packages/core/src/execution.js';
import { tidyMessage, runResultSchema, type GateSpec } from '../packages/protocol/src/index.js';
import { renderMarkdown } from '../packages/ci/src/report.js';
import { renderSarif } from '../packages/ci/src/sarif.js';
const ESC = String.fromCharCode(27);
const flattened = 't.fails: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 1 !== 2     at TestContext.<anonymous> (file:///proj/tests/a.test.mjs:12:3)     at Test.runInAsyncScope (node:async_hooks:214:14)     at Test.run (node:internal/test_runner/test:1047:25)';
test('tidyMessage strips ANSI sequences and collapses a flattened stack trace to its first meaningful line', () => {
  assert.equal(tidyMessage(`${ESC}[31mred${ESC}[0m ${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\ ${ESC}[1;32mok`), 'red link ok');
  assert.equal(tidyMessage(flattened), 't.fails: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 1 !== 2');
  assert.equal(tidyMessage('boom\n    at run (/proj/a.ts:1:2)\n    at node:internal/x:3:4'), 'boom');
  assert.equal(tidyMessage('\n\n  first line\nsecond line\n    at f (/p/a.js:1:1)'), 'first line');
  assert.equal(tidyMessage('at f (/p/a.js:1:1)\nat g (/p/b.js:2:2)'), 'at f (/p/a.js:1:1)');
  assert.equal(tidyMessage('expected 1\nreceived 2'), 'expected 1\nreceived 2');
  assert.equal(tidyMessage('look at the file a.ts for details'), 'look at the file a.ts for details');
});
const spec = { id: 'g', type: 'command', run: 'true' } as GateSpec;
const storage = { id: 'storage', apiVersion: 1 as const, kind: 'storage' as const, createRun: async () => '', write: async () => '' };
test('gate findings carry tidy messages while the log keeps the full text, readable in Markdown and SARIF', async () => {
  const raw = `${ESC}[31m${flattened}${ESC}[0m`;
  const gate = await executeGate(spec, 0, { signal: new AbortController().signal, storage }, { id: 'p', apiVersion: 1, kind: 'gate',
    run: async () => ({ exitCode: 1, output: raw, findings: [{ gateId: 'g', severity: 'error', message: raw }] }) });
  assert.equal(gate.findings[0]!.message, 't.fails: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 1 !== 2');
  assert.match(gate.outputTail, /file:\/\/\/proj\/tests\/a\.test\.mjs:12:3/);
  const run = runResultSchema.parse({ schemaVersion: 1, runId: 'r', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', execution: 'completed',
    decision: 'BLOCK', results: [], gates: [gate], errors: [], findings: gate.findings });
  const markdown = renderMarkdown(run);
  assert.ok(!markdown.includes(ESC)); assert.match(markdown, /strictly equal: 1 \\!== 2/);
  assert.ok(!JSON.stringify(JSON.parse(renderSarif(run)).runs[0].results).includes('node:async_hooks'));
});
