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
/** Expands project-relative globs to absolute regular files; symlinks are never followed, limits are enforced. */
export async function expandArtifacts(cwd: string, patterns: string[], limits: ArtifactLimits = DEFAULT_LIMITS): Promise<{ files: string[]; truncated: boolean }> {
  const found = new Set<string>();
  for (const pattern of patterns) {
    const normalized = pattern.replaceAll('\\', '/');
    if (isAbsolute(pattern) || normalized.split('/').includes('..')) continue;
    const segments = normalized.split('/');
    const firstGlob = segments.findIndex(part => GLOB_CHARS.test(part));
    const literal = segments.slice(0, firstGlob === -1 ? -1 : firstGlob);
    const matcher = globToRegExp(normalized);
    if (!(await plainDirectories(cwd, literal))) continue;
    const pending = [literal.join('/')];
    while (pending.length) {
      const relative = pending.pop()!;
      let entries;
      try { entries = await readdir(join(cwd, relative), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && matcher.test(path)) found.add(path);
      }
    }
  }
  const files: string[] = []; let bytes = 0; let truncated = false;
  for (const path of [...found].sort()) {
    const size = (await lstat(join(cwd, path))).size;
    if (files.length >= limits.maxFiles || bytes + size > limits.maxBytes) { truncated = true; break; }
    files.push(join(cwd, path)); bytes += size;
  }
  return { files, truncated };
}
