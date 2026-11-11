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
const pluginId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Plugin id: lowercase letters, digits, - and _');
const gateId = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, 'Gate id: letters, digits, - and _');
const reportSpec = z.object({ format: z.string().regex(/^[a-z0-9-]+$/), path: z.string().min(1) }).strict();
const artifactGlobs = z.array(z.string().min(1)).max(50);
const fixCommand = z.string().min(1);
/** The command-gate subset an `ecosystem` plugin may propose to `qualitygate setup`. */
export const detectedGateSchema = z.object({
  id: gateId, run: z.string().min(1), timeoutMs: z.number().int().min(1).max(3600000).optional(),
  report: reportSpec.optional(), artifacts: artifactGlobs.optional(),
  /** Command that repairs what the gate reports (for example `eslint . --fix`); see `qualitygate fix`. */
  fix: fixCommand.optional(),
  /** Found but not enabled: setup lists the gate as a commented block with this reason (slow, needs a browser, needs an emulator). */
  skip: z.string().min(1).optional(),
  /** Advice printed by setup (for example a run that will not fit the timeout); never written to the config. */
  note: z.string().min(1).optional(),
}).strict();
export type DetectedGate = z.infer<typeof detectedGateSchema>;
export const gateSchema = z.object({
  id: gateId,
  /** Built-in `command`, `eslint`, `sonarqube`, `review`, or the id of a third-party gate plugin. */
  type: pluginId.default('command'),
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
  /**
   * Shell command that rewrites files to repair what this gate reports, run only by `qualitygate fix` and the interactive UI,
   * with the same trust and working directory as `run`. It never changes a verdict: the gate is run again and that result counts.
   */
  fix: fixCommand.optional(),
  /** Gates that must pass first; a gate whose dependency did not pass is skipped. Independent gates run in parallel. */
  dependsOn: z.array(gateId).max(50).optional(),
  /** Project-relative globs of the files this gate reads: used by `--changed` and `--cache`. */
  inputs: z.array(z.string().min(1)).max(50).optional(),
}).strict().superRefine((gate, ctx) => {
  if (gate.type !== 'command' && gate.fix) ctx.addIssue({ code: 'custom', message: 'fix is only for command gates' });
  if (gate.type !== 'command' && (gate.report || gate.artifacts)) ctx.addIssue({ code: 'custom', message: 'report and artifacts are only for command gates' });
  if ((gate.type === 'sonarqube') !== !!gate.sonar) ctx.addIssue({ code: 'custom', message: 'sonar settings are required only for sonarqube gates' });
  if ((gate.type === 'review') !== !!gate.review) ctx.addIssue({ code: 'custom', message: 'review settings are required only for review gates' });
});
function checkDependencies(gates: { id: string; dependsOn?: string[] }[], ctx: z.RefinementCtx) {
  const known = new Set(gates.map(gate => gate.id.toLowerCase()));
  for (const gate of gates) for (const dependency of gate.dependsOn ?? [])
    if (!known.has(dependency.toLowerCase())) ctx.addIssue({ code: 'custom', path: ['gates'], message: `Gate ${gate.id} depends on unknown gate: ${dependency}` });
  if (hasDependencyCycle(gates)) ctx.addIssue({ code: 'custom', path: ['gates'], message: 'Gate dependencies form a cycle' });
}
/** Depth-first search over `dependsOn`; a gate that depends on itself is a cycle. */
function hasDependencyCycle(gates: { id: string; dependsOn?: string[] }[]): boolean {
  const edges = new Map(gates.map(gate => [gate.id.toLowerCase(), (gate.dependsOn ?? []).map(id => id.toLowerCase())]));
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 'open') return true;
    if (state.get(id) === 'done') return false;
    state.set(id, 'open');
    const cyclic = (edges.get(id) ?? []).some(visit);
    state.set(id, 'done');
    return cyclic;
  };
  return [...edges.keys()].some(visit);
}
export const packageName = z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, 'Expected an npm package name');
export const configSchema = z.object({
  schemaVersion: z.literal(1),
  /** npm packages resolved from the project's node_modules; they run unsandboxed with your permissions. */
  plugins: z.array(packageName).max(20).optional(),
  urls: z.array(z.string().url().refine(u => ['http:', 'https:'].includes(new URL(u).protocol), 'Expected HTTP(S) URL')).default([]),
  thresholds: thresholdsSchema.optional(),
  gates: z.array(gateSchema).default([]),
  reviewSources: z.array(reviewSourceSchema).optional(),
  outputDir: z.string().min(1).default('.qualitygate'),
  timeoutMs: z.number().int().min(1).max(600000).default(120000),
  /** How many independent gates run at once; `dependsOn` still orders them. Use 1 for strictly sequential runs. */
  concurrency: z.number().int().min(1).max(16).default(4),
  chrome: z.object({
    noSandbox: z.boolean().default(false),
    launchTimeoutMs: z.number().int().min(100).max(60000).default(10000),
  }).strict().default({ noSandbox: false, launchTimeoutMs: 10000 }),
}).strict().superRefine((config, ctx) => {
  if (!config.urls.length && !config.gates.length) ctx.addIssue({ code: 'custom', message: 'Configure at least one URL or gate' });
  if (config.urls.length && !config.thresholds) ctx.addIssue({ code: 'custom', path: ['thresholds'], message: 'thresholds are required when urls are set' });
  if (new Set(config.plugins).size !== (config.plugins ?? []).length) ctx.addIssue({ code: 'custom', path: ['plugins'], message: 'Duplicate plugin package' });
  const ids = config.gates.map(g => g.id.toLowerCase());
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['gates'], message: 'Duplicate gate id' });
  const sources = config.reviewSources ?? [];
  if (new Set(sources.map(source => source.id)).size !== sources.length) ctx.addIssue({ code: 'custom', path: ['reviewSources'], message: 'Duplicate review source id' });
  checkDependencies(config.gates, ctx);
  for (const gate of config.gates) if (gate.review && !sources.some(source => source.id === gate.review!.sourceId)) ctx.addIssue({ code: 'custom', message: `Unknown review source: ${gate.review.sourceId}` });
});
const callable = z.custom<(...args: never[]) => unknown>(value => typeof value === 'function', 'Expected a function');
const pluginBase = { apiVersion: z.literal(1), id: pluginId };
/** Third-party plugin kinds; functions are checked here, behaviour is the plugin's own. */
export const externalPluginSchema = z.discriminatedUnion('kind', [
  z.object({ ...pluginBase, kind: z.literal('parser'), parse: callable }).passthrough(),
  z.object({ ...pluginBase, kind: z.literal('ecosystem'), detect: callable }).passthrough(),
  z.object({ ...pluginBase, kind: z.literal('gate'), run: callable }).passthrough(),
]);
export const pluginPackageSchema = z.object({ apiVersion: z.literal(1), plugins: z.array(externalPluginSchema).min(1).max(50) }).passthrough();
export const scoresSchema = thresholdsSchema.partial();
export const auditDataSchema = z.object({ scores: scoresSchema, raw: z.unknown().optional(), error: z.string().optional() }).strict();
export const auditResultSchema = z.object({
  url: z.string().url(), execution: z.enum(['completed', 'error', 'interrupted', 'skipped']),
  decision: z.enum(['PASS', 'BLOCK']), scores: scoresSchema,
  violations: z.array(z.string()), errors: z.array(z.string()), evidencePath: z.string().optional(),
}).strict();
const isHttpUrl = (value: string) => URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol);
export const findingSchema = z.object({
  gateId: z.string().min(1), severity: z.enum(['error', 'warning', 'info']),
  message: z.string().min(1), file: z.string().optional(),
  line: z.number().int().positive().optional(), column: z.number().int().positive().optional(),
  ruleId: z.string().optional(), evidencePath: z.string().optional(),
  /** Documentation for the rule, when the tool provides one (axe-core `helpUrl`); anything but an http(s) URL is dropped, not an error. */
  helpUrl: z.string().refine(isHttpUrl).optional().catch(undefined),
}).strict();
/** Test counts a report parser could read; on a timeout they show how far the run got. */
export const countsSchema = z.object({ passed: z.number().int().min(0), failed: z.number().int().min(0), skipped: z.number().int().min(0) }).strict();
export const gateDataSchema = z.object({
  exitCode: z.number().int().nullable(), output: z.string(),
  findings: z.array(findingSchema).default([]), rawReport: z.string().optional(), error: z.string().optional(),
  artifacts: z.array(z.string()).default([]),
  /** The command ran out of time; `error` carries the message. */
  timedOut: z.boolean().optional(), counts: countsSchema.optional(),
}).strict();
export const gateResultSchema = z.object({
  id: z.string(), command: z.string(), execution: z.enum(['completed', 'error', 'timeout', 'interrupted', 'skipped']),
  decision: z.enum(['PASS', 'BLOCK']), exitCode: z.number().int().nullable(), durationMs: z.number().min(0),
  outputTail: z.string(), errors: z.array(z.string()), evidencePath: z.string().optional(),
  reportPath: z.string().optional(), findings: z.array(findingSchema).default([]),
  artifacts: z.array(z.string()).default([]),
  counts: countsSchema.optional(),
  /** Why the gate did not run: a dependency did not pass. */
  skipped: z.string().optional(),
  /** Passed without running because its `inputs` are unchanged since a passing run (`--cache`). */
  cached: z.boolean().optional(),
}).strict();
export const stepStatuses = ['passed', 'failed', 'timeout', 'error', 'interrupted', 'skipped', 'cached', 'not-run'] as const;
/** One line of the step registry: every configured gate and URL appears, including those that did not run. */
export const stepSchema = z.object({ id: z.string(), kind: z.enum(['gate', 'url']), status: z.enum(stepStatuses) }).strict();
export const runResultSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().min(1), startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(), execution: z.enum(['completed', 'error', 'timeout', 'interrupted']),
  decision: z.enum(['PASS', 'BLOCK']), thresholds: thresholdsSchema.optional(),
  results: z.array(auditResultSchema), gates: z.array(gateResultSchema).default([]), errors: z.array(z.string()), reportPath: z.string().optional(),
  findings: z.array(findingSchema).default([]),
  /** Registry of every configured step, so a verdict built from 3 of 30 gates says so. */
  steps: z.array(stepSchema).default([]),
}).strict();
export type Config = z.infer<typeof configSchema>;
export type Scores = z.infer<typeof scoresSchema>;
export type AuditData = z.infer<typeof auditDataSchema>;
export type GateSpec = z.infer<typeof gateSchema>;
export type GateData = z.input<typeof gateDataSchema>;
export type Counts = z.infer<typeof countsSchema>;
export type Step = z.infer<typeof stepSchema>;
export type StepStatus = Step['status'];
export type Finding = z.infer<typeof findingSchema>;
export type GateResult = z.infer<typeof gateResultSchema>;
export type AuditResult = z.infer<typeof auditResultSchema>;
export type RunResult = z.infer<typeof runResultSchema>;
/** Exit codes: 0 PASS, 1 BLOCK, 2 error, 3 a gate timed out, 130 interrupted. An error outranks a timeout. */
export const EXIT = { pass: 0, block: 1, error: 2, timeout: 3, interrupted: 130 } as const;
export function exitCode(run: RunResult): number {
  if (run.execution === 'interrupted') return EXIT.interrupted;
  if (run.execution === 'error') return EXIT.error;
  if (run.execution === 'timeout') return EXIT.timeout;
  return run.decision === 'BLOCK' ? EXIT.block : EXIT.pass;
}
/** The registry status of one finished gate or audit. */
export function stepStatus(item: { execution: string; decision: string; skipped?: string; cached?: boolean }): StepStatus {
  if (item.execution === 'timeout' || item.execution === 'interrupted' || item.execution === 'error') return item.execution;
  if (item.execution === 'skipped' || item.skipped) return 'skipped';
  if (item.cached) return 'cached';
  return item.decision === 'PASS' ? 'passed' : 'failed';
}
/** One line saying how much of the configuration ran, for example "3 of 30 steps ran". */
export function coverageLine(run: Pick<RunResult, 'steps'>): string {
  const ran = run.steps.filter(step => step.status !== 'not-run').length;
  return `${ran} of ${run.steps.length} steps ran`;
}
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
/** Text without ANSI escape sequences (colors, cursor moves, hyperlinks). */
export const stripAnsi = (text: string): string => text.replace(ANSI, '');
/** First `at fn (file:///x.mjs:1:2)` or `at /x.ts:1:2` frame of a Node style stack, flattened onto one line or not. */
const STACK_FRAME = /(?:^|\s)at (?:async )?(?:[^\s(]+ \()?(?:file:\/\/|node:|\/|[A-Za-z]:[\\/]|\.{1,2}\/)[^\s)]*:\d+:\d+\)?/;
/**
 * A finding message as a person reads it: ANSI escape sequences removed and, when the text carries a stack trace (even one
 * flattened to a single line), only its first meaningful line. The full text stays in the gate log and the report artifact.
 */
