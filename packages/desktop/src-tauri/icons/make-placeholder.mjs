// Writes icon.png, a 512x512 placeholder (dark rounded square, white check). Replace it with the real artwork, then run
// `cargo tauri icon src-tauri/icons/icon.png` to generate the platform formats (.icns, .ico, sizes) listed in tauri.conf.json.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const size = 512;
const inside = (x, y) => { const r = size * .22, cx = Math.min(Math.max(x, r), size - 1 - r), cy = Math.min(Math.max(y, r), size - 1 - r); return (x - cx) ** 2 + (y - cy) ** 2 <= r * r; };
const segment = (px, py, ax, ay, bx, by) => { const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2))); return Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay)); };
const rows = [];
for (let y = 0; y < size; y++) {
  const row = [0];
  for (let x = 0; x < size; x++) {
    const check = Math.min(segment(x, y, size * .27, size * .52, size * .44, size * .69), segment(x, y, size * .44, size * .69, size * .74, size * .33)) <= size * .05;
    row.push(...(inside(x, y) ? (check ? [250, 250, 250, 255] : [24, 24, 27, 255]) : [0, 0, 0, 0]));
  }
  rows.push(Buffer.from(row));
}
const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buffer => { let c = 0xffffffff; for (const b of buffer) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
writeFileSync(fileURLToPath(new URL('./icon.png', import.meta.url)), png);
