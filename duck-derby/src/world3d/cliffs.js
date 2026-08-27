// Dedicated flat-shaded bank-face strips: terraced sandstone walls through the
// canyon and low granite ledges along the rapids. The heightfield (terrain.js)
// keeps clear of them -- it stays below the water in front of and underneath
// the terraces and only comes up to rim height behind them, hidden under the
// rim shelf that is built here -- so these strips are the visible bank face.
// Everything is deterministic (hash jitter per 4 m station) and static; the
// meshes are meant to be parented to the terrain mesh.
import * as THREE from 'three';
import { PAL, hash2, noise2, fbm2 } from './gfx.js';
import { clamp, smoothstep, lerp } from '../rng.js';
import { WATER_BANK, bankLat } from './track.js';

/** Waterfall notches in the canyon rim; mirrors the fall list in scenery.js ({ s, side, w }). */
export const CANYON_FALLS = [
  { s: 150, side: -1, w: 3.5 },
  { s: 178, side: 1, w: 3 },
  { s: 262, side: 1, w: 4 },
  { s: 322, side: -1, w: 3.5 },
];
/** Geometry the notch assumes for a fall sheet (scenery.js): foot at half+0.3, leaning back 3.6 m with a 0.6 m mid bulge. */
const FALL_SHEET = { foot: 0.3, lean: 3.6, bulge: 0.6, notch: 1.4 };

const STEP = 4; // station spacing along the course (m)
export const RIM_SLOPE = 0.1; // the rim shelf / plateau rises gently away from the edge (m per m)
const SHELF_CLEAR = 0.24; // rim shelf floats this far above the nominal plateau height (hides the heightfield seam)

/**
 * Wall recipes. terraces: number of vertical faces; hBase/hVar: total height (m) in the core of the
 * stretch; tMin/tVar: raw terrace heights (rescaled to the total); back/backVar/backMax: ledge depths
 * and a cap on their sum; lean: how far each face's top sits back from its foot; footJit: jitter of the
 * wall foot beyond the water's visual edge; lip: grass band at the top of the top face; ramp: width of
 * the (hidden) heightfield ramp behind the faces; under: how far face 1 continues below the water.
 */
export const WALLS = {
  canyon: { terraces: 4, hBase: 14.5, hVar: 3.5, tMin: 3.5, tVar: 1.0, back: 0.8, backVar: 0.8, backMax: 3.3, lean: 0.2, footJit: 0.2, lip: 0.6, ramp: 4, under: 1.0, endMin: 0, hEnd: 0.5 },
  rapids: { terraces: 2, hBase: 3.0, hVar: 2.0, tMin: 1.4, tVar: 0.8, back: 1.0, backVar: 1.0, backMax: 2.2, lean: 0.4, footJit: 0.3, lip: 0.35, ramp: 3, under: 0.8, endMin: 0.5, hEnd: 0.5 },
};

/** Race-distance range [sStart, sEnd] over which a wall kind exists on one side. */
export function wallRange(course, kind, side) {
  const F = course.features;
  // canyon terraces flare out of the marina basin's banks and open out again into the lily pond;
  // granite ledges start right at the flume's exit portal and die out into the harbour approach
  // (earlier on the left, where the bank opens out to the sea)
  if (kind === 'canyon') return { sStart: F.canyonInS - 12, sEnd: F.lilyInS + 6, ease: 28 };
  return { sStart: F.tunnelOutS + 0.5, sEnd: side > 0 ? F.harborInS - 36 : F.harborInS - 6, ease: 16 };
}

/** 0..1: how much of the wall recipe applies at this profile (0 = ordinary soft bank). Smooth in s. */
export function wallOn(course, prof, kind, side) {
  const { sStart, sEnd } = wallRange(course, kind, side);
  return smoothstep(sStart - 4, sStart, prof.s) * (1 - smoothstep(sEnd, sEnd + 4, prof.s));
}

