// Share-link codec. Pure (no DOM) so it runs in Node tests as well as the app.
//
// One `n=` query param per duck, so any manager name — including ones that
// contain '~', '&', '=' or emoji — survives the round trip and the receiving
// side races exactly the same field. Names are sanitised identically on both
// ends (trim, collapse whitespace, truncate, trim again) so both ends hash
// identical looks.
//
// The ONE name-length rule (setup inputs, pasted lists, share links, storage):
// a name is at most NAME_MAX (22) user-perceived characters. With
// Intl.Segmenter that means <= 22 grapheme clusters (hard-capped at 44 code
// points); without it, <= 22 code points. Either way a cut never lands inside
// a cluster: the kept text never stops right before a zero-width joiner, a
// variation selector, a skin-tone modifier, a combining mark or the second
// letter of a flag, and never ends on a joiner — a truncated family emoji or
// flag is dropped whole rather than left as a stray person / letter.

import { seedToCode, codeToSeed } from './rng.js';
import { MIN_DUCKS, MAX_DUCKS } from './ducks.js';

export const NAME_MAX = 22;
export const LEAGUE_MAX = 40;
const DURATIONS = [24, 38, 55];
const RULE_TO_CODE = { 'winner-first': 'w', 'last-first': 'l', 'winner-choice': 'c' };
const CODE_TO_RULE = { w: 'winner-first', l: 'last-first', c: 'winner-choice' };

const ZWJ = '\u200D';
const isRegional = (c) => c >= '\u{1F1E6}' && c <= '\u{1F1FF}';
/** Code points that extend the cluster before them (a cut must never land in front of one). */
const extendsPrev = (c) => c === ZWJ || c === '\uFE0F' || c === '\uFE0E' || (c >= '\u{1F3FB}' && c <= '\u{1F3FF}') || (c >= '\u{E0020}' && c <= '\u{E007F}') || c === '\u20E3' || /^\p{M}$/u.test(c);
/** Is there a cluster boundary between chars[k-1] and chars[k]? (emoji-aware approximation of UAX #29) */
function boundaryBefore(chars, k) {
  if (k <= 0 || k >= chars.length) return true;
  const c = chars[k];
  const p = chars[k - 1];
  if (extendsPrev(c) || p === ZWJ) return false;
  if (isRegional(c) && isRegional(p)) {
    let run = 0; // flags pair up left to right: an odd run before k means p is waiting for c
    for (let j = k - 1; j >= 0 && isRegional(chars[j]); j--) run++;
    if (run % 2 === 1) return false;
  }
  return true;
}
let segmenter = null; // lazily built; looked up per call so a missing Intl.Segmenter (old WebViews) falls back cleanly
function graphemes() {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
  if (!segmenter) segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return segmenter;
}

/**
 * Truncate to `max` user-perceived characters: grapheme clusters when Intl.Segmenter exists (capped at
 * max*2 code points), else code points — never splitting a surrogate pair or an emoji sequence (see top).
 */
export function truncateCodePoints(str, max) {
  const s = String(str ?? '');
  const chars = Array.from(s);
  if (chars.length <= max) return s; // <= max code points is also <= max clusters
  const seg = graphemes();
  let keep = max; // code points to keep
  if (seg) {
    keep = 0;
    let n = 0;
    for (const { segment } of seg.segment(s)) {
      const len = Array.from(segment).length;
      if (n + 1 > max || keep + len > max * 2) break;
      n++;
      keep += len;
    }
    if (keep >= chars.length) return s;
  }
  while (keep > 0 && (!boundaryBefore(chars, keep) || chars[keep - 1] === ZWJ)) keep--;
  return chars.slice(0, keep).join('');
}

/** Canonical form of a duck name: trimmed, single-spaced, at most NAME_MAX characters (see top). Idempotent. */
export function sanitizeName(s) {
  return truncateCodePoints(String(s ?? '').trim().replace(/\s+/g, ' '), NAME_MAX).trim();
}

/** Canonical form of a league name (same rules, 40 characters). */
export function sanitizeLeague(s) {
  return truncateCodePoints(String(s ?? '').trim().replace(/\s+/g, ' '), LEAGUE_MAX).trim();
}

/** How many of these raw names does sanitizeName() shorten (beyond trimming / collapsing spaces)? */
export function shortenedCount(rawNames) {
  let k = 0;
  for (const raw of rawNames || []) {
    const tidy = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (Array.from(sanitizeName(tidy)).length < Array.from(tidy).length) k++;
  }
  return k;
}

/**
 * Build the query string (without '?') for a race.
 * @param {{names:string[], seed:number|null, duration:number, rule:string, salt?:number, hazards?:boolean, league?:string}} race
 */
export function encodeShare({ names, seed, duration, rule, salt = 0, hazards = true, league = '' }) {
  const p = new URLSearchParams();
  for (const name of names) p.append('n', sanitizeName(name));
  if (seed !== null && seed !== undefined) p.set('seed', seedToCode(seed));
  p.set('len', String(duration));
  p.set('rule', RULE_TO_CODE[rule] || 'w');
  if (Number.isSafeInteger(salt) && salt !== 0) p.set('salt', String(salt));
  if (hazards === false) p.set('hz', '0');
  const lg = sanitizeLeague(league);
  if (lg) p.set('lg', lg);
  return p.toString();
}

/**
 * Parse a location.search string. Returns null when it is not a share link
 * (no `n`/`names` param) or when the duck count is out of range.
 * Legacy links joined names with '~' in a single `names` param; that form is
 * only honoured when no `n` param is present.
 * @param {string} search
 */
export function decodeShare(search) {
  const p = new URLSearchParams(String(search ?? ''));
  let raw;
  if (p.has('n')) raw = p.getAll('n');
  else if (p.has('names')) raw = String(p.get('names')).split('~');
  else return null;
  const names = raw.map(sanitizeName);
  if (names.length < MIN_DUCKS || names.length > MAX_DUCKS) return null;
  const len = Number(p.get('len'));
  const salt = p.has('salt') ? Number(p.get('salt')) : 0;
  return {
    names,
    seed: codeToSeed(p.get('seed')),
    duration: DURATIONS.includes(len) ? len : 38,
    rule: CODE_TO_RULE[p.get('rule')] || 'winner-first',
    salt: Number.isSafeInteger(salt) ? salt : 0,
    hazards: p.get('hz') !== '0',
    league: sanitizeLeague(p.get('lg')),
  };
}
