import { posix, relative, isAbsolute } from 'node:path';
import { runResultSchema, type Finding, type RunResult } from '../../protocol/src/index.js';
const LEVEL = { error: 'error', warning: 'warning', info: 'note' } as const;
const ruleOf = (finding: Finding) => finding.ruleId ?? finding.gateId;
/** A repo-relative, forward-slash uri, or undefined when the path is absolute outside the project root or climbs out of it. */
function relativeUri(file: string, root: string): string | undefined {
  let path = file.replaceAll('\\', '/');
  if (/^([a-z]:|\/\/)/i.test(path)) return undefined;
  if (isAbsolute(path)) path = relative(root, path).replaceAll('\\', '/');
  const clean = posix.normalize(path);
  return clean === '.' || clean === '..' || clean.startsWith('../') ? undefined : encodeURI(clean).replaceAll('#', '%23').replaceAll('?', '%3F');
}
function locations(finding: Finding, root: string) {
  const uri = finding.file ? relativeUri(finding.file, root) : undefined;
  if (uri === undefined) return {};
  const region = finding.line ? { region: { startLine: finding.line, ...(finding.column ? { startColumn: finding.column } : {}) } } : {};
  return { locations: [{ physicalLocation: { artifactLocation: { uri, uriBaseId: '%SRCROOT%' }, ...region } }] };
}
/** Gates and audits that did not pass without a finding of their own, so a blocked or crashed run never reads as clean. */
function failures(run: RunResult): Finding[] {
  const gates = run.gates.filter(gate => (gate.decision !== 'PASS' || gate.execution !== 'completed') && !gate.findings.length)
    .map((gate): Finding => ({ gateId: gate.id, severity: gate.skipped ? 'info' : 'error',
      message: `Gate ${gate.id}: decision ${gate.decision}, execution ${gate.execution}${gate.skipped ? ` (${gate.skipped})` : ''}${gate.errors.length ? `: ${gate.errors.join('; ')}` : ''}` }));
  const audits = run.results.filter(audit => audit.decision !== 'PASS' || audit.execution !== 'completed')
    .map((audit): Finding => ({ gateId: 'lighthouse', severity: 'error',
      message: `${audit.url}: decision ${audit.decision}, execution ${audit.execution}: ${[...audit.violations, ...audit.errors].join('; ') || 'no detail'}` }));
  const own = run.errors.map((error): Finding => ({ gateId: 'qualitygate', severity: 'error', message: `Run ${run.execution}, decision ${run.decision}: ${error}` }));
  return [...gates, ...audits, ...own];
}
/** SARIF 2.1.0 for GitHub code scanning: one result per finding, file paths resolved against `root` (the project root, default the working directory), one rule per rule id (or gate id when the tool gave none). Gates that
 * ended BLOCK, error or timeout without findings appear as results (skipped ones as notes), and `executionSuccessful` is true only for a completed PASS run. */
export function renderSarif(input: RunResult, root = process.cwd()): string {
  const run = runResultSchema.parse(input);
  const findings = [...run.findings, ...failures(run)];
  const rules = new Map<string, { id: string; helpUri?: string }>();
  for (const finding of findings) {
    const rule = rules.get(ruleOf(finding)) ?? { id: ruleOf(finding) };
    if (finding.helpUrl) rule.helpUri ??= finding.helpUrl;
    rules.set(rule.id, rule);
  }
  const index = [...rules.keys()];
  const results = findings.map(finding => ({ ruleId: ruleOf(finding), ruleIndex: index.indexOf(ruleOf(finding)), level: LEVEL[finding.severity],
    message: { text: finding.message }, ...locations(finding, root) }));
  return JSON.stringify({ version: '2.1.0', $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    runs: [{ tool: { driver: { name: 'QualityGate', rules: [...rules.values()] } },
      invocations: [{ executionSuccessful: run.execution === 'completed' && run.decision === 'PASS' }], results }] }, null, 2) + '\n';
}