/** 0 in the core of a wall, rising to 1 at its ends (where heights ramp and the foot flares). */
function wallEndness(course, prof, kind, side) {
  const { sStart, sEnd, ease } = wallRange(course, kind, side);
  return 1 - clamp((prof.s - sStart) / ease, 0, 1) * clamp((sEnd - prof.s) / ease, 0, 1);
}

/** Total wall height (m above the water at its foot); piecewise-linear ramps at the ends, smooth inside. */
export function wallHeight(course, prof, side, kind) {
  const K = WALLS[kind];
  const ramp = 1 - wallEndness(course, prof, kind, side);
  const full = K.hBase + K.hVar * noise2(prof.s * 0.025, side * 3.1 + (kind === 'canyon' ? 0 : 40));
  const notch = kind === 'canyon' ? FALL_SHEET.notch * fallWeight(prof.s, side) : 0; // waterfall notches in the rim
  return Math.max(K.hEnd, full * (K.endMin + (1 - K.endMin) * ramp) - notch);
}

/**
 * Smooth (un-jittered) wall quantities at a terrain profile, for the heightfield to keep clear of the
 * strips: `vis` water's visual edge (= wall foot), `H` wall height, `D1` heightfield stays low out to
 * here, `D2` ...and reaches plateau height by here, `DS` outer edge of the rim shelf, `yFoot` banked
 * water height at the wall foot, `liftFrom` where the plateau starts to rise (see RIM_SLOPE).
 */
export function wallZone(course, prof, side, kind) {
  const K = WALLS[kind];
  const on = wallOn(course, prof, kind, side);
  if (on <= 0) return null;
  const vis = side > 0 ? prof.visL : prof.visR;
  const H = wallHeight(course, prof, side, kind);
  const rimMax = vis + K.footJit + K.backMax + K.lean * K.terraces; // outermost the rim edge can be
  const D1 = rimMax + 0.6;
  const D2 = D1 + K.ramp;
  const DS = D2 + 5.2; // covers the ramp plus one heightfield grid diagonal
  const yFoot = prof.y - bankLat(side * (vis + K.footJit * 0.5), prof.half * 2) * Math.tan(prof.bank) * WATER_BANK;
  // the rim shelf rides higher near the wall ends, where heights ramp and the foot flares (the heightfield
  // only approximates those curves between its 3.5 m vertices)
  const clear = SHELF_CLEAR + 0.5 * wallEndness(course, prof, kind, side);
  return { kind, on, vis, H, D1, D2, DS, yFoot, under: K.under, liftFrom: vis + 3, clear };
}

/** Nominal plateau height at lateral distance d for a zone (what the heightfield converges to). */
export const plateauY = (zn, d) => zn.yFoot + zn.H + RIM_SLOPE * Math.max(0, d - zn.liftFrom);

/** 0..1 weight of a waterfall notch at (s, side). */
function fallWeight(s, side) {
  let f = 0;
  for (const fl of CANYON_FALLS) if (fl.side === side) f = Math.max(f, 1 - smoothstep(fl.w / 2 + 0.5, fl.w / 2 + 4.0, Math.abs(s - fl.s)));
  return f;
}

/**
 * Station table for one wall (kind, side): per 4 m station the cross-section polyline in
 * (d = lateral distance from the centre line, y = world height) plus per-segment colour keys.
 */
