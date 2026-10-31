#!/usr/bin/env node
import { resolve } from 'node:path';
import { createDashboard } from './server.js';
const args = process.argv.slice(2);
let config = '.qualitygate.yml'; let port = 4173;
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i]; const value = args[i + 1];
  if (!value) throw Error(`Missing value for ${flag}`);
  if (flag === '--config') config = value;
  else if (flag === '--port') port = Number(value);
  else throw Error(`Unknown option: ${flag}`);
}
if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid port');
const dashboard = createDashboard(config);
dashboard.server.listen(port, '127.0.0.1', () => {
  const address = dashboard.server.address();
  if (address && typeof address !== 'string') console.log(`QualityGate: http://127.0.0.1:${address.port}\nProject: ${resolve(config)}`);
});
const stop = async () => { await dashboard.close(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
