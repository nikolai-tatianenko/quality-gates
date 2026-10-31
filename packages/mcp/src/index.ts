import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { message } from '../../protocol/src/index.js';
import { loadConfig } from '../../cli/src/runner.js';
import { QualityGateService, runArgsSchema, getRunArgsSchema } from '../../service/src/index.js';
import { z } from 'zod';
import { readMethodology } from '../../review-sources/src/index.js';
export { summarize } from '../../service/src/index.js';
const reply = (value: unknown, isError = false) =>
  ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], isError });
function runtime(configPath: string) {
  const service = new QualityGateService(configPath);
  const server = new McpServer({ name: 'qualitygate', version: '0.1.0' }, {
    instructions: 'Run declared quality gates, read findings, fix the implementation in your editor, then verify again. '
      + 'Use the actual run decision; never infer PASS from a natural-language explanation. '
      + 'Only configured commands are exposed. Commands are trusted and are not sandboxed. One run at a time per connection.',
  });
  server.registerTool('list_gates', {
    description: 'List this project’s configured gate IDs, types, commands and URL audits.',
    annotations: { readOnlyHint: true },
  }, async () => {
    try { return reply(await service.list()); } catch (error) { return reply({ error: message(error) }, true); }
  });
  server.registerTool('run_gates', {
    description: 'Run configured gates; return the actual PASS/BLOCK decision, structured findings and evidence. '
      + 'Optional gates limits execution to those command gate IDs. Concurrent runs are rejected; cancellation stops owned processes.',
    inputSchema: runArgsSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async (args, extra) => {
    try {
      const result = await service.run(args, extra.signal);
      return reply(result, result.execution === 'error');
    } catch (error) { return reply({ error: message(error) }, true); }
  });
  server.registerTool('get_run', {
    description: 'Read a saved run and structured findings, by ID or latest. Does not rerun tools.',
    inputSchema: getRunArgsSchema, annotations: { readOnlyHint: true },
  }, async args => {
    try { return reply(await service.get(args)); } catch (error) { return reply({ error: message(error) }, true); }
  });
  server.registerTool('get_review_methodology', {
    description: 'Read a pinned review methodology file (default SKILL.md), with repository and commit provenance. '
      + 'This returns reference material, not a completed audit. Does not download updates or execute the skill. '
      + 'Use the agent capabilities and isolation required by the methodology; report missing capabilities as needs_validation.',
    inputSchema: z.object({ sourceId: z.string().min(1), file: z.string().optional() }).strict(),
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    try {
      const { config, directory } = await loadConfig(configPath);
      return reply(await readMethodology(directory, config.reviewSources ?? [], args.sourceId, { file: args.file, signal: extra.signal }));
    } catch (error) { return reply({ error: message(error) }, true); }
  });
  server.server.onclose = () => { void service.close(); };
  return { server, service };
}
export function createServer(configPath: string): McpServer { return runtime(configPath).server; }
export async function serve(configPath: string, signal?: AbortSignal): Promise<void> {
  await loadConfig(configPath);
  const { server, service } = runtime(configPath);
  let finish!: () => void;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  const stop = () => { void service.close().finally(finish); };
  server.server.onclose = stop;
  process.stdin.once('end', stop);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    await server.connect(new StdioServerTransport());
    if (signal?.aborted) stop();
    await closed;
  } finally {
    process.stdin.removeListener('end', stop);
    signal?.removeEventListener('abort', stop);
    await service.close();
    await server.close();
  }
}
