// World set dressing for all seven sections. Everything is procedural
// (primitives, merged/instanced) and deterministic. buildScenery() returns the
// root group plus per-frame updaters (bobbing buoys, blimp, frogs, item boxes,
// lighthouse beam...) and anchor points other systems need (hot-dog thrower
// spots, podium spots, fireworks barges).
import * as THREE from 'three';
import { PAL } from './gfx.js';
import { Instancer, mergedMesh, place, colorize, bannerTexture, canvasTexture, catenary, sceneryRng } from './builders.js';
import { profileAt, SEA_LEVEL } from './terrain.js';
import { clamp, lerp, smoothstep } from '../rng.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const lam = (color, o = {}) => new THREE.MeshLambertMaterial({ color, ...o });
const basic = (color, o = {}) => new THREE.MeshBasicMaterial({ color, ...o });

export function buildScenery({ track, terrain, quality, fallMat }) {
  const root = new THREE.Group();
  root.name = 'scenery';
  const updaters = [];
  const throwerSpots = [];
  const rng = sceneryRng(1234567);
  const course = track.course;
  const F = track.features;
  const L = track.length;
  const P = (s, lat, h, out) => track.toWorld(s, lat, h, out);
  const groundY = (x, z) => terrain.heightAt(x, z);
  const frameAt = (s) => track.frame(s);
  const halfAt = (s) => course.widthAt(s) / 2;

  /** Two back-to-back single-sided textured planes (readable from both sides, never mirrored). */
  function twoSided(tex, w, h) {
    const grp = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.FrontSide });
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

  // ------------------------------------------------------------------ shared geos/materials
  const woodMat = lam(PAL.wood);
  const woodDarkMat = lam(PAL.woodDark);
  const whiteMat = lam(0xf4f1ea);
  const redMat = lam(PAL.buoyRed);
  const rockMat = new THREE.MeshLambertMaterial({ color: PAL.rock, flatShading: true });
  const rockWarmMat = new THREE.MeshLambertMaterial({ color: PAL.cliff, flatShading: true });
  const rockDarkMat = new THREE.MeshLambertMaterial({ color: PAL.rockDark, flatShading: true });
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);

  // ------------------------------------------------------------------ crowd (instanced people)
  const crowdScale = quality.crowd;
  const personBody = new THREE.CylinderGeometry(0.22, 0.26, 0.9, 6);
  personBody.translate(0, 0.45, 0);
  const personHead = new THREE.SphereGeometry(0.17, 8, 6);
  personHead.translate(0, 1.07, 0);
  const crowdBodies = new Instancer(personBody, lam(0xffffff), { colors: true });
  const crowdHeads = new Instancer(personHead, lam(0xffffff), { colors: true });
  const SHIRTS = [0xe8412e, 0xffd23f, 0x3d7be0, 0x5fbf4a, 0xff7fb0, 0xffffff, 0x8e5bd9, 0x16b8a6, 0xff7a2f, 0x222222];
  const SKIN = [0xf6d3b3, 0xe8b894, 0xc68863, 0x8d5524, 0x5c3a1e, 0xffe0c4];
  const crowdPhases = [];
  function addPerson(pos, rotY = 0) {
    if (rng.next() > crowdScale) return;
    const sc = rng.range(0.85, 1.15);
    crowdBodies.add(pos, rotY, sc, rng.pick(SHIRTS));
    crowdHeads.add(pos, rotY, sc, rng.pick(SKIN));
    crowdPhases.push(rng.range(0, Math.PI * 2));
  }

  // ------------------------------------------------------------------ bunting flags (instanced)
  const flagGeo = new THREE.BufferGeometry();
  flagGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.2, 0, 0, 0.2, 0, 0, 0, -0.5, 0]), 3));
  flagGeo.computeVertexNormals();
  const flags = new Instancer(flagGeo, new THREE.MeshLambertMaterial({ vertexColors: false, side: THREE.DoubleSide, color: 0xffffff }), { colors: true });
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

  // ================================================================== MARINA
  {
    const g = new THREE.Group();
    g.name = 'marina';
    const half0 = halfAt(0);
    // --- start arch on pontoons
    const parts = [];
    for (const side of [-1, 1]) {
      const p = P(0, side * (half0 + 2.2), 0);
      parts.push(colorize(place(new THREE.BoxGeometry(3.2, 0.6, 6), p.x, p.y + 0.1, p.z, 0, yawAt(0), 0), PAL.woodLight)); // pontoon
      parts.push(colorize(place(new THREE.CylinderGeometry(0.35, 0.45, 9.5, 8), p.x, p.y + 4.8, p.z), side < 0 ? PAL.buoyRed : 0x3d7be0)); // pylon
      parts.push(colorize(place(new THREE.SphereGeometry(0.7, 10, 8), p.x, p.y + 9.8, p.z), 0xffd23f));
    }
    const archMesh = mergedMesh(parts);
    g.add(archMesh);
    // banner beam across
    const a = P(0, half0 + 2.2, 8.6);
    const b = P(0, -(half0 + 2.2), 8.6);
    const beamLen = a.distanceTo(b);
    const mid = V().addVectors(a, b).multiplyScalar(0.5);
    const bannerTex = bannerTexture('DUCK DERBY WORLD', { bg: '#13233a', accent: '#ffd23f' });
    const banner = new THREE.Mesh(new THREE.BoxGeometry(beamLen, 2.2, 0.3), [lam(0x13233a), lam(0x13233a), lam(0x13233a), lam(0x13233a), new THREE.MeshLambertMaterial({ map: bannerTex }), new THREE.MeshLambertMaterial({ map: bannerTex })]);
    banner.position.copy(mid);
    banner.rotation.y = yawAt(0);
    g.add(banner);
    addBunting(P(0, half0 + 2.2, 7.4), P(0, -(half0 + 2.2), 7.4), 1.0, 0.8);
    // start boom (striped) that swings up at GO
    const boomPivot = new THREE.Group();
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
    updaters.push((dt, ctx) => {
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
    const blimp = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), lam(0xfff4d6));
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
    updaters.push((dt, ctx) => {
      const a = ctx.realTime * 0.045;
      blimp.position.set(blimpCenter.x + Math.cos(a) * 80, blimpCenter.y + 48, blimpCenter.z + Math.sin(a) * 60);
      blimp.rotation.y = -a - Math.PI / 2;
    });
    g.add(blimp);

    // --- village houses behind the stands
    const houseBody = new THREE.BoxGeometry(1, 1, 1);
    houseBody.translate(0, 0.5, 0);
    const houses = new Instancer(houseBody, lam(0xffffff), { colors: true });
    const roofGeo = new THREE.CylinderGeometry(0.001, 0.78, 0.7, 4);
    roofGeo.rotateY(Math.PI / 4);
    roofGeo.translate(0, 1.35, 0);
    const roofs = new Instancer(roofGeo, lam(0xffffff), { colors: true });
    const WALLS = [0xf3ead8, 0xfff1cc, 0xe8d5c0, 0xd6e6f2, 0xf7d6d0];
    const ROOFS = [PAL.roofRed, PAL.roofBlue, 0x8a5a3c, 0x4f9a45, 0xd9803b];
    function addHouse(x, z, rotY, w, d, h) {
      const y = groundY(x, z);
      houses.add(V(x, y, z), rotY, [w, h, d], rng.pick(WALLS));
      roofs.add(V(x, y + h - 1.0, z), rotY, [w * 1.05, 1.6 + rng.range(0, 0.8), d * 1.05], rng.pick(ROOFS));
    }
    for (const side of [-1, 1]) {
      for (let s = -90; s < 80; s += rng.range(9, 14)) {
        for (let k = 0; k < 3; k++) {
          const lat = side * rng.range(62, 118);
          const pp = P(s + rng.range(-3, 3), lat, 0);
          addHouse(pp.x, pp.z, yawAt(s) + rng.range(-0.2, 0.2), rng.range(4, 7), rng.range(4, 6), rng.range(3, 5));
        }
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
      const grp = new THREE.Group();
      const col = rng.pick([0xffffff, 0x3d7be0, 0xe8412e, 0x16b8a6, 0xffd23f]);
      grp.add(mergedMesh([colorize(hullGeo.clone(), col), colorize(place(new THREE.BoxGeometry(1.4, 0.9, 1.6), 0, 0.8, -0.6), 0xf4f1ea), colorize(place(new THREE.CylinderGeometry(0.05, 0.05, 5, 6), 0, 3, 0.5), 0xdddddd)], { flat: false }));
      const pp = P(s, lat, 0.25);
      grp.position.copy(pp);
      grp.rotation.y = yawAt(s) + rng.range(-0.6, 0.6);
      grp.userData = { base: pp.y, phase: rng.range(0, 6), s, lat };
      boats.push(grp);
      g.add(grp);
      // a couple of spectators aboard
      addPerson(V(pp.x + 0.3, pp.y + 0.4, pp.z - 0.3), grp.rotation.y);
      throwerSpots.push({ s, pos: V(pp.x, pp.y + 1.2, pp.z), kind: 'boat' });
    }
    updaters.push((dt, ctx) => {
      for (const bt of boats) {
        bt.position.y = bt.userData.base + Math.sin(ctx.realTime * 1.3 + bt.userData.phase) * 0.12;
        bt.rotation.z = Math.sin(ctx.realTime * 1.1 + bt.userData.phase) * 0.04;
      }
    });
    g.add(houses.build('houses'), roofs.build('roofs'));
    root.add(g);
  }

  // ================================================================== CANYON
  {
    const g = new THREE.Group();
    g.name = 'canyon';
    // buoy lines along both channel edges (canyon + a bit of the marina exit)
    const buoyGeo = new THREE.SphereGeometry(0.38, 10, 8);
    buoyGeo.translate(0, 0.15, 0);
    const buoys = new Instancer(buoyGeo, lam(0xffffff), { colors: true });
    const buoyList = [];
    for (let s = 40; s < F.lilyInS - 4; s += 7) {
      const half = halfAt(s) - 0.7;
      for (const side of [-1, 1]) {
        const pos = P(s, side * half, 0);
        buoys.add(pos, 0, 1, (Math.round(s / 7) + (side > 0 ? 1 : 0)) % 2 ? PAL.buoyRed : PAL.buoyWhite);
        buoyList.push({ s, lat: side * half });
      }
    }
    const buoyMesh = buoys.build('buoys');
    g.add(buoyMesh);
    {
      const m = new THREE.Matrix4();
      const pos = V();
      const q = new THREE.Quaternion();
      const sc = V(1, 1, 1);
      updaters.push((dt, ctx) => {
        // bob with the waves (cheap: ~90 instances)
        for (let i = 0; i < buoyList.length; i++) {
          const b = buoyList[i];
          P(b.s, b.lat, Math.sin(ctx.realTime * 2.4 + b.s * 0.35 + b.lat) * 0.09 - 0.05, pos);
          m.compose(pos, q, sc);
          buoyMesh.setMatrixAt(i, m);
        }
        buoyMesh.instanceMatrix.needsUpdate = true;
      });
    }

    // pines on the plateaus (instanced merged tree)
    const pineGeo = (() => {
      const parts = [colorize(place(new THREE.CylinderGeometry(0.18, 0.25, 1.6, 6), 0, 0.8, 0), 0x6b4423)];
      for (let k = 0; k < 3; k++) parts.push(colorize(place(new THREE.ConeGeometry(1.5 - k * 0.35, 2.2, 7), 0, 2.2 + k * 1.15, 0), k === 1 ? 0x2f7a45 : 0x2a6b3e));
      const m = mergedMesh(parts);
      return m.geometry;
    })();
    const pines = new Instancer(pineGeo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    const treeCount = Math.round(260 * quality.trees);
    let placed = 0;
    let guard = 0;
    while (placed < treeCount && guard++ < 4000) {
      const s = rng.range(F.canyonInS - 10, F.lilyInS + 20);
      const prof = profileAt(course, s);
      const side = rng.pick([-1, 1]);
      const lat = side * rng.range(prof.half + prof.slopeW + 2, prof.half + 55);
      const pp = P(s, lat, 0);
      const gy = groundY(pp.x, pp.z);
      const f = course.at(s);
      if (gy < f.y + 6) continue; // only up on the plateau
      pines.add(V(pp.x, gy - 0.2, pp.z), rng.range(0, 6), rng.range(0.8, 1.6));
      placed++;
    }
    g.add(pines.build('pines'));

    // rock stacks at the cliff foot + boulders on the rim
    const rocks = new Instancer(rockGeo, rockWarmMat);
    for (let s = F.canyonInS + 4; s < F.lilyInS - 6; s += rng.range(5, 10)) {
      for (const side of [-1, 1]) {
        if (rng.chance(0.35)) continue;
        const half = halfAt(s);
        const pp = P(s, side * (half + rng.range(0.6, 2.2)), rng.range(-0.6, 0.4));
        const sc = rng.range(0.9, 2.3);
        rocks.add(pp, rng.range(0, 6), [sc * rng.range(0.8, 1.3), sc * rng.range(0.6, 1.1), sc], null, [rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)]);
      }
    }
    g.add(rocks.build('canyon-rocks'));

    // waterfalls down the cliffs
    const falls = [
      { s: 150, side: -1, w: 5 },
      { s: 262, side: 1, w: 6.5 },
      { s: 322, side: -1, w: 4 },
    ];
    const foamGeo = new THREE.CircleGeometry(1, 18);
    const foamMat = basic(0xffffff, { transparent: true, opacity: 0.7, depthWrite: false });
    for (const fdef of falls) {
      const half = halfAt(fdef.s);
      const base = P(fdef.s, fdef.side * (half + 0.3), 0.05);
      const topP = P(fdef.s, fdef.side * (half + 4.5), 0);
      const topY = groundY(topP.x, topP.z) - 0.3;
      const h = topY - base.y;
      if (h < 4) continue;
      const geo = new THREE.PlaneGeometry(fdef.w, h, 1, 8);
      // lean the sheet: top sits back into the cliff, bottom at the water's edge
      const posA = geo.attributes.position;
      for (let i = 0; i < posA.count; i++) {
        const y = posA.getY(i);
        const k = (y + h / 2) / h; // 0 bottom .. 1 top
        posA.setZ(i, -k * 3.6 - Math.sin(k * Math.PI) * 0.6);
      }
      posA.needsUpdate = true;
      geo.computeVertexNormals();
      const sheet = new THREE.Mesh(geo, fallMat);
      sheet.position.set(base.x, base.y + h / 2, base.z);
      const f = frameAt(fdef.s);
      // plane normal (+Z) should point from the cliff toward the channel: -side * left
      const nrm = V(-fdef.side * f.left.x, 0, -fdef.side * f.left.z);
      sheet.rotation.y = Math.atan2(nrm.x, nrm.z);
      sheet.renderOrder = 3;
      g.add(sheet);
      // foam disc + mist at the base
      const foam = new THREE.Mesh(foamGeo, foamMat);
      foam.rotation.x = -Math.PI / 2;
      foam.position.copy(base).y += 0.12;
      foam.scale.set(fdef.w * 0.7, fdef.w * 0.45, 1);
      foam.renderOrder = 4;
      g.add(foam);
      updaters.push((dt, ctx) => {
        const k = 1 + Math.sin(ctx.realTime * 7 + fdef.s) * 0.06;
        foam.scale.set(fdef.w * 0.7 * k, fdef.w * 0.45 * k, 1);
      });
      fdef.base = base;
    }

    // rope bridge across the canyon with spectators (a hot-dog thrower spot)
    {
      const s = 205;
      const half = halfAt(s);
      const a = P(s, half + 5, 0);
      const b = P(s, -(half + 5), 0);
      a.y = groundY(a.x, a.z) + 0.2;
      b.y = groundY(b.x, b.z) + 0.2;
      const deckY = Math.min(a.y, b.y);
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

    // birds circling above the canyon
    {
      const birdGeo = (() => {
        const w1 = place(new THREE.BoxGeometry(0.9, 0.05, 0.25), 0.4, 0.1, 0, 0, 0, 0.35);
        const w2 = place(new THREE.BoxGeometry(0.9, 0.05, 0.25), -0.4, 0.1, 0, 0, 0, -0.35);
        return mergedMesh([colorize(w1, 0x222222), colorize(w2, 0x222222)]).geometry;
      })();
      const birds = new THREE.InstancedMesh(birdGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), 9);
      birds.frustumCulled = false;
      const center = P(230, 0, 30);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const sc = V(1, 1, 1);
      const pos = V();
      updaters.push((dt, ctx) => {
        for (let i = 0; i < 9; i++) {
          const a = ctx.realTime * (0.35 + i * 0.02) + i * 0.7;
          const r = 18 + i * 3;
          pos.set(center.x + Math.cos(a) * r, center.y + Math.sin(a * 2 + i) * 2 + i, center.z + Math.sin(a) * r);
          e.set(0, -a, Math.sin(ctx.realTime * 6 + i) * 0.3 - 0.4);
          q.setFromEuler(e);
          m.compose(pos, q, sc);
          birds.setMatrixAt(i, m);
        }
        birds.instanceMatrix.needsUpdate = true;
      });
      g.add(birds);
    }
    root.add(g);
  }

  // ================================================================== LILY-PAD CHICANE
  const frogs = [];
  {
    const g = new THREE.Group();
    g.name = 'lily';
    const padGeo = new THREE.CylinderGeometry(1, 1, 0.1, 24, 1, false, 0.25, Math.PI * 2 - 0.5);
    colorize(padGeo, PAL.lily);
    // darker rim ring merged in
    const rimGeo = new THREE.TorusGeometry(0.97, 0.05, 4, 28, Math.PI * 2 - 0.5);
    rimGeo.rotateX(Math.PI / 2);
    rimGeo.rotateY(-0.25 - (Math.PI * 2 - 0.5));
    colorize(rimGeo, PAL.lilyDark);
    const padMerged = mergedMesh([padGeo, rimGeo], { flat: false }).geometry;
    const pads = new Instancer(padMerged, new THREE.MeshLambertMaterial({ vertexColors: true }));
    const flowerGeo = (() => {
      const parts = [];
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        parts.push(colorize(place(new THREE.ConeGeometry(0.22, 0.7, 6), Math.cos(a) * 0.25, 0.35, Math.sin(a) * 0.25, 0.5 * Math.sin(a), 0, -0.5 * Math.cos(a)), k % 2 ? 0xff8fc0 : 0xffc2dc));
      }
      parts.push(colorize(place(new THREE.SphereGeometry(0.16, 8, 6), 0, 0.35, 0), 0xffd23f));
      return mergedMesh(parts, { flat: false }).geometry;
    })();
    const flowers = new Instancer(flowerGeo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    const padSpots = [];
    // slalom pads: the sim weaves ducks with sin(2π (s - lilyIn)/52); pads sit on the other side
    for (let s = F.lilyInS + 13; s < F.dropApproachS - 12; s += 26) {
      const phase = Math.sin((2 * Math.PI * (s - F.lilyInS)) / 52);
      const half = halfAt(s) - 1.2;
      const side = -Math.sign(phase) || 1;
      for (let k = 0; k < 3; k++) {
        const lat = side * half * rng.range(0.25, 0.95) + rng.range(-1, 1);
        const ss = s + rng.range(-6, 6);
        const r = rng.range(2.2, 3.8);
        const pos = P(ss, lat, 0.06);
        pads.add(pos, rng.range(0, 6), [r, 1, r]);
        padSpots.push({ s: ss, lat, r, pos });
        if (rng.chance(0.4)) flowers.add(P(ss, lat + rng.range(-0.5, 0.5), 0.1), rng.range(0, 6), rng.range(0.8, 1.3));
      }
    }
    // pond pads outside the racing channel
    for (let s = F.lilyInS - 5; s < F.dropApproachS + 5; s += rng.range(2.5, 4.5)) {
      const prof = profileAt(course, s);
      for (const side of [-1, 1]) {
        const vis = side > 0 ? prof.visL : prof.visR;
        if (vis < prof.half + 4) continue;
        const lat = side * rng.range(prof.half + 1.5, vis - 1);
        const r = rng.range(1.4, 3.6);
        const pos = P(s, lat, 0.06);
        pads.add(pos, rng.range(0, 6), [r, 1, r]);
        if (rng.chance(0.3)) flowers.add(P(s, lat, 0.1), rng.range(0, 6), rng.range(0.7, 1.2));
      }
    }
    g.add(pads.build('lilypads'), flowers.build('lotus'));

    // reeds along the pond margins
    const reedGeo = (() => {
      const parts = [];
      for (let k = 0; k < 7; k++) {
        const h = 1.8 + (k % 3) * 0.5;
        parts.push(colorize(place(new THREE.CylinderGeometry(0.03, 0.05, h, 4), Math.sin(k * 2.3) * 0.4, h / 2, Math.cos(k * 2.3) * 0.4, Math.sin(k) * 0.12, 0, Math.cos(k * 1.7) * 0.12), k % 2 ? 0x6d8f3a : 0x86a848));
        if (k % 2) parts.push(colorize(place(new THREE.CylinderGeometry(0.07, 0.07, 0.35, 6), Math.sin(k * 2.3) * 0.4, h - 0.1, Math.cos(k * 2.3) * 0.4), 0x6b4423)); // cattail
      }
      return mergedMesh(parts).geometry;
    })();
    const reeds = new Instancer(reedGeo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    for (let s = F.lilyInS - 10; s < F.dropApproachS + 8; s += rng.range(1.5, 3)) {
      const prof = profileAt(course, s);
      for (const side of [-1, 1]) {
        const vis = side > 0 ? prof.visL : prof.visR;
        const lat = side * (vis + rng.range(-2.5, 2.5));
        const pp = P(s, lat, 0);
        pp.y = Math.max(pp.y - 0.1, groundY(pp.x, pp.z) - 0.1);
        reeds.add(pp, rng.range(0, 6), rng.range(0.8, 1.4));
      }
    }
    g.add(reeds.build('reeds'));

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
      const frog = new THREE.Mesh(frogGeo, frogMat);
      frog.scale.setScalar(1.5);
      const home = spot.pos.clone();
      home.y += 0.12;
      frog.position.copy(home);
      faceAlong(frog, spot.s, true); // face the oncoming ducks
      const away = P(spot.s + 3, spot.lat + (spot.lat > 0 ? 4.5 : -4.5), 0);
      frogs.push({ mesh: frog, home, away, s: spot.s, trigger: spot.s - 16, state: 'sit', t0: 0, splashed: false });
      g.add(frog);
    }
    updaters.push((dt, ctx) => {
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
    root.add(g);
  }

  // ================================================================== THE DROP (weir)
  const mist = [];
  {
    const g = new THREE.Group();
    g.name = 'drop';
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
    // stone abutment towers each side with a timber gantry and sign
    for (const side of [-1, 1]) {
      const pp = P(lip, side * (half + 3.2), 0);
      parts.push(colorize(place(new THREE.BoxGeometry(3.2, 9, 4.5), pp.x, lipY + 1.5, pp.z, 0, yawAt(lip), 0), 0xb3a48f));
      parts.push(colorize(place(new THREE.BoxGeometry(3.6, 0.5, 4.9), pp.x, lipY + 6.2, pp.z, 0, yawAt(lip), 0), 0x8b7d6b));
      for (let k = 0; k < 4; k++) parts.push(colorize(place(new THREE.BoxGeometry(0.7, 0.7, 0.7), pp.x + Math.sin(k * 1.6) * 1.2, lipY + 6.8, pp.z + Math.cos(k * 1.6) * 1.6, 0, yawAt(lip), 0), 0xb3a48f)); // crenellations
    }
    const beamA = P(lip - 1, half + 3.2, 6.9);
    const beamB = P(lip - 1, -(half + 3.2), 6.9);
    const bm = V().addVectors(beamA, beamB).multiplyScalar(0.5);
    parts.push(colorize(place(new THREE.BoxGeometry(0.5, 0.6, beamA.distanceTo(beamB)), bm.x, bm.y, bm.z, 0, yawAt(lip), 0), PAL.woodDark));
    g.add(mergedMesh(parts));
    const signTex = bannerTexture('THE DROP', { w: 1024, h: 256, bg: '#d9493b', fg: '#ffffff', accent: '#14202e' });
    const sign = twoSided(signTex, 9, 2.2);
    sign.position.copy(bm).y -= 1.4;
    sign.rotation.y = yawAt(lip);
    g.add(sign);
    addBunting(P(lip - 1, half + 3, 5.5), P(lip - 1, -(half + 3), 5.5), 0.8, 0.7);
    // rocks flanking the plunge pool
    const rocks = new Instancer(rockGeo, rockMat);
    for (let s = F.dropLandS - 8; s < F.tunnelInS - 2; s += rng.range(2.5, 5)) {
      for (const side of [-1, 1]) {
        const pp = P(s, side * (halfAt(s) + rng.range(0.5, 3)), rng.range(-0.5, 0.6));
        const sc = rng.range(1, 2.4);
        rocks.add(pp, rng.range(0, 6), [sc, sc * 0.7, sc * 1.1], null, [rng.range(0, 3), rng.range(0, 3), 0]);
      }
    }
    g.add(rocks.build('drop-rocks'));
    // mist sprites over the plunge pool
    const mistTex = canvasTexture(128, 128, (ctx2, w, h) => {
      const grd = ctx2.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      grd.addColorStop(0, 'rgba(255,255,255,0.8)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      ctx2.fillStyle = grd;
      ctx2.fillRect(0, 0, w, h);
    });
    const mistMat = new THREE.SpriteMaterial({ map: mistTex, transparent: true, depthWrite: false, opacity: 0.5, fog: true });
    for (let k = 0; k < 10; k++) {
      const sp = new THREE.Sprite(mistMat);
      const base = P(F.dropLandS - 4 + rng.range(-4, 6), rng.range(-half, half), rng.range(0.3, 2));
      sp.position.copy(base);
      sp.scale.setScalar(rng.range(5, 9));
      sp.userData = { base, phase: rng.range(0, 6), size: sp.scale.x };
      mist.push(sp);
      g.add(sp);
    }
    updaters.push((dt, ctx) => {
      for (const sp of mist) {
        const ph = ctx.realTime * 0.6 + sp.userData.phase;
        sp.position.y = sp.userData.base.y + Math.sin(ph) * 0.6 + 0.5;
        sp.material.opacity = 0.42;
        const k = 1 + Math.sin(ph * 1.3) * 0.12;
        sp.scale.setScalar(sp.userData.size * k);
      }
    });
    root.add(g);
  }

  // ================================================================== LOG-FLUME TUNNEL
  const tunnelInfo = { s0: F.tunnelInS - 3, s1: F.tunnelOutS + 3 };
  {
    const g = new THREE.Group();
    g.name = 'tunnel';
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
    const lanternMat = basic(0xffcf5a);
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
      for (const side of [-1, 1]) {
        const lp = P(s + (s < (s0 + s1) / 2 ? -0.8 : 0.8), side * (R - 1.2), 3.6);
        const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), lanternMat);
        lantern.position.copy(lp);
        g.add(lantern);
      }
    }
    g.add(mergedMesh(portalParts));
    // light shafts from roof holes + glow pools on the water
    const shaftMat = basic(0xfff1c4, { transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
    const poolMat = basic(0xfff1c4, { transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const shafts = [];
    for (let s = s0 + 16; s < s1 - 10; s += 19) {
      const lat = rng.range(-2.5, 2.5);
      const top = P(s, lat, H - 0.3);
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.9, H + 0.4, 14, 1, true), shaftMat);
      shaft.position.copy(top).y -= (H + 0.4) / 2 - 0.2;
      shaft.rotation.z = rng.range(-0.12, 0.12);
      shaft.renderOrder = 6;
      g.add(shaft);
      const pool = new THREE.Mesh(new THREE.CircleGeometry(2.1, 18), poolMat);
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
    updaters.push((dt, ctx) => {
      for (const sh of shafts) sh.shaft.material.opacity = 0.13 + Math.sin(ctx.realTime * 1.5 + sh.s) * 0.03;
    });
    // glow-worms on the ceiling
    const wormGeo = new THREE.SphereGeometry(0.07, 5, 4);
    const worms = new Instancer(wormGeo, basic(0x9dffd0, { fog: false }), { colors: true });
    for (let k = 0; k < 170; k++) {
      const s = rng.range(s0 + 4, s1 - 4);
      const a = rng.range(0.18 * Math.PI, 0.82 * Math.PI);
      const R = halfAt(s) + 1.3;
      worms.add(P(s, Math.cos(a) * (R - 0.15), Math.sin(a) * (H - 0.25) - 0.15), 0, rng.range(0.6, 1.6), rng.pick([0x9dffd0, 0x7fe8ff, 0xd0ff8a]));
    }
    g.add(worms.build('glowworms'));
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
    root.add(g);
  }

  // ================================================================== RAPIDS
  {
    const g = new THREE.Group();
    g.name = 'rapids';
    const rocks = new Instancer(rockGeo, rockDarkMat);
    const foamRingGeo = new THREE.RingGeometry(0.9, 1.35, 14);
    const foamRings = new Instancer(foamRingGeo, basic(0xffffff, { transparent: true, opacity: 0.65, depthWrite: false, side: THREE.DoubleSide }));
    const ringList = [];
    for (let s = F.tunnelOutS + 6; s < F.harborInS - 4; s += rng.range(3, 6)) {
      for (const side of [-1, 1]) {
        const half = halfAt(s);
        const edge = rng.chance(0.75);
        const lat = edge ? side * (half + rng.range(-0.8, 2.5)) : side * rng.range(0.5, half - 2);
        const sc = edge ? rng.range(0.9, 2.2) : rng.range(0.5, 0.9);
        const pp = P(s, lat, edge ? rng.range(-0.4, 0.3) : -sc * 0.55);
        rocks.add(pp, rng.range(0, 6), [sc * rng.range(0.9, 1.4), sc * rng.range(0.6, 0.9), sc], null, [rng.range(0, 3), rng.range(0, 3), 0]);
        if (!edge || rng.chance(0.5)) {
          const rp = P(s, lat, 0.13);
          foamRings.add(rp, rng.range(0, 6), sc * (edge ? 1.1 : 1.5), null, [-Math.PI / 2, 0, 0]);
          ringList.push({ s, lat, sc: sc * (edge ? 1.1 : 1.5) });
        }
      }
    }
    g.add(rocks.build('rapids-rocks'));
    const ringMesh = foamRings.build('foam-rings');
    ringMesh.renderOrder = 4;
    g.add(ringMesh);
    {
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
      const pos = V();
      const sc = V();
      updaters.push((dt, ctx) => {
        for (let i = 0; i < ringList.length; i++) {
          const r = ringList[i];
          const k = r.sc * (1 + 0.12 * Math.sin(ctx.realTime * 5 + r.s));
          P(r.s, r.lat, 0.13 + Math.sin(ctx.realTime * 2.4 + r.s * 0.35 + r.lat * 0.31) * 0.1, pos);
          sc.set(k, k, k);
          m.compose(pos, q, sc);
          ringMesh.setMatrixAt(i, m);
        }
        ringMesh.instanceMatrix.needsUpdate = true;
      });
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
      const s = 905;
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
    root.add(g);
  }

  // ================================================================== HARBOUR
  const podium = { spots: [], camPos: null, camLook: null, group: null };
  const fireworkBarges = [];
  let lighthouseBeam = null;
  {
    const g = new THREE.Group();
    g.name = 'harbor';
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
    for (const side of [-1, 1]) {
      const pp = P(L, side * (halfF + 1.5), 0);
      const pyl = new THREE.Mesh(new THREE.BoxGeometry(1.6, 11, 1.6), chequerMat);
      pyl.position.set(pp.x, pp.y + 5, pp.z);
      pyl.rotation.y = yawAt(L);
      g.add(pyl);
      parts.push(colorize(place(new THREE.BoxGeometry(3.5, 0.7, 6), pp.x, pp.y + 0.1, pp.z, 0, yawAt(L), 0), PAL.woodLight)); // pontoon
      parts.push(colorize(place(new THREE.ConeGeometry(0.9, 1.6, 4), pp.x, pp.y + 11.3, pp.z, 0, yawAt(L), 0), 0xffd23f));
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
    // chequered line painted on the water (thin additive strip just above the surface)
    const lineTex = canvasTexture(512, 64, (c, w, h) => { for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) { c.fillStyle = (x + y) % 2 ? '#111' : '#fff'; c.fillRect(x * 32, y * 32, 32, 32); } });
    const line = new THREE.Mesh(new THREE.PlaneGeometry(2 * halfF + 2, 1.2), basic(0xffffff, { map: lineTex, transparent: true, opacity: 0.55, depthWrite: false }));
    line.rotation.x = -Math.PI / 2;
    line.position.copy(P(L, 0, 0.18));
    line.rotation.z = -yawAt(L) - Math.PI / 2;
    line.renderOrder = 4;
    g.add(line);

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
    // crowd along the quay edge + quay bunting
    {
      let prev = null;
      for (let s = L - 120; s < L + 95; s += 1.5) {
        const pp = P(s, -22.5 - rng.range(0, 4), 0);
        pp.y = groundY(pp.x, pp.z);
        if (pp.y < SEA_LEVEL + 0.5) continue;
        addPerson(pp, yawAt(s) + Math.PI / 2 + rng.range(-0.4, 0.4));
      }
      for (let s = L - 120; s < L + 100; s += 16) {
        const pp = P(s, -21.2, 0);
        const gy = groundY(pp.x, pp.z);
        parts.push(colorize(place(new THREE.CylinderGeometry(0.08, 0.1, 4.2, 6), pp.x, gy + 2.1, pp.z), 0xf4f1ea));
        const top = V(pp.x, gy + 4.1, pp.z);
        if (prev) addBunting(prev, top, 0.9);
        prev = top;
      }
    }
    // town houses on the quay side
    const houseBody = new THREE.BoxGeometry(1, 1, 1);
    houseBody.translate(0, 0.5, 0);
    const houses = new Instancer(houseBody, lam(0xffffff), { colors: true });
    const roofGeo = new THREE.CylinderGeometry(0.001, 0.78, 0.7, 4);
    roofGeo.rotateY(Math.PI / 4);
    roofGeo.translate(0, 1.35, 0);
    const roofs = new Instancer(roofGeo, lam(0xffffff), { colors: true });
    const WALLS = [0xf3ead8, 0xfff1cc, 0xe8d5c0, 0xd6e6f2, 0xf7d6d0, 0xcfe0c3];
    const ROOFS = [PAL.roofRed, PAL.roofBlue, 0x8a5a3c, 0xd9803b];
    for (let s = L - 130; s < L + 110; s += rng.range(8, 12)) {
      for (let k = 0; k < 3; k++) {
        const lat = -rng.range(34, 95);
        const pp = P(s + rng.range(-3, 3), lat, 0);
        const gy = groundY(pp.x, pp.z);
        if (gy < SEA_LEVEL + 0.8) continue;
        const w = rng.range(4, 7);
        const d = rng.range(4, 6);
        const h = rng.range(3, 6);
        const rotY = yawAt(s) + rng.range(-0.2, 0.2);
        houses.add(V(pp.x, gy, pp.z), rotY, [w, h, d], rng.pick(WALLS));
        roofs.add(V(pp.x, gy + h - 1.0, pp.z), rotY, [w * 1.05, 1.6 + rng.range(0, 0.8), d * 1.05], rng.pick(ROOFS));
      }
    }
    g.add(houses.build('town'), roofs.build('town-roofs'));

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
      const beamMat = basic(0xfff1c4, { transparent: true, opacity: 0.13, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
      const beam = new THREE.Group();
      for (const side of [-1, 1]) {
        const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 5.5, 42, 16, 1, true), beamMat);
        cone.rotation.z = side * Math.PI / 2;
        cone.position.x = side * 21;
        beam.add(cone);
      }
      beam.position.set(base.x, topY + 1.6, base.z);
      g.add(beam);
      lighthouseBeam = beam;
      updaters.push((dt, ctx) => {
        beam.rotation.y = ctx.realTime * 0.7;
      });
      // breakwater rocks trailing from the islet along the sea side
      const bw = new Instancer(rockGeo, rockDarkMat);
      for (let s = L - 10; s < L + 120; s += rng.range(2.5, 4)) {
        const pp = P(s, halfF + 30 + rng.range(-2, 2) + (s - L) * 0.05, 0);
        pp.y = SEA_LEVEL + rng.range(-0.6, 0.8);
        const sc = rng.range(1.4, 2.8);
        bw.add(pp, rng.range(0, 6), [sc, sc * 0.7, sc], null, [rng.range(0, 3), rng.range(0, 3), 0]);
      }
      g.add(bw.build('breakwater'));
    }

    // --- sailboats bobbing on the sea side
    const sailGeo = (() => {
      const hullG = new THREE.BoxGeometry(2, 0.9, 5.5);
      const p = hullG.attributes.position;
      for (let i = 0; i < p.count; i++) { if (p.getZ(i) > 0) p.setX(i, p.getX(i) * 0.3); if (p.getY(i) < 0) p.setX(i, p.getX(i) * 0.7); }
      const sail = new THREE.BufferGeometry();
      sail.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 1, 0.3, 0, 7, 0.3, 0, 1, -2.6, 0, 1, 0.5, 0, 6, 0.5, 0, 1.2, 2.4]), 3));
      sail.computeVertexNormals();
      const sailNI = sail;
      return mergedMesh([colorize(hullG, 0xf4f1ea), colorize(place(new THREE.CylinderGeometry(0.06, 0.06, 7, 6), 0, 4, 0.3), 0xdddddd), colorize(sailNI, 0xffffff)], { flat: false, material: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }) });
    })();
    const sailboats = [];
    for (let k = 0; k < 9; k++) {
      const s = rng.range(L - 140, L + 130);
      const lat = rng.range(halfF + 8, halfF + 24);
      const m = new THREE.Mesh(sailGeo.geometry, sailGeo.material);
      const pp = P(s, lat, 0.2);
      pp.y = SEA_LEVEL + 0.25;
      m.position.copy(pp);
      m.rotation.y = rng.range(0, 6);
      m.userData = { base: pp.y, phase: rng.range(0, 6) };
      sailboats.push(m);
      g.add(m);
      throwerSpots.push({ s, pos: V(pp.x, pp.y + 1.3, pp.z), kind: 'boat' });
    }
    updaters.push((dt, ctx) => {
      for (const b of sailboats) {
        b.position.y = b.userData.base + Math.sin(ctx.realTime * 1.2 + b.userData.phase) * 0.15;
        b.rotation.z = Math.sin(ctx.realTime + b.userData.phase) * 0.05;
      }
    });

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
      const grp = new THREE.Group();
      grp.position.copy(c);
      grp.rotation.y = yaw;
      const pp = [];
      pp.push(colorize(place(new THREE.BoxGeometry(13, 0.9, 7), 0, 0, 0), PAL.woodLight));
      pp.push(colorize(place(new THREE.BoxGeometry(13.4, 0.3, 7.4), 0, -0.4, 0), 0x39424e));
      const blocks = [
        { x: 0, h: 1.7, col: 0xf2c230, label: '1' },
        { x: -3.3, h: 1.2, col: 0xc9d1d9, label: '2' },
        { x: 3.3, h: 0.85, col: 0xc98b5c, label: '3' },
      ];
      for (const b of blocks) {
        pp.push(colorize(place(new THREE.BoxGeometry(3, b.h, 3), b.x, 0.45 + b.h / 2, 0), b.col));
        const spot = V(b.x, 0.45 + b.h + 0.02, 0);
        podium.spots.push(spot); // local; converted below
      }
      // back truss with banner
      pp.push(colorize(place(new THREE.BoxGeometry(0.3, 6, 0.3), -6, 3.4, -3), 0x59636e));
      pp.push(colorize(place(new THREE.BoxGeometry(0.3, 6, 0.3), 6, 3.4, -3), 0x59636e));
      grp.add(mergedMesh(pp, { flat: false }));
      const podTex = bannerTexture('DRAFT ORDER PODIUM', { w: 1024, h: 200, bg: '#13233a', fg: '#ffffff', accent: '#ffd23f', font: '900 105px system-ui, sans-serif' });
      const pb = twoSided(podTex, 12.3, 2.3);
      pb.position.set(0, 5.6, -3);
      grp.add(pb);
      for (const b of blocks) {
        const t = bannerTexture(b.label, { w: 256, h: 256, bg: '#' + b.col.toString(16).padStart(6, '0'), fg: '#14202e', accent: '#' + b.col.toString(16).padStart(6, '0'), font: '900 190px system-ui, sans-serif' });
        const lbl = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshLambertMaterial({ map: t }));
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
      updaters.push((dt, ctx) => {
        grp.position.y = c.y + Math.sin(ctx.realTime * 1.1) * 0.06;
      });
    }
    g.add(mergedMesh(parts));
    root.add(g);
  }

  // ================================================================== ITEM BOXES
  const itemBoxes = [];
  {
    const g = new THREE.Group();
    g.name = 'itemboxes';
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
        const m = new THREE.Mesh(boxGeo, boxMat);
        const base = P(s, lat, 1.3);
        m.position.copy(base);
        m.userData = { row, s, lat, base, popT: -10 };
        itemBoxes.push(m);
        g.add(m);
      }
    });
    updaters.push((dt, ctx) => {
      for (const b of itemBoxes) {
        const u = b.userData;
        b.rotation.y = ctx.realTime * 1.6 + u.lat;
        b.rotation.x = Math.sin(ctx.realTime * 1.1 + u.lat) * 0.3;
        b.position.y = u.base.y + Math.sin(ctx.realTime * 2 + u.lat) * 0.25;
        const since = ctx.t - u.popT;
        const sc = since < 0 || since > 1.4 ? 1 : since < 0.15 ? 1 + since * 4 : since < 1.0 ? 0 : (since - 1.0) / 0.4;
        b.scale.setScalar(sc);
      }
    });
    root.add(g);
  }
  /** Pop the box nearest to (row, lat) at race time t. */
  function popItemBox(row, lat, t) {
    let best = null;
    let bd = Infinity;
    for (const b of itemBoxes) {
      if (b.userData.row !== row) continue;
      const d = Math.abs(b.userData.lat - lat);
      if (d < bd) { bd = d; best = b; }
    }
    if (best) best.userData.popT = t;
  }

  // ================================================================== COMMON: trees, clouds, distance boards
  {
    // round deciduous trees around marina, lily pond meadows and the harbour town
    const treeGeo = (() => {
      const parts = [colorize(place(new THREE.CylinderGeometry(0.2, 0.3, 2, 6), 0, 1, 0), 0x6b4423)];
      parts.push(colorize(place(new THREE.IcosahedronGeometry(1.6, 0), 0, 3.1, 0), PAL.grassDark));
      parts.push(colorize(place(new THREE.IcosahedronGeometry(1.2, 0), 0.7, 3.9, 0.3), 0x5daa4c));
      parts.push(colorize(place(new THREE.IcosahedronGeometry(1.0, 0), -0.6, 3.6, -0.5), 0x6cbc55));
      return mergedMesh(parts).geometry;
    })();
    const trees = new Instancer(treeGeo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    const n = Math.round(340 * quality.trees);
    let placed = 0;
    let guard = 0;
    while (placed < n && guard++ < 6000) {
      const s = rng.range(F.minS, F.maxS);
      const prof = profileAt(course, s);
      if (prof.canyon > 0.5 || prof.tunnel > 0.3) continue;
      const side = prof.harbor > 0.5 ? -1 : rng.pick([-1, 1]);
      const minLat = Math.max(prof.half + prof.slopeW + 3, (side > 0 ? prof.visL : prof.visR) + 4) + (prof.marina > 0.5 ? 24 : 0) + (prof.harbor > 0.5 ? 8 : 0);
      const lat = side * rng.range(minLat, minLat + 70);
      const pp = P(s, lat, 0);
      const gy = groundY(pp.x, pp.z);
      if (gy < prof.y + 0.4) continue;
      trees.add(V(pp.x, gy - 0.1, pp.z), rng.range(0, 6), rng.range(0.8, 1.7));
      placed++;
    }
    root.add(trees.build('trees'));

    // puffy clouds
    const cloudGeo = (() => {
      const parts = [];
      for (let k = 0; k < 6; k++) parts.push(colorize(place(new THREE.IcosahedronGeometry(1, 1), (k - 2.5) * 1.1 + Math.sin(k) * 0.3, Math.cos(k * 1.7) * 0.4, Math.sin(k * 2.1) * 0.6, 0, 0, 0, 1 + (k % 3) * 0.35), 0xffffff));
      return mergedMesh(parts, { flat: true, material: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, fog: false, emissive: 0x8899aa, emissiveIntensity: 0.35 }) });
    })();
    const clouds = new Instancer(cloudGeo.geometry, cloudGeo.material);
    for (let k = 0; k < 26; k++) {
      const s = rng.range(F.minS, F.maxS);
      const pp = P(s, rng.range(-260, 260), 0);
      clouds.add(V(pp.x, 70 + rng.range(0, 40), pp.z), rng.range(0, 6), [rng.range(8, 16), rng.range(4, 7), rng.range(6, 10)]);
    }
    root.add(clouds.build('clouds'));

    // distance boards every 200 m
    for (let s = 200; s < L; s += 200) {
      const half = halfAt(s);
      const prof = profileAt(course, s);
      if (prof.tunnel > 0.1) continue;
      const tex = bannerTexture(`${Math.round(L - s)}m`, { w: 256, h: 128, bg: '#14202e', fg: '#ffffff', accent: '#ffd23f', font: '900 80px system-ui, sans-serif' });
      const board = twoSided(tex, 2.2, 1.1);
      const pp = P(s, -(half + 1.2), 2.2);
      board.position.copy(pp);
      board.rotation.y = yawAt(s) + Math.PI;
      root.add(board);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 5), woodDarkMat);
      post.position.copy(pp).y -= 1.3;
      root.add(post);
    }
  }

  // crowd + bunting meshes (built last, after every section added people/flags)
  const crowdBodyMesh = crowdBodies.build('crowd-bodies');
  const crowdHeadMesh = crowdHeads.build('crowd-heads');
  // bobbing crowd via vertex shader (per-instance phase attribute)
  const phases = new Float32Array(crowdPhases);
  for (const mesh of [crowdBodyMesh, crowdHeadMesh]) {
    mesh.geometry = mesh.geometry.clone();
    mesh.geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    const uniforms = { uTime: { value: 0 }, uExcite: { value: 0.3 } };
    mesh.material = mesh.material.clone();
    mesh.material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uExcite = uniforms.uExcite;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPhase;\nuniform float uTime;\nuniform float uExcite;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += max(0.0, sin(uTime * 7.0 + aPhase)) * (0.08 + 0.32 * uExcite) ;\ntransformed.x += sin(uTime * 3.0 + aPhase * 2.0) * 0.05 * uExcite;');
    };
    mesh.userData.uniforms = uniforms;
    root.add(mesh);
  }
  updaters.push((dt, ctx) => {
    for (const mesh of [crowdBodyMesh, crowdHeadMesh]) {
      mesh.userData.uniforms.uTime.value = ctx.realTime;
      mesh.userData.uniforms.uExcite.value = ctx.excite ?? 0.3;
    }
  });
  root.add(flags.build('bunting'));
  if (cableGeoms.length) root.add(mergedMesh(cableGeoms, { flat: false }));

  // freeze static transforms
  root.traverse((o) => {
    if (o !== root && !o.userData.dynamic) o.matrixAutoUpdate = true;
  });

  function update(dt, ctx) {
    for (const u of updaters) u(dt, ctx);
  }

  return { root, update, throwerSpots, itemBoxes, popItemBox, frogs, podium, fireworkBarges, tunnel: tunnelInfo, lighthouseBeam };
}
