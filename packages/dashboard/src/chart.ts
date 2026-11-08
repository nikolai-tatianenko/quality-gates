import type { TeamReport, TeamRunPoint } from '../../core/src/team.js';

/** One bar of a chart. `part` is the share of `value` that blocked, drawn hatched on top of the bar. */
export interface Bar { label: string; value: number; part?: number; kind: 'pass' | 'block' | 'other'; title: string }
export interface BarShape extends Bar { x: number; y: number; width: number; height: number; partHeight: number }
export const CHART = { width: 320, height: 130, top: 16, bottom: 20, gap: 3, maxBar: 26 } as const;

/** Pixel geometry for the bars; the tallest bar fills the plot and every non-zero bar is at least 2px tall so it stays visible. */
export function layoutBars(bars: Bar[]): BarShape[] {
  const plot = CHART.height - CHART.top - CHART.bottom;
  const max = Math.max(1, ...bars.map(b => b.value));
  const width = Math.min(CHART.maxBar, (CHART.width - CHART.gap * bars.length) / Math.max(1, bars.length));
  const left = (CHART.width - (width + CHART.gap) * bars.length + CHART.gap) / 2;
  const tall = (value: number) => value > 0 ? Math.max(2, (value / max) * plot) : 0;
  return bars.map((bar, i) => {
    const height = tall(bar.value);
    return { ...bar, x: left + i * (width + CHART.gap), width, height, y: CHART.top + plot - height, partHeight: Math.min(height, tall(bar.part ?? 0)) };
  });
}

export const formatMs = (ms: number) => ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;
const day = (iso: string) => iso.slice(0, 10);
const kindOf = (run: TeamRunPoint): Bar['kind'] => run.execution !== 'completed' ? 'other' : run.decision === 'PASS' ? 'pass' : 'block';

/** Run duration per recorded run, oldest first; blocked runs are hatched red, runs without a verdict are neutral. */
export const durationBars = (runs: TeamRunPoint[]): Bar[] => runs.map(r => ({ label: day(r.startedAt), value: r.durationMs, kind: kindOf(r),
  title: `${day(r.startedAt)} ${r.decision}${r.execution === 'completed' ? '' : ` (${r.execution})`}, ${formatMs(r.durationMs)}` }));
/** Runs per week with the blocked share of them hatched. */
export const weekBars = (weeks: TeamReport['weeks']): Bar[] => weeks.map(w => ({ label: w.week, value: w.runs, part: w.blocked, kind: 'pass',
  title: `Week of ${w.week}: ${w.blocked} of ${w.runs} runs blocked` }));
/** How long each recovery from BLOCK to PASS took. */
export const greenBars = (spans: TeamReport['timeToGreen']['spans']): Bar[] => spans.map(s => ({ label: day(s.greenAt), value: s.ms, kind: 'other',
  title: `Blocked since ${s.blockedSince}, green ${s.greenAt}: ${formatMs(s.ms)}` }));

/** History rows newest first, each with the gates that block in it and not in the run before it (the oldest run has no baseline). */
export function historyRows(runs: TeamRunPoint[]) {
  return runs.map((run, i) => ({ run, newlyBlocked: i === 0 ? [] : run.blocked.filter(id => !runs[i - 1]!.blocked.includes(id)) })).reverse();
}
