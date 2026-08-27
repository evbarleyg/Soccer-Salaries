// Race scene renderer: parallax venue, water, lane float-lines, ducks, wakes,
// particles, start dock, finish gantry, the hot-dog set piece and an adaptive
// broadcast camera with a zoom/punch channel.
// World x is measured in track units (0 = start line, TRACK_LENGTH = finish);
// screen mapping is sx = insets.left + Weff/2 + (x - cam.x) * cam.ppu.

import { drawDuck, drawCrownGlyph, HAT_HEIGHT } from './draw-duck.js';
import { TRACK_LENGTH, positionAt, speedAt } from './sim.js';
import { clamp, lerp, createRng } from './rng.js';

const TAU = Math.PI * 2;
const NOSE = 36; // local units from body centre to beak tip: positions refer to the beak
const MAX_PARTICLES = 700;
const FLOAT_PITCH = 2.8; // track units between lane-line floats (fixed in world space so floats never crawl during zooms)
const UI_FONT = 'ui-rounded, "SF Pro Rounded", "Segoe UI", system-ui, sans-serif';
const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const CROWD_COLS = ['#E23D4E', '#1F5BD8', '#FFD23F', '#FFFFFF', '#16B8A6', '#FF7A2F', '#8E5BD9', '#2B2B2B'];
const SKINS = ['#F6D3B3', '#E9B48A', '#C68A5E', '#8D5A3B', '#5C3A25'];
const CONFETTI_COLS = ['#FF3CAC', '#2BD2FF', '#FFE066', '#7CFF6B', '#FF7A2F', '#B18AF0', '#FFFFFF'];
const PENNANT_COLS = ['#FF3CAC', '#FFE066', '#2BD2FF', '#7CFF6B', '#FF7A2F', '#FFFFFF'];
// 3x5 dot-matrix digits for the scoreboard tower (bit 14 = top-left)
const DOT_FONT = { 0: 0x7b6f, 1: 0x2c97, 2: 0x73e7, 3: 0x73cf, 4: 0x5bc9, 5: 0x79cf, 6: 0x79ef, 7: 0x7292, 8: 0x7bef, 9: 0x7bcf, '.': 0x0002, ':': 0x0410 };

export const THEMES = {
  day: {
    skyTop: '#2B6BD0',
    skyMid: '#78C2F2',
    skyLow: '#FFD7A3',
    sun: '#FFF6C2',
    sunRim: '#FFFBE3',
    far: '#A5C6DC',
    hillFar: '#86B9CF',
    hillNear: '#5FA37A',
    hillNear2: '#4B8C60',
    haze: 'rgba(255,236,200,0.38)',
    bank: '#6BBE55',
    bankDark: '#4E9A3E',
    wall: '#C9C1B1',
    wallDark: '#9C9384',
    wallLight: '#DED7C9',
    waterTop: '#7FD6F7',
    water2: '#3AB3E6',
    water3: '#1F7FC6',
    waterBottom: '#0E4C92',
    rope: 'rgba(255,255,255,0.22)',
    buoyA: '#FF5A47',
    buoyB: '#FFFFFF',
    cloud: '#EEF4FB',
    cloudShade: '#D2E3F5',
    cloudLight: 'rgba(255,253,247,0.95)',
  },
};

