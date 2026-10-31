import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { Launcher, getChromePath } from 'chrome-launcher';
import type { AuditPlugin } from '../../../plugin-sdk/src/index.js';
import { categories, message, type Config, type Scores } from '../../../protocol/src/index.js';
interface RawReport {
  categories?: Record<string, { score: number | null }>;
  runtimeError?: { code: string; message: string };
}
/** Reap the owned process before the launcher removes its profile directory. */
async function stopBrowser(browser: Launcher) {
  const child = browser.chromeProcess;
  try {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { child.kill('SIGKILL'); }
      await closed;
    }
  } finally { browser.kill(); }
}
export function normalize(raw: RawReport): Scores {
  const scores: Scores = {};
  for (const name of categories) {
    const value = raw.categories?.[name]?.score;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) scores[name] = Math.round(value * 100);
  }
  return scores;
}
export function chromeStartupMessage(error: unknown, stderr: string): string {
  const detail = stderr.trim().slice(-2000);
  const sandbox = /no usable sandbox|running as root.*no-sandbox|failed to move to new namespace/i.test(detail);
  return `Chrome startup failed: ${message(error)}${detail ? `\n${detail}` : ''}`
    + (sandbox ? '\nChrome sandbox is unavailable. Fix the host sandbox, or explicitly set chrome.noSandbox: true in an isolated container you control.' : '');
}
export function lighthousePlugin(timeoutMs: number, chrome: Config['chrome'] = { noSandbox: false, launchTimeoutMs: 10000 }): AuditPlugin {
  return {
    id: 'lighthouse', apiVersion: 1, kind: 'audit',
    async audit(url, context) {
      const controller = new AbortController();
      const interrupt = () => controller.abort(new Error('Interrupted'));
      context.signal.addEventListener('abort', interrupt, { once: true });
      if (context.signal.aborted) interrupt();
      const timer = setTimeout(() => controller.abort(new Error(`Audit timed out after ${timeoutMs}ms`)), timeoutMs);
      let worker: Worker | undefined;
      let browser: Launcher | undefined;
      // Register before launch, including partially launched Chrome instances.
      context.defer(async () => {
        try { if (worker) await worker.terminate(); }
        finally {
          if (browser) await stopBrowser(browser);
        }
      });
      try {
        const chromePath = process.env.CHROME_PATH || getChromePath();
        await access(chromePath, constants.X_OK);
        controller.signal.throwIfAborted();
        let spawnError: Error | undefined;
        browser = new Launcher({ chromePath, handleSIGINT: false, logLevel: 'silent',
          chromeFlags: ['--headless', '--disable-dev-shm-usage', ...(chrome.noSandbox ? ['--no-sandbox'] : [])],
          connectionPollInterval: 100,
          maxConnectionRetries: Math.ceil(Math.min(chrome.launchTimeoutMs, timeoutMs) / 100) }, {
          spawn: ((...args: Parameters<typeof spawn>) => {
            const child = spawn(...args);
            child.once('error', error => { spawnError = error; });
            return child;
          }) as typeof spawn,
        });
        // Await launch settlement before cleanup, so a late launch cannot escape it.
        try { await browser.launch(); }
        catch (error) {
          controller.signal.throwIfAborted();
          const stderr = browser.userDataDir
            ? await readFile(join(browser.userDataDir, 'chrome-err.log'), 'utf8').catch(() => '') : '';
          throw new Error(chromeStartupMessage(spawnError || error, stderr));
        }
        controller.signal.throwIfAborted();
        worker = new Worker(new URL('./lighthouse-worker.mjs', import.meta.url), {
          workerData: { url, port: browser.port }, stdout: true, stderr: true,
        });
        // Drain tool output without mixing it into the CLI JSON stream.
        worker.stdout.resume(); worker.stderr.resume();
        const currentWorker = worker;
        const raw = await new Promise<RawReport>((resolve, reject) => {
          const abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', abort, { once: true });
          const finish = () => controller.signal.removeEventListener('abort', abort);
          currentWorker.once('message', (data: { raw?: RawReport; error?: string }) => {
            finish();
            if (data.error || !data.raw) reject(new Error(data.error || 'Missing Lighthouse result'));
            else resolve(data.raw);
          });
          currentWorker.once('error', error => { finish(); reject(error); });
          currentWorker.once('exit', code => { finish(); reject(new Error(`Lighthouse worker exited before result (${code})`)); });
          if (controller.signal.aborted) abort();
        });
        return { scores: normalize(raw), raw, error: raw.runtimeError ? `${raw.runtimeError.code}: ${raw.runtimeError.message}` : undefined };
      } finally {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', interrupt);
      }
    },
  };
}
