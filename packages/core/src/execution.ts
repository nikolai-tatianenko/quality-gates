import { join } from 'node:path';
import { auditDataSchema, gateDataSchema, message, runResultSchema,
  type AuditResult, type GateResult, type GateSpec, type RunResult } from '../../protocol/src/index.js';
import type { AuditPlugin, Context, GatePlugin, ReporterPlugin, StoragePlugin } from '../../plugin-sdk/src/index.js';
interface Environment { signal: AbortSignal; storage: StoragePlugin; directory?: string }
type Item = GateResult | AuditResult;
/** Cleanup errors remain visible and do not prevent other cleanup handlers running. */
async function lifecycle(item: Item, signal: AbortSignal, execute: (context: Context) => Promise<void>) {
  if (signal.aborted) {
    item.execution = 'skipped'; item.errors.push('Interrupted before check'); return;
  }
  const cleanups: (() => void | Promise<void>)[] = [];
  try { await execute({ signal, defer: fn => cleanups.push(fn) }); }
  catch (error) {
    item.execution = signal.aborted ? 'interrupted' : 'error'; item.errors.push(message(error));
    item.decision = 'BLOCK';
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); }
      catch (error) { item.execution = 'error'; item.errors.push(`Cleanup: ${message(error)}`); }
    }
  }
}
export async function executeGate(spec: GateSpec, index: number, env: Environment, plugin: GatePlugin): Promise<GateResult> {
  const item: GateResult = { id: spec.id, command: spec.run, execution: 'completed', decision: 'BLOCK',
    exitCode: null, durationMs: 0, outputTail: '', errors: [], findings: [], artifacts: [] };
  const started = Date.now();
  await lifecycle(item, env.signal, async context => {
    const data = gateDataSchema.parse(await plugin.run(spec, context));
    item.exitCode = data.exitCode; item.outputTail = data.output.slice(-4000);
    item.findings = data.findings.map(finding => ({ ...finding, gateId: spec.id }));
    item.decision = data.exitCode === 0 ? 'PASS' : 'BLOCK';
    if (data.error) {
      item.execution = env.signal.aborted ? 'interrupted' : 'error';
      item.decision = 'BLOCK'; item.errors.push(data.error);
    }
    if (env.directory) {
      item.evidencePath = await env.storage.write(env.directory, `gate-${index + 1}-${spec.id}.log`, data.output);
      if (data.rawReport !== undefined) item.reportPath = await env.storage.write(env.directory, `gate-${index + 1}-${spec.id}.json`, data.rawReport);
    }
    item.findings = item.findings.map(finding => ({ ...finding, evidencePath: item.reportPath ?? item.evidencePath }));
  });
  item.durationMs = Date.now() - started;
  return item;
}
export async function executeAudit(url: string, index: number, env: Environment, plugin: AuditPlugin): Promise<AuditResult> {
  const item: AuditResult = { url, execution: 'completed', scores: {}, decision: 'BLOCK', violations: [], errors: [] };
  await lifecycle(item, env.signal, async context => {
    const data = auditDataSchema.parse(await plugin.audit(url, context));
    item.scores = data.scores;
    if (data.error) { item.execution = 'error'; item.errors.push(data.error); }
    if (env.directory && data.raw !== undefined) item.evidencePath = await env.storage.write(env.directory, `${index + 1}-audit.json`, JSON.stringify(data.raw, null, 2));
  });
  return item;
}
export function executionStatus(result: RunResult, signal: AbortSignal): RunResult['execution'] {
  if (signal.aborted) return 'interrupted';
  return result.errors.length || [...result.results, ...result.gates].some(r => r.execution !== 'completed') ? 'error' : 'completed';
}
export async function saveReport(result: RunResult, env: Environment, reporter: ReporterPlugin) {
  if (!env.directory) return;
  result.reportPath = join(env.directory, 'report.json');
  try {
    await env.storage.write(env.directory, 'report.json', reporter.render(runResultSchema.parse(result)));
    if (env.signal.aborted && result.execution !== 'interrupted') {
      result.execution = 'interrupted';
      await env.storage.write(env.directory, 'report.json', reporter.render(runResultSchema.parse(result)));
    }
  } catch (error) {
    delete result.reportPath; result.errors.push(`Report write: ${message(error)}`);
    result.execution = env.signal.aborted ? 'interrupted' : 'error';
  }
}
