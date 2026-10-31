import { randomUUID } from 'node:crypto';
import { configSchema, message, runResultSchema, type Config, type RunResult } from '../../protocol/src/index.js';
import type { AuditPlugin, GatePlugin, Plugin, ReporterPlugin, StoragePlugin } from '../../plugin-sdk/src/index.js';
import { executeGate, executeAudit, executionStatus, saveReport } from './execution.js';
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
export interface RunPlugins {
  audit?: AuditPlugin; gate?: GatePlugin; storage: StoragePlugin; reporter: ReporterPlugin;
}
function selectPlugins(config: Config, plugins: RunPlugins, only?: string[]) {
  const registry = new Registry();
  for (const plugin of Object.values(plugins)) if (plugin) registry.register(plugin);
  const gateSpecs = only ? config.gates.filter(g => only.includes(g.id)) : config.gates;
  const unknown = only?.filter(id => !config.gates.some(g => g.id === id));
  if (unknown?.length) throw new Error(`Unknown gate: ${unknown.join(', ')}`);
  const urls = only ? [] : config.urls;
  return { gateSpecs, urls,
    audit: urls.length ? registry.get(plugins.audit?.id ?? 'audit', 'audit') : undefined,
    gate: gateSpecs.length ? registry.get(plugins.gate?.id ?? 'gate', 'gate') : undefined,
    storage: registry.get(plugins.storage.id, 'storage'), reporter: registry.get(plugins.reporter.id, 'reporter') };
}
/** Runs configured gates then audits; selection by gate ID skips URL audits. */
export async function run(configInput: Config, plugins: RunPlugins,
  signal: AbortSignal = new AbortController().signal, only?: string[]): Promise<RunResult> {
  const config = configSchema.parse(configInput);
  const selected = selectPlugins(config, plugins, only);
  const result: RunResult = {
    schemaVersion: 1, runId: randomUUID(), startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(), execution: 'completed', decision: 'PASS',
    thresholds: config.thresholds, results: [], gates: [], errors: [], findings: [],
  };
  let directory: string | undefined;
  try { directory = await selected.storage.createRun(result.runId); }
  catch (error) { result.errors.push(`Storage initialization: ${message(error)}`); }
  const environment = { signal, storage: selected.storage, directory };
  for (const [index, spec] of selected.gateSpecs.entries()) {
    const item = await executeGate(spec, index, environment, selected.gate!);
    result.gates.push(item); result.findings.push(...item.findings);
  }
  for (const [index, url] of selected.urls.entries()) {
    const item = await executeAudit(url, index, environment, selected.audit!);
    Object.assign(item, evaluate(item.scores, config.thresholds!)); result.results.push(item);
  }
  result.execution = executionStatus(result, signal);
  result.decision = [...result.results, ...result.gates].some(r => r.decision === 'BLOCK') ? 'BLOCK' : 'PASS';
  result.finishedAt = new Date().toISOString();
  await saveReport(result, environment, selected.reporter);
  return runResultSchema.parse(result);
}
