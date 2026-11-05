import { z } from 'zod';
import type { ParserPlugin } from '../../../plugin-sdk/src/index.js';
import type { Finding } from '../../../protocol/src/index.js';
interface Suite { specs?: Spec[]; suites?: Suite[] }
const specSchema = z.object({
  title: z.string(), file: z.string().optional(), line: z.number().int().positive().optional(), column: z.number().int().positive().optional(),
  tests: z.array(z.object({ results: z.array(z.object({ status: z.string(), error: z.object({ message: z.string() }).passthrough().optional() }).passthrough()) }).passthrough()),
}).passthrough();
type Spec = z.infer<typeof specSchema>;
const suiteSchema: z.ZodType<Suite> = z.lazy(() => z.object({ specs: z.array(specSchema).optional(), suites: z.array(suiteSchema).optional() }).passthrough());
const reportSchema = z.object({ suites: z.array(suiteSchema).optional() }).passthrough();
const FAILED = new Set(['failed', 'timedOut']);
/** Walks nested suites of a Playwright `--reporter=json` report; one finding per failing spec. */
export const playwrightJson: ParserPlugin = { id: 'playwright-json', apiVersion: 1, kind: 'parser', parse(raw, { gateId }) {
  const findings: Finding[] = [];
  const walk = (suite: Suite) => {
    for (const spec of suite.specs ?? []) {
      const failure = spec.tests.flatMap(test => test.results).find(result => FAILED.has(result.status));
      if (!failure) continue;
      findings.push({ gateId, severity: 'error', message: failure.error ? `${spec.title}: ${failure.error.message}` : spec.title,
        ...(spec.file ? { file: spec.file } : {}), ...(spec.line ? { line: spec.line } : {}), ...(spec.column ? { column: spec.column } : {}) });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of reportSchema.parse(JSON.parse(raw)).suites ?? []) walk(suite);
  return findings;
},
count(raw) {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  const walk = (suite: Suite) => {
    for (const spec of suite.specs ?? []) {
      const statuses = spec.tests.flatMap(test => test.results).map(result => result.status);
      if (statuses.some(status => FAILED.has(status))) counts.failed++;
      else if (statuses.length && statuses.every(status => status === 'skipped')) counts.skipped++;
      else counts.passed++;
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of reportSchema.parse(JSON.parse(raw)).suites ?? []) walk(suite);
  return counts;
} };
