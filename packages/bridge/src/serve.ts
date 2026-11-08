import { loadConfig } from '../../cli/src/runner.js';
import { parseOrigins } from './origins.js';
import { TokenStore, tokenFile } from './tokens.js';
import { createBridge } from './server.js';

export interface ServeOptions { configPath: string; port: number; origins: string[]; out: (text: string) => void; err: (text: string) => void }
/** The port the extension and the desktop shell expect when `--port` is not given. */
export const DEFAULT_PORT = 4180;

/** Starts the bridge, prints the address and a one-time pairing code, and resolves after `signal` aborts and the server has closed. */
export async function serveBridge(options: ServeOptions, signal: AbortSignal): Promise<void> {
  const origins = parseOrigins(options.origins);
  const bridge = await createBridge({ configPath: options.configPath, origins, onError: error => options.err(`QualityGate: bridge error: ${error instanceof Error ? error.message : error}\n`) });
  await new Promise<void>((resolve, reject) => { bridge.server.once('error', reject); bridge.server.listen(options.port, '127.0.0.1', resolve); });
  const address = bridge.server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  options.out(`QualityGate bridge: http://127.0.0.1:${port}\nPairing code: ${bridge.issuePairingCode()} (single use, valid for 10 minutes)\n`
    + 'Enter the code in the extension or desktop app. Press Ctrl+C to stop.\n');
  if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  await bridge.close();
}

/** Deletes every stored token; clients must pair again. Returns how many were removed. */
export async function revokeAll(configPath: string): Promise<number> {
  const { config } = await loadConfig(configPath);
  const store = new TokenStore(tokenFile(config.outputDir));
  await store.load();
  return store.revokeAll();
}
