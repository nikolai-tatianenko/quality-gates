import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandPlugin } from '../packages/plugins/command/src/index.js';
import { builtinParsers } from '../packages/plugins/parsers/src/index.js';
const context = { signal: new AbortController().signal, defer() {} };
/** Writes more than the capture limit, then the line that shows what hung, then hangs. */
const hang = `'${process.execPath}' -e "process.stdout.write('x'.repeat(1.2e6) + '\\nLAST-LINE-BEFORE-HANG\\n')"; sleep 30`;
const run = (extra: object) => commandPlugin(process.cwd(), builtinParsers).run({ id: 'g', type: 'command', run: hang, timeoutMs: 3000, ...extra } as never, context);
test('a timeout keeps the last part of the output captured before the kill, bounded', async () => {
  for (const extra of [{}, { report: { format: 'junit', path: 'absent.xml' } }]) {
    const data = await run(extra);
    assert.equal(data.timedOut, true);
    assert.match(data.output, /LAST-LINE-BEFORE-HANG\n/);
    assert.match(data.output, /output truncated/);
    assert.ok(data.output.length < 1_100_000, `bounded, got ${data.output.length}`);
  }
});
test('a secret scanner timeout still withholds the output, tail included', async () => {
  const data = await run({ report: { format: 'gitleaks', path: 'absent.json' } });
  assert.equal(data.timedOut, true);
  assert.match(data.output, /output withheld/);
  assert.doesNotMatch(data.output, /LAST-LINE-BEFORE-HANG/);
});
