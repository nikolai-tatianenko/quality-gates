import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parse } from 'yaml';
import { configSchema, type Config, type RunResult } from '../../protocol/src/index.js';
import { run } from '../../core/src/index.js';
import { lighthousePlugin } from '../../plugins/lighthouse/src/index.js';
import { commandPlugin } from '../../plugins/command/src/index.js';
import { filesystemPlugin } from '../../plugins/storage-fs/src/index.js';
import { jsonReporter } from '../../plugins/reporter-json/src/index.js';
/** Parses the YAML config; outputDir and gate commands resolve relative to the config file. */
export async function loadConfig(configPath: string): Promise<{ config: Config; directory: string }> {
  const path = resolve(configPath);
  const config = configSchema.parse(parse(await readFile(path, 'utf8')));
  const directory = dirname(path);
  config.outputDir = resolve(directory, config.outputDir);
  return { config, directory };
}
/** Executes every gate (or only `only`) from the config with the built-in plugins. */
export async function execute(configPath: string, signal: AbortSignal, only?: string[]): Promise<RunResult> {
  const { config, directory } = await loadConfig(configPath);
  return run(config, {
    audit: lighthousePlugin(config.timeoutMs), gate: commandPlugin(directory),
    storage: filesystemPlugin(config.outputDir), reporter: jsonReporter,
  }, signal, only);
}
