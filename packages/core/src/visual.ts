import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { message } from '../../protocol/src/index.js';

/**
 * The reader side of the optional visual-regression plugin. The plugin writes one `visual/visual.json` per run plus copies of the
 * images next to it; this module only reads them. It never decides, changes or approves anything, so a verdict is unaffected.
 */
export const VISUAL_KINDS = ['approved', 'current', 'diff'] as const;
export type VisualKind = (typeof VISUAL_KINDS)[number];
const MAX_JSON_BYTES = 1_000_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ITEMS = 500;
const MAX_IMAGE_PIXELS = 40_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An item name: also what a person is told to type after `visual approve`, so it must never start like an option. */
const segment = z.string().regex(/^[A-Za-z0-9._-]{1,120}$/).refine(value => !value.startsWith('.'), 'must not start with a dot').refine(value => !value.startsWith('-'), 'must not start with a dash');
/** A path inside the project: not absolute, no drive letter, no `..` segment (either slash). */
const projectRelative = z.string().min(1).max(512).refine(value => !/^[\\/]|^[A-Za-z]:|\0/.test(value) && !value.split(/[\\/]/).includes('..'), 'must be a project-relative path');
const pathOf = z.string().regex(/^(approved|current|diff)\/[A-Za-z0-9._-]{1,124}$/).refine(value => !value.split('/')[1]!.startsWith('.'), 'must not start with a dot').nullable();
const itemSchema = z.object({
  name: segment, status: z.enum(['match', 'changed', 'new', 'missing']),
  approved: pathOf, current: pathOf, diff: pathOf,
  width: z.number().int().min(0), height: z.number().int().min(0), diffPixels: z.number().int().min(0),
  diffRatio: z.number().min(0).max(1), threshold: z.number().min(0),
}).superRefine((item, context) => {
  for (const kind of VISUAL_KINDS) if (item[kind] && !item[kind].startsWith(`${kind}/`)) context.addIssue({ code: 'custom', message: `${kind} must point into the ${kind} folder` });
});
/** Optional fields may be added to the file later; unknown keys are ignored, not rejected. */
const visualSchema = z.object({
  schemaVersion: z.literal(1), gateId: z.string().min(1).max(128), baselineDir: projectRelative,
  items: z.array(itemSchema).max(MAX_ITEMS),
}).refine(file => new Set(file.items.map(item => item.name)).size === file.items.length, 'item names must be unique');
type VisualFile = z.infer<typeof visualSchema>;

/** What a client may see of one item: numbers and which images exist, never file paths. */
export interface VisualItemView {
  name: string; status: 'match' | 'changed' | 'new' | 'missing'; width: number; height: number; diffPixels: number; diffRatio: number; threshold: number;
  images: Record<VisualKind, boolean>;
}
export interface VisualView { enabled: boolean; runId?: string; gateId?: string; baselineDir?: string; items: VisualItemView[]; warning?: string }

/** Refusal to serve an image; `status` is the HTTP status the caller should answer with. */
export class VisualImageError extends Error {
  constructor(readonly status: number, text: string) { super(text); }
}

type Read = { data: Buffer } | { missing: true } | { problem: string; large?: true };
/** Reads a regular file without following a link in its last component, capped in size. */
async function readRegular(file: string, cap: number, label: string): Promise<Read> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => error);
  if (handle instanceof Error) return ['ENOENT', 'ENOTDIR'].includes((handle as NodeJS.ErrnoException).code ?? '') ? { missing: true } : { problem: `${label} is not a regular file or cannot be read` };
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { problem: `${label} is not a regular file or cannot be read` };
    if (info.size > cap) return { problem: `${label} is too large`, large: true };
    return { data: await handle.readFile() };
  } finally { await handle.close(); }
}
const assertRunId = (runId: string) => { if (!z.string().uuid().safeParse(runId).success) throw new Error('Invalid run ID'); };
const visualFolder = (outputDir: string, runId: string) => join(outputDir, runId, 'visual');

