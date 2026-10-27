import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { auditDataSchema, configSchema, message, runResultSchema, type AuditResult, type Config, type RunResult } from '../../protocol/src/index.js';
import type { AuditPlugin, Plugin, ReporterPlugin, StoragePlugin } from '../../plugin-sdk/src/index.js';
import { evaluate } from '../../policy/src/index.js';
export class Registry {
  private plugins = new Map<string, Plugin>();
  register(plugin: Plugin): void {
    if (plugin.apiVersion !== 1) throw new Error(`Incompatible plugin API: ${plugin.id}`);
    if (!plugin.id || this.plugins.has(plugin.id)) throw new Error(`Duplicate or empty plugin ID: ${plugin.id}`);
    this.plugins.set(plugin.id, plugin);
  }
  get<K extends Plugin['kind']>(id: string, kind: K): Extract<Plugin, {kind: K}> {
    const plugin = this.plugins.get(id);
    if (!plugin || plugin.kind !== kind) throw new Error(`Missing ${kind} plugin: ${id}`);
    return plugin as Extract<Plugin, {kind: K}>;
  }
}
export async function run(configInput: Config, plugins: {
  audit: AuditPlugin; storage: StoragePlugin; reporter: ReporterPlugin;
}, signal: AbortSignal = new AbortController().signal): Promise<RunResult> {
  const config = configSchema.parse(configInput);
  const registry = new Registry();
  for (const plugin of Object.values(plugins)) registry.register(plugin);
  const audit = registry.get(plugins.audit.id, 'audit');
  const storage = registry.get(plugins.storage.id, 'storage');
  const reporter = registry.get(plugins.reporter.id, 'reporter');
  const result: RunResult = {
    schemaVersion: 1, runId: randomUUID(), startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(), execution: 'completed', decision: 'PASS',
    thresholds: config.thresholds, results: [], errors: [],
  };
  let directory: string | undefined;
  try { directory = await storage.createRun(result.runId); }
  catch (error) { result.errors.push(`Storage initialization: ${message(error)}`); }
  for (const [index, url] of config.urls.entries()) {
    const item: AuditResult = { url, execution: 'completed', scores: {}, decision: 'BLOCK', violations: [], errors: [] };
    const cleanups: (() => void | Promise<void>)[] = [];
    if (signal.aborted) {
      item.execution = 'skipped'; item.errors.push('Interrupted before audit');
    } else {
      try {
        const data = auditDataSchema.parse(await audit.audit(url, { signal, defer: fn => cleanups.push(fn) }));
        item.scores = data.scores;
        if (directory && data.raw !== undefined) {
          item.evidencePath = await storage.write(directory, `${index + 1}-lighthouse.json`, JSON.stringify(data.raw, null, 2));
        }
      } catch (error) {
        item.execution = signal.aborted ? 'interrupted' : 'error';
        item.errors.push(message(error));
      } finally {
        for (const cleanup of cleanups.reverse()) {
          try { await cleanup(); }
          catch (error) { item.execution = 'error'; item.errors.push(`Cleanup: ${message(error)}`); }
        }
      }
    }
    Object.assign(item, evaluate(item.scores, config.thresholds));
    result.results.push(item);
  }
  result.execution = signal.aborted ? 'interrupted' : result.errors.length || result.results.some(r => r.execution !== 'completed') ? 'error' : 'completed';
  result.decision = result.results.some(r => r.decision === 'BLOCK') ? 'BLOCK' : 'PASS';
  result.finishedAt = new Date().toISOString();
  if (directory) {
    result.reportPath = join(directory, 'report.json');
    try { await storage.write(directory, 'report.json', reporter.render(runResultSchema.parse(result))); }
    catch (error) {
      delete result.reportPath;
      result.errors.push(`Report write: ${message(error)}`);
      if (result.execution !== 'interrupted') result.execution = 'error';
    }
  }
  return runResultSchema.parse(result);
}
