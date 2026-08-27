// Race story: the run-in call, per-duck awards, the one-line headline and the
// hot-dog "culprits". Pure functions of the precomputed sim (positions, finish
// times, events, stats) plus seed hashes — never playback state, wall clock or
// Math.random — so the board, the PNG, the copied text and every replay of a
// share link tell the same story. Node-importable (see test/awards.test.js,
// test/runin.test.js).

import { standingsAt, speedAt, TRACK_LENGTH } from './sim.js';
import { hashString } from './rng.js';

/** The run-in programme is decided once, when the leader has this many units (4.5 m) left. */
export const RUNIN_AT = 45;
const GRID = 0.25; // sampling step (race seconds) for rank histories — the broadcast grid

// ---------------------------------------------------------------------------
// run-in classification (C1)
// ---------------------------------------------------------------------------

/**
 * The live picture at race time tq: the unfinished ducks front to back, the gap between the first two in
 * seconds of swimming, and how far apart those two will actually touch (signed: > 0 = the leader holds on).
 * @returns {{live: Array<{i:number,x:number}>, gapUnits: number, gapSec: number, projected: number}}
 */
export function runInGap(sim, tq) {
  const live = standingsAt(sim, tq).filter((r) => !r.done);
  if (live.length < 2) return { live, gapUnits: Infinity, gapSec: Infinity, projected: Infinity };
  const a = live[0];
  const b = live[1];
  const gapUnits = a.x - b.x;
  const gapSec = gapUnits / Math.max(8, speedAt(sim, a.i, tq));
  const projected = sim.finishTimes[b.i] - sim.finishTimes[a.i];
  return { live, gapUnits, gapSec, projected };
}

/**
 * How to programme the last metres, judged by TIME (not distance): 'photo' only for a finish that will
 * genuinely be tight, 'contested' for a fight to the wall, 'clear' for daylight.
 * @returns {'photo'|'contested'|'clear'}
 */
export function classifyRunIn(sim, tq) {
  if (sim.photoFinish) return 'photo';
  const { live, gapSec, projected } = runInGap(sim, tq);
  if (live.length < 2) return 'clear';
  const close = Math.abs(projected);
  // the live pair look inseparable AND will touch inside 0.35 s — and nobody else spoils it by half a second
  if (gapSec < 0.25 && close < 0.35 && sim.margin < 0.5) return 'photo';
  if (gapSec < 0.6 || close < 0.6) return 'contested';
  if (gapSec > 0.75 && projected > 1.0) return 'clear';
  return 'contested';
}

/** "Nobody is catching X": daylight now AND at the line (the leader really does hold on by over a second). */
export function nobodyCatching(sim, tq) {
  const { live, gapSec, projected } = runInGap(sim, tq);
  return live.length >= 2 && gapSec > 0.8 && projected > 1.2;
}

// ---------------------------------------------------------------------------
// hot-dog culprits (C4): which manager's "section" of the crowd threw it
// ---------------------------------------------------------------------------

/**
 * For the k-th hot dog (in sim.events order) a seeded pick among the other ducks, in lane order.
 * @returns {Map<number, number>} sim.events index -> culprit duck index
 */
