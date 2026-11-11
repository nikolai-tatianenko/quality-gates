import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { CommandContext } from '../../../plugin-sdk/src/index.js';
import { message } from '../../../protocol/src/index.js';
import { NAME, projectFolder, readImageFile, show } from './files.js';
import { settingsOf } from './gate.js';
import { decodePng } from './png.js';
import { REPORT_FILE, VISUAL_DIR, type VisualReport } from './types.js';
const USAGE = 'Usage: qualitygate visual approve <name>|--all [--config <path>]';
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['match', 'changed', 'new', 'missing'];
const posix = (path: string) => path.split(sep).join('/');
/** The newest finished run (by report.json time), which is the one whose screenshots can be approved. */
async function latestRun(outputDir: string): Promise<string> {
  const entries = await readdir(outputDir, { withFileTypes: true }).catch(() => []);
  let newest: { id: string; time: number } | undefined;
  for (const entry of entries.filter(item => item.isDirectory() && RUN_ID.test(item.name))) {
    const info = await stat(join(outputDir, entry.name, 'report.json')).catch(() => undefined);
    if (info?.isFile() && (!newest || info.mtimeMs > newest.time)) newest = { id: entry.name, time: info.mtimeMs };
  }
  if (!newest) throw new Error('No runs found: run the visual gate first');
  return newest.id;
}
const parseObject = (text: string): Partial<VisualReport> => { try { return (JSON.parse(text) ?? {}) as Partial<VisualReport>; } catch { return {}; } };
/** Reads and validates the latest run's visual.json; the evidence folder is data, not trusted input. */
async function readReport(runDir: string, runId: string, gateIds: string[]): Promise<VisualReport> {
  const text = await readFile(join(runDir, VISUAL_DIR, REPORT_FILE), 'utf8').catch(() => undefined);
  if (text === undefined) throw new Error(`The latest run (${runId}) has no visual results: run the visual gate first (qualitygate run --gate ${gateIds[0]})`);
  const report = parseObject(text);
  const valid = report.schemaVersion === 1 && typeof report.baselineDir === 'string' && Array.isArray(report.items)
    && report.items.every(item => typeof item?.name === 'string' && NAME.test(item.name) && STATUSES.includes(item.status));
  if (!valid) throw new Error(`${REPORT_FILE} is not a version 1 visual report`);
  return report as VisualReport;
}
interface Approval { name: string; source: Buffer; target: string; path: string; existing: Buffer | undefined }
/** Where an approval reads from and writes to. */
interface Where { visual: string; folder: string; root: string; maxPixels: number }
/** Reads the stored current screenshot (never through a symlink), checks it is a PNG the plugin can read, and looks at the baseline file it would replace. */
async function prepare(name: string, where: Where): Promise<Approval> {
  const directory = join(where.visual, 'current');
  if (await realpath(directory).catch(() => '') !== join(await realpath(where.visual), 'current')) throw new Error(`Cannot approve ${name}: the stored screenshot is not inside the run folder`);
  const source = await readImageFile(join(directory, `${name}.png`)).catch(error => { throw new Error(`Cannot approve ${name}: ${message(error)}`); });
  try { decodePng(source, where.maxPixels); } catch (error) { throw new Error(`Cannot approve ${name}: ${message(error)}`); }
  const target = join(where.folder, `${name}.png`);
  const path = posix(relative(where.root, target));
  const info = await lstat(target).catch(() => undefined);
  if (info?.isSymbolicLink()) throw new Error(`Cannot approve ${name}: ${path} is a symbolic link; refusing to replace it`);
  if (info && !info.isFile()) throw new Error(`Cannot approve ${name}: ${path} is not a file`);
  return { name, source, target, path, existing: info ? await readFile(target) : undefined };
}
/** Writes through a temporary file in the same folder, so a baseline is never half written. */
async function write(approval: Approval) {
  await mkdir(dirname(approval.target), { recursive: true });
  const temporary = join(dirname(approval.target), `.${approval.name}.png.${process.pid}.tmp`);
  try { await writeFile(temporary, approval.source); await rename(temporary, approval.target); }
  finally { await rm(temporary, { force: true }); }
}
/** The screenshot name after `approve`, or undefined for `--all`; anything else is a usage error. */
function parseArgs(args: string[]): string | undefined {
  const [action, ...rest] = args;
  const all = rest.includes('--all'); const names = rest.filter(arg => arg !== '--all');
  if (action !== 'approve' || all === (names.length === 1) || names.length > 1) throw new Error(USAGE);
  if (names[0] !== undefined && !NAME.test(names[0])) throw new Error(`Invalid screenshot name: ${show(names[0])}`);
  return names[0];
}
/** The items to approve (new and changed) and the missing ones to report; a named screenshot must exist and have a current file. */
function selectItems(report: VisualReport, name: string | undefined, where: Where) {
  const wanted = name ? report.items.filter(item => item.name === name) : report.items;
  if (name && !wanted.length) throw new Error(`Unknown screenshot ${name} in the latest run (known: ${report.items.map(item => item.name).join(', ')})`);
  const missing = wanted.filter(item => item.status === 'missing');
  if (name && missing.length) throw new Error(`Screenshot ${name} has no current screenshot; delete ${baselinePath(where, name)} yourself if it should go`);
  return { open: wanted.filter(item => item.status === 'new' || item.status === 'changed'), missing };
}
const baselinePath = (where: Where, name: string) => posix(relative(where.root, join(where.folder, `${name}.png`)));
/** The lines printed after approving: each file changed, missing ones left alone, and a summary. */
function describeResult(prepared: Approval[], approved: { name: string; change: string }[], notRemoved: string[], named: string | undefined): string[] {
  const lines = prepared.map(approval => {
    const change = approved.find(item => item.name === approval.name)?.change;
    return change ? `${change === 'new' ? 'New' : 'Replaced'}: ${approval.path}` : `Unchanged: ${approval.path} (already identical)`;
  });
  for (const path of notRemoved) lines.push(`Not removed: ${path} has no current screenshot (delete the file if the screenshot no longer exists)`);
  if (!prepared.length) lines.push(named ? `Screenshot ${named} already matches the baseline: nothing to approve` : 'Nothing to approve: every screenshot matches the baseline');
  else if (approved.length) lines.push(`Approved ${approved.length} screenshot${approved.length === 1 ? '' : 's'} from the latest run. Review the change and commit the baseline folder.`);
  return lines;
}
/** `qualitygate visual approve <name>|--all`: the one place a baseline changes. It copies, never runs a gate and never changes a verdict. */
export async function visualCommand(context: CommandContext) {
  const named = parseArgs(context.args);
  const gates = context.config.gates.filter(gate => gate.type === 'visual');
  if (!gates.length) throw new Error('No visual gate is configured (a gate with "type: visual")');
  const root = await realpath(context.directory);
  const runId = await latestRun(context.config.outputDir);
  const runDir = join(context.config.outputDir, runId);
  const report = await readReport(runDir, runId, gates.map(gate => gate.id));
  const settings = settingsOf(gates.find(item => item.id === report.gateId) ?? gates[0]!);
  const folder = await projectFolder(root, report.baselineDir, 'baseline folder');
  if ((await projectFolder(root, settings.baseline, 'baseline folder')).path !== folder.path) {
    throw new Error(`The latest run used baseline folder ${report.baselineDir} but the configuration says ${settings.baseline}: run the gate again`);
  }
  const where: Where = { visual: join(runDir, VISUAL_DIR), folder: folder.path, root, maxPixels: settings.maxPixels };
  const { open, missing } = selectItems(report, named, where);
  const prepared = [];
  for (const item of open) prepared.push(await prepare(item.name, where));
  const changes = prepared.filter(approval => !approval.existing?.equals(approval.source));
  for (const approval of changes) await write(approval);
  const approved = changes.map(approval => ({ name: approval.name, path: approval.path, change: approval.existing ? 'replaced' : 'new' }));
  return { lines: describeResult(prepared, approved, missing.map(item => baselinePath(where, item.name)), named), runId, baselineDir: report.baselineDir, approved };
}
