// World set dressing for all seven sections. Everything is procedural
// (primitives, merged/instanced) and deterministic. buildScenery() returns the
// root group plus per-frame updaters (bobbing buoys, blimp, frogs, item boxes,
// lighthouse beam...) and anchor points other systems need (hot-dog thrower
// spots, podium spots, fireworks barges).
import * as THREE from 'three';
import { PAL } from './gfx.js';
import * as cliffsModule from './cliffs.js';
import { Instancer, mergedMesh, place, colorize, colorizeFn, lumpify, gableGeo, bannerTexture, canvasTexture, catenary, sceneryRng } from './builders.js';
import { profileAt, SEA_LEVEL } from './terrain.js';
import { clamp, lerp, smoothstep } from '../rng.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const lam = (color, o = {}) => new THREE.MeshLambertMaterial({ color, ...o });
const basic = (color, o = {}) => new THREE.MeshBasicMaterial({ color, ...o });
/** Lambert for rocks / vegetation: a faint warm emissive floor so shadow sides never go dead grey. */
const EMISSIVE = (PAL && PAL.rockEmissive) || 0x1a1410;
const lamRock = (color, o = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, emissive: EMISSIVE, ...o });
/** Mark an object as animated so the static-transform freeze at the end of buildScenery leaves it alone. */
const dyn = (o) => { o.userData.dynamic = true; return o; };
/** Let a static, spatially compact InstancedMesh be frustum-culled as a whole (bounds over all instances). */
const cullable = (mesh) => { if (mesh.isInstancedMesh) mesh.computeBoundingSphere(); mesh.frustumCulled = true; return mesh; };
// waterfall notches live with the canyon terraces (cliffs.js); fall back to the classic three if that export moves
const CANYON_FALLS = (cliffsModule && cliffsModule.CANYON_FALLS) || [{ s: 150, side: -1, w: 5 }, { s: 262, side: 1, w: 6.5 }, { s: 322, side: -1, w: 4 }];

// art-direction colours owned here (gfx.PAL is being re-keyed elsewhere, so nothing new is added to it)
const COL = {
  trunk: 0x7a4f2a,
  pine: [0x3d8b52, 0x4da062, 0x5db56a],
  leaf: [0x5ea84c, 0x7cc35c, 0x9bd468],
  willow: [0x8dbf4e, 0xa8d264],
  cypress: [0x3f7f45, 0x4f9450],
  walls: [0xfff4e0, 0xffe0c4, 0xf6c9b6, 0xdfeaf3],
  roofs: [0xd9493b, 0xc9673a],
  roofBlue: 0x3c6fd1,
  plinth: 0x6f645d,
  windowPane: 0x2b3a4a,
  windowFrame: 0xfff1cc,
  door: [0x7a4f2a, 0x3d7be0, 0x3f8f3a, 0xc0392b],
  rockTop: 0xb5a28c,
  rockTop2: 0xa08d78,
  rockWet: 0x6b5847,
  moss: 0x7fae5a,
  lily: [0x4aa840, 0x6cc85a, 0x8fd66a],
  lilyRimYellow: 0xe8d040,
  gold: 0xffd23f,
  silver: 0xdfe6ee,
  bronze: 0xd98b4a,
  sailStripe: [0xe8412e, 0x3d7be0, 0xffd23f],
  hulls: [0xf4f1ea, 0x3d7be0, 0xe8412e, 0x16b8a6, 0x2b333b],
  lantern: 0xffc46b,
  bollard: 0x2b333b,
};