export function hotdogCulprits(sim, n = sim.count) {
  const out = new Map();
  if (!sim || !Array.isArray(sim.events) || n < 2) return out;
  let k = 0;
  sim.events.forEach((ev, idx) => {
    if (ev.type !== 'hotdog') return;
    const h = hashString(`${sim.seed}:hd:${k}`);
    k++;
    let pick = h % (n - 1);
    for (let d = 0; d < n; d++) {
      if (d === ev.duck) continue;
      if (pick-- === 0) {
        out.set(idx, d);
        break;
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// awards + headline (C3)
// ---------------------------------------------------------------------------

const ord = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const sec1 = (t) => (Math.round(t * 10) / 10).toFixed(1);
const sec2 = (t) => t.toFixed(2);
const mps = (units) => (units / 10).toFixed(2);

/** Fixed priority: story beats first, then superlatives, then the also-rans' consolation prizes. */
const PRIORITY = ['HOTDOG_VICTIM', 'SNIPER', 'TRIED_TOO_HARD', 'WIRE_TO_WIRE', 'DAYLIGHT', 'ROBBED', 'LED_MOST', 'COMEBACK', 'COLLAPSE', 'BY_A_BEAK', 'MASTER_TANKER', 'TOP_SPEED', 'ROCKET_START', 'YOYO', 'MOST_BURSTS', 'MOST_STUMBLES', 'SLEPT_IN'];
const MAX_PER_DUCK = 2;

/**
 * Everything the awards and the headline are read from: finish places, sim stats, event tallies and each
 * duck's best/worst running position sampled on the fixed 0.25 s grid (from 4 s: the start scramble is lane
 * order, not racing — the broadcast's situational lines wait for the same moment).
 */
function survey(sim) {
  const n = sim.count;
  const order = sim.order;
  const ft = sim.finishTimes;
  const place = new Array(n);
  order.forEach((d, k) => (place[d] = k + 1));
  const maxFt = Math.max(...ft);
  const best = new Array(n).fill(Infinity); // best / worst 1-based running position while still racing
  const worst = new Array(n).fill(0);
  for (let t = 4; t <= maxFt + 1e-9; t += GRID) {
    standingsAt(sim, t).forEach((r, k) => {
      if (r.done) return;
      if (k + 1 < best[r.i]) best[r.i] = k + 1;
      if (k + 1 > worst[r.i]) worst[r.i] = k + 1;
    });
  }
  for (let i = 0; i < n; i++) if (!Number.isFinite(best[i])) best[i] = worst[i] = place[i];
  const bursts = new Array(n).fill(0);
  const stumbles = new Array(n).fill(0);
  const hotdogs = []; // {idx, t, duck, rank (1-based at impact)}
  let halfway = null;
  sim.events.forEach((ev, idx) => {
    if (ev.type === 'burst' && ev.duck >= 0) bursts[ev.duck]++;
    else if (ev.type === 'stumble' && ev.duck >= 0) stumbles[ev.duck]++;
    else if (ev.type === 'hotdog' && ev.duck >= 0) {
      const rankAt = (t) => standingsAt(sim, t).findIndex((r) => r.i === ev.duck) + 1;
      hotdogs.push({ idx, t: ev.t, duck: ev.duck, rank: rankAt(ev.t), rankAfter: rankAt(ev.t + 2.2) }); // 2.2 s: when the broadcast asks "did it cost them?"
    }
    else if (ev.type === 'halfway' && !halfway) halfway = ev;
  });
  const winner = order[0];
  const winnerT = ft[winner];
  // a steal: the winner was not in front for the whole of the last second (the same test main.js airs "STEALS IT" on)
  const steal = n >= 2 && [0.25, 0.5, 0.75, 1].some((d) => standingsAt(sim, Math.max(0, winnerT - d))[0].i !== winner);
  return { n, order, ft, place, best, worst, bursts, stumbles, hotdogs, halfway, winner, winnerT, steal, stats: sim.stats || [] };
}

/**
 * Deterministic per-duck superlatives + a one-line race story.
 * @param {object} sim createRace() result
 * @param {string[]} names index-aligned with the sim's ducks
 * @param {'winner-first'|'winner-choice'|'last-first'} [rule]
 * @returns {{byDuck: Map<number, Array<{id:string,icon:string,label:string,short:string,detail:string}>>, headline: string, culprits: Map<number, number>}}
 */
export function raceAwards(sim, names, rule = 'winner-first') {
  const S = survey(sim);
  const { n, ft, place, stats } = S;
  const nm = (i) => names[i] ?? `Duck ${i + 1}`;
  const culprits = hotdogCulprits(sim, n);
  const lastFirst = rule === 'last-first';
  /** candidate grants per award id, best first */
  const cands = new Map();
  const grant = (id, duck, score, icon, label, short, detail) => {
    if (duck === undefined || duck === null || duck < 0 || duck >= n) return;
    if (!cands.has(id)) cands.set(id, []);
    cands.get(id).push({ duck, score, award: { id, icon, label, short, detail } });
  };
  const byMax = (arr) => arr.reduce((bi, v, i) => (v > arr[bi] || (v === arr[bi] && better(i, bi)) ? i : bi), 0);
  const byMin = (arr) => arr.reduce((bi, v, i) => (v < arr[bi] || (v === arr[bi] && better(i, bi)) ? i : bi), 0);
  const better = (a, b) => place[a] < place[b] || (place[a] === place[b] && a < b); // tie-break: finish place, then lane

  // led the most (sim's own hysteresis bookkeeping) — a podium duck is a front-runner, anyone else was robbed
  const led = stats.map((s) => s.timeLed || 0);
  if (led.length === n) {
    const i = byMax(led);
    if (led[i] >= 4) {
      if (place[i] > 3) grant('ROBBED', i, led[i], '💔', `Led longest, finished ${ord(place[i])}`, `Led ${sec1(led[i])} s`, `${nm(i)} led for ${sec1(led[i])} s — longer than anyone — and finished ${ord(place[i])}`);
      else grant('LED_MOST', i, led[i], '🏁', `Front-runner · led ${sec1(led[i])} s`, `Led ${sec1(led[i])} s`, `${nm(i)} led the race for ${sec1(led[i])} of ${sec1(S.winnerT)} s`);
    }
    const w = S.winner;
    if (led[w] > 0.8 * S.winnerT) grant('WIRE_TO_WIRE', w, led[w], '👑', 'Wire to wire', 'Wire to wire', `${nm(w)} led for ${sec1(led[w])} of ${sec1(S.winnerT)} s and was never really headed`);
  }
  if (n >= 2 && Number.isFinite(sim.margin) && sim.margin > 1.5) grant('DAYLIGHT', S.winner, sim.margin, '🔭', `Daylight · won by ${sec2(sim.margin)} s`, `By ${sec2(sim.margin)} s`, `${nm(S.winner)} won by ${sec2(sim.margin)} s — daylight second`);
  // raw pace + reactions
  const vmax = stats.map((s) => s.maxSpeed || 0);
  if (vmax.length === n && n >= 2) {
    const i = byMax(vmax);
    grant('TOP_SPEED', i, vmax[i], '⚡', `${mps(vmax[i])} m/s peak`, `${mps(vmax[i])} m/s`, `${nm(i)} hit the top speed of the race: ${mps(vmax[i])} m/s`);
  }
  const react = stats.map((s) => s.reaction || 0);
  if (react.length === n && n >= 3) {
    const i = byMin(react);
    const j = byMax(react);
    grant('ROCKET_START', i, -react[i], '🚀', `Rocket start · ${Math.round(react[i] * 1000)} ms`, `${Math.round(react[i] * 1000)} ms start`, `${nm(i)} reacted to the gun in ${Math.round(react[i] * 1000)} ms, quickest of all`);
    grant('SLEPT_IN', j, react[j], '😴', `Slept in · ${Math.round(react[j] * 1000)} ms`, `${Math.round(react[j] * 1000)} ms start`, `${nm(j)} took ${Math.round(react[j] * 1000)} ms to react to the gun, slowest of all`);
  }
  // rank swings on the grid (meaningless in tiny fields)
  if (n >= 4) {
    const need = n >= 10 ? 4 : 3;
    for (let i = 0; i < n; i++) {
      const up = S.worst[i] - place[i];
      if (up >= need) grant('COMEBACK', i, up * 100 - place[i], '📈', `${ord(S.worst[i])} → ${ord(place[i])}`, `${ord(S.worst[i])}→${ord(place[i])}`, `${nm(i)} was running ${ord(S.worst[i])} and came home ${ord(place[i])}`);
      const down = place[i] - S.best[i];
      const ledHalf = S.halfway && S.halfway.duck === i && place[i] > 3;
      if (down >= need || ledHalf) {
        const label = ledHalf ? `Led at halfway, finished ${ord(place[i])}` : `${ord(S.best[i])} → ${ord(place[i])}`;
        grant('COLLAPSE', i, (ledHalf ? 1000 : 0) + down * 100 - place[i], '📉', label, ledHalf ? `Led → ${ord(place[i])}` : `${ord(S.best[i])}→${ord(place[i])}`, ledHalf ? `${nm(i)} led the field at halfway and faded to ${ord(place[i])}` : `${nm(i)} was running ${ord(S.best[i])} and slid to ${ord(place[i])}`);
      }
      // yo-yo: well above AND well below where they finished at some point (spec'd as "6 rank changes", but in a
      // packed field every duck swaps places 20+ times on the grid — the swing is the honest measure)
      if (place[i] - S.best[i] >= 2 && S.worst[i] - place[i] >= 2 && S.worst[i] - S.best[i] > need) {
        grant('YOYO', i, (S.worst[i] - S.best[i]) * 100 - place[i], '🎢', `Yo-yo · ran ${ord(S.best[i])} and ${ord(S.worst[i])}`, `${ord(S.best[i])}↕${ord(S.worst[i])}`, `${nm(i)} ran as high as ${ord(S.best[i])} and as low as ${ord(S.worst[i])}, finished ${ord(place[i])}`);
      }
    }
  }
  // hot dogs: the victim (and what it cost), the "culprit"
  for (const hd of S.hotdogs) {
    const v = hd.duck;
    const won = place[v] === 1;
    const at = `${sec1(hd.t)} s`;
    const label = won ? `Ate a hot dog at ${at} and still won` : `Ate a hot dog at ${at} while ${ord(hd.rank)}`;
    grant('HOTDOG_VICTIM', v, 1000 - hd.t, '🌭', label, won ? 'Hot dog · still won' : `Hot dog while ${ord(hd.rank)}`, `${nm(v)} took a hot dog from the crowd at ${at} while running ${ord(hd.rank)} and finished ${ord(place[v])}`);
    const c = culprits.get(hd.idx);
    if (c !== undefined) grant('SNIPER', c, 1000 - hd.t, '🎯', `Hot-dogged ${nm(v)} at ${at}`, 'Hot-dog sniper', `The hot dog that hit ${nm(v)} at ${at} came from the ${nm(c)} section`);
  }
  for (let i = 0; i < n; i++) {
    if (S.stumbles[i] >= 3) grant('MOST_STUMBLES', i, S.stumbles[i] * 100 - place[i], '💫', `${S.stumbles[i]} stumbles`, `${S.stumbles[i]} stumbles`, `${nm(i)} lost rhythm ${S.stumbles[i]} times (bread, lily pads, dragonflies)`);
    if (S.bursts[i] >= 3) grant('MOST_BURSTS', i, S.bursts[i] * 100 - place[i], '💨', `${S.bursts[i]} bursts`, `${S.bursts[i]} bursts`, `${nm(i)} found another gear ${S.bursts[i]} times`);
    // by a beak: lost the place above by under 0.18 s
    if (place[i] >= 2) {
      const ahead = S.order[place[i] - 2];
      const gap = ft[i] - ft[ahead];
      if (gap < 0.18) {
        const label = place[i] === 2 ? `Beaten by ${sec2(gap)} s` : `Missed ${ord(place[i] - 1)} by ${sec2(gap)} s`;
        grant('BY_A_BEAK', i, -gap - place[i] * 10, '🤏', label, label, `${nm(i)} finished ${ord(place[i])}, ${sec2(gap)} s behind ${nm(ahead)}`);
      }
    }
  }
  if (lastFirst && n >= 3) {
    // toilet-bowl rules: the slowest engine among the bottom three is a craftsman; the race winner tried too hard
    const bottom = S.order.slice(-3);
    if (vmax.length === n) {
      const i = bottom.reduce((bi, d) => (vmax[d] < vmax[bi] ? d : bi), bottom[0]);
      grant('MASTER_TANKER', i, -vmax[i], '🐢', `Master tanker · ${mps(vmax[i])} m/s tops`, `${mps(vmax[i])} m/s tops`, `${nm(i)} never went faster than ${mps(vmax[i])} m/s — slowest engine of the bottom three`);
    }
    grant('TRIED_TOO_HARD', S.winner, 1, '🤦', 'Tried too hard', 'Tried too hard', `${nm(S.winner)} won the race, which under these rules means the last pick`);
  }

  // greedy unique assignment: fixed award order, best candidate with room (<= 2 per duck)
  const byDuck = new Map();
  const multi = new Set(['HOTDOG_VICTIM', 'SNIPER']); // one per hot dog
  for (const id of PRIORITY) {
    const list = cands.get(id);
    if (!list) continue;
    list.sort((a, b) => b.score - a.score || place[a.duck] - place[b.duck] || a.duck - b.duck);
    for (const c of list) {
      const have = byDuck.get(c.duck) || [];
      if (have.length >= MAX_PER_DUCK || have.some((a) => a.id === id)) continue;
      have.push(c.award);
      byDuck.set(c.duck, have);
      if (!multi.has(id)) break;
    }
  }
  return { byDuck, headline: headline(sim, names, rule, S, byDuck), culprits };
}

/** One sentence (<= 140 chars): winner + margin, at most two other facts, then the wooden spoon / the first pick. */
function headline(sim, names, rule, S, byDuck) {
  const { n, place, ft } = S;
  const nm = (i) => names[i] ?? `Duck ${i + 1}`;
  const W = nm(S.winner);
  const second = n >= 2 ? S.order[1] : -1;
  const m = Number.isFinite(sim.margin) ? sec2(sim.margin) : '';
  const has = (duck, id) => (byDuck.get(duck) || []).some((a) => a.id === id);
  const holder = (id) => [...byDuck.keys()].find((d) => has(d, id));
  // the decisive hot dog: it hit the leader in the second half, cost them the lead, and they finished 3rd or worse
  const costLead = (hd) => hd.rank === 1 && hd.rankAfter > 1;
  const decider = S.hotdogs.find((hd) => costLead(hd) && hd.t >= 0.5 * S.winnerT && place[hd.duck] >= 3);
  const victimLed = S.hotdogs.find(costLead);
  let lead;
  if (n < 2) lead = `${W} wins`;
  else if (sim.photoFinish) lead = `Photo finish: ${W} beats ${nm(second)} by ${m} s`;
  else if (S.steal) lead = `${W} steals it on the line, ${m} s over ${nm(second)}`;
  else if (has(S.winner, 'WIRE_TO_WIRE')) lead = `${W} leads wire to wire and wins by ${m} s`;
  else if (decider && decider.duck !== S.winner) lead = `A hot dog decides it: ${nm(decider.duck)} led until ${sec1(decider.t)} s, ${W} wins by ${m} s`;
  else lead = `${W} wins by ${m} s`;
  const facts = [];
  if (victimLed && !lead.startsWith('A hot dog')) facts.push(`a hot dog cost ${nm(victimLed.duck)} the lead at ${sec1(victimLed.t)} s`);
  const cb = holder('COMEBACK');
  if (cb !== undefined && cb !== S.winner) facts.push(`${nm(cb)} came from ${ord(S.worst[cb])} to ${ord(place[cb])}`);
  const rb = holder('ROBBED');
  if (rb !== undefined) facts.push(`${nm(rb)} led longest and finished ${ord(place[rb])}`);
  if (sim.leadChanges >= 4) facts.push(`${sim.leadChanges} lead changes`);
  const last = S.order[n - 1];
  const tail = n >= 3 ? (rule === 'last-first' ? `First pick: ${nm(last)}, dead last in ${sec2(ft[last])} s.` : `Wooden spoon: ${nm(last)}.`) : '';
  for (let k = Math.min(2, facts.length); k >= 0; k--) {
    const mid = facts.slice(0, k);
    const s = `${lead}${mid.length ? ` — ${mid.join(', ')}` : ''}. ${tail}`.trim();
    if (s.length <= 140 || k === 0) return s.length <= 140 ? s : `${lead}.`.slice(0, 140);
  }
  return `${lead}.`;
}

/** The share-sheet / PNG line for one hot dog: 'Hot dog: from the Mallory section, hit Puddles (1st) at 24.1 s'. */
export function hotdogLines(sim, names, culprits = hotdogCulprits(sim)) {
  const nm = (i) => names[i] ?? `Duck ${i + 1}`;
  const out = [];
  sim.events.forEach((ev, idx) => {
    if (ev.type !== 'hotdog') return;
    const rank = standingsAt(sim, ev.t).findIndex((r) => r.i === ev.duck) + 1;
    const c = culprits.get(idx);
    out.push(`Hot dog: ${c !== undefined ? `from the ${nm(c)} section, ` : ''}hit ${nm(ev.duck)} (${ord(rank)}) at ${sec1(ev.t)} s`);
  });
  return out;
}

export { TRACK_LENGTH };
