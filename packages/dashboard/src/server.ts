import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { QualityGateService, teamView } from '../../service/src/index.js';
import { message } from '../../protocol/src/index.js';
import { portlessOrigin, dashboardHost } from './address.js';

const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
}
const cookieName = 'qg_token';
function sameToken(supplied: string, token: string) {
  const a = Buffer.from(supplied); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Fresh random access token for a shared (tunnelled) dashboard. */
export const newShareToken = () => randomBytes(32).toString('base64url');
/**
 * Bound to one trusted configuration. No endpoint accepts paths, commands or new configuration.
 * With `shareToken` the dashboard is read-only (no run or cancel endpoints) and every request needs the token.
 */
export function createDashboard(configPath: string, assets = resolve('packages/dashboard/dist'), publicOrigin?: string, shareToken?: string) {
  const externalOrigin = portlessOrigin(publicOrigin);
  let sharedHost: string | undefined;
  const service = new QualityGateService(resolve(configPath));
  let active: AbortController | undefined;
  const server = createServer((req, res) => { void route(req, res).catch(error => json(res, 500, { error: message(error) })); });
  function origin() {
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Dashboard is not listening');
    return `http://127.0.0.1:${address.port}`;
  }
  async function mutate(path: string, res: ServerResponse) {
    if (path === '/api/cancel') { active?.abort(); json(res, 200, { cancelled: !!active }); return; }
    if (path !== '/api/run') { json(res, 404, { error: 'Not found' }); return; }
    if (active) { json(res, 409, { error: 'A run is already active' }); return; }
    const controller = new AbortController(); active = controller;
    try { json(res, 200, await service.run({}, controller.signal)); }
    finally { active = undefined; }
  }
  /** The token arrives once in the URL, becomes an HttpOnly cookie and is removed from the address bar. */
  function authorize(req: IncomingMessage, res: ServerResponse, url: URL, token: string): boolean {
    const supplied = url.searchParams.get('token');
    if (supplied !== null) {
      if (!sameToken(supplied, token)) { json(res, 401, { error: 'Invalid access token' }); return false; }
      url.searchParams.delete('token');
      res.writeHead(302, { ...headers, Location: url.pathname + url.search, 'Set-Cookie': `${cookieName}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/` });
      res.end(); return false;
    }
    const cookie = (req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`));
    if (cookie && sameToken(cookie.slice(cookieName.length + 1), token)) return true;
    json(res, 401, { error: 'Access token required' }); return false;
  }
  /** Host, token and read-only checks; returns the parsed URL only for requests that may continue. */
  function admit(req: IncomingMessage, res: ServerResponse, backendOrigin: string, expectedOrigin: string): URL | undefined {
    if (!dashboardHost(req.headers.host, backendOrigin, expectedOrigin) && !(sharedHost && req.headers.host === sharedHost)) { json(res, 403, { error: 'Invalid host' }); return; }
    const url = new URL(req.url!, expectedOrigin);
    if (shareToken && !authorize(req, res, url, shareToken)) return;
    if (shareToken && req.method !== 'GET') { res.setHeader('Allow', 'GET'); json(res, 405, { error: 'Read-only shared dashboard' }); return; }
    return url;
  }
  async function read(path: string, res: ServerResponse) {
    if (path === '/api/project') { json(res, 200, { configPath: resolve(configPath), ...await service.list(), ...(shareToken ? { readOnly: true } : {}) }); return true; }
    if (path === '/api/team') { json(res, 200, await teamView(configPath)); return true; }
    if (path !== '/api/run') return false;
    try { json(res, 200, await service.get()); }
    catch (error) {
      if (message(error) !== 'No runs found') throw error;
      json(res, 200, null);
    }
    return true;
  }
  async function route(req: IncomingMessage, res: ServerResponse) {
    const backendOrigin = origin();
    const expectedOrigin = externalOrigin ?? backendOrigin;
    const url = admit(req, res, backendOrigin, expectedOrigin); if (!url) return;
    const path = url.pathname;
    if (req.method === 'POST') {
      if (req.headers.origin !== expectedOrigin || req.headers['x-qualitygate-request'] !== '1') { json(res, 403, { error: 'Invalid origin or request header' }); return; }
      if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0) { json(res, 400, { error: 'Request body is not supported' }); return; }
      await mutate(path, res); return;
    }
    if (req.method !== 'GET') { json(res, 405, { error: 'Method not allowed' }); return; }
    if (await read(path, res)) return;
    const files: Record<string, [string, string]> = { '/': ['index.html', 'text/html; charset=utf-8'],
      '/theme-init.js': ['theme-init.js', 'text/javascript; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'] };
    const file = files[path];
    if (!file) { json(res, 404, { error: 'Not found' }); return; }
    const body = await readFile(join(assets, file[0]));
    res.writeHead(200, { ...headers, 'Content-Type': file[1] }); res.end(body);
  }
  return { server, trustHost(host: string) { sharedHost = host; }, async close() {
    active?.abort(); await service.close(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
