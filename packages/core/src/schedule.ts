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
 * if one of them did not pass, it is reported as skipped instead. Results keep the order of `specs`.
 */
export async function scheduleGates(specs: GateSpec[], limit: number, execute: (spec: GateSpec, index: number) => Promise<GateResult>): Promise<GateResult[]> {
  const slots = semaphore(limit);
  const finished = new Map<string, Promise<GateResult>>();
  const start = (spec: GateSpec, index: number) => {
    const task = (async () => {
      const dependencies = await Promise.all((spec.dependsOn ?? []).filter(id => finished.has(id.toLowerCase())).map(id => finished.get(id.toLowerCase())!));
      const failed = dependencies.find(result => result.decision !== 'PASS' || result.execution !== 'completed');
      if (failed) return dependencySkipped(spec, failed.id);
      await slots.acquire();
      try { return await execute(spec, index); } finally { slots.release(); }
    })();
    finished.set(spec.id.toLowerCase(), task);
  };
  specs.forEach(start);
  return Promise.all(specs.map(spec => finished.get(spec.id.toLowerCase())!));
}
