import type { GateResult, RunResult } from '../../protocol/src/index.js';
import type { ProgressEvent } from '../../core/src/index.js';
/** Escape sequences (CSI, OSC, two-character) and control characters, which gate output must not send to the terminal. */
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]|[\x00-\x1f\x7f]/g;
const SPINNER = ['|', '/', '-', '\\'];
const HIDE = '\x1b[?25l'; const SHOW = '\x1b[?25h';
interface Terminal { isTTY?: boolean }
/** The live view needs a terminal on stdout, no CI, no opt-out (`--no-live`, `QUALITYGATE_NO_LIVE`) and text output. */
export function liveEnabled(stream: Terminal, env: Record<string, string | undefined>, flags: { noLive?: boolean; json?: boolean }): boolean {
  const off = env.QUALITYGATE_NO_LIVE;
  return Boolean(stream.isTTY) && !env.CI && !(off && off !== '0') && env.TERM !== 'dumb' && !flags.noLive && !flags.json;
}
/** One printable line: no escape sequences or control characters, at most `width` characters. */
export function plainLine(text: string, width: number): string {
  const clean = text.replace(CONTROL, '');
  if (width < 1) return '';
  return clean.length > width ? `${clean.slice(0, width - 1)}…` : clean;
}
interface Row { id: string; state: 'waiting' | 'running' | 'done'; startedAt?: number; line: string; result?: GateResult }
export interface LiveStream extends NodeJS.WritableStream { columns?: number; rows?: number }
const PRIORITY = { running: 0, waiting: 1, done: 2 } as const;
/**
 * Draws one row per gate in place with plain ANSI codes and updates it as events arrive. Rows are cut to the terminal width and
 * at most one fewer than the terminal height are drawn (running gates first, then "+N more"), so the cursor arithmetic holds.
 * When the terminal gets narrower the old rows have wrapped; erasing counts the wrapped rows and a resize redraws. `stop` erases the rows, restores the cursor and optionally prints a one-line summary; the normal
 * text output follows it unchanged.
 */
export function liveView(stream: LiveStream, options: { interval?: number } = {}) {
  const rows = new Map<string, Row>();
  const started = Date.now();
  let drawn: string[] = []; let stopped = false;
  const row = (id: string) => rows.get(id) ?? rows.set(id, { id, state: 'waiting', line: '' }).get(id)!;
  const text = (item: Row, tick: number) => {
    const seconds = item.startedAt ? `${Math.floor((Date.now() - item.startedAt) / 1000)}s` : '';
    const mark = item.state === 'running' ? SPINNER[tick % SPINNER.length]! : item.state === 'waiting' ? '.' : item.result!.decision;
    const detail = item.result ? (item.result.skipped ? 'skipped' : item.result.cached ? 'cached' : `${item.result.durationMs}ms`) : item.line;
    return `${mark} ${item.id} ${seconds} ${detail}`.trimEnd();
  };
  const erase = () => {
    const width = Math.max(1, stream.columns ?? 80);
    const physical = drawn.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / width)), 0);
    if (physical) stream.write(`\x1b[${physical}A\x1b[J`);
    drawn = [];
  };
  /** The rows to draw: all of them, or when they do not fit the terminal the running gates first (in plan order) and a count of the rest. */
  const visible = (items: Row[]) => {
    const capacity = Math.max(1, (stream.rows ?? 24) - 1);
    if (items.length <= capacity) return { shown: items, hidden: 0 };
    const keep = Math.max(0, capacity - 1);
    const chosen = new Set([...items].sort((a, b) => PRIORITY[a.state] - PRIORITY[b.state]).slice(0, keep));
    return { shown: items.filter(item => chosen.has(item)), hidden: items.length - keep };
  };
  let tick = 0;
  const draw = () => {
    erase();
    const width = Math.max(1, (stream.columns ?? 80) - 1);
    const { shown, hidden } = visible([...rows.values()]);
    const lines = shown.map(item => plainLine(text(item, tick), width));
    if (hidden) lines.push(plainLine(`+${hidden} more`, width));
    if (lines.length) stream.write(`${lines.join('\n')}\n`);
    drawn = lines;
  };
  stream.write(HIDE);
  const restore = () => { stream.write(SHOW); };
  process.once('exit', restore);
  const resized = () => { if (!stopped) draw(); };
  stream.on('resize', resized);
  const timer = options.interval === 0 ? undefined : setInterval(() => { tick++; draw(); }, options.interval ?? 100);
  timer?.unref();
  return {
    onProgress(event: ProgressEvent) {
      if (event.kind === 'plan') for (const id of event.ids) row(id);
      else if (event.kind === 'start') Object.assign(row(event.id), { state: 'running', startedAt: Date.now() });
      else if (event.kind === 'log') { if (!rows.has(event.id)) return; row(event.id).line = event.line; }
      else Object.assign(row(event.gate.id), { state: 'done', result: event.gate });
      draw();
    },
    /** Erases the rows and restores the cursor; safe to call more than once. */
    stop(result?: RunResult) {
      if (stopped) return;
      stopped = true; clearInterval(timer); process.removeListener('exit', restore); stream.removeListener('resize', resized);
      erase();
      if (result) {
        const blocked = result.gates.filter(gate => gate.decision === 'BLOCK').length;
        stream.write(`${result.gates.length} gates in ${((Date.now() - started) / 1000).toFixed(1)}s: ${result.gates.length - blocked} passed, ${blocked} blocked\n`);
      }
      restore();
    },
  };
}
