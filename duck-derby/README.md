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
**No runtime dependencies** · plain ES modules + Canvas 2D + WebAudio, two
self-hosted typefaces. No build step. Drop the folder on any static host.

## Features

- Procedurally drawn ducks: 16 plumage palettes × 16 hats × post-position
  saddle-towel numbers — every entrant is visually distinct — with faces that
  act (grit, smug, shock, joy, gloom follow the race: the hot-dog target
  flinches, the crown holder smirks, the winner beams, the last duck sulks).
- Broadcast presentation: parallax venue with grandstands and bunting, buoyed
  lanes, adaptive follow-camera, wakes, splashes, photo-finish slow-mo,
  confetti, podium.
- Race engine with bursts, stumbles, rubber-banding that relaxes for the
  run-in, finishing kicks, and "drama curation" (auditions several sub-seeds
  and keeps the most exciting — symmetric, so still fair).
- Crowd hazards: occasionally someone in the stands lobs a **hot dog** at
  whoever is leading, Mario Kart style (toggle off under *Race options*). The
  thrower is "credited" to another manager's section of the crowd (a seeded
  pick, purely for laughs): the fan wears that duck's colours and waves its
  pennant, the call names them, and the results hand them a 🎯 award.
- Race awards: the results board, the copied text, the PNG and the share sheet
  carry a one-line race story ("Puddles wins by 0.38 s — a hot dog cost Waddle
  Dee the lead…") and up to two superlatives per duck (front-runner, robbed,
  comeback, collapse, top speed, rocket start, by a beak, yo-yo…). All of it is
  a pure function of the simulation, so every replay of a link tells the same
  story (`src/awards.js`, `test/awards.test.js`).
- Start and finish set pieces: starter arch with race lights and a pennant
  rope that drops on GO, crouch-and-launch poses, a candy-striped finish tape
  the winner snaps, confetti cannons, a grayscale photo-finish still for close
  races, and a staged results ceremony (plinths rise 3-2-1 to a drumroll and
  fanfare, the board arrives sealed and flips open pick by pick, two-tone
  confetti in the champion's colours arcs over the panel then drifts behind the
  glass).
- An honest run-in call: 4.5 m out the director classifies the finish by *time*
  (live gap in seconds and how tight the touch will really be) — PHOTO FINISH
  only for a genuine photo, "to the wall!" for a fight, "nobody is catching X"
  for daylight; if a photo call is beaten by a late break the line owns it.
- Live standings and a two-tier commentary ticker (headlines + chatter) whose
  lines are drawn from seeded shuffle-bags and sampled on a fixed race-clock
  grid — the same share link produces the same broadcast, word for word.
- Fully synthesized broadcast sound (no audio files): quacks, horn, crowd and
  water beds, hot-dog foley, lead-change whoosh, a tension drone with an
  accelerating heartbeat for the run-in that cuts to a cymbal on the win,
  slow-mo muffling, fanfare stings, a sad trombone for last place, and a
  name-keyed three-note jingle per duck (new leaders and the podium reveals —
  the same notes every season). Muted sessions build no audio graph at all;
  background tabs go silent.
- Performance governor: watches real frame cadence and sheds effect tiers
  (particles, reflections, backing-store resolution, backdrop blur) on devices
  that can't hold the frame rate; idle screens render at 30 fps. `&fx=0|1|2`
  pins a tier for captures or debugging.
- Draft rule up front — winner gets pick 1, winner *chooses* first, or last
  place gets pick 1 — and the results, copied text and PNG all follow it.
- Results: podium + draft board, native share sheet (or copy link), copy as
  text, save as PNG; optional league name carried through the top bar, tab
  title, PNG and share link. `&view=board` deep-links straight to the board,
  `&autoplay=1` starts a shared race by itself. The result URL gets its own
  history entry (browser Back reopens the board), "New race" asks first unless
  the board was copied / saved / shared, and setup offers "Reopen board".
- A shared link lands locked: "Watch the race", "Skip to draft board" or
  "Make my own race" — the roster and rule are read-only until you fork it, so
  a stray tap can never produce a different "official" board under the same
  code. The code's provenance (random draw / custom code / shared replay) is on
  the badge, the countdown title card, the results and every export.
- "Which duck is mine?": click a live-order row (or tap a duck) to follow it —
  halo on the water, tag always on, remembered by name for next time; tap your
  duck again and it quacks back, press and hold it (or tap its row) to stop
  following; `N` cycles name tags Auto / All / Off.
- Roster entry: paste a whole list into any row (or the "Paste list" button;
  pasting into an empty roster sets the league size), non-destructive resize
  with Undo, duplicate names race as "Mike (2)". One name-length rule
  everywhere (inputs, pastes, links): 22 characters, grapheme-safe — an emoji
  family or a flag is never cut in half — with a note when a link or paste had
  to be shortened.
- Responsive (phone portrait + landscape → TV, safe-area aware), keyboard and
  screen-reader friendly (`P`/`Space` pause, `Esc` skip to results, `M` mute,
  `F` fullscreen, `N` name tags, polite live announcements), honours
  `prefers-reduced-motion` live plus an in-app "Calm" effects setting. The
  quality governor tells a capped refresh rate (Low Power Mode, 30 Hz TVs)
  from a slow device: a shed tier that doesn't buy frame rate is undone and
  never persisted.
- Race codes (`3GQ-M2XD`) are canonical 32-bit seeds; share links carry one
  `n=` param per duck so any name — `~`, `&`, emoji — replays the same race.

## Run locally

```bash
cd duck-derby
npm run serve      # serves the repo root like GitHub Pages: open http://localhost:8080/duck-derby/
npm test           # simulation, fairness, identity, share-codec, awards and run-in tests (node:test)
npm run ci         # syntax check + tests (what the checks run; no browser needed)
npm run analyze    # Monte Carlo drama/fairness report for the race engine
npm run shots      # Playwright: screenshots of every phase across 17 viewports/sessions (~5 min)
npm run smoke      # Playwright: end-to-end flows, exits 1 on any page/console error (~2 min)
```

`tools/shots.mjs <baseUrl> <outDir> [seed] [--only=desktop12,fin390,…]` re-shoots
a subset; `tools/smoke.mjs <baseUrl>` needs the same static server. Both use a
global or local Playwright install.

## Fonts

Bungee (display) and Nunito (UI) ship in `fonts/` as woff2 subsets from
`@fontsource` and are declared in `styles.css` — no third-party font request
is made. Both are licensed under the SIL Open Font License 1.1
(`fonts/OFL.txt`).

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
src/awards.js            run-in classification, race awards + headline, hot-dog culprits (pure)
src/share.js             share-link codec + the name-length rule (pure; one n= param per duck)
src/main.js              UI + race director (playback pacing, pause, hooks)
fonts/                   self-hosted Bungee + Nunito (woff2, OFL)
test/                    node:test suites
tools/                   analysis, screenshot (shots.mjs) and smoke-test (smoke.mjs) tooling
```

## Phase 2 (planned)

**Duck Cam 3D** — a Three.js chase-camera view where each manager opens the
shared link on their own phone and rides behind their own duck through the
same seeded race (the sim layer is renderer-agnostic, so both views replay the
identical result).

## Deploying on its own

This folder is self-contained (fonts included). To make it its own repository:
copy the folder, push, and enable GitHub Pages (a one-job workflow that uploads
the folder as the Pages artifact is all it needs); point `npm run serve` /
`shots` / `smoke` at the new root.
