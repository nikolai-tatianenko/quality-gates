import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totalWithShipping } from './shipping.mjs';
test('shipping is added to the subtotal', () => {
  assert.equal(totalWithShipping(100, 5), 105, 'Shipping must be added to subtotal');
});
test('zero shipping preserves the subtotal', () => {
  assert.equal(totalWithShipping(100, 0), 100);
});
