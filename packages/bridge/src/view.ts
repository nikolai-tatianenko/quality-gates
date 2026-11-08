import { basename } from 'node:path';
import { exitCode, type Finding, type RunResult } from '../../protocol/src/index.js';

/**
 * What a bridge client may see of a run. Gate logs (`outputTail`, `*.log`), raw gate reports and absolute paths are left
 * out on purpose: a secret scanner's output must never travel to a browser or webview. The verdict fields are copied
 * unchanged from the stored report, and `exitCode` is the CLI's own exit code for the same run.
 */
export function publicRun(run: RunResult) {
  return {
    runId: run.runId, startedAt: run.startedAt, finishedAt: run.finishedAt, execution: run.execution, decision: run.decision, exitCode: exitCode(run),
    thresholds: run.thresholds, errors: run.errors, steps: run.steps,
    results: run.results.map(r => ({ url: r.url, execution: r.execution, decision: r.decision, scores: r.scores, violations: r.violations, errors: r.errors })),
    gates: run.gates.map(g => ({ id: g.id, execution: g.execution, decision: g.decision, exitCode: g.exitCode, durationMs: g.durationMs, errors: g.errors,
      findings: g.findings.length, artifacts: g.artifacts.map(file => basename(file)), ...(g.skipped ? { skipped: g.skipped } : {}), ...(g.cached ? { cached: true } : {}), ...(g.counts ? { counts: g.counts } : {}) })),
  };
}

export function publicFinding(finding: Finding) {
  const { evidencePath, ...rest } = finding;
  return { ...rest, ...(evidencePath ? { evidence: basename(evidencePath) } : {}) };
}

/** Every file a client may download for a run: gate artifacts and the Lighthouse report of each audited URL. */
export function listArtifacts(run: RunResult): { kind: 'gate' | 'audit'; source: string; name: string }[] {
  return [...run.gates.flatMap(g => g.artifacts.map(file => ({ kind: 'gate' as const, source: g.id, name: basename(file) }))),
    ...run.results.filter(r => r.evidencePath).map(r => ({ kind: 'audit' as const, source: r.url, name: basename(r.evidencePath!) }))];
}
