// Particles and item/hazard visuals: splashes, spray, mustard bursts, confetti,
// fireworks (one pooled Points system), plus projectile meshes (hornet, stone,
// seagull, hot dog + thrower) positioned as pure functions of race time so
// jump-to-time captures and replays show them mid-flight.
import * as THREE from 'three';
import { PAL } from './gfx.js';
import { itemIconCanvas } from './icons.js';
import { ITEM_TUNING } from './items.js';
import { clamp, lerp, smoothstep } from '../rng.js';

const GRAV = 9.8;

export class Effects {
  constructor(scene, track, quality) {
    this.scene = scene;
    this.track = track;
    this.quality = quality;
    this.root = new THREE.Group();
    this.root.name = 'effects';
    scene.add(this.root);
    this._initParticles(Math.round(2200 * quality.particles));
    this._initProjectiles();
    this.rand = mulberry(9001);
    this.fireT = 0;
    this.budget = 1;
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this.live = 0;
  }

  // ------------------------------------------------------------ pooled particles
  _initParticles(n) {
    this.N = n;
    this.pPos = new Float32Array(n * 3);
    this.pVel = new Float32Array(n * 3);
    this.pCol = new Float32Array(n * 4);
    this.pSize = new Float32Array(n);
    this.pLife = new Float32Array(n); // remaining
    this.pMax = new Float32Array(n);
    this.pGrav = new Float32Array(n);
    this.pDrag = new Float32Array(n);
    this.cursor = 0;
    this.emitLo = n;
    this.emitHi = -1;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: { scale: { value: 600 }, maxSize: { value: 34 } },
      vertexShader: /* glsl */ `
        attribute vec4 color; attribute float size; varying vec4 vCol; uniform float scale; uniform float maxSize;
        void main() {
          vCol = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float depth = max(0.5, -mv.z);
          gl_PointSize = min(size * scale / depth, maxSize);
          vCol.a *= smoothstep(0.8, 2.5, depth); // nothing blows up into a disc on the lens
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vCol;
        void main() { vec2 c = gl_PointCoord - 0.5; float d = dot(c, c); if (d > 0.25) discard; float a = vCol.a * smoothstep(0.25, 0.12, d); gl_FragColor = vec4(vCol.rgb, a);
        #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
    this.root.add(this.points);
    for (let i = 0; i < n; i++) { this.pLife[i] = 0; this.pCol[i * 4 + 3] = 0; this.pPos[i * 3 + 1] = -999; }
  }

  emit(pos, vel, color, size, life, grav = 1, drag = 0.2, alpha = 1) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.N;
    this.pPos[i * 3] = pos.x; this.pPos[i * 3 + 1] = pos.y; this.pPos[i * 3 + 2] = pos.z;
    this.pVel[i * 3] = vel.x; this.pVel[i * 3 + 1] = vel.y; this.pVel[i * 3 + 2] = vel.z;
    const c = tmpColor.set(color);
    this.pCol[i * 4] = c.r; this.pCol[i * 4 + 1] = c.g; this.pCol[i * 4 + 2] = c.b; this.pCol[i * 4 + 3] = alpha;
    this.pSize[i] = size;
    this.pLife[i] = life;
    this.pMax[i] = life;
    this.pGrav[i] = grav;
    this.pDrag[i] = drag;
    this.live++;
    this.dirty = true;
    if (i < this.emitLo) this.emitLo = i;
    if (i > this.emitHi) this.emitHi = i;
  }

  _updateParticles(dt) {
    const n = this.N;
    if (this.live <= 0 && !this.dirty) return; // nothing alive: skip the CPU pass and GPU uploads
    let live = 0;
    let lo = n;
    let hi = -1;
    for (let i = 0; i < n; i++) {
      if (this.pLife[i] <= 0) continue;
      live++;
      if (i < lo) lo = i;
      if (i > hi) hi = i;
      this.pLife[i] -= dt;
      if (this.pLife[i] <= 0) { this.pCol[i * 4 + 3] = 0; this.pPos[i * 3 + 1] = -999; continue; }
      const k = Math.exp(-this.pDrag[i] * dt);
      this.pVel[i * 3] *= k; this.pVel[i * 3 + 1] = this.pVel[i * 3 + 1] * k - GRAV * this.pGrav[i] * dt; this.pVel[i * 3 + 2] *= k;
      this.pPos[i * 3] += this.pVel[i * 3] * dt; this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * dt; this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * dt;
      const e = this.pLife[i] / this.pMax[i];
      this.pCol[i * 4 + 3] = Math.min(1, e * 2.5);
    }
    this.live = live;
    this.dirty = false;
    const g = this.points.geometry;
    // upload only the slice of the pool that holds live (or just-emitted/died) particles
    lo = Math.min(lo, this.emitLo);
    hi = Math.max(hi, this.emitHi);
    this.emitLo = n;
    this.emitHi = -1;
    if (hi < lo) { lo = 0; hi = n - 1; }
    const setRange = (attr, comps) => {
      if (attr.clearUpdateRanges) attr.clearUpdateRanges();
      if (attr.addUpdateRange) attr.addUpdateRange(lo * comps, (hi - lo + 1) * comps);
      else attr.updateRange = { offset: lo * comps, count: (hi - lo + 1) * comps };
      attr.needsUpdate = true;
    };
    setRange(g.attributes.position, 3);
    setRange(g.attributes.color, 4);
    setRange(g.attributes.size, 1);
  }

  rnd(a = 0, b = 1) { return a + (b - a) * this.rand(); }

  /** Create one of each pooled projectile so their programs compile during boot (hidden again next frame). */
  warmup() {
    for (const kind of Object.keys(this.pool)) { const m = this._get(kind, 0); m.visible = true; m.traverse((o) => { o.frustumCulled = false; }); }
    this.emit(this._v.set(0, -50, 0), this._v2.set(0, 0, 0), 0xffffff, 0.1, 0.2);
  }

  splash(pos, strength = 1) {
    // a crown: most droplets in a ring moving outward + up, a few stragglers
    const n = Math.round(40 * strength * this.quality.particles * this.budget);
    for (let k = 0; k < n; k++) {
      const a = this.rnd(0, Math.PI * 2);
      const ring = k % 10 < 7;
      const sp = (ring ? this.rnd(2.6, 3.4) : this.rnd(0.5, 4.5)) * Math.sqrt(strength);
      this._v.set(Math.cos(a) * sp, (ring ? this.rnd(3.2, 4.2) : this.rnd(2, 6.5)) * Math.sqrt(strength), Math.sin(a) * sp);
      this._v3.set(pos.x + Math.cos(a) * 0.4, pos.y, pos.z + Math.sin(a) * 0.4);
      this.emit(this._v3, this._v, k % 6 ? PAL.waterFoam : PAL.waterShallow, this.rnd(0.06, 0.14), this.rnd(0.35, 0.7), 1.3, 0.9, 0.9);
    }
  }

  /** Rooster-tail spray behind a fast duck. dir = unit backward vector. */
  spray(pos, back, amount = 1, color = PAL.waterFoam) {
    const n = Math.max(1, Math.round(8 * amount * this.quality.particles * this.budget));
    for (let k = 0; k < n; k++) {
      this._v.copy(back).multiplyScalar(this.rnd(2, 6)).add(this._v2.set(this.rnd(-1.2, 1.2), this.rnd(1.5, 4), this.rnd(-1.2, 1.2)));
      this.emit(pos, this._v, k % 7 ? color : PAL.waterShallow, this.rnd(0.05, 0.12), this.rnd(0.25, 0.45), 1.4, 1.2, 0.85);
    }
  }

  bubbles(pos, amount = 1) {
    const n = Math.max(1, Math.round(2 * amount));
    for (let k = 0; k < n; k++) {
      this._v.set(this.rnd(-0.8, 0.8), this.rnd(0.5, 1.6), this.rnd(-0.8, 0.8));
      this._v2.set(pos.x + this.rnd(-0.4, 0.4), pos.y + this.rnd(0, 0.3), pos.z + this.rnd(-0.4, 0.4));
      this.emit(this._v2, this._v, k % 2 ? 0xfff1a8 : 0xffb347, this.rnd(0.16, 0.34), this.rnd(0.3, 0.55), -0.3, 2.5, 0.9);
    }
  }

  mustard(pos) {
    const n = Math.round(60 * this.quality.particles * this.budget);
    for (let k = 0; k < n; k++) {
      const a = this.rnd(0, Math.PI * 2);
      const up = this.rnd(2, 8);
      const sp = this.rnd(1, 5);
      this._v.set(Math.cos(a) * sp, up, Math.sin(a) * sp);
      this.emit(pos, this._v, k % 3 === 0 ? 0xd6281f : 0xffcf1a, this.rnd(0.14, 0.32), this.rnd(0.6, 1.2), 1, 0.6, 1);
    }
  }

  sparkle(pos, color = 0xfff1a8, amount = 1) {
    const n = Math.max(1, Math.round(3 * amount));
    for (let k = 0; k < n; k++) {
      this._v.set(this.rnd(-1.5, 1.5), this.rnd(0.5, 3), this.rnd(-1.5, 1.5));
      this._v2.set(pos.x + this.rnd(-0.6, 0.6), pos.y + this.rnd(0, 1), pos.z + this.rnd(-0.6, 0.6));
      this.emit(this._v2, this._v, color, this.rnd(0.12, 0.28), this.rnd(0.3, 0.7), 0.2, 1.5, 1);
    }
  }

  confetti(pos, amount = 1) {
    const n = Math.round(120 * amount * this.quality.particles * this.budget);
    for (let k = 0; k < n; k++) {
      const a = this.rnd(0, Math.PI * 2);
      const sp = this.rnd(2, 9);
      this._v.set(Math.cos(a) * sp, this.rnd(6, 16), Math.sin(a) * sp);
      this.emit(pos, this._v, PAL.bunting[k % PAL.bunting.length], this.rnd(0.14, 0.26), this.rnd(1.8, 3.2), 0.45, 1.4, 1);
    }
  }

  firework(pos) {
    // burst at altitude (the "rocket" is implied by a quick trail)
    const top = this._v2.copy(pos);
    top.y += this.rnd(22, 38);
    top.x += this.rnd(-8, 8);
    top.z += this.rnd(-8, 8);
    for (let k = 0; k < 10; k++) {
      this._v3.lerpVectors(pos, top, k / 10);
      this.emit(this._v3, this._v.set(0, 2, 0), 0xfff1c4, 0.2, 0.25 + k * 0.03, 0, 0.5, 0.8);
    }
    const col = [0xff5f6d, 0xffd23f, 0x47e0ff, 0xb06bff, 0x7dff8a, 0xffffff][Math.floor(this.rnd(0, 6))];
    const n = Math.round(90 * this.quality.particles * this.budget);
    for (let k = 0; k < n; k++) {
      // uniform sphere
      const u = this.rnd(-1, 1);
      const a = this.rnd(0, Math.PI * 2);
      const r = Math.sqrt(1 - u * u);
      const sp = this.rnd(9, 13);
      this._v.set(r * Math.cos(a) * sp, u * sp, r * Math.sin(a) * sp);
      this.emit(top, this._v, k % 7 === 0 ? 0xffffff : col, this.rnd(0.35, 0.6), this.rnd(1.0, 1.6), 0.35, 1.6, 1);
    }
    return top;
  }

  // ------------------------------------------------------------ projectiles & hot dogs
  _initProjectiles() {
    // hornet
    const hornet = new THREE.Group();
    const hb = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 10), new THREE.MeshLambertMaterial({ color: 0xffd23f }));
    hb.scale.set(1, 0.8, 1.3);
    hornet.add(hb);
    for (const z of [-0.25, 0.15]) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.14, 14, 1, true), new THREE.MeshLambertMaterial({ color: 0x1b1b1b }));
      band.rotation.x = Math.PI / 2;
      band.position.z = z;
      band.scale.set(1, 1, 0.8);
      hornet.add(band);
    }
    const wingMat = new THREE.MeshBasicMaterial({ color: 0xe8faff, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false, forceSinglePass: true });
    hornet.userData.wings = [];
    for (const side of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.CircleGeometry(0.45, 10), wingMat);
      w.position.set(side * 0.35, 0.4, 0);
      w.rotation.set(-Math.PI / 2, 0, side * 0.4);
      w.scale.set(0.7, 1.2, 1);
      hornet.add(w);
      hornet.userData.wings.push(w);
    }
    const sting = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.4, 8), new THREE.MeshLambertMaterial({ color: 0x1b1b1b }));
    sting.rotation.x = -Math.PI / 2;
    sting.position.z = -0.7;
    hornet.add(sting);
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff3b2f, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending }));
    hornet.add(glow);
    hornet.visible = false;
    this.hornetProto = hornet;

    // stone
    const stone = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 8), new THREE.MeshLambertMaterial({ color: 0x8fa3ad }));
    stone.scale.set(1.2, 0.45, 1);
    stone.visible = false;
    this.stoneProto = stone;

    // seagull
    const gull = new THREE.Group();
    const gb = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), new THREE.MeshLambertMaterial({ color: 0xffffff }));
    gb.scale.set(0.8, 0.7, 1.6);
    gull.add(gb);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.5, 8), new THREE.MeshLambertMaterial({ color: 0xffb020 }));
    beak.rotation.x = Math.PI / 2;
    beak.position.z = 0.95;
    gull.add(beak);
    gull.userData.wings = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.3, 0.15, 0);
      const w = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.08, 0.7), new THREE.MeshLambertMaterial({ color: 0xf4f4f4 }));
      w.position.x = side * 0.95;
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.085, 0.5), new THREE.MeshLambertMaterial({ color: 0x333333 }));
      tip.position.x = side * 2.0;
      pivot.add(w, tip);
      pivot.userData.side = side;
      gull.add(pivot);
      gull.userData.wings.push(pivot);
    }
    gull.scale.setScalar(1.3);
    gull.visible = false;
    this.gullProto = gull;

    // hot dog
    const dog = new THREE.Group();
    const bun = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.9, 4, 10), new THREE.MeshLambertMaterial({ color: 0xe8a33c }));
    bun.rotation.z = Math.PI / 2;
    bun.scale.set(1, 1, 0.75);
    dog.add(bun);
    const frank = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 1.25, 4, 10), new THREE.MeshLambertMaterial({ color: 0xc4452d }));
    frank.rotation.z = Math.PI / 2;
    frank.position.y = 0.14;
    dog.add(frank);
    const mus = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.04, 4, 24, Math.PI * 3), new THREE.MeshLambertMaterial({ color: 0xffd23f }));
    mus.scale.set(4.5, 1, 1);
    mus.rotation.x = Math.PI / 2;
    mus.position.y = 0.33;
    dog.add(mus);
    dog.scale.setScalar(1.15);
    dog.visible = false;
    this.dogProto = dog;

    // thrower figure (bigger than crowd people so the wind-up reads)
    const thrower = new THREE.Group();
    const tb = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 1.2, 8), new THREE.MeshLambertMaterial({ color: 0xff7a2f }));
    tb.position.y = 0.6;
    thrower.add(tb);
    const th = new THREE.Mesh(new THREE.SphereGeometry(0.25, 10, 8), new THREE.MeshLambertMaterial({ color: 0xf1c8a4 }));
    th.position.y = 1.45;
    thrower.add(th);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x3d7be0 }));
    cap.position.y = 1.5;
    thrower.add(cap);
    const armPivot = new THREE.Group();
    armPivot.position.set(0.35, 1.15, 0);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.75, 0.16), new THREE.MeshLambertMaterial({ color: 0xff7a2f }));
    arm.position.y = -0.32;
    armPivot.add(arm);
    thrower.add(armPivot);
    thrower.userData.arm = armPivot;
    thrower.visible = false;
    this.throwerProto = thrower;

    this.pool = { hornet: [], stone: [], seagull: [], hotdog: [], thrower: [] };
    this.protos = { hornet: this.hornetProto, stone: this.stoneProto, seagull: this.gullProto, hotdog: this.dogProto, thrower: this.throwerProto };
  }

  _get(kind, idx) {
    const arr = this.pool[kind];
    while (arr.length <= idx) {
      const m = this.protos[kind].clone(true);
      m.visible = false;
      // re-link animated parts after clone
      if (kind === 'hornet' || kind === 'seagull') m.userData.wings = m.children.filter((c) => (kind === 'hornet' ? c.geometry && c.geometry.type === 'CircleGeometry' : c.isGroup));
      if (kind === 'hornet') for (const c of m.children) if (c.material && c.material.blending === THREE.AdditiveBlending) c.material = c.material.clone();
      if (kind === 'thrower') m.userData.arm = m.children.find((c) => c.isGroup);
      this.root.add(m);
      arr.push(m);
    }
    return arr[idx];
  }

  /**
   * Plan hot dogs for a race: pick a thrower spot for each 'hotdog' event.
   * @param race the sim
   * @param spots [{s,pos}] from scenery
   * @param duckWorldPos (i, t, out) -> world position of duck i at time t
   */
  planHotdogs(race, spots, duckWorldPos, duckS) {
    this.hotdogs = [];
    const lead = ITEM_TUNING.hotdog.lead;
    for (const ev of race.events) {
      if (ev.type !== 'hotdog') continue;
      const target = new THREE.Vector3();
      duckWorldPos(ev.duck, ev.t, target);
      const sDuck = duckS(ev.duck, ev.t);
      let best = null;
      let bestScore = Infinity;
      for (const sp of spots) {
        const d = sp.pos.distanceTo(target);
        if (d < 10) continue; // too close looks odd
        // prefer spots ahead of the duck (visible from the chase cam) and not too far
        const ahead = sp.s - sDuck;
        const score = d + (ahead > 6 && ahead < 90 ? 0 : 60) + (d > 80 ? 100 : 0);
        if (score < bestScore) { bestScore = score; best = sp; }
      }
      if (!best) continue;
      const from = best.pos.clone();
      // a very long throw launches from part-way along the line (and we don't show a floating thrower)
      const d = from.distanceTo(target);
      let showThrower = true;
      if (d > 75) { from.lerp(target, 1 - 75 / d).setY(Math.max(from.y, target.y + 5)); showThrower = false; }
      this.hotdogs.push({ t: ev.t, t0: ev.t - lead, duck: ev.duck, from, target, result: ev.result, spot: best, showThrower });
    }
  }

  /** Per-frame: place projectile meshes for race time t. duckState(i) -> {pos, ...} */
  updateRace(dt, ctx) {
    const { t, race, ducks, realTime } = ctx;
    const used = { hornet: 0, stone: 0, seagull: 0, hotdog: 0, thrower: 0 };
    if (race) {
      for (const p of race.projectiles) {
        if (t < p.t0 || t > p.t1 + (p.result === 'hit' ? 0.0 : 0.4)) continue;
        const k = Math.min(Math.floor((t - p.t0) / race.dt), p.path.length / 2 - 1);
        if (k < 0) continue;
        const k2 = Math.min(k + 1, p.path.length / 2 - 1);
        const f = (t - p.t0) / race.dt - k;
        const s = lerp(p.path[k * 2], p.path[k2 * 2], clamp(f, 0, 1));
        const lat = lerp(p.path[k * 2 + 1], p.path[k2 * 2 + 1], clamp(f, 0, 1));
        const age = t - p.t0;
        const mineP = ctx.target === p.owner;
        if (p.type === 'hornet') {
          const m = this._get('hornet', used.hornet++);
          m.visible = true;
          const glowMesh = m.children[m.children.length - 1];
          if (glowMesh && glowMesh.material && glowMesh.material.blending === THREE.AdditiveBlending) glowMesh.material.opacity = mineP ? 0.42 : 0.18;
          this.track.toWorld(s, lat, 1.1 + Math.sin(age * 9) * 0.25, m.position);
          const ahead = this.track.toWorld(s + 1, lat, 1.1, this._v);
          m.lookAt(ahead);
          for (const w of m.userData.wings) w.rotation.z = Math.sign(w.position.x) * (0.4 + Math.sin(realTime * 60) * 0.5);
          if (age > p.t1 - p.t0 - 0.05 && p.result !== 'hit') m.scale.setScalar(Math.max(0.01, 1 - (t - p.t1) / 0.4));
          else m.scale.setScalar(1);
        } else if (p.type === 'stone') {
          const m = this._get('stone', used.stone++);
          m.visible = true;
          const hop = Math.abs(Math.sin(age * 7.5)) * 0.7 * (1 - smoothstep(ITEM_TUNING.stone.ttl - 0.4, ITEM_TUNING.stone.ttl + 0.4, age));
          this.track.toWorld(s, lat, 0.15 + hop, m.position);
          m.rotation.y = age * 10;
          if (t > p.t1) m.position.y -= (t - p.t1) * 3;
          // skip rings
          if (hop < 0.08 && this.rand() < 0.5) this.splash(m.position, 0.25);
        } else if (p.type === 'seagull') {
          const m = this._get('seagull', used.seagull++);
          m.visible = true;
          let h = 9 + Math.sin(age * 2) * 0.8;
          if (p.diveT && t >= p.diveT) {
            const e = clamp((t - p.diveT) / ITEM_TUNING.seagull.dive, 0, 1);
            h = lerp(9, 1.3, e * e);
          }
          // swoop in from high behind at launch
          h += (1 - smoothstep(0, 1.2, age)) * 10;
          this.track.toWorld(s, lat, h, m.position);
          const ahead = this.track.toWorld(s + 2, lat, h - (p.diveT && t >= p.diveT ? 1.5 : 0), this._v);
          m.lookAt(ahead);
          for (const w of m.userData.wings) w.rotation.z = w.userData.side * Math.sin(realTime * 9) * 0.6;
          if (t > p.t1) { m.position.y += (t - p.t1) * 6; }
        }
      }
      // hot dogs (+ throwers winding up)
      if (this.hotdogs) {
        for (const hd of this.hotdogs) {
          const windup = 0.55;
          if (t < hd.t0 - windup - 1.5 || t > hd.t + 1.3) continue;
          const thr = this._get('thrower', used.thrower++);
          thr.visible = hd.showThrower;
          thr.position.copy(hd.spot.pos).y -= 1.2;
          // face the target
          thr.lookAt(this._v.set(hd.target.x, thr.position.y, hd.target.z));
          const arm = thr.userData.arm;
          if (t < hd.t0) {
            const e = clamp((t - (hd.t0 - windup)) / windup, 0, 1);
            arm.rotation.x = lerp(0.2, -2.8, e); // wind back
          } else arm.rotation.x = lerp(-2.8, 0.9, clamp((t - hd.t0) / 0.25, 0, 1)); // fling
          thr.scale.setScalar(1.5);
          if (t >= hd.t0 - 0.02) {
            const m = this._get('hotdog', used.hotdog++);
            m.visible = true;
            if (t <= hd.t) {
              const e = clamp((t - hd.t0) / (hd.t - hd.t0), 0, 1);
              // re-aim at the duck's live position so it visibly connects
              const target = ducks && ducks[hd.duck] ? this._v2.copy(ducks[hd.duck].pos).setY(ducks[hd.duck].pos.y + 0.8) : hd.target;
              m.position.lerpVectors(hd.from, target, e);
              m.position.y += Math.sin(Math.PI * e) * clamp(hd.from.distanceTo(target) * 0.12, 2.5, 6);
              m.rotation.set(e * 14, e * 3, 0);
              m.scale.setScalar(1.15);
            } else {
              // bounce away and sink
              const e = t - hd.t;
              const d = ducks && ducks[hd.duck] ? ducks[hd.duck] : null;
              const base = d ? d.pos : hd.target;
              m.position.set(base.x + e * 3, base.y + 1.2 + 3 * e - 6 * e * e, base.z + e * 2);
              m.rotation.set(e * 20, e * 9, 0);
              m.scale.setScalar(Math.max(0.01, 1.15 * (1 - e / 1.3)));
            }
          }
        }
      }
    }
    // hide unused pool meshes
    for (const kind of Object.keys(this.pool)) for (let i = used[kind]; i < this.pool[kind].length; i++) this.pool[kind][i].visible = false;
    this._updateParticles(dt);
  }

  /** Fireworks show driver: call each frame after the winner is home. */
  fireworksTick(dt, barges, active) {
    if (!active || !barges || !barges.length) return null;
    this.fireT -= dt;
    if (this.fireT <= 0) {
      this.fireT = this.rnd(0.35, 0.9);
      const b = barges[Math.floor(this.rnd(0, barges.length))];
      return this.firework(b);
    }
    return null;
  }
}

const tmpColor = new THREE.Color();
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sprite showing a held item above a duck. */
export function makeItemSprite() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 96;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.1, 1.1, 1);
  sprite.renderOrder = 11;
  sprite.visible = false;
  let current = null;
  sprite.userData.setItem = (id, charges = 1) => {
    const key = id ? id + charges : null;
    if (key === current) return;
    current = key;
    if (!id) { sprite.visible = false; return; }
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, 96, 96);
    g.fillStyle = 'rgba(12,22,34,0.7)';
    g.beginPath(); g.arc(48, 48, 46, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 3; g.stroke();
    g.drawImage(itemIconCanvas(id, 96), 6, 6, 84, 84);
    if (id === 'triple' && charges < 3) { g.fillStyle = '#fff'; g.font = '900 30px system-ui'; g.textAlign = 'right'; g.fillText('×' + charges, 90, 88); }
    tex.needsUpdate = true;
    sprite.visible = true;
  };
  return sprite;
}
