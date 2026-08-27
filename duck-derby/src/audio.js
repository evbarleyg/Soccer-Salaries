// Tiny WebAudio synthesizer — the whole broadcast sound design is procedural:
// countdown beeps, air horn, quacks, splashes, crowd + water beds, hot-dog
// foley (uh-oh / bonk / splat / boing), lead-change whoosh, a tension drone
// with an accelerating heartbeat and a riser for the run-in, slow-mo treatment, fanfare
// stings, a sad-trombone and the results-ceremony kit (thunk / drumroll /
// cymbal / tick). No audio files.
//
// Lifecycle rules (item 1): no AudioContext and no node graphs while sound is
// off; every one-shot is guarded by ctx + enabled; crowd automation is
// throttled; cheers/quacks/splashes are rate limited so a 16-duck finish under
// fast-forward never stacks into distortion; ambience stops with a fade.

import { clamp, lerp } from './rng.js';

const MASTER_LEVEL = 0.8;
const FANFARE = [
  [523.25, 0, 0.16],
  [659.25, 0.16, 0.16],
  [783.99, 0.32, 0.16],
  [1046.5, 0.48, 0.5],
  [783.99, 0.82, 0.14],
  [1046.5, 0.98, 0.7],
];

/** C-major pentatonic, C5..E6: any three of these make a pleasant jingle. */
const MOTIF_SCALE = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51];
/** A duck's three-note motif from 9 bits (three 3-bit scale indices) — pure, so a name keeps its jingle across seasons. */
export function motifNotes(bits) {
  const b = bits | 0;
  return [MOTIF_SCALE[b & 7], MOTIF_SCALE[(b >> 3) & 7], MOTIF_SCALE[(b >> 6) & 7]];
}

