import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

export type Manager = 'pnpm' | 'yarn' | 'npm';
const lockfiles: [string, Manager][] = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm']];

export const exists = (path: string) => access(path).then(() => true, () => false);

/** Reads and parses a JSON file; `undefined` when it does not exist, throws when it is not valid JSON. */
export async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  return raw === undefined ? undefined : JSON.parse(raw);
}

/** Picks the package manager from `packageManager` in package.json, then lockfiles, else npm. */
export async function packageManager(directory: string, declared?: unknown): Promise<Manager> {
  const name = typeof declared === 'string' ? declared.split('@')[0] : undefined;
  if (name === 'pnpm' || name === 'yarn' || name === 'npm') return name;
  for (const [file, manager] of lockfiles) if (await exists(join(directory, file))) return manager;
  return 'npm';
}

/** The command prefix that runs a locally installed binary. */
export const execPrefix = (manager: Manager): string => ({ pnpm: 'pnpm exec', yarn: 'yarn', npm: 'npx' })[manager];
