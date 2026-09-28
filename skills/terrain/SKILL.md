---
name: terrain
description: Read before changing terrain height generation, terrain meshes/LOD/skirts/colours, road flattening, height queries, or terrain physics colliders.
---

# Terrain

## 1. Purpose

Deliver a stylized, readable ground: rolling forested hills, a road cut into them, ravines near caves — built from
a heightfield per 64 m chunk, rendered cheaply, collidable via Rapier heightfields, and queryable for placement.

## 2. Architecture

```
height(x,z) = base fbm + ridged hills + detail
            → road flattening (blend toward road bed height within road width + shoulder)
sampled per chunk: 33×33 Float32 at 2 m (`CHUNK_RES = 32`) (shared border rows with neighbours)
    ├─ TerrainGeometry(lod)  stride 1/2/4 → 65²/33²/17² verts + skirt   (src/world/Terrain/TerrainGeometry.ts)
    ├─ vertex colours        slope/height/road mask → palette           (stylized, no textures required)
    ├─ Rapier heightfield    physics radius only                          (src/physics/PhysicsWorld.ts)
    └─ height query          bilinear from heights / analytic fallback
```

Heights are generated in the worker (`src/world/WorldGenerator.ts`) and are the single source of truth for
render, physics and placement — never recompute differently in two places.

## 3. When to use

- Outdoor ground everywhere in the streamed world.
- Placement (trees, props, spawns): `heightAt(x,z)` from sampled data.

## 4. When NOT to use

- Caves and overhangs: heightfields can't represent them. Caves are separate meshes (GLB kits or generated tubes),
  entered through a terrain-side entrance; the terrain under a cave just stays solid.
- Road surface detail (asphalt edges, cracks): separate thin road mesh/decals following `roadCenterX(z)`, drawn with
  `polygonOffset`, not more terrain vertices.

## 5. Performance implications

| | CPU | GPU | Memory |
|---|---|---|---|
| Sample 65² heights (fbm 5 oct) | 1.5–3 ms (worker) | — | 17 KB |
| Build LOD0 geometry + normals + colours | ~0.5–1 ms (main) | 8 192 tris | ~150 KB (pos/normal/color + indices) |
| LOD1 / LOD2 | 0.2 / 0.1 ms | 2 048 / 512 tris | ~40 / 10 KB |
| Visible terrain (81 chunks, mixed LOD) | — | ~100–150 k tris | ~5 MB |
| Heightfield collider | 0.2–0.5 ms | — | ~20 KB wasm |

Material: `MeshLambertMaterial({ vertexColors: true })` shared — per-fragment Lambert (since r151), cheapest lit path that
supports fog and shadows. No textures ⇒ no texture memory; optionally one small tiling detail texture multiplied in.

## 6. WebGL limitations

- No tessellation / vertex texture displacement worth using for terrain LOD — discrete grids.
- Float32 positions: fine within ±10 km of origin; beyond that use a floating origin (see `world-streaming`).
- Index buffers: 65² = 4 225 verts + skirt fits `Uint16`.
- Vertex colours are interpolated linearly in the colour space of the attribute — store linear values (convert
  palette `THREE.Color` via `.convertSRGBToLinear()` or use `Color.setHex` which assumes sRGB → linear with
  ColorManagement enabled).

## 7. R3F implementation

```tsx
const geo = useMemo(() => chunk.terrainGeometry(lod), [chunk, lod])  // cached per LOD inside chunk
return <mesh geometry={geo} material={materials.terrain} receiveShadow castShadow={lod === 0} dispose={null} />
```

Terrain geometries are chunk-owned and disposed when the chunk unloads (not on LOD change). Material is shared.

## 8. Direct Three.js implementation

**Height function**

```ts
export function terrainHeight(n: Noise2D, x: number, z: number): number {
  let h = fbm(n, x * 0.004, z * 0.004, 5) * 28          // broad hills
  const r = 1 - Math.abs(n(x * 0.0015 + 31.7, z * 0.0015 - 11.3))
  h += r * r * 22                                        // ridged hills
  h += n(x * 0.05, z * 0.05) * 0.6                       // small bumps
  // road flattening
  const d = Math.abs(x - roadCenterX(z))
  const t = smoothstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + ROAD_SHOULDER, d)
  return lerp(roadBedHeight(z), h, t)
}
```

`roadBedHeight(z)` must itself be smooth and analytic (e.g. low-frequency fbm along z), otherwise the road bumps.
Use `smoothstep` / `lerp` (pure arithmetic) — deterministic across browsers.

**Geometry from heights (stride per LOD)**

