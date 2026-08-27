# Phase 3 — "Duck Derby World: Grand Prix" (live, player-controlled, multiplayer)

Phase 2 (`world.html`) is deliberately a **precomputed, seeded, fair** race: nobody
steers, every duck has the same chance, and a shared link replays the identical
result — that is what makes it usable for a draft order. Phase 3 adds a second
mode on the same world where **each manager drives their own duck** from their
phone, Mario Kart style, with the others live on screen.

## What stays, what changes

Keep: the course (`course.js`), terrain/water/scenery, 3D ducks + hats, items
catalogue and visuals, cameras, HUD, audio. Everything that renders a duck at
`(s, lateral, speed, state)` already takes that state from "somewhere" each frame.

Replace the source of that state: instead of sampling the precomputed `race.js`
arrays, a **live simulation** integrates every duck at 60 Hz from player input.

```
input.js      per-device controls -> { steer -1..1, boost, useItem }
live-sim.js   authoritative tick: same physics vocabulary as race.js
              (cruise speed, boost windows, stumble/spin windows, item effects,
              section modifiers, The Drop airborne window) but driven by input;
              lateral position is now steered (clamped to the channel), and
              wall scrapes / lily pads / rocks cost speed for real.
net.js        rooms, clock sync, input upload, state snapshots down
lobby         room code / QR, ready-up, countdown sync, rematch
```

## Controls (mobile first)

- **Tilt to steer** (DeviceOrientation `gamma` in portrait / `beta` in landscape,
  ±25° = full lock, small dead-zone, low-pass filtered). iOS needs a one-tap
  permission (`DeviceOrientationEvent.requestPermission()`); phase 2 already ships
  a "Tilt look" toggle that exercises exactly this path.
- Thumb buttons: right thumb = use item, left thumb = brake/drift; auto-accelerate.
- Fallbacks: touch slider steering; keyboard (arrows / WASD + space) on desktop;
  gamepad via the Gamepad API.
- Assist: soft lane-keeping near walls so tilt noise never wall-rides; optional
  "auto-steer, I just fire items" mode for people holding a drink.

## Netcode

GitHub Pages only serves static files, so the realtime channel lives elsewhere:

| Option | How | Notes |
|---|---|---|
| **Cloudflare Workers + Durable Objects** (recommended) | one Durable Object per room holds the authoritative `live-sim`, clients connect by WebSocket, send inputs (20 Hz), receive snapshots (15–20 Hz) | cheap, no server to babysit, ~50 lines of Worker glue; site itself can stay on Pages or move to Cloudflare Pages |
| Managed realtime (Ably / Liveblocks / Supabase Realtime / Pusher) | clients pub/sub through the service; one client ("host", e.g. the TV) runs the authoritative sim | zero backend code, free tiers cover a league night; host migration needed if the host tab closes |
| WebRTC peer-to-peer | host-authoritative star topology over data channels; only signalling needs a function (Vercel/Netlify/Cloudflare function or a public signalling server) | lowest latency on a LAN party; NAT traversal needs a TURN fallback for ~10% of connections |
| Vercel | great for hosting the static site + short serverless functions (signalling, room codes) but functions do not hold WebSockets, so pair it with one of the rows above | |

Model: **host-authoritative with client-side prediction** for your own duck and
interpolation (100 ms buffer) for everyone else; inputs are tiny (steer byte +
buttons), snapshots are ~24 bytes per duck. Items resolve on the host so hits
are consistent; the seeded RNG still drives item rolls so a replay file
(inputs + seed) can reproduce a race.

## Fairness / draft-order use

Skill decides a Grand Prix, so the fair auto-race stays the default for draft
order. Options for leagues that want to *drive* for their pick: mirrored
handicaps off, identical duck stats, items on catch-up tables as now, best-of-3.

## Milestones

1. Local single-player driving on the existing course (input + live-sim, AI ducks
   use the phase-2 brains) — proves handling and course collisions.
2. Two phones + a TV in one room over the chosen transport; lobby with room code/QR.
3. 8–16 players, host migration, reconnect, spectate-on-TV, replays.


## Shipped preview: Tilt Trial (single device)

`world.html` now has a **Tilt Trial** button (beta): a live, locally simulated run down the same course where
you steer your own duck by tilting the phone (or ← → / A D, or touching the left/right half of the screen),
hitting boost arrows and dodging floating logs against seven AI ducks. It uses `src/world3d/trial.js` (live sim,
same duck-state shape as the playback race, so the renderer/cameras/HUD are shared) and `src/world3d/input.js`
(keyboard/touch/tilt → one steer value). It is a skill mode and never feeds the draft order; it is the
single-player half of the Grand Prix plan above — the networking layer (lobby relay + input broadcast +
lockstep/rollback) is the remaining work.
