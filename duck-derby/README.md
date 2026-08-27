# 🦆 Duck Derby — Fantasy Draft Order Race

Race a flock of gloriously animated ducks down the pond to decide your fantasy
football draft order. Type 8, 10, 12 (or anything from 2–16) manager names,
hit **Start the Derby**, and get an official draft board at the end.

**Fair** · every duck draws speed, stamina, bursts, stumbles and luck from
identical distributions, so every name has exactly the same chance (there is a
Monte Carlo chi-square test in `test/fairness.test.js`).
**Seeded & replayable** · a race is fully determined by names + seed. The
results screen puts a share link in the address bar; anyone opening it watches
the identical race, hot dogs and all.
**Zero dependencies** · plain ES modules + Canvas 2D + WebAudio. No build step.
Drop the folder on any static host.

## Features

- Procedurally drawn ducks: 16 plumage palettes × 16 hats × post-position
  saddle-towel numbers — every entrant is visually distinct.
- Broadcast presentation: parallax venue with grandstands and bunting, buoyed
  lanes, adaptive follow-camera, wakes, splashes, photo-finish slow-mo,
  confetti, podium.
- Race engine with bursts, stumbles, rubber-banding that relaxes for the
  run-in, finishing kicks, and "drama curation" (auditions several sub-seeds
  and keeps the most exciting — symmetric, so still fair).
- Crowd hazards: occasionally someone in the stands lobs a **hot dog** at
  whoever is leading, Mario Kart style (toggle off under *Race options*).
- Start and finish set pieces: starter arch with race lights and a pennant
  rope that drops on GO, crouch-and-launch poses, a candy-striped finish tape
  the winner snaps, confetti cannons, a grayscale photo-finish still for close
  races, and a staged results ceremony (plinths rise 3-2-1 to a drumroll and
  fanfare, the board reveals pick by pick, confetti over the panel).
- Live standings and a two-tier commentary ticker (headlines + chatter) whose
  lines are drawn from seeded shuffle-bags and sampled on a fixed race-clock
  grid — the same share link produces the same broadcast, word for word.
- Fully synthesized broadcast sound (no audio files): quacks, horn, crowd and
  water beds, hot-dog foley, lead-change whoosh, a tension drone with an
  accelerating heartbeat for the run-in that cuts to a cymbal on the win,
  slow-mo muffling, fanfare stings and a sad trombone for last place. Muted
  sessions build no audio graph at all; background tabs go silent.
- Performance governor: watches real frame cadence and sheds effect tiers
  (particles, reflections, backing-store resolution, backdrop blur) on devices
  that can't hold the frame rate; idle screens render at 30 fps. `&fx=0|1|2`
  pins a tier for captures or debugging.
- Draft rule up front — winner gets pick 1, winner *chooses* first, or last
  place gets pick 1 — and the results, copied text and PNG all follow it.
- Results: podium + draft board, native share sheet (or copy link), copy as
  text, save as PNG; optional league name carried through the top bar, tab
  title, PNG and share link. `&view=board` deep-links straight to the board,
  `&autoplay=1` starts a shared race by itself.
- Roster entry: paste a whole list into any row, non-destructive resize with
  Undo, duplicate names race as "Mike (2)".
- Responsive (phone portrait + landscape → TV, safe-area aware), keyboard and
  screen-reader friendly (`P`/`Space` pause, `Esc` skip to results, `M` mute,
  `F` fullscreen, polite live announcements), honours `prefers-reduced-motion`
  live plus an in-app "Calm" effects setting.
- Race codes (`3GQ-M2XD`) are canonical 32-bit seeds; share links carry one
  `n=` param per duck so any name — `~`, `&`, emoji — replays the same race.

## Run locally

```bash
cd duck-derby
npm run serve      # http://localhost:8080
npm test           # simulation, fairness and identity tests (node:test)
npm run analyze    # Monte Carlo drama/fairness report for the race engine
```

`tools/shots.mjs` drives the app with Playwright and captures every phase for
visual review (`node tools/shots.mjs http://localhost:8080/ shots`).

## How the race works

`src/sim.js` integrates every duck at 60 Hz from the seed: cruise speed,
rhythm waves, a slow "storyline" wave, Ornstein–Uhlenbeck jitter, Poisson
bursts and stumbles, pack rubber-banding (fades out after 60% so the finish is
honest), a finishing kick, and the hot-dog hazard aimed at the leader. The
whole race is computed before the gates open; playback interpolates it, which
is what makes slow-motion photo finishes and exact replays possible.

## Layout

```
index.html, styles.css   app shell
src/rng.js               seeded PRNG, seed codes
src/sim.js               deterministic race engine
src/ducks.js             palettes, hats, towel colours, look assignment
src/draw-duck.js         procedural duck + headgear renderer
src/scene.js             venue, water, camera, particles, hot dogs
src/audio.js             WebAudio synth (beds, foley, tension, ceremony kit)
src/commentary.js        seeded commentary: set pieces + situational lines
src/share.js             share-link codec (pure; one n= param per duck)
src/main.js              UI + race director (playback pacing, pause, hooks)
test/                    node:test suites
tools/                   analysis + screenshot tooling
```

## Phase 2 (planned)

**Duck Cam 3D** — a Three.js chase-camera view where each manager opens the
shared link on their own phone and rides behind their own duck through the
same seeded race (the sim layer is renderer-agnostic, so both views replay the
identical result).

## Deploying on its own

This folder is self-contained. To make it its own repository: copy the folder,
push, and enable GitHub Pages (a one-job workflow that uploads the folder as
the Pages artifact is all it needs).
