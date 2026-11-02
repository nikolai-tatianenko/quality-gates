import type { ParserPlugin } from '../../../plugin-sdk/src/index.js';
import type { Finding } from '../../../protocol/src/index.js';
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): (error|warning) (CS\d+): (.+)$/;
/** Reads C# compiler diagnostics (`File.cs(line,col): error CS0000: text`) from a Unity log. */
export const unityLog: ParserPlugin = { id: 'unity-log', apiVersion: 1, kind: 'parser', parse(raw, { gateId }) {
  const seen = new Set<string>(); const findings: Finding[] = [];
  for (const text of raw.split(/\r?\n/)) {
    const match = DIAGNOSTIC.exec(text.trim());
    if (!match || seen.has(match[0])) continue;
    seen.add(match[0]);
    const [, file, line, column, severity, ruleId, detail] = match as unknown as string[];
    findings.push({ gateId, severity: severity as 'error' | 'warning', file: file!, line: Number(line), column: Number(column), ruleId, message: detail! });
  }
  return findings;
} };
