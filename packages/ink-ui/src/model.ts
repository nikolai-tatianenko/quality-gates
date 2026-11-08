import { exitCode, type FixResult, type GateResult, type RunResult } from '../../protocol/src/index.js';
import type { ProgressEvent } from '../../core/src/index.js';
import type { Trends } from '../../core/src/history.js';
import { plainLine } from '../../cli/src/live.js';

/** One gate as the screen knows it before any run. `withheld` gates have a report parser that can expose secrets. */
export interface GateInfo { id: string; command: string; fixable: boolean; withheld: boolean }
export type RowState = 'idle' | 'waiting' | 'running' | 'fixing' | 'PASS' | 'BLOCK' | 'error' | 'timeout' | 'interrupted' | 'skipped';
export interface Row extends GateInfo { state: RowState; startedAt?: number; line: string; result?: GateResult }
export type Panel = 'list' | 'details' | 'trends';
export interface State {
  rows: Row[];
  /** Index of the row under the cursor; `undefined` until the first arrow key. */
  selected?: number;
  panel: Panel;
  /** Gate ids waiting for the y/n answer to the fix warning. */
  confirm?: string[];
  busy?: 'run' | 'fix';
  /** The last finished run: it decides the header. */
  run?: RunResult;
  fix?: FixResult;
  trends?: Trends | undefined | 'none';
  notice: string;
  cancelling: boolean;
}
export const FIX_WARNING = 'Fix rewrites files in your working tree. y/n';

export const initialState = (gates: GateInfo[], last?: RunResult): State => {
  const results = new Map(last?.gates.map(gate => [gate.id, gate]));
  return { rows: gates.map(info => ({ ...info, line: '', ...(results.has(info.id) ? { state: stateOf(results.get(info.id)!), result: results.get(info.id) } : { state: 'idle' as const }) })),
    panel: 'list', notice: '', cancelling: false, ...(last ? { run: last } : {}) };
};

/** The row state a finished gate shows. */
export function stateOf(gate: GateResult): RowState {
  if (gate.skipped) return 'skipped';
  if (gate.execution === 'timeout' || gate.execution === 'interrupted' || gate.execution === 'error') return gate.execution;
  return gate.decision;
}

const patchRow = (state: State, id: string, patch: Partial<Row>): State =>
  ({ ...state, rows: state.rows.map(row => row.id === id ? { ...row, ...patch } : row) });

/** Applies one runner event (the same events `qualitygate run` draws its live view from). */
export function applyProgress(state: State, event: ProgressEvent, now: number): State {
  if (event.kind === 'plan') return { ...state, rows: state.rows.map(row => event.ids.includes(row.id) ? { id: row.id, command: row.command, fixable: row.fixable, withheld: row.withheld, state: 'waiting', line: '' } : row) };
  if (event.kind === 'start') return patchRow(state, event.id, { state: 'running', startedAt: now });
  if (event.kind === 'log') return patchRow(state, event.id, { line: event.line });
  return patchRow(state, event.gate.id, { state: stateOf(event.gate), result: event.gate, line: '' });
}

/** A fix command is running for this gate; the re-run follows. */
export function applyFixStart(state: State, id: string, now: number): State {
  return patchRow(state, id, { state: 'fixing', startedAt: now, line: '' });
}

export function runStarted(state: State, busy: 'run' | 'fix'): State {
  return { ...state, busy, notice: '', confirm: undefined, fix: undefined };
}

export function runFinished(state: State, run: RunResult, notice: string, fix?: FixResult): State {
  return { ...state, busy: undefined, cancelling: false, run, notice, ...(fix ? { fix } : {}) };
}

export function jobFailed(state: State, text: string): State {
  return { ...state, busy: undefined, cancelling: false, notice: text };
}

/** What a key press asks the session to do besides changing the screen. */
export type Command = { kind: 'run'; ids?: string[] } | { kind: 'fix'; ids: string[] } | { kind: 'trends' } | { kind: 'quit' } | { kind: 'cancel-and-quit'; code: number };
export interface KeyInput { input: string; up?: boolean; down?: boolean; enter?: boolean; escape?: boolean; ctrlC?: boolean }

type Outcome = { state: State; command?: Command };
const selectedRow = (state: State) => state.selected === undefined ? undefined : state.rows[state.selected];

