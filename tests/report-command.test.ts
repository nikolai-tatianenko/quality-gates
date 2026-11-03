import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandPlugin } from '../packages/plugins/command/src/index.js';
import { readReport } from '../packages/plugins/command/src/report.js';
import { builtinParsers } from '../packages/plugins/parsers/src/index.js';
import { gateSchema } from '../packages/protocol/src/index.js';
import type { ParserPlugin } from '../packages/plugin-sdk/src/index.js';
const context = { signal: new AbortController().signal, defer() {} };
const FAIL = '<testsuite><testcase classname="A" name="b"><failure message="boom"/></testcase></testsuite>';
async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'qg-report-')));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const gate = (run: string, report: { format: string; path: string }) => gateSchema.parse({ id: 'g', run, report });
const writer = (name: string, body: string, code: number) => {
  const script = `require('fs').writeFileSync('${name}', Buffer.from('${Buffer.from(body).toString('base64')}', 'base64')); process.exit(${code})`;
  return `node -e "${script}"`;
};
const throwing: Record<string, ParserPlugin> = { junit: { id: 'junit', apiVersion: 1, kind: 'parser', parse() { throw new Error('parser must not run'); } } };
test('exit 0 and a clean report pass with the report as an artifact', async () => withDir(async dir => {
  const data = await commandPlugin(dir, builtinParsers).run(gate(writer('r.xml', '<testsuite/>', 0), { format: 'junit', path: 'r.xml' }), context);
  assert.equal(data.exitCode, 0); assert.deepEqual(data.findings, []); assert.equal(data.error, undefined);
  assert.deepEqual(data.artifacts, [join(dir, 'r.xml')]);
}));
test('exit 1 with failures keeps the exit-code BLOCK and reports the finding', async () => withDir(async dir => {
  const data = await commandPlugin(dir, builtinParsers).run(gate(writer('r.xml', FAIL, 1), { format: 'junit', path: 'r.xml' }), context);
  assert.equal(data.exitCode, 1); assert.equal(data.findings?.length, 1); assert.equal(data.error, undefined);
}));
test('missing report: BLOCK with the log when the command failed, error when it exited 0', async () => withDir(async dir => {
  const plugin = commandPlugin(dir, builtinParsers);
  const failed = await plugin.run(gate('node -e "process.exit(1)"', { format: 'junit', path: 'r.xml' }), context);
  assert.equal(failed.error, undefined); assert.match(failed.output, /Report not found: r\.xml/);
  const passed = await plugin.run(gate('node -e "0"', { format: 'junit', path: 'r.xml' }), context);
  assert.match(passed.error ?? '', /Report not found/);
}));
test('exit 0 with a failing report is an error', async () => withDir(async dir => {
  const data = await commandPlugin(dir, builtinParsers).run(gate(writer('r.xml', FAIL, 0), { format: 'junit', path: 'r.xml' }), context);
  assert.match(data.error ?? '', /exited 0 but report contains failures/); assert.equal(data.findings?.length, 1);
}));
test('report paths outside the project or through symlinks are never read', async () => withDir(async dir => {
  await writeFile(join(dir, '..', 'outside-report.xml'), FAIL).catch(() => {});
  await writeFile(join(dir, 'real.xml'), FAIL);
  await symlink(join(dir, 'real.xml'), join(dir, 'link.xml'));
  await mkdir(join(dir, 'sub')); await symlink(dir, join(dir, 'sub', 'up'));
  const plugin = commandPlugin(dir, throwing);
  for (const path of ['../outside-report.xml', join(dir, 'real.xml'), 'link.xml', 'sub/up/real.xml']) {
    const data = await plugin.run(gate('node -e "0"', { format: 'junit', path }), context);
    assert.match(data.error ?? '', /Report path/, path); assert.deepEqual(data.findings ?? [], []);
  }
  await rm(join(dir, '..', 'outside-report.xml'), { force: true });
}));
test('reports over 5 MB are rejected', async () => withDir(async dir => {
  const big = Buffer.alloc(5 * 1024 * 1024 + 1, 'a');
  await writeFile(join(dir, 'big.xml'), big);
  const data = await commandPlugin(dir, throwing).run(gate('node -e "0"', { format: 'junit', path: 'big.xml' }), context);
  assert.match(data.error ?? '', /5 MB/);
  assert.deepEqual(await readReport(dir, 'big.xml'), { status: 'error', error: 'Report exceeds the 5 MB limit: big.xml' });
}));
test('malformed XML and unknown formats are errors, never crashes', async () => withDir(async dir => {
  const plugin = commandPlugin(dir, builtinParsers);
  const bad = await plugin.run(gate(writer('r.xml', '<a><b></a>', 0), { format: 'junit', path: 'r.xml' }), context);
  assert.match(bad.error ?? '', /^Invalid junit report: Invalid XML/);
  const unknown = await plugin.run(gate('node -e "0"', { format: 'nope', path: 'r.xml' }), context);
  assert.equal(unknown.error, 'Unknown report format: nope');
}));
test('readReport rejects directories and other read failures', async () => withDir(async dir => {
  await mkdir(join(dir, 'd'));
  assert.equal((await readReport(dir, 'd')).status, 'error');
  assert.match((await readReport(dir, 'bad\0name') as { error: string }).error, /^Cannot read report/);
  assert.deepEqual(await readReport(dir, 'nothing.xml'), { status: 'missing' });
  assert.deepEqual(await readReport(dir, 'nested/nothing.xml'), { status: 'missing' });
}));
test('gates without a report keep the original result shape', async () => withDir(async dir => {
  const data = await commandPlugin(dir).run(gateSchema.parse({ id: 'g', run: 'node -e "0"' }), context);
  assert.deepEqual(Object.keys(data).sort(), ['error', 'exitCode', 'output']);
}));
