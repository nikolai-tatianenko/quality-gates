import type { GateResult, GateSpec } from '../../protocol/src/index.js';

/** A gate that was not executed because a gate it depends on did not pass. */
export function dependencySkipped(spec: GateSpec, dependency: string): GateResult {
  return { id: spec.id, command: spec.run, execution: 'completed', decision: 'BLOCK', exitCode: null, durationMs: 0, outputTail: '',
    errors: [], findings: [], artifacts: [], skipped: `dependency ${dependency} did not pass` };
}

/** A gate that passed without running because its inputs are unchanged since a passing run. */
export function cachedGate(spec: GateSpec, note: string): GateResult {
  return { id: spec.id, command: spec.run, execution: 'completed', decision: 'PASS', exitCode: 0, durationMs: 0, outputTail: note,
    errors: [], findings: [], artifacts: [], cached: true };
}

/** Counting semaphore: at most `limit` tasks hold a slot at once. */
function semaphore(limit: number) {
  let free = limit;
  const waiting: (() => void)[] = [];
  return {
    async acquire() { if (free > 0) { free--; return; } await new Promise<void>(resolve => waiting.push(resolve)); },
    release() { const next = waiting.shift(); if (next) next(); else free++; },
  };
}

/**
 * Runs gates with at most `limit` in parallel. A gate starts once the selected gates it `dependsOn` have finished;
 * if one of them did not pass, it is reported as skipped instead. Results keep the order of `specs`, and the listing
 * order does not matter: a gate's dependencies are looked up among all selected gates, not only those started so far.
 * Dependencies must be acyclic (the config schema rejects cycles).
 */
export async function scheduleGates(specs: GateSpec[], limit: number, execute: (spec: GateSpec, index: number) => Promise<GateResult>,
  onSkipped?: (result: GateResult) => void): Promise<GateResult[]> {
  const slots = semaphore(limit);
  const selected = new Map(specs.map((spec, index) => [spec.id.toLowerCase(), { spec, index }]));
  const finished = new Map<string, Promise<GateResult>>();
  const finish = (id: string): Promise<GateResult> => {
    if (!finished.has(id)) finished.set(id, (async () => {
      const { spec, index } = selected.get(id)!;
      const dependencies = await Promise.all((spec.dependsOn ?? []).map(name => name.toLowerCase()).filter(name => selected.has(name)).map(finish));
      const failed = dependencies.find(result => result.decision !== 'PASS' || result.execution !== 'completed');
      if (failed) { const skipped = dependencySkipped(spec, failed.id); onSkipped?.(skipped); return skipped; }
      await slots.acquire();
      try { return await execute(spec, index); } finally { slots.release(); }
    })());
    return finished.get(id)!;
  };
  return Promise.all(specs.map(spec => finish(spec.id.toLowerCase())));
}
