import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GateSpec, RunResult } from '../../protocol/src/index.js';
import { globFiles, globToRegExp } from '../../plugins/command/src/artifacts.js';

const exec = promisify(execFile);
const MAX_INPUT_FILES = 20000;

/** Paths git reports as modified, added, renamed or untracked, relative to `cwd`. */
export async function changedFiles(cwd: string): Promise<string[]> {
  let stdout: string;
  try { ({ stdout } = await exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, maxBuffer: 64 * 1024 * 1024 })); }
  catch { throw new Error('--changed needs a git repository with git on PATH'); }
  return stdout.split('\0').filter(entry => entry.length > 3 && entry[2] === ' ').map(entry => entry.slice(3));
}

/**
 * Gate ids to run for `--changed`: gates without `inputs` always run, gates with `inputs` run only when
 * a changed file matches one of their globs.
 */
export function changedGateIds(gates: GateSpec[], changed: string[]): string[] {
  return gates.filter(gate => !gate.inputs || gate.inputs.some(pattern => {
    const matcher = globToRegExp(pattern.replaceAll('\\', '/'));
    return changed.some(path => matcher.test(path));
  })).map(gate => gate.id);
}

/** Hash of the gate command and the content of every input file; `undefined` when the gate has no usable inputs. */
export async function inputHash(cwd: string, gate: GateSpec): Promise<string | undefined> {
  if (!gate.inputs) return undefined;
  const files = await globFiles(cwd, gate.inputs);
  if (!files.length || files.length > MAX_INPUT_FILES) return undefined;
  const hash = createHash('sha256').update(`${gate.id}\0${gate.run}\0`);
  for (const file of files) hash.update(`${file}\0`).update(await readFile(join(cwd, file))).update('\0');
  return hash.digest('hex');
}

type Cache = Record<string, string>;
const cachePath = (outputDir: string) => join(outputDir, 'cache.json');
export async function readCache(outputDir: string): Promise<Cache> {
  try {
    const data = JSON.parse(await readFile(cachePath(outputDir), 'utf8')) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Cache : {};
  } catch { return {}; }
}

/** Gate id to a note, for gates whose inputs hash equals the hash of their last passing run. */
export async function cachedGates(cwd: string, outputDir: string, gates: GateSpec[]): Promise<{ cached: Record<string, string>; hashes: Record<string, string> }> {
  const cache = await readCache(outputDir);
  const cached: Record<string, string> = {}; const hashes: Record<string, string> = {};
  for (const gate of gates) {
    const hash = await inputHash(cwd, gate);
    if (!hash) continue;
    hashes[gate.id] = hash;
    if (cache[gate.id] === hash) cached[gate.id] = 'Cached: inputs unchanged since the last passing run';
  }
  return { cached, hashes };
}

/** Remembers the input hash of every executed gate that passed and forgets the ones that did not. */
export async function saveCache(outputDir: string, hashes: Record<string, string>, result: RunResult): Promise<void> {
  const cache = await readCache(outputDir);
  for (const gate of result.gates) {
    if (gate.cached || gate.skipped || !(gate.id in hashes)) continue;
    if (gate.decision === 'PASS' && gate.execution === 'completed') cache[gate.id] = hashes[gate.id]!; else delete cache[gate.id];
  }
  await mkdir(outputDir, { recursive: true });
  await writeFile(cachePath(outputDir), JSON.stringify(cache, null, 2));
}
