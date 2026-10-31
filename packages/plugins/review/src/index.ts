import { z } from 'zod';
import type { GatePlugin } from '../../../plugin-sdk/src/index.js';
import { findingSchema, message } from '../../../protocol/src/index.js';
import { listSources, type ReviewSource } from '../../../review-sources/src/index.js';
import { captureCommand } from '../../command/src/index.js';
const finding = findingSchema.omit({ gateId: true, evidencePath: true });
export const reviewReportSchema = z.object({
  schemaVersion: z.literal(1), completed: z.literal(true),
  methodology: z.object({ id: z.string(), commit: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  findings: z.array(z.object({
    verdict: z.enum(['confirmed', 'needs_validation', 'rejected']), finding,
  }).strict()),
}).strict();
/** Runs a configured review producer; a methodology download alone is never a review. */
export function reviewPlugin(cwd: string, sources: ReviewSource[]): GatePlugin {
  return { id: 'review', apiVersion: 1, kind: 'gate', async run(spec, context) {
    const source = (await listSources(cwd, sources)).find(item => item.id === spec.review!.sourceId)!;
    const captured = await captureCommand(cwd, spec, context);
    let findings: z.infer<typeof findingSchema>[] = []; let error = captured.error; let exitCode = captured.exitCode;
    try {
      if (error || exitCode !== 0) throw new Error(error ?? `Review producer exited ${exitCode}`);
      if (captured.truncated) throw new Error('Review report exceeded the 1 MB capture limit');
      const report = reviewReportSchema.parse(JSON.parse(captured.stdout));
      if (report.methodology.id !== source.id || report.methodology.commit !== source.commit) throw new Error('Review methodology does not match the pinned source');
      findings = report.findings.map(item => ({ ...item.finding, gateId: spec.id,
        severity: item.verdict === 'rejected' ? 'info' : item.verdict === 'needs_validation' ? 'warning' : item.finding.severity,
        message: `[${item.verdict}] ${item.finding.message}` }));
      // Unresolved candidates block by default, even if their supplied severity is informational.
      exitCode = report.findings.some(item => item.verdict === 'needs_validation' || (item.verdict === 'confirmed' && item.finding.severity !== 'info')) ? 1 : 0;
    } catch (cause) { error = message(cause); }
    return { exitCode, output: captured.output, findings, rawReport: JSON.stringify({ source, producerOutput: captured.stdout }), error };
  } };
}
