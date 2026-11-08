import { execFile } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FixResult, GateSpec, RunResult } from '../../protocol/src/index.js';
import type { ProgressEvent } from '../../core/src/index.js';
import type { Context } from '../../plugin-sdk/src/index.js';
import { captureCommand } from '../../plugins/command/src/index.js';
import { getRun } from '../../service/src/index.js';
import { execute, loadConfig } from './runner.js';

const git = promisify(execFile);
const GIT_BUFFER = 64 * 1024 * 1024;

/** What `fixGates` reports while it works; display only. The re-run reports through `onProgress` as `run` does. */
export type FixEvent = { kind: 'fix-start'; id: string; command: string } | { kind: 'fix-end'; id: string; exitCode: number | null; error?: string };
export interface FixOptions {
  /** Gate ids to fix; default: the gates that blocked in the last run and declare `fix`, else every gate that declares `fix`. */
  gates?: string[];
  /** Fix in a git repository that has uncommitted changes. */
  allowDirty?: boolean;
  onProgress?: (event: ProgressEvent) => void;
  onFix?: (event: FixEvent) => void;
}

/** Gates to fix. Explicit ids must exist and declare `fix`; without ids the blocked gates win over "all gates with a fix". */
export function selectFixIds(gates: GateSpec[], requested: string[] | undefined, blocked: string[]): string[] {
  if (requested?.length) {
    const unknown = requested.filter(id => !gates.some(gate => gate.id === id));
    if (unknown.length) throw new Error(`Unknown gate: ${unknown.join(', ')}`);
    const without = requested.filter(id => !gates.find(gate => gate.id === id)!.fix);
    if (without.length) throw new Error(`No fix command is configured for gate: ${without.join(', ')} (add \`fix: <command>\` to it)`);
    return [...new Set(requested)];
  }
  const fixable = gates.filter(gate => gate.fix);
  if (!fixable.length) throw new Error('No gate declares a fix command (add `fix: <command>` to a gate, for example `eslint . --fix`)');
  const failing = fixable.filter(gate => blocked.includes(gate.id));
  return (failing.length ? failing : fixable).map(gate => gate.id);
}

/** Paths git reports as changed under `directory`, ignoring the output directory. `undefined` when `directory` is not in a git repository. */
export async function dirtyFiles(directory: string, outputDir: string): Promise<string[] | undefined> {
  try { await git('git', ['rev-parse', '--is-inside-work-tree'], { cwd: directory }); } catch { return undefined; }
  const output = relative(directory, outputDir);
  const exclude = output && !output.startsWith('..') && resolve(directory, output) === outputDir ? [`:(exclude)${output}`] : [];
  const { stdout } = await git('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ...exclude], { cwd: directory, maxBuffer: GIT_BUFFER });
  return stdout.split('\0').filter(entry => entry.length > 3 && entry[2] === ' ').map(entry => entry.slice(3));
}

/** `git diff --stat` of the working tree. */
async function diffStat(directory: string): Promise<string> {
  return (await git('git', ['diff', '--stat'], { cwd: directory, maxBuffer: GIT_BUFFER })).stdout.trimEnd();
}

/** The newest stored run, or undefined when there is none. */
async function lastRun(configPath: string): Promise<RunResult | undefined> {
  try { return await getRun(configPath); } catch { return undefined; }
}

/**
 * Runs one gate's fix command with the capture, timeout and process-group cleanup of `run` and the gate's own timeout.
 * The command comes from the user's own config and runs in the project directory, like `run`.
 */
async function runFix(directory: string, gate: GateSpec, signal: AbortSignal) {
  const cleanups: (() => void | Promise<void>)[] = [];
  const context: Context = { signal, defer: cleanup => { cleanups.push(cleanup); } };
  try {
    const captured = await captureCommand(directory, { ...gate, run: gate.fix! }, context);
    const error = captured.error ?? (captured.exitCode === 0 ? undefined : `fix exited with ${captured.exitCode}`);
    return { exitCode: captured.exitCode, ...(error ? { error } : {}) };
  } finally { for (const cleanup of cleanups) await cleanup(); }
}

/**
 * Runs the fix command of the selected gates one after another, then runs exactly those gates again with the normal runner.
 * A fix never decides anything: the `run` in the result is the verdict, so exit codes are the same as for `qualitygate run`.
 */
export async function fixGates(configPath: string, signal: AbortSignal, options: FixOptions = {}): Promise<FixResult> {
  const { config, directory } = await loadConfig(configPath);
  const before = await lastRun(configPath);
  const blocked = before?.gates.filter(gate => gate.decision === 'BLOCK').map(gate => gate.id) ?? [];
  const ids = selectFixIds(config.gates, options.gates, blocked);
  const warnings: string[] = [];
  const dirty = await dirtyFiles(directory, config.outputDir);
  if (!dirty) warnings.push('Not a git repository: fixes cannot be reviewed or reverted with git, and no diff is shown.');
  else if (dirty.length && !options.allowDirty) throw new Error(`Refusing to fix: the working tree has ${dirty.length} uncommitted change(s) and fixes rewrite files, so their edits could not be told apart from yours. Commit or stash first, or pass --allow-dirty.`);
  const done = [];
  for (const id of ids) {
    const gate = config.gates.find(candidate => candidate.id === id)!;
    options.onFix?.({ kind: 'fix-start', id, command: gate.fix! });
    const outcome = await runFix(directory, gate, signal);
    options.onFix?.({ kind: 'fix-end', id, ...outcome });
    if (signal.aborted) throw new Error('Interrupted');
    done.push({ id, gate, ...outcome });
  }
  const run = await execute(configPath, signal, ids, { onProgress: options.onProgress });
  const after = new Map(run.gates.map(gate => [gate.id, gate.decision]));
  const was = new Map(before?.gates.map(gate => [gate.id, gate.decision]));
  return { schemaVersion: 1, warnings, run, ...(dirty ? { diffStat: await diffStat(directory) } : {}),
    gates: done.map(({ id, gate, exitCode, error }) => ({ id, fix: gate.fix!, fixExitCode: exitCode, ...(error ? { fixError: error } : {}),
      ...(was.has(id) ? { before: was.get(id) } : {}), ...(after.has(id) ? { after: after.get(id) } : {}) })) };
}

/** Text for `qualitygate fix`: one line per gate with its decision before and after, then the diff stat. */
export function describeFix(result: FixResult): string[] {
  const lines = result.gates.map(gate => `${gate.id}: ${gate.before ?? 'not run before'} -> ${gate.after ?? 'not run'}  (fix: ${gate.fix}${gate.fixError ? `; ${gate.fixError}` : ''})`);
  lines.push(result.diffStat ? `Changed by the fixes (git diff --stat):\n${result.diffStat}` : result.diffStat === '' ? 'The fixes changed no tracked file.' : 'No diff: not a git repository.');
  return lines;
}
