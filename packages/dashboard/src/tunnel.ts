import { spawn, type ChildProcess } from 'node:child_process';
export const tunnelProviders = ['cloudflare', 'ngrok'] as const;
export type TunnelProvider = (typeof tunnelProviders)[number];
export type Spawn = (command: string, args: string[], options: { stdio: ['ignore', 'pipe', 'pipe'] }) => ChildProcess;
/** The user's own installed binaries; nothing is downloaded. */
const tools = {
  cloudflare: { bin: 'cloudflared', args: (port: number) => ['tunnel', '--url', `http://127.0.0.1:${port}`], url: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/ },
  ngrok: { bin: 'ngrok', args: (port: number) => ['http', `127.0.0.1:${port}`, '--log', 'stdout', '--log-format', 'logfmt'], url: /url=(https:\/\/[^\s"]+)/ },
} as const;
export interface Tunnel { url: string; close(): void }
/** Resolves with the public URL once the tool prints it. Rejects with a readable message if the binary is missing, exits early or stays silent. */
export function startTunnel(provider: TunnelProvider, port: number, onExit: (code: number | null) => void,
  { spawnProcess = spawn as Spawn, timeoutMs = 30000 }: { spawnProcess?: Spawn; timeoutMs?: number } = {}): Promise<Tunnel> {
  const tool = tools[provider];
  return new Promise((resolve, reject) => {
    const child = spawnProcess(tool.bin, [...tool.args(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let ready = false; let text = '';
    const stop = () => { clearTimeout(timer); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${tool.bin} did not report a public URL within ${timeoutMs / 1000}s`)); }, timeoutMs);
    const scan = (chunk: Buffer) => {
      if (ready) return;
      text = (text + chunk).slice(-4000);
      const match = tool.url.exec(text);
      if (!match) return;
      ready = true; stop();
      resolve({ url: match[1] ?? match[0], close: () => { child.kill('SIGTERM'); } });
    };
    child.stdout!.on('data', scan); child.stderr!.on('data', scan);
    child.once('error', error => {
      stop();
      reject(new Error((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `${tool.bin} is not installed or not on PATH. Install it yourself (QualityGate never downloads tunnel tools) or run the dashboard without --tunnel.`
        : `Could not start ${tool.bin}: ${error.message}`));
    });
    child.once('close', code => { stop(); if (ready) onExit(code); else reject(new Error(`${tool.bin} exited (code ${code}) before reporting a public URL`)); });
  });
}
