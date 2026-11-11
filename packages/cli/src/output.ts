import { countsLine, coverageLine, type RunResult, type GateResult, type Finding } from '../../protocol/src/index.js';
/** npm, pnpm and Node warnings stay in the gate log; the terminal shows only what explains a failure. */
const NOISE = /^\s*(npm (warn|notice)|\S*\s*WARN\b|\(node:\d+\)|\(Use `node --trace-warnings)/i;
export function printRun(result: RunResult) {
  for (const item of result.gates) printGate(item);
  for (const finding of result.findings) printFinding(finding);
  for (const item of result.results) {
    console.log(`${item.decision} ${item.url} (${item.execution})`); console.log(`  Scores: ${JSON.stringify(item.scores)}`);
    for (const issue of [...item.violations, ...item.errors]) console.log(`  ${issue}`);
    if (item.evidencePath) console.log(`  Evidence: ${item.evidencePath}`);
  }
  for (const error of result.errors) console.error(error);
  if (result.steps.length) console.log(`Steps: ${coverageLine(result)}${notRun(result)}`);
  console.log(`${result.decision} (${result.execution})`);
  if (result.reportPath) console.log(`Report: ${result.reportPath}`);
}

function notRun(result: RunResult) {
  const missing = result.steps.filter(step => step.status === 'not-run').map(step => step.id);
  return missing.length ? ` (not run: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? `, +${missing.length - 8} more` : ''})` : '';
}

/** One line per gate with the path to its log; the output tail appears only for gates that did not pass. */
function printGate(item: GateResult) {
  const state = item.skipped ? `skipped: ${item.skipped}` : item.cached ? 'cached' : `${item.execution}, exit ${item.exitCode}, ${item.durationMs}ms`;
  console.log(`${item.decision} gate ${item.id} (${state})${item.evidencePath ? ` log: ${item.evidencePath}` : ''}`);
  if (item.decision === 'BLOCK' && !item.skipped) {
    const lines = item.outputTail.trimEnd().split('\n').filter(line => !NOISE.test(line));
    for (const line of lines.slice(-15)) console.log(`  | ${line}`);
  }
  if (item.counts) console.log(`  ${countsLine(item.counts)}`);
  for (const issue of item.errors) console.log(`  ${issue}`);
  for (const artifact of item.artifacts) console.log(`  Artifact: ${artifact}`);
}

function printFinding(finding: Finding) {
  console.log(`${finding.severity.toUpperCase()} ${finding.file ?? finding.gateId}${finding.line ? `:${finding.line}` : ''} ${finding.ruleId ?? ''} ${finding.message}`);
}
