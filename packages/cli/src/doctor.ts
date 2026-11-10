import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { getChromePath } from 'chrome-launcher';
import { ZodError } from 'zod';
import { message, type Config } from '../../protocol/src/index.js';
import { readRuns, type HistoryGate } from '../../core/src/history.js';
import { loadConfig } from './runner.js';

/** The oldest Node this tool supports; pinned to `engines.node` in package.json by a test. */
export const MIN_NODE = '22.23.4';
/** How many recent runs `list` looks through to find the last result of each gate. */
const LIST_RUNS = 50;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const firstLine = (error: unknown) => message(error).split('\n')[0]!;

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';
export interface Check { id: string; status: CheckStatus; detail: string }
export interface DoctorReport { schemaVersion: 1; healthy: boolean; checks: Check[] }

/** Compares dotted versions numerically (a leading `v` is ignored): negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const left = a.replace(/^v/, '').split('.').map(Number); const right = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

interface ListedGate { id: string; type: string; last: { runId: string; startedAt: string; status: HistoryGate['status']; durationMs: number } | null }

/** `qualitygate list`: the configured gates and the newest recorded result of each. Read-only; never shows commands or output. */
export async function listCommand(configPath: string, json: boolean): Promise<string> {
  const { config } = await loadConfig(configPath);
  let warning: string | undefined;
  const runs = await readRuns(config.outputDir, LIST_RUNS).catch((error: unknown) => { warning = `run history unreadable (${firstLine(error)})`; return []; });
  const gates: ListedGate[] = config.gates.map(spec => {
    for (const run of runs) {
      const found = run.gates.find(item => item.id === spec.id);
      if (found) return { id: spec.id, type: spec.type, last: { runId: run.id, startedAt: run.startedAt, status: found.status, durationMs: found.durationMs } };
    }
    return { id: spec.id, type: spec.type, last: null };
  });
  if (json) return JSON.stringify({ schemaVersion: 1, gates, ...(warning ? { warning } : {}) });
  const idWidth = Math.max(...gates.map(g => g.id.length)); const typeWidth = Math.max(...gates.map(g => g.type.length));
  return [...(gates.length ? gates.map(g => `${g.id.padEnd(idWidth)}  ${g.type.padEnd(typeWidth)}  ${g.last ? `${g.last.status}  ${g.last.startedAt}  ${seconds(g.last.durationMs)}` : 'never run'}`) : ['No gates configured.']),
    ...(warning ? ['', `Warning: ${warning}`] : [])].join('\n');
}