function buildStations(course, profileAt, side, kind) {
  const K = WALLS[kind];
  const T = K.terraces;
  const { sStart, sEnd } = wallRange(course, kind, side);
  const run = [];
  for (let s = sStart; s <= sEnd + 1e-6; s += STEP) {
    const prof = profileAt(course, s);
    run.push({ s, prof, zn: wallZone(course, prof, side, kind) });
  }
  if (run.length < 3) return null;
  const seedK = kind === 'canyon' ? 0 : 53;
  const stations = run.map((r, k) => {
    const { s, prof, zn } = r;
    const p = course.at(s);
    const end = k === 0 || k === run.length - 1; // collapse the section at both ends so the strips die into the bank
    const jit = (n) => hash2(k * 1.31 + side * 17.7 + seedK, n * 7.13 + 0.5);
    const vis = zn.vis;
    const w0 = vis + K.footJit * jit(0);
    const notch = kind === 'canyon' ? fallWeight(s, side) : 0;
    const H = end ? 0 : zn.H; // (already lowered inside waterfall notches, see wallHeight)
    // terrace heights, rescaled to the total
    const raw = [];
    let sum = 0;
    for (let i = 0; i < T; i++) { raw.push(K.tMin + K.tVar * jit(1 + i)); sum += raw[i]; }
    const L = []; // ledge levels above the foot water, cumulative
    let acc = 0;
    for (let i = 0; i < T; i++) { acc += raw[i] * H / sum; L.push(acc); }
    // ledge depths (capped total so rim props placed by other modules land on the rim, not a ledge)
    const b = [];
    let bt = 0;
    for (let i = 0; i < T - 1; i++) { b.push(K.back + K.backVar * jit(11 + i)); bt += b[i]; }
    if (bt > K.backMax) for (let i = 0; i < b.length; i++) b[i] *= K.backMax / bt;
    // face foot positions: face i stands at dFace[i]; its top leans back by K.lean
    const dFace = [w0];
    for (let i = 1; i < T; i++) {
      let dn = dFace[i - 1] + K.lean + b[i - 1];
      if (notch > 0 && H > 1) {
        // behind a waterfall the faces stay just behind the leaning, bulging sheet so it reads as one drop
        const kk = clamp(L[i - 1] / Math.max(H - 0.35, 1), 0, 1);
        const sheet = vis - 0.5 + FALL_SHEET.foot + FALL_SHEET.lean * kk + FALL_SHEET.bulge * Math.sin(Math.PI * kk) + 0.4;
        dn = lerp(dn, Math.max(sheet, dFace[i - 1] + K.lean + 0.3), notch);
      }
      dFace.push(dn);
    }
    const rim = dFace[T - 1] + K.lean; // rim edge (top of the grass lip)
    const yFoot = p.y - bankLat(side * w0, p.width) * Math.tan(p.bank) * WATER_BANK;
    const top = (d) => yFoot + H + RIM_SLOPE * Math.max(0, d - zn.liftFrom);
    // cross-section polyline (d, y, colour key of the segment that STARTS at this point)
    const pts = [];
    const BAND = 0.25; // sun-bleached band along the top of every face (one tone lighter)
    let footY = yFoot - K.under - (end ? 0.6 : 0);
    pts.push({ d: w0, y: footY, c: 'face0' });
    for (let i = 0; i < T; i++) {
      const faceTopD = dFace[i] + K.lean - (i < T - 1 ? 0 : 0.03);
      const faceTopY = i < T - 1 ? yFoot + L[i] : yFoot + Math.max(0, H - K.lip);
      const fh = faceTopY - footY;
      const f = fh > BAND + 0.05 ? 1 - BAND / fh : 0.5; // (collapsed faces at the wall ends keep the point count)
      pts.push({ d: lerp(dFace[i], faceTopD, f), y: lerp(footY, faceTopY, f), c: 'band' + i });
      if (i < T - 1) {
        pts.push({ d: faceTopD, y: faceTopY, c: 'ledge' + i }); // top of face i = inner edge of ledge i
        footY = faceTopY + 0.05;
        pts.push({ d: dFace[i + 1], y: footY, c: 'face' + (i + 1) }); // outer edge of ledge i = foot of face i+1
      } else {
        pts.push({ d: faceTopD, y: faceTopY, c: 'lip' }); // rock part of the top face ends
        pts.push({ d: rim, y: yFoot + H, c: 'shelf' }); // rim edge
      }
    }
    // rim shelf: floats just above the nominal plateau and bevels down into the heightfield at its outer edge
    const shelfDrop = end ? -0.9 : 0;
    pts.push({ d: Math.max(rim + 0.5, zn.D2 - 0.5), y: top(zn.D2 - 0.5) + zn.clear + shelfDrop, c: 'shelf' });
    pts.push({ d: zn.DS - 2.2, y: top(zn.DS - 2.2) + zn.clear + shelfDrop, c: 'shelfEdge' });
    pts.push({ d: zn.DS, y: top(zn.DS) - 0.85 + shelfDrop, c: null });
    return { s, k, p, prof, zn, side, w0, H, L, b, dFace, rim, yFoot, pts, end, notch, jit };
  });
  return { kind, side, s0: stations[0].s, stations };
}

