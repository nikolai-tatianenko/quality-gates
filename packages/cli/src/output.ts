import type { RunResult, GateResult, Finding } from '../../protocol/src/index.js';
export function printRun(result: RunResult) {
  for (const item of result.gates) printGate(item);
  for (const finding of result.findings) printFinding(finding);
  for (const item of result.results) {
    console.log(`${item.decision} ${item.url} (${item.execution})`); console.log(`  Scores: ${JSON.stringify(item.scores)}`);
    for (const issue of [...item.violations, ...item.errors]) console.log(`  ${issue}`);
    if (item.evidencePath) console.log(`  Evidence: ${item.evidencePath}`);
  }
  for (const error of result.errors) console.error(error);
  console.log(`${result.decision} (${result.execution})`);
  if (result.reportPath) console.log(`Report: ${result.reportPath}`);
}

function printGate(item: GateResult) {
    console.log(`${item.decision} gate ${item.id} (${item.execution}, exit ${item.exitCode}, ${item.durationMs}ms)`);
    if (item.decision === 'BLOCK') for (const line of item.outputTail.trimEnd().split('\n').slice(-15)) console.log(`  | ${line}`);
    for (const issue of item.errors) console.log(`  ${issue}`);
    if (item.evidencePath) console.log(`  Evidence: ${item.evidencePath}`);

}

function printFinding(finding: Finding) {
  console.log(`${finding.severity.toUpperCase()} ${finding.file ?? finding.gateId}${finding.line ? `:${finding.line}` : ''} ${finding.ruleId ?? ''} ${finding.message}`);
}
