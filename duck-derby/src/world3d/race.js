// Duck Derby World — deterministic race engine (headless; no Three.js).
//
// The whole race is integrated up-front at 60 Hz from (count, seed): each
// duck's distance along the course, lateral position in the channel, speed and
// held item per tick, plus timed events (bursts, stumbles, item pickups/uses,
// projectile hits, hot dogs, lead changes, takeoff/splashdown at The Drop,
// finishes). Playback just interpolates, which is what makes exact replays,
// camera cuts, jump-to-time captures and slow-motion photo finishes trivial.
//
// Fairness contract: every per-duck parameter (pace, rhythm, luck, item brain,
// lateral wander) is drawn i.i.d. from the same distributions, course features
// treat whoever reaches them identically, and hazards/items key off *race
// position* (the leader, the duck directly ahead, the back third) — never a
// name or a lane. So each entrant has the same chance of any finishing place;
// test/world3d.fairness.test.js checks that with a Monte Carlo chi-square.

import { createRng, hashString, clamp, smoothstep, lerp } from '../rng.js';
import { getCourse } from './course.js';
import { ITEM_ORDER, ITEM_TUNING as IT, rollItem, makeBrain, brainWantsToFire } from './items.js';

export const SIM_HZ = 60;
export const DT = 1 / SIM_HZ;
export const DEFAULTS = { duration: 40, candidates: 4 };
/** Bump when tuning changes race outcomes, so shared links can announce a mismatch. */
export const ENGINE_VERSION = 3;

/** Engine tuning knobs (fractions of base speed v0 unless noted). */
export const TUNING = {
  cruiseSd: 0.024, // systematic ability spread
  shortAmp: [0.02, 0.05], // quick rhythm waves
  longAmp: [0.06, 0.11], // slow storyline wave
  longPeriod: [14, 26], // seconds
  noise: 0.04, // OU jitter
  band: 0.45, // rubber-band gain (speed fraction per track-fraction of deficit)
  hotdogRate: 0.06, // chance per second that the crowd lobs a hot dog at the leader
  maxHotdogs: 2,
  hotdogGap: 9, // min seconds between hot dogs
  tunnelCurrent: 0.05, // everyone rides the flume a touch faster
  rapids: { noise: 1.6, stumble: 1.3, burst: 1.3 },
  lily: { stumble: 1.4 },
  splashSlow: { dur: 0.3, amp: 0.18 }, // brief check on splashdown (same for everyone)
};

const ITEM_CODE = Object.fromEntries(ITEM_ORDER.map((id, k) => [id, k + 1]));
export const CODE_ITEM = [null, ...ITEM_ORDER];

/**
 * Run one raw simulation.
 * @param {{count:number, seed:number, duration?:number, hazards?:boolean, items?:boolean}} opts
 */