/** World position of cross-section point (d, y) at a station. */
function toWorld(st, d, y, out) {
  return out.set(st.p.x + st.p.nx * st.side * d, y, st.p.z + st.p.nz * st.side * d);
}

const COLOR_CACHE = new Map();
const colorOf = (hex) => {
  if (!COLOR_CACHE.has(hex)) COLOR_CACHE.set(hex, new THREE.Color(hex));
  return COLOR_CACHE.get(hex);
};

/** Base colour for the segment with key `key` starting at cross-section point q of station st; (x, z) = where it sits. */
function segmentColor(kind, key, out, st, q, x, z) {
  if (key === 'shelf' || key === 'shelfEdge') {
    // same recipe as the terrain's plateau greens (terrain.js) so the shelf seam does not show
    const pn = fbm2(x * 0.03 + 11, z * 0.03 + 3, 2);
    const patch = smoothstep(0.52, 0.66, pn);
    const shade = 1 - smoothstep(0.24, 0.36, pn);
    const bumps = fbm2(x * 0.05 + 7, z * 0.05 - 3, 3);
    out.copy(colorOf(PAL.grass)).lerp(colorOf(PAL.meadow), 0.5 * bumps).lerp(colorOf(PAL.grassLight), patch * 0.85).lerp(colorOf(PAL.grassDark), shade * 0.45);
    return out;
  }
  if (key === 'lip') return out.copy(colorOf(PAL.grassLip));
  if (kind === 'canyon') {
    const strata = PAL.strata;
    const light = strata[strata.length - 1];
    if (key.startsWith('face')) {
      const i = Number(key.slice(4));
      out.copy(colorOf(strata[Math.min(i, strata.length - 1)]));
      // chunky hand-painted variation: some blocks a touch darker / redder, some sandier
      const v = hash2(st.k * 3.17 + i * 11.1, q * 1.7 + st.side);
      if (v < 0.22) out.lerp(colorOf(PAL.cliffDark), 0.12);
      else if (v > 0.85) out.lerp(colorOf(PAL.sand), 0.18);
      return out;
    }
    if (key.startsWith('band')) {
      const i = Number(key.slice(4));
      return i >= strata.length - 1 ? out.copy(colorOf(light)).lerp(colorOf(PAL.sand), 0.4) : out.copy(colorOf(strata[i])).lerp(colorOf(light), 0.55);
    }
    if (key.startsWith('ledge')) {
      const i = Number(key.slice(5));
      return out.copy(colorOf(strata[Math.min(i, strata.length - 1)])).lerp(colorOf(light), 0.6).lerp(colorOf(PAL.sand), 0.15);
    }
  } else {
    if (key.startsWith('face')) {
      const v = hash2(st.k * 2.9 + q, 5.3 + st.side);
      out.copy(colorOf(v < 0.5 ? PAL.granite : PAL.graniteDark));
      if (v > 0.86) out.lerp(colorOf(PAL.rock), 0.4);
      return out;
    }
    if (key.startsWith('band')) return out.copy(colorOf(PAL.granite)).lerp(colorOf(PAL.sand), 0.3);
    if (key.startsWith('ledge')) return out.copy(colorOf(PAL.granite)).lerp(colorOf(PAL.rock), 0.35).lerp(colorOf(PAL.sand), 0.12);
  }
  return out.copy(colorOf(0xff00ff));
}

