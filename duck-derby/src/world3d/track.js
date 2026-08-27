// Three-side view of the course: frames along the centre line, banking-aware
// water surface, and helpers to place things in "track space" (s, lateral, height).
import * as THREE from 'three';
import { getCourse } from './course.js';

export const WATER_BANK = 0.5; // how much the water surface super-elevates in banked turns (fraction of duck lean)
/** Banking only tilts the channel itself; beyond the banks the world stays level. */
export const bankLat = (lat, width) => Math.max(-width / 2 - 2, Math.min(width / 2 + 2, lat));

export class Track {
  constructor(course = getCourse()) {
    this.course = course;
    this.length = course.length;
    this.features = course.features;
    this._tmp = {};
    this._a = {};
    this._b = {};
  }

  /** Water surface height at (s, lat) including banking super-elevation. */
  surfaceY(s, lat = 0) {
    const p = this.course.at(s, this._tmp);
    return p.y - bankLat(lat, p.width) * Math.tan(p.bank) * WATER_BANK;
  }

  /**
   * Frame at race distance s. Fills `out` with pos (centre line, on the water),
   * fwd (unit, includes water slope pitch), flat (unit horizontal forward),
   * left (unit horizontal), up, bank, width, section, y, curvature.
   */
  frame(s, out = makeFrame()) {
    const c = this.course;
    const p = c.at(s, this._tmp);
    out.pos.set(p.x, p.y, p.z);
    out.flat.set(p.tx, 0, p.tz);
    out.left.set(p.nx, 0, p.nz);
    const a = c.at(s - 0.75, this._a);
    const b = c.at(s + 0.75, this._b);
    out.fwd.set(b.x - a.x, b.y - a.y, b.z - a.z).normalize();
    out.up.crossVectors(out.fwd, out.left).normalize(); // y-up for a level track
    out.bank = p.bank;
    out.width = p.width;
    out.section = p.section;
    out.y = p.y;
    out.curvature = p.curvature;
    out.s = s;
    return out;
  }

  /** World position for track-space coordinates. h = height above the (banked) water. */
  toWorld(s, lat, h, out = new THREE.Vector3()) {
    const p = this.course.at(s, this._tmp);
    const y = p.y - bankLat(lat, p.width) * Math.tan(p.bank) * WATER_BANK + h;
    return out.set(p.x + p.nx * lat, y, p.z + p.nz * lat);
  }

  /** Nearest race distance s to a world point (coarse search + refine). */
  nearestS(x, z) {
    const c = this.course;
    if (!this._outline) this._outline = c.outline(4);
    let best = 0;
    let bestD = Infinity;
    for (const q of this._outline) {
      const d = (q.x - x) ** 2 + (q.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = q.s;
      }
    }
    // refine
    let lo = best - 4;
    let hi = best + 4;
    for (let k = 0; k < 12; k++) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      const p1 = c.at(m1, this._a);
      const p2 = c.at(m2, this._b);
      const d1 = (p1.x - x) ** 2 + (p1.z - z) ** 2;
      const d2 = (p2.x - x) ** 2 + (p2.z - z) ** 2;
      if (d1 < d2) hi = m2;
      else lo = m1;
    }
    return (lo + hi) / 2;
  }
}

export function makeFrame() {
  return { pos: new THREE.Vector3(), fwd: new THREE.Vector3(), flat: new THREE.Vector3(), left: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), bank: 0, width: 0, section: 'marina', y: 0, curvature: 0, s: 0 };
}
