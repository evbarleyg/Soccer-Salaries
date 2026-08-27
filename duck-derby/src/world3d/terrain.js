// Procedural terrain: one vertex-coloured low-poly heightfield carved by the
// river. Each vertex looks up its nearest point on the course and takes a
// cross-section profile that depends (smoothly) on the section there: quays in
// the marina, tall warm cliffs in the canyon, flat marsh around the lily pond,
// a hill over the tunnel (with a slot cut for the flume), rocky banks in the
// rapids, a quay on the town side of the harbour and open sea on the other.
import * as THREE from 'three';
import { PAL, fbm2, noise2, hash2 } from './gfx.js';
import { clamp, smoothstep, lerp } from '../rng.js';
import { WATER_BANK } from './track.js';

export const SEA_LEVEL = -5.7;
const GRID = 3.5;

/** Smooth 0..1 membership of s in [a, b] with soft edges of width e. */
const band = (s, a, b, e) => smoothstep(a - e, a + e, s) * (1 - smoothstep(b - e, b + e, s));

/** Cross-section profile parameters at race distance s (all smooth in s). */
export function profileAt(course, s) {
  const F = course.features;
  const p = course.at(s);
  const half = p.width / 2;
  const marina = 1 - smoothstep(F.canyonInS - 34, F.canyonInS + 4, s);
  const canyon = band(s, F.canyonInS + 2, F.lilyInS - 8, 14);
  const lily = band(s, F.lilyInS, F.dropApproachS - 6, 12);
  const drop = band(s, F.dropApproachS, F.tunnelInS - 6, 8);
  const tunnel = band(s, F.tunnelInS + 2, F.tunnelOutS - 2, 5);
  const rapids = band(s, F.tunnelOutS, F.harborInS - 10, 10);
  const harbor = smoothstep(F.harborInS - 30, F.harborInS + 5, s);
  // visual water half-width per side (L = left/north-ish, R = right)
  const visBase = half + 0.5 + lily * 22 + drop * 2.5 + rapids * 2.5;
  const visL = lerp(lerp(visBase, 38, marina), 95, harbor);
  const visR = lerp(lerp(visBase, 38, marina), 21, harbor);
  const bankH = 0.35 + marina * 1.1 + canyon * 16 + lily * 0.25 + drop * 4.5 + rapids * 2.8 + harbor * 1.2;
  const slopeW = 1.2 + canyon * 5 + lily * 9 + drop * 3 + rapids * 4 + marina * 0.3 + harbor * 0.3;
  return { s, x: p.x, z: p.z, y: p.y, bank: p.bank, nx: p.nx, nz: p.nz, tx: p.tx, tz: p.tz, half, visL, visR, bankH, slopeW, marina, canyon, lily, drop, tunnel, rapids, harbor, section: p.section };
}

