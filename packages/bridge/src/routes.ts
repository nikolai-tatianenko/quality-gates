import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { message, type RunResult } from '../../protocol/src/index.js';
import { getRun, readRun, teamView, visualImage, visualView } from '../../service/src/index.js';
import { loadConfig } from '../../cli/src/runner.js';
import { compareRuns, readRuns, trends } from '../../core/src/history.js';
import { VisualImageError } from '../../core/src/visual.js';
import { HttpError, Image, parse, parseJson, type Reply, type Route } from './http.js';
import type { Jobs } from './jobs.js';
import type { TokenStore } from './tokens.js';
import type { RateLimiter } from './limits.js';
import { listArtifacts, publicFinding, publicRun } from './view.js';

/** What the bridge needs from the runner. The default is the same service the MCP server and the dashboard use. */
export interface BridgeService {
  list(): Promise<{ gates: { id: string }[] }>;
  run(args: { gates: string[] }, signal?: AbortSignal): Promise<RunResult>;
  scan(url: string, signal?: AbortSignal): Promise<RunResult>;
  close(): Promise<void>;
}
export interface RouteDeps { configPath: string; store: TokenStore; service: BridgeService; jobs: Jobs; pairLimiter: RateLimiter; onError?: (error: unknown) => void }

const pairSchema = z.object({ code: z.string().min(1).max(32), label: z.string().min(1).max(64).optional() }).strict();
const runSchema = z.object({ gates: z.array(z.string().min(1).max(128)).min(1).max(100) }).strict();
const scanSchema = z.object({ url: z.string().max(2048).refine(isScannable, 'Expected an http(s) URL without credentials') }).strict();
const limitQuery = (fallback: number, max: number) => z.coerce.number().int().min(1).max(max).default(fallback);
const safeName = (name: string) => name.length > 0 && name.length <= 255 && !/[/\\\0]/.test(name) && !name.startsWith('.');

/** Only web pages: no file:, javascript:, chrome: or data: schemes and no embedded credentials. */
function isScannable(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
}

/** Reads project data fresh on each request, so a config edited while the bridge runs is honoured. */
class Project {
  constructor(private deps: RouteDeps) {}
  get configPath() { return this.deps.configPath; }
  config = async () => (await loadConfig(this.deps.configPath)).config;
  outputDir = async () => (await this.config()).outputDir;
  async run(id: string): Promise<RunResult> {
    try { return id === 'latest' ? await getRun(this.deps.configPath) : await readRun(await this.outputDir(), id); }
    catch (error) {
      const text = message(error);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || text === 'No runs found') throw new HttpError(404, 'Run not found');
      if (text === 'Invalid run ID') throw new HttpError(400, text);
      throw error;
    }
  }
  /** A listed artifact of a run, read only when it is a regular file directly inside that run's own directory. */
  async artifact(id: string, name: string): Promise<Buffer> {
    if (!safeName(name)) throw new HttpError(400, 'Invalid artifact name');
    const run = await this.run(id);
    if (!listArtifacts(run).some(item => item.name === name)) throw new HttpError(404, 'Artifact not found');
    const file = join(await this.outputDir(), run.runId, name);
    // lstat does not follow links: a symlink planted in the run directory is not a file and is refused.
    if (!(await lstat(file).catch(() => undefined))?.isFile()) throw new HttpError(404, 'Artifact not found');
    return readFile(file);
  }
  async history(limit: number) {
    try { return await readRuns(await this.outputDir(), limit); }
    catch (error) { this.deps.onError?.(error); throw new HttpError(503, 'Run history is unreadable'); }
  }
}

const visualQuery = z.object({ run: z.string().max(64).optional(), name: z.string().max(255).optional(), image: z.string().max(16).optional() });
/**
 * `GET /v1/visual`: the visual comparison of the latest run (or `?run=`); with `?name=&image=approved|current|diff&run=` one
 * screenshot the run lists, as image/png. A project without the plugin gets `{enabled: false, items: []}`.
 */
async function visual(c: { url: URL }, configPath: string): Promise<Reply> {
  const query = parse(visualQuery, Object.fromEntries(c.url.searchParams));
  try {
    if (query.name === undefined) return [200, await visualView(configPath, query.run)];
    return [200, new Image(await visualImage(configPath, query.run ?? '', query.name, query.image ?? ''))];
  } catch (error) {
    if (error instanceof VisualImageError) throw new HttpError(error.status, error.message);
    if (message(error) === 'Invalid run ID') throw new HttpError(400, 'Invalid run ID');
    throw error;
  }
}

