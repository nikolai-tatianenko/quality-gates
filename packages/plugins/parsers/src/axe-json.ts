import { z } from 'zod';
import type { ParserPlugin } from '../../../plugin-sdk/src/index.js';
import type { Finding } from '../../../protocol/src/index.js';
const violationSchema = z.object({
  id: z.string().min(1), impact: z.string().nullable().optional(), help: z.string().optional(), description: z.string().optional(), helpUrl: z.string().url().optional(),
  nodes: z.array(z.object({ target: z.array(z.union([z.string(), z.array(z.string())])).optional() }).passthrough()).default([]),
}).passthrough();
const resultSchema = z.object({ violations: z.array(violationSchema).default([]) }).passthrough();
const SEVERITY = { critical: 'error', serious: 'error', moderate: 'warning', minor: 'info' } as const;
/** axe-core results (one object, or the list `@axe-core/cli` writes for several pages); one finding per violating node. */
export const axeJson: ParserPlugin = { id: 'axe-json', apiVersion: 1, kind: 'parser', parse(raw, { gateId }) {
  const data: unknown = JSON.parse(raw);
  return z.array(resultSchema).parse(Array.isArray(data) ? data : [data]).flatMap(page => page.violations.flatMap(violation => {
    const severity = SEVERITY[violation.impact as keyof typeof SEVERITY] ?? 'warning';
    const text = violation.help ?? violation.description ?? violation.id;
    const selectors = violation.nodes.length ? violation.nodes.map(node => (node.target ?? []).flat().join(' ')) : [''];
    return selectors.map((selector): Finding => ({ gateId, severity, ruleId: violation.id, message: selector ? `${text} (${selector})` : text,
      ...(violation.helpUrl ? { helpUrl: violation.helpUrl } : {}) }));
  }));
} };
