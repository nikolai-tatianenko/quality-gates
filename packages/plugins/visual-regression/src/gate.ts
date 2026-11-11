import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { GatePlugin } from '../../../plugin-sdk/src/index.js';
import { message, type Finding, type GateData, type GateSpec } from '../../../protocol/src/index.js';
import { captureCommand } from '../../command/src/index.js';
import { compareImages } from './compare.js';
import { listPngs, overlaps, show, projectFolder, readImageFile, type Listed } from './files.js';
import { decodePng, encodePng, type Image } from './png.js';
import { DEFAULT_BASELINE, DEFAULT_MAX_PIXELS, DEFAULT_THRESHOLD, REPORT_FILE, VISUAL_DIR, type VisualItem, type VisualReport } from './types.js';
/** File times can be coarser than the clock, so a screenshot counts as fresh a little before the command started. */
const FILE_TIME_SLACK_MS = 2000;
export interface Settings { current: string; baseline: string; threshold: number; maxDiffRatio: number; maxPixels: number; ignore: Set<string> }
/** Reads the gate's visual settings and applies the defaults. */
export function settingsOf(spec: GateSpec): Settings {
  if (!spec.current) throw new Error(`Visual gate ${spec.id} needs a "current" folder: the folder the command writes its PNG screenshots to`);
  return { current: spec.current, baseline: spec.baseline ?? DEFAULT_BASELINE, threshold: spec.threshold ?? DEFAULT_THRESHOLD,
    maxDiffRatio: spec.maxDiffRatio ?? 0, maxPixels: spec.maxPixels ?? DEFAULT_MAX_PIXELS, ignore: new Set(spec.ignore) };
}
interface Loaded { present: boolean; bytes?: Buffer; image?: Image; error?: string }
/** Reads and decodes one screenshot; a failure is kept as text so the screenshot is reported, never skipped. */
async function load(file: Listed | undefined, label: string, maxPixels: number): Promise<Loaded> {
  if (!file) return { present: false };
  let bytes: Buffer;
  try { bytes = await readImageFile(file.path); } catch (error) { return { present: true, error: `${label}: ${message(error)}` }; }
  try { return { present: true, bytes, image: decodePng(bytes, maxPixels) }; } catch (error) { return { present: true, bytes, error: `${label}: ${message(error)}` }; }
}
type Rule = 'visual-changed' | 'visual-new' | 'visual-missing' | 'visual-unreadable';
interface Outcome { item: VisualItem; rule?: Rule; diff?: Buffer }
const percent = (ratio: number) => `${(ratio * 100).toFixed(2)}%`;
/** Compares two readable screenshots of the same name. */
function compareLoaded(base: VisualItem, approved: Image, current: Image, settings: Settings): Outcome {
  const { width, height } = current;
  if (approved.width !== width || approved.height !== height) {
    return { rule: 'visual-changed', item: { ...base, status: 'changed', width, height, diffPixels: width * height, diffRatio: 1,
      note: `Size changed: approved ${approved.width}x${approved.height}, current ${width}x${height}` } };
  }
  const { diffPixels, diff } = compareImages(approved, current, settings.threshold);
  const diffRatio = diffPixels / (width * height);
  const item = { ...base, width, height, diffPixels, diffRatio };
  if (diffRatio <= settings.maxDiffRatio) return { item: { ...item, status: 'match' } };
  return { rule: 'visual-changed', item: { ...item, status: 'changed' }, diff: encodePng(diff) };
}
/** Decides one screenshot's status. `stale` is a current file the command did not write this time. */
function decide(base: VisualItem, loaded: { approved: Loaded; current: Loaded }, settings: Settings, stale: boolean): Outcome {
  const { approved, current } = loaded;
  const image = current.image ?? approved.image;
  const size = { width: image?.width ?? 0, height: image?.height ?? 0 };
  const note = stale ? 'The screenshot was not written by this run (an older file was ignored)' : undefined;
  if (!approved.present) return { rule: 'visual-new', item: { ...base, ...size, status: 'new', ...(current.error ? { note: current.error } : {}) } };
  if (!current.present) return { rule: 'visual-missing', item: { ...base, ...size, status: 'missing', ...(approved.error ? { note: approved.error } : note ? { note } : {}) } };
  const errors = [approved.error, current.error].filter(Boolean).join('; ');
  if (errors) return { rule: 'visual-unreadable', item: { ...base, ...size, status: 'changed', diffRatio: 1, note: errors } };
  return compareLoaded(base, approved.image!, current.image!, settings);
}
/** Stores the evidence copies of one screenshot and returns the item with their relative paths. */
async function store(visual: string, outcome: Outcome, loaded: { approved: Loaded; current: Loaded }): Promise<VisualItem> {
  const { item } = outcome;
  const put = async (kind: 'approved' | 'current' | 'diff', bytes: Buffer | undefined) => {
    if (!bytes) return null;
    await mkdir(join(visual, kind), { recursive: true });
    await writeFile(join(visual, kind, `${item.name}.png`), bytes, { flag: 'wx' });
    return `${kind}/${item.name}.png`;
  };
  return { ...item, approved: await put('approved', loaded.approved.bytes), current: await put('current', loaded.current.bytes), diff: await put('diff', outcome.diff) };
}
function describe(item: VisualItem, rule: Rule, settings: Settings): string {
  const name = `Screenshot "${item.name}"`;
  if (rule === 'visual-unreadable') return `${name} cannot be compared: ${item.note}`;
  if (rule === 'visual-new') return `${name} has no approved baseline: check it, then run "qualitygate visual approve ${item.name}"${item.note ? ` (${item.note})` : ''}`;
  if (rule === 'visual-missing') return `${name} has an approved baseline but the run produced no screenshot${item.note ? `. ${item.note}` : ''}`;
  return item.note ? `${name} changed. ${item.note}` : `${name} changed: ${percent(item.diffRatio)} of pixels differ (limit ${percent(settings.maxDiffRatio)})`;
}
const posix = (path: string) => path.split(sep).join('/');
/** Finds every screenshot in both folders and decides each one. */
interface Run { spec: GateSpec; root: string; visual: string; startedAt: number }
async function compareFolders({ spec, root, visual, startedAt }: Run, settings: Settings) {
  const baseline = await projectFolder(root, settings.baseline, 'baseline folder');
  const current = await projectFolder(root, settings.current, 'current folder');
  const labels = { baseline: posix(relative(root, baseline.path)), current: posix(relative(root, current.path)) };
  const approvedList = await listPngs(labels.baseline, baseline.path);
  const currentList = await listPngs(labels.current, current.path);
  const problems = [...approvedList.problems, ...currentList.problems];
  const blocked = new Set([...approvedList.blocked, ...currentList.blocked]);
  const keys = [...new Set([...approvedList.files.keys(), ...currentList.files.keys()])].filter(key => !blocked.has(key)).sort();
  const items: VisualItem[] = []; const findings: Finding[] = [];
  for (const key of keys) {
    const approvedFile = approvedList.files.get(key); const found = currentList.files.get(key);
    const name = (approvedFile ?? found)!.name;
    if (approvedFile && found && approvedFile.name !== found.name) { problems.push(`${labels.current}/${found.name}.png: name collides with ${labels.baseline}/${approvedFile.name}.png (names are compared without case)`); continue; }
    if (settings.ignore.has(name)) continue;
    const stale = found !== undefined && found.mtimeMs < startedAt;
    const currentFile = stale ? undefined : found;
    const loaded = { approved: await load(approvedFile, 'approved image', settings.maxPixels), current: await load(currentFile, 'current image', settings.maxPixels) };
    const base: VisualItem = { name, status: 'match', approved: null, current: null, diff: null, width: 0, height: 0, diffPixels: 0, diffRatio: 0, threshold: settings.threshold };
    const outcome = decide(base, loaded, settings, stale);
    const item = await store(visual, outcome, loaded);
    items.push(item);
    if (outcome.rule) findings.push({ gateId: spec.id, severity: 'error', message: describe(item, outcome.rule, settings), file: posix(relative(root, join(current.path, `${name}.png`))), ruleId: outcome.rule });
  }
  for (const problem of problems) findings.push({ gateId: spec.id, severity: 'error', message: problem, file: problem.split(': ')[0], ruleId: 'visual-problem' });
  return { items, findings, problems, labels };
}
function summary(items: VisualItem[]): string {
  const count = (status: string) => items.filter(item => item.status === status).length;
  return `${items.length} screenshots: ${count('match')} match, ${count('changed')} changed, ${count('new')} new, ${count('missing')} missing`;
}
async function runVisual(spec: GateSpec, context: Parameters<GatePlugin['run']>[1]): Promise<GateData> {
  const settings = settingsOf(spec);
  const root = await realpath(context.projectDir ?? process.cwd());
  if (!context.evidenceDir) throw new Error('The run has no evidence folder, so the screenshots cannot be stored');
  const folders = [await projectFolder(root, settings.current, 'current folder'), await projectFolder(root, settings.baseline, 'baseline folder')];
  // Screenshots written to the baseline (or a baseline read from the current folder) would always compare equal: never a pass.
  if (overlaps(folders[0]!.real, folders[1]!.real)) throw new Error(`The current and baseline folders must be different and must not contain each other: ${show(settings.current)} and ${show(settings.baseline)}`);
  const visual = join(context.evidenceDir, VISUAL_DIR);
  await mkdir(visual).catch(() => { throw new Error('Only one visual gate can run per run: the evidence folder already has visual results'); });
  const startedAt = Date.now() - FILE_TIME_SLACK_MS;
  const captured = await captureCommand(root, spec, context);
  if (captured.error) return { exitCode: captured.exitCode, output: captured.output, error: captured.error, ...(captured.timedOut ? { timedOut: true } : {}) };
  if (captured.exitCode !== 0) return { exitCode: captured.exitCode, output: `${captured.output}\n[screenshots not compared: the command failed]\n` };
  const { items, findings, problems, labels } = await compareFolders({ spec, root, visual, startedAt }, settings);
  if (!items.length && !problems.length) throw new Error(`No screenshots found in ${labels.current} and no approved baselines in ${labels.baseline}: the command must write PNG files there`);
  const report: VisualReport = { schemaVersion: 1, gateId: spec.id, baselineDir: labels.baseline, items, ...(problems.length ? { problems } : {}) };
  await writeFile(join(visual, REPORT_FILE), JSON.stringify(report, null, 2), { flag: 'wx' });
  const lines = items.map(item => `${item.name}: ${item.status}${item.note ? ` (${item.note})` : item.status === 'changed' ? ` (${percent(item.diffRatio)} of pixels differ)` : ''}`);
  return { exitCode: findings.length ? 1 : 0, output: [captured.output.trimEnd(), ...lines, ...problems, summary(items)].filter(Boolean).join('\n') + '\n', findings };
}
/** Runs the screenshot command, compares its PNG files with the approved baseline and writes `visual/visual.json` into the run evidence. */
export const visualGate: GatePlugin = { id: 'visual', apiVersion: 1, kind: 'gate', async run(spec, context) {
  try { return await runVisual(spec, context); } catch (error) { return { exitCode: null, output: '', error: message(error) }; }
} };
