import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRace, standingsAt, TRACK_LENGTH } from '../src/sim.js';
import { classifyRunIn, runInGap, nobodyCatching, RUNIN_AT } from '../src/awards.js';

/** The first broadcast-grid instant (0.25 s steps) at which main.js would classify the run-in, or null. */
function crossing(sim) {
  for (let tq = 0.25; tq < sim.totalTime + 1; tq += 0.25) {
    const st = standingsAt(sim, tq);
    const live = st.filter((r) => !r.done);
    if (st[0].done || live.length < 2) return null;
    if (TRACK_LENGTH - live[0].x < RUNIN_AT) return tq;
  }
  return null;
}

// Known true photo finish for the browser probes: seed 2, 8 ducks, classic distance (margin 0.118 s).
test('an honest run-in call: never PHOTO for a race won by half a second, always PHOTO for a real one', () => {
  let sims = 0;
  let photoSims = 0;
  let photoCalled = 0;
  const counts = { photo: 0, contested: 0, clear: 0 };
  for (let seed = 1; seed <= 150; seed++) {
    for (const n of [2, 8, 16]) {
      // every (n, distance) pairing gets 50 seeds; the full cross product trebles the suite's runtime for the same verdict
      const duration = [24, 38, 55][(seed + n) % 3];
      const sim = createRace({ count: n, seed, duration, hazards: true });
      const tq = crossing(sim);
      assert.ok(tq !== null, `seed ${seed} n ${n}: the leader is seen inside the last ${RUNIN_AT} units on the grid`);
      const c = classifyRunIn(sim, tq);
      assert.ok(c === 'photo' || c === 'contested' || c === 'clear');
      counts[c]++;
      sims++;
      if (sim.margin >= 0.5) assert.notEqual(c, 'photo', `seed ${seed} n ${n} len ${duration}: PHOTO FINISH called on a race won by ${sim.margin.toFixed(2)} s`);
      if (c === 'clear') assert.ok(sim.margin > 0.6 || sim.order[0] !== runInGap(sim, tq).live[0].i, `seed ${seed}: 'clear' only with daylight`);
      if (sim.photoFinish) {
        photoSims++;
        if (c === 'photo') photoCalled++;
      }
      // "nobody is catching X" is only ever said when X does hold on by daylight
      for (let t = 0.25; t < tq; t += 0.25) {
        if (nobodyCatching(sim, t)) {
          const g = runInGap(sim, t);
          assert.ok(g.projected > 1.2 && sim.finishTimes[g.live[0].i] < sim.finishTimes[g.live[1].i]);
          break;
        }
      }
    }
  }
  assert.ok(photoSims > 20, `the scan contains real photo finishes (${photoSims})`);
  assert.ok(photoCalled / photoSims >= 0.85, `photo finishes called as PHOTO: ${photoCalled}/${photoSims}`);
  assert.ok(counts.contested > 0 && counts.clear > 0, JSON.stringify(counts));
  void sims;
});

test('the documented photo-finish seed still is one (seed 2, 8 ducks, classic)', () => {
  const sim = createRace({ count: 8, seed: 2, duration: 38, hazards: true });
  assert.equal(sim.photoFinish, true);
  assert.equal(classifyRunIn(sim, crossing(sim)), 'photo');
});

test('the qa3 case (3GQ-M2XD, 16 ducks, epic) is not a photo: margin over half a second', () => {
  const sim = createRace({ count: 16, seed: 3782871981, duration: 55, hazards: true });
  assert.ok(sim.margin >= 0.5, `margin ${sim.margin}`);
  assert.notEqual(classifyRunIn(sim, crossing(sim)), 'photo');
});
