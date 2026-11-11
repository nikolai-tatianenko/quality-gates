import { crc32, deflateSync, inflateSync } from 'node:zlib';
/** Decoded pixels: 8-bit RGBA, row after row. */
export interface Image { width: number; height: number; data: Uint8Array }
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Bytes per pixel by PNG color type: 2 is RGB, 6 is RGBA. Every other kind is refused. */
const CHANNELS: Record<number, number> = { 2: 3, 6: 4 };
interface Header { width: number; height: number; colorType: number }
interface Chunk { type: string; data: Buffer }
function fail(text: string): never { throw new Error(text); }
/** Splits the file into chunks and checks every checksum; stops at IEND. */
function readChunks(file: Buffer): Chunk[] {
  if (file.length < SIGNATURE.length || !file.subarray(0, SIGNATURE.length).equals(SIGNATURE)) fail('Not a PNG file');
  const chunks: Chunk[] = [];
  let offset = SIGNATURE.length;
  while (offset < file.length) {
    if (offset + 12 > file.length) fail('Truncated PNG');
    const length = file.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > file.length) fail('Truncated PNG');
    const type = file.toString('latin1', offset + 4, offset + 8);
    if (crc32(file.subarray(offset + 4, end - 4)) !== file.readUInt32BE(end - 4)) fail(`PNG chunk ${type} has a bad checksum`);
    chunks.push({ type, data: file.subarray(offset + 8, end - 4) });
    if (type === 'IEND') return chunks;
    offset = end;
  }
  return fail('PNG has no IEND chunk');
}
/** Reads IHDR and refuses everything but 8-bit RGB or RGBA without interlacing. */
function readHeader(first: Chunk | undefined): Header {
  if (first?.type !== 'IHDR' || first.data.length !== 13) fail('PNG must start with an IHDR chunk');
  const { data } = first;
  const header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), colorType: data[9]! };
  if (data[8] !== 8) fail(`Unsupported PNG: bit depth ${data[8]} (only 8-bit RGB and RGBA are supported)`);
  if (!CHANNELS[header.colorType]) fail(`Unsupported PNG: color type ${header.colorType} (only 8-bit RGB and RGBA are supported)`);
  if (data[12] !== 0) fail('Unsupported PNG: interlaced (only non-interlaced images are supported)');
  return header;
}
const paeth = (left: number, up: number, upLeft: number) => {
  const estimate = left + up - upLeft;
  const fromLeft = Math.abs(estimate - left); const fromUp = Math.abs(estimate - up); const fromUpLeft = Math.abs(estimate - upLeft);
  return fromLeft <= fromUp && fromLeft <= fromUpLeft ? left : fromUp <= fromUpLeft ? up : upLeft;
};
/** What the filter predicts for one byte, given the byte to the left, above and above-left. */
const PREDICTORS: Record<number, (left: number, up: number, upLeft: number) => number> = {
  0: () => 0, 1: left => left, 2: (_, up) => up, 3: (left, up) => (left + up) >> 1, 4: paeth,
};
/** Reverses the per-row filters in place and returns the pixel rows without their filter bytes. */
function unfilter(raw: Buffer, width: number, height: number, bytesPerPixel: number): Uint8Array {
  const stride = width * bytesPerPixel;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const predict = PREDICTORS[raw[y * (stride + 1)]!] ?? fail(`PNG uses an unknown filter ${raw[y * (stride + 1)]}`);
    const source = y * (stride + 1) + 1; const target = y * stride; const above = target - stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bytesPerPixel ? out[target + x - bytesPerPixel]! : 0;
      const up = y > 0 ? out[above + x]! : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? out[above + x - bytesPerPixel]! : 0;
      out[target + x] = (raw[source + x]! + predict(left, up, upLeft)) & 255;
    }
  }
  return out;
}
/** Expands RGB rows to RGBA with full opacity. */
function toRgba(rows: Uint8Array, pixels: number, channels: number): Uint8Array {
  if (channels === 4) return rows;
  const out = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) { out.set(rows.subarray(i * 3, i * 3 + 3), i * 4); out[i * 4 + 3] = 255; }
  return out;
}
/**
 * Decodes an 8-bit RGB or RGBA non-interlaced PNG. Anything else throws with a clear message, so an image the
 * comparer cannot read can never count as a match. The pixel limit is checked before any decompression.
 */
export function decodePng(file: Buffer, maxPixels: number): Image {
  const chunks = readChunks(file);
  const { width, height, colorType } = readHeader(chunks[0]);
  const pixels = width * height;
  if (pixels === 0) fail('PNG has no pixels');
  if (pixels > maxPixels) fail(`PNG too large: ${width}x${height} is ${Math.round(pixels / 1e6)} megapixels, the limit is ${Math.round(maxPixels / 1e6)}`);
  const parts = chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data);
  if (!parts.length) fail('PNG has no image data');
  const channels = CHANNELS[colorType]!;
  return { width, height, data: toRgba(inflateRows(parts, width, height, channels), pixels, channels) };
}
/** Inflates and unfilters the image data; the inflated copy goes out of scope here, so only the pixel rows stay alive. */
function inflateRows(parts: Buffer[], width: number, height: number, channels: number): Uint8Array {
  const expected = height * (1 + width * channels);
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(parts), { maxOutputLength: expected }); }
  catch { return fail('PNG image data cannot be decompressed (or is larger than its header says)'); }
  if (raw.length !== expected) fail('PNG image data has the wrong size');
  return unfilter(raw, width, height, channels);
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}
/** Encodes 8-bit RGBA with no row filtering; the diff image is read by people, so size does not matter. */
export function encodePng(image: Image): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0); header.writeUInt32BE(image.height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
