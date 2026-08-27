// Race scene renderer: parallax world, water, lane ropes, ducks, wakes,
// particles, start dock, finish gantry and an adaptive broadcast camera.
// World x is measured in track units (0 = start line, TRACK_LENGTH = finish);
// screen mapping is sx = W/2 + (x - cam.x) * cam.ppu.

import { drawDuck } from './draw-duck.js';
import { TRACK_LENGTH, positionAt, speedAt } from './sim.js';
import { clamp, lerp, smoothstep, createRng } from './rng.js';

const TAU = Math.PI * 2;
const NOSE = 36; // local units from body centre to beak tip: positions refer to the beak

export const THEMES = {
  day: {
    skyTop: '#2F7FD8',
    skyMid: '#7CC9F3',
    skyLow: '#FFEBC4',
    sun: '#FFF3B0',
    sunGlow: 'rgba(255,236,170,0.35)',
    hillFar: '#86B9CF',
    hillNear: '#5FA37A',
    hillNear2: '#4B8C60',
    bank: '#6BBE55',
    bankDark: '#4E9A3E',
    wall: '#C9C1B1',
    wallDark: '#9C9384',
    waterTop: '#3CB5E6',
    waterBottom: '#1560A8',
    waterStreak: 'rgba(255,255,255,0.20)',
    waterDark: 'rgba(6,40,100,0.13)',
    rope: '#F6F2E9',
    buoyA: '#FF5A47',
    buoyB: '#FFFFFF',
    cloud: '#FFFFFF',
    cloudShade: '#DCEBFA',
  },
};