/** Build the strip mesh for one station table. */
function buildStripMesh(table) {
  const { stations, kind } = table;
  const pos = [];
  const col = [];
  const A = new THREE.Vector3();
  const B = new THREE.Vector3();
  const C = new THREE.Vector3();
  const D = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();
  const inward = new THREE.Vector3();
  const cc = new THREE.Color();
  const pushTri = (a, b, c) => { pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); for (let k = 0; k < 3; k++) col.push(cc.r, cc.g, cc.b); };
  for (let k = 0; k < stations.length - 1; k++) {
    const s0 = stations[k];
    const s1 = stations[k + 1];
    const np = s0.pts.length;
    // expected facing: toward the channel and up
    inward.set(-s0.side * s0.p.nx, 0.7, -s0.side * s0.p.nz);
    for (let q = 0; q < np - 1; q++) {
      const key = s0.pts[q].c;
      if (!key) continue;
      toWorld(s0, s0.pts[q].d, s0.pts[q].y, A);
      toWorld(s0, s0.pts[q + 1].d, s0.pts[q + 1].y, B);
      toWorld(s1, s1.pts[q].d, s1.pts[q].y, C);
      toWorld(s1, s1.pts[q + 1].d, s1.pts[q + 1].y, D);
      segmentColor(kind, key, cc, s0, q, (A.x + D.x) / 2, (A.z + D.z) / 2);
      const tint = 0.94 + 0.12 * hash2(s0.k * 0.77 + q * 3.1, s0.side * 2.3 + (kind === 'canyon' ? 1 : 9));
      cc.multiplyScalar(tint);
      // orientation: make the quad face the channel / sky
      e1.subVectors(C, A);
      e2.subVectors(B, A);
      n.crossVectors(e1, e2);
      const faceKey = key.startsWith('face') || key.startsWith('band') || key === 'lip';
      const expect = faceKey ? inward : n.y >= 0 ? n : inward; // ledges/shelf just need to face up
      const flip = n.dot(expect) < 0 || (!faceKey && n.y < 0);
      if (faceKey) {
        // baked bounce light: the sun never moves, so lift faces it cannot reach instead of letting them go murky
        n.normalize();
        if (flip) n.negate();
        const lit = n.dot(PAL.sunDir);
        cc.multiplyScalar(lerp(1.62, 1.0, smoothstep(-0.1, 0.55, lit)));
      }
      // split the quad along the shorter diagonal for chunkier facets
      const dAD = A.distanceToSquared(D);
      const dBC = B.distanceToSquared(C);
      if (dAD < dBC) {
        if (!flip) { pushTri(A, C, D); pushTri(A, D, B); } else { pushTri(A, D, C); pushTri(A, B, D); }
      } else {
        if (!flip) { pushTri(A, C, B); pushTri(B, C, D); } else { pushTri(A, B, C); pushTri(B, D, C); }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: kind === 'canyon' ? 0x2c1d12 : PAL.rockEmissive }));
  mesh.name = `${kind}-wall-${table.side > 0 ? 'L' : 'R'}`;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

