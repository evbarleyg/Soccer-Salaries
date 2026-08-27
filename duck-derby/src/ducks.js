// Duck identities: every entrant gets a unique plumage palette, unique headgear
// and an authentic post-position saddle-towel colour. Looks derive from the
// *names* (plus an optional style salt) so "your" duck stays yours between races.

import { hashString, createRng } from './rng.js';

/** Plumage palettes. `head` defaults to body; `ring` is an optional neck ring. */
export const PALETTES = [
  { id: 'classic', name: 'Classic Yellow', body: '#FFD93B', shade: '#F0B400', light: '#FFED8A', wing: '#F7C331', wingShade: '#E0A800', beak: '#FF8A00', beakShade: '#D96C00', eye: '#1B1B1B' },
  { id: 'mallard', name: 'Mallard', body: '#B9A58A', shade: '#8E7B62', light: '#D8CBB8', wing: '#7C6C5C', wingShade: '#5E5044', head: '#1E7A46', headLight: '#2FA866', ring: '#FFFFFF', accent: '#3A5BA9', beak: '#E8C22C', beakShade: '#B99A1E', eye: '#111' },
  { id: 'snow', name: 'Snow White', body: '#F7F9FC', shade: '#CDD8E4', light: '#FFFFFF', wing: '#E6EDF5', wingShade: '#BCC9D8', beak: '#FF9F1C', beakShade: '#D9800F', eye: '#1B1B1B' },
  { id: 'cayuga', name: 'Midnight', body: '#243333', shade: '#121B1B', light: '#3D6B5C', wing: '#1A2626', wingShade: '#0C1212', beak: '#3A3A3A', beakShade: '#222', eye: '#F5C542', outline: '#000' },
  { id: 'flamingo', name: 'Hot Pink', body: '#FF6FAE', shade: '#D9447F', light: '#FFA3CB', wing: '#FF8DC0', wingShade: '#E0609A', beak: '#FFD23F', beakShade: '#D9AC20', eye: '#1B1B1B' },
  { id: 'sky', name: 'Sky Blue', body: '#5EC8FF', shade: '#2A9BDB', light: '#9BDEFF', wing: '#8AD8FF', wingShade: '#4FB5EE', beak: '#FFB020', beakShade: '#D98F0E', eye: '#1B1B1B' },
  { id: 'royal', name: 'Royal Purple', body: '#8E5BD9', shade: '#6437B3', light: '#B18AF0', wing: '#A77BEA', wingShade: '#7E52CC', beak: '#FFC940', beakShade: '#D9A521', eye: '#1B1B1B' },
  { id: 'tangerine', name: 'Tangerine', body: '#FF7A2F', shade: '#D4541A', light: '#FFA56E', wing: '#FF9A57', wingShade: '#E5702E', beak: '#FFE066', beakShade: '#D9BB40', eye: '#1B1B1B' },
  { id: 'teal', name: 'Teal', body: '#16B8A6', shade: '#0B8577', light: '#4FDCCB', wing: '#3FD4C2', wingShade: '#18A897', beak: '#FFB627', beakShade: '#D9920F', eye: '#1B1B1B' },
  { id: 'cocoa', name: 'Cocoa', body: '#8B5A3C', shade: '#603B25', light: '#B07A57', wing: '#A8734F', wingShade: '#7D5133', beak: '#F2B84B', beakShade: '#C9922E', eye: '#1B1B1B' },
  { id: 'mint', name: 'Mint', body: '#7EE0B5', shade: '#48B98B', light: '#B2F0D4', wing: '#A4EBCB', wingShade: '#66CFA2', beak: '#FF9950', beakShade: '#D97530', eye: '#1B1B1B' },
  { id: 'crimson', name: 'Crimson', body: '#E23D4E', shade: '#AE2334', light: '#F07784', wing: '#EE6470', wingShade: '#C93C4A', beak: '#FFCF4A', beakShade: '#D9AA28', eye: '#1B1B1B' },
  { id: 'gold', name: '24 Karat', body: '#E8B923', shade: '#A9820C', light: '#FFE37A', wing: '#F5D25C', wingShade: '#C9A020', beak: '#E07A10', beakShade: '#B35E08', eye: '#1B1B1B', metallic: true },
  { id: 'navy', name: 'Navy', body: '#2E4A8C', shade: '#1B2F5E', light: '#4D6DB8', wing: '#4A69B5', wingShade: '#2C478A', beak: '#FFB833', beakShade: '#D99416', eye: '#F4F4F4', outline: '#0E1A36' },
  { id: 'lime', name: 'Electric Lime', body: '#A6E22E', shade: '#76A812', light: '#CDF27A', wing: '#C1EE62', wingShade: '#8FC92A', beak: '#FF8C1A', beakShade: '#D96D05', eye: '#1B1B1B' },
  { id: 'steel', name: 'Steel', body: '#8C99AD', shade: '#5F6B7E', light: '#B7C2D2', wing: '#A5B1C2', wingShade: '#748196', beak: '#FFAA2B', beakShade: '#D98A12', eye: '#1B1B1B' },
];

