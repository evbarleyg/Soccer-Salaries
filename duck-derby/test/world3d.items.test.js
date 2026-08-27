import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemWeights, rollItem, makeBrain, brainWantsToFire, ITEM_ORDER, ITEMS } from '../src/world3d/items.js';
import { simulateRace } from '../src/world3d/race.js';
import { createRng } from '../src/rng.js';

test('catalogue is complete', () => {
  assert.deepEqual(Object.keys(ITEMS), ITEM_ORDER);
  for (const id of ITEM_ORDER) assert.ok(ITEMS[id].name && ITEMS[id].color && ITEMS[id].short);
});

test('item table depends only on race position (catch-up logic)', () => {
  const w = (rank, count, prog = 0.5) => Object.fromEntries(itemWeights(rank, count, prog));
  // leader gets defensive stuff, never hornet/mud/feather/seagull
  const lead = w(0, 12);
  assert.equal(lead.hornet, 0);
  assert.equal(lead.mud, 0);
  assert.equal(lead.feather, 0);
  assert.equal(lead.seagull, 0);
  assert.ok(lead.shield > lead.triple);
  // the back gets the good stuff
  const back = w(11, 12);
  assert.ok(back.triple > lead.triple && back.hornet > 0 && back.feather > 0 && back.seagull > 0);
  // blue shell switches off late
  assert.equal(w(11, 12, 0.95).seagull, 0);
  // seagull only for the last third
  assert.equal(w(7, 12).seagull, 0);
  assert.ok(w(8, 12).seagull > 0);
  // monotone catch-up: strength grows with rank
  let prev = -1;
  for (let r = 0; r < 12; r++) {
    const x = w(r, 12);
    const strength = x.triple + x.hornet + x.feather + x.seagull;
    assert.ok(strength >= prev - 1e-9);
    prev = strength;
  }
});

test('rollItem follows the table and consumes exactly one draw', () => {
  const rng = createRng(77);
  const counts = {};
  const N = 20000;
  for (let k = 0; k < N; k++) {
    const id = rollItem(rng, 9, 12, 0.5);
    counts[id] = (counts[id] || 0) + 1;
  }
  const w = itemWeights(9, 12, 0.5);
  const total = w.reduce((s, [, x]) => s + x, 0);
  for (const [id, x] of w) {
    const expected = (x / total) * N;
    if (expected === 0) assert.ok(!counts[id]);
    else assert.ok(Math.abs((counts[id] || 0) - expected) < 5 * Math.sqrt(expected) + 10, `${id}: ${counts[id]} vs ${expected}`);
  }
  const a = createRng(5);
  const b = createRng(5);
  rollItem(a, 3, 10, 0.4);
  b.next();
  assert.equal(a.next(), b.next());
});

test('brains are deterministic pure functions of (params, view)', () => {
  const b1 = makeBrain(createRng(9));
  const b2 = makeBrain(createRng(9));
  assert.deepEqual(b1, b2);
  const view = { item: 'hornet', heldFor: 1.2, sinceLastUse: 1.2, chargesLeft: 1, rank: 3, count: 12, gapAhead: 20, latDiffAhead: 0.5, prog: 0.4, airborne: false, spinning: false };
  assert.equal(brainWantsToFire(b1, view), brainWantsToFire(b2, { ...view }));
  assert.equal(brainWantsToFire(b1, { ...view, airborne: true }), false, 'never fires in the air');
  assert.equal(brainWantsToFire(b1, { ...view, item: 'shield' }), false);
  assert.equal(brainWantsToFire(b1, { ...view, item: 'feather', heldFor: 0.5 }), true);
  assert.equal(brainWantsToFire(b1, { ...view, item: 'hornet', rank: 0, heldFor: 2 }), false, 'leader sits on a hornet');
});

test('item pickups, uses and hits are spread evenly across ducks (symmetric by index)', () => {
  const count = 8;
  const pick = new Array(count).fill(0);
  const hit = new Array(count).fill(0);
  for (let seed = 1; seed <= 260; seed++) {
    const sim = simulateRace({ count, seed: seed * 104729 });
    for (const e of sim.events) {
      if (e.type === 'pickup') pick[e.duck]++;
      if (e.type === 'hit') hit[e.duck]++;
    }
  }
  const chi = (arr) => {
    const exp = arr.reduce((s, x) => s + x, 0) / arr.length;
    return arr.reduce((s, x) => s + (x - exp) ** 2 / exp, 0);
  };
  // df = 7, p = 0.01 critical 18.48
  assert.ok(chi(pick) < 18.48, `pickups by duck look biased: ${pick} chi=${chi(pick).toFixed(1)}`);
  assert.ok(chi(hit) < 18.48, `hits by duck look biased: ${hit} chi=${chi(hit).toFixed(1)}`);
});
