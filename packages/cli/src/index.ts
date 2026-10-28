#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stringify } from 'yaml';
import { configSchema, exitCode, message, cliErrorSchema } from '../../protocol/src/index.js';
import { jsonReporter } from '../../plugins/reporter-json/src/index.js';
import { execute } from './runner.js';
const args = process.argv.slice(2);
const json = args.includes('--json');
const controller = new AbortController();
const interrupt = () => controller.abort();
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  let command: string | undefined;
  let configPath = '.qualitygate.yml';
  let explicitConfig = false;
  const urls: string[] = [];
  const only: string[] = [];
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--config') {
      const value = args[++i];
      if (!value || value.startsWith('-') || explicitConfig) throw new Error('Expected one --config <path>');
      explicitConfig = true; configPath = value; continue;
    }
    if (arg === '--gate') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error('Expected --gate <id>');
      only.push(value); continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    if (!command) command = arg;
    else urls.push(arg);
  }
  if (help || args.length === 0) {
    const help = 'Usage: qualitygate init [URL...] [--config <path>] [--json]\n       qualitygate run [--config <path>] [--gate <id>...] [--json]\n       qualitygate mcp [--config <path>]';
    console.log(json ? JSON.stringify({ schemaVersion: 1, help }) : help);
  } else if (command === 'init') {
    const config = configSchema.parse({ schemaVersion: 1, urls: urls.length ? urls : ['https://example.com'],
      thresholds: { performance: 80, accessibility: 90, seo: 90, 'best-practices': 90 } });
    controller.signal.throwIfAborted();
    await writeFile(configPath, stringify(config), { flag: 'wx' });
    console.log(json ? JSON.stringify({ schemaVersion: 1, configPath: resolve(configPath) }) : `Created ${resolve(configPath)}`);
  } else if (command === 'run') {
    if (urls.length) throw new Error('run reads URLs from configuration; unexpected arguments');
    const result = await execute(configPath, controller.signal, only.length ? only : undefined);
    if (json) process.stdout.write(jsonReporter.render(result));
    else {
      for (const item of result.gates) {
        console.log(`${item.decision} gate ${item.id} (${item.execution}, exit ${item.exitCode}, ${item.durationMs}ms)`);
        if (item.decision === 'BLOCK') for (const line of item.outputTail.trimEnd().split('\n').slice(-15)) console.log(`  | ${line}`);
        for (const issue of item.errors) console.log(`  ${issue}`);
        if (item.evidencePath) console.log(`  Evidence: ${item.evidencePath}`);
      }
      for (const item of result.results) {
        console.log(`${item.decision} ${item.url} (${item.execution})`);
        console.log(`  Scores: ${JSON.stringify(item.scores)}`);
        for (const issue of [...item.violations, ...item.errors]) console.log(`  ${issue}`);
        if (item.evidencePath) console.log(`  Evidence: ${item.evidencePath}`);
      }
      for (const error of result.errors) console.error(error);
      console.log(`${result.decision} (${result.execution})`);
      if (result.reportPath) console.log(`Report: ${result.reportPath}`);
    }
    process.exitCode = exitCode(result);
  } else if (command === 'mcp') {
    if (urls.length || only.length) throw new Error('mcp takes only --config');
    const { serve } = await import('../../mcp/src/index.js');
    await serve(configPath);
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  const result = cliErrorSchema.parse({ schemaVersion: 1, execution: controller.signal.aborted ? 'interrupted' : 'error', errors: [message(error)] });
  if (json) console.log(JSON.stringify(result));
  else console.error(`QualityGate: ${result.errors.join('\n')}`);
  process.exitCode = controller.signal.aborted ? 130 : 2;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
