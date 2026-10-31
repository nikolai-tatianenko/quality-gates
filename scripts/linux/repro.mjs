import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd();
const output = process.env.QUALITYGATE_LINUX_OUTPUT || '/artifacts';
await mkdir(output, { recursive: true });
const html = await readFile(join(root, 'tests/fixture.html'));
const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const chrome = process.env.CHROME_PATH; assert.ok(chrome);
async function audit(name, noSandbox) {
  const path = join(output, `${name}.json`);
  await writeFile(path, JSON.stringify({ schemaVersion: 1, urls: [`http://127.0.0.1:${address.port}`],
    thresholds: { performance: 0, accessibility: 0, seo: 0, 'best-practices': 0 },
    timeoutMs: 45000, chrome: { noSandbox, launchTimeoutMs: 2000 }, outputDir: join(output, name) }));
  const child = spawn(process.execPath, [join(root, 'dist/qualitygate.mjs'), 'run', '--config', path, '--json'], { env: process.env });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(stderr, ''); const result = JSON.parse(stdout);
  await writeFile(join(output, `${name}-result.json`), stdout);
  console.log(`${name}: exit ${code}, ${result.execution}, ${result.decision}`);
  return { code, result };
}
try {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0, 'The negative reproduction uses an isolated root container');
  const failing = await audit('sandbox-startup-failure', false);
  assert.equal(failing.code, 2); assert.match(failing.result.results[0].errors.join(), /sandbox/i);
  const passing = await audit('explicit-container-opt-in', true);
  assert.equal(passing.code, 0); assert.equal(passing.result.results[0].execution, 'completed');
  await writeFile(join(output, 'environment.json'), JSON.stringify({ platform: process.platform, node: process.version,
    chrome: execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim(), isolatedContainer: true,
    cases: ['sandbox-startup-failure', 'explicit-container-opt-in'] }, null, 2));
  console.log(`Linux reproduction and successful audit verified. Evidence: ${output}`);
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
