import { z } from 'zod';
export const categories = ['performance', 'accessibility', 'seo', 'best-practices'] as const;
export const scoreSchema = z.number().finite().min(0).max(100);
export const thresholdsSchema = z.object({
  performance: scoreSchema, accessibility: scoreSchema, seo: scoreSchema,
  'best-practices': scoreSchema,
}).strict();
export const configSchema = z.object({
  schemaVersion: z.literal(1),
  urls: z.array(z.string().url().refine(u => ['http:', 'https:'].includes(new URL(u).protocol), 'Expected HTTP(S) URL')).min(1),
  thresholds: thresholdsSchema,
  outputDir: z.string().min(1).default('.qualitygate'),
  timeoutMs: z.number().int().min(1).max(600000).default(120000),
}).strict();
export const scoresSchema = thresholdsSchema.partial();
export const auditDataSchema = z.object({ scores: scoresSchema, raw: z.unknown().optional(), error: z.string().optional() }).strict();
export const auditResultSchema = z.object({
  url: z.string().url(), execution: z.enum(['completed', 'error', 'interrupted', 'skipped']),
  decision: z.enum(['PASS', 'BLOCK']), scores: scoresSchema,
  violations: z.array(z.string()), errors: z.array(z.string()), evidencePath: z.string().optional(),
}).strict();
export const runResultSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().min(1), startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(), execution: z.enum(['completed', 'error', 'interrupted']),
  decision: z.enum(['PASS', 'BLOCK']), thresholds: thresholdsSchema,
  results: z.array(auditResultSchema), errors: z.array(z.string()), reportPath: z.string().optional(),
}).strict();
export type Config = z.infer<typeof configSchema>;
export type Scores = z.infer<typeof scoresSchema>;
export type AuditData = z.infer<typeof auditDataSchema>;
export type AuditResult = z.infer<typeof auditResultSchema>;
export type RunResult = z.infer<typeof runResultSchema>;
export function exitCode(run: RunResult): number {
  return run.execution === 'interrupted' ? 130 : run.execution === 'error' ? 2 : run.decision === 'BLOCK' ? 1 : 0;
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export const cliErrorSchema = z.object({
  schemaVersion: z.literal(1), execution: z.enum(['error', 'interrupted']), errors: z.array(z.string()).min(1),
}).strict();
export const cliInitSchema = z.object({ schemaVersion: z.literal(1), configPath: z.string() }).strict();
export const cliHelpSchema = z.object({ schemaVersion: z.literal(1), help: z.string() }).strict();
export const cliOutputSchema = z.union([runResultSchema, cliErrorSchema, cliInitSchema, cliHelpSchema]);
