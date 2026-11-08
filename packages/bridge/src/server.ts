import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { QualityGateService } from '../../service/src/index.js';
import { loadConfig } from '../../cli/src/runner.js';
import { HttpError, decode, matchRoute, send, type Context, type Reply } from './http.js';
import { Jobs } from './jobs.js';
import { originPolicy } from './origins.js';
import { RateLimiter, readBody } from './limits.js';
import { buildRoutes, type BridgeService } from './routes.js';
import { TokenStore, tokenFile, type TokenOptions } from './tokens.js';

export type { BridgeService } from './routes.js';
export type { JobStatus } from './jobs.js';
export interface BridgeOptions extends TokenOptions {
  configPath: string;
  /** Extra exact origins (an extension id to pin, a dashboard on another port). */
  origins?: string[];
  service?: BridgeService;
  tokenFile?: string;
  /** Requests per minute per origin (default 120); pairing attempts are limited to a tenth of that. */
  rateLimit?: number;
  maxBodyBytes?: number;
  /** Receives unexpected errors; clients only ever see "Internal error". */
  onError?: (error: unknown) => void;
}

/**
 * The local bridge: an authenticated HTTP API on 127.0.0.1 for the browser extension, the desktop shell and the dashboard.
 * It runs only gates declared in the project's config, never accepts a command or path, and never changes a verdict.
 */
export async function createBridge(options: BridgeOptions) {
  const allowed = originPolicy(options.origins);
  const { config } = await loadConfig(options.configPath);
  const store = new TokenStore(options.tokenFile ?? tokenFile(config.outputDir), options);
  await store.load();
  const service: BridgeService = options.service ?? new QualityGateService(options.configPath);
  const rate = options.rateLimit ?? 120;
  const limiter = new RateLimiter(rate, 60_000, options.now);
  const jobs = new Jobs(options.onError);
  const routes = buildRoutes({ configPath: options.configPath, store, service, jobs, onError: options.onError, pairLimiter: new RateLimiter(Math.max(1, Math.floor(rate / 10)), 60_000, options.now) });
  const maxBody = options.maxBodyBytes ?? 4096;

  const hostAllowed = (host: string | undefined) => {
    const address = server.address();
    return !!address && typeof address !== 'string' && (host === `127.0.0.1:${address.port}` || host === `localhost:${address.port}`);
  };
  /** The record id of the presented bearer token, valid only from the origin that paired. */
  function authenticate(req: IncomingMessage, origin: string): string {
    const supplied = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const record = supplied ? store.verify(supplied, origin) : undefined;
    if (!record) throw new HttpError(401, 'A valid bearer token is required', { 'WWW-Authenticate': 'Bearer' });
    return record.id;
  }
  async function bodyOf(req: IncomingMessage): Promise<string> {
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > maxBody) throw new HttpError(413, 'Request body too large');
    if (req.method !== 'POST') {
      if (req.headers['transfer-encoding'] || length > 0) throw new HttpError(400, 'Request body is not supported');
      return '';
    }
    const body = await readBody(req, maxBody);
    if (body === undefined) throw new HttpError(413, 'Request body too large');
    if (body && !/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Content-Type must be application/json');
    return body;
  }
  async function dispatch(req: IncomingMessage, origin: string): Promise<Reply> {
    const wait = limiter.hit(origin);
    if (wait) throw new HttpError(429, 'Rate limit exceeded', { 'Retry-After': String(wait) });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const { route, params } = matchRoute(routes, req.method ?? 'GET', url.pathname.split('/').slice(1).map(decode));
    const context: Context = { req, url, params, origin, body: '' };
    if (route.auth) context.tokenId = authenticate(req, origin);
    context.body = await bodyOf(req);
    return route.handle(context);
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (!hostAllowed(req.headers.host)) { send(res, 403, { error: 'Invalid host' }); return; }
    if (!origin || !allowed(origin)) { send(res, 403, { error: 'Origin not allowed' }); return; }
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    if (req.method === 'OPTIONS') {
      send(res, 204, undefined, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
      return;
    }
    try { const [status, body] = await dispatch(req, origin); send(res, status, body, cors); }
    catch (error) {
      if (error instanceof HttpError) { send(res, error.status, { error: error.message }, { ...cors, ...error.headers }); return; }
      options.onError?.(error); send(res, 500, { error: 'Internal error' }, cors);
    }
  }
  const server = createServer((req, res) => { void handle(req, res); });
  return {
    server, store,
    /** A fresh single-use pairing code. Show it to the person who is pairing a client; it is never sent over HTTP. */
    issuePairingCode: () => store.issueCode(),
    async close() {
      await jobs.close();
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
