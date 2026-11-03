import { z } from 'zod';
export const categories = ['performance', 'accessibility', 'seo', 'best-practices'] as const;
export const scoreSchema = z.number().finite().min(0).max(100);
export const thresholdsSchema = z.object({
  performance: scoreSchema, accessibility: scoreSchema, seo: scoreSchema,
  'best-practices': scoreSchema,
}).strict();
export const reviewSourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  repository: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/),
  ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).default('main'),
  path: z.string().regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/),
}).strict();
const gateId = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, 'Gate id: letters, digits, - and _');
const reportSpec = z.object({ format: z.string().regex(/^[a-z0-9-]+$/), path: z.string().min(1) }).strict();
const artifactGlobs = z.array(z.string().min(1)).max(50);
/** The command-gate subset an `ecosystem` plugin may propose to `qualitygate setup`. */
export const detectedGateSchema = z.object({
  id: gateId, run: z.string().min(1), timeoutMs: z.number().int().min(1).max(3600000).optional(),
  report: reportSpec.optional(), artifacts: artifactGlobs.optional(),
}).strict();
export type DetectedGate = z.infer<typeof detectedGateSchema>;
export const gateSchema = z.object({
  id: gateId,
  type: z.enum(['command', 'eslint', 'sonarqube', 'review']).default('command'),
  run: z.string().min(1),
  timeoutMs: z.number().int().min(1).max(3600000).optional(),
  sonar: z.object({
    serverUrl: z.string().url().refine(value => {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    }, 'Expected HTTP(S) server URL without credentials, query or fragment'),
    tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('SONAR_TOKEN'),
    taskFile: z.string().min(1).default('.scannerwork/report-task.txt'),
  }).strict().optional(),
  review: z.object({ sourceId: z.string().min(1) }).strict().optional(),
  report: reportSpec.optional(),
  artifacts: artifactGlobs.optional(),
}).strict().superRefine((gate, ctx) => {
  if (gate.type !== 'command' && (gate.report || gate.artifacts)) ctx.addIssue({ code: 'custom', message: 'report and artifacts are only for command gates' });
  if ((gate.type === 'sonarqube') !== !!gate.sonar) ctx.addIssue({ code: 'custom', message: 'sonar settings are required only for sonarqube gates' });
  if ((gate.type === 'review') !== !!gate.review) ctx.addIssue({ code: 'custom', message: 'review settings are required only for review gates' });
});
export const configSchema = z.object({
  schemaVersion: z.literal(1),
  urls: z.array(z.string().url().refine(u => ['http:', 'https:'].includes(new URL(u).protocol), 'Expected HTTP(S) URL')).default([]),
  thresholds: thresholdsSchema.optional(),
  gates: z.array(gateSchema).default([]),
  reviewSources: z.array(reviewSourceSchema).optional(),
  outputDir: z.string().min(1).default('.qualitygate'),
  timeoutMs: z.number().int().min(1).max(600000).default(120000),
  chrome: z.object({
    noSandbox: z.boolean().default(false),
    launchTimeoutMs: z.number().int().min(100).max(60000).default(10000),
  }).strict().default({}),
}).strict().superRefine((config, ctx) => {
  if (!config.urls.length && !config.gates.length) ctx.addIssue({ code: 'custom', message: 'Configure at least one URL or gate' });
  if (config.urls.length && !config.thresholds) ctx.addIssue({ code: 'custom', path: ['thresholds'], message: 'thresholds are required when urls are set' });
  const ids = config.gates.map(g => g.id.toLowerCase());
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['gates'], message: 'Duplicate gate id' });
  const sources = config.reviewSources ?? [];
  if (new Set(sources.map(source => source.id)).size !== sources.length) ctx.addIssue({ code: 'custom', path: ['reviewSources'], message: 'Duplicate review source id' });
  for (const gate of config.gates) if (gate.review && !sources.some(source => source.id === gate.review!.sourceId)) ctx.addIssue({ code: 'custom', message: `Unknown review source: ${gate.review.sourceId}` });
});
export const scoresSchema = thresholdsSchema.partial();
export const auditDataSchema = z.object({ scores: scoresSchema, raw: z.unknown().optional(), error: z.string().optional() }).strict();
export const auditResultSchema = z.object({
  url: z.string().url(), execution: z.enum(['completed', 'error', 'interrupted', 'skipped']),
  decision: z.enum(['PASS', 'BLOCK']), scores: scoresSchema,
  violations: z.array(z.string()), errors: z.array(z.string()), evidencePath: z.string().optional(),
}).strict();
export const findingSchema = z.object({
  gateId: z.string().min(1), severity: z.enum(['error', 'warning', 'info']),
  message: z.string().min(1), file: z.string().optional(),
  line: z.number().int().positive().optional(), column: z.number().int().positive().optional(),
  ruleId: z.string().optional(), evidencePath: z.string().optional(),
}).strict();
export const gateDataSchema = z.object({
  exitCode: z.number().int().nullable(), output: z.string(),
  findings: z.array(findingSchema).default([]), rawReport: z.string().optional(), error: z.string().optional(),
  artifacts: z.array(z.string()).default([]),
}).strict();
export const gateResultSchema = z.object({
  id: z.string(), command: z.string(), execution: z.enum(['completed', 'error', 'interrupted', 'skipped']),
  decision: z.enum(['PASS', 'BLOCK']), exitCode: z.number().int().nullable(), durationMs: z.number().min(0),
  outputTail: z.string(), errors: z.array(z.string()), evidencePath: z.string().optional(),
  reportPath: z.string().optional(), findings: z.array(findingSchema).default([]),
  artifacts: z.array(z.string()).default([]),
}).strict();
export const runResultSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().min(1), startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(), execution: z.enum(['completed', 'error', 'interrupted']),
  decision: z.enum(['PASS', 'BLOCK']), thresholds: thresholdsSchema.optional(),
  results: z.array(auditResultSchema), gates: z.array(gateResultSchema).default([]), errors: z.array(z.string()), reportPath: z.string().optional(),
  findings: z.array(findingSchema).default([]),
}).strict();
export type Config = z.infer<typeof configSchema>;
export type Scores = z.infer<typeof scoresSchema>;
export type AuditData = z.infer<typeof auditDataSchema>;
export type GateSpec = z.infer<typeof gateSchema>;
export type GateData = z.input<typeof gateDataSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type GateResult = z.infer<typeof gateResultSchema>;
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
