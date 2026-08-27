// Procedural terrain: one vertex-coloured low-poly heightfield carved by the
// river. Each vertex looks up its nearest point on the course and takes a
// cross-section profile that depends (smoothly) on the section there: quays in
// the marina, flat marsh around the lily pond, a hill over the tunnel rising
// just outside the flume tube, a quay on the town side of the harbour and open
// sea on the other. The canyon's terraced cliffs and the rapids' granite ledges
// are dedicated strip meshes (cliffs.js) parented to this mesh; through those
// stretches the heightfield stays under the water in front of the strips and
// only comes up to rim height behind them.
import * as THREE from 'three';
import { PAL, fbm2, noise2, hash2 } from './gfx.js';
import { clamp, smoothstep, lerp } from '../rng.js';
import { WATER_BANK, bankLat } from './track.js';
import { buildCliffs, wallZone, plateauY } from './cliffs.js';

export const SEA_LEVEL = -5.7;
const GRID = 3.5;
const JITTER = 1.1; // +-m of x/z jitter on interior vertices (kills the visible grid)

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
  // soft-bank height/width (the canyon cliffs and rapids ledges are separate strip meshes, see cliffs.js)
  const bankH = 0.35 + marina * 1.1 + lily * 0.25 + drop * 4.5 + rapids * 2.8 + harbor * 1.2;
  const slopeW = 1.2 + canyon * 5 + lily * 4 + drop * 3 + rapids * 4 + marina * 0.3 + harbor * 0.3;
  return { s, x: p.x, z: p.z, y: p.y, bank: p.bank, nx: p.nx, nz: p.nz, tx: p.tx, tz: p.tz, half, visL, visR, bankH, slopeW, marina, canyon, lily, drop, tunnel, rapids, harbor, section: p.section };
}

/**
 * Lateral distance from the centre line to the nominal shoreline on one side (+1 left / -1 right):
 * the foot of a terrace wall where the bank is a strip mesh, else where the soft bank breaks the surface.
 */
export function shorelineAt(course, prof, side) {
  const vis = side > 0 ? prof.visL : prof.visR;
  const zn = wallZone(course, prof, side, 'canyon') || wallZone(course, prof, side, 'rapids');
  const soft = vis + (0.35 / (prof.bankH + 0.35)) * prof.slopeW;
  return zn ? lerp(soft, vis + 0.1, zn.on) : soft;
}

