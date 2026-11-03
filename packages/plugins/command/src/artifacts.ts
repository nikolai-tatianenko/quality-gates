import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
export interface ArtifactLimits { maxFiles: number; maxBytes: number }
export const DEFAULT_LIMITS: ArtifactLimits = { maxFiles: 50, maxBytes: 50 * 1024 * 1024 };
const GLOB_CHARS = /[*?]/;
/** `*` stays within one path segment, `**` crosses directories, `?` is one character. */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; source += '(?:.*/)?'; } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
/** True when every directory along the literal prefix exists and is not a symlink. */
async function plainDirectories(cwd: string, segments: string[]): Promise<boolean> {
  let current = cwd;
  for (const segment of segments) {
    current = join(current, segment);
    try { if (!(await lstat(current)).isDirectory()) return false; } catch { return false; }
  }
  return true;
}
/** Absolute-path or `..` patterns can never match inside the project. */
const escapes = (pattern: string) => isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..');
/** Walks the directories under `start`, returning relative paths of regular files matching `matcher`; symlinks are skipped. */
async function walk(cwd: string, start: string, matcher: RegExp): Promise<string[]> {
  const matches: string[] = []; const pending = [start];
  while (pending.length) {
    const relative = pending.pop()!;
    const entries = await readdir(join(cwd, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && matcher.test(path)) matches.push(path);
    }
  }
  return matches;
}
/** Expands project-relative globs to absolute regular files; symlinks are never followed, limits are enforced, and files last modified before `notBefore` (leftovers from earlier runs) are skipped. */
export async function expandArtifacts(cwd: string, patterns: string[], limits: ArtifactLimits = DEFAULT_LIMITS, notBefore?: number): Promise<{ files: string[]; truncated: boolean }> {
  const found = new Set<string>();
  for (const pattern of patterns.filter(item => !escapes(item))) {
    const segments = pattern.replaceAll('\\', '/').split('/');
    const firstGlob = segments.findIndex(part => GLOB_CHARS.test(part));
    const literal = segments.slice(0, firstGlob === -1 ? -1 : firstGlob);
    if (!(await plainDirectories(cwd, literal))) continue;
    for (const path of await walk(cwd, literal.join('/'), globToRegExp(segments.join('/')))) found.add(path);
  }
  const files: string[] = []; let bytes = 0;
  for (const path of [...found].sort()) {
    const info = await lstat(join(cwd, path)); const size = info.size;
    if (notBefore !== undefined && info.mtimeMs < notBefore) continue;
    if (files.length >= limits.maxFiles || bytes + size > limits.maxBytes) return { files, truncated: true };
    files.push(join(cwd, path)); bytes += size;
  }
  return { files, truncated: false };
}
