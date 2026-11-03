#!/usr/bin/env node
import { resolve } from 'node:path';
import { createDashboard, newShareToken } from './server.js';
import { startTunnel, tunnelProviders, type Tunnel, type TunnelProvider } from './tunnel.js';
import { portlessOrigin } from './address.js';
const args = process.argv.slice(2);
let config = '.qualitygate.yml'; let tunnel: TunnelProvider | undefined; let port = Number(process.env.PORT ?? 4173);
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i]; const value = args[i + 1];
  if (!value) throw Error(`Missing value for ${flag}`);
  if (flag === '--config') config = value;
  else if (flag === '--port') port = Number(value);
  else if (flag === '--tunnel' && (tunnelProviders as readonly string[]).includes(value)) tunnel = value as TunnelProvider;
  else throw Error(`Unknown option: ${flag}`);
}
if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid port');
const publicOrigin = portlessOrigin(process.env.PORTLESS_URL);
const token = tunnel ? newShareToken() : undefined;
const dashboard = createDashboard(config, undefined, publicOrigin, token);
let shared: Tunnel | undefined;
let stopping = false;
const stopTunnel = new AbortController();
const stop = async () => { stopping = true; stopTunnel.abort(); shared?.close(); await dashboard.close(); };
dashboard.server.listen(port, '127.0.0.1', async () => {
  const address = dashboard.server.address();
  if (!address || typeof address === 'string') return;
  console.log(`QualityGate: ${publicOrigin ?? `http://127.0.0.1:${address.port}`}\nProject: ${resolve(config)}`);
  if (!tunnel) return;
  try {
    shared = await startTunnel(tunnel, address.port, code => { if (stopping) return; console.error(`QualityGate: ${tunnel} tunnel closed (code ${code}); stopping`); process.exitCode = 2; void stop(); }, { signal: stopTunnel.signal });
    if (stopping) { shared.close(); return; }
    dashboard.trustHost(new URL(shared.url).host);
    console.log(`Warning: this link gives read-only access to logs, findings and evidence (file paths, command output), the gate command lines and the config path of ${resolve(config)} to anyone who has it. Press Ctrl+C to close the tunnel.\nShare: ${shared.url}/?token=${token}`);
  } catch (error) {
    if (stopping) return;
    console.error(`QualityGate: ${error instanceof Error ? error.message : error}`); process.exitCode = 2; await stop(); }
});
process.once('SIGINT', stop); process.once('SIGTERM', stop);
