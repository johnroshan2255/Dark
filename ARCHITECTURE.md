# DARK — Architecture

Browser co-op survival horror. Stylized, low-poly, fog-heavy procedural open world.
Target: **≥ 60 fps minimum on every supported device — ~₹15k Android phones, low-end PCs (Intel UHD) and
desktops — uncapped above** (display refresh), in Chrome/Firefox/Safari (WebGL2). Achieved with three quality
tiers + adaptive resolution (`src/rendering/quality/`, `skills/mobile`). Every game is a new random world
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
- **Biomes** (`src/world/Biomes.ts`): 900 m cells (forest / desert / snowfield) with 260 m blended, noise-warped
  borders + an altitude snow line; the spawn's 3×3 cells are forest and one desert + one snow cell always sit on
  the road ~2 km up/down it. Weights drive relief, ground palette, trees/rocks/grass, the terrain shader and the fog tint.
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
- **Art styles** (`src/rendering/artStyle.ts`, fixed per session, Settings/`?look=`): **`overland`** (default — the
  "over the hill" look: straw meadows, solid spiky low-poly trees, faceted rocks, warm haze; also the cheapest),
  `bright` (Genshin, card canopies, painted surfaces), `storybook` (unlit painting). Each style is a keyframe set
  + material/geometry variants chosen at build time — no runtime branches. The ground palette is baked in the
  chunk workers (`WorldFields.palette`, sent with every chunk/horizon request). See skills/art-direction.
- **Weather** (`src/rendering/weather/Weather.ts`): deterministic cloud / rain / wind fields (seed + day + 20-min slot)
  modulating the time-of-day params; rain streaks (`particles/RainParticles.ts`), tree sway (`uniforms.ts` `foliageSway`).
- **Lights at night**: car head/brake lamps (`Car`, F switch in the truck, auto with the dark) share the single spot light
  with the torch; street lamps on every roadside post are additive glow + road pool sprites instanced with the poles
  (`MaterialLibrary.lampGlow`) that flicker on at dusk — no extra real lights (skills/lighting fixed light pool).
- **Sound** (`src/audio/AudioSystem.ts`, files in `src/assets/audio/`, credits in ASSET_LIST.md): a WebAudio mixer —
  master (Settings → Audio → Sound mutes everything) → music bus (Theme music) + effects bus. Persistent loops follow
  the game each frame (`frame()`): engine idle + drive layers through a simulated gearbox, boost rush, tyre squeal from
  wheel slip, bike rolling + freewheel, rain, the theme (fades out with the dark and the nightmare). One-shots: doors,
  engine start/stop, footsteps by stride length. Loaded after the first gesture; the game never waits for audio.
- **Vehicle effects** (`src/rendering/particles/VehicleFx.ts`): exhaust puffs + tyre smoke/dust as one tier-capped
  point-sprite draw (`quality.particles.vehicle`), driven by the vehicle simulation's per-wheel slip.

---

### Beyond the chunks
Horizon terrain (1 draw, worker-built, rebuilt every size/6 of travel) shows the world to ~0.8–1.5 km; a single
water plane at `WorldFields.WATER` shows lakes/rivers wherever terrain dips below it. Fog therefore closes at
the horizon, not at the chunk ring (see skills/art-direction, skills/fog).

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
  attribute, wheels split out by name or shape, glass split off, normalised to metres / −Z / wheelbase origin) and
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
| `F7` / `F8` | cycle quality tier (disables auto) / toggle adaptive quality |
| touch | left half: joystick (full push = sprint) · right half: look · LIGHT / JUMP / FPS / TIME / fullscreen buttons |
| `[` / `]` | render scale down / up (within the tier's range) |
| click | pointer lock; WASD move, Shift sprint, Space jump |
