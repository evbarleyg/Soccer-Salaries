// Per-frame duck posing from race state: bob, bank, drift, head pump, wing
// flaps, paddling feet, airborne pose off the Drop, boost squash & stretch,
// hop + 360° barrel roll on hits, dizzy stars, bubble shield, golden glow.
import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../rng.js';

const starGeo = new THREE.OctahedronGeometry(0.13, 0);
const starMat = new THREE.MeshBasicMaterial({ color: 0xffe14d });
const shieldGeo = new THREE.SphereGeometry(1.05, 20, 14);
const GOLD = new THREE.Color(0xffc830);

export class DuckAnimator {
  /** @param duck result of buildDuck; @param track Track */
  constructor(duck, track, index) {
    this.duck = duck;
    this.track = track;
    this.i = index;
    this.roll = 0;
    this.pitch = 0;
    this.yawOff = 0;
    this.squash = 0;
    this.prevLat = null;
    this.latVel = 0;
    this.frame = null;
    this.basis = new THREE.Matrix4();
    this.stars = null;
    this.shield = null;
    this.glow = 0;
    this.sprayAcc = 0;
    this._v = new THREE.Vector3();
    this._back = new THREE.Vector3();
    this.emissiveMats = duck.glowMats && duck.glowMats.length ? duck.glowMats : [duck.mats.body, duck.mats.head, duck.mats.wing, duck.mats.light];
    // per-duck instances of the water-contact materials so opacity can follow this duck's speed/height
    if (duck.shadow && duck.shadow.material) duck.shadow.material = duck.shadow.material.clone();
    if (duck.wake && duck.wake.material) duck.wake.material = duck.wake.material.clone();
    if (duck.foam && duck.foam.material) duck.foam.material = duck.foam.material.clone();
  }

  ensureStars() {
    if (this.stars) return;
    this.stars = new THREE.Group();
    for (let k = 0; k < 3; k++) {
      const m = new THREE.Mesh(starGeo, starMat);
      this.stars.add(m);
    }
    this.duck.group.add(this.stars);
    this.stars.visible = false;
  }
  ensureShield() {
    if (this.shield) return;
    this.shield = new THREE.Mesh(shieldGeo, new THREE.MeshLambertMaterial({ color: 0x7fdcff, emissive: 0x1d6d9c, transparent: true, opacity: 0.14, depthWrite: false }));
    this.shield.position.set(0, 0.45, 0);
    this.shield.renderOrder = 8;
    const rim = new THREE.Mesh(shieldGeo, new THREE.MeshBasicMaterial({ color: 0xd8f6ff, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending }));
    rim.scale.setScalar(1.04);
    this.shield.add(rim);
    this.duck.group.add(this.shield);
    this.shield.visible = false;
  }

