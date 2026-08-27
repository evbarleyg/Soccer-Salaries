import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRace, simulateRace } from '../src/world3d/race.js';

// Every duck draws its parameters i.i.d. and hazards/items key off race
// position, so index (= lane = name) must not matter. Chi-square goodness of
// fit on win / last-place counts over fixed seeds (deterministic).
const chi = (arr, expected) => arr.reduce((s, w) => s + (w - expected) ** 2 / expected, 0);

test('3D engine: each lane wins (and loses) about equally often — items + hot dogs on', () => {
  const count = 10;
  const races = 520;
  const wins = new Array(count).fill(0);
  const last = new Array(count).fill(0);
  for (let r = 0; r < races; r++) {
    const sim = createRace({ count, seed: (r * 7919 + 13) >>> 0 });
    wins[sim.order[0]]++;
    last[sim.order[count - 1]]++;
  }
  const expected = races / count;
  // df = 9, critical value at p = 0.01 is 21.67
  assert.ok(chi(wins, expected) < 21.67, `wins look biased: ${wins.join(',')} chi=${chi(wins, expected).toFixed(2)}`);
  assert.ok(chi(last, expected) < 21.67, `last places look biased: ${last.join(',')} chi=${chi(last, expected).toFixed(2)}`);
});

test('3D engine: fair with 16 ducks too (raw simulation, everything on)', () => {
  const count = 16;
  const races = 480;
  const wins = new Array(count).fill(0);
  for (let r = 0; r < races; r++) wins[simulateRace({ count, seed: (r * 48611 + 7) >>> 0 }).order[0]]++;
  const expected = races / count;
  // df = 15, critical value at p = 0.01 is 30.58
  assert.ok(chi(wins, expected) < 30.58, `wins look biased: ${wins.join(',')} chi=${chi(wins, expected).toFixed(2)}`);
});
