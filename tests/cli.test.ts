import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { cliOutputSchema, configSchema } from '../packages/protocol/src/index.js';
const entry = resolve('packages/cli/src/index.ts');
function cli(cwd: string, args: string[], chromePath = '/qualitygate-no-such-chrome') {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], { cwd, env: { ...process.env, CHROME_PATH: chromePath } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
}
test('init, no overwrite, invalid config/arguments and missing Chrome obey JSON/exit contracts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-cli-'));
  try {
    const path = join(dir, '.qualitygate.yml');
    const created = await cli(process.cwd(), ['init', 'https://example.com', '--config', path, '--json']);
    assert.equal(created.code, 0); assert.equal(created.stderr, '');
    const original = await readFile(path, 'utf8'); configSchema.parse(parse(original));
    const duplicate = await cli(process.cwd(), ['init', '--config', path, '--json']);
    assert.equal(duplicate.code, 2); assert.ok(cliOutputSchema.safeParse(JSON.parse(duplicate.stdout)).success);
    assert.equal(await readFile(path, 'utf8'), original);
    for (const args of [['run', '--config'], ['unknown'], ['run', '--bad'], ['run', 'extra']]) {
      const result = await cli(process.cwd(), [...args, '--json']);
      assert.equal(result.code, 2); assert.equal(result.stderr, ''); cliOutputSchema.parse(JSON.parse(result.stdout));
    }
    const missing = await cli(process.cwd(), ['run', '--config', path, '--json']);
    assert.equal(missing.code, 2); assert.equal(missing.stderr, '');
    const result = JSON.parse(missing.stdout); cliOutputSchema.parse(result);
    assert.match(result.results[0].errors.join(), /qualitygate-no-such-chrome/);
    assert.ok(result.reportPath);
    const invalidBinary = join(dir, 'bad-chrome');
    await writeFile(invalidBinary, '#!/qualitygate-missing-interpreter\n', { mode: 0o755 });
    const spawnFailure = await cli(process.cwd(), ['run', '--config', path, '--json'], invalidBinary);
    assert.equal(spawnFailure.code, 2); assert.equal(spawnFailure.stderr, '');
    const spawnResult = JSON.parse(spawnFailure.stdout); cliOutputSchema.parse(spawnResult);
    assert.match(spawnResult.results[0].errors.join(), /ENOENT/);
    await writeFile(path, 'schemaVersion: 100\n');
    const invalid = await cli(process.cwd(), ['run', '--config', path, '--json']);
    assert.equal(invalid.code, 2); cliOutputSchema.parse(JSON.parse(invalid.stdout));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
