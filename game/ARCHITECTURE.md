# DARK — Architecture

Browser co-op survival horror. Stylized, low-poly, fog-heavy procedural open world.
Target: **≥ 60 fps minimum on every supported device — ~₹15k Android phones, low-end PCs (Intel UHD) and
desktops — uncapped above** (display refresh), in Chrome/Firefox/Safari (WebGL2). Achieved with graphics presets
(LOW · MEDIUM · HIGH · ULTRA) + adaptive resolution (`src/rendering/quality/`, `skills/mobile`): each preset sets
a level per FEATURE (shadows, reflections, ambient occlusion, volumetric light & fog, grass, ground & weather detail,
trees & bushes, view distance); the sky is drawn at reduced resolution per tier (`skyScale`)
and the player can override any of them in Settings → Graphics, like a PC game's menu. Auto detection and
adaptive quality pick LOW–HIGH; ULTRA is the player's choice. Cheap devices get no reflections and no AO.
On a chosen preset, **Hold 60 fps** (default on) lowers resolution, then the costliest features at runtime, and a
cap probe detects a browser-imposed 30 fps (Low Power Mode) instead of degrading quality (skills/mobile). Every game is a new random world
(seed shared with co-op peers).

This document is the source of truth for *how the systems fit together*.
The `skills/` directory explains *how to build each system correctly*.
Read the relevant skill before touching a system.

---

## 1. Dependencies (and why each exists)

| Package | Why |
|---|---|
| `three` | Renderer, scene graph, math. Everything renders through it. |
| `@react-three/fiber` | Declarative scene composition, React lifecycle for mount/unmount/dispose, a single frame loop with priorities. |
| `@react-three/drei` | Used selectively (loaders `useGLTF`/`useTexture`, `KTX2`/`meshopt` wiring, helpers). **Not** used for the hot path. |
| `@dimforge/rapier3d-compat` | WASM physics: character controller, heightfield terrain, BMX rigid body. `-compat` embeds the wasm so Vite needs no plugin. Used directly (not `@react-three/rapier`) so we control body activation per chunk and step timing. |
| `react`, `react-dom` | UI + R3F host. |
| `vite`, `typescript`, `@vitejs/plugin-react` | Build. Vite gives native module workers (`new Worker(new URL(...))`) for chunk generation. |
| `puppeteer-core` (dev) | Drives the locally installed Chrome for `npm run shot` (headless screenshots + fps/GPU ms per tier). Downloads nothing; dev-only. |

Deliberately **not** added (yet): state libraries (we use a ~40-line external store), `postprocessing` (our single
combined grading pass is cheaper and fully controlled; revisit if we need SSAO/bloom mip chains), `@react-three/rapier`,
`leva`, ECS libraries. Add one only with a concrete measured reason.

---

## 2. Frame architecture

React is used for **composition and lifecycle**, never for per-frame state.

```
<App>                                 DOM: HUD, debug overlay (updated via refs, 4 Hz)
 └─ <GameCanvas>                      R3F <Canvas>, renderer config, dpr clamp
     └─ <GameProvider game>           one Game instance (plain TS class) in context
         ├─ <GameLoopDriver>          useFrame(priority -100): game.loop.tick(dt)
         ├─ <CameraRig>               camera params; camera pose written by player system
         ├─ <Lighting>                sun/hemi/flashlight objects registered with LightingSystem
         ├─ <Environment>             background/fog objects driven by TimeOfDay
         ├─ <World>                   <primitive> of WorldManager.root; chunks are added imperatively (WorldChunk.ts)
         └─ <Effects>                 useFrame(priority 1): takes over rendering → PostPipeline
```

### Per-frame order (`src/game/GameLoop.ts`)

1. `look` — mouse/touch deltas → yaw/pitch (per render frame, not fixed step)
2. `fixed` (accumulator, 60 Hz, max 4 substeps) — player controller, Rapier step, interpolation alpha
3. `timeOfDay` — continuous hours, sun/moon directions, nightmare weight
4. `camera` — FPP eye or TPP over-the-shoulder orbit with Rapier ray-cast pull-in; animates the character; sets the
   flashlight origin/aim (must precede culling)
4. `world` — streaming (worker requests, ≤2 builds/frame), chunk LOD with hysteresis, chunk frustum culling, physics ring
5. `timeOfDay` → `lighting` — blend phase params, sun shadow follows player, flashlight, fog, grading uniforms
6. `debug` — chunk bounds / physics wireframes (only when enabled)
7. *(R3F render phase)* `Effects` → `Game.render()`: scene → RT → grading pass → screen, then `PerformanceMonitor.endFrame()`

High-frequency data (positions, velocities, instance matrices) lives in plain objects / typed arrays and is written to
Three.js objects directly. React state changes only for: chunk set changes, LOD changes, UI mode changes.

---

## 3. World model

```
World (seed)
 └─ Chunk grid, CHUNK_SIZE = 64 m, heights sampled every 2 m (33×33, `CHUNK_RES = 32`) — deliberately low-poly
     └─ per chunk: terrain mesh (LOD 0/1/2), instanced trees/rocks/plants, colliders (near only)
```

- **Generation is pure**: `generateChunk(seed, cx, cz) → ChunkData` (typed arrays only). Runs in a Web Worker
  (`src/world/Streaming/chunk.worker.ts`). Same seed ⇒ same world on every client. Generation uses only
  arithmetic + `Math.floor` (no `Math.random`, no `sin/cos` in anything gameplay-relevant).
  A FIXED MAP's nature grows from `FixedMap.seed` (from the map id), not the session's seed: the same trees for every
  player in a room, and for the server's car physics — `scripts/export-statics.mjs` writes the map's trunks, boulders
  and set pieces to `public/maps/<id>/statics.bin` (rerun after changing the scatter, a map or a prop's collider;
  the server's `statics_match_the_game` test fails on a stale file).
- **Road** is a global analytic function `roadCenterX(z)` so any chunk can evaluate it without neighbours.
- **Road graph (2026-10-15, `Road/RoadNetwork.ts`) — no road ends mid-way.** Nodes within `NET_BAND` (2.4 km) of
  the main road; tree links toward the main road + E/N loops; every structural LEAF (would dead-end on a bare hilltop)
  tries a CLOSURE to another tree node (8 neighbours) or the main road, conflicts between closures resolved pairwise
  (non-recursive); `live()` prunes branches that still lead nowhere (degree ≥ 2 or a destination for every node).
  PLACES, oasis CAMPS and the far end of every rope BRIDGE are joined by an A* ROUTE (`route`/`search`: Dijkstra on a
  12 m grid — 24 m beyond 1.5 km — with half-cell heights; cost len·(1 + 14·grade² + water); stops at the FIRST road
  it reaches, ending on it as a junction at that road's height, so it can't cross; road cells it can't join (cut /
  fill > 3 m) are walls; RDP + Chaikin smoothing with a cliff-safe fallback; stricter slope passes on failure). A
  bridge is built only if both ends get roads (`bridgeLinks` / `builtBridge`; bridges use `heightNoNet`). Grading
  (`finishRoad`): fixed heights (ends, place discs) with a band that widens just enough for a ramp; roads that would
  float over a valley or climb a cliff are rejected. Tests: every road reaches the main road, 0 dead ends, every place
  / camp has a road, every bridge connected, 0 crossings (4 seeds). Cost: ~25 ms of worker time per 380 m region,
  but a driveway A* that floods its grid without reaching a road costs 0.3–2 s (desktop, dev build) — so **the main
  thread never builds roads**: chunk workers send the region road lists / bridge roads they built with each chunk
  (`RoadNetwork.exportNew` → `importRoads`, the same deterministic roads, ~10 KB per chunk) and the main thread's
  height / road / bridge queries near the player (grass, car, camera) are cache hits; LANDMARKS (whose placement
  checks formations → roads) are placed in their own worker (`LandmarkSystem`, main-thread field `remote`). Before
  this, flying out froze the game for 1–4 s at a time and the first world took ~45 s (now ~11 s, dev build).
  Search speed-ups that keep every road identical: one height grid shared by a route's slope passes, the main road's
  centre per grid row, numeric region-cache keys (POIs / formations / landmarks: string keys were 19 % of generation).
  Heights between the ~14 m samples are PARABOLIC VERTICAL CURVES (`roadHeightAt`, C1 along the road — every reader
  of `hs` goes through it): linear interpolation left a sharp crest / sag at each sample (a −45 % → 0 % break at a
  ford stopped a truck dead).
  DRIVABLE LINKS (2026-10-16): straight Bézier links between hilltop nodes ran up 45–90 % pitches. A CHOSEN tree /
  loop / closure link steeper than DRIVE_GRADE (0.3) is re-routed (`drivable` → `routeTo`): A* to the node (or onto
  the main road) with a slope limit judged per 12 m step and over two steps (no sawtooth), ≤ 90° turn per step and per
  two steps (hairpins ≥ ~15 m radius), higher-priority roads as walls, a penalty for running along the main road,
  rounded only where that stays drivable, graded at MAX_GRADE. Kept only if flatter, ≤ DETOUR_MAX × the length its
  drop needs, within BOX_MARGIN of its ends (region lists stay valid) and it `fits` the terrain shaping: its
  embankment never reaches the main road's shoulder, its own legs or a nearby road (`bankMax`: else the terrain blend
  walls the gap or humps the other road). Selection still runs on the cheap straight shapes — the first candidate
  that is drivable (as is or routed) wins. Seeds 7 / 1337 / 42 (7 × 7 regions): road length steeper than 45 %
  360 / 394 / 1074 m → 208 / 138 / 450 m; road surface off its grade by > 0.5 m 22 / 328 / 1368 → 64 / 246 / 534 m.
  Cost: ~15 ms per routed link, ~1.3 / 2.6 / 8.7 s for the 49 regions (was 0.2 / 0.6 / 5 s; connector searches now
  stop after the first pass that reaches no road at all instead of flooding the grid three times).
- **Exploration (2026-10-18 — "we only have a straight road; people need places to explore and drive to")**:
  SUMMIT LOOKOUTS (`POI/pois.ts` `PoiType.Lookout`, `lookout(li, lj)`): ≤ 1 per 600 m cell — the 4 highest of a 6 × 6
  height grid, each hill-climbed to its top; kept if PROMINENCE ≥ 16 m over the 150 m ring, flanks ≤ 50 % on average
  over the top 48 m (a needle has no drivable way up), dry, ≥ 140 m off the main road and 80 m off the river, any
  biome. A place like the others (flattened terrace r 11 m, trees cleared, compass + arrival banner), laid out as a
  stone VIEWPOINT terrace facing the lowest side of the peak (railing, telescope, cairn, 7.5 m red-orange FLAG — the
  mark on the skyline), bench, log seat, lantern, signpost (`PropType.Viewpoint`, ~600 tris, merged into the place
  mesh: 0 draws; collider = the 0.4 m terrace). SWITCHBACK TRAIL (`RoadNetwork.summitTrail`): a Trail-type road from
  the peak to the first network road, searched as a LINK (two-step grade, ≤ 90° turns, hairpins ≥ ~15 m) with the
  STRICTEST slope limit first (0.3 → 0.42 → 0.55), the summit's first two cell rings exempt (terrace + blend); graded at
  22 % in a ±5.5 m band — a SHELF ROAD cut into the hillside (CLIMB_OFFSET; the steep uphill face is rock-clad by
  the crags); a graded pitch > 45 % anywhere rejects the pass, and a peak with no such trail keeps none (hike up).
  It stays out of the places' crossing order (driveway0 skips lookouts — in it a 1–3 km trail chained the checks
  across the map: 198 s for one area) and is re-routed onto a place's drive only if it would cross one. Tests
  (4 seeds): 67 lookouts, 45 trails, steepest graded pitch 43 %; shelf cut faces ≤ 2.8 m/m. Cost: chunk generation
  in lookout areas +35 % (300 chunks round 3 lookouts, Windows desktop, node: mean 96 → 129 ms, mostly the one-off trail
  build), 0 draws, ~600 tris per lookout. DISCOVERY (`gameplay/explore/Discovery.ts`, HUD): lookouts show on the
  compass from 2.5 km; other places only within 600 m or where a discovered lookout maps the land (1.5 km round it);
  reaching one → "Viewpoint discovered · N places revealed"; persisted per seed (localStorage, per-player). CANYON
  DRIVES: the main road's gorges cover ~40 % of it (was ~25 %), walls 14–30 m (were 10–20) — clad by the crags; the
  verge is unchanged (shoulder-step test). LOW tier, this PC (1536×639, ×1.25): lookout 281–284 draws / 1.36 M tris,
  canyon 295 / 1.04 M, open road 322 / 0.96 M — no extra draws (GPU timer pinned at the 144 Hz frame here; measure on a
  phone).
