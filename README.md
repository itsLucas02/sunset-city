# 🌆 Sunset City — a GTA-style top-down joyride

A GTA 1/2-style game that runs in any desktop browser. One self-contained
HTML file, built with **three.js** — no image, model, or audio assets;
the whole city is procedural.

## ▶️ Play

Open **`index.html`** (double-click it — works fully offline), or play the
hosted build on GitHub Pages once enabled.

| Key | Action |
|---|---|
| W A S D / arrows | walk / drive |
| Shift | sprint |
| E | enter / exit (steal) any car · answer pay phones |
| Space | handbrake (drift) |
| H | horn (scares pedestrians) |
| M | mute |
| P | pause |

## Features

- **Procedural city** — 10×10 blocks, 221 buildings (taller downtown), parks,
  sidewalks, crosswalks, lane markings, street lamps, trees
- **Arcade driving** — 6 car models with grip/drift, reverse, body roll,
  speed-sensitive steering
- **Living city** — traffic AI on a right-hand-traffic lane graph (routes at
  intersections, braking, honking, crash recovery) + pedestrians who wander,
  panic, and get knocked down
- **Wanted system** — crimes build heat → 1–5 stars; police Interceptors
  spawn per star with flashing lightbars, siren audio, and target-leading
  pursuit AI that gets faster at higher heat; evade to cool down
- **Minimap + health/damage** — circular radar with cop blips, player health,
  per-car damage; cars get totalled, players get WASTED and respawn
- **Missions & money** — 7 pay phones around the city ring at random; walk up
  and press **E** to take a job. Three kinds: timed **deliveries** (get the
  package to the gold beacon), **car boosts** (steal the marked gold Stallion
  and deliver it), and **hot goods** (a drop that trips the alarm — instant
  wanted stars). Finish before the timer for a cash time bonus; cash and
  completed-mission count persist via `localStorage`
- **Procedural audio** — engine, tire skid, horn, crashes, police siren,
  phone ring, mission jingle (pure WebAudio, no files)

## Project structure

```
index.html              ← the playable game (single file)
src/game.js             ← all game source (~1,950 lines, sectioned)
src/index.template.html ← HTML shell + HUD markup/CSS
src/three.min.js        ← vendored three.js r128
src/build.py            ← bundles the above into index.html
src/test-harness.js     ← headless test: stubs DOM/WebGL, simulates ~125s
                           of gameplay with scripted input, asserts sanity
```

## Develop

```bash
cd src
node --check game.js     # syntax
node test-harness.js     # headless gameplay simulation
python3 build.py         # rebuild index.html
```

## Notes

- three.js is vendored (r128, MIT license © three.js authors)
- Everything else in this repo: do whatever you like
