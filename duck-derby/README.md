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
- Live standings, commentary ticker, synthesized sound (quacks, horn, crowd).
- Results: draft board (winner-first or last-place-first), copy as text, copy
  share link, save as PNG.
- Responsive (phone → TV), keyboard friendly, honours `prefers-reduced-motion`.

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
src/audio.js             WebAudio synth
src/commentary.js        ticker lines
src/main.js              UI + race director
test/                    node:test suites
tools/                   analysis + screenshot tooling
```

## Duck Derby World (3D)

`world.html` is a separate Mario Kart-style 3D race through a procedural world
(marina, canyon, lily pond, The Drop, log flume, rapids, harbour) with items,
chase/TV/free cameras, a join-by-QR lobby so every phone starts together, and
the same fair/seeded/replayable contract (its own engine and tests under
`src/world3d/` and `test/world3d.*`). See `WORLD3D.md` for the architecture and
`PHASE3-MULTIPLAYER.md` for the player-controlled follow-up (a single-device preview,
**Tilt Trial**, is already on the setup screen: steer your own duck with phone tilt or arrow keys).

## Deploying on its own

This folder is self-contained. To make it its own repository: copy the folder,
push, and enable GitHub Pages (a one-job workflow that uploads the folder as
the Pages artifact is all it needs).
