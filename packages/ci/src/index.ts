import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { runResultSchema, type RunResult } from '../../protocol/src/index.js';
import { renderMarkdown } from './report.js';
import { updateDescription } from './description.js';
import { renderHtml } from './html.js';
export { renderMarkdown, updateDescription, renderHtml };
export const forgeOptionsSchema = z.object({
  provider: z.enum(['github', 'gitlab', 'bitbucket']), repository: z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/).refine(value => value.split('/').every(part => part !== '.' && part !== '..')),
  number: z.coerce.number().int().positive(), head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  apiUrl: z.string().optional(), tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(), write: z.boolean().default(false),
}).strict();
export type ForgeOptions = z.infer<typeof forgeOptionsSchema>;
const defaults = { github: ['https://api.github.com', 'GITHUB_TOKEN'], gitlab: ['https://gitlab.com/api/v4', 'GITLAB_TOKEN'], bitbucket: ['https://api.bitbucket.org/2.0', 'BITBUCKET_TOKEN'] } as const;
function endpoint(options: ForgeOptions) {
  const base = new URL(options.apiUrl ?? defaults[options.provider][0]);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) || base.username || base.password || base.search || base.hash) throw new Error('Use an HTTPS API URL without credentials, query or fragment (HTTP only for loopback)');
  const parts = options.repository.split('/').map(encodeURIComponent);
  if (options.provider !== 'gitlab' && parts.length !== 2) throw new Error('Expected repository owner/name');
  const route = options.provider === 'github' ? `repos/${parts.join('/')}/pulls/${options.number}`
    : options.provider === 'gitlab' ? `projects/${encodeURIComponent(options.repository)}/merge_requests/${options.number}`
      : `repositories/${parts.join('/')}/pullrequests/${options.number}`;
  return `${base.href.replace(/\/$/, '')}/${route}`;
}
async function request(url: string, token: string, options: RequestInit, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' } });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`PR API returned HTTP ${response.status}`); }
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 1_000_000) { await reader.cancel(); throw new Error('PR API response exceeds 1 MB'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function parsePullRequest(provider: ForgeOptions['provider'], input: unknown) {
  if (provider === 'github') {
    const data = z.object({ body: z.string().nullable(), head: z.object({ sha: z.string() }), state: z.string() }).parse(input);
    return { body: data.body ?? '', head: data.head.sha, open: data.state === 'open' };
  }
  if (provider === 'gitlab') {
    const data = z.object({ description: z.string().nullable(), sha: z.string(), state: z.string() }).parse(input);
    return { body: data.description ?? '', head: data.sha, open: data.state === 'opened' };
  }
  const data = z.object({ description: z.string().nullable(), source: z.object({ commit: z.object({ hash: z.string() }) }), state: z.string() }).parse(input);
  return { body: data.description ?? '', head: data.source.commit.hash, open: data.state === 'OPEN' };
}
export async function readReport(path: string) {
  if ((await stat(path)).size > 5_000_000) throw new Error('Run report exceeds 5 MB');
  return runResultSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
/** Remote writes are explicit; never invoked automatically by run_gates or MCP. */
export async function publishDescription(input: unknown, reportPath: string, signal: AbortSignal) {
  const options = forgeOptionsSchema.parse(input); const url = endpoint(options);
  const tokenEnv = options.tokenEnv ?? defaults[options.provider][1]; const token = process.env[tokenEnv];
  if (!token) throw new Error(`Missing PR API token environment variable: ${tokenEnv}`);
  const report = await readReport(reportPath); const markdown = `Source commit: ${options.head}\n\n${renderMarkdown(report, 16000)}`;
  const read = async () => parsePullRequest(options.provider, await request(url, token, { method: 'GET' }, signal));
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await read();
    if (!current.open || current.head !== options.head) return { changed: false, reason: current.open ? 'stale-head' : 'closed', write: false };
    const updated = updateDescription(current.body, markdown, { head: options.head, finishedAt: report.finishedAt, runId: report.runId });
    if (!options.write || !updated.changed) return { ...updated, write: false };
    // Rebase on intervening edits; providers do not offer a portable atomic body CAS.
    const latest = await read();
    if (JSON.stringify(latest) !== JSON.stringify(current)) continue;
    const field = options.provider === 'github' ? 'body' : 'description';
    await request(url, token, { method: options.provider === 'github' ? 'PATCH' : 'PUT', body: JSON.stringify({ [field]: updated.body }) }, signal);
    return { changed: true, reason: 'updated', write: true };
  }
  throw new Error('PR changed during publication; retry in a serialized publisher job');
}
/** Static HTML report plus the validated JSON, written locally; nothing is uploaded. */
export async function exportReport(run: RunResult, outDir: string) {
  await mkdir(outDir, { recursive: true });
  const index = join(outDir, 'index.html');
  await writeFile(index, renderHtml(run)); await writeFile(join(outDir, 'report.json'), JSON.stringify(run, null, 2) + '\n');
  return { index, report: join(outDir, 'report.json') };
}
