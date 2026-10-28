import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { message, runResultSchema, type RunResult } from '../../protocol/src/index.js';
import { execute, loadConfig } from '../../cli/src/runner.js';
/** Agents get the verdict and failure output, not full logs: passing gates drop their output. */
export function summarize(run: RunResult) {
  return {
    ...run,
    gates: run.gates.map(g => g.decision === 'PASS' ? { ...g, outputTail: '' } : g),
  };
}
async function latestRun(outputDir: string): Promise<RunResult> {
  const entries = await readdir(outputDir, { withFileTypes: true }).catch(() => []);
  let newest: { dir: string; time: number } | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const time = (await stat(join(outputDir, entry.name, 'report.json')).catch(() => undefined))?.mtimeMs;
    if (time !== undefined && (!newest || time > newest.time)) newest = { dir: entry.name, time };
  }
  if (!newest) throw new Error('No runs found');
  return readRun(outputDir, newest.dir);
}
async function readRun(outputDir: string, runId: string): Promise<RunResult> {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('Invalid run ID');
  return runResultSchema.parse(JSON.parse(await readFile(join(outputDir, runId, 'report.json'), 'utf8')));
}
const reply = (value: unknown, isError = false) =>
  ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], isError });
/**
 * Builds the MCP server bound to one config file. Agents can only run the gates that file declares:
 * no tool accepts a command, path or URL.
 */
export function createServer(configPath: string): McpServer {
  const server = new McpServer({ name: 'qualitygate', version: '0.1.0' });
  server.registerTool('list_gates', {
    description: 'List the quality gates (commands and URL audits) this project defines.',
  }, async () => {
    try {
      const { config } = await loadConfig(configPath);
      return reply({ gates: config.gates.map(g => ({ id: g.id, run: g.run })), urls: config.urls, thresholds: config.thresholds });
    } catch (error) { return reply({ error: message(error) }, true); }
  });
  server.registerTool('run_gates', {
    description: 'Run the project quality gates and return a PASS/BLOCK verdict with failure output. '
      + 'Pass gate ids to run only those command gates; omit to run everything including URL audits.',
    inputSchema: { gates: z.array(z.string()).optional() },
  }, async ({ gates }) => {
    try {
      const result = await execute(configPath, new AbortController().signal, gates?.length ? gates : undefined);
      return reply(summarize(result), result.execution === 'error');
    } catch (error) { return reply({ error: message(error) }, true); }
  });
  server.registerTool('get_run', {
    description: 'Return a stored run by id, or the most recent run when no id is given.',
    inputSchema: { runId: z.string().optional() },
  }, async ({ runId }) => {
    try {
      const { config } = await loadConfig(configPath);
      return reply(summarize(runId ? await readRun(config.outputDir, runId) : await latestRun(config.outputDir)));
    } catch (error) { return reply({ error: message(error) }, true); }
  });
  return server;
}
export async function serve(configPath: string): Promise<void> {
  await loadConfig(configPath); // Fail fast on a missing or invalid config.
  const server = createServer(configPath);
  // The client going away shows up as stdin ending; the SDK transport does not always signal it.
  const closed = new Promise<void>(resolve => {
    server.server.onclose = () => resolve();
    process.stdin.once('end', () => resolve());
  });
  await server.connect(new StdioServerTransport());
  await closed;
  await server.close().catch(() => undefined);
}
