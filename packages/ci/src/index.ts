import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { runResultSchema, type RunResult } from '../../protocol/src/index.js';
import { renderMarkdown } from './report.js';
import { updateDescription, older } from './description.js';
import { commentMarker, commentBody, reportUrlSchema, slackMessage, slackTarget, statusPayload, verdict } from './notify.js';
import { renderHtml } from './html.js';
export { renderMarkdown, updateDescription, renderHtml };
export const forgeOptionsSchema = z.object({
  provider: z.enum(['github', 'gitlab', 'bitbucket']), repository: z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/).refine(value => value.split('/').every(part => part !== '.' && part !== '..')),
  number: z.coerce.number().int().positive(), head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  apiUrl: z.string().optional(), tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(), write: z.boolean().default(false),
}).strict();
export type ForgeOptions = z.infer<typeof forgeOptionsSchema>;
const defaults = { github: ['https://api.github.com', 'GITHUB_TOKEN'], gitlab: ['https://gitlab.com/api/v4', 'GITLAB_TOKEN'], bitbucket: ['https://api.bitbucket.org/2.0', 'BITBUCKET_TOKEN'] } as const;
function apiRoot(apiUrl: string | undefined, provider: ForgeOptions['provider']) {
  const base = new URL(apiUrl ?? defaults[provider][0]);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) || base.username || base.password || base.search || base.hash) throw new Error('Use an HTTPS API URL without credentials, query or fragment (HTTP only for loopback)');
  return base.href.replace(/\/$/, '');
}
function endpoint(options: ForgeOptions) {
  const root = apiRoot(options.apiUrl, options.provider);
  const parts = options.repository.split('/').map(encodeURIComponent);
  if (options.provider !== 'gitlab' && parts.length !== 2) throw new Error('Expected repository owner/name');
  const route = options.provider === 'github' ? `repos/${parts.join('/')}/pulls/${options.number}`
    : options.provider === 'gitlab' ? `projects/${encodeURIComponent(options.repository)}/merge_requests/${options.number}`
      : `repositories/${parts.join('/')}/pullrequests/${options.number}`;
  return `${root}/${route}`;
}
async function request(url: string, token: string, options: RequestInit, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' } });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`PR API returned HTTP ${response.status}`); }
  if (!response.body) return null;
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

const repositoryField = z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/).refine(value => value.split('/').every(part => part !== '.' && part !== '..'));
const tokenEnvField = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional();
export const statusOptionsSchema = z.object({ repository: repositoryField, head: forgeOptionsSchema.shape.head, reportUrl: reportUrlSchema.optional(), headRepository: repositoryField.optional(),
  apiUrl: z.string().optional(), tokenEnv: tokenEnvField, write: z.boolean().default(false) }).strict();
