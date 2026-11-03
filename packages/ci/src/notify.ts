import { z } from 'zod';
import { exitCode, type RunResult } from '../../protocol/src/index.js';
export const commentMarker = '<!-- qualitygate:comment -->';
/** Report links must be public HTTPS URLs without credentials; they are embedded in Markdown and Slack links, so characters that can end a link early are refused and the normalized form is used. */
export const reportUrlSchema = z.string().refine(value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !/[\s()<>|[\]]/.test(value); } catch { return false; } }, 'Use an HTTPS report URL without credentials, spaces or any of ( ) < > | [ ]').transform(value => new URL(value).href);
export type Verdict = { state: 'success' | 'failure' | 'error'; label: 'PASS' | 'BLOCK' | 'ERROR' | 'INTERRUPTED'; summary: string };
/** One verdict shared by commit status, comment and Slack. The CI exit code is never derived from it. */
export function verdict(run: RunResult): Verdict {
  const blocked = run.gates.filter(gate => gate.decision === 'BLOCK').map(gate => gate.id); const audits = run.results.filter(audit => audit.decision === 'BLOCK').length;
  const parts = [...(blocked.length ? [`gates ${blocked.slice(0, 5).join(', ')}${blocked.length > 5 ? `, +${blocked.length - 5} more` : ''}`] : []), ...(audits ? [`${audits} URL audit(s)`] : [])];
  const detail = parts.length ? `blocked: ${parts.join('; ')}` : `${run.gates.length + run.results.length} check(s)`;
  if (run.execution !== 'completed') return { state: 'error', label: run.execution === 'interrupted' ? 'INTERRUPTED' : 'ERROR', summary: `run ${run.execution}; exit ${exitCode(run)}` };
  return run.decision === 'PASS' ? { state: 'success', label: 'PASS', summary: `all gates passed (${detail})` } : { state: 'failure', label: 'BLOCK', summary: detail };
}
export function statusPayload(run: RunResult, reportUrl?: string) {
  const v = verdict(run);
  return { state: v.state, context: 'qualitygate', description: `QualityGate ${v.label}: ${v.summary}`.slice(0, 140), ...(reportUrl ? { target_url: reportUrl } : {}) };
}
/** Sticky comment body: marker first so the updater can find it, then freshness metadata and the bounded report. */
export function commentBody(markdown: string, metadata: { head: string; finishedAt: string; runId: string }, reportUrl?: string) {
  if (markdown.includes('<!-- qualitygate:')) throw new Error('Generated report contains reserved section markers');
  return `${commentMarker}\n<!-- qualitygate:metadata ${JSON.stringify(metadata)} -->\n${markdown.trimEnd()}${reportUrl ? `\n\n[Full report](${reportUrl})` : ''}\n`;
}
const slackText = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
/** Gate ids and counts only: tool output, errors and paths can carry secrets and stay out of chat. */
export function slackMessage(run: RunResult, reportUrl?: string) {
  const v = verdict(run);
  return { text: `QualityGate ${v.label}: ${slackText(v.summary)}${reportUrl ? ` <${reportUrl}|Report>` : ''}` };
}
export function slackTarget(value: string | undefined, name: string) {
  if (!value) throw new Error(`Missing Slack webhook environment variable: ${name}`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Slack webhook URL is invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Slack webhook URL must use HTTPS without credentials');
  return url;
}
