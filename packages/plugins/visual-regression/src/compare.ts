import type { Image } from './png.js';
export type { Image };
/** The largest possible YIQ colour distance, used to turn the 0..1 threshold into a distance. */
const MAX_DELTA = 35215;
/** Draws a pixel on a white background, so transparent areas compare as white. */
const onWhite = (channel: number, alpha: number) => 255 + (channel - 255) * (alpha / 255);
function yiq(data: Uint8Array, offset: number): [number, number, number] {
  const alpha = data[offset + 3]!;
  const r = onWhite(data[offset]!, alpha); const g = onWhite(data[offset + 1]!, alpha); const b = onWhite(data[offset + 2]!, alpha);
  return [
    r * 0.29889531 + g * 0.58662247 + b * 0.11448223,
    r * 0.59597799 - g * 0.2741761 - b * 0.32180189,
    r * 0.21147017 - g * 0.52261711 + b * 0.31114694,
  ];
}
/** Perceptual distance of one pixel in both images (the YIQ metric used by common screenshot comparers). */
function distance(approved: Uint8Array, current: Uint8Array, offset: number): number {
  const [y1, i1, q1] = yiq(approved, offset); const [y2, i2, q2] = yiq(current, offset);
  return 0.5053 * (y1 - y2) ** 2 + 0.299 * (i1 - i2) ** 2 + 0.1957 * (q1 - q2) ** 2;
}
/** A faded copy of the current pixel, so changed pixels in red stand out. */
function fade(data: Uint8Array, offset: number, out: Uint8Array) {
  const [y] = yiq(data, offset);
  out.set([0, 1, 2].map(() => Math.round(255 + (y - 255) * 0.1)), offset);
  out[offset + 3] = 255;
}
/**
 * Compares two images of the same size. `threshold` (0..1) is the colour distance a pixel may move before it counts:
 * 0 counts any difference. The diff image shows differing pixels in red over a faded copy of the current image.
 */
export function compareImages(approved: Image, current: Image, threshold: number): { diffPixels: number; diff: Image } {
  if (approved.width !== current.width || approved.height !== current.height) throw new Error('Images must have the same size');
  const limit = MAX_DELTA * threshold * threshold;
  const diff: Image = { width: current.width, height: current.height, data: new Uint8Array(current.data.length) };
  let diffPixels = 0;
  for (let offset = 0; offset < current.data.length; offset += 4) {
    if (distance(approved.data, current.data, offset) > limit) { diffPixels++; diff.data.set([255, 0, 0, 255], offset); }
    else fade(current.data, offset, diff.data);
  }
  return { diffPixels, diff };
}
