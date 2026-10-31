import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { QualityGateService } from '../../service/src/index.js';
import { message } from '../../protocol/src/index.js';
import { portlessOrigin, dashboardHost } from './address.js';

const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
}
/** Bound to one trusted configuration. No endpoint accepts paths, commands or new configuration. */
export function createDashboard(configPath: string, assets = resolve('packages/dashboard/dist'), publicOrigin?: string) {
  const externalOrigin = portlessOrigin(publicOrigin);
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
  async function route(req: IncomingMessage, res: ServerResponse) {
    const backendOrigin = origin();
    const expectedOrigin = externalOrigin ?? backendOrigin;
    if (!dashboardHost(req.headers.host, backendOrigin, expectedOrigin)) { json(res, 403, { error: 'Invalid host' }); return; }
    const path = new URL(req.url!, expectedOrigin).pathname;
    if (req.method === 'POST') {
      if (req.headers.origin !== expectedOrigin || req.headers['x-qualitygate-request'] !== '1') { json(res, 403, { error: 'Invalid origin or request header' }); return; }
      if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0) { json(res, 400, { error: 'Request body is not supported' }); return; }
      await mutate(path, res); return;
    }
    if (req.method !== 'GET') { json(res, 405, { error: 'Method not allowed' }); return; }
    if (path === '/api/project') { json(res, 200, { configPath: resolve(configPath), ...await service.list() }); return; }
    if (path === '/api/run') {
      try { json(res, 200, await service.get()); }
      catch (error) {
        if (message(error) !== 'No runs found') throw error;
        json(res, 200, null);
      }
      return;
    }
    const files: Record<string, [string, string]> = { '/': ['index.html', 'text/html; charset=utf-8'],
      '/theme-init.js': ['theme-init.js', 'text/javascript; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'] };
    const file = files[path];
    if (!file) { json(res, 404, { error: 'Not found' }); return; }
    const body = await readFile(join(assets, file[0]));
    res.writeHead(200, { ...headers, 'Content-Type': file[1] }); res.end(body);
  }
  return { server, async close() {
    active?.abort(); await service.close(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
