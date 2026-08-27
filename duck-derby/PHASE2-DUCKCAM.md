# Phase 2 — "Duck Derby World" (Three.js, Mario Kart–style course)

Not a 3D camera on the swimming pool. A full Mario Kart–style race through a
navigable 3D world: a winding water course with turns, drops, tunnels, jumps,
shortcuts-that-aren't, crowds and scenery, item-style hazards, chase camera
behind *your* duck. Each manager opens the shared link on their own device,
picks their duck and rides along; a TV/spectator camera works for the big
screen. The 2D game's duck identities (palettes, hats, numbers) carry over so
everyone recognises their racer.

## Relationship to the 2D game

This is a **fully separate implementation** of the same concept, not a 3D
camera on the 2D race and not bound to its engine or share links. Reuse what
helps — the duck identities in `src/ducks.js` (palettes, 16 hats, towel
numbers, `assignLooks`), the seeded RNG in `src/rng.js`, ideas from
`src/sim.js`, the synth audio — but the 3D game owns its own race logic.

What must carry over is the *contract*, not the code:
- **Random but fair**: who wins must be genuinely random with every duck
  having the same chance (parameters drawn i.i.d.; hazards target race
  positions such as "the leader", never a name or lane). Include a headless
  Monte Carlo fairness test like `test/fairness.test.js`.
- **Seeded & replayable**: a race is reproducible from (names, seed) so a
  league can share a link and everyone sees the same result; expose the seed.
- **Dramatic**: rubber-banding that fades for the run-in, bursts, stumbles,
  lead changes, photo finishes, item hits — tuned for a ~40 s race.

A good architecture is still "simulate progress along the course
deterministically from the seed (1D distance per duck over time + timed
events), then render it on a 3D spline course", because it makes replays,
slow-mo and camera cuts trivial — but that simulation lives in the 3D game's
own modules and can model course features (currents, the Drop, rapids) directly.

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

