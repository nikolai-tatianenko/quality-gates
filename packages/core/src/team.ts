import { exitCode, stepStatus, type Finding, type RunResult } from '../../protocol/src/index.js';
import { compareRuns, trends, type Comparison, type HistoryRun, type Trends } from './history.js';

/**
 * Team view of a project: what a lead needs to decide (current decision, what changed, top risks, time to green) and what an
 * engineer needs to act (failing gate, findings with file:line, a command to reproduce it locally). Everything is shaped from the
 * run history and the latest stored run. Gate logs (`outputTail`), raw reports and evidence paths are never read, so a secret
 * scanner's output cannot reach this view. The verdict fields are copied from the stored run, never recomputed.
 */
export interface TeamFinding { severity: Finding['severity']; message: string; location: string; ruleId?: string; helpUrl?: string }
export interface TeamGate {
  id: string; kind: 'gate' | 'audit'; status: string; durationMs?: number;
  /** Command that runs only this gate again from the project directory; built from the gate id alone. */
  reproduce: string;
  findings: TeamFinding[]; omittedFindings: number;
  /** Audit threshold violations, which are measurements rather than file locations. */
  violations: string[];
}
export interface TeamRisk { gateId: string; kind: 'blocking' | 'regression' | 'flaky' | 'failing-often' | 'slower'; detail: string }
export interface TeamRunPoint { runId: string; startedAt: string; decision: HistoryRun['decision']; execution: HistoryRun['execution']; durationMs: number; blocked: string[]; gates: number }
export interface GreenSpan { blockedSince: string; greenAt: string; ms: number }
export interface TeamReport {
  schemaVersion: 1;
  current: { runId: string; startedAt: string; decision: RunResult['decision']; execution: RunResult['execution']; exitCode: number; durationMs: number } | null;
  headline: string;
  blockingGates: string[];
  changes: Comparison | null;
  risks: TeamRisk[];
  /** Recorded runs, oldest first. */
  runs: TeamRunPoint[];
  weeks: Trends['weeks'];
  failingGates: Trends['failingGates'];
  flakyGates: Trends['flakyGates'];
  timeToGreen: { spans: GreenSpan[]; medianMs: number | null; openSince: string | null };
  engineer: TeamGate[];
  warnings: string[];
}
export interface TeamInput { runs: HistoryRun[]; latest?: RunResult | null; configName?: string; warnings?: string[] }

export const MAX_RISKS = 3;
const MAX_FINDINGS = 10;
const MAX_MESSAGE = 300;
const DEFAULT_CONFIG = '.qualitygate.yml';
const blocking = (status: string) => status === 'failed' || status === 'timeout' || status === 'error';

