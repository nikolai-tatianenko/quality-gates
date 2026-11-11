import { basename, join } from 'node:path';
import { auditDataSchema, gateDataSchema, message, runResultSchema, stepStatus, tidyMessage,
  type AuditResult, type GateResult, type GateSpec, type RunResult, type Step } from '../../protocol/src/index.js';
import type { AuditPlugin, Context, GatePlugin, ReporterPlugin, StoragePlugin } from '../../plugin-sdk/src/index.js';
interface Environment { signal: AbortSignal; storage: StoragePlugin; directory?: string; log?: (line: string) => void }
type Item = GateResult | AuditResult;
/** Cleanup errors remain visible and do not prevent other cleanup handlers running. */
async function lifecycle(item: Item, signal: AbortSignal, execute: (context: Context) => Promise<void>, log?: (line: string) => void) {
  if (signal.aborted) {
    item.execution = 'skipped'; item.errors.push('Interrupted before check'); return;
  }
  const cleanups: (() => void | Promise<void>)[] = [];
  try { await execute({ signal, defer: fn => cleanups.push(fn), log }); }
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
/** Copies the plugin's answer onto the result; a timeout keeps its own status instead of becoming a generic error. */
function applyGateData(item: GateResult, data: ReturnType<typeof gateDataSchema.parse>, signal: AbortSignal) {
  item.exitCode = data.exitCode; item.outputTail = data.output.slice(-4000); item.counts = data.counts;
  item.findings = data.findings.map(finding => ({ ...finding, gateId: item.id, message: tidyMessage(finding.message) }));
  item.decision = data.exitCode === 0 ? 'PASS' : 'BLOCK';
  if (!data.error) return;
  item.execution = signal.aborted ? 'interrupted' : data.timedOut ? 'timeout' : 'error';
  item.decision = 'BLOCK'; item.errors.push(data.error);
}
export async function executeGate(spec: GateSpec, index: number, env: Environment, plugin: GatePlugin): Promise<GateResult> {
  const item: GateResult = { id: spec.id, command: spec.run, execution: 'completed', decision: 'BLOCK',
    exitCode: null, durationMs: 0, outputTail: '', errors: [], findings: [], artifacts: [] };
  const started = Date.now();
  await lifecycle(item, env.signal, async context => {
    const data = gateDataSchema.parse(await plugin.run(spec, context));
    applyGateData(item, data, env.signal);
    if (env.directory) {
      item.evidencePath = await env.storage.write(env.directory, `gate-${index + 1}-${spec.id}.log`, data.output);
      if (data.artifacts.length && !env.storage.copy) item.errors.push(`${data.artifacts.length} artifact(s) not stored: the storage plugin cannot copy files`);
      for (const [k, source] of data.artifacts.entries()) {
        if (!env.storage.copy) break;
        item.artifacts.push(await env.storage.copy(env.directory, `gate-${index + 1}-${spec.id}-artifact-${k + 1}-${basename(source)}`, source));
      }
      if (data.rawReport !== undefined) item.reportPath = await env.storage.write(env.directory, `gate-${index + 1}-${spec.id}.json`, data.rawReport);
    }
    item.findings = item.findings.map(finding => ({ ...finding, evidencePath: item.reportPath ?? item.evidencePath }));
  }, env.log);
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
/** Interrupted beats error, error beats timeout: a timeout alone is reported (and exits) as its own status. */
export function executionStatus(result: RunResult, signal: AbortSignal): RunResult['execution'] {
  if (signal.aborted) return 'interrupted';
  const items = [...result.results, ...result.gates];
  if (result.errors.length || items.some(item => item.execution !== 'completed' && item.execution !== 'timeout')) return 'error';
  return items.some(item => item.execution === 'timeout') ? 'timeout' : 'completed';
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
/** Every configured gate and URL with its outcome; steps that were not selected or never started are `not-run`. */
export function buildSteps(config: { gates: { id: string }[]; urls: string[] }, result: RunResult): Step[] {
  const gates = new Map(result.gates.map(gate => [gate.id, gate]));
  const audits = new Map(result.results.map(audit => [audit.url, audit]));
  return [
    ...config.gates.map((gate): Step => ({ id: gate.id, kind: 'gate', status: gates.has(gate.id) ? stepStatus(gates.get(gate.id)!) : 'not-run' })),
    ...config.urls.map((url): Step => ({ id: url, kind: 'url', status: audits.has(url) ? stepStatus(audits.get(url)!) : 'not-run' })),
  ];
}
