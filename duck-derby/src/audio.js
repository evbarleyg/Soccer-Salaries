// Tiny WebAudio synthesizer: countdown beeps, air horn, quacks, splashes,
// crowd ambience and a results fanfare. No audio files.

export class DuckAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.crowd = null;
    this.crowdGain = null;
    this.water = null;
  }

  /** Must be called from a user gesture. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.8 : 0;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);
    this.noiseBuffer = this._makeNoise(2.5);
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ctx.currentTime, 0.05);
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
    return { o, g };
  }

  beep(high = false) {
    if (!this.ctx) return;
    const t = this.now;
    const { g } = this._osc('sine', high ? 1046 : 660, t, high ? 0.5 : 0.18, 0.3);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (high ? 0.5 : 0.18));
  }

  horn() {
    if (!this.ctx) return;
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

  quack(pitch = 1, vol = 0.5) {
    if (!this.ctx) return;
    const t = this.now;
    const syllables = Math.random() < 0.4 ? 2 : 1;
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
    }
  }

  splash(vol = 0.25) {
    if (!this.ctx) return;
    const t = this.now;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
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
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.4);
  }

  /** Looping crowd murmur; level 0..1 controls excitement. */
  startAmbience() {
    if (!this.ctx || this.crowd) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700;
    bp.Q.value = 0.6;
    const g = this.ctx.createGain();
    g.gain.value = 0.0001;
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start();
    this.crowd = src;
    this.crowdGain = g;
    this.crowdFilter = bp;

    // water lapping: lowpassed noise, slow tremolo
    const w = this.ctx.createBufferSource();
    w.buffer = this.noiseBuffer;
    w.loop = true;
    w.playbackRate.value = 0.5;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    const wg = this.ctx.createGain();
    wg.gain.value = 0.05;
    w.connect(lp);
    lp.connect(wg);
    wg.connect(this.master);
    w.start();
    this.water = w;
    this.waterGain = wg;
  }

  setCrowd(level) {
    if (!this.crowdGain) return;
    const t = this.now;
    this.crowdGain.gain.setTargetAtTime(0.02 + level * 0.16, t, 0.25);
    this.crowdFilter.frequency.setTargetAtTime(600 + level * 700, t, 0.3);
  }

  cheer(vol = 0.35, dur = 1.6) {
    if (!this.ctx) return;
    const t = this.now;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
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
    src.start(t);
    src.stop(t + dur + 0.1);
    lfo.start(t);
    lfo.stop(t + dur + 0.1);
  }

  stopAmbience() {
    for (const k of ['crowd', 'water']) {
      if (this[k]) {
        try {
          this[k].stop();
        } catch {
          /* already stopped */
        }
        this[k] = null;
      }
    }
    this.crowdGain = null;
  }

  cameraFlash() {
    if (!this.ctx) return;
    const t = this.now;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    src.connect(hp);
    hp.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + 0.15);
  }

  fanfare() {
    if (!this.ctx) return;
    const t = this.now;
    const notes = [
      [523.25, 0, 0.16], [659.25, 0.16, 0.16], [783.99, 0.32, 0.16], [1046.5, 0.48, 0.5],
      [783.99, 0.82, 0.14], [1046.5, 0.98, 0.7],
    ];
    for (const [f, dt, dur] of notes) {
      for (const [type, vol, det] of [['triangle', 0.22, 1], ['square', 0.05, 1.005]]) {
        const { o, g } = this._osc(type, f * det, t + dt, dur + 0.1, vol);
        g.gain.setValueAtTime(0.0001, t + dt);
        g.gain.exponentialRampToValueAtTime(vol, t + dt + 0.02);
        g.gain.setValueAtTime(vol, t + dt + dur * 0.6);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dt + dur);
        o.frequency.value = f * det;
      }
    }
  }

  /** Descending slide-whistle for an incoming projectile. */
  whistle(dur = 0.7) {
    if (!this.ctx) return;
    const t = this.now;
    const { o, g } = this._osc('sine', 1500, t, dur, 0.2);
    o.frequency.setValueAtTime(1500, t);
    o.frequency.exponentialRampToValueAtTime(380, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  /** Cartoon bonk: pitch-dropping thump + slap of noise. */
  bonk() {
    if (!this.ctx) return;
    const t = this.now;
    const { o, g } = this._osc('triangle', 320, t, 0.3, 0.5);
    o.frequency.setValueAtTime(320, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.25);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.35, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    src.connect(bp);
    bp.connect(ng);
    ng.connect(this.master);
    src.start(t);
    src.stop(t + 0.15);
  }

  /** Crowd "ooooh". */
  ooh() {
    if (!this.ctx) return;
    const t = this.now;
    for (const [f, vol] of [[220, 0.12], [277, 0.08], [330, 0.06]]) {
      const { o, g } = this._osc('sine', f, t, 1.1, vol);
      o.frequency.setValueAtTime(f * 1.12, t);
      o.frequency.exponentialRampToValueAtTime(f * 0.84, t + 1.0);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.15);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    }
  }

  tick() {
    if (!this.ctx) return;
    const t = this.now;
    const { g } = this._osc('square', 1800, t, 0.03, 0.05);
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
  }
}
