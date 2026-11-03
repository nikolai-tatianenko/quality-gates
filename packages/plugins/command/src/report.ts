import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { message } from '../../../protocol/src/index.js';
export const MAX_REPORT_BYTES = 5 * 1024 * 1024;
export type ReportRead = { status: 'ok'; raw: string; absolutePath: string } | { status: 'missing'; stale?: boolean } | { status: 'error'; error: string };
/** Reads a gate report that must live inside `cwd`: no absolute paths, no `..`, no symlinks, at most 5 MB. A file last modified before `notBefore` (ms since epoch) is a leftover from an earlier run and counts as missing. */
export async function readReport(cwd: string, path: string, notBefore?: number): Promise<ReportRead> {
  const parts = path.split(/[\\/]+/);
  if (isAbsolute(path) || parts.includes('..') || relative(cwd, join(cwd, path)).split(sep)[0] === '..')
    return { status: 'error', error: `Report path must stay inside the project: ${path}` };
  let current = cwd;
  try {
    for (const part of parts.filter(Boolean)) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) return { status: 'error', error: `Report path must not use symlinks: ${path}` };
    }
    const info = await lstat(current);
    if (!info.isFile()) return { status: 'error', error: `Report path is not a file: ${path}` };
    if (notBefore !== undefined && info.mtimeMs < notBefore) return { status: 'missing', stale: true };
    if (info.size > MAX_REPORT_BYTES) return { status: 'error', error: `Report exceeds the 5 MB limit: ${path}` };
    return { status: 'ok', raw: await readFile(current, 'utf8'), absolutePath: current };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return { status: 'error', error: `Cannot read report ${path}: ${message(error)}` };
  }
}
