import { z } from 'zod';
import type { ParserPlugin } from '../../../plugin-sdk/src/index.js';
import type { Finding } from '../../../protocol/src/index.js';
const leakSchema = z.object({
  RuleID: z.string().min(1), File: z.string().min(1), StartLine: z.number().int().min(0), StartColumn: z.number().int().min(0).optional(),
  Description: z.string().optional(), Match: z.string().optional(), Secret: z.string().optional(),
}).passthrough();
/** Reads the report without ever putting its content into an error: a parse or shape problem names the field, not the value. */
function readLeaks(raw: string) {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new Error('Invalid gitleaks report: not valid JSON (truncated?)'); }
  const parsed = z.array(leakSchema).safeParse(data);
  if (!parsed.success) throw new Error(`Invalid gitleaks report: expected a list of findings with RuleID, File and StartLine (${parsed.error.issues.slice(0, 3).map(issue => issue.path.join('.') || 'report').join(', ')})`);
  return parsed.data;
}
/** gitleaks `--report-format json`: one error finding per leak with rule, file and line. `Match` and `Secret` are never copied anywhere; `secrets` lists them so the runner can scrub them from logs. An empty list is a clean scan, `null` or an object is an error. */
export const gitleaks: ParserPlugin = { id: 'gitleaks', apiVersion: 1, kind: 'parser',
  parse: (raw, { gateId }) => readLeaks(raw).map((leak): Finding => ({ gateId, severity: 'error', ruleId: leak.RuleID, file: leak.File,
    ...(leak.StartLine > 0 ? { line: leak.StartLine } : {}), ...(leak.StartColumn ? { column: leak.StartColumn } : {}),
    message: leak.Description || `Possible secret (${leak.RuleID})` })),
  secrets: raw => [...new Set(readLeaks(raw).flatMap(leak => [leak.Secret, leak.Match]).filter((value): value is string => !!value))] };
