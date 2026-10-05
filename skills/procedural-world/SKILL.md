---
name: procedural-world
description: Read before adding or changing any generated content (terrain, road, forest, props, caves, POIs, monster spawns) or anything that must be identical across co-op clients.
---

# Procedural World

## 1. Purpose

Generate the entire world from one **seed**, chunk by chunk, deterministically. Same seed ⇒ same terrain, road,
trees, caves, POIs and monster spawn points on every client, every session. Multiplayer only sends the seed plus
deltas (looted/destroyed/opened).

## 2. Architecture

> **Road network (implemented, `src/world/Road/RoadNetwork.ts`):** besides the analytic main road, a
> deterministic secondary network: one node per 380 m region (highest of 4 hashed candidates, not in water →
> roads lead to hilltops/viewpoints), links east/north with p = 0.55 and to the main road when near it.
> Links are hashed quadratic Béziers sampled to 18 points with heights graded (smoothed) along the road,
> kept ≥ water + 1.2 m and blended to the main road's level at junctions. Types: GRAVEL (2.3 m half-width)
> and TRAIL (1.35 m). `WorldFields.height` = natural → river → network → main road. Per-vertex `netEdge` /
> `netType` drive the painted surface in the terrain shader; vegetation keeps clear via `anyRoadEdge`.
> Cost: chunk generation 1.1 → 1.9 ms (worker). Rocks: slate-indigo boulders with mauve tops, 0.5–4 m.
>
> **Biomes (implemented, `src/world/Biomes.ts`):** the world is tiled by 900 m cells, each with a jittered
> centre and a hashed type (forest 50 % / desert 27 % / snowfield 23 %); a point's weights `[desert, snow]`
> blend the 3×3 surrounding cells over 260 m (`(1 − (d − dMin)/260)²`, normalised) after a ±150 m noise warp of
> the lookup position, so borders wander. Altitude adds a snow line (78–112 m, higher in deserts). The spawn's
> 3×3 cells are forest; cells (0, ±2) — on the road ~2 km up and down it — are always one desert and one snow, so
> both are found by driving. Weights feed: `naturalHeight` (dunes / massifs), `groundColor` (dune gold, snow
> white, ice at the shore), `forestDensity` (+ treeline above 95 m), species (desert: snags + pines; snow:
> conifers), rock/plant density, per-instance tints (frosted / sun-dried, `WorldChunk`), grass (none on snow,
> dry tufts on sand), the terrain shader (`biome` attribute: ripples / sparkle) and the fog colour under the
> player. Chunk data carries `biome` (33² × 2). Cost: generation 2.5 → ~3.3 ms/chunk (worker), mostly the wider
> secondary-road blend. Test: spawn is forest, desert + snow on the road, weights well-formed.
>
> **Biome places (implemented):** the desert grows `TreeSpecies.Cactus` / `Joshua` (`Forest/desertFlora.ts`;
> `pickSpecies` above 0.8 desert weight, a pine-and-snag rim at 0.5–0.8, density floor `0.1 × sand` because
> forestDensity is ~0 there) and agaves / dry shrubs in the plant layer (WorldChunk picks the desert meshes by the
> biome at each plant — the record format is unchanged). `naturalHeight` adds MESAS in the desert:
> `sstep(0.3, 0.38, n) × 26 + sstep(0.5, 0.55, n) × 16` of a 2-octave fbm at 0.0045 — flat tops, ~50° sides. These
> change the generated world for existing seeds (no `WORLD_GEN_VERSION` yet). Snow cover, ice and strata are
> rendering-only (biome map texture), never gameplay. Tests: desert chunks hold saguaros + Joshua trees and no
> forest conifers; snowfields have (almost) no undergrowth. Generation cost unchanged (~4.1 ms/chunk in the test).
> Desert relief = `WorldFields.dunes` (transverse dunes across a SW wind: concave windward slope, sharp crest at 78 %
> of the 72 m spacing, slip face at ~34°, crest height 4–15 m, warped crest lines) + mesas; snow relief adds
> `drifts` (soft 1–3 m mounds) and the main road gets 0.7 m plough banks just outside its edges in the snow.

```
seed (uint32)
 ↓
terrain      height(x,z)        global analytic (noise of world coords)
 ↓
road         roadCenterX(z)     global analytic; flattens terrain nearby
 ↓
forest       per-chunk scatter  RNG(seed, cx, cz, LAYER_FOREST), density noise, road exclusion
 ↓
props        per-chunk scatter  RNG(..., LAYER_PROPS), road-side debris, rocks
 ↓
caves        region cells       one region = 8×8 chunks; RNG(seed, rx, rz, LAYER_CAVE) picks entrance
 ↓
POIs         region cells       cabins, wrecks, shrines; spacing guaranteed by region grid
 ↓
monsters     per-chunk spawns   RNG(..., LAYER_MONSTER) + POI/cave influence; nightmare adds a layer
```