export function simulateRace({ count, seed, duration = DEFAULTS.duration, hazards = true, items = true, course = getCourse() }) {
  if (!Number.isInteger(count) || count < 1) throw new Error('count must be a positive integer');
  const rng = createRng(seed);
  const L = course.length;
  const F = course.features;
  const v0 = L / duration;
  const boxes = items ? F.itemBoxes : [];
  const startHalfW = course.at(0).width / 2 - 1.2;

  // ---- per-duck parameters (i.i.d.) ----
  const ducks = [];
  const laneSpacing = Math.min(1.75, (2 * startHalfW) / Math.max(1, count));
  for (let i = 0; i < count; i++) {
    const waves = [];
    for (let k = 0; k < 2; k++) {
      waves.push({ amp: rng.range(TUNING.shortAmp[0], TUNING.shortAmp[1]) * v0, period: rng.range(3.5, 9), phase: rng.range(0, Math.PI * 2) });
    }
    waves.push({
      amp: rng.range(TUNING.longAmp[0], TUNING.longAmp[1]) * v0,
      period: rng.range(TUNING.longPeriod[0], TUNING.longPeriod[1]),
      phase: rng.range(0, Math.PI * 2),
    });
    const a1 = rng.range(0.35, 0.6);
    ducks.push({
      cruise: v0 * (1 + rng.normal(0, TUNING.cruiseSd)),
      waves,
      reaction: rng.range(0.05, 0.4),
      kick: rng.range(0, 0.1) * v0,
      kickStart: rng.range(0.74, 0.86),
      kicked: false,
      burstRate: rng.range(0.08, 0.14), // per second
      stumbleRate: rng.range(0.04, 0.08),
      brain: makeBrain(rng),
      // lateral wander (fractions of the usable half-width)
      laneFrac: startHalfW > 0 ? ((i - (count - 1) / 2) * laneSpacing) / startHalfW : 0,
      latA1: a1,
      latW1: rng.range(0.25, 0.55),
      latP1: rng.range(0, Math.PI * 2),
      latA2: 0.92 - a1,
      latW2: rng.range(0.7, 1.3),
      latP2: rng.range(0, Math.PI * 2),
      weaveP: rng.range(-0.6, 0.6),
      tieKey: rng.next(),
      // dynamic state
      noise: 0,
      burst: null, // {t0,dur,amp,item?}
      stumble: null, // {t0,dur,amp,cause}
      item: null,
      itemT: 0,
      charges: 0,
      lastUse: -1,
      shieldUntil: -1,
      starUntil: -1,
      mudUntil: -1,
      wobbleUntil: -1,
      splashUntil: -1,
      airborne: false,
      vAir: 0,
      s: 0,
      v: 0,
      lat: 0,
      finishTime: null,
      timeLed: 0,
      maxSpeed: 0,
      itemsUsed: 0,
      hitsTaken: 0,
    });
  }

  const maxTicks = Math.ceil(duration * 3 * SIM_HZ);
  const cap = maxTicks + 2;
  const pos = ducks.map(() => new Float32Array(cap));
  const lat = ducks.map(() => new Float32Array(cap));
  const vel = ducks.map(() => new Float32Array(cap));
  const held = ducks.map(() => new Uint8Array(cap));
  const events = [];
  const projectiles = [];
  const windows = ducks.map(() => []); // per-duck effect windows for rendering

  let t = 0;
  let tick = 0;
  let finished = 0;
  let leader = -1;
  let leadChanges = 0;
  let halfwayCalled = false;
  let stretchCalled = false;
  let hotdogs = 0;
  let lastHotdog = -Infinity;
  let projId = 0;

  const rank = new Int16Array(count);
  const orderBuf = ducks.map((_, i) => i);

  function lateralFor(d, s, time) {
    const halfW = Math.max(0.5, course.widthAt(s) / 2 - 1.2);
    const wander = d.latA1 * Math.sin(d.latW1 * time + d.latP1) + d.latA2 * Math.sin(d.latW2 * time + d.latP2);
    let f = lerp(d.laneFrac, wander, smoothstep(1.2, 7.5, time));
    if (s > F.lilyInS && s < F.dropApproachS) {
      const e = smoothstep(F.lilyInS, F.lilyInS + 18, s) * (1 - smoothstep(F.dropApproachS - 22, F.dropApproachS, s));
      f = lerp(f, 0.62 * Math.sin((2 * Math.PI * (s - F.lilyInS)) / 52 + d.weaveP), 0.7 * e);
    }
    return clamp(f, -1, 1) * halfW;
  }

  for (let i = 0; i < count; i++) {
    ducks[i].lat = lateralFor(ducks[i], 0, 0);
    pos[i][0] = 0;
    lat[i][0] = ducks[i].lat;
    vel[i][0] = 0;
    held[i][0] = 0;
  }

  const isStar = (d) => t < d.starUntil;
  const isShield = (d) => t < d.shieldUntil;

  function openWindow(i, kind, dur, extra) {
    const w = { kind, t0: t, t1: t + dur, ...extra };
    windows[i].push(w);
    return w;
  }

  /** Something nasty reaches duck i. Returns 'hit' | 'blocked' | 'immune' | 'gone'. */
  function hitDuck(i, cause, spin, by) {
    const d = ducks[i];
    if (d.finishTime !== null) return 'gone';
    if (isStar(d)) {
      events.push({ t, type: 'blocked', duck: i, item: cause, by, reason: 'feather' });
      return 'immune';
    }
    if (isShield(d) && cause !== 'seagull') {
      d.shieldUntil = -1;
      if (d.item === 'shield') d.item = null;
      for (let k = windows[i].length - 1; k >= 0; k--) {
        const w = windows[i][k];
        if (w.kind === 'shield') {
          w.t1 = t;
          w.popped = true;
          break;
        }
      }
      events.push({ t, type: 'blocked', duck: i, item: cause, by, reason: 'shield' });
      return 'blocked';
    }
    d.burst = null;
    d.stumble = { t0: t, dur: spin.dur, amp: spin.amp * v0, cause };
    d.hitsTaken++;
    events.push({ t, type: 'hit', duck: i, item: cause, by, rank: rank[i] });
    openWindow(i, 'spin', spin.dur, { cause });
    return 'hit';
  }

  function duckAhead(i) {
    const r = rank[i];
    if (r <= 0) return -1;
    return orderBuf[r - 1];
  }
  function currentLeaderUnfinished(exclude = -1) {
    for (let r = 0; r < count; r++) {
      const j = orderBuf[r];
      if (j !== exclude && ducks[j].finishTime === null) return j;
    }
    return -1;
  }

  function useItem(i) {
    const d = ducks[i];
    const item = d.item;
    d.itemsUsed++;
    const ev = { t, type: 'use', duck: i, item, rank: rank[i] };
    switch (item) {
      case 'bread':
      case 'triple': {
        d.burst = { t0: t, dur: IT.boost.dur, amp: IT.boost.amp * v0, item: true };
        openWindow(i, 'boost', IT.boost.dur, {});
        if (item === 'triple') {
          d.charges--;
          ev.chargesLeft = d.charges;
          d.lastUse = t;
          if (d.charges > 0) {
            events.push(ev);
            return; // keep holding the rest
          }
        }
        break;
      }
      case 'hornet': {
        const target = duckAhead(i);
        projectiles.push({ id: projId++, type: 'hornet', owner: i, target, t0: t, t1: null, s: d.s + 1, lat: d.lat, result: null, path: [] });
        ev.target = target;
        break;
      }
      case 'stone': {
        projectiles.push({ id: projId++, type: 'stone', owner: i, target: -1, t0: t, t1: null, s: d.s + 1.5, lat: d.lat, result: null, path: [] });
        break;
      }
      case 'mud': {
        const ahead = [];
        for (let j = 0; j < count; j++) {
          if (j === i) continue;
          const o = ducks[j];
          if (o.finishTime !== null || isStar(o)) continue;
          if (o.s > d.s && o.s - d.s < IT.mud.range) ahead.push(j);
        }
        ahead.sort((a, b) => ducks[a].s - ducks[b].s || ducks[a].tieKey - ducks[b].tieKey);
        const victims = ahead.slice(0, IT.mud.maxVictims || ahead.length);
        for (const j of victims) {
          ducks[j].mudUntil = t + IT.mud.dur;
          openWindow(j, 'mud', IT.mud.dur, { by: i });
        }
        ev.victims = victims;
        break;
      }
      case 'feather': {
        d.starUntil = t + IT.feather.dur;
        d.stumble = null;
        openWindow(i, 'star', IT.feather.dur, {});
        break;
      }
      case 'seagull': {
        projectiles.push({ id: projId++, type: 'seagull', owner: i, target: currentLeaderUnfinished(i), t0: t, t1: null, s: d.s, lat: d.lat, phase: 'fly', diveT: 0, result: null, path: [] });
        break;
      }
      default:
        break;
    }
    events.push(ev);
    d.item = null;
    d.charges = 0;
  }

  // =====================================================================
  while (finished < count && tick < maxTicks) {
    // ---- A. standings at the start of the tick ----
    orderBuf.sort((a, b) => ducks[b].s - ducks[a].s || ducks[a].tieKey - ducks[b].tieKey);
    for (let r = 0; r < count; r++) rank[orderBuf[r]] = r;
    let maxS = 0;
    let sumS = 0;
    for (const d of ducks) {
      if (d.s > maxS) maxS = d.s;
      sumS += d.s;
    }
    const meanS = sumS / count;
    const leaderProg = maxS / L;
    const bandFade = 1 - smoothstep(0.5, 0.82, leaderProg); // rubber band relaxes for the run-in

    // ---- B. crowd hazard: a hot dog lobbed at whoever leads ----
    if (
      hazards &&
      hotdogs < TUNING.maxHotdogs &&
      leader >= 0 &&
      t > 7 &&
      t - lastHotdog > TUNING.hotdogGap &&
      leaderProg > 0.16 &&
      leaderProg < 0.66 &&
      !ducks[leader].airborne &&
      !(ducks[leader].s > F.tunnelInS - 25 && ducks[leader].s < F.tunnelOutS + 10) && // nobody can throw into the tunnel
      rng.chance(TUNING.hotdogRate * DT)
    ) {
      const res = hitDuck(leader, 'hotdog', IT.hotdog.spin, -1);
      if (res !== 'gone') {
        events.push({ t, type: 'hotdog', duck: leader, result: res });
        hotdogs++;
        lastHotdog = t;
      }
    }

    // ---- C. item boxes ----
    if (boxes.length) {
      for (let i = 0; i < count; i++) {
        const d = ducks[i];
        if (d.finishTime !== null) continue;
        // an unused shield quietly expires (frees the slot for the next box)
        if (d.item === 'shield' && !isShield(d)) {
          d.item = null;
          events.push({ t, type: 'expire', duck: i, item: 'shield' });
        }
        if (d.item !== null) continue;
        const prevS = tick > 0 ? pos[i][tick - 1] : 0;
        for (const bs of boxes) {
          if (prevS < bs && d.s >= bs) {
            if (!rng.chance(IT.pickupChance)) break;
            const item = rollItem(rng, rank[i], count, leaderProg);
            d.item = item;
            d.itemT = t;
            d.charges = item === 'triple' ? 3 : 1;
            d.lastUse = t;
            events.push({ t, type: 'pickup', duck: i, item, rank: rank[i], box: boxes.indexOf(bs) });
            if (item === 'shield') {
              d.shieldUntil = t + IT.shield.dur;
              openWindow(i, 'shield', IT.shield.dur, { popped: false });
            }
            break;
          }
        }
      }

      // ---- D. brains decide (all on the same snapshot), then fire ----
      const firing = [];
      for (let i = 0; i < count; i++) {
        const d = ducks[i];
        if (d.finishTime !== null || d.item === null || d.item === 'shield') continue;
        const ahead = duckAhead(i);
        const view = {
          item: d.item,
          heldFor: t - d.itemT,
          sinceLastUse: t - d.lastUse,
          chargesLeft: d.charges,
          rank: rank[i],
          count,
          gapAhead: ahead >= 0 ? ducks[ahead].s - d.s : Infinity,
          latDiffAhead: ahead >= 0 ? ducks[ahead].lat - d.lat : 0,
          prog: d.s / L,
          airborne: d.airborne,
          spinning: !!(d.stumble && d.stumble.cause),
          leaderProg,
        };
        if (brainWantsToFire(d.brain, view)) firing.push(i);
      }
      for (const i of firing) useItem(i);

      // ---- E. projectiles ----
      for (const p of projectiles) {
        if (p.result) continue;
        const age = t - p.t0;
        if (p.type === 'hornet') {
          p.s += IT.hornet.speed * v0 * DT;
          const tgt = p.target >= 0 ? ducks[p.target] : null;
          if (tgt) p.lat += (tgt.lat - p.lat) * Math.min(1, DT * 3);
          if (!tgt || age > IT.hornet.maxFlight) {
            if (age > 1.2 || !tgt) finish(p, tgt ? 'fizzle' : 'fizzle');
          } else if (tgt.finishTime !== null) finish(p, 'fizzle');
          else if (p.s >= tgt.s) finish(p, hitDuck(p.target, 'hornet', IT.hornet.spin, p.owner));
        } else if (p.type === 'stone') {
          p.s += IT.stone.speed * v0 * DT;
          if (age > IT.stone.ttl) finish(p, 'fizzle');
          else {
            for (let r = 0; r < count; r++) {
              const j = orderBuf[r];
              if (j === p.owner) continue;
              const o = ducks[j];
              if (o.finishTime !== null) continue;
              if (Math.abs(o.s - p.s) < IT.stone.sRadius && Math.abs(o.lat - p.lat) < IT.stone.latRadius) {
                p.target = j;
                finish(p, hitDuck(j, 'stone', IT.stone.spin, p.owner));
                break;
              }
            }
          }
        } else if (p.type === 'seagull') {
          if (p.phase === 'fly') {
            const tgtI = currentLeaderUnfinished(p.owner);
            p.target = tgtI;
            const tgt = tgtI >= 0 ? ducks[tgtI] : null;
            if (!tgt) finish(p, 'fizzle');
            else if (tgt.s / L > 0.9) finish(p, 'fizzle');
            else {
              p.s = Math.min(p.s + IT.seagull.speed * v0 * DT, tgt.s);
              p.lat += (tgt.lat - p.lat) * Math.min(1, DT * 2);
              if (tgt.s - p.s < 14 && age > 0.8) {
                p.phase = 'dive';
                p.diveT = t;
              }
            }
          } else {
            const tgt = ducks[p.target];
            const e = (t - p.diveT) / IT.seagull.dive;
            p.s = tgt.s - 14 * Math.max(0, 1 - e);
            p.lat += (tgt.lat - p.lat) * Math.min(1, DT * 6);
            if (tgt.finishTime !== null) finish(p, 'fizzle');
            else if (e >= 1) finish(p, hitDuck(p.target, 'seagull', IT.seagull.spin, p.owner));
          }
        }
        p.path.push(p.s, p.lat);
      }
    }

    // ---- F. integrate every duck ----
    for (let i = 0; i < count; i++) {
      const d = ducks[i];
      if (d.finishTime !== null) {
        d.v *= 0.985; // coast into the harbour (visual only)
        d.v = Math.max(d.v, 0.25 * v0);
        d.s += d.v * DT;
        d.lat = lateralFor(d, d.s, t);
        continue;
      }
      const prog = d.s / L;
      const sec = course.sectionIdAt(d.s);
      const inRapids = sec === 'rapids';
      const wasAir = d.airborne;
      d.airborne = d.s > F.dropLipS - 1.5 && d.s < F.dropLandS + 4;
      if (d.airborne && !wasAir) {
        d.vAir = Math.max(d.v, 0.85 * v0);
        events.push({ t, type: 'takeoff', duck: i });
      } else if (!d.airborne && wasAir) {
        d.splashUntil = t + TUNING.splashSlow.dur;
        events.push({ t, type: 'splashdown', duck: i });
      }

      let form = 0;
      for (const w of d.waves) form += w.amp * Math.sin((2 * Math.PI * t) / w.period + w.phase);

      const tau = 0.7;
      const sigma = TUNING.noise * v0 * (inRapids ? TUNING.rapids.noise : 1);
      d.noise += (-d.noise / tau) * DT + sigma * Math.sqrt((2 * DT) / tau) * rng.normal();

      const star = isStar(d);
      let boost = 0;
      if (d.burst) {
        const e = (t - d.burst.t0) / d.burst.dur;
        if (e >= 1) d.burst = null;
        else boost = d.burst.amp * burstShape(e);
      } else if (!d.airborne && t > 1.5 && rng.chance(d.burstRate * DT * (prog > 0.88 ? 0.5 : 1) * (inRapids ? TUNING.rapids.burst : 1))) {
        d.burst = { t0: t, dur: rng.range(1.0, 1.7), amp: rng.range(0.26, 0.46) * v0 };
        events.push({ t, type: 'burst', duck: i, section: sec });
        openWindow(i, 'burst', d.burst.dur, {});
      }

      let drag = 0;
      if (d.stumble) {
        const e = (t - d.stumble.t0) / d.stumble.dur;
        if (e >= 1) d.stumble = null;
        else drag = d.stumble.amp * Math.sin(Math.PI * e);
      } else if (!d.burst && !d.airborne && !star && t > 2.5 && prog < 0.9) {
        const mul = inRapids ? TUNING.rapids.stumble : sec === 'lily' ? TUNING.lily.stumble : 1;
        if (rng.chance(d.stumbleRate * DT * mul)) {
          d.stumble = { t0: t, dur: rng.range(0.7, 1.1), amp: rng.range(0.3, 0.5) * v0, cause: null };
          const what = inRapids ? 'rock' : sec === 'lily' ? 'lilypad' : sec === 'tunnel' ? 'log' : sec === 'canyon' ? 'buoy' : 'wave';
          events.push({ t, type: 'stumble', duck: i, what, section: sec });
          openWindow(i, 'stumble', d.stumble.dur, { what });
        }
      }
      if (star) drag = 0;
      if (t < d.mudUntil) drag += IT.mud.slow * v0;
      if (t < d.wobbleUntil) drag += IT.feather.wobble.amp * v0;
      if (t < d.splashUntil) drag += TUNING.splashSlow.amp * v0;

      const rb = clamp(TUNING.band * ((meanS - d.s) / L), -0.15, 0.19) * v0 * bandFade;
      const kick = d.kick * smoothstep(d.kickStart, d.kickStart + 0.12, prog);
      if (!d.kicked && prog >= d.kickStart) {
        d.kicked = true;
        if (d.kick > 0.06 * v0) events.push({ t, type: 'kick', duck: i, rank: rank[i], amp: d.kick / v0 });
      }
      const launch = smoothstep(d.reaction, d.reaction + 1.3, t);
      const current = sec === 'tunnel' ? TUNING.tunnelCurrent * v0 : 0;

      let v = (d.cruise + form + d.noise + boost - drag + rb + kick + current + (star ? IT.feather.fast * v0 : 0)) * launch;
      if (d.airborne) v = Math.max(v, d.vAir);
      v = Math.max(v, 0.22 * v0 * launch);
      d.v = v;
      if (v > d.maxSpeed) d.maxSpeed = v;

      const prevS = d.s;
      d.s += v * DT;
      d.lat = lateralFor(d, d.s, t + DT);

      // golden feather plows through anyone it passes close to (positions as at the start of the tick, so index order can't matter)
      if (star) {
        for (let j = 0; j < count; j++) {
          if (j === i) continue;
          const o = ducks[j];
          if (o.finishTime !== null || isStar(o)) continue;
          const os = tick > 0 ? pos[j][tick - 1] + 0 : o.s;
          if (os > prevS && os <= d.s + 0.8 && Math.abs(o.lat - d.lat) < IT.feather.plowLat && t >= o.wobbleUntil) {
            o.wobbleUntil = t + IT.feather.wobble.dur;
            events.push({ t, type: 'plow', duck: j, by: i });
            openWindow(j, 'wobble', IT.feather.wobble.dur, { by: i });
          }
        }
      }

      if (d.s >= L) {
        const frac = (L - prevS) / (d.s - prevS);
        d.finishTime = t + DT * frac;
        finished++;
        events.push({ t: d.finishTime, duck: i, type: 'finish' });
      }
    }

    t += DT;
    tick++;

    // ---- G. leader bookkeeping (hysteresis so photo-close swaps don't spam) ----
    let best = -1;
    let bestS = -1;
    for (let i = 0; i < count; i++) {
      const d = ducks[i];
      if (d.s > bestS || (d.s === bestS && best >= 0 && d.tieKey < ducks[best].tieKey)) {
        bestS = d.s;
        best = i;
      }
    }
    const curLeader = leader >= 0 && best !== leader && bestS <= ducks[leader].s + 0.004 * L ? leader : best;
    if (t < 1 && bestS <= 0) { /* nobody has moved yet: no leader */ } else if (curLeader !== leader) {
      if (leader !== -1 && t > 3 && ducks[curLeader].finishTime === null) {
        leadChanges++;
        events.push({ t, duck: curLeader, type: 'lead', from: leader });
      }
      leader = curLeader;
    }
    if (leader >= 0 && ducks[leader].finishTime === null) ducks[leader].timeLed += DT;

    let mx = 0;
    for (const d of ducks) if (d.s > mx) mx = d.s;
    if (!halfwayCalled && mx >= L * 0.5) {
      halfwayCalled = true;
      events.push({ t, duck: leader, type: 'halfway' });
    }
    if (!stretchCalled && mx >= F.harborInS) {
      stretchCalled = true;
      events.push({ t, duck: leader, type: 'stretch' });
    }

    for (let i = 0; i < count; i++) {
      const d = ducks[i];
      pos[i][tick] = d.s;
      lat[i][tick] = d.lat;
      vel[i][tick] = d.v;
      held[i][tick] = d.item ? ITEM_CODE[d.item] | (d.charges << 4) : 0;
    }
  }

  function finish(p, result) {
    p.result = result === 'immune' ? 'blocked' : result;
    p.t1 = t;
    events.push({ t, type: 'projectile-end', id: p.id, kind: p.type, result: p.result, owner: p.owner, target: p.target });
  }

  // Safety net: anyone still out there gets a finish time in current order.
  if (finished < count) {
    const stragglers = ducks
      .map((d, i) => ({ d, i }))
      .filter((e) => e.d.finishTime === null)
      .sort((a, b) => b.d.s - a.d.s || a.d.tieKey - b.d.tieKey);
    let ft = t;
    for (const { d, i } of stragglers) {
      ft += 0.25;
      d.finishTime = ft;
      d.s = L;
      events.push({ t: ft, duck: i, type: 'finish', forced: true });
    }
  }
  for (const p of projectiles) {
    if (!p.result) {
      p.result = 'fizzle';
      p.t1 = t;
    }
    p.path = Float32Array.from(p.path);
  }

  const ticks = tick;
  const finishTimes = ducks.map((d) => d.finishTime);
  const order = ducks.map((d, i) => i).sort((a, b) => finishTimes[a] - finishTimes[b] || ducks[a].tieKey - ducks[b].tieKey);
  const margin = finishTimes[order[1]] !== undefined ? finishTimes[order[1]] - finishTimes[order[0]] : Infinity;
  events.sort((a, b) => a.t - b.t);

  return {
    seed,
    count,
    duration,
    hazards,
    itemsOn: items,
    hotdogs,
    trackLength: L,
    v0,
    dt: DT,
    ticks,
    totalTime: t,
    pos: pos.map((p) => p.subarray(0, ticks + 1)),
    lat: lat.map((p) => p.subarray(0, ticks + 1)),
    vel: vel.map((p) => p.subarray(0, ticks + 1)),
    held: held.map((p) => p.subarray(0, ticks + 1)),
    finishTimes,
    order,
    margin,
    photoFinish: margin < 0.08,
    close: margin < 0.35,
    leadChanges,
    events,
    projectiles,
    windows,
    stats: ducks.map((d) => ({ timeLed: d.timeLed, maxSpeed: d.maxSpeed, reaction: d.reaction, itemsUsed: d.itemsUsed, hitsTaken: d.hitsTaken })),
  };
}