export class DuckAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.noiseBuffer = null;
    // ambience beds
    this.crowd = null;
    this.crowdGain = null;
    this.crowdFilter = null;
    this.water = null;
    this.waterGain = null;
    this._ambienceWanted = false; // startAmbience() was requested (rebuilt when sound is re-enabled)
    this._crowdLevel = 0;
    this._crowdAt = -9;
    this._mixLast = null;
    this._slowmo = 0;
    this._duckMul = 1;
    this._duckTimer = 0;
    this._tension = null; // {g, oscs, p, timer, paused}
    this._riser = null; // {g, src, o} run-in swell (riser())
    // rate limits
    this._cheerAt = -9;
    this._cheerVol = 0;
    this._quackVoices = 0;
    this._splashWin = -9;
    this._splashN = 0;
  }

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Must be called from a user gesture. Creates the context lazily — and not at
   * all while sound is off (a muted session builds no audio graph whatsoever;
   * setEnabled(true) creates it from the toggle's own gesture).
   */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); // also recovers iOS 'interrupted'
      return;
    }
    if (!this.enabled) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
    } catch {
      this.ctx = null;
      return;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = MASTER_LEVEL;
    // safety limiter: 16 ducks + fanfare + crowd never clip the output
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 18;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);
    this.noiseBuffer = this._makeNoise(2.5);
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    if (this._ambienceWanted) this.startAmbience();
  }

  /** Background tab: silence everything (the race clock freezes too — rAF stops). */
  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  resume() {
    if (this.ctx && this.enabled && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  setEnabled(on) {
    on = !!on;
    this.enabled = on;
    if (!on) {
      // muted = no node graphs: tear the beds down (they come back on re-enable)
      this._teardownAmbience(0.15);
      this._killTension();
    } else if (!this.ctx) {
      this.unlock(); // called from the sound toggle's gesture
    }
    if (this.master) this.master.gain.setTargetAtTime(on ? MASTER_LEVEL : 0, this.ctx.currentTime, 0.05);
    if (on && this._ambienceWanted) this.startAmbience();
  }

  _makeNoise(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** True when the beds may be (re)built: a context exists and sound is on (resume() may still be pending). */
  _live() {
    return !!(this.ctx && this.enabled && this.master);
  }

  /**
   * True when a ONE-SHOT may build nodes right now: additionally requires a running context, so nothing is
   * scheduled into a suspended context (hidden tab, pending unlock) to burst out all at once on resume.
   */
  _canPlay() {
    return this._live() && this.ctx.state === 'running';
  }

  _osc(type, freq, t0, dur, gain = 0.3, dest = this.master) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.value = 0;
    o.connect(g);
    g.connect(dest);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
    void gain;
    return { o, g };
  }

  _noise(t0, dur, { loop = false, offset = null, rate = 1 } = {}) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = loop;
    src.playbackRate.value = rate;
    src.start(t0, offset ?? Math.random() * 1.5);
    if (dur > 0) src.stop(t0 + dur);
    return src;
  }

  /** Cancel pending automation but keep the current value (ramps included). */
  _hold(param, t) {
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(t);
    } else {
      const v = param.value;
      param.cancelScheduledValues(t);
      param.setValueAtTime(v, t);
    }
  }

  // ---------------------------------------------------------------------------
  // countdown / start
  // ---------------------------------------------------------------------------

  beep(high = false) {
    if (!this._canPlay()) return;
    const t = this.now;
    const { g } = this._osc('sine', high ? 1046 : 660, t, high ? 0.5 : 0.18, 0.3);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (high ? 0.5 : 0.18));
  }

  horn() {
    if (!this._canPlay()) return;
    const t = this.now;
    const dur = 0.9;
    const freqs = [311, 415, 466];
    const bus = this.ctx.createGain();
    bus.gain.value = 0.0001;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    bus.connect(lp);
    lp.connect(this.master);
    for (const f of freqs) {
      const { o, g } = this._osc('sawtooth', f, t, dur, 0.2, bus);
      g.gain.value = 0.22;
      o.frequency.setValueAtTime(f * 0.96, t);
      o.frequency.linearRampToValueAtTime(f, t + 0.06);
    }
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.exponentialRampToValueAtTime(0.5, t + 0.04);
    bus.gain.setValueAtTime(0.5, t + dur - 0.15);
    bus.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  // ---------------------------------------------------------------------------
  // ducks
  // ---------------------------------------------------------------------------

  /** At most 4 quack voices in flight (a 16-duck finish under fast-forward stays clean). */
  quack(pitch = 1, vol = 0.5) {
    if (!this._canPlay() || this._quackVoices >= 4) return;
    this._quackVoices++;
    const t = this.now;
    const syllables = Math.random() < 0.4 ? 2 : 1;
    let last = null;
    for (let s = 0; s < syllables; s++) {
      const ts = t + s * 0.16;
      const base = 260 * pitch * (s ? 0.94 : 1);
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(base * 1.25, ts);
      o.frequency.exponentialRampToValueAtTime(base * 0.78, ts + 0.13);
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900 * pitch;
      bp.Q.value = 2.5;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, ts);
      g.gain.exponentialRampToValueAtTime(vol, ts + 0.015);
      g.gain.exponentialRampToValueAtTime(vol * 0.5, ts + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, ts + 0.15);
      // a little AM "rasp"
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 70;
      const lfoG = this.ctx.createGain();
      lfoG.gain.value = vol * 0.4;
      lfo.connect(lfoG);
      lfoG.connect(g.gain);
      o.connect(bp);
      bp.connect(g);
      g.connect(this.master);
      o.start(ts);
      o.stop(ts + 0.2);
      lfo.start(ts);
      lfo.stop(ts + 0.2);
      last = o;
    }
    const release = () => {
      this._quackVoices = Math.max(0, this._quackVoices - 1);
    };
    if (last) last.onended = release;
    else release();
  }

  /** At most 6 splashes per second. */
  splash(vol = 0.25) {
    if (!this._canPlay()) return;
    const t = this.now;
    if (t - this._splashWin >= 1) {
      this._splashWin = t;
      this._splashN = 0;
    }
    if (this._splashN >= 6) return;
    this._splashN++;
    const src = this._noise(t, 0.4);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1400, t);
    bp.frequency.exponentialRampToValueAtTime(500, t + 0.3);
    bp.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
  }

  // ---------------------------------------------------------------------------
  // ambience beds: crowd murmur + water lapping
  // ---------------------------------------------------------------------------

  /** Looping crowd murmur; level 0..1 controls excitement. Idempotent. */
  startAmbience() {
    this._ambienceWanted = true;
    if (!this._live() || this.crowd) return;
    const t = this.now;
    const src = this._noise(t, 0, { loop: true, offset: 0 });
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700;
    bp.Q.value = 0.6;
    const g = this.ctx.createGain();
    g.gain.value = 0.0001;
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    this.crowd = src;
    this.crowdGain = g;
    this.crowdFilter = bp;

    // water lapping: lowpassed noise, half speed
    const w = this._noise(t, 0, { loop: true, offset: 0.7, rate: 0.5 });
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    const wg = this.ctx.createGain();
    wg.gain.setValueAtTime(0.0001, t);
    wg.gain.linearRampToValueAtTime(0.05, t + 0.8);
    w.connect(lp);
    lp.connect(wg);
    wg.connect(this.master);
    this.water = w;
    this.waterGain = wg;
    this._crowdAt = -9;
    this._mixLast = null;
    this._applyMix(true);
  }

  /** Fade the beds out over 0.4 s, then stop and release them. Idempotent. */
  stopAmbience() {
    this._ambienceWanted = false;
    this._teardownAmbience(0.4);
  }

  _teardownAmbience(fade) {
    clearTimeout(this._duckTimer);
    this._duckTimer = 0;
    this._duckMul = 1;
    this._slowmo = 0;
    if (!this.ctx) {
      this.crowd = this.crowdGain = this.crowdFilter = this.water = this.waterGain = null;
      return;
    }
    const t = this.now;
    for (const [srcK, gainK] of [
      ['crowd', 'crowdGain'],
      ['water', 'waterGain'],
    ]) {
      const src = this[srcK];
      const g = this[gainK];
      if (g) {
        try {
          this._hold(g.gain, t);
          g.gain.linearRampToValueAtTime(0.0001, t + fade);
        } catch {
          /* torn down already */
        }
      }
      if (src) {
        try {
          src.stop(t + fade + 0.03);
        } catch {
          /* already stopped */
        }
      }
      this[srcK] = null;
      this[gainK] = null;
    }
    this.crowdFilter = null;
    this._mixLast = null;
  }

  /**
   * Crowd excitement 0..1. Called every frame by the director, so it is
   * throttled: tiny changes within 250 ms are ignored, and every applied change
   * cancels the pending automation first (two events per call, not per frame).
   */
  setCrowd(level) {
    level = clamp(Number(level) || 0, 0, 1);
    if (Math.abs(level - this._crowdLevel) < 0.03 && this.now - this._crowdAt < 0.25) return;
    this._crowdLevel = level;
    this._crowdAt = this.now;
    this._applyMix();
  }

  /**
   * One place that turns (crowd level, tension progress, slow-mo amount,
   * side-chain duck) into the three bed parameters.
   */
  _applyMix(force = false, tc = 0.25) {
    if (!this.crowdGain || !this.crowdFilter) return;
    const t = this.now;
    const tn = this._tension;
    const p = tn ? tn.p : 0;
    const a = this._slowmo;
    const duck = this._duckMul;
    const level = this._crowdLevel;
    const gain = (0.02 + level * 0.16) * (1 + 0.3 * p) * duck;
    let freq = 600 + level * 700;
    if (tn) freq = Math.max(freq, lerp(1300, 1900, p)); // the crowd opens up for the run-in
    freq = lerp(freq, 330, a); // slow-mo: the world goes underwater
    const wGain = lerp(0.05, 0.02, a) * duck;
    const m = this._mixLast;
    if (!force && m && Math.abs(gain - m.gain) < 0.004 && Math.abs(freq - m.freq) < 15 && Math.abs(wGain - m.w) < 0.002) return;
    this._mixLast = { gain, freq, w: wGain };
    this.crowdGain.gain.cancelScheduledValues(t);
    this.crowdGain.gain.setTargetAtTime(gain, t, tc);
    this.crowdFilter.frequency.cancelScheduledValues(t);
    this.crowdFilter.frequency.setTargetAtTime(freq, t, tc * 1.2);
    if (this.waterGain) {
      this._hold(this.waterGain.gain, t);
      this.waterGain.gain.setTargetAtTime(wGain, t, tc * 1.2);
    }
  }

  /** Side-chain: dip crowd + water 40% for `ms` so a big moment reads, then swell back. */
  duckAmbience(ms = 1200) {
    if (!this._canPlay()) return;
    this._duckMul = 0.6;
    this._applyMix(true, 0.06);
    clearTimeout(this._duckTimer);
    this._duckTimer = setTimeout(() => {
      this._duckTimer = 0;
      this._duckMul = 1;
      this._applyMix(true, 0.35);
    }, ms);
  }

  /**
   * Slow-motion treatment 0..1: muffles the crowd, thins the water, lifts the
   * drone, and plays a reversed "whoomp" as it kicks in.
   */
  setSlowmo(a) {
    a = clamp(Number(a) || 0, 0, 1);
    const prev = this._slowmo;
    if (Math.abs(a - prev) < 0.01) return;
    this._slowmo = a;
    if (!this._live()) return;
    if (prev < 0.5 && a >= 0.5 && this.ctx.state === 'running') this._whoomp();
    this._applyMix(true, 0.2);
    const tn = this._tension;
    if (tn) {
      const t = this.now;
      this._hold(tn.g.gain, t);
      tn.g.gain.setTargetAtTime(0.07 + 0.05 * a, t, 0.25);
    }
  }

  _whoomp() {
    const t = this.now;
    const src = this._noise(t, 0.3);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(200, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + 0.25);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.25);
    g.gain.linearRampToValueAtTime(0.0001, t + 0.27); // …then cut: reads as reversed
    src.connect(lp);
    lp.connect(g);
    g.connect(this.master);
    const { o, g: sg } = this._osc('sine', 90, t, 0.3, 0.2);
    o.frequency.setValueAtTime(60, t);
    o.frequency.exponentialRampToValueAtTime(120, t + 0.25);
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.18, t + 0.24);
    sg.gain.linearRampToValueAtTime(0.0001, t + 0.27);
  }

  /** Crowd roar. Calls within 200 ms of the previous are ignored unless clearly bigger. */
  cheer(vol = 0.35, dur = 1.6) {
    if (!this._canPlay()) return;
    const t = this.now;
    if (t - this._cheerAt < 0.2 && vol <= this._cheerVol + 0.1) return;
    this._cheerAt = t;
    this._cheerVol = vol;
    const src = this._noise(t, dur + 0.1, { loop: true });
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 0.9;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.12);
    g.gain.setValueAtTime(vol, t + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    // tremolo for "roar" texture
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 5.5;
    const lg = this.ctx.createGain();
    lg.gain.value = vol * 0.3;
    lfo.connect(lg);
    lg.connect(g.gain);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    lfo.start(t);
    lfo.stop(t + dur + 0.1);
  }

  cameraFlash() {
    if (!this._canPlay()) return;
    const t = this.now;
    const src = this._noise(t, 0.15);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    src.connect(hp);
    hp.connect(g);
    g.connect(this.master);
  }

  // ---------------------------------------------------------------------------
  // hot-dog foley
  // ---------------------------------------------------------------------------

  /** Descending slide-whistle for an incoming projectile. */
  whistle(dur = 0.7) {
    if (!this._canPlay()) return;
    const t = this.now;
    const { o, g } = this._osc('sine', 1500, t, dur, 0.2);
    o.frequency.setValueAtTime(1500, t);
    o.frequency.exponentialRampToValueAtTime(380, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  /** Crowd "uh-oh": three voices gliding UP 15% (the inverse of ooh) — the telegraph. */
  uhoh() {
    if (!this._canPlay()) return;
    const t = this.now;
    for (const [f, vol] of [
      [330, 0.06],
      [277, 0.05],
      [220, 0.04],
    ]) {
      const { o, g } = this._osc('sine', f, t, 0.65, vol);
      o.frequency.setValueAtTime(f, t);
      o.frequency.setValueAtTime(f, t + 0.18);
      o.frequency.exponentialRampToValueAtTime(f * 1.15, t + 0.6);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.08);
      g.gain.setValueAtTime(vol * 0.7, t + 0.2); // two syllables: "uh" · "oh"
      g.gain.exponentialRampToValueAtTime(vol, t + 0.26);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
    }
  }

  /** Cartoon bonk: pitch-dropping thump + slap of noise. */
  bonk() {
    if (!this._canPlay()) return;
    const t = this.now;
    const { o, g } = this._osc('triangle', 320, t, 0.3, 0.5);
    o.frequency.setValueAtTime(320, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.25);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    const src = this._noise(t, 0.15);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.35, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    src.connect(bp);
    bp.connect(ng);
    ng.connect(this.master);
  }

  /** Condiment splat: lowpassed noise burst + a sinking sine. */
  splat() {
    if (!this._canPlay()) return;
    const t = this.now + 0.03;
    const src = this._noise(t, 0.2);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(600, t);
    lp.frequency.exponentialRampToValueAtTime(250, t + 0.18);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    src.connect(lp);
    lp.connect(g);
    g.connect(this.master);
    const { o, g: sg } = this._osc('sine', 140, t, 0.2, 0.25);
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.16);
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  }

  /** Spring "boing" as the victim wobbles: 180→420→180 Hz. */
  boing() {
    if (!this._canPlay()) return;
    const t = this.now;
    const { o, g } = this._osc('sine', 180, t, 0.4, 0.15);
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(420, t + 0.12);
    o.frequency.exponentialRampToValueAtTime(180, t + 0.35);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.15, t + 0.015);
    g.gain.setValueAtTime(0.15, t + 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.37);
    // wobble overtone
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 14;
    const lg = this.ctx.createGain();
    lg.gain.value = 18;
    lfo.connect(lg);
    lg.connect(o.frequency);
    lfo.start(t);
    lfo.stop(t + 0.4);
  }

  /** Crowd "ooooh". */
  ooh() {
    if (!this._canPlay()) return;
    const t = this.now;
    for (const [f, vol] of [
      [220, 0.12],
      [277, 0.08],
      [330, 0.06],
    ]) {
      const { o, g } = this._osc('sine', f, t, 1.1, vol);
      o.frequency.setValueAtTime(f * 1.12, t);
      o.frequency.exponentialRampToValueAtTime(f * 0.84, t + 1.0);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.15);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    }
  }

  // ---------------------------------------------------------------------------
  // lead change
  // ---------------------------------------------------------------------------

  /** Swoosh + ding: bandpassed noise sweeping 400→2000 Hz, then a bell at 1320 Hz. */
  whooshDing() {
    if (!this._canPlay()) return;
    const t = this.now;
    const src = this._noise(t, 0.25);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(2000, t + 0.2);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    const td = t + 0.16;
    for (const [f, vol, type] of [
      [1320, 0.12, 'sine'],
      [2640, 0.03, 'sine'],
    ]) {
      const { g: dg } = this._osc(type, f, td, 0.5, vol);
      dg.gain.setValueAtTime(0.0001, td);
      dg.gain.exponentialRampToValueAtTime(vol, td + 0.006);
      dg.gain.exponentialRampToValueAtTime(0.0001, td + (f > 2000 ? 0.2 : 0.45));
    }
  }

  /**
   * Instant-replay wipe: a broadcast "swoosh" — band-passed noise sweeping up (in) or down (out) under a soft sine
   * glide. `out` reverses the sweep so the pair brackets the replay.
   */
  replaySwoosh(out = false) {
    if (!this._canPlay()) return;
    const t = this.now;
    const dur = 0.42;
    const src = this._noise(t, dur + 0.05);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.2;
    const [f0, f1] = out ? [2400, 380] : [380, 2400];
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.9);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.34, t + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    const { o, g: sg } = this._osc('sine', out ? 640 : 220, t, dur, 0.1);
    o.frequency.setValueAtTime(out ? 640 : 220, t);
    o.frequency.exponentialRampToValueAtTime(out ? 220 : 640, t + dur * 0.8);
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.08, t + dur * 0.3);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  // ---------------------------------------------------------------------------
  // run-in tension: drone + accelerating heartbeat, cut by a cymbal on the win
  // ---------------------------------------------------------------------------

  startTension() {
    if (!this._live() || this._tension) return;
    const ctx = this.ctx;
    const t = this.now;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + 2);
    g.connect(this.master);
    const oscs = [];
    for (const [type, f, vol] of [
      ['sine', 55, 1],
      ['sine', 55.5, 1],
      ['triangle', 110.6, 0.35], // an octave up so laptop/phone speakers still feel the drone
    ]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = vol;
      o.connect(og);
      og.connect(g);
      o.start(t);
      oscs.push(o);
    }
    this._tension = { g, oscs, p: 0, timer: 0, paused: false };
    this._applyMix(true);
    this._tension.timer = setTimeout(() => this._beat(), 600);
  }

  /** p 0..1 through the final 20%: heartbeat interval 0.9 → 0.45 s, crowd opens up. */
  setTensionProgress(p) {
    const tn = this._tension;
    if (!tn) return;
    p = clamp(Number(p) || 0, 0, 1);
    if (Math.abs(p - tn.p) < 0.02) return;
    tn.p = p;
    this._applyMix();
  }

  /** Game paused: the drone keeps humming but no new heartbeats are scheduled. */
  pauseTension(on) {
    if (this._tension) this._tension.paused = !!on;
  }

  get tensionActive() {
    return !!this._tension;
  }

  _beat() {
    const tn = this._tension;
    if (!tn) return;
    const playing = this._canPlay() && !tn.paused;
    if (playing) {
      const t = this.now + 0.02;
      this._thump(t, 1, 78);
      this._thump(t + 0.12, 0.7, 64);
      if (tn.p > 0.85) {
        // the last strides: the heart skips to a double beat
        this._thump(t + 0.09, 0.85, 74);
        this._thump(t + 0.21, 0.6, 62);
      }
    }
    const interval = tn.paused ? 0.25 : lerp(0.9, 0.45, tn.p);
    tn.timer = setTimeout(() => this._beat(), interval * 1000);
  }

  _thump(t, vol, f0) {
    const { o, g } = this._osc('sine', f0, t, 0.22, 0.3);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(50, t + 0.14);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.42 * vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    // soft click transient so the beat reads on small speakers
    const { g: cg } = this._osc('triangle', 160, t, 0.05, 0.1);
    cg.gain.setValueAtTime(0.0001, t);
    cg.gain.exponentialRampToValueAtTime(0.08 * vol, t + 0.004);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
  }

  /** Cut the drone/heartbeat; with `hit`, land it on a cymbal. Safe to call any time. */
  stopTension(hit = true) {
    const had = !!this._tension;
    this._killTension();
    if (hit && had) this.cymbal();
    this._applyMix(true);
  }

  _killTension() {
    this._killRiser();
    const tn = this._tension;
    if (!tn) return;
    this._tension = null;
    clearTimeout(tn.timer);
    if (!this.ctx) return;
    const t = this.now;
    try {
      this._hold(tn.g.gain, t);
      tn.g.gain.linearRampToValueAtTime(0.0001, t + 0.08);
      for (const o of tn.oscs) o.stop(t + 0.1);
    } catch {
      /* context gone */
    }
  }

  cymbal() {
    if (!this._canPlay()) return;
    const t = this.now;
    const src = this._noise(t, 1.1);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4000;
    const pk = this.ctx.createBiquadFilter();
    pk.type = 'peaking';
    pk.frequency.value = 7500;
    pk.Q.value = 2;
    pk.gain.value = 6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
    src.connect(hp);
    hp.connect(pk);
    pk.connect(g);
    g.connect(this.master);
  }

  /**
   * Run-in riser: bandpassed noise sweeping 300→2000 Hz plus a sawtooth gliding 110→440 Hz, swelling from
   * nothing to 0.09 over `sec` seconds. Ends itself just past `sec`; the winner's cymbal (stopTension) or any
   * tension kill cuts it early so it always resolves ON the touch, never after it.
   */
  riser(sec = 3) {
    if (!this._canPlay()) return;
    sec = clamp(Number(sec) || 3, 0.5, 6);
    this._killRiser();
    const ctx = this.ctx;
    const t = this.now;
    const end = t + sec;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, end);
    g.gain.linearRampToValueAtTime(0.0001, end + 0.1);
    g.connect(this.master);
    const src = this._noise(t, sec + 0.12, { loop: true });
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 4;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(2000, end);
    src.connect(bp);
    bp.connect(g);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(440, end);
    const og = ctx.createGain();
    og.gain.value = 0.35;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.exponentialRampToValueAtTime(2400, end);
    o.connect(og);
    og.connect(lp);
    lp.connect(g);
    o.start(t);
    o.stop(end + 0.12);
    this._riser = { g, src, o };
  }

  _killRiser() {
    const r = this._riser;
    if (!r) return;
    this._riser = null;
    if (!this.ctx) return;
    const t = this.now;
    try {
      this._hold(r.g.gain, t);
      r.g.gain.linearRampToValueAtTime(0.0001, t + 0.06);
      r.src.stop(t + 0.08);
      r.o.stop(t + 0.08);
    } catch {
      /* already stopped */
    }
  }

  // ---------------------------------------------------------------------------
  // fanfares, stings, sad trombone
  // ---------------------------------------------------------------------------

  _brass(notes, t, level = 1) {
    for (const [f, dt, dur] of notes) {
      for (const [type, v, det] of [
        ['triangle', 0.22, 1],
        ['square', 0.05, 1.005],
      ]) {
        const vol = v * level;
        const { o, g } = this._osc(type, f * det, t + dt, dur + 0.1, vol);
        g.gain.setValueAtTime(0.0001, t + dt);
        g.gain.exponentialRampToValueAtTime(vol, t + dt + 0.02);
        g.gain.setValueAtTime(vol, t + dt + dur * 0.6);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dt + dur);
        o.frequency.value = f * det;
      }
    }
  }

  /** A duck's own three-note jingle (see motifNotes): new leaders and the podium reveals. */
  motif(bits, vol = 0.16) {
    if (!this._canPlay()) return;
    const [a, b, c] = motifNotes(bits);
    this._brass([[a, 0, 0.09], [b, 0.11, 0.09], [c, 0.22, 0.16]], this.now, vol / 0.22);
  }

  /** Full six-note fanfare (results ceremony). */
  fanfare() {
    if (!this._canPlay()) return;
    this._brass(FANFARE, this.now);
  }

  /** First four notes: the winner crosses the line. */
  fanfareSting() {
    if (!this._canPlay()) return;
    this._brass(FANFARE.slice(0, 4), this.now);
  }

  /** Last two notes: everyone home. */
  fanfareTag() {
    if (!this._canPlay()) return;
    const tail = FANFARE.slice(4).map(([f, dt, dur]) => [f, dt - FANFARE[4][1], dur]);
    this._brass(tail, this.now);
  }

  /** Sad trombone for the last duck home: four sliding sawtooth notes with vibrato, the last drooping. */
  wahwah() {
    if (!this._canPlay()) return;
    const ctx = this.ctx;
    const t = this.now;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.Q.value = 0.8;
    lp.connect(this.master);
    const notes = [466, 440, 415, 370];
    notes.forEach((f, k) => {
      const t0 = t + k * 0.3;
      const dur = k === 3 ? 0.6 : 0.3;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, t0);
      if (k === 3) {
        o.frequency.setValueAtTime(f, t0 + 0.12);
        o.frequency.exponentialRampToValueAtTime(f * 0.92, t0 + dur); // the droop
      }
      const vib = ctx.createOscillator();
      vib.frequency.value = 6;
      const vg = ctx.createGain();
      vg.gain.value = 8;
      vib.connect(vg);
      vg.connect(o.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.14, t0 + 0.03);
      g.gain.setValueAtTime(0.12, t0 + dur - 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur - 0.005);
      o.connect(g);
      g.connect(lp);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
      vib.start(t0);
      vib.stop(t0 + dur + 0.02);
    });
  }

  // ---------------------------------------------------------------------------
  // results ceremony kit
  // ---------------------------------------------------------------------------

  /** Plinth landing. */
  thunk() {
    if (!this._canPlay()) return;
    const t = this.now;
    const { o, g } = this._osc('triangle', 110, t, 0.15, 0.3);
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(96, t + 0.08);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    const src = this._noise(t, 0.06);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.12, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(lp);
    lp.connect(ng);
    ng.connect(this.master);
  }

  /**
   * Snare roll: looped noise through a 200 Hz bandpass with a tremolo whose
   * rate ramps 25→40 Hz while the level swells .05→.2 over `dur` seconds.
   * @returns {{stop: () => void}}
   */
  drumroll(dur = 0.7) {
    const handle = { stop: () => {} };
    if (!this._canPlay()) return handle;
    const ctx = this.ctx;
    const t = this.now;
    const end = t + dur;
    const src = this._noise(t, 0, { loop: true, offset: 0.3 });
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 200;
    bp.Q.value = 0.7;
    const snap = ctx.createBiquadFilter(); // a little snare wire on top
    snap.type = 'highshelf';
    snap.frequency.value = 3000;
    snap.gain.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.04, t);
    g.gain.exponentialRampToValueAtTime(dur > 1 ? 0.26 : 0.2, end); // the crescendo spans the whole roll, however long
    const trem = ctx.createGain();
    trem.gain.value = 0.55;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.setValueAtTime(dur > 1 ? 22 : 25, t);
    lfo.frequency.linearRampToValueAtTime(dur > 1 ? 44 : 40, end);
    const lg = ctx.createGain();
    lg.gain.value = 0.45; // 0.55 ± 0.45: strokes, not silence
    lfo.connect(lg);
    lg.connect(trem.gain);
    src.connect(bp);
    bp.connect(snap);
    snap.connect(trem);
    trem.connect(g);
    g.connect(this.master);
    lfo.start(t);
    let stopped = false;
    const stopAt = (ts) => {
      if (stopped) return;
      stopped = true;
      try {
        this._hold(g.gain, ts);
        g.gain.linearRampToValueAtTime(0.0001, ts + 0.06);
        src.stop(ts + 0.08);
        lfo.stop(ts + 0.08);
      } catch {
        /* gone */
      }
    };
    const timer = setTimeout(() => stopAt(this.now), Math.max(0, dur * 1000));
    handle.stop = () => {
      clearTimeout(timer);
      if (this.ctx) stopAt(this.now);
    };
    return handle;
  }

  tick() {
    if (!this._canPlay()) return;
    const t = this.now;
    const { g } = this._osc('square', 1800, t, 0.03, 0.05);
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
  }
}