Each stage reads only the seed, world coordinates and **earlier stages evaluated analytically** — never another
chunk's generated output. That is what makes any chunk generable independently, in any order, in a worker.

Files: `src/world/WorldGenerator.ts` (`generateChunk(seed, cx, cz) → ChunkData`), `src/world/noise/rng.ts`
(hashing + seeded PRNG), `src/world/noise/simplex.ts` (seeded 2D simplex), `src/world/WorldFields.ts` (global analytic fields: height, `roadCenterX(z)`, forest density),
`src/world/Forest/scatter.ts`, `src/world/Cave/`.

## 3. When to use

- All world content that isn't hand-authored.
- Anything whose position gameplay depends on (spawns, loot, POIs) — must go through this pipeline.

## 4. When NOT to use

- Cosmetic per-frame randomness (particles, grain, flicker): `Math.random` is fine there.
- Hand-authored set pieces: place them via a POI record (seeded position), author the content itself.
- Don't generate the world in one big pass at startup.

## 5. Performance implications

| Stage | CPU per chunk (worker) | Memory |
|---|---|---|
| Heights 65² × fbm 5 octaves | ~1.5–3 ms | 17 KB (Float32) |
| Road evaluation | < 0.1 ms | — |
| Forest scatter (jittered grid 4 m, ~250 candidates) | ~0.3 ms | 6 floats × n |
| Props / monsters | < 0.2 ms | small |
| Region cell (cave/POI) lookup | ~µs (cached per region) | tiny |

All generation runs in `chunk.worker.ts`; main thread cost is 0 until build (see `world-streaming`).

## 6. WebGL limitations

Not a WebGL concern directly, but: generation output must be typed arrays ready for GPU upload (no per-vertex
objects), and anything computed on the GPU (e.g. shader noise for grass sway) is **not** deterministic across GPUs
— never use GPU results for gameplay.

## 7. R3F implementation

React never generates. `<WorldChunk>` only receives finished `ChunkData`. The seed lives in `GameState`
(low-frequency store); changing it resets the `WorldManager`, which clears caches and the chunk set.

## 8. Direct Three.js implementation (generator code)

**Hash-based RNG keyed by coordinates**

```ts
// rng.ts — integer-only, identical on every JS engine.
export function hash4(seed: number, a: number, b: number, c: number): number {
  let h = seed ^ 0x9e3779b9
  h = Math.imul(h ^ a, 0x85ebca6b); h ^= h >>> 13
  h = Math.imul(h ^ b, 0xc2b2ae35); h ^= h >>> 16
  h = Math.imul(h ^ c, 0x27d4eb2f); h ^= h >>> 15
  return h >>> 0
}

export function mulberry32(s: number) {
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const LAYER = { FOREST: 1, PROPS: 2, CAVE: 3, POI: 4, MONSTER: 5 } as const
const rng = mulberry32(hash4(seed, cx, cz, LAYER.FOREST))
```

A separate stream **per layer** means adding rocks never changes where trees are.

**Why no `Math.random`**: unseeded, different per client, per run, and per call order. Also avoid a single
global seeded RNG consumed in load order — chunk load order differs per client.

**Floating-point determinism across clients**

- `+ - * /`, `Math.floor`, `Math.imul`, `Math.sqrt`, `Math.abs`, `Math.min/max` are exactly specified (IEEE-754
  double) ⇒ identical everywhere.
- `Math.sin/cos/exp/pow/log/atan2` are **implementation-approximated** and can differ in the last bits between
  V8, SpiderMonkey, JavaScriptCore. For gameplay-relevant results (positions, spawn decisions, thresholds) use
  polynomial approximations or avoid them. Simplex/value noise uses only arithmetic + floor ⇒ safe.
- Rendering-only values (tree rotation → quaternion) may use `sin/cos`.
- Decisions near thresholds (`density > 0.5`) can still flip if inputs differ — so keep inputs exact.
- Store generated values as Float32 only for rendering; do comparisons in doubles before conversion.

**Cross-chunk features**

- *Global analytic functions*: road `x = roadCenterX(z)` from 1D noise; rivers likewise. Any chunk evaluates them.
- *Region cells*: coarse grid (e.g. 8×8 chunks = 512 m). Each region deterministically picks 0–1 cave entrance,
  0–2 POIs with a jittered position inside a margin, so features never overlap and spacing is guaranteed. A chunk
  asks "which features of my region and the 8 neighbour regions overlap my bounds?".
