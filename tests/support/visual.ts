import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buffer: Buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(body));
  return Buffer.concat([head, body, tail]);
}
/** A small solid-colour RGB PNG, so tests never depend on binary fixture files. */
export function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
export const RUN_ID = '44444444-4444-4444-8444-444444444444';
export type FixtureItem = { name: string; status: 'match' | 'changed' | 'new' | 'missing'; diffRatio?: number };
const colors: Record<string, [number, number, number]> = { approved: [40, 90, 200], current: [200, 90, 40], diff: [255, 0, 0] };
/** Writes `<outputDir>/<runId>/visual/` exactly as the visual-regression plugin does: visual.json plus approved|current|diff copies. */
export async function writeVisualRun(outputDir: string, items: FixtureItem[], runId = RUN_ID, size: [number, number] = [8, 4]) {
  const folder = join(outputDir, runId, 'visual');
  const listed = [];
  for (const kind of ['approved', 'current', 'diff']) await mkdir(join(folder, kind), { recursive: true });
  for (const item of items) {
    const has = { approved: item.status !== 'new', current: item.status !== 'missing', diff: item.status === 'changed' };
    const paths: Record<string, string | null> = {};
    for (const kind of ['approved', 'current', 'diff'] as const) {
      paths[kind] = has[kind] ? `${kind}/${item.name}.png` : null;
      if (has[kind]) await writeFile(join(folder, `${kind}/${item.name}.png`), png(size[0], size[1], colors[kind]!));
    }
    listed.push({ name: item.name, status: item.status, ...paths, width: size[0], height: size[1], diffPixels: item.status === 'changed' ? 3 : 0, diffRatio: item.diffRatio ?? (item.status === 'changed' ? 0.09375 : 0), threshold: 0.1 });
  }
  await writeFile(join(folder, 'visual.json'), JSON.stringify({ schemaVersion: 1, gateId: 'visual', baselineDir: 'qualitygate-visual/approved', items: listed }));
  return folder;
}
