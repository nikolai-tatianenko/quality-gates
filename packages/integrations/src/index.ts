import { resolve } from 'node:path';
export const clients = ['claude', 'claude-code', 'claude-desktop', 'cursor', 'codex', 'vscode', 'generic'] as const;
export type ClientName = typeof clients[number];
/** Emits configuration only; never overwrites a user's editor settings. */
export function clientConfig(client: ClientName, configPath: string, entry: string) {
  const server = { command: process.execPath, args: [resolve(entry), 'mcp', '--config', resolve(configPath)] };
  if (client === 'codex') return { filename: '.codex/config.toml', format: 'toml', content:
    `[mcp_servers.qualitygate]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\nstartup_timeout_sec = 20\ntool_timeout_sec = 600\n` };
  if (client === 'vscode') return { filename: '.vscode/mcp.json', format: 'json', content:
    JSON.stringify({ servers: { qualitygate: { type: 'stdio', ...server } } }, null, 2) + '\n' };
  return { filename: client === 'cursor' ? '.cursor/mcp.json' : client === 'claude-desktop' ? 'claude_desktop_config.json' : '.mcp.json', format: 'json', content:
    JSON.stringify({ mcpServers: { qualitygate: server } }, null, 2) + '\n' };
}
