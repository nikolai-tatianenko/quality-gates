import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gateSchema, type GateData } from '../packages/protocol/src/index.js';
import type { Context } from '../packages/plugin-sdk/src/index.js';
import { encodePng } from '../packages/plugins/visual-regression/src/png.js';
import { visualGate } from '../packages/plugins/visual-regression/src/gate.js';
import type { VisualReport } from '../packages/plugins/visual-regression/src/types.js';
import { readFile } from 'node:fs/promises';
export interface Project { dir: string; evidence: string }
/** A temporary project with an empty evidence folder; always a real path. */
export async function withProject(fn: (project: Project) => Promise<void>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'qg-visual-')));
  const evidence = join(dir, '.qualitygate', 'run-1');
  await mkdir(evidence, { recursive: true });
  try { await fn({ dir, evidence }); } finally { await rm(dir, { recursive: true, force: true }); }
}
export const solid = (width: number, height: number, rgba: number[]) => ({ width, height, data: Uint8Array.from({ length: width * height * 4 }, (_, i) => rgba[i % 4]!) });
export const WHITE = [255, 255, 255, 255];
export const BLACK = [0, 0, 0, 255];
/** Writes a solid-colour PNG (optionally with one different pixel) and returns its path. */
export async function shot(dir: string, path: string, rgba = WHITE, options: { size?: [number, number]; dot?: number[]; age?: number } = {}) {
  const [width, height] = options.size ?? [10, 10];
  const image = solid(width, height, rgba);
  if (options.dot) image.data.set(options.dot, 0);
  const file = join(dir, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, encodePng(image));
  if (options.age) { const old = new Date(Date.now() - options.age); await utimes(file, old, old); }
  return file;
}
export const spec = (patch: Record<string, unknown> = {}) => gateSchema.parse({ id: 'shots', type: 'visual', run: 'true', current: 'shots', baseline: 'base', ...patch });
export const context = (project: Project, patch: Partial<Context> = {}): Context => ({ signal: new AbortController().signal, defer: () => {}, projectDir: project.dir, evidenceDir: project.evidence, ...patch });
/** Runs the gate once in a fresh evidence folder (a run holds at most one visual gate) and returns its result and visual.json. */
export async function runGate(project: Project, patch: Record<string, unknown> = {}, ctx: Partial<Context> = {}): Promise<GateData & { report?: VisualReport; evidence: string }> {
  const evidence = join(project.dir, '.qualitygate', randomUUID());
  await mkdir(evidence, { recursive: true });
  const data = await visualGate.run(spec(patch), context(project, { evidenceDir: evidence, ...ctx }));
  await writeFile(join(evidence, 'report.json'), '{}'); // marks the folder as a finished run for "visual approve"
  const report = await readFile(join(evidence, 'visual', 'visual.json'), 'utf8').then(text => JSON.parse(text) as VisualReport, () => undefined);
  return { ...data, report, evidence };
}
