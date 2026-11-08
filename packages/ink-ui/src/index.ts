import { createElement } from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { projectController } from './controller.js';
import { Session, type Controller } from './session.js';

export interface UiIo { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream }

/**
 * Draws the interactive screen until the user quits and returns the exit code: the last run's code as for `qualitygate run`,
 * 130 when a job was cancelled. SIGTERM and the abort signal cancel a running job the way Ctrl+C does.
 */
export async function startUi(configPath: string, signal: AbortSignal, io: UiIo, controller?: Controller): Promise<number> {
  const session = new Session(controller ?? await projectController(configPath));
  await session.load();
  // Ink puts the terminal in raw mode, so Ctrl+C arrives as a key press (handled by the session) and not as SIGINT.
  const onAbort = () => session.stop(130);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const instance = render(createElement(App, { session }), { stdin: io.stdin, stdout: io.stdout, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    const code = await session.finished;
    instance.unmount();
    await instance.waitUntilExit();
    return code;
  } finally { signal.removeEventListener('abort', onAbort); }
}
