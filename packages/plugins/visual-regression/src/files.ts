import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
/**
 * A screenshot name is its file stem: ASCII letters, digits, dots, dashes and underscores. It must not start with a dot
 * (hidden files) or a dash (it would read as an option), the same rule the dashboard reader applies to visual.json.
 */
export const NAME = /^(?![.-])[A-Za-z0-9._-]{1,120}$/;
export const NAME_RULE = 'the name must use ASCII letters, digits, dots, dashes or underscores (1-120 characters, not starting with a dot or a dash)';
/** Text safe to print: JSON-style escapes for quotes, backslashes, control characters and everything outside printable ASCII (no quotes added). */
export const show = (text: string) => JSON.stringify(text).slice(1, -1).replace(/[^\x20-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export interface Listed { name: string; path: string; mtimeMs: number }
export interface Listing { files: Map<string, Listed>; blocked: Set<string>; problems: string[] }
export interface Entry { name: string; isFile(): boolean; isSymbolicLink(): boolean }
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
/**
 * Resolves a project-relative folder that may not exist yet. The real path of its nearest existing part must stay inside
 * the project, so neither `..`, an absolute path nor a symlink can lead out of it. `root` must be a real path.
 */
export async function projectFolder(root: string, folder: string, label: string): Promise<{ path: string; real: string; exists: boolean }> {
  if (isAbsolute(folder) || folder.split(/[\\/]/).includes('..')) throw new Error(`${label} must be a folder inside the project: ${folder}`);
  const path = resolve(root, folder);
  let probe = path; let real = '';
  for (;;) {
    try { real = await realpath(probe); break; } catch { probe = dirname(probe); }
  }
  if (!inside(root, real)) throw new Error(`${label} resolves outside the project: ${folder}`);
  const exists = probe === path;
  if (exists && !(await stat(path)).isDirectory()) throw new Error(`${label} is not a folder: ${folder}`);
  return { path, real: join(real, relative(probe, path)), exists };
}
/** True when both folders are the same place or one holds the other (compared by real path, so a symlink alias counts). */
export const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
/** Indexes the `.png` entries of one folder by lower-cased name; symlinks, bad names, other extension cases and name collisions are reported, never read. */
export function indexEntries(label: string, directory: string, entries: Entry[], mtimeOf: (name: string) => number): Listing {
  const listing: Listing = { files: new Map(), blocked: new Set(), problems: [] };
  for (const entry of entries.filter(item => /\.png$/i.test(item.name))) {
    const name = entry.name.slice(0, -4); const key = name.toLowerCase(); const shown = `${label}/${show(entry.name)}`;
    if (entry.isSymbolicLink()) listing.problems.push(`${shown}: symbolic links are not followed`);
    else if (!entry.isFile()) continue;
    else if (!entry.name.endsWith('.png')) listing.problems.push(`${shown}: the extension must be lower-case .png`);
    else if (!NAME.test(name)) listing.problems.push(`${shown}: ${NAME_RULE}`);
    else if (listing.blocked.has(key) || listing.files.has(key)) {
      listing.problems.push(`${shown}: name collides with ${listing.files.get(key)?.name ?? name}.png (names are compared without case)`);
      listing.files.delete(key); listing.blocked.add(key);
    } else listing.files.set(key, { name, path: join(directory, entry.name), mtimeMs: mtimeOf(entry.name) });
  }
  return listing;
}
/** Lists the PNG files directly inside a folder (not its subfolders); a missing folder is an empty listing. */
export async function listPngs(label: string, directory: string): Promise<Listing> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const times = new Map<string, number>();
  for (const entry of entries) if (entry.isFile()) times.set(entry.name, (await stat(join(directory, entry.name))).mtimeMs);
  return indexEntries(label, directory, entries, name => times.get(name) ?? 0);
}
/** Reads a regular file without following a symlink at the last path part, refusing files over the size limit. */
export async function readImageFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW | 0));
  try {
    if ((await handle.stat()).size > MAX_FILE_BYTES) throw new Error(`file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    return await handle.readFile();
  } finally { await handle.close(); }
}
