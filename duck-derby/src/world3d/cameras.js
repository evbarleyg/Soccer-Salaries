// Camera rig: chase cam (spring-damped, track-space so it never leaves the
// channel or clips the tunnel), TV director with auto-cuts, free-fly spectator
// cam, course fly-through, grid sweep, finish-line cam, winner orbit, podium.
import * as THREE from 'three';
import { clamp, lerp, smoothstep, mulberry32 } from '../rng.js';

const UP = new THREE.Vector3(0, 1, 0);
const tmpLook = new THREE.Vector3();

export class CameraRig {
  constructor(camera, track, dom) {
    this.camera = camera;
    this.track = track;
    this.dom = dom;
    this.mode = 'menu'; // menu | flythrough | grid | chase | tv | free | finish | orbit | podium
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.fov = 62;
    this.shake = 0;
    this.shakeSeed = 0;
    this.userYaw = 0;
    this.userPitch = 0;
    this.userZoom = 1;
    this.snapNext = true;
    this.tvShot = null;
    this.free = { yaw: 0, pitch: -0.2, vel: new THREE.Vector3(), keys: new Set(), speed: 22, touchMove: 0 };
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this.portrait = false;
    this.podiumSpot = null; // {pos, look}
    this.setSeed(1);
    this._bindInput();
  }

  /** Seed the TV director's shot lengths (2.8–6.5 s) so cuts don't land on a metronome. */
  setSeed(seed) {
    const rnd = mulberry32((seed >>> 0) || 1);
    this.slots = [0];
    while (this.slots[this.slots.length - 1] < 200) this.slots.push(this.slots[this.slots.length - 1] + 2.8 + rnd() * 3.7);
    this.tvOverride = null;
  }
  slotAt(t) {
    const s = this.slots;
    let k = 0;
    while (k < s.length - 1 && s[k + 1] <= t) k++;
    return k;
  }
  /** Event-driven TV cut: 'lead' {a, b} frames the two ducks; 'hit' {duck} dollies on the victim. */
  tvEvent(kind, data, t) {
    if (this.mode !== 'tv' || this.reducedMotion) return;
    if (this.tvOverride && t < this.tvOverride.until - 0.3) return; // don't stack
    if (kind === 'lead') this.tvOverride = { shot: { id: 'ev-lead-' + t.toFixed(1), pair: [data.a, data.b], fov: 52 }, until: t + 3.2 };
    else if (kind === 'hit') this.tvOverride = { shot: { id: 'ev-hit-' + t.toFixed(1), dollyOn: data.duck, ahead: 7, h: 0.7, fov: 68, stiff: 8 }, until: t + 2.9 };
    else if (kind === 'drop') this.tvOverride = { shot: null, until: t }; // handled by position logic
  }

  setMode(mode) {
    if (mode === this.mode) return;
    if (mode === 'free') {
      // start flying from wherever we are, keeping the view direction
      const dir = this._v1.copy(this.look).sub(this.pos).normalize();
      this.free.yaw = Math.atan2(dir.x, dir.z);
      this.free.pitch = Math.asin(clamp(dir.y, -0.99, 0.99));
      this.free.vel.set(0, 0, 0);
    }
    this.mode = mode;
    this.snapNext = mode !== 'free';
    this.tvShot = null;
  }

  cut() {
    this.snapNext = true;
  }

  kick(amount = 0.6) {
    if (this.reducedMotion) return;
    this.shake = Math.min(1.2, this.shake + amount);
  }

  /** Nudge the field of view (degrees); it eases back on its own. */
  fovPunch(deg) {
    this.fovExtra = (this.fovExtra || 0) + deg * (this.reducedMotion ? 0.3 : 1);
  }

