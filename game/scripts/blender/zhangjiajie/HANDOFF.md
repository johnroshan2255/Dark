# Zhangjiajie map — handoff (2026-10-23, fourth pass: approved Blender terrain, 4 km)

The user approved the terrain from Cycles renders (`preview/`): wide tapered tower hills, eroded, gaps to drive
between, 4 km map. See `ARCHITECTURE.md` → ZHANGJIAJIE for the whole design and the history of what they rejected.

## Pipeline

```
cd game
blender -b --online-mode --command extension install antlandscape          # once (the eroder)
blender -b --python scripts/blender/zhangjiajie/terrain.py -- [RENDER=1 OUT=<dir>]   # → scripts/blender/zhangjiajie/terrain/
blender -b --factory-startup --python scripts/blender/zhangjiajie/build.py -- OUT=$PWD/public/maps/zhangjiajie [DEBUG=<dir>]
blender -b --factory-startup --python scripts/blender/island/roads.py -- MAP=$PWD/public/maps/zhangjiajie WRITE=1
blender -b --factory-startup --python scripts/blender/island/map_preview.py -- MAP=$PWD/public/maps/zhangjiajie OUT=$PWD/public/maps/zhangjiajie/preview.jpg
blender -b --factory-startup --python scripts/blender/island/map_preview.py -- MAP=$PWD/public/maps/zhangjiajie OUT=$PWD/public/maps/zhangjiajie/minimap.jpg TILT=0 FULL=1 PX=1024
node scripts/export-statics.mjs zhangjiajie        # needs npm run dev (PORT=…)
cd ../server && cargo test
```
terrain.py knobs: `SP` (massif spacing, 300), `TH` (height × the render's, 1.8), `SW0`/`SW1` (wall steepness),
`GAP` (half gap, 26 m), `CS` (column size, 85), `HALF` (2000). Note: `terrain.py` must run without
`--factory-startup` (it enables the installed A.N.T. Landscape extension). `terrain/*.npy` are generated (16 MB each).

## Open

- From a hill top the far hills are still muted blue-green; trees on the far tops show only within the impostor range.
- cross_road has a ~1 m step onto one bridge deck (−505, 496); check the drive probe.
- `cargo test -p dark-sim`: `island_bots_cruise_race_and_never_go_wild` aborts (SIGABRT) on this machine — Island-only.