function pairingRoutes({ store, pairLimiter }: RouteDeps): Route[] {
  return [
    { method: 'GET', path: ['v1', 'ping'], auth: false, handle: async () => [200, { name: 'qualitygate-bridge', apiVersion: 1 }] },
    { method: 'POST', path: ['v1', 'pair'], auth: false, handle: async c => {
      const wait = pairLimiter.hit(c.origin);
      if (wait) throw new HttpError(429, 'Too many pairing attempts', { 'Retry-After': String(wait) });
      const { code, label } = parse(pairSchema, parseJson(c.body));
      const paired = await store.pair(code, c.origin, label);
      if (!paired) throw new HttpError(401, 'Invalid or expired pairing code');
      return [200, { token: paired.token, tokenId: paired.record.id, origin: paired.record.origin, expiresAt: new Date(paired.record.expiresAt).toISOString() }];
    } },
    { method: 'DELETE', path: ['v1', 'token'], auth: true, handle: async c => { await store.revoke(c.tokenId!); return [200, { revoked: true }]; } },
  ];
}

function jobRoutes(deps: RouteDeps, project: Project): Route[] {
  const { service, jobs } = deps;
  return [
    { method: 'GET', path: ['v1', 'gates'], auth: true, handle: async () => {
      const config = await project.config();
      return [200, { gates: config.gates.map(g => ({ id: g.id, type: g.type })), scan: { available: !!config.thresholds, thresholds: config.thresholds } }];
    } },
    { method: 'POST', path: ['v1', 'runs'], auth: true, handle: async c => {
      const { gates } = parse(runSchema, parseJson(c.body));
      const known = (await service.list()).gates.map(g => g.id);
      const unknown = gates.filter(id => !known.includes(id));
      if (unknown.length) throw new HttpError(400, `Unknown gate: ${unknown.join(', ')}`);
      return [202, jobs.view(jobs.start('run', gates, signal => service.run({ gates }, signal)))];
    } },
    { method: 'POST', path: ['v1', 'scans'], auth: true, handle: async c => {
      const { url } = parse(scanSchema, parseJson(c.body));
      if (!(await project.config()).thresholds) throw new HttpError(409, 'No Lighthouse thresholds are configured for this project');
      return [202, jobs.view(jobs.start('scan', url, signal => service.scan(url, signal)))];
    } },
    { method: 'GET', path: ['v1', 'jobs', ':id'], auth: true, handle: async c => [200, jobs.view(jobs.find(c.params.id!))] },
    { method: 'POST', path: ['v1', 'jobs', ':id', 'cancel'], auth: true, handle: async c => [202, jobs.cancel(c.params.id!)] },
  ];
}

function resultRoutes(project: Project): Route[] {
  const query = (c: { url: URL }) => c.url.searchParams.get('limit') ?? undefined;
  return [
    { method: 'GET', path: ['v1', 'runs', ':id'], auth: true, handle: async c => [200, publicRun(await project.run(c.params.id!))] },
    { method: 'GET', path: ['v1', 'runs', ':id', 'findings'], auth: true, handle: async c => [200, { findings: (await project.run(c.params.id!)).findings.map(publicFinding) }] },
    { method: 'GET', path: ['v1', 'runs', ':id', 'artifacts'], auth: true, handle: async c => [200, { artifacts: listArtifacts(await project.run(c.params.id!)) }] },
    { method: 'GET', path: ['v1', 'runs', ':id', 'artifacts', ':name'], auth: true, handle: async c => [200, await project.artifact(c.params.id!, c.params.name!)] },
    { method: 'GET', path: ['v1', 'history'], auth: true, handle: async c => {
      const limit = parse(limitQuery(20, 200), query(c));
      const runs = await project.history(Math.max(limit, 2));
      const strip = (run: (typeof runs)[number]) => ({ ...run, gates: run.gates.map(({ id, status, durationMs }) => ({ id, status, durationMs })) });
      return [200, { runs: runs.slice(0, limit).map(strip), comparison: runs.length > 1 ? compareRuns(runs[0]!, runs[1]!) : null }];
    } },
    { method: 'GET', path: ['v1', 'team'], auth: true, handle: async c => [200, await teamView(project.configPath, parse(limitQuery(50, 200), query(c)))] },
    { method: 'GET', path: ['v1', 'visual'], auth: true, handle: async c => visual(c, project.configPath) },
    { method: 'GET', path: ['v1', 'trends'], auth: true, handle: async c => [200, trends(await project.history(parse(limitQuery(50, 1000), query(c))))] },
  ];
}

export const buildRoutes = (deps: RouteDeps): Route[] => { const project = new Project(deps); return [...pairingRoutes(deps), ...jobRoutes(deps, project), ...resultRoutes(project)]; };
