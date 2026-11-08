import type { BridgeClient } from './client.js';
import type { FindingSummary, Job, RunSummary } from './types.js';

/** How a scan ended. `done` carries the bridge's own run summary; the verdict is never recomputed here. */
export type ScanOutcome =
  | { kind: 'done'; job: Job; run: RunSummary; findings: FindingSummary[]; artifacts: string[] }
  | { kind: 'cancelled'; job: Job }
  | { kind: 'failed'; job: Job };

export interface WatchOptions { signal?: AbortSignal; intervalMs?: number; sleep?: (ms: number) => Promise<void>; onJob?: (job: Job) => void }
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const active = (job: Job) => job.status === 'running' || job.status === 'cancelling';

/**
 * Follows a job until the bridge says it ended. When `signal` aborts, the job is cancelled on the bridge and the loop
 * keeps polling until the bridge confirms. Leaving the popup does not abort: the job continues on the bridge and
 * can be picked up again by its id.
 */
export async function watchJob(client: BridgeClient, first: Job, options: WatchOptions = {}): Promise<ScanOutcome> {
  const sleep = options.sleep ?? wait;
  let job = first, cancelSent = false;
  options.onJob?.(job);
  while (active(job)) {
    await sleep(options.intervalMs ?? 1000);
    if (options.signal?.aborted && !cancelSent) { cancelSent = true; job = await client.cancel(job.jobId).catch(() => job); }
    else job = await client.job(job.jobId);
    options.onJob?.(job);
  }
  if (job.status === 'cancelled') return { kind: 'cancelled', job };
  if (job.status === 'error' || !job.runId) return { kind: 'failed', job };
  const [run, findings, artifacts] = await Promise.all([client.run(job.runId), client.findings(job.runId), client.artifacts(job.runId)]);
  return { kind: 'done', job, run, findings, artifacts: artifacts.map(a => a.name) };
}

/** Submits the URL to the bridge's configured Lighthouse scan and follows it. */
export async function scanPage(client: BridgeClient, url: string, options: WatchOptions = {}): Promise<ScanOutcome> {
  return watchJob(client, await client.startScan(url), options);
}
