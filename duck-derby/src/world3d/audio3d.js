// WebAudio for the 3D world: reuses the 2D synth (beeps, horn, quacks,
// splashes, crowd, fanfare, whistle, bonk, ooh) and adds boost whooshes, item
// jingles, hornet buzz, seagull screech, shield pop, a tunnel echo send and a
// final-stretch stinger. No audio files.
import { DuckAudio } from '../audio.js';

export class WorldAudio extends DuckAudio {
  unlock() {
    super.unlock();
    if (!this.ctx || this.echo) return;
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

  setTunnel(amount) {
    if (!this.echo) return;
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
    [0, 0.07, 0.14, 0.21, 0.28].forEach((dt, k) => {
      const { g } = this._osc('square', 600 + k * 120 + (k % 2) * 200, t + dt, 0.06, 0.06);
      g.gain.setValueAtTime(0.06, t + dt); g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.06);
    });
    const { g } = this._osc('triangle', 1320, t + 0.42, 0.3, 0.2);
    g.gain.setValueAtTime(0.0001, t + 0.42); g.gain.exponentialRampToValueAtTime(0.22, t + 0.44); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
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
