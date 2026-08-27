# Phase 2 — "Duck Derby World" (Three.js, Mario Kart–style course)

Not a 3D camera on the swimming pool. A full Mario Kart–style race through a
navigable 3D world: a winding water course with turns, drops, tunnels, jumps,
shortcuts-that-aren't, crowds and scenery, item-style hazards, chase camera
behind *your* duck. Each manager opens the shared link on their own device,
picks their duck and rides along; a TV/spectator camera works for the big
screen. The 2D game's duck identities (palettes, hats, numbers) carry over so
everyone recognises their racer.

## The one rule that keeps it fair and replayable

The existing seeded engine (`duck-derby/src/sim.js`) remains the single
source of truth for the OUTCOME. It produces, for every duck, distance along
the course over time (`positionAt(sim, i, t)` in 0..TRACK_LENGTH), speed, and
timed events (`burst`, `stumble`, `hotdog`, `lead`, `stretch`, `finish`).
The 3D game maps that 1D distance onto a 3D spline course: `s = x / TRACK_LENGTH`
→ `curve.getPointAt(s)`, tangent → heading. Everything else — lateral lane
offsets, jostling, drifting wide in corners, leaning, hops off ramps, spray,
item hits — is presentation layered on top and must never change who is ahead
*along the spline*. Same link ⇒ same finishing order as `index.html`.
No `Math.random()` for anything outcome-affecting (visual randomness fine;
prefer a seeded RNG from `src/rng.js` so replays even *look* the same).

If you want extra world-specific drama events (e.g. "whirlpool grabs the
leader", "log bump"), add them the way `hotdog` was added in `sim.js`:
seeded, symmetric across ducks (target by race position, never by name/lane),
covered by `test/fairness.test.js` — and propose the sim change in your PR
description since another session owns that file; until then, drive all
hazards visually from the existing `stumble`/`hotdog` events.

## World & course

Design one signature course (~40 s at default pace, matching `len=38`), built
procedurally in code (no external models required; small CC0 textures optional
but the look should not depend on them):

1. **Start — Duck Village marina**: pontoon start gates, bunting, grandstands
   packed with bobbing instanced spectators, PA towers, blimp overhead.
2. **River canyon S-bends**: banked turns between rock walls, buoy lines mark
   the ideal line, waterfalls down the cliff faces, pine trees, birds.
3. **Lily-pad chicane**: giant lily pads and reeds the ducks weave through
   (lateral weaving is cosmetic, synced to their rhythm waves), frogs that
   leap as the pack passes.
4. **The Drop**: a weir/waterfall ramp — ducks go airborne (hop arc driven by
   course position, everyone gets it), big splashdown, camera dips.
5. **Log-flume tunnel**: dark wooden tunnel with light shafts and glow-worms,
   echoing audio, speed-streak effect; exits into…
6. **Rapids**: choppy shader water, rocks, foam; `stumble` events here read
   as bonking a rock (stars), `burst` as catching a current (boost flames…
   er, bubbles).
7. **Harbor finish**: lighthouse, cheering crowds on piers, chequered arch,
   fireworks + confetti cannons on finish, podium barge for the results.

Hazards/items presentation (all driven by existing sim events):
- `hotdog` (targets the leader): a spectator on a bridge/boat lobs a hot dog
  — visible wind-up and arc (launch ~0.8 s before the event time; the race is
  precomputed so look ahead in `sim.events`), impact → hop + 360° barrel roll
  (~0.95 s), mustard/ketchup particle burst, orbiting stars, crowd "OOH".
- `stumble`: context-specific bonk (rock, lily pad, log) + wobble.
- `burst`: boost — squash/stretch, speed lines, spray rooster-tail, FOV kick
  for the chase cam if it's your duck.
- `lead` change: brief "1st!" toast if it's your duck; TV cam cut.
- `stretch`: final-stretch banner, music intensity up.
- Photo finish (`sim.photoFinish`): slow-mo 0.3× for the leader's last ~3%,
  freeze-frame flash at the line.

## Ducks

Rebuild the 2D ducks in 3D from primitives (ellipsoid body, sphere head,
rounded cone beak, eyes with highlights, tail wedge, wing ellipsoids that
flap), coloured from each duck's palette in `src/ducks.js` (`assignLooks`
gives palette, hat id, towel colours, number), a number roundel decal
(CanvasTexture) on each flank, and a distinct 3D take on each of the 16 hats
(top hat, crown, cowboy, viking, pirate bandana + eye patch, aviators,
sweatband, bow, propeller beanie (spins), snorkel, chef toque, wizard, party
hat, flower crown, headphones, jockey cap). Animation: bob and pitch on the
waves, lean/bank into turns (from spline curvature), head pump with effort,
wing flaps on bursts, drift-style tail-out in sharp corners (cosmetic yaw
offset), airborne pose off the Drop, dizzy wobble, barrel roll.

