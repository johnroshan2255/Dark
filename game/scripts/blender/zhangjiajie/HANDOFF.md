# Zhangjiajie map — handoff (stopped 2026-10-23)

## Prompt to continue

> Continue the **Zhangjiajie & Wulingyuan** map (`zhangjiajie`) in `C:\project\Dark`. Read
> `game/scripts/blender/zhangjiajie/HANDOFF.md` first. The current build looks like **1 % of the height map — a cheap
> copy**: the relief, pillar forest and mesas don't match `ref/heightmap_original.png`. Rebuild the terrain so it
> faithfully follows the reference height map (landform layout, pillar density/height, mesas, river valleys), coloured
> from `ref/terrain_design_atlas.png`'s palette, with the roads/paths the atlas shows. Use Blender headless
> (`build.py`). Compare the result side by side with the reference images before calling it done, and verify by
> playing in Chrome at localhost:5173. No subagents.

## Reference images (keep)

| file | what |
|---|---|
| `ref/heightmap_original.png` | the user's original height map (full resolution, from Downloads `Gemini_Generated_Image_is91smis91smis91.png`) |
| `ref/terrain_design_atlas.png` | the user's colour / route atlas (`Zhangjiajie Terrain Design Atlas.png`) |
| `heightmap.png` | a 1024 px greyscale copy that `build.py` currently reads |
| `atlas.png` | the same atlas as `ref/terrain_design_atlas.png` |

Palette sampled from the atlas swatches (sRGB): vegetation `2a4e35 446c41 678859 89a772` · rock `5d544c 827465 a49580
cdbca5` · soil `614c32 88694b aa8560 ceb38f` · water `205f7b 3a84a6 5ea8c8 a4dced` · sky `4e7295 7ea8d1 b3d0e9 e0eefa`
(`map.json` doesn't support sky colours yet).

## The user's verdict on the current build

The map looks like **1 % of the height map, like a cheap copy**. Likely causes in the current approach (see the header
of `build.py`):
- `build.py` treats the height map as a shaded render, not a DEM. It reads only its structure (bright = mesa, dark
  path = river, local brightness = pillar height) and then **synthesises** the landforms. As a result, little of the
  image's actual shape survives.
- Heights were scaled down: the relief is −8.6 … 184 m on a 2.4 km map (2 m grid, 1201²), and the pillars are 16–215 m.
  The image's legend says 1300 m.
- The pillars aren't terrain. They are 1578 instanced, fluted cylinder meshes (`src/world/map/PillarField.ts`, 5
  variants × 3 LODs) placed on a mostly flat base, plus a talus skirt in the heightfield.
- The roads were routed by heading-aware A* between hand-picked nodes (`ROUTES` in `build.py`), not traced from the
  atlas.

Decide first: either (a) use the height map's pixels directly as heights (denoise or deshade them, and possibly use a
larger map, more vertical scale or a finer grid), or (b) keep the procedural build but match the layout, density and
heights much more closely. Check the engine's limits: `FixedMap` grid size, the server reading `heights.bin`, and the
perf budget per quality tier.

## Pipeline (how to rebuild)

```
cd C:\project\Dark\game
"/c/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup --python scripts/blender/zhangjiajie/build.py -- OUT=C:/project/Dark/game/public/maps/zhangjiajie
```
- Always pass an **absolute** `OUT`. A relative one once wrote to `C:\public\maps\zhangjiajie`, which left empty
  folders there; delete them by hand.
- The output goes to `game/public/maps/zhangjiajie/`: heights.bin, biome.bin, map.json (roads, `pillars` stride 7:
  x, y, z, r, h, rot, variant), props.json, props.glb, bruno/, preview.jpg, minimap.jpg, statics.bin.
- Then run `node scripts/export-statics.mjs zhangjiajie` (it needs `npm run dev`). This writes statics.bin and
  `server/crates/sim/golden/statics-probe-zhangjiajie.json`.
- Then run `cd server && cargo test` (`statics_match_the_game` now includes `("zhangjiajie", 20_000)`).
- For the drive check, run `MAP=zhangjiajie FULL=1 node scripts/drive-probe.mjs <outdir>` (~20 min).

## Code already in place (uncommitted)

- `src/world/map/FixedMap.ts`: MAPS entry, `MapJson.pillars`, `inPillar()`, and a pillar grid.
- `src/world/map/PillarField.ts`: renders the pillars as instanced meshes, and adds their colliders.
- `Game.ts` wires the pillar field. `scatter.ts` keeps trees out of the pillars. `TowSystem.ts` lets a rope be tied
  to a pillar. `horizonGen.ts` averages 5 points per far-terrain vertex on fixed maps.
- `map_preview.py` draws the pillars. `export-statics.mjs` adds the pillar colliders.
- Server: `config.rs` default maps, README, and the `physics.rs` parity test. Docs: an `ARCHITECTURE.md` ZHANGJIAJIE
  section.

## Where I stopped

- Drive probe (previous build): scenic_loop, valley_road and mesa_road were clean. cross_road got stuck at
  (−113, 107), at a bridge start. Cause: the deck is clamped to WATER + 2.5 m above a lower bank, which leaves a 1.6 m
  step. **Fixed in `build.py`** (bank ends are raised to the deck) and the map was rebuilt. The re-probe was stopped
  before it finished, so the fix is **unverified**.
- statics.bin was exported for the rebuilt map. `cargo test` (workspace minus `dark-server`), clippy and
  `npm run typecheck` pass. `cargo test -p dark-server` wasn't run, because the running dev server locks
  `target/debug/dark-server.exe`; stop the server first. `npm test` was interrupted, so the full suite hasn't been
  confirmed.
- If the terrain is rebuilt from scratch, all of the above (statics, probe, tests) must be redone.

## Other open questions (from the same session)

- Multi-server hosting for hundreds of rooms: own VMs or Edgegap / Agones / GameLift? Not answered.
- Players who join late don't see cars that were parked before they joined. Fixing this needs a protocol change.
