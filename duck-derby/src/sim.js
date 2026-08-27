// Deterministic duck race simulation.
//
// The whole race is computed up-front from (count, seed, duration) at a fixed
// 60 Hz timestep, so playback is just interpolation and any race can be
// replayed exactly from its seed. Every duck's parameters are drawn i.i.d.
// from the same distributions, so each entrant has an identical chance of
// winning regardless of name or lane (see test/fairness.test.js).

import { createRng, hashString, clamp, smoothstep } from './rng.js';

export const TRACK_LENGTH = 1000; // abstract units (rendered as a 100 m course)
export const SIM_HZ = 60;
export const DT = 1 / SIM_HZ;

const DEFAULTS = {
  duration: 38, // target seconds for an average duck; the winner is a bit quicker
  candidates: 6, // drama curation: number of sub-seeds auditioned
};

/** Engine tuning knobs (fractions of base speed v0 unless noted). */
export const TUNING = {
  cruiseSd: 0.025, // systematic ability spread
  shortAmp: [0.02, 0.05], // quick rhythm waves
  longAmp: [0.06, 0.11], // slow storyline wave
  longPeriod: [14, 26], // seconds
  noise: 0.04, // OU jitter
  band: 0.45, // rubber-band gain (speed fraction per track-fraction of deficit)
  hotdogRate: 0.06, // crowd hazard: chance per second that a hot dog is lobbed at the leader
  maxHotdogs: 2,
  hotdogGap: 9, // min seconds between hot dogs
};

/**
 * Run one raw simulation.
 * @param {{count:number, seed:number, duration?:number}} opts
 */