export function buildTerrain(course) {
  const F = course.features;
  // course samples every 3 m with profiles
  const samples = [];
  for (let s = F.minS; s <= F.maxS; s += 3) samples.push(profileAt(course, s));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const q of samples) {
    minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
    minZ = Math.min(minZ, q.z); maxZ = Math.max(maxZ, q.z);
  }
  minX -= 150; maxX += 170; minZ -= 160; maxZ += 140;
  const nx = Math.ceil((maxX - minX) / GRID) + 1;
  const nz = Math.ceil((maxZ - minZ) / GRID) + 1;

  // spatial hash of samples for nearest lookup
  const CELL = 24;
  const grid = new Map();
  samples.forEach((q, i) => {
    const k = `${Math.floor(q.x / CELL)},${Math.floor(q.z / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  function nearest(x, z) {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best = -1;
    let bestD = Infinity;
    for (let r = 0; r <= 8; r++) {
      if (best >= 0 && (r - 1) * CELL > Math.sqrt(bestD)) break;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const cell = grid.get(`${cx + dx},${cz + dz}`);
          if (!cell) continue;
          for (const i of cell) {
            const q = samples[i];
            const d = (q.x - x) ** 2 + (q.z - z) ** 2;
            if (d < bestD) { bestD = d; best = i; }
          }
        }
      }
    }
    if (best < 0) {
      // far away: brute force
      for (let i = 0; i < samples.length; i++) {
        const q = samples[i];
        const d = (q.x - x) ** 2 + (q.z - z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    return best;
  }

  /** Height + colour info at world (x, z). */
  function evaluate(x, z) {
    const i = nearest(x, z);
    const q = samples[i];
    const dxw = x - q.x;
    const dzw = z - q.z;
    const lat = dxw * q.nx + dzw * q.nz; // + = left of the course
    const d = Math.abs(lat);
    const dist = Math.hypot(dxw, dzw);
    const vis = lat >= 0 ? q.visL : q.visR;
    const waterY = q.y - lat * Math.tan(q.bank) * WATER_BANK;
    const hills = fbm2(x * 0.012, z * 0.012, 4); // 0..1
    const bumps = fbm2(x * 0.05 + 7, z * 0.05 - 3, 3);
    let h;
    let kind; // for colouring
    const seaSide = q.harbor > 0.5 && lat > 0;
    if (seaSide || (q.harbor > 0.5 && dist > 140)) {
      h = SEA_LEVEL - 3.5 - 2 * hills;
      kind = 'bed';
    } else if (d < vis) {
      // river / basin bed
      h = waterY - 1.6 - 0.8 * bumps;
      kind = 'bed';
      if (q.tunnel > 0.02) {
        // hill over the tunnel (a slot is cut out of the mesh along the flume)
        h = lerp(h, waterY + 10 + 5 * hills, q.tunnel);
        kind = 'hill';
      }
    } else {
      const e = (d - vis) / q.slopeW; // 0 at the water's edge, 1 at the top of the bank
      const t = clamp(e, 0, 1);
      const cliffNoise = q.canyon * (5 * fbm2(x * 0.07, z * 0.07, 3) - 1.5);
      const top = waterY + q.bankH + cliffNoise * t;
      h = lerp(waterY - 0.35, top, t < 1 ? Math.pow(t, lerp(1, 0.55, q.canyon)) : 1);
      kind = t < 0.999 ? 'bank' : 'top';
      if (e > 1) {
        // beyond the bank: gentle ground, then hills rising with distance to close the world in
        const far = d - vis - q.slopeW;
        const flat = 18 + 30 * q.marina + 20 * q.harbor + 10 * q.lily;
        const rise = smoothstep(flat, flat + 90, far);
        h += (0.6 * bumps - 0.2) * smoothstep(0, 12, far) * (1 - 0.7 * q.marina) * (1 - 0.7 * q.harbor);
        h += rise * (14 + 26 * hills) + q.canyon * smoothstep(0, 40, far) * 6 * hills;
        if (q.tunnel > 0.02) h = Math.max(h, lerp(h, waterY + 10 + 6 * hills, q.tunnel * (1 - smoothstep(25, 60, far))));
        kind = rise > 0.55 ? 'hill' : 'top';
      }
    }
    return { h, kind, q, lat, d, dist, waterY, hills, bumps };
  }

  const positions = new Float32Array(nx * nz * 3);
  const colors = new Float32Array(nx * nz * 3);
  const info = new Array(nx * nz);
  const col = new THREE.Color();
  const cA = new THREE.Color();
  const C = {
    grass: new THREE.Color(PAL.grass), grassDark: new THREE.Color(PAL.grassDark), grassLight: new THREE.Color(PAL.grassLight),
    meadow: new THREE.Color(PAL.meadow), sand: new THREE.Color(PAL.sand), mud: new THREE.Color(PAL.mud), rock: new THREE.Color(PAL.rock),
    rockDark: new THREE.Color(PAL.rockDark), cliff: new THREE.Color(PAL.cliff), cliffDark: new THREE.Color(PAL.cliffDark),
    quay: new THREE.Color(PAL.quay), marsh: new THREE.Color(PAL.marsh), bed: new THREE.Color(0x2f5a57), snow: new THREE.Color(PAL.snow),
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = minX + i * GRID;
      const z = minZ + j * GRID;
      const ev = evaluate(x, z);
      const k = j * nx + i;
      info[k] = ev;
      positions[k * 3] = x;
      positions[k * 3 + 1] = ev.h;
      positions[k * 3 + 2] = z;
      // colour
      const q = ev.q;
      const tint = 0.88 + 0.24 * hash2(i * 0.7, j * 1.3);
      if (ev.kind === 'bed') col.copy(C.bed);
      else if (ev.kind === 'bank') {
        col.copy(C.sand).lerp(C.mud, 0.5 * q.lily).lerp(C.rock, Math.min(1, q.rapids + q.drop)).lerp(C.cliff, q.canyon).lerp(C.quay, Math.max(q.marina, q.harbor));
        if (q.canyon > 0.3) col.lerp(C.cliffDark, 0.45 * noise2(x * 0.15, ev.h * 0.4));
      } else if (ev.kind === 'hill') {
        col.copy(C.grassDark).lerp(C.grass, ev.hills).lerp(C.rock, smoothstep(22, 34, ev.h - ev.waterY) * 0.6);
      } else {
        col.copy(C.grass).lerp(C.meadow, ev.bumps).lerp(C.marsh, 0.6 * q.lily).lerp(C.quay, 0.85 * Math.max(q.marina * (1 - smoothstep(30, 60, ev.d - 38)), q.harbor * (1 - smoothstep(10, 40, ev.d - 21))));
        if (q.canyon > 0.3) col.lerp(C.cliff, 0.35 * q.canyon * (1 - smoothstep(0, 25, ev.d - q.visL - q.slopeW)));
      }
      col.multiplyScalar(tint);
      colors[k * 3] = col.r;
      colors[k * 3 + 1] = col.g;
      colors[k * 3 + 2] = col.b;
    }
  }
  // slope-based rock tint (second pass using neighbours)
  for (let j = 1; j < nz - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      const hL = positions[(k - 1) * 3 + 1];
      const hR = positions[(k + 1) * 3 + 1];
      const hD = positions[(k - nx) * 3 + 1];
      const hU = positions[(k + nx) * 3 + 1];
      const slope = Math.hypot(hR - hL, hU - hD) / (2 * GRID);
      if (slope > 0.9 && info[k].kind !== 'bed') {
        cA.setRGB(colors[k * 3], colors[k * 3 + 1], colors[k * 3 + 2]);
        const rockCol = info[k].q.canyon > 0.3 ? C.cliffDark : C.rockDark;
        cA.lerp(rockCol, clamp((slope - 0.9) * 0.8, 0, 0.75));
        colors[k * 3] = cA.r; colors[k * 3 + 1] = cA.g; colors[k * 3 + 2] = cA.b;
      }
    }
  }

  // indices, skipping the slot over the flume so the tunnel tube can sit in it
  const idx = [];
  const inSlot = (k) => {
    const ev = info[k];
    return ev.q.tunnel > 0.02 && ev.d < ev.q.half + 3.2 && ev.q.s > F.tunnelInS - 4 && ev.q.s < F.tunnelOutS + 4;
  };
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      if (inSlot(a) || inSlot(b) || inSlot(c) || inSlot(d)) continue;
      // alternate diagonal for a nicer low-poly look
      if ((i + j) % 2 === 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, c, d, a, d, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  /** Bilinear height lookup at world (x, z). */
  function heightAt(x, z) {
    const fi = (x - minX) / GRID;
    const fj = (z - minZ) / GRID;
    const i = clamp(Math.floor(fi), 0, nx - 2);
    const j = clamp(Math.floor(fj), 0, nz - 2);
    const u = clamp(fi - i, 0, 1);
    const v = clamp(fj - j, 0, 1);
    const k = j * nx + i;
    const h00 = positions[k * 3 + 1];
    const h10 = positions[(k + 1) * 3 + 1];
    const h01 = positions[(k + nx) * 3 + 1];
    const h11 = positions[(k + nx + 1) * 3 + 1];
    return lerp(lerp(h00, h10, u), lerp(h01, h11, u), v);
  }

  return { mesh, heightAt, evaluate, samples, bounds: { minX, maxX, minZ, maxZ }, profileAt: (s) => profileAt(course, s) };
}