Hazards/items (drive them from your sim's timed events so replays match):
- Hot dog (targets the leader): a spectator on a bridge/boat lobs a hot dog
  — visible wind-up and arc (launch ~0.8 s before the event time; the race is
  precomputed so look ahead in `sim.events`), impact → hop + 360° barrel roll
  (~0.95 s), mustard/ketchup particle burst, orbiting stars, crowd "OOH".
- Stumble: context-specific bonk (rock, lily pad, log) + wobble.
- Burst: boost — squash/stretch, speed lines, spray rooster-tail, FOV kick
  for the chase cam if it's your duck.
- Lead change: brief "1st!" toast if it's your duck; TV cam cut.
- Final stretch: banner, music intensity up.
- Photo finish: slow-mo 0.3× for the leader's last ~3%,
  freeze-frame flash at the line.

## Items & autonomous item use (Mario Kart style)

Item boxes float at fixed points on the course (after the first S-bend, before
the Drop, mid-rapids). Passing through one grants an item chosen by a seeded,
position-weighted table — catch-up logic like Mario Kart: the further back a
duck is, the better its odds of a strong item. Each duck has a small seeded
"brain" that decides *when* to fire (e.g. hold a shield while leading, fire a
homing item when within N metres of the duck ahead, boost on corner exit).
All of it runs inside the seeded simulation so a replay shows the same item
rolls and the same decisions, and fairness holds because tables/brains are
identical for every duck and keyed only on race position. Suggested set:

- **Bread Boost** (mushroom): short burst; commonest item.
- **Triple Bread**: three boosts the brain spaces out.
- **Homing Hornet** (red shell): flies up the course to the duck directly
  ahead → spin-out. Blockable by a held shield.
- **Skipping Stone** (green shell): fired straight; hits the first duck in its
  path or skips off harmlessly.
- **Bubble Shield**: absorbs one hit; held behind the duck visibly.
- **Squid Ink... er, Mud Splat**: brief muddy screen for the ducks *ahead*
  (visual on their chase cams; tiny slowdown).
- **Golden Goose Feather** (star): rare, back-of-pack only; invulnerable +
  fast for a few seconds, plows through others (they wobble, no big loss).
- **Thundercloud / Seagull Strike** (blue shell): very rare, only rolls for
  the last third of the field; a seagull dive-bombs whoever is leading.
- Crowd **hot dog** stays as a non-item ambient hazard aimed at the leader.

Show item state in the HUD (slot with icon, roulette spin on pickup), over
each duck (small held-item icon), and announce big hits in the commentary.
Tune so items create 2–4 meaningful swings per race without making the last
10% pure chaos (e.g. no new blue-shell rolls once the leader passes 90%).
Cover with tests: item distribution by position is symmetric across ducks,
brains are deterministic for a seed, win-rate chi-square still passes.

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

- Static files only (GitHub Pages). No bundler, no runtime npm deps.
  **Vendor Three.js into the repo** rather than using a CDN: the Claude
  sandbox's egress proxy blocks `cdn.jsdelivr.net` (CONNECT 403) but
  `registry.npmjs.org` works, so run `npm pack three@0.160.0`, copy
  `build/three.module.js` (and any `examples/jsm/` addons you use) into
  `duck-derby/vendor/three/`, and point an import map at those local files
  (`"three": "./vendor/three/three.module.js"`, `"three/addons/": "./vendor/three/addons/"`).
  This also makes the deployed game independent of third-party CDNs.
  Post-processing allowed if it stays fast (bloom on boosts/fireworks is
  nice-to-have; gate it by device). Headless Chromium here does provide
  WebGL2 with the swiftshader flags below.
- Performance: 60 fps target on a mid-range phone. Instancing for crowd,
  buoys, trees, rocks; capped pixel ratio (≤2); cheap/blob shadows; LOD or
  density scaling by device; frustum-friendly chunking of the course.
- URL params: keep the 2D app's conventions where sensible so links feel
  familiar — `names=a~b~c` (URI-encoded, `~` separated), `seed=XXXX-XXXX`
  (see `codeToSeed` in `src/rng.js`), `rule` (w|l = winner or last place
  picks first), `hz` (0 = no hot dogs) — plus `cam=<duck name | 1-based
  lane>` and `view=tv|chase|free`. A setup screen for entering 8/10/12/…
  names (2–16) is required, like the 2D app's.
- Files: `duck-derby/world.html` (entry), `duck-derby/src/world3d/**.js`,
  `duck-derby/tools/shots3d.mjs`. You may extend the `check` glob in
  `duck-derby/package.json`. Do not edit `index.html`, `styles.css`,
  `src/main.js`, `src/scene.js`, `src/draw-duck.js`, `src/sim.js`,
  `src/ducks.js` or the existing tests (the 2D session owns them and will add
  an "Enter Duck Derby World" link to `world.html`). Put your own engine and
  tests under `src/world3d/` and `test/world3d.*.test.js`. Any earlier draft
  under `src/cam3d/` / `duckcam.html` is disposable — reuse or delete.
- Headless captures: Playwright is installed globally (see the import shim in
  `tools/shots.mjs`); launch Chromium with
  `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`;
  expose `window.__duckWorld = { state, jump(t), setTarget(i), setView(v) }`
  so captures are deterministic. Capture: fly-through, grid, canyon chase,
  lily chicane, the Drop mid-air, tunnel, hot-dog impact, rapids, finish,
  results — at 1280×720 and 390×844 — and iterate on what you see.

## Definition of done

`world.html` runs a fair, seeded, replayable race of 2–16 named ducks (same
names + seed ⇒ same result, verified by a fairness test); the course has all seven sections with
distinct looks; chase/TV/free cameras work; hot-dog spin-outs, the Drop,
tunnel and fireworks finish all land; smooth on phone + laptop; no console
errors; `cd duck-derby && npm run ci` passes; screenshots for every section;
short write-up of architecture, perf numbers, known gaps.
