import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { createProxyServer } from 'portless';
import { createDashboard } from '../packages/dashboard/src/server.js';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--config' || !args[1])) throw Error('Usage: pnpm dev:ui [--config <path>]');
const config = resolve(args[1] ?? '.qualitygate.yml');
const proxyPort = Number(process.env.PORTLESS_PORT ?? 1355);
if (!Number.isInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535) throw Error('PORTLESS_PORT must be an unprivileged port from 1024 to 65535');
const hostname = 'qualitygate.localhost';
const publicOrigin = `http://${hostname}:${proxyPort}`;
const dashboard = createDashboard(config, undefined, publicOrigin);
const proxy = createProxyServer({ getRoutes: () => [{ hostname, port: backendPort }], proxyPort, strict: true }) as Server;
let backendPort = 0; let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  if (dashboard.server.listening) await dashboard.close();
  if (proxy.listening) {
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
  }
}
const shutdown = () => { void stop().catch(error => { console.error(error); process.exitCode = 2; }); };
try {
  await new Promise<void>((resolve, reject) => {
    dashboard.server.once('error', reject); dashboard.server.listen(0, '127.0.0.1', resolve);
  });
  const address = dashboard.server.address();
  if (!address || typeof address === 'string') throw Error('Dashboard backend did not bind');
  backendPort = address.port;
  await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(proxyPort, '127.0.0.1', resolve); });
  console.log(`QualityGate (Portless): ${publicOrigin}\nProject: ${config}`);
} catch (error) { await stop(); throw error; }
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