export function tidyMessage(text: string): string {
  const plain = stripAnsi(text).trim();
  const frame = STACK_FRAME.exec(plain);
  if (!frame) return plain || text;
  const lines = (line: string) => line.split(/\r?\n/).map(part => part.trim()).filter(Boolean);
  return lines(plain.slice(0, frame.index))[0] ?? lines(plain)[0] ?? text;
}
/** "56 tests passed", or the split when something failed or was skipped; shown next to a gate that parsed a test report. */
export function countsLine({ passed, failed, skipped }: Counts): string {
  const total = passed + failed + skipped;
  if (!failed && !skipped) return `${total} ${total === 1 ? 'test' : 'tests'} passed`;
  return `${total} tests: ${passed} passed, ${failed} failed, ${skipped} skipped`;
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export const cliErrorSchema = z.object({
  schemaVersion: z.literal(1), execution: z.enum(['error', 'interrupted']), errors: z.array(z.string()).min(1),
}).strict();
export const cliInitSchema = z.object({ schemaVersion: z.literal(1), configPath: z.string() }).strict();
export const cliHelpSchema = z.object({ schemaVersion: z.literal(1), help: z.string() }).strict();
/** `qualitygate fix --json`: what each fix command did and the decision of every re-run gate before and after. */
export const fixResultSchema = z.object({
  schemaVersion: z.literal(1),
  gates: z.array(z.object({
    id: z.string(), fix: z.string(), fixExitCode: z.number().int().nullable(), fixError: z.string().optional(),
    before: z.enum(['PASS', 'BLOCK']).optional(), after: z.enum(['PASS', 'BLOCK']).optional(),
  }).strict()),
  /** `git diff --stat` after the fixes; absent outside a git repository. */
  diffStat: z.string().optional(), warnings: z.array(z.string()),
  run: runResultSchema,
}).strict();
export type FixResult = z.infer<typeof fixResultSchema>;
export const cliOutputSchema = z.union([runResultSchema, cliErrorSchema, cliInitSchema, cliHelpSchema]);