export function buildScenery({ track, terrain, quality, fallMat }) {
  const root = new THREE.Group();
  root.name = 'scenery';
  const updaters = []; // { sec, fn }: update() skips those whose section group is hidden
  const throwerSpots = [];
  const rng = sceneryRng(1234567);
  const course = track.course;
  const F = track.features;
  const L = track.length;
  /** Per-section groups + s-ranges, so main.js can hide whole stretches that are far from the camera. */
  const sections = {};
  for (const sc of course.sections) {
    const group = new THREE.Group();
    group.name = sc.id;
    sections[sc.id] = { group, s0: sc.s0, s1: sc.s1 };
    root.add(group);
  }
  let curSec = null; // section currently being built: tags updaters and keyed instancer adds (crowd, trees, houses...)
  const inSec = () => curSec;
  const secOfS = (s) => course.sectionIdAt(s);
  const addUpdater = (fn, sec = curSec) => { updaters.push({ sec, fn }); };
  const P = (s, lat, h, out) => track.toWorld(s, lat, h, out);
  const groundY = (x, z) => terrain.heightAt(x, z);
  const frameAt = (s) => track.frame(s);
  const halfAt = (s) => course.widthAt(s) / 2;
  const waterAt = (s) => course.at(s).y;
  /** Ground height at track-space (s, lat), or null when that spot is under / too close to the local water. */
  const dryGround = (s, lat, clearance = 0.4, out = null) => {
    const pp = P(s, lat, 0, out || V());
    const gy = groundY(pp.x, pp.z);
    return gy > waterAt(s) + clearance ? gy : null;
  };

  /** Two back-to-back single-sided textured planes (readable from both sides, never mirrored). */
  function twoSided(tex, w, h, { unlit = false } = {}) {
    const grp = new THREE.Group();
    const mat = unlit ? new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide }) : new THREE.MeshLambertMaterial({ map: tex, side: THREE.FrontSide });
    const a = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    const b = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    b.rotation.y = Math.PI;
    b.position.z = -0.04;
    a.position.z = 0.04;
    grp.add(a, b);
    return grp;
  }
  /** Orient an object so its local +Z faces along the course at s (yaw only). */
  function faceAlong(obj, s, flip = false) {
    const f = frameAt(s);
    obj.rotation.y = Math.atan2(f.flat.x, f.flat.z) + (flip ? Math.PI : 0);
    return obj;
  }
  const yawAt = (s) => { const f = frameAt(s); return Math.atan2(f.flat.x, f.flat.z); };
  /** Rounded white float (capsule lying along the course) with a red belly stripe, carrying a buoy-striped post. */
  const startFloat = (s, lat, postH, out) => {
    const p = P(s, lat, 0);
    const yaw = yawAt(s);
    const cap = new THREE.CapsuleGeometry(0.85, 4.3, 6, 14);
    cap.rotateX(Math.PI / 2); // axis along local z = along the course after the yaw
    out.push(colorize(place(cap, p.x, p.y + 0.15, p.z, 0, yaw, 0), 0xf6f3ec));
    const band = new THREE.CylinderGeometry(0.88, 0.88, 1.1, 14, 1, true);
    band.rotateX(Math.PI / 2);
    out.push(colorize(place(band, p.x, p.y + 0.15, p.z, 0, yaw, 0), PAL.buoyRed));
    if (postH > 0) {
      const nSeg = 8;
      for (let i = 0; i < nSeg; i++) out.push(colorize(place(new THREE.CylinderGeometry(0.32, 0.34, postH / nSeg, 10), p.x, p.y + 0.7 + (i + 0.5) * (postH / nSeg), p.z), i % 2 ? PAL.buoyWhite : PAL.buoyRed));
      out.push(colorize(place(new THREE.SphereGeometry(0.62, 12, 9), p.x, p.y + 0.7 + postH + 0.35, p.z), 0xffd23f));
    }
    return p;
  };

  // ------------------------------------------------------------------ shared geos/materials
  const woodMat = lam(PAL.wood);
  const woodDarkMat = lam(PAL.woodDark);
  const whiteMat = lam(0xf4f1ea);
  const redMat = lam(PAL.buoyRed);
  const rockMat = lamRock(PAL.rock);
  const rockWarmMat = lamRock(PAL.strata ? PAL.strata[0] : PAL.cliff); // canyon wall-foot boulders: the lowest terrace band's stone
  const rockDarkMat = lamRock(PAL.rockDark);
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  // faceted boulders shared by the Drop banks and the rapids: three lumpy unit variants, vertex-coloured per
  // placement with a dark wet band at the local waterline, warm light dry tops and optional moss caps
  const boulderVariants = [
    lumpify(new THREE.DodecahedronGeometry(1, 0), 0.16, 1),
    lumpify(new THREE.IcosahedronGeometry(1, 1), 0.2, 2),
    lumpify(new THREE.BoxGeometry(1.7, 1.0, 1.4, 2, 1, 2).toNonIndexed(), 0.14, 3),
  ];
  const boulderMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: EMISSIVE });
  const cRockTop = new THREE.Color(COL.rockTop);
  const cRockTop2 = new THREE.Color(COL.rockTop2);
  const cRockWet = new THREE.Color(COL.rockWet);
  const cRockDeep = new THREE.Color(0x54473c);
  const cMoss = new THREE.Color(COL.moss);
  const rockM = new THREE.Matrix4();
  const rockQ = new THREE.Quaternion();
  const rockE = new THREE.Euler();
  /** World-space boulder geometry: variant 0-2 at `centre`, scale [x,y,z], euler rot, water level wy (for the wet band). */
  function boulderGeo(variant, centre, sc, rot, wy, mossy, seed = 0) {
    const geo = boulderVariants[variant].clone();
    rockE.set(rot[0], rot[1], rot[2]);
    rockQ.setFromEuler(rockE);
    rockM.compose(centre, rockQ, V(sc[0], sc[1], sc[2]));
    geo.applyMatrix4(rockM);
    colorizeFn(geo, (x, y, z, c, n) => {
      const rel = y - wy;
      if (rel < 0.05) c.copy(cRockDeep);
      else if (rel < 0.3) c.copy(cRockWet);
      else {
        const t = 0.5 + 0.5 * Math.sin(x * 1.7 + z * 2.3 + seed);
        c.copy(cRockTop2).lerp(cRockTop, t);
        if (rel < 0.55) c.lerp(cRockWet, 0.35); // damp fringe above the wet band
        if (mossy && n.y > 0.55 && rel > 0.6) c.copy(cMoss).lerp(cRockTop, 0.15 * t);
      }
    });
    return geo;
  }

  // ------------------------------------------------------------------ crowd (instanced people)
  const crowdScale = quality.crowd;
  const personBody = new THREE.CylinderGeometry(0.22, 0.26, 0.9, 6);
  personBody.translate(0, 0.45, 0);
  const personHead = new THREE.SphereGeometry(0.17, 6, 5);
  personHead.translate(0, 1.07, 0);
  const crowdBodies = new Instancer(personBody, lam(0xffffff), { colors: true, keyOf: inSec });
  const crowdHeads = new Instancer(personHead, lam(0xffffff), { colors: true, keyOf: inSec });
  const SHIRTS = [0xe8412e, 0xffd23f, 0x3d7be0, 0x5fbf4a, 0xff7fb0, 0xffffff, 0x8e5bd9, 0x16b8a6, 0xff7a2f, 0x222222];
  const SKIN = [0xf6d3b3, 0xe8b894, 0xc68863, 0x8d5524, 0x5c3a1e, 0xffe0c4];
  function addPerson(pos, rotY = 0) {
    if (rng.next() > crowdScale) return;
    const sc = rng.range(0.85, 1.15);
    const phase = rng.range(0, Math.PI * 2); // bobbing phase, carried per instance (see the crowd shader below)
    crowdBodies.add(pos, rotY, sc, rng.pick(SHIRTS), null, phase);
    crowdHeads.add(pos, rotY, sc, rng.pick(SKIN), null, phase);
  }

  // ------------------------------------------------------------------ bunting flags (instanced)
  const flagGeo = new THREE.BufferGeometry();
  flagGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.2, 0, 0, 0.2, 0, 0, 0, -0.5, 0]), 3));
  flagGeo.computeVertexNormals();
  const flags = new Instancer(flagGeo, new THREE.MeshLambertMaterial({ vertexColors: false, side: THREE.DoubleSide, color: 0xffffff }), { colors: true, keyOf: inSec });
  const cableGeoms = [];
  function addBunting(a, b, sag = 1.2, spacing = 0.9) {
    const len = a.distanceTo(b);
    const n = Math.max(2, Math.round(len / spacing));
    const pts = catenary(a, b, sag, n);
    const dir = V().subVectors(b, a);
    const rotY = Math.atan2(dir.x, dir.z) + Math.PI / 2;
    for (let i = 1; i < n; i++) flags.add(pts[i], rotY + rng.range(-0.3, 0.3), rng.range(0.9, 1.15), PAL.bunting[i % PAL.bunting.length]);
    // cable as a thin tube (few segments)
    const curve = new THREE.CatmullRomCurve3(pts);
    cableGeoms.push(colorize(new THREE.TubeGeometry(curve, n, 0.025, 3, false), 0x333333));
  }

  // ------------------------------------------------------------------ houses (instanced parts shared by the marina village and the harbour town)
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  unitBox.translate(0, 0.5, 0); // base at y = 0
  const unitBoxC = new THREE.BoxGeometry(1, 1, 1); // centred
  const flatWhite = () => new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  const houseWalls = new Instancer(unitBox, lam(0xffffff), { colors: true, keyOf: inSec }); // walls + plinths + chimneys
  const houseGables = new Instancer(gableGeo(), flatWhite(), { colors: true, keyOf: inSec });
  const hipGeo = new THREE.CylinderGeometry(0.001, Math.SQRT1_2, 1, 4);
  hipGeo.rotateY(Math.PI / 4);
  hipGeo.translate(0, 0.5, 0);
  const houseHips = new Instancer(hipGeo, flatWhite(), { colors: true, keyOf: inSec });
  const houseTrim = new Instancer(unitBoxC, lam(0xffffff), { colors: true, keyOf: inSec }); // window frames + panes + doors
  const houseSpots = []; // footprints, so trees keep out of houses
  /**
   * A cottage sitting ON the ground: base sunk 0.3 m under the lowest footprint corner over a dark plinth,
   * 2-4 framed windows, a door, an overhanging gable (or hip) roof and maybe a chimney. Returns false when
   * any corner is below `minGround` (water / beach).
   */
  function addHouse(x, z, rotY, w, d, h, { minGround = -Infinity } = {}) {
    const cs = Math.cos(rotY);
    const sn = Math.sin(rotY);
    const toWorld = (lx, ly, lz, out = V()) => out.set(x + lx * cs + lz * sn, ly, z - lx * sn + lz * cs);
    let gmin = Infinity;
    let gmax = -Infinity;
    const tmpc = V();
    for (const sx of [-0.5, 0.5]) {
      for (const szz of [-0.5, 0.5]) {
        toWorld(sx * w, 0, szz * d, tmpc);
        const gy = groundY(tmpc.x, tmpc.z);
        gmin = Math.min(gmin, gy);
        gmax = Math.max(gmax, gy);
      }
    }
    if (gmin < minGround || gmax - gmin > 1.6) return false;
    const yb = gmin - 0.3;
    const wallH = gmax - yb + h;
    houseWalls.add(V(x, yb - 0.2, z), rotY, [w + 0.4, gmax - yb + 0.45, d + 0.4], COL.plinth);
    houseWalls.add(V(x, yb, z), rotY, [w, wallH, d], rng.pick(COL.walls));
    const roofCol = rng.chance(0.15) ? COL.roofBlue : rng.pick(COL.roofs);
    const roofY = yb + wallH;
    const rh = 1.5 + rng.range(0, 0.9) + Math.min(w, d) * 0.12;
    const ridgeAlongZ = d >= w;
    if (rng.chance(0.7)) houseGables.add(V(x, roofY, z), ridgeAlongZ ? rotY : rotY + Math.PI / 2, ridgeAlongZ ? [w * 1.18, rh, d * 1.1] : [d * 1.18, rh, w * 1.1], roofCol);
    else houseHips.add(V(x, roofY, z), rotY, [w * 1.18, rh, d * 1.18], roofCol);
    // windows on the two faces across the width (local x = +-w/2), spaced along the depth
    const winY = yb + (gmax - yb) + Math.min(h * 0.55, h - 0.8);
    for (const fx of [-1, 1]) {
      const nW = d > 5 ? 2 : rng.int(1, 2);
      for (let k = 0; k < nW; k++) {
        const lz = nW === 1 ? rng.range(-0.6, 0.6) : (k - (nW - 1) / 2) * (d / nW);
        houseTrim.add(toWorld(fx * (w / 2 + 0.01), winY, lz), rotY, [0.06, 1.1, 0.9], COL.windowFrame);
        houseTrim.add(toWorld(fx * (w / 2 + 0.025), winY, lz), rotY, [0.07, 0.9, 0.7], COL.windowPane);
      }
    }
    // door on the +z gable face (and a window beside it on wide houses)
    const doorX = w > 5 ? rng.range(-0.25, 0.25) * w : 0;
    houseTrim.add(toWorld(doorX, gmax + 0.72, d / 2 + 0.02), rotY, [0.85, 1.5, 0.08], rng.pick(COL.door));
    if (w > 5.5) {
      const wx = doorX > 0 ? doorX - 1.7 : doorX + 1.7;
      houseTrim.add(toWorld(wx, winY, d / 2 + 0.01), rotY, [0.9, 1.1, 0.06], COL.windowFrame);
      houseTrim.add(toWorld(wx, winY, d / 2 + 0.025), rotY, [0.7, 0.9, 0.07], COL.windowPane);
    }
    if (rng.chance(0.4)) {
      const c = toWorld(rng.pick([-1, 1]) * w * 0.22, roofY + rh * 0.35, rng.pick([-1, 1]) * d * 0.22);
      houseWalls.add(c, rotY, [0.55, rh * 0.75 + 0.4, 0.55], rng.chance(0.5) ? 0x9a4a3a : 0xb3a48f);
    }
    houseSpots.push({ x, z, r: Math.hypot(w, d) / 2 + 1.5 });
    return true;
  }
  const nearHouse = (x, z, pad = 0) => houseSpots.some((hs) => (hs.x - x) ** 2 + (hs.z - z) ** 2 < (hs.r + pad) ** 2);

  // quay-edge bollards (marina + harbour), built at the end
  const bollardGeo = (() => {
    const parts = [colorize(place(new THREE.CylinderGeometry(0.15, 0.19, 0.55, 6), 0, 0.275, 0), COL.bollard), colorize(place(new THREE.SphereGeometry(0.19, 6, 4), 0, 0.6, 0), COL.bollard), colorize(place(new THREE.CylinderGeometry(0.2, 0.2, 0.08, 6, 1, true), 0, 0.42, 0), 0xd9cdb8)];
    return mergedMesh(parts, { flat: false }).geometry;
  })();
  const bollards = new Instancer(bollardGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), { keyOf: inSec });

  // ------------------------------------------------------------------ vegetation (instanced; sections add positions, meshes are built at the end)
  const vegMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: EMISSIVE });
  const pineGeo = (() => {
    const parts = [colorize(place(new THREE.CylinderGeometry(0.17, 0.26, 1.6, 6), 0, 0.8, 0), COL.trunk)];
    const tiers = [{ r: 1.5, h: 2.4, y: 2.1 }, { r: 1.15, h: 2.1, y: 3.4 }, { r: 0.78, h: 1.9, y: 4.6 }];
    tiers.forEach((t, k) => parts.push(colorize(place(new THREE.ConeGeometry(t.r, t.h, 7), 0, t.y, 0, 0, k * 0.4, 0), COL.pine[k])));
    return mergedMesh(parts).geometry;
  })();
  // skinny spruce: taller, narrower, four tight tiers
  const spruceGeo = (() => {
    const parts = [colorize(place(new THREE.CylinderGeometry(0.13, 0.2, 1.4, 6), 0, 0.7, 0), COL.trunk)];
    const tiers = [{ r: 0.95, h: 2.3, y: 2.0 }, { r: 0.78, h: 2.0, y: 3.3 }, { r: 0.6, h: 1.8, y: 4.5 }, { r: 0.4, h: 1.6, y: 5.6 }];
    tiers.forEach((t, k) => parts.push(colorize(place(new THREE.ConeGeometry(t.r, t.h, 6), 0, t.y, 0, 0, k * 0.55, 0), COL.pine[Math.min(k, 2)])));
    return mergedMesh(parts).geometry;
  })();
  // round puffball bush (white vertex colour: tinted per instance)
  const bushGeo = colorize(lumpify(new THREE.IcosahedronGeometry(0.9, 0), 0.08, 5), 0xffffff); // (polyhedron geometries are already non-indexed)
  const leafGeo = (() => {
    const parts = [colorize(place(new THREE.CylinderGeometry(0.2, 0.32, 2.7, 6), 0, 1.35, 0), COL.trunk)];
    parts.push(colorize(place(new THREE.IcosahedronGeometry(1.7, 0), 0, 3.7, 0, 0.3, 0.5, 0), COL.leaf[0]));
    parts.push(colorize(place(new THREE.IcosahedronGeometry(1.3, 0), 0.8, 4.4, 0.4, 0, 1.1, 0.4), COL.leaf[1]));
    parts.push(colorize(place(new THREE.IcosahedronGeometry(1.05, 0), -0.35, 5.15, -0.3, 0.7, 0.2, 0), COL.leaf[2])); // light blob on top
    return mergedMesh(parts).geometry;
  })();
  const willowGeo = (() => {
    const parts = [colorize(place(new THREE.CylinderGeometry(0.3, 0.48, 3.2, 7), 0, 1.6, 0, 0.08, 0, 0.1), COL.trunk)];
    parts.push(colorize(place(new THREE.SphereGeometry(2.3, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), 0, 3.7, 0, 0, 0, 0, 1, 0.7, 1), COL.leaf[2]));
    // drooping curtain of fronds: an open cone-ish skirt flaring outward with a ragged hem, streaked in two greens
    const cur = new THREE.CylinderGeometry(1.7, 3.0, 3.2, 16, 3, true).toNonIndexed();
    const cp = cur.attributes.position;
    for (let i = 0; i < cp.count; i++) {
      const y = cp.getY(i);
      if (y < 1.5) {
        const a = Math.atan2(cp.getZ(i), cp.getX(i));
        cp.setY(i, y - (0.3 + 0.4 * Math.sin(a * 8) + 0.25 * Math.sin(a * 3 + 1)) * (1.6 - y) / 3.2);
      }
    }
    cur.computeVertexNormals();
    const cA = new THREE.Color(COL.willow[0]);
    const cB = new THREE.Color(0x79b84c);
    colorizeFn(cur, (x, y, z, c) => { const a = Math.atan2(z, x); c.copy(Math.sin(a * 8) > 0 ? cA : cB); if (y > 1) c.lerp(new THREE.Color(COL.leaf[2]), 0.5); });
    parts.push(place(cur, 0, 2.5, 0));
    return mergedMesh(parts).geometry;
  })();
  const cypressGeo = (() => {
    const parts = [colorize(place(new THREE.CylinderGeometry(0.16, 0.22, 1.2, 6), 0, 0.6, 0), COL.trunk)];
    parts.push(colorize(place(new THREE.SphereGeometry(0.95, 8, 6), 0, 1.6, 0), COL.cypress[0]));
    parts.push(colorize(place(new THREE.ConeGeometry(0.92, 5.2, 8), 0, 4.4, 0), COL.cypress[1]));
    return mergedMesh(parts).geometry;
  })();
  const reedGeo = (() => {
    const parts = [];
    for (let k = 0; k < 7; k++) {
      const h = 1.8 + (k % 3) * 0.5;
      parts.push(colorize(place(new THREE.CylinderGeometry(0.03, 0.05, h, 4), Math.sin(k * 2.3) * 0.4, h / 2, Math.cos(k * 2.3) * 0.4, Math.sin(k) * 0.12, 0, Math.cos(k * 1.7) * 0.12), k % 2 ? 0x6d8f3a : 0x86a848));
      if (k % 2) parts.push(colorize(place(new THREE.CylinderGeometry(0.07, 0.07, 0.35, 6), Math.sin(k * 2.3) * 0.4, h - 0.1, Math.cos(k * 2.3) * 0.4), 0x6b4423)); // cattail
    }
    return mergedMesh(parts).geometry;
  })();
  const pines = new Instancer(pineGeo, vegMat, { keyOf: inSec });
  const spruces = new Instancer(spruceGeo, vegMat, { keyOf: inSec });
  const leafTrees = new Instancer(leafGeo, vegMat, { keyOf: inSec });
  const bushes = new Instancer(bushGeo, vegMat, { colors: true, keyOf: inSec });
  const willows = new Instancer(willowGeo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide, emissive: EMISSIVE }), { keyOf: inSec });
  const cypresses = new Instancer(cypressGeo, vegMat, { keyOf: inSec });
  const reeds = new Instancer(reedGeo, vegMat, { keyOf: inSec });
  const SIZE_CLASSES = [0.7, 1.0, 1.35, 1.9];
  const treeScale = () => rng.pick(SIZE_CLASSES) * rng.range(0.9, 1.1);
  const BUSH_GREENS = [0x6cbc55, 0x7fc860, 0x5aa84c];
  const lean = () => [rng.range(-0.06, 0.06), rng.range(0, 6.28), rng.range(-0.06, 0.06)]; // slight lean: no two trees stand alike
  /**
   * Plant a tree at track-space (s, lat) if the ground there is dry and clear of houses. kind: instancer
   * (pines are swapped for the skinny spruce variant a third of the time; ~40% of trees get 2-3 puffball
   * bushes around their base).
   */
  function plant(kind, s, lat, scale = treeScale(), sink = 0.15) {
    const pp = P(s, lat, 0);
    const gy = groundY(pp.x, pp.z);
    if (gy < waterAt(s) + 0.4) return false;
    if (nearHouse(pp.x, pp.z, 1.5 * scale)) return false;
    plantAt(kind, pp.x, gy, pp.z, scale, sink);
    return true;
  }
  /** Place a tree of `kind` with its base at (x, gy, z): spruce swap, lean and companion bushes included. */
  function plantAt(kind, x, gy, z, scale = treeScale(), sink = 0.15) {
    const k = kind === pines && rng.chance(0.33) ? spruces : kind;
    k.add(V(x, gy - sink * scale, z), 0, scale, null, lean());
    if ((k === pines || k === spruces || k === leafTrees) && rng.chance(0.4)) {
      const nb = rng.int(2, 3);
      for (let b = 0; b < nb; b++) {
        const a = rng.range(0, 6.28);
        const r = (0.9 + rng.range(0.3, 1.1)) * scale;
        const bx = x + Math.cos(a) * r;
        const bz = z + Math.sin(a) * r;
        const by = groundY(bx, bz);
        if (Math.abs(by - gy) > 1.2) continue;
        const bs = rng.range(0.55, 0.95) * Math.min(scale, 1.3);
        bushes.add(V(bx, by + 0.45 * bs, bz), rng.range(0, 6.28), [bs, bs * 0.8, bs], rng.pick(BUSH_GREENS));
      }
    }
  }

  // ================================================================== MARINA
  {
    curSec = 'marina';
    const g = sections.marina.group;
    const half0 = halfAt(0);
    // --- start arch on pontoons
    const parts = [];
    for (const side of [-1, 1]) startFloat(0, side * (half0 + 2.2), 9.0, parts);
    const archMesh = mergedMesh(parts, { flat: false });
    g.add(archMesh);
    // banner beam across
    const a = P(0, half0 + 2.2, 8.6);
    const b = P(0, -(half0 + 2.2), 8.6);
    const beamLen = a.distanceTo(b);
    const mid = V().addVectors(a, b).multiplyScalar(0.5);
    const bannerTex = bannerTexture('START', { bg: '#13233a', accent: '#ffd23f', chequer: true });
    const banner = new THREE.Mesh(new THREE.BoxGeometry(beamLen, 2.2, 0.3), [lam(0x13233a), lam(0x13233a), lam(0x13233a), lam(0x13233a), new THREE.MeshLambertMaterial({ map: bannerTex }), new THREE.MeshLambertMaterial({ map: bannerTex })]);
    banner.position.copy(mid);
    banner.rotation.y = yawAt(0);
    g.add(banner);
    addBunting(P(0, half0 + 2.2, 7.4), P(0, -(half0 + 2.2), 7.4), 1.0, 0.8);
    // start boom (striped) that swings up at GO
    const boomPivot = dyn(new THREE.Group());
    const bp = P(2.5, -(half0 + 1.5), 0.7);
    boomPivot.position.copy(bp);
    boomPivot.rotation.y = yawAt(0);
    const boomLen = 2 * half0 + 3;
    const boomParts = [];
    const nStripe = 16;
    for (let i = 0; i < nStripe; i++) boomParts.push(colorize(place(new THREE.CylinderGeometry(0.12, 0.12, boomLen / nStripe, 8), -(i + 0.5) * (boomLen / nStripe), 0, 0, 0, 0, Math.PI / 2), i % 2 ? 0xffffff : 0xe8412e));
    const boom = mergedMesh(boomParts, { flat: false });
    boomPivot.add(boom);
    g.add(boomPivot);
    addUpdater((dt, ctx) => {
      // down before the start, swings up at GO
      const up = ctx.phase === 'race' || ctx.phase === 'finish' || ctx.phase === 'results' ? smoothstep(0, 0.6, ctx.t + 0.05) : 0;
      boomPivot.rotation.z = -up * 1.35;
    });

    // --- grandstands on both quays
    const standParts = [];
    const rows = 6;
    const sA = -58;
    const sB = 62;
    const segs = 10;
    for (const side of [-1, 1]) {
      for (let r = 0; r < rows; r++) {
        const lat = side * (41 + r * 1.6);
        const h = 1.2 + r * 0.95; // above quay
        for (let k = 0; k < segs; k++) {
          const s0 = lerp(sA, sB, k / segs);
          const s1 = lerp(sA, sB, (k + 1) / segs);
          const p0 = P(s0, lat, 0);
          const p1 = P(s1, lat, 0);
          const gy = groundY(p0.x, p0.z);
          const len = p0.distanceTo(p1) + 0.05;
          const midp = V().addVectors(p0, p1).multiplyScalar(0.5);
          const yaw = Math.atan2(p1.x - p0.x, p1.z - p0.z);
          standParts.push(colorize(place(new THREE.BoxGeometry(1.6, h, len), midp.x, gy + h / 2, midp.z, 0, yaw, 0), r % 2 ? 0xdfe6ee : 0xc7d2de));
          // people on this row
          const n = Math.floor(len / 1.7);
          for (let i = 0; i < n; i++) {
            const pp = V().lerpVectors(p0, p1, (i + 0.5) / n);
            pp.y = gy + h;
            addPerson(pp, yaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2));
          }
        }
      }
      // canopy roof + back wall
      for (let k = 0; k < segs; k++) {
        const s0 = lerp(sA, sB, k / segs);
        const s1 = lerp(sA, sB, (k + 1) / segs);
        const lat = side * (41 + rows * 1.6 + 0.5);
        const p0 = P(s0, lat, 0);
        const p1 = P(s1, lat, 0);
        const gy = groundY(p0.x, p0.z);
        const len = p0.distanceTo(p1) + 0.05;
        const midp = V().addVectors(p0, p1).multiplyScalar(0.5);
        const yaw = Math.atan2(p1.x - p0.x, p1.z - p0.z);
        standParts.push(colorize(place(new THREE.BoxGeometry(0.4, 9.5, len), midp.x, gy + 4.75, midp.z, 0, yaw, 0), 0x8797a8));
        const roofLat = side * (41 + rows * 0.8);
        const r0 = P(s0, roofLat, 0);
        const r1 = P(s1, roofLat, 0);
        const rm = V().addVectors(r0, r1).multiplyScalar(0.5);
        standParts.push(colorize(place(new THREE.BoxGeometry(rows * 1.6 + 3, 0.25, len), rm.x, gy + 10.2, rm.z, 0, yaw, side * 0.12), k % 2 ? PAL.roofRed : 0xf4f1ea));
      }
      // roof posts
      for (let k = 0; k <= segs; k += 2) {
        const s0 = lerp(sA, sB, k / segs);
        const pp = P(s0, side * 40.2, 0);
        const gy = groundY(pp.x, pp.z);
        standParts.push(colorize(place(new THREE.CylinderGeometry(0.15, 0.15, 10, 6), pp.x, gy + 5, pp.z), 0x8797a8));
      }
      // bunting poles along the quay edge
      let prev = null;
      for (let s = -70; s <= 75; s += 14.5) {
        const pp = P(s, side * 39.2, 0);
        const gy = groundY(pp.x, pp.z);
        standParts.push(colorize(place(new THREE.CylinderGeometry(0.08, 0.1, 4.2, 6), pp.x, gy + 2.1, pp.z), 0xf4f1ea));
        const top = V(pp.x, gy + 4.1, pp.z);
        if (prev) addBunting(prev, top, 0.9);
        prev = top;
        throwerSpots.push({ s, pos: V(pp.x, gy + 1.2, pp.z), kind: 'quay' });
      }
    }
    g.add(mergedMesh(standParts));

    // --- PA towers with horn speakers
    const paParts = [];
    for (const side of [-1, 1]) {
      const pp = P(18, side * 44, 0);
      const gy = groundY(pp.x, pp.z) ;
      for (const dx of [-0.6, 0.6]) for (const dz of [-0.6, 0.6]) paParts.push(colorize(place(new THREE.BoxGeometry(0.18, 13, 0.18), pp.x + dx, gy + 6.5, pp.z + dz), 0x59636e));
      for (let y = 1; y < 13; y += 1.5) paParts.push(colorize(place(new THREE.BoxGeometry(1.3, 0.12, 0.12), pp.x, gy + y, pp.z, 0, y, 0), 0x59636e));
      for (let k = 0; k < 3; k++) {
        const horn = new THREE.CylinderGeometry(0.9, 0.3, 1.2, 12, 1, true);
        paParts.push(colorize(place(horn, pp.x - side * 0.3, gy + 12.5 - k * 1.3, pp.z, Math.PI / 2, 0, side * Math.PI / 2 + (k - 1) * 0.5), 0x2b333b));
      }
    }
    g.add(mergedMesh(paParts, { flat: false }));

    // --- blimp
    const blimp = dyn(new THREE.Group());
    const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), lam(0xd9cdb0, { emissive: 0x8f8672 })); // strong self-light: nose-on and from below it stays cream, never a grey "cloud"
    hull.scale.set(9, 2.8, 2.8);
    blimp.add(hull);
    const stripe = new THREE.Mesh(new THREE.SphereGeometry(1.01, 24, 8, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.16), lam(PAL.buoyRed));
    stripe.scale.set(9, 2.8, 2.8);
    blimp.add(stripe);
    for (let k = 0; k < 4; k++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.8, 0.15), lam(PAL.buoyRed));
      fin.position.set(-8, 0, 0);
      fin.rotation.x = (k * Math.PI) / 2;
      fin.translateY(1.9);
      blimp.add(fin);
    }
    const gondola = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 1.1), lam(0x39424e));
    gondola.position.set(0.5, -3, 0);
    blimp.add(gondola);
    const blimpTex = bannerTexture('DUCK DERBY', { w: 1024, h: 200, bg: '#fff4d6', fg: '#d9493b', accent: '#fff4d6', font: '900 120px system-ui, sans-serif' });
    for (const side of [-1, 1]) {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(9.5, 1.9), new THREE.MeshLambertMaterial({ map: blimpTex, transparent: true }));
      pl.position.set(0.5, -0.2, side * 2.72);
      pl.rotation.y = side > 0 ? 0 : Math.PI;
      blimp.add(pl);
    }
    const blimpCenter = P(10, 0, 0);
    addUpdater((dt, ctx) => {
      const a = ctx.realTime * 0.045;
      blimp.position.set(blimpCenter.x + Math.cos(a) * 80, blimpCenter.y + 48, blimpCenter.z + Math.sin(a) * 60);
      blimp.rotation.y = -a - Math.PI / 2;
    });
    g.add(blimp);

    // --- village cottages behind the stands, in loose rows facing the water
    for (const side of [-1, 1]) {
      for (let s = -95; s < 85; s += rng.range(8, 13)) {
        for (let k = 0; k < 3; k++) {
          const lat = side * rng.range(60 + k * 16, 72 + k * 18);
          const pp = P(s + rng.range(-3, 3), lat, 0);
          addHouse(pp.x, pp.z, yawAt(s) + (side > 0 ? -Math.PI / 2 : Math.PI / 2) + rng.range(-0.25, 0.25), rng.range(4, 7), rng.range(4, 6), rng.range(2.8, 4.6), { minGround: waterAt(s) + 0.8 });
        }
      }
      // bollards along the quay edge
      for (let s = -88; s <= 82; s += 6) {
        const pp = P(s, side * 39.9, 0);
        const gy = groundY(pp.x, pp.z);
        if (gy > waterAt(s) + 0.5) bollards.add(V(pp.x, gy, pp.z), 0, 1);
      }
    }
    // giant inflatable duck mascot on the left quay
    {
      const pp = P(-30, 50, 0);
      const gy = groundY(pp.x, pp.z);
      const mParts = [];
      mParts.push(colorize(place(new THREE.SphereGeometry(1, 20, 14), 0, 2.4, 0, 0, 0, 0, 3.2, 2.5, 4.2), 0xffd93b));
      mParts.push(colorize(place(new THREE.SphereGeometry(1, 18, 12), 0, 5.6, 2.4, 0, 0, 0, 1.8, 1.8, 1.8), 0xffd93b));
      mParts.push(colorize(place(new THREE.CylinderGeometry(0.2, 0.8, 1.6, 12), 0, 5.3, 4.4, Math.PI / 2, 0, 0, 1.4, 1, 0.6), 0xff8a00));
      mParts.push(colorize(place(new THREE.SphereGeometry(0.25, 8, 6), 1.1, 6.1, 3.7), 0x111111));
      mParts.push(colorize(place(new THREE.SphereGeometry(0.25, 8, 6), -1.1, 6.1, 3.7), 0x111111));
      mParts.push(colorize(place(new THREE.ConeGeometry(1.2, 2, 4), 0, 3.8, -3.8, -2.2, Math.PI / 4, 0), 0xffd93b));
      const mascot = mergedMesh(mParts, { flat: false });
      mascot.position.set(pp.x, gy, pp.z);
      mascot.rotation.y = yawAt(-30) + Math.PI * 0.75;
      g.add(mascot);
    }
    // moored boats in the basin behind the start
    const boatParts = [];
    const hullGeo = new THREE.BoxGeometry(2.2, 0.8, 5);
    // taper the bow
    {
      const p = hullGeo.attributes.position;
      for (let i = 0; i < p.count; i++) if (p.getZ(i) > 0) p.setX(i, p.getX(i) * 0.35);
      p.needsUpdate = true;
    }
    const boats = [];
    for (let k = 0; k < 7; k++) {
      const s = rng.range(-85, -30);
      const lat = rng.pick([-1, 1]) * rng.range(14, 33);
      const grp = dyn(new THREE.Group());
      const col = rng.pick([0xffffff, 0x3d7be0, 0xe8412e, 0x16b8a6, 0xffd23f]);
      grp.add(mergedMesh([colorize(hullGeo.clone(), col), colorize(place(new THREE.BoxGeometry(1.4, 0.9, 1.6), 0, 0.8, -0.6), 0xf4f1ea), colorize(place(new THREE.CylinderGeometry(0.05, 0.05, 5, 6), 0, 3, 0.5), 0xdddddd)], { flat: false }));
      const pp = P(s, lat, 0.25);
      grp.position.copy(pp);
      grp.rotation.y = yawAt(s) + rng.range(-0.6, 0.6);
      Object.assign(grp.userData, { base: pp.y, phase: rng.range(0, 6), s, lat });
      boats.push(grp);
      g.add(grp);
      // a couple of spectators aboard
      addPerson(V(pp.x + 0.3, pp.y + 0.4, pp.z - 0.3), grp.rotation.y);
      throwerSpots.push({ s, pos: V(pp.x, pp.y + 1.2, pp.z), kind: 'boat' });
    }
    addUpdater((dt, ctx) => {
      for (const bt of boats) {
        bt.position.y = bt.userData.base + Math.sin(ctx.realTime * 1.3 + bt.userData.phase) * 0.12;
        bt.rotation.z = Math.sin(ctx.realTime * 1.1 + bt.userData.phase) * 0.04;
      }
    });
  }

  // ================================================================== CANYON
  {
    curSec = 'canyon';
    const g = sections.canyon.group;
    // buoy lines along both channel edges (canyon + a bit of the marina exit): bobbing spheres ~55% out of
    // the water, alternating red/white, each with a white band and a dark lifting eye on top
    const buoyGeo = new THREE.SphereGeometry(0.42, 10, 8);
    buoyGeo.translate(0, 0.04, 0);
    const buoyBandGeo = (() => {
      const parts = [colorize(place(new THREE.CylinderGeometry(0.405, 0.425, 0.13, 12, 1, true), 0, 0.2, 0), 0xffffff), colorize(place(new THREE.CylinderGeometry(0.06, 0.08, 0.14, 6), 0, 0.5, 0), 0x2b333b)];
      return mergedMesh(parts, { flat: false }).geometry;
    })();
    const buoys = new Instancer(buoyGeo, lam(0xffffff), { colors: true });
    const buoyBands = new Instancer(buoyBandGeo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    const buoyList = [];
    for (let s = 40; s < F.lilyInS - 4; s += 7) {
      const half = halfAt(s) - 0.7;
      for (const side of [-1, 1]) {
        const pos = P(s, side * half, 0);
        buoys.add(pos, 0, 1, (Math.round(s / 7) + (side > 0 ? 1 : 0)) % 2 ? PAL.buoyRed : PAL.buoyWhite);
        buoyBands.add(pos, 0, 1);
        buoyList.push({ s, lat: side * half });
      }
    }
    const buoyMesh = dyn(buoys.build('buoys'));
    const buoyBandMesh = dyn(buoyBands.build('buoy-bands'));
    g.add(buoyMesh, buoyBandMesh);
    {
      const m = new THREE.Matrix4();
      const pos = V();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const sc = V(1, 1, 1);
      addUpdater((dt, ctx) => {
        // bob + rock with the waves (cheap: ~90 instances)
        for (let i = 0; i < buoyList.length; i++) {
          const b = buoyList[i];
          const ph = ctx.realTime * 2.4 + b.s * 0.35 + b.lat;
          P(b.s, b.lat, Math.sin(ph) * 0.09 - 0.04, pos);
          e.set(Math.sin(ph * 0.8) * 0.12, 0, Math.cos(ph * 0.7 + i) * 0.12);
          q.setFromEuler(e);
          m.compose(pos, q, sc);
          buoyMesh.setMatrixAt(i, m);
          buoyBandMesh.setMatrixAt(i, m);
        }
        buoyMesh.instanceMatrix.needsUpdate = true;
        buoyBandMesh.instanceMatrix.needsUpdate = true;
      });
    }

    // pines: dense along the canyon rim (within ~15 m of the cliff edge), thinner further back on the plateau
    {
      const probe = V();
      const flatAround = (s, side, d, gy) => {
        P(s, side * (d + 2.5), 0, probe);
        if (Math.abs(groundY(probe.x, probe.z) - gy) > 0.9) return false;
        P(s, side * (d - 1.5), 0, probe);
        return Math.abs(groundY(probe.x, probe.z) - gy) < 1.0;
      };
      const bands = [{ n: Math.round(230 * quality.trees), d0: 4.8, d1: 19 }, { n: Math.round(90 * quality.trees), d0: 19, d1: 60 }];
      for (const bandDef of bands) {
        let placed = 0;
        let guard = 0;
        while (placed < bandDef.n && guard++ < 6000) {
          const s = rng.range(F.canyonInS - 6, F.lilyInS + 12);
          if (Math.abs(s - 205) < 7) continue; // rope-bridge abutments
          if (CANYON_FALLS.some((fl) => Math.abs(s - fl.s) < fl.w / 2 + 3.5)) continue; // keep the waterfall notches clear
          const prof = profileAt(course, s);
          const side = rng.pick([-1, 1]);
          const vis = side > 0 ? prof.visL : prof.visR;
          const d = vis + rng.range(bandDef.d0, bandDef.d1);
          const pp = P(s, side * d, 0);
          const gy = groundY(pp.x, pp.z);
          if (gy < prof.y + 6) continue; // up on the plateau only
          if (!flatAround(s, side, d, gy)) continue; // not on a terrace ledge / hanging over the face
          plantAt(pines, pp.x, gy, pp.z, treeScale(), 0.25);
          placed++;
        }
      }
    }

    // angular boulders half-sunk at the cliff foot (the lowest terrace band's stone, so they read as fallen wall)
    const rocks = new Instancer(rockGeo, rockWarmMat);
    for (let s = F.canyonInS + 4; s < F.lilyInS - 6; s += rng.range(5, 10)) {
      for (const side of [-1, 1]) {
        if (rng.chance(0.35)) continue;
        const half = halfAt(s);
        const sc = rng.range(0.9, 2.1);
        const pp = P(s, side * (half + rng.range(0.6, 2.2)), -sc * rng.range(0.15, 0.4));
        rocks.add(pp, 0, [sc * rng.range(0.8, 1.25), sc * rng.range(0.7, 1.0), sc], null, [rng.range(-0.35, 0.35), rng.range(0, 6.28), rng.range(-0.35, 0.35)]);
      }
    }
    g.add(cullable(rocks.build('canyon-rocks')));

    // waterfalls: one cascade per rim notch (CANYON_FALLS from cliffs.js), full height from the cliff top down
    // to the water. The sheet follows the bank profile sampled at build time (terrain.heightAt), sitting
    // ~0.4 m proud of the outermost rock at every height, with dark wet strips either side, a foam
    // splat and mist puffs at the foot.
    const fallFoamGeo = new THREE.CircleGeometry(1, 20);
    const fallFoamMat = basic(0xffffff, { transparent: true, opacity: 0.5, depthWrite: false });
    const wetMat = lam(0x3a2c22, { transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
    const mistPuffs = []; // { pos, size, phase }
    const fallFoams = []; // { pos, w, s, yaw }
    const sheetGeos = [];
    const wetGeos = [];
    for (const fdef of CANYON_FALLS) {
      const s = fdef.s;
      const side = fdef.side;
      const w = clamp(fdef.w, 3, 4);
      const prof = profileAt(course, s);
      const vis = side > 0 ? prof.visL : prof.visR;
      const tmp = V();
      // bank profile y(d) at this station
      const scan = [];
      for (let d = vis - 1; d <= vis + 10; d += 0.2) {
        P(s, side * d, 0, tmp);
        scan.push({ d, y: groundY(tmp.x, tmp.z) });
      }
      const footY = P(s, side * (vis + 0.2), 0, tmp).y;
      let topY = -Infinity;
      for (const q of scan) if (q.d <= vis + 8) topY = Math.max(topY, q.y);
      const h = topY - 0.2 - footY;
      if (h < 4) continue;
      // outermost rock at each height, then a running minimum from the lip down (water never tucks under an overhang)
      const N = 30;
      const dS = new Float32Array(N + 1);
      for (let k = 0; k <= N; k++) {
        const y = footY + h * (k / N);
        let dRock = vis + 8;
        for (const q of scan) if (q.y >= y - 0.05) { dRock = Math.min(dRock, q.d); break; }
        dS[k] = dRock;
      }
      for (let k = N - 1; k >= 0; k--) dS[k] = Math.min(dS[k], dS[k + 1]);
      // soften the staircase a little (still monotonic), then stand the sheet 0.4 m proud
      for (let pass = 0; pass < 2; pass++) for (let k = 1; k < N; k++) dS[k] = Math.min(dS[k], (dS[k - 1] + 2 * dS[k] + dS[k + 1]) / 4);
      for (let k = 0; k <= N; k++) dS[k] -= 0.4;
      dS[0] = Math.min(dS[0], vis - 0.3); // splash out over the water at the foot
      const lipD = dS[N];
      // sheet + wet strips as one strip builder: columns across the width (along the course), rows up the fall
      const buildStrip = (x0, x1, inset, cols) => {
        const pos = [];
        const uvs = [];
        const idx = [];
        for (let k = 0; k <= N; k++) {
          const y = footY + h * (k / N) + 0.05;
          for (let c = 0; c <= cols; c++) {
            const u = c / cols;
            const xoff = lerp(x0, x1, u);
            const bulge = Math.sin(Math.PI * u) * 0.18 * (cols > 1 ? 1 : 0);
            P(s + xoff, side * (dS[k] + inset - bulge), 0, tmp);
            pos.push(tmp.x, y, tmp.z);
            uvs.push(u, k / N);
          }
        }
        for (let k = 0; k < N; k++) {
          for (let c = 0; c < cols; c++) {
            const a = k * (cols + 1) + c;
            idx.push(a, a + 1, a + cols + 1, a + 1, a + cols + 2, a + cols + 1);
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        return geo;
      };
      sheetGeos.push(buildStrip(-w / 2, w / 2, 0, 4));
      for (const sx of [-1, 1]) wetGeos.push(buildStrip(sx * (w / 2 - 0.1), sx * (w / 2 + 0.8), 0.28, 1));
      // foam splat + mist at the foot
      const base = P(s, side * (vis - 0.6), 0.14);
      fallFoams.push({ pos: base, w, s, yaw: yawAt(s) });
      for (let k = 0; k < 6; k++) {
        const mp = P(s + rng.range(-w * 0.6, w * 0.6), side * (vis - rng.range(0.2, 2.2)), rng.range(0.15, 0.6)); // sitting on the water
        mistPuffs.push({ pos: mp, size: rng.range(1.0, 1.8), phase: rng.range(0, 6.28) });
      }
      // a couple of puffs part-way up where the cascade hits the ledges
      for (let k = 0; k < 2; k++) {
        const ky = rng.range(0.25, 0.6);
        const mp = P(s + rng.range(-w * 0.3, w * 0.3), side * (dS[Math.round(ky * N)] - 0.5), 0);
        mp.y = footY + h * ky;
        mistPuffs.push({ pos: mp, size: rng.range(0.9, 1.5), phase: rng.range(0, 6.28) });
      }
      fdef.lipD = lipD;
    }
    if (sheetGeos.length) {
      // all cascades share one sheet mesh (the animated fall material) and one wet-rock mesh
      const mergeRaw = (geos) => {
        const pos = [];
        const uv = [];
        const idx = [];
        let base = 0;
        for (const gq of geos) {
          const pa = gq.attributes.position;
          const ua = gq.attributes.uv;
          for (let i = 0; i < pa.count; i++) { pos.push(pa.getX(i), pa.getY(i), pa.getZ(i)); uv.push(ua.getX(i), ua.getY(i)); }
          const ia = gq.index.array;
          for (let i = 0; i < ia.length; i++) idx.push(ia[i] + base);
          base += pa.count;
        }
        const out = new THREE.BufferGeometry();
        out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        out.setIndex(idx);
        out.computeVertexNormals();
        return out;
      };
      const sheet = new THREE.Mesh(mergeRaw(sheetGeos), fallMat);
      sheet.renderOrder = 3;
      sheet.name = 'waterfalls';
      const wet = new THREE.Mesh(mergeRaw(wetGeos), wetMat);
      wet.renderOrder = 2;
      wet.name = 'waterfall-wet';
      g.add(wet, sheet);
      const foamIM = dyn(new THREE.InstancedMesh(fallFoamGeo, fallFoamMat, fallFoams.length));
      foamIM.renderOrder = 4;
      foamIM.frustumCulled = false;
      foamIM.name = 'waterfall-foam';
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const sc = V();
      addUpdater((dt, ctx) => {
        for (let i = 0; i < fallFoams.length; i++) {
          const ff = fallFoams[i];
          const k = 1 + Math.sin(ctx.realTime * 7 + ff.s) * 0.06;
          e.set(-Math.PI / 2, 0, -ff.yaw);
          q.setFromEuler(e);
          sc.set(ff.w * 0.75 * k, ff.w * 0.55 * k, 1);
          m.compose(ff.pos, q, sc);
          foamIM.setMatrixAt(i, m);
        }
        foamIM.instanceMatrix.needsUpdate = true;
      });
      g.add(foamIM);
    }
    // mist: one instanced mesh of three crossed soft quads per puff (additive, no billboarding needed)
    const mistTex = canvasTexture(128, 128, (ctx2, cw, ch) => {
      const grd = ctx2.createRadialGradient(cw / 2, ch / 2, 0, cw / 2, ch / 2, cw / 2);
      grd.addColorStop(0, 'rgba(255,255,255,0.8)');
      grd.addColorStop(0.5, 'rgba(255,255,255,0.35)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      ctx2.fillStyle = grd;
      ctx2.fillRect(0, 0, cw, ch);
    });
    if (mistPuffs.length) {
      const pg = new THREE.PlaneGeometry(1, 1);
      const puffGeo = mergedMesh([pg.clone(), pg.clone().rotateY(Math.PI / 3), pg.clone().rotateY((2 * Math.PI) / 3)], { flat: false }).geometry;
      const puffMat = basic(0xeef6ff, { map: mistTex, transparent: true, opacity: 0.15, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, fog: true });
      const puffs = dyn(new THREE.InstancedMesh(puffGeo, puffMat, mistPuffs.length));
      puffs.frustumCulled = false;
      puffs.renderOrder = 5;
      puffs.name = 'fall-mist';
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const pos = V();
      const sc = V();
      addUpdater((dt, ctx) => {
        for (let i = 0; i < mistPuffs.length; i++) {
          const mp = mistPuffs[i];
          const ph = ctx.realTime * 0.7 + mp.phase;
          pos.copy(mp.pos);
          pos.y += Math.sin(ph) * 0.15 + 0.1;
          const k = mp.size * (1 + Math.sin(ph * 1.3) * 0.25);
          sc.set(k, k * 0.8, k);
          e.set(0, ph * 0.15, 0);
          q.setFromEuler(e);
          m.compose(pos, q, sc);
          puffs.setMatrixAt(i, m);
        }
        puffs.instanceMatrix.needsUpdate = true;
      });
      g.add(puffs);
    }

    // rope bridge across the canyon with spectators (a hot-dog thrower spot)
    {
      const s = 205;
      const half = halfAt(s);
      const a = P(s, half + 5, 0);
      const b = P(s, -(half + 5), 0);
      a.y = groundY(a.x, a.z) + 0.2;
      b.y = groundY(b.x, b.z) + 0.2;
      const deckY = Math.max(Math.min(a.y, b.y), waterAt(s) + 7.5); // sags 1.3 m: always clears water + 6
      a.y = b.y = deckY;
      const pts = catenary(a, b, 1.3, 16);
      const parts = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        const midp = V().addVectors(p0, p1).multiplyScalar(0.5);
        const yaw = Math.atan2(p1.x - p0.x, p1.z - p0.z);
        parts.push(colorize(place(new THREE.BoxGeometry(2.2, 0.15, p0.distanceTo(p1) * 0.92), midp.x, midp.y, midp.z, 0, yaw, 0), PAL.woodLight));
      }
      for (const railSide of [-1, 1]) {
        const f = frameAt(s);
        const off = V(f.flat.x, 0, f.flat.z).multiplyScalar(railSide * 1.05);
        const ra = a.clone().add(off);
        ra.y += 1.1;
        const rb = b.clone().add(off);
        rb.y += 1.1;
        const railPts = catenary(ra, rb, 1.3, 16);
        cableGeoms.push(colorize(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPts), 16, 0.04, 3, false), 0x6b4423));
        for (let i = 0; i <= 16; i += 2) parts.push(colorize(place(new THREE.CylinderGeometry(0.04, 0.04, 1.1, 4), railPts[i].x, railPts[i].y - 0.55, railPts[i].z), 0x6b4423));
      }
      g.add(mergedMesh(parts));
      for (let i = 2; i < pts.length - 1; i += 2) addPerson(V(pts[i].x, pts[i].y + 0.08, pts[i].z), yawAt(s) + Math.PI);
      throwerSpots.push({ s, pos: V(pts[8].x, pts[8].y + 1.2, pts[8].z), kind: 'bridge' });
    }

    // gulls wheeling above the canyon: two-tone bodies + separately instanced wings that visibly flap
    {
      const N = 9;
      const gullBody = (() => {
        const parts = [];
        parts.push(colorize(place(new THREE.SphereGeometry(1, 10, 8), 0, 0, 0, 0, 0, 0, 0.28, 0.25, 0.8), 0xf6f4ee)); // body
        parts.push(colorize(place(new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), 0, 0.03, -0.05, 0, 0, 0, 0.29, 0.24, 0.7), 0x9aa4ad)); // grey mantle
        parts.push(colorize(place(new THREE.SphereGeometry(0.2, 8, 6), 0, 0.13, 0.72), 0xf6f4ee)); // head
        parts.push(colorize(place(new THREE.ConeGeometry(0.06, 0.3, 6), 0, 0.09, 1.02, Math.PI / 2, 0, 0), 0xf2b81f)); // bill
        parts.push(colorize(place(new THREE.BoxGeometry(0.36, 0.04, 0.45), 0, 0.02, -0.9), 0x3a3f45)); // tail
        return mergedMesh(parts, { flat: false }).geometry;
      })();
      const gullWing = (() => {
        // right wing, root at x = 0 extending +x; inner white/grey, outer third dark
        const geo = new THREE.BufferGeometry();
        // prettier-ignore
        const v = [
          0, 0, 0.3,   0.8, 0.04, 0.22,   0.8, 0.04, -0.2,    0, 0, 0.3,   0.8, 0.04, -0.2,   0, 0, -0.28,
          0.8, 0.04, 0.22,   1.45, 0, 0.02,   1.45, 0, -0.16,   0.8, 0.04, 0.22,   1.45, 0, -0.16,   0.8, 0.04, -0.2,
        ];
        geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
        const cols = [];
        const cIn = new THREE.Color(0xe9ecef);
        const cOut = new THREE.Color(0x3a3f45);
        for (let i = 0; i < 12; i++) { const c = i < 6 ? cIn : cOut; cols.push(c.r, c.g, c.b); }
        geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
        geo.computeVertexNormals();
        return geo;
      })();
      const gullMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
      const bodies = dyn(new THREE.InstancedMesh(gullBody, gullMat, N));
      const wingsIM = dyn(new THREE.InstancedMesh(gullWing, gullMat, N * 2));
      bodies.frustumCulled = false;
      wingsIM.frustumCulled = false;
      bodies.name = 'gulls';
      const center = P(230, 0, 36);
      const m = new THREE.Matrix4();
      const mw = new THREE.Matrix4();
      const ml = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const one = V(1, 1, 1);
      const pos = V();
      const wingOff = [new THREE.Matrix4().makeTranslation(0.16, 0.08, 0.05), new THREE.Matrix4().makeTranslation(-0.16, 0.08, 0.05)];
      const mirror = new THREE.Matrix4().makeScale(-1, 1, 1);
      addUpdater((dt, ctx) => {
        const rt = ctx.realTime;
        for (let i = 0; i < N; i++) {
          const a = rt * (0.3 + i * 0.017) + i * 0.7;
          const r = 20 + i * 3.5;
          pos.set(center.x + Math.cos(a) * r, center.y + Math.sin(a * 2 + i) * 2.5 + i * 1.2, center.z + Math.sin(a) * r);
          // heading tangent to the circle (counter-clockwise seen from above => yaw = -a), banked into the turn
          e.set(0, -a, -0.35, 'YXZ');
          q.setFromEuler(e);
          m.compose(pos, q, one);
          bodies.setMatrixAt(i, m);
          // flap: bursts of wing beats between glides
          const beat = Math.sin(rt * 9 + i * 1.3);
          const glide = smoothstep(-0.2, 0.4, Math.sin(rt * 0.7 + i * 2.1));
          const flap = beat * 0.7 * glide + 0.12;
          for (let sgn = 0; sgn < 2; sgn++) {
            ml.makeRotationZ(sgn === 0 ? flap : -flap); // tips up for positive flap on both sides
            mw.multiplyMatrices(m, wingOff[sgn]).multiply(ml);
            if (sgn === 1) mw.multiply(mirror);
            wingsIM.setMatrixAt(i * 2 + sgn, mw);
          }
        }
        bodies.instanceMatrix.needsUpdate = true;
        wingsIM.instanceMatrix.needsUpdate = true;
      });
      g.add(bodies, wingsIM);
    }
  }

  // ================================================================== LILY-PAD CHICANE
  const frogs = [];
  {
    curSec = 'lily';
    const g = sections.lily.group;
    const notch = 0.5;
    const padGeo = (() => {
      const top = new THREE.CircleGeometry(1, 16, 0.25, Math.PI * 2 - notch);
      top.rotateX(-Math.PI / 2);
      top.rotateY(-Math.PI / 2); // line the disc's notch up with the wall's (cylinder theta runs from +z)
      top.translate(0, 0.05, 0);
      const wall = new THREE.CylinderGeometry(1, 1, 0.1, 16, 1, true, 0.25, Math.PI * 2 - notch);
      return mergedMesh([colorize(top, 0xffffff), colorize(wall, 0xffffff)], { flat: false }).geometry;
    })();
    // darker rim ring merged in (vertex colour multiplies the per-instance green)
    const rimGeo = new THREE.TorusGeometry(0.97, 0.05, 3, 16, Math.PI * 2 - notch);
    rimGeo.rotateX(Math.PI / 2);
    rimGeo.rotateY(-0.25 - (Math.PI * 2 - notch));
    colorize(rimGeo, 0xb8c0b0);
    const padMerged = mergedMesh([padGeo, rimGeo], { flat: false }).geometry;
    const pads = new Instancer(padMerged, new THREE.MeshLambertMaterial({ vertexColors: true }), { colors: true });
    const yRimGeo = new THREE.TorusGeometry(1.0, 0.065, 3, 16, Math.PI * 2 - notch);
    yRimGeo.rotateX(Math.PI / 2);
    yRimGeo.rotateY(-0.25 - (Math.PI * 2 - notch));
    const yellowRims = new Instancer(yRimGeo, lam(COL.lilyRimYellow));
    const flowerGeo = (() => {
      const parts = [];
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        parts.push(colorize(place(new THREE.ConeGeometry(0.22, 0.7, 6), Math.cos(a) * 0.25, 0.35, Math.sin(a) * 0.25, 0.5 * Math.sin(a), 0, -0.5 * Math.cos(a)), k % 2 ? 0xffffff : 0xf0eef4));
      }
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 + 0.3;
        parts.push(colorize(place(new THREE.ConeGeometry(0.15, 0.5, 5), Math.cos(a) * 0.1, 0.42, Math.sin(a) * 0.1, 0.2 * Math.sin(a), 0, -0.2 * Math.cos(a)), 0xffffff));
      }
      parts.push(colorize(place(new THREE.SphereGeometry(0.14, 8, 6), 0, 0.42, 0), 0xffd23f));
      return mergedMesh(parts, { flat: false }).geometry;
    })();
    const flowers = new Instancer(flowerGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), { colors: true });
    const LOTUS = [0xffffff, 0xff8fc0, 0xffb3d1, 0xff6fa8];
    const padSpots = [];
    const pondPads = []; // candidate spots for flowers / dragonflies
    const tilt = (3 * Math.PI) / 180;
    function addPad(s, lat, r) {
      const pos = P(s, lat, 0.05 + rng.range(0, 0.03));
      const rot = [rng.range(-tilt, tilt), rng.range(0, 6.28), rng.range(-tilt, tilt)];
      pads.add(pos, 0, [r, 1, r], rng.pick(COL.lily), rot);
      if (rng.chance(0.3)) yellowRims.add(pos, 0, [r, 1, r], null, rot);
      return pos;
    }
    // slalom rafts: the sim weaves ducks with sin(2pi (s - lilyIn)/52); a tight raft of 5-9 pads (two big ones +
    // smaller company) sits on the OTHER side each half-period, so the open lane reads clearly from the chase cam
    const laneSpots = []; // pads bordering the racing line (lotus flowers go here)
    for (let s = F.lilyInS + 13; s < F.dropApproachS - 12; s += 26) {
      const phase = Math.sin((2 * Math.PI * (s - F.lilyInS)) / 52);
      const half = halfAt(s) - 1.2;
      const side = -Math.sign(phase) || 1;
      const latC = side * half * 0.62;
      const nPads = rng.int(5, 9);
      for (let k = 0; k < nPads; k++) {
        const big = k < 2;
        const r = big ? rng.range(2.6, 3.5) : rng.range(0.7, 1.6);
        const a = big ? k * Math.PI + rng.range(-0.4, 0.4) : rng.range(0, 6.28);
        const rr = big ? 2.2 : rng.range(3.8, 6.2);
        const ss = s + Math.cos(a) * rr * 1.3;
        let lat = latC + Math.sin(a) * rr;
        lat = side * clamp(Math.abs(lat), r + 0.8, half + 1.2 - r * 0.3); // never across the centre line: the lane stays open
        const pos = addPad(ss, lat, r);
        if (big) padSpots.push({ s: ss, lat, r, pos });
        if (Math.abs(lat) - r < 2.5) laneSpots.push({ s: ss, lat, r, pos });
      }
    }
    // pond pads outside the racing channel, in clusters of 5-9
    for (let s = F.lilyInS - 4; s < F.dropApproachS + 4; s += rng.range(8, 12)) {
      const prof = profileAt(course, s);
      for (const side of [-1, 1]) {
        const vis = side > 0 ? prof.visL : prof.visR;
        if (vis < prof.half + 6) continue;
        const latC = side * rng.range(prof.half + 4, vis - 3);
        const n = rng.int(5, 9);
        for (let k = 0; k < n; k++) {
          const a = rng.range(0, 6.28);
          const rr = Math.sqrt(rng.next()) * 3.6;
          const r = k === 0 ? rng.range(1.6, 2.2) : rng.range(0.5, 1.7);
          let lat = latC + Math.sin(a) * rr;
          // stay in the pond: between the channel edge and the bank
          lat = side * clamp(Math.abs(lat), prof.half + 1.5, vis - 0.8);
          const pos = addPad(s + Math.cos(a) * rr, lat, r);
          pondPads.push({ s: s + Math.cos(a) * rr, lat, r, pos });
        }
      }
    }
    // ~30 lotus flowers in two sizes (white and pinks): out in the pond, plus a good showing on the raft pads that
    // border the racing line (where the chase cam actually looks)
    {
      const picks = pondPads.filter((_, i) => i % 3 === 1).slice(0, 18).concat(laneSpots.slice(0, 8), padSpots.slice(0, 4));
      for (const pd of picks) {
        const big = rng.chance(0.45);
        const fp = P(pd.s + rng.range(-0.3, 0.3) * pd.r, pd.lat + rng.range(-0.3, 0.3) * pd.r, 0.1);
        flowers.add(fp, rng.range(0, 6.28), big ? rng.range(1.05, 1.3) : rng.range(0.65, 0.85), rng.pick(LOTUS));
      }
    }
    g.add(cullable(pads.build('lilypads')), cullable(yellowRims.build('lily-rims')), cullable(flowers.build('lotus')));

    // wooden jetty poking out from the left bank with peg fishermen (also a hot-dog thrower spot)
    {
      const s = F.lilyInS + 58;
      const prof = profileAt(course, s);
      const vis = prof.visL;
      const lat0 = vis + 3.5; // bank end (buried in the bank)
      const lat1 = prof.half + 2.8; // pond end, short of the racing channel
      const deckY = waterAt(s) + 0.75;
      const a = P(s, lat0, 0);
      const b = P(s, lat1, 0);
      a.y = b.y = deckY;
      const len = a.distanceTo(b);
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      const parts = [];
      const nPl = Math.floor(len / 0.5);
      const tmpj = V();
      for (let i = 0; i < nPl; i++) {
        tmpj.lerpVectors(a, b, (i + 0.5) / nPl);
        parts.push(colorize(place(new THREE.BoxGeometry(1.9, 0.09, 0.43), tmpj.x, deckY, tmpj.z, 0, yaw + rng.range(-0.03, 0.03), 0), i % 3 ? PAL.woodLight : 0xb98550));
      }
      // bearers + posts
      for (const side2 of [-1, 1]) {
        const off = V(Math.cos(yaw) * side2 * 0.85, 0, -Math.sin(yaw) * side2 * 0.85);
        const ra = a.clone().add(off);
        const rb = b.clone().add(off);
        const mid = V().addVectors(ra, rb).multiplyScalar(0.5);
        parts.push(colorize(place(new THREE.BoxGeometry(0.16, 0.18, len), mid.x, deckY - 0.13, mid.z, 0, yaw, 0), PAL.woodDark));
        const nPosts = Math.floor(len / 3);
        for (let i = 0; i <= nPosts; i++) {
          const pp = V().lerpVectors(ra, rb, i / nPosts);
          const tall = i === nPosts || i % 2 === 0;
          parts.push(colorize(place(new THREE.CylinderGeometry(0.1, 0.12, 2.2 + (tall ? 0.7 : 0), 6), pp.x, deckY - 1.1 + (tall ? 0.35 : 0), pp.z), PAL.woodDark));
        }
      }
      // fishing rods resting on the end rail
      for (const k of [-1, 1]) {
        const rod = new THREE.CylinderGeometry(0.02, 0.03, 3.2, 4);
        rod.translate(0, 1.6, 0);
        rod.rotateX(0.95); // lean out over the water, then yaw with the jetty
        const rp = V().lerpVectors(a, b, 0.97).add(V(Math.cos(yaw) * k * 0.5, 0, -Math.sin(yaw) * k * 0.5));
        parts.push(colorize(place(rod, rp.x, deckY + 0.5, rp.z, 0, yaw + k * 0.25, 0), 0x5a4630));
      }
      g.add(mergedMesh(parts));
      const fwdYaw = yaw; // people face out along the jetty / toward the channel
      for (const t of [0.93, 0.85, 0.6, 0.35]) {
        const pp = V().lerpVectors(a, b, t);
        pp.y = deckY + 0.05;
        pp.x += Math.cos(yaw) * rng.range(-0.5, 0.5);
        pp.z -= Math.sin(yaw) * rng.range(-0.5, 0.5);
        addPerson(pp, fwdYaw + rng.range(-0.6, 0.6));
      }
      throwerSpots.push({ s, pos: V(b.x, deckY + 1.2, b.z), kind: 'pier' });
    }

    // dragonflies darting over the pads (tiny emissive cyan, instanced; state in typed arrays, no per-frame allocation)
    {
      const N = 8;
      const dfGeo = mergedMesh([colorize(new THREE.BoxGeometry(0.06, 0.06, 0.42), 0x5ff0ff), colorize(place(new THREE.BoxGeometry(0.5, 0.012, 0.1), 0, 0.03, 0.05), 0xd8fbff), colorize(place(new THREE.BoxGeometry(0.42, 0.012, 0.08), 0, 0.03, -0.06), 0xd8fbff)], { flat: false }).geometry;
      const dfMesh = dyn(new THREE.InstancedMesh(dfGeo, basic(0xffffff, { vertexColors: true }), N));
      dfMesh.frustumCulled = false;
      dfMesh.name = 'dragonflies';
      const home = new Float32Array(N * 3);
      const cur = new Float32Array(N * 3);
      const period = new Float32Array(N);
      const yawA = new Float32Array(N);
      const spots = pondPads.length ? pondPads : padSpots;
      for (let i = 0; i < N; i++) {
        const pd = spots[(i * 7 + 3) % spots.length];
        home[i * 3] = pd.pos.x;
        home[i * 3 + 1] = pd.pos.y + rng.range(0.7, 1.6);
        home[i * 3 + 2] = pd.pos.z;
        cur[i * 3] = pd.pos.x;
        cur[i * 3 + 1] = home[i * 3 + 1];
        cur[i * 3 + 2] = pd.pos.z;
        period[i] = rng.range(0.7, 1.5);
      }
      const hsh = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const pos = V();
      const one = V(1, 1, 1);
      addUpdater((dt, ctx) => {
        const rt = ctx.realTime;
        const k = 1 - Math.exp(-Math.min(dt, 0.1) * 7);
        for (let i = 0; i < N; i++) {
          const slot = Math.floor(rt / period[i]) + i * 31;
          const tx = home[i * 3] + (hsh(slot) - 0.5) * 6;
          const ty = home[i * 3 + 1] + (hsh(slot + 0.37) - 0.5) * 0.8 + Math.sin(rt * 3 + i) * 0.08;
          const tz = home[i * 3 + 2] + (hsh(slot + 0.71) - 0.5) * 6;
          const dx = tx - cur[i * 3];
          const dz = tz - cur[i * 3 + 2];
          cur[i * 3] += dx * k;
          cur[i * 3 + 1] += (ty - cur[i * 3 + 1]) * k;
          cur[i * 3 + 2] += dz * k;
          pos.set(cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2]);
          if (dx * dx + dz * dz > 1e-4) yawA[i] = Math.atan2(dx, dz);
          e.set(0, yawA[i], 0);
          q.setFromEuler(e);
          m.compose(pos, q, one);
          dfMesh.setMatrixAt(i, m);
        }
        dfMesh.instanceMatrix.needsUpdate = true;
      });
      g.add(dfMesh);
    }

    // frogs that leap as the pack arrives
    const frogGeo = (() => {
      const parts = [];
      parts.push(colorize(place(new THREE.SphereGeometry(0.35, 12, 8), 0, 0.25, 0, 0, 0, 0, 1, 0.7, 1.2), 0x4caf50));
      parts.push(colorize(place(new THREE.SphereGeometry(0.12, 8, 6), 0.17, 0.5, 0.28), 0xffffff));
      parts.push(colorize(place(new THREE.SphereGeometry(0.12, 8, 6), -0.17, 0.5, 0.28), 0xffffff));
      parts.push(colorize(place(new THREE.SphereGeometry(0.06, 6, 4), 0.19, 0.52, 0.38), 0x111111));
      parts.push(colorize(place(new THREE.SphereGeometry(0.06, 6, 4), -0.19, 0.52, 0.38), 0x111111));
      parts.push(colorize(place(new THREE.BoxGeometry(0.18, 0.1, 0.5), 0.35, 0.08, -0.15, 0, 0.5, 0), 0x3b8c3f));
      parts.push(colorize(place(new THREE.BoxGeometry(0.18, 0.1, 0.5), -0.35, 0.08, -0.15, 0, -0.5, 0), 0x3b8c3f));
      return mergedMesh(parts, { flat: false }).geometry;
    })();
    const frogMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const chosen = padSpots.filter((_, i) => i % 2 === 0).slice(0, 6);
    for (const spot of chosen) {
      const frog = dyn(new THREE.Mesh(frogGeo, frogMat));
      frog.scale.setScalar(1.5);
      const home = spot.pos.clone();
      home.y += 0.12;
      frog.position.copy(home);
      faceAlong(frog, spot.s, true); // face the oncoming ducks
      const away = P(spot.s + 3, spot.lat + (spot.lat > 0 ? 4.5 : -4.5), 0);
      frogs.push({ mesh: frog, home, away, s: spot.s, trigger: spot.s - 16, state: 'sit', t0: 0, splashed: false });
      g.add(frog);
    }
    addUpdater((dt, ctx) => {
      for (const fr of frogs) {
        const lead = ctx.leaderS ?? -1e9;
        if (lead < fr.trigger || ctx.phase !== 'race') {
          fr.state = 'sit';
          fr.mesh.visible = true;
          fr.mesh.position.copy(fr.home);
          fr.mesh.position.y = fr.home.y + Math.max(0, Math.sin(ctx.realTime * 2 + fr.s)) * 0.03;
          fr.splashed = false;
          fr.t0 = ctx.t;
          continue;
        }
        // leap: 0.75 s arc, then gone (under water) until reset
        const e = (ctx.t - fr.t0) / 0.75;
        if (e < 1) {
          fr.mesh.visible = true;
          fr.mesh.position.lerpVectors(fr.home, fr.away, e);
          fr.mesh.position.y += Math.sin(Math.PI * e) * 2.6;
          fr.mesh.rotation.x = -0.8 + e * 1.9;
        } else {
          if (!fr.splashed && ctx.fx) {
            ctx.fx.splash(fr.away, 0.8);
            fr.splashed = true;
          }
          fr.mesh.visible = false;
          fr.mesh.rotation.x = 0;
        }
      }
    });
    // a sign
  }

  // ================================================================== THE DROP (weir)
  const mist = [];
  {
    curSec = 'drop';
    const g = sections.drop.group;
    const lip = F.dropLipS;
    const half = halfAt(lip);
    const fl = frameAt(lip);
    const lipY = fl.y;
    const landY = course.at(F.dropLandS).y;
    const parts = [];
    // weir wall (crest just under the lip water level), spanning the channel
    const wallH = lipY - landY + 2.5;
    // stone-block weir face, set just behind the (near-vertical) falling sheet
    {
      const blockW = 2.2;
      const nb = Math.ceil((2 * half + 8) / blockW);
      const rowsN = Math.ceil(wallH / 1.3);
      for (let r = 0; r < rowsN; r++) {
        for (let k = 0; k < nb; k++) {
          const lat = -half - 4 + (k + 0.5 + (r % 2 ? 0.5 : 0)) * blockW;
          if (lat > half + 4) continue;
          const cpos = P(lip + 0.2, lat, -0.18 - (r + 0.5) * 1.3);
          const shade = [0x9d9385, 0xa89d8c, 0x8f8577][(k + r) % 3];
          parts.push(colorize(place(new THREE.BoxGeometry(blockW - 0.1, 1.25, 2.2), cpos.x, cpos.y, cpos.z, 0, yawAt(lip), 0), shade));
        }
      }
    }
    // stone abutment towers each side carrying a level timber gantry with the sign, spectators and flags.
    // The chase camera crests the weir at ~lipY + 4.8 right under the gantry, so everything spanning the
    // channel (beam, sign, bunting) keeps its underside at or above lipY + 7.
    const towerTop = lipY + 10.45;
    const yawLip = yawAt(lip);
    const lx = V(fl.left.x, 0, fl.left.z);
    const fz = V(fl.flat.x, 0, fl.flat.z);
    for (const side of [-1, 1]) {
      const pp = P(lip, side * (half + 3.2), 0);
      const towerH = towerTop - 0.5 - (lipY - 3);
      parts.push(colorize(place(new THREE.BoxGeometry(3.2, towerH, 4.5), pp.x, lipY - 3 + towerH / 2, pp.z, 0, yawLip, 0), 0xb3a48f));
      // string course + arrow-slit details so the taller tower doesn't read as a blank box
      parts.push(colorize(place(new THREE.BoxGeometry(3.35, 0.35, 4.65), pp.x, lipY + 4.2, pp.z, 0, yawLip, 0), 0xa39784));
      for (const k of [-1, 1]) {
        const sl = pp.clone().addScaledVector(lx, -side * 1.62).addScaledVector(fz, k * 1.1);
        parts.push(colorize(place(new THREE.BoxGeometry(0.08, 1.4, 0.28), sl.x, lipY + 6.6, sl.z, 0, yawLip, 0), 0x3a3128));
      }
      parts.push(colorize(place(new THREE.BoxGeometry(3.6, 0.5, 4.9), pp.x, towerTop - 0.25, pp.z, 0, yawLip, 0), 0x8b7d6b));
      // 8 merlons on the cap's real perimeter: corners + edge midpoints
      for (const [mx, mz] of [[-1.45, -2.1], [0, -2.1], [1.45, -2.1], [-1.45, 0], [1.45, 0], [-1.45, 2.1], [0, 2.1], [1.45, 2.1]]) {
        const wp = pp.clone().addScaledVector(lx, mx).addScaledVector(fz, mz);
        parts.push(colorize(place(new THREE.BoxGeometry(0.7, 0.7, 0.7), wp.x, towerTop + 0.35, wp.z, 0, yawLip, 0), 0xb3a48f));
      }
      // spectators on the roof, looking upstream at the oncoming pack
      for (let k = 0; k < 5; k++) {
        const wp = pp.clone().addScaledVector(lx, rng.range(-0.9, 0.9)).addScaledVector(fz, rng.range(-1.4, 1.4));
        wp.y = towerTop;
        addPerson(wp, yawLip + Math.PI + rng.range(-0.5, 0.5));
      }
      // flag on the outer upstream corner
      const fp = pp.clone().addScaledVector(lx, side * 1.15).addScaledVector(fz, -1.75);
      parts.push(colorize(place(new THREE.CylinderGeometry(0.05, 0.06, 3.4, 5), fp.x, towerTop + 1.7, fp.z), 0xdddddd));
      const flagOff = fp.clone().addScaledVector(fz, -0.6);
      parts.push(colorize(place(new THREE.BoxGeometry(0.04, 0.75, 1.2), flagOff.x, towerTop + 2.95, flagOff.z, 0, yawLip, side * 0.08), side < 0 ? 0xe8412e : 0xffd23f));
    }
    // level cross-beam resting on the two caps (ends over the tower centres)
    const beamY = towerTop + 0.3;
    const beamA = P(lip, half + 3.2, 0);
    const beamB = P(lip, -(half + 3.2), 0);
    beamA.y = beamB.y = beamY;
    const bm = V().addVectors(beamA, beamB).multiplyScalar(0.5);
    parts.push(colorize(place(new THREE.BoxGeometry(beamA.distanceTo(beamB) + 0.6, 0.6, 0.55), bm.x, bm.y, bm.z, 0, yawLip, 0), PAL.woodDark)); // local x = across the channel
    // hanger struts for the sign
    for (const k of [-3.6, 3.6]) {
      const hp = bm.clone().addScaledVector(lx, k);
      parts.push(colorize(place(new THREE.BoxGeometry(0.12, 0.4, 0.12), hp.x, beamY - 0.4, hp.z), PAL.woodDark));
    }
    g.add(mergedMesh(parts));
    const signTex = bannerTexture('THE DROP', { w: 1024, h: 256, bg: '#d9493b', fg: '#ffffff', accent: '#14202e' });
    const sign = twoSided(signTex, 9, 2.2);
    sign.position.copy(bm).y = beamY - 1.55; // underside at lipY + 8.1
    sign.rotation.y = yawLip;
    g.add(sign);
    // pennants along the top of the beam + bunting swagged underneath the sign
    {
      const n = Math.floor(beamA.distanceTo(beamB) / 1.1);
      for (let i = 1; i < n; i++) {
        const fpp = V().lerpVectors(beamA, beamB, i / n);
        fpp.y = beamY + 0.85;
        flags.add(fpp, Math.atan2(lx.x, lx.z) + Math.PI / 2, 0.8, PAL.bunting[i % PAL.bunting.length]); // pennant planes contain the beam
        cableGeoms.push(colorize(place(new THREE.CylinderGeometry(0.02, 0.02, 0.6, 3), fpp.x, beamY + 0.58, fpp.z), 0x333333));
      }
    }
    const bA = P(lip - 1, half + 2.4, 0);
    const bB = P(lip - 1, -(half + 2.4), 0);
    bA.y = bB.y = beamY - 2.75; // cable low point lipY + 7.6, pennant tips ~lipY + 7.0
    addBunting(bA, bB, 0.4, 0.7);
    // rocks flanking the plunge pool (half-sunk)
    const rocks = new Instancer(rockGeo, rockMat);
    for (let s = F.dropLandS - 8; s < F.tunnelInS - 2; s += rng.range(2.5, 5)) {
      for (const side of [-1, 1]) {
        const sc = rng.range(1, 2.4);
        const pp = P(s, side * (halfAt(s) + rng.range(0.5, 3)), -sc * rng.range(0.1, 0.35));
        rocks.add(pp, 0, [sc, sc * 0.7, sc * 1.1], null, [rng.range(-0.3, 0.3), rng.range(0, 6.28), rng.range(-0.3, 0.3)]);
      }
    }
    g.add(cullable(rocks.build('drop-rocks')));
    // big faceted boulders (3-5 m, some moss-capped) cladding the steep Drop banks in two loose rows, so the bank
    // reads as tumbled rock rather than a few huge heightfield triangles
    {
      const geos = [];
      const bp = V();
      for (const side of [-1, 1]) {
        for (let s = F.dropApproachS - 4; s < F.tunnelInS - 9; s += rng.range(3.0, 4.4)) {
          if (Math.abs(s - lip) < 5) continue; // the weir's abutment towers stand here
          const prof = profileAt(course, s);
          if (prof.drop < 0.3) continue;
          const vis = side > 0 ? prof.visL : prof.visR;
          for (const row of [0.3, 0.75]) {
            if (row > 0.5 && rng.chance(0.35)) continue;
            const ss = s + rng.range(-1, 1);
            const lat = side * (vis + prof.slopeW * row + rng.range(-0.3, 0.7));
            P(ss, lat, 0, bp);
            const gy = groundY(bp.x, bp.z);
            const wy = waterAt(ss);
            const size = rng.range(3, 5) * (row > 0.5 ? 0.75 : 1);
            const sc = [size * 0.5 * rng.range(0.9, 1.2), size * 0.5 * rng.range(0.6, 0.85), size * 0.5 * rng.range(0.9, 1.1)];
            const centre = V(bp.x, Math.max(gy, wy + 0.2) - sc[1] * 0.3, bp.z);
            geos.push(boulderGeo(rng.int(0, 2), centre, sc, [rng.range(-0.3, 0.3), rng.range(0, 6.28), rng.range(-0.3, 0.3)], wy, size > 3.6 && rng.chance(0.55), ss * 0.37 + lat));
          }
        }
      }
      if (geos.length) {
        const bm = mergedMesh(geos, { material: boulderMat });
        bm.name = 'drop-bank-boulders';
        g.add(bm);
      }
    }
    // mist sprites over the plunge pool
    const mistTex = canvasTexture(128, 128, (ctx2, w, h) => {
      const grd = ctx2.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      grd.addColorStop(0, 'rgba(255,255,255,0.8)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      ctx2.fillStyle = grd;
      ctx2.fillRect(0, 0, w, h);
    });
    const mistMat = new THREE.SpriteMaterial({ map: mistTex, transparent: true, depthWrite: false, opacity: 0.25, fog: true });
    for (let k = 0; k < 10; k++) {
      const sp = dyn(new THREE.Sprite(mistMat));
      const base = P(F.dropLandS - 4 + rng.range(-4, 6), rng.range(-half, half), rng.range(0.2, 1.2));
      sp.position.copy(base);
      sp.scale.setScalar(rng.range(2.5, 4.5));
      Object.assign(sp.userData, { base, phase: rng.range(0, 6), size: sp.scale.x });
      mist.push(sp);
      g.add(sp);
    }
    addUpdater((dt, ctx) => {
      for (const sp of mist) {
        const ph = ctx.realTime * 0.6 + sp.userData.phase;
        sp.position.y = sp.userData.base.y + Math.sin(ph) * 0.4 + 0.3;
        const k = 1 + Math.sin(ph * 1.3) * 0.2;
        sp.scale.setScalar(sp.userData.size * k);
      }
    });
  }

  // ================================================================== LOG-FLUME TUNNEL
  const tunnelInfo = { s0: F.tunnelInS - 3, s1: F.tunnelOutS + 3 };
  {
    curSec = 'tunnel';
    const g = sections.tunnel.group;
    const s0 = tunnelInfo.s0;
    const s1 = tunnelInfo.s1;
    const step = 3;
    const rows = Math.floor((s1 - s0) / step) + 1;
    const K = 14; // verts around the arch
    const pos = new Float32Array(rows * (K + 1) * 3);
    const col = new Float32Array(rows * (K + 1) * 3);
    const c1 = new THREE.Color(PAL.wood);
    const c2 = new THREE.Color(PAL.woodDark);
    const c3 = new THREE.Color(0x4a3020);
    const tmp = V();
    const H = 5.4;
    for (let r = 0; r < rows; r++) {
      const s = s0 + r * step;
      const R = halfAt(s) + 1.4;
      const ringCol = r % 2 ? c1 : c2;
      for (let k = 0; k <= K; k++) {
        const a = lerp(-0.12 * Math.PI, 1.12 * Math.PI, k / K);
        P(s, Math.cos(a) * R, Math.sin(a) * H - 0.15, tmp);
        const i = r * (K + 1) + k;
        pos[i * 3] = tmp.x;
        pos[i * 3 + 1] = tmp.y;
        pos[i * 3 + 2] = tmp.z;
        const cc = k % 3 === 0 ? c3 : ringCol;
        const shade = 0.75 + 0.25 * Math.sin(k * 1.3 + r * 0.7);
        col[i * 3] = cc.r * shade;
        col[i * 3 + 1] = cc.g * shade;
        col[i * 3 + 2] = cc.b * shade;
      }
    }
    const idx = [];
    for (let r = 0; r < rows - 1; r++) for (let k = 0; k < K; k++) { const a = r * (K + 1) + k; const b = a + 1; const d = a + K + 1; const e = d + 1; idx.push(a, b, d, b, e, d); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const tube = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }));
    tube.name = 'flume';
    g.add(tube);
    // portal frames + lanterns
    const portalParts = [];
    const portalLanterns = [];
    for (const s of [s0 + 0.5, s1 - 0.5]) {
      const R = halfAt(s) + 1.9;
      const segsN = 12;
      for (let k = 0; k < segsN; k++) {
        const a0 = lerp(-0.05 * Math.PI, 1.05 * Math.PI, k / segsN);
        const a1 = lerp(-0.05 * Math.PI, 1.05 * Math.PI, (k + 1) / segsN);
        const pA = P(s, Math.cos(a0) * R, Math.sin(a0) * (H + 0.5) - 0.2);
        const pB = P(s, Math.cos(a1) * R, Math.sin(a1) * (H + 0.5) - 0.2);
        const midp = V().addVectors(pA, pB).multiplyScalar(0.5);
        const len = pA.distanceTo(pB);
        const boxG = new THREE.BoxGeometry(1.0, len + 0.3, 1.2);
        const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), V().subVectors(pB, pA).normalize());
        boxG.applyQuaternion(q);
        boxG.translate(midp.x, midp.y, midp.z);
        portalParts.push(colorize(boxG, 0x5a3a1e));
      }
      for (const side of [-1, 1]) portalLanterns.push(P(s + (s < (s0 + s1) / 2 ? -0.8 : 0.8), side * (R - 1.2), 3.6));
    }
    // light shafts from roof holes + glow pools on the water
    const shaftMat = basic(0xfff1c4, { transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, blending: THREE.AdditiveBlending, fog: false });
    // soft-edged glow pool (radial gradient) so it reads as light on the water, not a disc
    const poolTex = canvasTexture(128, 128, (c, w, h) => {
      const grd = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      grd.addColorStop(0, 'rgba(255,241,196,1)');
      grd.addColorStop(0.45, 'rgba(255,241,196,0.55)');
      grd.addColorStop(1, 'rgba(255,241,196,0)');
      c.fillStyle = grd;
      c.fillRect(0, 0, w, h);
    });
    const poolMat = basic(0xffffff, { map: poolTex, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const shafts = [];
    for (let s = s0 + 16; s < s1 - 10; s += 19) {
      const lat = rng.range(-2.5, 2.5);
      const top = P(s, lat, H - 0.3);
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.9, H + 0.4, 14, 1, true), shaftMat);
      shaft.position.copy(top).y -= (H + 0.4) / 2 - 0.2;
      shaft.rotation.z = rng.range(-0.12, 0.12);
      shaft.renderOrder = 6;
      g.add(shaft);
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 5.2), poolMat);
      pool.rotation.x = -Math.PI / 2;
      P(s, lat, 0.15, pool.position);
      pool.renderOrder = 5;
      g.add(pool);
      const hole = new THREE.Mesh(new THREE.CircleGeometry(0.55, 12), basic(0xfff8e0, { fog: false }));
      hole.rotation.x = Math.PI / 2;
      hole.position.copy(top).y += 0.05;
      g.add(hole);
      shafts.push({ shaft, pool, s });
    }
    addUpdater((dt, ctx) => {
      for (const sh of shafts) sh.shaft.material.opacity = 0.13 + Math.sin(ctx.realTime * 1.5 + sh.s) * 0.03;
    });
    // wooden ribs every 6 m standing proud of the tube wall, a plank strip along the ceiling, and a lantern
    // hanging from each rib (emissive globe + soft additive glow card + warm pool on the water)
    const ribParts = [];
    const lanternPts = []; // { pos, s }
    {
      const segsN = 12;
      const yAxis = V(0, 1, 0);
      for (let s = s0 + 3; s < s1 - 2; s += 6) {
        const R = halfAt(s) + 1.4 - 0.32;
        const HH = H - 0.32;
        for (let k = 0; k < segsN; k++) {
          const a0 = lerp(-0.06 * Math.PI, 1.06 * Math.PI, k / segsN);
          const a1 = lerp(-0.06 * Math.PI, 1.06 * Math.PI, (k + 1) / segsN);
          const pA = P(s, Math.cos(a0) * R, Math.sin(a0) * HH - 0.15);
          const pB = P(s, Math.cos(a1) * R, Math.sin(a1) * HH - 0.15);
          const midp = V().addVectors(pA, pB).multiplyScalar(0.5);
          const boxG = new THREE.BoxGeometry(0.42, pA.distanceTo(pB) + 0.15, 0.5);
          boxG.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(yAxis, V().subVectors(pB, pA).normalize()));
          boxG.translate(midp.x, midp.y, midp.z);
          ribParts.push(colorize(boxG, k % 2 ? 0x4a2e16 : 0x553519));
        }
        const lp = P(s, 0, H - 1.25);
        lanternPts.push({ pos: lp, s });
        ribParts.push(colorize(place(new THREE.CylinderGeometry(0.015, 0.015, 0.75, 4), lp.x, lp.y + 0.55, lp.z), 0x222222)); // cord
        ribParts.push(colorize(place(new THREE.CylinderGeometry(0.2, 0.12, 0.16, 8), lp.x, lp.y + 0.27, lp.z), 0x3a2a1a)); // cap
      }
      // ceiling plank strip (two boards with a gap) following the apex
      for (let s = s0 + 1.5; s < s1 - 1.5; s += 3) {
        const pa = P(s, 0, H - 0.47);
        const pb = P(s + 3, 0, H - 0.47);
        const midp = V().addVectors(pa, pb).multiplyScalar(0.5);
        const yaw = Math.atan2(pb.x - pa.x, pb.z - pa.z);
        for (const off of [-0.42, 0.42]) {
          const f2 = frameAt(s + 1.5);
          ribParts.push(colorize(place(new THREE.BoxGeometry(0.7, 0.1, pa.distanceTo(pb) + 0.02), midp.x + f2.left.x * off, midp.y, midp.z + f2.left.z * off, 0, yaw, 0), off < 0 ? 0x7a5230 : 0x6e4828));
        }
      }
    }
    g.add(mergedMesh(portalParts.concat(ribParts)));
    {
      // each lantern: a small hot core, an amber shade around it, two additive glow cards (4 m at 0.35 and a
      // faint 8 m halo) facing along the flume, and a warm pool of light on the water underneath
      const coreGeo = new THREE.SphereGeometry(0.25, 12, 8);
      const cores = new Instancer(coreGeo, basic(0xffe2a8, { fog: false }));
      const shades = new Instancer(new THREE.SphereGeometry(0.36, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), basic(COL.lantern, { fog: false, transparent: true, opacity: 0.55, depthWrite: false }));
      for (const lp of portalLanterns) { cores.add(lp, 0, 1.1); shades.add(lp, 0, 1.1); }
      const glowTex = canvasTexture(128, 128, (c2, cw, ch) => {
        const grd = c2.createRadialGradient(cw / 2, ch / 2, 0, cw / 2, ch / 2, cw / 2);
        grd.addColorStop(0, 'rgba(255,220,150,1)');
        grd.addColorStop(0.25, 'rgba(255,190,100,0.55)');
        grd.addColorStop(1, 'rgba(255,170,80,0)');
        c2.fillStyle = grd;
        c2.fillRect(0, 0, cw, ch);
      });
      const glowOpts = { map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true, fog: false };
      const glows = new Instancer(new THREE.PlaneGeometry(4, 4), basic(0xffffff, { ...glowOpts, opacity: 0.35 }));
      const halos = new Instancer(new THREE.PlaneGeometry(8, 8), basic(0xffd8a0, { ...glowOpts, opacity: 0.12 }));
      const warmPoolMat = basic(0xffd89a, { map: glowTex, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      const warmPools = new Instancer(new THREE.PlaneGeometry(5, 5), warmPoolMat);
      for (const lpt of lanternPts) {
        cores.add(lpt.pos, 0, 1);
        shades.add(lpt.pos, 0, 1);
        glows.add(lpt.pos, yawAt(lpt.s), 1);
        halos.add(lpt.pos, yawAt(lpt.s), 1);
        warmPools.add(P(lpt.s, 0, 0.16), yawAt(lpt.s), 1, null, [-Math.PI / 2, 0, 0]);
      }
      const glowMesh = cullable(glows.build('lantern-glow'));
      glowMesh.renderOrder = 6;
      const haloMesh = cullable(halos.build('lantern-halo'));
      haloMesh.renderOrder = 6;
      const poolMesh = cullable(warmPools.build('lantern-pools'));
      poolMesh.renderOrder = 5;
      g.add(cullable(cores.build('lanterns')), cullable(shades.build('lantern-shades')), glowMesh, haloMesh, poolMesh);
    }
    // glow-worms: 6 dense constellations on the upper walls / ceiling between lanterns
    const wormGeo = new THREE.SphereGeometry(0.065, 4, 3);
    const worms = new Instancer(wormGeo, basic(0x9dffd0, { fog: false }), { colors: true });
    for (let c = 0; c < 6; c++) {
      const sc0 = lerp(s0 + 10, s1 - 10, (c + rng.range(0.2, 0.8)) / 6);
      const ac = rng.range(0.28 * Math.PI, 0.72 * Math.PI) + (c % 2 ? 0.12 : -0.12);
      const nPts = rng.int(40, 60);
      for (let k = 0; k < nPts; k++) {
        // sum of uniforms ~ soft gaussian cluster, with a few outliers
        const ds = (rng.next() + rng.next() + rng.next() - 1.5) * 2.6 * (k % 9 === 0 ? 2.2 : 1);
        const da = (rng.next() + rng.next() - 1) * 0.42;
        const s = clamp(sc0 + ds, s0 + 4, s1 - 4);
        const a = clamp(ac + da, 0.16 * Math.PI, 0.84 * Math.PI);
        const R = halfAt(s) + 1.3;
        worms.add(P(s, Math.cos(a) * (R - 0.15), Math.sin(a) * (H - 0.25) - 0.15), 0, rng.range(0.6, 1.7), rng.pick([0x9dffd0, 0x7fe8ff, 0xd0ff8a, 0xb8fff0]));
      }
    }
    g.add(cullable(worms.build('glowworms')));
    // bright "daylight" card just outside the exit portal: only faces into the tunnel, fades in while the camera is inside
    {
      const sExit = s1 + 1.2;
      const R = halfAt(sExit) + 2.2;
      const card = new THREE.Mesh(new THREE.CircleGeometry(1, 28), basic(0xfff4dc, { transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      P(sExit, 0, H * 0.42, card.position);
      card.scale.set(R, H * 0.62 + 0.6, 1);
      card.rotation.y = yawAt(s1) + Math.PI; // normal points back up the tunnel; back-face culled from outside
      card.renderOrder = 7;
      card.name = 'tunnel-daylight';
      g.add(card);
      const axis = lanternPts.map((l) => P(l.s, 0, 2.2));
      let kIn = 0;
      addUpdater((dt, ctx) => {
        let inside = 0;
        if (ctx.camPos) {
          for (let i = 0; i < axis.length; i++) {
            if (axis[i].distanceToSquared(ctx.camPos) < 40) { inside = 1; break; }
          }
        }
        kIn = lerp(kIn, inside, Math.min(1, dt * (inside ? 4 : 2)));
        card.material.opacity = 0.6 * kIn;
        card.visible = kIn > 0.01;
      });
    }
    // timber walkway along the right wall
    const walk = [];
    for (let s = s0 + 2; s < s1 - 2; s += 4) {
      const R = halfAt(s) + 1.4;
      const pp = P(s + 2, -(R - 1.1), 0.9);
      walk.push(colorize(place(new THREE.BoxGeometry(1.4, 0.12, 4.05), pp.x, pp.y, pp.z, 0, yawAt(s + 2), 0), PAL.woodLight));
      const post = P(s, -(R - 0.5), 0.2);
      walk.push(colorize(place(new THREE.CylinderGeometry(0.08, 0.08, 1.6, 5), post.x, post.y, post.z), PAL.woodDark));
    }
    g.add(mergedMesh(walk));
  }

  // ================================================================== RAPIDS
  {
    curSec = 'rapids';
    const g = sections.rapids.group;
    // rocks: three shape variants merged into one vertex-coloured mesh -- light dry tops, a dark wet band at
    // the waterline, moss caps on ~30% of the big ones -- plus 4 hero rocks just off the racing line
    const rockParts = [];
    const collars = []; // emergent rocks: { x, y, z, r, yaw, s }
    function addRock(s, lat, sub, sc, variant, mossy) {
      const pp = P(s, lat, 0);
      const wy = pp.y;
      const rot = [rng.range(0, 3), rng.range(0, 6.28), rng.range(-0.4, 0.4)];
      let geo = boulderGeo(variant, V(pp.x, wy + sub, pp.z), sc, rot, wy, mossy, s * 0.37 + lat);
      const measure = (gq) => {
        let top = -Infinity;
        let rW = 0;
        const pos = gq.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const rel = pos.getY(i) - wy;
          top = Math.max(top, rel);
          if (Math.abs(rel) < 0.35) rW = Math.max(rW, Math.hypot(pos.getX(i) - pp.x, pos.getZ(i) - pp.z));
        }
        return { top, rW };
      };
      let { top, rW } = measure(geo);
      if (top <= 0.02) return; // fully under the (opaque) water: nothing to draw
      if (top < 0.3) {
        // barely awash: a lone flat facet floating on the foam reads as a manta ray -- lift it so it has sides
        geo = boulderGeo(variant, V(pp.x, wy + sub + (0.32 - top), pp.z), sc, rot, wy, mossy, s * 0.37 + lat);
        ({ top, rW } = measure(geo));
      }
      rockParts.push(geo);
      if (rW > 0.2) collars.push({ x: pp.x, y: wy + 0.11, z: pp.z, r: rW, yaw: yawAt(s), s });
    }
    for (let s = F.tunnelOutS + 6; s < F.harborInS - 4; s += rng.range(3, 6)) {
      for (const side of [-1, 1]) {
        const half = halfAt(s);
        if (rng.chance(0.75)) {
          // bank rocks: big, mostly emergent
          const sc = rng.range(0.7, 2.8);
          addRock(s, side * (half + rng.range(-0.8, 2.5)), rng.range(-0.35, 0.25) * sc, [sc * rng.range(0.9, 1.3), sc * rng.range(0.55, 0.85), sc * rng.range(0.9, 1.2)], rng.int(0, 2), sc > 1.5 && rng.chance(0.42));
        } else {
          // mid-channel bonkers: small, mostly awash
          const sc = rng.range(0.55, 0.95);
          addRock(s, side * rng.range(0.5, half - 2), -sc * rng.range(0.25, 0.6), [sc * rng.range(0.9, 1.4), sc * rng.range(0.6, 0.9), sc], rng.int(0, 1), false);
        }
      }
    }
    // hero rocks near (not on) the racing line
    {
      const span = F.harborInS - 4 - (F.tunnelOutS + 6);
      [0.16, 0.45, 0.82].forEach((t, i) => {
        const s = F.tunnelOutS + 6 + span * t + rng.range(-4, 4);
        if (Math.abs(s - 764) < 10) return; // keep the bridge arch clear
        const side = i % 2 ? 1 : -1;
        const half = halfAt(s);
        const sc = rng.range(3.2, 3.6);
        addRock(s, side * (half + rng.range(0.2, 1.2)), -0.9, [sc * 0.75, sc * 0.55, sc * 0.9], i % 3, rng.chance(0.6));
      });
    }
    {
      const rockMesh = mergedMesh(rockParts, { material: boulderMat });
      rockMesh.name = 'rapids-rocks';
      g.add(rockMesh);
    }
    // foam collars: an irregular soft-edged splat at each emergent rock's true waterline radius plus a short
    // V streak trailing downstream (vertex-alpha geometry, one instanced mesh, gently pulsing)
    {
      const pos = [];
      const col = [];
      const idx = [];
      const ring = (rIn, rOut, aIn, aOut, wobIn, wobOut, seg = 18) => {
        const base = pos.length / 3;
        for (let i = 0; i <= seg; i++) {
          const th = (i / seg) * Math.PI * 2;
          const wi = 1 + wobIn * (0.6 * Math.sin(3 * th + 1) + 0.4 * Math.sin(7 * th + 2));
          const wo = 1 + wobOut * (0.5 * Math.sin(3 * th + 0.6) + 0.3 * Math.sin(5 * th + 2.2) + 0.2 * Math.sin(11 * th));
          pos.push(Math.cos(th) * rIn * wi, 0, Math.sin(th) * rIn * wi, Math.cos(th) * rOut * wo, 0, Math.sin(th) * rOut * wo);
          col.push(1, 1, 1, aIn, 1, 1, 1, aOut);
          if (i < seg) {
            const a = base + i * 2;
            idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
          }
        }
      };
      ring(0.78, 1.0, 0.0, 0.95, 0.05, 0.08);
      ring(1.0, 1.3, 0.95, 0.55, 0.08, 0.14);
      ring(1.3, 1.75, 0.55, 0.0, 0.14, 0.22);
      // V streak: two tapering strips downstream (+z in unit space), fading out
      for (const sx of [-1, 1]) {
        const base = pos.length / 3;
        const segs = 4;
        for (let k = 0; k <= segs; k++) {
          const t = k / segs;
          const cx = sx * (0.95 + 0.75 * t);
          const cz = 0.35 + 3.4 * t;
          const w = 0.32 + 0.4 * t;
          pos.push(cx - w * 0.5, 0, cz, cx + w * 0.5, 0, cz);
          const a = 0.75 * (1 - t) * (1 - t);
          col.push(1, 1, 1, k === 0 ? 0.4 : a, 1, 1, 1, k === 0 ? 0.4 : a);
          if (k < segs) {
            const a0 = base + k * 2;
            idx.push(a0, a0 + 2, a0 + 1, a0 + 1, a0 + 2, a0 + 3);
          }
        }
      }
      const splatGeo = new THREE.BufferGeometry();
      splatGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      splatGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
      splatGeo.setIndex(idx);
      splatGeo.computeVertexNormals();
      const splatMat = basic(0xffffff, { vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.FrontSide });
      const splats = dyn(new THREE.InstancedMesh(splatGeo, splatMat, Math.max(1, collars.length)));
      splats.count = collars.length;
      splats.renderOrder = 4;
      splats.frustumCulled = false;
      splats.name = 'rock-collars';
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const pv = V();
      const sv = V();
      addUpdater((dt, ctx) => {
        for (let i = 0; i < collars.length; i++) {
          const c = collars[i];
          const k = c.r * (1 + 0.07 * Math.sin(ctx.realTime * 5 + c.s));
          pv.set(c.x, c.y + Math.sin(ctx.realTime * 2.4 + c.s * 0.35) * 0.05, c.z);
          sv.set(k, 1, k);
          e.set(0, c.yaw, 0);
          q.setFromEuler(e);
          m.compose(pv, q, sv);
          splats.setMatrixAt(i, m);
        }
        splats.instanceMatrix.needsUpdate = true;
      });
      g.add(splats);
    }
    // two fallen logs on the banks
    {
      const logParts = [];
      for (const [s, side, along] of [[F.tunnelOutS + 48, 1, 0.5], [F.harborInS - 55, -1, -0.9]]) {
        const prof = profileAt(course, s);
        const vis = side > 0 ? prof.visL : prof.visR;
        const pp = P(s, side * (vis + 5.5), 0);
        const gy = groundY(pp.x, pp.z);
        if (gy < prof.y + 0.4) continue;
        const yaw = yawAt(s) + along;
        const log = new THREE.CylinderGeometry(0.42, 0.5, 6.5, 9);
        log.rotateX(Math.PI / 2 + 0.05); // lie down first (axis -> +z), then yaw
        logParts.push(colorize(place(log, pp.x, gy + 0.38, pp.z, 0, yaw, 0), COL.trunk));
        for (const end of [-1, 1]) logParts.push(colorize(place(new THREE.CircleGeometry(end < 0 ? 0.5 : 0.42, 9), pp.x + Math.sin(yaw) * end * 3.26, gy + 0.38 + end * 0.16, pp.z + Math.cos(yaw) * end * 3.26, 0, yaw + (end < 0 ? Math.PI : 0), 0), 0xd8b98e));
        logParts.push(colorize(place(new THREE.CylinderGeometry(0.12, 0.16, 1.4, 6), pp.x + Math.sin(yaw) * 1.1, gy + 0.9, pp.z + Math.cos(yaw) * 1.1, 0.5, yaw + 1.2, 0.9), COL.trunk)); // snapped branch
      }
      if (logParts.length) g.add(mergedMesh(logParts));
    }
    // warning sign at the entry
    const signTex = bannerTexture('RAPIDS!', { w: 512, h: 256, bg: '#ffd23f', fg: '#14202e', accent: '#14202e', font: '900 130px system-ui, sans-serif' });
    const sp = P(F.tunnelOutS + 14, halfAt(F.tunnelOutS + 14) + 3.5, 0);
    const gy = groundY(sp.x, sp.z);
    const sign = twoSided(signTex, 3.2, 1.6);
    sign.position.set(sp.x, gy + 2.6, sp.z);
    sign.rotation.y = yawAt(F.tunnelOutS + 14) + Math.PI;
    g.add(sign);
    const postM = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.8, 6), woodDarkMat);
    postM.position.set(sp.x, gy + 1.3, sp.z);
    g.add(postM);
    // stone arch bridge over the rapids with spectators
    {
      const s = 764;
      const half = halfAt(s);
      const parts = [];
      const a = P(s, half + 6, 4.2);
      const b = P(s, -(half + 6), 4.2);
      const deckLen = a.distanceTo(b);
      const midp = V().addVectors(a, b).multiplyScalar(0.5);
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      parts.push(colorize(place(new THREE.BoxGeometry(3.4, 0.6, deckLen), midp.x, midp.y, midp.z, 0, yaw, 0), 0xb3a48f));
      // arch: half torus under the deck
      const arch = new THREE.TorusGeometry(half + 1.5, 0.7, 6, 20, Math.PI);
      const archM = new THREE.Matrix4().makeRotationY(yaw + Math.PI / 2);
      arch.applyMatrix4(archM);
      arch.translate(midp.x, midp.y - (half + 1.5) - 0.2 + (half + 1.5) * 0.0, midp.z);
      // squash vertically so it clears ~4 m
      const ap = arch.attributes.position;
      for (let i = 0; i < ap.count; i++) ap.setY(i, midp.y - 0.4 - (midp.y - 0.4 - ap.getY(i)) * 0.45);
      parts.push(colorize(arch, 0x9d9385));
      for (const side2 of [-1, 1]) parts.push(colorize(place(new THREE.BoxGeometry(0.4, 1.0, deckLen), midp.x + Math.cos(yaw) * side2 * 1.6, midp.y + 0.7, midp.z - Math.sin(yaw) * side2 * 1.6, 0, yaw, 0), 0xa39784));
      g.add(mergedMesh(parts));
      for (let i = 0; i < 9; i++) {
        const pp = V().lerpVectors(a, b, (i + 0.5) / 9);
        pp.y += 0.3;
        addPerson(pp, yawAt(s) + Math.PI);
      }
      throwerSpots.push({ s, pos: V(midp.x, midp.y + 1.5, midp.z), kind: 'bridge' });
    }
  }

  // ================================================================== HARBOUR
  const podium = { spots: [], camPos: null, camLook: null, group: null };
  const fireworkBarges = [];
  let lighthouseBeam = null;
  {
    curSec = 'harbor';
    const g = sections.harbor.group;
    // --- finish arch
    const halfF = halfAt(L);
    const parts = [];
    const chequerTex = canvasTexture(256, 1024, (c, w, h) => {
      const n = 4;
      const sz = w / n;
      for (let y = 0; y < h / sz; y++) for (let x = 0; x < n; x++) { c.fillStyle = (x + y) % 2 ? '#111' : '#fff'; c.fillRect(x * sz, y * sz, sz, sz); }
    });
    chequerTex.wrapS = chequerTex.wrapT = THREE.RepeatWrapping;
    const chequerMat = new THREE.MeshLambertMaterial({ map: chequerTex });
    const floatParts = [];
    for (const side of [-1, 1]) {
      const pp = P(L, side * (halfF + 1.5), 0);
      const pyl = new THREE.Mesh(new THREE.BoxGeometry(1.6, 11, 1.6), chequerMat);
      pyl.position.set(pp.x, pp.y + 5, pp.z);
      pyl.rotation.y = yawAt(L);
      g.add(pyl);
      startFloat(L, side * (halfF + 1.5), 0, floatParts); // rounded white float under each pylon (no post: the pylon stands on it)
      parts.push(colorize(place(new THREE.ConeGeometry(0.9, 1.6, 4), pp.x, pp.y + 11.3, pp.z, 0, yawAt(L), 0), 0xffd23f));
    }
    g.add(mergedMesh(floatParts, { flat: false }));
    // balloon bunches tied to the pylon tops
    {
      const bParts = [];
      for (const side of [-1, 1]) {
        const knot = P(L, side * (halfF + 1.5), 0); // tied to the pylon cap...
        const pp = P(L, side * (halfF + 3.0), 0); // ...leaning outboard so the bunch clears the gold finial
        const topY = knot.y + 10.4;
        for (let k = 0; k < 7; k++) {
          const a = k * 2.4 + side;
          const r = k === 0 ? 0 : 0.75;
          const bx = pp.x + Math.cos(a) * r;
          const bz = pp.z + Math.sin(a) * r;
          const by = topY + 0.7 + (k % 3) * 0.5 + rng.range(0, 0.3);
          bParts.push(colorize(place(new THREE.SphereGeometry(0.48, 10, 8), bx, by, bz, 0, 0, 0, 1, 1.18, 1), PAL.bunting[(k + (side > 0 ? 2 : 0)) % PAL.bunting.length]));
          // string down to the knot on the pylon cap
          const len = Math.hypot(bx - knot.x, by - 0.55 - topY, bz - knot.z);
          const str = new THREE.CylinderGeometry(0.012, 0.012, len, 3);
          str.translate(0, len / 2, 0);
          const dir = V(bx - knot.x, by - 0.55 - topY, bz - knot.z).normalize();
          str.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), dir));
          str.translate(knot.x, topY, knot.z);
          bParts.push(colorize(str, 0xeeeeee));
        }
      }
      g.add(mergedMesh(bParts, { flat: false }));
    }
    const fa = P(L, halfF + 1.5, 10);
    const fb = P(L, -(halfF + 1.5), 10);
    const fm = V().addVectors(fa, fb).multiplyScalar(0.5);
    const finTex = bannerTexture('FINISH', { bg: '#14202e', fg: '#ffffff', accent: '#ffd23f', chequer: true });
    const finBanner = new THREE.Mesh(new THREE.BoxGeometry(fa.distanceTo(fb), 2.6, 0.35), [lam(0x14202e), lam(0x14202e), lam(0x14202e), lam(0x14202e), new THREE.MeshLambertMaterial({ map: finTex }), new THREE.MeshLambertMaterial({ map: finTex })]);
    finBanner.position.copy(fm);
    finBanner.rotation.y = yawAt(L);
    g.add(finBanner);
    addBunting(P(L, halfF + 1.5, 8.5), P(L, -(halfF + 1.5), 8.5), 1.2, 0.7);
    // the finish line itself: a floating black/white chequered rope between the floats, carried by 8 small
    // red/white buoys, all bobbing gently
    {
      const ropeParts = [];
      const la = P(L, halfF + 0.6, 0.12);
      const lb = P(L, -(halfF + 0.6), 0.12);
      const nSeg = 28;
      const segLen = la.distanceTo(lb) / nSeg;
      const ryaw = Math.atan2(lb.x - la.x, lb.z - la.z);
      const rp = V();
      for (let i = 0; i < nSeg; i++) {
        rp.lerpVectors(la, lb, (i + 0.5) / nSeg);
        const rope = new THREE.CylinderGeometry(0.07, 0.07, segLen * 1.02, 6);
        rope.rotateX(Math.PI / 2);
        ropeParts.push(colorize(place(rope, rp.x, rp.y, rp.z, 0, ryaw, 0), i % 2 ? 0x111111 : 0xffffff));
      }
      for (let k = 0; k < 8; k++) {
        rp.lerpVectors(la, lb, (k + 0.5) / 8);
        ropeParts.push(colorize(place(new THREE.SphereGeometry(0.38, 10, 8), rp.x, rp.y + 0.05, rp.z, 0, 0, 0, 1, 0.85, 1), k % 2 ? PAL.buoyWhite : PAL.buoyRed));
        ropeParts.push(colorize(place(new THREE.CylinderGeometry(0.37, 0.39, 0.12, 10, 1, true), rp.x, rp.y + 0.12, rp.z), k % 2 ? PAL.buoyRed : 0xffffff)); // contrasting band
      }
      const finishRope = dyn(mergedMesh(ropeParts, { flat: false }));
      finishRope.name = 'finish-rope';
      const ropeY = finishRope.position.y;
      g.add(finishRope);
      addUpdater((dt, ctx) => { finishRope.position.y = ropeY + Math.sin(ctx.realTime * 2.1) * 0.06; });
    }

    // --- quay-side piers + crowd (town side = right = negative lat)
    for (const s of [L - 95, L - 45, L + 18, L + 70]) {
      const q0 = P(s, -21.5, 0);
      const gy = groundY(q0.x, q0.z);
      const deckY = Math.max(gy, q0.y + 1.3);
      const pierEnd = P(s, -8 - halfF * 0.0 - 6, 0);
      const pa = V(q0.x, deckY, q0.z);
      const pb = V(pierEnd.x, deckY, pierEnd.z);
      if (Math.abs(-14 ) < halfF) { /* keep piers out of the racing channel */ }
      const end = P(s, -(halfF + 2.5), 0);
      pb.set(end.x, deckY, end.z);
      const len = pa.distanceTo(pb);
      const midp = V().addVectors(pa, pb).multiplyScalar(0.5);
      const yaw = Math.atan2(pb.x - pa.x, pb.z - pa.z);
      parts.push(colorize(place(new THREE.BoxGeometry(3, 0.3, len), midp.x, deckY, midp.z, 0, yaw, 0), PAL.woodLight));
      for (let k = 0; k <= 3; k++) {
        const pp = V().lerpVectors(pa, pb, k / 3);
        for (const dx of [-1.2, 1.2]) parts.push(colorize(place(new THREE.CylinderGeometry(0.15, 0.15, 3, 6), pp.x + Math.cos(yaw) * dx, deckY - 1.5, pp.z - Math.sin(yaw) * dx), PAL.woodDark));
      }
      const n = Math.floor(len / 1.3);
      for (let i = 0; i < n; i++) {
        const pp = V().lerpVectors(pa, pb, (i + 0.5) / n);
        pp.y = deckY + 0.15;
        pp.x += Math.cos(yaw) * rng.range(-0.9, 0.9);
        pp.z -= Math.sin(yaw) * rng.range(-0.9, 0.9);
        addPerson(pp, yawAt(s) + Math.PI / 2 + rng.range(-0.5, 0.5));
      }
      throwerSpots.push({ s, pos: V(pb.x, deckY + 1.3, pb.z), kind: 'pier' });
    }
    // crowd along the quay edge: three rows deep on a stepped quay for the last ~60 m before the line,
    // a loose single row elsewhere; bollards + bunting poles along the edge
    {
      const stepS0 = L - 64;
      const stepS1 = L - 4;
      const stepParts = [];
      const segLen = 6;
      for (let s = stepS0; s < stepS1; s += segLen) {
        const sMid = s + segLen / 2;
        for (let r = 0; r < 3; r++) {
          const lat = -(24.1 + r * 1.6);
          const p0 = P(s, lat, 0);
          const p1 = P(s + segLen, lat, 0);
          const gy = Math.max(groundY(p0.x, p0.z), groundY(p1.x, p1.z));
          if (gy < SEA_LEVEL + 0.5) continue;
          const h = 0.45 * (r + 1);
          const midp = V().addVectors(p0, p1).multiplyScalar(0.5);
          const yaw = Math.atan2(p1.x - p0.x, p1.z - p0.z);
          stepParts.push(colorize(place(new THREE.BoxGeometry(1.6, h + 0.6, p0.distanceTo(p1) + 0.05), midp.x, gy + h / 2 - 0.3, midp.z, 0, yaw, 0), r % 2 ? 0xcfc3ae : 0xded3bf));
          const n = Math.floor(segLen / 1.15);
          for (let i = 0; i < n; i++) {
            const pp = V().lerpVectors(p0, p1, (i + rng.range(0.2, 0.8)) / n);
            pp.y = gy + h;
            addPerson(pp, yawAt(sMid) + Math.PI / 2 + rng.range(-0.4, 0.4));
          }
        }
      }
      if (stepParts.length) g.add(mergedMesh(stepParts));
      for (let s = L - 120; s < L + 95; s += 1.5) {
        if (s > stepS0 - 1 && s < stepS1 + 1) { // front row at the foot of the steps
          const pp = P(s, -22.9 - rng.range(0, 0.3), 0);
          pp.y = groundY(pp.x, pp.z);
          if (pp.y > SEA_LEVEL + 0.5 && rng.chance(0.7)) addPerson(pp, yawAt(s) + Math.PI / 2 + rng.range(-0.4, 0.4));
          continue;
        }
        const pp = P(s, -22.5 - rng.range(0, 4), 0);
        pp.y = groundY(pp.x, pp.z);
        if (pp.y < SEA_LEVEL + 0.5) continue;
        addPerson(pp, yawAt(s) + Math.PI / 2 + rng.range(-0.4, 0.4));
      }
      let prev = null;
      for (let s = L - 120; s < L + 100; s += 16) {
        const pp = P(s, -21.2, 0);
        const gy = groundY(pp.x, pp.z);
        parts.push(colorize(place(new THREE.CylinderGeometry(0.08, 0.1, 4.2, 6), pp.x, gy + 2.1, pp.z), 0xf4f1ea));
        const top = V(pp.x, gy + 4.1, pp.z);
        if (prev) addBunting(prev, top, 0.9);
        prev = top;
      }
      for (let s = L - 126; s < L + 100; s += 6) {
        if ([L - 95, L - 45, L + 18, L + 70].some((ps) => Math.abs(s - ps) < 2.5)) continue; // pier roots
        const pp = P(s, -22.75, 0);
        const gy = groundY(pp.x, pp.z);
        if (gy > SEA_LEVEL + 0.6) bollards.add(V(pp.x, gy, pp.z), 0, 1);
      }
    }
    // town houses: three loose rows up the slope behind the quay, doors toward the harbour
    for (let s = L - 130; s < L + 110; s += rng.range(8, 12)) {
      for (let k = 0; k < 3; k++) {
        const lat = -rng.range(34 + k * 18, 46 + k * 22);
        const pp = P(s + rng.range(-3, 3), lat, 0);
        addHouse(pp.x, pp.z, yawAt(s) + Math.PI / 2 + rng.range(-0.2, 0.2), rng.range(4, 7), rng.range(4, 6), rng.range(3, 5.5), { minGround: SEA_LEVEL + 0.8 });
      }
    }

    // --- lighthouse on a rock islet (sea side, near the finish)
    {
      const base = P(L - 18, halfF + 26, 0);
      base.y = SEA_LEVEL;
      const lp = [];
      lp.push(colorize(place(new THREE.CylinderGeometry(7, 9, 3, 9), base.x, base.y + 0.5, base.z), PAL.rockDark));
      const bands = 6;
      for (let k = 0; k < bands; k++) {
        const r0 = 3.2 - k * 0.28;
        const r1 = 3.2 - (k + 1) * 0.28;
        lp.push(colorize(place(new THREE.CylinderGeometry(r1, r0, 3.6, 16), base.x, base.y + 3.8 + k * 3.6, base.z), k % 2 ? 0xf4f1ea : 0xd9493b));
      }
      const topY = base.y + 3.8 + bands * 3.6 - 1.8;
      lp.push(colorize(place(new THREE.CylinderGeometry(2.6, 2.6, 0.4, 16), base.x, topY + 0.2, base.z), 0x39424e)); // gallery
      lp.push(colorize(place(new THREE.TorusGeometry(2.6, 0.08, 4, 24), base.x, topY + 1.3, base.z, Math.PI / 2), 0x39424e));
      lp.push(colorize(place(new THREE.ConeGeometry(2.0, 1.8, 16), base.x, topY + 4.1, base.z), 0xd9493b));
      g.add(mergedMesh(lp, { flat: false }));
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 2.4, 16), basic(0xfff3b0, { fog: false }));
      lamp.position.set(base.x, topY + 1.6, base.z);
      g.add(lamp);
      // very faint by day; brightens a little for the finish / podium celebrations
      const beamMat = basic(0xfff1c4, { transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true, fog: false });
      const beam = dyn(new THREE.Group());
      for (const side of [-1, 1]) {
        const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 2.3, 18, 16, 1, true), beamMat);
        cone.rotation.z = side * Math.PI / 2;
        cone.position.x = side * 9;
        beam.add(cone);
      }
      beam.position.set(base.x, topY + 1.6, base.z);
      g.add(beam);
      lighthouseBeam = beam;
      addUpdater((dt, ctx) => {
        beam.rotation.y = ctx.realTime * 0.7;
        // off by day; sweeps on for the finish / podium celebrations
        const night = ctx.phase === 'finish' || ctx.phase === 'results' ? 1 : 0;
        beamMat.opacity = lerp(beamMat.opacity, 0.12 * night, Math.min(1, dt * 2));
        beam.visible = beamMat.opacity > 0.004;
      });
      // breakwater rocks trailing from the islet along the sea side
      const bw = new Instancer(rockGeo, rockDarkMat);
      for (let s = L - 10; s < L + 120; s += rng.range(2.5, 4)) {
        const pp = P(s, halfF + 30 + rng.range(-2, 2) + (s - L) * 0.05, 0);
        pp.y = SEA_LEVEL + rng.range(-0.6, 0.8);
        const sc = rng.range(1.4, 2.8);
        bw.add(pp, rng.range(0, 6), [sc, sc * 0.7, sc], null, [rng.range(0, 3), rng.range(0, 3), 0]);
      }
      g.add(cullable(bw.build('breakwater')));
    }

    // --- sailboats on the sea side: coloured hulls, white sails with one coloured stripe, heeled ~8 deg and
    // bobbing; three instanced variants
    {
      const sailVariant = (hullCol, stripeCol) => {
        const hullG = new THREE.BoxGeometry(2, 0.9, 5.5);
        const p = hullG.attributes.position;
        for (let i = 0; i < p.count; i++) { if (p.getZ(i) > 0) p.setX(i, p.getX(i) * 0.3); if (p.getY(i) < 0) p.setX(i, p.getX(i) * 0.7); }
        const tri = (pts, colHex) => {
          const g2 = new THREE.BufferGeometry();
          g2.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
          g2.computeVertexNormals();
          return colorize(g2, colHex);
        };
        const parts = [colorize(hullG.toNonIndexed(), hullCol)];
        parts.push(colorize(place(new THREE.BoxGeometry(2.06, 0.12, 5.56), 0, 0.42, 0), 0xf4f1ea)); // gunwale
        parts.push(colorize(place(new THREE.BoxGeometry(1.1, 0.5, 1.5), 0, 0.7, -0.9), 0xf4f1ea)); // cuddy
        parts.push(colorize(place(new THREE.CylinderGeometry(0.06, 0.06, 7.2, 6), 0, 4, 0.3), 0xdddddd)); // mast
        parts.push(colorize(place(new THREE.CylinderGeometry(0.04, 0.04, 3, 5), 0, 1.15, -1.15, Math.PI / 2, 0, 0), 0xdddddd)); // boom
        // mainsail in three bands (middle one coloured) + jib
        const zl = (y) => 0.3 - ((7 - y) / 6) * 2.9; // leech z at height y
        parts.push(tri([0, 1.2, 0.25, 0, 1.2, -2.55, 0, 3.2, zl(3.2), 0, 1.2, 0.25, 0, 3.2, zl(3.2), 0, 3.2, 0.25], 0xffffff));
        parts.push(tri([0, 3.2, 0.25, 0, 3.2, zl(3.2), 0, 4.1, zl(4.1), 0, 3.2, 0.25, 0, 4.1, zl(4.1), 0, 4.1, 0.25], stripeCol));
        parts.push(tri([0, 4.1, 0.25, 0, 4.1, zl(4.1), 0, 7, 0.25], 0xffffff));
        parts.push(tri([0, 1.3, 0.55, 0, 6.2, 0.45, 0, 1.4, 2.5], 0xf7f7f2)); // jib
        return mergedMesh(parts, { flat: false, material: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }) });
      };
      const protos = [sailVariant(0xf4f1ea, COL.sailStripe[0]), sailVariant(0x2e4a7c, COL.sailStripe[2]), sailVariant(0x16b8a6, COL.sailStripe[1])];
      const boatsIM = protos.map((pm, i) => {
        const im = dyn(new THREE.InstancedMesh(pm.geometry, pm.material, 3));
        im.frustumCulled = false;
        im.name = `sailboats-${i}`;
        g.add(im);
        return im;
      });
      const sail = []; // { x, y, z, yaw, heel, phase, v }
      for (let k = 0; k < 9; k++) {
        const s = rng.range(L - 140, L + 130);
        const lat = rng.range(halfF + 8, halfF + 24);
        const pp = P(s, lat, 0.2);
        pp.y = SEA_LEVEL + 0.25;
        sail.push({ x: pp.x, y: pp.y, z: pp.z, yaw: rng.range(0, 6.28), heel: rng.pick([-1, 1]) * rng.range(0.11, 0.16), phase: rng.range(0, 6.28), v: k % 3, slot: Math.floor(k / 3) });
        throwerSpots.push({ s, pos: V(pp.x, pp.y + 1.3, pp.z), kind: 'boat' });
      }
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const pos = V();
      const one = V(1, 1, 1);
      addUpdater((dt, ctx) => {
        for (const b of sail) {
          pos.set(b.x, b.y + Math.sin(ctx.realTime * 1.2 + b.phase) * 0.15, b.z);
          e.set(Math.sin(ctx.realTime * 0.9 + b.phase) * 0.03, b.yaw, b.heel + Math.sin(ctx.realTime + b.phase) * 0.04, 'YXZ');
          q.setFromEuler(e);
          m.compose(pos, q, one);
          boatsIM[b.v].setMatrixAt(b.slot, m);
        }
        for (const im of boatsIM) im.instanceMatrix.needsUpdate = true;
      });
    }

    // --- fireworks barges
    for (const [s, lat] of [[L + 25, halfF + 12], [L - 35, halfF + 16], [L + 80, halfF + 10]]) {
      const pp = P(s, lat, 0.3);
      pp.y = SEA_LEVEL + 0.35;
      parts.push(colorize(place(new THREE.BoxGeometry(4, 0.8, 7), pp.x, pp.y, pp.z, 0, yawAt(s), 0), 0x59636e));
      for (let k = -1; k <= 1; k++) parts.push(colorize(place(new THREE.CylinderGeometry(0.25, 0.25, 1.2, 8), pp.x + k * 1.1, pp.y + 0.9, pp.z), 0x2b333b));
      fireworkBarges.push(V(pp.x, pp.y + 1.5, pp.z));
    }

    // --- podium barge
    {
      const s = L + 52;
      const c = P(s, halfF + 9, 0);
      c.y = SEA_LEVEL + 0.45;
      const yaw = yawAt(s) + Math.PI / 2; // podium faces the town quay
      const grp = dyn(new THREE.Group());
      grp.position.copy(c);
      grp.rotation.y = yaw;
      const pp = [];
      pp.push(colorize(place(new THREE.BoxGeometry(13, 0.9, 7), 0, 0, 0), PAL.woodLight));
      pp.push(colorize(place(new THREE.BoxGeometry(13.4, 0.3, 7.4), 0, -0.4, 0), 0x39424e));
      const blocks = [
        { x: 0, h: 1.9, col: COL.gold, label: '1' },
        { x: -3.3, h: 1.45, col: COL.silver, label: '2' },
        { x: 3.3, h: 1.1, col: COL.bronze, label: '3' },
      ];
      for (const b of blocks) {
        // medal blocks self-illuminate in their own colour so gold/silver/bronze stay saturated on the shadow side
        const blk = new THREE.Mesh(new THREE.BoxGeometry(3, b.h, 3), lam(b.col, { emissive: b.col, emissiveIntensity: 0.35 }));
        blk.position.set(b.x, 0.45 + b.h / 2, 0);
        grp.add(blk);
        pp.push(colorize(place(new THREE.BoxGeometry(3.15, 0.12, 3.15), b.x, 0.45 + b.h - 0.05, 0), 0xffffff)); // white cap edge
        const spot = V(b.x, 0.45 + b.h + 0.02, 0);
        podium.spots.push(spot); // local; converted below
      }
      // back truss with banner
      pp.push(colorize(place(new THREE.BoxGeometry(0.3, 6, 0.3), -6, 3.4, -3), 0x59636e));
      pp.push(colorize(place(new THREE.BoxGeometry(0.3, 6, 0.3), 6, 3.4, -3), 0x59636e));
      grp.add(mergedMesh(pp, { flat: false }));
      const podTex = canvasTexture(1120, 160, (c2, w, h) => {
        c2.fillStyle = '#13233a';
        c2.fillRect(0, 0, w, h);
        c2.fillStyle = '#ffd23f';
        c2.fillRect(0, 0, w, 12);
        c2.fillRect(0, h - 12, w, 12);
        c2.font = '900 96px system-ui, -apple-system, Segoe UI, sans-serif';
        c2.textAlign = 'center';
        c2.textBaseline = 'middle';
        if ('letterSpacing' in c2) c2.letterSpacing = '2px';
        c2.fillText('DRAFT ORDER PODIUM', w / 2, h / 2 + 5, w * 0.94); // solid gold, no keyline
      });
      const pb = twoSided(podTex, 12.3, 1.75, { unlit: true });
      pb.position.set(0, 5.35, -3);
      grp.add(pb);
      for (const b of blocks) {
        const t = canvasTexture(256, 256, (c2, w, h) => {
          c2.clearRect(0, 0, w, h); // transparent: the solid numeral sits straight on the lit block face, no outline
          c2.font = '900 190px system-ui, -apple-system, Segoe UI, sans-serif';
          c2.textAlign = 'center';
          c2.textBaseline = 'middle';
          c2.fillStyle = b.label === '1' ? '#ffffff' : '#14202e'; // white on gold, ink on silver / bronze
          c2.fillText(b.label, w / 2, h / 2 + 10);
        });
        const sz = Math.min(1.5, b.h - 0.15);
        const lbl = new THREE.Mesh(new THREE.PlaneGeometry(sz, sz), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
        lbl.position.set(b.x, 0.45 + b.h / 2, 1.52);
        grp.add(lbl);
      }
      g.add(grp);
      grp.updateMatrixWorld(true);
      podium.spots = podium.spots.map((v) => v.applyMatrix4(grp.matrixWorld));
      podium.group = grp;
      podium.yaw = yaw;
      const look = c.clone();
      look.y += 2.3;
      const camPos = c.clone().add(V(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(13));
      camPos.y += 3.2;
      podium.camPos = camPos;
      podium.camLook = look;
      addUpdater((dt, ctx) => {
        grp.position.y = c.y + Math.sin(ctx.realTime * 1.1) * 0.06;
      });
    }
    g.add(mergedMesh(parts));
  }

  // ================================================================== ITEM BOXES
  curSec = null;
  // ================================================================== ITEM BOXES
  // one instanced mesh; `itemBoxes` are lightweight records (main.js toggles .visible on each and calls popItemBox)
  const itemBoxes = [];
  {
    const tex = canvasTexture(128, 128, (c, w, h) => {
      const grd = c.createLinearGradient(0, 0, w, h);
      grd.addColorStop(0, '#ff5f6d');
      grd.addColorStop(0.35, '#ffc371');
      grd.addColorStop(0.65, '#47e0ff');
      grd.addColorStop(1, '#b06bff');
      c.fillStyle = grd;
      c.fillRect(0, 0, w, h);
      c.strokeStyle = 'rgba(255,255,255,0.9)';
      c.lineWidth = 8;
      c.strokeRect(6, 6, w - 12, h - 12);
      c.fillStyle = '#ffffff';
      c.font = '900 86px system-ui, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('?', w / 2, h / 2 + 6);
    });
    const boxMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.92 });
    const boxGeo = new THREE.BoxGeometry(1.3, 1.3, 1.3);
    F.itemBoxes.forEach((s, row) => {
      const half = halfAt(s) - 2;
      const n = 5;
      for (let k = 0; k < n; k++) {
        const lat = lerp(-half, half, k / (n - 1));
        const rec = { row, s, lat, base: P(s, lat, 1.3), popT: -10, visible: true };
        rec.userData = rec; // old callers read mesh.userData.{row, lat, popT}
        itemBoxes.push(rec);
      }
    });
    const boxIM = dyn(new THREE.InstancedMesh(boxGeo, boxMat, Math.max(1, itemBoxes.length)));
    boxIM.name = 'itemboxes';
    boxIM.frustumCulled = false;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = V();
    const scv = V();
    addUpdater((dt, ctx) => {
      let any = false;
      for (let i = 0; i < itemBoxes.length; i++) {
        const u = itemBoxes[i];
        e.set(Math.sin(ctx.realTime * 1.1 + u.lat) * 0.3, ctx.realTime * 1.6 + u.lat, 0);
        q.setFromEuler(e);
        pos.copy(u.base);
        pos.y += Math.sin(ctx.realTime * 2 + u.lat) * 0.25;
        const since = ctx.t - u.popT;
        let sc = since < 0 || since > 1.4 ? 1 : since < 0.15 ? 1 + since * 4 : since < 1.0 ? 0 : (since - 1.0) / 0.4;
        if (u.visible === false) sc = 0;
        else any = true;
        scv.setScalar(Math.max(sc, 1e-4));
        m4.compose(pos, q, scv);
        boxIM.setMatrixAt(i, m4);
      }
      boxIM.instanceMatrix.needsUpdate = true;
      boxIM.visible = any;
    }, null);
    root.add(boxIM);
  }
  /** Pop the box nearest to (row, lat) at race time t. */
  function popItemBox(row, lat, t) {
    let best = null;
    let bd = Infinity;
    for (const b of itemBoxes) {
      if (b.row !== row) continue;
      const d = Math.abs(b.lat - lat);
      if (d < bd) { bd = d; best = b; }
    }
    if (best) best.popT = t;
  }

  // ================================================================== COMMON: trees, clouds, distance boards
  {
    // --- broadleaf trees: clumps of 3-7 on the marina hills, around the lily meadows and behind the harbour town
    {
      const zones = [
        { sec: 'marina', n: Math.round(34 * quality.trees), s0: F.minS + 5, s1: F.canyonInS - 8, lat0: 52, lat1: 135, sides: [-1, 1] },
        { sec: 'lily', n: Math.round(16 * quality.trees), s0: F.lilyInS, s1: F.dropApproachS, lat0: 30, lat1: 80, sides: [-1, 1], fromVis: true },
        { sec: 'harbor', n: Math.round(18 * quality.trees), s0: L - 140, s1: L + 110, lat0: 40, lat1: 110, sides: [-1] },
        { sec: 'drop', n: Math.round(10 * quality.trees), s0: F.dropApproachS - 10, s1: F.tunnelOutS + 30, lat0: 12, lat1: 45, sides: [-1, 1], fromVis: true },
      ];
      for (const zdef of zones) {
        curSec = zdef.sec;
        let done = 0;
        let guard = 0;
        while (done < zdef.n && guard++ < zdef.n * 30) {
          const s = rng.range(zdef.s0, zdef.s1);
          const prof = profileAt(course, s);
          if (prof.canyon > 0.5) continue;
          const side = rng.pick(zdef.sides);
          const base = zdef.fromVis ? (side > 0 ? prof.visL : prof.visR) + prof.slopeW : 0;
          const lat = side * (base + rng.range(zdef.lat0, zdef.lat1));
          const n = rng.int(3, 7);
          let ok = 0;
          for (let k = 0; k < n; k++) if (plant(leafTrees, s + rng.range(-7, 7), lat + rng.range(-7, 7))) ok++;
          if (ok) done++;
        }
      }
      // a few lone trees between clumps on the marina side hills
      curSec = 'marina';
      for (let k = 0; k < Math.round(30 * quality.trees); k++) plant(leafTrees, rng.range(F.minS, F.canyonInS - 10), rng.pick([-1, 1]) * rng.range(48, 140));
    }
    // --- lily pond: weeping willows leaning over the banks + dense reed clusters along both margins
    curSec = 'lily';
    {
      let placedW = 0;
      for (let k = 0; k < 40 && placedW < 8; k++) {
        const s = lerp(F.lilyInS + 4, F.dropApproachS - 4, (k % 8) / 7) + rng.range(-5, 5);
        const prof = profileAt(course, s);
        const side = k % 2 ? -1 : 1;
        const vis = side > 0 ? prof.visL : prof.visR;
        if (plant(willows, s, side * (vis + prof.slopeW + rng.range(1.5, 5)), rng.range(0.85, 1.25), 0.3)) placedW++;
      }
      const rp = V();
      for (let s = F.lilyInS - 8; s < F.dropApproachS + 6; s += rng.range(5, 8)) {
        const prof = profileAt(course, s);
        for (const side of [-1, 1]) {
          if (rng.chance(0.25)) continue;
          const vis = side > 0 ? prof.visL : prof.visR;
          const cl = rng.int(3, 4); // 3-4 instances x 7 stalks = clusters of ~20-28 reeds
          const latC = side * (vis + rng.range(-1.2, 1.5));
          for (let k = 0; k < cl; k++) {
            const ss = s + rng.range(-1.3, 1.3);
            P(ss, latC + rng.range(-1.2, 1.2), 0, rp);
            rp.y = Math.max(waterAt(ss) - 0.15, groundY(rp.x, rp.z) - 0.1);
            reeds.add(rp, rng.range(0, 6.28), rng.range(0.8, 1.4));
          }
        }
      }
    }
    // --- rapids: pines crowding the banks just behind the granite ledges
    curSec = 'rapids';
    for (let s = F.tunnelOutS + 8; s < F.harborInS - 12; s += rng.range(4, 7)) {
      const prof = profileAt(course, s);
      if (Math.abs(s - 764) < 8) continue; // stone bridge
      for (const side of [-1, 1]) {
        if (rng.next() > quality.trees) continue;
        const vis = side > 0 ? prof.visL : prof.visR;
        plant(pines, s, side * (vis + rng.range(4, 15)));
        if (rng.chance(0.5)) plant(pines, s + rng.range(-2, 2), side * (vis + rng.range(9, 24)));
      }
    }
    // --- harbour: a row of cypresses along the back of the town quay
    curSec = 'harbor';
    for (let s = L - 128; s < L + 96; s += 12) plant(cypresses, s, -29.5, rng.range(0.95, 1.15), 0.1);
    curSec = null;

    // vegetation / houses / quay furniture: one instanced mesh per section (each culls and hides with its section)
    for (const [inst, name] of [[pines, 'pines'], [spruces, 'spruces'], [leafTrees, 'trees'], [bushes, 'bushes'], [willows, 'willows'], [cypresses, 'cypresses'], [reeds, 'reeds'], [houseWalls, 'house-walls'], [houseGables, 'house-gables'], [houseHips, 'house-hips'], [houseTrim, 'house-trim'], [bollards, 'bollards']]) {
      if (!inst.items.length) continue;
      for (const { key, mesh } of inst.buildSplit(name)) (sections[key] ? sections[key].group : root).add(mesh);
    }

    // clouds: bright, soft, flattened puffs ringing the horizon (never over the course), unlit with a gentle
    // white-to-blue-grey vertical gradient so there are no dark undersides
    {
      const cloudProto = (detail) => {
        const parts = [];
        const nBlob = 6;
        for (let k = 0; k < nBlob; k++) {
          const r = 1 + (k % 3) * 0.35;
          parts.push(place(new THREE.IcosahedronGeometry(1, detail), (k - (nBlob - 1) / 2) * 1.1 + Math.sin(k * 1.9) * 0.3, Math.cos(k * 1.7) * 0.35 + (k % 2) * 0.25, Math.sin(k * 2.1) * 0.7, 0, k, 0, r, r * 0.85, r));
        }
        const geo = mergedMesh(parts, { flat: false }).geometry;
        const top = new THREE.Color(0xffffff);
        const bot = new THREE.Color(0xe6edf7);
        geo.computeBoundingBox();
        const y0 = geo.boundingBox.min.y;
        const y1 = geo.boundingBox.max.y;
        colorizeFn(geo, (x, y, z, c) => c.copy(bot).lerp(top, smoothstep(0.15, 0.75, (y - y0) / (y1 - y0))));
        return geo;
      };
      const cloudMat = basic(0xffffff, { vertexColors: true, fog: false });
      const cloudsBig = new Instancer(cloudProto(1), cloudMat);
      const cloudsSmall = new Instancer(cloudProto(1), cloudMat);
      const outline = course.outline(8);
      let cx = 0;
      let cz = 0;
      for (const q of outline) { cx += q.x; cz += q.z; }
      cx /= outline.length;
      cz /= outline.length;
      const farFromCourse = (x, z, min) => {
        for (const q of outline) if ((q.x - x) ** 2 + (q.z - z) ** 2 < min * min) return false;
        return true;
      };
      const bounds = terrain.bounds || { minX: cx - 500, maxX: cx + 500, minZ: cz - 400, maxZ: cz + 400 };
      const defs = [{ n: 18, big: true }, { n: 10, big: false }];
      for (const def of defs) {
        let placed = 0;
        let guard = 0;
        while (placed < def.n && guard++ < 3000) {
          const x = rng.range(bounds.minX - 260, bounds.maxX + 260);
          const z = rng.range(bounds.minZ - 260, bounds.maxZ + 260);
          if (!farFromCourse(x, z, 180)) continue;
          const sc = def.big ? rng.range(11, 17) : rng.range(5, 8);
          // long axis roughly tangential to the ring so they read as banks of cloud on the horizon
          const rotY = Math.atan2(x - cx, z - cz) + Math.PI / 2 + rng.range(-0.4, 0.4);
          (def.big ? cloudsBig : cloudsSmall).add(V(x, rng.range(150, 210), z), rotY, [sc * 1.8, sc * 0.4, sc * 1.15]);
          placed++;
        }
      }
      for (const inst of [cloudsBig, cloudsSmall]) {
        const cloudMesh = inst.build('clouds');
        cloudMesh.renderOrder = -1;
        root.add(cloudMesh);
      }

      // distant mountains: two unlit silhouette ranges closing the horizon all round. Every ridge point keeps a
      // fixed clearance from the whole course, so from any race camera they sit 350-800 m off, pre-faded toward
      // the fog colour (far range paler) with their feet exactly fog-coloured so they melt into the haze line.
      {
        const fogC = new THREE.Color(PAL.fog);
        const tintC = new THREE.Color(0x7690a8);
        const coarse = course.outline(24);
        const clearOf = (x, z) => {
          let m = Infinity;
          for (const q of coarse) m = Math.min(m, (q.x - x) ** 2 + (q.z - z) ** 2);
          return Math.sqrt(m);
        };
        const pos = [];
        const cols = [];
        const ridge = (ring) => {
          const N = 84;
          const pts = [];
          for (let i = 0; i < N; i++) {
            const a = (i / N) * Math.PI * 2 + ring.phase;
            let R = ring.r0;
            for (let it = 0; it < 30; it++) {
              if (clearOf(cx + Math.cos(a) * R, cz + Math.sin(a) * R) >= ring.clear) break;
              R += 30;
            }
            R += 25 * (fbmA(a * 7 + ring.seed) - 0.5);
            // height: broad massifs (low-frequency) carved into individual low-poly peaks (saw profile)
            const mass = smoothstep(0.3, 0.7, fbmA(a * 1.7 + ring.seed * 0.3));
            const saw = Math.abs(((i + ring.seed) % 4) - 2) / 2; // 0..1 triangle wave over 4 samples
            const h = ring.hMin + (ring.hMax - ring.hMin) * (0.55 * mass + 0.45 * saw * (0.4 + 0.6 * mass)) * (0.85 + 0.3 * fbmA(a * 13 + 5));
            pts.push({ x: cx + Math.cos(a) * R, z: cz + Math.sin(a) * R, h });
          }
          const top = new THREE.Color().copy(fogC).lerp(tintC, ring.w);
          const y0 = SEA_LEVEL - 4;
          for (let i = 0; i < N; i++) {
            const p0 = pts[i];
            const p1 = pts[(i + 1) % N];
            // quad p0-base, p0-top, p1-base, p1-top (two tris, facing inward -- but the material is double sided)
            pos.push(p0.x, y0, p0.z, p1.x, y0, p1.z, p0.x, y0 + p0.h, p0.z, p1.x, y0, p1.z, p1.x, y0 + p1.h, p1.z, p0.x, y0 + p0.h, p0.z);
            for (let k = 0; k < 6; k++) {
              const isTop = k === 2 || k === 4 || k === 5;
              const hk = k === 2 || k === 5 ? p0.h : p1.h;
              const c = isTop ? new THREE.Color().copy(fogC).lerp(top, smoothstep(4, 40, hk)) : fogC;
              cols.push(c.r, c.g, c.b);
            }
          }
        };
        // cheap 1D fbm over angle
        const fbmA = (t) => {
          const n1 = (x) => { const i = Math.floor(x); const f = x - i; const u = f * f * (3 - 2 * f); const h0 = Math.sin(i * 127.1) * 43758.5453; const h1 = Math.sin((i + 1) * 127.1) * 43758.5453; return lerp(h0 - Math.floor(h0), h1 - Math.floor(h1), u); };
          return n1(t) * 0.6 + n1(t * 2.3 + 17) * 0.3 + n1(t * 5.1 + 31) * 0.1;
        };
        ridge({ r0: 560, clear: 500, hMin: 25, hMax: 78, w: 0.5, phase: 0, seed: 3 });
        ridge({ r0: 460, clear: 420, hMin: 10, hMax: 42, w: 0.68, phase: 0.21, seed: 11 });
        const mg = new THREE.BufferGeometry();
        mg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        mg.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
        mg.computeBoundingSphere();
        const mountains = new THREE.Mesh(mg, basic(0xffffff, { vertexColors: true, fog: false, side: THREE.DoubleSide }));
        mountains.name = 'mountains';
        mountains.renderOrder = -2;
        root.add(mountains);
      }
    }

    // distance boards every 200 m
    for (let s = 200; s < L; s += 200) {
      const half = halfAt(s);
      const prof = profileAt(course, s);
      if (prof.tunnel > 0.1) continue;
      const tex = bannerTexture(`${Math.round(L - s)}m`, { w: 256, h: 128, bg: '#14202e', fg: '#ffffff', accent: '#ffd23f', font: '900 60px system-ui, sans-serif' });
      const board = twoSided(tex, 2.2, 1.1);
      const pp = P(s, -(half + 1.2), 2.2);
      board.position.copy(pp);
      board.rotation.y = yawAt(s) + Math.PI;
      const into = sections[secOfS(s)] ? sections[secOfS(s)].group : root;
      into.add(board);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 5), woodDarkMat);
      post.position.copy(pp).y -= 1.3;
      into.add(post);
    }
  }

  // crowd + bunting meshes (built last, after every section added people/flags): one instanced mesh per
  // section, bobbing via the vertex shader (per-instance phase attribute, shared time/excitement uniforms)
  const crowdUniforms = { uTime: { value: 0 }, uExcite: { value: 0.3 } };
  for (const [inst, name] of [[crowdBodies, 'crowd-bodies'], [crowdHeads, 'crowd-heads']]) {
    inst.mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = crowdUniforms.uTime;
      shader.uniforms.uExcite = crowdUniforms.uExcite;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPhase;\nuniform float uTime;\nuniform float uExcite;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += max(0.0, sin(uTime * 7.0 + aPhase)) * (0.08 + 0.32 * uExcite) ;\ntransformed.x += sin(uTime * 3.0 + aPhase * 2.0) * 0.05 * uExcite;');
    };
    if (!inst.items.length) continue;
    for (const { key, mesh } of inst.buildSplit(name)) {
      mesh.geometry = mesh.geometry.clone();
      mesh.geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(mesh.userData.items.map((it) => it.extra ?? 0)), 1));
      mesh.userData.uniforms = crowdUniforms;
      (sections[key] ? sections[key].group : root).add(mesh);
    }
  }
  addUpdater((dt, ctx) => {
    crowdUniforms.uTime.value = ctx.realTime;
    crowdUniforms.uExcite.value = ctx.excite ?? 0.3;
  }, null);
  if (flags.items.length) for (const { key, mesh } of flags.buildSplit('bunting')) (sections[key] ? sections[key].group : root).add(mesh);
  if (cableGeoms.length) root.add(mergedMesh(cableGeoms, { flat: false }));

  // freeze static transforms: everything not flagged dyn() keeps its build-time local matrix (moving parents
  // such as the podium barge still carry their frozen children along, since world matrices are recomputed
  // whenever a parent updates)
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (o === root || o.userData.dynamic) return;
    o.updateMatrix();
    o.matrixAutoUpdate = false;
  });

  /** Run the per-frame updaters (those belonging to a section whose group main.js has hidden are skipped). */
  function update(dt, ctx) {
    for (let i = 0; i < updaters.length; i++) {
      const u = updaters[i];
      if (u.sec && sections[u.sec] && !sections[u.sec].group.visible) continue;
      u.fn(dt, ctx);
    }
  }

  return { root, update, updaters, sections, throwerSpots, itemBoxes, popItemBox, frogs, podium, fireworkBarges, tunnel: tunnelInfo, lighthouseBeam };
}
