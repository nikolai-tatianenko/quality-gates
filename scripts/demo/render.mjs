import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = resolve('.');
const session = JSON.parse(await readFile('docs/demo/session.json', 'utf8'));
const tools = new Map(); const runs = []; let edit;
for (const event of session.events) for (const block of event.content) {
  if (block.type === 'tool_use') { tools.set(block.id, block.name); if (block.name === 'Edit') edit = block.input; }
  if (block.type === 'tool_result' && tools.get(block.tool_use_id)?.endsWith('__run_gates')) {
    const text = typeof block.content === 'string' ? block.content : block.content.map(c => c.text || '').join('\n');
    runs.push(JSON.parse(text));
  }
}
assert.equal(runs[0]?.decision, 'BLOCK'); assert.equal(runs.at(-1)?.decision, 'PASS'); assert.ok(edit);
const failed = runs[0].gates.find(g => g.decision === 'BLOCK');
const passed = runs.at(-1).gates[0];
const original = session.events.flatMap(e => e.content).find(c => c.type === 'tool_use' && c.name === 'Read' && c.input.file_path.endsWith('/shipping.mjs'));
assert.ok(original);
let font = process.env.QUALITYGATE_DEMO_FONT;
for (const candidate of ['/System/Library/Fonts/Menlo.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf']) {
  if (font) break; try { await access(candidate); font = candidate; } catch { /* try the next font */ }
}
assert.ok(font, 'Set QUALITYGATE_DEMO_FONT to a monospace font');
const directory = join(root, '.qualitygate/demo/render'); await mkdir(directory, { recursive: true });
const out = join(root, 'docs/demo'); await mkdir(out, { recursive: true });
const slides = [
  { title: 'BLOCK → fix → PASS', duration: 7, status: 'REAL SESSION', body: [
    'Claude Code + QualityGate over MCP', '',
    'A failing check becomes an actionable result.',
    'The agent reads the reason, edits the implementation,',
    'then runs the same quality gate again.', '',
    `Recorded session: ${(session.elapsedMs / 1000).toFixed(1)} seconds`,
    'This replay is paced to 75 seconds for readability.',
    'Source transcript: docs/demo/session.json',
  ] },
  { title: '01 / Ask the agent to verify first', duration: 9, status: 'CLAUDE CODE', body: [
    'Prompt excerpt from the actual session:', '',
    ...wrap(session.prompt.split(' Read shipping.mjs')[0]), '',
    'Connected server: qualitygate',
    'Transport: MCP / stdio',
    'Gate command: node --test shipping.test.mjs',
    'Project: examples/agent-fix (working copy)',
  ] },
  { title: '02 / Claude calls QualityGate', duration: 11, status: 'BLOCK', body: [
    'mcp__qualitygate__run_gates({})', '',
    ...JSON.stringify({ execution: runs[0].execution, decision: runs[0].decision,
      gate: failed.id, command: failed.command, exitCode: failed.exitCode }, null, 2).split('\n'), '',
    'The tool returned an actual stored run with failure output.',
  ] },
  { title: '03 / Read the reason', duration: 10, status: 'BLOCK', body: [
    'Failure excerpt returned by the MCP tool:', '',
    ...failed.outputTail.split('\n').filter(line => /not ok|Shipping must|95 !==|expected:|actual:|# pass |# fail /.test(line)).map(s => s.trim()), '',
    'The agent receives the cause, not just a red exit code.',
  ] },
  { title: '04 / Inspect implementation and test', duration: 10, status: 'READ', body: [
    'Claude Code → Read shipping.mjs', '',
    'export function totalWithShipping(subtotal, shipping) {',
    `  return ${edit.old_string};`, '}', '',
    'Claude Code → Read shipping.test.mjs', '',
    'assert.equal(totalWithShipping(100, 5), 105,',
    "  'Shipping must be added to subtotal');",
  ] },
  { title: '05 / Fix the implementation', duration: 10, status: 'EDIT', body: [
    'Claude Code → Edit shipping.mjs', '',
    'Actual edit recorded by Claude Code:', '',
    `- return ${edit.old_string};`,
    `+ return ${edit.new_string};`, '',
    'Recorder verified: tests unchanged.',
    'Recorder verified: quality gate configuration unchanged.',
    'The requirement stays the same.',
  ] },
  { title: '06 / Run the same MCP gate again', duration: 10, status: 'PASS', body: [
    'mcp__qualitygate__run_gates({})', '',
    ...JSON.stringify({ execution: runs.at(-1).execution, decision: runs.at(-1).decision,
      gate: passed.id, exitCode: passed.exitCode, errors: runs.at(-1).errors }, null, 2).split('\n'), '',
    'A second stored run confirms the fix.',
  ] },
  { title: 'Let the agent prove its work.', duration: 8, status: 'PASS', body: [
    'QualityGate: local quality gates for developers, CI and AI agents.', '',
    'One project configuration.', 'The same verdict through CLI and MCP.',
    'Failure output and evidence tied to a run ID.', '',
    'Try this fixture: examples/agent-fix/',
    'Replay the real session: docs/demo/session.json', '',
    'github.com/example-org/qualitygate',
  ] },
];
function wrap(text, width = 76) {
  const lines = []; let line = '';
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > width) { lines.push(line); line = word; }
    else line += (line ? ' ' : '') + word;
  }
  if (line) lines.push(line); return lines;
}
function filterPath(path) { return path.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'"); }
for (const [index, slide] of slides.entries()) {
  const base = join(directory, String(index));
  await writeFile(`${base}-title.txt`, slide.title); await writeFile(`${base}-body.txt`, slide.body.join('\n'));
  await writeFile(`${base}-status.txt`, slide.status);
  const color = slide.status === 'BLOCK' ? '0xff7272' : slide.status === 'PASS' ? '0x78e3a5' : '0x8fb7ff';
  const text = (file, x, y, size, color) => `drawtext=fontfile='${filterPath(font)}':textfile='${filterPath(file)}':expansion=none:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}:line_spacing=11`;
  const filters = [
    'drawbox=x=24:y=24:w=1392:h=852:color=0x202b42:t=1',
    'drawbox=x=25:y=25:w=1390:h=48:color=0x1a2235:t=fill',
    'drawbox=x=48:y=44:w=12:h=12:color=0xff7272:t=fill',
    'drawbox=x=70:y=44:w=12:h=12:color=0xffd580:t=fill',
    'drawbox=x=92:y=44:w=12:h=12:color=0x78e3a5:t=fill',
    `drawtext=fontfile='${filterPath(font)}':text='QUALITYGATE  /  CLAUDE CODE  /  MCP SESSION REPLAY':fontsize=16:fontcolor=0x9aaac6:x=135:y=40`,
    text(`${base}-title.txt`, 64, 111, 35, '0xf0f4ff'),
    text(`${base}-body.txt`, 66, 200, 24, '0xcbd5e8'),
    text(`${base}-status.txt`, 1110, 119, 22, color),
    `drawtext=fontfile='${filterPath(font)}':text='ACTUAL TOOL CALLS AND RESULTS  |  PACING ADJUSTED FOR READING':fontsize=16:fontcolor=0x8293b1:x=66:y=832`,
  ].join(',');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x101522:s=1440x900:r=1:d=1', '-vf', filters, '-frames:v', '1', `${base}.png`]);
}
const concat = slides.map((s, i) => `file '${join(directory, `${i}.png`)}'\nduration ${s.duration}`).join('\n') + `\nfile '${join(directory, `${slides.length - 1}.png`)}'\n`;
await writeFile(join(directory, 'frames.ffconcat'), concat);
const video = join(out, 'qualitygate-claude-code.mp4');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(directory, 'frames.ffconcat'), '-vf', 'fps=12,format=yuv420p', '-t', '75', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-movflags', '+faststart', video]);
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-filter_complex', 'fps=4,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', '-loop', '0', join(out, 'qualitygate-claude-code.gif')]);
console.log('Rendered 75-second MP4 and GIF from the verified Claude Code MCP transcript.');