  _bindInput() {
    const el = this.dom;
    let dragging = false;
    let lx = 0;
    let ly = 0;
    let pinchD = 0;
    const touches = new Map();
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
      el.setPointerCapture?.(e.pointerId);
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        pinchD = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging || !touches.has(e.pointerId)) return;
      const t = touches.get(e.pointerId);
      t.x = e.clientX;
      t.y = e.clientY;
      if (touches.size >= 2) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchD > 0) {
          const k = pinchD / d;
          if (this.mode === 'free') this.free.touchMove = (d - pinchD) * 0.08;
          else { this.userZoom = clamp(this.userZoom * k, 0.6, 1.8); this.lastInputAt = this.nowReal || 0; }
        }
        pinchD = d;
        return;
      }
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      if (this.mode === 'free') {
        this.free.yaw -= dx * 0.004;
        this.free.pitch = clamp(this.free.pitch - dy * 0.004, -1.4, 1.4);
      } else {
        this.userYaw = clamp(this.userYaw - dx * 0.005, -1.3, 1.3);
        this.userPitch = clamp(this.userPitch - dy * 0.004, -0.35, 0.6);
        this.lastInputAt = this.nowReal || 0;
      }
    });
    const end = (e) => {
      touches.delete(e.pointerId);
      if (touches.size === 0) dragging = false;
      pinchD = 0;
      this.free.touchMove = 0;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      if (this.mode === 'free') {
        const fwd = this._v1.set(Math.sin(this.free.yaw) * Math.cos(this.free.pitch), Math.sin(this.free.pitch), Math.cos(this.free.yaw) * Math.cos(this.free.pitch));
        this.pos.addScaledVector(fwd, -e.deltaY * 0.05);
      } else { this.userZoom = clamp(this.userZoom * (1 + e.deltaY * 0.001), 0.6, 1.8); this.lastInputAt = this.nowReal || 0; }
      e.preventDefault();
    }, { passive: false });
    el.addEventListener('dblclick', () => {
      this.userYaw = 0;
      this.userPitch = 0;
      this.userZoom = 1;
    });
    window.addEventListener('keydown', (e) => this.free.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.free.keys.delete(e.code));
    window.addEventListener('blur', () => this.free.keys.clear());
  }

  /** Desired chase-camera pose for duck state d (fills outPos/outLook; returns extra FOV). */
  chasePose(d, outPos, outLook) {
    const track = this.track;
    const inTunnel = d.section === 'tunnel' || (d.s > track.features.tunnelInS - 12 && d.s < track.features.tunnelOutS + 4);
    const portrait = this.portrait;
    const dist = (inTunnel ? 4.2 : portrait ? 4.9 : 5.4) * this.userZoom;
    const height = Math.max(0.7, (inTunnel ? 1.7 : portrait ? 2.7 : 2.35) * this.userZoom + this.userPitch * 3);
    const yaw = this.userYaw;
    const sBack = d.s - Math.cos(yaw) * dist;
    const latOff = d.lat * 0.92 + Math.sin(yaw) * dist;
    const half = track.course.widthAt(sBack) / 2 - 1.0;
    track.toWorld(sBack, clamp(latOff, -half, half), height + Math.min(1.6, d.hop * 0.4), outPos);
    track.toWorld(d.s + (portrait ? 11 : 9), d.lat * 0.85, (portrait ? 0.8 : 0.9), outLook);
    if ((d.airborne || d.spinning) && d.pos) {
      // over the weir (or while spinning out): look at the duck itself rather than the water ahead
      const f = track.frame(d.s);
      tmpLook.copy(d.pos).addScaledVector(f.flat, 5);
      tmpLook.y = d.pos.y - 0.2;
      outLook.lerp(tmpLook, 0.85);
      outPos.y = Math.max(outPos.y, d.pos.y - 1.2); // don't let the duck fly out of the top of the frame
    }
    return inTunnel;
  }

  /**
   * @param {number} dt frame delta (real seconds)
   * @param {object} ctx { t, phaseTime, phase, ducks: DuckState[], target, leader, race, events }
   */
  update(dt, ctx) {
    const cam = this.camera;
    this.nowReal = ctx.realTime;
    this.portrait = cam.aspect < 0.8;
    const baseFov = this.portrait ? 70 : 62;
    let wantFov = baseFov;
    const desiredPos = this._v1;
    const desiredLook = this._v2;
    let wantUp = UP;
    let stiffness = 7;
    const track = this.track;
    const L = track.length;

    switch (this.mode) {
      case 'menu': {
        const a = ctx.realTime * 0.05;
        const c = track.toWorld(25, 0, 0, this._v3);
        desiredPos.set(c.x + Math.cos(a) * 62, c.y + 24, c.z + Math.sin(a) * 62);
        desiredLook.copy(c).y += 2;
        stiffness = 2;
        break;
      }
      case 'flythrough': {
        const T = ctx.flyDuration || 11;
        const e = clamp(ctx.phaseTime / T, 0, 1);
        const ease = smoothstep(0, 1, e);
        const s = lerp(track.features.minS + 20, L + 40, ease);
        const f = track.frame(s);
        // open high over the marina (clear of the start banner and blimp), then swoop down to racing height
        const opening = 1 - smoothstep(10, 70, s);
        const h = 6.5 + 2.5 * Math.sin(e * Math.PI * 4) + (f.section === 'tunnel' ? -4.3 : 0) + (f.section === 'canyon' ? 3 : 0) + opening * 9;
        track.toWorld(s, Math.sin(e * 9) * 2 + opening * 6, Math.max(1.4, h), desiredPos);
        track.toWorld(s + 28 + opening * 20, 0, (f.section === 'tunnel' ? 1.2 : 1.5) + opening * 1.5, desiredLook);
        wantFov = baseFov + 8;
        stiffness = 5;
        break;
      }
      case 'grid': {
        const e = clamp(ctx.phaseTime / (ctx.gridDuration || 3), 0, 1);
        const w = track.frame(0).width;
        // sweep along the line-up at duck height, then rise behind the pack
        const a = lerp(-1, 1, smoothstep(0, 0.75, e));
        track.toWorld(7 - 2 * e, a * w * 0.42, 1.0 + 0.4 * e, desiredPos);
        track.toWorld(0, a * w * 0.3, 0.6, desiredLook);
        if (e > 0.65) {
          const k = smoothstep(0.65, 1, e);
          const tgt = ctx.ducks[ctx.target] || ctx.ducks[0];
          if (tgt) {
            const p2 = this._v3;
            const l2 = tmpLook;
            if (ctx.view === 'tv') { track.toWorld(-14, 16, 9, p2); track.toWorld(6, 0, 0.8, l2); }
            else this.chasePose(tgt, p2, l2);
            desiredPos.lerp(p2, k);
            desiredLook.lerp(l2, k);
          }
        }
        wantFov = lerp(baseFov + 4, baseFov, smoothstep(0.65, 1, e));
        stiffness = 6;
        break;
      }
      case 'chase': {
        const d = ctx.ducks[ctx.target] || ctx.ducks[0];
        if (!d) break;
        // camera sits behind along the track (track space keeps it inside the channel/tunnel), swung by user yaw
        const inTunnel = this.chasePose(d, desiredPos, desiredLook);
        // pack zoom: when the pack is tight around my duck, widen so neighbours stay in frame
        let close = 0;
        for (const o of ctx.ducks) if (o !== d && Math.abs(o.s - d.s) < 6 && Math.abs(o.lat - d.lat) < 5) close++;
        this.packZoom = lerp(this.packZoom || 0, close >= 3 ? 1 : 0, Math.min(1, dt * 1.5));
        wantFov += this.packZoom * 5;
        if (d.spinning) wantFov += 4;
        if (d.boosting) wantFov += 9;
        if (d.star) wantFov += 5;
        if (d.airborne) wantFov += 7;
        wantFov += clamp((d.v / (ctx.race ? ctx.race.v0 : 23) - 1) * 10, -3, 6);
        const f = track.frame(d.s);
        const bankRoll = this.externalLook ? 0 : clamp(-f.bank * 0.35, -0.1, 0.1); // cap at ~6 degrees
        wantUp = this._v3.copy(f.up).applyAxisAngle(f.flat, bankRoll).normalize();
        stiffness = inTunnel ? 9 : d.airborne ? 3.8 : 6.5;
        break;
      }
      case 'tv': {
        this._tv(ctx, desiredPos, desiredLook);
        wantFov = this.tvShot && this.tvShot.fov ? this.tvShot.fov : baseFov - 6;
        stiffness = this.tvShot && this.tvShot.stiff ? this.tvShot.stiff : 4;
        break;
      }
      case 'finish': {
        const w = track.frame(L).width;
        track.toWorld(L + 9, -w * 0.36, 2.0, desiredPos);
        const lead = ctx.ducks[ctx.leader] || ctx.ducks[0];
        track.toWorld(Math.min(L + 2, Math.max(L - 25, lead ? lead.s : L)), lead ? lead.lat * 0.5 : 0, 0.7, desiredLook);
        wantFov = baseFov - 8;
        stiffness = 5;
        break;
      }
      case 'orbit': {
        const d = ctx.ducks[ctx.orbitTarget ?? ctx.target] || ctx.ducks[0];
        if (!d) break;
        if (this.orbitA0 === undefined || ctx.phaseTime < 0.05) this.orbitA0 = Math.atan2(this.pos.z - d.pos.z, this.pos.x - d.pos.x);
        const a = this.orbitA0 + ctx.phaseTime * 0.55;
        const r = Math.min(4.8 * this.userZoom, track.course.widthAt(d.s) / 2);
        desiredPos.set(d.pos.x + Math.cos(a) * r, d.pos.y + 1.7 + this.userPitch * 2, d.pos.z + Math.sin(a) * r);
        desiredLook.copy(d.pos).y += 0.7;
        wantFov = baseFov - 10;
        stiffness = 5;
        break;
      }
      case 'podium': {
        if (this.podiumSpot) {
          const a = Math.sin(ctx.phaseTime * 0.25) * 0.25;
          desiredPos.copy(this.podiumSpot.pos);
          desiredPos.x += Math.cos(a) * 2 - 2;
          desiredPos.z += Math.sin(a) * 2;
          desiredLook.copy(this.podiumSpot.look);
          // keep the podium clear of the results panel: right half on landscape, upper half (and wider) on portrait
          const f = this._v3.subVectors(this.podiumSpot.look, this.podiumSpot.pos).setY(0).normalize();
          if (this.portrait) { desiredPos.addScaledVector(f, -7); desiredPos.y += 2.2; desiredLook.y -= 7.5; }
          else desiredLook.addScaledVector(this._v3.set(f.z, 0, -f.x), 4.8);
        }
        wantFov = this.portrait ? baseFov + 6 : baseFov - 4;
        stiffness = 3;
        break;
      }
      case 'free': {
        this._freeFly(dt);
        cam.fov += (baseFov + 6 - cam.fov) * Math.min(1, dt * 4);
        cam.updateProjectionMatrix();
        return;
      }
      default:
        break;
    }

    if (this.fovExtra) {
      wantFov += this.fovExtra;
      this.fovExtra *= Math.exp(-dt * (ctx.phase === 'countdown' ? 0.15 : 3.5));
      if (Math.abs(this.fovExtra) < 0.05) this.fovExtra = 0;
    }
    if (this.portrait) wantFov = Math.min(wantFov, baseFov + 12);
    // drag-to-look and pinch recentre themselves a moment after the last touch
    if (!this.externalLook && this.lastInputAt !== undefined && ctx.realTime - this.lastInputAt > 2.2) {
      const r = 1 - Math.exp(-dt * 2.2);
      this.userYaw *= 1 - r;
      this.userPitch *= 1 - r;
      if (ctx.realTime - this.lastInputAt > 6) this.userZoom += (1 - this.userZoom) * r;
    }
    const k = this.snapNext ? 1 : 1 - Math.exp(-stiffness * dt);
    this.pos.lerp(desiredPos, k);
    if (this.mode === 'chase') {
      // never let the spring carry the camera into the duck (hits kill its speed suddenly)
      const d = ctx.ducks[ctx.target];
      if (d && d.pos) {
        const dx = this.pos.x - d.pos.x;
        const dz = this.pos.z - d.pos.z;
        const dist = Math.hypot(dx, dz);
        const minD = 3.6;
        if (dist < minD && dist > 1e-3) { this.pos.x = d.pos.x + (dx / dist) * minD; this.pos.z = d.pos.z + (dz / dist) * minD; }
      }
    }
    this.look.lerp(desiredLook, this.snapNext ? 1 : 1 - Math.exp(-(stiffness + 2) * dt));
    this.up.lerp(wantUp, this.snapNext ? 1 : 1 - Math.exp(-3 * dt)).normalize();
    this.snapNext = false;

    cam.position.copy(this.pos);
    // impact shake
    if (this.shake > 0.001) {
      this.shakeSeed += dt * 40;
      const a = this.shake * this.shake * 0.35;
      cam.position.x += Math.sin(this.shakeSeed * 1.7) * a;
      cam.position.y += Math.sin(this.shakeSeed * 2.3 + 1) * a;
      cam.position.z += Math.sin(this.shakeSeed * 1.1 + 2) * a;
      this.shake = Math.max(0, this.shake - dt * 1.8);
    }
    // keep the camera above the water surface near the course
    cam.up.copy(this.up);
    cam.lookAt(this.look);
    this.fov += (wantFov - this.fov) * Math.min(1, dt * 5);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  _tv(ctx, outPos, outLook) {
    const track = this.track;
    const F = track.features;
    const L = track.length;
    const lead = ctx.ducks[ctx.leader] || ctx.ducks[0];
    if (!lead) return;
    const s = lead.s;
    const t = ctx.t;
    // pack centre (mean of the front half)
    let cs = 0;
    let cl = 0;
    let n = 0;
    const sorted = ctx.standings || [];
    const frontN = Math.max(1, Math.ceil(ctx.ducks.length / 2));
    for (let r = 0; r < Math.min(frontN, sorted.length); r++) {
      const d = ctx.ducks[sorted[r].i];
      cs += d.s;
      cl += d.lat;
      n++;
    }
    if (n) {
      cs /= n;
      cl /= n;
    } else {
      cs = s;
    }
    // candidate shots keyed off the leader's position (deterministic in t)
    let shot;
    if (s > F.dropLipS - 30 && s < F.dropLandS + 22) shot = { id: 'weir', s: F.dropLandS + 24, lat: -11, h: 6.2, lookS: F.dropLipS + 3, lookH: 3.0, fov: 54 };
    else if (s > F.tunnelInS - 8 && s < F.tunnelOutS - 25) shot = { id: 'tunnel-dolly', dolly: true, ahead: 10, h: 1.1, fov: 70, stiff: 8 };
    else if (s > F.tunnelOutS - 25 && s < F.tunnelOutS + 20) shot = { id: 'tunnel-exit', s: F.tunnelOutS + 26, lat: 8, h: 2.2, lookS: F.tunnelOutS + 2, lookH: 1.5, fov: 55 };
    else if (s > L - 70) shot = { id: 'finish', s: L + 10, lat: -track.frame(L).width * 0.34, h: 2.4, lookLeader: true, fov: 52 };
    else if (s < 60) shot = { id: 'start-crane', s: -14, lat: 16, h: 9, lookPack: true, fov: 60 };
    else {
      const slot = this.slotAt(t);
      const flip = slot % 2;
      if (s > F.canyonInS + 25 && s < F.lilyInS - 30) {
        // canyon: alternate in-channel apex cams and a low chase dolly
        const half = track.course.widthAt(s + 32) / 2;
        shot = flip === 0 ? { id: 'canyon-apex-' + slot, s: s + 32, lat: (slot % 4 < 2 ? 1 : -1) * (half - 1.2), h: 3.2, lookPack: true, fov: 60 } : { id: 'canyon-dolly-' + slot, dolly: true, ahead: 12, h: 0.7, fov: 66, stiff: 7 };
      } else if (s > F.lilyInS - 30 && s < F.dropLipS - 30) shot = flip === 0 ? { id: 'lily-low-' + slot, s: Math.min(s + 34, F.dropApproachS - 5), lat: -11, h: 0.45, lookPack: true, fov: 62 } : { id: 'lily-heli-' + slot, heli: true, r: 34, h: 20, fov: 54 };
      else if (s > F.tunnelOutS + 20 && s < F.harborInS) shot = flip === 0 ? { id: 'rapids-dolly-' + slot, dolly: true, ahead: 11, h: 0.6, fov: 68, stiff: 7 } : { id: 'rapids-rock-' + slot, s: s + 36, lat: 9, h: 5.5, lookPack: true, fov: 56 };
      else shot = flip === 0 ? { id: 'heli-' + slot, heli: true, r: 36, h: 22, fov: 55 } : { id: 'dolly-' + slot, dolly: true, ahead: 12, h: 0.8, fov: 66, stiff: 7 };
    }
    // event cuts (lead changes, big hits) pre-empt the schedule for their duration
    if (this.tvOverride && this.tvOverride.shot && t < this.tvOverride.until && !(s > F.dropLipS - 30 && s < F.dropLandS + 22) && s < L - 70) shot = this.tvOverride.shot;
    else if (this.tvOverride && t >= this.tvOverride.until + 1.2) this.tvOverride = null;
    else if (this.tvOverride && t >= this.tvOverride.until && this.tvShot) shot = this.tvShot.id.startsWith('ev-') ? shot : this.tvShot; // hold the scheduled shot briefly after an event cut

    if (!this.tvShot || this.tvShot.id !== shot.id) {
      this.tvShot = shot;
      this.snapNext = true; // hard cut
    }
    const sh = this.tvShot;
    if (sh.pair) {
      const a = ctx.ducks[sh.pair[0]];
      const b = ctx.ducks[sh.pair[1]] || a;
      if (a) {
        const ms = (a.s + b.s) / 2;
        const ml = (a.lat + b.lat) / 2;
        const sep = Math.hypot(a.s - b.s, a.lat - b.lat);
        const r = Math.max(16, sep * 1.8) * this.userZoom;
        const c = track.toWorld(ms, ml * 0.5, 0, this._v3);
        const ang = t * 0.2;
        outPos.set(c.x + Math.cos(ang) * r, c.y + 9 + sep * 0.4, c.z + Math.sin(ang) * r);
        if (this.terrainHeight) outPos.y = Math.max(outPos.y, this.terrainHeight(outPos.x, outPos.z) + 4);
        outLook.copy(c).y += 0.8;
      }
    } else if (sh.dollyOn !== undefined) {
      const v = ctx.ducks[sh.dollyOn] || lead;
      const half = track.course.widthAt(v.s + sh.ahead) / 2 - 1.5;
      track.toWorld(v.s + sh.ahead, clamp(-v.lat * 0.3, -half, half), sh.h, outPos);
      track.toWorld(v.s - 2, v.lat * 0.7, 0.7, outLook);
    } else if (sh.heli) {
      const a = t * 0.16 + this.userYaw;
      const c = track.toWorld(cs, cl * 0.5, 0, this._v3);
      outPos.set(c.x + Math.cos(a) * sh.r * this.userZoom, c.y + sh.h * this.userZoom, c.z + Math.sin(a) * sh.r * this.userZoom);
      if (this.terrainHeight) outPos.y = Math.max(outPos.y, this.terrainHeight(outPos.x, outPos.z) + 4);
      outLook.copy(c).y += 1;
    } else if (sh.dolly) {
      const half = track.course.widthAt(s + sh.ahead) / 2 - 1.5;
      track.toWorld(s + sh.ahead, clamp(-lead.lat * 0.4, -half, half), sh.h, outPos);
      track.toWorld(s - 3, lead.lat * 0.6, 0.7, outLook);
    } else {
      track.toWorld(sh.s, sh.lat, sh.h, outPos);
      if (this.terrainHeight) {
        outPos.y = Math.max(outPos.y, this.terrainHeight(outPos.x, outPos.z) + 1.2);
        // cheap occlusion test along the sight line to the leader: lift the camera until it clears
        const tgt = track.toWorld(Math.min(lead.s, L + 3), lead.lat * 0.6, 0.7, tmpLook);
        for (let tries = 0; tries < 4; tries++) {
          let blocked = false;
          for (let k = 1; k <= 5; k++) {
            const f = k / 6;
            const x = outPos.x + (tgt.x - outPos.x) * f;
            const z = outPos.z + (tgt.z - outPos.z) * f;
            const y = outPos.y + (tgt.y - outPos.y) * f;
            if (this.terrainHeight(x, z) > y - 0.5) { blocked = true; break; }
          }
          if (!blocked) break;
          outPos.y += 2.5;
        }
      }
      if (sh.lookLeader) track.toWorld(Math.min(lead.s, L + 3), lead.lat * 0.6, 0.7, outLook);
      else if (sh.lookPack) track.toWorld(lerp(cs, s, 0.6), cl * 0.5, 0.8, outLook);
      else track.toWorld(sh.lookS, 0, sh.lookH ?? 1, outLook);
    }
  }

  _freeFly(dt) {
    const f = this.free;
    const k = f.keys;
    const fwd = this._v1.set(Math.sin(f.yaw) * Math.cos(f.pitch), Math.sin(f.pitch), Math.cos(f.yaw) * Math.cos(f.pitch));
    const right = this._v2.set(Math.cos(f.yaw), 0, -Math.sin(f.yaw)).negate();
    const acc = this._v3.set(0, 0, 0);
    if (k.has('KeyW') || k.has('ArrowUp')) acc.add(fwd);
    if (k.has('KeyS') || k.has('ArrowDown')) acc.sub(fwd);
    if (k.has('KeyD') || k.has('ArrowRight')) acc.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) acc.sub(right);
    if (k.has('KeyE') || k.has('PageUp')) acc.y += 1;
    if (k.has('KeyQ') || k.has('PageDown')) acc.y -= 1;
    if (f.touchMove) acc.addScaledVector(fwd, clamp(f.touchMove, -1, 1));
    const speed = f.speed * (k.has('ShiftLeft') || k.has('ShiftRight') ? 3 : 1);
    f.vel.addScaledVector(acc, speed * dt * 4);
    f.vel.multiplyScalar(Math.exp(-dt * 3.5));
    this.pos.addScaledVector(f.vel, dt);
    // don't sink: stay above the water/terrain near the course
    const sNear = this.track.nearestS(this.pos.x, this.pos.z);
    const c = this.track.course.at(sNear);
    const distToLine = Math.hypot(this.pos.x - c.x, this.pos.z - c.z);
    const floor = (distToLine < c.width / 2 + 2 ? c.y : -5.7) + 0.8;
    if (this.terrainHeight) this.pos.y = Math.max(this.pos.y, Math.max(floor, this.terrainHeight(this.pos.x, this.pos.z) + 1.0));
    else this.pos.y = Math.max(this.pos.y, floor);
    this.pos.y = Math.min(this.pos.y, 160);
    this.look.copy(this.pos).add(fwd);
    this.camera.position.copy(this.pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.look);
  }
}
