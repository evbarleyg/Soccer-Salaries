// WebAudio for the 3D world: reuses the 2D synth (beeps, horn, quacks,
// splashes, crowd, fanfare, whistle, bonk, ooh) and adds boost whooshes, item
// jingles, hornet buzz, seagull screech, shield pop, a tunnel echo send and a
// final-stretch stinger. No audio files.
import { DuckAudio } from '../audio.js';

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

export class WorldAudio extends DuckAudio {
  unlock() {
    super.unlock();
    if (!this.ctx) return;
    if (!this.toneBus) {
      // everything musical/one-shot goes through a tone bus so slow-motion can low-pass it
      this.toneBus = this.ctx.createBiquadFilter();
      this.toneBus.type = 'lowpass';
      this.toneBus.frequency.value = 20000;
      this.toneBus.connect(this.master);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.0001;
      this.musicGain.connect(this.toneBus);
      this.music = { on: false, next: 0, step: 0, intensity: 0, target: 0.3, duck: 1 };
    }
    if (this.echo) return;
    // tunnel echo: master -> delay -> feedback -> destination (wet gain toggled)
    const delay = this.ctx.createDelay(0.6);
    delay.delayTime.value = 0.23;
    const fb = this.ctx.createGain();
    fb.gain.value = 0.42;
    const wet = this.ctx.createGain();
    wet.gain.value = 0;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    this.master.connect(delay);
    delay.connect(lp);
    lp.connect(fb);
    fb.connect(delay);
    lp.connect(wet);
    wet.connect(this.ctx.destination);
    this.echo = wet;
  }

