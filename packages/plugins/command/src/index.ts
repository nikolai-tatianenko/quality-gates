import { spawn } from 'node:child_process';
import type { Context, GatePlugin, ParserPlugin } from '../../../plugin-sdk/src/index.js';
import { message, type GateData, type GateSpec } from '../../../protocol/src/index.js';
import { DEFAULT_LIMITS, expandArtifacts } from './artifacts.js';
import { readReport } from './report.js';
const MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 300_000;
export interface CommandOutput {
  exitCode: number | null; output: string; stdout: string; stderr: string;
  truncated: boolean; error?: string; timedOut?: boolean;
}
/** Captures a trusted shell command; timers and aborts kill the owned process group. */
export async function captureCommand(cwd: string, spec: GateSpec, context: Context): Promise<CommandOutput> {
  const child = spawn(spec.run, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const kill = () => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  };
  context.defer(async () => { kill(); await closed; });
  const result: CommandOutput = { exitCode: null, output: '', stdout: '', stderr: '', truncated: false };
  const chunks: Record<'output' | 'stdout' | 'stderr', Buffer[]> = { output: [], stdout: [], stderr: [] };
  let bytes = 0;
  const append = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    const available = Math.max(0, MAX_OUTPUT_BYTES - bytes);
    const captured = chunk.subarray(0, available);
    chunks[stream].push(captured); chunks.output.push(captured);
    bytes += Math.min(chunk.length, available);
    if (chunk.length > available) result.truncated = true;
  };
  child.stdout.on('data', chunk => append('stdout', chunk));
  child.stderr.on('data', chunk => append('stderr', chunk));
  const stop = (error: string, timedOut = false) => { result.error ??= error; if (timedOut) result.timedOut = true; kill(); };
  const abort = () => stop('Interrupted');
  context.signal.addEventListener('abort', abort, { once: true });
  if (context.signal.aborted) abort();
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => stop(`Gate ${spec.id} timed out after ${timeoutMs}ms`, !result.error), timeoutMs);
  try {
    result.exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', code => resolve(code));
    });
  } catch (error) { result.error ??= message(error); }
  finally { clearTimeout(timer); context.signal.removeEventListener('abort', abort); }
  for (const stream of ['stdout', 'stderr', 'output'] as const) result[stream] = Buffer.concat(chunks[stream]).toString('utf8');
  return result;
}
/** Runs a command gate; an optional `report` is parsed into findings (exit code still decides PASS/BLOCK). */
export function commandPlugin(cwd: string, parsers: Record<string, ParserPlugin> = {}): GatePlugin {
  return { id: 'command', apiVersion: 1, kind: 'gate', async run(spec, context) {
    const startedAt = Date.now() - FILE_TIME_SLACK_MS;
    const captured = await captureCommand(cwd, spec, context);
    if (!spec.report && !spec.artifacts) return { exitCode: captured.exitCode, output: captured.output, error: captured.error, ...(captured.timedOut ? { timedOut: true } : {}) };
    const data: GateData = { exitCode: captured.exitCode, output: captured.output, error: captured.error, artifacts: [] };
    if (spec.report && (!captured.error || captured.timedOut)) await applyReport(spec, data, { cwd, parsers, startedAt });
    if (captured.timedOut) markTimeout(data, captured.error!);
    if (spec.artifacts) {
      const { files, truncated } = await expandArtifacts(cwd, spec.artifacts, DEFAULT_LIMITS, startedAt);
      data.artifacts!.push(...files);
      if (truncated) data.output += `\n[artifacts truncated: limit ${DEFAULT_LIMITS.maxFiles} files / ${DEFAULT_LIMITS.maxBytes / 1024 / 1024} MB]\n`;
    }
    return data;
  } };
}
/** A timed-out gate keeps whatever the partial report showed: "timed out after 5ms: passed 40, failed 0, stopped by timeout". */
function markTimeout(data: GateData, error: string) {
  data.timedOut = true;
  data.error = data.counts ? `${error}: passed ${data.counts.passed}, failed ${data.counts.failed}, stopped by timeout` : error;
}
/** File times can be coarser than the clock (1-2 s on some filesystems), so a file counts as fresh a little before the run started. */
const FILE_TIME_SLACK_MS = 2000;
/** Removes the values a secret scanner's report names from the gate output (a scanner without `--redact` prints them). An unreadable report names none. */
function scrub(output: string, parser: ParserPlugin, raw: string): string {
  let secrets: string[] = [];
  try { secrets = parser.secrets!(raw); } catch { /* the parse step below reports the bad report */ }
  return secrets.sort((a, b) => b.length - a.length).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), output);
}
async function applyReport(spec: GateSpec, data: GateData, { cwd, parsers, startedAt }: { cwd: string; parsers: Record<string, ParserPlugin>; startedAt: number }) {
  const { format, path } = spec.report!;
  const parser = parsers[format];
  if (!parser) { data.error = `Unknown report format: ${format}`; return; }
  const read = await readReport(cwd, path, startedAt);
  if (read.status === 'missing') {
    const reason = read.stale ? `Report was not written by this run: ${path}` : `Report not found: ${path}`;
    if (data.exitCode === 0) data.error = reason; else data.output += `\n${reason}\n`;
    return;
  }
  if (read.status === 'error') { data.error = read.error; return; }
  if (parser.secrets) data.output = scrub(data.output, parser, read.raw);
  try {
    data.findings = parser.parse(read.raw, { gateId: spec.id, cwd });
    data.counts = parser.count?.(read.raw);
    if (!parser.secrets) data.artifacts!.push(read.absolutePath);
    if (data.exitCode === 0 && data.findings.some(finding => finding.severity === 'error')) data.error = `Gate ${spec.id} exited 0 but report contains failures`;
  } catch (cause) { data.error = `Invalid ${format} report: ${message(cause)}`; }
}
