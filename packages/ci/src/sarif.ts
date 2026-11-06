import { runResultSchema, type Finding, type RunResult } from '../../protocol/src/index.js';
const LEVEL = { error: 'error', warning: 'warning', info: 'note' } as const;
const ruleOf = (finding: Finding) => finding.ruleId ?? finding.gateId;
function locations(finding: Finding) {
  if (!finding.file) return {};
  const region = finding.line ? { region: { startLine: finding.line, ...(finding.column ? { startColumn: finding.column } : {}) } } : {};
  return { locations: [{ physicalLocation: { artifactLocation: { uri: finding.file.replaceAll('\\', '/'), uriBaseId: '%SRCROOT%' }, ...region } }] };
}
/** SARIF 2.1.0 for GitHub code scanning: one result per finding, one rule per rule id (or gate id when the tool gave none). */
export function renderSarif(input: RunResult): string {
  const { findings } = runResultSchema.parse(input);
  const rules = new Map<string, { id: string; helpUri?: string }>();
  for (const finding of findings) {
    const rule = rules.get(ruleOf(finding)) ?? { id: ruleOf(finding) };
    if (finding.helpUrl) rule.helpUri ??= finding.helpUrl;
    rules.set(rule.id, rule);
  }
  const index = [...rules.keys()];
  const results = findings.map(finding => ({ ruleId: ruleOf(finding), ruleIndex: index.indexOf(ruleOf(finding)), level: LEVEL[finding.severity],
    message: { text: finding.message }, ...locations(finding) }));
  return JSON.stringify({ version: '2.1.0', $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    runs: [{ tool: { driver: { name: 'QualityGate', rules: [...rules.values()] } }, results }] }, null, 2) + '\n';
}
