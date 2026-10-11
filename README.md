# ├░┼╕┼ÆΓÇá Sunset City ├óΓé¼ΓÇ¥ a GTA-style top-down joyride

[![Live demo](https://img.shields.io/badge/live-demo-4f8cff?style=flat-square)](https://itslucas02.github.io/sunset-city/)

A GTA 1/2-style game that runs in any desktop browser. One self-contained
HTML file, built with **three.js** ├óΓé¼ΓÇ¥ no image, model, or audio assets;
the whole city is procedural.

## ├óΓÇô┬╢├»┬╕┬Å Play

Open **`index.html`** (double-click it ├óΓé¼ΓÇ¥ works fully offline), or play the
hosted build](https://itslucas02.github.io/sunset-city/).

| Key | Action |
|---|---|
| W A S D / arrows | walk / drive |
| Shift | sprint |
| E | enter / exit (steal) any car ├é┬╖ answer pay phones |
| Space | handbrake (drift) |
| H | horn (scares pedestrians) |
| M | mute |
| P | pause |

## Features

- **Procedural city** ├óΓé¼ΓÇ¥ 10├âΓÇö10 blocks, 221 buildings (taller downtown), parks,
  sidewalks, crosswalks, lane markings, street lamps, trees
- **Arcade driving** ├óΓé¼ΓÇ¥ 6 car models with grip/drift, reverse, body roll,
  speed-sensitive steering
- **Living city** ├óΓé¼ΓÇ¥ traffic AI on a right-hand-traffic lane graph (routes at
  intersections, braking, honking, crash recovery) + pedestrians who wander,
  panic, and get knocked down
- **Wanted system** ├óΓé¼ΓÇ¥ crimes build heat ├óΓÇáΓÇÖ 1├óΓé¼ΓÇ£5 stars; police Interceptors
  spawn per star with flashing lightbars, siren audio, and target-leading
  pursuit AI that gets faster at higher heat; evade to cool down
- **Minimap + health/damage** ├óΓé¼ΓÇ¥ circular radar with cop blips, player health,
  per-car damage; cars get totalled, players get WASTED and respawn
- **Missions & money** ├óΓé¼ΓÇ¥ 7 pay phones around the city; a booth rings as you
  walk up to it (one also rings somewhere across town ├óΓé¼ΓÇ¥ follow the cyan
  minimap blip). Press **E** to take a job. Three kinds: timed
  **deliveries** (get the package to the gold beacon), **car boosts**
  (steal the marked gold Stallion and deliver it), and **hot goods** (a
  drop that trips the alarm ├óΓé¼ΓÇ¥ instant wanted stars). Finish before the
  timer for a cash time bonus; cash and completed-mission count persist
  via `localStorage`
- **Explosions & destructibles** ├óΓé¼ΓÇ¥ totalled cars smoke, catch fire, then
  blow up: shockwave, sparks, scorch mark, area damage and chain
  reactions. Smash fire hydrants for a water geyser and send trash cans
  flying
- **Hidden packages** ├óΓé¼ΓÇ¥ 25 briefcases tucked around the city ($100 each,
  +$2,500 for the set); collected ones stay collected
- **Taxi fares** ├óΓé¼ΓÇ¥ steal a Cabbie and passengers hail you from the curb;
  timed drop-offs pay cash, streaks pay ├âΓÇö1.5
- **Day / night cycle** ├óΓé¼ΓÇ¥ a full day every ~3├é┬╜ minutes: sunset glow,
  dusk, night with glowing street lamps and headlight pools, dawn; a
  clock by the minimap
- **Procedural audio** ├óΓé¼ΓÇ¥ engine, tire skid, horn, crashes, explosions,
  police siren, phone ring, mission jingle (pure WebAudio, no files)

## Project structure

```
index.html              ├óΓÇá┬É the playable game (single file)
src/game.js             ├óΓÇá┬É all game source (~2,600 lines, sectioned)
src/index.template.html ├óΓÇá┬É HTML shell + HUD markup/CSS
src/three.min.js        ├óΓÇá┬É vendored three.js r128
src/build.py            ├óΓÇá┬É bundles the above into index.html
src/test-harness.js     ├óΓÇá┬É headless test: stubs DOM/WebGL, simulates ~140s
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

- three.js is vendored (r128, MIT license ├é┬⌐ three.js authors)
- Everything else in this repo: do whatever you like