## Cameras & flow

- **Chase cam** (default when `cam=` is set): spring-damped, ~3.5 m behind /
  1.6 m above, looks ahead along the spline, banks slightly with turns, FOV
  kick on bursts, shake on impacts, roll-stabilised during barrel rolls,
  never clips through tunnel walls (pull in when occluded).
- **TV cam**: helicopter overview, corner-apex fixed cams, water-level dolly,
  auto-cuts on lead changes and big events; this is the screen-share view.
- **Photo/finish cam** and **winner orbit**; podium barge scene for results.
- Flow: load → course fly-through (skippable) → grid line-up with names →
  3-2-1-GO → race → results overlay (draft order: winner-first, reversed when
  `rule=l`) with Replay / Switch duck / Back to 2D (`index.html` + same
  params) / Copy share link.
- HUD: position ("P3/12"), gap to leader in metres, lap-style progress bar
  with per-duck dots, minimap of the spline with dots, item-hit popups,
  current leader, optional commentary line (you may reuse `src/commentary.js`
  and `src/audio.js`; add engine-free "paddle" loops, splashes, tunnel reverb,
  crowd, music stingers via WebAudio — no audio files required).
- Controls: none needed to race (it's a fair auto-race), but let the viewer
  look around (drag to orbit slightly, pinch/scroll zoom within limits),
  switch target (tap a duck / picker / keys 1-9,[ ]), switch camera (C), and
  toggle a free-fly spectator camera (F) to explore the world — that is the
  "navigable" part; keep it collision-light but don't fall through water.

## Tech constraints

- Static files only (GitHub Pages). No bundler, no npm deps. Three.js
  `0.160.0` as ES modules via import map from jsdelivr
  (`https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js`,
  addons under `/examples/jsm/`). Post-processing allowed if it stays fast
  (bloom on boosts/fireworks is nice-to-have; gate it by device).
- Performance: 60 fps target on a mid-range phone. Instancing for crowd,
  buoys, trees, rocks; capped pixel ratio (≤2); cheap/blob shadows; LOD or
  density scaling by device; frustum-friendly chunking of the course.
- URL params identical to the 2D app: `names=a~b~c` (URI-encoded, `~`
  separated), `seed=XXXX-XXXX` (`codeToSeed` in `src/rng.js`), `len`
  (24|38|55 → also scales course pacing), `rule` (w|l), `salt`, `hz` (0 = no
  hot dogs), plus `cam=<duck name | 1-based lane>` and `view=tv|chase|free`.
- Files: `duck-derby/world.html` (entry), `duck-derby/src/world3d/**.js`,
  `duck-derby/tools/shots3d.mjs`. You may extend the `check` glob in
  `duck-derby/package.json`. Do not edit `index.html`, `styles.css`,
  `src/main.js`, `src/scene.js`, `src/draw-duck.js`, `src/sim.js`,
  `src/ducks.js` or tests (the 2D session owns them and will link
  "Enter Duck Derby World" → `world.html?<same params>`). Any earlier draft
  under `src/cam3d/` / `duckcam.html` is disposable — reuse or delete.
- Headless captures: Playwright is installed globally (see the import shim in
  `tools/shots.mjs`); launch Chromium with
  `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`;
  expose `window.__duckWorld = { state, jump(t), setTarget(i), setView(v) }`
  so captures are deterministic. Capture: fly-through, grid, canyon chase,
  lily chicane, the Drop mid-air, tunnel, hot-dog impact, rapids, finish,
  results — at 1280×720 and 390×844 — and iterate on what you see.

## Definition of done

`world.html?names=…&seed=…` reproduces the exact finishing order of
`index.html` for the same params; the course has all seven sections with
distinct looks; chase/TV/free cameras work; hot-dog spin-outs, the Drop,
tunnel and fireworks finish all land; smooth on phone + laptop; no console
errors; `cd duck-derby && npm run ci` passes; screenshots for every section;
short write-up of architecture, perf numbers, known gaps.
