import { build } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const options = { absWorkingDir: root };
await mkdir(`${root}dist`, { recursive: true });
// One IIFE, no eval, no remote code: the extension CSP allows only script-src 'self'.
await build({ ...options, entryPoints: { popup: 'src/main.tsx' }, bundle: true, platform: 'browser', format: 'iife', outdir: 'dist', jsx: 'automatic', minify: true, legalComments: 'none' });
await build({ ...options, entryPoints: { popup: 'src/popup.css' }, bundle: true, outdir: 'dist', minify: true });
await copyFile(`${root}manifest.json`, `${root}dist/manifest.json`);
await copyFile(`${root}src/popup.html`, `${root}dist/popup.html`);

/** A dependency-free PNG: dark rounded square with a white check mark. */
function icon(size) {
  const rows = [], inside = (x, y) => { const r = size * .22, cx = Math.min(Math.max(x, r), size - 1 - r), cy = Math.min(Math.max(y, r), size - 1 - r); return (x - cx) ** 2 + (y - cy) ** 2 <= r * r; };
  const segment = (px, py, ax, ay, bx, by) => { const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2))); return Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay)); };
  const s = size, width = Math.max(1.2, s * .09);
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) {
      const check = Math.min(segment(x, y, s * .27, s * .52, s * .44, s * .69), segment(x, y, s * .44, s * .69, s * .74, s * .33)) <= width;
      row.push(...(inside(x, y) ? (check ? [250, 250, 250, 255] : [24, 24, 27, 255]) : [0, 0, 0, 0]));
    }
    rows.push(Buffer.from(row));
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buffer => { let c = 0xffffffff; for (const b of buffer) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
for (const size of [16, 48, 128]) await writeFile(`${root}dist/icon-${size}.png`, icon(size));