const BUILTINS = new Set(['cd', 'echo', 'eval', 'exit', 'export', 'set', 'unset', 'test', 'true', 'false', 'source', '.', ':', '[', 'read', 'wait', 'if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while']);
/** The programs a shell command line starts: the first word of each `&&`, `||`, `;`, `|` or `&` segment, minus assignments, shell builtins and anything computed. */
export function commandTools(command: string): string[] {
  const tools = new Set<string>();
  for (const segment of command.replace(/"[^"]*"|'[^']*'/g, '\0').split(/&&|\|\||[;|&\n]/)) {
    const word = segment.trim().split(/\s+/).find(token => !/^[A-Za-z_]\w*=/.test(token));
    if (word && !/[$`(\0]/.test(word) && !BUILTINS.has(word)) tools.add(word);
  }
  return [...tools];
}

const executable = (path: string) => access(path, constants.X_OK).then(() => true, () => false);
/** The executable a program name resolves to: a path relative to `directory`, or the first match on `PATH`. */
async function locate(tool: string, directory: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (tool.includes('/')) { const path = resolve(directory, tool); return await executable(path) ? path : undefined; }
  for (const folder of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const path = join(folder, tool);
    if (await executable(path) && (await stat(path)).isFile()) return path;
  }
  return undefined;
}

/** Chrome matters only for URL audits. `CHROME_PATH` wins, as in the audit itself. */
async function chromeCheck(config: Config, env: NodeJS.ProcessEnv): Promise<Check> {
  if (!config.urls.length) return { id: 'chrome', status: 'skipped', detail: 'not needed: no URLs are configured' };
  let path: string;
  try { path = env.CHROME_PATH || getChromePath(); } catch (error) { return { id: 'chrome', status: 'fail', detail: `not found (${firstLine(error)}); install Chrome or set CHROME_PATH` }; }
  return await executable(path) ? { id: 'chrome', status: 'ok', detail: path } : { id: 'chrome', status: 'fail', detail: `${path} is not an executable file; fix CHROME_PATH` };
}

async function toolChecks(config: Config, directory: string, env: NodeJS.ProcessEnv): Promise<Check[]> {
  const users = new Map<string, string[]>();
  for (const gate of config.gates) {
    if (!['command', 'eslint', 'sonarqube'].includes(gate.type)) continue;
    for (const tool of new Set([...commandTools(gate.run), ...commandTools(gate.fix ?? '')])) users.set(tool, [...users.get(tool) ?? [], gate.id]);
  }
  return Promise.all([...users].map(async ([tool, gates]): Promise<Check> => {
    const found = await locate(tool, directory, env);
    return { id: `tool:${tool}`, status: found ? 'ok' : 'fail', detail: `${found ?? (tool.includes('/') ? 'not an executable file' : 'not found on PATH')} (gates: ${gates.join(', ')})` };
  }));
}

/** The output directory is writable when it is, or when the nearest existing parent is; nothing is created. */
async function outputCheck(outputDir: string): Promise<Check> {
  let path = outputDir;
  for (;;) {
    const info = await stat(path).catch(() => undefined);
    if (info) {
      if (!info.isDirectory()) return { id: 'output-dir', status: 'fail', detail: `${path} exists but is not a directory` };
      return await access(path, constants.W_OK).then(() => true, () => false)
        ? { id: 'output-dir', status: 'ok', detail: path === outputDir ? outputDir : `${outputDir} (will be created in ${path})` }
        : { id: 'output-dir', status: 'fail', detail: `${path} is not writable` };
    }
    path = dirname(path);
  }
}

async function historyCheck(outputDir: string): Promise<Check> {
  try {
    const runs = await readRuns(outputDir, 1000);
    return runs.length ? { id: 'history', status: 'ok', detail: `${runs.length} run${runs.length === 1 ? '' : 's'} readable` } : { id: 'history', status: 'skipped', detail: 'no runs recorded yet' };
  } catch (error) { return { id: 'history', status: 'warn', detail: `unreadable (${firstLine(error)}); runs still work and only warn` }; }
}

/** What is wrong with a config, without echoing its content: schema issues give paths and rules, other errors only their first line. */
function configProblem(error: unknown): string {
  return error instanceof ZodError ? error.issues.map(issue => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; ') : firstLine(error);
}

/** Runs every doctor check. Read-only; `version` and `env` are injectable for tests. */
export async function runDoctor(configPath: string, env: NodeJS.ProcessEnv = process.env, version: string = process.version): Promise<DoctorReport> {
  const checks: Check[] = [compareVersions(version, MIN_NODE) >= 0
    ? { id: 'node', status: 'ok', detail: `${version} (needs >=${MIN_NODE})` } : { id: 'node', status: 'fail', detail: `${version} is older than ${MIN_NODE}` }];
  try {
    const { config, directory } = await loadConfig(configPath);
    checks.push({ id: 'config', status: 'ok', detail: `${configPath}: ${config.gates.length} gate${config.gates.length === 1 ? '' : 's'}, ${config.urls.length} URL${config.urls.length === 1 ? '' : 's'}` },
      await chromeCheck(config, env), ...await toolChecks(config, directory, env), await outputCheck(config.outputDir), await historyCheck(config.outputDir));
  } catch (error) { checks.push({ id: 'config', status: 'fail', detail: configProblem(error) }); }
  return { schemaVersion: 1, healthy: !checks.some(check => check.status === 'fail'), checks };
}

/** `qualitygate doctor`: the report as text or JSON and the exit code (0 healthy, 2 when a check failed). Never changes a verdict. */
export async function doctorCommand(configPath: string, json: boolean, env: NodeJS.ProcessEnv = process.env): Promise<{ text: string; code: number }> {
  const report = await runDoctor(configPath, env);
  const code = report.healthy ? 0 : 2;
  if (json) return { text: JSON.stringify(report), code };
  const width = Math.max(...report.checks.map(check => check.id.length));
  return { code, text: [...report.checks.map(check => `${check.status.padEnd(7)}  ${check.id.padEnd(width)}  ${check.detail}`), '',
    report.healthy ? 'Everything needed is in place.' : 'Problems found: fix the lines marked fail.'].join('\n') };
}
