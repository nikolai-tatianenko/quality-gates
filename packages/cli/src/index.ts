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
import { execute, loadConfig } from './runner.js';
import { syncSources, restoreSources, checkSources, listSources, readMethodology } from '../../review-sources/src/index.js';
import { printRun } from './output.js';
import { setupProject } from './setup.js';
import { readReport, renderMarkdown, publishDescription, exportReport, publishStatus, publishComment, notifySlack } from '../../ci/src/index.js';
const args = process.argv.slice(2);
const json = args.includes('--json');
const write = args.includes('--write');
const controller = new AbortController();
const interrupt = () => controller.abort();
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
try {
  let command: string | undefined;
  const values = new Map<string, string>();
  const positional: string[] = []; const only: string[] = []; const plugins: string[] = [];
  let help = false;
  const valueFlags = ['--config', '--client', '--provider', '--model', '--base-url', '--prompt', '--api-key-env', '--max-turns', '--timeout-ms', '--input', '--output', '--repository', '--number', '--head', '--api-url', '--token-env', '--out', '--report-url', '--head-repository', '--webhook-env'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--write') continue;
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (valueFlags.includes(arg) || arg === '--gate' || arg === '--plugin') {
      const value = args[++i];
      if (!value || value.startsWith('-') || (arg !== '--gate' && arg !== '--plugin' && values.has(arg))) throw new Error(`Expected one ${arg} <value>`);
      if (arg === '--gate') only.push(value); else if (arg === '--plugin') plugins.push(value); else values.set(arg, value);
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    if (!command) command = arg; else positional.push(arg);
  }
  const configPath = values.get('--config') || '.qualitygate.yml';
  const entry = fileURLToPath(import.meta.url);
  const validFlags: Record<string, string[]> = {
    init: ['--config'], setup: ['--config'], run: ['--config'], mcp: ['--config'], inspect: ['--config'], sources: ['--config'],
    report: ['--input', '--output'], export: ['--out', '--input', '--config'], pr: ['--input', '--provider', '--repository', '--number', '--head', '--api-url', '--token-env'],
    status: ['--input', '--repository', '--head', '--report-url', '--head-repository', '--api-url', '--token-env'],
    comment: ['--input', '--provider', '--repository', '--number', '--head', '--report-url', '--head-repository', '--api-url', '--token-env'],
    notify: ['--input', '--webhook-env', '--report-url'],
    connect: ['--config', '--client'], ask: ['--config', '--provider', '--model', '--base-url', '--prompt', '--api-key-env', '--max-turns', '--timeout-ms'],
  };
  if (command && validFlags[command]) {
    for (const key of values.keys()) if (!validFlags[command]!.includes(key)) throw new Error(`${command} does not accept ${key}`);
    if (only.length && command !== 'run') throw new Error(`${command} does not accept --gate`);
    if (plugins.length && command !== 'setup') throw new Error(`${command} does not accept --plugin`);
    if (write && !['pr', 'status', 'comment', 'notify'].includes(command)) throw new Error(`${command} does not accept --write`);
  }
  if (help || args.length === 0) {
    const help = 'Usage: qualitygate init [URL...] [--config <path>] [--json]\n'
      + '       qualitygate setup [--config <path>] [--plugin <package>...] [--json]\n'
      + '       qualitygate run [--config <path>] [--gate <id>...] [--json]\n'
      + '       qualitygate inspect [runId] [--config <path>] [--json]\n'
      + '       qualitygate mcp [--config <path>]\n'
      + '       qualitygate report --input <run.json> [--output <report.md>] [--json]\n'
      + '       qualitygate export --out <dir> [--input <run.json>] [--config <path>] [--json]\n'
      + '       qualitygate pr --provider <github|gitlab|bitbucket> --repository <owner/repo> --number <id> --head <sha> --input <run.json> [--write] [--json]\n'
      + '       qualitygate status --repository <owner/repo> --head <sha> --input <run.json> [--report-url <https-url>] [--write] [--json]\n'
      + '       qualitygate comment --repository <owner/repo> --number <id> --head <sha> --input <run.json> [--report-url <https-url>] [--write] [--json]\n'
      + '       qualitygate notify --input <run.json> [--webhook-env <NAME>] [--report-url <https-url>] [--write] [--json]\n'
      + '       qualitygate sources <sync|restore|check|list|read> [sourceId] [filename] [--config <path>] [--json]\n'
      + '       qualitygate connect --client <claude|cursor|codex|vscode|generic> [--config <path>] [--json]\n'
      + '       qualitygate ask --provider <ollama|vllm|openai-compatible> --model <name> --prompt <text> [--base-url <url>] [--config <path>] [--json]';
    console.log(json ? JSON.stringify({ schemaVersion: 1, help }) : help);
  } else if (command === 'init') {
    const config = configSchema.parse({ schemaVersion: 1, urls: positional.length ? positional : ['https://example.com'],
      thresholds: { performance: 80, accessibility: 90, seo: 90, 'best-practices': 90 } });
    controller.signal.throwIfAborted(); await writeFile(configPath, stringify(config), { flag: 'wx' });
    console.log(json ? JSON.stringify({ schemaVersion: 1, configPath: resolve(configPath) }) : `Created ${resolve(configPath)}`);
  } else if (command === 'setup') {
    if (positional.length) throw new Error('setup takes only --config');
    controller.signal.throwIfAborted();
    const result = await setupProject(configPath, undefined, plugins);
    if (json) console.log(JSON.stringify({ schemaVersion: 1, ...result }));
    else console.log([`Created ${result.configPath}`, `Ecosystems: ${result.ecosystems.join(', ')}`,
      ...(result.plugins.length ? [`Plugins (run unsandboxed with your permissions): ${result.plugins.join(', ')}`] : []), ...result.gates.map(gate => `  ${gate.id}: ${gate.run}`),
      ...(result.gitignore.length ? [`Added to .gitignore: ${result.gitignore.join(' ')}`] : []),
      'Check that the test script exits (not watch mode), then run: qualitygate run'].join('\n'));
  } else if (command === 'run' || command === 'inspect') {
    if ((command === 'run' && positional.length) || positional.length > 1) throw new Error(`${command}: unexpected arguments`);
    const result = command === 'run' ? await execute(configPath, controller.signal, only.length ? only : undefined) : await getRun(configPath, positional[0]);
    if (json) process.stdout.write(jsonReporter.render(result));
    else {
      printRun(result);
    }
    process.exitCode = exitCode(result);
  } else if (['report', 'pr', 'status', 'comment', 'notify'].includes(command ?? '')) {
    if (positional.length) throw new Error(`${command} does not accept positional arguments`);
    const input = z.string().min(1).parse(values.get('--input'));
    if (command === 'report') {
      const markdown = renderMarkdown(await readReport(input));
      const output = values.get('--output');
      if (output) await writeFile(output, markdown);
      if (json) console.log(JSON.stringify({ schemaVersion: 1, ...(output ? { output: resolve(output) } : { markdown }) }));
      else if (!output) process.stdout.write(markdown);
    } else if (command === 'status') {
      const result = await publishStatus({ repository: values.get('--repository'), head: values.get('--head'), reportUrl: values.get('--report-url'), headRepository: values.get('--head-repository'),
        apiUrl: values.get('--api-url'), tokenEnv: values.get('--token-env'), write }, input, controller.signal);
      console.log(json ? JSON.stringify(result) : `${result.payload.description}${result.write ? ' (posted)' : ' (dry run)'}`);
    } else if (command === 'comment') {
      const result = await publishComment({ provider: values.get('--provider') ?? 'github', repository: values.get('--repository'), number: values.get('--number'), head: values.get('--head'), reportUrl: values.get('--report-url'),
        headRepository: values.get('--head-repository'), apiUrl: values.get('--api-url'), tokenEnv: values.get('--token-env'), write }, input, controller.signal);
      console.log(json ? JSON.stringify(result) : 'body' in result ? result.body : `Comment: ${result.reason}`);
    } else if (command === 'notify') {
      const result = await notifySlack({ webhookEnv: values.get('--webhook-env'), reportUrl: values.get('--report-url'), write }, input, controller.signal);
      console.log(json ? JSON.stringify(result) : result.message ? `${result.message.text}${result.sent ? ' (sent)' : ' (dry run)'}` : `Slack: ${result.reason}`);
    } else {
      const result = await publishDescription({ provider: values.get('--provider'), repository: values.get('--repository'),
        number: values.get('--number'), head: values.get('--head'), apiUrl: values.get('--api-url'), tokenEnv: values.get('--token-env'), write }, input, controller.signal);
      console.log(json ? JSON.stringify(result) : 'body' in result ? result.body : `PR: ${result.reason}`);
    }
  } else if (command === 'export') {
    if (positional.length) throw new Error('export does not accept positional arguments');
    const out = z.string().min(1).parse(values.get('--out'));
    const input = values.get('--input');
    const result = await exportReport(input ? await readReport(input) : await getRun(configPath), resolve(out));
    console.log(json ? JSON.stringify({ schemaVersion: 1, ...result }) : `Exported ${result.index}`);
  } else if (command === 'sources') {
    const [action, id, file] = positional;
    if (!['sync', 'restore', 'check', 'list', 'read'].includes(action ?? '') || positional.length > (action === 'read' ? 3 : 1) || (action === 'read' && !id)) throw new Error('sources: expected sync, restore, check, list, or read <sourceId> [filename]');
    const { config, directory } = await loadConfig(configPath);
    const sources = config.reviewSources ?? [];
    const result = action === 'sync' ? await syncSources(directory, sources, controller.signal)
      : action === 'restore' ? await restoreSources(directory, sources, controller.signal)
      : action === 'check' ? await checkSources(directory, sources, controller.signal)
        : action === 'list' ? await listSources(directory, sources)
          : await readMethodology(directory, sources, id!, { file, signal: controller.signal });
    console.log(JSON.stringify(result, null, json ? undefined : 2));
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
