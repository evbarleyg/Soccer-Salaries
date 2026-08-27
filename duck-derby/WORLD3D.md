# Duck Derby World (3D) — architecture, performance, known gaps

`world.html` is a separate, Mario Kart–style 3D implementation of the Duck Derby
concept: 2–16 named ducks race a ~40 s course through seven sections to decide a
fantasy draft order. It shares only the duck identities (`src/ducks.js`), the
seeded RNG (`src/rng.js`) and the WebAudio synth (`src/audio.js`) with the 2D
game; the engine, randomness, renderer and page are its own.

## Run

```bash
npx http-server . -p 8080 -c-1        # from the repo root
open http://localhost:8080/duck-derby/world.html
cd duck-derby && npm run ci           # node --check + node:test (2D + 3D suites)
node tools/shots3d.mjs                # Playwright captures of every section → shots/world/
node tools/analyze3d.mjs 12 300       # Monte Carlo fairness/drama/item report
node tools/strip3d.mjs                # 4-frame filmstrips around key moments (hot dog, hit, Drop, lead, finish)
node tools/motion3d.mjs               # dense 9–12 frame motion strips via the deterministic __duckWorld.tick(dt) hook
node tools/flow3d.mjs                 # end-to-end phase flow check (grid → race → results → replay/TV/menu)
```

URL parameters mirror the 2D app: `names=a~b~c`, `seed=XXXX-XXXX`, `rule=w|l`,
`hz=0` (no hot dogs), plus `items=0`, `cam=<name|1-based lane>`,
`view=chase|tv|free`, `autostart=1`, `intro=0`, `sound=0`, `t=<seconds>`,
`q=low|mid|high`.

## Architecture

```
world.html / world.css        page shell, import map -> vendor/three (r160, no CDN)
src/world3d/
  course.js      headless course: tagged control points -> centripetal Catmull-Rom
                 centre line, eased water height/width per segment, banking,
                 The Drop hop arc, item-box positions, fast lookups
  items.js       8 items, position-weighted catch-up table, seeded per-duck brain
  race.js        deterministic 60 Hz engine: i.i.d. duck params, rubber band that
                 fades for the run-in, bursts/stumbles, section effects, lateral
                 wander + lily weave, item pickups/uses/brains, hornet/stone/
                 seagull projectiles, shields, feather, mud, crowd hot dogs at the
                 leader, takeoff/splashdown, drama curation (auditions sub-seeds)
  params.js      URL <-> config, cam resolution, draft order
  --- everything above is headless and covered by node:test ---
  gfx.js         renderer/quality tier, palette, gradient sky dome, lights
  track.js       Three-side frames over the course (banked water surface, toWorld)
  terrain.js     one vertex-coloured low-poly heightfield carved by the river,
                 per-section cross-section profiles (quays, cliffs, marsh, hill…)
  water.js       procedural toon-water shader (flowing caustics, foam, fresnel,
                 glints, fog), river ribbon (banked, weir face, rapids chop), sea
  scenery.js     all seven sections' set dressing (instanced crowd/trees/pads/
                 rocks/buoys, grandstands, blimp, waterfalls, rope + stone
                 bridges, frogs, weir, flume tube with light shafts + glow-worms,
                 lighthouse, piers, finish arch, podium barge, item boxes)
  ducks3d.js     ducks from primitives (palette, towel + number roundels)
  hats3d.js      16 procedural hats matching the 2D catalogue
  animate.js     bob, bank, drift, head pump, wing flaps, airborne pose, boost
                 squash/stretch, hop + 360° barrel roll, dizzy stars, shield, glow
  effects.js     pooled particle system (splash, spray, mustard, confetti,
                 fireworks) + projectile meshes placed as pure functions of time
  cameras.js     chase (track-space spring, FOV kick, shake, tunnel-safe), TV
                 director with auto-cuts, free-fly, fly-through, grid, finish, orbit
  hud.js         DOM HUD: position, gap, progress dots, minimap, item roulette,
                 commentary, banners, countdown, mud splat
  audio3d.js     WorldAudio extends the 2D synth (whoosh, item jingles, buzz,
                 screech, tunnel echo, stinger, fireworks)
  commentary3d.js seeded commentary incl. items/hazards/sections
  main.js        boot, setup UI, race director (phases + timeline), per-frame
                 orchestration, results/sharing, window.__duckWorld hooks
test/world3d.*.test.js   course, engine, items, params, Monte Carlo fairness
tools/shots3d.mjs        Playwright capture script (desktop + mobile)
tools/analyze3d.mjs      fairness/drama/item Monte Carlo report
tools/strip3d.mjs        filmstrips around key moments
tools/motion3d.mjs       dense motion strips (real frame stepping)
tools/flow3d.mjs         end-to-end phase flow check
```

The race is simulated up-front from `(names.length, seed)`; playback samples
per-duck distance/lateral/speed/held-item arrays and effect windows at time `t`,
so replays, TV cuts, `jump(t)` captures and the slow-motion photo finish are all
just different clocks over the same data. Projectiles record their `(s, lateral)`
path per tick so a hornet or hot dog is drawn mid-flight at any `t`.