```ts
export function buildTerrainGeometry(h: Float32Array, stride: 1 | 2 | 4): THREE.BufferGeometry {
  const N = 64 / stride + 1, S = 65
  const pos = new Float32Array(N * N * 3), nor = new Float32Array(N * N * 3)
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const gi = i * stride, gj = j * stride, k = (j * N + i) * 3
    pos[k] = gi; pos[k + 1] = h[gj * S + gi]; pos[k + 2] = gj
    // central differences on the full-res grid (clamped): identical normals on shared borders
    const hl = h[gj * S + Math.max(gi - 1, 0)], hr = h[gj * S + Math.min(gi + 1, 64)]
    const hd = h[Math.max(gj - 1, 0) * S + gi], hu = h[Math.min(gj + 1, 64) * S + gi]
    const nx = hl - hr, ny = 2, nz = hd - hu, inv = 1 / Math.hypot(nx, ny, nz)
    nor[k] = nx * inv; nor[k + 1] = ny * inv; nor[k + 2] = nz * inv
  }
  // indices: 2 tris per cell, + skirt strip along 4 borders (verts at y - 3)
  ...
}
```

Border normals: clamping at chunk edges produces slight lighting seams. Fix by having the worker sample a 67×67
grid (1-sample apron) and computing normals from it, while the mesh uses the inner 33×33. Do this when seams are
visible under low sun.

**Skirts**: for each border vertex, add a copy at `y - 3 m` with the same normal/colour; stitch quads. Hides
T-junction cracks between LOD levels and float rounding gaps.

**Vertex colour stylization** (computed in worker or at build):

| Condition | Colour |
|---|---|
| road mask > 0.5 | dark asphalt/dirt |
| slope (1 − ny) > 0.35 | rock grey-brown |
| height low / near water | dark moss |
| default | 2–3 grass/forest-floor tones mixed by low-freq noise |

Add cheap baked AO: darken by `(avgNeighbourHeight - h)` concavity and near tree trunks (tree positions known at
scatter time). This substitutes for dynamic shadows on the ground (see `shadows`).

**Height query**

```ts
export function heightAt(chunk: ChunkData, lx: number, lz: number): number {
  const x0 = Math.min(Math.floor(lx), 63), z0 = Math.min(Math.floor(lz), 63)
  const fx = lx - x0, fz = lz - z0, S = 65, h = chunk.heights
  const a = h[z0 * S + x0], b = h[z0 * S + x0 + 1], c = h[(z0 + 1) * S + x0], d = h[(z0 + 1) * S + x0 + 1]
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz
}
```

Note the rendered triangle is planar, not bilinear; the difference is a few cm at 2 m spacing — irrelevant for
placement. For the player, use Rapier (raycast / character controller), not this function.

**Rapier heightfield**

```ts
// VERIFIED on rapier3d-compat 0.21 by raycasting an asymmetric test field (h = ix + 10·iz):
//  - nrows/ncols = number of SUBDIVISIONS (CHUNK_RES), array holds (n+1)² samples
//  - sample (ix, iz) lives at hf[ix * (n + 1) + iz]   (x selects the column, z the row)
//  - field is centred on the body origin and spans scale.x × scale.z
const V = CHUNK_VERTS // 33
const hf = new Float32Array(V * V)
for (let iz = 0; iz < V; iz++) for (let ix = 0; ix < V; ix++) hf[ix * V + iz] = heights[iz * V + ix]
const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(originX + 32, 0, originZ + 32))
world.createCollider(RAPIER.ColliderDesc.heightfield(CHUNK_RES, CHUNK_RES, hf, { x: 64, y: 1, z: 64 }), body)
```

Passing `n + 1` as nrows traps in WASM (`unreachable`). Rapier splits each cell along the (1,0)–(0,1)
diagonal; `TerrainGeometry` and `sampleHeight` use the same split, otherwise the visible surface and the
collision surface differ by up to ~35 cm on bumpy ground (`npm test` catches this). Orientation has changed between Rapier versions —
re-run the raycast check after any Rapier upgrade (see `src/physics/PhysicsWorld.ts`).

## 9. Common mistakes

- Different height functions for mesh, physics and placement.
- Computing normals with `computeVertexNormals()` per chunk → seams at borders (no neighbour data).
- LOD grids that don't share border samples (64 not divisible by stride) → cracks.
- Road flattening with a hard `if` → cliffs at the shoulder.
- Heightfield row/column transposed → player walks on an invisible mirrored terrain.
- High-frequency noise at > 1 cycle/2 m → aliasing shimmer at 1 m sampling.
- Heightfield colliders for all 81 rendered chunks (only radius 1 needed).
- Storing sRGB colours in vertex colour attribute.

## 10. Profiling / debugging

- Wireframe toggle on terrain material; `F4` for LOD tint and chunk bounds.
- `F6` Rapier debug lines (`src/debug/PhysicsDebug.ts`): heightfield wireframe must sit exactly on the mesh.
- Low sun angle (evening) reveals normal seams — check chunk borders there.
- Worker timing for `sampleHeights` in HUD; if > 5 ms, reduce octaves or sample the detail octave only at LOD0.
- Draw-call/tri counts per LOD in HUD; terrain should be ≤ 25 % of visible triangles.