function burstShape(e) {
  if (e < 0.18) return smoothstep(0, 0.18, e);
  return 1 - smoothstep(0.18, 1, e);
}

/**
 * Score a simulation for entertainment value ("structured TV race"): a few
 * real lead changes, decided in the run-in rather than on the line, a winner
 * who was in the picture at three-quarters, a close (not always photo) finish,
 * item drama at the front that is not a late pile-up, and a comeback bonus.
 * A pure function of positions/events, symmetric under any permutation of the
 * ducks, so keeping the best of several candidate sub-seeds stays fair.
 */
export function dramaScore(sim) {
  const n = sim.count;
  const ft = sim.order.map((i) => sim.finishTimes[i]);
  const winT = ft[0];
  const winner = sim.order[0];
  let s = 0;
  const lc = sim.leadChanges;
  s += Math.min(lc, 5) * 0.7 - Math.max(0, lc - 7) * 0.6; // 3–6 changes, not 9+
  const leads = sim.events.filter((e) => e.type === 'lead');
  const last = leads.length ? leads[leads.length - 1].t / winT : 0;
  s += last > 0.8 && last <= 0.97 ? 2 : last > 0.97 ? 0.5 : last < 0.6 ? -1.5 : 0; // decided in the run-in, not on the line
  if (new Set(leads.map((e) => e.duck)).size >= 3) s += 1; // three or more protagonists
  const wr = standingsAt(sim, winT * 0.75).findIndex((row) => row.i === winner);
  s += wr <= 1 ? 1.5 : wr <= 3 ? 1 : wr <= 5 ? -0.5 : -2; // the winner earned it (with the odd steal)
  const m = sim.margin;
  s += m < 0.08 ? 1.2 : m < 0.6 ? 1.5 : m < 1.2 ? 0.5 : m > 2 ? -1.5 : 0; // close > photo > blowout
  if (ft[Math.min(2, n - 1)] - winT < 1.4) s += 0.5;
  if (ft[n - 1] - winT > sim.duration * 0.28) s -= 2; // nobody wants to wait for a straggler
  const hits = sim.events.filter((e) => e.type === 'hit');
  const front = hits.filter((e) => e.rank <= 2);
  const lateFront = front.filter((e) => positionAt(sim, e.duck, e.t) > 0.84 * sim.trackLength).length;
  s += Math.min(front.length - lateFront, 3) * 0.6 - Math.max(0, lateFront - 1) * 1.2 - Math.max(0, hits.length - (n * 0.6 + 2)) * 0.3;
  const st50 = standingsAt(sim, winT * 0.5); // a comeback story is a bonus
  for (let k = 0; k < Math.min(3, n); k++) {
    if (st50.findIndex((x) => x.i === sim.order[k]) >= Math.ceil((2 * n) / 3)) {
      s += 0.8;
      break;
    }
  }
  return s;
}

