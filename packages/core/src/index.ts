import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { auditDataSchema, configSchema, gateDataSchema, message, runResultSchema, type AuditResult, type Config, type GateResult, type RunResult } from '../../protocol/src/index.js';
import type { AuditPlugin, GatePlugin, Plugin, ReporterPlugin, StoragePlugin } from '../../plugin-sdk/src/index.js';
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
const OUTPUT_TAIL = 4000;
/** Runs the configured command gates, then URL audits; `only` limits gates by id and skips URL audits. */
export async function run(configInput: Config, plugins: {
  audit?: AuditPlugin; gate?: GatePlugin; storage: StoragePlugin; reporter: ReporterPlugin;
}, signal: AbortSignal = new AbortController().signal, only?: string[]): Promise<RunResult> {
  const config = configSchema.parse(configInput);
  const registry = new Registry();
  for (const plugin of Object.values(plugins)) if (plugin) registry.register(plugin);
  const gateSpecs = only ? config.gates.filter(g => only.includes(g.id)) : config.gates;
  if (only) {
    const unknown = only.filter(id => !config.gates.some(g => g.id === id));
    if (unknown.length) throw new Error(`Unknown gate: ${unknown.join(', ')}`);
  }
  const urls = only ? [] : config.urls;
  const audit = urls.length ? registry.get(plugins.audit?.id ?? 'audit', 'audit') : undefined;
  const gate = gateSpecs.length ? registry.get(plugins.gate?.id ?? 'gate', 'gate') : undefined;
  const storage = registry.get(plugins.storage.id, 'storage');
  const reporter = registry.get(plugins.reporter.id, 'reporter');
  const result: RunResult = {
    schemaVersion: 1, runId: randomUUID(), startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(), execution: 'completed', decision: 'PASS',
    thresholds: config.thresholds, results: [], gates: [], errors: [],
  };
  let directory: string | undefined;
  try { directory = await storage.createRun(result.runId); }
  catch (error) { result.errors.push(`Storage initialization: ${message(error)}`); }
  for (const [index, spec] of gateSpecs.entries()) {
    const item: GateResult = { id: spec.id, command: spec.run, execution: 'completed', decision: 'BLOCK',
      exitCode: null, durationMs: 0, outputTail: '', errors: [] };
    const cleanups: (() => void | Promise<void>)[] = [];
    const started = Date.now();
    if (signal.aborted) {
      item.execution = 'skipped'; item.errors.push('Interrupted before gate');
    } else {
      try {
        const data = gateDataSchema.parse(await gate!.run(spec, { signal, defer: fn => cleanups.push(fn) }));
        item.exitCode = data.exitCode; item.outputTail = data.output.slice(-OUTPUT_TAIL);
        item.decision = data.exitCode === 0 ? 'PASS' : 'BLOCK';
        if (directory) item.evidencePath = await storage.write(directory, `gate-${index + 1}-${spec.id}.log`, data.output);
      } catch (error) {
        item.execution = signal.aborted ? 'interrupted' : 'error';
        item.decision = 'BLOCK'; item.errors.push(message(error));
      } finally {
        for (const cleanup of cleanups.reverse()) {
          try { await cleanup(); }
          catch (error) { item.execution = 'error'; item.errors.push(`Cleanup: ${message(error)}`); }
        }
      }
    }
    item.durationMs = Date.now() - started;
    result.gates.push(item);
  }
  for (const [index, url] of urls.entries()) {
    const item: AuditResult = { url, execution: 'completed', scores: {}, decision: 'BLOCK', violations: [], errors: [] };
    const cleanups: (() => void | Promise<void>)[] = [];
    if (signal.aborted) {
      item.execution = 'skipped'; item.errors.push('Interrupted before audit');
    } else {
      try {
        const data = auditDataSchema.parse(await audit!.audit(url, { signal, defer: fn => cleanups.push(fn) }));
        item.scores = data.scores;
        if (data.error) { item.execution = 'error'; item.errors.push(data.error); }
        if (directory && data.raw !== undefined) {
          item.evidencePath = await storage.write(directory, `${index + 1}-audit.json`, JSON.stringify(data.raw, null, 2));
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
    Object.assign(item, evaluate(item.scores, config.thresholds!));
    result.results.push(item);
  }
  result.execution = signal.aborted ? 'interrupted' : result.errors.length || [...result.results, ...result.gates].some(r => r.execution !== 'completed') ? 'error' : 'completed';
  result.decision = [...result.results, ...result.gates].some(r => r.decision === 'BLOCK') ? 'BLOCK' : 'PASS';
  result.finishedAt = new Date().toISOString();
  if (directory) {
    result.reportPath = join(directory, 'report.json');
    try {
      await storage.write(directory, 'report.json', reporter.render(runResultSchema.parse(result)));
      // A signal can arrive while the filesystem write is in flight.
      if (signal.aborted && result.execution !== 'interrupted') {
        result.execution = 'interrupted';
        await storage.write(directory, 'report.json', reporter.render(runResultSchema.parse(result)));
      }
    }
    catch (error) {
      delete result.reportPath;
      result.errors.push(`Report write: ${message(error)}`);
      result.execution = signal.aborted ? 'interrupted' : 'error';
    }
  }
  return runResultSchema.parse(result);
}
