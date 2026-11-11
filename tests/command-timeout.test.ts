import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const SECRET = 'AKIAQWERTY1234567890ABCDEFGHIJKL';
test('a secret scanner timeout never adds the tail, so a secret cut by the tail boundary cannot leak in part', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qg-tail-'));
  try {
    const total = 1_200_000; const tail = 64 * 1024;
    const before = total - tail - 10; // the secret starts 10 bytes before the tail boundary
    const script = `const fs=require('fs');fs.writeFileSync('leaks.json',JSON.stringify([{RuleID:'r',File:'a.txt',StartLine:1,Secret:'${SECRET}',Match:'${SECRET}'}]));`
      + `process.stdout.write('x'.repeat(${before})+'${SECRET}'+'x'.repeat(${total - before - SECRET.length})+'\\n')`;
    const command = `'${process.execPath}' -e "${script}"; sleep 30`;
    const data = await commandPlugin(directory, builtinParsers).run({ id: 'g', type: 'command', run: command, timeoutMs: 4000, report: { format: 'gitleaks', path: 'leaks.json' } } as never, context);
    assert.equal(data.timedOut, true);
    for (let size = 4; size <= SECRET.length; size++) for (let at = 0; at + size <= SECRET.length; at++) assert.ok(!data.output.includes(SECRET.slice(at, at + size)), `fragment ${SECRET.slice(at, at + size)} leaked`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('the tail of another gate starts at a line start, never in the middle of a character', async () => {
  const script = `process.stdout.write('a'+'é'.repeat(700000)+'\\nLAST-LINE\\n')`;
  const data = await commandPlugin(process.cwd(), builtinParsers).run({ id: 'g', type: 'command', run: `'${process.execPath}' -e "${script}"; sleep 30`, timeoutMs: 3000 } as never, context);
  const tailPart = data.output.slice(data.output.indexOf('timeout follow]') + 'timeout follow]'.length);
  assert.equal(tailPart, '\nLAST-LINE\n');
});
