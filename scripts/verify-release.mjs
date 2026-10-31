import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const report = { startedAt: new Date().toISOString(), node: process.version,
  platform: process.platform, status: 'FAIL', steps: [] };
try {
  for (const name of ['check', 'verify:analysis-package', 'verify:package', 'smoke:dashboard']) {
    console.log(`\nRelease verification: ${name}`);
    const start = Date.now();
    const child = spawn('pnpm', ['--silent', name], { cwd, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    report.steps.push({ name, code, durationMs: Date.now() - start });
    if (code !== 0) throw Error(`Release verification failed: ${name} (exit ${code})`);
  }
  report.status = 'PASS';
  console.log('\nLocal release checks passed. Nothing was pushed or published.');
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(new URL('../.qualitygate/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.qualitygate/release-check.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
}
