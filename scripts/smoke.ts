import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { configSchema, runResultSchema, cliErrorSchema, type RunResult } from '../packages/protocol/src/index.js';
import { evaluate } from '../packages/policy/src/index.js';

const entry = resolve(process.env.QUALITYGATE_CLI || 'dist/qualitygate.mjs');
const base = resolve('.qualitygate'); await mkdir(base, { recursive: true });
const directory = await mkdtemp(join(base, 'smoke-'));
const html = await readFile(new URL('../tests/fixture.html', import.meta.url));
let hangingRequest: (() => void) | undefined;
const server = createServer((req, res) => {
  if (req.url === '/hang') { hangingRequest?.(); return; }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(html);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}`;
const thresholds = { performance: 0, accessibility: 0, seo: 0, 'best-practices': 0 };
function chromeChildren(pid: number): number[] {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const row = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return row && Number(row[2]) === pid && /--remote-debugging-port/.test(row[3]!) ? [Number(row[1])] : [];
  });
}
async function audit(name: string, urls: string[], patch = {}, options: { env?: Record<string, string>; interrupt?: boolean; text?: boolean } = {}) {
  const path = join(directory, `${name}.yml`);
  const config = configSchema.parse({ schemaVersion: 1, urls, thresholds, outputDir: name, timeoutMs: 60000, ...patch });
  await writeFile(path, stringify(config));
  let visited: (() => void) | undefined;
  const arrived = new Promise<void>(resolve => { visited = resolve; });
  hangingRequest = visited;
  const child = spawn(process.execPath, [entry, 'run', '--config', path, ...(options.text ? [] : ['--json'])], { env: { ...process.env, ...options.env } });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const owned = new Set<number>();
  const poll = setInterval(() => { if (child.pid) for (const pid of chromeChildren(child.pid)) owned.add(pid); }, 100);
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 90000);
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve(code));
  });
  if (options.interrupt) {
    await Promise.race([arrived, closed.then(() => { throw new Error(`CLI exited before fixture request: ${stdout} ${stderr}`); }), delay(15000).then(() => { throw new Error('No fixture request before Ctrl+C'); })]);
    child.kill('SIGINT');
  }
  let code: number | null;
  try { code = await closed; }
  finally { clearInterval(poll); clearTimeout(watchdog); hangingRequest = undefined; }
  assert.equal(stderr, '', `${name} stderr`);
  for (const pid of owned) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `${name} leaked Chrome ${pid}`);
  if (options.text) return { code, text: stdout, result: undefined };
  let result: RunResult;
  try { result = runResultSchema.parse(JSON.parse(stdout)); }
  catch (error) { throw new Error(`${name}: invalid run result: ${stdout}`, { cause: error }); }
  if (result.reportPath) assert.deepEqual(JSON.parse(await readFile(result.reportPath, 'utf8')), result);
  console.log(`${name}: exit ${code}, ${result.decision}, ${result.execution}, Chrome cleaned (${owned.size})`);
  return { code, result, text: stdout };
}
try {
  const pass = await audit('pass', [url, `${url}/second`]);
  assert.equal(pass.code, 0); assert.equal(pass.result!.results.length, 2);
  for (const item of pass.result!.results) {
    const raw = JSON.parse(await readFile(item.evidencePath!, 'utf8'));
    assert.ok(raw.lighthouseVersion); assert.ok(raw.categories.performance);
  }
  const saved = runResultSchema.parse(JSON.parse(await readFile(pass.result!.reportPath!, 'utf8')));
  assert.equal(evaluate(saved.results[0]!.scores, thresholds).decision, 'PASS');
  assert.equal(evaluate(saved.results[0]!.scores, { ...thresholds, seo: 100 }).decision, 'BLOCK');
  assert.equal((await audit('block', [url], { thresholds: { ...thresholds, seo: 100 } })).code, 1);
  const mixed = await audit('mixed', [url, 'http://127.0.0.1:1'], { thresholds: { ...thresholds, seo: 100 } });
  assert.equal(mixed.code, 2); assert.equal(mixed.result!.results[0]!.execution, 'completed');
  assert.equal(mixed.result!.results[1]!.execution, 'error');
  assert.ok(mixed.result!.results[1]!.errors.length);
  assert.equal((await audit('no-chrome', [url], {}, { env: { CHROME_PATH: '/qualitygate-no-such-chrome' } })).code, 2);
  const timeout = await audit('timeout', [`${url}/hang`], { timeoutMs: 2500 });
  assert.equal(timeout.code, 2); assert.match(timeout.result!.results[0]!.errors.join(), /timed out/);
  const interrupted = await audit('interrupt', [`${url}/hang`, url], {}, { interrupt: true });
  assert.equal(interrupted.code, 130); assert.equal(interrupted.result!.results[1]!.execution, 'skipped');
  const occupied = join(directory, 'occupied'); await writeFile(occupied, 'not a directory');
  const writeFailure = await audit('write-error', [url], { outputDir: occupied });
  assert.equal(writeFailure.code, 2); assert.match(writeFailure.result!.errors.join(), /Storage initialization/);
  assert.equal(writeFailure.result!.results[0]!.execution, 'completed');
  const plain = await audit('plain', [url], {}, { text: true, env: { CHROME_PATH: '/qualitygate-no-such-chrome' } });
  assert.equal(plain.code, 2); assert.match(plain.text, /BLOCK.*\(error\)/); assert.match(plain.text, /Report:/);
  const invalid = join(directory, 'invalid.yml'); await writeFile(invalid, 'schemaVersion: 99\n');
  const child = spawn(process.execPath, [entry, 'run', '--config', invalid, '--json']);
  let output = ''; child.stdout.on('data', data => { output += data; });
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 2); cliErrorSchema.parse(JSON.parse(output));
  console.log(`Smoke passed. Evidence: ${directory}`);
} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
