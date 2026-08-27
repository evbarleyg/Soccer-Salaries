import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseParams, buildQuery, resolveCam, draftOrder } from '../src/world3d/params.js';
import { seedToCode } from '../src/rng.js';

test('params round-trip like the 2D app', () => {
  const q = buildQuery({ names: ['Ann', 'Bob B', 'Cé'], seed: 123456789, rule: 'l', hazards: false, items: true });
  const p = parseParams(q);
  assert.deepEqual(p.names, ['Ann', 'Bob B', 'Cé']);
  assert.equal(p.seed, 123456789 >>> 0);
  assert.equal(p.rule, 'l');
  assert.equal(p.hazards, false);
  assert.equal(p.items, true);
  assert.ok(q.includes(seedToCode(123456789)));
});

test('bad rosters are rejected, cam resolves by name or lane', () => {
  assert.equal(parseParams('names=solo').names, null);
  assert.equal(parseParams('names=' + new Array(17).fill('x').join('~')).names, null);
  const names = ['Quack Sparrow', 'Duck Norris', 'Mallory'];
  assert.equal(resolveCam('2', names), 1);
  assert.equal(resolveCam('duck  norris', names), 1);
  assert.equal(resolveCam('nobody', names), -1);
  assert.equal(resolveCam('9', names), -1);
  assert.equal(parseParams('view=tv').view, 'tv');
  assert.equal(parseParams('view=bogus').view, null);
});

test('draft order honours the rule', () => {
  assert.deepEqual(draftOrder([2, 0, 1], 'w'), [2, 0, 1]);
  assert.deepEqual(draftOrder([2, 0, 1], 'l'), [1, 0, 2]);
});
