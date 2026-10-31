import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { reviewSourceSchema } from '../../protocol/src/index.js';
export type ReviewSource = z.infer<typeof reviewSourceSchema>;
const lockedSource = reviewSourceSchema.extend({ commit: z.string().regex(/^[a-f0-9]{40}$/) });
const lockSchema = z.object({ schemaVersion: z.literal(1), sources: z.array(lockedSource) }).strict();
const execute = promisify(execFile);
const lockName = 'qualitygate.sources.lock.json';
const cacheName = '.qualitygate-review-sources';
/** No hooks, shell, checkout, submodules or downloaded executables. Git objects remain inert. */
async function git(args: string[], signal?: AbortSignal): Promise<string> {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const { stdout } = await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'http.followRedirects=false', ...args], {
    env: { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    timeout: 60000, maxBuffer: 1_000_000, signal,
  });
  return stdout.trimEnd();
}
async function readLock(directory: string) {
  return lockSchema.parse(JSON.parse(await readFile(join(directory, lockName), 'utf8')));
}
function configured(source: ReviewSource, locked: z.infer<typeof lockedSource>) {
  if (source.repository !== locked.repository || source.ref !== locked.ref || source.path !== locked.path) throw new Error(`Review source ${source.id} changed; run sources sync`);
  return locked;
}
export async function listSources(directory: string, sources: ReviewSource[]) {
  const lock = await readLock(directory);
  return sources.map(source => {
    const entry = lock.sources.find(item => item.id === source.id);
    if (!entry) throw new Error(`Review source ${source.id} is not locked; run sources sync`);
    return configured(source, entry);
  });
}
async function download(directory: string, source: ReviewSource, revision: string, signal?: AbortSignal) {
  const cache = join(directory, cacheName);
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(join(cache, 'download-'));
  try {
    await git(['init', '--bare', temporary], signal);
    await git(['--git-dir', temporary, 'fetch', '--depth=1', '--', source.repository, revision], signal);
    const commit = z.string().regex(/^[a-f0-9]{40}$/).parse(await git(['--git-dir', temporary, 'rev-parse', 'FETCH_HEAD^{commit}'], signal));
    await git(['--git-dir', temporary, 'show', `${commit}:${source.path}/SKILL.md`], signal);
    // Existing pinned stores are immutable, including during concurrent reads.
    const store = join(cache, `${source.id}-${commit}`);
    await rename(temporary, store).catch(error => {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
    });
    return { ...source, commit };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
/** Explicitly replaces the lock only after every requested source has downloaded successfully. */
export async function syncSources(directory: string, inputs: ReviewSource[], signal?: AbortSignal) {
  const entries = [];
  for (const input of inputs) {
    const source = reviewSourceSchema.parse(input);
    entries.push(await download(directory, source, source.ref, signal));
  }
  const lock = { schemaVersion: 1 as const, sources: entries };
  const temporary = join(directory, `${lockName}.${randomUUID()}.tmp`);
  try { await writeFile(temporary, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' }); await rename(temporary, join(directory, lockName)); }
  finally { await rm(temporary, { force: true }); }
  return lock;
}
/** Restores exact locked revisions on another machine without updating the lockfile. */
export async function restoreSources(directory: string, sources: ReviewSource[], signal?: AbortSignal) {
  const entries = await listSources(directory, sources);
  for (const entry of entries) {
    const { commit, ...source } = entry;
    const restored = await download(directory, source, commit, signal);
    if (restored.commit !== commit) throw new Error(`Restored review source ${entry.id} does not match the lock`);
  }
  return entries;
}
/** Detects upstream changes without changing the pinned version or running remote code. */
export async function checkSources(directory: string, sources: ReviewSource[], signal?: AbortSignal) {
  const entries = await listSources(directory, sources);
  const result = [];
  for (const source of entries) {
    const refs = await git(['ls-remote', '--exit-code', '--', source.repository, source.ref], signal);
    const commit = z.string().regex(/^[a-f0-9]{40}$/).parse(refs.split(/\s/)[0]);
    result.push({ id: source.id, pinned: source.commit, latest: commit, updateAvailable: commit !== source.commit });
  }
  return result;
}
export async function readMethodology(directory: string, sources: ReviewSource[], id: string, options: { file?: string; signal?: AbortSignal } = {}) {
  const file = options.file ?? 'SKILL.md';
  if (!/^(?:[A-Za-z0-9_-]+\.(?:md|json|cjs)|LICENSE)$/.test(file)) throw new Error('Expected a methodology Markdown/JSON/CJS filename or LICENSE');
  const source = (await listSources(directory, sources)).find(item => item.id === id);
  if (!source) throw new Error(`Unknown review source: ${id}`);
  const path = file === 'LICENSE' ? file : `${source.path}/${file}`;
  const content = await git(['--git-dir', join(directory, cacheName, `${source.id}-${source.commit}`), 'show', `${source.commit}:${path}`], options.signal);
  return { source, file, content };
}