export function simulateRace({ count, seed, duration = DEFAULTS.duration, hazards = true }) {
  if (!Number.isInteger(count) || count < 1) throw new Error('count must be a positive integer');
  const rng = createRng(seed);
  const L = TRACK_LENGTH;
  const v0 = L / duration;

  // ---- per-duck parameters (i.i.d.) ----
  const ducks = [];
  for (let i = 0; i < count; i++) {
    // two quick rhythm waves + one slow "storyline" wave (strong start / late fade etc.)
    const waves = [];
    for (let k = 0; k < 2; k++) {
      waves.push({
        amp: rng.range(TUNING.shortAmp[0], TUNING.shortAmp[1]) * v0,
        period: rng.range(3.5, 9),
        phase: rng.range(0, Math.PI * 2),
      });
    }
    waves.push({
      amp: rng.range(TUNING.longAmp[0], TUNING.longAmp[1]) * v0,
      period: rng.range(TUNING.longPeriod[0], TUNING.longPeriod[1]),
      phase: rng.range(0, Math.PI * 2),
    });
    ducks.push({
      cruise: v0 * (1 + rng.normal(0, TUNING.cruiseSd)),
      waves,
      reaction: rng.range(0.05, 0.4),
      kick: rng.range(0, 0.13) * v0,
      kickStart: rng.range(0.78, 0.88),
      burstRate: rng.range(0.08, 0.14), // per second
      stumbleRate: rng.range(0.04, 0.08),
      noise: 0,
      burst: null,
      stumble: null,
      x: 0,
      v: 0,
      finishTime: null,
      timeLed: 0,
      maxSpeed: 0,
    });
  }

  const maxTicks = Math.ceil(duration * 3 * SIM_HZ);
  const cap = maxTicks + 2;
  const pos = ducks.map(() => new Float32Array(cap));
  const vel = ducks.map(() => new Float32Array(cap));
  const events = [];

  let t = 0;
  let tick = 0;
  let finished = 0;
  let leader = -1;
  let leadChanges = 0;
  let halfwayCalled = false;
  let stretchCalled = false;
  let hotdogs = 0;
  let lastHotdog = -Infinity;

  // tick 0 sample: everyone on the line
  for (let i = 0; i < count; i++) {
    pos[i][0] = 0;
    vel[i][0] = 0;
  }

  while (finished < count && tick < maxTicks) {
    // pack statistics
    let maxX = 0;
    let sumX = 0;
    for (const d of ducks) {
      if (d.x > maxX) maxX = d.x;
      sumX += d.x;
    }
    const meanX = sumX / count;
    const leaderProgress = maxX / L;
    const bandFade = 1 - smoothstep(0.6, 0.86, leaderProgress); // rubber band relaxes for the run-in

    // crowd hazard: someone in the stands lobs a hot dog at whoever is leading.
    // Symmetric (targets the leader, whoever that is) so the race stays fair.
    if (
      hazards &&
      hotdogs < TUNING.maxHotdogs &&
      leader >= 0 &&
      t > 7 &&
      t - lastHotdog > TUNING.hotdogGap &&
      leaderProgress > 0.22 &&
      leaderProgress < 0.86 &&
      rng.chance(TUNING.hotdogRate * DT)
    ) {
      const target = leader;
      const d = ducks[target];
      if (d.finishTime === null) {
        d.burst = null;
        d.stumble = { t0: t, dur: 1.7, amp: 1.1 * v0, hotdog: true };
        events.push({ t, duck: target, type: 'hotdog' });
        hotdogs++;
        lastHotdog = t;
      }
    }

    for (let i = 0; i < count; i++) {
      const d = ducks[i];
      if (d.finishTime !== null) {
        d.v = d.v * 0.92; // coast after the line (visual only)
        continue;
      }
      const prog = d.x / L;

      // rhythmic form
      let form = 0;
      for (const w of d.waves) form += w.amp * Math.sin((2 * Math.PI * t) / w.period + w.phase);

      // Ornstein-Uhlenbeck jitter
      const tau = 0.7;
      const sigma = TUNING.noise * v0;
      d.noise += (-d.noise / tau) * DT + sigma * Math.sqrt((2 * DT) / tau) * rng.normal();

      // bursts of effort
      let boost = 0;
      if (d.burst) {
        const e = (t - d.burst.t0) / d.burst.dur;
        if (e >= 1) d.burst = null;
        else boost = d.burst.amp * burstShape(e);
      } else if (t > 1.5 && rng.chance(d.burstRate * DT * (prog > 0.9 ? 0.4 : 1))) {
        d.burst = { t0: t, dur: rng.range(1.0, 1.7), amp: rng.range(0.26, 0.46) * v0 };
        events.push({ t, duck: i, type: 'burst' });
      }

      // stumbles (distracted by bread, hit a lily pad...)
      let drag = 0;
      if (d.stumble) {
        const e = (t - d.stumble.t0) / d.stumble.dur;
        if (e >= 1) d.stumble = null;
        else drag = d.stumble.amp * Math.sin(Math.PI * e);
      } else if (!d.burst && t > 2.5 && prog < 0.97 && rng.chance(d.stumbleRate * DT)) {
        d.stumble = { t0: t, dur: rng.range(0.7, 1.1), amp: rng.range(0.3, 0.5) * v0 };
        events.push({ t, duck: i, type: 'stumble' });
      }

      // rubber banding keeps the pack honest until the final stretch
      const rb = clamp(TUNING.band * ((meanX - d.x) / L), -0.15, 0.19) * v0 * bandFade;

      // finishing kick
      const kick = d.kick * smoothstep(d.kickStart, d.kickStart + 0.1, prog);

      // start: reaction time then acceleration
      const launch = smoothstep(d.reaction, d.reaction + 1.3, t);

      let v = (d.cruise + form + d.noise + boost - drag + rb + kick) * launch;
      v = Math.max(v, 0.22 * v0 * launch);
      d.v = v;
      if (v > d.maxSpeed) d.maxSpeed = v;

      const prevX = d.x;
      d.x += v * DT;
      if (d.x >= L) {
        const frac = (L - prevX) / (d.x - prevX);
        d.finishTime = t + DT * frac;
        d.x = L;
        finished++;
        events.push({ t: d.finishTime, duck: i, type: 'finish' });
      }
    }

    t += DT;
    tick++;

    // leader bookkeeping (with a little hysteresis so photo-close swaps don't spam)
    let curLeader = leader;
    let bestX = leader >= 0 ? ducks[leader].x : -1;
    for (let i = 0; i < count; i++) {
      if (i === leader) continue;
      if (ducks[i].x > bestX + (leader >= 0 ? 0.004 * L : 0)) {
        bestX = ducks[i].x;
        curLeader = i;
      }
    }
    if (curLeader !== leader) {
      if (leader !== -1 && t > 3 && ducks[curLeader].finishTime === null) {
        leadChanges++;
        events.push({ t, duck: curLeader, type: 'lead', from: leader });
      }
      leader = curLeader;
    }
    if (leader >= 0 && ducks[leader].finishTime === null) ducks[leader].timeLed += DT;

    if (!halfwayCalled && maxX >= L * 0.5) {
      halfwayCalled = true;
      events.push({ t, duck: leader, type: 'halfway' });
    }
    if (!stretchCalled && maxX >= L * 0.8) {
      stretchCalled = true;
      events.push({ t, duck: leader, type: 'stretch' });
    }

    for (let i = 0; i < count; i++) {
      pos[i][tick] = ducks[i].x;
      vel[i][tick] = ducks[i].v;
    }
  }

  // Safety net: anyone still out there gets a finish time in current order.
  if (finished < count) {
    const stragglers = ducks
      .map((d, i) => ({ d, i }))
      .filter((e) => e.d.finishTime === null)
      .sort((a, b) => b.d.x - a.d.x || a.i - b.i);
    let ft = t;
    for (const { d, i } of stragglers) {
      ft += 0.25;
      d.finishTime = ft;
      d.x = L;
      events.push({ t: ft, duck: i, type: 'finish', forced: true });
    }
  }

  const ticks = tick;
  const finishTimes = ducks.map((d) => d.finishTime);
  const order = ducks
    .map((d, i) => i)
    .sort((a, b) => finishTimes[a] - finishTimes[b] || a - b);
  const margin = finishTimes[order[1]] !== undefined ? finishTimes[order[1]] - finishTimes[order[0]] : Infinity;

  events.sort((a, b) => a.t - b.t);

  return {
    seed,
    count,
    duration,
    hazards,
    hotdogs,
    trackLength: L,
    dt: DT,
    ticks,
    totalTime: t,
    pos: pos.map((p) => p.subarray(0, ticks + 1)),
    vel: vel.map((p) => p.subarray(0, ticks + 1)),
    finishTimes,
    order,
    margin,
    photoFinish: margin < 0.18,
    leadChanges,
    events,
    stats: ducks.map((d) => ({ timeLed: d.timeLed, maxSpeed: d.maxSpeed, reaction: d.reaction })),
  };
}