- **Road tunnels** (`Formations/formations.ts`, Cave on the main road): the 5.6 m bore BENDS and CLIMBS with the road
  (`Formation.bore`: the road's local (z, y) every 4 m, sampled at placement) — a straight bore left rock 0.3 m from
  the centre where the road curved. Test: no rock within 4.2 m of the centre at 0.3–1.8 m height (2 seeds).
- **Secondary roads are CONNECTED by construction** (`Road/RoadNetwork.ts`): one hilltop node per 380 m region; each
  node's road goes to a 4-neighbour strictly nearer the main road (same side, itself connected) or onto the main road
  (a spanning tree rooted at the main road, like a drainage network — distances strictly decrease, so no cycles and
  every kept node reaches the main road); a node with no buildable route gets no road. Extra E / N loop roads only
  join two connected nodes. Before, links were kept per hash and 42 % of roads (76 / 180, 4 seeds) formed chains cut
  off from the main road ("roads ending mid-way"); `npm test` now checks every road reaches the main road.
- **Rope bridges** (bright, `Road/bridges.ts`): every ~500 m (half the cells) a plank suspension bridge spans the
  river gorge beside the main road from bank top to where the far bank meets the deck (clears the ground all the
  way); appended to the chunk's formation mesh → 0 draws, the exact trimesh collider (walk / drive across; 4 m deck,
  solid sub-deck under the planks so wheel rays never fall through the gaps); trees, rocks, plants, grass and crags
  keep clear; the deck counts as dry dirt for the tyres (`drivetrain/surface.ts`). ~2.5–4 k tris per bridge.
- **Terrain layering** (`WorldFields.height`, skills/terrain §2): natural relief (biome-shaped) → main-road
  VALLEY (slope-limited banks, never walls) → river → PLACES flattened to a base measured on that ground →
  SECONDARY ROADS graded within ±3 m of it, meeting the ground on embankments → main road bed. Each stage is
  measured on the stages before it; `npm test` checks the shoulder step, place flatness and road banks.
- **Regions** (`src/world/Biomes.ts` + `src/world/biomes/BiomeDefs.ts`, generator **v2** = `WORLD_GEN_VERSION`):
  900 m cells whose type comes from a seeded CLIMATE (temperature / moisture / magic noise over ~4 cells → table:
  cold = SNOW, hot+dry = DESERT, drier = AUTUMN valley, moist+magic = MYSTIC wood, else FOREST; ≈ 50/15/15/15/5 %),
  so neighbours make sense (forest ↔ autumn ↔ desert, forest → snow, mystic pockets). Spawn 3×3 is forest; the main
  road runs forest → autumn → desert one way and forest → mystic → snow the other (cells (0, ±2), (0, ±3)).
  `weightsN` = one weight per region (sum 1, 260 m noise-warped blend + altitude snow line); `weights()` keeps the
  old [desert, snow] view. `BiomeDefs` holds each region's identity — tree species, undergrowth, grass, leaf
  palettes, ambient particles, density — CONTINUOUS values are blended by the weights, DISCRETE choices (species,
  plant kind, landmark) pick a region by seeded hash ∝ weights → gradual mixed borders. Autumn: maples (gold → red),
  birches/pines turning gold, leaf piles, golden grass, falling leaves, warm air, open rolling terrain, Great Maple
  landmarks. Mystic: violet ancient giants, glowing mushroom trees (`GLOW_UV` emissive in the vegetation shader),
  glow-shrooms + blue ferns, teal grass, violet mist + spores, dramatic tiers, Elder Bloom landmarks. Region species
  REPLACE the forest's (draws flat); new species/GLBs via `registerTreeSpecies`. Measured LOW (phone projection,
  M4 × 25 ≈ Adreno 610): forest 10, autumn 9, mystic 10, borders 9 ms; CPU ×6 driving through them: 2.5–3 ms mean.
  The previous paragraph's numbers for desert / snow still hold.
- **Blender trees**: `scripts/blender/genshin_trees.py` (run in Blender via the MCP socket) writes
  `src/assets/models/trees/*.glb` (broadleaf 'mondstadt', maple, ancient, world_tree, spruce, fir, Liyue pine, dead), 3 LODs
  each (`<tree>_lod0/1/2`). Crowns are leaf CLUMPS made only of cards — an outer shell of overlapping leaf-cluster
  cards facing out + (LOD0) a darker inner shell; NO solid core (a low-poly ball read as a faceted blob from below) —
  with spherical normals and dark-inside → light-top vertex colours. Conifers (`conifer()`) are tiers of flat
  drooping clumps; the hero world tree adds fill clumps for one Windrise dome. ONE primitive per LOD — the part kind
  travels in U (leaf 0..1, bark 2, core 4) because Blender's glTF exporter keeps vertex colours only on a mesh's first
  primitive. `assets/treeModels.ts` bakes them into the vegetation format and registers them in EVERY art style
  (`registerTreeSpecies`, `modelled: true` → always the Genshin hue set; the atlas leaf-cluster cell is the painted
  Genshin cluster in every style but storybook). Same per-species InstancedMesh, LOD bands and impostors. Cacti,
  joshua and mushroom trees stay code-built. `?trees=code` loads the old code-built trees (A/B). Tris L0/L1/L2:
  broadleaf 864/366/104, maple 746/320/104, ancient 716/326/110, spruce 1246/186/74, fir 1238/176/54,
  pine 804/344/106, dead 286/164/64; world tree 3812/1878/312. Measured seed 7, 1280×720, forest view, A/B vs code
  trees: HIGH 853k vs 1219k tris (GPU 6.1–6.6 vs 6.35 ms), LOW 111k vs 110k tris, 64 draws both, 3.75 vs 3.54 ms.
  Landmark snow cover tests the snow line at the landmark's foot (`aBaseY`), not per vertex.
  BROADLEAF STANDS (scatter.ts `broadleafStand`): wherever the forest would grow a birch, each ~56 m cell grows mostly
  ONE reference type — Mondstadt broadleaf (Birch), Slender (forks low into 3 stems), Windrise Oak (thick, wide dome),
  Curvy (S-trunk) or Golden (Liyue tiers of gold pads) — 20 % Birch/Slender mixed in; species ids 10–13, each its own
  InstancedMesh + impostor slot (14 of 16). Tris L0: slender 768, oak 1772, curvy 664, golden 694.
  BARK (paint.ts): 12 soft vertical grooves + lighter ridges wrapped round the trunk axis, built as cos(12θ) from
  complex powers of the trunk's horizontal direction (no atan → no seam), faded by fwidth; low contrast.
  Measured seed 7 at (38, −14), A/B vs `?trees=code`: HIGH 815k vs 1189k tris, 259 vs 261 draws, 5.4 vs 5.7 ms GPU;
  LOW 108k tris, 67 draws, 3.8 ms GPU.
  LEAF STYLE (stylized tree packs / Genshin): the leaf-cluster atlas cell is a dense PUFF of short PINNATE SPRAYS
  (stem + leaflet pairs, drooping, fringed outline; FoliageAtlas `drawTuftGenshin`); broadleaf palettes are a luminous
  lime (shade stays mid green); each clump is shaded bottom → top on its own as well as across the crown (bulb
  puffs). Leaf cards get WRAPPED light (`stylize`, vSurf < 0: shade side ≥ 40 % of the sun) and a backlit
  translucency lift — 0 extra programs, a few ALU on card fragments.
  LEAF STYLE v2 (matched to Genshin screenshots — the stylized-pack pass was too saturated and shiny): the card
  texture is a fine LEAF MASS (~3000 tiny pointed leaves, even tone 0.76–1.0, fringe thinning out past the blob, no
  stems/outlines) that mips to a soft tone; Blender leaf cards are CAMERA-FACING (treeModels.ts groups each card's
  4 vertices → bbCenter + rotated bbOff; never seen edge-on, the crown reads as a soft volume); muted natural
  palettes (broadleaf ~0xb8d468 lit / 0x50803a shade, golden 0xf2b444 / 0xb0681c); leaf lighting: soft wrap (shade
  side ≥ 25 %), rim ×0.2 and backlight ×0.15 on leaves only (full rim = "shiny" crowns). Measured seed 7, A/B vs
  `?trees=code`: HIGH 731k vs 851k tris, 5.35 vs 5.46 ms GPU; LOW 4.1 vs 4.5 ms (forest) and 4.2 vs 3.3 ms (road
  view: camera-facing cards cover more pixels).
  The leaf mass is IRREGULAR (a few sub-clusters out toward the cell corners, fringe thinning over a fixed
  distance) and inner/outer card shading is nearly flat (0.94 / 0.9–1.0): a round texture on camera-facing cards
  read as round sections. Measured golden grove HIGH 4.6–5.1 vs 3.8 ms (old trees); LOW road 2.5 vs 3.3 ms.
  LEAF STYLE v3 (Genshin ginkgo / broadleaf close-ups): broadleaf crowns are open LEAF SPRAYS — `spray()` places
  the camera-facing cards ALONG a few twig directions from each branch end (no ball of cards; sky between sprays);
  the card texture is a spray of 5 thin twigs with ROUND fan leaves alternating along them, each its own width /
  size, one flat tone (0.86–1.0), no outlines or contact shadows, all inside the cell. Warm olive / yellow-green
  palettes, no teal hue on broadleaves, lighter grey-brown trunks. LOD0 tris: broadleaf 850, slender 674, oak 1378,
  curvy 650, golden 588. HIGH 3.5–7.0 ms GPU across the test views (unchanged).
