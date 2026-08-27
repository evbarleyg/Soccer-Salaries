// Share-link codec. Pure (no DOM) so it runs in Node tests as well as the app.
//
// One `n=` query param per duck, so any manager name — including ones that
// contain '~', '&', '=' or emoji — survives the round trip and the receiving
// side races exactly the same field. Names are sanitised identically on both
// ends (trim, collapse whitespace, truncate by code points) so both ends hash
// identical looks.

import { seedToCode, codeToSeed } from './rng.js';
import { MIN_DUCKS, MAX_DUCKS } from './ducks.js';

export const NAME_MAX = 22;
export const LEAGUE_MAX = 40;
const DURATIONS = [24, 38, 55];
const RULE_TO_CODE = { 'winner-first': 'w', 'last-first': 'l', 'winner-choice': 'c' };
const CODE_TO_RULE = { w: 'winner-first', l: 'last-first', c: 'winner-choice' };

/** Truncate to `max` Unicode code points (never splits a surrogate pair). */
export function truncateCodePoints(str, max) {
  const chars = Array.from(String(str ?? ''));
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

/** Canonical form of a duck name: trimmed, single-spaced, at most 22 code points. */
export function sanitizeName(s) {
  return truncateCodePoints(String(s ?? '').trim().replace(/\s+/g, ' '), NAME_MAX);
}

/** Canonical form of a league name (same rules, 40 code points). */
export function sanitizeLeague(s) {
  return truncateCodePoints(String(s ?? '').trim().replace(/\s+/g, ' '), LEAGUE_MAX);
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
