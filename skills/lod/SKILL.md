---
name: lod
description: Read before adding detail levels for terrain, vegetation, props, or monsters, or tuning LOD distances/hysteresis.
---

# Level of Detail

## 1. Purpose

Spend triangles, draw calls, shader work and CPU animation where the player is looking closely, and nearly
nothing in the fog. In this game fog hides the far field, so LOD is aggressive: at 150 m+ an object is a
silhouette against fog.

## 2. Architecture

LOD is decided **per chunk**, not per object (`src/optimization/lod/LodSelector.ts`):

| Chunk LOD | Chebyshev ring | Terrain grid | Vegetation | Props | Shadows |
|---|---|---|---|---|---|
| 0 | ≤ 1 | 33×33 (2 m) | full trees, rocks, small plants, mushrooms, grass | full | cast + receive |
| 1 | 2–3 | 33×33 (2 m) | trees (low-poly variant), rocks > 1 m | large only | receive only |
| 2 | 4 | 17×17 (4 m) | trees (lowest variant or impostor) | none | none |

Selection uses continuous distance from the player to the chunk centre (in chunk units) with hysteresis:

```
upgrade   (more detail)  when d < threshold - 0.35
downgrade (less detail)  when d > threshold + 0.35
thresholds: LOD0|1 = 1.5, LOD1|2 = 3.5
```

A LOD change is a low-frequency event (≈ once per few seconds per chunk) → it is allowed to trigger a React
re-render of that one `<WorldChunk>` (memoised; props `lod`).

Monsters and hero props use **per-entity** LOD because there are few of them (≤ 30).

## 3. When to use

- Terrain: always (per-chunk grid resolution).
- Vegetation: species-level mesh variants per chunk LOD.
- GLB props with > 500 triangles that appear more than a handful of times.
- Monsters: animation rate and skinning, not just triangles.

## 4. When NOT to use

- Assets under ~300 triangles: a second LOD adds a draw call per chunk for nothing.
- `THREE.LOD` for vegetation: it is a per-object `Object3D` that computes distance for every instance each frame
  and holds a separate `Mesh` per level. 10 000 trees ⇒ 10 000 objects, 10 000 distance checks, 10 000 draw calls.
  Vegetation LOD must be "swap the InstancedMesh of the whole chunk".
- Don't LOD things the fog already hides — reduce the render radius instead.

## 5. Performance implications

| | CPU | GPU | Memory |
|---|---|---|---|
| Chunk LOD pass (81 chunks) | < 0.02 ms | — | — |
| LOD switch (rebuild terrain grid) | 0.3–1 ms one-off (cache per level) | new VBO upload | 3 grids cached ≈ 65²+33²+17² verts × 28 B ≈ 160 KB/chunk |
| Tree LOD0 vs LOD1 | — | ~60 vs ~12 tris/tree | two geometries shared across all chunks |
| Monster skinning off (far) | saves mixer + bone updates ~0.05 ms/monster | saves skinning VS | — |
| Impostor atlas | bake at load | 1 quad/tree, alpha-test fragment cost | 1–4 MB texture |

Triangle budget guideline (visible): terrain ≤ 150 k, vegetation ≤ 400 k, props ≤ 100 k, characters ≤ 60 k.

## 6. WebGL limitations

- No geometry shaders / mesh shaders / tessellation: all LOD is CPU-selected discrete geometry.
- Changing `InstancedMesh.geometry` is cheap, but a *new* geometry must upload VBOs (first use hitch). Warm up
  all LOD geometries at load by rendering once (or `renderer.compile`).
- Alpha-tested impostors disable early-Z on some GPUs and cause overdraw; keep impostors small and opaque-ish,
  use `alphaTest` not blending. Alpha-to-coverage requires MSAA (we have MSAA 4 on the scene RT).
- Cross-fading LODs requires transparency or dithered discard; use screen-door dither in the fragment shader
  if popping is visible — never blend.

## 7. R3F implementation

