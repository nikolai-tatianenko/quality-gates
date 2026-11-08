import { spawn, type ChildProcess } from 'node:child_process';
import { DesktopBridgeError, DesktopClient, type Fetch } from './client.js';

/** How to run the QualityGate CLI, e.g. `{ command: process.execPath, args: ['dist/qualitygate.mjs'] }`. */
export interface CliCommand { command: string; args: string[] }
export interface Session { mode: 'launched' | 'attached'; port: number; client: DesktopClient; stop(): Promise<void> }
export interface LaunchOptions { cli: CliCommand; configPath: string; cwd: string; timeoutMs?: number; graceMs?: number; fetch?: Fetch; spawnFn?: typeof spawn }

const ADDRESS = /QualityGate bridge: http:\/\/127\.0\.0\.1:(\d{1,5})/;
const CODE = /Pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/;
const GRACE_MS = 3000;

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

/** Asks the child to stop and kills it when it ignores the request. A child that never started has nothing to wait for. */
async function terminate(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.pid === undefined) return;
  child.kill('SIGTERM');
  if (!(await waitForExit(child, graceMs))) { child.kill('SIGKILL'); await waitForExit(child, graceMs); }
}

/** Reads the child's output until it has printed its address and one-time pairing code, or fails with an explicit reason. */
function readyLine(child: ChildProcess, timeoutMs: number): Promise<{ port: number; code: string }> {
  return new Promise((resolve, reject) => {
    let output = ''; let errors = '';
    const onErrorOutput = (chunk: Buffer) => { errors = `${errors}${chunk}`.slice(-300); };
    const finish = (action: () => void) => { clearTimeout(timer); child.stdout?.off('data', onData); child.off('exit', onExit); child.off('error', onError); child.stderr?.off('data', onErrorOutput); action(); };
    const onData = (chunk: Buffer) => {
      output += chunk;
      const port = ADDRESS.exec(output)?.[1]; const code = CODE.exec(output)?.[1];
      if (port && code) finish(() => resolve({ port: Number(port), code }));
    };
    const onExit = (status: number | null) => finish(() => reject(new Error(`The bridge exited before it was ready (exit ${status ?? 'signal'}).${errors.trim() ? ` ${errors.trim()}` : ''}`)));
    const onError = (error: Error) => finish(() => reject(new Error(`The bridge could not be started: ${error.message}`)));
    const timer = setTimeout(() => finish(() => reject(new Error(`The bridge did not become ready within ${timeoutMs} ms.`))), timeoutMs);
    child.stdout?.on('data', onData); child.stderr?.on('data', onErrorOutput); child.once('exit', onExit); child.once('error', onError);
  });
}

/**
 * Starts `qualitygate bridge` for one project on a random loopback port and pairs with the one-time code it prints.
 * The code is read from the child's own output, so it never passes through the webview, and the token stays in memory.
 */
export async function launchBridge(options: LaunchOptions): Promise<Session> {
  const run = options.spawnFn ?? spawn;
  const child = run(options.cli.command, [...options.cli.args, 'bridge', '--port', '0', '--config', options.configPath], { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const grace = options.graceMs ?? GRACE_MS;
  try {
    const { port, code } = await readyLine(child, options.timeoutMs ?? 15000);
    const client = new DesktopClient(port, undefined, options.fetch);
    await client.ping();
    await client.pair(code);
    return { mode: 'launched', port, client, async stop() { await client.revoke().catch(() => undefined); await terminate(child, grace); } };
  } catch (error) {
    await terminate(child, grace);
    throw error;
  }
}

/** Connects to a bridge somebody else started (for example in a terminal) with the pairing code the person typed in. */
export async function attachBridge(port: number, code: string, fetchFn?: Fetch): Promise<Session> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DesktopBridgeError('invalid', 'The port must be between 1 and 65535.');
  const client = new DesktopClient(port, undefined, fetchFn);
  await client.ping();
  await client.pair(code);
  return { mode: 'attached', port, client, async stop() { await client.revoke().catch(() => undefined); } };
}
