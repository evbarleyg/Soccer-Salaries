// URL parameters <-> race config. Mirrors the 2D app's conventions so links
// feel familiar: names=a~b~c, seed=XXXX-XXXX, rule=w|l, hz=0, plus the 3D
// extras cam=<name|1-based lane>, view=chase|tv|free, items=0, autostart=1.

import { codeToSeed, seedToCode } from '../rng.js';
import { MIN_DUCKS, MAX_DUCKS, normalizeName } from '../ducks.js';

export const VIEWS = ['chase', 'tv', 'free'];

/** @param {string|URLSearchParams} search */
export function parseParams(search) {
  const p = search instanceof URLSearchParams ? search : new URLSearchParams(search);
  const out = { names: null, seed: null, rule: 'w', hazards: true, items: true, cam: null, view: null, autostart: false, muted: false, t: null, salt: 0 };
  const namesRaw = p.get('names');
  if (namesRaw) {
    const names = namesRaw.split('~').map((s) => s.trim().slice(0, 22)).filter((s) => s.length);
    if (names.length >= MIN_DUCKS && names.length <= MAX_DUCKS) out.names = names;
  }
  const seed = codeToSeed(p.get('seed'));
  if (seed !== null) out.seed = seed;
  out.rule = p.get('rule') === 'l' ? 'l' : 'w';
  out.hazards = p.get('hz') !== '0';
  out.items = p.get('items') !== '0';
  const view = p.get('view');
  if (VIEWS.includes(view)) out.view = view;
  const cam = p.get('cam');
  if (cam) out.cam = cam;
  out.autostart = p.get('autostart') === '1';
  out.muted = p.get('sound') === '0';
  const salt = Number(p.get('salt'));
  if (Number.isInteger(salt) && salt >= 0) out.salt = salt;
  const t = Number(p.get('t'));
  if (p.get('t') !== null && Number.isFinite(t)) out.t = t;
  return out;
}

/** Resolve cam=<name | 1-based lane> against a roster; returns duck index or -1. */
export function resolveCam(cam, names) {
  if (cam == null || !names) return -1;
  const s = String(cam).trim();
  if (/^\d+$/.test(s)) {
    const lane = Number(s);
    if (lane >= 1 && lane <= names.length) return lane - 1;
  }
  const norm = normalizeName(s);
  const idx = names.findIndex((n) => normalizeName(n) === norm);
  return idx;
}

/** Build the shareable query string for a race (no cam: everyone picks their own). */
export function buildQuery({ names, seed, rule = 'w', hazards = true, items = true, cam = null, view = null, salt = 0 }) {
  const p = new URLSearchParams();
  p.set('names', names.join('~'));
  if (seed != null) p.set('seed', seedToCode(seed));
  p.set('rule', rule === 'l' ? 'l' : 'w');
  if (!hazards) p.set('hz', '0');
  if (!items) p.set('items', '0');
  if (salt) p.set('salt', String(salt));
  if (cam != null && cam !== '') p.set('cam', String(cam));
  if (view) p.set('view', view);
  return p.toString();
}

/** Draft order from a finishing order (array of duck indices, winner first). */
export function draftOrder(order, rule) {
  return rule === 'l' ? order.slice().reverse() : order.slice();
}
