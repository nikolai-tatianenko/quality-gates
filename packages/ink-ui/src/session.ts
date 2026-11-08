import { message, type FixResult, type RunResult } from '../../protocol/src/index.js';
import type { ProgressEvent } from '../../core/src/index.js';
import type { Trends } from '../../core/src/history.js';
import type { FixEvent } from '../../cli/src/fix.js';
import { applyFixStart, applyProgress, exitCodeOf, handleKey, initialState, jobFailed, runFinished, runStarted, type GateInfo, type KeyInput, type State } from './model.js';

/** What the screen needs from the project; the real one calls the same runner as `qualitygate run` and `qualitygate fix`. */
export interface Controller {
  gates: GateInfo[];
  root: string;
  last(): Promise<RunResult | undefined>;
  run(ids: string[] | undefined, signal: AbortSignal, onProgress: (event: ProgressEvent) => void): Promise<RunResult>;
  fix(ids: string[], signal: AbortSignal, onProgress: (event: ProgressEvent) => void, onFix: (event: FixEvent) => void): Promise<FixResult>;
  trends(): Promise<Trends | undefined>;
}

const describeFix = (result: FixResult) => {
  const lines = result.gates.map(gate => `${gate.id}: ${gate.before ?? 'not run before'} -> ${gate.after ?? 'not run'}${gate.fixError ? ` (${gate.fixError})` : ''}`);
  return `Fix done. ${lines.join('; ')}${result.warnings.length ? ` ${result.warnings.join(' ')}` : ''}`;
};

/**
 * The state and the jobs behind the screen, without any rendering: key presses go in, a state and an exit code come out.
 * One job (run or fix) at a time; Ctrl+C cancels it through its AbortSignal and ends the session with 130 once it has stopped.
 */
export class Session {
  state: State;
  /** Resolves with the exit code once the session has ended. */
  readonly finished: Promise<number>;
  private listeners = new Set<() => void>();
  private abort?: AbortController;
  private job?: Promise<void>;
  private end!: (code: number) => void;
  private ending?: number;
  constructor(private controller: Controller, private now: () => number = Date.now) {
    this.state = initialState(controller.gates);
    this.finished = new Promise(resolve => { this.end = resolve; });
  }
  /** Shows the last stored run, when there is one. */
  async load() {
    try { this.set(initialState(this.controller.gates, await this.controller.last())); } catch { /* an unreadable history only leaves the table empty */ }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getState = () => this.state;
  get root() { return this.controller.root; }
  private set(state: State) { this.state = state; for (const listener of this.listeners) listener(); }
  /** Cancels the running job and ends the session with `code` as soon as it has stopped (immediately when idle). */
  stop(code: number) {
    this.ending = code;
    if (!this.job) { this.end(code); return; }
    this.set({ ...this.state, cancelling: true });
    this.abort?.abort();
  }
  key(input: KeyInput) {
    if (this.ending !== undefined) return;
    const { state, command } = handleKey(this.state, input);
    this.set(state);
    if (!command) return;
    if (command.kind === 'quit') this.stop(this.state.busy ? 130 : exitCodeOf(this.state));
    else if (command.kind === 'cancel-and-quit') this.stop(command.code);
    else if (command.kind === 'trends') void this.loadTrends();
    else this.start(command.kind, command.ids);
  }
  private async loadTrends() {
    try { this.set({ ...this.state, trends: (await this.controller.trends()) ?? 'none' }); } catch (error) { this.set({ ...this.state, trends: 'none', notice: `Trends unavailable: ${message(error)}` }); }
  }
  private start(kind: 'run' | 'fix', ids: string[] | undefined) {
    this.abort = new AbortController();
    const { signal } = this.abort;
    this.set(runStarted(this.state, kind));
    const onProgress = (event: ProgressEvent) => this.set(applyProgress(this.state, event, this.now()));
    this.job = (async () => {
      try {
        if (kind === 'run') {
          const run = await this.controller.run(ids, signal, onProgress);
          this.set(runFinished(this.state, run, signal.aborted ? 'Run cancelled.' : ''));
        } else {
          const result = await this.controller.fix(ids!, signal, onProgress, event => { if (event.kind === 'fix-start') this.set(applyFixStart(this.state, event.id, this.now())); });
          this.set(runFinished(this.state, result.run, describeFix(result), result));
        }
      } catch (error) { this.set(jobFailed(this.state, signal.aborted ? 'Cancelled.' : message(error))); }
    })().finally(() => {
      this.job = undefined; this.abort = undefined;
      if (this.ending !== undefined) this.end(this.ending);
    });
  }
}
