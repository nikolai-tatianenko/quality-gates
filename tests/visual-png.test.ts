import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { decodePng, encodePng } from '../packages/plugins/visual-regression/src/png.js';
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type: string, data: Buffer, crc?: number): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc ?? crc32(body));
  return Buffer.concat([head, body, tail]);
}
function header(width: number, height: number, depth = 8, colorType = 6, interlace = 0): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0); data.writeUInt32BE(height, 4); data[8] = depth; data[9] = colorType; data[12] = interlace;
  return chunk('IHDR', data);
}
/** Builds a PNG from raw scanlines (each already prefixed with its filter byte). */
function png(width: number, height: number, scanlines: number[][], options: { colorType?: number; depth?: number; interlace?: number; extra?: Buffer[]; split?: boolean } = {}): Buffer {
  const raw = deflateSync(Buffer.from(scanlines.flat()));
  const idat = options.split ? [chunk('IDAT', raw.subarray(0, 3)), chunk('IDAT', raw.subarray(3))] : [chunk('IDAT', raw)];
  return Buffer.concat([SIGNATURE, header(width, height, options.depth, options.colorType, options.interlace), ...(options.extra ?? []), ...idat, chunk('IEND', Buffer.alloc(0))]);
}
const rgba = (...pixels: number[][]) => Uint8Array.from(pixels.flat());
test('encode then decode round-trips RGBA pixels', () => {
  const image = { width: 2, height: 2, data: rgba([1, 2, 3, 255], [4, 5, 6, 128], [7, 8, 9, 0], [250, 251, 252, 255]) };
  const decoded = decodePng(encodePng(image), 100);
  assert.deepEqual([decoded.width, decoded.height, [...decoded.data]], [2, 2, [...image.data]]);
});
test('decodes RGB as opaque RGBA and handles every row filter, with split IDAT chunks and ancillary chunks', () => {
  // 2x5 RGB image; row k uses filter k (None, Sub, Up, Average, Paeth), each encoding the same two pixels again.
  const row = [10, 20, 30, 40, 50, 60];
  const rows = [
    [0, ...row],
    [1, 10, 20, 30, 30, 30, 30],
    [2, 0, 0, 0, 0, 0, 0],
    [] as number[],
    [] as number[],
  ];
  // Average row: left=0, up=row => (up/2) predicted for first pixel; compute residuals from the true pixels.
  const up = row; const avg = [3, ...[0, 1, 2].map(i => (row[i]! - (up[i]! >> 1)) & 255), ...[3, 4, 5].map(i => (row[i]! - ((row[i - 3]! + up[i]!) >> 1)) & 255)];
  // Paeth row: first pixel predictor is up (a=0,c=0), second uses paeth(a, b, c).
  const paeth = (a: number, b: number, c: number) => { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  const paethRow = [4, ...[0, 1, 2].map(i => (row[i]! - row[i]!) & 255), ...[3, 4, 5].map(i => (row[i]! - paeth(row[i - 3]!, row[i]!, row[i - 3]!)) & 255)];
  rows[3] = avg; rows[4] = paethRow;
  const decoded = decodePng(png(2, 5, rows, { colorType: 2, split: true, extra: [chunk('tEXt', Buffer.from('k\0v'))] }), 100);
  for (let y = 0; y < 5; y++) assert.deepEqual([...decoded.data.subarray(y * 8, y * 8 + 8)], [10, 20, 30, 255, 40, 50, 60, 255], `row ${y}`);
});
test('refuses PNG kinds other than 8-bit RGB and RGBA without interlacing', () => {
  assert.throws(() => decodePng(png(1, 1, [[0, 5]], { colorType: 0 }), 100), /Unsupported PNG: color type 0/);
  assert.throws(() => decodePng(png(1, 1, [[0, 5]], { colorType: 3 }), 100), /Unsupported PNG: color type 3/);
  assert.throws(() => decodePng(png(1, 1, [[0, 0, 0, 0, 0, 0, 0, 0]], { colorType: 6, depth: 16 }), 100), /Unsupported PNG: bit depth 16/);
  assert.throws(() => decodePng(png(1, 1, [[0, 0, 0, 0, 0]], { interlace: 1 }), 100), /Unsupported PNG: interlaced/);
});
test('rejects damaged files with a clear message', () => {
  const good = encodePng({ width: 1, height: 1, data: rgba([1, 2, 3, 4]) });
  assert.throws(() => decodePng(Buffer.from('not a png at all'), 100), /Not a PNG file/);
  assert.throws(() => decodePng(good.subarray(0, 20), 100), /Truncated PNG/);
  assert.throws(() => decodePng(good.subarray(0, good.length - 12), 100), /PNG has no IEND chunk/);
  const flipped = Buffer.from(good); flipped[flipped.length - 20] = flipped[flipped.length - 20]! ^ 1;
  assert.throws(() => decodePng(flipped, 100), /PNG chunk IDAT has a bad checksum/);
  const badHeader = Buffer.concat([SIGNATURE, chunk('IDAT', Buffer.alloc(0)), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => decodePng(badHeader, 100), /PNG must start with an IHDR chunk/);
  assert.throws(() => decodePng(Buffer.concat([SIGNATURE, chunk('IHDR', Buffer.alloc(5)), chunk('IEND', Buffer.alloc(0))]), 100), /PNG must start with an IHDR chunk/);
  const noData = Buffer.concat([SIGNATURE, header(1, 1), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => decodePng(noData, 100), /PNG has no image data/);
  assert.throws(() => decodePng(png(1, 1, [[0, 1, 2, 3]]), 100), /PNG image data has the wrong size/);
  assert.throws(() => decodePng(png(1, 1, [[9, 1, 2, 3, 4]]), 100), /PNG uses an unknown filter 9/);
  const notZlib = Buffer.concat([SIGNATURE, header(1, 1), chunk('IDAT', Buffer.from('garbage')), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => decodePng(notZlib, 100), /PNG image data cannot be decompressed/);
  const zeroSize = Buffer.concat([SIGNATURE, header(0, 4), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => decodePng(zeroSize, 100), /PNG has no pixels/);
});
test('rejects images over the pixel limit before inflating anything', () => {
  const huge = Buffer.concat([SIGNATURE, header(100_000, 100_000), chunk('IDAT', Buffer.from('x')), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => decodePng(huge, 40_000_000), /PNG too large: 100000x100000 is 10000 megapixels, the limit is 40/);
  assert.throws(() => decodePng(encodePng({ width: 3, height: 3, data: new Uint8Array(36) }), 8), /PNG too large: 3x3/);
  assert.equal(decodePng(encodePng({ width: 3, height: 3, data: new Uint8Array(36) }), 9).width, 3);
});
