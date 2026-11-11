#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { z } from 'zod';
import { configSchema, exitCode, message, cliErrorSchema } from '../../protocol/src/index.js';
import { jsonReporter } from '../../plugins/reporter-json/src/index.js';
import { clients, clientConfig } from '../../integrations/src/index.js';
import { getRun } from '../../service/src/index.js';
import { askModel, providers } from '../../model-client/src/index.js';
import { connectTools } from '../../model-client/src/mcp-host.js';
import { execute, loadConfig, builtinIds } from './runner.js';
import { loadExternalPlugins } from '../../core/src/external.js';
import { syncSources, restoreSources, checkSources, listSources, readMethodology } from '../../review-sources/src/index.js';
import { printRun } from './output.js';
import { liveView, liveEnabled } from './live.js';
import { setupProject } from './setup.js';
import { fixGates, describeFix } from './fix.js';
import { serveBridge, revokeAll } from '../../bridge/src/index.js';
import { DEFAULT_PORT } from '../../bridge/src/serve.js';
import { historyCommand, trendsCommand } from './history.js';
import { listCommand, doctorCommand } from './doctor.js';
import { readTrends } from '../../core/src/history.js';
import { readReport, renderMarkdown, renderSarif, publishDescription, exportReport, publishStatus, publishComment, notifySlack } from '../../ci/src/index.js';
const args = process.argv.slice(2);
const json = args.includes('--json');
const write = args.includes('--write');
const changed = args.includes('--changed');
const cache = args.includes('--cache');
const noGitignore = args.includes('--no-gitignore');
const noLive = args.includes('--no-live');
const sarif = args.includes('--sarif');
const revoke = args.includes('--revoke-all');
const allowDirty = args.includes('--allow-dirty');
const all = args.includes('--all');
const controller = new AbortController();
const interrupt = () => controller.abort();
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
try {
  let command: string | undefined;
  const values = new Map<string, string>();
  const positional: string[] = []; const only: string[] = []; const plugins: string[] = []; const origins: string[] = [];
  let help = false;
  const valueFlags = ['--config', '--client', '--provider', '--model', '--base-url', '--prompt', '--api-key-env', '--max-turns', '--timeout-ms', '--input', '--output', '--repository', '--number', '--head', '--api-url', '--token-env', '--out', '--report-url', '--head-repository', '--author', '--webhook-env', '--from', '--limit', '--port', '--since', '--decision', '--baseline'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--write' || arg === '--changed' || arg === '--cache' || arg === '--no-gitignore' || arg === '--sarif' || arg === '--no-live' || arg === '--revoke-all' || arg === '--allow-dirty' || arg === '--all') continue;
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (valueFlags.includes(arg) || arg === '--gate' || arg === '--only' || arg === '--plugin' || arg === '--origin') {
      const value = args[++i];
      const repeatable = arg === '--gate' || arg === '--only' || arg === '--plugin' || arg === '--origin';
      if (!value || value.startsWith('-') || (!repeatable && values.has(arg))) throw new Error(`Expected one ${arg} <value>`);
      if (arg === '--gate' || arg === '--only') only.push(value); else if (arg === '--plugin') plugins.push(value); else if (arg === '--origin') origins.push(value); else values.set(arg, value);
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    if (!command) command = arg; else positional.push(arg);
  }
  const configPath = values.get('--config') || '.qualitygate.yml';
  const entry = fileURLToPath(import.meta.url);
  const validFlags: Record<string, string[]> = {
    init: ['--config'], setup: ['--config', '--from'], run: ['--config'], fix: ['--config'], visual: ['--config'], ui: ['--config'], mcp: ['--config'], inspect: ['--config'], list: ['--config'], doctor: ['--config'], history: ['--config', '--limit', '--since', '--decision', '--baseline'], trends: ['--config', '--limit', '--since', '--decision'], sources: ['--config'], bridge: ['--config', '--port', '--origin'],
    report: ['--input', '--output', '--config'], export: ['--out', '--input', '--config'], pr: ['--input', '--provider', '--repository', '--number', '--head', '--head-repository', '--api-url', '--token-env'],
    status: ['--input', '--repository', '--head', '--report-url', '--head-repository', '--api-url', '--token-env'],
    comment: ['--input', '--provider', '--repository', '--number', '--head', '--report-url', '--head-repository', '--author', '--api-url', '--token-env'],
    notify: ['--input', '--webhook-env', '--report-url'],
    connect: ['--config', '--client'], ask: ['--config', '--provider', '--model', '--base-url', '--prompt', '--api-key-env', '--max-turns', '--timeout-ms'],
  };
  if (command && validFlags[command]) {
    for (const key of values.keys()) if (!validFlags[command]!.includes(key)) throw new Error(`${command} does not accept ${key}`);
    if (only.length && !['run', 'fix', 'history', 'trends'].includes(command)) throw new Error(`${command} does not accept --gate or --only`);
    if ((changed || cache) && command !== 'run') throw new Error(`${command} does not accept --changed or --cache`);
    if (allowDirty && command !== 'fix') throw new Error(`${command} does not accept --allow-dirty`);
    if (noLive && command !== 'run') throw new Error(`${command} does not accept --no-live`);
    if (noGitignore && command !== 'setup') throw new Error(`${command} does not accept --no-gitignore`);
    if (sarif && command !== 'report') throw new Error(`${command} does not accept --sarif`);
    if (plugins.length && command !== 'setup') throw new Error(`${command} does not accept --plugin`);
    if (all && command !== 'visual') throw new Error(`${command} does not accept --all`);
    if (revoke && command !== 'bridge') throw new Error(`${command} does not accept --revoke-all`);
    if (values.has('--port') && command !== 'bridge') throw new Error(`${command} does not accept --port`);
    if (origins.length && command !== 'bridge') throw new Error(`${command} does not accept --origin`);
    if (write && !['pr', 'status', 'comment', 'notify'].includes(command)) throw new Error(`${command} does not accept --write`);
  }
  if (help || args.length === 0) {
    const help = 'Usage: qualitygate init [URL...] [--config <path>] [--json]\n'
      + '       qualitygate setup [--config <path>] [--from <gates.json|gates.mjs>] [--plugin <package>...] [--no-gitignore] [--json]\n'
      + '       qualitygate run [--config <path>] [--gate|--only <id>...] [--changed] [--cache] [--no-live] [--json]\n'
      + '       qualitygate fix [--config <path>] [--gate <id>...] [--allow-dirty] [--json]\n'
      + '       qualitygate visual approve <name>|--all [--config <path>] [--json]   (optional visual-regression plugin)\n'
      + '       qualitygate ui [--config <path>]\n'
      + '       qualitygate inspect [runId] [--config <path>] [--json]\n'
      + '       qualitygate list [--config <path>] [--json]\n'
      + '       qualitygate doctor [--config <path>] [--json]\n'
      + '       qualitygate history [--limit <n>] [--gate <id>...] [--since <date>] [--decision <PASS|BLOCK>] [--baseline <runId>] [--config <path>] [--json]\n'
      + '       qualitygate trends [--limit <n>] [--gate <id>...] [--since <date>] [--decision <PASS|BLOCK>] [--config <path>] [--json]\n'
      + '       qualitygate mcp [--config <path>]\n'
      + '       qualitygate bridge [--port <n>] [--origin <origin>...] [--config <path>] | qualitygate bridge --revoke-all\n'
      + '       qualitygate report --input <run.json> [--output <report.md|report.sarif>] [--sarif] [--json]\n'
      + '         (--json prints a JSON object instead of the report: {output} with --output, otherwise {markdown}, or {sarif} with --sarif)\n'
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
    const result = await setupProject(configPath, undefined, plugins, { from: values.get('--from'), gitignore: !noGitignore });
    if (json) console.log(JSON.stringify({ schemaVersion: 1, ...result }));
    else console.log([`Created ${result.configPath}`, `Ecosystems: ${result.ecosystems.join(', ')}`,
      ...(result.plugins.length ? [`Plugins (run unsandboxed with your permissions): ${result.plugins.join(', ')}`] : []), ...result.gates.map(gate => `  ${gate.id}: ${gate.run}`),
      ...(result.skipped.length ? ['Found but not enabled (listed as comments in the config):', ...result.skipped.map(gate => `  ${gate.id}: ${gate.reason}`)] : []),
      ...result.notes.map(note => `Note: ${note}`),
      ...(result.gitignore.length ? [`Added to .gitignore: ${result.gitignore.join(' ')}`] : []),
      `Files changed: ${result.changed.join(', ')}`,
      'Check that the test script exits (not watch mode), then run: qualitygate run'].join('\n'));
  } else if (command === 'list' || command === 'doctor') {
    if (positional.length) throw new Error(`${command} does not accept positional arguments`);
    if (command === 'list') console.log(await listCommand(configPath, json));
    else { const result = await doctorCommand(configPath, json); console.log(result.text); process.exitCode = result.code; }
  } else if (command === 'history' || command === 'trends') {
    if (positional.length) throw new Error(`${command} does not accept positional arguments`);
    const limit = z.coerce.number().int().min(1).max(1000).parse(values.get('--limit') ?? (command === 'history' ? 10 : 50));
    const since = values.get('--since'); const baseline = values.get('--baseline');
    if (since !== undefined && Number.isNaN(Date.parse(since))) throw new Error(`--since expects a date such as 2026-11-01 or 2026-11-01T10:00:00Z, got "${since}"`);
    if (baseline !== undefined && !baseline) throw new Error('--baseline expects a run id');
    const filter = { gates: only, ...(since ? { since: new Date(since).toISOString() } : {}), ...(values.has('--decision') ? { decision: z.enum(['PASS', 'BLOCK']).parse(values.get('--decision')) } : {}) };
    console.log(await (command === 'history' ? historyCommand(configPath, limit, json, { ...filter, baseline }) : trendsCommand(configPath, limit, json, filter)));
  } else if (command === 'run' || command === 'inspect') {
    if ((command === 'run' && positional.length) || positional.length > 1) throw new Error(`${command}: unexpected arguments`);
    const view = command === 'run' && liveEnabled(process.stdout, process.env, { noLive, json }) ? liveView(process.stdout) : undefined;
    let result;
    const warnings: string[] = [];
    try {
      result = command === 'run' ? await execute(configPath, controller.signal, only.length ? only : undefined, { changed, cache, onProgress: view?.onProgress, onWarning: view && (text => warnings.push(text)) }) : await getRun(configPath, positional[0]);
      view?.stop(result);
    } finally { view?.stop(); for (const text of warnings) process.stderr.write(text); }
    if (json) process.stdout.write(jsonReporter.render(result));
    else {
      if (command === 'run') console.log(`Project root: ${dirname(resolve(configPath))}`);
      printRun(result);
    }
    process.exitCode = exitCode(result);
  } else if (command === 'fix') {
    if (positional.length) throw new Error('fix does not accept positional arguments');
    const result = await fixGates(configPath, controller.signal, { gates: only.length ? only : undefined, allowDirty });
    if (json) console.log(JSON.stringify(result));
    else {
      for (const warning of result.warnings) console.error(`QualityGate: warning: ${warning}`);
      console.log(`Project root: ${dirname(resolve(configPath))}`);
      console.log(describeFix(result).join('\n'));
      printRun(result.run);
    }
    process.exitCode = exitCode(result.run);
  } else if (command === 'visual') {
    const { config, directory } = await loadConfig(configPath);
    const handler = (await loadExternalPlugins(directory, config.plugins ?? [], builtinIds)).commands.visual;
    if (!handler) throw new Error(`The visual-regression plugin is not enabled: add "@qualitygate/plugin-visual-regression" to plugins: in ${configPath}`);
    const result = await handler({ args: [...positional, ...(all ? ['--all'] : [])], config, directory, signal: controller.signal });
    console.log(json ? JSON.stringify({ schemaVersion: 1, ...result }) : result.lines.join('\n'));
  } else if (command === 'ui') {
    if (positional.length) throw new Error('ui takes only --config');
    const { runUi } = await import('./ui.js');
    process.exitCode = await runUi(configPath, controller);
  } else if (['report', 'pr', 'status', 'comment', 'notify'].includes(command ?? '')) {
    if (positional.length) throw new Error(`${command} does not accept positional arguments`);
    const input = z.string().min(1).parse(values.get('--input'));
    if (command === 'report') {
      const report = await readReport(input);
      const markdown = sarif ? renderSarif(report, dirname(resolve(configPath))) : renderMarkdown(report);
      const output = values.get('--output');
      if (output) await writeFile(output, markdown);
      if (json) console.log(JSON.stringify({ schemaVersion: 1, ...(output ? { output: resolve(output) } : { [sarif ? 'sarif' : 'markdown']: markdown }) }));
      else if (!output) process.stdout.write(markdown);
    } else if (command === 'status') {
      const result = await publishStatus({ repository: values.get('--repository'), head: values.get('--head'), reportUrl: values.get('--report-url'), headRepository: values.get('--head-repository'),
        apiUrl: values.get('--api-url'), tokenEnv: values.get('--token-env'), write }, input, controller.signal);
      console.log(json ? JSON.stringify(result) : `${result.payload.description}${result.write ? ' (posted)' : ' (dry run)'}`);
    } else if (command === 'comment') {
      const result = await publishComment({ provider: values.get('--provider') ?? 'github', repository: values.get('--repository'), number: values.get('--number'), head: values.get('--head'), reportUrl: values.get('--report-url'),
        headRepository: values.get('--head-repository'), author: values.get('--author'), apiUrl: values.get('--api-url'), tokenEnv: values.get('--token-env'), write }, input, controller.signal);
      console.log(json ? JSON.stringify(result) : 'body' in result ? result.body : `Comment: ${result.reason}`);
    } else if (command === 'notify') {
      const result = await notifySlack({ webhookEnv: values.get('--webhook-env'), reportUrl: values.get('--report-url'), write }, input, controller.signal);
      console.log(json ? JSON.stringify(result) : result.message ? `${result.message.text}${result.sent ? ' (sent)' : ' (dry run)'}` : `Slack: ${result.reason}`);
    } else {
      const result = await publishDescription({ provider: values.get('--provider'), repository: values.get('--repository'),
        number: values.get('--number'), head: values.get('--head'), headRepository: values.get('--head-repository'), apiUrl: values.get('--api-url'), tokenEnv: values.get('--token-env'), write }, input, controller.signal);
      console.log(json ? JSON.stringify(result) : 'body' in result ? result.body : `PR: ${result.reason}`);
    }
  } else if (command === 'export') {
    if (positional.length) throw new Error('export does not accept positional arguments');
    const out = z.string().min(1).parse(values.get('--out'));
    const input = values.get('--input');
    const outputDir = await loadConfig(configPath).then(loaded => loaded.config.outputDir, () => undefined);
    const history = outputDir && await readTrends(outputDir, 50, text => console.error(`QualityGate: warning: ${text}`));
    const result = await exportReport(input ? await readReport(input) : await getRun(configPath), resolve(out), history || undefined);
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
  } else if (command === 'bridge') {
    if (positional.length) throw new Error('bridge does not accept positional arguments');
    if (revoke) {
      const count = await revokeAll(configPath);
      console.log(json ? JSON.stringify({ schemaVersion: 1, revoked: count }) : `Revoked ${count} bridge token(s)`);
    } else {
      const port = z.coerce.number().int().min(0).max(65535).parse(values.get('--port') ?? DEFAULT_PORT);
      await serveBridge({ configPath, port, origins, out: text => process.stdout.write(text), err: text => process.stderr.write(text) }, controller.signal);
      if (controller.signal.aborted) process.exitCode = 130;
    }
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
