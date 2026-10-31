import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { GatePlugin } from '../../../plugin-sdk/src/index.js';
import { message, type Finding } from '../../../protocol/src/index.js';
import { captureCommand } from '../../command/src/index.js';
const taskSchema = z.object({ task: z.object({ id: z.string(), status: z.enum(['PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED', 'CANCELED']), analysisId: z.string().optional() }) });
const statusSchema = z.object({ projectStatus: z.object({ status: z.enum(['OK', 'ERROR', 'NONE']), conditions: z.array(z.object({
  status: z.enum(['OK', 'ERROR', 'NO_VALUE']), metricKey: z.string(), comparator: z.string(), errorThreshold: z.string(), actualValue: z.string().optional(),
})) }) });
async function request(base: string, path: string, token: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${base}/${path}`, { signal, redirect: 'error', headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`SonarQube returned HTTP ${response.status}`); }
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body!.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 1_000_000) { await reader.cancel(); throw new Error('SonarQube response exceeds 1 MB'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** Runs a project-selected scanner, then reads the quality gate for that exact CE task. */
export function sonarQubePlugin(cwd: string): GatePlugin {
  return { id: 'sonarqube', apiVersion: 1, kind: 'gate', async run(spec, context) {
    const settings = spec.sonar!;
    const token = process.env[settings.tokenEnv];
    if (!token) throw new Error(`Missing SonarQube token environment variable: ${settings.tokenEnv}`);
    const base = settings.serverUrl.replace(/\/+$/, '');
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(spec.timeoutMs ?? 300000)]);
    const taskPath = resolve(cwd, settings.taskFile);
    await rm(taskPath, { force: true });
    const captured = await captureCommand(cwd, spec, { ...context, signal });
    const redact = (value: string) => value.replaceAll(token, '[REDACTED]');
    const evidence: Record<string, unknown> = { serverUrl: base };
    let findings: Finding[] = []; let exitCode = captured.exitCode; let error = captured.error;
    try {
      if (error || exitCode !== 0) throw new Error(error ?? `Sonar scanner exited ${exitCode}`);
      const metadata = await readFile(taskPath, 'utf8');
      if (Buffer.byteLength(metadata) > 65536) throw new Error('Sonar scanner metadata exceeds 64 KB');
      const fields = Object.fromEntries(metadata.trim().split(/\r?\n/).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
      if (fields.serverUrl?.replace(/\/+$/, '') !== base || !fields.ceTaskId) throw new Error('Sonar scanner metadata has a missing task ID or different server URL');
      evidence.ceTaskId = fields.ceTaskId;
      const task = await waitForTask(base, fields.ceTaskId, token, signal);
      evidence.analysisId = task.analysisId;
      const report = statusSchema.parse(await request(base, `api/qualitygates/project_status?analysisId=${encodeURIComponent(task.analysisId!)}`, token, signal));
      evidence.report = report;
      const status = report.projectStatus;
      if (status.status === 'NONE') throw new Error('SonarQube has no quality gate for this analysis');
      findings = status.conditions.filter(condition => condition.status !== 'OK').map(condition => ({ gateId: spec.id, severity: 'error',
        ruleId: `sonarqube/${condition.metricKey}`, message: `${condition.metricKey}: ${condition.actualValue ?? 'missing'} (${condition.comparator} ${condition.errorThreshold}), ${condition.status}` }));
      exitCode = status.status === 'OK' && findings.length === 0 ? 0 : 1;
    } catch (cause) { error = redact(message(cause)); }
    return { exitCode, findings, output: redact(captured.output), rawReport: redact(JSON.stringify(evidence, null, 2)), error };
  } };
}
async function waitForTask(base: string, id: string, token: string, signal: AbortSignal) {
  for (;;) {
    const { task } = taskSchema.parse(await request(base, `api/ce/task?id=${encodeURIComponent(id)}`, token, signal));
    if (task.id !== id) throw new Error('SonarQube returned a different task ID');
    if (task.status === 'SUCCESS') {
      if (!task.analysisId) throw new Error('SonarQube completed without an analysis ID');
      return task;
    }
    if (task.status === 'FAILED' || task.status === 'CANCELED') throw new Error(`SonarQube task ${task.status}`);
    await delay(250, undefined, { signal });
  }
}
