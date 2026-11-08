import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parse } from 'yaml';
import { configSchema, message, type Config, type RunResult } from '../../protocol/src/index.js';
import { runWith, type ProgressEvent } from '../../core/src/index.js';
import { recordRun, toHistoryRun } from '../../core/src/history.js';
import { loadExternalPlugins } from '../../core/src/external.js';
import type { GatePlugin } from '../../plugin-sdk/src/index.js';
import { lighthousePlugin } from '../../plugins/lighthouse/src/index.js';
import { eslintPlugin } from '../../plugins/eslint/src/index.js';
import { sonarQubePlugin } from '../../plugins/sonarqube/src/index.js';
import { reviewPlugin } from '../../plugins/review/src/index.js';
import { commandPlugin } from '../../plugins/command/src/index.js';
import { builtinParsers } from '../../plugins/parsers/src/index.js';
import { builtinEcosystems } from '../../plugins/ecosystems/src/index.js';
import { filesystemPlugin } from '../../plugins/storage-fs/src/index.js';
import { jsonReporter } from '../../plugins/reporter-json/src/index.js';
import { cachedGates, changedFiles, changedGateIds, inputHash, saveCache } from './select.js';
/** Ids third-party plugins may not reuse. */
export const builtinIds = [...Object.keys(builtinParsers), ...builtinEcosystems.map(plugin => plugin.id), 'command', 'eslint', 'sonarqube', 'review'];
/** Parses the YAML config; outputDir and gate commands resolve relative to the config file. */
export async function loadConfig(configPath: string): Promise<{ config: Config; directory: string }> {
  const path = resolve(configPath);
  const config = configSchema.parse(parse(await readFile(path, 'utf8')));
  const directory = await realpath(dirname(path));
  config.outputDir = resolve(directory, config.outputDir);
  return { config, directory };
}
export interface ExecuteFlags { changed?: boolean; cache?: boolean; /** Audit only this URL with the configured thresholds; no gates run and the run is not recorded in the history. */ scanUrl?: string; onProgress?: (event: ProgressEvent) => void }
/** Gate ids to run: `only`, narrowed to the gates affected by changed files when `changed` is set. */
async function selectIds(config: Config, directory: string, only: string[] | undefined, changed: boolean | undefined) {
  const unknown = only?.filter(id => !config.gates.some(gate => gate.id === id));
  if (unknown?.length) throw new Error(`Unknown gate: ${unknown.join(', ')}`);
  if (!changed) return only;
  const wanted = changedGateIds(config.gates, await changedFiles(directory));
  return only ? only.filter(id => wanted.includes(id)) : wanted;
}
/** Stores the finished run in the history database. It must never change the verdict or exit code, so a failure is only a warning. */
async function remember(config: Config, directory: string, result: RunResult, known: Record<string, string>) {
  try {
    const hashes = { ...known };
    for (const gate of config.gates) if (!(gate.id in hashes)) { const hash = await inputHash(directory, gate); if (hash) hashes[gate.id] = hash; }
    await recordRun(config.outputDir, toHistoryRun(result, hashes));
  } catch (error) { process.stderr.write(`QualityGate: warning: run history not saved (${message(error)})\n`); }
}
/** Executes every gate (or only `only`) from the config with the built-in plugins. */
export async function execute(configPath: string, signal: AbortSignal, only?: string[], flags: ExecuteFlags = {}): Promise<RunResult> {
  const { config, directory } = await loadConfig(configPath);
  if (flags.scanUrl) {
    if (!config.thresholds) throw new Error('No Lighthouse thresholds are configured; add urls and thresholds to scan a page');
    config.gates = []; config.plugins = []; config.urls = [flags.scanUrl];
  }
  const external = await loadExternalPlugins(directory, config.plugins ?? [], builtinIds);
  const command = commandPlugin(directory, { ...builtinParsers, ...external.parsers });
  const eslint = eslintPlugin(directory);
  const sonar = sonarQubePlugin(directory);
  const review = reviewPlugin(directory, config.reviewSources ?? []);
  const gates = new Map<string, GatePlugin>(Object.entries({ command, eslint, sonarqube: sonar, review, ...external.gates }));
  const unknown = config.gates.find(gate => !gates.has(gate.type));
  if (unknown) throw new Error(`Unknown gate type: ${unknown.type}`);
  const ids = await selectIds(config, directory, only, flags.changed);
  const selected = config.gates.filter(gate => !ids || ids.includes(gate.id));
  const { cached, hashes } = flags.cache ? await cachedGates(directory, config.outputDir, selected) : { cached: {}, hashes: {} };
  const result = await runWith(config, {
    audit: lighthousePlugin(config.timeoutMs, config.chrome), gate: { ...command, run: (spec, context) => gates.get(spec.type)!.run(spec, context) },
    storage: filesystemPlugin(config.outputDir), reporter: jsonReporter,
  }, { signal, only: ids, cached, onProgress: flags.onProgress });
  if (flags.cache) await saveCache(config.outputDir, hashes, result);
  if (!flags.scanUrl) await remember(config, directory, result, hashes);
  return result;
}
