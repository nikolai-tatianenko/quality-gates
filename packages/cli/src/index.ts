#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { z } from 'zod';
import { configSchema, exitCode, message, cliErrorSchema } from '../../protocol/src/index.js';
import { jsonReporter } from '../../plugins/reporter-json/src/index.js';
import { clients, clientConfig } from '../../integrations/src/index.js';
import { getRun } from '../../service/src/index.js';
import { askModel, providers } from '../../model-client/src/index.js';
import { connectTools } from '../../model-client/src/mcp-host.js';
import { execute } from './runner.js';
import { printRun } from './output.js';
const args = process.argv.slice(2);
const json = args.includes('--json');
const controller = new AbortController();
const interrupt = () => controller.abort();
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
try {
  let command: string | undefined;
  const values = new Map<string, string>();
  const positional: string[] = []; const only: string[] = [];
  let help = false;
  const valueFlags = ['--config', '--client', '--provider', '--model', '--base-url', '--prompt', '--api-key-env', '--max-turns', '--timeout-ms'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (valueFlags.includes(arg) || arg === '--gate') {
      const value = args[++i];
      if (!value || value.startsWith('-') || (arg !== '--gate' && values.has(arg))) throw new Error(`Expected one ${arg} <value>`);
      if (arg === '--gate') only.push(value); else values.set(arg, value);
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    if (!command) command = arg; else positional.push(arg);
  }
  const configPath = values.get('--config') || '.qualitygate.yml';
  const entry = fileURLToPath(import.meta.url);
  const validFlags: Record<string, string[]> = {
    init: ['--config'], run: ['--config'], mcp: ['--config'], inspect: ['--config'],
    connect: ['--config', '--client'], ask: ['--config', '--provider', '--model', '--base-url', '--prompt', '--api-key-env', '--max-turns', '--timeout-ms'],
  };
  if (command && validFlags[command]) {
    for (const key of values.keys()) if (!validFlags[command]!.includes(key)) throw new Error(`${command} does not accept ${key}`);
    if (only.length && command !== 'run') throw new Error(`${command} does not accept --gate`);
  }
  if (help || args.length === 0) {
    const help = 'Usage: qualitygate init [URL...] [--config <path>] [--json]\n'
      + '       qualitygate run [--config <path>] [--gate <id>...] [--json]\n'
      + '       qualitygate inspect [runId] [--config <path>] [--json]\n'
      + '       qualitygate mcp [--config <path>]\n'
      + '       qualitygate connect --client <claude|cursor|codex|vscode|generic> [--config <path>] [--json]\n'
      + '       qualitygate ask --provider <ollama|vllm|openai-compatible> --model <name> --prompt <text> [--base-url <url>] [--config <path>] [--json]';
    console.log(json ? JSON.stringify({ schemaVersion: 1, help }) : help);
  } else if (command === 'init') {
    const config = configSchema.parse({ schemaVersion: 1, urls: positional.length ? positional : ['https://example.com'],
      thresholds: { performance: 80, accessibility: 90, seo: 90, 'best-practices': 90 } });
    controller.signal.throwIfAborted(); await writeFile(configPath, stringify(config), { flag: 'wx' });
    console.log(json ? JSON.stringify({ schemaVersion: 1, configPath: resolve(configPath) }) : `Created ${resolve(configPath)}`);
  } else if (command === 'run' || command === 'inspect') {
    if ((command === 'run' && positional.length) || positional.length > 1) throw new Error(`${command}: unexpected arguments`);
    const result = command === 'run' ? await execute(configPath, controller.signal, only.length ? only : undefined) : await getRun(configPath, positional[0]);
    if (json) process.stdout.write(jsonReporter.render(result));
    else {
      printRun(result);
    }
    process.exitCode = exitCode(result);
  } else if (command === 'mcp') {
    if (positional.length) throw new Error('mcp takes only --config');
    const { serve } = await import('../../mcp/src/index.js');
    await serve(configPath, controller.signal);
    if (controller.signal.aborted) process.exitCode = 130;
  } else if (command === 'connect') {
    if (positional.length) throw new Error('connect does not accept positional arguments');
    const client = z.enum(clients).parse(values.get('--client'));
    const config = clientConfig(client, configPath, entry);
    process.stdout.write(json ? JSON.stringify({ schemaVersion: 1, client, ...config }) + '\n' : config.content);
  } else if (command === 'ask') {
    if (positional.length) throw new Error('ask uses --prompt');
    const provider = z.enum(providers).parse(values.get('--provider'));
    const model = z.string().min(1).parse(values.get('--model'));
    const prompt = z.string().min(1).parse(values.get('--prompt'));
    const keyEnv = values.get('--api-key-env');
    if (keyEnv && !process.env[keyEnv]) throw new Error(`Environment variable ${keyEnv} is not set`);
    const connection = await connectTools(entry, resolve(configPath));
    try {
      const result = await askModel({ provider, model, prompt, baseUrl: values.get('--base-url'),
        apiKey: keyEnv ? process.env[keyEnv] : undefined,
        timeoutMs: values.has('--timeout-ms') ? Number(values.get('--timeout-ms')) : undefined,
        maxTurns: values.has('--max-turns') ? Number(values.get('--max-turns')) : undefined,
      }, connection.host, controller.signal);
      console.log(json ? JSON.stringify(result) : `${result.answer}\n\nVerified decision: ${result.decision}\nReport: ${result.run.reportPath ?? 'not saved'}`);
      process.exitCode = exitCode(result.run);
    } finally { await connection.close(); }
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  const result = cliErrorSchema.parse({ schemaVersion: 1, execution: controller.signal.aborted ? 'interrupted' : 'error', errors: [message(error)] });
  if (json) console.log(JSON.stringify(result)); else console.error(`QualityGate: ${result.errors.join('\n')}`);
  process.exitCode = controller.signal.aborted ? 130 : 2;
} finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
