import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runResultSchema } from '../packages/protocol/src/index.js';
const entry = resolve('packages/cli/src/index.ts');
function cli(dir: string, args: string[]) {
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), entry, ...args, '--config', join(dir, '.qualitygate.yml')], { cwd: dir });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((res, reject) => {
    child.once('error', reject); child.once('close', code => res({ code, stdout, stderr }));
  });
}
test('qualitygate run turns a JUnit report into findings and stores artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-report-cli-'));
  try {
    const xml = '<testsuite><testcase classname="A" name="b"><failure message="boom"/></testcase></testsuite>';
    const script = `const fs=require('fs');fs.writeFileSync('r.xml',Buffer.from('${Buffer.from(xml).toString('base64')}','base64'));fs.mkdirSync('shots',{recursive:true});fs.writeFileSync('shots/a.png',Buffer.from([137,80,78,71]));process.exit(1)`;
    await writeFile(join(dir, '.qualitygate.yml'), JSON.stringify({ schemaVersion: 1, gates: [{ id: 'e2e', run: `node -e "${script}"`,
      report: { format: 'junit', path: 'r.xml' }, artifacts: ['shots/*.png'] }] }));
    const json = await cli(dir, ['run', '--json']);
    assert.equal(json.code, 1);
    const result = runResultSchema.parse(JSON.parse(json.stdout));
    assert.equal(result.gates[0]?.artifacts.length, 2);
    assert.equal(result.findings[0]?.message, 'A.b: boom');
    assert.deepEqual(await readFile(result.gates[0]!.artifacts.find(path => path.endsWith('a.png'))!), Buffer.from([137, 80, 78, 71]));
    const text = await cli(dir, ['run']);
    assert.match(text.stdout, /Artifact: .*artifact-1-r\.xml/); assert.match(text.stdout, /Artifact: .*artifact-2-a\.png/);
    assert.match(text.stdout, /A\.b: boom/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