- **Hillside caves** (`world/Formations/caves.ts`, live part `gameplay/caves/CaveSystem.ts`): a Cave formation on a
  slope ≥ ~23° becomes a cave dug INTO the hill — mouth facing downhill in a rounded rock mass, a winding tunnel
  sloping down into a big chamber (stalactites / stalagmites, a pool basin, 1–2 skylights), a narrow side passage to
  a hidden alcove with a TREASURE CHEST (E: lid opens, full heal, "Treasure found" toast). All from the formation
  seed (deterministic). The terrain is CARVED under the cave's air (`WorldFields.height` → `formations.caveCarve`;
  `heightNoCave` for the horizon mesh and the rock cap); the rock cap follows the original hill +1.6 m, so outside it
  is a rocky outcrop with grass on top. Where the hill above is too low for the chamber's vault (a ridge, a
  shoulder), the cap is RAISED over the air (`caveRoof`: the air's top on a 2 m grid + 3.2 m, flanks falling ~48°,
  plus a smooth ≥ 1.9 m core the stone relief can't gouge) — the cave becomes a rocky knoll instead of its air
  bursting out through the hill (sky cracks, the blue interior plates showing outside) or a sub-voxel roof meshing
  with holes. SDF scan of 20 seeds: open-air breaches 2.9 k → ~0.1 k m² (only the skylights' ragged rims), roofs
  < 1.6 m 663 → 14 m². Cost: cave mesh build 320 → 450 ms once in the worker, 10–12 k → 17–18 k tris per cave.
  Caves keep clear of the main road, rivers, places and secondary roads.
  LIGHT is BAKED into the rock's vertex colours in the worker (daylight fading with the walk in from the mouth,
  pools under the skylights, a cyan glow round the crystals; moss / grass only where light reaches) — 0 runtime
  cost. CaveSystem: crystal clusters (one InstancedMesh, HDR → bloom), the pool (still water shader), additive
  sunbeam columns under the skylights (fade with the sun), the chest; `inside` (0..1, the baked light at the player)
  → Game dims the sky fill (and the sun on tiers without shadow maps), closes in a dark fog, cuts aerial haze /
  mist / god rays, opens the exposure ×1.55, the torch works at full strength in daylight. Measured seed 7 in a
  chamber: HIGH 6.2 ms GPU / 624 k tris / 199 draws, LOW 4.0 ms / 120 k / 93 draws (4 extra draws per near cave).
- **Streaming radii** (in chunks, Chebyshev distance from player chunk). The **render ring and LOD rings are per
  quality tier** (LOW 2 / MEDIUM 3 / HIGH 4 — `QualityTiers.ts`); the values below are HIGH:

| System | Radius | Notes |
|---|---|---|
| Data generated/cached | 5 | worker output kept in LRU |
| Render | 4 | mesh built, subject to frustum culling |
| LOD0 (full detail, small plants, shadows) | ≤1 | |
| LOD1 | 2–3 | half-res terrain, no small plants |
| LOD2 | 4 | quarter-res terrain, trees only, low-poly |
| Physics colliders | 1 | heightfield + trunk colliders |
| AI active | 2 | monsters beyond are frozen/despawned |
| Audio emitters | 2 | |
| Interaction | ≤ 0 (same chunk + raycast) | |

**Why chunks are not React components:** chunk creation is gated by a per-frame build budget, LOD switching
is a visibility flip on pre-built meshes, and disposal must free exactly the per-chunk buffers (never shared
geometry/materials). Doing that imperatively in `WorldChunk.ts` avoids reconciler work and `dispose` pitfalls;
React still owns the mount point (`<World>`).

Hysteresis: a chunk switches LOD / unloads only when distance crosses the threshold **+1 ring** (unload) or by a
margin of 0.35 chunk (LOD), so standing on a border does not thrash.

---

### Fixed maps (2026-10-20, "Select map")

The main menu offers **Explore endless world** (the procedural world above) or **Select map** (`ui/MapSelect.tsx`):
hand-made maps listed in `world/map/FixedMap.ts` `MAPS`, each a folder `public/maps/<id>/` (heights.bin 2 m Uint16
grid, biome.bin, map.json with roads + spawn, props.json, props.glb, bruno/). Playing one reloads on `?map=<id>`
(world, workers and physics are built for one world per session). `FixedMap` is loaded on the main thread and in
every chunk worker (each request carries `map`, `activeMap()`; the worker queues requests behind the load).
`new WorldFields(seed, map)` then answers from the map: `height*` = the map grid (falling off to a −30 m sea floor
over 320 m past its edge), biomes = its desert / snow weights (the rest forest), `forestDensity` = its tree
placements per 16 m cell (cleared round set pieces), roads = its centrelines (`RoadNetwork.setFixed`: nothing is
generated, nothing exported); the main road and the river move to `MAP_FAR` and places / formations / landmarks are
empty, so the pipeline downstream (chunks, road ribbon, scatter, grass, physics, car) runs unchanged. Set pieces
(camps, stunt park, cabins, ramps, bridges, Bruno Simon's props) are `world/map/MapProps.ts`: instanced per 200 m
tile, fixed colliders within 140 m (trimeshes in StaticMesh). DARK'S LOOK (2026-10-21, `world/map/mapPieces.ts`): the
map's flat clay camp gear, cabins, fences, crates and barrels are drawn with the procedural world's place props (white
canvas A-frame tents, campfire, chairs, picnic tables, crates, barrels, signposts, lamp posts, the A-frame cabin —
painted surfaces via the atlas UV, one BatchedMesh, +1 program `mapprop-dark`); toy cars and flags are left out;
solid pieces standing on a road bed are dropped (a pillar sat on dune_dome_switchbacks); the BRIDGES are Dark's plank
suspension bridge built along each road's bridge samples (`FixedMap.bridges`, cliff-rock material like the procedural
ones, a fixed trimesh each — the map's plank strip is not drawn). MINIMAP (`ui/Minimap.tsx`, fixed maps only): a
round GTA-style map top-left under the party badge, turned with the camera, N on the rim, your car as a dot on foot —
the map's top-down render (`MapInfo.minimap`, `map_preview.py TILT=0 FULL=1`, 240 KB JPEG) moved by one CSS
transform per frame (no React renders). DESERT POOLS & BEACH (2026-10-21, "too many bushes — group them round
small pools; beach: no bushes, trees to 20 %, bushes round the trees"; refs: desert springs / seeps / tinajas — grass
and sedge at the water, shrubs clustered round it, the sand between nearly bare; palm coasts — sea grape under the
palms): `FixedMap.pools` — ≤ 1 per 120 m cell (55 %), in the cell's lowest flat open-desert hollow off roads and set
pieces, carved into the height grid at load (flattened, a 1.1 m bowl, water 0.35 m below the rim) — 29 on the island;
the scatter grows bushes on the desert / beach sand ONLY in a pool's ring (`poolRing`, ~6–11 m) and round the beach
trees (`beachTreeNear`: the tree layer's hashed cells recomputed — nothing stored), a palm or two per pool, grass
round them (GrassField corners) and an olive / scrub ring with wet sand in the ground colour; the beach's trees are a
fifth of the map's palm sites (`FixedMap.palmCell`, 38) grown as Dark's palm — the map's clay palms are not drawn.
Water: one merged disc mesh for all pools (~800 tris, 1 draw, the clay props' program). Cost: 0 programs; draws in
the desert 171 → 141–156 at a pool (fewer plant instances), pools +1. Spawn / respawn / new-car points come from the map's
roads (`Game.roadPoint`). A map plays on ULTRA with Hold 60 unless the player chose a quality. The Island is exported
by The-Land (`tools/blender/export_dark_map.py`); its DESERT was then rebuilt in place by
`scripts/blender/island/desert.py` (2026-10-21: layered mesas, buttes, dunes, a slot canyon, three new roads — re-run
it from the pre-rebuild files, see its header). `FixedMap.beach()` (low sand with the sea nearby) keeps the beach open:
on fixed maps the scatter grows ~10 % of the trees and ~4 % of the rocks there (no oasis palm groves), the desert ~30 %
of its rocks with boulders ≤ ~4.5 m. ROAD BEDS (2026-10-21, `scripts/blender/island/roads.py`, "routes go straight into walls"): the terrain grid IS the road surface on a map (the ribbon drapes it), and the export's beds had drifted off some centrelines — summit_west ran into the coast highway's cut wall (ground 12–40 m above the road), summit_road crossed lake_road 13 m higher with no bridge, and the desert rebuild stored its new roads in world heights (6–10 m steps where they met the old ones). The pass re-grades every road (ground under the centreline where it agrees with the graded heights, the graded heights where it is a wall / hole; ends snapped onto the road they join; grade ≤ the class's or the export's), trims ends that run alongside the road they join, starts summit_road at its crossing, and carves a flat bed (half width + 1 m) with ~51° cut / ~44° fill banks that open up within ~6 m so cliffs beyond stay cliffs. Road length off its bed by > 1 m or on a > 35 % pitch: 3.75 km → 32 m (one-sample junction / abutment spikes); 16.6 k grid cells moved > 0.5 m. Data only: 0 runtime cost. MAP CARD: `scripts/blender/island/map_preview.py` — a bird's-eye Eevee render in the bright palette (cel ramp with blue shade, the map's own trees as dot canopies / pines / snowy pines, turquoise sea + river, packed-dirt roads), tilted 43.5° so the island fills the card's ~1.38 : 1 box uncropped; 1100 × 798 JPEG 210 KB (was a 1.3 MB PNG hillshade). Cost on the island (ULTRA, M4, driving): 60 fps at 1080p and with
a 4 × CPU throttle at phone resolution; ~150–190 draws, 0.35–0.65 M tris.

THE HIGHLANDS (2026-10-21, `public/maps/highlands/`) is built from a concept sheet (heightmap panel + colour concept +
palette) by `scripts/blender/highlands/build.py` (`blender -b --factory-startup --python … -- OUT=<dir> [GUIDE=<png>]
[DEBUG=<dir>]`, numpy only): the panel's grey relief → terraced plateaus with cliffs (165 m peak), a hand-placed lake +
isle and four meandering rivers from the concept, a noisy superellipse coast, roads routed by grade-costed A* on a 6 m
grid (water crossed only as level bridges), ~6.6 k pine sites, camps / cabins / a summit tower. Then the island's
`roads.py` (re-grade + beds) and `map_preview.py` (card + minimap) run on it unchanged. map.json carries two optional
keys any map can use: `palette` (sRGB hex: grass, grassDark, water, waterDeep, dirt, rock, cliff, flowers, sand →
`groundColor` paletteOf, the road soil `uRoadSoil`, the water body + a lower sky mirror `Water.setDeep(rgb, 0.42)`) and
`trees: 'conifer'` (forest = spruce / fir / pine only, drawn as the stylized TIERED PINE of `treeFactory.tieredPine` —
stacked faceted skirts in the palette greens, gentle hues, no region / autumn tint). Cost: data only plus the same
tree draws (the tiered pine replaces the Blender conifers: fewer tris); ULTRA M4 60 fps, 46–104 draws, 0.32–0.47 M tris.
DRIVABLE ROADS (2026-10-22, "some roads can't be driven"): the first routing zig-zagged up the terrace cliffs in 6 m A*
steps — switchback legs a few metres apart at different heights, so `roads.py` split the ground between them into a
wall across both beds (64 stretches > 30 % grade / > 35 % cross tilt / > 0.6 m steps). `build.py` now routes over the
relief blurred ~20 m (a cliff is climbed on a long diagonal cut), with the HEADING in the A* state (≤ one of 16
directions per turn, a turn every 2 cells: hairpin legs ~50 m apart), a cost for running within ~18 m of a road
already routed (the ring road out to the summit and back), junction nodes moved off the stream mouths (a road began
mid-bridge) and set pieces placed clear of every road. `roads.py` levels AT-GRADE CROSSINGS (the later / lower-class
road takes the other's height round the crossing). Checked by driving every road (`scripts/drive-probe.mjs FULL=1`).
On the Island the stuck spots were the export's stunt ramps / log ramps, two rock pillars and a pole standing ON the
road centre lines: removed from props.json (the ramps on stunt_spur / jump_spur / pump_spur stay — that's their job).

ZHANGJIAJIE & WULINGYUAN (2026-10-23, `public/maps/zhangjiajie/`, 4 km × 4 km, 2001² grid at 2 m) — sandstone
TOWER HILLS sculpted and eroded in Blender, approved by the user from renders before they went into the game.
`scripts/blender/zhangjiajie/terrain.py` (→ `terrain/terrain.npy`, `floor.npy`; RENDER=1 for Cycles approval renders):
the layout read from the user's height-map render (`ref/heightmap_original.png`, via build.py stage 1: spire field,
white tables, rivers) → ~120 tower massifs at ~5× the render's tip spacing (~300 m; heights × HS = 0.75 since the user asked for 3/4, tops ≈ 90–320 m, tables ≈ 340–420 m), each tapered — wide base, walls
of 61–77° that differ side to side (sheer / stepped with strata ledges / cut by gullies and alcoves), an uneven domed
top; split into fused columns of different heights; 50–70 m flat, drivable gaps; tables round the edge with ragged,
tapered rims → A.N.T. Landscape's eroder (Blender extension, `blender --command extension install antlandscape`)
for river scour and scree, clipped to −60 / +25 m. `build.py` (HALF 2000) takes that terrain (`TERRAIN=0`: the older
procedural towers), routes the roads through the gaps (lowest corridor A*, relaxed bends, 6:1 cuts), trees, props,
map.json; then `island/roads.py`, `map_preview.py`, `export-statics.mjs`. (History: a synthesised relief was "1 % of
the height map"; instanced pillar meshes on grass "small pillars on a ground"; thin terrain towers "too narrow" — the
user wants the Island's high hills, taller, many, wide, with gaps to drive round.) map.json: atlas palette (`cliff` →
`uCliffStone`, `cliffMoss` → `uCliffMoss` wall vegetation), `trees: 'liyue'`, `treeLine: 1000`, `mist` (BiomeAir.
applyMapAir: valley mist, distance tint ≤ 0.3, haze × 0.4), `aerial: [200, 2600, 0.45]` (the stylize shader's
distance desaturation — the default 30 → 600 m greyed every hill), `horizonRes: 160`, `crags: false`. Terrain LODs on
a `crags: false` map keep each coarse vertex's highest grid point; the horizon the highest of 5 samples on a cliff
cell. THE LOOK (2026-10-23, after the user's in-game check against their photos): `light` (BiomeAir.applyMapAir: a
neutral sun, a cool pale sky fill, soft cel shading — the bright style's golden light turned the jade forest yellow
and the grey-beige stone orange); `cliff` with `uCliffStone.w = 2` = NATURAL SANDSTONE in the terrain shader (no
stacked blocks: smooth faces streaked down their height — pale / grey bands, thin rust, dark wet runnels, strata
lines — and vertical flutes as a normal tilt); jade crown hues for every tree (WorldChunk JADE_HUES) at full forest
density; `grass: 0.3` (forest floor, not meadow); `mistSheets` (world/map/MistSheets.ts: 1–3 see-through drifting
cloud sheets at 45 / 90 / 150 m that fade where the ground rises to them — cloud in the gorges, no fog pass, 1 draw
each; LOW draws one); coarse terrain LODs take their normals from the coarse surface. Fixed maps have no altitude snow line (`uSnowLine`). Memory: heights.bin 8 MB (Float32 16 MB per thread: main +
each chunk worker), statics.bin 9 MB. Cost (desktop M4, headless, HIGH): 2.9–6.7 ms GPU, 46–63 draws, 0.16–0.44 M
tris; LOW hill top 2.4 ms.

## 4. Rendering

- `WebGLRenderer` created by R3F, configured in `src/rendering/renderer/configureRenderer.ts`:
  `antialias:false` (MSAA is on the scene render target instead), `powerPreference:'high-performance'`,
  `info.autoReset = false` (we reset once per frame so multi-pass stats are correct), DPR clamp `[1, 1.5]`,
  dynamic resolution scale on the scene RT.
- **Post pipeline** (`src/rendering/postprocessing/PostPipeline.ts`): scene → HalfFloat RT (MSAA 4) → one
  fullscreen shader: grading (lift/gamma/gain/saturation/tint), vignette, grain, nightmare distortion,
  tone mapping + sRGB. **One extra fullscreen pass total.**
- **Materials** (`src/rendering/materials/MaterialLibrary.ts`): shared, created once. Terrain & vegetation use
  `MeshLambertMaterial` + vertex colors (cheapest lit material that still takes fog and shadows). GLB assets may
  keep `MeshStandardMaterial` but get remapped to library materials when possible.
- **Fog**: linear-range `THREE.Fog` (smoothstep near→far): **clear up close, closing in at distance** (DAY 70→260 m,
  NIGHT 35→170 m), `far` capped at the tier's ring edge (`fogLimit`). Replaced FogExp2, which hazed everything from 0 m.
  Plus **volumetric ground mist** (skills/fog): exponential height fog integrated analytically along the view ray in
  every world material, the sky and the water (all tiers, ~0.1 ms GPU) and noise-marched drifting fog BANKS in the
  low-res shafts pass (MEDIUM/HIGH, ~0.2 ms). Per-phase `mistDensity/Base/Falloff` in `TimeOfDay.ts`.
  **Aerial perspective** (Genshin's distance "filter", `uAerial`, in every world material's fog block, ~12 ALU, no
  pass): from 30 m out to ~380 m surfaces lose saturation, then contrast, toward the haze — far hills, forest and
  rocks read as soft layered silhouettes, each ridge paler than the one in front — and the haze is warmer/brighter
  looking toward the sun, cooler away from it. It also hides where detail stops, so LOW/MEDIUM draw less: impostors
  from 50 / 70 m, far forest to 260 / 400 m, view distance 200 / 300 m (measured: far-forest cards −29…−41 %,
  MEDIUM triangles −30 %, LOW draws ≤ 71; desktop GPU time unchanged).
  Tone mapping: Khronos PBR Neutral (keeps the reference's saturation). Sun/moon shadows fade out at the shadow-map edge
  (`rendering/shadows/ShadowEdgeFade.ts`).
  distance, which sets the streaming radius, which sets the budget.
- **Shadows**: one directional shadow (sun/moon), 2048², tight ortho frustum (~70 m) following the player, snapped
  to texels. Only LOD0 chunk content casts. Flashlight shadow optional (1 map, 512²). Everything else: fake blob
  shadows / AO baked into vertex colors.
- **Lighting phases**: `DAY → EVENING → NIGHT → NIGHTMARE` keyframes in `src/rendering/lighting/TimeOfDay.ts`.
- **Art styles** (`src/rendering/artStyle.ts`, fixed per session, Settings/`?look=`): **`bright`** (default — the
  Genshin look: saturated cel-shaded meadows, fluffy card canopies, dirt paths, Sumeru-gold desert, snow-laden
  Dragonspine conifers; settings key v4 migrates old saves to it), `overland` (the
  "over the hill" look: straw meadows, solid spiky low-poly trees, faceted rocks, warm haze; also the cheapest),
  `bright` (Genshin, card canopies, painted surfaces), `storybook` (unlit painting). Each style is a keyframe set
  + material/geometry variants chosen at build time — no runtime branches. The ground palette is baked in the
  chunk workers (`WorldFields.palette`, sent with every chunk/horizon request). See skills/art-direction.
- **Weather** (`src/rendering/weather/Weather.ts`): deterministic cloud / rain / wind fields (seed + day + 20-min slot)
  modulating the time-of-day params; rain streaks (`particles/RainParticles.ts`), tree sway (`uniforms.ts` `foliageSway`).
  Precipitation follows the biome underfoot: rain in the forest, none in the desert, SNOW on the snowfields (the same
  particle pool as soft drifting flakes; a light snowfall even under a fair sky); no puddles on sand or snow.
- **Lights at night**: car head/tail/brake/reverse lamps (`Car`, F switch in the truck, auto with the dark; lamp
  positions from the catalogue `lamps`, a second pair of quads per side with `head2` — the BMW's quad lamps) light
  the road with TWO spot lights: the torch's shadowed spot is the left beam, `LightingSystem.headlight2` (no shadow,
  always in the scene so no program re-resolves) the right one, each 0.6 × the torch's intensity; street lamps on every roadside post are additive glow + road pool sprites instanced with the poles
  (`MaterialLibrary.lampGlow`) that flicker on at dusk — no extra real lights (skills/lighting fixed light pool).
- **Realistic drivetrain** (Simulation handling, the default; skills/realistic-vehicle-system): every garage car is
  its real spec sheet (`gameplay/vehicle/specs.ts`: G500 4×4², BMW E30 M3, a 1983 800 cc kei van) resolved against
  the model's measured wheelbase / track (`drivetrain/spec.ts`) into `drivetrain/Drivetrain.ts`: engine torque
  curve (petrol / turbo / diesel / EV) with idle control, limiter and engine braking → auto-clutch, torque
  converter, CVT or direct drive (velocity constraints with torque capacity) → stepped gearbox with a shift map
  (load-checked upshifts, kickdown, anti-hunting) or manual X / Z → open / LSD / Torsen / viscous / locked diffs,
  part-time and permanent 4WD, low range (Q) and lockers (K) → each wheel's ω → combined-slip tyre forces on the
  surface under it (`drivetrain/surface.ts`: road asphalt, gravel / trail dirt, region grass / sand / snow, frozen
  water ice, the weather's wetness) → applied at the contact points. Rapier does springs and contacts only (tyre
  friction 0); the car runs at real gravity (body gravity scale 9.81/20) with its spec mass, COM and inertia,
  per-axle springs from ride frequency, anti-roll bars and bump stops. Brakes with dynamic bias, EBD, ABS; TCS
  (brake + engine + launch control), ESC, counter-steer (Settings → Controls → Driving aids); static hold and
  hill-start assist. The car's exact body mesh never meets a static TRIMESH (terrain, road ribbon, formations, map
  ramps / bridges) — its convex hulls do; two hollow trimeshes clamped the car ("stuck all the time", 2026-10-21,
  skills/realistic-vehicle-system). The HUD shows tacho, gear and aid lamps; the engine sound follows the sim's rpm; wheel spin,
  dust and brake / reverse lamps read the sim. Boat and flight hand Rapier back to the legacy setup. Measured:
  +0.015–0.04 ms CPU per physics step (Node, 4 wheels, 8 substeps), no allocation per step; no GPU change.
  `tests/drivetrain.test.ts` (100 checks over the 3 cars: 0–100 and top speed vs published, shifts, parking on
  15°, TCS, 35° low-range climb, skidpad, braking, ESC, drop, boat handoff).
  BRAKE HARDWARE (`scripts/blender/vehicle_brakes.py` via the Blender MCP socket, `scripts/blender/bl.mjs`):
  `caliper_FL…RR` per corner — disc + hat + caliper (G500, BMW) or drum (the van) —
  steering and riding with the wheel, never spinning; +2 draws (one per axle, no shadow pass), +1.1–1.3 k tris;
  the same pass brought the G500 inside the then vehicle budget (39.5 k tris, 12 materials: planar decimate + merged
  near-black materials).
  RIDE + LOOK: each wheel rides deterministic GROUND ROUGHNESS (bumps, ruts, stones by surface — the terrain mesh is
  smooth at wheel scale) through its suspension, so the springs and dampers visibly work on every road (dirt road,
  45 km/h: ±5–9 cm per wheel, body roll ±3–6°). Wheels rebuilt in Blender (`scripts/blender/vehicle_realism.py`:
  knobby tread + steel / alloy rims, 2.4–2.9 k tris each) with baked Cycles AO in every part's vertex colours; the
  car shader flattens and bulges each tyre from its real load (`tyreW` attribute, `uTyre[4]`; tread shear on
  HIGH), coats the lower body and tyres in dirt from the ground it drives on, and adds paint gloss on MEDIUM+
  (a soft terminator instead of the cel step). Tris (2026-10-23, budget 30 k): BMW 15.2 k, van 29.8 k, G500 29.7 k.
  Measured seed 7, RTX 4050 laptop: no fps change (144 capped), GPU within noise (4.6–6.3 ms HIGH, 2.8 ms LOW).
  DRIFT + KIT: handbrake slides can be caught and held (no shifts mid-slide, handbrake declutches, full lock into
  a slide, each car's real aids by default — the 1983 kei van has no ABS / TCS / ESC);
  tests/drivetrain.test.ts checks catch (all) and hold (the BMW).
  BURNOUT + TYRE HEAT: W + S (touch: DRIFT + stick forward at a standstill) = gas + foot brake 0.75 → a brake-stand:
  the front-biased brakes hold the fronts, the engine spins the driven rears (manual: clutch held to ~75 % of the
  redline, then dumped). Per tyre a two-lump tread temperature (`Drivetrain` `TYRE`) from the sliding power: grip
  falls past 120 °C, smoke from 140 °C, FIRE at 360 °C (bulk ≥ 170 °C) — measured on an 85 kW LSD rear-driver: smoke 2.7 s, fire ~21 s, 0.0 m
  of creep; open diff (a one-wheel peel) 3.1 s / ~15 s, 0.3 m; limit cornering 30 s and 0–100 stay < 110 °C.
  VehicleFx: heat smoke, additive flames + soot + a glow sprite in the SAME draw (premultiplied blending; no real
  light — no point-light pool exists); HUD lamp `TYRES n°C` / `TYRE FIRE`, toast on ignition, synthesized crackle.
  Cost: thermal ≈ 0.2 µs per physics step, +320 B; GPU (M4, 1280×720, seed 7, 6.5 m chase) burnout HIGH ≈ +0.4 ms,
  LOW within noise (the 110-sprite cap), fire HIGH / LOW within noise; +0 draws, +0 programs. Every car carries real kit built in Blender
  (`scripts/blender/vehicle_details.py`: racks, spares, jerrycans, lights, snorkel, sliders, flaps; 560–1270 tris).
- **Arcade handling** (`VehicleSim.TruckSim.arcade`, Settings → Controls → Driving): Asphalt-style —
  Rapier keeps suspension, contacts and crashes; `driveArcade` adds a scripted longitudinal force (0→100 km/h ≈ 3.7 s,
  top ≈ 163 km/h stock = `arcadeTopSpeed(tune)`, nitro ×1.32 / ×1.7 accel), straight-down downforce; `afterWheels`
  SETS the yaw rate from the stick (radius 5.5 + 0.2 v + 0.02 v² m) and ROTATES the velocity toward the nose without
  scrubbing speed. DRIFT: brake tap (S / stick back) or handbrake while steering above 40 km/h → slide held at
  30–40° (the velocity follows the nose at its own yaw rate), fills the NITRO bar (also air time, smashed props).
  Air: self-levelling. Touch: auto-accelerate, NITRO + held DRIFT buttons. Chase camera re-centres behind the
  travel direction 1.2 s after the last look input; FOV widens with speed. HUD: speedometer + nitro bar.
  The legacy realistic model remains for cars without a spec and under the boat / hover; tests/vehicle.test.ts
  covers arcade and legacy, tests/drivetrain.test.ts the drivetrain.
- **Sound** (`src/audio/AudioSystem.ts`, files in `src/assets/audio/`, credits in ASSET_LIST.md): a WebAudio mixer —
  master (Settings → Audio → Sound mutes everything) → music bus (Theme music) + effects bus. Persistent loops follow
  the game each frame (`frame()`): engine idle + drive layers through a simulated gearbox driven by the wheels' rim
  speed (`VehicleSim.wheelSpeed`: burnouts / drifts rev it), each car's own pitch and shift points (catalogue
  `engine`), a reverse gear, load-dependent loudness (coasting is quieter) and a dip at every shift, boost rush, tyre squeal from
  wheel slip, bike rolling + freewheel, rain, the theme (fades out with the dark and the nightmare). One-shots: doors,
  engine start/stop, footsteps on every foot plant of the animation (`CharacterModel.steps`). Loaded after the first gesture; the game never waits for audio.
- **Snow / sand build-up on the car** (`Car.ts` `updateDirt`, car shader): `uSnowCoat` / `uSandCoat` (0..1) grow
  with speed and wheel spin while the region under the car is snow / desert (snow ≈ 80 s at 36 km/h; a parked car
  in the snowfield slowly collects it), melt / wash off elsewhere, in rain and in water. Snow: caps on up-facing
  panels spreading in clumps + a packed band up the sides whose top climbs to ~1.25 m + flecks; sand: a fine
  speckled dust film (specks below a pixel fade to their mean — no sparkle), caked low down, dust on the tops. Matte.
  ~25 ALU on car fragments, 0 draws; `g.car.coat` for dev shots.
- **Vehicle effects** (`src/rendering/particles/VehicleFx.ts`): exhaust puffs + tyre smoke/dust as one tier-capped
  point-sprite draw (`quality.particles.vehicle`), driven by the vehicle simulation's per-wheel slip.

---

### Beyond the chunks
Horizon terrain (1 draw, worker-built, rebuilt every size/6 of travel) shows the world to ~0.8–1.5 km; a single
water plane at `WorldFields.WATER` shows lakes/rivers wherever terrain dips below it (frozen — still mirror ice with
cracks and drifted snow — wherever the biome map says snow). Fog therefore closes at the horizon, not at the chunk
ring (see skills/art-direction, skills/fog).
**Planar water reflections** (`rendering/water/PlanarReflection.ts`, `QualitySettings.reflections`: MEDIUM 0.25 every 2nd
frame, HIGH 0.5, ULTRA 0.75, off on LOW → sky-colour mirror): the scene mirrored about the water plane (oblique near plane), rendered only when a
line-of-sight test over the loaded terrain sees water (`WorldManager.waterInView`, every 4th frame). Undergrowth,
small rocks, crops, poles and fences are on `LAYER_NO_REFLECT`; near chunks show their merged LOD1 trees in the mirror
(`LAYER_REFLECT_ONLY`). Measured HIGH, M4, 1280×720: +62–75 draws, +80–120 k tris, ≈ +1.5 ms GPU, +0.5 ms CPU while
water is in view; 0 otherwise.

## 5. Optimization layers

```
World → loaded chunk ring (streaming radius)
      → chunk AABB vs frustum (≤ ~80 tests / frame)       ChunkVisibility
      → chunk LOD ring                                    LodSelector
      → per-object Three frustum test only inside visible chunks (few objects per chunk)
```

Never iterate individual trees on the CPU per frame. Trees are `InstancedMesh` per chunk per species per LOD,
with a bounding sphere covering the chunk; the chunk decides visibility.

**Cross-chunk batching (2026-10-21, `src/optimization/batching/`)** — the chunks still BUILD per-chunk meshes, but
they don't DRAW them: ULTRA went from ~160–200 draws to ~50–80 (island / endless world), same frame, same programs
(`?batch=0` turns it off for A/B checks — the screenshots must match).
- `ImpostorBatch`: every tree impostor card (chunks + far forest) in ONE InstancedMesh; each source owns a range,
  re-uploaded only when it streams / changes LOD (47 draws → 1).
- `InstanceBatcher`: each chunk's InstancedMeshes (tree species, rocks, ferns, bushes, poles, fences…) leave the
  scene; one batch per (geometry, material, shadow flags, layers) draws them all, chunk offset baked into the
  instances. `sync()` polls each source's `visible` / `count` / buffer versions (WorldChunk logic is untouched).
  Near-ring chunks out of view go to a SHADOW-ONLY batch (0 instances in every other render) — they still cast.
- `TerrainBatch`: every chunk's terrain grid in one `BatchedMesh` (multi-draw), one LOD0-sized slot per chunk.
- `MeshBatcher`: the one-off meshes (formations, road ribbons, buildings) in `BatchedMesh`es (28 draws → 1–2).
BatchedMesh culls per chunk (camera and light) and sorts front to back. Shaders that read world positions handle
`USE_BATCHING` (stylize: terrain `vWorldPos`, biome cover). Without `WEBGL_multi_draw` three loops the draws — never
worse than before.

**Trees: per-tree LOD + octahedral impostors + far forest** (skills/lod §2): past `impostors.start` (60–130 m by
tier) each tree dithers from its mesh into a camera-facing card showing the tree baked from 64 directions
(`rendering/impostors`, atlas baked at load), choosing its LOD by its own distance in the shaders (no chunk
popping); the chunk only enables the mesh sets its trees can be in. Beyond the built ring a FAR FOREST of
impostor-only trees (`world/Forest/FarForest.ts`, same deterministic scatter, own worker, 4×4-chunk blocks, seated
on the drawn horizon surface) reaches `impostors.far` (360–900 m) and dissolves into the horizon terrain.
Measured (RTX 4050, 1080p): GPU time within noise on every tier, LOW +8 draws (≤ 65), fewer triangles.

---

## 6. Physics (Rapier)

- `src/physics/PhysicsWorld.ts` owns the Rapier world, fixed 60 Hz step with accumulator.
- Terrain: one heightfield collider per chunk inside physics radius; removed when leaving it.
- Trees: fixed cylinder collider for trunk only, only inside physics radius. No colliders for plants/grass.
- Rocks: one convex hull per boulder built from the rock mesh's own vertices with the instance's scale/rotation
  (tested: every rendered vertex is inside). The physics ring also covers where a moving vehicle will be in ~1.5 s,
  and a vehicle on ground without colliders is frozen instead of falling through.
- Player: `KinematicCharacterController` + capsule.
- Vehicles (`src/gameplay/vehicle/VehicleSim.ts`): dynamic raycast vehicles (truck 4×4 with a DRIFT mode on the
  handbrake / boosted power slide, BMX with a balance controller); `tests/vehicle.test.ts`. See skills/physics.
- **The garage** (`src/gameplay/vehicle/catalogue.ts`): every drivable car — model URL, stock setup, tuning ranges,
  paints. Models are baked by `assets/loadModels.ts` `bakeVehicle` (materials → vertex colours + a `paintMask`
  attribute, plus for textured models a per-pixel PAINT MASK from the texture's dominant body hue so paint never
  reaches rims, tyres, glass, chrome, lights or rust; LAMPS found on the model — pale front lenses / red rear lenses
  in the texture, or named lens/glow parts — so head and brake lights sit on the real lamps; wheels split out by
  name or shape, glass split off, normalised to metres / −Z / wheelbase origin) and
  loaded on demand (`loadVehicle`, cached). `Game.selectVehicle` swaps the car in the world live; `Game.setTuning` →
  `Car.retune` → `TruckSim.retune` changes power / force / boost / grip / springs / tyre size / mass in Rapier in
  place; paint tints the masked panels in the car shader. Saved per vehicle in Settings (`garage`).
- **Scale**: real-world. Each car's `length` is set so its WHEELBASE matches the real vehicle (G500 4×4² 2.85 m,
  BMW E30 2.57 m, kei van 1.84 m); the player is a 1.78 m adult — the hero (`hero.lod0.glb`, built by
  `scripts/blender/hero/`: AI-generated body, rebuilt face + modelled hands, Mixamo rig of 65 bones incl. fingers,
  15 k tris, 1024² albedo on `MaterialLibrary.hero`, 2.3 MB) animated by `CharacterModel`: 13 Mixamo clips — idle,
  walk → jog → run → sprint blended by speed on one shared foot phase (stride lengths measured from the clips: no
  sliding), walk-back / strafes by travel direction vs facing (flashlight aiming), jump → fall, landing, knockdown →
  get-up scrubbed by `knock` — plus leg IK onto the terrain, the flashlight arm, footsteps from the phase; car seat /
  BMX / bail-tumble poses stay procedural (the 15-bone driver rig) and are retargeted onto the Mixamo bones (hands
  re-solved onto grips / wheel by IK). Clip ⇄ procedural switches blend over 0.22 s; the ground clips keep their own hip sway (pinning the hips slid the planted feet), the upper sleeves follow the arm (Mixamo had skinned them to the spine; arm-vs-torso shares re-derived in scripts/blender/hero/build6.py). Cost: ~0.08 ms CPU / frame
  (desktop), 1 draw, +5.3 MB texture VRAM. Same capsule and 1.62 m eye. (The old `scripts/blender/human.py` model is
  no longer loaded.)
- **Doors, cabin, axles** (models prepared in Blender: `scripts/blender/vehicle_doors.py` + `vehicle_finish.py`):
  the front doors are separate parts (`door_FL*`/`door_FR*` with a `hinge` glTF extra, dark jamb in the opening),
  the steering wheel is a named part on every car, and only the base-colour texture is kept (≤ 1024²; the BMW's
  one 1024² JPEG). The BMW and the van come out of ONE script, `scripts/blender/vehicle_prep.py CAR=bmw_e30|carry_van`
  (normalise → debadge → wheels → decimate to budget → bake textures into vertex colours → matte role materials →
  calipers → doors → steering wheel, pedals, gear lever, dial → AO → export), then `vehicle_hooks.py`;
  `vehicle_trim.py` brings a finished car under 30 k tris and makes its materials matte (metallic 0, roughness 0.85:
  the source gloss read as glitter). `Car` hangs each door on its hinge (one instanced draw on the car program +
  its window): held by the entry animation, else latched, else swinging free (the car's acceleration and the head
  wind; slams shut). Live beam axles + diffs + driveshaft (catalogue `axles`, models without their own) are one
  5-instance draw that tilts with each wheel's suspension. Cost with the car in view: +5 draws (+10 on HIGH with
  its shadow pass), ≈ +1–2 k tris, GPU/CPU within noise on every tier.
- **Shock absorbers, air suspension, flying car** (every car): each wheel has a coil-over strut (dark damper body +
  chrome rod + blue coil spring, instanced on the car program, +2 draws, ~2 k tris) from the hub to a mount in the
  arch. ↑ / ↓ (touch ▲ ▼, shown only while driving) raise the body up to 1 m on its wheels (`TruckSim.ride`: the
  Rapier suspension rest length grows; the struts and springs stretch). L (touch FLY / LAND) transforms the car
  (`Car.fly`, 1.2 s): wheels turn flat, tuck into the arches, spin up like turbines and blue jet flames light under
  them (1 additive instanced draw, only while flying) — `TruckSim.hoverStep` then replaces the wheels: W/S thrust
  (≈ 38 m/s, Shift ≈ 60), A/D yaw with bank, ↑/↓ climb / sink at ≈ 9 m/s, altitude hold when released, never
  below 0.8 m over the terrain. Landing sinks to ~1.3 m before the wheels fold back; E in the air bails out and the
  empty car lands itself. tests/vehicle.test.ts covers lift, hover hold, climb, flight, banked turn and landing.
- **Amphibious boat** (every car; `gameplay/vehicle/BoatHull.ts`, `Car.toggleBoat`, `TruckSim.driveBoat`): O while
  driving (touch BOAT / CAR) turns the car into a jet boat in 2.2 s, the WHEELS being the gadget — the body rises
  0.22 m on the air suspension, each wheel folds flat, slides in under the car spinning like a turbine disc and
  spreads into a thin disc, the keel pack forms out of the four discs (the tyres vanish into it) and telescopes out,
  the sides swing up about the chines, the bow lowers like a drawbridge, the transom and jet nozzle fold out (a clunk
  as each part locks) and cyan LED strips along the rub rails scan bow → stern, then glow (+3 additive draws); O
  again reverses it. ONE hull asset (`scripts/blender/boat_hull.py` → `boat_hull.lod0.glb`, 696
  tris, 6 parts + hinge pivots as glTF extras, vertex colours) is FITTED per car at load (width from body / tyres,
  keel 0.22 m below the tyres, floor above the floating waterline so no water shows inside, gunwale over the door
  sills, bow 1.6 m ahead of the bumper). Afloat (`WorldManager.waterAt`: liquid water only — not frozen, not desert):
  buoyancy at 6 bilge points (draft 0.36 m, damped, small travelling waves → it bobs, pitches, rolls), a water jet
  (≈ 54 km/h, Shift ≈ 79) vs hull drag, keel side grip, nozzle steering (it yaws on the screen too), lift shifted
  forward over the planing hump (bow up ~7°) and outboard in turns (banks into them). On land it crawls on its keel
  (≤ 16 km/h) — drive in and out up a beach. Rules: O is refused while flying ("Land first"); L from the boat folds
  the hull as the wheels become jets; landing (L) over water puts the hull out on the way down; afloat, E (get out)
  and O (wheels) are refused with a HUD notice. VehicleFx adds bow spray, the jet's rooster tail, a foam wake and a
  splash on hard water entry (same tier-capped point pool; spray falls and turns to foam). Cost with the hull out:
  +6 draws on the car's program (0 new programs; +6 in the shadow pass where objects cast), +696 tris, 6 surface
  lookups + 6 point forces per physics step; measured seed 7 on the open lake (RTX 4050 laptop, 1280×720): LOW
  GPU 3.4–5.0 ms / CPU ≈ 2 ms planing with spray, HIGH 3.7–5.3 ms / ≈ 4.3 ms — within the noise of driving there.
  tests/vehicle.test.ts covers floating, planing, boost, banked turn, reverse, sinking without the hull, the land
  crawl and driving out up a beach.
- **Getting in / out** (`gameplay/vehicle/CarEntry.ts`, GTA-style): E walks the player round the car to the
  nearer front door (path never cuts through the body), opens it (hand on the handle, stepping out of its sweep),
  climbs in ducking under the roof line, pulls it shut (slam) — drivable from here — and slides over to the wheel
  if it came in on the passenger side; out = push the driver's door open, climb out, push it shut (walking off
  leaves it open). Faster than 4 m/s E is a BAIL: thrown out tumbling, door flung open on its free hinge. Poses are
  authored in car space and solved by `CharacterModel.carPose` (two-bone IK for hands on the handle / the turning
  steering wheel and feet on the floor); a cramped cab tucks the seated body in (≥ 75 %; catalogue `cabin`:
  hip height, roof). ~0.02 ms CPU. tests/vehicle.test.ts covers both doors, the slide-over and the walk path.
- **Front end** (`src/ui/MainMenu.tsx`, `Garage.tsx`, `SettingsPanel.tsx`, tokens in `ui/theme.ts`): a racing-game
  style menu over a still KEY ART image (`ui/KeyArt.tsx`: `src/assets/ui/key-art.jpg` / `key-art-sm.jpg`, also the loading screen; layouts + phone breakpoints in `ui/frontend.css`, colours in `ui/theme.ts`):
  `Game.render` draws no 3D frame while the main menu is up — the world streams in behind it. The garage shows the
  live car (`CameraController.garage`) once `worldReady`. LOADING: the boot screen closes as soon as the code, physics
  and models are in (~1.5–2 s); the player / truck / bike are placed only when the spawn chunk (and the roads its
  worker built) arrive (`Game.pendingSpawn` — `surface` on the main thread before that ran the road A* for seconds);
  PLAY before the 5 × 5 chunks round the player exist shows "Entering the world" (`Game.playReadiness`). The first
  chunk goes to ONE worker and its roads are forwarded to the others (`ChunkStreamer`); the far forest waits for the
  near chunks. Road searches share ground samples on a 6 m world lattice (`RoadNetwork` HeightSamples) and a
  driveway's crossing check reaches 2 places back (`DRIVE_DEPTH`; unlimited it walked 10–15 km for one chunk).
  MAIN MENU: Play / Garage / Settings + the current car's card.
  GARAGE: car strip (tap → swapped in live), Performance tab (sliders + live rating), Paint tab (named swatches +
  custom), Back / Drive. SETTINGS: full-page tabs Garage / Graphics / Controls / World (`Garage embedded`).
  `Game.showScreen`, `play`, `openSettings`. `?play=1` skips the menu (tests), `?car=<id>` picks a car.

---

## 6b. Destruction

`gameplay/destruction/Destruction.ts`: fences, power-line posts, hay, woodpiles, tents, ruins, cabins, houses and
barns break when the truck hits them fast enough (strength per type, m/s for 1750 kg — fence 2.2, post 8.5, house 21;
heavier vehicles need less speed). Rapier contact-force events on the prop colliders (`PhysicsWorld.props`,
`afterStep`) → the collider is removed, the instance hidden (`WorldChunk.breakProp`: instanced poles/fences zeroed,
building mesh rebuilt, power-line spans of a broken post dropped), ≤ 48 physics DEBRIS boxes (1 instanced draw)
thrown with the truck, which keeps (1 − loss) of its speed. Broken props are listed per chunk (`PhysicsWorld.broken`)
and REBUILT when the chunk unloads (drive away and come back). Crash sound synthesized (`AudioSystem.crash`).

## 7. Multiplayer (2026-10-21: dedicated server in `../server/`; rooms + bots wired)

Battle-royale matches of up to 100 players on the fixed maps run on a dedicated, authoritative **Rust server**
(`../server/README.md`). Over WebSocket, clients stream their own simulated pose at ~30 Hz. The server validates it
against the map's heightfield (speed, teleport, ground, bounds), owns the match, zone, damage and eliminations, and
sends each client the players near it (interest tiers, 30 / 15 / 5 Hz) to interpolate ~100 ms in the past. The world
is **not** sent: the map id (or the seed) and deltas only.

The wire format is `src/net/protocol.ts` (`npm run test:protocol` checks it against the server's golden vectors).

**Rooms** (what players see). There is no host / join menu: every game started (endless world or a map) opens a
room the player owns: `Game.play()` / `?play=1` → `NetClient.ensureRoom()`, with the menu's PUBLIC / PRIVATE toggle
and ROOM SETTINGS (`store.roomSetup`, persisted). The landing page lists public rooms (top-right panel on desktop, a
floating ROOMS button + modal on phones: `ui/Rooms.tsx`) and joins by click or code. A room in another world reloads
into it (`?seed=` / `?map=` + `?room=CODE&play=1`, `App.tsx`), since worlds are built once per page. In game the
room pill (toolbar / under the minimap on touch) opens the room card: code, players, the owner's settings + kicks.
- `net/NetClient.ts` (loop system `net`, after `bike`): guest session, room REST calls, the socket. It sends the
  local pose at 30 Hz (`Game.localPose`: the car's when driving) and applies `Welcome` spawns / `Correction`s
  (`netRelocate` / `netCorrect`). Roster, room and status go to `store.net` (low frequency), never per-frame state.
- `net/RemotePlayers.ts`: others drawn ~100 ms in the past (interpolated, ≤ 200 ms extrapolation), built for a crowd
  (draws don't grow with players): cars in three LODs — the nearest `remoteCars` within 35 m drawn EXACTLY like
  the player's car (`net/RemoteCar.ts`, pooled per model: Car's shared `truckMaterial`, cabin, doors, brakes,
  dampers, lamps from LIGHTS / BRAKING / reversing, jets when FLYING, the hull when BOAT; wheels roll with the
  forward speed and the fronts steer by the turn rate, atan(wheelbase · yaw rate / speed); ~12–15 draws each), then
  instanced per model: a simplified one (vertex-clustered ≤ 2 k-triangle body, texture baked into colours,
  12-sided wheels) to 110 m, boxes to 900 m; a car stays PARKED where its driver got out; the nearest
  `remoteCharacters` on foot animated (1 skinned draw each, no sun / dynamic shadow), the rest instanced
  low-poly people; blob shadows under both (1 draw); all name tags in 1 draw (atlas, nearest 10). Phones cap the
  full models at 6 people / 3 cars on every preset. BOTS (ids ≥ `BOT_ID_BASE`) are set on this client's ground.
  WORST CASE (100 cars + 100 people within 70 m, `scripts/crowd-probe.mjs`): 2.26 M → 0.96 M triangles, 96 → 160
  fps uncapped (M4, ULTRA, desktop and phone viewports), +16–20 draws.
- ROOM BOTS (`../server/crates/sim/src/bots.rs`): server-run players the owner sets (0–100, room settings); they
  cruise, race, convoy, explore, boat, fly, stroll and hang out; the client only draws them. `scripts/bots-probe.mjs`.
- SERVER-SIMULATED CARS (2026-10-22, protocol v4, `../server/docs/VEHICLE_PHYSICS.md`): in map rooms the server
  runs the game's car model (a Rust port, golden-tested against this one) for every bot and for each person driving
  in Simulation handling. `net/VehicleSync.ts` sends the car's controls per physics step (`Input`), keeps predicting
  locally (the same model) and reconciles with the server's `VehicleState`; `net/RemoteColliders.ts` puts the nearest
  remote cars into our physics world as boxes where the server's will be. Boats, flights, arcade, walking, the BMX and
  endless worlds stay client-simulated and validated.
- `?net=0` plays offline (screenshot / benchmark runs teleport — the server would correct that).
- Offline (no server) the game plays on alone; the room UI says the server can't be reached. Server URL:
  `VITE_DARK_SERVER`, else this host on port 7350.
- Check: `node scripts/rooms-probe.mjs <dir>` and `scripts/rooms-touch.mjs` (with `npm run dev` + the server).

Next: battle royale in the game (zone in the HUD / minimap, spectating). The older 4-player
peer-host notes in `skills/multiplayer` still apply to a co-op mode.

---

## 8. Directory map

```
src/
  app/            App.tsx (DOM root), Canvas.tsx (R3F canvas + renderer config)
  game/           Game.ts (owns all systems), GameLoop.ts (ordered systems), GameState.ts (low-freq store)
  scene/          R3F composition components: World, Camera, Lighting, Environment, Effects
  world/          WorldManager (chunk lifecycle), WorldChunk.tsx, WorldGenerator (pure)
    Terrain/ Road/ Forest/ Cave/ Streaming/ noise/
  rendering/      materials/ shaders/ lighting/ shadows/ fog/ postprocessing/ renderer/
  optimization/   culling/ lod/ instancing/ batching/ streaming/
  physics/        Rapier wrapper, colliders
  gameplay/       player/ bmx/ monsters/ flashlight/ interaction/ survival/
  input/          keyboard/mouse/pointer-lock
  multiplayer/    networking/ interpolation/ state/ (reserved)
  net/            protocol.ts (the server's wire format, ../server/docs/PROTOCOL.md), NetClient.ts, RemotePlayers.ts
  assets/         models/ textures/ animations/ audio/  (optimized outputs only)
  debug/          PerformanceMonitor, CullingDebug, ChunkDebug, PhysicsDebug, DebugHud
skills/           how-to docs per system (read before implementing)
refer/            visual reference images (style guidance, not specs)
scripts/          asset validation tooling
```

URL options: `?seed=<n|text>` (default: random per game) · `?tier=low|medium|high` · `?adaptive=0` ·
`?stress=<ms>` (dev only, simulated slow device).

Headless verification: `npm run dev`, then `npm run shot -- <outdir> <shots.json>` (`scripts/shoot.mjs`, local Google
Chrome via puppeteer-core) teleports/drives/times the scene per shot, screenshots it and prints fps + GPU/CPU ms per tier.
Road check: `MAP=<id> FULL=1 HEADLESS=0 TIER= node scripts/drive-probe.mjs <outdir>` — an autopilot drives every road
of a map end to end (offline), logging each STUCK / thrown-OFF spot (position, wheel contacts, what the body touches)
and the fps every second (spots below FPS_LOW). HEADLESS=0 is a visible window that keeps full speed unfocused.

## 9. Debug keys

| Key | Action |
|---|---|
| `F3` | toggle performance HUD |
| `F4` | chunk bounds / LOD colouring |
| `F6` | Rapier collider wireframes |
| `T` | day ⇄ night (animated: the sun travels) |
| `G` / `N` | next time preset (dawn/day/evening/night) / nightmare realm |
| `V` | first ⇄ third person |
| `O` | settings (quality, AA, sharpness, resolution, pixel ratio, grain, camera, sensitivity, day length) |
| `F` | flashlight |
| `E` | mount / get off the BMX (touch: BIKE) — W/S pedal/brake, A/D steer, Shift faster |
| `L` | in a car: fly ⇄ land (touch: FLY / LAND) |
| `X` / `Z` | in a car (Simulation, manual gearbox): gear up / down |
| `Q` / `K` | in a car (Simulation): low range / lock differentials (G500) |
| `↑` / `↓` | in a car: raise / lower the body (air suspension); flying: climb / sink (touch: ▲ ▼) |
| `F7` / `F8` | cycle quality preset low → ultra (disables auto) / toggle adaptive quality |
| touch | left half: joystick (full push = sprint) · right half: look · LIGHT / JUMP / FPS / TIME / fullscreen buttons |
| `[` / `]` | render scale down / up (within the tier's range) |
| click | pointer lock; WASD move, Shift sprint, Space jump |

## 10. Over the Hill (`oth.html`, `src/oth/`) — map 3, a world of its own

2026-10-26: map 3 is a NEW project inside this repo — "Over the Hill" stylized realism (painterly ground, art-directed
PBR-ish light, rolling mountains, warm cinematic air). It shares NOTHING of the game's world / rendering code: no
React, no WorldManager / stylize / bright style. Planned reuse: the vehicle physics and the vehicle models only.
The Select-map card (`MapInfo.page`) opens `/oth.html`; it is not a room map (the server doesn't know it yet).

- **Map** (`scripts/oth/terrain.py`, Blender's Python + numpy → `public/oth/valley/`): a 4 km playable box (2 m,
  `height.bin` Uint16 2049²) inside a 16 km world (16 m, `far.bin`), box mask at 4 m (`mask.bin` RGBA8: rock,
  dryness, wet — 1 = water + its gravel edge, forest), `meta.json` (grids, lake, river centre line + surface heights,
  spawn). Macro landform (rolling hills, ranges where a low-frequency mask says, the valley kept open) → vectorised
  droplet erosion → 2 m detail → valley floor / river channel / lake bowl carved with SLOPED banks (a flat shore turns
  mesh error into a zigzag water line). `PREVIEW=<dir>` writes top-down hillshades. ~17 s.
- **Look (2026-10-26, the user: "low poly like stylized", "smooth", "exactly like Over the Hill")**: SMOOTH landforms
  (light erosion kept only as broad shaping, no 2 m detail noise, soft broad colour fields — no speckle) and LOW-POLY
  light: the terrain blends each triangle's flat normal (`dFdx/dFdy`) over a soft normal (the normal grid a few mips
  up) — full facets on rock / snow, gentle on grassy hills — plus a per-facet tone jitter (`facetRand`).
- **Terrain** (`Terrain.ts`): CDLOD on the GPU — one patch mesh instanced per quadtree node (ONE draw for 16 km), heights
  from R16UI textures (4 texelFetch, exact), per-vertex geomorph through up to 3 levels (no pops, no cracks), CPU
  selection with a min/max pyramid + frustum. Fragment: the mask (procedural outside the box) painted by
  `groundPaint` (`paint.ts`: palette + world-space paint noise from `noiseTex.ts`, generated at boot).
- **Grass** (`Grass.ts`): the Over-the-Hill CARPET — low-poly tufts of thick pointed blades (6 per tuft, 20 cm wide,
  quad + tip; the far ring 3-blade triangles), even heights. THE GRASS IS THE GROUND GROWN UP: each blade takes
  `groundPaint` at its root (green ground → green grass) and the ground's soft normal, so a hill shades as one surface;
  only a root-to-tip ramp and a per-blade sun-facing nudge separate them. Three rings of world-locked tiles (one
  instanced draw each); per-tuft rank culls by a distance density curve and widens the survivors (same coverage, no
  ring edge); LOW = fewer, wider tufts (`uWidthK` vs HIGH's 17 tufts/m²), never a thinner field. None on rock, snow,
  water's gravel / earth band; thinner under the forest.
- **Light / air** (`Atmosphere.ts`): one shared uniform set + GLSL (`skyColor`, analytic height-fog aerial
  perspective toward the sky's horizon colour, wrapped-diffuse + GGX `shade`); sun path by hour (default 17:00).
  **Terrain sun shadow** (`TerrainShadow.ts` + worker): horizon march over both height grids → R8 textures (box 4 m,
  world 16 m), soft penumbra, re-baked when the sun moves ~1°; one fetch per pixel / blade root, no shadow-map pass.
- **Water** (`Water.ts`): lake disc + river ribbon; depth from the height grid in the fragment shader (no depth
  pre-pass) → see-through shallows → teal, shore line, Fresnel sky, glints, downstream flow.
- **Post** (`Post.ts`, MEDIUM+): HDR target (MSAA 4) → dual-filter bloom, vignette, Neutral tone map, dither. LOW
  draws straight to the canvas (same tone map, no bloom).
- **Tiers** (`quality.ts`, `?tier=`; DEFAULT ULTRA on every device — the user's call, 2026-10-26; with trees, bushes,
  rocks and the car, M4 1280×720 uncapped: LOW 1.4–1.7 ms GPU, MEDIUM 2.6–2.7, HIGH 4.2–4.6, ULTRA 6.4–7.2, phone
  viewport ULTRA 6.3–7.2): LOW terrain 16-quad patches / near 80 m, grass 38 m @ 9 tufts/m² × 6 blades,
  rocks to 900 m; ULTRA 32 / 300 m, 72 m @ 26 × 11, rocks to 2.6 km. Cost (M4, 1280×720, uncapped): LOW 1.0–1.3 ms
  GPU, 90–130 k tris, 10–13 draws; MEDIUM 2.5–2.7 ms; HIGH 2.6–3.9 ms, 0.3–0.48 M tris; ULTRA 4.9–6.8 ms, ~1 M tris.
  Phone viewport LOW: 0.6–0.8 ms, 50–63 k tris. Shrub dots / pebbles: one texture fetch each (paint texture's cell
  channel), no loops.
- **Verify**: `node scripts/oth-shot.mjs <outdir> <shots.json>` (needs `npm run dev`; PORT, UNCAPPED=1, PHONE=1) —
  shots at x / z / h / yaw / pitch / hour / tier; prints fps, CPU / GPU ms, draws, tris, patches, blades. Debug:
  `?stats=1` or F3; fly with drag + WASD / Space / C / Shift.
- **Erosion** (terrain.py): vectorised droplet erosion, 1.6 M drops in the box (4 m) and 2.4 M in the world (16 m),
  speed capped and the change per batch clamped (a vectorised batch can pile many drops into one channel cell →
  runaway → NaN). Kept in full on steep / high ground (gullied mountain faces, drainage networks); the gentle hills
  keep only its broad shaping (on a soft slope parallel droplet channels read as ripples).
- **Trails** (terrain.py → `trail.bin`, `meta.trails`): DIRT TRACKS by A* on an 8 m grid (cost len·(1 + 25·grade²) ×
  a slowly varying field so they wander, > 30 % or the lake a wall, the river a costly ford, cells already on a track
  cheap so routes merge), spawn ↔ lake, the south exit, the box's prominent hilltops joined to the nearest track;
  RDP → Catmull-Rom → Chaikin, a smoothed height profile CARVED into the ground (±hw + 5 m). The ground paints
  packed earth + two ruts with a ragged edge from the distance field; the grass keeps off it (its blades keep the
  field's colour at the edge).
- **Rocks** (`Rocks.ts`): chunky chamfered blocks (hull of a jittered box's chamfered corners, creased normals:
  flat faces, soft edges), light blue-grey; outcrops on steep ground / the rock mask, lone boulders, river stones;
  never on a track or in water; deterministic; one instanced draw per shape; re-picked only when the camera crosses a
  128 m cell; their 2 m footprint texture keeps the grass out of them.
- **Matching Over the Hill** (`scripts/oth/compare.py`, Blender python): pairs of (reference crop, our render crop)
  scored 0–100 on colour (HSV histogram), tone, texture energy in 3 bands, stroke orientation; writes side-by-sides.
  2026-10-26: 25 rounds, 53.8 → 64.8 overall (golden slope 86, golden field 75, green 67, trail 59, mountain 58,
  rock 57, ground 58, far hillside 59). The rest is mostly content OTH has and we don't yet (pines, bushes, snags).
- **The 4×4s** (`Vehicle.ts`, `Physics.ts`, `ChaseCam.ts`; 2026-10-26): the game's own vehicles — `loadVehicle` models,
  `TruckSim` + the spec-sheet drivetrain (Simulation handling, full aids, off-road assist) in the game's Rapier
  `PhysicsWorld` — on this map: the ground as 256 m heightfield tiles of the 2 m grid streamed 3 × 3 round the car,
  the rocks within 160 m as convex hulls of their drawn shapes, walls 40 m inside the box's edge. Tyres read this
  map's surfaces (dirt on the tracks, grass, sand / gravel at the water, rock). Drawn with this world's light
  (`shade`, the terrain's baked sun shadow) + a terrain-hugging contact shadow; paint per car (rust G500, cream E30,
  orange kei van; `?paint=`). Chase camera with drag-orbit; V = free camera. Keys W A S D / Space / Shift / R / 1 2 3,
  touch ◀ ▶ GAS BRAKE ⟲. Cost: the car + shadow ≈ 8 draws; LOW 1.45 ms GPU with it.
- **Trees** (`treeGeometry.ts`, `Trees.ts`; new for this world): the OTH spruce / golden larch — stacked FRILLED
  SKIRTS (dark apex, raised shoulder, a fringe of hanging saw-teeth gathered into plumes), indexed, **864 vertices**
  near, 217 mid; snags = the trunk + branch stubs. One instanced draw per LOD for every species. IMPOSTORS beyond
  `treeMid`: at load each species' near LOD is rendered from 12 azimuths × 3 elevations into a 2-target atlas (albedo ×
  AO sqrt-encoded, tree-space normal); a far tree is one camera-facing quad picking the nearest view, relit by the sun
  from the normal image, mip-corrected alpha (alpha-to-coverage on MSAA tiers). Beyond `treeFar` a rank cull thins the
  forest (survivors grow). Culling: 64 m tiles (distance + frustum), lists rebuilt only when the camera moves 4 m /
  turns. SHADOWS AS AN IMAGE: every tree stamps a soft ellipse (away from the sun) into a 2 m R8 texture
  (`TerrainShadow.treeTex`, re-baked when the sun moves 1°) — the ground, grass, water, rocks, bushes, the car and the
  trees' own lower crowns read it (`sunVisibility`); no shadow-map pass. Trunks near the car are physics cylinders.
- **Mixed woods** (2026-10-26, the user: "fewer pines, other trees like OTH"): a BROADLEAF family too
  (`broadleafGeometry`: white trunk + a tall loose oval of 34 jittered leaf clusters, ~320 vertices; leaf speckle in
  the shader) — gold birch, red / orange aspen, a few green — in DENSE GROVES (a slow noise picks grove vs conifer
  stand; ~half each; conifers sparser than before). 5 instanced draws: conifer near / mid, broadleaf near / mid, one
  impostor draw for all species (atlas rows: spruce, larch, birch, aspen, green × 3 elevations).
- **Trekking hills** (terrain.py `TREK`, the user: "hill-trekking places like OTH"): 4 broad rocky hills; their upper
  slopes TERRACED into ledges (a grassy shelf + a ~45° rock riser, 4–6 m, the step height wandering), tracks up to
  each top (A* allows 62 % steps there and the carve keeps 85 % of the ledges: rock crawling). More rock everywhere:
  slope rock from 25° and EXPOSED-BEDROCK patches on the hillsides (rock 3 % → 12 % of the box), never on a track.
- **Tracks** (the user: "exact OTH road texture"): one car wide (half width 1.8 m), smooth muted warm brown with a fine
  speckled grain, faint ruts, darker under the overhanging grass; the edge (`trackMask`, shared by the ground and the
  grass) pushed in / out by grass CLUMPS a few metres across + a finer fringe — OTH's scalloped grassy edges.
- **Round-leaf broadleaf + tightness** (2026-10-26 round 6, the user: "trees like a stick with paper — OTH has round
  leaves growing up and down"; "the spawn feels like a desert for 500 m"; "multiple hills and cliffs"; "rock
  formations on cliffs and hills, connected roads through them for trucking"): `broadleafGeometry` = a forked white
  trunk + ~210 ROUND LEAVES (quads cut to discs in the shader, per-leaf tint, one in ten yellow-green) on the
  surfaces of 7 lumpy clusters (some facing up, some out, the lower ones hanging) + a small dark core; 878 vertices
  (LOD 1 206). Placement adds clumps round the SPAWN (< 260 m), lining the TRACKS (5–26 m) and the RIVER banks (14–45
  m, mostly broadleaf) from coarse distance fields (`MapData.trackDist` / `riverDist`, 4 m, built at load); bushes
  thick along the banks / tracks / spawn; boulders round the spawn and along the tracks. Terrain: knolls + hummocks
  everywhere, ~30 more hills, ~14 CLIFFS (escarpments: a 12–30 m near-vertical rock step onto a plateau), rock
  FORMATIONS on 70 % of the hills and every plateau (48 in all), two by the spawn; TRUCKING ROUTES from the network
  into the 18 nearest formations and on between neighbours (A* may climb the rock there, the carve keeps the blocks)
  — 33 connected tracks, ~20 km.
- **Bushes** (`Bushes.ts`): lumpy clumps of icosphere blobs (green / juniper / autumn red), 2 LODs to `bushReach`,
  thicker at forest edges and in green hollows; beyond, the ground's painted shrub dots take over.
- **Rock outcrops** (terrain.py, the user: "huge rock — the terrain itself, rock texture, no grass"): 12 sites (2 in
  sight of the spawn), fused Voronoi BLOCKS raised out of the slope (flat tilted tops, steep sides, rounded crevices)
  in the HEIGHT GRID — the car climbs and hits them, they cast terrain shadow — painted blue-grey slab (mask R = 1), no
  grass / trees / bushes / loose boulders on them; tracks route round them. `meta.rocks` lists them.
- **Runtime**: ADAPTIVE RESOLUTION (PlayCanvas guideline: DPR at runtime) — once a second a slow frame (> 19 ms)
  lowers the pixel ratio 15 % (to half), a fast one (< 12.5 ms) raises it (`?dpr=fixed` off; F3 shows `res %`).
  FULL SCREEN button (top-left; Fullscreen API + landscape lock; iPhone: "Add to Home Screen" hint). Default tier
  ULTRA everywhere.
- **Score ceiling** (compare.py on OTH against ITSELF): golden grass from two OTH screenshots 70–73, a spruce vs another
  spruce in the same screenshot 51, the same crop shifted 5 % 89, identical 100 — so 100 means "the same image"; ours
  (2026-10-26, round oth2d): golden slope 92, golden field 75, spruce 66, rock 64, aspen grove 62, hillside 62,
  larch 61, overall 63.5.
- **Leaf cards + day / night** (2026-10-26, the user: "each leaf small and separated, the sky seen between them";
  "sun, bloom and day-night like OTH"): broadleaf crowns and bushes are LEAF CARDS showing a generated 512² atlas of 4
  leaf clusters (`leafTexture.ts`: ~80 tiny separate leaves each, gaps between them; R tone, G depth, A coverage —
  mip-corrected alpha test, alpha-to-coverage on MSAA tiers). `broadleafGeometry`: a low fork + side limbs, clumps of
  10 cards in 4 rings + a top + 5 dark core cards — the CROWN FILLS THE TOP 70 % of the tree (the user: "70 % leaves,
  30 % trunk"), each tree its own base (31–40 %) and width (×0.85–1.15) in the vertex shader; ~760 vertices (LOD 1
  ~190). Bushes: 5 clumps × 6 cards. The clock runs (`Atmosphere.tick`, 24 min a day, nights 3× faster; [ ] an hour,
  T stops it, `?time=0`): golden hour → pink dusk → night (the light becomes the MOON, stars twinkle, the headlights
  light every surface through the shared `headlight()`; L toggles them).
- **Clear near air** (the user: "no fog near us — the colours go dull"): the height fog starts at `FOG_START` = 140 m
  (`fogAmount` integrates only beyond it) and swallows the far hills by ~1.5 km; the vignette is the faintest
  darkening (no tint); the bloom keeps to what is brighter than white. In that clear air the sunlit SCREE and rock
  slabs read as snow, so both are a stone grey now (`paint.ts` SCREE / SLAB). The sky marks itself for the god rays
  (alpha 0) only when Post draws (LOW renders straight to the canvas: an opaque sky).
- **God rays + bloom** (`Post.ts`): the bloom's soft knee from 1.0 (the sun, the glowing sky round it, the sunset
  horizon, glints). GOD RAYS at a quarter of the resolution: the sky marks itself (the sky writes alpha 0, everything
  else 1 — a leaf card's edge, alpha-to-coverage, lets part through), its pixels near the sun (a tight falloff: the
  streaks keep their contrast) are the source, blurred RADIALLY toward the sun in 2 passes of 12 taps (the second 13×
  longer: 144 evenly spaced samples), added tinted as that sky is — light streams round every trunk, crown and ridge
  against the bright sky. Off (passes skipped) when the sun is behind the camera. `?rays=` strength (2.0), `?rays=-1`
  shows the rays alone. ≈ 0.1–0.2 ms.
- **The car, finished** (the user: "the car has no windows and no smoke"): the model's front DOORS (cut out of the body
  in Blender — `TruckModel.doors`) and the CABIN were never drawn here; now they are, and the glass is see-through
  (Fresnel sky, sun glint, the cabin behind it). DUST + SMOKE (`Dust.ts`): one instanced draw of soft painterly puffs
  from a ring (160 LOW … 360 ULTRA) — dust thrown back from each tyre on the ground by what it rolls on (orange-brown
  off the tracks, grey off rock, pale off gravel, a little off grass; none on a bridge), more with speed and tyre
  slip; exhaust from the catalogue's tailpipes (haze at idle, grey puffs on the gas). ≈ 0.03 ms CPU.
- **Camera zoom** (the user): the chase camera's distance 3.5–40 m, eased — mouse wheel, two-finger PINCH, + / − keys,
  on-screen + / − buttons (held: keeps zooming); in the free camera the buttons change the field of view.
- **A fuller map** (2026-10-26 round 7, the user: "more bumps and hills, bigger and smaller, some with rocks, some just
  rock on the ground; proper cliffs; random ponds and lakes with tracks, trees and hills near them; bridges like
  OTH; make it fuller, all explorable"): terrain.py adds a HILL FIELD (~240 hills: small 18–45 m / 3–12 m, medium
  45–100 m / 8–28 m, big 100–190 m / 18–50 m, ellipses at their own angles; a third crowned by a rock FORMATION, a
  third by a cap of BARE ROCK paint, the rest grass; some gathered round the ponds), 420 knolls, 22 PROPER CLIFFS (the
  big ones 24–46 m tall, up to 320 m long, the edge bending; the face LAYERED into 3–5 strata — near-vertical risers
  and narrow ledges — a scree apron at the foot), ~16 PONDS and small LAKES (16–110 m; a bowl under the level its own
  rim allows, a sloped beach; `meta.water.ponds`, a water disc each in `Water.ts`; the trees and bushes line their
  shores via `MapData.riverDist`; three within ~500 m of the spawn) with TRACKS to their shores (round the lakes), and
  3 PLANK BRIDGES over the river (`meta.bridges`; `Bridges.ts`: planks on three stringers, log posts + cap beams, curb
  logs and rails — one merged draw; the deck, curbs and rails are colliders in `Physics.ts`; the track ramps up to
  each deck and the river runs on under it; `MapData.bridgeAt` → the tyres feel planks, no dust). 74 tracks, ~35 km.
- **Culling, all of it** (the user: "check we have proper culling, all types"): DISTANCE (every system's tier reach),
  FRUSTUM (terrain CDLOD nodes, grass tiles, tree tiles, bush tiles, rock cells — the rocks had none before), LOD
  (CDLOD + geomorph, grass density rank, trees near / mid / impostor + far rank cull, bushes 2 LODs), BACKFACE (all
  closed meshes; leaf cards are double-sided by nature), SMALL-FEATURE (a rock under ~2 px tall is skipped), and
  OCCLUSION (`Horizon.ts`: 320 azimuth rays marched over the height grid from the camera each keep the highest slope
  met — the horizon; a tree / bush tile or rock cell whose top is under it in every azimuth it spans is behind a hill
  and skipped; conservative — eye +1.2 m, ±1 ray, a margin; rebuilt each 4 m moved ≈ 0.4–0.9 ms; `?occlusion=0`
  off). No shadow-map passes to cull (shadows are baked images). F3 shows the culled counts.
- **Not yet**: engine / tyre sounds, tyre tracks, planar reflections.