/** A word safe to paste into a POSIX shell: plain when it only holds harmless characters, otherwise single-quoted. */
export const shellWord = (value: string) => /^[\w.:@/+=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

/** The command that re-runs one gate (the id is the only thing taken from the project). */
export function reproduceCommand(gateId: string | undefined, configName = DEFAULT_CONFIG): string {
  return ['qualitygate run', ...(configName === DEFAULT_CONFIG ? [] : [`--config ${shellWord(configName)}`]), ...(gateId ? [`--gate ${shellWord(gateId)}`] : [])].join(' ');
}

const clip = (text: string) => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE - 1)}…` : line; };
function teamFinding(finding: Finding): TeamFinding {
  const where = finding.file ? `${finding.file}${finding.line ? `:${finding.line}${finding.column ? `:${finding.column}` : ''}` : ''}` : finding.gateId;
  return { severity: finding.severity, message: clip(finding.message), location: where, ...(finding.ruleId ? { ruleId: finding.ruleId } : {}), ...(finding.helpUrl ? { helpUrl: finding.helpUrl } : {}) };
}
const severityRank = { error: 0, warning: 1, info: 2 } as const;

/** Gates and audits of the latest run that block, with their findings (errors first) and how to run them again. */
function engineerView(run: RunResult, configName?: string): TeamGate[] {
  const gates = run.gates.filter(g => blocking(stepStatus(g))).map((g): TeamGate => {
    const findings = [...g.findings].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
    return { id: g.id, kind: 'gate', status: stepStatus(g), durationMs: g.durationMs, reproduce: reproduceCommand(g.id, configName),
      findings: findings.slice(0, MAX_FINDINGS).map(teamFinding), omittedFindings: Math.max(0, findings.length - MAX_FINDINGS), violations: [] };
  });
  const audits = run.results.filter(r => blocking(stepStatus(r))).map((r): TeamGate => ({ id: r.url, kind: 'audit', status: stepStatus(r),
    reproduce: reproduceCommand(undefined, configName), findings: [], omittedFindings: 0, violations: r.violations.map(clip) }));
  return [...gates, ...audits];
}

function currentOf(runs: HistoryRun[], latest?: RunResult | null): TeamReport['current'] {
  if (latest) {
    return { runId: latest.runId, startedAt: latest.startedAt, decision: latest.decision, execution: latest.execution, exitCode: exitCode(latest),
      durationMs: Math.max(0, Date.parse(latest.finishedAt) - Date.parse(latest.startedAt)) };
  }
  const run = runs[0];
  if (!run) return null;
  const code = { interrupted: 130, error: 2, timeout: 3, completed: run.decision === 'BLOCK' ? 1 : 0 }[run.execution];
  return { runId: run.id, startedAt: run.startedAt, decision: run.decision, execution: run.execution, exitCode: code, durationMs: run.durationMs };
}

/** Spans from the first BLOCK of a streak to the next PASS. Interrupted runs say nothing and are skipped. */
function timeToGreen(oldestFirst: HistoryRun[]): TeamReport['timeToGreen'] {
  const spans: GreenSpan[] = []; let since: string | null = null;
  for (const run of oldestFirst.filter(r => r.execution !== 'interrupted')) {
    if (run.decision === 'BLOCK') since ??= run.startedAt;
    else if (since) { spans.push({ blockedSince: since, greenAt: run.finishedAt, ms: Math.max(0, Date.parse(run.finishedAt) - Date.parse(since)) }); since = null; }
  }
  const sorted = spans.map(s => s.ms).sort((a, b) => a - b); const mid = sorted.length >> 1;
  const medianMs = sorted.length ? (sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2) : null;
  return { spans: spans.slice(-10), medianMs, openSince: since };
}

const RISK_ORDER: TeamRisk['kind'][] = ['regression', 'blocking', 'flaky', 'failing-often', 'slower'];
/** Up to three risks, one per gate, most urgent first: regressions, then other blocking gates, flaky gates, often failing gates, newly slow gates. */
function risksOf(blockingGates: string[], changes: Comparison | null, t: Trends): TeamRisk[] {
  const all: TeamRisk[] = [
    ...blockingGates.map((gateId): TeamRisk => changes?.regressions.includes(gateId)
      ? { gateId, kind: 'regression', detail: 'passed in the previous run and blocks now' }
      : { gateId, kind: 'blocking', detail: 'blocks the current run' }),
    ...t.flakyGates.map((g): TeamRisk => ({ gateId: g.id, kind: 'flaky', detail: `${g.flips} PASS/BLOCK flips in ${g.runs} runs without a change of its inputs` })),
    ...t.failingGates.filter(g => g.failures / g.runs >= 0.3 && g.runs >= 3).map((g): TeamRisk => ({ gateId: g.id, kind: 'failing-often', detail: `blocked ${g.failures} of ${g.runs} runs` })),
    ...(changes?.slower ?? []).map((s): TeamRisk => ({ gateId: s.id, kind: 'slower', detail: `${(s.previousMs / 1000).toFixed(1)}s to ${(s.currentMs / 1000).toFixed(1)}s` })),
  ];
  const seen = new Set<string>();
  return all.sort((a, b) => RISK_ORDER.indexOf(a.kind) - RISK_ORDER.indexOf(b.kind))
    .filter(r => !seen.has(r.gateId) && !!seen.add(r.gateId)).slice(0, MAX_RISKS);
}

function headlineOf(current: TeamReport['current'], blockingGates: string[], changes: Comparison | null): string {
  if (!current) return 'No run recorded yet';
  if (current.execution !== 'completed') return `Run ${current.execution}: no verdict from the gates (exit code ${current.exitCode})`;
  if (current.decision === 'PASS') return changes?.fixed.length ? `PASS: ${changes.fixed.join(', ')} fixed since the previous run` : 'PASS: all gates that ran passed';
  const names = blockingGates.length ? `${blockingGates.length} blocking: ${blockingGates.join(', ')}` : 'see the run details';
  return `BLOCK: ${names}`;
}

/** Shapes the team report. `runs` is newest first, as `readRuns` returns it. */
export function buildTeamReport({ runs, latest, configName, warnings = [] }: TeamInput): TeamReport {
  const current = currentOf(runs, latest);
  const changes = runs.length > 1 ? compareRuns(runs[0]!, runs[1]!) : null;
  const t = trends(runs);
  const engineer = latest ? engineerView(latest, configName) : [];
  const blockingGates = latest ? engineer.filter(g => g.kind === 'gate').map(g => g.id) : (runs[0]?.gates ?? []).filter(g => blocking(g.status)).map(g => g.id);
  const oldestFirst = [...runs].reverse();
  return { schemaVersion: 1, current, headline: headlineOf(current, blockingGates, changes), blockingGates, changes, risks: risksOf(blockingGates, changes, t),
    runs: oldestFirst.map(r => ({ runId: r.id, startedAt: r.startedAt, decision: r.decision, execution: r.execution, durationMs: r.durationMs,
      blocked: r.gates.filter(g => blocking(g.status)).map(g => g.id), gates: r.gates.length })),
    weeks: t.weeks, failingGates: t.failingGates, flakyGates: t.flakyGates, timeToGreen: timeToGreen(oldestFirst), engineer, warnings };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const span = (ms: number) => ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : ms >= 60_000 ? `${Math.round(ms / 60_000)}min` : seconds(ms);
/** Text for one line of Markdown: no line breaks, and nothing that could start formatting or a table cell. */
const plain = (text: string) => text.replace(/\s+/g, ' ').replace(/[\\`*_{}[\]<>|#]/g, '\\$&');
/** Inline code that keeps the text verbatim, also when it holds backticks (the fence is longer than any run inside). */
const code = (text: string) => {
  const flat = text.replace(/\s+/g, ' '); const fence = '`'.repeat(Math.max(0, ...(flat.match(/`+/g) ?? []).map(run => run.length)) + 1);
  return flat.includes('`') ? `${fence} ${flat} ${fence}` : `${fence}${flat}${fence}`;
};

/** Markdown for a stand-up or a pull request description. */
export function teamMarkdown(report: TeamReport): string {
  const out: string[] = [`## QualityGate: ${plain(report.headline)}`, ''];
  const c = report.current;
  if (c) out.push(`- Run ${code(c.runId.slice(0, 8))} at ${c.startedAt}: **${c.decision}** (${c.execution}, exit code ${c.exitCode}, ${seconds(c.durationMs)})`);
  if (report.changes) {
    const ch = report.changes; const list = (ids: string[]) => ids.map(code).join(', ') || 'none';
    out.push(`- Since the previous run: regressions ${list(ch.regressions)}; new failures ${list(ch.newFailures)}; fixed ${list(ch.fixed)}; slower ${list(ch.slower.map(s => s.id))}`);
  }
  const ttg = report.timeToGreen;
  out.push(`- Time to green: ${ttg.medianMs === null ? 'no completed BLOCK to PASS recovery recorded' : `median ${span(ttg.medianMs)} over ${ttg.spans.length} recoveries`}${ttg.openSince ? `; blocked since ${ttg.openSince}` : ''}`);
  if (report.risks.length) out.push('', '### Top risks', ...report.risks.map((r, i) => `${i + 1}. ${code(r.gateId)} (${r.kind}): ${plain(r.detail)}`));
  for (const gate of report.engineer) {
    out.push('', `### Blocking: ${code(gate.id)}`, '', `Reproduce: ${code(gate.reproduce)}`);
    out.push(...gate.findings.map(f => `- ${f.severity} ${code(f.location)}${f.ruleId ? ` ${code(f.ruleId)}` : ''}: ${plain(f.message)}`), ...gate.violations.map(v => `- ${plain(v)}`));
    if (gate.omittedFindings) out.push(`- and ${gate.omittedFindings} more findings`);
  }
  if (report.failingGates.length) out.push('', '### Most frequently failing gates', ...report.failingGates.slice(0, 5).map(g => `- ${code(g.id)}: ${g.failures} of ${g.runs} runs`));
  if (report.flakyGates.length) out.push('', '### Flaky gates', ...report.flakyGates.slice(0, 5).map(g => `- ${code(g.id)}: ${g.flips} flips in ${g.runs} runs`));
  if (report.warnings.length) out.push('', ...report.warnings.map(w => `> ${plain(w)}`));
  return `${out.join('\n')}\n`;
}