### Fairness

Every per-duck parameter (pace, rhythm waves, kick, burst/stumble rates, item
brain, lateral wander) is drawn i.i.d.; course features treat whoever reaches
them identically; hazards and items key off race position only (leader, duck
ahead, back third) and the item table/brain are the same functions for everyone.
`test/world3d.fairness.test.js` runs 520 twelve-duck... (10-duck) races with items and
hot dogs on and checks win and last-place counts per lane with a chi-square test
(p = 0.01), plus a 16-duck variant; `world3d.items.test.js` checks pickups and
hits are evenly spread across ducks.

### Presentation systems

- **Race director** (`main.js`): boot → menu / join → fly-through (12 s first
  visit, 6.5 s after) → grid sweep that converges onto the race camera →
  0.8 s countdown with FOV squeeze → race → shaped slow-motion + freeze-frame
  letterbox verdict at the line → winner orbit with lower-third → slow-motion
  instant replay of the finish → podium barge + draft-order panel.
- **Identity**: each duck wears a rubber ring in its saddle-towel colour and
  number; a YOU/LEADER chevron marks the followed duck in every camera; name tags
  carry the number and are decluttered per frame in screen space.
- **Announcer** (`hud.js`): headline lane (priority queue, min hold), personal
  callouts anchored to your duck (BOOST!, ▲ passed X), moment cards, incoming
  projectile warning, item roulette, contextual standings ladder.
- **TV director** (`cameras.js`): seeded shot lengths, section-aware shots
  (start crane, canyon apex/dolly, lily low cam, weir cam, tunnel dolly/exit,
  rapids rock, finish cam) plus event cuts on lead changes and big hits.
- **Audio** (`audio3d.js`): procedural music loop (kick/hat, bass, arpeggio,
  stabs) layered by race intensity, ducked under stingers, low-passed in slow
  motion; tunnel echo send; item roulette ticks; haptics on phones.
- **Adaptive quality**: a frame-time percentile watchdog (ignores hitches and
  hidden-tab gaps, detects 30 Hz caps) sheds duck decals/particles first, then
  scenery density, then pixel ratio, and gives quality back when there is headroom.
- **Start together**: the host's Start opens a 45 s lobby with a QR code; the
  share link carries `go=<epoch ms>` so every phone counts down to the same
  moment; late joiners drop into the live race (or straight to the result).
- **Race engine v3** (`ENGINE_VERSION`): structured, permutation-symmetric drama
  curation; hot dogs and seagulls only as mid-race resets; item rows at
  26/44/72 %; calmer run-in; announced finishing kick; photo finishes ≈ 1 in 7.

## Performance

- One heightfield (≈55k verts), one river ribbon, instanced crowd (2 draws),
  trees, pads, rocks, buoys, flags; merged static geometry per structure.
- Duck parts are merged per material class and share one shader program (body,
  head+hat, wings, tail, decals: ~11 draws and ~3.5k triangles per duck, with
  far-LOD hiding of shadow/foam/wake/decals). Terrain and river are chunked for
  frustum culling, crowd/trees/houses/bunting are instanced per course section
  and whole sections are hidden when the camera is far from them, item boxes and
  mist are single instanced meshes, volumetric fakes render single-pass.
- Typical desktop frame at 1280×720 (12 ducks): grid line-up ≈ 170 draw calls /
  185k triangles, canyon chase ≈ 220 / 315k, TV canyon ≈ 165 / 225k, rapids
  chase ≈ 80 / 140k, podium ≈ 70 / 115k.
- Quality tiers (`detectQuality`, GPU-name aware so 8-core budget phones with
  weak Adreno/Mali/PowerVR parts land on low): pixel-ratio cap 2 / 1.5 / 1.25,
  MSAA only where pixels are big, cheaper water shader on mid/low,
  crowd/particle/tree density scaling; plus the adaptive quality ladder (decals → density → resolution) and
  half-rate / idle-stop rendering on menus.
- No shadow maps (blob shadows), no post-processing; fog hides the far field.

## Known gaps / next steps

- Chase cam avoids walls by living in track space rather than by raycasting.
- Lighting inside the tunnel dims globally while the camera is inside (the water
  is darkened by position); ducks seen from outside the tunnel are not darkened.
- Real-device frame-rate numbers still to be collected (headless captures run on
  software GL); the GPU-aware tiers and the adaptive ladder are the safety net.
- The sim uses `Math.sin/cos/pow` and branches on accumulated floats, so a shared
  race could in principle diverge between JS engines by an ulp; a golden test pins
  node's results per `ENGINE_VERSION`, but a WebKit/Gecko cross-check is still to do.
- A faint seam can show where the river ribbon meets the open-sea sheet in the
  harbour at grazing angles.
- Start-together sync relies on device clocks (`go=` is an epoch time); phones a
  few seconds off will start a few seconds off.
- Phase 3 (player-controlled multiplayer "Grand Prix" with tilt steering) is
  sketched in `PHASE3-MULTIPLAYER.md`.
