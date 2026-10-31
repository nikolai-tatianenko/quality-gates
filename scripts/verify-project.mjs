import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
const root = resolve('.');
const output = join(root, '.qualitygate/project-verification'); await mkdir(output, { recursive: true });
const readme = await readFile(join(root, 'README.md'), 'utf8');
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
// A local documentation preview of this actual repository, not a separate toy app.
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="QualityGate project documentation"><title>QualityGate documentation</title><link rel="icon" href="data:,"><style>body{max-width:70rem;margin:2rem auto;padding:1rem;font:18px system-ui;color:#17202a;background:#fff}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><main><h1>QualityGate documentation</h1><pre>${escape(readme)}</pre></main></body></html>`;
const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const config = join(root, `.qualitygate-project-${randomUUID()}.json`);
const selfConfig = parse(await readFile(join(root, '.qualitygate.yml'), 'utf8'));
await writeFile(config, JSON.stringify({ ...selfConfig,
  urls: [`http://127.0.0.1:${address.port}`], thresholds: { performance: 80, accessibility: 90, seo: 90, 'best-practices': 90 }, outputDir: output }));
try {
  const child = spawn(process.execPath, [join(root, 'dist/qualitygate.mjs'), 'run', '--config', config, '--json'], { env: process.env });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await writeFile(join(output, 'result.json'), stdout); assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  console.log(JSON.stringify({ code, execution: result.execution, decision: result.decision,
    gates: result.gates.map(g => ({ id: g.id, decision: g.decision, errors: g.errors })),
    urls: result.results.map(r => ({ url: r.url, scores: r.scores, errors: r.errors })), reportPath: result.reportPath }, null, 2));
  assert.equal(code, 0); assert.equal(result.gates.length, selfConfig.gates.length); assert.equal(result.results.length, 1);
  assert.equal(result.execution, 'completed'); assert.equal(result.decision, 'PASS');
} finally { await unlink(config); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
