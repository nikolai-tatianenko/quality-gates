import { useState } from 'react';
import type { TeamGate, TeamReport } from '../../core/src/team.js';
import { durationBars, formatMs, greenBars, historyRows, layoutBars, weekBars, CHART, type Bar } from './chart.js';

/** What `/api/team` (and the bridge's `/v1/team`) return. */
export type Team = TeamReport & { markdown: string };

/** Copies text to the clipboard; false when the browser refuses or has no clipboard API (insecure context, denied permission). */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/**
 * Button that copies `text`. The result is announced to screen readers through a polite live region.
 * @param text what to copy
 * @param label visible button text
 * @param testId value of the `data-test-id` attribute
 */
export function CopyButton({ text, label, testId }: { text: string; label: string; testId: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return <span className="copy">
    <button type="button" className="secondary" data-test-id={testId} onClick={() => void copyText(text).then(ok => setState(ok ? 'copied' : 'failed'))}>{label}</button>
    <span role="status" className="copy-status">{state === 'copied' ? 'Copied to clipboard' : state === 'failed' ? 'Copy failed. Select the text and copy it by hand.' : ''}</span>
  </span>;
}

/**
 * Bar chart as inline SVG. Blocked bars are hatched, so the verdict never depends on colour alone; the same numbers are in
 * the history table. Each bar carries a `<title>` tooltip.
 * @param id unique id prefix for the SVG pattern and labels
 * @param label accessible name, which should state the finding the chart shows
 */
export function BarChart({ id, label, bars, unit }: { id: string; label: string; bars: Bar[]; unit: (value: number) => string }) {
  if (!bars.length) return <p className="muted">Nothing recorded yet.</p>;
  const shapes = layoutBars(bars); const max = Math.max(...bars.map(b => b.value));
  return <figure className="chart"><svg viewBox={`0 0 ${CHART.width} ${CHART.height}`} role="img" aria-labelledby={`${id}-title`} data-test-id={`chart-${id}`}>
    <title id={`${id}-title`}>{label}</title>
    <defs><pattern id={`${id}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" className="hatch-bg"/><line x1="0" y1="0" x2="0" y2="6" className="hatch-line" strokeWidth="3"/></pattern></defs>
    <line x1="0" x2={CHART.width} y1={CHART.height - CHART.bottom} y2={CHART.height - CHART.bottom} className="axis"/>
    {shapes.map((b, i) => <g key={i}><title>{b.title}</title>
      <rect x={b.x} y={b.y} width={b.width} height={b.height} className={`bar bar-${b.kind}`} fill={b.kind === 'block' ? `url(#${id}-hatch)` : undefined}/>
      {b.partHeight > 0 && <rect x={b.x} y={CHART.height - CHART.bottom - b.partHeight} width={b.width} height={b.partHeight} className="bar bar-block" fill={`url(#${id}-hatch)`}/>}</g>)}
    <text x="0" y="11" className="axis-label">{unit(max)}</text>
    <text x="0" y={CHART.height - 5} className="axis-label">{bars[0]!.label}</text>
    <text x={CHART.width} y={CHART.height - 5} textAnchor="end" className="axis-label">{bars[bars.length - 1]!.label}</text>
  </svg></figure>;
}

const pill = (decision: string) => <span className={`pill ${decision.toLowerCase()}`}>{decision}</span>;
const Empty = ({ children }: { children: string }) => <p className="muted">{children}</p>;
const ids = (list: string[]) => list.length ? list.map((id, i) => <span key={id}>{i ? ', ' : ''}<code>{id}</code></span>) : 'none';

/** Short answer for team leads: the decision, what changed, the top three risks, who blocks and how fast the team gets back to green. */
export function LeadSummary({ team }: { team: Team }) {
  const { current, changes, risks, timeToGreen } = team;
  return <section className="panel" id="team" aria-labelledby="team-title"><div className="section-title"><div><h2 id="team-title">Summary for leads</h2>
    <p className="section-description">Current decision, what changed and where the risk is. Verdicts come from the stored run and are never recomputed here.</p></div>
    <span>{current ? current.runId.slice(0, 8) : 'NO RUN'}</span></div>
    <div className="lead">
      <div className="lead-decision" data-test-id="lead-decision">{current && pill(current.decision)}<p className="lead-headline">{team.headline}</p>
        {current && <small>Exit code {current.exitCode} · {current.execution} · {formatMs(current.durationMs)}</small>}</div>
      <div className="lead-grid">
        <section aria-labelledby="lead-changed"><h3 id="lead-changed">Since the last run</h3>
          {changes ? <dl className="changes"><dt>Regressions</dt><dd>{ids(changes.regressions)}</dd><dt>New failures</dt><dd>{ids(changes.newFailures)}</dd>
            <dt>Fixed</dt><dd>{ids(changes.fixed)}</dd><dt>Slower</dt><dd>{ids(changes.slower.map(s => s.id))}</dd></dl> : <Empty>Needs at least two recorded runs.</Empty>}</section>
        <section aria-labelledby="lead-risks"><h3 id="lead-risks">Top risks</h3>
          {risks.length ? <ol className="risks" data-test-id="lead-risks">{risks.map(r => <li key={r.gateId}><code>{r.gateId}</code> <span className="tag">{r.kind}</span><small>{r.detail}</small></li>)}</ol> : <Empty>No risks found in the recorded runs.</Empty>}</section>
        <section aria-labelledby="lead-blocking"><h3 id="lead-blocking">Gates that block</h3>
          {team.blockingGates.length ? <ul className="plain" data-test-id="lead-blocking">{team.blockingGates.map(id => <li key={id}><code>{id}</code></li>)}</ul> : <Empty>No gate blocks the latest run.</Empty>}</section>
        <section aria-labelledby="lead-green"><h3 id="lead-green">Time to green</h3>
          <p className="big">{timeToGreen.medianMs === null ? '—' : formatMs(timeToGreen.medianMs)}</p>
          <small>{timeToGreen.medianMs === null ? 'No BLOCK to PASS recovery recorded yet.' : `Median over ${timeToGreen.spans.length} recoveries.`}{timeToGreen.openSince ? ` Blocked since ${timeToGreen.openSince.slice(0, 16).replace('T', ' ')} UTC.` : ''}</small></section>
      </div>
      <ExportPanel team={team}/>
    </div></section>;
}

/** Markdown of the summary for a stand-up or a pull request description: copy, download, or select from the preview. */
export function ExportPanel({ team }: { team: Team }) {
  return <div className="export"><h3 id="export-title">Export summary</h3>
    <div className="export-actions"><CopyButton text={team.markdown} label="Copy Markdown" testId="copy-markdown"/>
      <a className="button-outline" data-test-id="download-markdown" download="qualitygate-summary.md" href={`data:text/markdown;charset=utf-8,${encodeURIComponent(team.markdown)}`}>Download .md</a></div>
    <details><summary>Preview Markdown</summary><textarea readOnly aria-labelledby="export-title" rows={10} value={team.markdown} data-test-id="markdown-preview"/></details></div>;
}

/** Pass/block over time, duration, most frequently failing gates and flaky gates. */
export function Trends({ team }: { team: Team }) {
  const total = team.runs.length;
  return <section className="panel" id="trends" aria-labelledby="trends-title"><div className="section-title"><div><h2 id="trends-title">Trends</h2>
    <p className="section-description">Hatched bars are blocked. The history table below holds the same numbers.</p></div><span>{total} {total === 1 ? 'RUN' : 'RUNS'}</span></div>
    <div className="charts">
      <div><h3>Runs per week, blocked share hatched</h3><BarChart id="weeks" label={`Runs per week: ${team.weeks.map(w => `${w.week} ${w.blocked} of ${w.runs} blocked`).join('; ')}`} bars={weekBars(team.weeks)} unit={v => `${v} runs`}/></div>
      <div><h3>Run duration</h3><BarChart id="duration" label={`Duration of the last ${total} runs, oldest first`} bars={durationBars(team.runs)} unit={formatMs}/></div>
      <div><h3>Time to green</h3><BarChart id="green" label={`Time from first BLOCK to the next PASS, ${team.timeToGreen.spans.length} recoveries`} bars={greenBars(team.timeToGreen.spans)} unit={formatMs}/></div>
      <div><h3>Most frequently failing gates</h3>
        {team.failingGates.length ? <ul className="meters" data-test-id="failing-gates">{team.failingGates.slice(0, 8).map(g => <li key={g.id}><code>{g.id}</code>
          <meter min={0} max={g.runs} value={g.failures} aria-label={`${g.id} blocked ${g.failures} of ${g.runs} runs`}/><span>{g.failures} of {g.runs}</span></li>)}</ul> : <Empty>No gate has blocked.</Empty>}
        <h3>Flaky gates</h3>
        {team.flakyGates.length ? <ul className="plain" data-test-id="flaky-gates">{team.flakyGates.map(g => <li key={g.id}><code>{g.id}</code> <small>{g.flips} PASS/BLOCK flips in {g.runs} runs without a change of inputs</small></li>)}</ul> : <Empty>No flaky gates detected.</Empty>}</div>
    </div></section>;
}

/** Recorded runs, newest first, with the gates that started to block in each. */
export function HistoryTable({ team }: { team: Team }) {
  const rows = historyRows(team.runs);
  return <section className="panel" id="history" aria-labelledby="history-title"><div className="section-title"><div><h2 id="history-title">Run history</h2>
    <p className="section-description">From history.sqlite in the output directory. Skipped, cached and interrupted outcomes are not counted as failures.</p></div></div>
    {rows.length ? <div className="table-scroll" role="region" aria-label="Run history table" tabIndex={0}><table className="data-table" data-test-id="history-table"><caption className="sr-only">Recorded runs, newest first</caption>
      <thead><tr><th scope="col">Run</th><th scope="col">Decision</th><th scope="col">Duration</th><th scope="col">Blocking gates</th><th scope="col">Newly blocking</th></tr></thead>
      <tbody>{rows.map(({ run, newlyBlocked }) => <tr key={run.runId}><td><code>{run.runId.slice(0, 8)}</code><small>{run.startedAt.slice(0, 16).replace('T', ' ')} UTC</small></td>
        <td>{pill(run.decision)}{run.execution !== 'completed' && <small>{run.execution}</small>}</td><td>{formatMs(run.durationMs)}</td>
        <td>{run.blocked.length} of {run.gates}</td><td>{ids(newlyBlocked)}</td></tr>)}</tbody></table></div> : <div className="empty">No runs recorded yet.<p>Run <code>qualitygate run</code> or use the button above.</p></div>}
  </section>;
}

function EngineerGate({ gate }: { gate: TeamGate }) {
  return <article className="engineer-gate" data-test-id={`engineer-${gate.id}`}><div className="engineer-head"><h3>{gate.id}</h3><span className="pill block">{gate.status.toUpperCase()}</span></div>
    <div className="reproduce"><span>Reproduce locally</span><code data-test-id="reproduce-command">{gate.reproduce}</code>
      <CopyButton text={gate.reproduce} label="Copy command" testId={`copy-reproduce-${gate.id}`}/></div>
    {gate.findings.length > 0 && <ul className="findings-list">{gate.findings.map((f, i) => <li key={i}><span className={`pill severity-${f.severity}`}>{f.severity}</span>
      <div><code>{f.location}</code>{f.ruleId && <> · <small className="inline">{f.helpUrl ? <a href={f.helpUrl} rel="noreferrer noopener" target="_blank">{f.ruleId}</a> : f.ruleId}</small></>}<p>{f.message}</p></div></li>)}</ul>}
    {gate.omittedFindings > 0 && <p className="muted">and {gate.omittedFindings} more findings; run the command above to see all of them.</p>}
    {gate.violations.length > 0 && <ul className="plain">{gate.violations.map((v, i) => <li key={i}>{v}</li>)}</ul>}
    {!gate.findings.length && !gate.violations.length && <p className="muted">This gate reported no structured findings. Gate output is not shown in this view; run the command above to read it.</p>}
  </article>;
}

/** The failing gates of the latest run, with file:line findings and a command to reproduce each one. */
export function EngineerView({ team }: { team: Team }) {
  return <section className="panel" id="engineer" aria-labelledby="engineer-title"><div className="section-title"><div><h2 id="engineer-title">Engineer view</h2>
    <p className="section-description">What to fix first, where, and how to run it again on your machine.</p></div></div>
    <div className="engineer">{team.engineer.length ? team.engineer.map(g => <EngineerGate key={`${g.kind}:${g.id}`} gate={g}/>) : <Empty>{team.current ? 'Nothing blocks the latest run.' : 'Run the gates to see failures here.'}</Empty>}</div></section>;
}

/** All team sections. `team` is undefined until it has loaded; `error` replaces it when loading failed. */
export function TeamView({ team, error }: { team?: Team; error: string }) {
  if (error) return <div role="alert" className="error" data-test-id="team-error">Team view unavailable: {error}</div>;
  if (!team) return <p className="muted" role="status">Loading team view…</p>;
  return <>
    {team.warnings.map(w => <div key={w} role="alert" className="error">{w}</div>)}
    <LeadSummary team={team}/><Trends team={team}/><HistoryTable team={team}/><EngineerView team={team}/></>;
}
