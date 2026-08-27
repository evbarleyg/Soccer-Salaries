// Tilt Trial (phase-3 preview): a LIVE simulation where one duck is steered by the player and the rest are AI,
// on the same course. Not used for draft order (it is a skill mode); the seeded playback engine in race.js stays
// the fair one. Headless (no THREE): main.js renders its duck states exactly like the playback race.
import { createRng, hashString, clamp, lerp } from '../rng.js';
import { getCourse } from './course.js';

export const TRIAL = {
  v0: 23, // cruise speed (m/s), same feel as the race
  steerRate: 10, // lateral m/s at full lock
  edgeMargin: 0.9,
  padBoost: { dur: 1.4, amp: 0.38 },
  logSpin: { dur: 0.9, slow: 0.55 },
  bankBonk: { dur: 0.5, slow: 0.7 },
  aiSkill: [0.55, 0.9], // how well AI ducks line up pads / dodge logs
};

/**
 * createTrial({ names, playerIndex, seed }) → live sim with the same duck-state shape the renderer expects.
 * Obstacles (floating logs) and boost pads are laid out deterministically from the seed.
 */
export function createTrial({ names, playerIndex = 0, seed = 1, course = getCourse() }) {
  const rng = createRng(typeof seed === 'number' ? seed : hashString(String(seed)));
  const L = course.length;
  const F = course.features;
  const count = names.length;
  // --- layout: boost pads and logs between the marina exit and the harbour (none on the weir or in the air)
  const pads = [];
  const logs = [];
  for (let s = 60; s < L - 60; s += rng.range(22, 38)) {
    if (Math.abs(s - F.dropLipS) < 30) continue;
    const half = course.widthAt(s) / 2 - 1.6;
    pads.push({ s, lat: rng.range(-half, half) * 0.8, r: 1.7 });
  }
  for (let s = 95; s < L - 70; s += rng.range(16, 30)) {
    if (Math.abs(s - F.dropLipS) < 35 || (s > F.tunnelInS && s < F.tunnelInS + 20)) continue;
    const half = course.widthAt(s) / 2 - 1.4;
    logs.push({ s, lat: rng.range(-half, half), len: rng.range(2.2, 3.6), yaw: rng.range(-0.5, 0.5) });
  }
  // --- ducks
  const startHalfW = course.widthAt(0) / 2 - 2.5;
  const laneSpacing = Math.min(2.1, (2 * startHalfW) / Math.max(1, count - 1));
  const ducks = names.map((name, i) => ({
    i,
    name,
    player: i === playerIndex,
    s: F.startS - (i % 2 ? 1.2 : 0),
    lat: (i - (count - 1) / 2) * laneSpacing,
    v: 0,
    latV: 0,
    skill: lerp(TRIAL.aiSkill[0], TRIAL.aiSkill[1], rng.next()),
    cruise: TRIAL.v0 * (i === playerIndex ? 1.0 : 0.955 + (rng.next() - 0.5) * 0.05),
    wanderPh: rng.range(0, 6.28),
    boostUntil: 0,
    spinUntil: 0,
    bonkUntil: 0,
    finishTime: null,
    padsHit: 0,
    logsHit: 0,
    // renderer-facing state (same shape as the playback race's duck states)
    state: { i, pos: null, win: {}, held: null, v0: TRIAL.v0 },
  }));
  const race = {
    // race-shaped summary object for the HUD/results code
    trial: true,
    count,
    v0: TRIAL.v0,
    trackLength: L,
    finishTimes: new Array(count).fill(null),
    order: [],
    events: [],
    stats: names.map(() => ({ hitsTaken: 0, timeLed: 0, itemsUsed: 0 })),
    photoFinish: false,
    close: false,
    margin: 0,
    leadChanges: 0,
    itemsOn: false,
    hotdogs: false,
    projectiles: [],
    windows: names.map(() => []),
  };
  let t = 0;
  let leader = -1;
  const events = []; // drained by main each frame
  const standings = [];
  const path = []; // player's [t, s, lat] samples at ~10 Hz (ghost replays)
  let nextSample = 0;

  function step(dt, steer) {
    t += dt;
    for (const d of ducks) {
      if (d.finishTime !== null) { d.s = Math.min(d.s + d.v * dt, L + 12); d.v = lerp(d.v, 6, dt * 2); continue; }
      const half = course.widthAt(d.s) / 2 - TRIAL.edgeMargin;
      // --- speed
      let target = d.cruise;
      if (t < d.boostUntil) target *= 1 + TRIAL.padBoost.amp;
      if (t < d.spinUntil) target *= TRIAL.logSpin.slow;
      if (t < d.bonkUntil) target *= TRIAL.bankBonk.slow;
      const sec = course.sectionIdAt(d.s);
      if (sec === 'tunnel') target *= 1.05;
      if (sec === 'rapids') target *= 0.97 + 0.06 * Math.sin(t * 3 + d.i);
      // light rubber band toward the player so the field stays raceable (skill mode, not the fair engine)
      const player = ducks[playerIndex];
      if (!d.player && player) target *= 1 + clamp((player.s - d.s) / L, -0.2, 0.2) * 0.6;
      d.v = t < 0 ? 0 : lerp(d.v, target, dt * (d.v < target ? 1.6 : 3));
      // --- steering
      let want;
      if (d.player) want = steer;
      else {
        // AI: wander, line up the next pad, dodge the next log
        let aim = Math.sin(t * 0.5 + d.wanderPh) * half * 0.45;
        const pad = pads.find((p) => p.s > d.s && p.s < d.s + 40);
        if (pad && d.skill > 0.6) aim = lerp(aim, pad.lat, d.skill);
        const log = logs.find((o) => o.s > d.s && o.s < d.s + 25);
        if (log && Math.abs(log.lat - d.lat) < log.len * 0.6 + 0.8) aim = d.lat + (d.lat > log.lat ? 1 : -1) * (2.5 + d.skill * 2);
        want = clamp((aim - d.lat) * 0.35, -1, 1) * d.skill;
      }
      d.latV = lerp(d.latV, want * TRIAL.steerRate, dt * 5);
      const airborne = course.hopAt(d.s) > 0.02;
      if (!airborne) d.lat += d.latV * dt;
      if (Math.abs(d.lat) > half) {
        d.lat = Math.sign(d.lat) * half;
        if (t > d.bonkUntil + 0.3 && Math.abs(d.latV) > 3) {
          d.bonkUntil = t + TRIAL.bankBonk.dur;
          d.latV *= -0.4;
          events.push({ t, type: 'stumble', duck: d.i, what: 'bank' });
        }
      }
      // --- advance
      const prevS = d.s;
      d.s += d.v * dt;
      // pads and logs
      if (!airborne) {
        for (const p of pads) {
          if (p.s > prevS && p.s <= d.s && Math.abs(d.lat - p.lat) < p.r) {
            d.boostUntil = t + TRIAL.padBoost.dur;
            d.padsHit++;
            events.push({ t, type: 'use', duck: d.i, item: 'bread', target: -1 });
          }
        }
        for (const o of logs) {
          if (o.s > prevS && o.s <= d.s && Math.abs(d.lat - o.lat) < o.len * 0.5 + 0.35 && t > d.spinUntil) {
            d.spinUntil = t + TRIAL.logSpin.dur;
            d.logsHit++;
            race.stats[d.i].hitsTaken++;
            events.push({ t, type: 'stumble', duck: d.i, what: 'log' });
          }
        }
      }
      if (prevS < F.dropLipS && d.s >= F.dropLipS) events.push({ t, type: 'takeoff', duck: d.i });
      if (prevS < F.dropLandS && d.s >= F.dropLandS) events.push({ t, type: 'splashdown', duck: d.i });
      if (prevS < L && d.s >= L) {
        d.finishTime = t - (d.s - L) / Math.max(1e-3, d.v);
        race.finishTimes[d.i] = d.finishTime;
        race.order.push(d.i);
        events.push({ t: d.finishTime, type: 'finish', duck: d.i, place: race.order.length });
        if (race.order.length === 2) { race.margin = race.finishTimes[race.order[1]] - race.finishTimes[race.order[0]]; race.close = race.margin < 0.35; race.photoFinish = race.margin < 0.08; }
      }
    }
    // ghost recording
    const pl = ducks[playerIndex];
    if (pl && t >= nextSample && pl.finishTime === null) { path.push(+t.toFixed(2), +pl.s.toFixed(2), +pl.lat.toFixed(2)); nextSample = t + 0.1; }
    // standings + lead changes
    standings.length = 0;
    for (const d of ducks) standings.push({ i: d.i, s: d.finishTime !== null ? L + 1e3 - d.finishTime : d.s });
    standings.sort((a, b) => b.s - a.s || a.i - b.i);
    const newLeader = standings[0].i;
    if (t > 1 && newLeader !== leader) {
      if (leader >= 0) { race.leadChanges++; events.push({ t, type: 'lead', duck: newLeader, from: leader }); }
      leader = newLeader;
    }
    if (leader >= 0) race.stats[leader].timeLed += dt;
    // publish renderer-facing states
    standings.forEach((row, k) => { ducks[row.i].state.rank = k; });
    for (const d of ducks) {
      const st = d.state;
      st.t = t;
      st.s = d.s;
      st.lat = d.lat;
      st.v = d.v;
      st.hop = course.hopAt(d.s);
      st.airborne = st.hop > 0.02;
      st.finished = d.finishTime !== null;
      st.section = course.sectionIdAt(d.s);
      const w = st.win;
      w.boost = t < d.boostUntil ? { kind: 'boost', t0: d.boostUntil - TRIAL.padBoost.dur, t1: d.boostUntil } : null;
      w.spin = t < d.spinUntil ? { kind: 'spin', t0: d.spinUntil - TRIAL.logSpin.dur, t1: d.spinUntil } : null;
      w.stumble = t < d.bonkUntil ? { kind: 'stumble', t0: d.bonkUntil - TRIAL.bankBonk.dur, t1: d.bonkUntil, what: 'bank' } : null;
      w.burst = w.shield = w.star = w.mud = w.wobble = w.splash = null;
      st.boosting = !!w.boost;
      st.star = false;
      st.spinning = !!w.spin;
      st.held = null;
    }
  }

  return {
    race,
    pads,
    logs,
    ducks,
    standings,
    path,
    get t() { return t; },
    get leader() { return Math.max(0, leader); },
    get done() { return race.order.length === count; },
    playerIndex,
    step,
    drain() { const out = events.splice(0, events.length); race.events.push(...out); return out; },
  };
}

/** Sample a recorded ghost path ([t, s, lat, t, s, lat, ...]) at time t → { s, lat } or null past its end. */
export function ghostAt(path, t) {
  const n = path.length / 3;
  if (n < 2 || t > path[(n - 1) * 3]) return null;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (path[mid * 3] <= t) lo = mid;
    else hi = mid;
  }
  const t0 = path[lo * 3];
  const t1 = path[hi * 3];
  const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
  return { s: path[lo * 3 + 1] + (path[hi * 3 + 1] - path[lo * 3 + 1]) * f, lat: path[lo * 3 + 2] + (path[hi * 3 + 2] - path[lo * 3 + 2]) * f };
}

/** The shared "course of the day" seed for trials (same arrows/logs for everyone today). */
export function dailyTrialSeed(date = new Date()) {
  return `trial-${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
