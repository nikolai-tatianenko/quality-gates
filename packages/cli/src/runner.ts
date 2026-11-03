import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parse } from 'yaml';
import { configSchema, type Config, type RunResult } from '../../protocol/src/index.js';
import { run } from '../../core/src/index.js';
import type { GatePlugin } from '../../plugin-sdk/src/index.js';
import { lighthousePlugin } from '../../plugins/lighthouse/src/index.js';
import { eslintPlugin } from '../../plugins/eslint/src/index.js';
import { sonarQubePlugin } from '../../plugins/sonarqube/src/index.js';
import { reviewPlugin } from '../../plugins/review/src/index.js';
import { commandPlugin } from '../../plugins/command/src/index.js';
import { builtinParsers } from '../../plugins/parsers/src/index.js';
import { filesystemPlugin } from '../../plugins/storage-fs/src/index.js';
import { jsonReporter } from '../../plugins/reporter-json/src/index.js';
/** Parses the YAML config; outputDir and gate commands resolve relative to the config file. */
export async function loadConfig(configPath: string): Promise<{ config: Config; directory: string }> {
  const path = resolve(configPath);
  const config = configSchema.parse(parse(await readFile(path, 'utf8')));
  const directory = await realpath(dirname(path));
  config.outputDir = resolve(directory, config.outputDir);
  return { config, directory };
}
/** Executes every gate (or only `only`) from the config with the built-in plugins. */
export async function execute(configPath: string, signal: AbortSignal, only?: string[]): Promise<RunResult> {
  const { config, directory } = await loadConfig(configPath);
  const command = commandPlugin(directory, builtinParsers);
  const eslint = eslintPlugin(directory);
  const sonar = sonarQubePlugin(directory);
  const review = reviewPlugin(directory, config.reviewSources ?? []);
  const gates: Record<string, GatePlugin> = { command, eslint, sonarqube: sonar, review };
  return run(config, {
    audit: lighthousePlugin(config.timeoutMs, config.chrome), gate: { ...command, run: (spec, context) => gates[spec.type]!.run(spec, context) },
    storage: filesystemPlugin(config.outputDir), reporter: jsonReporter,
  }, signal, only);
}
