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

## Performance

- One heightfield (≈55k verts), one river ribbon, instanced crowd (2 draws),
  trees, pads, rocks, buoys, flags; merged static geometry per structure.
- Typical frame: ~430 draw calls / ~470k triangles on desktop at the grid (all
  16 ducks close); fewer mid-race. Quality tiers (`detectQuality`): pixel-ratio
  cap 2 / 1.75 / 1.25, antialias off on low, crowd/particle/tree density scaling.
- No shadow maps (blob shadows), no post-processing; fog hides the far field.

## Known gaps / next steps

- Music loop is a stinger + fanfare rather than a full track.
- Chase cam avoids walls by living in track space rather than by raycasting.
- No per-object darkness inside the tunnel (global light dim while the camera is inside).