/** Instanced ledge-top shrub clumps, clustered half-sunk rim boulders and grass tufts (deterministic). */
function buildDressing(tables) {
  const shrubGeo = new THREE.IcosahedronGeometry(1, 0);
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const tuftGeo = new THREE.ConeGeometry(0.28, 0.6, 5);
  tuftGeo.translate(0, 0.3, 0);
  const shrubs = []; // { x, y, z, r, rot }
  const rocks = []; // { x, y, z, sc, kind, r:[...], squash }
  const tufts = []; // { x, y, z, sc, rot }
  const v = new THREE.Vector3();
  for (const t of tables) {
    if (!t) continue;
    const K = WALLS[t.kind];
    for (const st of t.stations) {
      if (st.end || st.H < 3) continue;
      if (t.kind === 'canyon') {
        // shrub clumps (two blobs, 0.6-1.0 m) sitting ON the deeper ledges, never in the waterfall notches
        for (let i = 0; i < K.terraces - 1; i++) {
          if (st.jit(20 + i) > 0.2 || st.notch > 0.2 || st.b[i] < 0.9) continue;
          const r = 0.3 + 0.2 * st.jit(27 + i);
          const d = st.dFace[i] + K.lean + 0.5 * st.b[i];
          const yTop = st.yFoot + st.L[i] + 0.03;
          toWorld(st, d, yTop + 0.5 * r, v);
          const rot = 6 * st.jit(30 + i);
          shrubs.push({ x: v.x, y: v.y, z: v.z, r, rot });
          // second, smaller blob beside it along the ledge
          const off = (st.jit(33 + i) < 0.5 ? -1 : 1) * r * 0.95;
          shrubs.push({ x: v.x + st.p.tx * off, y: v.y - 0.12 * r, z: v.z + st.p.tz * off, r: r * 0.72, rot: rot + 1.3 });
        }
      }
      // boulder clusters on the rim shelf (3-5 squashed, a third sunk) with a grass tuft beside each boulder
      const pr = t.kind === 'canyon' ? 0.15 : 0.12;
      if (st.jit(40) < pr && st.notch < 0.2) {
        const d0 = st.rim + 1.3 + 2.4 * st.jit(41);
        const base = t.kind === 'canyon' ? 0.8 + 0.9 * st.jit(42) : 0.6 + 0.6 * st.jit(42);
        const n = t.kind === 'canyon' ? 3 + Math.floor(3 * st.jit(47)) : 2 + Math.floor(2 * st.jit(47));
        for (let bi = 0; bi < n; bi++) {
          const ang = (bi / n) * Math.PI * 2 + 3 * st.jit(48);
          const rr = bi === 0 ? 0 : base * (0.9 + 0.6 * st.jit(49 + bi));
          const d = d0 + Math.cos(ang) * rr * 0.8;
          const along = Math.sin(ang) * rr;
          const sc = base * (bi === 0 ? 1 : 0.45 + 0.4 * st.jit(53 + bi));
          const squash = 0.6;
          const ground = st.yFoot + st.H + RIM_SLOPE * Math.max(0, d - st.zn.liftFrom) + (d > st.zn.D2 - 0.5 ? st.zn.clear : 0.08);
          toWorld(st, d, ground + sc * squash * 0.3, v); // ~35% of its height under the ground
          v.x += st.p.tx * along;
          v.z += st.p.tz * along;
          rocks.push({ x: v.x, y: v.y, z: v.z, sc, kind: t.kind, r: [0.3 * st.jit(43 + bi), 6 * st.jit(44 + bi), 0.3 * st.jit(45 + bi)], squash });
          const ta = ang + 1.7;
          tufts.push({ x: v.x + Math.cos(ta) * sc * 0.95, y: ground - 0.05, z: v.z + Math.sin(ta) * sc * 0.95, sc: 0.7 + 0.6 * st.jit(57 + bi), rot: 6 * st.jit(58 + bi) });
        }
      }
    }
  }
  const group = new THREE.Group();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();
  const finish = (mesh, name) => {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = name;
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
    group.add(mesh);
  };
  if (shrubs.length) {
    const mesh = new THREE.InstancedMesh(shrubGeo, new THREE.MeshLambertMaterial({ color: PAL.shrub, flatShading: true, emissive: PAL.rockEmissive }), shrubs.length);
    shrubs.forEach((sh, i) => {
      e.set(0.3 * Math.sin(sh.rot * 3), sh.rot, 0.2 * Math.cos(sh.rot * 2));
      q.setFromEuler(e);
      sc.set(sh.r * 1.1, sh.r * 0.85, sh.r * 1.1);
      p.set(sh.x, sh.y, sh.z);
      m.compose(p, q, sc);
      mesh.setMatrixAt(i, m);
    });
    finish(mesh, 'ledge-shrubs');
  }
  for (const kind of ['canyon', 'rapids']) {
    const list = rocks.filter((r) => r.kind === kind);
    if (!list.length) continue;
    const mesh = new THREE.InstancedMesh(rockGeo, new THREE.MeshLambertMaterial({ color: kind === 'canyon' ? PAL.rockWarm : PAL.granite, flatShading: true, emissive: PAL.rockEmissive }), list.length);
    list.forEach((r, i) => {
      e.set(r.r[0], r.r[1], r.r[2]);
      q.setFromEuler(e);
      sc.set(r.sc, r.sc * r.squash, r.sc * 0.9);
      p.set(r.x, r.y, r.z);
      m.compose(p, q, sc);
      mesh.setMatrixAt(i, m);
    });
    finish(mesh, `${kind}-rim-boulders`);
  }
  if (tufts.length) {
    const mesh = new THREE.InstancedMesh(tuftGeo, new THREE.MeshLambertMaterial({ color: PAL.grassLight, flatShading: true, emissive: PAL.rockEmissive }), tufts.length);
    tufts.forEach((tf, i) => {
      e.set(0.15 * Math.sin(tf.rot), tf.rot, 0.15 * Math.cos(tf.rot));
      q.setFromEuler(e);
      sc.set(tf.sc, tf.sc * 1.2, tf.sc);
      p.set(tf.x, tf.y, tf.z);
      m.compose(p, q, sc);
      mesh.setMatrixAt(i, m);
    });
    finish(mesh, 'rim-tufts');
  }
  return group;
}

