// Player input for the live (steer-your-own-duck) modes: keyboard, touch halves and device tilt, merged into a
// single steer value in [-1, 1] (+ = steer left, matching the course's +lat = left convention).
export class SteerInput {
  constructor(target = window) {
    this.keys = new Set();
    this.touchDir = 0;
    this.tilt = { on: false, base: null, value: 0 };
    this.steer = 0; // smoothed output
    this.raw = 0;
    target.addEventListener('keydown', (e) => { this.keys.add(e.key); });
    target.addEventListener('keyup', (e) => { this.keys.delete(e.key); });
    const touch = (e) => {
      if (e.pointerType === 'mouse' && e.buttons === 0 && e.type !== 'pointerup') return;
      if (e.type === 'pointerup' || e.type === 'pointercancel' || e.type === 'pointerleave') { this.touchDir = 0; return; }
      if (e.target && e.target.closest && e.target.closest('button, .panel, #hud-menu, #picker')) return;
      this.touchDir = e.clientX < window.innerWidth / 2 ? 1 : -1; // left half = steer left
    };
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave']) target.addEventListener(t, touch, { passive: true });
    this._onTilt = (e) => {
      if (!this.tilt.on) return;
      // portrait: gamma = left/right tilt; landscape: beta (sign depends on which way the phone is turned)
      const landscape = window.innerWidth > window.innerHeight;
      const angle = landscape ? (screen.orientation && screen.orientation.angle === 90 ? -e.beta : e.beta) : e.gamma;
      if (angle === null || angle === undefined) return;
      if (this.tilt.base === null) this.tilt.base = angle;
      this.tilt.value = Math.max(-1, Math.min(1, -(angle - this.tilt.base) / 22)); // ~22 degrees for full lock
    };
    window.addEventListener('deviceorientation', this._onTilt);
  }

  /** Ask for motion permission where needed (iOS) and start steering by tilt. Must be called from a user gesture. */
  async enableTilt() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') return false;
      }
    } catch { return false; }
    this.tilt.on = true;
    this.tilt.base = null; // recalibrate: however the phone is held now is "straight"
    return true;
  }
  disableTilt() { this.tilt.on = false; this.tilt.value = 0; }
  recalibrate() { this.tilt.base = null; }

  /** Call once per frame; returns smoothed steer in [-1, 1]. */
  update(dt) {
    let k = 0;
    if (this.keys.has('ArrowLeft') || this.keys.has('a') || this.keys.has('A')) k += 1;
    if (this.keys.has('ArrowRight') || this.keys.has('d') || this.keys.has('D')) k -= 1;
    let raw = k !== 0 ? k : this.touchDir !== 0 ? this.touchDir : this.tilt.on ? this.tilt.value : 0;
    raw = Math.max(-1, Math.min(1, raw));
    this.raw = raw;
    const rate = Math.abs(raw) > Math.abs(this.steer) ? 9 : 6; // snappy in, softer out
    this.steer += (raw - this.steer) * Math.min(1, dt * rate);
    return this.steer;
  }
}
