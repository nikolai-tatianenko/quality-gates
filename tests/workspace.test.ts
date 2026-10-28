import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('published CLI declares the MIT license', () => {
  assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).license, 'MIT');
});
