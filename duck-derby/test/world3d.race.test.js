import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateRace, createRace, standingsAt, positionAt, lateralAt, heldAt, activeWindows, dramaScore, TUNING, DEFAULTS, ENGINE_VERSION } from '../src/world3d/race.js';
import { getCourse } from '../src/world3d/course.js';

const course = getCourse();

// Expected outcomes per engine version (order | finish times) for a few fixed seeds.
const GOLDEN = {
  2: {
      "1": "6,4,7,1,9,2,8,0,5,3|40.873,40.041,40.178,41.347,38.990,40.949,38.959,39.272,40.868,40.077",
      "777": "6,0,7,8,1,9,3,4,2,5|38.355,39.896,41.184,40.101,40.498,41.256,38.107,38.610,39.438,39.952",
      "123456789": "1,6,4,9,8,3,2,7,0,5|41.381,38.659,40.716,39.732,38.963,41.893,38.949,40.806,39.623,39.362"
  },
};

test('same seed => identical race (positions, events, items, projectiles)', () => {
  const a = createRace({ count: 12, seed: 123456 });
  const b = createRace({ count: 12, seed: 123456 });
  assert.deepEqual(a.order, b.order);
  assert.deepEqual(a.finishTimes, b.finishTimes);
  assert.equal(a.variant, b.variant);
  assert.deepEqual(a.events, b.events);
  assert.equal(a.projectiles.length, b.projectiles.length);
  for (let k = 0; k < a.projectiles.length; k++) assert.deepEqual(Array.from(a.projectiles[k].path), Array.from(b.projectiles[k].path));
  for (let i = 0; i < 12; i++) assert.deepEqual(Array.from(a.held[i]), Array.from(b.held[i]));
});

test('different seeds => different races', () => {
  const a = createRace({ count: 10, seed: 1 });
  const b = createRace({ count: 10, seed: 2 });
  assert.notDeepEqual(a.finishTimes, b.finishTimes);
});

test('everyone finishes; order is a permutation sorted by finish time; no forced finishes', () => {
  for (const count of [2, 3, 8, 10, 12, 16]) {
    const sim = createRace({ count, seed: 99 + count });
    assert.equal(sim.order.length, count);
    assert.deepEqual([...sim.order].sort((x, y) => x - y), [...Array(count).keys()]);
    for (let k = 1; k < count; k++) assert.ok(sim.finishTimes[sim.order[k]] >= sim.finishTimes[sim.order[k - 1]]);
    assert.ok(sim.finishTimes.every((t) => Number.isFinite(t) && t > 0));
    assert.ok(!sim.events.some((e) => e.forced), `forced finish with ${count} ducks`);
    assert.equal(sim.events.filter((e) => e.type === 'finish').length, count);
  }
});

test('a single duck can race alone', () => {
  const sim = createRace({ count: 1, seed: 5 });
  assert.equal(sim.order.length, 1);
  assert.ok(sim.finishTimes[0] > 30 && sim.finishTimes[0] < 50);
});

test('positions monotonic & finite, lateral stays inside the channel, everyone takes The Drop', () => {
  const sim = simulateRace({ count: 16, seed: 42 });
  for (let i = 0; i < sim.count; i++) {
    const p = sim.pos[i];
    for (let k = 1; k < p.length; k++) {
      assert.ok(Number.isFinite(p[k]));
      assert.ok(p[k] >= p[k - 1] - 1e-6, `duck ${i} went backwards at tick ${k}`);
      const halfW = course.widthAt(p[k]) / 2;
      assert.ok(Math.abs(sim.lat[i][k]) <= halfW - 0.5, `duck ${i} left the channel at tick ${k}: ${sim.lat[i][k]} vs ${halfW}`);
    }
    assert.ok(p[p.length - 1] >= sim.trackLength - 1e-3);
  }
  assert.equal(sim.events.filter((e) => e.type === 'takeoff').length, 16);
  assert.equal(sim.events.filter((e) => e.type === 'splashdown').length, 16);
  for (const e of sim.events.filter((x) => x.type === 'takeoff')) {
    const s = positionAt(sim, e.duck, e.t);
    assert.ok(Math.abs(s - course.features.dropLipS) < 12, `takeoff at s=${s}`);
  }
});

test('winner time lands near the configured duration', () => {
  for (const duration of [30, 40, 55]) {
    const sim = createRace({ count: 12, seed: 7, duration });
    const w = sim.finishTimes[sim.order[0]];
    assert.ok(w > duration * 0.85 && w < duration * 1.1, `duration ${duration}: winner ${w}`);
  }
  assert.equal(DEFAULTS.duration, 40);
});

