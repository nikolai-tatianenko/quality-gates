import { z } from 'zod';
import type { ParserPlugin } from '../../../plugin-sdk/src/index.js';
import { findingSchema, type Finding } from '../../../protocol/src/index.js';
const level = z.enum(['info', 'low', 'moderate', 'high', 'critical']);
const advisorySchema = z.object({
  source: z.number().optional(), title: z.string().optional(), url: z.string().optional(), severity: level.optional(), range: z.string().optional(),
}).passthrough();
const vulnerabilitySchema = z.object({ name: z.string().min(1), severity: level, via: z.array(z.union([z.string(), advisorySchema])), range: z.string().optional() }).passthrough();
const reportSchema = z.object({ auditReportVersion: z.literal(2), vulnerabilities: z.record(z.string(), vulnerabilitySchema) }).passthrough();
const SEVERITY = { critical: 'error', high: 'error', moderate: 'warning', low: 'info', info: 'info' } as const;
/** The advisory id: the GHSA id from the advisory URL, else npm's numeric source id. */
const advisoryId = (advisory: z.infer<typeof advisorySchema>) => /GHSA(-[0-9a-z]{4}){3}/.exec(advisory.url ?? '')?.[0] ?? (advisory.source === undefined ? undefined : String(advisory.source));
/** `npm audit --json` (npm 7+, `auditReportVersion: 2`): one finding per advisory. Packages that are only vulnerable through another package are reported where the advisory is, unless that package is missing from the report. Error output (`{"error": ...}`) or the legacy format is an error, never "no vulnerabilities". */
export const npmAudit: ParserPlugin = { id: 'npm-audit', apiVersion: 1, kind: 'parser', parse(raw, { gateId }) {
  const report = reportSchema.parse(JSON.parse(raw));
  return Object.values(report.vulnerabilities).flatMap(pkg => {
    const range = pkg.range ? ` (${pkg.range})` : '';
    const advisories = pkg.via.filter((item): item is z.infer<typeof advisorySchema> => typeof item !== 'string');
    if (!pkg.via.length) return [{ gateId, severity: SEVERITY[pkg.severity], message: `${pkg.name}: vulnerable${range}` }];
    const missing = pkg.via.filter((item): item is string => typeof item === 'string' && !(item in report.vulnerabilities));
    if (!advisories.length && missing.length) return [{ gateId, severity: SEVERITY[pkg.severity], message: `${pkg.name}: vulnerable via ${missing.join(', ')}${range}` }];
    return advisories.map((advisory): Finding => {
      const helpUrl = findingSchema.shape.helpUrl.parse(advisory.url);
      const ruleId = advisoryId(advisory);
      return { gateId, severity: SEVERITY[advisory.severity ?? pkg.severity], message: `${pkg.name}: ${advisory.title ?? 'vulnerable'}${advisory.range ? ` (${advisory.range})` : range}`,
        ...(ruleId ? { ruleId } : {}), ...(helpUrl ? { helpUrl } : {}) };
    });
  });
} };
