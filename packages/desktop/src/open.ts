import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { loadConfig } from '../../cli/src/runner.js';

export type FolderKind = 'reports' | 'run';
/** Folders the file manager would launch instead of show. */
const BUNDLE = /\.(app|pkg|bundle|framework|prefpane|command|workflow|action|saver|kext|plugin|xpc)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The folder to show for a project: the report folder (`outputDir` of the approved config) or one run's evidence folder
 * inside it, which must itself lie inside the project and must not be an application bundle. Only existing real directories are returned. A run id must be a UUID and its folder must not be a link
 * leading outside the report folder, so a crafted id or a planted symlink cannot point the file manager elsewhere.
 */
export async function resolveFolder(configPath: string, kind: FolderKind, runId?: string): Promise<string> {
  const { config } = await loadConfig(configPath);
  let reports: string;
  try { reports = await realpath(config.outputDir); } catch { throw new Error('No reports exist yet. Run the gates first.'); }
  const root = await realpath(dirname(resolve(configPath)));
  if (!reports.startsWith(root + sep)) throw new Error('The report folder is outside the project.');
  if (reports.slice(root.length).split(sep).some(part => BUNDLE.test(part))) throw new Error('Refusing to open an application bundle.');
  if (kind === 'reports') return reports;
  if (!runId || !UUID.test(runId)) throw new Error('Invalid run id.');
  const folder = join(reports, runId);
  if (!(await lstat(folder).catch(() => undefined))?.isDirectory()) throw new Error('This run has no evidence folder.');
  const real = await realpath(folder);
  if (!real.startsWith(reports + sep)) throw new Error('This run has no evidence folder.');
  return real;
}

/** The file manager command of a platform. Always called with one directory argument, never through a shell. */
export const openerFor = (platform: NodeJS.Platform): string => (platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer.exe' : 'xdg-open');

/** Shows a directory in the file manager. Files are never opened, so nothing is executed. Resolves once the process started. */
export function openDirectory(path: string, platform: NodeJS.Platform = process.platform, spawnFn: typeof spawn = spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(openerFor(platform), [path], { stdio: 'ignore', detached: true, shell: false });
    child.once('error', error => reject(new Error(`The file manager could not be started: ${error.message}`)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