export class RaceScene {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.theme = THEMES.day;
    this.dpr = 1;
    this.ui = 1; // resolution-aware scale for canvas text/boards (1 at 1440x900)
    this.W = 0;
    this.H = 0;
    this.insets = { left: 0, right: 0, top: 0, bottom: 0 };
    this.sim = null;
    this.looks = [];
    this.lanes = [];
    this.ropeYs = [];
    this.cam = { x: 0, ppu: 5, targetPpu: 5, vx: 0 };
    this.wall = 0; // wall-clock seconds, for ambient animation
    this.frameNo = 0;
    this._dt = 1 / 60;
    this.particles = [];
    this.projectiles = [];
    this.throwers = [];
    this.duckFx = [];
    this.cheer = 0;
    this.flash = 0;
    this.shakes = [];
    this._shakeLevel = 0;
    this._nativeShakeAt = -9;
    this.slowmo = 0;
    // quality flags, driven by setQualityTier() (main.js owns the frame-cadence governor)
    this.qualityTier = 0;
    this.quality = { reflections: true, particles: 1, flashes: true, rays: true, clock: true, glitter: true, rippleB: true, wakes: 'full', bounce: true, foam: true, simpleClip: false, confetti: 1, dprCap: 2 };
    this.frameMsAvg = 8; // metric only (scene JS time per render)
    this.tiles = null;
    this.clouds = [];
    const css = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
    this.displayFont = (css && css.getPropertyValue('--display').trim()) || 'ui-rounded, system-ui, sans-serif';
    this.uiFont = (css && css.getPropertyValue('--ui').trim()) || UI_FONT;
    this._textW = new Map();
    // web fonts arrive late: drop cached text widths so banners/pills re-measure with the real face
    if (typeof document !== 'undefined' && document.fonts?.addEventListener) document.fonts.addEventListener('loadingdone', () => this._textW.clear());
    // Reduced motion is honoured live: the OS/devtools media query can flip
    // mid-race, and the app's "calm mode" (setCalm) forces it on regardless.
    this.rmq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.forceCalm = false;
    this.reduceMotion = !!this.rmq?.matches;
    const onRmq = (e) => {
      this.reduceMotion = this.forceCalm || !!e.matches;
    };
    if (this.rmq?.addEventListener) this.rmq.addEventListener('change', onRmq);
    else this.rmq?.addListener?.(onRmq);
    // Director hooks written by main.js each race (playback-side only):
    //   introDur     seconds the 'intro' phase lasts (camera dolly budget)
    //   camMode      '' | 'stretch' | 'tail' — framing hint from the race director
    //   startLights  0 off, 1..3 red lights during the countdown, 4 = green/GO
    //   pendingHoldMs  set by the scene to request a wall-clock hold; main.js polls + clears it
    this.introDur = 2.2;
    this.camMode = '';
    this.startLights = 0;
    this.pendingHoldMs = 0;
    this.phaseTime = 0;
    this._lights = 0;
    this.intro = { begun: false, t: 0, dur: 2, x0: TRACK_LENGTH * 0.55, ppu0: 2 };
    // zoom channel (true scale about a screen point): base = held framing, punch = impact kick
    this.zoom = { base: 1, baseTarget: 1, baseV: 0, punch: 0, punchV: 0, bcx: 0, bcy: 0, pcx: 0, pcy: 0, holdUntil: 0 };
    this._zf = 1;
    // on-water identity (public knobs for batch C): labelMode 'smart' | 'all' | 'off', focusDuck index or -1
    this.labelMode = 'smart';
    this.focusDuck = -1;
    this.labelSide = [];
    this.labelTop = [];
    this.ranks = [];
    this.leaderIdx = -1;
    this._leadX = 0;
    this.leaderMark = newLeaderMark();
    this._heroDone = false;
    this._firstFinishSeen = false;
    this.sunX = 0;
    this.standsY = 0;
    this.standsPar = 0.38;
    // start/finish set pieces (all reset per race in setRace)
    this.tape = null; // finish tape: intact ribbon, then two verlet chains once the winner breaks it
    this.startRope = null; // pennant rope across the start; released on GO
    this.photo = null; // photo-finish still (offscreen copy of the frame the winner touched)
    this.strobe = 0; // vertical strobe band at the line on the first finish
    this._lightsWall = -9; // wall time the start lights last changed
    this._seedDecor(1234);
  }

  /**
   * Quality tiers (main.js steps these from real frame cadence):
   *  0 everything on; 1 half particles, no reflections/glitter/rays/crowd flashes/second ripple layer,
   *  flat wakes, no crowd bounce; 2 additionally DPR <= 1.25, rect water clip on ducks, no foam,
   *  half confetti, static clocks.
   */
  setQualityTier(tier) {
    const t = clamp(tier | 0, 0, 2);
    this.qualityTier = t;
    const q = this.quality;
    q.reflections = t < 1;
    q.glitter = t < 1;
    q.rays = t < 1;
    q.flashes = t < 1;
    q.rippleB = t < 1;
    q.wakes = t < 1 ? 'full' : 'flat';
    q.bounce = t < 1;
    q.foam = t < 2;
    q.simpleClip = t >= 2;
    q.confetti = t >= 2 ? 0.5 : 1;
    q.clock = t < 2;
    q.dprCap = t >= 2 ? 1.25 : 2;
    q.particles = this._baseParticles();
    if (this.W && ((t >= 2 && this.dpr > 1.25 + 1e-6) || (t < 2 && this.dpr < Math.min(2, window.devicePixelRatio || 1) - 1e-6))) this.resize();
  }

  _baseParticles() {
    return (this.qualityTier >= 1 ? 0.5 : 1) * (this.W && this.W < 500 ? 0.6 : 1);
  }

  /** Legacy shake knob (main.js sets `scene.shake = k`): maps onto the damped shake channel. */
  get shake() {
    return this._shakeLevel;
  }

  set shake(k) {
    k = Number(k) || 0;
    // the scene now shakes natively at GO / the win / hot dogs; a legacy set right after one is absorbed
    if (k > this._shakeLevel + 1e-6 && this.wall - this._nativeShakeAt > 0.25) {
      this.addShake(8 * k, 0.7071, 0.7071);
      const last = this.shakes[this.shakes.length - 1];
      if (last) last.legacy = this.wall;
    }
    this._shakeLevel = Math.max(0, k);
  }

  /** Scene-driven shake; supersedes a legacy `shake =` set in the same beat (before or after). */
  _shakeNative(A, dx, dy) {
    this._nativeShakeAt = this.wall;
    this.shakes = this.shakes.filter((sh) => !(sh.legacy !== undefined && this.wall - sh.legacy < 0.2));
    this.addShake(A, dx, dy);
  }

  /** Damped directional shake: offset = A·e^(−6τ)·sin(2π·18τ)·dir, summed, capped at 12 px. */
  addShake(A, dirX = 0.7071, dirY = 0.7071) {
    if (this.reduceMotion || !(A > 0)) return;
    this.shakes.push({ A, dx: dirX, dy: dirY, t: 0 });
    if (this.shakes.length > 6) this.shakes.shift();
    this._shakeLevel = Math.max(this._shakeLevel, A / 8);
  }

  /** App-level calm mode: forces reduced motion on regardless of the OS setting. */
  setCalm(on) {
    this.forceCalm = !!on;
    this.reduceMotion = this.forceCalm || !!this.rmq?.matches;
  }

  _seedDecor(seed) {
    const rng = createRng(seed);
    this.clouds = [];
    for (let i = 0; i < 9; i++) {
      const count = rng.int(4, 7);
      const puffs = [];
      const mid = (count - 1) / 2;
      const step = rng.range(13, 18);
      for (let j = 0; j < count; j++) {
        const d = Math.abs(j - mid) / Math.max(1, mid);
        puffs.push({ x: (j - mid) * step + rng.range(-3, 3), y: rng.range(-4, 5) - (1 - d) * rng.range(4, 11), r: rng.range(12, 24) * (1 - d * 0.45) });
      }
      this.clouds.push({ x: rng.range(0, 1), y: rng.range(0.05, 0.55), s: rng.range(0.6, 1.4), v: rng.range(0.004, 0.012), puffs });
    }
    this.decorRng = rng;
  }

  setInsets(insets) {
    this.insets = { ...this.insets, ...insets };
  }

  setLooks(looks) {
    this.looks = looks || [];
    const n = this.looks.length;
    this.duckFx = this.looks.map((_, i) => ({
      flap: 0,
      dizzy: 0,
      quack: 0,
      boostGlow: 0,
      lastFoam: 0,
      foamSide: 1,
      place: 0,
      spin: -1,
      stars: 0,
      pad: (i * 0.37) % 1,
      effVis: 0,
      vPrev: 0,
      tiltA: 0,
      sq: 0,
      sqV: 0,
      kick: 0,
      kickT: 0,
      kickDur: 1,
      sauce: 0,
      leadFlash: 0,
      celebrate: 0,
      lean: 0,
      lastEvent: -99,
      finishSeenAt: -99,
      ringT: (i / Math.max(1, n)) * 0.9,
      hx: 0,
      hy: 0,
      topY: 0,
      bx: 0,
      by: 0,
      sc: 1,
      visible: false,
    }));
    this.labelSide = this.looks.map(() => 0);
    this.labelTop = this.looks.map(() => 0);
    this.projectiles = [];
    this.throwers = [];
    this.leaderMark = newLeaderMark();
    this.ranks = this.looks.map((_, i) => i);
    this.leaderIdx = -1;
    this.startRope = null;
    this.layout();
  }

  setRace(sim, looks) {
    this.sim = sim;
    this.setLooks(looks);
    this.particles.length = 0;
    this.cheer = 0;
    this.flash = 0;
    this.shakes.length = 0;
    this._shakeLevel = 0;
    this.camMode = '';
    this._heroDone = false;
    this._firstFinishSeen = false;
    this.zoom.base = 1;
    this.zoom.baseTarget = 1;
    this.zoom.baseV = 0;
    this.zoom.punch = 0;
    this.zoom.punchV = 0;
    this.zoom.holdUntil = 0;
    this.tape = null;
    this.startRope = null;
    this.photo = null;
    this.strobe = 0;
    // an in-progress intro dolly is driven from update() while phase === 'intro',
    // so this snap never shows on screen during the intro (beginIntro restarts it)
    this.snapCamera(0);
  }

  resize() {
    const cssW = this.canvas.clientWidth || 800;
    const cssH = this.canvas.clientHeight || 500;
    this.ui = clamp(Math.min(cssW / 1440, cssH / 900), 0.85, 2.6);
    // pixel budget: never back more than ~9.5 MP (4K screens render at a lower ratio)
    this.dpr = Math.min(this.quality.dprCap || 2, 2, window.devicePixelRatio || 1, Math.sqrt(9.5e6 / (cssW * cssH)));
    this.W = cssW;
    this.H = cssH;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.quality.particles = this._baseParticles();
    this._ripKey = '';
    this.layout();
    try {
      this._buildTiles();
    } catch (err) {
      console.error('[duck-derby] venue tiles failed', err); // keep racing with whatever built
    }
  }

  /** Vertical layout of sky / water / lanes. */
  layout() {
    const { W, H } = this;
    if (!W || !H) return;
    const n = Math.max(1, this.looks.length || 8);
    let skyFrac = H < 450 ? 0.17 : H < 520 ? 0.24 : W < 500 && H > 700 ? 0.24 : 0.29;
    const place = (frac) => {
      this.skyH = Math.round(H * frac);
      this.waterTop = this.skyH;
      const minTop = this.waterTop + Math.max(18, (H - this.waterTop) * 0.07);
      const usableTop = Math.max(minTop, (this.insets.top || 0) + 8);
      const usableBottom = H - Math.max(10, (H - this.waterTop) * 0.04) - (this.insets.bottom || 0);
      return { usableTop, usableBottom, avail: usableBottom - usableTop };
    };
    let g = place(skyFrac);
    if (g.avail / n < 22 && skyFrac > 0.17) {
      skyFrac = 0.17; // short screens: shrink the sky (the HUD then overlays sky, not water)
      g = place(skyFrac);
    }
    const { usableTop, avail } = g;
    // perspective: lane height grows toward the viewer
    const sMin = avail / n < 22 ? 0.94 : n > 6 ? 0.74 : 0.86;
    let total = 0;
    const weights = [];
    for (let i = 0; i < n; i++) {
      const w = lerp(sMin, 1, n === 1 ? 1 : i / (n - 1));
      weights.push(w);
      total += w;
    }
    const maxScale = (W < 520 ? 1.25 : 1.7) * this.ui;
    this.lanes = [];
    let y = usableTop;
    for (let i = 0; i < n; i++) {
      const h = Math.max(4, (avail * weights[i]) / total);
      const persp = weights[i];
      // size by lane height AND track width so phones don't render 150 px ducks in a column
      const duckScale = clamp(Math.min(h / 40, Math.max(0.7, this.effectiveW() / 300)), 0.45, maxScale);
      this.lanes.push({ top: y, h, y: y + h * 0.62, persp, duckScale });
      y += h;
    }
    this.ropeYs = [usableTop, ...this.lanes.map((l) => l.top + l.h)];
    this.maxDuckScale = this.lanes.reduce((m, l) => Math.max(m, l.duckScale), 0.45);
  }

  effectiveW() {
    return Math.max(200, this.W - this.insets.left - this.insets.right);
  }

  ppuMax() {
    const we = this.effectiveW();
    return we < 500 ? clamp(we / 140, 3.4, 8.5) : clamp(we / 170, 3.2, 8.5 * this.ui);
  }

  ppuMin() {
    return this.effectiveW() / 340;
  }

  sx(x) {
    return this.insets.left + this.effectiveW() / 2 + (x - this.cam.x) * this.cam.ppu;
  }

  /** Inverse of sx(): world x for a screen x. */
  wxOf(screenX) {
    return this.cam.x + (screenX - this.insets.left - this.effectiveW() / 2) / this.cam.ppu;
  }

  /** Visual (possibly past-the-line) position of duck i at race time t. */
  duckX(i, t) {
    const sim = this.sim;
    if (!sim) return 0;
    const ft = sim.finishTimes[i];
    if (ft !== null && t > ft) {
      // coast past the line: each duck glides a different distance so finishers fan out instead of parking in a column
      const { tau, drift, vf } = this._coast(i, ft);
      const dtp = t - ft;
      return sim.trackLength + vf * tau * (1 - Math.exp(-dtp / tau)) + 2 * Math.min(dtp, drift);
    }
    return positionAt(sim, i, t);
  }

  _coast(i, ft) {
    const sim = this.sim;
    const look = this.looks[i] || {};
    const vf = Math.max(speedAt(sim, i, ft - 0.05), (sim.trackLength / sim.duration) * 0.8);
    const tau = 0.8 + 0.9 * ((look.bobPhase || 0) / TAU);
    const drift = 2 + 3 * (((look.blinkOffset || 0) / 5) % 1);
    return { tau, drift, vf };
  }

  duckV(i, t) {
    const sim = this.sim;
    if (!sim) return 0;
    const ft = sim.finishTimes[i];
    if (ft !== null && t > ft) {
      const { tau, drift, vf } = this._coast(i, ft);
      const dtp = t - ft;
      return vf * Math.exp(-dtp / tau) + (dtp < drift ? 2 : 0);
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
    const narrow = Weff < 500;
    const mode = this.camMode;
    let lead = 0;
    let tail = 0;
    this._leadX = 0;
    if (this.sim && n) {
      let xs = [];
      let leadAll = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = this.duckX(i, t);
        if (x > leadAll) leadAll = x;
        if (mode === 'tail') {
          const ft = this.sim.finishTimes[i];
          if (ft !== null && t >= ft) continue; // frame the unfinished
        }
        xs.push(x);
      }
      this._leadX = leadAll;
      if (!xs.length) for (let i = 0; i < n; i++) xs.push(this.duckX(i, t));
      xs.sort((a, b) => a - b);
      lead = xs[xs.length - 1];
      // ignore one hopeless straggler when framing (they get an edge marker)
      tail = xs.length > 4 ? lerp(xs[0], xs[1], 0.5) : xs[0];
      if (mode === 'stretch') tail = Math.max(tail, lead - 30); // only the fight at the front defines the zoom
    }
    const span = Math.max(lead - tail, 1);
    let ppu = (Weff * 0.56) / Math.max(span + 14, 48);
    ppu = clamp(ppu, this.ppuMin(), this.ppuMax());
    const anchor = mode === 'stretch' ? 0.64 : mode === 'tail' ? 0.62 : narrow ? 0.64 : 0.7;
    let x = lead - (anchor - 0.5) * (Weff / ppu);
    const minX = (0.5 - 0.3) * (Weff / ppu); // start line no further right than 30%
    const maxX = TRACK_LENGTH + (0.5 - 0.34) * (Weff / ppu); // finish line no further left than 34%
    x = clamp(x, minX, maxX);
    if (mode === 'tail') x = clamp(Math.max(x, TRACK_LENGTH - 0.32 * (Weff / ppu)), minX, maxX); // keep the line in view (<= 82%)
    return { x, ppu };
  }

  /** Start the intro dolly: hold mid-course, then sweep back to the start dock before "3". */
  beginIntro() {
    const it = this.intro;
    it.x0 = TRACK_LENGTH * 0.55;
    it.ppu0 = this.ppuMin();
    it.t = 0;
    it.begun = true;
    it.dur = Math.max(0.6, (this.introDur || 2.2) - 0.25 - (this.phaseTime || 0));
    if (this.reduceMotion) {
      it.dur = 0;
      this.snapCamera(0);
    } else {
      this.cam.x = it.x0;
      this.cam.ppu = it.ppu0;
    }
  }

  /** Impact kick on the zoom channel (amount ~0.02–0.1), centred on a screen point. */
  punch(amount, cx, cy) {
    if (this.reduceMotion || !(amount > 0)) return;
    const z = this.zoom;
    z.punchV += amount * 30;
    z.pcx = Number.isFinite(cx) ? cx : this.insets.left + this.effectiveW() / 2;
    z.pcy = Number.isFinite(cy) ? cy : (this.waterTop + this.H) / 2;
  }

  /** Held zoom toward a screen point; reverts to 1 after holdMs (if given). */
  zoomTo(zv, cx, cy, holdMs) {
    const z = this.zoom;
    z.baseTarget = clamp(Number(zv) || 1, 1, 2);
    z.reason = '';
    if (Number.isFinite(cx)) z.bcx = cx;
    else if (z.baseTarget > 1) z.bcx = this.insets.left + this.effectiveW() / 2;
    if (Number.isFinite(cy)) z.bcy = cy;
    else if (z.baseTarget > 1) z.bcy = (this.waterTop + this.H) / 2;
    z.holdUntil = holdMs > 0 ? this.wall + holdMs / 1000 : 0;
    if (this.reduceMotion) {
      z.base = z.baseTarget;
      z.baseV = 0;
    }
  }

  /** Zoom pivot y that keeps every lane on screen (the sky gets cropped instead). */
  _zoomFloorY() {
    const yb = this.ropeYs.length ? this.ropeYs[this.ropeYs.length - 1] : this.H;
    return Math.min(this.H, yb + 14);
  }

  _zoomState() {
    const z = this.zoom;
    const zf = Math.max(1, z.base + z.punch);
    const b = Math.max(0, z.base - 1);
    const p = Math.max(0, z.punch);
    const wsum = b + p;
    let cx = this.insets.left + this.effectiveW() / 2;
    let cy = (this.waterTop + this.H) / 2;
    if (wsum > 1e-5) {
      cx = (z.bcx * b + z.pcx * p) / wsum;
      cy = (z.bcy * b + z.pcy * p) / wsum;
    }
    return { zf, cx, cy };
  }

  /**
   * @param {number} dt wall-clock seconds since last frame
   * @param {number} t race clock (seconds)
   * @param {string} phase director phase
   * @param {number} [phaseTime] seconds spent in `phase` so far
   */
  update(dt, t, phase, phaseTime = 0) {
    this.wall += dt;
    this.frameNo++;
    this._dt = dt;
    this.phaseTime = phaseTime;
    const racing = phase === 'race' || phase === 'finish';
    const rm = this.reduceMotion;
    // a jump()/skip moved the race clock: snap anything that would otherwise animate from stale state
    this._cut = Math.abs(t - (this._lastT ?? t)) > 1;
    this._lastT = t;
    if (this._cut) {
      const lm = this.leaderMark;
      lm.flight = null;
      lm.toss = null;
      lm.holder = -1;
      const zz = this.zoom;
      zz.base = zz.baseTarget = 1;
      zz.baseV = zz.punch = zz.punchV = 0;
      zz.holdUntil = 0;
      zz.reason = '';
      this.shakes.length = 0;
      for (const fx of this.duckFx) {
        fx.vPrev = this.sim && racing ? this.duckV(this.duckFx.indexOf(fx), t) : 0;
        fx.tiltA = 0;
        fx.sq = 0;
        fx.sqV = 0;
        fx.kickT = 0;
      }
    }

    // ---- camera ----
    if (phase === 'intro' && !rm) {
      const it = this.intro;
      const tgt = this._cameraTarget(0);
      if (!it.begun) {
        // sim not here yet: hold the opening shot mid-course
        it.x0 = TRACK_LENGTH * 0.55;
        it.ppu0 = this.ppuMin();
        this.cam.x = it.x0;
        this.cam.ppu = it.ppu0;
      } else {
        it.t += dt;
        const p = it.dur > 0 ? easeInOutCubic(clamp(it.t / it.dur, 0, 1)) : 1;
        this.cam.x = lerp(it.x0, tgt.x, p);
        this.cam.ppu = lerp(it.ppu0, tgt.ppu, p);
      }
      this.cam.vx = 0;
      this.cam.targetPpu = tgt.ppu;
    } else {
      if (phase !== 'intro') this.intro.begun = false;
      const target = this._cameraTarget(t);
      let k = rm ? 10 : phase === 'race' ? 3.2 : 2.0;
      if (racing && !rm && this._leadX > TRACK_LENGTH * 0.85) k = 4.5; // no lag at the line
      if (Math.abs(target.x - this.cam.x) * this.cam.ppu > 1.5 * this.W) {
        this.cam.x = target.x; // a jump()/skip moved the race: cut, don't pan
        this.cam.ppu = target.ppu;
      }
      const a = 1 - Math.exp(-dt * k);
      const prevX = this.cam.x;
      const pr = this.camMode === 'stretch' ? 2.2 : 1.3;
      this.cam.ppu = lerp(this.cam.ppu, target.ppu, 1 - Math.exp(-dt * (rm ? 10 : pr)));
      this.cam.x = lerp(this.cam.x, target.x, a);
      this.cam.vx = dt > 0 ? (this.cam.x - prevX) / dt : 0;
      this.cam.targetPpu = target.ppu;
    }

    // ---- start lights -> countdown push-in / GO kick ----
    if (this.startLights !== this._lights) {
      const L = this.startLights;
      const prevL = this._lights;
      this._lights = L;
      this._lightsWall = this.wall;
      if (L >= 1 && L <= 3) {
        if (phase === 'countdown') {
          // anchor at the bottom rope so the push-in crops sky, never lanes
          this.zoomTo(1 + (L - 1) * 0.04, this.sx(0) + 60 * this.ui, this._zoomFloorY(), 0);
          this.zoom.reason = 'lights';
        }
      } else if (L === 4) {
        this.zoomTo(1);
        this._shakeNative(6, 1, 0);
        this._releaseStartRope();
        if (prevL === 3) {
          // GO: uncoil — squash overshoots into a stretch, foam kicks up behind everyone
          for (let i = 0; i < this.duckFx.length; i++) {
            const fx = this.duckFx[i];
            if (!fx) continue;
            if (!rm) {
              this._kick(fx, 0.7, 0.35);
              fx.sqV += 5;
            }
            if (this.quality.particles > 0) {
              const nf = Math.round(8 * this.quality.particles);
              for (let k = 0; k < nf; k++) this._spawnFoam(i, 0, 0);
              this._spawnRing(i, 0, 0.8);
            }
          }
        }
      } else if (L === 0 && this.zoom.baseTarget > 1 && !this.zoom.holdUntil) {
        this.zoomTo(1);
      }
    }

    // ---- zoom springs ----
    const z = this.zoom;
    if (z.reason === 'lights' && phase !== 'countdown' && z.baseTarget > 1) this.zoomTo(1); // countdown skipped/jumped
    if (z.holdUntil && this.wall >= z.holdUntil) {
      z.holdUntil = 0;
      z.baseTarget = 1;
    }
    if (rm) {
      z.base = z.baseTarget;
      z.baseV = 0;
      z.punch = 0;
      z.punchV = 0;
    } else {
      const sdt = Math.min(dt, 1 / 30);
      z.baseV += (60 * (z.baseTarget - z.base) - 15.5 * z.baseV) * sdt; // critically damped, ~0.8 s settle
      z.base += z.baseV * sdt;
      z.punchV += (-200 * z.punch - 18 * z.punchV) * sdt;
      z.punch += z.punchV * sdt;
      if (Math.abs(z.punch) < 1e-4 && Math.abs(z.punchV) < 1e-3) z.punch = z.punchV = 0;
    }

    // ---- shakes ----
    for (let s = this.shakes.length - 1; s >= 0; s--) {
      const sh = this.shakes[s];
      sh.t += dt;
      if (sh.A * Math.exp(-6 * sh.t) < 0.12) this.shakes.splice(s, 1);
    }
    this._shakeLevel = Math.max(0, this._shakeLevel - dt * 3);

    this.cheer = Math.max(0, this.cheer - dt * 0.35);
    this.flash = Math.max(0, this.flash - dt * 2.5);

    // ---- ranks (display order) ----
    this._computeRanks(t, phase);

    // ---- per-duck fx ----
    if (this.looks.length) {
      const v0 = this.sim ? TRACK_LENGTH / this.sim.duration : 26;
      const idle = !this.sim || !racing;
      for (let i = 0; i < this.looks.length; i++) {
        const fx = this.duckFx[i];
        if (!fx) continue;
        fx.flap = Math.max(0, fx.flap - dt * 0.7);
        fx.dizzy = Math.max(0, fx.dizzy - dt * 0.9);
        fx.quack = Math.max(0, fx.quack - dt * 3.5);
        fx.boostGlow = Math.max(0, fx.boostGlow - dt * 1.2);
        fx.stars = Math.max(0, fx.stars - dt * 0.45);
        fx.leadFlash = Math.max(0, fx.leadFlash - dt * 1.2);
        fx.sauce = Math.max(0, fx.sauce - dt * 0.3);
        fx.celebrate = Math.max(0, fx.celebrate - dt);
        // countdown body language: rock back on "2", coil on "1", relax otherwise (eased ~120 ms)
        const Lc = phase === 'countdown' ? this.startLights : 0;
        const leanT = rm ? 0 : Lc === 2 ? 0.06 : Lc === 3 ? 0.075 : 0;
        fx.lean += (leanT - fx.lean) * (1 - Math.exp(-dt / 0.12));
        if (fx.kickT > 0) fx.kickT = Math.max(0, fx.kickT - dt);
        if (fx.spin >= 0) {
          fx.spin += dt / 0.95;
          if (fx.spin >= 1) fx.spin = -1;
        }
        if (!idle) {
          const v = this.duckV(i, t);
          fx.effVis = clamp((v / v0 - 0.7) / 0.55, 0, 1.35);
          fx.pad += (1.4 + 1.8 * fx.effVis) * dt;
          const aN = dt > 1e-4 ? clamp((v - fx.vPrev) / dt / (0.5 * v0), -1, 1) : 0;
          fx.tiltA += (aN - fx.tiltA) * (1 - Math.exp(-8 * dt));
          fx.vPrev = v;
          const kick = fx.kickT > 0 ? fx.kick * (fx.kickT / fx.kickDur) : 0;
          const sqTarget = 0.35 * fx.tiltA + kick;
          fx.sqV += (120 * (sqTarget - fx.sq) - 14 * fx.sqV) * dt;
          fx.sq += fx.sqV * dt;
          fx.sq = clamp(fx.sq, -1, 1);
          // foam trail: two lines astern, thinner for the back of the field
          const rank = this.ranks[i] ?? i;
          const rate = this.quality.foam ? (v / v0) * 11 * this.quality.particles * (rank < 3 ? 1 : 0.55) : 0;
          fx.lastFoam += dt * rate;
          while (fx.lastFoam >= 1) {
            fx.lastFoam -= 1;
            this._spawnFoam(i, t, v);
          }
        } else {
          fx.effVis = 0;
          fx.pad += 0.45 * dt;
          fx.vPrev = 0;
          fx.tiltA *= Math.exp(-4 * dt);
          // crouch spring: the same squash channel the race uses, aimed at the countdown pose
          const crouch = rm ? 0 : Lc === 2 ? -0.35 : Lc === 3 ? -0.55 : 0;
          const kick = fx.kickT > 0 ? fx.kick * (fx.kickT / fx.kickDur) : 0;
          fx.sqV += (120 * (crouch + kick - fx.sq) - 14 * fx.sqV) * dt;
          fx.sq = clamp(fx.sq + fx.sqV * dt, -1, 1);
          if (Math.abs(fx.sq) < 1e-4 && Math.abs(fx.sqV) < 1e-3) fx.sq = fx.sqV = 0;
          // idle rings under the waiting ducks
          if (phase === 'setup' || phase === 'intro' || phase === 'countdown') {
            fx.ringT += dt;
            if (fx.ringT >= 0.9) {
              fx.ringT -= 0.9;
              if (!rm) this._spawnRing(i, 0, 0.75);
            }
          }
        }
      }
    }

    // ---- leader crown hand-off ----
    this._updateLeaderMark(dt, t, racing);

    // ---- throwers past their exit ----
    for (let k = this.throwers.length - 1; k >= 0; k--) {
      const th = this.throwers[k];
      if (t > th.tHit + 0.8 || t < th.t0 - 0.5) this.throwers.splice(k, 1);
    }

    // ---- projectiles: condiment drips in flight; stale ones removed ----
    for (let p = this.projectiles.length - 1; p >= 0; p--) {
      const pr = this.projectiles[p];
      if (t > pr.tHit + 0.05 || t < pr.t0 - 0.5) {
        this.projectiles.splice(p, 1);
        continue;
      }
      pr.dropT = (pr.dropT || 0) + dt;
      if (pr.dropT >= 0.08 && this.quality.particles > 0) {
        pr.dropT = 0;
        const pos = this._projectilePos(pr, t);
        const lane = this.lanes[pr.duck];
        if (pos && lane) {
          this._pushParticle({ kind: 'drop', wx: this.wxOf(pos.x), lane: pr.duck, ox: 0, oy: pos.y - lane.y, vx: -20 + Math.random() * 40, vy: 20 + Math.random() * 40, r: 1.6 + Math.random() * 1.2, color: '#F5C400', age: 0, life: 0.45 });
        }
      }
    }

    // ---- finish tape / start rope / photo still ----
    this.strobe = Math.max(0, this.strobe - dt / 0.12);
    if (this.tape) {
      const tp = this.tape;
      if (!tp.snapped && this.sim && this._leadX >= TRACK_LENGTH) this._snapTape();
      if (tp.snapped) {
        tp.t += dt;
        if (tp.t > 1.8) this.tape = null;
        else for (const ch of tp.chains) stepChain(ch, dt, 320, 0.985);
      }
    }
    if (this.startRope && this.startRope.released) {
      const rp = this.startRope;
      rp.t += dt;
      if (rp.t > 0.85) this.startRope = null;
      else {
        rp.chain.t = rp.t;
        stepChain(rp.chain, dt, 900, 0.97);
        // each knot splashes once as it lands on its lane's water
        const pts = rp.chain.pts;
        for (let k = 0; k < pts.length; k++) {
          const hit = rp.hits[k];
          if (hit.done || !pts[k].wet) continue;
          hit.done = true;
          if (hit.lane >= 0 && this.quality.particles > 0) this.splashAt(this.wxOf(this.sx(0) + pts[k].ox), hit.lane, 2, false, null, -3, 6);
        }
      }
    }
    if (this.photo && this.wall - this.photo.t0 > this.photo.dur) this.photo = null;

    // ---- particles ----
    const g = 520;
    const arr = this.particles;
    for (let p = arr.length - 1; p >= 0; p--) {
      const q = arr[p];
      q.age += dt;
      if (q.age >= q.life) {
        arr[p] = arr[arr.length - 1];
        arr.pop();
        continue;
      }
      q.ox += q.vx * dt;
      q.oy += q.vy * dt;
      if (q.kind === 'drop') q.vy += g * dt;
      else if (q.kind === 'confetti') {
        const drag = 1 - dt * (q.drag || 0.8);
        q.vx *= drag;
        if (q.vy < 0) q.vy *= drag; // air drag eats the launch, gravity brings it back into frame
        q.vy = Math.min(q.vy + (q.g || 160) * dt, q.streamer ? 140 : 190); // flutter caps the fall speed
        q.rot += q.vr * dt;
      } else if (q.kind === 'sparkle') {
        q.vx *= 1 - dt * 2;
        q.vy *= 1 - dt * 2;
      } else if (q.kind === 'hotdogDebris') {
        this._updateDebris(q, dt, t);
      }
    }
  }

  _updateDebris(q, dt, t) {
    const lane = this.lanes[q.lane];
    const scale = lane ? lane.duckScale : 1;
    if (q.state === 'fly') {
      q.vy += 520 * dt;
      q.rot += q.vr * dt;
      if (q.oy >= 8 * scale && q.vy > 0) {
        q.state = 'float';
        q.oy = 8 * scale;
        q.vx = 0;
        q.vy = 0;
        q.floatT = 0;
        q.rot = ((q.rot % TAU) + TAU) % TAU;
        this.splashAt(q.wx + q.ox / this.cam.ppu, q.lane, 6);
        this._spawnRing(q.lane, 0, 0.9, q.wx + q.ox / this.cam.ppu);
      }
    } else {
      q.floatT += dt;
      q.wx -= (20 / Math.max(1, this.cam.ppu)) * dt; // drifts back in world space
      q.rot = lerp(q.rot, Math.round(q.rot / Math.PI) * Math.PI, 1 - Math.exp(-dt * 5));
      if (q.floatT > 2) {
        q.state = 'sink';
        const s = (q.floatT - 2) / 0.6;
        q.sinkA = 1 - s;
        q.oy = 8 * scale + 8 * s;
        if (s >= 1) q.age = q.life; // done
      }
    }
    void t;
  }

  _computeRanks(t, phase) {
    const n = this.looks.length;
    if (!n) {
      this.ranks = [];
      this.leaderIdx = -1;
      return;
    }
    if (!this.sim || phase === 'setup' || phase === 'intro' || phase === 'countdown') {
      this.ranks = this.looks.map((_, i) => i);
      this.leaderIdx = -1;
      return;
    }
    const sim = this.sim;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const ft = sim.finishTimes[i];
      const done = ft !== null && t >= ft;
      rows.push({ i, done, ft, x: done ? Infinity : this.duckX(i, t) });
    }
    rows.sort((a, b) => {
      if (a.done && b.done) return a.ft - b.ft;
      if (a.done !== b.done) return a.done ? -1 : 1;
      return b.x - a.x || a.i - b.i;
    });
    const ranks = new Array(n);
    rows.forEach((r, k) => {
      ranks[r.i] = k;
    });
    this.ranks = ranks;
    this.leaderIdx = t > 0.05 ? rows[0].i : -1;
  }

  _updateLeaderMark(dt, t, racing) {
    const lm = this.leaderMark;
    const rm = this.reduceMotion;
    if (!racing || !this.sim || this.leaderIdx < 0) {
      lm.holder = -1;
      lm.flight = null;
      lm.toss = null;
      return;
    }
    lm.popT += dt;
    // who should hold it? follow the display leader with a little hysteresis
    let want = this.leaderIdx;
    if (lm.holder >= 0 && want !== lm.holder && lm.holder < this.looks.length) {
      const sim = this.sim;
      const hf = sim.finishTimes[lm.holder];
      const holderDone = hf !== null && t >= hf;
      const wf = sim.finishTimes[want];
      const wantDone = wf !== null && t >= wf;
      if (!holderDone && !wantDone) {
        const dx = this.duckX(want, t) - this.duckX(lm.holder, t);
        if (dx < 0.004 * TRACK_LENGTH && lm.pendingFrom !== want) want = lm.holder;
      }
    }
    lm.pendingFrom = -1;
    if (lm.toss) {
      const ts = lm.toss;
      ts.t += dt;
      ts.vy += 600 * dt;
      ts.y += ts.vy * dt;
      ts.rot += 12 * dt;
      if (ts.t >= 0.6) {
        // fly from the tossed position to whoever leads now
        lm.toss = null;
        this._startCrownFlight(want, ts.x, ts.y);
        lm.holder = want;
      }
      return;
    }
    if (lm.holder < 0) {
      lm.holder = want;
      lm.flight = null;
      return;
    }
    if (want !== lm.holder) {
      if (rm) {
        lm.holder = want;
        lm.flight = null;
      } else if (lm.flight && this.wall - lm.flight.start < 0.35) {
        lm.flight.to = want; // coalesce rapid swaps: retarget the flight
        lm.holder = want;
      } else {
        const from = this._crownRestPos(lm.holder) || { x: lm.x, y: lm.y };
        const cur = lm.flight ? { x: lm.x, y: lm.y } : from;
        this._startCrownFlight(want, cur.x, cur.y);
        lm.holder = want;
      }
    }
    if (lm.flight) {
      const f = lm.flight;
      const p = clamp((this.wall - f.start) / f.dur, 0, 1);
      f.p = p;
      if (p >= 1) {
        lm.flight = null;
        lm.popT = 0;
        const fx = this.duckFx[lm.holder];
        if (fx) fx.leadFlash = 1;
        const at = this._crownRestPos(lm.holder);
        if (at) this._sparkles(at.x, at.y, 8);
      }
    }
  }

  _startCrownFlight(to, fromX, fromY) {
    const lm = this.leaderMark;
    lm.flight = { from: { x: fromX, y: fromY }, to, start: this.wall, dur: 0.45, p: 0 };
  }

  /** Screen position where the crown rests above duck i's headgear (from last frame's pose). */
  _crownRestPos(i) {
    const fx = this.duckFx[i];
    const lane = this.lanes[i];
    if (!fx || !lane) return null;
    return { x: fx.hx, y: fx.topY - 5 * lane.duckScale }; // sits right on the headgear so it reads as this duck's
  }

  _sparkles(x, y, count) {
    if (this.reduceMotion) return;
    for (let k = 0; k < count; k++) {
      const a = (k / count) * TAU + Math.random() * 0.5;
      const sp = 60 + Math.random() * 60;
      this._pushParticle({ kind: 'sparkle', lane: -2, ax: x, ay: y, ox: 0, oy: 0, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: 2.5 + Math.random() * 2, age: 0, life: 0.4, color: k % 2 ? '#FFFFFF' : '#FFE066' });
    }
  }

  _pushParticle(p) {
    const arr = this.particles;
    if (arr.length >= MAX_PARTICLES) {
      // full: overwrite the oldest
      let oldest = 0;
      let bestAge = -1;
      for (let k = 0; k < arr.length; k += 7) {
        const f = arr[k].age / arr[k].life;
        if (f > bestAge) {
          bestAge = f;
          oldest = k;
        }
      }
      arr[oldest] = p;
    } else arr.push(p);
  }

  _spawnFoam(i, t, v) {
    const lane = this.lanes[i];
    if (!lane) return;
    const fx = this.duckFx[i];
    const x = this.duckX(i, t) - ((NOSE + 26) * lane.duckScale) / this.cam.ppu;
    const spread = 3.2 * lane.duckScale;
    fx.foamSide = -fx.foamSide;
    this._pushParticle({
      kind: 'foam',
      wx: x,
      lane: i,
      ox: (Math.random() - 0.5) * 4,
      oy: 8 * lane.duckScale + fx.foamSide * spread + (Math.random() - 0.5) * 1.2,
      vx: -4 - Math.random() * 6,
      vy: fx.foamSide * (0.5 + Math.random()),
      r: Math.min(2.4, (1.1 + Math.random() * 1.3) * lane.duckScale),
      age: 0,
      life: 0.5 + Math.random() * 0.5,
    });
    void v;
  }

  _spawnRing(i, t, life = 0.7, wx = null) {
    const lane = this.lanes[i];
    if (!lane || this.quality.particles <= 0) return;
    this._pushParticle({ kind: 'ring', wx: wx ?? this.duckX(i, t) - (NOSE * lane.duckScale) / this.cam.ppu, lane: i, ox: 0, oy: 9 * lane.duckScale, vx: 0, vy: 0, scale: lane.duckScale, age: 0, life });
  }

  _kick(fx, amount, dur) {
    fx.kick = amount;
    fx.kickT = dur;
    fx.kickDur = dur;
  }

  /** Trigger effects for a sim event. */
  onEvent(ev, t) {
    const fx = this.duckFx[ev.duck];
    if (!fx) return;
    const lane = this.lanes[ev.duck];
    const scale = lane ? lane.duckScale : 1;
    const rm = this.reduceMotion;
    if (t - ev.t > 0.75) {
      // replayed by a time jump (testing hook / skip): keep lasting state, skip the theatrics
      if (ev.type === 'finish') {
        if (fx.place === 0) fx.place = 1;
        this._firstFinishSeen = true;
        this._heroDone = true;
      } else if (ev.type === 'hotdog') fx.sauce = Math.max(fx.sauce, 1 - 0.3 * (t - ev.t));
      else if (ev.type === 'stretch') this.camMode = 'stretch';
      return;
    }
    if (ev.type === 'burst') {
      fx.flap = 1;
      fx.boostGlow = 1;
      fx.quack = 1;
      fx.lastEvent = this.wall;
      this._kick(fx, 0.5, 0.25);
      this.splash(ev.duck, t, 14);
    } else if (ev.type === 'stumble') {
      fx.dizzy = 1;
      fx.lastEvent = this.wall;
      this._kick(fx, -0.6, 0.12);
      this.splash(ev.duck, t, 8, true);
      this._spawnRing(ev.duck, t);
    } else if (ev.type === 'lead') {
      this.cheer = Math.min(1, this.cheer + 0.5);
      fx.quack = 1;
      fx.lastEvent = this.wall;
      this.leaderMark.pendingFrom = ev.duck; // bypass hysteresis: the sim called it
    } else if (ev.type === 'finish') {
      this.cheer = 1;
      const first = !this._firstFinishSeen;
      if (fx.place === 0) fx.place = first ? 1 : 2;
      fx.finishSeenAt = t;
      this._spawnRing(ev.duck, t, 0.8);
      // place from the sim's finish order (events arrive in order, but be exact)
      const place = this.sim ? this.sim.order.indexOf(ev.duck) + 1 : first ? 1 : 4;
      if (!rm) {
        if (place === 1) this._cannons(120);
        else if (place <= 3) this._cannons(30);
        else {
          // everyone else: a puff of foam at the line
          const nf = Math.round(8 * this.quality.particles);
          for (let k = 0; k < nf; k++) this._spawnFoam(ev.duck, t, 0);
        }
      }
      if (first) {
        this._firstFinishSeen = true;
        this._shakeNative(8, 0.7071, 0.7071);
        fx.celebrate = 2.5;
        this.strobe = rm ? 0 : 1;
        // photo-finish still: freeze the frame the winner touched in, hold the race clock while it shows
        const margin = this.sim ? this.sim.margin : Infinity;
        if (!rm && margin < 0.6 && this.W) this._capturePhoto(ev.duck);
        else this.pendingHoldMs = Math.max(this.pendingHoldMs, 90);
        // hero framing on a clear winner (skip for photo finishes: the pack tells that story)
        if (!this._heroDone && this.sim) {
          this._heroDone = true;
          const fts = this.sim.finishTimes;
          const me = fts[ev.duck];
          const close = fts.some((f, j) => j !== ev.duck && f !== null && Math.abs(f - me) < 0.25);
          if (!close && !rm && lane) this.zoomTo(1.22, this.sx(TRACK_LENGTH) - 40 * this.ui, this._zoomFloorY(), 1400);
        }
      }
    } else if (ev.type === 'stretch') {
      this.cheer = Math.min(1, this.cheer + 0.7);
      this.camMode = 'stretch';
    } else if (ev.type === 'hotdog') {
      fx.lastEvent = this.wall;
      this._kick(fx, 0.8, 0.2);
      fx.spin = 0; // starts the hop + flip
      fx.stars = 1;
      fx.dizzy = 0.34; // wobble but keep normal eyes until stars fade
      fx.sauce = 1;
      this.splash(ev.duck, t, 16, false, '#F5C400');
      this.splash(ev.duck, t, 10, true, '#D7263D');
      this._spawnRing(ev.duck, t, 0.8);
      this._shakeNative(9, 0, 1);
      this.cheer = Math.min(1, this.cheer + 0.6);
      if (lane) {
        const wx = this.duckX(ev.duck, t);
        // starburst + BONK! at the head
        this._pushParticle({ kind: 'starburst', wx, lane: ev.duck, ox: (-NOSE + 17) * scale, oy: -22 * scale, vx: 0, vy: 0, scale, age: 0, life: 0.2 });
        if (!rm) this._pushParticle({ kind: 'text', text: 'BONK!', wx, lane: ev.duck, ox: (-NOSE + 6) * scale, oy: -58 * scale - (HAT_HEIGHT[this.looks[ev.duck]?.hat] || 0) * 0.5 * scale, vx: 0, vy: 0, size: 30 * scale, age: 0, life: 0.9 });
        // ricochet: the frank bounces off and floats behind the pack
        let px = null;
        for (let p = this.projectiles.length - 1; p >= 0; p--) {
          const pr = this.projectiles[p];
          if (pr.duck !== ev.duck) continue;
          px = this._projectilePos(pr, Math.min(t, pr.tHit)) || null;
          this.projectiles.splice(p, 1);
        }
        const hx = px ? px.x : this.sx(wx) - (NOSE - 16) * scale;
        const hy = px ? px.y : lane.y - 20 * scale;
        this._pushParticle({ kind: 'hotdogDebris', wx: this.wxOf(hx), lane: ev.duck, ox: 0, oy: hy - lane.y, vx: rm ? -60 : -140, vy: rm ? -60 : -280, rot: this.wall * 14, vr: rm ? 4 : 22, state: 'fly', floatT: 0, sinkA: 1, scale, age: 0, life: 8 });
      }
      // crown: knocked off the leader, lands on whoever leads 600 ms later
      const lm = this.leaderMark;
      if (lm.holder === ev.duck && !rm) {
        const at = this._crownRestPos(ev.duck) || { x: this.sx(this.duckX(ev.duck, t)), y: lane ? lane.y - 40 * scale : this.H / 2 };
        lm.toss = { t: 0, x: at.x, y: at.y, vy: -220, rot: 0 };
        lm.flight = null;
      }
    }
  }

  splash(i, t, count = 12, back = false, color = null) {
    const lane = this.lanes[i];
    if (!lane) return;
    this.splashAt(this.duckX(i, t), i, count, back, color, (-NOSE - 20) * lane.duckScale, 30 * lane.duckScale);
  }

  /** Splash at world x `wx` on lane i (ox0/oxSpan in screen px relative to wx). */
  splashAt(wx, i, count = 12, back = false, color = null, ox0 = -12, oxSpan = 24) {
    const lane = this.lanes[i];
    if (!lane) return;
    const n = Math.round(count * this.quality.particles);
    for (let k = 0; k < n; k++) {
      const a = back ? Math.PI * (1.05 + Math.random() * 0.4) : Math.PI * (1.1 + Math.random() * 0.8);
      const sp = (90 + Math.random() * 160) * lane.duckScale;
      this._pushParticle({
        kind: 'drop',
        wx,
        lane: i,
        ox: ox0 + Math.random() * oxSpan,
        oy: 6 * lane.duckScale,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 60,
        r: Math.min(3, (1.1 + Math.random() * 1.6) * lane.duckScale * (color ? 1.15 : 1)),
        color,
        age: 0,
        life: 0.5 + Math.random() * 0.4,
      });
    }
  }

  /** Director beat 1.5 s before impact: a fan stands up in the crowd and a reticle locks on. */
  telegraphHotdog(i, tNow, tHit) {
    const lane = this.lanes[i];
    if (!lane) return;
    const victimX = this.sx(this.duckX(i, tNow)) - (NOSE - 10) * lane.duckScale;
    const screenX0 = clamp(victimX + 220 * this.ui, this.insets.left + 40, this.W - this.insets.right - 40);
    const u = screenX0 + this.cam.x * this.cam.ppu * this.standsPar; // stands-layer offset: scrolls with the crowd
    const h = ((i * 7919 + Math.floor(tHit * 10) * 104729) >>> 0) % 8;
    this.throwers = this.throwers.filter((th) => th.duck !== i || Math.abs(th.tHit - tHit) > 0.01);
    this.throwers.push({ duck: i, t0: tNow, tHit, u, color: CROWD_COLS[h === 3 ? 0 : h], skin: SKINS[h % SKINS.length] });
  }

  /** Visual-only: lob a hot dog from the stands so it lands on duck i at race time tHit. */
  launchHotdog(i, tNow, tHit) {
    const th = this.throwers.find((x) => x.duck === i && Math.abs(x.tHit - tHit) < 0.05) || null;
    this.projectiles.push({ duck: i, t0: tNow, tHit, thrower: th, dropT: 0 });
  }

  /**
   * Two confetti cannons on the gantry's corners firing an outward V of paper + streamers. The
   * gantry sits near the top of the frame (and the hero zoom crops the sky), so the cannons fire
   * flat-ish: the plume fans out over the top lanes and flutters down through the field at the line.
   */
  _cannons(count) {
    const n = Math.round(count * this.quality.particles * this.quality.confetti);
    if (n <= 0) return;
    const g = this._gantryGeom();
    for (let k = 0; k < n; k++) {
      const left = k % 2 === 0;
      const deg = (left ? -150 : -30) + (Math.random() - 0.5) * 34;
      const a = (deg * Math.PI) / 180;
      const sp = 300 + Math.random() * 300;
      this._pushParticle({
        kind: 'confetti',
        wx: TRACK_LENGTH,
        lane: -1,
        absY: g.top + g.h - 4,
        ox: (left ? -1 : 1) * (g.w / 2 - 4) + (Math.random() - 0.5) * 8,
        oy: (Math.random() - 0.5) * 10,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        g: 260,
        drag: 1.4,
        streamer: Math.random() < 0.3,
        seed: Math.random() * TAU,
        r: 3 + Math.random() * 3,
        rot: Math.random() * TAU,
        vr: (Math.random() - 0.5) * 14,
        color: CONFETTI_COLS[k % CONFETTI_COLS.length],
        age: 0,
        life: 2.4 + Math.random(),
        big: true,
      });
    }
  }

  /** Copy the frame the winner touched in; render() shows it as a grayscale photo for 650 ms of wall time. */
  _capturePhoto(winner) {
    try {
      const c = document.createElement('canvas');
      c.width = this.canvas.width;
      c.height = this.canvas.height;
      c.getContext('2d').drawImage(this.canvas, 0, 0);
      const ft = this.sim ? this.sim.finishTimes[winner] : 0;
      const label = this.sim && this.sim.photoFinish ? 'PHOTO FINISH' : 'AT THE LINE';
      this.photo = { c, t0: this.wall, dur: 0.65, label, lineX: this.sx(TRACK_LENGTH), midY: (this.ropeYs[0] + this.ropeYs[this.ropeYs.length - 1]) / 2, time: ft || 0, zf: this._zf, zc: this._zc };
      this.pendingHoldMs = Math.max(this.pendingHoldMs, 650);
    } catch {
      this.photo = null; // tainted/unsupported canvas: just carry on live
      this.pendingHoldMs = Math.max(this.pendingHoldMs, 90);
    }
  }

  /** The intact tape becomes two 8-segment chains anchored top and bottom, free ends kicked downstream. */
  _snapTape() {
    const tp = this.tape;
    if (!tp || tp.snapped) return;
    const top = this.ropeYs[0];
    const bottom = this.ropeYs[this.ropeYs.length - 1];
    const mid = (top + bottom) / 2;
    const mk = (y0, y1, vyEnd, floor) => {
      const N = 8;
      const pts = [];
      for (let k = 0; k <= N; k++) {
        const y = lerp(y0, y1, k / N);
        const f = k / N; // 0 at the anchor, 1 at the free end
        const p = { ox: 0, y, pox: -180 * f * (1 / 60), py: y - vyEnd * f * (1 / 60) };
        if (floor !== undefined) p.floor = floor;
        pts.push(p);
      }
      return { pts, seg: Math.abs(y1 - y0) / N, anchored: true };
    };
    tp.snapped = true;
    tp.t = 0;
    // top half whips from the far post; the near half drops onto the water by the pylon and slides downstream
    tp.chains = this.reduceMotion ? [] : [mk(top, mid, -60), mk(bottom, mid, 60, bottom + 3)];
  }

  /** GO: the start rope is let go — every knot drops onto its own lane's water with a little splash, gone in 0.8 s. */
  _releaseStartRope() {
    const rp = this.startRope;
    if (!rp || rp.released) return;
    rp.released = true;
    rp.t = 0;
    if (this.reduceMotion) {
      this.startRope = null;
      return;
    }
    const top = this.ropeYs[0];
    const bottom = this.ropeYs[this.ropeYs.length - 1];
    const N = 10;
    const pts = [];
    const hits = [];
    for (let k = 0; k <= N; k++) {
      const u = k / N; // 0 = top knot (released first, shoved hardest), 1 = bottom
      const y = lerp(top, bottom, u);
      let lane = -1;
      for (let i = 0; i < this.lanes.length; i++) {
        const l = this.lanes[i];
        if (y >= l.top - 0.5 && y < l.top + l.h) lane = i;
      }
      if (lane < 0) lane = this.lanes.length - 1;
      const floor = this.lanes[lane] ? this.lanes[lane].y + 5 : y + 20;
      const vx = 70 + 190 * (1 - u) + (hash01(k * 31 + 7) - 0.5) * 40; // px/s downstream, hardest at the loose top end
      const vy = 40 + 80 * (1 - u); // and a downward flick so it is visibly falling within 150 ms
      const delay = 0.06 * u; // the release ripples down the line
      pts.push({ ox: 0, y, pox: -vx / 60, py: y - vy / 60, floor, delay, wet: false });
      hits.push({ lane, done: false });
    }
    rp.chain = { pts, seg: (bottom - top) / N, anchored: false, t: 0 };
    rp.hits = hits;
  }

  confettiBurst(wx, y, count = 40) {
    const n = Math.round(count * this.quality.particles * this.quality.confetti);
    for (let k = 0; k < n; k++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const sp = 220 + Math.random() * 320;
      this._pushParticle({
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
        color: CONFETTI_COLS[k % CONFETTI_COLS.length],
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
    let ox = 0;
    let oy = 0;
    if (!this.reduceMotion) {
      for (const sh of this.shakes) {
        const v = sh.A * Math.exp(-6 * sh.t) * Math.sin(TAU * 18 * sh.t);
        ox += v * sh.dx;
        oy += v * sh.dy;
      }
      const m = Math.hypot(ox, oy);
      if (m > 12) {
        ox *= 12 / m;
        oy *= 12 / m;
      }
    }
    const zs = this._zoomState();
    this._zf = zs.zf;
    this._zc = zs;
    ctx.save();
    ctx.translate(ox, oy);
    if (zs.zf > 1.0005) {
      ctx.translate(zs.cx, zs.cy);
      ctx.scale(zs.zf, zs.zf);
      ctx.translate(-zs.cx, -zs.cy);
    }

    this._drawSky();
    this._drawHills();
    this._drawStands(t);
    this._drawBank();
    this._drawWater(t);
    this._drawShore();
    this._drawCourse(t, phase);
    this._drawRopes();
    this._drawParticlesUnder();
    this._drawDucks(t, phase);
    this._drawTape(t, phase); // in front of approaching beaks
    this._drawStartRope(phase);
    this._drawNameTags(t, phase);
    this._drawCrown(t);
    this._drawParticlesOver();
    this._drawProjectiles(t);
    this._drawFinishOverhead(t);
    this._drawStartOverhead(phase);
    this._drawParticlesTop();
    if (this.strobe > 0) {
      // vertical strobe band at the line on the first finish
      const fxl = this.sx(TRACK_LENGTH);
      const sg = ctx.createLinearGradient(fxl - 40, 0, fxl + 40, 0);
      sg.addColorStop(0, 'rgba(255,255,255,0)');
      sg.addColorStop(0.5, `rgba(255,255,255,${0.8 * this.strobe})`);
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(fxl - 40, 0, 80, H);
    }
    ctx.restore();

    // screen-anchored UI: unzoomed, unshaken
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._drawEdgeMarkers(t, phase);
    this._drawVignette();

    if (this.flash > 0 && !this.photo) {
      // reduced motion: no full-screen white strobe, just a faint blink
      const a = this.reduceMotion ? Math.min(this.flash, 1) * 0.25 : this.flash * 0.85;
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.fillRect(-10, -10, W + 20, H + 20);
    }
    if (this.photo) this._drawPhotoStill();

    this.frameMsAvg = lerp(this.frameMsAvg, performance.now() - t0, 0.05); // metric only; main.js governs quality from frame cadence
  }

  /** Photo-finish still: the captured frame in grayscale, slowly pushing in about the line, film border, red line, stamp. */
  _drawPhotoStill() {
    const ph = this.photo;
    const { ctx, W, H, dpr } = this;
    const age = this.wall - ph.t0;
    if (age > ph.dur) return;
    const ui = this.ui;
    const k = 1 + 0.035 * easeOutCubic(clamp(age / ph.dur, 0, 1));
    // where the line sits in the captured (possibly zoomed) frame
    const zc = ph.zc || { zf: 1, cx: 0, cy: 0 };
    const lx = zc.zf > 1.0005 ? zc.cx + (ph.lineX - zc.cx) * zc.zf : ph.lineX;
    const my = zc.zf > 1.0005 ? zc.cy + (ph.midY - zc.cy) * zc.zf : ph.midY;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const canFilter = 'filter' in ctx;
    if (canFilter) ctx.filter = 'grayscale(1) contrast(1.15)';
    ctx.translate(lx * dpr, my * dpr);
    ctx.scale(k, k);
    ctx.translate(-lx * dpr, -my * dpr);
    ctx.drawImage(ph.c, 0, 0);
    if (canFilter) ctx.filter = 'none';
    ctx.restore();
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!canFilter) {
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(0, 0, W, H);
    }
    // cool paper tint + vignette
    ctx.fillStyle = 'rgba(20,26,40,0.12)';
    ctx.fillRect(0, 0, W, H);
    // 2px red timing line
    ctx.fillStyle = 'rgba(230,30,50,0.9)';
    ctx.fillRect(Math.round(lx) - 1, 0, 2, H);
    // film border
    const b = Math.round(24 * ui);
    ctx.fillStyle = '#0b0b0f';
    ctx.fillRect(0, 0, W, b);
    ctx.fillRect(0, H - b, W, b);
    ctx.fillRect(0, 0, b, H);
    ctx.fillRect(W - b, 0, b, H);
    // sprocket ticks along the top/bottom bars
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    for (let x = b + 6; x < W - b; x += 34 * ui) {
      ctx.fillRect(x, b * 0.35, 14 * ui, b * 0.3);
      ctx.fillRect(x, H - b * 0.65, 14 * ui, b * 0.3);
    }
    // stamp: slams in 1.6 -> 1 over 120 ms
    const sc = age < 0.12 ? lerp(1.6, 1, easeOutCubic(age / 0.12)) : 1;
    const text = `${ph.label}  ${ph.time.toFixed(2)}`;
    const size = Math.round(28 * ui);
    ctx.font = `${size}px ${this.displayFont}`;
    const tw0 = this._measure(text, ctx.font) + 26 * ui;
    const tx = clamp(lx - 150 * ui - tw0 / 2, b + tw0 / 2 + 8, W - b - tw0 / 2);
    // keep the stamp below anything docked over the top of the canvas (compact HUD strip / event ribbon)
    const ty = clamp(this.ropeYs[0] - 46 * ui, Math.max(b + 40 * ui, (this.insets.top || 0) + size), H * 0.6);
    ctx.translate(tx, ty);
    ctx.rotate(-0.07);
    ctx.scale(sc, sc);
    ctx.font = `${size}px ${this.displayFont}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = this._measure(text, ctx.font) + 26 * ui;
    ctx.globalAlpha = age < 0.12 ? 0.75 + 0.25 * (age / 0.12) : 1;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    roundRectPath(ctx, -tw / 2, -size * 0.78, tw, size * 1.56, 6 * ui);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#D7263D';
    ctx.stroke();
    ctx.fillStyle = '#D7263D';
    ctx.fillText(text, 0, 1);
    ctx.restore();
    // white flash 1 -> 0 over the first 140 ms
    if (age < 0.14) {
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = `rgba(255,255,255,${1 - age / 0.14})`;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  // ---- sky ------------------------------------------------------------------

  _drawSky() {
    const { ctx, W, theme } = this;
    const h = this.skyH;
    const zx = -(this._zf - 1) * 40;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, theme.skyTop);
    g.addColorStop(0.62, theme.skyMid);
    g.addColorStop(1, theme.skyLow);
    ctx.fillStyle = g;
    ctx.fillRect(-20, -20, W + 40, h + 22);

    // sun: pre-rendered bloom + slow rays + disc
    const sunX = W * 0.8 - this.cam.x * this.cam.ppu * 0.01 + zx;
    const sunY = h * 0.42;
    this.sunX = sunX;
    const sunR = Math.max(6, h * 0.075);
    if (this.tiles?.bloom) {
      const bs = this.tiles.bloomSize;
      const dpr = this.dpr;
      ctx.drawImage(this.tiles.bloom, Math.round((sunX - bs / 2) * dpr) / dpr, Math.round((sunY - bs / 2) * dpr) / dpr, bs, bs);
    }
    if (this.quality.rays) {
      ctx.save();
      ctx.translate(sunX, sunY);
      ctx.rotate(this.reduceMotion ? 0.3 : this.wall * 0.02);
      ctx.fillStyle = 'rgba(255,250,225,0.05)';
      const rl = h * 1.1;
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * TAU;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, rl, a - 0.09, a + 0.09);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.fillStyle = theme.sunRim;
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR + 2, 0, TAU);
    ctx.fill();
    ctx.fillStyle = theme.sun;
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR, 0, TAU);
    ctx.fill();

    // clouds (two depths)
    for (const c of this.clouds) {
      const span = W + 300;
      const far = c.y < 0.2;
      const drift = this.reduceMotion ? 0 : this.wall * c.v * 120;
      const x = ((((c.x * span + drift - this.cam.x * this.cam.ppu * (far ? 0.02 : 0.03) + zx) % span) + span) % span) - 150;
      const y = c.y * h;
      this._cloud(x, y, c.s * (h / 200) * (far ? 0.7 : 1), c, far ? 0.85 : 1);
    }
  }

  _cloud(x, y, s, c, alpha) {
    const { ctx, theme } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.fillStyle = theme.cloudShade;
    ctx.beginPath();
    for (const p of c.puffs) {
      ctx.moveTo(p.x + p.r, p.y + 5);
      ctx.arc(p.x, p.y + 5, p.r, 0, TAU);
    }
    ctx.fill();
    ctx.beginPath();
    for (const p of c.puffs) {
      ctx.moveTo(p.x + p.r, p.y);
      ctx.arc(p.x, p.y, p.r, 0, TAU);
    }
    ctx.fillStyle = theme.cloud;
    ctx.fill();
    // highlight pass clipped to the body
    ctx.save();
    ctx.clip();
    ctx.fillStyle = theme.cloudLight;
    ctx.beginPath();
    for (const p of c.puffs) {
      ctx.moveTo(p.x - 3 + p.r * 0.78, p.y - 3);
      ctx.arc(p.x - 3, p.y - 3, p.r * 0.78, 0, TAU);
    }
    ctx.fill();
    ctx.restore();
    ctx.restore();
  }

  _drawHills() {
    const { ctx, W, theme } = this;
    const h = this.skyH;
    const zx = -(this._zf - 1) * 40;
    // cool far silhouette (distant treeline / town) peeking above the far hills
    {
      const par = 0.03;
      const off = this.cam.x * this.cam.ppu * par - zx;
      ctx.fillStyle = theme.far;
      ctx.beginPath();
      ctx.moveTo(-20, h + 2);
      const step = 14;
      const kk0 = Math.floor((off - 20) / step);
      for (let kk = kk0; kk * step - off <= W + 20 + step; kk++) {
        const x = kk * step - off;
        const hh = hash01(kk * 2654435761) ;
        const blockH = h * (0.05 + hh * 0.08) + (kk % 7 === 0 ? h * 0.06 : 0);
        const y = h * 0.6 - blockH;
        ctx.lineTo(x, y);
        ctx.lineTo(x + step, y);
      }
      ctx.lineTo(W + 40, h + 2);
      ctx.closePath();
      ctx.fill();
    }
    const layers = [
      { par: 0.06, color: theme.hillFar, base: h * 0.62, amp: h * 0.16, f1: 0.004, f2: 0.011 },
      { par: 0.12, color: theme.hillNear, base: h * 0.74, amp: h * 0.12, f1: 0.006, f2: 0.017 },
      { par: 0.2, color: theme.hillNear2, base: h * 0.86, amp: h * 0.07, f1: 0.009, f2: 0.021 },
    ];
    for (const L of layers) {
      const off = this.cam.x * this.cam.ppu * L.par - zx;
      ctx.fillStyle = L.color;
      ctx.beginPath();
      ctx.moveTo(-20, h + 2);
      for (let x = -20; x <= W + 28; x += 8) {
        const wx = x + off;
        const y = L.base - (Math.sin(wx * L.f1) * 0.6 + Math.sin(wx * L.f2 + 1.7) * 0.4 + 1) * 0.5 * L.amp;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W + 28, h + 2);
      ctx.closePath();
      ctx.fill();
    }
    // warm haze low over the hills
    const hz = ctx.createLinearGradient(0, h * 0.65, 0, h);
    hz.addColorStop(0, 'rgba(255,236,200,0)');
    hz.addColorStop(1, theme.haze);
    ctx.fillStyle = hz;
    ctx.fillRect(-20, h * 0.65, W + 40, h * 0.35 + 2);
  }

  // ---- venue tiles ----------------------------------------------------------

  _buildTiles() {
    const dpr = this.dpr;
    const tileW = 480;
    const tileH = Math.max(40, Math.round(this.skyH * 0.42));
    const make = (w, h) => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
      const x = c.getContext('2d');
      x.scale(dpr, dpr);
      return { c, x, w, h };
    };
    const roofH = tileH * 0.22;

    // --- trees: 8 variants ---
    const treeW = Math.round(tileH * 0.9);
    const treeH = Math.round(tileH * 1.25);
    const trees = [];
    for (let v = 0; v < 8; v++) {
      const tc = make(treeW, treeH);
      drawTreeInto(tc.x, treeW, treeH, createRng(311 + v * 17));
      trees.push(tc);
    }

    // --- crowd people (shared between the two poses) ---
    const rng = createRng(99);
    const rows = clamp(Math.floor((tileH - roofH - 10) / 11), 2, 6);
    const people = [];
    let pc = 0;
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < tileW / 9; col++) {
        const base = rng.pick(CROWD_COLS);
        people.push({
          r,
          col,
          color: jitterHue(base, rng.range(-8, 8)),
          skin: rng.pick(SKINS),
          up: rng.chance(0.5),
          hat: rng.chance(0.18) ? jitterHue(rng.pick(CROWD_COLS), rng.range(-8, 8)) : null,
          prop: pc++ % 22 === 7 ? (rng.chance(0.5) ? 'pennant' : 'sign') : null,
          propCol: rng.pick(PENNANT_COLS),
        });
      }
    }
    const stand = [make(tileW, tileH), make(tileW, tileH)];
    stand.forEach((p, pi) => drawStandInto(p.x, tileW, tileH, roofH, rows, people, pi, this.theme));

    // --- commentary box + scoreboard tower tiles (static; the tower clock is drawn live) ---
    const box = make(tileW, tileH);
    drawBoxInto(box.x, tileW, tileH, trees, this.displayFont, this.theme);
    const tower = make(tileW, tileH);
    const clockRect = drawTowerInto(tower.x, tileW, tileH, trees, this.displayFont);

    // --- bunting ---
    const bunting = make(240, 26);
    {
      const bx = bunting.x;
      bx.strokeStyle = 'rgba(60,60,60,0.7)';
      bx.lineWidth = 1;
      bx.beginPath();
      for (let xx = 0; xx <= 240; xx += 4) {
        const yy = 3 + Math.sin((xx / 240) * TAU) * 3 + 3;
        if (xx === 0) bx.moveTo(xx, yy);
        else bx.lineTo(xx, yy);
      }
      bx.stroke();
      for (let f = 0; f < 12; f++) {
        const fx = f * 20 + 4;
        const fy = 3 + Math.sin((fx / 240) * TAU) * 3 + 3;
        bx.fillStyle = PENNANT_COLS[f % PENNANT_COLS.length];
        bx.beginPath();
        bx.moveTo(fx, fy);
        bx.lineTo(fx + 12, fy + 0.5);
        bx.lineTo(fx + 6, fy + 13);
        bx.closePath();
        bx.fill();
      }
    }

    // --- chequer field for the finish gantry (blitted, never looped per frame) ---
    const chequer = make(Math.ceil(330 * 2.6) , Math.ceil(48 * 2.6));
    {
      const cx = chequer.x;
      const sq = 7.5;
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, chequer.w, chequer.h);
      cx.fillStyle = '#111';
      cx.beginPath();
      for (let gx = 0; gx < chequer.w / sq; gx++) {
        for (let gy = 0; gy < chequer.h / sq; gy++) {
          if ((gx + gy) % 2 === 0) cx.rect(gx * sq, gy * sq, sq, sq);
        }
      }
      cx.fill();
    }

    // --- ripple layer: one seamless 512x256 tile stacked twice vertically ---
    const RW = 512;
    const RH = 256;
    const ripple = make(RW, RH * 2);
    {
      const rx = ripple.x;
      const rr = createRng(4242);
      const strokes = [];
      for (let k = 0; k < 220; k++) {
        const fy = Math.pow(rr.next(), 1.25); // denser toward the top (far water)
        const y = fy * RH;
        const len = lerp(10, 60, fy) * rr.range(0.6, 1.15);
        const th = lerp(1, 3, fy) * rr.range(0.7, 1.1);
        strokes.push({ x: rr.range(0, RW), y, len, th, ink: rr.chance(0.52) ? 'rgba(255,255,255,0.11)' : 'rgba(4,30,90,0.10)' });
      }
      const lens = (x, y, len, th) => {
        rx.moveTo(x - len / 2, y);
        rx.quadraticCurveTo(x, y - th, x + len / 2, y);
        rx.quadraticCurveTo(x, y + th, x - len / 2, y);
        rx.closePath();
      };
      for (const ink of ['rgba(255,255,255,0.11)', 'rgba(4,30,90,0.10)']) {
        rx.fillStyle = ink;
        rx.beginPath();
        for (const s of strokes) {
          if (s.ink !== ink) continue;
          for (const dy of [0, RH]) {
            for (const dx of [-RW, 0, RW]) {
              const x = s.x + dx;
              if (x + s.len / 2 < 0 || x - s.len / 2 > RW) continue;
              for (const wy of [-RH, 0, RH]) {
                const y = s.y + dy + wy;
                if (y + s.th < dy - 0.5 || y - s.th > dy + RH + 0.5) continue;
                lens(x, y, s.len, s.th);
              }
            }
          }
        }
        rx.fill();
      }
    }

    // --- sun bloom (radial), pre-rendered at its on-screen size so the blit is unscaled ---
    const bs = Math.max(16, Math.round(2.4 * this.skyH));
    const bloom = make(bs, bs);
    {
      const b = bloom.x;
      const rg = b.createRadialGradient(bs / 2, bs / 2, 2, bs / 2, bs / 2, bs / 2);
      rg.addColorStop(0, 'rgba(255,250,220,0.95)');
      rg.addColorStop(0.1, 'rgba(255,243,196,0.55)');
      rg.addColorStop(0.35, 'rgba(255,236,170,0.18)');
      rg.addColorStop(1, 'rgba(255,236,170,0)');
      b.fillStyle = rg;
      b.fillRect(0, 0, bs, bs);
    }

    this.tiles = { stand, box, tower, clockRect, trees, tileW, tileH, roofH, bunting: bunting.c, chequer, ripple, RW, RH, bloom: bloom.c, bloomSize: bs };
    this._ripKey = '';
  }

  _tileKind(k) {
    if (!this._kinds) {
      // deterministic venue sequence: mostly stands, never two specials adjacent, never 3 stands in a row
      const kinds = [];
      for (let i = 0; i < 256; i++) {
        const b = Math.floor(hash01(i * 3 + 17) * 5);
        let kind = b < 3 ? 'stand' : b === 3 ? 'box' : 'tower';
        const p1 = kinds[i - 1];
        const p2 = kinds[i - 2];
        if (kind !== 'stand' && p1 && p1 !== 'stand') kind = 'stand';
        if (kind === 'stand' && p1 === 'stand' && p2 === 'stand') kind = i % 2 ? 'box' : 'tower';
        kinds.push(kind);
      }
      this._kinds = kinds;
    }
    return this._kinds[((k % 256) + 256) % 256];
  }

  _drawStands(t) {
    const { ctx, W } = this;
    if (!this.tiles) return;
    const { stand, box, tower, tileW, tileH, roofH } = this.tiles;
    const par = this.standsPar;
    const y0 = this.skyH - tileH - Math.round(this.skyH * 0.1);
    this.standsY = y0 + tileH * 0.55;
    this.standsTop = y0;
    const zx = -(this._zf - 1) * 25;
    const off = this.cam.x * this.cam.ppu * par - zx;
    const start = -(((off % tileW) + tileW) % tileW);
    const bounce = this.reduceMotion || !this.quality.bounce ? 0 : this.cheer;
    const cheering = this.cheer; // pose swaps still show the crowd going wild on the low-fx path
    let k = Math.floor(off / tileW);
    const standTiles = [];
    const kinds = [];
    for (let x = start; x < W + 1; x += tileW, k++) {
      const kind = this._tileKind(k);
      kinds.push({ x, kind });
      if (kind === 'stand') {
        // alternate poses over time when cheering
        const pose = mod2(cheering > 0.05 && !this.reduceMotion ? Math.floor(this.wall * 6 + k) : k);
        const dy = bounce > 0 ? -Math.abs(Math.sin(this.wall * 9 + k)) * 3 * bounce : 0;
        ctx.drawImage(stand[pose].c, x, y0 + dy, tileW, tileH);
        standTiles.push({ x, dy });
      } else if (kind === 'box') {
        ctx.drawImage(box.c, x, y0, tileW, tileH);
      } else {
        ctx.drawImage(tower.c, x, y0, tileW, tileH);
        if (this.quality.clock) this._drawTowerClock(x, y0, t);
      }
    }
    // floodlight masts at seams between two stand tiles
    for (let j = 0; j + 1 < kinds.length; j++) {
      if (kinds[j].kind === 'stand' && kinds[j + 1].kind === 'stand') this._drawMast(kinds[j + 1].x, y0, tileH);
    }
    // camera flashes in the crowd when it goes wild
    if (cheering > 0.5 && this.quality.flashes && !this.reduceMotion && standTiles.length) {
      const seatTop = roofH + 10;
      const seatH = tileH - roofH - 14;
      const slot = Math.floor(this.frameNo / 3);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let j = 0; j < 8; j++) {
        const h = Math.imul(slot * 31 + j * 977 + 13, 2654435761) >>> 0;
        const st = standTiles[h % standTiles.length];
        const fx = st.x + ((h >>> 8) % tileW);
        const fy = y0 + st.dy + seatTop + ((h >>> 20) % Math.max(1, Math.floor(seatH)));
        if (fx < 0 || fx > W) continue;
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath();
        ctx.arc(fx, fy, 6, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(fx - 1, fy - 1, 2, 2);
      }
      ctx.restore();
    }
    // bunting string hung from the roof fascia
    if (this.tiles.bunting) {
      const bpar = 0.45;
      const boff = this.cam.x * this.cam.ppu * bpar - zx;
      const bw = 240;
      const bstart = -(((boff % bw) + bw) % bw);
      const by = y0 + roofH - 3;
      for (let x = bstart; x < W; x += bw) ctx.drawImage(this.tiles.bunting, x, by, bw, 26);
    }
    this._drawThrowers(t);
  }

  _drawTowerClock(x, y0, t) {
    const { ctx } = this;
    const r = this.tiles.clockRect;
    if (!r) return;
    const val = this.sim ? clockValue(this.sim, t) : '0.0';
    const text = val.padStart(5, ' ');
    // dot size from panel size: 5 chars x 4 cols (3 + gap), 5 rows
    const cols = text.length * 4 - 1;
    const d = Math.max(0.6, Math.min(r.w / cols, r.h / 5));
    const oxp = x + r.x + (r.w - cols * d) / 2;
    const oyp = y0 + r.y + (r.h - 5 * d) / 2;
    ctx.fillStyle = '#FFB000';
    ctx.beginPath();
    for (let ci = 0; ci < text.length; ci++) {
      const ch = text[ci];
      const bits = DOT_FONT[ch];
      if (bits === undefined) continue;
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 3; col++) {
          if (bits & (1 << (14 - (row * 3 + col)))) {
            const px = oxp + (ci * 4 + col) * d;
            const py = oyp + row * d;
            ctx.moveTo(px + d * 0.85, py + d * 0.45);
            ctx.arc(px + d * 0.45, py + d * 0.45, d * 0.4, 0, TAU);
          }
        }
      }
    }
    ctx.fill();
  }

  _drawMast(x, y0, tileH) {
    const { ctx } = this;
    const top = y0 - tileH * 0.42;
    const base = y0 + 4;
    ctx.strokeStyle = '#5B6470';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x - 2, base);
    ctx.lineTo(x - 2, top);
    ctx.moveTo(x + 2, base);
    ctx.lineTo(x + 2, top);
    const steps = 6;
    for (let s = 0; s < steps; s++) {
      const ya = base - (s / steps) * (base - top);
      const yb = base - ((s + 1) / steps) * (base - top);
      ctx.moveTo(x - 2, ya);
      ctx.lineTo(x + 2, yb);
    }
    ctx.stroke();
    // lamp head
    ctx.fillStyle = '#3E4650';
    ctx.fillRect(x - 9, top - 6, 18, 6);
    ctx.save();
    ctx.shadowBlur = 14;
    ctx.shadowColor = '#FFF3C4';
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    for (const dx of [-6, 0, 6]) {
      ctx.moveTo(x + dx + 1.6, top - 3);
      ctx.arc(x + dx, top - 3, 1.6, 0, TAU);
    }
    ctx.fill();
    ctx.restore();
    // 4-point glints
    const tw = this.reduceMotion ? 0.7 : 0.55 + 0.45 * Math.sin(this.wall * 3 + x * 0.01);
    ctx.fillStyle = `rgba(255,250,230,${0.5 * tw})`;
    for (const dx of [-6, 6]) {
      star4(ctx, x + dx, top - 3, 5 * tw);
      ctx.fill();
    }
  }

  /** Thrower pose at race time t (screen coords). */
  _throwerPose(th, t) {
    if (!this.tiles) return null;
    const zx = -(this._zf - 1) * 25;
    const x = th.u - this.cam.x * this.cam.ppu * this.standsPar + zx;
    const tL = th.tHit - 0.8;
    const rise = easeOutCubic(clamp((t - th.t0) / 0.15, 0, 1));
    const end = th.tHit + 0.6;
    const sink = clamp((t - end) / 0.15, 0, 1);
    if (sink >= 1) return null;
    const baseY = this.standsY + 6 - 10 * rise + 10 * sink;
    let arm; // radians, 0 = straight up, negative = wound back (away from the water)
    let holding = true;
    let cheerPose = false;
    if (t < tL) arm = lerp(-10, -40, clamp((t - th.t0) / Math.max(0.1, tL - th.t0), 0, 1)) * (Math.PI / 180);
    else if (t < tL + 0.08) {
      arm = lerp(-40, 70, (t - tL) / 0.08) * (Math.PI / 180);
      holding = t < tL + 0.02;
    } else {
      holding = false;
      cheerPose = true;
      arm = (25 + (this.reduceMotion ? 0 : Math.sin(this.wall * 14) * 12)) * (Math.PI / 180);
    }
    const shoulderX = x + 3;
    const shoulderY = baseY - 12;
    const armLen = 13;
    const handX = shoulderX + Math.sin(arm) * armLen;
    const handY = shoulderY - Math.cos(arm) * armLen;
    return { x, baseY, arm, holding, cheerPose, shoulderX, shoulderY, handX, handY };
  }

  _drawThrowers(t) {
    const { ctx } = this;
    for (const th of this.throwers) {
      if (t < th.t0) continue;
      const pose = this._throwerPose(th, t);
      if (!pose) continue;
      const { x, baseY } = pose;
      if (x < -40 || x > this.W + 40) continue;
      // body
      ctx.fillStyle = th.color;
      roundRectPath(ctx, x - 5, baseY - 14, 10, 14, 3);
      ctx.fill();
      // arms
      ctx.strokeStyle = th.color;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pose.shoulderX, pose.shoulderY);
      ctx.lineTo(pose.handX, pose.handY);
      // other arm: down until the throw, then up cheering
      const oa = pose.cheerPose ? (-25 + (this.reduceMotion ? 0 : Math.sin(this.wall * 14 + 1.5) * 12)) * (Math.PI / 180) : -160 * (Math.PI / 180);
      ctx.moveTo(x - 3, baseY - 12);
      ctx.lineTo(x - 3 + Math.sin(oa) * 12, baseY - 12 - Math.cos(oa) * 12);
      ctx.stroke();
      // hands + head
      ctx.fillStyle = th.skin;
      ctx.beginPath();
      ctx.arc(pose.handX, pose.handY, 2, 0, TAU);
      ctx.moveTo(x + 4, baseY - 18);
      ctx.arc(x, baseY - 18, 4, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#2B2B2B';
      ctx.beginPath();
      ctx.arc(x, baseY - 19.5, 4, Math.PI * 1.05, Math.PI * 1.95);
      ctx.fill();
      if (pose.holding) drawHotdog(ctx, pose.handX + 2, pose.handY - 4, 0.55, -0.5 + pose.arm * 0.5);
    }
  }

  // ---- bank / water ---------------------------------------------------------

  _drawBank() {
    const { ctx, W, theme } = this;
    const bankH = Math.max(10, Math.round(this.skyH * 0.1));
    const y = this.skyH - bankH;
    const zx = -(this._zf - 1) * 25;
    // grass verge
    const g = ctx.createLinearGradient(0, y, 0, y + bankH);
    g.addColorStop(0, '#8BD870');
    g.addColorStop(1, theme.bankDark);
    ctx.fillStyle = g;
    ctx.fillRect(-20, y, W + 40, bankH * 0.55);
    // stone embankment: capstone course, staggered joints, damp band at the waterline
    const wy = y + bankH * 0.55;
    const wh = bankH * 0.45 + 1;
    ctx.fillStyle = theme.wall;
    ctx.fillRect(-20, wy, W + 40, wh);
    ctx.fillStyle = theme.wallLight;
    ctx.fillRect(-20, wy, W + 40, 3);
    const par = 0.6;
    const off = this.cam.x * this.cam.ppu * par - zx;
    ctx.fillStyle = theme.wallDark;
    ctx.beginPath();
    const period = 90; // 38 + 52
    const start = -(((off % period) + period) % period);
    for (let x = start; x < W + period; x += period) {
      ctx.rect(x, wy + 3, 1.5, wh - 3);
      ctx.rect(x + 38, wy + 3, 1.5, wh - 3);
    }
    ctx.fill();
    ctx.fillStyle = 'rgba(60,50,30,0.28)';
    ctx.fillRect(-20, this.skyH - 3, W + 40, 3);
  }

  /** Things that sit on the waterline: contact shadow, foam scallops, lily pads, reeds. */
  _drawShore() {
    const { ctx, W } = this;
    const y0 = this.waterTop;
    const bankH = Math.max(10, Math.round(this.skyH * 0.1));
    const zx = -(this._zf - 1) * 25;
    ctx.fillStyle = 'rgba(0,40,90,0.35)';
    ctx.fillRect(-20, y0, W + 40, 2);
    // foam scallops
    const par = 0.6;
    const off = this.cam.x * this.cam.ppu * par - zx;
    const sp = 9;
    const start = -(((off % sp) + sp) % sp);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath();
    for (let x = start; x < W + sp; x += sp) {
      ctx.moveTo(x + 4, y0 + 2);
      ctx.arc(x, y0 + 2, 4, 0, Math.PI);
    }
    ctx.fill();
    // reeds + lily pads hugging the bank
    const rpar = 0.62;
    const roff = this.cam.x * this.cam.ppu * rpar - zx;
    const rw = 170;
    const rstart = -(((roff % rw) + rw) % rw);
    let k = Math.floor(roff / rw);
    for (let x = rstart; x < W + rw; x += rw, k++) {
      if (k % 2 === 0) this._reeds(x + 40, this.skyH + 1, bankH * 1.3, k);
      else {
        this._lilyPad(x + 30, y0 + 7, 1, k);
        this._lilyPad(x + 64, y0 + 11, 0.85, k + 3);
        if (k % 4 === 3) this._lilyPad(x + 118, y0 + 8, 1.1, k + 5);
      }
    }
  }

  _lilyPad(x, y, s, k) {
    const { ctx } = this;
    if (x < -20 || x > this.W + 20) return;
    const bob = this.reduceMotion ? 0 : Math.sin(this.wall * 2 + k) * 0.8;
    const rx = 9 * s;
    const ry = 3.4 * s;
    const notch = 0.35 + (k % 3) * 0.4;
    ctx.fillStyle = '#2E8B47';
    ctx.beginPath();
    ctx.ellipse(x, y + bob + 1.2, rx, ry, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#49B265';
    ctx.beginPath();
    ctx.moveTo(x, y + bob);
    ctx.ellipse(x, y + bob, rx, ry, 0, notch + 0.25, notch - 0.25 + TAU);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,70,40,0.5)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y + bob);
    ctx.lineTo(x + Math.cos(notch + Math.PI) * rx * 0.8, y + bob + Math.sin(notch + Math.PI) * ry * 0.8);
    ctx.stroke();
    if (k % 2) {
      ctx.fillStyle = '#FF7BAC';
      ctx.beginPath();
      ctx.arc(x - rx * 0.3, y + bob - 1.5, 2.2 * s, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#FFD0E2';
      ctx.beginPath();
      ctx.arc(x - rx * 0.3, y + bob - 2.2, 1.1 * s, 0, TAU);
      ctx.fill();
    }
  }

  _reeds(x, y, h, k) {
    const { ctx } = this;
    if (x < -40 || x > this.W + 40) return;
    const sway = this.reduceMotion ? 0 : Math.sin(this.wall * 1.5 + k) * 2;
    ctx.strokeStyle = '#2E7D45';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const bx = x + i * 4;
      const bh = h * (0.6 + ((i * 37 + k * 13) % 10) / 22);
      ctx.moveTo(bx, y);
      ctx.quadraticCurveTo(bx + sway * 0.5, y - bh * 0.5, bx + sway + (i - 3), y - bh);
    }
    ctx.stroke();
    ctx.fillStyle = '#7A4E2A';
    ctx.beginPath();
    for (let i = 0; i < 7; i += 3) {
      const bx = x + i * 4;
      const bh = h * (0.6 + ((i * 37 + k * 13) % 10) / 22);
      ctx.moveTo(bx + sway + (i - 3) + 1.8, y - bh - 4);
      ctx.ellipse(bx + sway + (i - 3), y - bh - 4, 1.8, 5, 0, 0, TAU);
    }
    ctx.fill();
  }

  _drawWater(t) {
    const { ctx, W, H, theme } = this;
    const y0 = this.waterTop;
    const Hw = H - y0;
    const g = ctx.createLinearGradient(0, y0, 0, H);
    g.addColorStop(0, theme.waterTop);
    g.addColorStop(0.1, theme.water2);
    g.addColorStop(0.55, theme.water3);
    g.addColorStop(1, theme.waterBottom);
    ctx.fillStyle = g;
    ctx.fillRect(-20, y0, W + 40, Hw + 20);

    // grandstand reflection
    if (this.quality.reflections && !this.reduceMotion && this.tiles) this._drawReflection();

    // sheen band under the bank
    const rg = ctx.createLinearGradient(0, y0, 0, y0 + 18);
    rg.addColorStop(0, 'rgba(255,255,255,0.22)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(-20, y0, W + 40, 18);

    // ripple texture: two cached layers drifting against each other, in perspective bands
    if (this.tiles?.ripple) {
      const drift = this.reduceMotion ? 0 : this.wall;
      this._blitRipple(this.cam.x * this.cam.ppu * 0.95 - drift * 12, 0, 1);
      if (this.quality.rippleB) this._blitRipple(this.cam.x * this.cam.ppu * 1.06 + drift * 7, 1, 0.6);
    }

    // shimmer highlights (alpha-bucketed into 3 batched fills)
    if (!this.reduceMotion) {
      const buckets = [new Path2D(), new Path2D(), new Path2D()];
      for (let i = 0; i < 20; i++) {
        const fx = (i * 0.6180339) % 1;
        const fy = (i * 0.3819) % 1;
        const x = ((((fx * W * 1.3 - this.cam.x * this.cam.ppu * (0.95 + fy * 0.15)) % (W * 1.3)) + W * 1.3) % (W * 1.3)) - W * 0.15;
        const y = y0 + 10 + fy * (Hw - 20);
        const a = 0.5 + 0.5 * Math.sin(this.wall * 3 + i * 1.7);
        const b = a < 0.34 ? 0 : a < 0.67 ? 1 : 2;
        const rx = 10 + fy * 16;
        buckets[b].moveTo(x + rx, y);
        buckets[b].ellipse(x, y, rx, 1.5 + fy * 1.5, 0, 0, TAU);
      }
      for (let b = 0; b < 3; b++) {
        ctx.fillStyle = `rgba(255,255,255,${(0.1 * (b + 0.5)) / 3})`;
        ctx.fill(buckets[b]);
      }
    }

    // sun glitter column (additive, alpha-bucketed)
    if (this.quality.glitter) {
      const sxg = this.sunX;
      const nb = 4;
      const buckets = [];
      for (let b = 0; b < nb; b++) buckets.push(new Path2D());
      const n = 34;
      for (let i = 0; i < n; i++) {
        const fy = Math.pow((i + 0.5) / n, 1.6);
        const y = y0 + 4 + fy * (Hw - 8);
        const spread = lerp(20, 70, fy);
        const jx = (hash01(i * 7919 + 3) - 0.5) * 2 * spread;
        const w = lerp(6, 22, fy) * (0.6 + hash01(i * 104729 + 11) * 0.8);
        const a = this.reduceMotion ? 0.5 : 0.25 + 0.75 * Math.max(0, Math.sin(this.wall * 5 + i * 2.3));
        const b = Math.min(nb - 1, Math.floor(a * nb));
        buckets[b].moveTo(sxg + jx + w / 2, y);
        buckets[b].ellipse(sxg + jx, y, w / 2, lerp(1, 2, fy) / 2 + 0.4, 0, 0, TAU);
      }
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let b = 0; b < nb; b++) {
        ctx.fillStyle = `rgba(255,250,225,${0.55 * ((b + 0.5) / nb)})`;
        ctx.fill(buckets[b]);
      }
      ctx.restore();
    }
    void t;
  }

  /** (Re)build the per-band ripple canvases at the exact destination height so blits are 1:1. */
  _rippleBands() {
    const { H, dpr } = this;
    const y0 = this.waterTop;
    const Hw = Math.max(3, Math.round(H - y0));
    const key = `${Hw}|${dpr}`;
    if (this._ripKey === key && this._rip) return this._rip;
    const { ripple, RW, RH } = this.tiles;
    const fr = [0.7, 1.0, 1.35];
    const sum = fr[0] + fr[1] + fr[2];
    const heights = [Math.round((Hw * fr[0]) / sum), Math.round((Hw * fr[1]) / sum)];
    heights.push(Math.max(1, Hw - heights[0] - heights[1]));
    const layers = [];
    for (let L = 0; L < 2; L++) {
      const bands = [];
      for (let b = 0; b < 3; b++) {
        const c = document.createElement('canvas');
        c.width = Math.round(RW * dpr);
        c.height = Math.max(1, Math.round(heights[b] * dpr));
        const x = c.getContext('2d');
        const sh = RH / 3;
        const sy = (((b * sh + (L ? RH / 2 : 0)) % RH) + RH) % RH;
        x.drawImage(ripple.c, 0, sy * dpr, RW * dpr, sh * dpr, 0, 0, c.width, c.height);
        bands.push({ c, h: heights[b] });
      }
      layers.push(bands);
    }
    this._ripKey = key;
    this._rip = { layers, RW };
    return this._rip;
  }

  _blitRipple(offX, layer, alpha) {
    const { ctx, W, dpr } = this;
    const rip = this._rippleBands();
    const RW = rip.RW;
    const ox = ((offX % RW) + RW) % RW;
    const xs = Math.round(-ox * dpr) / dpr; // integer device pixels: unscaled, unsampled blits
    ctx.save();
    ctx.globalAlpha = alpha;
    let dy = this.waterTop;
    for (const band of rip.layers[layer]) {
      for (let x = xs; x < W; x += RW) ctx.drawImage(band.c, x, dy, RW, band.h);
      dy += band.h;
    }
    ctx.restore();
  }

  _drawReflection() {
    const { ctx, W, theme } = this;
    const { stand, box, tower, tileW, tileH } = this.tiles;
    const y0 = this.waterTop;
    const refH = tileH * 0.45;
    const zx = -(this._zf - 1) * 25;
    const off = this.cam.x * this.cam.ppu * this.standsPar - zx;
    const start = -(((off % tileW) + tileW) % tileW);
    let k = Math.floor(off / tileW);
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.translate(0, y0);
    ctx.scale(1, -1);
    for (let x = start; x < W + 1; x += tileW, k++) {
      const kind = this._tileKind(k);
      const img = kind === 'stand' ? stand[mod2(k)].c : kind === 'box' ? box.c : tower.c;
      ctx.drawImage(img, x, -refH, tileW, refH);
    }
    ctx.restore();
    // water lines across the reflection + fade out with depth
    ctx.fillStyle = 'rgba(58,179,230,0.5)';
    ctx.beginPath();
    for (let y = y0 + 1; y < y0 + refH; y += 3) ctx.rect(-20, y, W + 40, 1);
    ctx.fill();
    const fg = ctx.createLinearGradient(0, y0, 0, y0 + Math.min(40, refH));
    fg.addColorStop(0, 'rgba(127,214,247,0)');
    fg.addColorStop(1, theme.water2);
    ctx.fillStyle = fg;
    ctx.fillRect(-20, y0, W + 40, refH + 1);
  }

  // ---- course furniture -----------------------------------------------------

  /** Start pontoon, finish line on the water, far finish post, distance markers. */
  _drawCourse(t, phase) {
    const { ctx, W } = this;
    const ui = this.ui;
    const top = this.ropeYs[0];
    const bottom = this.ropeYs[this.ropeYs.length - 1];
    const bankH = Math.max(10, Math.round(this.skyH * 0.1));
    // ---- start dock (x < 0) ----
    const sx0 = this.sx(0);
    if (sx0 > -40) {
      const dockRight = sx0 - 80 * (this.maxDuckScale || 1);
      if (dockRight > 0) {
        // wooden dock planks
        ctx.fillStyle = '#9A6B3E';
        ctx.fillRect(-20, top - 14, dockRight + 20, bottom - top + 24);
        ctx.fillStyle = '#B98450';
        ctx.beginPath();
        for (let y = top - 14; y < bottom + 10; y += 14) ctx.rect(-20, y, dockRight + 20, 6);
        ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath();
        for (let x = dockRight - 6; x > -20; x -= 60) ctx.rect(x, top - 14, 2, bottom - top + 24);
        ctx.fill();
        // dock edge beam + bollards
        ctx.fillStyle = '#6E4A2A';
        ctx.fillRect(dockRight - 5, top - 22, 7, bottom - top + 34);
        ctx.fillStyle = '#3E2A18';
        ctx.beginPath();
        for (let y = top; y < bottom; y += Math.max(40, (bottom - top) / 6)) {
          ctx.moveTo(dockRight + 1, y);
          ctx.arc(dockRight - 1.5, y, 4, 0, TAU);
        }
        ctx.fill();
        // shadow on water
        const sg = ctx.createLinearGradient(dockRight, 0, dockRight + 30, 0);
        sg.addColorStop(0, 'rgba(0,30,70,0.35)');
        sg.addColorStop(1, 'rgba(0,30,70,0)');
        ctx.fillStyle = sg;
        ctx.fillRect(dockRight + 2, top - 6, 30, bottom - top + 12);
      }
      // painted start line on the water (the pennant rope sits on top of it until GO)
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(sx0 - 1.5, top - 2, 3, bottom - top + 4);
      // starter arch: far post from the beam down to the far rope (the beam + lights are drawn after the ducks)
      const sg0 = this._startGeom();
      ctx.fillStyle = '#D8D2C4';
      ctx.fillRect(sx0 - 4, sg0.top + sg0.h, 8, Math.max(0, top - 2 - (sg0.top + sg0.h)));
      ctx.fillStyle = '#B5AE9F';
      ctx.fillRect(sx0 + 1, sg0.top + sg0.h, 3, Math.max(0, top - 2 - (sg0.top + sg0.h)));
    }

    // ---- distance markers: far-bank boards (+ reflection) and spar buoys on the boundary ropes ----
    for (const m of [250, 500, 750]) {
      const x = this.sx(m);
      if (x < -60 || x > W + 60) continue;
      const label = `${(TRACK_LENGTH - m) / 10}m`;
      this._markerBoard(x, label, bankH);
      this._sparBuoy(x, top, 0);
      this._sparBuoy(x, bottom, 1);
    }

    // ---- finish: far post + chequer strip on the water + beam ----
    const fx = this.sx(TRACK_LENGTH);
    if (fx > -80 && fx < W + 80) {
      const g = this._gantryGeom();
      // far post from the gantry down to the far rope
      ctx.fillStyle = '#D8D2C4';
      ctx.fillRect(fx - 4, g.top + g.h, 8, Math.max(0, top - 2 - (g.top + g.h)));
      ctx.fillStyle = '#B5AE9F';
      ctx.fillRect(fx + 1, g.top + g.h, 3, Math.max(0, top - 2 - (g.top + g.h)));
      // chequer strip: squares grow toward the viewer
      const cols = 3;
      const dark = new Path2D();
      const light = new Path2D();
      let r = 0;
      for (let y = top - 4; y < bottom + 4; r++) {
        const fy = clamp((y - this.waterTop) / Math.max(1, this.H - this.waterTop), 0, 1);
        const sq = 7 * lerp(0.8, 1.3, fy);
        const hgt = Math.min(sq, bottom + 4 - y);
        for (let c = 0; c < cols; c++) {
          const path = (r + c) % 2 ? dark : light;
          path.rect(fx - (cols * sq) / 2 + c * sq, y, sq, hgt);
        }
        y += sq;
      }
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fill(light);
      ctx.fillStyle = 'rgba(20,20,30,0.85)';
      ctx.fill(dark);
      // timing beam
      ctx.fillStyle = 'rgba(255,40,60,0.45)';
      ctx.fillRect(fx - 1.5, top - 4, 3, bottom - top + 8);
      if (this.sim && phase !== 'setup') {
        const lead = this._leadX;
        const anyUnfinished = this.leaderIdx >= 0 && this.sim.finishTimes[this.leaderIdx] !== null && t < this.sim.finishTimes[this.leaderIdx];
        if (anyUnfinished && TRACK_LENGTH - lead < 60 && TRACK_LENGTH - lead > -1) {
          const pulse = this.reduceMotion ? 0.7 : 0.6 + 0.4 * Math.sin(this.wall * 8);
          ctx.fillStyle = `rgba(255,40,60,${0.15 * pulse})`;
          ctx.fillRect(fx - 4.5, top - 4, 9, bottom - top + 8);
          ctx.fillStyle = `rgba(255,40,60,${0.08 * pulse})`;
          ctx.fillRect(fx - 7.5, top - 4, 15, bottom - top + 8);
        }
      }
    }
    void ui;
  }

  _gantryGeom() {
    const ui = this.ui;
    const top = this.ropeYs[0];
    const w = clamp(this.effectiveW() * 0.24, 180, 320) * ui;
    const h = 44 * ui;
    const gTop = Math.max(8, top - 60 * ui);
    return { w, h, top: gTop };
  }

  _markerBoard(x, label, bankH) {
    const { ctx } = this;
    const ui = this.ui;
    const w = 46 * ui;
    const h = 22 * ui;
    const grassY = this.skyH - bankH + 2; // legs stand on the verge
    const by = grassY - 5 * ui - h;
    const draw = (flip) => {
      ctx.fillStyle = '#5B6470';
      ctx.fillRect(x - w * 0.3 - 1.5, by + h, 3, 5 * ui);
      ctx.fillRect(x + w * 0.3 - 1.5, by + h, 3, 5 * ui);
      ctx.fillStyle = '#16202E';
      roundRectPath(ctx, x - w / 2, by, w, h, 4 * ui);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.stroke();
      if (!flip) {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(x - w / 2 + 2, by + h - 4 * ui, w - 4, 3 * ui);
      }
      ctx.fillStyle = '#FFE066';
      ctx.font = `800 ${Math.round(13 * ui)}px ${this.displayFont}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x, by + h / 2 + 1);
    };
    draw(false);
    // reflection just below the waterline
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.translate(0, this.waterTop + 2);
    ctx.scale(1, -0.6);
    ctx.translate(0, -(this.skyH));
    draw(true);
    ctx.restore();
  }

  _sparBuoy(x, ropeY, r) {
    const { ctx } = this;
    const ui = this.ui;
    const fy = (ropeY - this.waterTop) / Math.max(1, this.H - this.waterTop);
    const bob = this.reduceMotion ? 0 : Math.sin(this.wall * 3 + Math.round(x) * 0.02 + r) * lerp(0.6, 1.6, fy);
    const y = ropeY + bob;
    const pw = 5 * ui;
    const ph = 22 * ui;
    // float
    ctx.fillStyle = '#F4F1EA';
    ctx.beginPath();
    ctx.ellipse(x, y + 1, 9 * ui, 3.5 * ui, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.ellipse(x, y + 2, 9 * ui, 2.5 * ui, 0, 0, Math.PI);
    ctx.fill();
    // banded pole
    for (let b = 0; b < 4; b++) {
      ctx.fillStyle = b % 2 ? '#FFFFFF' : '#FF7A2F';
      ctx.fillRect(x - pw / 2, y - ph + (b * ph) / 4, pw, ph / 4 + 0.5);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(x + pw / 2 - 1.5, y - ph, 1.5, ph);
    // pennant
    const wv = this.reduceMotion ? 0 : Math.sin(this.wall * 6 + x * 0.05) * 2;
    ctx.fillStyle = '#FF3B30';
    ctx.beginPath();
    ctx.moveTo(x + pw / 2, y - ph);
    ctx.lineTo(x + pw / 2 + 11 * ui, y - ph + 3 * ui + wv);
    ctx.lineTo(x + pw / 2, y - ph + 7 * ui);
    ctx.closePath();
    ctx.fill();
  }

  _banner(x, top, text, color) {
    const { ctx } = this;
    const ui = this.ui;
    const y = Math.max(16, top - 34 * ui);
    ctx.fillStyle = '#6E4A2A';
    ctx.fillRect(x - 2, y - 6, 4, top - y + 8);
    ctx.font = `800 ${Math.round(13 * ui)}px ${this.displayFont}`;
    const w = this._measure(text, ctx.font) + 18 * ui;
    const h = 20 * ui;
    ctx.fillStyle = color;
    roundRectPath(ctx, x - w / 2, y - h - 2, w, h, 6 * ui);
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(x - w / 2, y - 2 - 3 * ui, w, 3 * ui);
    ctx.restore();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y - h / 2 - 1);
  }

  _measure(text, font) {
    const key = font + '|' + text;
    let w = this._textW.get(key);
    if (w === undefined) {
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      if (this._textW.size > 400) this._textW.clear();
      this._textW.set(key, w);
    }
    return w;
  }

  _drawFinishOverhead(t) {
    const { ctx, W } = this;
    const fx = this.sx(TRACK_LENGTH);
    if (fx < -200 || fx > W + 200) return;
    const ui = this.ui;
    const top = this.ropeYs[0];
    const bottom = this.ropeYs[this.ropeYs.length - 1];
    const g = this._gantryGeom();
    const bx = fx - g.w / 2;
    const by = g.top;
    const bw = g.w;
    const bh = g.h;
    // truss rails behind the banner
    ctx.fillStyle = '#5B6470';
    ctx.fillRect(bx - 8, by + 5, bw + 16, 3);
    ctx.fillRect(bx - 8, by + bh - 8, bw + 16, 3);
    ctx.strokeStyle = '#5B6470';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const ex of [bx - 8, bx + bw + 2]) {
      ctx.moveTo(ex, by + 6);
      ctx.lineTo(ex + 6, by + bh - 7);
      ctx.moveTo(ex + 6, by + 6);
      ctx.lineTo(ex, by + bh - 7);
    }
    ctx.stroke();
    // pennants hanging under the banner
    const nP = clamp(Math.round(bw / 36), 7, 9);
    for (let k = 0; k < nP; k++) {
      const px = bx + ((k + 0.5) / nP) * bw;
      const sway = this.reduceMotion ? 0 : Math.sin(this.wall * 4 + k) * 3;
      ctx.fillStyle = PENNANT_COLS[k % PENNANT_COLS.length];
      ctx.beginPath();
      ctx.moveTo(px - 6 * ui, by + bh - 1);
      ctx.lineTo(px + 6 * ui, by + bh - 1);
      ctx.lineTo(px + sway, by + bh + 11 * ui);
      ctx.closePath();
      ctx.fill();
    }
    // chequered banner (blitted) with frame
    ctx.fillStyle = '#111';
    roundRectPath(ctx, bx - 3, by - 3, bw + 6, bh + 6, 7 * ui);
    ctx.fill();
    ctx.save();
    roundRectPath(ctx, bx, by, bw, bh, 5 * ui);
    ctx.clip();
    const ch = this.tiles?.chequer;
    if (ch) {
      const scale = bh / 44; // keep squares proportionate to the banner
      const sw = Math.min(ch.c.width, (bw / scale) * this.dpr);
      const shh = Math.min(ch.c.height, 44 * this.dpr);
      ctx.drawImage(ch.c, 0, 0, sw, shh, bx, by, bw, bh);
    } else {
      ctx.fillStyle = '#fff';
      ctx.fillRect(bx, by, bw, bh);
    }
    // subtle cloth shading
    const shade = ctx.createLinearGradient(0, by, 0, by + bh);
    shade.addColorStop(0, 'rgba(255,255,255,0.15)');
    shade.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = shade;
    ctx.fillRect(bx, by, bw, bh);
    // centre plate
    const pw = Math.max(bw * 0.5, this._measure('FINISH', `900 ${Math.round(22 * ui)}px ${this.displayFont}`) + 26 * ui);
    ctx.fillStyle = 'rgba(226,61,78,0.96)';
    roundRectPath(ctx, fx - pw / 2, by + 5 * ui, pw, bh - 10 * ui, 5 * ui);
    ctx.fill();
    ctx.restore();
    ctx.font = `900 ${Math.round(22 * ui)}px ${this.displayFont}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineJoin = 'round';
    ctx.strokeText('FINISH', fx, by + bh / 2 + 1);
    ctx.fillStyle = '#fff';
    ctx.fillText('FINISH', fx, by + bh / 2 + 1);
    // flags on top
    const wave = this.reduceMotion ? 0 : Math.sin(this.wall * 6) * 3;
    for (const side of [-1, 1]) {
      const px = fx + side * (bw / 2 + 1);
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, by - 2);
      ctx.lineTo(px, by - 22 * ui);
      ctx.stroke();
      ctx.fillStyle = side < 0 ? '#E23D4E' : '#1F5BD8';
      ctx.beginPath();
      ctx.moveTo(px, by - 22 * ui);
      ctx.quadraticCurveTo(px + side * 9 * ui, by - 20 * ui + wave, px + side * 18 * ui, by - 16 * ui);
      ctx.lineTo(px, by - 11 * ui);
      ctx.closePath();
      ctx.fill();
    }

    // timing board on the far bank
    if (this.sim) {
      const bankH = Math.max(10, Math.round(this.skyH * 0.1));
      const tw = 78 * ui;
      const thh = 30 * ui;
      const tx = fx + 70 * ui;
      const ty = this.skyH - bankH + 2 - 6 * ui - thh;
      ctx.fillStyle = '#5B6470';
      ctx.fillRect(tx + 10 * ui, ty + thh, 3, 6 * ui);
      ctx.fillRect(tx + tw - 13 * ui, ty + thh, 3, 6 * ui);
      ctx.fillStyle = '#141B26';
      roundRectPath(ctx, tx, ty, tw, thh, 5 * ui);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#FFD23F';
      ctx.font = `700 ${Math.round(16 * ui)}px ${MONO_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(clockValue(this.sim, t), tx + tw / 2, ty + thh / 2 + 1);
    }

    // near-side pylon on the bottom rope (never crosses a lane)
    const pyY = bottom;
    ctx.fillStyle = 'rgba(0,30,70,0.25)';
    ctx.beginPath();
    ctx.ellipse(fx, pyY + 16 * ui, 15 * ui, 4.5 * ui, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#F4F1EA';
    ctx.beginPath();
    ctx.ellipse(fx, pyY + 13 * ui, 13 * ui, 4 * ui, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    roundRectPath(ctx, fx - 6 * ui, pyY - 8 * ui, 12 * ui, 22 * ui, 3 * ui);
    ctx.fill();
    ctx.fillStyle = '#E23D4E';
    ctx.fillRect(fx - 6 * ui, pyY - 1 * ui, 12 * ui, 6 * ui);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(fx + 2 * ui, pyY - 8 * ui, 4 * ui, 22 * ui);
    void top;
  }

  // ---- start furniture: arch + lights, pennant rope; finish tape -----------------

  _startGeom() {
    const ui = this.ui;
    const g = this._gantryGeom();
    const w = clamp(this.effectiveW() * 0.13, 120, 180) * ui;
    const h = 30 * ui;
    return { w, h, top: g.top + 4 * ui };
  }

  /** Overhead starter beam with a green START plate, the 3-lamp start light, and the near pylon on the bottom rope. */
  _drawStartOverhead(phase) {
    const { ctx, W } = this;
    const sx0 = this.sx(0);
    if (sx0 < -160 || sx0 > W + 160) return;
    const ui = this.ui;
    const bottom = this.ropeYs[this.ropeYs.length - 1];
    const g = this._startGeom();
    const bx = sx0 - g.w / 2;
    const by = g.top;
    // truss rails + lattice stubs
    ctx.fillStyle = '#5B6470';
    ctx.fillRect(bx - 6, by + 4, g.w + 12, 3);
    ctx.fillRect(bx - 6, by + g.h - 7, g.w + 12, 3);
    ctx.strokeStyle = '#5B6470';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const ex of [bx - 6, bx + g.w + 1]) {
      ctx.moveTo(ex, by + 5);
      ctx.lineTo(ex + 5, by + g.h - 6);
      ctx.moveTo(ex + 5, by + 5);
      ctx.lineTo(ex, by + g.h - 6);
    }
    ctx.stroke();
    // beam
    ctx.fillStyle = '#1C2634';
    roundRectPath(ctx, bx, by, g.w, g.h, 6 * ui);
    ctx.fill();
    const shade = ctx.createLinearGradient(0, by, 0, by + g.h);
    shade.addColorStop(0, 'rgba(255,255,255,0.16)');
    shade.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = shade;
    roundRectPath(ctx, bx, by, g.w, g.h, 6 * ui);
    ctx.fill();
    // green plate
    ctx.font = `900 ${Math.round(16 * ui)}px ${this.displayFont}`;
    const pw = Math.max(g.w * 0.62, this._measure('START', ctx.font) + 22 * ui);
    ctx.fillStyle = '#1E9E52';
    roundRectPath(ctx, sx0 - pw / 2, by + 4 * ui, pw, g.h - 8 * ui, 4 * ui);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(sx0 - pw / 2 + 2, by + 4 * ui + 1, pw - 4, 3 * ui);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineJoin = 'round';
    ctx.strokeText('START', sx0, by + g.h / 2 + 1);
    ctx.fillStyle = '#fff';
    ctx.fillText('START', sx0, by + g.h / 2 + 1);
    // start lights: on an arm off the beam's course-side end, level with it (clear of lane 1's headgear)
    this._drawStartLights(bx + g.w, by + g.h / 2, ui);
    // near-side pylon on the bottom rope (white with a green band)
    const pyY = bottom;
    ctx.fillStyle = 'rgba(0,30,70,0.25)';
    ctx.beginPath();
    ctx.ellipse(sx0, pyY + 16 * ui, 15 * ui, 4.5 * ui, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#F4F1EA';
    ctx.beginPath();
    ctx.ellipse(sx0, pyY + 13 * ui, 13 * ui, 4 * ui, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    roundRectPath(ctx, sx0 - 6 * ui, pyY - 8 * ui, 12 * ui, 22 * ui, 3 * ui);
    ctx.fill();
    ctx.fillStyle = '#1E9E52';
    ctx.fillRect(sx0 - 6 * ui, pyY - 1 * ui, 12 * ui, 6 * ui);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(sx0 + 2 * ui, pyY - 8 * ui, 4 * ui, 22 * ui);
    void phase;
  }

  /** Three lamps reading this.startLights: 1 one red, 2 two red, 3 amber, 4 green (+halo for 0.4 s), 0 dark. */
  _drawStartLights(xLeft, yMid, ui) {
    const { ctx } = this;
    const L = this.startLights;
    const r = 6 * ui;
    const gap = 16 * ui;
    const hw = 3 * gap + 8 * ui;
    const hh = 2 * r + 9 * ui;
    const hx = xLeft + 10 * ui;
    const hy = yMid - hh / 2;
    // mounting arm from the beam
    ctx.fillStyle = '#5B6470';
    ctx.fillRect(xLeft - 2, yMid - 2, 14 * ui, 4);
    // housing
    ctx.fillStyle = '#11161F';
    roundRectPath(ctx, hx, hy, hw, hh, 5 * ui);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
    const since = this.wall - this._lightsWall;
    for (let k = 0; k < 3; k++) {
      const cx = hx + 4 * ui + gap * (k + 0.5);
      const cy = hy + hh / 2;
      let col = null;
      if (L === 1 && k === 0) col = '#FF3B30';
      else if (L === 2 && k <= 1) col = '#FF3B30';
      else if (L === 3) col = '#FFB020';
      else if (L === 4) col = '#3BE477';
      // dark lens
      ctx.fillStyle = '#2A1E1E';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.fill();
      if (col) {
        const glowR = r * (L === 4 && since < 0.4 ? 4.2 - 3 * (since / 0.4) : 2.3);
        const gr = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, glowR);
        gr.addColorStop(0, col);
        gr.addColorStop(0.35, hexA(col, 0.45));
        gr.addColorStop(1, hexA(col, 0));
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = gr;
        ctx.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);
        ctx.restore();
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.92, 0, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.beginPath();
        ctx.arc(cx - r * 0.3, cy - r * 0.35, r * 0.32, 0, TAU);
        ctx.fill();
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.beginPath();
        ctx.arc(cx - r * 0.3, cy - r * 0.35, r * 0.3, 0, TAU);
        ctx.fill();
      }
    }
  }

  /** Pennant rope across the start (in front of the waiting beaks); after GO the released chain dropping onto the water. */
  _drawStartRope(phase) {
    const waiting = phase === 'setup' || phase === 'intro' || phase === 'countdown';
    if (!this.startRope) {
      if (!waiting || !this.lanes.length) return;
      this.startRope = { released: false, t: 0 };
    }
    const rp = this.startRope;
    if (!rp.released && !waiting) {
      this.startRope = null; // left the countdown without a GO (jump/skip)
      return;
    }
    const { ctx, W } = this;
    const sx0 = this.sx(0);
    if (sx0 < -60 || sx0 > W + 60) return;
    const ui = this.ui;
    const top = this.ropeYs[0];
    const bottom = this.ropeYs[this.ropeYs.length - 1];
    const rm = this.reduceMotion;
    let pts;
    let alpha = 1;
    if (!rp.released) {
      // intact: gentle bob, a knot on every lane line
      const n = this.ropeYs.length;
      pts = [];
      for (let k = 0; k < n; k++) {
        const y = this.ropeYs[k];
        const bob = rm ? 0 : Math.sin(this.wall * 2.2 + k * 0.7) * 1.5;
        pts.push({ x: sx0 + bob * (k === 0 || k === n - 1 ? 0.3 : 1), y });
      }
    } else {
      if (!rp.chain) return;
      alpha = clamp(1 - (rp.t - 0.3) / 0.5, 0, 1);
      pts = rp.chain.pts.map((p) => ({ x: sx0 + p.ox, y: p.y, wet: p.wet }));
    }
    if (alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    // rope: white cord with red ticks
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,20,60,0.25)';
    ctx.lineWidth = 4 * ui;
    ctx.beginPath();
    pts.forEach((p, k) => (k ? ctx.lineTo(p.x + 1.5, p.y + 2) : ctx.moveTo(p.x + 1.5, p.y + 2)));
    ctx.stroke();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2.6 * ui;
    ctx.beginPath();
    pts.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.setLineDash([5 * ui, 7 * ui]);
    ctx.strokeStyle = '#E23D4E';
    ctx.stroke();
    ctx.setLineDash([]);
    // pennants between knots, fluttering downstream
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const mx = (a.x + b.x) / 2;
      const myy = (a.y + b.y) / 2;
      const flut = rm ? 0 : Math.sin(this.wall * 7 + k * 1.3) * 2.5 * ui;
      const len = (11 + (k % 2) * 2) * ui;
      ctx.fillStyle = PENNANT_COLS[k % PENNANT_COLS.length];
      ctx.beginPath();
      ctx.moveTo(mx, myy - 5 * ui);
      ctx.lineTo(mx + len, myy + flut * 0.6);
      ctx.lineTo(mx, myy + 5 * ui);
      ctx.closePath();
      ctx.fill();
    }
    // knots
    ctx.fillStyle = '#E23D4E';
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.4 * ui, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Finish tape: candy-striped ribbon across the line until the winner breaks it, then two whipping halves. */
  _drawTape(t, phase) {
    if (!this.sim || (phase !== 'race' && phase !== 'finish')) return;
    if (!this.tape) {
      if (this._firstFinishSeen) return; // already broken (or replayed past the finish)
      this.tape = { snapped: false, t: 0, chains: null };
    }
    const tp = this.tape;
    const { ctx, W } = this;
    const fx = this.sx(TRACK_LENGTH);
    if (fx < -220 || fx > W + 220) return;
    const ui = this.ui;
    const top = this.ropeYs[0];
    const bottom = this.ropeYs[this.ropeYs.length - 1];
    const strokeRibbon = (build, alpha) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,20,60,0.22)';
      ctx.lineWidth = 5 * ui;
      ctx.beginPath();
      build(2, 2);
      ctx.stroke();
      ctx.strokeStyle = '#FFFFFF';
      ctx.beginPath();
      build(0, 0);
      ctx.stroke();
      ctx.strokeStyle = '#E5233B';
      ctx.setLineDash([7 * ui, 7 * ui]);
      ctx.lineDashOffset = 0;
      ctx.stroke();
      ctx.setLineDash([]);
      // specular edge
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      build(-2 * ui, 0);
      ctx.stroke();
      ctx.restore();
    };
    if (!tp.snapped) {
      const lead = this._leadX;
      const bulge = this.reduceMotion ? 0 : clamp(1 - (TRACK_LENGTH - lead) / 25, 0, 1) * 5 * ui; // bows as the leader bears down on it
      const wob = this.reduceMotion ? 0 : Math.sin(this.wall * 3) * 1.2;
      strokeRibbon((dx, dy) => {
        ctx.moveTo(fx + dx, top + dy);
        ctx.quadraticCurveTo(fx + dx + bulge + wob, (top + bottom) / 2 + dy, fx + dx, bottom + dy);
      }, 1);
      return;
    }
    if (!tp.chains || !tp.chains.length) return;
    const alpha = clamp(1 - (tp.t - 0.5) / 1.1, 0, 1);
    if (alpha <= 0.01) return;
    for (const ch of tp.chains) {
      strokeRibbon((dx, dy) => {
        ch.pts.forEach((p, k) => (k ? ctx.lineTo(fx + p.ox + dx, p.y + dy) : ctx.moveTo(fx + p.ox + dx, p.y + dy)));
      }, alpha);
    }
    void t;
  }

  // ---- lane float-lines ----------------------------------------------------

  /**
   * Lane lines as continuous shaded float bands: colour-zoned runs (red for the first/last 5 m,
   * gold triplets on every 10 m mark, white alternating with the lane's towel colour), a specular
   * top line, a dark underside and 1 px disc separators. Cheap: a few strokes per rope plus one
   * batched rect path, instead of ~1,000 ellipse fills.
   */
  _drawRopes() {
    const { ctx, W, theme } = this;
    const n = this.ropeYs.length;
    if (!n) return;
    const ppu = this.cam.ppu;
    const sizeK = clamp(ppu / 5, 0.75, 1.25);
    const xStart = this.sx(0);
    // lane lines run on to the screen edge: after the finish the camera follows the coasting
    // field 100+ units past the line, so a fixed end (+60) left open water mid-frame
    const x0 = Math.max(-10, xStart);
    const x1 = W + 10;
    if (x1 <= x0) return;
    const kFirst = Math.max(0, Math.floor(this.wxOf(x0) / FLOAT_PITCH));
    const kLast = Math.ceil(this.wxOf(x1) / FLOAT_PITCH);
    const rm = this.reduceMotion;
    const seps = new Path2D();
    const colourAt = (k, laneCol) => {
      const wxk = k * FLOAT_PITCH;
      if (wxk < 50 || (wxk > TRACK_LENGTH - 50 && wxk <= TRACK_LENGTH + 1)) return '#E23D4E';
      if (wxk > TRACK_LENGTH + 1) return '#FFFFFF';
      const m = Math.round(wxk / 100);
      if (m > 0 && Math.abs(wxk - m * 100) <= FLOAT_PITCH * 1.5) return '#FFD23F';
      return Math.floor(k / 4) % 2 ? '#FFFFFF' : laneCol;
    };
    ctx.lineCap = 'butt';
    for (let r = 0; r < n; r++) {
      const yBase = this.ropeYs[r];
      if (yBase < -10 || yBase > this.H + 10) continue;
      const fy = clamp((yBase - this.waterTop) / Math.max(1, this.H - this.waterTop), 0, 1);
      const boundary = r === 0 || r === n - 1;
      const size = (1.9 + fy * 2.1) * sizeK * (boundary ? 1.22 : 1); // half-height of the band
      const bob = rm ? 0 : Math.sin(this.wall * 2.1 + r * 0.9) * lerp(0.5, 1.4, fy);
      const y = yBase + bob;
      const laneCol = this.looks[r]?.towel?.bg || theme.buoyA; // lane BELOW this rope
      // underside shadow on the water
      ctx.strokeStyle = 'rgba(0,20,60,0.22)';
      ctx.lineWidth = size * 0.9;
      ctx.beginPath();
      ctx.moveTo(x0, y + size * 0.95);
      ctx.lineTo(x1, y + size * 0.95);
      ctx.stroke();
      // colour runs
      const runs = new Map();
      let runCol = null;
      let runStart = 0;
      const flush = (col, xa, xb) => {
        if (!col || xb <= x0 || xa >= x1) return;
        let p = runs.get(col);
        if (!p) {
          p = new Path2D();
          runs.set(col, p);
        }
        p.moveTo(Math.max(x0, xa), y);
        p.lineTo(Math.min(x1, xb), y);
      };
      for (let k = kFirst; k <= kLast + 1; k++) {
        const col = k <= kLast ? colourAt(k, laneCol) : null;
        if (col !== runCol) {
          if (runCol) flush(runCol, this.sx((runStart - 0.5) * FLOAT_PITCH), this.sx((k - 0.5) * FLOAT_PITCH));
          runCol = col;
          runStart = k;
        }
        // disc separators (only where floats are big enough to read)
        if (size > 2.3 && k <= kLast) {
          const xs = this.sx((k - 0.5) * FLOAT_PITCH);
          if (xs > x0 && xs < x1) seps.rect(xs - 0.5, y - size, 1, size * 2);
        }
      }
      ctx.lineWidth = size * 2;
      for (const [col, p] of runs) {
        ctx.strokeStyle = col;
        ctx.stroke(p);
      }
      // specular top line + soft lower shade give the band a cylindrical read
      ctx.strokeStyle = 'rgba(255,255,255,0.38)';
      ctx.lineWidth = Math.max(0.8, size * 0.45);
      ctx.beginPath();
      ctx.moveTo(x0, y - size * 0.45);
      ctx.lineTo(x1, y - size * 0.45);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.14)';
      ctx.lineWidth = Math.max(0.8, size * 0.5);
      ctx.beginPath();
      ctx.moveTo(x0, y + size * 0.62);
      ctx.lineTo(x1, y + size * 0.62);
      ctx.stroke();
      // round end caps at the start line
      if (xStart > -10 && xStart < W + 10) {
        ctx.fillStyle = '#E23D4E';
        ctx.beginPath();
        ctx.arc(xStart, y, size, 0, TAU);
        ctx.fill();
      }
    }
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fill(seps);
  }

  // ---- ducks -----------------------------------------------------------------

  _drawDucks(t, phase) {
    const { ctx } = this;
    const n = this.looks.length;
    if (!n) return;
    const idle = !this.sim || phase === 'setup' || phase === 'intro' || phase === 'countdown';
    const rm = this.reduceMotion;
    const amp = rm ? 0.3 : 1;
    const v0 = this.sim ? TRACK_LENGTH / this.sim.duration : 26;
    const clipX = this.sx(0) - 4;
    const holder = this.leaderMark.holder;
    const countdown = phase === 'countdown';
    const L = this.startLights;
    const simpleClip = this.quality.simpleClip;
    for (let i = 0; i < n; i++) {
      const look = this.looks[i];
      const lane = this.lanes[i];
      const fx = this.duckFx[i];
      if (!lane || !fx) continue;
      const wx = idle ? 0 : this.duckX(i, t);
      const v = idle ? 0 : this.duckV(i, t);
      // off the line each duck sits still until its own reaction time (x is ~0 there anyway; this keeps the body idle too)
      const reacting = !idle && this.sim && t < (this.sim.stats?.[i]?.reaction ?? 0) + 0.05;
      const effVis = idle || reacting ? 0 : fx.effVis;
      const effort = idle ? 0.15 : clamp(v / v0, 0, 1.6);
      const scale = lane.duckScale;
      const pad = fx.pad;
      let x = this.sx(wx) - NOSE * scale;
      const legacyBob = Math.sin(this.wall * 2.6 * look.bobRate + look.bobPhase) * 2.2 * scale;
      let y;
      if (idle) {
        y = lane.y + legacyBob;
      } else {
        x += Math.cos(TAU * pad) * 2.4 * scale * effVis * amp;
        y = lane.y + (Math.sin(TAU * pad) * 1.8 * scale * (0.4 + effVis) + legacyBob * (1 - 0.6 * Math.min(1, effVis))) * amp;
      }
      // pose anchors for overhead markers (crown, pills, reticle) — stored even when culled
      const hatH = HAT_HEIGHT[look.hat] || 0;
      fx.sc = scale;
      fx.bx = x;
      fx.by = y;
      fx.hx = x + 17 * scale;
      fx.hy = y - 21 * scale;
      fx.topY = y - (33 + hatH) * scale * (look.scale || 1);
      fx.beakX = x + NOSE * scale;
      fx.visible = !(x < -90 * scale || x > this.W + 90 * scale);
      if (!fx.visible) continue;
      const rank = this.ranks[i] ?? i;

      // wake behind the duck (clipped so nothing streams over the dock)
      if (!idle && v > 1) this._wake(x, lane.y, scale, effVis, i, rank, lane, clipX);

      // boost speed-lines
      if (fx.boostGlow > 0.02 && !idle) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(clipX, 0, this.W - clipX + 100, this.H);
        ctx.clip();
        ctx.globalAlpha = fx.boostGlow * 0.5;
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2 * scale;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let s = 0; s < 3; s++) {
          const ly = y - 14 * scale + s * 10 * scale;
          const lx = x - 48 * scale - s * 6 * scale - ((this.wall * 200) % 30) * scale;
          ctx.moveTo(lx, ly);
          ctx.lineTo(lx - 22 * scale, ly);
        }
        ctx.stroke();
        ctx.restore();
      }

      // soft contact shadow on the water
      ctx.fillStyle = 'rgba(6,40,100,0.18)';
      ctx.beginPath();
      ctx.ellipse(x + 2 * scale, lane.y + 10 * scale, 34 * scale, 5 * scale, 0, 0, TAU);
      ctx.fill();

      // focus halo (batch C may point focusDuck at "my duck")
      if (i === this.focusDuck) {
        const pulse = rm ? 0.8 : 0.65 + 0.35 * Math.sin(this.wall * 5);
        ctx.strokeStyle = `rgba(255,255,255,${0.75 * pulse})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.ellipse(x + 2 * scale, lane.y + 10 * scale, (40 + 6 * pulse) * scale, (8 + 2 * pulse) * scale, 0, 0, TAU);
        ctx.stroke();
      }
      // new-leader flash ring
      if (fx.leadFlash > 0.01) {
        const p = 1 - fx.leadFlash;
        ctx.strokeStyle = `rgba(255,210,63,${fx.leadFlash})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(x + 2 * scale, lane.y + 10 * scale, lerp(20, 60, p) * scale, lerp(5, 15, p) * scale, 0, 0, TAU);
        ctx.stroke();
      }

      const spinning = fx.spin >= 0;
      let hop = spinning ? Math.sin(Math.PI * fx.spin) * 22 * scale : 0;
      const spinAngle = spinning ? -TAU * easeInOut(fx.spin) : 0;
      let tilt = idle ? 0 : spinAngle - 0.04 * (effort - 0.8) - 0.09 * fx.tiltA * amp;
      let flap = idle ? 0 : spinning ? 1 : Math.max(fx.flap || 0, 0.25 * Math.max(0, (effVis - 0.8) / 0.55));
      let beakOpen = spinning ? 1 : fx.quack > 0 ? Math.sin(fx.quack * Math.PI) : 0;
      let tailWag = idle ? Math.sin(TAU * 2 * pad) * 0.05 : Math.sin(TAU * 2 * pad) * (0.1 + 0.18 * effVis) * amp;
      let wingLift = 0;
      // countdown body language: weight-shift roll, rock back on "2", coil with half-open wings on "1"
      if (countdown && !rm) {
        tilt += Math.sin(this.wall * Math.PI + look.bobPhase) * 0.035 + fx.lean;
        if (L === 3) {
          wingLift = 0.35;
          tailWag += 0.14;
        }
      } else if (!idle) tilt += fx.lean; // eases back out over the first strides
      // winner: 2.5 s of hopping, flapping, quacking under a golden halo (crown stays on via the leader mark)
      const celeb = fx.celebrate > 0 && !spinning;
      let tau = 0;
      if (celeb) {
        tau = 2.5 - fx.celebrate;
        const fade = clamp(fx.celebrate / 0.4, 0, 1);
        if (!rm) hop += Math.abs(Math.sin(Math.PI * 2.4 * tau)) * 10 * scale * fade;
        if (tau % 1.25 < 0.4) flap = Math.max(flap, rm ? 0.4 : 1);
        beakOpen = Math.max(beakOpen, Math.max(0, Math.sin(TAU * 1.6 * tau)) > 0.55 ? 1 : 0);
        const hr = 60 * scale;
        const hg = ctx.createRadialGradient(x + 4 * scale, y - 14 * scale, 2, x + 4 * scale, y - 14 * scale, hr);
        hg.addColorStop(0, `rgba(255,214,80,${0.3 * fade})`);
        hg.addColorStop(1, 'rgba(255,214,80,0)');
        ctx.fillStyle = hg;
        ctx.fillRect(x + 4 * scale - hr, y - 14 * scale - hr, hr * 2, hr * 2);
      }

      drawDuck(ctx, look, {
        x,
        y: y - hop,
        scale,
        t: this.wall + i * 0.37,
        effort: idle ? 0.15 : effVis,
        pad,
        squash: fx.sq * amp,
        tailWag,
        flap,
        wingLift,
        beakOpen,
        dizzy: fx.dizzy || 0,
        tilt,
        standing: false,
        airborne: spinning,
        sauce: fx.sauce,
        leadGlow: !idle && i === holder ? 1 : 0,
        simpleClip,
      });

      if (celeb && !rm) {
        // ten gold sparkles orbiting the champion, twinkling
        const fade = clamp(fx.celebrate / 0.4, 0, 1) * clamp(tau / 0.25, 0, 1);
        const cx = x + 4 * scale;
        const cy = y - hop - 12 * scale;
        for (let k = 0; k < 10; k++) {
          const ang = tau * 1.5 + (k / 10) * TAU;
          const px = cx + Math.cos(ang) * 34 * scale;
          const py = cy + Math.sin(ang) * 34 * scale * 0.55;
          const tw = 0.7 + 0.3 * Math.sin(TAU * 6 * tau + k * 2.1);
          ctx.globalAlpha = (0.4 + 0.6 * (tw > 0.85 ? 1 : (tw - 0.4) / 0.45)) * fade;
          ctx.fillStyle = k % 3 === 0 ? '#FFFFFF' : '#FFD23F';
          star4(ctx, px, py, (2.2 + 1.8 * tw) * scale);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      const overheadY = y - (44 + hatH * 0.6) * scale;
      if (fx.stars > 0.02 && !spinning) this._stars(x + 18 * scale, Math.min(y - 38 * scale, overheadY + 4 * scale), scale, fx.stars);

      // stumble "?!" bubble (clears tall hats)
      if (fx.dizzy > 0.35) {
        ctx.save();
        ctx.globalAlpha = clamp((fx.dizzy - 0.35) * 3, 0, 1);
        ctx.font = `900 ${Math.round(14 * scale)}px ${UI_FONT}`;
        ctx.fillStyle = '#FFE066';
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.strokeText('?!', x + 4 * scale, overheadY);
        ctx.fillText('?!', x + 4 * scale, overheadY);
        ctx.restore();
      }
    }
  }

  _wake(x, y, scale, effVis, i, rank, lane, clipX) {
    const { ctx } = this;
    const effort = 0.7 + effVis * 0.55;
    const len = (40 + effort * 70) * scale * (rank === 0 ? 1.25 : 1);
    const spread = Math.min((10 + effort * 10) * scale, lane.h * 0.42);
    const alphaK = rank === 0 ? 0.85 : rank >= 5 ? 0.45 : 0.65;
    const sternX = x - 28 * scale;
    const wy = y + 8 * scale;
    if (sternX - len > this.W || sternX < clipX) return;
    ctx.save();
    if (sternX - len < clipX) {
      ctx.beginPath();
      ctx.rect(clipX, 0, this.W - clipX + 200, this.H);
      ctx.clip();
    }
    const hw = 4.5 * scale; // half-width at the stern
    const wob = this.reduceMotion ? 0 : Math.sin(this.wall * 8 + i) * 0.6;
    const flat = this.quality.wakes === 'flat';
    // three nested tapered arms per side, wide+faint to narrow+bright (one flat band on the low-fx path)
    const bands = flat
      ? [{ k: 0.75, a: 0.42 }]
      : [
          { k: 1.0, a: 0.14 },
          { k: 0.66, a: 0.32 },
          { k: 0.36, a: 0.6 },
        ];
    for (const b of bands) {
      ctx.fillStyle = `rgba(255,255,255,${b.a * alphaK})`;
      ctx.beginPath();
      for (const sign of [-1, 1]) {
        const tipX = sternX - len * (0.55 + 0.45 * b.k);
        const tipY = wy + sign * spread * b.k + wob;
        ctx.moveTo(sternX, wy - hw * b.k);
        ctx.quadraticCurveTo(lerp(sternX, tipX, 0.5), lerp(wy, tipY, 0.35) - hw * b.k * 0.6, tipX, tipY);
        ctx.quadraticCurveTo(lerp(sternX, tipX, 0.45), lerp(wy, tipY, 0.6) + hw * b.k * 0.4, sternX, wy + hw * b.k);
        ctx.closePath();
      }
      ctx.fill();
    }
    // turbulence dashes directly astern
    if (!flat) {
      ctx.strokeStyle = `rgba(255,255,255,${0.5 * alphaK})`;
      ctx.lineWidth = 1.6 * scale;
      ctx.lineCap = 'round';
      ctx.beginPath();
      const scroll = this.reduceMotion ? 0 : (this.wall * 60 * scale) % (14 * scale);
      for (let d = 0; d < 3; d++) {
        const dx = sternX - 6 * scale - d * 14 * scale - scroll;
        ctx.moveTo(dx, wy + (d % 2 ? 1.5 : -1.5) * scale);
        ctx.lineTo(dx - 7 * scale, wy + (d % 2 ? 1.5 : -1.5) * scale);
      }
      ctx.stroke();
    }
    // bow wave
    ctx.strokeStyle = `rgba(255,255,255,${0.7 * alphaK})`;
    ctx.lineWidth = 1.6 * scale;
    ctx.beginPath();
    ctx.arc(x + 30 * scale, wy + 1, 7 * scale * (0.6 + effort * 0.5), Math.PI * 1.1, Math.PI * 1.75);
    ctx.stroke();
    ctx.restore();
  }

  /** Animated leader crown: rests above the leader's headgear, flies on a hand-off, tossed by hot dogs. */
  _drawCrown(t) {
    const lm = this.leaderMark;
    if (!this.sim || lm.holder < 0) return;
    const { ctx } = this;
    const fx = this.duckFx[lm.holder];
    const lane = this.lanes[lm.holder];
    if (!fx || !lane) return;
    const scale = lane.duckScale;
    const r = 7 * scale;
    let x;
    let y;
    let rot = 0;
    let scl = 1;
    const rest = this._crownRestPos(lm.holder);
    if (lm.toss) {
      x = lm.toss.x;
      y = lm.toss.y;
      rot = lm.toss.rot;
    } else if (lm.flight && rest) {
      const f = lm.flight;
      const p = easeInOutCubic(f.p);
      const mx = (f.from.x + rest.x) / 2;
      const my = Math.min(f.from.y, rest.y) - 70;
      const u = 1 - p;
      x = u * u * f.from.x + 2 * u * p * mx + p * p * rest.x;
      y = u * u * f.from.y + 2 * u * p * my + p * p * rest.y;
      rot = TAU * p;
      scl = 1 - 0.3 * Math.sin(Math.PI * p);
    } else if (rest) {
      x = rest.x;
      y = rest.y + (this.reduceMotion ? 0 : Math.sin(this.wall * 4) * 2);
      if (lm.popT < 0.16) scl = lerp(1.45, 1, easeOutBack(lm.popT / 0.16));
    } else return;
    lm.x = x;
    lm.y = y;
    if (!fx.visible && !lm.flight && !lm.toss) return;
    // glow
    const gr = 18 * scale * scl;
    const g = ctx.createRadialGradient(x, y, 1, x, y, gr);
    g.addColorStop(0, 'rgba(255,220,90,0.35)');
    g.addColorStop(1, 'rgba(255,220,90,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - gr, y - gr, gr * 2, gr * 2);
    drawCrownGlyph(ctx, x, y, r * scl, { t: this.wall, rot });
    void t;
  }

  /** Name pills: start-list style beside the beak while idle/early, then broadcast tags above the head. */
  _drawNameTags(t, phase) {
    const n = this.looks.length;
    if (!n) return;
    const { ctx } = this;
    const dt = this._dt || 1 / 60;
    const idle = !this.sim || phase === 'setup' || phase === 'intro' || phase === 'countdown';
    const racing = phase === 'race' || phase === 'finish';
    const off = this.labelMode === 'off';
    const allMode = !off && (idle || (racing && t < 4));
    const cap = this.W <= 720 ? 3 : 4;
    // --- pick which top pills are wanted ---
    const wantTop = new Array(n).fill(false);
    if (!off && racing && !allMode) {
      if (this.labelMode === 'all') wantTop.fill(true);
      else {
        const cands = [];
        for (let i = 0; i < n; i++) {
          const fx = this.duckFx[i];
          let pri = -1;
          if (i === this.focusDuck) pri = 100;
          else if (i === this.leaderMark.holder || (this.leaderMark.holder < 0 && i === this.leaderIdx)) pri = 90;
          else {
            const age = this.wall - fx.lastEvent;
            if (age < 2.5) pri = Math.max(pri, 80 - age);
            const ft = this.sim.finishTimes[i];
            if (ft !== null && t >= ft && t - ft < 2) pri = Math.max(pri, 60 - (t - ft));
          }
          if (pri >= 0) cands.push({ i, pri });
        }
        cands.sort((a, b) => b.pri - a.pri);
        for (let k = 0; k < Math.min(cap, cands.length); k++) wantTop[cands[k].i] = true;
      }
    }
    // --- ease alphas (250 ms) ---
    const step = this._cut ? 1 : dt * 4;
    let any = false;
    for (let i = 0; i < n; i++) {
      const ts = allMode ? 1 : 0;
      const tt = wantTop[i] ? 1 : 0;
      this.labelSide[i] = approach(this.labelSide[i] || 0, ts, this._cut ? 1 : step * (allMode ? 1 : 0.5));
      this.labelTop[i] = approach(this.labelTop[i] || 0, tt, step);
      if (this.labelSide[i] > 0.01 || this.labelTop[i] > 0.01) any = true;
    }
    if (!any) return;
    ctx.save();
    ctx.textBaseline = 'middle';
    for (let i = 0; i < n; i++) {
      const fx = this.duckFx[i];
      const lane = this.lanes[i];
      const look = this.looks[i];
      if (!fx || !lane || !fx.visible) continue;
      const scale = lane.duckScale;
      const fs = Math.round(clamp(11 * scale, 10, 14));
      const font = `800 ${fs}px ${this.uiFont}`;
      const name = truncName(look.name || `Duck ${i + 1}`, 14);
      const tw = this._measure(name, font);
      const ph = fs + 8;
      const numW = fs + 4;
      const pw = tw + numW + 16;
      ctx.font = font;
      const minY = (this.insets.top || 0) + 4;
      if (this.labelSide[i] > 0.01) {
        const px = fx.beakX + 10 * scale;
        const py = Math.max(minY, fx.by - 6 * scale - ph / 2);
        this._pill(px, py, pw, ph, numW, look, name, this.labelSide[i], fs);
      }
      if (this.labelTop[i] > 0.01) {
        // in-lane tag on the water behind the tail (swimming-broadcast style): never covers a neighbour
        let px = fx.bx - 42 * scale - pw;
        if (px < (this.insets.left || 0) + 4) px = fx.beakX + 10 * scale; // no room astern: tag ahead
        const py = clamp(lane.y - ph / 2 + 1 * scale, minY, this.H - ph - 2);
        this._pill(px, py, pw, ph, numW, look, name, this.labelTop[i] * 0.95, fs);
      }
    }
    ctx.restore();
  }

  _pill(px, py, pw, ph, numW, look, name, alpha, fs) {
    const { ctx } = this;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    roundRectPath(ctx, px + 1, py + 2, pw, ph, ph / 2);
    ctx.fill();
    ctx.fillStyle = look.towel.bg;
    roundRectPath(ctx, px, py, pw, ph, ph / 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // number disc
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(px + 4 + numW / 2, py + ph / 2, numW / 2, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.font = `900 ${Math.round(fs * 0.85)}px ${this.uiFont}`;
    ctx.fillText(String(look.number), px + 4 + numW / 2, py + ph / 2 + 0.5);
    ctx.fillStyle = look.towel.text;
    ctx.textAlign = 'left';
    ctx.font = `800 ${fs}px ${this.uiFont}`;
    ctx.fillText(name, px + numW + 9, py + ph / 2 + 0.5);
    ctx.globalAlpha = 1;
  }

  // ---- particles --------------------------------------------------------------

  _particleXY(p) {
    if (p.lane === -2) return { x: p.ax + p.ox, y: p.ay + p.oy };
    if (p.lane >= 0) {
      const lane = this.lanes[p.lane];
      if (!lane) return null;
      return { x: this.sx(p.wx) + p.ox, y: lane.y + p.oy };
    }
    return { x: this.sx(p.wx) + p.ox, y: p.absY + p.oy };
  }

  /** Under the ducks: foam trails and ring ripples. */
  _drawParticlesUnder() {
    const { ctx } = this;
    const clipX = this.sx(0) - 4;
    const outer = new Path2D();
    const inner = new Path2D();
    let rings = false;
    for (const p of this.particles) {
      if (p.kind === 'ring') {
        rings = true;
        continue;
      }
      if (p.kind !== 'foam') continue;
      const q = this._particleXY(p);
      if (!q || q.x < clipX || q.x > this.W + 20) continue;
      const life = 1 - p.age / p.life;
      const ageF = p.age / p.life;
      const rx = p.r * (1.4 + ageF * 1.5);
      const ry = p.r * 0.5;
      // bucket alpha by life into the two shared paths (3 buckets via size trick is overkill): use two passes
      const path = life > 0.5 ? inner : outer;
      path.moveTo(q.x + rx, q.y);
      path.ellipse(q.x, q.y, rx, ry, 0, 0, TAU);
    }
    ctx.fillStyle = 'rgba(190,235,255,0.28)';
    ctx.fill(outer);
    ctx.fillStyle = 'rgba(190,235,255,0.35)';
    ctx.fill(inner);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    // bright cores for the fresh half
    ctx.save();
    ctx.globalAlpha = 0.9;
    const core = new Path2D();
    for (const p of this.particles) {
      if (p.kind !== 'foam') continue;
      const life = 1 - p.age / p.life;
      if (life < 0.35) continue;
      const q = this._particleXY(p);
      if (!q || q.x < clipX || q.x > this.W + 20) continue;
      const ageF = p.age / p.life;
      const rx = p.r * (1.4 + ageF * 1.5) * 0.6;
      core.moveTo(q.x + rx, q.y);
      core.ellipse(q.x, q.y, rx, p.r * 0.3, 0, 0, TAU);
    }
    ctx.fill(core);
    ctx.restore();
    if (rings) {
      ctx.lineCap = 'butt';
      for (const p of this.particles) {
        if (p.kind !== 'ring') continue;
        const q = this._particleXY(p);
        if (!q || q.x < -60 || q.x > this.W + 60) continue;
        const f = p.age / p.life;
        const rx = lerp(6, 42, easeOutCubic(f)) * p.scale;
        ctx.strokeStyle = `rgba(255,255,255,${0.55 * (1 - f)})`;
        ctx.lineWidth = lerp(2, 0.6, f);
        ctx.beginPath();
        ctx.ellipse(q.x, q.y, rx, rx * 0.28, 0, 0, TAU);
        ctx.stroke();
      }
    }
  }

  /** Over the ducks: splash drops (streaks), condiment drops, the ricocheting frank. */
  _drawParticlesOver() {
    const { ctx } = this;
    ctx.lineCap = 'round';
    for (const p of this.particles) {
      if (p.kind === 'drop') {
        const q = this._particleXY(p);
        if (!q || q.x < -20 || q.x > this.W + 20) continue;
        const life = 1 - p.age / p.life;
        ctx.globalAlpha = 0.9 * life;
        if (p.color) {
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(q.x, q.y, Math.min(3, p.r), 0, TAU);
          ctx.fill();
        } else {
          ctx.strokeStyle = 'rgb(225,245,255)';
          ctx.lineWidth = Math.min(3, p.r) * 1.3;
          ctx.beginPath();
          ctx.moveTo(q.x, q.y);
          ctx.lineTo(q.x - p.vx * 0.022, q.y - p.vy * 0.022);
          ctx.stroke();
        }
      } else if (p.kind === 'hotdogDebris') {
        const q = this._particleXY(p);
        if (!q || q.x < -60 || q.x > this.W + 60) continue;
        const s = p.scale * 1.25;
        const bob = p.state === 'fly' || this.reduceMotion ? 0 : Math.sin(this.wall * 4 + p.wx) * 1.5;
        ctx.save();
        ctx.globalAlpha = p.state === 'sink' ? clamp(p.sinkA, 0, 1) : 1;
        if (p.state !== 'fly') {
          // half submerged: clip away the lower half at the waterline
          ctx.beginPath();
          ctx.rect(q.x - 40 * s, q.y - 60 * s + bob, 80 * s, 60 * s);
          ctx.clip();
          drawHotdog(ctx, q.x, q.y + bob, s, p.rot);
          ctx.restore();
          ctx.save();
          ctx.globalAlpha = p.state === 'sink' ? clamp(p.sinkA, 0, 1) * 0.7 : 0.7;
          ctx.strokeStyle = 'rgba(255,255,255,0.8)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.ellipse(q.x, q.y + bob + 1, 20 * s, 3.5 * s, 0, 0, Math.PI);
          ctx.stroke();
        } else drawHotdog(ctx, q.x, q.y, s, p.rot);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Topmost: confetti, crown sparkles, starbursts, BONK! text. */
  _drawParticlesTop() {
    const { ctx } = this;
    for (const p of this.particles) {
      const k = p.kind;
      if (k !== 'confetti' && k !== 'sparkle' && k !== 'starburst' && k !== 'text') continue;
      const q = this._particleXY(p);
      if (!q || q.x < -80 || q.x > this.W + 80) continue;
      const life = 1 - p.age / p.life;
      if (k === 'confetti') {
        ctx.save();
        const flut = p.seed !== undefined ? Math.sin(p.age * 6 + p.seed) * 18 : 0;
        ctx.translate(q.x + flut, q.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.min(1, life * 2);
        const u = this.ui;
        if (p.streamer) {
          ctx.scale(1, 0.55 + 0.45 * Math.cos(p.age * 5 + p.seed));
          ctx.fillRect(-1.2 * u, -8 * u, 2.4 * u, 16 * u);
        } else if (p.seed !== undefined) {
          ctx.scale(0.25 + 0.75 * Math.abs(Math.cos(p.age * 7 + p.seed)), 1); // paper tumbling edge-on
          ctx.fillRect(-3.5 * u, -1.8 * u, 7 * u, 3.6 * u);
        } else ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
        ctx.restore();
      } else if (k === 'sparkle') {
        ctx.globalAlpha = life;
        ctx.fillStyle = p.color;
        star4(ctx, q.x, q.y, p.r * (0.6 + life));
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (k === 'starburst') {
        const f = p.age / p.life; // 0..1 over 200 ms: grow 120 ms, fade 80 ms
        const grow = clamp(f / 0.6, 0, 1);
        const fade = f < 0.6 ? 1 : 1 - (f - 0.6) / 0.4;
        const r = 46 * p.scale * easeOutCubic(grow);
        ctx.globalAlpha = fade;
        ctx.fillStyle = '#FFFFFF';
        starburstPath(ctx, q.x, q.y, r, r * 0.45, 8, this.wall * 2);
        ctx.fill();
        ctx.fillStyle = '#FFE066';
        starburstPath(ctx, q.x, q.y, r * 0.55, r * 0.25, 8, this.wall * 2 + 0.3);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (k === 'text') {
        // scale 0→1.25→1 over 200 ms (cubic overshoot), hold 450 ms, rise 24 px + fade over 250 ms
        const a = p.age;
        let sc = 1;
        let alpha = 1;
        let rise = 0;
        if (a < 0.2) sc = easeOutBack(a / 0.2);
        else if (a > 0.65) {
          const f = clamp((a - 0.65) / 0.25, 0, 1);
          alpha = 1 - f;
          rise = 24 * f;
        }
        if (sc <= 0.01 || alpha <= 0.01) continue;
        ctx.save();
        ctx.translate(q.x, q.y - rise);
        ctx.scale(sc, sc);
        ctx.rotate(-0.08);
        ctx.globalAlpha = alpha;
        ctx.font = `${Math.round(p.size)}px ${this.displayFont}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#3B2400';
        ctx.strokeText(p.text, 0, 0);
        ctx.fillStyle = '#FFE066';
        ctx.fillText(p.text, 0, 0);
        ctx.restore();
      }
    }
  }

  // ---- hot dog in flight -----------------------------------------------------

  /** Screen position of a projectile at race time t: {x, y, p, sx0, sy0, tx, ty}. */
  _projectilePos(pr, t) {
    const lane = this.lanes[pr.duck];
    if (!lane) return null;
    const scale = lane.duckScale;
    const p = clamp((t - pr.t0) / Math.max(0.001, pr.tHit - pr.t0), 0, 1);
    const tx = this.sx(this.duckX(pr.duck, t)) - (NOSE - 16) * scale;
    const ty = lane.y - 20 * scale;
    let sx0;
    let sy0;
    const pose = pr.thrower ? this._throwerPose(pr.thrower, pr.thrower.tHit - 0.74) : null;
    if (pose) {
      // x follows the (parallax) crowd layer live; y is the raised hand
      const live = this._throwerPose(pr.thrower, t);
      sx0 = (live || pose).handX;
      sy0 = pose.handY;
    } else {
      sx0 = tx + 260;
      sy0 = this.skyH * 0.45;
    }
    const cx = (sx0 + tx) / 2;
    const cy = Math.min(sy0, ty) - 120 * this.ui;
    const u = 1 - p;
    const x = u * u * sx0 + 2 * u * p * cx + p * p * tx;
    const y = u * u * sy0 + 2 * u * p * cy + p * p * ty;
    return { x, y, p, sx0, sy0, tx, ty, cx, cy, scale, lane };
  }

  _drawProjectiles(t) {
    const { ctx } = this;
    // reticles: from telegraph until impact
    for (const th of this.throwers) {
      if (t < th.t0 || t > th.tHit + 0.05) continue;
      const fx = this.duckFx[th.duck];
      const lane = this.lanes[th.duck];
      if (!fx || !lane || !fx.visible) continue;
      this._reticle(fx.bx + 4 * lane.duckScale, fx.by - 8 * lane.duckScale, lane.duckScale, t - th.t0);
    }
    for (const pr of this.projectiles) {
      const pos = this._projectilePos(pr, t);
      if (!pos) continue;
      const { x, y, p, sx0, sy0, tx, ty, cx, cy, scale, lane } = pos;
      // shadow on the water under the frank
      ctx.fillStyle = `rgba(0,30,70,${0.15 + 0.2 * p})`;
      ctx.beginPath();
      ctx.ellipse(lerp(sx0, tx, p), lane.y + 10 * scale, (10 + 8 * p) * scale, (3 + 2 * p) * scale, 0, 0, TAU);
      ctx.fill();
      const s = scale * (1.1 + 0.6 * p);
      const rot = this.reduceMotion ? 0.4 : this.wall * 14;
      // afterimages
      if (!this.reduceMotion) {
        const alphas = [0.35, 0.2, 0.12, 0.07];
        for (let k = 4; k >= 1; k--) {
          const pk = p - 0.04 * k;
          if (pk <= 0) continue;
          const u = 1 - pk;
          const ax = u * u * sx0 + 2 * u * pk * cx + pk * pk * tx;
          const ay = u * u * sy0 + 2 * u * pk * cy + pk * pk * ty;
          ctx.globalAlpha = alphas[k - 1];
          drawHotdog(ctx, ax, ay, s * Math.pow(0.9, k), rot - k * 0.5);
        }
        ctx.globalAlpha = 1;
      }
      drawHotdog(ctx, x, y, s, rot);
    }
  }

  _reticle(x, y, scale, age) {
    const { ctx } = this;
    const rm = this.reduceMotion;
    const grow = rm ? 1 : lerp(1.6, 1, easeOutBack(clamp(age / 0.4, 0, 1)));
    let alpha = 1;
    if (!rm && age < 0.55) alpha = Math.floor(age * 16) % 2 ? 0.25 : 1;
    const rot = rm ? 0 : (age * Math.PI) / 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#FF3B30';
    ctx.lineWidth = 2;
    const r1 = 26 * scale * grow;
    const r2 = 18 * scale * grow;
    ctx.beginPath();
    ctx.arc(0, 0, r1, 0, TAU);
    ctx.moveTo(r2, 0);
    ctx.arc(0, 0, r2, 0, TAU);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU;
      ctx.moveTo(Math.cos(a) * (r1 - 5 * scale), Math.sin(a) * (r1 - 5 * scale));
      ctx.lineTo(Math.cos(a) * (r1 + 6 * scale), Math.sin(a) * (r1 + 6 * scale));
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,59,48,0.9)';
    ctx.beginPath();
    ctx.arc(0, 0, 2.2, 0, TAU);
    ctx.fill();
    ctx.restore();
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
    const ui = this.ui;
    const zs = this._zc || { zf: 1, cx: 0, cy: 0 };
    for (let i = 0; i < this.looks.length; i++) {
      const lane = this.lanes[i];
      if (!lane) continue;
      const xr = this.sx(this.duckX(i, t));
      const x = zs.cx + (xr - zs.cx) * zs.zf;
      if (x >= -20) continue;
      const look = this.looks[i];
      const y = clamp(zs.cy + (lane.y - 4 - zs.cy) * zs.zf, 12, this.H - 12);
      const px = this.insets.left + 14 * ui;
      ctx.fillStyle = 'rgba(16,24,40,0.7)';
      ctx.beginPath();
      ctx.moveTo(px - 10 * ui, y);
      ctx.lineTo(px, y - 9 * ui);
      ctx.lineTo(px + 16 * ui, y - 9 * ui);
      ctx.lineTo(px + 16 * ui, y + 9 * ui);
      ctx.lineTo(px, y + 9 * ui);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = look.towel.bg;
      ctx.beginPath();
      ctx.arc(px + 7 * ui, y, 6.5 * ui, 0, TAU);
      ctx.fill();
      ctx.fillStyle = look.towel.text;
      ctx.font = `800 ${Math.round(8 * ui)}px ${UI_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(look.number), px + 7 * ui, y + 0.5);
    }
  }

  _drawVignette() {
    if (this.slowmo <= 0.01 || this.reduceMotion) return;
    const { ctx, W, H } = this;
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,20,${0.55 * this.slowmo})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /** Screen-space anchor for duck i (for DOM labels / punch centres), zoom applied. */
  duckScreen(i, t, phase) {
    const lane = this.lanes[i];
    if (!lane) return null;
    const idle = !this.sim || phase === 'setup' || phase === 'intro' || phase === 'countdown';
    const x = this.sx(idle ? 0 : this.duckX(i, t)) - NOSE * lane.duckScale;
    const zs = this._zoomState();
    return {
      x: zs.cx + (x - zs.cx) * zs.zf,
      y: zs.cy + (lane.y - zs.cy) * zs.zf,
      scale: lane.duckScale * zs.zf,
      h: lane.h * zs.zf,
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function newLeaderMark() {
  return { holder: -1, x: 0, y: 0, flight: null, toss: null, popT: 9, pendingFrom: -1 };
}

/**
 * One verlet step for a chain {pts:[{ox,y,pox,py,floor?,delay?}], seg, anchored, t?}. With `anchored`,
 * pts[0] is fixed. x is a screen offset from a world anchor (finish line / start line) so the camera
 * carries it. A point with a `floor` stops there (it landed on the water: vy killed, heavy x drag) and
 * is flagged `wet`; a point with a `delay` stays put until chain.t passes it.
 */
function stepChain(ch, dt, gravity, damping) {
  const pts = ch.pts;
  const k60 = Math.min(2.5, dt * 60); // damping is specified per 60 Hz frame
  const damp = Math.pow(damping, k60);
  const first = ch.anchored ? 1 : 0;
  const tNow = ch.t || 0;
  for (let k = first; k < pts.length; k++) {
    const p = pts[k];
    if (p.delay && tNow < p.delay) {
      p.py = p.y;
      continue;
    }
    let vx = (p.ox - p.pox) * damp;
    const vy = (p.y - p.py) * damp;
    if (p.wet) vx *= Math.pow(0.9, k60);
    p.pox = p.ox;
    p.py = p.y;
    p.ox += vx;
    p.y += vy + (p.wet ? 0 : gravity * dt * dt);
  }
  for (let it = 0; it < 4; it++) {
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      const dx = b.ox - a.ox;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      if (!ch.anchored && d < ch.seg) continue; // a slack rope may bunch up, never stretch
      const diff = (d - ch.seg) / d;
      if (k === 1 && ch.anchored) {
        b.ox -= dx * diff;
        b.y -= dy * diff;
      } else {
        b.ox -= dx * diff * 0.5;
        b.y -= dy * diff * 0.5;
        a.ox += dx * diff * 0.5;
        a.y += dy * diff * 0.5;
      }
    }
  }
  for (let k = first; k < pts.length; k++) {
    const p = pts[k];
    if (p.floor !== undefined && p.y >= p.floor) {
      p.y = p.floor;
      p.py = p.floor;
      p.wet = true;
    }
  }
}

function clockValue(sim, t) {
  const win = sim.finishTimes[sim.order[0]];
  if (win !== null && win !== undefined && t >= win) return win.toFixed(2);
  return Math.max(0, t).toFixed(1);
}

function mod2(k) {
  return ((k % 2) + 2) % 2;
}

function approach(v, target, step) {
  if (v < target) return Math.min(target, v + step);
  return Math.max(target, v - step);
}

function truncName(name, max) {
  const cps = Array.from(String(name));
  return cps.length > max ? cps.slice(0, max).join('') + '…' : cps.join('');
}

function hash01(n) {
  let h = Math.imul(n | 0, 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function easeInOut(p) {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

function easeInOutCubic(p) {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

function easeOutCubic(p) {
  return 1 - Math.pow(1 - p, 3);
}

function easeOutBack(p) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
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

function star4(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU - Math.PI / 2;
    const rr = k % 2 ? r * 0.28 : r;
    if (k === 0) ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    else ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
}

function starburstPath(ctx, cx, cy, rOuter, rInner, points, rot) {
  ctx.beginPath();
  for (let k = 0; k < points * 2; k++) {
    const a = (k / (points * 2)) * TAU + rot;
    const rr = k % 2 ? rInner : rOuter;
    if (k === 0) ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    else ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
}

function hexA(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Rotate a hex colour's hue by `deg` degrees (keeps saturation/lightness). */
function jitterHue(hex, deg) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  h = (((h + deg) % 360) + 360) % 360;
  return `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
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

// ---- tile painters (run once per resize) ------------------------------------

function drawTreeInto(x, w, h, rng) {
  const cx = w / 2;
  const ground = h - 3;
  const th = h * rng.range(0.72, 0.95);
  // ground shadow
  x.fillStyle = 'rgba(0,40,20,0.22)';
  x.beginPath();
  x.ellipse(cx + 3, ground, w * 0.32, 4, 0, 0, TAU);
  x.fill();
  // tapered trunk
  x.fillStyle = '#6b4a2b';
  x.beginPath();
  x.moveTo(cx - 4.5, ground);
  x.lineTo(cx + 4.5, ground);
  x.lineTo(cx + 2, ground - th * 0.5);
  x.lineTo(cx - 2, ground - th * 0.5);
  x.closePath();
  x.fill();
  x.fillStyle = 'rgba(0,0,0,0.2)';
  x.fillRect(cx + 1, ground - th * 0.45, 2.5, th * 0.45);
  // canopy: 5–7 circles, radii decreasing upward
  const n = rng.int(5, 7);
  const circles = [];
  for (let j = 0; j < n; j++) {
    const f = j / (n - 1);
    const r = lerp(w * 0.3, w * 0.16, f) * rng.range(0.85, 1.1);
    circles.push({ x: cx + rng.range(-w * 0.18, w * 0.18) * (1 - f * 0.6), y: ground - th * lerp(0.42, 0.95, f), r });
  }
  const pass = (dx, dy, k, col) => {
    x.fillStyle = col;
    x.beginPath();
    for (const c of circles) {
      x.moveTo(c.x + dx + c.r * k, c.y + dy);
      x.arc(c.x + dx, c.y + dy, c.r * k, 0, TAU);
    }
    x.fill();
  };
  const hue = rng.range(-8, 8);
  pass(2, 3, 1, jitterHue('#2E7440', hue));
  pass(0, 0, 0.96, jitterHue('#3F8F4E', hue));
  pass(-3, -3, 0.66, jitterHue('#58AE62', hue));
  x.fillStyle = 'rgba(255,255,210,0.18)';
  x.beginPath();
  for (const c of circles) {
    x.moveTo(c.x - 5 + c.r * 0.3, c.y - 5);
    x.arc(c.x - 5, c.y - 5, c.r * 0.3, 0, TAU);
  }
  x.fill();
}

function drawStandInto(x, tileW, tileH, roofH, rows, people, pi, theme) {
  const seatTop = roofH + 8;
  const seatH = tileH - seatTop;
  // back wall band + seating
  x.fillStyle = '#4C525E';
  x.fillRect(0, roofH, tileW, 8);
  x.fillStyle = theme.wall;
  x.fillRect(0, seatTop, tileW, seatH);
  const rowH = (seatH - 2) / rows;
  for (let r = 0; r < rows; r++) {
    const y = seatTop + r * rowH;
    x.fillStyle = r % 2 ? 'rgba(0,0,0,0.06)' : 'rgba(0,0,0,0.02)';
    x.fillRect(0, y, tileW, rowH);
    // pre-darken rows toward the back (under the roof)
    const shade = 0.05 * (rows - 1 - r);
    if (shade > 0) {
      x.fillStyle = `rgba(10,20,45,${shade})`;
      x.fillRect(0, y, tileW, rowH);
    }
  }
  // people, back rows first
  for (const pz of people) {
    const y = seatTop + 6 + pz.r * rowH;
    const px = pz.col * 9 + (pz.r % 2 ? 4 : 0);
    const up = pi === 1 ? !pz.up : pz.up;
    x.fillStyle = pz.color;
    // shoulders: rounded trapezoid 7 wide, 7 tall
    x.beginPath();
    x.moveTo(px - 3.6, y + 7.5);
    x.lineTo(px + 3.6, y + 7.5);
    x.lineTo(px + 2.6, y + 1.2);
    x.quadraticCurveTo(px, y - 0.3, px - 2.6, y + 1.2);
    x.closePath();
    x.fill();
    if (up) {
      x.strokeStyle = pz.color;
      x.lineWidth = 1.6;
      x.lineCap = 'round';
      x.beginPath();
      x.moveTo(px - 2.5, y + 2);
      x.lineTo(px - 5, y - 4);
      x.moveTo(px + 2.5, y + 2);
      x.lineTo(px + 5, y - 4);
      x.stroke();
    }
    x.fillStyle = pz.skin;
    x.beginPath();
    x.arc(px, y - 2.4, 2.7, 0, TAU);
    x.fill();
    if (pz.hat) {
      x.fillStyle = pz.hat;
      x.fillRect(px - 3, y - 5.8, 6, 2);
    } else {
      x.fillStyle = 'rgba(40,25,15,0.55)';
      x.beginPath();
      x.arc(px, y - 3.2, 2.7, Math.PI * 1.08, Math.PI * 1.92);
      x.fill();
    }
    if (pz.prop) {
      const side = up ? 1 : -1; // flips with the pose swap
      const hx = px + side * 5;
      const hy = y - 5;
      x.strokeStyle = '#6b4a2b';
      x.lineWidth = 1;
      x.beginPath();
      x.moveTo(hx, hy + 3);
      x.lineTo(hx, hy - 6);
      x.stroke();
      if (pz.prop === 'pennant') {
        x.fillStyle = pz.propCol;
        x.beginPath();
        x.moveTo(hx, hy - 6);
        x.lineTo(hx + side * 7, hy - 4);
        x.lineTo(hx, hy - 2);
        x.closePath();
        x.fill();
      } else {
        x.fillStyle = '#FFFFFF';
        x.fillRect(hx - 5, hy - 11, 10, 6);
        x.fillStyle = pz.propCol;
        x.fillRect(hx - 3.5, hy - 9.5, 7, 1.2);
        x.fillRect(hx - 3.5, hy - 7.5, 5, 1.2);
      }
    }
  }
  // roof shadow over the back of the seating
  const rs = x.createLinearGradient(0, seatTop, 0, seatTop + seatH * 0.65);
  rs.addColorStop(0, 'rgba(10,20,45,0.42)');
  rs.addColorStop(1, 'rgba(10,20,45,0)');
  x.fillStyle = rs;
  x.fillRect(0, seatTop, tileW, seatH * 0.65);
  // posts (light/dark halves) + diagonal struts
  for (let pxp = 0; pxp < tileW; pxp += 120) {
    x.fillStyle = '#B7AFA0';
    x.fillRect(pxp, roofH, 2.5, tileH - roofH);
    x.fillStyle = '#8B8374';
    x.fillRect(pxp + 2.5, roofH, 2.5, tileH - roofH);
    x.strokeStyle = '#8B8374';
    x.lineWidth = 1.5;
    x.beginPath();
    x.moveTo(pxp + 2.5, roofH + 22);
    x.lineTo(pxp + 38, roofH + 2);
    x.stroke();
  }
  // striped roof with a subtle vertical gradient
  const stripeW = 24;
  for (let sxp = -stripeW; sxp < tileW + stripeW; sxp += stripeW) {
    x.fillStyle = (Math.round(sxp / stripeW) % 2 + 2) % 2 ? '#FFFFFF' : '#E23D4E';
    x.beginPath();
    x.moveTo(sxp, roofH - 6);
    x.lineTo(sxp + stripeW, roofH - 6);
    x.lineTo(sxp + stripeW + 6, 2);
    x.lineTo(sxp + 6, 2);
    x.closePath();
    x.fill();
  }
  const rg = x.createLinearGradient(0, 2, 0, roofH - 6);
  rg.addColorStop(0, 'rgba(255,255,255,0.18)');
  rg.addColorStop(1, 'rgba(0,0,0,0.16)');
  x.fillStyle = rg;
  x.fillRect(0, 2, tileW, roofH - 8);
  // fascia + highlight + underside shadow
  x.fillStyle = '#C7343F';
  x.fillRect(0, roofH - 6, tileW, 6);
  x.fillStyle = 'rgba(255,255,255,0.35)';
  x.fillRect(0, roofH - 6, tileW, 1);
  x.fillStyle = 'rgba(0,0,0,0.35)';
  x.fillRect(0, roofH, tileW, 4);
}

function drawBoxInto(x, tileW, tileH, trees, displayFont, theme) {
  // trees flanking
  const tw = trees[0].w;
  const th = trees[0].h;
  const placeTree = (v, cx, s = 1) => {
    const t = trees[v & 7];
    x.drawImage(t.c, cx - (tw * s) / 2, tileH - th * s + 2, tw * s, th * s);
  };
  placeTree(1, tileW * 0.09, 0.9);
  placeTree(4, tileW * 0.2, 1.0);
  placeTree(6, tileW * 0.83, 0.95);
  placeTree(3, tileW * 0.95, 0.85);
  // cabin on stilts
  const bw = tileW * 0.44;
  const bx = (tileW - bw) / 2;
  const by = tileH * 0.28;
  const bh = tileH * 0.5;
  x.fillStyle = '#5B6470';
  for (const lx of [bx + 10, bx + bw / 2 - 2, bx + bw - 14]) x.fillRect(lx, by + bh, 4, tileH - by - bh);
  x.fillStyle = '#2A3442';
  roundRectPath(x, bx, by, bw, bh, 6);
  x.fill();
  // glass with sky gradient + glare
  const gx = bx + 8;
  const gy = by + 9;
  const gw = Math.max(8, bw - 16);
  const gh = Math.max(4, bh - 20);
  const gg = x.createLinearGradient(0, gy, 0, gy + gh);
  gg.addColorStop(0, '#5EB4EE');
  gg.addColorStop(1, '#BFE6FA');
  x.fillStyle = gg;
  roundRectPath(x, gx, gy, gw, gh, 5);
  x.fill();
  x.save();
  roundRectPath(x, gx, gy, gw, gh, 5);
  x.clip();
  x.fillStyle = 'rgba(255,255,255,0.35)';
  x.beginPath();
  x.moveTo(gx + gw * 0.15, gy);
  x.lineTo(gx + gw * 0.3, gy);
  x.lineTo(gx + gw * 0.12, gy + gh);
  x.lineTo(gx - gw * 0.03, gy + gh);
  x.closePath();
  x.fill();
  // silhouettes of two commentators
  x.fillStyle = 'rgba(20,30,50,0.55)';
  for (const cx of [gx + gw * 0.42, gx + gw * 0.68]) {
    x.beginPath();
    x.arc(cx, gy + gh * 0.5, gh * 0.16, 0, TAU);
    x.fill();
    roundRectPath(x, cx - gh * 0.22, gy + gh * 0.66, gh * 0.44, gh * 0.4, 4);
    x.fill();
  }
  x.restore();
  x.strokeStyle = 'rgba(255,255,255,0.6)';
  x.lineWidth = 1.5;
  roundRectPath(x, gx, gy, gw, gh, 5);
  x.stroke();
  // mullions
  x.fillStyle = '#2A3442';
  x.fillRect(gx + gw / 3 - 1, gy, 2, gh);
  x.fillRect(gx + (2 * gw) / 3 - 1, gy, 2, gh);
  // roof slab + sign
  x.fillStyle = '#1B2330';
  x.fillRect(bx - 6, by - 5, bw + 12, 7);
  const sw = bw * 0.62;
  const sh = Math.max(14, tileH * 0.16);
  const sx = bx + (bw - sw) / 2;
  const sy = by - 5 - sh;
  x.fillStyle = '#E23D4E';
  roundRectPath(x, sx, sy, sw, sh, 4);
  x.fill();
  x.fillStyle = 'rgba(0,0,0,0.2)';
  x.fillRect(sx, sy + sh - 3, sw, 3);
  x.fillStyle = '#FFFFFF';
  x.font = `${Math.round(sh * 0.62)}px ${displayFont}`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('DUCK TV', sx + sw / 2, sy + sh / 2 + 1);
  // dish
  x.strokeStyle = '#C9D2DC';
  x.lineWidth = 2;
  x.beginPath();
  x.arc(bx + bw - 6, sy + 2, 9, Math.PI * 1.15, Math.PI * 1.75);
  x.stroke();
  x.beginPath();
  x.moveTo(bx + bw - 6, by - 5);
  x.lineTo(bx + bw - 10, sy - 4);
  x.stroke();
  void theme;
}

function drawTowerInto(x, tileW, tileH, trees, displayFont) {
  const tw = trees[0].w;
  const th = trees[0].h;
  const placeTree = (v, cx, s = 1) => {
    const t = trees[v & 7];
    x.drawImage(t.c, cx - (tw * s) / 2, tileH - th * s + 2, tw * s, th * s);
  };
  placeTree(2, tileW * 0.12, 1.0);
  placeTree(7, tileW * 0.27, 0.85);
  placeTree(5, tileW * 0.74, 0.9);
  placeTree(0, tileW * 0.9, 1.05);
  // scoreboard tower
  const pw = tileW * 0.36;
  const ph = tileH * 0.46;
  const px = (tileW - pw) / 2;
  const py = tileH * 0.1;
  x.fillStyle = '#5B6470';
  x.fillRect(px + 12, py + ph, 6, tileH - py - ph);
  x.fillRect(px + pw - 18, py + ph, 6, tileH - py - ph);
  x.strokeStyle = '#5B6470';
  x.lineWidth = 2;
  x.beginPath();
  x.moveTo(px + 15, py + ph + 4);
  x.lineTo(px + pw - 15, tileH - 4);
  x.moveTo(px + pw - 15, py + ph + 4);
  x.lineTo(px + 15, tileH - 4);
  x.stroke();
  x.fillStyle = '#16202E';
  roundRectPath(x, px, py, pw, ph, 6);
  x.fill();
  x.strokeStyle = 'rgba(255,255,255,0.35)';
  x.lineWidth = 1.5;
  x.stroke();
  // header
  const hh = clamp(ph * 0.26, 4, Math.max(4, ph * 0.4));
  x.fillStyle = '#E23D4E';
  roundRectPath(x, px + 4, py + 4, pw - 8, hh, 4);
  x.fill();
  x.fillStyle = '#fff';
  x.font = `${Math.round(hh * 0.7)}px ${displayFont}`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('RACE CLOCK', px + pw / 2, py + 4 + hh / 2 + 1);
  // dot-matrix field (unlit dots baked in; lit dots drawn live)
  const r = { x: px + 10, y: py + hh + 10, w: Math.max(8, pw - 20), h: Math.max(3, ph - hh - 18) };
  x.fillStyle = '#0B111A';
  roundRectPath(x, r.x - 4, r.y - 4, r.w + 8, r.h + 8, 3);
  x.fill();
  x.fillStyle = 'rgba(255,176,0,0.12)';
  const cols = 5 * 4 - 1;
  const d = Math.max(0.6, Math.min(r.w / cols, r.h / 5));
  const ox = r.x + (r.w - cols * d) / 2;
  const oy = r.y + (r.h - 5 * d) / 2;
  x.beginPath();
  for (let c = 0; c < cols; c++) {
    for (let row = 0; row < 5; row++) {
      x.moveTo(ox + c * d + d * 0.85, oy + row * d + d * 0.45);
      x.arc(ox + c * d + d * 0.45, oy + row * d + d * 0.45, d * 0.4, 0, TAU);
    }
  }
  x.fill();
  // speaker horns
  x.fillStyle = '#3E4650';
  for (const side of [-1, 1]) {
    const hx = side < 0 ? px - 10 : px + pw + 2;
    x.beginPath();
    x.moveTo(hx, py + 10);
    x.lineTo(hx + 8, py + 6);
    x.lineTo(hx + 8, py + 22);
    x.lineTo(hx, py + 18);
    x.closePath();
    x.fill();
  }
  return r;
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
