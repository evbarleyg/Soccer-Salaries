// Seeded randomness utilities. Everything in the race derives from one 32-bit
// seed so any race can be replayed (and audited) exactly.

/** FNV-1a-ish string hash -> uint32 */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // final avalanche
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32 PRNG. Returns a function producing floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rich RNG wrapper with helpers. */
export function createRng(seed) {
  const next = mulberry32(seed);
  const rng = {
    next,
    /** float in [min, max) */
    range(min, max) {
      return min + (max - min) * next();
    },
    /** int in [min, max] inclusive */
    int(min, max) {
      return Math.floor(min + (max - min + 1) * next());
    },
    /** true with probability p */
    chance(p) {
      return next() < p;
    },
    /** standard normal via Box-Muller */
    normal(mean = 0, sd = 1) {
      let u = 0;
      let v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
      return mean + sd * z;
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    /** Fisher-Yates shuffle (returns new array) */
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    /** derive an independent child seed */
    childSeed() {
      return Math.floor(next() * 4294967296) >>> 0;
    },
  };
  return rng;
}

/** Random seed from crypto if available. */
export function randomSeed() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] >>> 0;
  }
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

/** Short human-friendly seed code, e.g. "K7Q2-M9XD". */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
export function seedToCode(seed) {
  let s = seed >>> 0;
  let out = '';
  for (let i = 0; i < 7; i++) {
    out = ALPHABET[s & 31] + out;
    s = Math.floor(s / 32);
  }
  return out.slice(0, 3) + '-' + out.slice(3);
}

export function codeToSeed(code) {
  const clean = String(code || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
  if (!clean) return null;
  if (/^\d+$/.test(clean) && clean.length > 7) {
    // plain integer seed
    const n = Number(clean);
    return Number.isFinite(n) ? n >>> 0 : null;
  }
  let s = 0;
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    s = s * 32 + v;
  }
  return s >>> 0;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
