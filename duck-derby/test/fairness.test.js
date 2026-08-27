import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRace } from '../src/sim.js';

// Every duck draws its parameters i.i.d., so lane/name must not matter.
// Chi-square goodness-of-fit on win counts across fixed seeds (deterministic).
test('each lane wins about equally often (chi-square)', () => {
  const count = 10;
  const races = 700;
  const wins = new Array(count).fill(0);
  const last = new Array(count).fill(0);
  for (let r = 0; r < races; r++) {
    const sim = createRace({ count, seed: (r * 7919 + 13) >>> 0, duration: 38 });
    wins[sim.order[0]]++;
    last[sim.order[count - 1]]++;
  }
  const expected = races / count;
  const chi = (arr) => arr.reduce((s, w) => s + (w - expected) ** 2 / expected, 0);
  // df = 9, critical value at p = 0.01 is 21.67
  assert.ok(chi(wins) < 21.67, `wins look biased: ${wins.join(',')} chi=${chi(wins).toFixed(2)}`);
  assert.ok(chi(last) < 21.67, `last places look biased: ${last.join(',')} chi=${chi(last).toFixed(2)}`);
});