  /**
   * @param {number} dt
   * @param {object} d duck race state {s, lat, v, hop, airborne, t, finished, win:{...}, v0}
   * @param {object} ctx { fx, realTime, chop }
   */
  update(dt, d, ctx) {
    const duck = this.duck;
    const look = duck.look;
    const t = d.t;
    const rt = ctx.realTime;
    const f = this.track.frame(d.s, this.frame || (this.frame = undefined));
    this.frame = f;
    const w = d.win;

    // --- position: on the (banked) water + hop + bob
    const chop = f.section === 'rapids' ? 1 : f.section === 'harbor' ? 0.5 : 0.25;
    const bob = Math.sin(rt * 2.3 * look.bobRate + look.bobPhase) * (0.05 + 0.05 * chop) + Math.sin(rt * 5.1 + look.bobPhase * 2) * 0.02 * chop;
    let hopY = d.hop;
    let spinE = -1;
    if (w.spin) {
      spinE = (t - w.spin.t0) / 0.95;
      if (spinE >= 0 && spinE < 1) hopY += Math.sin(Math.PI * spinE) * 1.0;
    }
    this.track.toWorld(d.s, d.lat, 0, duck.group.position);
    const waterY = duck.group.position.y;
    duck.group.position.y = waterY + hopY + (d.airborne ? 0 : bob) - 0.04;

    // --- orientation basis from the track (yaw + slope), roll/pitch extras on the pivot
    // lateral velocity -> small yaw into the drift
    if (this.prevLat === null) this.prevLat = d.lat;
    const dl = dt > 0 ? (d.lat - this.prevLat) / Math.max(dt, 1e-3) : 0;
    this.latVel = lerp(this.latVel, dl, Math.min(1, dt * 6));
    this.prevLat = d.lat;
    const speed = Math.max(0.1, d.v);
    const slipYaw = Math.atan2(this.latVel, speed) * 0.9;
    // drift: tail-out in sharp corners (nose into the turn)
    const drift = clamp(f.curvature * 7, -0.32, 0.32);
    const wantYaw = slipYaw + drift + (w.stumble ? Math.sin(t * 13) * 0.18 : 0) + (w.wobble ? Math.sin(t * 20) * 0.2 : 0);
    this.yawOff = lerp(this.yawOff, wantYaw, Math.min(1, dt * 5));

    // bank into turns (+ lean with lateral motion), wobble when dizzy
    let wantRoll = -f.bank * 1.1 - clamp(this.latVel * 0.05, -0.3, 0.3);
    const dizzy = (w.spin && t < w.spin.t1 + 0.5) || (w.stumble && (w.stumble.what === 'rock' || w.stumble.what === 'lilypad' || w.stumble.what === 'log' || w.stumble.what === 'buoy') && t < w.stumble.t0 + 0.9);
    if (dizzy && spinE >= 1) wantRoll += Math.sin(t * 12) * 0.22 * (1 - smoothstep(w.spin.t1 - 0.2, w.spin.t1 + 0.5, t));
    if (w.stumble) wantRoll += Math.sin(t * 15) * 0.16;
    this.roll = lerp(this.roll, wantRoll, Math.min(1, dt * 6));
    let roll = this.roll;
    if (spinE >= 0 && spinE < 1) {
      const e = spinE * spinE * (3 - 2 * spinE);
      roll += e * Math.PI * 2 * (this.i % 2 ? 1 : -1);
    }
    // pitch: follow hop arc when airborne, nose up on boosts, dip on splashdown
    let wantPitch = 0;
    if (d.airborne) {
      const h1 = this.track.course.hopAt(d.s + 0.6);
      const h0 = this.track.course.hopAt(d.s - 0.6);
      wantPitch = clamp(-Math.atan2(h1 - h0, 1.2) * 0.9, -0.7, 0.6);
    }
    if (w.boost || w.burst) wantPitch -= 0.16;
    if (w.star) wantPitch -= 0.1;
    this.pitch = lerp(this.pitch, wantPitch, Math.min(1, dt * 7));

    // basis: x = left, y = up, z = forward (level forward unless airborne)
    const fwd = d.airborne ? f.fwd : this._v.copy(f.flat);
    const up = this._back.set(0, 1, 0);
    const left = tmpL.crossVectors(up, fwd).normalize();
    const upO = tmpU.crossVectors(fwd, left).normalize();
    this.basis.makeBasis(left, upO, fwd);
    duck.group.quaternion.setFromRotationMatrix(this.basis);
    duck.pivot.rotation.set(this.pitch, this.yawOff, roll, 'YXZ');

    // --- squash & stretch on boost start / landing
    let sq = 0;
    const boostW = w.boost || w.burst;
    if (boostW) {
      const e = (t - boostW.t0) / 0.35;
      if (e >= 0 && e < 1) sq = Math.sin(Math.PI * e) * 0.22;
    }
    if (w.splash) sq -= Math.sin(Math.PI * clamp((t - w.splash.t0) / 0.3, 0, 1)) * 0.18;
    this.squash = lerp(this.squash, sq, Math.min(1, dt * 12));
    const sc = look.scale || 1;
    duck.pivot.scale.set(sc * (1 - this.squash * 0.5), sc * (1 - this.squash * 0.6), sc * (1 + this.squash));

    // --- head pump with effort, tail wag, wings, feet
    const effort = clamp(d.v / (d.v0 || 23), 0.3, 1.6);
    const pump = Math.sin(rt * (7 + effort * 4) + look.bobPhase);
    duck.head.position.z = 0.45 + pump * 0.05 * effort;
    duck.head.position.y = 0.9 + Math.abs(pump) * 0.03;
    duck.head.rotation.x = (boostW ? 0.25 : 0) + (d.airborne ? -0.2 : 0) + pump * 0.04;
    duck.head.rotation.z = dizzy ? Math.sin(t * 9) * 0.3 : 0;
    duck.tail.rotation.z = Math.sin(rt * 9 + look.bobPhase) * 0.25;
    const flapping = boostW || d.airborne || w.star || (d.finished && d.rank === 0);
    for (const wing of duck.wings) {
      const side = wing.userData.side;
      let lift;
      if (d.airborne) lift = 1.25 + Math.sin(rt * 8) * 0.25;
      else if (flapping) lift = 0.5 + Math.sin(rt * 28 * look.flapRate) * 0.55;
      else lift = 0.08 + Math.max(0, Math.sin(rt * 1.3 + look.bobPhase)) * 0.06;
      wing.rotation.z = side * lift;
      wing.rotation.x = d.airborne ? -0.3 : 0;
    }
    for (let k = 0; k < 2; k++) {
      const foot = duck.feet[k];
      if (d.airborne || spinE >= 0) {
        foot.rotation.x = 0.9;
        foot.position.z = -0.35;
      } else {
        foot.rotation.x = Math.sin(rt * 18 * effort + k * Math.PI) * 0.7;
        foot.position.z = -0.1 + Math.cos(rt * 18 * effort + k * Math.PI) * 0.12;
      }
    }
    if (duck.hat.userData.spin) duck.hat.userData.spin.rotation.y += dt * (18 + effort * 20);

    // --- shadow stays on the water
    duck.shadow.position.y = -(hopY + (d.airborne ? 0 : bob)) + 0.1;
    const shS = 1 - clamp(hopY / 6, 0, 0.6);
    duck.shadow.scale.set(0.75 * shS, 1.05 * shS, 1);
    duck.shadow.material.opacity = 0.35 * (1 - clamp(hopY / 4, 0, 1));
    // wake + waterline foam scale with speed (nothing at rest on the grid, nothing in the air)
    const spd = clamp(d.v / (d.v0 || 23), 0, 1.4);
    const onWater = d.airborne || spinE >= 0 ? 0 : 1;
    if (duck.wake && duck.wake.material) duck.wake.material.opacity = 0.3 * smoothstep(0.25, 0.8, spd) * onWater * (boostW || w.star ? 1.3 : 1);
    if (duck.foam && duck.foam.material) duck.foam.material.opacity = (0.18 + 0.3 * smoothstep(0.1, 0.7, spd)) * onWater;

    // --- dizzy stars
    if (dizzy) {
      this.ensureStars();
      this.stars.visible = true;
      for (let k = 0; k < 3; k++) {
        const a = rt * 5 + (k * Math.PI * 2) / 3;
        this.stars.children[k].position.set(Math.cos(a) * 0.55, 1.5 + Math.sin(rt * 3 + k) * 0.05, 0.45 + Math.sin(a) * 0.55);
        this.stars.children[k].rotation.y = a * 2;
      }
    } else if (this.stars) this.stars.visible = false;

    // --- bubble shield
    if (w.shield) {
      this.ensureShield();
      this.shield.visible = true;
      const k = 1 + Math.sin(rt * 6) * 0.03;
      this.shield.scale.setScalar(k);
      this.shield.material.opacity = ctx.isTarget ? 0.2 : 0.12;
      this.shieldWin = w.shield;
    } else if (this.shield) {
      // pop animation just after it ends
      const wS = this.shieldWin;
      const since = wS ? t - wS.t1 : 99;
      if (wS && since >= 0 && since < 0.3 && wS.popped) {
        this.shield.visible = true;
        this.shield.scale.setScalar(1 + since * 3);
        this.shield.material.opacity = 0.25 * (1 - since / 0.3);
      } else this.shield.visible = false;
    }

    // --- golden feather glow
    const wantGlow = w.star ? 0.55 + Math.sin(rt * 14) * 0.25 : 0;
    if (Math.abs(wantGlow - this.glow) > 0.005) {
      this.glow = lerp(this.glow, wantGlow, Math.min(1, dt * 10));
      for (const m of this.emissiveMats) {
        if (!m) continue;
        m.emissive.copy(GOLD);
        m.emissiveIntensity = this.glow;
      }
    }

    // --- continuous particles
    const fx = ctx.fx;
    if (fx) {
      const back = this._back.copy(f.flat).negate();
      const sternPos = this._v.copy(duck.group.position).addScaledVector(back, 0.75);
      sternPos.y = waterY + 0.15;
      if (!d.airborne && spinE < 0) {
        // wake spray scales with speed; rooster tail when boosting
        this.sprayAcc += ctx.lens ? 0 : dt * (boostW || w.star ? 60 : d.v > 5 ? 14 * effort : 0) * (ctx.near ? 1 : 0.35);
        while (this.sprayAcc >= 1) {
          this.sprayAcc -= 1;
          fx.spray(sternPos, back, boostW || w.star ? 1.6 : 0.7);
        }
        if (boostW && ctx.near) fx.bubbles(sternPos, 1);
      }
      if (w.star && ctx.near) fx.sparkle(duck.group.position, 0xffe680, 1);
      if (w.mud && ctx.near && Math.sin(rt * 20) > 0.7) fx.sparkle(this._v.copy(duck.group.position).setY(duck.group.position.y + 1), 0x7a5230, 0.6);
    }
  }
}
const tmpL = new THREE.Vector3();
const tmpU = new THREE.Vector3();
