import { runResultSchema, exitCode, countsLine, coverageLine, stripAnsi, type RunResult } from '../../protocol/src/index.js';
/** Treat report/tool text as data: no injected HTML, marker comments or mentions. */
export function markdownText(value: string): string {
  return stripAnsi(value).replace(/[\\*_{}[\]()#!]/g, '\\$&').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('@', '&#64;').replaceAll('|', '&#124;').replaceAll('`', '&#96;')
    .replace(/\r?\n/g, '<br>');
}
function gateRows(run: RunResult) {
  return run.gates.map(gate => `| ${markdownText(gate.id)} | ${gate.decision} | ${gate.skipped ? `skipped (${markdownText(gate.skipped)})` : gate.cached ? 'cached' : gate.execution} | ${gate.exitCode ?? '—'} | ${gate.durationMs} |`);
}
function stepRows(run: RunResult) {
  return run.steps.map(step => `| ${markdownText(step.id)} | ${step.kind} | ${step.status} |`);
}
function auditRows(run: RunResult) {
  return run.results.map(audit => `| ${markdownText(audit.url)} | ${audit.decision} | ${audit.execution} | ${markdownText(JSON.stringify(audit.scores))} |`);
}
function findingLines(run: RunResult) {
  return run.findings.flatMap(finding => [
    `- **${finding.severity}** ${markdownText(finding.file ?? finding.gateId)}${finding.line ? `:${finding.line}` : ''}: ${markdownText(finding.message)}${finding.ruleId ? ` (${markdownText(finding.ruleId)})` : ''}`,
    ...(finding.evidencePath ? [`  Evidence: ${markdownText(finding.evidencePath)}`] : []),
  ]);
}
function gateDetails(run: RunResult) {
  return run.gates.flatMap(gate => [
    ...(gate.counts ? [`- Gate ${markdownText(gate.id)}: ${countsLine(gate.counts)}`] : []),
    ...gate.errors.map(error => `- Gate ${markdownText(gate.id)}: ${markdownText(error)}`),
    ...(gate.decision === 'BLOCK' && gate.outputTail ? [`### Output: ${markdownText(gate.id)}\n\n${markdownText(gate.outputTail)}`] : []),
    ...(gate.reportPath ?? gate.evidencePath ? [`Evidence (${markdownText(gate.id)}): ${markdownText((gate.reportPath ?? gate.evidencePath)!)}`] : []),
  ]);
}
function auditDetails(run: RunResult) {
  return run.results.flatMap(audit => [
    ...[...audit.violations, ...audit.errors].map(reason => `- ${markdownText(audit.url)}: ${markdownText(reason)}`),
    ...(audit.evidencePath ? [`Evidence (${markdownText(audit.url)}): ${markdownText(audit.evidencePath)}`] : []),
  ]);
}
function bounded(sections: string[], maxBytes: number) {
  const lines: string[] = []; let size = 0;
  const truncated = '\n\n_Report truncated. Download CI artifacts for the complete result._\n';
  for (const section of sections) {
    const bytes = Buffer.byteLength(section) + 2;
    if (size + bytes + Buffer.byteLength(truncated) > maxBytes) return lines.join('\n\n') + truncated;
    lines.push(section); size += bytes;
  }
  return lines.join('\n\n') + '\n';
}
/** Full JSON remains the evidence; Markdown is a bounded, readable summary. */
export function renderMarkdown(input: RunResult, maxBytes = 60000): string {
  const run = runResultSchema.parse(input);
  const title = run.execution === 'completed' ? run.decision : run.execution.toUpperCase();
  const sections = [`## QualityGate: ${title}\n\nRun: ${markdownText(run.runId)}\n\nFinished: ${run.finishedAt}\n\nDecision: ${run.decision}; execution: ${run.execution}; exit: ${exitCode(run)}.\n`];
  if (run.steps.length) sections.push([`### Steps (${coverageLine(run)})\n\n| Step | Kind | Status |\n| --- | --- | --- |`, ...stepRows(run)].join('\n'));
  if (run.gates.length) sections.push(['### Gates\n\n| Gate | Decision | Execution | Exit | Duration, ms |\n| --- | --- | --- | --- | --- |', ...gateRows(run)].join('\n'));
  if (run.results.length) sections.push(['### URL audits\n\n| URL | Decision | Execution | Scores |\n| --- | --- | --- | --- |', ...auditRows(run)].join('\n'));
  sections.push(`### Findings (${run.findings.length})`, ...findingLines(run), ...gateDetails(run), ...auditDetails(run));
  sections.push(...run.errors.map(error => `- Run error: ${markdownText(error)}`));
  sections.push('See the CI artifacts for the complete JSON report and evidence.');
  return bounded(sections, maxBytes);
}
