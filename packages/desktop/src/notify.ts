import { DesktopBridgeError, type DesktopClient, type RunView } from './client.js';

export type RunKind = 'pass' | 'block' | 'error' | 'timeout' | 'interrupted';
export interface DesktopNotification { kind: Exclude<RunKind, 'interrupted'>; title: string; body: string; runId: string }

/**
 * Maps a stored run to a kind using the CLI exit-code contract: 0 PASS, 1 BLOCK, 2 error, 3 timeout, 130 interrupted.
 * A report whose decision and exit code disagree, or an unknown code, is shown as an error and never as a pass.
 */
export function classifyRun(run: RunView): RunKind {
  if (run.exitCode === 0) return run.decision === 'PASS' ? 'pass' : 'error';
  if (run.exitCode === 1) return run.decision === 'BLOCK' ? 'block' : 'error';
  if (run.exitCode === 3) return 'timeout';
  if (run.exitCode === 130) return 'interrupted';
  return 'error';
}

const safeId = (id: unknown) => (typeof id === 'string' ? id.replace(/[^\w.:-]/g, '').slice(0, 64) : '');

function blockedBody(run: RunView): string {
  const ids = (run.gates ?? []).filter(gate => gate.decision === 'BLOCK').map(gate => safeId(gate.id)).filter(Boolean);
  if (!ids.length) return 'The run was blocked.';
  const shown = ids.slice(0, 3).join(', ');
  return ids.length > 3 ? `Blocked by ${shown} and ${ids.length - 3} more.` : `Blocked by ${shown}.`;
}

/**
 * The notification for a finished run, or `undefined` when none is wanted (an interrupted run was cancelled by a person).
 * Text is built from the verdict and gate ids only: gate output, error messages and file paths never reach the OS.
 */
export function notificationFor(project: string, run: RunView): DesktopNotification | undefined {
  const kind = classifyRun(run);
  if (kind === 'interrupted') return undefined;
  const name = project.slice(0, 80);
  const text = {
    pass: { title: `${name}: PASS`, body: `${(run.gates ?? []).length} gate(s) checked, none blocked.` },
    block: { title: `${name}: BLOCK`, body: blockedBody(run) },
    error: { title: `${name}: run failed`, body: `The run did not complete (exit code ${Number.isInteger(run.exitCode) ? run.exitCode : 'unknown'}). Open the dashboard for details.` },
    timeout: { title: `${name}: run timed out`, body: 'The run exceeded its time limit. Open the dashboard for details.' },
  }[kind];
  return { kind, runId: run.runId, ...text };
}

export interface WatchEvents { onRun(run: RunView): void; onStop(reason: 'down' | 'unauthorized' | 'error', message: string): void }
export interface WatchOptions { intervalMs?: number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> }

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

const stopReasonOf = (error: unknown): 'down' | 'unauthorized' | 'error' =>
  (error instanceof DesktopBridgeError && (error.kind === 'down' || error.kind === 'unauthorized') ? error.kind : 'error');

/**
 * Polls the bridge for the newest run. The run that exists when watching starts is the baseline and is not announced;
 * every later run id is reported once. A lost or revoked connection ends the watch with a reason instead of retrying silently.
 */
export async function watchRuns(client: DesktopClient, events: WatchEvents, signal: AbortSignal, options: WatchOptions = {}): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  let seen: string | undefined;
  let baseline = true;
  while (!signal.aborted) {
    try {
      const run = await client.latestRun();
      if (!baseline && run && run.runId !== seen) events.onRun(run);
      seen = run?.runId ?? seen; baseline = false;
    } catch (error) {
      if (!signal.aborted) events.onStop(stopReasonOf(error), error instanceof Error ? error.message : String(error));
      return;
    }
    await sleep(options.intervalMs ?? 3000, signal);
  }
}
