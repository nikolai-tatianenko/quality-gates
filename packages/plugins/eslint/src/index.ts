import { relative, resolve } from 'node:path';
import { z } from 'zod';
import type { GatePlugin } from '../../../plugin-sdk/src/index.js';
import { message, type Finding } from '../../../protocol/src/index.js';
import { captureCommand } from '../../command/src/index.js';
const reportSchema = z.array(z.object({
  filePath: z.string(),
  messages: z.array(z.object({
    ruleId: z.string().nullable().optional(), severity: z.number().int().min(0).max(2),
    message: z.string().min(1), line: z.number().int().nullable().optional(),
    column: z.number().int().nullable().optional(), fatal: z.boolean().optional(),
  }).passthrough()),
}).passthrough());
export function parseEslintReport(raw: string, gateId: string, cwd: string): Finding[] {
  return reportSchema.parse(JSON.parse(raw)).flatMap(file => file.messages.map(item => ({
    gateId, severity: item.severity === 2 ? 'error' as const : item.severity === 1 ? 'warning' as const : 'info' as const,
    message: item.message, file: relative(cwd, resolve(cwd, file.filePath)).replaceAll('\\', '/'),
    ...(item.line && item.line > 0 ? { line: item.line } : {}),
    ...(item.column && item.column > 0 ? { column: item.column } : {}),
    ...(item.ruleId ? { ruleId: item.ruleId } : {}),
  })));
}
/** The project selects its own ESLint executable/version; require its JSON formatter. */
export function eslintPlugin(cwd: string): GatePlugin {
  return { id: 'eslint', apiVersion: 1, kind: 'gate', async run(spec, context) {
    const captured = await captureCommand(cwd, spec, context);
    let findings: Finding[] = [];
    let error = captured.error;
    if (!error) {
      if (captured.truncated) error = 'ESLint report exceeded the 1 MB capture limit';
      else {
        try { findings = parseEslintReport(captured.stdout, spec.id, cwd); }
        catch (cause) { error = `Invalid ESLint JSON report (use --format json): ${message(cause)}`; }
      }
      if (captured.exitCode !== 0 && captured.exitCode !== 1) error ??= `ESLint execution failed with exit ${captured.exitCode}`;
      if (captured.exitCode === 0 && findings.some(f => f.severity === 'error')) error ??= 'ESLint exited 0 but reported errors';
    }
    return { exitCode: captured.exitCode, output: captured.output, findings,
      rawReport: captured.stdout, error };
  } };
}
