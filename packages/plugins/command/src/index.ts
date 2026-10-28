import { spawn } from 'node:child_process';
import type { GatePlugin } from '../../../plugin-sdk/src/index.js';
const MAX_OUTPUT = 1_000_000;
const DEFAULT_TIMEOUT_MS = 300_000;
/** Runs a shell command in `cwd`; exit code 0 passes. Trusted local config only: the command is not sandboxed. */
export function commandPlugin(cwd: string): GatePlugin {
  return {
    id: 'command', apiVersion: 1, kind: 'gate',
    async run(spec, context) {
      const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // detached puts the shell in its own process group so the whole tree can be killed.
      const child = spawn(spec.run, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      const kill = () => {
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      };
      context.defer(async () => { kill(); await closed; });
      let output = '';
      const append = (chunk: Buffer) => { if (output.length < MAX_OUTPUT) output += chunk.toString(); };
      child.stdout.on('data', append); child.stderr.on('data', append);
      let failure: Error | undefined;
      const stop = (error: Error) => { failure ??= error; kill(); };
      const onAbort = () => stop(new Error('Interrupted'));
      context.signal.addEventListener('abort', onAbort, { once: true });
      if (context.signal.aborted) onAbort();
      const timer = setTimeout(() => stop(new Error(`Gate ${spec.id} timed out after ${timeoutMs}ms`)), timeoutMs);
      try {
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', code => resolve(code));
        });
        if (failure) throw failure;
        return { exitCode, output };
      } finally {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
