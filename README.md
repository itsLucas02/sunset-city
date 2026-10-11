# ðŸŒ† Sunset City â€” a GTA-style top-down joyride

[![Live demo](https://img.shields.io/badge/live-demo-4f8cff?style=flat-square)](https://itslucas02.github.io/sunset-city/)

A GTA 1/2-style game that runs in any desktop browser. One self-contained
HTML file, built with **three.js** â€” no image, model, or audio assets;
the whole city is procedural.

## â–¶ï¸ Play

Open **`index.html`** (double-click it â€” works fully offline), or play the
hosted build on GitHub Pages once enabled.

| Key | Action |
|---|---|
| W A S D / arrows | walk / drive |
| Shift | sprint |
| E | enter / exit (steal) any car Â· answer pay phones |
| Space | handbrake (drift) |
| H | horn (scares pedestrians) |
| M | mute |
| P | pause |

## Features

- **Procedural city** â€” 10Ã—10 blocks, 221 buildings (taller downtown), parks,
  sidewalks, crosswalks, lane markings, street lamps, trees
- **Arcade driving** â€” 6 car models with grip/drift, reverse, body roll,
  speed-sensitive steering
- **Living city** â€” traffic AI on a right-hand-traffic lane graph (routes at
  intersections, braking, honking, crash recovery) + pedestrians who wander,
  panic, and get knocked down
- **Wanted system** â€” crimes build heat â†’ 1â€“5 stars; police Interceptors
  spawn per star with flashing lightbars, siren audio, and target-leading
  pursuit AI that gets faster at higher heat; evade to cool down
- **Minimap + health/damage** â€” circular radar with cop blips, player health,
  per-car damage; cars get totalled, players get WASTED and respawn
- **Missions & money** â€” 7 pay phones around the city; a booth rings as you
  walk up to it (one also rings somewhere across town â€” follow the cyan
  minimap blip). Press **E** to take a job. Three kinds: timed
  **deliveries** (get the package to the gold beacon), **car boosts**
  (steal the marked gold Stallion and deliver it), and **hot goods** (a
  drop that trips the alarm â€” instant wanted stars). Finish before the
  timer for a cash time bonus; cash and completed-mission count persist
  via `localStorage`
- **Explosions & destructibles** â€” totalled cars smoke, catch fire, then
  blow up: shockwave, sparks, scorch mark, area damage and chain
  reactions. Smash fire hydrants for a water geyser and send trash cans
  flying
- **Hidden packages** â€” 25 briefcases tucked around the city ($100 each,
  +$2,500 for the set); collected ones stay collected
- **Taxi fares** â€” steal a Cabbie and passengers hail you from the curb;
  timed drop-offs pay cash, streaks pay Ã—1.5
- **Day / night cycle** â€” a full day every ~3Â½ minutes: sunset glow,
  dusk, night with glowing street lamps and headlight pools, dawn; a
  clock by the minimap
- **Procedural audio** â€” engine, tire skid, horn, crashes, explosions,
  police siren, phone ring, mission jingle (pure WebAudio, no files)

## Project structure

```
index.html              â† the playable game (single file)
src/game.js             â† all game source (~2,600 lines, sectioned)
src/index.template.html â† HTML shell + HUD markup/CSS
src/three.min.js        â† vendored three.js r128
src/build.py            â† bundles the above into index.html
src/test-harness.js     â† headless test: stubs DOM/WebGL, simulates ~140s
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

- three.js is vendored (r128, MIT license Â© three.js authors)
- Everything else in this repo: do whatever you like