export const commentOptionsSchema = forgeOptionsSchema.extend({ reportUrl: reportUrlSchema.optional(), headRepository: repositoryField.optional() });
export const slackOptionsSchema = z.object({ webhookEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('SLACK_WEBHOOK_URL'), reportUrl: reportUrlSchema.optional(), write: z.boolean().default(false) }).strict();
/** Fork pull requests run untrusted code and must never reach a write token. */
function refuseFork(repository: string, headRepository?: string) {
  if (headRepository && headRepository.toLowerCase() !== repository.toLowerCase()) throw new Error(`Refusing fork pull request from ${headRepository}: publish only from a trusted same-repository job`);
}
function githubToken(tokenEnv: string | undefined) {
  const name = tokenEnv ?? defaults.github[1]; const token = process.env[name];
  if (!token) throw new Error(`Missing PR API token environment variable: ${name}`);
  return token;
}
function githubRepo(apiUrl: string | undefined, repository: string) {
  const parts = repository.split('/').map(encodeURIComponent);
  if (parts.length !== 2) throw new Error('Expected repository owner/name');
  return `${apiRoot(apiUrl, 'github')}/repos/${parts.join('/')}`;
}
/** Commit status for the reviewed SHA (needs `statuses: write`); the gate's exit code is untouched. */
export async function publishStatus(input: unknown, reportPath: string, signal: AbortSignal) {
  const options = statusOptionsSchema.parse(input); refuseFork(options.repository, options.headRepository);
  const url = `${githubRepo(options.apiUrl, options.repository)}/statuses/${options.head}`; const token = githubToken(options.tokenEnv);
  const payload = statusPayload(await readReport(reportPath), options.reportUrl);
  if (options.write) await request(url, token, { method: 'POST', body: JSON.stringify(payload) }, signal);
  return { write: options.write, payload };
}
async function ownComments(base: string, token: string, signal: AbortSignal) {
  const found: { id: number; body: string }[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = z.array(z.object({ id: z.number(), body: z.string().nullable() })).parse(await request(`${base}/comments?per_page=100&page=${page}`, token, { method: 'GET' }, signal));
    found.push(...batch.flatMap(comment => comment.body?.startsWith(commentMarker) ? [{ id: comment.id, body: comment.body }] : []));
    if (batch.length < 100) return found;
  }
  throw new Error('PR comment scan exceeds 1000 comments; refusing incomplete publication');
}
async function writeComment(issues: string, token: string, plan: { number: number; first?: { id: number; body: string }; extra: { id: number }[]; body: string }, signal: AbortSignal) {
  const send = (url: string, method: string) => request(url, token, { method, ...(method === 'DELETE' ? {} : { body: JSON.stringify({ body: plan.body }) }) }, signal);
  if (!plan.first) return void await send(`${issues}/${plan.number}/comments`, 'POST');
  if (plan.first.body !== plan.body) await send(`${issues}/comments/${plan.first.id}`, 'PATCH');
  for (const duplicate of plan.extra) await send(`${issues}/comments/${duplicate.id}`, 'DELETE');
}
/** One marker-tagged comment per PR, updated in place; duplicates are removed. Needs `pull-requests: write`. */
export async function publishComment(input: unknown, reportPath: string, signal: AbortSignal) {
  const options = commentOptionsSchema.parse(input); refuseFork(options.repository, options.headRepository);
  if (options.provider !== 'github') throw new Error('Sticky comments support GitHub only');
  const token = githubToken(options.tokenEnv); const current = parsePullRequest('github', await request(endpoint(options), token, { method: 'GET' }, signal));
  if (!current.open || current.head !== options.head) return { changed: false, reason: current.open ? 'stale-head' as const : 'closed' as const, write: false };
  const report = await readReport(reportPath); const metadata = { head: options.head, finishedAt: report.finishedAt, runId: report.runId };
  const body = commentBody(`Source commit: ${options.head}\n\n${renderMarkdown(report, 16000)}`, metadata, options.reportUrl);
  const issues = `${githubRepo(options.apiUrl, options.repository)}/issues`; const [first, ...extra] = await ownComments(`${issues}/${options.number}`, token, signal);
  if ([...(first ? [first] : []), ...extra].some(comment => older(comment.body, metadata))) return { changed: false, reason: 'older-run' as const, write: false };
  const reason = !first ? 'created' as const : first.body !== body || extra.length ? 'updated' as const : 'unchanged' as const;
  if (!options.write || reason === 'unchanged') return { changed: false, reason, write: false, body };
  await writeComment(issues, token, { number: options.number, first, extra, body }, signal);
  return { changed: true, reason, write: true };
}
/** Slack incoming webhook for BLOCK or error only. The URL is a secret: env var only, never printed. */
export async function notifySlack(input: unknown, reportPath: string, signal: AbortSignal) {
  const options = slackOptionsSchema.parse(input); const run = await readReport(reportPath);
  if (verdict(run).state === 'success') return { sent: false, reason: 'pass' as const };
  const target = slackTarget(process.env[options.webhookEnv], options.webhookEnv); const message = slackMessage(run, options.reportUrl);
  if (!options.write) return { sent: false, reason: 'dry-run' as const, message };
  let response: Response;
  try { response = await fetch(target, { method: 'POST', body: JSON.stringify(message), headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) }); }
  catch { throw new Error('Slack webhook request failed'); }
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Slack webhook returned HTTP ${response.status}`);
  return { sent: true, reason: 'sent' as const, message };
}