/** Headgear catalogue (drawn procedurally in draw-duck.js). */
export const HATS = [
  { id: 'tophat', name: 'Top Hat' },
  { id: 'crown', name: 'Silver Tiara' }, // silver on purpose: gold is the race leader's floating crown
  { id: 'cowboy', name: 'Cowboy Hat' },
  { id: 'viking', name: 'Viking Helmet' },
  { id: 'pirate', name: 'Pirate Bandana' },
  { id: 'shades', name: 'Aviators' },
  { id: 'headband', name: 'Sweatband' },
  { id: 'bow', name: 'Big Bow' },
  { id: 'propeller', name: 'Propeller Beanie' },
  { id: 'snorkel', name: 'Snorkel' },
  { id: 'chef', name: 'Chef Toque' },
  { id: 'wizard', name: 'Wizard Hat' },
  { id: 'party', name: 'Party Hat' },
  { id: 'flower', name: 'Flower Crown' },
  { id: 'headphones', name: 'Headphones' },
  { id: 'helmet', name: 'Jockey Cap' },
];

/**
 * Post-position saddle towel colours (as used in horse racing), indexed by
 * lane. `text` is the numeral colour.
 */
export const TOWELS = [
  { bg: '#D7263D', text: '#FFFFFF' }, // 1 red
  { bg: '#F4F4F4', text: '#111111' }, // 2 white
  { bg: '#1F5BD8', text: '#FFFFFF' }, // 3 blue
  { bg: '#F5D000', text: '#111111' }, // 4 yellow
  { bg: '#1C8C3C', text: '#FFFFFF' }, // 5 green
  { bg: '#161616', text: '#F5D000' }, // 6 black
  { bg: '#FF7F11', text: '#111111' }, // 7 orange
  { bg: '#FF8FB3', text: '#111111' }, // 8 pink
  { bg: '#17BEBB', text: '#111111' }, // 9 turquoise
  { bg: '#6A2C91', text: '#FFFFFF' }, // 10 purple
  { bg: '#9AA0A6', text: '#B00020' }, // 11 grey
  { bg: '#9BE22D', text: '#111111' }, // 12 lime
  { bg: '#5B3A1E', text: '#FFFFFF' }, // 13 brown
  { bg: '#7A0026', text: '#F5D000' }, // 14 maroon
  { bg: '#C8B88A', text: '#111111' }, // 15 khaki
  { bg: '#8FB8E8', text: '#111111' }, // 16 light blue
];

export const MIN_DUCKS = 2;
export const MAX_DUCKS = 16;

/**
 * Assign a unique palette + hat to each name. Deterministic in (names, salt):
 * each duck "prefers" the palette/hat its name hashes to and collisions are
 * resolved in a stable priority order, so adding a 12th friend rarely changes
 * anyone else's duck.
 * @param {string[]} names
 * @param {number} [salt]
 * @returns {Array<object>} looks, index-aligned with names
 */
export function assignLooks(names, salt = 0) {
  const n = names.length;
  const keyed = names.map((name, i) => {
    const key = `${normalizeName(name)}#${countPrior(names, i)}`;
    return { i, key, h: hashString(key + '|' + salt) };
  });
  // stable priority: by hash, then index
  const priority = keyed.slice().sort((a, b) => a.h - b.h || a.i - b.i);

  const paletteTaken = new Set();
  const hatTaken = new Set();
  const looks = new Array(n);
  for (const entry of priority) {
    const rng = createRng(entry.h ^ 0x9e3779b9);
    const pIdx = claim(hashString('p' + entry.key + salt) % PALETTES.length, PALETTES.length, paletteTaken);
    const hIdx = claim(hashString('h' + entry.key + salt) % HATS.length, HATS.length, hatTaken);
    const palette = PALETTES[pIdx];
    looks[entry.i] = {
      name: names[entry.i],
      lane: entry.i,
      number: entry.i + 1,
      palette,
      hat: HATS[hIdx].id,
      hatName: HATS[hIdx].name,
      towel: TOWELS[entry.i % TOWELS.length],
      // per-duck personality for animation/audio
      scale: rng.range(0.96, 1.05),
      bobPhase: rng.range(0, Math.PI * 2),
      bobRate: rng.range(0.85, 1.15),
      quackPitch: rng.range(0.82, 1.22),
      flapRate: rng.range(0.9, 1.15),
      blinkOffset: rng.range(0, 5),
      cheeks: rng.chance(0.35),
    };
  }
  return looks;
}

function claim(preferred, size, taken) {
  for (let k = 0; k < size; k++) {
    const idx = (preferred + k) % size;
    if (!taken.has(idx)) {
      taken.add(idx);
      return idx;
    }
  }
  // more ducks than options: share (still deterministic)
  return preferred % size;
}

export function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function countPrior(names, i) {
  const me = normalizeName(names[i]);
  let c = 0;
  for (let k = 0; k < i; k++) if (normalizeName(names[k]) === me) c++;
  return c;
}

/** Default roster placeholders. */
export const SAMPLE_NAMES = [
  'Quack Sparrow', 'Duck Norris', 'Mallory', 'Sir Waddles', 'Bill Murray', 'Puddles',
  'Feather Locklear', 'Drake', 'Waddle Dee', 'Eggatha', 'Beak Man', 'Ponderosa',
  'Quackie Chan', 'Webby', 'Duckleberry', 'Fowler',
];
