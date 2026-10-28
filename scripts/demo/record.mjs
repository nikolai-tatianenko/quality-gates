import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const root = resolve('.');
const directory = join(root, '.qualitygate/demo');
const workspace = join(directory, 'workspace');
await mkdir(workspace, { recursive: true });
for (const file of ['shipping.mjs', 'shipping.test.mjs', '.qualitygate.yml']) {
  await cp(join(root, 'examples/agent-fix', file), join(workspace, file));
}
const originalTest = await readFile(join(workspace, 'shipping.test.mjs'), 'utf8');
const originalConfig = await readFile(join(workspace, '.qualitygate.yml'), 'utf8');
const mcp = { mcpServers: { qualitygate: { command: process.execPath,
  args: [join(root, 'dist/qualitygate.mjs'), 'mcp', '--config', join(workspace, '.qualitygate.yml')] } } };
const prompt = 'Use the QualityGate MCP tools to check this project before making changes. '
  + 'First call run_gates and read its BLOCK verdict and failing test output. Read shipping.mjs and shipping.test.mjs, '
  + 'fix only the implementation in shipping.mjs (do not change tests or config), then call run_gates again to verify PASS. '
  + 'Keep responses brief and explain the cause. Work only in the current demo directory. Do not delegate or spawn agents.';
const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
  '--no-session-persistence', '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
  '--settings', JSON.stringify({ disableAllHooks: true }), '--disable-slash-commands',
  '--tools', 'Read,Edit', '--allowedTools', 'Read', 'Edit',
  'mcp__qualitygate__list_gates', 'mcp__qualitygate__run_gates', 'mcp__qualitygate__get_run'];
const started = Date.now();
const events = [];
let raw = ''; let stderr = ''; let buffer = '';
const child = spawn('claude', args, { cwd: workspace, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stderr.on('data', data => { stderr += data; });
function clean(value) { return JSON.parse(JSON.stringify(value).replaceAll(root, '<repo>')); }
child.stdout.on('data', data => {
  raw += data; buffer += data;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    let item; try { item = JSON.parse(line); } catch { continue; }
    if (item.type === 'assistant' || item.type === 'user') {
      const content = item.message?.content?.filter(c => ['text', 'tool_use', 'tool_result'].includes(c.type));
      if (content?.length) events.push({ elapsedMs: Date.now() - started, role: item.type, content: clean(content) });
      if (item.type === 'assistant') for (const block of content || []) {
        if (block.type === 'tool_use') console.log(`Claude Code → ${block.name}`);
        if (block.type === 'text') console.log(block.text);
      }
    }
  }
});
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
await writeFile(join(directory, 'raw.jsonl'), raw);
await writeFile(join(directory, 'stderr.log'), stderr);
assert.equal(code, 0, `Claude Code failed: ${stderr}`);
const tools = new Map(); const verdicts = [];
for (const event of events) for (const block of event.content) {
  if (block.type === 'tool_use') tools.set(block.id, block.name);
  if (block.type === 'tool_result' && tools.get(block.tool_use_id)?.endsWith('__run_gates')) {
    const content = typeof block.content === 'string' ? block.content : block.content?.map(c => c.text || '').join('\n');
    try { const result = JSON.parse(content); if (result.decision) verdicts.push(result.decision); } catch { /* report below */ }
  }
}
assert.equal(verdicts[0], 'BLOCK', `Expected first MCP verdict BLOCK: ${verdicts}`);
assert.equal(verdicts.at(-1), 'PASS', `Expected final MCP verdict PASS: ${verdicts}`);
assert.equal(await readFile(join(workspace, 'shipping.test.mjs'), 'utf8'), originalTest);
assert.equal(await readFile(join(workspace, '.qualitygate.yml'), 'utf8'), originalConfig);
await mkdir(join(root, 'docs/demo'), { recursive: true });
const session = { formatVersion: 1, client: 'Claude Code', prompt, elapsedMs: Date.now() - started, verdicts, events };
await writeFile(join(root, 'docs/demo/session.json'), JSON.stringify(session, null, 2) + '\n');
console.log(`Verified actual MCP loop: ${verdicts.join(' → ')}. Tests and configuration unchanged.`);
