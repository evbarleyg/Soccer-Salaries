import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignLooks, PALETTES, HATS, SAMPLE_NAMES } from '../src/ducks.js';
import { HAT_IDS } from '../src/draw-duck.js';
import { seedToCode, codeToSeed, mulberry32, hashString } from '../src/rng.js';

test('every duck gets a unique palette and hat (up to 16)', () => {
  for (const n of [8, 10, 12, 16]) {
    const looks = assignLooks(SAMPLE_NAMES.slice(0, n));
    assert.equal(new Set(looks.map((l) => l.palette.id)).size, n);
    assert.equal(new Set(looks.map((l) => l.hat)).size, n);
    looks.forEach((l, i) => assert.equal(l.number, i + 1));
  }
});

test('looks are deterministic and mostly stable when a duck is added', () => {
  const a = assignLooks(SAMPLE_NAMES.slice(0, 11));
  const b = assignLooks(SAMPLE_NAMES.slice(0, 11));
  assert.deepEqual(a.map((l) => l.palette.id + l.hat), b.map((l) => l.palette.id + l.hat));
  const c = assignLooks(SAMPLE_NAMES.slice(0, 12));
  let same = 0;
  for (let i = 0; i < 11; i++) if (a[i].palette.id === c[i].palette.id && a[i].hat === c[i].hat) same++;
  assert.ok(same >= 8, `expected most ducks to keep their look, kept ${same}/11`);
});

test('duplicate and blank-ish names still get distinct ducks', () => {
  const looks = assignLooks(['Sam', 'sam ', 'SAM', 'Sam']);
  assert.equal(new Set(looks.map((l) => l.palette.id)).size, 4);
});

test('every catalogued hat has a renderer', () => {
  for (const h of HATS) assert.ok(HAT_IDS.includes(h.id), `missing drawer for ${h.id}`);
  assert.ok(PALETTES.length >= 16 && HATS.length >= 16);
});

test('seed codes round-trip', () => {
  for (const seed of [0, 1, 123456789, 4294967295, 987654321]) {
    assert.equal(codeToSeed(seedToCode(seed)), seed >>> 0);
  }
  assert.equal(codeToSeed('7gq-m2xd'), codeToSeed('7GQM2XD'));
  assert.equal(codeToSeed(''), null);
});

test('rng is reproducible', () => {
  const a = mulberry32(77);
  const b = mulberry32(77);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  assert.equal(hashString('duck'), hashString('duck'));
  assert.notEqual(hashString('duck'), hashString('Duck'));
});