function startFix(state: State): Outcome {
  const row = selectedRow(state);
  if (row) {
    if (!row.fixable) return { state: { ...state, notice: `Gate ${row.id} declares no fix command (add \`fix:\` to it in the config).` } };
    return { state: { ...state, confirm: [row.id], notice: '' } };
  }
  const ids = state.rows.filter(candidate => candidate.fixable && candidate.state === 'BLOCK').map(candidate => candidate.id);
  if (!ids.length) return { state: { ...state, notice: 'Nothing to fix: no blocked gate declares a fix command.' } };
  return { state: { ...state, confirm: ids, notice: '' } };
}

function confirmKey(state: State, key: KeyInput): Outcome {
  if (key.input === 'y' || key.input === 'Y') return { state: { ...state, confirm: undefined }, command: { kind: 'fix', ids: state.confirm! } };
  return { state: { ...state, confirm: undefined, notice: 'Fix cancelled.' } };
}

function moveKey(state: State, key: KeyInput): Outcome | undefined {
  if (!key.up && !key.down) return undefined;
  const last = state.rows.length - 1;
  if (last < 0) return { state };
  const next = state.selected === undefined ? (key.down ? 0 : last) : Math.min(last, Math.max(0, state.selected + (key.down ? 1 : -1)));
  return { state: { ...state, selected: next } };
}

function panelKey(state: State, key: KeyInput): Outcome | undefined {
  if (key.escape) return { state: { ...state, panel: 'list', selected: state.panel === 'list' ? undefined : state.selected } };
  if (key.input === 'd') return { state: { ...state, panel: state.panel === 'details' ? 'list' : 'details' } };
  if (key.input !== 't') return undefined;
  const closing = state.panel === 'trends';
  return { state: { ...state, panel: closing ? 'list' : 'trends' }, command: closing ? undefined : { kind: 'trends' } };
}

function jobKey(state: State, key: KeyInput): Outcome {
  const wanted = key.input === 'r' || key.input === 'f' || key.enter;
  if (state.busy && wanted) return { state: { ...state, notice: `Wait for the ${state.busy} to finish, or press Ctrl+C to cancel.` } };
  if (key.input === 'r') return { state, command: { kind: 'run' } };
  if (key.input === 'f') return startFix(state);
  if (!key.enter) return { state };
  const row = selectedRow(state);
  return row ? { state, command: { kind: 'run', ids: [row.id] } } : { state: { ...state, notice: 'Select a gate with the arrow keys first.' } };
}

/** Maps one key press to the next screen state and, when a job should start or the program should end, a command. */
export function handleKey(state: State, key: KeyInput): Outcome {
  if (key.ctrlC) return { state, command: { kind: 'cancel-and-quit', code: 130 } };
  if (state.confirm) return confirmKey(state, key);
  if (key.input === 'q') return { state, command: { kind: 'quit' } };
  return moveKey(state, key) ?? panelKey(state, key) ?? jobKey(state, key);
}

/** The exit code `qualitygate ui` ends with: the last run's, as for `qualitygate run`; 0 when nothing ran. */
export const exitCodeOf = (state: State): number => state.run ? exitCode(state.run) : 0;

const MARK: Record<RowState, string> = { idle: '-', waiting: '.', running: '*', fixing: '~', PASS: 'PASS', BLOCK: 'BLOCK', error: 'ERROR', timeout: 'TIMEOUT', interrupted: 'INTERRUPTED', skipped: 'SKIPPED' };
export const SPINNER = ['|', '/', '-', '\\'];
const seconds = (since: number | undefined, now: number) => since === undefined ? '' : `${Math.floor((now - since) / 1000)}s`;

const TONE: Record<RowState, RowView['tone']> = { idle: 'dim', waiting: 'dim', running: 'busy', fixing: 'busy', PASS: 'ok', BLOCK: 'bad', error: 'bad', timeout: 'bad', interrupted: 'warn', skipped: 'warn' };
export interface RowView { text: string; tone: 'ok' | 'bad' | 'busy' | 'dim' | 'warn' }
/** One table line: state, id, elapsed time or duration and a short detail. */
export function rowView(row: Row, now: number, width: number): RowView {
  const running = row.state === 'running' || row.state === 'fixing';
  const mark = running ? `${MARK[row.state]} ${SPINNER[Math.floor(now / 250) % SPINNER.length]}` : MARK[row.state];
  const detail = running ? row.line : row.result ? (row.result.skipped ? 'skipped' : row.result.cached ? 'cached' : `${row.result.durationMs}ms`) : '';
  const parts = [mark.padEnd(12), `${row.id}${row.fixable ? ' [fix]' : ''}`, running ? seconds(row.startedAt, now) : '', detail];
  const text = plainLine(parts.filter(Boolean).join(' '), width);
  return { text, tone: TONE[row.state] };
}

