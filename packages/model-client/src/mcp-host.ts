import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolHost } from './index.js';
/** Uses the actual stdio MCP server; provider adapters have no separate execution path. */
export async function connectTools(entry: string, configPath: string): Promise<{ host: ToolHost; close(): Promise<void> }> {
  const loader = entry.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [];
  const transport = new StdioClientTransport({ command: process.execPath, args: [...loader, entry, 'mcp', '--config', configPath], stderr: 'pipe' });
  const client = new Client({ name: 'qualitygate-model-client', version: '0.1.0' });
  let stderr = '';
  transport.stderr?.on('data', data => { if (stderr.length < 4000) stderr += data; });
  try { await client.connect(transport); }
  catch (error) { await transport.close(); throw new Error(`Cannot connect to QualityGate MCP: ${stderr}`, { cause: error }); }
  return { close: () => client.close(), host: {
    listTools: () => client.listTools(),
    async callTool(name, args, signal) {
      const response = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 3600000 });
      const content = response.content as { type: string; text?: string }[];
      const text = content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
      return JSON.parse(text);
    },
  } };
}
