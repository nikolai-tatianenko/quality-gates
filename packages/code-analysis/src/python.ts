import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relative, resolve } from 'node:path';
import { z } from 'zod';
import type { AnalysisFinding, AnalysisOptions } from './index.js';

const execute = promisify(execFile);
const reportSchema = z.array(z.object({
  filename: z.string(), code: z.string().nullable(), message: z.string(),
  location: z.object({ row: z.number().int().positive(), column: z.number().int().positive() }),
}));
/** An external Ruff binary is required; filenames are argv, never shell commands. */
export async function analyzePython(options: AnalysisOptions) {
  const cwd = options.cwd ?? process.cwd();
  const paths = (options.patterns ?? ['.']).map(path => resolve(cwd, path));
  if (!paths.length) throw new Error('Provide at least one Python path');
  let stdout: string;
  try {
    ({ stdout } = await execute(options.ruffPath ?? 'ruff', [
      'check', '--isolated', '--no-cache', '--no-fix', '--output-format', 'json',
      '--select', 'E4,E7,E9,F,C901,PLR0912,PLR0913,PLR0915',
      '--config', 'lint.mccabe.max-complexity=15', '--', ...paths,
    ], { cwd, maxBuffer: 1_000_000, timeout: 30000, signal: options.signal }));
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    if (failure.code !== 1 || typeof failure.stdout !== 'string') {
      throw new Error(`Ruff execution failed. Install Ruff >=0.9.2 and ensure it is on PATH. ${failure.stderr ?? String(error)}`, { cause: error });
    }
    stdout = failure.stdout;
  }
  const issues = reportSchema.parse(JSON.parse(stdout));
  const findings: AnalysisFinding[] = issues.map(issue => ({
    file: relative(cwd, issue.filename).replaceAll('\\', '/'), line: issue.location.row,
    column: issue.location.column, rule: issue.code, severity: 2, message: issue.message,
  }));
  const files = new Map<string, typeof findings>();
  for (const finding of findings) {
    const group = files.get(finding.file) ?? []; group.push(finding); files.set(finding.file, group);
  }
  const results = [...files].map(([file, messages]) => ({ filePath: resolve(cwd, file),
    messages: messages.map(issue => ({ ...issue, ruleId: issue.rule })), errorCount: messages.length, warningCount: 0 }));
  return { schemaVersion: 1 as const, decision: findings.length ? 'BLOCK' as const : 'PASS' as const, findings, results };
}