/**
 * Build every wall. Returns { group, tables, surfaceAt(s, lat) } where surfaceAt gives the strip /
 * shelf surface height at track coordinates (null when (s, lat) is not over a wall), so terrain.js
 * can fold it into heightAt() for prop placement.
 */
export function buildCliffs(course, profileAt) {
  const tables = [];
  for (const kind of ['canyon', 'rapids']) for (const side of [1, -1]) tables.push(buildStations(course, profileAt, side, kind));
  const group = new THREE.Group();
  group.name = 'cliffs';
  for (const t of tables) if (t) group.add(buildStripMesh(t));
  group.add(buildDressing(tables));

  function surfaceAt(s, lat) {
    const side = lat >= 0 ? 1 : -1;
    const d = Math.abs(lat);
    for (const t of tables) {
      if (!t || t.side !== side) continue;
      const f = (s - t.s0) / STEP;
      if (f < 0 || f >= t.stations.length - 1) continue;
      const k = Math.floor(f);
      const u = f - k;
      const a = t.stations[k].pts;
      const b = t.stations[k + 1].pts;
      const np = a.length;
      const d0 = lerp(a[0].d, b[0].d, u);
      const dN = lerp(a[np - 1].d, b[np - 1].d, u);
      if (d < d0 || d > dN) continue;
      for (let q = 0; q < np - 1; q++) {
        const da = lerp(a[q].d, b[q].d, u);
        const db = lerp(a[q + 1].d, b[q + 1].d, u);
        if (d <= db || q === np - 2) {
          const ya = lerp(a[q].y, b[q].y, u);
          const yb = lerp(a[q + 1].y, b[q + 1].y, u);
          const w = db > da + 1e-6 ? clamp((d - da) / (db - da), 0, 1) : 1;
          return lerp(ya, yb, w);
        }
      }
    }
    return null;
  }
  return { group, tables, surfaceAt };
}