LOD is **not** React state. Chunks are imperative (`src/world/WorldChunk.ts`); React only mounts
`WorldManager.root`. Per frame `WorldManager.update` calls:

```ts
chunk.setLod(selectLod(chunk.lod, chunkDistance(focus.x, focus.z, cx, cz)))

// WorldChunk.setLod — a visibility flip on pre-built meshes; terrain per LOD is built lazily and cached.
setLod(lod: number) {
  if (lod === this.lod) return
  this.lod = lod
  this.terrain[lod] ??= this.add(new THREE.Mesh(buildTerrainGeometry(this.data, lod), this.mats.terrain))
  this.terrain.forEach((m, i) => m && (m.visible = i === lod))
  for (const m of this.hi) m.visible = lod === 0            // pine.lod0 / dead.lod0
  for (const m of this.lo) m.visible = lod !== 0            // share instanceMatrix with .hi → no re-upload
  if (this.rocks) this.rocks.visible = lod <= 1
  if (this.plants) this.plants.visible = lod === 0
}
```
Do not dispose cached terrain geometries on LOD change; dispose them on chunk unload.

## 8. Direct Three.js implementation

**Hysteresis selector**

```ts
const T = [1.5, 3.5]      // LOD boundaries in chunk units
const H = 0.35
export function selectLod(prev: number, d: number): number {
  let lod = prev
  while (lod < T.length && d > T[lod] + H) lod++
  while (lod > 0 && d < T[lod - 1] - H) lod--
  return lod
}
```

**Terrain LOD with skirts** — neighbours at different resolutions leave T-junction cracks. Instead of stitching,
add a skirt: duplicate each border vertex, move it down by 2–4 m, triangulate a vertical strip. Cost: +4·N verts.
Fog + vertex colour hides it. Stride sampling of the same 33×33 height array keeps borders identical at every LOD
(borders share sample points because 64 is divisible by 2 and 4).

**Monster LOD**

```ts
if (dist < 20) { mixer.update(dt); skinned.visible = true }                     // full rate
else if (dist < 60) { acc += dt; if (acc > 1 / 15) { mixer.update(acc); acc = 0 } } // 15 Hz animation
else { /* freeze pose; swap to static low-poly mesh or hide in fog */ }
```

**Geometry simplification (offline, never at runtime)**

```bash
npx @gltf-transform/cli simplify in.glb out_lod1.glb --ratio 0.25 --error 0.01
npx @gltf-transform/cli simplify in.glb out_lod2.glb --ratio 0.08 --error 0.05
```

Uses meshoptimizer. Check silhouettes — for trees, a hand-made "cone + trunk" LOD often beats automatic
simplification. Naming convention: `name.lod0.glb`, `name.lod1.glb` (see `asset-optimization`).

**Impostors / billboards** — for LOD2 trees if cone meshes are still too heavy: bake 8 views into an atlas,
render as camera-facing quads in an InstancedMesh, pick atlas column by view angle in the vertex shader.
Start with cheap low-poly cones; only build impostors if profiling shows vertex-bound LOD2.

## 9. Common mistakes

- `THREE.LOD` per tree or per rock.
- LOD distance without hysteresis → thrashing at chunk borders (watch the HUD LOD switch counter).
- Rebuilding terrain geometry on every LOD change instead of caching.
- Different height sampling per LOD → seams that skirts can't hide.
- LOD1 with different pivot/scale than LOD0 → visible jump.
- Only reducing triangles on monsters while leaving `mixer.update` running at 60 Hz for 30 monsters.
- Shadow casting left enabled on LOD1+ (shadow pass redraws geometry).

## 10. Profiling / debugging

- `F4` colours chunks by LOD (`src/debug/ChunkDebug.ts`): 0 green, 1 yellow, 2 red.
- HUD: triangles and draw calls; `lodSwitches/s` counter — should be ≈ 0 while standing still.
- Wireframe toggle on the terrain material to inspect grid density and skirts.
- Walk along a chunk border back and forth: no popping, no counter spikes.
- Spector.js capture: confirm LOD2 chunks issue only terrain + 1–2 tree draws.