/**
 * Build the race for a roster: auditions a fixed number of sub-seeds derived
 * from the master seed and keeps the most dramatic. Fully deterministic.
 */
export function createRace({ count, seed, duration = DEFAULTS.duration, candidates = DEFAULTS.candidates, hazards = true, items = true, course }) {
  let best = null;
  let bestScore = -Infinity;
  for (let k = 0; k < Math.max(1, candidates); k++) {
    const subSeed = k === 0 ? seed >>> 0 : hashString(`${seed >>> 0}:world${k}`);
    const sim = simulateRace({ count, seed: subSeed, duration, hazards, items, course });
    const s = dramaScore(sim);
    if (s > bestScore) {
      bestScore = s;
      best = sim;
      best.variant = k;
      best.drama = s;
    }
  }
  best.masterSeed = seed >>> 0;
  return best;
}

function sample(arr, dt, t) {
  const f = clamp(t / dt, 0, arr.length - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(i0 + 1, arr.length - 1);
  return arr[i0] + (arr[i1] - arr[i0]) * (f - i0);
}

/** Interpolated distance (m) of duck i at race time t; keeps coasting past the data. */
export function positionAt(sim, i, t) {
  const arr = sim.pos[i];
  const end = (arr.length - 1) * sim.dt;
  if (t <= end) return sample(arr, sim.dt, t);
  return arr[arr.length - 1] + sim.vel[i][arr.length - 1] * 0.6 * Math.min(t - end, 6);
}
export const lateralAt = (sim, i, t) => sample(sim.lat[i], sim.dt, t);
export const speedAt = (sim, i, t) => {
  const arr = sim.vel[i];
  const end = (arr.length - 1) * sim.dt;
  if (t <= end) return sample(arr, sim.dt, t);
  return t - end < 6 ? arr[arr.length - 1] * 0.6 : 0;
};

/** Held item of duck i at time t: { item, charges } or null. */
export function heldAt(sim, i, t) {
  const arr = sim.held[i];
  const k = clamp(Math.floor(t / sim.dt), 0, arr.length - 1);
  const code = arr[k];
  if (!code) return null;
  return { item: CODE_ITEM[code & 15], charges: code >> 4 };
}

/** Current running order at time t: leader first. */
export function standingsAt(sim, t) {
  const n = sim.count;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const ft = sim.finishTimes[i];
    const done = ft !== null && t >= ft;
    rows.push({ i, x: done ? sim.trackLength : Math.min(sim.trackLength, positionAt(sim, i, t)), done, ft });
  }
  rows.sort((a, b) => {
    if (a.done && b.done) return a.ft - b.ft;
    if (a.done !== b.done) return a.done ? -1 : 1;
    return b.x - a.x || a.i - b.i;
  });
  return rows;
}

/** Effect windows of duck i active at time t. */
export function activeWindows(sim, i, t, out = []) {
  out.length = 0;
  for (const w of sim.windows[i]) {
    if (w.t0 > t) break;
    if (t < w.t1) out.push(w);
  }
  return out;
}