test('events are time-sorted and reference valid ducks', () => {
  const sim = createRace({ count: 12, seed: 2024 });
  for (let k = 1; k < sim.events.length; k++) assert.ok(sim.events[k].t >= sim.events[k - 1].t);
  for (const e of sim.events) if (e.duck !== undefined) assert.ok(e.duck >= -1 && e.duck < 12, JSON.stringify(e));
});

test('hot dogs: hit the leader, capped, spaced, never in the tunnel, absent when hazards are off', () => {
  let seen = 0;
  const F = course.features;
  for (let seed = 1; seed <= 60; seed++) {
    const sim = simulateRace({ count: 12, seed });
    const hd = sim.events.filter((e) => e.type === 'hotdog');
    assert.ok(hd.length <= TUNING.maxHotdogs);
    for (let k = 1; k < hd.length; k++) assert.ok(hd[k].t - hd[k - 1].t >= TUNING.hotdogGap - 1e-9);
    for (const e of hd) {
      const rows = standingsAt(sim, e.t - sim.dt);
      const s = positionAt(sim, e.duck, e.t - sim.dt);
      assert.ok(rows[0].i === e.duck || rows[0].x - s < 0.006 * sim.trackLength, 'hot dog must target the leader (within lead-change hysteresis)');
      assert.ok(!(s > F.tunnelInS - 20 && s < F.tunnelOutS + 5), 'no hot dogs inside the tunnel');
    }
    seen += hd.length;
    const clean = simulateRace({ count: 12, seed, hazards: false });
    assert.equal(clean.events.filter((e) => e.type === 'hotdog').length, 0);
  }
  assert.ok(seen > 20, `hot dogs should actually happen (saw ${seen})`);
});

test('items: pickups only at boxes, uses follow pickups, held[] agrees, none when items are off', () => {
  const F = course.features;
  for (let seed = 11; seed <= 40; seed++) {
    const sim = simulateRace({ count: 12, seed });
    const holding = new Map();
    for (const e of sim.events) {
      if (e.type === 'pickup') {
        const s = positionAt(sim, e.duck, e.t);
        assert.ok(F.itemBoxes.some((b) => Math.abs(s - b) < 3), `pickup away from a box at s=${s}`);
        assert.ok(!holding.get(e.duck), 'cannot pick up while holding');
        holding.set(e.duck, e.item);
        const h = heldAt(sim, e.duck, e.t + sim.dt * 1.01);
        if (e.item !== 'shield' || h) assert.equal(h && h.item, e.item === 'shield' ? (h ? 'shield' : null) : e.item);
      } else if (e.type === 'use') {
        assert.equal(holding.get(e.duck), e.item, `use without holding: ${JSON.stringify(e)}`);
        if (!(e.item === 'triple' && e.chargesLeft > 0)) holding.set(e.duck, null);
      } else if (e.type === 'expire' || (e.type === 'blocked' && e.reason === 'shield')) {
        if (holding.get(e.duck) === 'shield') holding.set(e.duck, null);
      }
      if (e.type === 'use' && e.item === 'seagull') assert.ok(e.rank >= Math.ceil((2 * 12) / 3) - 4, 'seagull comes from the back');
    }
    for (const p of sim.projectiles) {
      assert.ok(p.t1 !== null && p.t1 >= p.t0);
      assert.ok(['hit', 'blocked', 'fizzle'].includes(p.result));
      assert.equal(p.path.length % 2, 0);
    }
    const off = simulateRace({ count: 12, seed, items: false });
    assert.equal(off.events.filter((e) => ['pickup', 'use', 'hit'].includes(e.type) && e.item !== 'hotdog').length, 0);
  }
});

test('seagull never rolls once the leader is past 90%; feather only for the back of the pack', () => {
  for (let seed = 100; seed < 160; seed++) {
    const sim = simulateRace({ count: 12, seed });
    for (const e of sim.events) {
      if (e.type !== 'pickup') continue;
      const leaderS = Math.max(...sim.pos.map((p, i) => positionAt(sim, i, e.t)));
      if (e.item === 'seagull') {
        assert.ok(leaderS / sim.trackLength < 0.9 + 1e-6);
        assert.ok(e.rank >= Math.ceil((2 * 12) / 3));
      }
      if (e.item === 'feather') assert.ok(e.rank / 11 > 0.6);
      if (e.item === 'hornet' || e.item === 'mud') assert.ok(e.rank > 0, 'leader never rolls hornet/mud');
    }
  }
});

