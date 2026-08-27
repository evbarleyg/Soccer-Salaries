// Duck Derby World — Mario Kart-style items: catalogue, position-weighted
// (catch-up) roll table and the little seeded "brain" every duck uses to decide
// when to fire. Headless and deterministic: everything keys off race position,
// never off a name or lane, and identical tables/brains are used for every
// duck, so the race stays fair (see test/world3d.items.test.js).

import { lerp, clamp } from '../rng.js';

/** @typedef {'bread'|'triple'|'hornet'|'stone'|'shield'|'mud'|'feather'|'seagull'} ItemId */

export const ITEMS = {
  bread: { id: 'bread', name: 'Bread Boost', short: 'BOOST', color: '#E8A33C', blurb: 'A quick burst of speed' },
  triple: { id: 'triple', name: 'Triple Bread', short: '3× BOOST', color: '#F3C46B', blurb: 'Three boosts, spaced out' },
  hornet: { id: 'hornet', name: 'Homing Hornet', short: 'HORNET', color: '#E0362C', blurb: 'Chases down the duck ahead' },
  stone: { id: 'stone', name: 'Skipping Stone', short: 'STONE', color: '#8FA3AD', blurb: 'Fired straight — hits or skips out' },
  shield: { id: 'shield', name: 'Bubble Shield', short: 'SHIELD', color: '#66D6FF', blurb: 'Blocks one hit' },
  mud: { id: 'mud', name: 'Mud Splat', short: 'MUD', color: '#7A5230', blurb: 'Splatters everyone ahead' },
  feather: { id: 'feather', name: 'Golden Goose Feather', short: 'GOLDEN', color: '#FFD23F', blurb: 'Invincible and fast' },
  seagull: { id: 'seagull', name: 'Seagull Strike', short: 'SEAGULL', color: '#3D7BE0', blurb: 'Dive-bombs the leader' },
};
export const ITEM_ORDER = ['bread', 'triple', 'hornet', 'stone', 'shield', 'mud', 'feather', 'seagull'];

/** Effect tuning (seconds / fractions of base speed v0). */
export const ITEM_TUNING = {
  pickupChance: 0.62, // chance a duck actually clips a box in the row
  boost: { dur: 1.35, amp: 0.36 },
  hornet: { speed: 1.9, maxFlight: 4.0, spin: { dur: 1.3, amp: 0.9 } },
  stone: { speed: 2.2, ttl: 2.0, sRadius: 2.0, latRadius: 1.5, spin: { dur: 1.1, amp: 0.82 } },
  shield: { dur: 8 },
  mud: { range: 90, dur: 1.7, slow: 0.045 },
  feather: { dur: 3.2, fast: 0.27, plowLat: 2.2, wobble: { dur: 0.55, amp: 0.05 } },
  seagull: { speed: 3.3, dive: 0.55, spin: { dur: 1.6, amp: 1.0 } },
  hotdog: { lead: 0.8, spin: { dur: 1.7, amp: 1.1 } },
};

/**
 * Position-weighted item table (catch-up logic). Pure function of race
 * position, so it is identical for every duck.
 * @param {number} rank 0 = leader
 * @param {number} count ducks in the race
 * @param {number} leaderProg leader's progress 0..1
 * @returns {Array<[ItemId, number]>} weights (unnormalised)
 */
export function itemWeights(rank, count, leaderProg) {
  const r = count > 1 ? clamp(rank / (count - 1), 0, 1) : 0;
  const leader = rank === 0;
  const backThird = count >= 3 && rank >= Math.ceil((2 * count) / 3);
  const w = [
    ['bread', lerp(34, 16, r)],
    ['triple', lerp(3, 22, r)],
    ['hornet', leader ? 0 : lerp(9, 22, r)],
    ['stone', lerp(18, 8, r)],
    ['shield', lerp(30, 6, r)],
    ['mud', leader ? 0 : lerp(9, 5, r)],
    ['feather', count >= 3 && r > 0.6 ? lerp(0, 17, (r - 0.6) / 0.4) : 0],
    ['seagull', backThird && leaderProg < 0.9 ? 7 : 0],
  ];
  return w;
}

/** Roll an item for a duck in `rank` (0 = leader). Consumes exactly one rng draw. */
export function rollItem(rng, rank, count, leaderProg) {
  const w = itemWeights(rank, count, leaderProg);
  let total = 0;
  for (const [, x] of w) total += x;
  let pick = rng.next() * total;
  for (const [id, x] of w) {
    pick -= x;
    if (pick < 0) return id;
  }
  return w[w.length - 1][0];
}

/**
 * Draw a duck's item brain. Parameters are i.i.d. across ducks. The brain is a
 * pure function of (its params, the view of the race) — no hidden state beyond
 * what the engine passes in — so replays reproduce every decision.
 */
export function makeBrain(rng) {
  return {
    patience: rng.range(0.55, 1.5), // seconds it likes to sit on an item
    nerve: rng.range(0, 1), // how close it wants to be before firing projectiles
    spacing: rng.range(1.0, 1.9), // gap between triple-bread charges
  };
}

/**
 * Decide whether to fire the held item this tick.
 * @param {{patience:number, nerve:number, spacing:number}} brain
 * @param {object} v view: { item, heldFor, sinceLastUse, chargesLeft, rank, count,
 *   gapAhead, latDiffAhead, prog, airborne, spinning, section }
 * @returns {boolean}
 */
export function brainWantsToFire(brain, v) {
  if (v.airborne || v.spinning) return false;
  if (v.prog > 0.985) return false; // over the line in a moment anyway
  const lastChance = v.prog > 0.9; // use it or lose it
  switch (v.item) {
    case 'bread':
      return v.heldFor > brain.patience * 0.8 || (v.gapAhead < 14 && v.heldFor > 0.25) || lastChance;
    case 'triple':
      if (v.chargesLeft === 3) return v.heldFor > brain.patience * 0.6 || lastChance;
      return v.sinceLastUse > brain.spacing || lastChance;
    case 'hornet':
      if (v.rank === 0) return v.heldFor > 6.5; // nothing to shoot at: eventually wastes it
      return (v.gapAhead < lerp(45, 90, brain.nerve) && v.heldFor > 0.3 + 0.4 * brain.patience) || v.heldFor > 5 || lastChance;
    case 'stone':
      if (v.rank === 0) return v.heldFor > 5.5;
      return (v.gapAhead < lerp(20, 34, brain.nerve) && Math.abs(v.latDiffAhead) < 1.6 && v.heldFor > 0.2) || v.heldFor > 4.5 || lastChance;
    case 'mud':
      if (v.rank === 0) return v.heldFor > 6;
      return v.heldFor > 0.5 * brain.patience || lastChance;
    case 'feather':
      return v.heldFor > 0.3;
    case 'seagull':
      return v.heldFor > 0.8 + 0.5 * brain.patience;
    case 'shield':
      return false; // shields equip themselves on pickup
    default:
      return v.heldFor > 1;
  }
}
