import { runResultSchema, exitCode, coverageLine, type RunResult } from '../../protocol/src/index.js';
/** Run data and tool output are data: every value is escaped before it reaches the page. */
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
const e = escapeHtml;
const css = `:root{color-scheme:light dark;--bg:#fafafa;--fg:#18181b;--muted:#71717a;--card:#fff;--line:#e4e4e7;--pass:#15803d;--block:#b91c1c;--warn:#a16207}
@media (prefers-color-scheme: dark){:root{--bg:#09090b;--fg:#fafafa;--muted:#a1a1aa;--card:#18181b;--line:#27272a;--pass:#4ade80;--block:#f87171;--warn:#facc15}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:960px;margin:0 auto}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}p,small{color:var(--muted)}
.PASS{color:var(--pass)}.BLOCK,.error{color:var(--block)}.warning{color:var(--warn)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line)}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
pre{background:var(--card);border:1px solid var(--line);padding:10px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}li{margin:4px 0;overflow-wrap:anywhere}code{font-family:ui-monospace,monospace}`;
function table(head: string[], rows: string[][]) {
  return `<div style="overflow-x:auto"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.join('')}</tr>`).join('')}</tbody></table></div>`;
}
const cell = (value: string | number, cls = '') => `<td${cls ? ` class="${e(cls)}"` : ''}>${e(String(value))}</td>`;
/** One self-contained page: inline CSS, no scripts, no network resources. */
export function renderHtml(input: RunResult): string {
  const run = runResultSchema.parse(input);
  const title = run.execution === 'completed' ? run.decision : run.execution.toUpperCase();
  const steps = run.steps.length ? `<h2>Steps (${e(coverageLine(run))})</h2>${table(['Step', 'Kind', 'Status'],
    run.steps.map(s => [cell(s.id), cell(s.kind), cell(s.status, s.status === 'passed' || s.status === 'cached' ? 'PASS' : s.status === 'not-run' || s.status === 'skipped' ? 'warning' : 'BLOCK')]))}` : '';
  const gates = run.gates.length ? `<h2>Gates</h2>${table(['Gate', 'Decision', 'Execution', 'Exit', 'Duration, ms'],
    run.gates.map(g => [cell(g.id), cell(g.decision, g.decision), cell(g.skipped ? `skipped (${g.skipped})` : g.cached ? 'cached' : g.execution), cell(g.exitCode ?? '—'), cell(g.durationMs)]))}` : '';
  const audits = run.results.length ? `<h2>URL audits</h2>${table(['URL', 'Decision', 'Execution', 'Scores'],
    run.results.map(a => [cell(a.url), cell(a.decision, a.decision), cell(a.execution), cell(JSON.stringify(a.scores))]))}` : '';
  const findings = run.findings.length ? `<ul>${run.findings.map(f => `<li><strong class="${f.severity}">${f.severity}</strong> <code>${e(f.file ?? f.gateId)}${f.line ? `:${f.line}` : ''}</code>: ${e(f.message)}${f.ruleId ? ` (${e(f.ruleId)})` : ''}${f.evidencePath ? `<br><small>Evidence: ${e(f.evidencePath)}</small>` : ''}</li>`).join('')}</ul>` : '<p>No findings.</p>';
  const details = [
    ...run.gates.flatMap(g => [...g.errors.map(m => `<li>Gate ${e(g.id)}: ${e(m)}</li>`),
      ...(g.decision === 'BLOCK' && g.outputTail ? [`<li>Output of ${e(g.id)}:<pre>${e(g.outputTail)}</pre></li>`] : []),
      ...((g.reportPath ?? g.evidencePath) ? [`<li><small>Evidence (${e(g.id)}): ${e((g.reportPath ?? g.evidencePath)!)}</small></li>`] : [])]),
    ...run.results.flatMap(a => [...[...a.violations, ...a.errors].map(m => `<li>${e(a.url)}: ${e(m)}</li>`),
      ...(a.evidencePath ? [`<li><small>Evidence (${e(a.url)}): ${e(a.evidencePath)}</small></li>`] : [])]),
    ...run.errors.map(m => `<li>Run error: ${e(m)}</li>`)];
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>QualityGate ${e(title)}</title><style>${css}</style></head><body><main>
<h1>QualityGate: <span class="${run.decision}">${e(title)}</span></h1>
<p>Run ${e(run.runId)} · finished ${e(run.finishedAt)} · decision ${run.decision}, execution ${run.execution}, exit ${exitCode(run)}</p>
${steps}${gates}${audits}<h2>Findings (${run.findings.length})</h2>${findings}${details.length ? `<h2>Details</h2><ul>${details.join('')}</ul>` : ''}
<p><small>Static export. Output and evidence paths may contain sensitive project data.</small></p></main></body></html>\n`;
}
