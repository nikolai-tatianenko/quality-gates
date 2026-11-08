import { message } from '../../protocol/src/index.js';

interface Terminal { isTTY?: boolean }
/** Why the interactive UI cannot start here, or undefined. It needs a terminal on stdin and stdout and must never hang in CI or a pipe. */
export function uiRefusal(stdin: Terminal, stdout: Terminal, env: Record<string, string | undefined>): string | undefined {
  if (!stdin.isTTY || !stdout.isTTY) return 'ui needs an interactive terminal (stdin and stdout must be a TTY); use `qualitygate run` instead';
  if (env.CI) return 'ui does not run in CI (CI is set); use `qualitygate run` instead';
  if (env.TERM === 'dumb') return 'ui needs a terminal that understands escape codes (TERM=dumb); use `qualitygate run` instead';
  return undefined;
}

export interface UiModule { startUi(configPath: string, signal: AbortSignal, io: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream }): Promise<number> }
/** Loads the Ink screen lazily: the plain commands never pay for it, and a build without it says so. */
export async function loadUi(load: () => Promise<UiModule> = () => import('../../ink-ui/src/index.js')): Promise<UiModule> {
  try { return await load(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') throw new Error('The interactive UI is not part of this installation (qualitygate-ui.mjs is missing); use `qualitygate run`, or reinstall qualitygate');
    throw error;
  }
}

/** `qualitygate ui`: returns the process exit code (2 when the terminal cannot show it). */
export async function runUi(configPath: string, controller: AbortController, env = process.env, load?: () => Promise<UiModule>): Promise<number> {
  const refusal = uiRefusal(process.stdin, process.stdout, env);
  if (refusal) { console.error(`QualityGate: ${refusal}`); return 2; }
  try { return await (await loadUi(load)).startUi(configPath, controller.signal, { stdin: process.stdin, stdout: process.stdout }); }
  catch (error) { console.error(`QualityGate: ${message(error)}`); return controller.signal.aborted ? 130 : 2; }
}
