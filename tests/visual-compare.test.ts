import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareImages, type Image } from '../packages/plugins/visual-regression/src/compare.js';
const solid = (width: number, height: number, rgba: number[]): Image => ({ width, height, data: Uint8Array.from({ length: width * height * 4 }, (_, i) => rgba[i % 4]!) });
const paint = (image: Image, x: number, y: number, rgba: number[]) => { image.data.set(rgba, (y * image.width + x) * 4); return image; };
test('identical images have no differing pixels and a faded diff', () => {
  const result = compareImages(solid(4, 3, [0, 0, 0, 255]), solid(4, 3, [0, 0, 0, 255]), 0.1);
  assert.equal(result.diffPixels, 0);
  assert.deepEqual([result.diff.width, result.diff.height], [4, 3]);
  assert.deepEqual([...result.diff.data.subarray(0, 4)], [230, 230, 230, 255]);
});
test('counts changed pixels and paints them red in the diff', () => {
  const current = paint(solid(4, 3, [255, 255, 255, 255]), 2, 1, [0, 0, 0, 255]);
  const result = compareImages(solid(4, 3, [255, 255, 255, 255]), current, 0.1);
  assert.equal(result.diffPixels, 1);
  assert.deepEqual([...result.diff.data.subarray((1 * 4 + 2) * 4, (1 * 4 + 2) * 4 + 4)], [255, 0, 0, 255]);
  assert.deepEqual([...result.diff.data.subarray(0, 4)], [255, 255, 255, 255]);
});
test('threshold is the colour distance a pixel may move before it counts', () => {
  const near = paint(solid(2, 1, [100, 100, 100, 255]), 0, 0, [104, 100, 100, 255]);
  const base = solid(2, 1, [100, 100, 100, 255]);
  assert.equal(compareImages(base, near, 0.1).diffPixels, 0);
  assert.equal(compareImages(base, near, 0).diffPixels, 1);
  const far = paint(solid(2, 1, [100, 100, 100, 255]), 0, 0, [200, 100, 100, 255]);
  assert.equal(compareImages(base, far, 0.1).diffPixels, 1);
  assert.equal(compareImages(base, far, 1).diffPixels, 0);
});
test('transparent pixels are compared as if drawn on white', () => {
  const clear = solid(1, 1, [0, 0, 0, 0]);
  assert.equal(compareImages(clear, solid(1, 1, [255, 255, 255, 255]), 0.1).diffPixels, 0);
  assert.equal(compareImages(clear, solid(1, 1, [0, 0, 0, 255]), 0.1).diffPixels, 1);
});
test('refuses images of different sizes', () => {
  assert.throws(() => compareImages(solid(2, 2, [0, 0, 0, 255]), solid(3, 2, [0, 0, 0, 255]), 0.1), /same size/);
});
