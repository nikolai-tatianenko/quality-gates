import { compareRuns, readRuns, trends, type Comparison, type HistoryRun } from '../../core/src/history.js';
import { loadConfig } from './runner.js';

const BLOCKED = ['failed', 'timeout', 'error'];
/** Gate counts of a run: passed (including cached), blocked (failed, timed out or errored) and other (skipped, interrupted). */
function counts(run: HistoryRun) {
  const blocked = run.gates.filter(g => BLOCKED.includes(g.status)).length;
  const passed = run.gates.filter(g => g.status === 'passed' || g.status === 'cached').length;
  return { passed, blocked, other: run.gates.length - passed - blocked };
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const list = (ids: string[]) => ids.length ? ids.join(', ') : 'none';
function comparisonLines(diff: Comparison | null): string[] {
  if (!diff) return ['No previous run to compare with.'];
  return [`Compared with the previous run ${diff.previous}:`, `  Regressions (passed before, blocks now): ${list(diff.regressions)}`,
    `  New failures: ${list(diff.newFailures)}`, `  Fixed: ${list(diff.fixed)}`,
    `  Newly slow: ${diff.slower.length ? diff.slower.map(s => `${s.id} (${seconds(s.previousMs)} -> ${seconds(s.currentMs)})`).join(', ') : 'none'}`];
}

/** `qualitygate history`: the most recent runs and a comparison of the newest with the one before it. Exits 0 even when it reports a regression. */
export async function historyCommand(configPath: string, limit: number, json: boolean): Promise<string> {
  const { config } = await loadConfig(configPath);
  const runs = await readRuns(config.outputDir, Math.max(limit, 2));
  const diff = runs.length > 1 ? compareRuns(runs[0]!, runs[1]!) : null;
  const shown = runs.slice(0, limit);
  if (json) return JSON.stringify({ schemaVersion: 1, runs: shown.map(r => ({ id: r.id, startedAt: r.startedAt, finishedAt: r.finishedAt, execution: r.execution, decision: r.decision, durationMs: r.durationMs, gates: counts(r) })), comparison: diff });
  if (!shown.length) return 'No runs recorded yet. Run: qualitygate run';
  return [...shown.map(r => { const c = counts(r); return `${r.id}  ${r.startedAt}  ${r.decision}${r.execution === 'completed' ? '' : ` (${r.execution})`}  ${seconds(r.durationMs)}  ${c.passed} pass, ${c.blocked} block, ${c.other} other`; }),
    '', ...comparisonLines(diff)].join('\n');
}

/** `qualitygate trends`: blocks per week, most frequently failing gates and flaky gates over the last `limit` runs. */
export async function trendsCommand(configPath: string, limit: number, json: boolean): Promise<string> {
  const { config } = await loadConfig(configPath);
  const t = trends(await readRuns(config.outputDir, limit));
  if (json) return JSON.stringify({ schemaVersion: 1, ...t });
  if (!t.runs) return 'No runs recorded yet. Run: qualitygate run';
  return [`Last ${t.runs} recorded runs`, '', 'Blocks per week (week starting Monday, UTC):', ...t.weeks.map(w => `  ${w.week}  ${w.blocked} of ${w.runs} runs blocked`),
    '', 'Most frequently failing gates:', ...(t.failingGates.length ? t.failingGates.slice(0, 10).map(g => `  ${g.id}  ${g.failures} of ${g.runs} runs`) : ['  none']),
    '', 'Flaky gates (alternate between PASS and BLOCK without a change of their inputs):', ...(t.flakyGates.length ? t.flakyGates.map(g => `  ${g.id}  ${g.flips} flips in ${g.runs} runs`) : ['  none'])].join('\n');
}