export interface HeaderView { title: string; overall: string; tone: 'ok' | 'bad' | 'busy' | 'dim' }
export function headerView(state: State, root: string): HeaderView {
  const title = plainLine(`QualityGate  ${root}`, 200);
  if (state.busy) return { title, overall: state.cancelling ? 'Cancelling...' : state.busy === 'fix' ? 'Fixing and re-running...' : 'Running...', tone: 'busy' };
  if (!state.run) return { title, overall: 'Not run yet. Press r to run all gates.', tone: 'dim' };
  const code = exitCode(state.run);
  const covered = state.run.steps.length ? `, ${state.run.steps.filter(step => step.status !== 'not-run').length} of ${state.run.steps.length} steps ran` : '';
  return { title, overall: `Overall: ${state.run.decision} (${state.run.execution}), exit code ${code}${covered}`, tone: state.run.decision === 'PASS' && code === 0 ? 'ok' : 'bad' };
}

const MAX_FINDINGS = 12; const MAX_TAIL = 8;
/** The details panel of one gate. Output of gates whose parser can expose secrets is never shown. */
export function detailLines(row: Row | undefined, width: number): string[] {
  if (!row) return ['Select a gate with the arrow keys to see its details.'];
  const lines = [`Gate ${row.id}`, `Reproduce: ${row.command}`];
  const result = row.result;
  if (!result) return [...lines, 'No result yet. Press enter to run this gate.'].map(line => plainLine(line, width));
  lines.push(`Result: ${result.decision} (${result.execution}${result.exitCode === null ? '' : `, exit ${result.exitCode}`}, ${result.durationMs}ms)`);
  if (result.skipped) lines.push(`Skipped: ${result.skipped}`);
  for (const error of result.errors) lines.push(`Error: ${error}`);
  for (const finding of result.findings.slice(0, MAX_FINDINGS)) {
    lines.push(`${finding.severity} ${finding.file ?? finding.gateId}${finding.line ? `:${finding.line}` : ''}${finding.column ? `:${finding.column}` : ''} ${finding.ruleId ?? ''} ${finding.message}`.replace(/\s+/g, ' '));
  }
  if (result.findings.length > MAX_FINDINGS) lines.push(`... and ${result.findings.length - MAX_FINDINGS} more findings`);
  if (row.withheld) lines.push('Output withheld: this gate\'s report parser can expose secrets.');
  else if (result.decision === 'BLOCK') lines.push(...result.outputTail.trimEnd().split('\n').filter(line => line.trim()).slice(-MAX_TAIL).map(line => `| ${line}`));
  if (result.evidencePath) lines.push(`Log: ${result.evidencePath}`);
  return lines.map(line => plainLine(line, width));
}

const BARS = '▁▂▃▄▅▆▇█';
/** One bar per week: the share of runs that blocked. */
export function sparkline(weeks: { runs: number; blocked: number }[]): string {
  return weeks.map(week => BARS[Math.min(BARS.length - 1, Math.floor((week.blocked / Math.max(1, week.runs)) * (BARS.length - 1) + 0.5))]!).join('');
}

export function trendLines(trends: State['trends'], width: number): string[] {
  if (trends === undefined) return ['Loading trends...'];
  if (trends === 'none') return ['No run history yet. Run the gates first.'];
  const lines = [`Blocked share per week, last ${trends.runs} runs: ${sparkline(trends.weeks)}`,
    ...(trends.weeks.length ? [`Weeks: ${trends.weeks[0]!.week} to ${trends.weeks.at(-1)!.week}`] : []),
    `Failing most: ${trends.failingGates.length ? trends.failingGates.slice(0, 5).map(gate => `${gate.id} ${gate.failures}/${gate.runs}`).join(', ') : 'none'}`,
    `Flaky: ${trends.flakyGates.length ? trends.flakyGates.slice(0, 5).map(gate => `${gate.id} ${gate.flips} flips`).join(', ') : 'none'}`];
  return lines.map(line => plainLine(line, width));
}

export const FOOTER = 'r run all | enter run gate | arrows move | f fix | d details | t trends | q quit';
