import { randomUUID } from 'node:crypto';
import { exitCode, message, type RunResult } from '../../protocol/src/index.js';
import { HttpError } from './http.js';

export type JobStatus = 'running' | 'cancelling' | 'finished' | 'cancelled' | 'error';
interface Outcome { status: 'finished' | 'cancelled' | 'error'; runId?: string; execution?: RunResult['execution']; decision?: RunResult['decision']; exitCode: number; error?: string }
interface Job { id: string; kind: 'run' | 'scan'; target: string[] | string; startedAt: string; finishedAt?: string; controller: AbortController; cancelRequested: boolean; outcome?: Outcome; done: Promise<void> }
const MAX_JOBS = 50;

/**
 * Runs one job at a time and remembers the most recent ones. The verdict and exit code of a finished job are
 * those of the run itself; the bridge adds nothing to them and cannot change them.
 */
export class Jobs {
  private jobs = new Map<string, Job>();
  private active?: Job;
  constructor(private onError?: (error: unknown) => void) {}

  view(job: Job) {
    const status: JobStatus = job.cancelRequested ? 'cancelling' : 'running';
    return { jobId: job.id, kind: job.kind, ...(job.kind === 'run' ? { gates: job.target } : { url: job.target }), status, startedAt: job.startedAt,
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}), ...job.outcome };
  }
  start(kind: Job['kind'], target: Job['target'], work: (signal: AbortSignal) => Promise<RunResult>): Job {
    if (this.active) throw new HttpError(409, 'A run is already active');
    const controller = new AbortController();
    const job: Job = { id: randomUUID(), kind, target, startedAt: new Date().toISOString(), controller, cancelRequested: false, done: Promise.resolve() };
    job.done = work(controller.signal).then(result => { job.outcome = this.finished(result); }, error => { job.outcome = this.failed(job, error); })
      .finally(() => { job.finishedAt = new Date().toISOString(); if (this.active === job) this.active = undefined; });
    this.active = job; this.jobs.set(job.id, job);
    for (const [id, old] of this.jobs) { if (this.jobs.size <= MAX_JOBS) break; if (old.outcome) this.jobs.delete(id); }
    return job;
  }
  private finished(result: RunResult): Outcome {
    return { status: result.execution === 'interrupted' ? 'cancelled' : 'finished', runId: result.runId, execution: result.execution, decision: result.decision, exitCode: exitCode(result) };
  }
  private failed(job: Job, error: unknown): Outcome {
    if (job.cancelRequested) return { status: 'cancelled', exitCode: 130 };
    this.onError?.(error);
    return { status: 'error', exitCode: 2, error: message(error) };
  }
  find(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new HttpError(404, 'Unknown job');
    return job;
  }
  cancel(id: string) {
    const job = this.find(id);
    if (job.outcome) throw new HttpError(409, 'The job already finished');
    job.cancelRequested = true; job.controller.abort(new Error('Cancelled by client'));
    return this.view(job);
  }
  /** Aborts the active job and waits until it has stopped and written its evidence. */
  async close() {
    this.active?.controller.abort(new Error('Bridge closed'));
    await this.active?.done;
  }
}