export function buildTerrain(course) {
  const F = course.features;
  // course samples every 3 m with profiles (+ wall zones where the banks are strip meshes)
  const samples = [];
  for (let s = F.minS; s <= F.maxS; s += 3) {
    const q = profileAt(course, s);
    q.zoneL = wallZone(course, q, 1, 'canyon') || wallZone(course, q, 1, 'rapids');
    q.zoneR = wallZone(course, q, -1, 'canyon') || wallZone(course, q, -1, 'rapids');
    samples.push(q);
  }
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
  const cellKey = (cx, cz) => (cx + 4096) * 8192 + (cz + 4096); // integer key (much faster than string keys)
  const grid = new Map();
  samples.forEach((q, i) => {
    const k = cellKey(Math.floor(q.x / CELL), Math.floor(q.z / CELL));
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
          const cell = grid.get(cellKey(cx + dx, cz + dz));
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

  /** Track coordinates (s, lateral; + = left) of world (x, z), refined along the local tangent. */
  function locate(x, z) {
    const q = samples[nearest(x, z)];
    const dx = x - q.x;
    const dz = z - q.z;
    return { q, s: q.s + dx * q.tx + dz * q.tz, lat: dx * q.nx + dz * q.nz };
  }

  const ZONE_KEYS = ['on', 'vis', 'H', 'D1', 'D2', 'DS', 'yFoot', 'under', 'liftFrom'];
  /** Wall zone at a vertex, blended between the nearest sample and its neighbour along the course (no 3 m steps). */
  function zoneAt(i, lat, ds) {
    const q = samples[i];
    const a = lat >= 0 ? q.zoneL : q.zoneR;
    if (!a) return null;
    const j = ds >= 0 ? Math.min(i + 1, samples.length - 1) : Math.max(i - 1, 0);
    const b = lat >= 0 ? samples[j].zoneL : samples[j].zoneR;
    if (!b || j === i) return a;
    const w = Math.min(0.5, Math.abs(ds) / 3);
    const out = { kind: a.kind };
    for (const key of ZONE_KEYS) out[key] = lerp(a[key], b[key], w);
    return out;
  }

  /** Height + colour info at world (x, z). `hint` = index of the nearest course sample when already known. */
  function evaluate(x, z, hint = -1) {
    const i = hint >= 0 ? hint : nearest(x, z);
    const q = samples[i];
    const dxw = x - q.x;
    const dzw = z - q.z;
    const lat = dxw * q.nx + dzw * q.nz; // + = left of the course
    const ds = dxw * q.tx + dzw * q.tz; // along-course offset from the sample
    const d = Math.abs(lat);
    const dist = Math.hypot(dxw, dzw);
    const vis = lat >= 0 ? q.visL : q.visR;
    const waterY = q.y - bankLat(lat, q.half * 2) * Math.tan(q.bank) * WATER_BANK;
    const hills = fbm2(x * 0.012, z * 0.012, 4); // 0..1
    const bumps = fbm2(x * 0.05 + 7, z * 0.05 - 3, 3);
    let h;
    let kind; // for colouring
    const seaSide = q.harbor > 0.5 && lat > 0;
    if (seaSide || (q.harbor > 0.5 && dist > 140)) {
      h = SEA_LEVEL - 3.5 - 2 * hills;
      kind = 'bed';
    } else if (d < vis) {
      // river / basin bed (sunk well below the plunge pool around the weir so nothing pokes through the sheet)
      const weir = smoothstep(F.dropLipS - 8, F.dropLipS - 1, q.s) * (1 - smoothstep(F.dropLandS, F.dropLandS + 10, q.s));
      h = waterY - 1.6 - 0.8 * bumps - 5.5 * weir;
      kind = 'bed';
    } else {
      // soft bank: quay / beach / rocky slope rising over slopeW, then gentle ground and distant hills
      const e = (d - vis) / q.slopeW; // 0 at the water's edge, 1 at the top of the bank
      const t = clamp(e, 0, 1);
      h = lerp(waterY - 0.35, waterY + q.bankH, t);
      kind = t < 0.999 ? 'bank' : 'top';
      if (e > 1) {
        // beyond the bank: gentle ground, then hills rising with distance to close the world in
        const far = d - vis - q.slopeW;
        const flat = 18 + 30 * q.marina + 20 * q.harbor + 10 * q.lily;
        const rise = smoothstep(flat, flat + 90, far);
        h += (0.6 * bumps - 0.2) * smoothstep(0, 12, far) * (1 - 0.7 * q.marina) * (1 - 0.7 * q.harbor);
        h += rise * (14 + 26 * hills) + q.canyon * smoothstep(0, 40, far) * 6 * hills;
        kind = rise > 0.55 ? 'hill' : 'top';
      }
      // walled banks (canyon terraces, rapids ledges): under water in front of / beneath the strips,
      // a hidden ramp behind them, then the plateau the rim shelf blends into
      const zn = zoneAt(i, lat, ds);
      if (zn) {
        let hc;
        let kc;
        const toe = zn.yFoot - zn.under - 0.4 * bumps;
        if (d <= zn.D1) { hc = toe; kc = 'toe'; }
        else if (d < zn.D2) { hc = lerp(toe, plateauY(zn, zn.D2), (d - zn.D1) / (zn.D2 - zn.D1)); kc = 'cliff'; }
        else {
          const far = d - zn.DS;
          const fade = smoothstep(1, 12, far);
          const flat = 18 + 10 * q.lily;
          const rise = smoothstep(flat, flat + 90, far);
          hc = plateauY(zn, d) + fade * (0.7 * bumps - 0.25 + rise * (14 + 26 * hills) + (zn.kind === 'canyon' ? smoothstep(0, 40, far) * 6 * hills : 0));
          kc = rise * fade > 0.55 ? 'hill' : 'top';
        }
        h = lerp(h, hc, zn.on);
        if (zn.on > 0.5) kind = kc;
      }
    }
    // the hill the flume tunnels through: rises steeply just outside the wooden tube
    // (nothing is raised over the tube footprint itself, so no terrain ever pokes into it)
    if (q.tunnel > 0.02 && !seaSide) {
      const hh = waterY + 10 + 6 * hills - 0.5 * bumps;
      const kLat = smoothstep(q.half + 2.3, q.half + 6.5, d);
      const k = q.tunnel * kLat * (1 - smoothstep(30, 66, d));
      if (k > 0) {
        h = lerp(h, Math.max(h, hh), k);
        if (k > 0.3) kind = 'hill';
      }
    }
    return { h, kind, q, lat, d, dist, waterY, hills, bumps };
  }

  /** 0..1: how much a grid vertex at nominal (x, z) may be jittered sideways (+ the nearest sample index). */
  function jitterWeight(x, z) {
    const ni = nearest(x, z);
    const q = samples[ni];
    const lat = (x - q.x) * q.nx + (z - q.z) * q.nz;
    const d = Math.abs(lat);
    const vis = lat >= 0 ? q.visL : q.visR;
    let w = 1;
    // keep quay edges straight
    w *= 1 - 0.95 * Math.max(q.marina, q.harbor) * (1 - smoothstep(3, 10, Math.abs(d - vis)));
    // keep the hill snug (and predictable) around the flume tube, and the weir's edges clean
    if (q.tunnel > 0.01 && d < q.half + 9) w = 0;
    if (q.drop > 0.3 && d < vis + 6) w = 0;
    // exact fit under the rim shelf of the walled banks
    const zn = lat >= 0 ? q.zoneL : q.zoneR;
    if (zn && d > zn.vis - 2 && d < zn.DS + 9) w = 0;
    return { w, ni };
  }

  const positions = new Float32Array(nx * nz * 3);
  const colors = new Float32Array(nx * nz * 3);
  const info = new Array(nx * nz);
  const col = new THREE.Color();
  const cA = new THREE.Color();
  const cA2 = new THREE.Vector3();
  const C = {
    grass: new THREE.Color(PAL.grass), grassDark: new THREE.Color(PAL.grassDark), grassLight: new THREE.Color(PAL.grassLight),
    meadow: new THREE.Color(PAL.meadow), sand: new THREE.Color(PAL.sand), mud: new THREE.Color(PAL.mud), rock: new THREE.Color(PAL.rock),
    rockDark: new THREE.Color(PAL.rockDark), cliff: new THREE.Color(PAL.cliff), cliffDark: new THREE.Color(PAL.cliffDark),
    quay: new THREE.Color(PAL.quay), quayFace: new THREE.Color(PAL.quayFace), marsh: new THREE.Color(PAL.marsh), bed: new THREE.Color(0x2f5a57), snow: new THREE.Color(PAL.snow),
    strata0: new THREE.Color(PAL.strata[0]), granite: new THREE.Color(PAL.graniteDark),
    flowerY: new THREE.Color(0xf2e07a), flowerP: new THREE.Color(0xe8a0c8), hedge: new THREE.Color(0x4f8a3c),
  };
  /**
   * Field pattern at world (x, z): ~60 m cells with wobbly borders. Returns the cell's mowing-stripe phase
   * (0/1, direction hashed per cell, some cells unmown = -1), distance to the nearest border (m) and a
   * per-cell flower hue pick.
   */
  const FIELD = 60;
  function fieldAt(x, z) {
    const wx = x + 16 * (noise2(x * 0.011 + 5, z * 0.011) - 0.5);
    const wz = z + 16 * (noise2(x * 0.011 - 9, z * 0.011 + 4) - 0.5);
    const fx = wx / FIELD;
    const fz = wz / FIELD;
    const cx = Math.floor(fx);
    const cz = Math.floor(fz);
    const ux = fx - cx;
    const uz = fz - cz;
    const border = Math.min(ux, 1 - ux, uz, 1 - uz) * FIELD;
    const hc = hash2(cx * 1.71 + 0.3, cz * 2.37 + 1.1);
    let stripe = -1;
    if (hc > 0.3) {
      const ang = hash2(cx * 0.53 + 7, cz * 0.91 + 3) * Math.PI;
      stripe = Math.floor((x * Math.cos(ang) + z * Math.sin(ang)) / 9) & 1;
    }
    return { stripe, border, hue: hash2(cx + 0.5, cz + 0.25) };
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      let x = minX + i * GRID;
      let z = minZ + j * GRID;
      let hint = -1;
      if (i > 0 && j > 0 && i < nx - 1 && j < nz - 1) {
        const { w, ni } = jitterWeight(x, z);
        if (w > 0) {
          x += (hash2(i * 0.913 + 3.1, j * 1.117) - 0.5) * 2 * JITTER * w;
          z += (hash2(i * 1.271 + 5.3, j * 0.697 + 11) - 0.5) * 2 * JITTER * w;
        } else hint = ni; // unmoved: the nearest sample is already known
      }
      // straight quay walls: pull the two vertex rings nearest a quay edge exactly onto the wall foot / cap edge
      // so the rendered waterline runs dead straight under the (straight) shoreline foam
      if (i > 0 && j > 0 && i < nx - 1 && j < nz - 1) {
        const loc = locate(x, z);
        const q0 = loc.q;
        const quayK = Math.max(smoothstep(0.6, 0.8, q0.marina), loc.lat < 0 ? smoothstep(0.6, 0.8, q0.harbor) : 0);
        if (quayK > 0) {
          const vis = loc.lat >= 0 ? q0.visL : q0.visR;
          const d = Math.abs(loc.lat);
          let target = null;
          if (d >= vis - GRID * 0.5 && d < vis + GRID * 0.5) target = vis + 0.02;
          else if (d >= vis + GRID * 0.5 && d < vis + GRID * 1.5) target = vis + q0.slopeW + 0.02;
          if (target !== null) {
            const shift = (target - d) * quayK * Math.sign(loc.lat);
            x += q0.nx * shift;
            z += q0.nz * shift;
            hint = -1;
          }
        }
      }
      const ev = evaluate(x, z, hint);
      const k = j * nx + i;
      info[k] = ev;
      positions[k * 3] = x;
      positions[k * 3 + 1] = ev.h;
      positions[k * 3 + 2] = z;
      // colour
      const q = ev.q;
      const tint = 0.95 + 0.1 * hash2(i * 0.7, j * 1.3);
      const pn = fbm2(x * 0.03 + 11, z * 0.03 + 3, 2);
      const patch = smoothstep(0.52, 0.66, pn); // low-frequency light-grass patches
      const shade = 1 - smoothstep(0.24, 0.36, pn); // ...and darker ones
      if (ev.kind === 'bed' || ev.kind === 'toe') col.copy(C.bed);
      else if (ev.kind === 'cliff') col.copy(q.canyon > 0.3 ? C.strata0 : C.granite);
      else if (ev.kind === 'bank') {
        col.copy(C.sand).lerp(C.mud, 0.55 * q.lily * noise2(x * 0.2, z * 0.2)).lerp(C.rock, Math.min(1, q.rapids + q.drop)).lerp(C.quayFace, Math.max(q.marina, q.harbor));
      } else if (ev.kind === 'hill') {
        col.copy(C.grassDark).lerp(C.grass, ev.hills).lerp(C.grassLight, patch * 0.5).lerp(C.rock, smoothstep(16, 30, ev.h - ev.waterY) * 0.6);
      } else {
        col.copy(C.grass).lerp(C.meadow, 0.5 * ev.bumps).lerp(C.grassLight, patch * 0.85).lerp(C.grassDark, shade * 0.45).lerp(C.marsh, 0.45 * q.lily * (1 - smoothstep(0, 14, ev.d - (ev.lat >= 0 ? q.visL : q.visR) - q.slopeW)));
        // stone quay caps around the marina basin and along the harbour's town side
        const quayK = 0.9 * Math.max(q.marina * (1 - smoothstep(30, 60, ev.d - 38)), q.harbor * (ev.lat < 0 ? 1 - smoothstep(10, 40, ev.d - 21) : 0));
        if (quayK < 0.3 && ev.kind === 'top') {
          // farmland dressing: hedgerow lines along the field-cell borders and meadow-flower speckle patches
          const fld = fieldAt(x, z);
          if (fld.border < 1.8) col.lerp(C.hedge, 0.55 * (1 - fld.border / 1.8));
          const fp = noise2(x * 0.045 + 21, z * 0.045 - 13);
          if (fp > 0.7 && hash2(i * 2.13 + 0.7, j * 3.71 + 0.2) > 0.45) col.lerp(fld.hue > 0.5 ? C.flowerY : C.flowerP, 0.12 + 0.1 * (fp - 0.7) / 0.3);
        }
        col.lerp(C.quay, quayK);
      }
      col.multiplyScalar(tint);
      colors[k * 3] = col.r;
      colors[k * 3 + 1] = col.g;
      colors[k * 3 + 2] = col.b;
    }
  }
  // second pass using neighbours: slope-based rock tint (capped so shadow sides don't go murky) and, on flat
  // open ground, mown-field striping (+-4% luminance, direction hashed per field cell)
  for (let j = 1; j < nz - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      const ev = info[k];
      const kindK = ev.kind;
      if (kindK === 'bed' || kindK === 'toe' || kindK === 'cliff' || kindK === 'bank') continue;
      const hL = positions[(k - 1) * 3 + 1];
      const hR = positions[(k + 1) * 3 + 1];
      const hD = positions[(k - nx) * 3 + 1];
      const hU = positions[(k + nx) * 3 + 1];
      const slope = Math.hypot(hR - hL, hU - hD) / (2 * GRID);
      if (slope > 0.9) {
        cA.setRGB(colors[k * 3], colors[k * 3 + 1], colors[k * 3 + 2]);
        cA.lerp(C.rockDark, clamp((slope - 0.9) * 0.6, 0, 0.2));
        colors[k * 3] = cA.r; colors[k * 3 + 1] = cA.g; colors[k * 3 + 2] = cA.b;
      } else if (slope < 0.15 && kindK === 'top') {
        const q = ev.q;
        const open = (1 - q.marina * (1 - smoothstep(30, 70, ev.d - 38))) * (1 - q.harbor * (ev.lat < 0 ? 1 - smoothstep(10, 50, ev.d - 21) : 0)) * (1 - 0.8 * q.lily);
        if (open > 0.5) {
          const fld = fieldAt(positions[k * 3], positions[k * 3 + 2]);
          if (fld.stripe >= 0) {
            const m = fld.stripe ? 1.04 : 0.96;
            colors[k * 3] *= m; colors[k * 3 + 1] *= m; colors[k * 3 + 2] *= m;
          }
        }
      }
    }
  }

  // indices: split each quad along the diagonal with the smaller height difference (reads as
  // deliberate low-poly facets instead of saw-teeth across slopes)
  const idx = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      const dAD = Math.abs(positions[a * 3 + 1] - positions[d * 3 + 1]);
      const dBC = Math.abs(positions[b * 3 + 1] - positions[c * 3 + 1]);
      if (dBC <= dAD) idx.push(a, c, b, b, c, d);
      else idx.push(a, c, d, a, d, b);
    }
  }
  // one shared vertex/colour/normal buffer set, drawn as CHUNK_X x CHUNK_Z chunk meshes (an index buffer and
  // tight bounds each) so the renderer can frustum-cull most of the heightfield every frame
  const full = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const colAttr = new THREE.BufferAttribute(colors, 3);
  full.setAttribute('position', posAttr);
  full.setAttribute('color', colAttr);
  full.setIndex(idx);
  full.computeVertexNormals();
  const nrmAttr = full.getAttribute('normal');
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const mesh = new THREE.Group();
  mesh.name = 'terrain';
  const CHUNK_X = 8;
  const CHUNK_Z = 5;
  const cw = Math.ceil((nx - 1) / CHUNK_X);
  const ch = Math.ceil((nz - 1) / CHUNK_Z);
  for (let cj = 0; cj < CHUNK_Z; cj++) {
    for (let ci = 0; ci < CHUNK_X; ci++) {
      const i0 = ci * cw;
      const i1 = Math.min(nx - 1, i0 + cw);
      const j0 = cj * ch;
      const j1 = Math.min(nz - 1, j0 + ch);
      if (i1 <= i0 || j1 <= j0) continue;
      const cidx = [];
      const box = new THREE.Box3();
      box.min.set(Infinity, Infinity, Infinity);
      box.max.set(-Infinity, -Infinity, -Infinity);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * nx + i;
          box.expandByPoint(cA2.set(positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]));
          if (i === i1 || j === j1) continue;
          const a = k;
          const b = a + 1;
          const c = a + nx;
          const d = c + 1;
          const dAD = Math.abs(positions[a * 3 + 1] - positions[d * 3 + 1]);
          const dBC = Math.abs(positions[b * 3 + 1] - positions[c * 3 + 1]);
          if (dBC <= dAD) cidx.push(a, c, b, b, c, d);
          else cidx.push(a, c, d, a, d, b);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', posAttr);
      geo.setAttribute('color', colAttr);
      geo.setAttribute('normal', nrmAttr);
      geo.setIndex(cidx);
      geo.boundingBox = box;
      geo.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      const chunk = new THREE.Mesh(geo, mat);
      chunk.name = 'terrain-chunk';
      chunk.matrixAutoUpdate = false;
      chunk.updateMatrix();
      mesh.add(chunk);
    }
  }
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  // canyon terraces + rapids ledges (children of the terrain so callers only ever add one object)
  const cliffs = buildCliffs(course, profileAt);
  mesh.add(cliffs.group);

  /** Bilinear heightfield lookup at world (x, z) (grid jitter makes this approximate by design). */
  function fieldAt(x, z) {
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

  /** Ground height at world (x, z): the heightfield, or the terrace / rim-shelf surface over a walled bank. */
  function heightAt(x, z) {
    const h = fieldAt(x, z);
    const loc = locate(x, z);
    const zn = loc.lat >= 0 ? loc.q.zoneL : loc.q.zoneR;
    if (!zn) return h;
    const c = cliffs.surfaceAt(loc.s, loc.lat);
    return c === null ? h : Math.max(h, c);
  }

  return { mesh, heightAt, evaluate, samples, bounds: { minX, maxX, minZ, maxZ }, profileAt: (s) => profileAt(course, s), cliffs, locate };
}
