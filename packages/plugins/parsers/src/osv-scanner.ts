import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { ParserPlugin } from '../../../plugin-sdk/src/index.js';
import type { Finding } from '../../../protocol/src/index.js';
const vulnerabilitySchema = z.object({
  id: z.string().min(1), aliases: z.array(z.string()).optional(), summary: z.string().optional(), details: z.string().optional(),
  database_specific: z.object({ severity: z.string().optional() }).passthrough().optional().catch(undefined),
}).passthrough();
const packageSchema = z.object({
  package: z.object({ name: z.string().min(1), version: z.string().min(1) }).passthrough(), vulnerabilities: z.array(vulnerabilitySchema).default([]),
  groups: z.array(z.object({ ids: z.array(z.string()).optional(), max_severity: z.string().optional() }).passthrough()).default([]),
}).passthrough();
const reportSchema = z.object({ results: z.array(z.object({ source: z.object({ path: z.string().min(1) }).passthrough(), packages: z.array(packageSchema) }).passthrough()) }).passthrough();
const NAMED = { critical: 'error', high: 'error', moderate: 'warning', medium: 'warning', low: 'info' } as const;
const fromScore = (score: number) => score >= 7 ? 'error' : score >= 4 ? 'warning' : 'info';
/** The advisory's own rating wins; otherwise the CVSS score osv-scanner computed for the group; otherwise a warning. */
function severityOf(vuln: z.infer<typeof vulnerabilitySchema>, pkg: z.infer<typeof packageSchema>): Finding['severity'] {
  const rating = vuln.database_specific?.severity?.toLowerCase();
  if (rating && Object.hasOwn(NAMED, rating)) return NAMED[rating as keyof typeof NAMED];
  const score = Number(pkg.groups.find(group => group.ids?.includes(vuln.id))?.max_severity);
  return Number.isFinite(score) ? fromScore(score) : 'warning';
}
/** `osv-scanner --format json`: one finding per vulnerable package and advisory; the id is the rule, aliases (CVE) go into the message. A report without `results` is an error, `{"results": []}` is a clean scan. */
export const osvScanner: ParserPlugin = { id: 'osv-scanner', apiVersion: 1, kind: 'parser', parse(raw, { gateId, cwd }) {
  return reportSchema.parse(JSON.parse(raw)).results.flatMap(result => {
    const path = relative(cwd, resolve(cwd, result.source.path));
    const file = path && !path.startsWith('..') && !isAbsolute(path) ? path : undefined;
    return result.packages.flatMap(pkg => pkg.vulnerabilities.map((vuln): Finding => {
      const text = vuln.summary ?? vuln.details?.split('\n')[0] ?? vuln.id;
      const aliases = vuln.aliases?.length ? ` (${vuln.aliases.join(', ')})` : '';
      return { gateId, severity: severityOf(vuln, pkg), ruleId: vuln.id, ...(file ? { file } : {}),
        message: `${pkg.package.name}@${pkg.package.version}: ${text}${aliases}`, helpUrl: `https://osv.dev/vulnerability/${encodeURIComponent(vuln.id)}` };
    }));
  });
} };
