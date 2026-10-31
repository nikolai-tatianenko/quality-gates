import { spawn } from 'node:child_process';
import type { Context, GatePlugin } from '../../../plugin-sdk/src/index.js';
import { message, type GateSpec } from '../../../protocol/src/index.js';
const MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 300_000;
export interface CommandOutput {
  exitCode: number | null; output: string; stdout: string; stderr: string;
  truncated: boolean; error?: string;
}
/** Captures a trusted shell command; timers and aborts kill the owned process group. */
export async function captureCommand(cwd: string, spec: GateSpec, context: Context): Promise<CommandOutput> {
  const child = spawn(spec.run, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const kill = () => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  };
  context.defer(async () => { kill(); await closed; });
  const result: CommandOutput = { exitCode: null, output: '', stdout: '', stderr: '', truncated: false };
  const chunks: Record<'output' | 'stdout' | 'stderr', Buffer[]> = { output: [], stdout: [], stderr: [] };
  let bytes = 0;
  const append = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    const available = Math.max(0, MAX_OUTPUT_BYTES - bytes);
    const captured = chunk.subarray(0, available);
    chunks[stream].push(captured); chunks.output.push(captured);
    bytes += Math.min(chunk.length, available);
    if (chunk.length > available) result.truncated = true;
  };
  child.stdout.on('data', chunk => append('stdout', chunk));
  child.stderr.on('data', chunk => append('stderr', chunk));
  const stop = (error: string) => { result.error ??= error; kill(); };
  const abort = () => stop('Interrupted');
  context.signal.addEventListener('abort', abort, { once: true });
  if (context.signal.aborted) abort();
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => stop(`Gate ${spec.id} timed out after ${timeoutMs}ms`), timeoutMs);
  try {
    result.exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', code => resolve(code));
    });
  } catch (error) { result.error ??= message(error); }
  finally { clearTimeout(timer); context.signal.removeEventListener('abort', abort); }
  for (const stream of ['stdout', 'stderr', 'output'] as const) result[stream] = Buffer.concat(chunks[stream]).toString('utf8');
  return result;
}
export function commandPlugin(cwd: string): GatePlugin {
  return { id: 'command', apiVersion: 1, kind: 'gate', async run(spec, context) {
    const { exitCode, output, error } = await captureCommand(cwd, spec, context);
    return { exitCode, output, error };
  } };
}
