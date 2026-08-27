import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateRace, createRace, standingsAt, positionAt, TRACK_LENGTH, TUNING } from '../src/sim.js';

test('same seed => identical race', () => {
  const a = createRace({ count: 12, seed: 123456, duration: 38 });
  const b = createRace({ count: 12, seed: 123456, duration: 38 });
  assert.deepEqual(a.order, b.order);
  assert.deepEqual(a.finishTimes, b.finishTimes);
  assert.equal(a.variant, b.variant);
  assert.equal(a.events.length, b.events.length);
});

test('different seeds => (almost surely) different races', () => {
  const a = createRace({ count: 10, seed: 1 });
  const b = createRace({ count: 10, seed: 2 });
  assert.notDeepEqual(a.finishTimes, b.finishTimes);
});

test('everyone finishes, order is a permutation sorted by finish time', () => {
  for (const count of [2, 8, 10, 12, 16]) {
    const sim = createRace({ count, seed: 99 + count });
    assert.equal(sim.order.length, count);
    assert.deepEqual([...sim.order].sort((x, y) => x - y), [...Array(count).keys()]);
    for (let k = 1; k < count; k++) {
      assert.ok(sim.finishTimes[sim.order[k]] >= sim.finishTimes[sim.order[k - 1]]);
    }
    assert.ok(sim.finishTimes.every((t) => Number.isFinite(t) && t > 0));
    assert.ok(!sim.events.some((e) => e.forced), 'no forced finishes in normal races');
  }
});

test('positions are monotonic, finite and end at the line', () => {
  const sim = simulateRace({ count: 12, seed: 42 });
  for (let i = 0; i < sim.count; i++) {
    const p = sim.pos[i];
    for (let k = 1; k < p.length; k++) {
      assert.ok(Number.isFinite(p[k]));
      assert.ok(p[k] >= p[k - 1] - 1e-6, `duck ${i} went backwards at tick ${k}`);
    }
    assert.ok(Math.abs(p[p.length - 1] - TRACK_LENGTH) < 1e-3);
  }
});

test('winner time lands near the configured duration', () => {
  for (const duration of [24, 38, 55]) {
    const sim = createRace({ count: 12, seed: 7, duration });
    const w = sim.finishTimes[sim.order[0]];
    assert.ok(w > duration * 0.85 && w < duration * 1.1, `duration ${duration}: winner ${w}`);
  }
});

test('events are time-sorted and reference valid ducks', () => {
  const sim = createRace({ count: 12, seed: 2024 });
  for (let k = 1; k < sim.events.length; k++) assert.ok(sim.events[k].t >= sim.events[k - 1].t);
  for (const e of sim.events) assert.ok(e.duck >= -1 && e.duck < 12);
  assert.equal(sim.events.filter((e) => e.type === 'finish').length, 12);
});

test('hot dogs: capped, spaced, and absent when hazards are off', () => {
  let seen = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const sim = simulateRace({ count: 12, seed });
    const hd = sim.events.filter((e) => e.type === 'hotdog');
    assert.ok(hd.length <= TUNING.maxHotdogs);
    for (let k = 1; k < hd.length; k++) assert.ok(hd[k].t - hd[k - 1].t >= TUNING.hotdogGap - 1e-9);
    seen += hd.length;
    const clean = simulateRace({ count: 12, seed, hazards: false });
    assert.equal(clean.events.filter((e) => e.type === 'hotdog').length, 0);
  }
  assert.ok(seen > 20, 'hot dogs should actually happen');
});

test('standingsAt agrees with final order once everyone is home', () => {
  const sim = createRace({ count: 10, seed: 555 });
  const end = Math.max(...sim.finishTimes) + 1;
  const rows = standingsAt(sim, end);
  assert.deepEqual(rows.map((r) => r.i), sim.order);
  assert.equal(positionAt(sim, 0, 0), 0);
});