- Never "look at neighbour chunk output" — it creates order dependence and recursion.

**Chunk generator shape**

```ts
export function generateChunk(seed: number, cx: number, cz: number): ChunkData {
  const heights = sampleHeights(seed, cx, cz)          // 33×33, includes road flattening
  const trees   = scatterForest(seed, cx, cz, heights)  // uses heights for y, road for exclusion
  const rocks   = scatterProps(seed, cx, cz, heights)
  const spawns  = monsterSpawns(seed, cx, cz, heights)
  return { cx, cz, heights, minY, maxY, instances: { trees, rocks }, spawns }
}
```

**Nightmare realm**: same seed, same layout, a different *variant* flag mixed into the hash layer
(`LAYER.MONSTER + 100`) and different shading — players recognise the place, but it is wrong.

## 9. Common mistakes

- `Math.random()` anywhere in generation.
- One global RNG advanced across chunks → order dependence.
- Reading neighbour chunk data (trees crossing borders are fine: scatter by *centre* point in own chunk only).
- Changing noise octaves/constants without bumping a `WORLD_GEN_VERSION` (saves/co-op desync).
- `sin/pow` in spawn logic → rare cross-browser desync.
- Using `(cx * 73856093) ^ cz` style weak hashes → visible repetition/stripes.
- Generating LOD geometry in the generator (keep generator = data; build = view).

## 10. Profiling / debugging

- Determinism test: generate chunks (0,0), (5,-3), (-100,42) in two orders and in worker vs main; compare a hash
  of all arrays (FNV over bytes). Run it in Chrome, Firefox, Safari with the same seed.
- Debug overlay: seed + `WORLD_GEN_VERSION` in HUD; seed override via URL `?seed=1234`.
- Time `generateChunk` inside the worker (`performance.now()`), report average ms to the HUD.
- Visual heatmaps: debug material that shows density noise / road mask as vertex colours.

## Road crossings
Secondary roads never CROSS (an X of two graded roads at different heights read as a "road intercept"):
`RoadNetwork.link` rejects grid links whose samples enter the main road's corridor (bed + shoulder + 4 m;
nodes on opposite sides connect through it), node→main links that cross a grid link, and driveways that cross
a grid link, a main link, or the driveway of a place earlier in (z, x) order. The priority grid < main <
driveway (+ the strict place order) keeps every decision independent of build order → identical on all
clients. `RoadNetwork.crosses` (junctions within 28 m of an end are allowed) is tested over 348 roads / 3 seeds
in `tests/world.test.ts`.


## Landscape & voxel formations (2026-10-05)
Genshin-like relief: `WorldFields.naturalHeight` adds terraced plateaus (`pn` fbm at 0.0022, three smoothstep tiers
of 16/14/12 m, transitions wide enough that secondary-road banks stay ≤ 2.2 m/m — tested). Trees in groves:
`forestDensity = clamp((n − 0.5) × 3.2)`. Rock formations: `FormationField` (region 340 m, ≤ 2 per region, kinds
by biome, hash-chosen, rejected near roads / rivers / places / water); `formationSdf` (value noise3 + ellipsoid /
capsule / torus SDFs) → `surfaceNets` (naive surface nets, winding verified: 100 % outward on a sphere) in the
worker that owns the formation's centre (`ChunkData.fm*`, chunk-local; the chunk's culling box grows to hold it).
Build cost 1.5–33 ms per formation (worker), 1.6–7.9 k tris. Physics: `ColliderDesc.trimesh` on the chunk body.

## Landmarks & places, not a road (2026-10-05)
The user compares against real Genshin screenshots (Windrise, Springvale, Windwail, Cider Lake, Sumeru desert,
Dragonspine) — the world must read as PLACES to travel to. `LandmarkField` (`world/Landmarks/landmarks.ts`): region
700 m, p 0.8, the highest of 16 candidates that fits (dry, 6 m relief, off road / river / places / formations),
kind from the biome AT the chosen spot; `home()` = giant oak 180–800 m ahead, visible from the spawn eye (tested).
Meshes are primitives in `landmarkGeometry.ts` (same vertex format as places), scaled per kind (`LANDMARK_SCALE`).
Never draw far content with `materials.vegetation`: its `cullFade` dither removes everything past the chunk ring.
Scatter clears trees within radius + 24 m (landmarks stand in clearings); grass skips stone footprints.
Horizon terrain: dry land never sinks under the water plane (it flooded every lowland → "grey sea"), and the shader
draws distant tree crowns from a per-vertex canopy colour + density. Daytime mist is ~0 in the Genshin style.
