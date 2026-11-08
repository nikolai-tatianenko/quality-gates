import { chmod, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../../cli/src/runner.js';

/** The only config file the desktop app opens. A project without it is refused; nothing is created for the user. */
export const CONFIG_NAME = '.qualitygate.yml';
export const MAX_RECENTS = 10;

export interface Recent { path: string; name: string; lastOpened: string }
export interface Prefs { notifications: boolean }
export type Validation = { ok: true; path: string; configPath: string; name: string } | { ok: false; path: string; reason: string };
export type ConfigLoader = (configPath: string) => Promise<unknown>;

const stateSchema = z.object({
  schemaVersion: z.literal(1),
  recents: z.array(z.object({ path: z.string().min(1).max(4096), name: z.string().max(256), lastOpened: z.string().max(40) })).max(50),
  prefs: z.object({ notifications: z.boolean() }),
});
const fresh = () => ({ recents: [] as Recent[], prefs: { notifications: false } });

const clip = (text: string) => (text.length > 200 ? `${text.slice(0, 200)}...` : text);
const reasonOf = (error: unknown) => clip(error instanceof Error ? error.message : String(error));

/**
 * Checks a folder before every launch: absolute, really a directory (symlinks resolved), with a readable
 * `.qualitygate.yml` that parses. The returned path is the resolved one, so a link swapped later cannot redirect a launch.
 */
export async function validateWorkspace(input: string, load: ConfigLoader = loadConfig): Promise<Validation> {
  const fail = (reason: string): Validation => ({ ok: false, path: input, reason });
  if (typeof input !== 'string' || !input || input.includes('\0') || !isAbsolute(input)) return fail('Choose an absolute folder path.');
  let path: string;
  try { path = await realpath(input); } catch { return fail('The folder does not exist.'); }
  if (!(await stat(path)).isDirectory()) return fail('The path is not a folder.');
  const configPath = join(path, CONFIG_NAME);
  if (!(await lstat(configPath).catch(() => undefined))?.isFile()) return fail(`No ${CONFIG_NAME} in this folder. Run "qualitygate setup" there first.`);
  try { await load(configPath); } catch (error) { return fail(`${CONFIG_NAME} is not valid: ${reasonOf(error)}`); }
  return { ok: true, path, configPath, name: basename(path) };
}

/** Recent projects and preferences, kept in one JSON file in the app data folder (mode 0600, replaced atomically). */
export class WorkspaceStore {
  constructor(private readonly file: string, private readonly now: () => Date = () => new Date()) {}

  /** Reads the file. A missing file is an empty state; a damaged one is moved aside as `.corrupt` and reported, never trusted. */
  async load(): Promise<{ recents: Recent[]; prefs: Prefs; recovered: boolean }> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); } catch { return { ...fresh(), recovered: false }; }
    let parsed: z.ZodSafeParseResult<z.infer<typeof stateSchema>>;
    try { parsed = stateSchema.safeParse(JSON.parse(text)); } catch { parsed = stateSchema.safeParse(undefined); }
    if (parsed.success) return { recents: parsed.data.recents, prefs: parsed.data.prefs, recovered: false };
    await rename(this.file, `${this.file}.corrupt`).catch(() => undefined);
    return { ...fresh(), recovered: true };
  }

  private async save(recents: Recent[], prefs: Prefs): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, recents, prefs }, null, 2), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.file);
  }

  /** Puts a validated project first, drops a duplicate of it and keeps the newest `MAX_RECENTS`. */
  async remember(project: { path: string; name: string }): Promise<Recent[]> {
    const { recents, prefs } = await this.load();
    const next = [{ path: project.path, name: project.name, lastOpened: this.now().toISOString() }, ...recents.filter(item => item.path !== project.path)].slice(0, MAX_RECENTS);
    await this.save(next, prefs);
    return next;
  }

  async forget(path: string): Promise<Recent[]> {
    const { recents, prefs } = await this.load();
    const next = recents.filter(item => item.path !== path);
    await this.save(next, prefs);
    return next;
  }

  async setPrefs(change: Partial<Prefs>): Promise<Prefs> {
    const { recents, prefs } = await this.load();
    const next = { ...prefs, ...change };
    await this.save(recents, next);
    return next;
  }
}
