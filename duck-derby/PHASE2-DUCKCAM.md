# Phase 2 — "Duck Cam 3D" (Three.js chase-camera view)

Goal: each manager opens the shared race link on their own phone/laptop, picks
their duck, and rides a third-person chase camera behind it through the *same*
seeded race the 2D broadcast view shows. Mario Kart energy: water spray, buoys
streaming past, rivals alongside, hot dogs incoming from the stands, barrel-roll
spin-outs, photo-finish slow-mo, winner fly-around.

## Non-negotiables

- Static files only (GitHub Pages). No bundler. Load Three.js as an ES module
  via an import map from a pinned CDN URL, e.g.
  `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js`
  (and `three/addons/` → `https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/`).
- Reuse the existing deterministic engine — do NOT fork the maths:
  `import { createRace, positionAt, speedAt, standingsAt, TRACK_LENGTH } from './src/sim.js'`
  and looks from `src/ducks.js` (`assignLooks`, `PALETTES`, `TOWELS`). Same
  inputs ⇒ same finish order as the 2D view. Never call Math.random() for
  anything that affects outcomes (visual-only randomness is fine).
- Accept the same URL params as the 2D app: `names=a~b~c` (URI-encoded,
  `~`-separated), `seed=XXXX-XXXX` (see `codeToSeed` in src/rng.js), `len`
  (24|38|55), `rule` (w|l), `salt` (int), `hz` (0 = hazards off), plus
  `cam=<duck name or 1-based lane number>` to choose whose duck to follow.
- New files only: `duckcam.html`, `src/cam3d/*.js` (as many modules as you
  like), `tools/shots3d.mjs`. Do not edit index.html / src/main.js /
  src/scene.js / styles.css (another workstream owns them); the 2D results
  screen will link to `duckcam.html?<same params>` later.
- Keep `npm run ci` green (extend the `check` script glob in package.json to
  include `src/cam3d/*.js`).

## Scene spec

- Course: straight canal, TRACK_LENGTH sim units mapped to ~100 m of world Z
  (or X). Lanes ~1.2 m apart with buoy lines (InstancedMesh spheres,
  alternating red/white, yellow every 5th), start pontoon, finish arch with a
  chequered banner (CanvasTexture) and flags, distance boards at 25/50/75 m.
- Water: large plane with animated vertex waves (custom ShaderMaterial or
  onBeforeCompile on MeshStandardMaterial), fresnel-ish tint, foam wake
  ribbons/particles behind each duck scaled by speed, splash bursts on sim
  'burst' events, bow spray at high effort.
- Venue: grandstands along both banks (instanced coloured boxes as crowd that
  bob when `cheer` is high), striped roofs, bunting, trees (cones+cylinders),
  hills, gradient sky dome, sun (directional) + hemisphere light, light fog.
  Cheap shadows (or blob shadows) — must hold 60 fps on a mid-range phone;
  cap renderer pixelRatio at 2; scale crowd instance count by device.
- Ducks: built from primitives (ellipsoid body, sphere head, cone/rounded
  beak, eyes, tail wedge, wings as flattened ellipsoids that flap), coloured
  from the duck's palette (body/wing/beak/head/ring for the mallard), number
  roundel as a small CanvasTexture disc on each flank using TOWELS colours,
  and a recognisable 3D take on each of the 16 hats in src/ducks.js (simple
  primitive compositions are fine; silhouettes must differ).
  Animation: bob, pitch with waves, lean into speed, head pump, wing flaps on
  bursts, dizzy wobble on 'stumble', and on 'hotdog': a hop + 360° barrel roll
  over ~0.95 s with mustard/ketchup particle burst and orbiting stars after.
- Hot dog: mesh (capsule sausage, half-torus/extruded bun, yellow squiggle),
  lobbed from the near grandstand in a parabola, launched ~0.8 s before the
  sim 'hotdog' event time so it lands exactly on the leader at event time
  (the race is precomputed — look ahead in `sim.events`).
- Cameras: (1) Chase cam: spring-damped follow ~3.5 m behind / 1.6 m above
  the chosen duck, look-at slightly ahead, subtle FOV kick on bursts, shake on
  impacts, roll-stabilised during the duck's barrel roll. (2) TV cam: cycles
  leader / pack / low water-level dolly. (3) Finish: when the followed duck
  finishes, ease into an orbit; when the winner finishes, brief slow-mo
  (playback rate 0.3) if `sim.photoFinish`. Tap/click or keys 1-9 / [ ] to
  switch target; a small picker lists ducks with their numbers/colours.
- Flow: load → lane intro fly-over (2–3 s) → 3-2-1-GO (DOM overlay) → race
  (clock = real time × rate, same pacing idea as src/main.js: advance `t`,
  consume `sim.events` in order) → results overlay with the draft order
  (winner-first, or reversed when rule=l) and buttons: Replay, Switch duck,
  Back to 2D view (index.html with same params).
- HUD (DOM): "P3 / 12", gap to leader in metres ((leaderX - x)/10), progress
  bar with per-duck dots, current leader name, mini commentary line optional.
- Audio: optional; may import `DuckAudio` from src/audio.js (user-gesture
  unlock required).
- Headless capture: tools/shots3d.mjs using Playwright (see tools/shots.mjs
  for the global-install import shim); launch Chromium with
  `args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']`
  so WebGL works headless; expose `window.__duckCam = { jump(t), state }` for
  deterministic captures like the 2D app does.

## Definition of done

duckcam.html?names=…&seed=… plays the identical race outcome as index.html
with the same params, follows the chosen duck, looks great on a phone and a
laptop, no console errors, `npm run ci` passes, screenshots captured for
countdown / mid-race chase / hot-dog impact / finish / results.