  /** Soft paddling loop for the followed duck: little filtered noise strokes at foot cadence (call every frame). */
  paddle(speedFrac, active) {
    if (!this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    if (!active || speedFrac < 0.15) { this._nextPaddle = now + 0.1; return; }
    if (this._nextPaddle === undefined) this._nextPaddle = now;
    const interval = 0.34 / Math.max(0.5, Math.min(1.8, speedFrac)); // faster duck, quicker strokes
    let guard = 0;
    while (this._nextPaddle < now + 0.12 && guard++ < 3) {
      const t = Math.max(now, this._nextPaddle);
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 500 + Math.random() * 300;
      bp.Q.value = 1.4;
      const g = this.ctx.createGain();
      const v = 0.05 + 0.05 * Math.min(1, speedFrac);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      src.connect(bp); bp.connect(g); g.connect(this.master);
      src.start(t, Math.random() * 2); src.stop(t + 0.13);
      this._nextPaddle += interval * (0.85 + Math.random() * 0.3);
    }
  }

  // ---------------------------------------------------------------- music
  /** Start the procedural loop (124 bpm, A minor): kick/hat, bass ostinato, arpeggio, stabs — layered by intensity. */
  startMusic() {
    if (!this.ctx || !this.music || this.music.on) return;
    this.music.on = true;
    this.music.next = this.ctx.currentTime + 0.1;
    this.music.step = 0;
  }
  stopMusic() {
    if (!this.music) return;
    this.music.on = false;
    if (this.musicGain) this.musicGain.gain.setTargetAtTime(0.0001, this.now, 0.3);
  }
  /** 0..1: how many layers / how loud. */
  setMusicIntensity(x) { if (this.music) this.music.target = Math.max(0, Math.min(1, x)); }
  /** Call every frame: schedules notes a little ahead of time. */
  pumpMusic() {
    const m = this.music;
    if (!this.ctx || !m || !m.on) return;
    const now = this.ctx.currentTime;
    m.intensity += (m.target - m.intensity) * 0.05;
    const level = (0.05 + 0.22 * m.intensity) * m.duck;
    if (this._changed('music', level, 0.004)) this.musicGain.gain.setTargetAtTime(level, now, 0.2);
    const spb = 60 / 124 / 4; // 16th notes
    const BASS = [45, 45, 0, 45, 48, 48, 0, 48, 43, 43, 0, 43, 40, 40, 0, 52]; // midi, 0 = rest (A, C, G, E)
    const ARP = [69, 72, 76, 81, 72, 76, 81, 84, 67, 71, 74, 79, 64, 67, 71, 76];
    while (m.next < now + 0.15) {
      const s = m.step % 16;
      const t = m.next;
      const it = m.intensity;
      // kick
      if (s % 4 === 0) this._kick(t, 0.5);
      // hats: off-beats, 16ths when intense
      if (s % 4 === 2 || (it > 0.75 && s % 2 === 1)) this._hat(t, s % 4 === 2 ? 0.16 : 0.08);
      // clap on 4 and 12
      if (it > 0.35 && (s === 4 || s === 12)) this._clap(t, 0.18);
      // bass
      if (it > 0.2 && BASS[s]) this._note('sawtooth', midi(BASS[s] - 12), t, spb * 1.6, 0.16, 420 + it * 500);
      // arp
      if (it > 0.55) this._note('triangle', midi(ARP[(s + Math.floor(m.step / 16) * 4) % 16]), t, spb * 0.9, 0.07 + 0.05 * it, 3000);
      // stabs in the final stretch
      if (it > 0.9 && (s === 0 || s === 6 || s === 10)) { this._note('square', midi(57), t, spb * 1.2, 0.05, 1800); this._note('square', midi(64), t, spb * 1.2, 0.05, 1800); }
      m.next += spb;
      m.step++;
    }
  }
  _kick(t, v) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g); g.connect(this.musicGain);
    o.start(t); o.stop(t + 0.25);
  }
  _hat(t, v) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(hp); hp.connect(g); g.connect(this.musicGain);
    src.start(t, Math.random() * 1.5); src.stop(t + 0.06);
  }
  _clap(t, v) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 0.9;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    src.connect(bp); bp.connect(g); g.connect(this.musicGain);
    src.start(t, Math.random()); src.stop(t + 0.14);
  }
  _note(type, freq, t, dur, v, cutoff) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f); f.connect(g); g.connect(this.musicGain);
    o.start(t); o.stop(t + dur + 0.02);
  }
  /** Dip the music under a stinger/fanfare. */
  duckMusic(sec = 1) {
    if (!this.music) return;
    this.music.duck = 0.4;
    clearTimeout(this._duckT);
    this._duckT = setTimeout(() => { if (this.music) this.music.duck = 1; }, sec * 1000);
  }
  /** Slow-motion feel: low-pass everything tonal while rate < 1. */
  setRate(rate) {
    if (!this.toneBus) return;
    if (!this._changed('rate', rate, 0.02)) return;
    const f = rate < 0.95 ? 700 + 5000 * rate * rate : 20000;
    this.toneBus.frequency.setTargetAtTime(f, this.now, 0.08);
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended' && this.enabled) this.ctx.resume(); }

  /** Only forward a parameter change to the audio thread when it actually moved. */
  _changed(key, value, eps = 0.01) {
    this._last = this._last || {};
    if (this._last[key] !== undefined && Math.abs(this._last[key] - value) < eps) return false;
    this._last[key] = value;
    return true;
  }

  setTunnel(amount) {
    if (!this.echo) return;
    if (!this._changed('tunnel', amount)) return;
    this.echo.gain.setTargetAtTime(0.55 * amount, this.now, 0.2);
    if (this.waterGain) this.waterGain.gain.setTargetAtTime(0.05 + 0.06 * amount, this.now, 0.3);
  }

  whoosh(vol = 0.3) {
    if (!this.ctx) return;
    const t = this.now;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + 0.35);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    src.connect(bp); bp.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + 0.6);
    const { o, g: og } = this._osc('sawtooth', 90, t, 0.5, 0.1);
    o.frequency.exponentialRampToValueAtTime(260, t + 0.4);
    og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(0.08, t + 0.05); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
  }

  itemGet() {
    if (!this.ctx) return;
    const t = this.now;
    // roulette: ticks slowing down, then a ding as the item settles (~0.75 s, matches the HUD roll)
    let dt = 0;
    for (let k = 0; k < 10; k++) {
      const { g } = this._osc('square', 700 + (k % 3) * 160, t + dt, 0.04, 0.05);
      g.gain.setValueAtTime(0.05, t + dt); g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.04);
      dt += 0.04 + k * 0.009;
    }
    const { g } = this._osc('triangle', 1320, t + 0.76, 0.3, 0.2);
    g.gain.setValueAtTime(0.0001, t + 0.76); g.gain.exponentialRampToValueAtTime(0.22, t + 0.78); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.05);
  }

  itemUse() {
    if (!this.ctx) return;
    const t = this.now;
    const { o, g } = this._osc('triangle', 500, t, 0.25, 0.2);
    o.frequency.exponentialRampToValueAtTime(1200, t + 0.2);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.2, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
  }

  buzz(dur = 0.8, vol = 0.12) {
    if (!this.ctx) return;
    const t = this.now;
    const { o, g } = this._osc('sawtooth', 150, t, dur, vol);
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 23;
    const lg = this.ctx.createGain();
    lg.gain.value = 40;
    lfo.connect(lg); lg.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.08); g.gain.setValueAtTime(vol, t + dur - 0.2); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lfo.start(t); lfo.stop(t + dur + 0.05);
  }

  screech() {
    if (!this.ctx) return;
    const t = this.now;
    for (const [f0, dt] of [[1700, 0], [1500, 0.18], [1900, 0.34]]) {
      const { o, g } = this._osc('square', f0, t + dt, 0.2, 0.08);
      o.frequency.setValueAtTime(f0, t + dt); o.frequency.exponentialRampToValueAtTime(f0 * 0.7, t + dt + 0.16);
      g.gain.setValueAtTime(0.0001, t + dt); g.gain.exponentialRampToValueAtTime(0.09, t + dt + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.18);
    }
  }

  pop() {
    if (!this.ctx) return;
    const t = this.now;
    const { o, g } = this._osc('sine', 400, t, 0.15, 0.3);
    o.frequency.exponentialRampToValueAtTime(1600, t + 0.08);
    g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
  }

  blip(up = true) {
    if (!this.ctx) return;
    const t = this.now;
    const [f1, f2] = up ? [660, 880] : [520, 390];
    [[f1, 0], [f2, 0.09]].forEach(([f, dt]) => {
      const { g } = this._osc('triangle', f, t + dt, 0.09, 0.14);
      g.gain.setValueAtTime(0.0001, t + dt); g.gain.exponentialRampToValueAtTime(0.14, t + dt + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.09);
    });
  }

  tom() {
    if (!this.ctx) return;
    const t = this.now;
    const { o, g } = this._osc('sine', 160, t, 0.4, 0.4);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.3);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
  }

  bigSplash() { this.splash(0.5); setTimeout(() => this.splash(0.35), 90); }

  stinger() {
    if (!this.ctx) return;
    this.duckMusic(1.2);
    const t = this.now;
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, k) => {
      const { g } = this._osc('triangle', f, t + k * 0.09, 0.25, 0.16);
      g.gain.setValueAtTime(0.0001, t + k * 0.09); g.gain.exponentialRampToValueAtTime(0.16, t + k * 0.09 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + k * 0.09 + 0.3);
    });
  }

  boom() {
    if (!this.ctx) return;
    const t = this.now;
    const { o, g } = this._osc('sine', 120, t, 0.6, 0.4);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.5);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2500;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t + 0.05); ng.gain.exponentialRampToValueAtTime(0.12, t + 0.1); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    src.connect(hp); hp.connect(ng); ng.connect(this.master);
    src.start(t); src.stop(t + 1);
  }
}