/** The run folder and the visual folder must be real folders: a link there could point anywhere. A missing one means "no visual results". */
async function checkFolders(outputDir: string, runId: string): Promise<{ warning?: string } | undefined> {
  for (const [label, path] of [['run folder', join(outputDir, runId)], ['visual folder', visualFolder(outputDir, runId)]] as const) {
    const info = await lstat(path).catch(() => undefined);
    if (!info) return {};
    if (!info.isDirectory()) return { warning: `${label} is ${info.isSymbolicLink() ? 'a symbolic link' : 'not a folder'}` };
  }
  return undefined;
}
async function loadFile(outputDir: string, runId: string): Promise<{ file: VisualFile } | { warning?: string }> {
  const folders = await checkFolders(outputDir, runId);
  if (folders) return folders;
  const read = await readRegular(join(visualFolder(outputDir, runId), 'visual.json'), MAX_JSON_BYTES, 'visual.json');
  if ('missing' in read) return {};
  if ('problem' in read) return { warning: read.problem };
  try {
    const parsed = visualSchema.safeParse(JSON.parse(read.data.toString('utf8')));
    return parsed.success ? { file: parsed.data } : { warning: `visual.json is invalid: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}` };
  } catch (error) { return { warning: `visual.json is invalid: ${message(error)}` }; }
}

/**
 * The visual comparison of one run. A run without `visual/visual.json` is simply "not enabled" (empty, no error); a file that
 * cannot be used gives an empty answer with a `warning`, so a broken plugin never breaks the dashboard or the bridge.
 */
export async function readVisual(outputDir: string, runId: string): Promise<VisualView> {
  assertRunId(runId);
  const loaded = await loadFile(outputDir, runId);
  if (!('file' in loaded)) return { enabled: false, items: [], ...(loaded.warning ? { warning: loaded.warning } : {}) };
  const { file } = loaded;
  return { enabled: true, runId, gateId: file.gateId, baselineDir: file.baselineDir, items: file.items.map(item => ({
    name: item.name, status: item.status, width: item.width, height: item.height, diffPixels: item.diffPixels, diffRatio: item.diffRatio, threshold: item.threshold,
    images: { approved: !!item.approved, current: !!item.current, diff: !!item.diff },
  })) };
}

/** IHDR is the first chunk: its size must equal what visual.json says, and a decompression bomb is not served to a browser. */
function checkSize(data: Buffer, listed: { width: number; height: number }) {
  if (data.length < 24 || data.readUInt32BE(8) !== 13 || data.toString('latin1', 12, 16) !== 'IHDR') throw new VisualImageError(415, 'Image is not a PNG');
  const [width, height] = [data.readUInt32BE(16), data.readUInt32BE(20)];
  if (width * height > MAX_IMAGE_PIXELS) throw new VisualImageError(422, `Image has more than ${MAX_IMAGE_PIXELS / 1e6} megapixels`);
  if (width !== listed.width || height !== listed.height) throw new VisualImageError(422, 'Image size does not match visual.json');
}
/**
 * The bytes of one image the run's visual.json lists, addressed by item name and kind, never by path. Only a regular PNG file
 * directly inside `visual/<kind>/` of that run is served: links (also on the folders) are refused, the size is capped and the
 * file must start with the PNG signature, and its header size must equal the item's and stay under 40 megapixels.
 */
export async function readVisualImage(outputDir: string, runId: string, name: string, kind: string): Promise<Buffer> {
  assertRunId(runId);
  if (!segment.safeParse(name).success) throw new VisualImageError(400, 'Invalid image name');
  if (!(VISUAL_KINDS as readonly string[]).includes(kind)) throw new VisualImageError(400, 'Invalid image kind');
  const loaded = await loadFile(outputDir, runId);
  const listed = 'file' in loaded ? loaded.file.items.find(item => item.name === name) : undefined;
  const relative = listed?.[kind as VisualKind];
  if (!listed || !relative) throw new VisualImageError(404, 'Image not found');
  const folder = visualFolder(outputDir, runId);
  // lstat does not follow links: a folder replaced by a link to somewhere else is refused, whatever it holds.
  for (const directory of [folder, join(folder, kind)]) if (!(await lstat(directory).catch(() => undefined))?.isDirectory()) throw new VisualImageError(404, 'Image not found');
  const read = await readRegular(join(folder, relative), MAX_IMAGE_BYTES, 'Image');
  if ('problem' in read && read.large) throw new VisualImageError(413, 'Image is too large');
  if (!('data' in read)) throw new VisualImageError(404, 'Image not found');
  if (!read.data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new VisualImageError(415, 'Image is not a PNG');
  checkSize(read.data, listed);
  return read.data;
}