function burstShape(e) {
  // fast attack, smooth release
  if (e < 0.18) return smoothstep(0, 0.18, e);
  return 1 - smoothstep(0.18, 1, e);
}

/**
 * Score a simulation for entertainment value. Symmetric across ducks, so
 * picking the most dramatic of several candidate seeds keeps the race fair.
 */
export function dramaScore(sim) {
  const ft = sim.order.map((i) => sim.finishTimes[i]);
  const winnerT = ft[0];
  let score = Math.min(sim.leadChanges, 7) * 1.0;
  if (sim.margin < 0.18) score += 1.5;
  else if (sim.margin < 0.6) score += 1.0;
  else if (sim.margin > 2.0) score -= 1;
  const top3 = ft[Math.min(2, ft.length - 1)] - winnerT;
  if (top3 < 1.6) score += 1;
  const lastGap = ft[ft.length - 1] - winnerT;
  if (lastGap > sim.duration * 0.28) score -= 2; // nobody wants to wait for a straggler
  // late drama: lead changes in the final 30%
  const late = sim.events.filter((e) => e.type === 'lead' && e.t > winnerT * 0.7).length;
  score += Math.min(late, 3) * 1.3;
  return score;
}

/**
 * Build the race for a roster: auditions a fixed number of sub-seeds derived
 * from the master seed and keeps the most dramatic. Fully deterministic.
 * @param {{count:number, seed:number, duration?:number, candidates?:number}} opts
 */
export function createRace({ count, seed, duration = DEFAULTS.duration, candidates = DEFAULTS.candidates, hazards = true }) {
  let best = null;
  let bestScore = -Infinity;
  for (let k = 0; k < Math.max(1, candidates); k++) {
    const subSeed = k === 0 ? seed >>> 0 : hashString(`${seed >>> 0}:take${k}`);
    const sim = simulateRace({ count, seed: subSeed, duration, hazards });
    const s = dramaScore(sim);
    if (s > bestScore) {
      bestScore = s;
      best = sim;
      best.variant = k;
      best.masterSeed = seed >>> 0;
      best.drama = s;
    }
  }
  return best;
}

/** Interpolated position of duck i at race time t (seconds). */
export function positionAt(sim, i, t) {
  const arr = sim.pos[i];
  const f = clamp(t / sim.dt, 0, arr.length - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(i0 + 1, arr.length - 1);
  const a = f - i0;
  return arr[i0] + (arr[i1] - arr[i0]) * a;
}

/** Interpolated speed of duck i at race time t. */
export function speedAt(sim, i, t) {
  const arr = sim.vel[i];
  const f = clamp(t / sim.dt, 0, arr.length - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(i0 + 1, arr.length - 1);
  const a = f - i0;
  return arr[i0] + (arr[i1] - arr[i0]) * a;
}

/** Current running order at time t: array of duck indices, leader first. */
export function standingsAt(sim, t) {
  const n = sim.count;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const ft = sim.finishTimes[i];
    const done = ft !== null && t >= ft;
    rows.push({ i, x: done ? sim.trackLength : positionAt(sim, i, t), done, ft });
  }
  rows.sort((a, b) => {
    if (a.done && b.done) return a.ft - b.ft;
    if (a.done !== b.done) return a.done ? -1 : 1;
    return b.x - a.x || a.i - b.i;
  });
  return rows;
}
