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
- **Road** is a global analytic function `roadCenterX(z)` so any chunk can evaluate it without neighbours.
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
- **Lights at night**: car head/tail/brake/reverse lamps (`Car`, F switch in the truck, auto with the dark) share the single spot light
  with the torch; street lamps on every roadside post are additive glow + road pool sprites instanced with the poles
  (`MaterialLibrary.lampGlow`) that flicker on at dusk — no extra real lights (skills/lighting fixed light pool).
- **Arcade handling** (`VehicleSim.TruckSim.arcade`, Settings → Controls → Driving, default ARCADE): Asphalt-style —
  Rapier keeps suspension, contacts and crashes; `driveArcade` adds a scripted longitudinal force (0→100 km/h ≈ 3.7 s,
  top ≈ 163 km/h stock = `arcadeTopSpeed(tune)`, nitro ×1.32 / ×1.7 accel), straight-down downforce; `afterWheels`
  SETS the yaw rate from the stick (radius 5.5 + 0.2 v + 0.02 v² m) and ROTATES the velocity toward the nose without
  scrubbing speed. DRIFT: brake tap (S / stick back) or handbrake while steering above 40 km/h → slide held at
  30–40° (the velocity follows the nose at its own yaw rate), fills the NITRO bar (also air time, smashed props).
  Air: self-levelling. Touch: auto-accelerate, NITRO + held DRIFT buttons. Chase camera re-centres behind the
  travel direction 1.2 s after the last look input; FOV widens with speed. HUD: speedometer + nitro bar.
  'Realistic' keeps the old model; tests/vehicle.test.ts covers both.
- **Sound** (`src/audio/AudioSystem.ts`, files in `src/assets/audio/`, credits in ASSET_LIST.md): a WebAudio mixer —
  master (Settings → Audio → Sound mutes everything) → music bus (Theme music) + effects bus. Persistent loops follow
  the game each frame (`frame()`): engine idle + drive layers through a simulated gearbox driven by the wheels' rim
  speed (`VehicleSim.wheelSpeed`: burnouts / drifts rev it), each car's own pitch and shift points (catalogue
  `engine`), a reverse gear, load-dependent loudness (coasting is quieter) and a dip at every shift, boost rush, tyre squeal from
  wheel slip, bike rolling + freewheel, rain, the theme (fades out with the dark and the nightmare). One-shots: doors,
  engine start/stop, footsteps on every foot plant of the animation (`CharacterModel.steps`). Loaded after the first gesture; the game never waits for audio.
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
- **Scale**: real-world. Each car's `length` is set so its WHEELBASE matches the real vehicle (Hilux Xtra Cab 3.095 m,
  G500 4×4² 2.85 m, Żuk 2.70 m); the player is a 1.78 m adult — a stylized human modelled in Blender at real proportions
  (`scripts/blender/human.py`: skin-modifier body, head, hair, face, clothes by vertex colour, ~5 k tris, 124 KB; joints
  at `CharacterModel` SRC), rigged and animated in code: idle weight shift + breathing; walk / run with planted feet,
  heel strike → toe-off foot roll, pelvis twist + roll, counter-rotating chest, steady head, run lean, bent run arms;
  jump with the lead knee driven up and the rear leg trailing, legs reaching down when falling. Same capsule and 1.62 m eye.
- **Doors, cabin, axles** (models prepared in Blender: `scripts/blender/vehicle_doors.py` + `vehicle_finish.py`):
  the front doors are separate parts (`door_FL*`/`door_FR*` with a `hinge` glTF extra, dark jamb in the opening),
  the steering wheel is a named part on every car, the Żuk has a ~150-tri cabin, and only the base-colour texture is
  kept (≤ 1024²; Żuk 3.9 → 0.7 MB). `Car` hangs each door on its hinge (one instanced draw on the car program +
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
  style menu over the live world (state `landing` + `screen`; the camera circles the parked car,
  `CameraController.garage`, the player is frozen). MAIN MENU: Play / Garage / Settings + the current car's card.
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

## 7. Multiplayer (future, structure reserved)

Host-authoritative (one peer or a small Node relay). Clients send inputs; host simulates players/monsters and
sends snapshots at 20 Hz; clients interpolate 100 ms in the past. World is **not** sent — only the seed and
deltas (opened doors, looted items). Streaming on the host is the union of all players' rings.

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
  multiplayer/    networking/ interpolation/ state/
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
| `↑` / `↓` | in a car: raise / lower the body (air suspension); flying: climb / sink (touch: ▲ ▼) |
| `F7` / `F8` | cycle quality preset low → ultra (disables auto) / toggle adaptive quality |
| touch | left half: joystick (full push = sprint) · right half: look · LIGHT / JUMP / FPS / TIME / fullscreen buttons |
| `[` / `]` | render scale down / up (within the tier's range) |
| click | pointer lock; WASD move, Shift sprint, Space jump |
