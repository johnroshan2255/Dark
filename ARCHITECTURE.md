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
- **Lights at night**: car head/brake lamps (`Car`, F switch in the truck, auto with the dark) share the single spot light
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
| `F7` / `F8` | cycle quality preset low → ultra (disables auto) / toggle adaptive quality |
| touch | left half: joystick (full push = sprint) · right half: look · LIGHT / JUMP / FPS / TIME / fullscreen buttons |
| `[` / `]` | render scale down / up (within the tier's range) |
| click | pointer lock; WASD move, Shift sprint, Space jump |