export class RaceScene {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.theme = THEMES.day;
    this.dpr = 1;
    this.W = 0;
    this.H = 0;
    this.insets = { left: 0, right: 0, top: 0, bottom: 0 };
    this.sim = null;
    this.looks = [];
    this.lanes = [];
    this.cam = { x: 0, ppu: 5, targetPpu: 5, vx: 0 };
    this.wall = 0; // wall-clock seconds, for ambient animation
    this.particles = [];
    this.projectiles = [];
    this.duckFx = [];
    this.cheer = 0;
    this.flash = 0;
    this.shake = 0;
    this.slowmo = 0;
    this.quality = { reflections: true, particles: 1 };
    this.frameMsAvg = 8;
    this.tiles = null;
    this.clouds = [];
    this.reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._seedDecor(1234);
  }

  _seedDecor(seed) {
    const rng = createRng(seed);
    this.clouds = [];
    for (let i = 0; i < 9; i++) {
      this.clouds.push({ x: rng.range(0, 1), y: rng.range(0.05, 0.55), s: rng.range(0.6, 1.4), v: rng.range(0.004, 0.012), puff: rng.int(3, 5), seed: rng.next() });
    }
    this.decorRng = rng;
  }

  setInsets(insets) {
    this.insets = { ...this.insets, ...insets };
  }

  setLooks(looks) {
    this.looks = looks || [];
    this.duckFx = this.looks.map(() => ({ flap: 0, dizzy: 0, quack: 0, boostGlow: 0, lastFoam: 0, place: 0, spin: -1, stars: 0 }));
    this.projectiles = [];
    this.layout();
  }

  setRace(sim, looks) {
    this.sim = sim;
    this.setLooks(looks);
    this.particles.length = 0;
    this.cheer = 0;
    this.flash = 0;
    this.snapCamera(0);
  }

  resize() {
    const cssW = this.canvas.clientWidth || 800;
    const cssH = this.canvas.clientHeight || 500;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = cssW;
    this.H = cssH;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.layout();
    this._buildTiles();
  }

  /** Vertical layout of sky / water / lanes. */
  layout() {
    const { W, H } = this;
    if (!W || !H) return;
    const n = Math.max(1, this.looks.length || 8);
    const skyFrac = H < 520 ? 0.24 : 0.29;
    this.skyH = Math.round(H * skyFrac);
    this.waterTop = this.skyH;
    const usableTop = this.waterTop + Math.max(18, (H - this.waterTop) * 0.07) + this.insets.top * 0;
    const usableBottom = H - Math.max(10, (H - this.waterTop) * 0.04) - this.insets.bottom;
    // perspective: lane height grows toward the viewer
    const sMin = n > 6 ? 0.8 : 0.88;
    let total = 0;
    const weights = [];
    for (let i = 0; i < n; i++) {
      const w = lerp(sMin, 1, n === 1 ? 1 : i / (n - 1));
      weights.push(w);
      total += w;
    }
    const avail = usableBottom - usableTop;
    this.lanes = [];
    let y = usableTop;
    for (let i = 0; i < n; i++) {
      const h = (avail * weights[i]) / total;
      const persp = weights[i];
      const duckScale = clamp((h * 0.95) / 34, 0.45, 1.8);
      this.lanes.push({ top: y, h, y: y + h * 0.6, persp, duckScale });
      y += h;
    }
    this.ropeYs = [usableTop, ...this.lanes.map((l) => l.top + l.h)];
  }

  effectiveW() {
    return Math.max(200, this.W - this.insets.left - this.insets.right);
  }

  ppuMax() {
    return clamp(this.effectiveW() / 170, 3.2, 8.5);
  }

  ppuMin() {
    return this.effectiveW() / 340;
  }

  sx(x) {
    return this.insets.left + this.effectiveW() / 2 + (x - this.cam.x) * this.cam.ppu;
  }

  /** Visual (possibly past-the-line) position of duck i at race time t. */
  duckX(i, t) {
    const sim = this.sim;
    if (!sim) return 0;
    const ft = sim.finishTimes[i];
    if (ft !== null && t > ft) {
      const vf = Math.max(speedAt(sim, i, ft - 0.05), sim.trackLength / sim.duration * 0.8);
      const tau = 1.1;
      const dtp = t - ft;
      return sim.trackLength + vf * tau * (1 - Math.exp(-dtp / tau)) + 2 * Math.min(dtp, 3);
    }
    return positionAt(sim, i, t);
  }

  duckV(i, t) {
    const sim = this.sim;
    if (!sim) return 0;
    const ft = sim.finishTimes[i];
    if (ft !== null && t > ft) {
      const vf = speedAt(sim, i, ft - 0.05);
      return vf * Math.exp(-(t - ft) / 1.1);
    }
    return speedAt(sim, i, t);
  }

  /** Place camera instantly for race time t. */
  snapCamera(t) {
    const target = this._cameraTarget(t);
    this.cam.x = target.x;
    this.cam.ppu = target.ppu;
    this.cam.targetPpu = target.ppu;
  }

  _cameraTarget(t) {
    const n = this.looks.length;
    const Weff = this.effectiveW();
    let lead = 0;
    let tail = Infinity;
    if (this.sim && n) {
      const xs = [];
      for (let i = 0; i < n; i++) xs.push(this.duckX(i, t));
      xs.sort((a, b) => a - b);
      lead = xs[xs.length - 1];
      // ignore one hopeless straggler when framing (they get an edge marker)
      tail = xs.length > 4 ? lerp(xs[0], xs[1], 0.5) : xs[0];
    } else {
      tail = 0;
    }
    const span = Math.max(lead - tail, 1);
    let ppu = (Weff * 0.56) / Math.max(span + 14, 48);
    ppu = clamp(ppu, this.ppuMin(), this.ppuMax());
    // leader sits at ~70% of the effective width
    let x = lead - (0.7 - 0.5) * (Weff / ppu);
    const minX = (0.5 - 0.3) * (Weff / ppu); // start line no further right than 30%
    const maxX = TRACK_LENGTH + (0.5 - 0.34) * (Weff / ppu); // finish line no further left than 34%
    x = clamp(x, minX, maxX);
    return { x, ppu };
  }

  update(dt, t, phase) {
    this.wall += dt;
    const target = this._cameraTarget(t);
    const k = this.reduceMotion ? 10 : phase === 'race' ? 3.2 : 2.0;
    const a = 1 - Math.exp(-dt * k);
    const prevX = this.cam.x;
    this.cam.ppu = lerp(this.cam.ppu, target.ppu, 1 - Math.exp(-dt * 1.3));
    this.cam.x = lerp(this.cam.x, target.x, a);
    this.cam.vx = dt > 0 ? (this.cam.x - prevX) / dt : 0;

    this.cheer = Math.max(0, this.cheer - dt * 0.35);
    this.flash = Math.max(0, this.flash - dt * 2.5);
    this.shake = Math.max(0, this.shake - dt * 3);

    // per-duck fx decay + foam trail
    if (this.sim) {
      for (let i = 0; i < this.looks.length; i++) {
        const fx = this.duckFx[i];
        fx.flap = Math.max(0, fx.flap - dt * 0.7);
        fx.dizzy = Math.max(0, fx.dizzy - dt * 0.9);
        fx.quack = Math.max(0, fx.quack - dt * 3.5);
        fx.boostGlow = Math.max(0, fx.boostGlow - dt * 1.2);
        fx.stars = Math.max(0, fx.stars - dt * 0.45);
        if (fx.spin >= 0) {
          fx.spin += dt / 0.95;
          if (fx.spin >= 1) fx.spin = -1;
        }
        if (phase === 'race' || phase === 'finish') {
          const v = this.duckV(i, t);
          const rate = (v / (TRACK_LENGTH / this.sim.duration)) * 11 * this.quality.particles;
          fx.lastFoam += dt * rate;
          while (fx.lastFoam >= 1) {
            fx.lastFoam -= 1;
            this._spawnFoam(i, t, v);
          }
        }
      }
    }

    // projectiles that have landed
    for (let p = this.projectiles.length - 1; p >= 0; p--) {
      if (t > this.projectiles[p].tHit + 0.05) this.projectiles.splice(p, 1);
    }

    // particles
    const g = 520;
    for (let p = this.particles.length - 1; p >= 0; p--) {
      const q = this.particles[p];
      q.age += dt;
      if (q.age >= q.life) {
        this.particles.splice(p, 1);
        continue;
      }
      q.ox += q.vx * dt;
      q.oy += q.vy * dt;
      if (q.kind === 'drop') q.vy += g * dt;
      if (q.kind === 'confetti') {
        q.vy += 160 * dt;
        q.vx *= 1 - dt * 0.8;
        q.rot += q.vr * dt;
      }
    }
  }

  _spawnFoam(i, t, v) {
    const lane = this.lanes[i];
    if (!lane) return;
    const x = this.duckX(i, t) - ((NOSE + 26) * lane.duckScale) / this.cam.ppu;
    const spread = 3 * lane.duckScale;
    this.particles.push({
      kind: 'foam',
      wx: x,
      lane: i,
      ox: (Math.random() - 0.5) * 4,
      oy: 8 * lane.duckScale + (Math.random() - 0.5) * spread,
      vx: -4 - Math.random() * 6,
      vy: (Math.random() - 0.5) * 2,
      r: (1.2 + Math.random() * 1.8) * lane.duckScale,
      age: 0,
      life: 0.5 + Math.random() * 0.5,
    });
  }

  /** Trigger effects for a sim event. */
  onEvent(ev, t) {
    const fx = this.duckFx[ev.duck];
    if (!fx) return;
    const lane = this.lanes[ev.duck];
    if (ev.type === 'burst') {
      fx.flap = 1;
      fx.boostGlow = 1;
      fx.quack = 1;
      this.splash(ev.duck, t, 14);
    } else if (ev.type === 'stumble') {
      fx.dizzy = 1;
      this.splash(ev.duck, t, 8, true);
    } else if (ev.type === 'lead') {
      this.cheer = Math.min(1, this.cheer + 0.5);
      fx.quack = 1;
    } else if (ev.type === 'finish') {
      this.cheer = 1;
      if (fx.place === 0) fx.place = 1;
      if (!this.reduceMotion) this.confettiBurst(TRACK_LENGTH, lane ? lane.top : this.waterTop, 26);
    } else if (ev.type === 'stretch') {
      this.cheer = Math.min(1, this.cheer + 0.7);
    } else if (ev.type === 'hotdog') {
      fx.spin = 0; // starts the hop + flip
      fx.stars = 1;
      fx.dizzy = 0.34; // wobble but keep normal eyes until stars fade
      this.splash(ev.duck, t, 16, false, '#F5C400');
      this.splash(ev.duck, t, 10, true, '#D7263D');
      this.shake = Math.max(this.shake, 0.45);
      this.cheer = Math.min(1, this.cheer + 0.6);
    }
  }

  splash(i, t, count = 12, back = false, color = null) {
    const lane = this.lanes[i];
    if (!lane) return;
    const wx = this.duckX(i, t);
    const n = Math.round(count * this.quality.particles);
    for (let k = 0; k < n; k++) {
      const a = back ? Math.PI * (1.05 + Math.random() * 0.4) : Math.PI * (1.1 + Math.random() * 0.8);
      const sp = (90 + Math.random() * 160) * lane.duckScale;
      this.particles.push({
        kind: 'drop',
        wx,
        lane: i,
        ox: (-NOSE - 20 + Math.random() * 30) * lane.duckScale,
        oy: 6 * lane.duckScale,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 60,
        r: (1.2 + Math.random() * 2) * lane.duckScale * (color ? 1.3 : 1),
        color,
        age: 0,
        life: 0.5 + Math.random() * 0.4,
      });
    }
  }

  /** Visual-only: lob a hot dog from the stands so it lands on duck i at race time tHit. */
  launchHotdog(i, tNow, tHit) {
    this.projectiles.push({ duck: i, t0: tNow, tHit, done: false });
  }

  confettiBurst(wx, y, count = 40) {
    const cols = ['#FF3CAC', '#2BD2FF', '#FFE066', '#7CFF6B', '#FF7A2F', '#B18AF0', '#FFFFFF'];
    const n = Math.round(count * this.quality.particles);
    for (let k = 0; k < n; k++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const sp = 220 + Math.random() * 320;
      this.particles.push({
        kind: 'confetti',
        wx,
        lane: -1,
        absY: y,
        ox: (Math.random() - 0.5) * 10,
        oy: 0,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        r: 3 + Math.random() * 3,
        rot: Math.random() * TAU,
        vr: (Math.random() - 0.5) * 14,
        color: cols[k % cols.length],
        age: 0,
        life: 1.6 + Math.random() * 1.2,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render(t, phase) {
    const t0 = performance.now();
    const { ctx, W, H, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let shakeX = 0;
    let shakeY = 0;
    if (this.shake > 0 && !this.reduceMotion) {
      shakeX = (Math.random() - 0.5) * 8 * this.shake;
      shakeY = (Math.random() - 0.5) * 6 * this.shake;
      ctx.translate(shakeX, shakeY);
    }

    this._drawSky();
    this._drawHills();
    this._drawStands();
    this._drawBank();
    this._drawWater(t);
    this._drawCourse(t, phase);
    this._drawRopes();
    this._drawParticles('foam');
    this._drawDucks(t, phase);
    this._drawParticles('drop');
    this._drawProjectiles(t);
    this._drawFinishOverhead();
    this._drawParticles('confetti');
    this._drawEdgeMarkers(t, phase);
    this._drawVignette();

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.85})`;
      ctx.fillRect(-10, -10, W + 20, H + 20);
    }

    // adaptive quality
    const ms = performance.now() - t0;
    this.frameMsAvg = lerp(this.frameMsAvg, ms, 0.05);
    if (this.frameMsAvg > 14 && this.quality.reflections) this.quality.reflections = false;
    if (this.frameMsAvg > 18) this.quality.particles = 0.5;
  }

  _drawSky() {
    const { ctx, W, theme } = this;
    const h = this.skyH;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, theme.skyTop);
    g.addColorStop(0.62, theme.skyMid);
    g.addColorStop(1, theme.skyLow);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, h + 2);

    // sun
    const sunX = W * 0.78 - this.cam.x * 0.01;
    const sunY = h * 0.38;
    const rg = ctx.createRadialGradient(sunX, sunY, 4, sunX, sunY, h * 0.7);
    rg.addColorStop(0, 'rgba(255,250,220,0.95)');
    rg.addColorStop(0.12, theme.sunGlow);
    rg.addColorStop(1, 'rgba(255,236,170,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, h * 1.2);
    ctx.fillStyle = theme.sun;
    ctx.beginPath();
    ctx.arc(sunX, sunY, h * 0.09, 0, TAU);
    ctx.fill();

    // clouds
    for (const c of this.clouds) {
      const span = W + 300;
      let x = ((c.x * span + this.wall * c.v * 120 - this.cam.x * this.cam.ppu * 0.03) % span + span) % span - 150;
      const y = c.y * h;
      this._cloud(x, y, c.s * (h / 200), c);
    }
  }

  _cloud(x, y, s, c) {
    const { ctx, theme } = this;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    const puffs = [[-26, 4, 16], [-8, -6, 22], [14, -2, 19], [32, 6, 13], [2, 8, 18]];
    ctx.fillStyle = theme.cloudShade;
    ctx.beginPath();
    for (const [px, py, pr] of puffs) {
      ctx.moveTo(px + pr, py + 4);
      ctx.arc(px, py + 4, pr, 0, TAU);
    }
    ctx.fill();
    ctx.fillStyle = theme.cloud;
    ctx.beginPath();
    for (const [px, py, pr] of puffs) {
      ctx.moveTo(px + pr, py);
      ctx.arc(px, py, pr, 0, TAU);
    }
    ctx.fill();
    ctx.restore();
  }

  _drawHills() {
    const { ctx, W, theme } = this;
    const h = this.skyH;
    const layers = [
      { par: 0.06, color: theme.hillFar, base: h * 0.62, amp: h * 0.16, f1: 0.004, f2: 0.011 },
      { par: 0.12, color: theme.hillNear, base: h * 0.74, amp: h * 0.12, f1: 0.006, f2: 0.017 },
      { par: 0.2, color: theme.hillNear2, base: h * 0.86, amp: h * 0.07, f1: 0.009, f2: 0.021 },
    ];
    for (const L of layers) {
      const off = this.cam.x * this.cam.ppu * L.par;
      ctx.fillStyle = L.color;
      ctx.beginPath();
      ctx.moveTo(0, h + 2);
      for (let x = 0; x <= W + 8; x += 8) {
        const wx = x + off;
        const y = L.base - (Math.sin(wx * L.f1) * 0.6 + Math.sin(wx * L.f2 + 1.7) * 0.4 + 1) * 0.5 * L.amp;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, h + 2);
      ctx.closePath();
      ctx.fill();
    }
  }

  _buildTiles() {
    // Pre-render the grandstand + crowd strip (two arm poses) for cheap tiling.
    const tileW = 480;
    const tileH = Math.max(40, Math.round(this.skyH * 0.42));
    const make = () => {
      const c = document.createElement('canvas');
      c.width = tileW * this.dpr;
      c.height = tileH * this.dpr;
      const x = c.getContext('2d');
      x.scale(this.dpr, this.dpr);
      return { c, x };
    };
    const poses = [make(), make()];
    const rng = createRng(99);
    const people = [];
    const rows = clamp(Math.floor(tileH / 11), 2, 6);
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < tileW / 9; col++) {
        people.push({ r, col, hue: rng.int(0, 359), light: rng.int(45, 70), skin: rng.pick(['#F6D3B3', '#E9B48A', '#C68A5E', '#8D5A3B', '#5C3A25']), up: rng.chance(0.5), hat: rng.chance(0.2) });
      }
    }
    poses.forEach((p, pi) => {
      const x = p.x;
      // stand structure
      const roofH = tileH * 0.22;
      x.fillStyle = this.theme.wall;
      x.fillRect(0, roofH, tileW, tileH - roofH);
      // tiers
      for (let r = 0; r < rows; r++) {
        const y = roofH + 4 + r * ((tileH - roofH - 6) / rows);
        x.fillStyle = r % 2 ? 'rgba(0,0,0,0.06)' : 'rgba(0,0,0,0.02)';
        x.fillRect(0, y, tileW, (tileH - roofH) / rows);
      }
      // people
      for (const pz of people) {
        const y = roofH + 9 + pz.r * ((tileH - roofH - 8) / rows);
        const px = pz.col * 9 + (pz.r % 2 ? 4 : 0);
        const up = pi === 1 ? !pz.up : pz.up;
        x.fillStyle = `hsl(${pz.hue} 70% ${pz.light}%)`;
        x.beginPath();
        x.roundRect ? x.roundRect(px - 3.2, y, 6.4, 8, 2) : x.rect(px - 3.2, y, 6.4, 8);
        x.fill();
        if (up) {
          x.strokeStyle = x.fillStyle;
          x.lineWidth = 1.6;
          x.beginPath();
          x.moveTo(px - 2.5, y + 2);
          x.lineTo(px - 5, y - 4);
          x.moveTo(px + 2.5, y + 2);
          x.lineTo(px + 5, y - 4);
          x.stroke();
        }
        x.fillStyle = pz.skin;
        x.beginPath();
        x.arc(px, y - 2.2, 2.6, 0, TAU);
        x.fill();
        if (pz.hat) {
          x.fillStyle = `hsl(${(pz.hue + 180) % 360} 70% 50%)`;
          x.fillRect(px - 3, y - 5.5, 6, 2);
        }
      }
      // striped roof
      const stripeW = 24;
      for (let sxp = 0; sxp < tileW; sxp += stripeW) {
        x.fillStyle = (sxp / stripeW) % 2 ? '#FFFFFF' : '#E23D4E';
        x.beginPath();
        x.moveTo(sxp, roofH);
        x.lineTo(sxp + stripeW, roofH);
        x.lineTo(sxp + stripeW + 6, 2);
        x.lineTo(sxp + 6, 2);
        x.closePath();
        x.fill();
      }
      x.fillStyle = 'rgba(0,0,0,0.18)';
      x.fillRect(0, roofH, tileW, 3);
      // posts
      x.fillStyle = this.theme.wallDark;
      for (let pxp = 0; pxp < tileW; pxp += 120) x.fillRect(pxp, roofH, 3, tileH - roofH);
    });
    this.tiles = { poses, tileW, tileH };

    // bunting tile
    const b = document.createElement('canvas');
    b.width = 240 * this.dpr;
    b.height = 26 * this.dpr;
    const bx = b.getContext('2d');
    bx.scale(this.dpr, this.dpr);
    bx.strokeStyle = 'rgba(60,60,60,0.7)';
    bx.lineWidth = 1;
    bx.beginPath();
    for (let xx = 0; xx <= 240; xx += 4) {
      const yy = 3 + Math.sin((xx / 240) * TAU) * 3 + 3;
      if (xx === 0) bx.moveTo(xx, yy);
      else bx.lineTo(xx, yy);
    }
    bx.stroke();
    const flagCols = ['#FF3CAC', '#FFE066', '#2BD2FF', '#7CFF6B', '#FF7A2F', '#FFFFFF'];
    for (let f = 0; f < 12; f++) {
      const fx = f * 20 + 4;
      const fy = 3 + Math.sin((fx / 240) * TAU) * 3 + 3;
      bx.fillStyle = flagCols[f % flagCols.length];
      bx.beginPath();
      bx.moveTo(fx, fy);
      bx.lineTo(fx + 12, fy + 0.5);
      bx.lineTo(fx + 6, fy + 13);
      bx.closePath();
      bx.fill();
    }
    this.bunting = b;
  }

  _drawStands() {
    const { ctx, W } = this;
    if (!this.tiles) return;
    const { poses, tileW, tileH } = this.tiles;
    const par = 0.38;
    const y0 = this.skyH - tileH - Math.round(this.skyH * 0.1);
    const off = this.cam.x * this.cam.ppu * par;
    const start = -((off % tileW) + tileW) % tileW;
    const bounce = this.reduceMotion ? 0 : this.cheer;
    let k = Math.floor(off / tileW);
    for (let x = start; x < W; x += tileW, k++) {
      // alternate poses over time when cheering; gaps between stands show trees
      const pose = bounce > 0.05 ? (Math.floor(this.wall * 6 + k) % 2) : (k % 2);
      const dy = bounce > 0 ? -Math.abs(Math.sin(this.wall * 9 + k)) * 3 * bounce : 0;
      const gap = (k % 3 === 2);
      if (gap) {
        this._drawTrees(x, y0, tileW, tileH, k);
      } else {
        ctx.drawImage(poses[pose].c, x, y0 + dy, tileW, tileH);
      }
    }
    // bunting string along the front of the stands
    if (this.bunting) {
      const bpar = 0.45;
      const boff = this.cam.x * this.cam.ppu * bpar;
      const bw = 240;
      const bstart = -((boff % bw) + bw) % bw;
      const by = this.skyH - Math.round(this.skyH * 0.1) - 6;
      for (let x = bstart; x < W; x += bw) ctx.drawImage(this.bunting, x, by, bw, 26);
    }
  }

  _drawTrees(x, y0, w, h, k) {
    const { ctx } = this;
    const rng = createRng(77 + (k & 1023));
    const n = 5;
    for (let i = 0; i < n; i++) {
      const tx = x + (i + 0.5) * (w / n) + rng.range(-12, 12);
      const th = h * rng.range(0.7, 1.15);
      const ty = y0 + h;
      ctx.fillStyle = '#6b4a2b';
      ctx.fillRect(tx - 3, ty - th * 0.35, 6, th * 0.35);
      const shades = ['#3F8F4E', '#4FA55C', '#347A43'];
      for (let j = 0; j < 3; j++) {
        ctx.fillStyle = shades[j];
        ctx.beginPath();
        ctx.arc(tx + (j - 1) * th * 0.16, ty - th * (0.5 + (j % 2) * 0.14), th * 0.3, 0, TAU);
        ctx.fill();
      }
    }
  }

  _drawBank() {
    const { ctx, W, theme } = this;
    const bankH = Math.max(10, Math.round(this.skyH * 0.1));
    const y = this.skyH - bankH;
    // grass verge
    const g = ctx.createLinearGradient(0, y, 0, y + bankH);
    g.addColorStop(0, '#8BD870');
    g.addColorStop(1, theme.bankDark);
    ctx.fillStyle = g;
    ctx.fillRect(0, y, W, bankH * 0.55);
    // stone embankment
    const wy = y + bankH * 0.55;
    ctx.fillStyle = theme.wall;
    ctx.fillRect(0, wy, W, bankH * 0.45 + 1);
    const par = 0.6;
    const off = this.cam.x * this.cam.ppu * par;
    ctx.fillStyle = theme.wallDark;
    const bw = 38;
    const start = -((off % bw) + bw) % bw;
    for (let x = start; x < W; x += bw) ctx.fillRect(x, wy, 1.5, bankH * 0.45);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, this.skyH - 2, W, 2);
    // reeds clumps
    const rpar = 0.62;
    const roff = this.cam.x * this.cam.ppu * rpar;
    const rw = 170;
    const rstart = -((roff % rw) + rw) % rw;
    let k = Math.floor(roff / rw);
    for (let x = rstart; x < W + rw; x += rw, k++) {
      if (k % 2) continue;
      this._reeds(x + 40, this.skyH + 1, bankH * 1.3, k);
    }
  }

  _reeds(x, y, h, k) {
    const { ctx } = this;
    const sway = this.reduceMotion ? 0 : Math.sin(this.wall * 1.5 + k) * 2;
    ctx.strokeStyle = '#2E7D45';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (let i = 0; i < 7; i++) {
      const bx = x + i * 4;
      const bh = h * (0.6 + ((i * 37 + k * 13) % 10) / 22);
      ctx.beginPath();
      ctx.moveTo(bx, y);
      ctx.quadraticCurveTo(bx + sway * 0.5, y - bh * 0.5, bx + sway + (i - 3), y - bh);
      ctx.stroke();
      if (i % 3 === 0) {
        ctx.fillStyle = '#7A4E2A';
        ctx.beginPath();
        ctx.ellipse(bx + sway + (i - 3), y - bh - 4, 1.8, 5, 0, 0, TAU);
        ctx.fill();
      }
    }
  }

  _drawWater(t) {
    const { ctx, W, H, theme } = this;
    const y0 = this.waterTop;
    const g = ctx.createLinearGradient(0, y0, 0, H);
    g.addColorStop(0, theme.waterTop);
    g.addColorStop(1, theme.waterBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, y0, W, H - y0);

    // bank reflection band
    const rg = ctx.createLinearGradient(0, y0, 0, y0 + 18);
    rg.addColorStop(0, 'rgba(255,255,255,0.28)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, y0, W, 18);

    // streaks: rows with perspective parallax (slightly faster near the bottom)
    const rows = 14;
    ctx.lineCap = 'round';
    for (let r = 0; r < rows; r++) {
      const fy = (r + 0.5) / rows;
      const y = y0 + 6 + fy * (H - y0 - 8);
      const par = 0.92 + fy * 0.16;
      const off = this.cam.x * this.cam.ppu * par + this.wall * (18 + r * 3);
      const spacing = 90 + (r % 3) * 35;
      const len = 18 + fy * 30;
      const start = -((off % spacing) + spacing) % spacing;
      ctx.lineWidth = 1.2 + fy * 2.2;
      ctx.strokeStyle = r % 2 ? theme.waterStreak : theme.waterDark;
      ctx.beginPath();
      let k = Math.floor(off / spacing);
      for (let x = start; x < W + spacing; x += spacing, k++) {
        const jitter = ((k * 9301 + r * 4973) % 233) / 233;
        const xx = x + jitter * spacing * 0.6;
        const yy = y + Math.sin(this.wall * 2 + k + r) * 1.5;
        ctx.moveTo(xx, yy);
        ctx.quadraticCurveTo(xx + len * 0.5, yy - 1.5 - fy, xx + len, yy);
      }
      ctx.stroke();
    }
    // shimmer highlights
    if (!this.reduceMotion) {
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      for (let i = 0; i < 24; i++) {
        const fx = ((i * 0.6180339) % 1);
        const fy = ((i * 0.3819) % 1);
        const x = ((fx * W * 1.3 - this.cam.x * this.cam.ppu * (0.95 + fy * 0.15)) % (W * 1.3) + W * 1.3) % (W * 1.3) - W * 0.15;
        const y = y0 + 10 + fy * (H - y0 - 20);
        const a = 0.5 + 0.5 * Math.sin(this.wall * 3 + i * 1.7);
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.ellipse(x, y, 10 + fy * 16, 1.5 + fy * 1.5, 0, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  /** Start pontoon, finish line on the water, distance boards. */
  _drawCourse(t, phase) {
    const { ctx, W, H } = this;
    const top = this.ropeYs[0];
    const bottom = this.ropeYs[this.ropeYs.length - 1];
    // ---- start dock (x < 0) ----
    const sx0 = this.sx(0);
    if (sx0 > -40) {
      const dockRight = sx0 - 30 * (this.lanes[0] ? this.lanes[this.lanes.length - 1].duckScale : 1);
      if (dockRight > 0) {
        // wooden dock planks
        ctx.fillStyle = '#9A6B3E';
        ctx.fillRect(0, top - 14, dockRight, bottom - top + 24);
        ctx.fillStyle = '#B98450';
        for (let y = top - 14; y < bottom + 10; y += 14) ctx.fillRect(0, y, dockRight, 6);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        for (let x = dockRight - 6; x > 0; x -= 60) ctx.fillRect(x, top - 14, 2, bottom - top + 24);
        // dock edge posts
        ctx.fillStyle = '#6E4A2A';
        ctx.fillRect(dockRight - 5, top - 22, 7, bottom - top + 34);
        // shadow on water
        const sg = ctx.createLinearGradient(dockRight, 0, dockRight + 30, 0);
        sg.addColorStop(0, 'rgba(0,30,70,0.35)');
        sg.addColorStop(1, 'rgba(0,30,70,0)');
        ctx.fillStyle = sg;
        ctx.fillRect(dockRight + 2, top - 6, 30, bottom - top + 12);
      }
      // start line rope of pennants across the water
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(sx0, top - 4);
      ctx.lineTo(sx0, bottom + 4);
      ctx.stroke();
      ctx.setLineDash([]);
      this._banner(sx0, top, 'START', '#1F5BD8');
    }

    // ---- distance boards ----
    for (const m of [250, 500, 750]) {
      const x = this.sx(m);
      if (x < -60 || x > W + 60) continue;
      const label = `${(TRACK_LENGTH - m) / 10}m`;
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(x - 1, top - 2, 2, bottom - top + 4);
      this._board(x, top - 6, label);
    }

    // ---- finish line on the water ----
    const fx = this.sx(TRACK_LENGTH);
    if (fx > -80 && fx < W + 80) {
      const sq = 7;
      const cols = 3;
      for (let c = 0; c < cols; c++) {
        for (let y = top - 4, r = 0; y < bottom + 4; y += sq, r++) {
          ctx.fillStyle = (r + c) % 2 ? 'rgba(20,20,30,0.85)' : 'rgba(255,255,255,0.92)';
          ctx.fillRect(fx - (cols * sq) / 2 + c * sq, y, sq, Math.min(sq, bottom + 4 - y));
        }
      }
    }
  }

  _banner(x, top, text, color) {
    const { ctx } = this;
    const y = Math.max(16, top - 34);
    ctx.fillStyle = '#6E4A2A';
    ctx.fillRect(x - 2, y - 6, 4, top - y + 8);
    ctx.font = '800 13px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
    const w = ctx.measureText(text).width + 18;
    ctx.fillStyle = color;
    roundRectPath(ctx, x - w / 2, y - 22, w, 20, 6);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y - 12);
  }

  _board(x, y, text) {
    const { ctx } = this;
    ctx.font = '700 11px ui-rounded, system-ui, sans-serif';
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = 'rgba(16,24,40,0.75)';
    roundRectPath(ctx, x - w / 2, y - 16, w, 16, 5);
    ctx.fill();
    ctx.fillStyle = '#FFE066';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y - 8);
  }

  _drawFinishOverhead() {
    const { ctx, W } = this;
    const fx = this.sx(TRACK_LENGTH);
    if (fx < -120 || fx > W + 120) return;
    const top = this.ropeYs[0];
    const bottom = this.ropeYs[this.ropeYs.length - 1];
    const gy = Math.max(18, top - 40);
    // posts
    ctx.fillStyle = '#E9E4DA';
    ctx.strokeStyle = '#7A828E';
    ctx.lineWidth = 1;
    for (const py of [top - 6, bottom + 2]) {
      ctx.fillStyle = '#D8D2C4';
      ctx.fillRect(fx - 4, Math.min(gy - 8, py), 8, Math.abs(py - gy + 8) + 6);
    }
    // chequered banner
    const bw = 150;
    const bh = 26;
    const bx = fx - bw / 2;
    const by = gy - bh;
    ctx.fillStyle = '#111';
    roundRectPath(ctx, bx - 3, by - 3, bw + 6, bh + 6, 6);
    ctx.fill();
    const sq = 6.5;
    ctx.save();
    roundRectPath(ctx, bx, by, bw, bh, 4);
    ctx.clip();
    for (let cx = 0; cx < bw / sq; cx++) {
      for (let cy = 0; cy < bh / sq; cy++) {
        ctx.fillStyle = (cx + cy) % 2 ? '#111' : '#fff';
        ctx.fillRect(bx + cx * sq, by + cy * sq, sq, sq);
      }
    }
    ctx.fillStyle = 'rgba(226,61,78,0.94)';
    roundRectPath(ctx, fx - 42, by + 4, 84, bh - 8, 4);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#fff';
    ctx.font = '900 14px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FINISH', fx, by + bh / 2 + 0.5);
    // flags on top
    const wave = Math.sin(this.wall * 6) * 3;
    for (const side of [-1, 1]) {
      const px = fx + side * (bw / 2 + 1);
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, by - 2);
      ctx.lineTo(px, by - 20);
      ctx.stroke();
      ctx.fillStyle = side < 0 ? '#E23D4E' : '#1F5BD8';
      ctx.beginPath();
      ctx.moveTo(px, by - 20);
      ctx.quadraticCurveTo(px + side * 8, by - 18 + wave, px + side * 16, by - 15);
      ctx.lineTo(px, by - 10);
      ctx.closePath();
      ctx.fill();
    }
  }

  _drawRopes() {
    const { ctx, W, theme } = this;
    const spacing = 14; // track units between buoys
    for (let r = 0; r < this.ropeYs.length; r++) {
      const y = this.ropeYs[r];
      const fy = (y - this.waterTop) / Math.max(1, this.H - this.waterTop);
      const size = 2.2 + fy * 2.4;
      // rope
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1 + fy;
      ctx.beginPath();
      const x0 = Math.max(-10, this.sx(0));
      const x1 = Math.min(W + 10, this.sx(TRACK_LENGTH + 60));
      if (x1 <= x0) continue;
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      // buoys
      const first = Math.max(0, Math.floor((this.cam.x - this.effectiveW() / this.cam.ppu) / spacing));
      const last = Math.min(Math.ceil(TRACK_LENGTH / spacing) + 4, Math.ceil((this.cam.x + (this.W) / this.cam.ppu) / spacing) + 1);
      for (let k = first; k <= last; k++) {
        const x = this.sx(k * spacing);
        if (x < -10 || x > W + 10) continue;
        const bob = this.reduceMotion ? 0 : Math.sin(this.wall * 3 + k * 0.7 + r) * 1.2;
        ctx.fillStyle = k % 5 === 0 ? '#FFD23F' : k % 2 ? theme.buoyA : theme.buoyB;
        ctx.beginPath();
        ctx.ellipse(x, y + bob, size * 1.15, size, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.beginPath();
        ctx.ellipse(x, y + bob + size * 0.45, size * 1.15, size * 0.55, 0, 0, Math.PI);
        ctx.fill();
      }
    }
  }

  _drawDucks(t, phase) {
    const { ctx } = this;
    const n = this.looks.length;
    if (!n) return;
    const idle = !this.sim || phase === 'setup' || phase === 'intro' || phase === 'countdown';
    for (let i = 0; i < n; i++) {
      const look = this.looks[i];
      const lane = this.lanes[i];
      if (!lane) continue;
      const fx = this.duckFx[i] || {};
      const wx = idle ? 0 : this.duckX(i, t);
      const v = idle ? 0 : this.duckV(i, t);
      const v0 = this.sim ? TRACK_LENGTH / this.sim.duration : 26;
      const effort = idle ? 0.15 : clamp(v / v0, 0, 1.6);
      const scale = lane.duckScale;
      const x = this.sx(wx) - NOSE * scale;
      if (x < -90 * scale || x > this.W + 90 * scale) continue;
      const bob = Math.sin(this.wall * 2.6 * look.bobRate + look.bobPhase) * 2.2 * scale;
      const y = lane.y + bob;

      // wake behind the duck
      if (!idle && v > 1) this._wake(x, lane.y, scale, effort, i);

      // boost glow
      if (fx.boostGlow > 0.02 && !idle) {
        ctx.save();
        ctx.globalAlpha = fx.boostGlow * 0.5;
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2 * scale;
        ctx.lineCap = 'round';
        for (let s = 0; s < 3; s++) {
          const ly = y - 14 * scale + s * 10 * scale;
          const lx = x - 48 * scale - s * 6 * scale - ((this.wall * 200) % 30) * scale;
          ctx.beginPath();
          ctx.moveTo(lx, ly);
          ctx.lineTo(lx - 22 * scale, ly);
          ctx.stroke();
        }
        ctx.restore();
      }

      // soft contact shadow on the water
      ctx.fillStyle = 'rgba(6,40,100,0.18)';
      ctx.beginPath();
      ctx.ellipse(x + 2 * scale, lane.y + 10 * scale, 34 * scale, 5 * scale, 0, 0, TAU);
      ctx.fill();

      const spinning = fx.spin >= 0;
      const hop = spinning ? Math.sin(Math.PI * fx.spin) * 22 * scale : 0;
      const spinAngle = spinning ? -TAU * easeInOut(fx.spin) : 0;

      drawDuck(ctx, look, {
        x,
        y: y - hop,
        scale,
        t: this.wall + i * 0.37,
        effort,
        flap: idle ? 0 : spinning ? 1 : Math.max(fx.flap || 0, effort > 1.25 ? 0.6 : 0),
        beakOpen: spinning ? 1 : fx.quack > 0 ? Math.sin(fx.quack * Math.PI) : 0,
        dizzy: fx.dizzy || 0,
        tilt: idle ? 0 : spinAngle - 0.04 * (effort - 0.8),
        standing: false,
        airborne: spinning,
      });

      if (fx.stars > 0.02 && !spinning) this._stars(x + 18 * scale, y - 38 * scale, scale, fx.stars);

      // stumble "?!" bubble
      if (fx.dizzy > 0.35) {
        ctx.save();
        ctx.globalAlpha = clamp((fx.dizzy - 0.35) * 3, 0, 1);
        ctx.font = `900 ${Math.round(14 * scale)}px ui-rounded, system-ui, sans-serif`;
        ctx.fillStyle = '#FFE066';
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 3;
        ctx.textAlign = 'center';
        ctx.strokeText('?!', x + 4 * scale, y - 44 * scale);
        ctx.fillText('?!', x + 4 * scale, y - 44 * scale);
        ctx.restore();
      }
    }
  }

  _wake(x, y, scale, effort, i) {
    const { ctx } = this;
    const len = (40 + effort * 70) * scale;
    const spread = (10 + effort * 10) * scale;
    const sternX = x - 28 * scale;
    const wy = y + 8 * scale;
    ctx.save();
    ctx.lineCap = 'round';
    for (let s = 0; s < 2; s++) {
      const sign = s ? 1 : -1;
      const g = ctx.createLinearGradient(sternX, 0, sternX - len, 0);
      g.addColorStop(0, 'rgba(255,255,255,0.7)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 2 * scale;
      ctx.beginPath();
      ctx.moveTo(sternX, wy);
      const phase = this.wall * 8 + i;
      for (let k = 1; k <= 8; k++) {
        const f = k / 8;
        const px = sternX - len * f;
        const py = wy + sign * spread * f + Math.sin(phase + f * 10) * 1.5 * scale;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    // bow wave
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1.6 * scale;
    ctx.beginPath();
    ctx.arc(x + 30 * scale, wy + 1, 7 * scale * (0.6 + effort * 0.5), Math.PI * 1.1, Math.PI * 1.75);
    ctx.stroke();
    ctx.restore();
  }

  _drawParticles(kind) {
    const { ctx } = this;
    for (const p of this.particles) {
      if (p.kind !== kind) continue;
      const life = 1 - p.age / p.life;
      let x;
      let y;
      if (p.lane >= 0) {
        const lane = this.lanes[p.lane];
        if (!lane) continue;
        x = this.sx(p.wx) + p.ox;
        y = lane.y + p.oy;
      } else {
        x = this.sx(p.wx) + p.ox;
        y = p.absY + p.oy;
      }
      if (x < -20 || x > this.W + 20) continue;
      if (kind === 'foam') {
        ctx.fillStyle = `rgba(255,255,255,${0.55 * life})`;
        ctx.beginPath();
        ctx.arc(x, y, p.r * (0.6 + 0.8 * (1 - life)), 0, TAU);
        ctx.fill();
      } else if (kind === 'drop') {
        ctx.globalAlpha = 0.9 * life;
        ctx.fillStyle = p.color || 'rgb(225,245,255)';
        ctx.beginPath();
        ctx.arc(x, y, p.r, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (kind === 'confetti') {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.min(1, life * 2);
        ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
        ctx.restore();
      }
    }
  }

  _drawProjectiles(t) {
    const { ctx } = this;
    for (const pr of this.projectiles) {
      const lane = this.lanes[pr.duck];
      if (!lane) continue;
      const p = clamp((t - pr.t0) / Math.max(0.001, pr.tHit - pr.t0), 0, 1);
      const tx = this.sx(this.duckX(pr.duck, t)) - (NOSE - 10) * lane.duckScale;
      const ty = lane.y - 18 * lane.duckScale;
      const sx0 = tx + 260;
      const sy0 = this.skyH * 0.45;
      const cx = (sx0 + tx) / 2;
      const cy = Math.min(sy0, ty) - 160;
      const u = 1 - p;
      const x = u * u * sx0 + 2 * u * p * cx + p * p * tx;
      const y = u * u * sy0 + 2 * u * p * cy + p * p * ty;
      const s = lane.duckScale * (1.0 + 0.6 * p);
      // motion streak
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const pb = Math.max(0, p - 0.08);
      const ub = 1 - pb;
      ctx.moveTo(ub * ub * sx0 + 2 * ub * pb * cx + pb * pb * tx, ub * ub * sy0 + 2 * ub * pb * cy + pb * pb * ty);
      ctx.lineTo(x, y);
      ctx.stroke();
      drawHotdog(ctx, x, y, s, this.wall * 14);
    }
  }

  _stars(x, y, scale, a) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = clamp(a * 2, 0, 1);
    for (let k = 0; k < 4; k++) {
      const ang = this.wall * 5 + (k / 4) * TAU;
      const px = x + Math.cos(ang) * 16 * scale;
      const py = y + Math.sin(ang) * 5 * scale;
      ctx.fillStyle = k % 2 ? '#FFE066' : '#FFFFFF';
      starPath(ctx, px, py, 4.2 * scale);
      ctx.fill();
    }
    ctx.restore();
  }

  _drawEdgeMarkers(t, phase) {
    if (!this.sim || (phase !== 'race' && phase !== 'finish')) return;
    const { ctx } = this;
    for (let i = 0; i < this.looks.length; i++) {
      const lane = this.lanes[i];
      const x = this.sx(this.duckX(i, t));
      if (x >= -20) continue;
      const look = this.looks[i];
      const y = lane.y - 4;
      const px = this.insets.left + 14;
      ctx.fillStyle = 'rgba(16,24,40,0.7)';
      ctx.beginPath();
      ctx.moveTo(px - 10, y);
      ctx.lineTo(px, y - 9);
      ctx.lineTo(px + 16, y - 9);
      ctx.lineTo(px + 16, y + 9);
      ctx.lineTo(px, y + 9);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = look.towel.bg;
      ctx.beginPath();
      ctx.arc(px + 7, y, 6.5, 0, TAU);
      ctx.fill();
      ctx.fillStyle = look.towel.text;
      ctx.font = '800 8px ui-rounded, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(look.number), px + 7, y + 0.5);
    }
  }

  _drawVignette() {
    if (this.slowmo <= 0.01) return;
    const { ctx, W, H } = this;
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,20,${0.55 * this.slowmo})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /** Screen-space anchor for duck i (for DOM labels). */
  duckScreen(i, t, phase) {
    const lane = this.lanes[i];
    if (!lane) return null;
    const idle = !this.sim || phase === 'setup' || phase === 'intro' || phase === 'countdown';
    const x = this.sx(idle ? 0 : this.duckX(i, t)) - NOSE * lane.duckScale;
    return { x, y: lane.y, scale: lane.duckScale, h: lane.h };
  }
}

function easeInOut(p) {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

function starPath(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * TAU - Math.PI / 2;
    const rr = k % 2 ? r * 0.45 : r;
    if (k === 0) ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    else ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
}

/** A cartoon hot dog: bun, sausage, mustard squiggle. */
export function drawHotdog(ctx, x, y, s, rot) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(s, s);
  // sausage (behind)
  ctx.fillStyle = '#B8432E';
  ctx.strokeStyle = '#7A2A1C';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.ellipse(0, -1, 19, 4.2, 0, 0, TAU);
  ctx.fill();
  ctx.stroke();
  // bun
  const g = ctx.createLinearGradient(0, -4, 0, 8);
  g.addColorStop(0, '#F2C079');
  g.addColorStop(1, '#C98B3F');
  ctx.fillStyle = g;
  ctx.strokeStyle = '#9A6428';
  ctx.beginPath();
  ctx.moveTo(-16, -1);
  ctx.quadraticCurveTo(-17, 8, 0, 8);
  ctx.quadraticCurveTo(17, 8, 16, -1);
  ctx.quadraticCurveTo(0, 3, -16, -1);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // mustard
  ctx.strokeStyle = '#F5C400';
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let k = 0; k <= 12; k++) {
    const px = -14 + (28 * k) / 12;
    const py = -2.5 + Math.sin(k * 1.3) * 1.6;
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.restore();
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
