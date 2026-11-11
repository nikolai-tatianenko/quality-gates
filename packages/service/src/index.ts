import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { message, runResultSchema, type RunResult } from '../../protocol/src/index.js';
import { execute, loadConfig } from '../../cli/src/runner.js';
import { readRuns } from '../../core/src/history.js';
import { readVisual, readVisualImage, type VisualView } from '../../core/src/visual.js';
import { buildTeamReport, teamMarkdown, type TeamReport } from '../../core/src/team.js';
export const runArgsSchema = z.object({ gates: z.array(z.string().min(1)).min(1).optional() }).strict();
export const getRunArgsSchema = z.object({ runId: z.string().optional() }).strict();
export function summarize(run: RunResult) {
  return { ...run, gates: run.gates.map(g => g.decision === 'PASS' ? { ...g, outputTail: '' } : g) };
}
export async function readRun(outputDir: string, runId: string): Promise<RunResult> {
  if (!z.string().uuid().safeParse(runId).success) throw new Error('Invalid run ID');
  return runResultSchema.parse(JSON.parse(await readFile(join(outputDir, runId, 'report.json'), 'utf8')));
}
export async function getRun(configPath: string, runId?: string): Promise<RunResult> {
  const { config } = await loadConfig(configPath);
  if (runId) return readRun(config.outputDir, runId);
  const entries = await readdir(config.outputDir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  let newest: { id: string; time: number } | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory() || !z.string().uuid().safeParse(entry.name).success) continue;
    const record = await stat(join(config.outputDir, entry.name, 'report.json')).catch(error => {
      if (error.code === 'ENOENT') return undefined; throw error;
    });
    if (record?.isFile() && (!newest || record.mtimeMs > newest.time)) newest = { id: entry.name, time: record.mtimeMs };
  }
  if (!newest) throw new Error('No runs found');
  return readRun(config.outputDir, newest.id);
}
/**
 * The team view of a project: history, trends, the latest run's blocking gates and a Markdown summary of it.
 * Reads only; an unreadable history database is reported in `warnings` instead of failing the whole view.
 */
export async function teamView(configPath: string, limit = 50): Promise<TeamReport & { markdown: string }> {
  const { config } = await loadConfig(configPath);
  const warnings: string[] = [];
  const runs = await readRuns(config.outputDir, limit).catch(error => { warnings.push(`Run history is unreadable (${message(error)}); trends and comparisons are omitted`); return []; });
  const latest = await getRun(configPath).catch(error => { if (message(error) !== 'No runs found') throw error; return null; });
  const report = buildTeamReport({ runs, latest, configName: basename(configPath), warnings });
  return { ...report, markdown: teamMarkdown(report) };
}
/** The visual comparison of a run (the latest by default). A project without the visual-regression plugin gets an empty answer. */
export async function visualView(configPath: string, runId?: string): Promise<VisualView> {
  const { config } = await loadConfig(configPath);
  if (runId) return readVisual(config.outputDir, runId);
  const latest = await getRun(configPath).catch(error => { if (message(error) !== 'No runs found') throw error; return undefined; });
  return latest ? readVisual(config.outputDir, latest.runId) : { enabled: false, items: [] };
}
/** One image of a run's visual comparison, by item name; the run must be named so the image matches the list the client holds. */
export async function visualImage(configPath: string, runId: string, name: string, kind: string): Promise<Buffer> {
  return readVisualImage((await loadConfig(configPath)).config.outputDir, runId, name, kind);
}
/** One mutation at a time per service. Read tools remain available during execution. */
export class QualityGateService {
  private closed = false;
  private active?: { controller: AbortController; promise: Promise<RunResult> };
  constructor(readonly configPath: string) {}
  async list() {
    this.assertOpen();
    const { config } = await loadConfig(this.configPath);
    return { gates: config.gates.map(g => ({ id: g.id, type: g.type, run: g.run })), urls: config.urls, thresholds: config.thresholds,
      ...(config.reviewSources ? { reviewSources: config.reviewSources } : {}) };
  }
  async get(args: unknown = {}) { this.assertOpen(); return summarize(await getRun(this.configPath, getRunArgsSchema.parse(args).runId)); }
  async run(args: unknown = {}, signal?: AbortSignal): Promise<RunResult> {
    this.assertOpen();
    const { gates } = runArgsSchema.parse(args);
    return this.exclusive(signal, controller => execute(this.configPath, controller, gates));
  }
  /** Audits one URL with the configured Lighthouse thresholds. The scan is not recorded in the run history. */
  async scan(url: string, signal?: AbortSignal): Promise<RunResult> {
    this.assertOpen();
    return this.exclusive(signal, controller => execute(this.configPath, controller, undefined, { scanUrl: url }));
  }
  private async exclusive(signal: AbortSignal | undefined, start: (signal: AbortSignal) => Promise<RunResult>): Promise<RunResult> {
    signal?.throwIfAborted();
    if (this.active) throw new Error('A quality gate run is already active; retry after it completes');
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const promise = start(controller.signal);
    const active = { controller, promise };
    this.active = active;
    try { return summarize(await promise); }
    finally {
      signal?.removeEventListener('abort', abort);
      if (this.active === active) this.active = undefined;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    const active = this.active;
    active?.controller.abort(new Error('Client disconnected'));
    // Drain execution and evidence writes before the server process exits.
    await active?.promise.catch(() => undefined);
  }
  private assertOpen() { if (this.closed) throw new Error('QualityGate service is closed'); }
}