test('items produce a few meaningful swings per race, not chaos', () => {
  let hits = 0;
  let front = 0;
  let late = 0;
  const N = 60;
  for (let seed = 1; seed <= N; seed++) {
    const sim = createRace({ count: 12, seed: seed * 31 });
    const h = sim.events.filter((e) => e.type === 'hit');
    hits += h.length;
    front += h.filter((e) => e.rank <= 2).length;
    late += h.filter((e) => positionAt(sim, e.duck, e.t) > sim.trackLength * 0.93).length;
  }
  assert.ok(hits / N >= 2 && hits / N <= 9, `hits per race ${hits / N}`);
  assert.ok(front / N >= 1 && front / N <= 5, `front-of-pack hits per race ${front / N}`);
  assert.ok(late / N < 0.6, `too much last-10% chaos: ${late / N}`);
});

test('standingsAt agrees with final order; activeWindows reports spins during hits', () => {
  const sim = createRace({ count: 10, seed: 555 });
  const end = Math.max(...sim.finishTimes) + 1;
  assert.deepEqual(standingsAt(sim, end).map((r) => r.i), sim.order);
  assert.equal(positionAt(sim, 0, 0), 0);
  assert.ok(Number.isFinite(lateralAt(sim, 0, 3)));
  const hit = sim.events.find((e) => e.type === 'hit');
  if (hit) {
    const w = activeWindows(sim, hit.duck, hit.t + 0.1);
    assert.ok(w.some((x) => x.kind === 'spin'));
  }
});

test('an unused bubble shield expires and frees the item slot', () => {
  let sawExpire = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const sim = simulateRace({ count: 12, seed: seed * 7 });
    const shieldAt = new Map();
    for (const e of sim.events) {
      if (e.type === 'pickup' && e.item === 'shield') shieldAt.set(e.duck, e.t);
      if (e.type === 'blocked' && e.reason === 'shield') shieldAt.delete(e.duck);
      if (e.type === 'expire') {
        sawExpire++;
        assert.ok(shieldAt.has(e.duck), 'expire without a held shield');
        assert.ok(e.t - shieldAt.get(e.duck) >= 7.9, 'shield expired early');
        shieldAt.delete(e.duck);
      }
      if (e.type === 'finish') shieldAt.delete(e.duck);
    }
    // nobody may still "hold" a shield more than 8.5 s after picking it up
    for (const [duck, t0] of shieldAt) {
      const end = sim.finishTimes[duck];
      assert.ok(end - t0 < 8.5, `duck ${duck} kept a dead shield from ${t0} to ${end}`);
      const h = heldAt(sim, duck, Math.min(end - 0.05, t0 + 8.4));
      assert.ok(!h || h.item !== 'shield' || end - t0 < 8.1);
    }
  }
  assert.ok(sawExpire > 5, 'shields should expire sometimes');
});

test('dramaScore is symmetric under a permutation of the ducks (curation cannot favour a lane)', () => {
  const sim = simulateRace({ count: 9, seed: 4242 });
  const perm = [3, 7, 0, 8, 1, 5, 2, 6, 4]; // new index k holds old duck perm[k]
  const inv = new Array(9);
  perm.forEach((oldI, k) => (inv[oldI] = k));
  const p = {
    ...sim,
    pos: perm.map((oldI) => sim.pos[oldI]),
    lat: perm.map((oldI) => sim.lat[oldI]),
    vel: perm.map((oldI) => sim.vel[oldI]),
    finishTimes: perm.map((oldI) => sim.finishTimes[oldI]),
    order: sim.order.map((oldI) => inv[oldI]),
    events: sim.events.map((e) => ({ ...e, duck: e.duck === undefined || e.duck < 0 ? e.duck : inv[e.duck] })),
  };
  assert.equal(dramaScore(p).toFixed(6), dramaScore(sim).toFixed(6));
});

test('golden races: tuning changes that alter shared-link outcomes must bump ENGINE_VERSION', () => {
  const golden = {};
  for (const seed of [1, 777, 123456789]) {
    const sim = createRace({ count: 10, seed });
    golden[seed] = sim.order.join(',') + '|' + sim.finishTimes.map((x) => x.toFixed(3)).join(',');
  }
  // Regenerate these strings (and bump ENGINE_VERSION in race.js) whenever the engine's behaviour changes on purpose.
  const expected = GOLDEN[ENGINE_VERSION];
  assert.ok(expected, `no golden data for ENGINE_VERSION ${ENGINE_VERSION} — add it: ${JSON.stringify(golden)}`);
  assert.deepEqual(golden, expected);
});
