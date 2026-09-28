---
name: batching
description: Read when draw calls are high or when combining static meshes, many different props, or materials/textures (merging, BatchedMesh, atlases).
---

# Batching

## 1. Purpose

Reduce draw calls and state changes for things that are **not** many copies of one mesh (that's `instancing`).
Draw call budget for this game: **< 300 per frame** total (incl. shadow pass), target ~150–200.

| Technique | Merges | Draw calls | Keeps per-object control? |
|---|---|---|---|
| InstancedMesh | same geometry, same material | 1 | transform/colour per instance |
| Static merge (`mergeGeometries`) | different geometry, same material | 1 | no (baked) |
| BatchedMesh | different geometry, same material | 1 (multi-draw) | transform, visibility per instance |
| Texture atlas / shared material | enables the above | — | — |

## 2. Architecture

```
Per chunk (built on main thread after worker data arrives):
  terrain        → 1 mesh (already one geometry)
  vegetation     → InstancedMesh per species (instancing skill)
  static props   → merged per material ("props_static" geometry), built once at chunk load
  mixed props    → optional BatchedMesh per material if > ~6 variants and needs visibility per item
  interactive    → individual Meshes (doors, pickups, few per chunk)
Global:
  one material per surface family in src/rendering/materials/MaterialLibrary.ts
  props share 1–3 atlas textures (2048², KTX2)
```

The number of **materials** × **visible chunks** is the draw-call multiplier. Keep per-chunk material count ≤ 6.

## 3. When to use

- Static props that never move and are visible together (road barriers, rubble piles, a cabin's parts).
- Kitbashed structures (cabin = 40 pieces → 2 merged meshes by material).
- Many different small cave formations sharing an atlas → BatchedMesh.

## 4. When NOT to use

- Objects that must be removed/moved individually (loot, breakables) — unless using BatchedMesh.
- Merging across chunk boundaries: breaks culling and streaming. Merge **within** a chunk only.
- Merging huge areas into one mesh: kills frustum culling (the whole thing is always "visible").
- Merging meshes with different materials: you must group by material first (or use `groups`, which still issues
  one draw per group).

## 5. Performance implications

| | CPU | GPU | Memory |
|---|---|---|---|
| mergeGeometries (40 props, 20 k verts) | 2–5 ms one-off → do in worker or at chunk build with budget | same tris, fewer calls | duplicates vertices (no sharing) |
| BatchedMesh | per-frame internal culling + sort ~1 µs/instance | multi-draw 1 call (WEBGL_multi_draw) | one big buffer, reserved capacity |
| Atlas | UV remap offline | fewer texture binds; mip bleeding risk | one large texture instead of many |
| Each extra material | shader program switch if different type | — | a program per unique define set |

## 6. WebGL limitations

- Draw-call overhead in WebGL is larger than native (validation + ANGLE translation on Windows ⇒ D3D11).
  Assume ~150–300 calls at 60 fps on mid hardware before CPU binds.
- `BatchedMesh` uses `WEBGL_multi_draw` when available (Chrome/Edge/Firefox desktop yes, Safari recent); falls
  back to multiple draws otherwise — still saves Three's per-object overhead.
- 16 texture units per fragment shader typically; texture arrays (`DataArrayTexture`) are WebGL2-only but work
  and avoid atlas bleeding.
- Indices: merged geometry above 65 535 verts needs `Uint32` indices (fine in WebGL2).

## 7. R3F implementation

```tsx
function ChunkStaticProps({ chunk }: { chunk: LoadedChunk }) {
  const geo = useMemo(() => chunk.buildMergedProps(), [chunk]) // returns BufferGeometry | null
  useEffect(() => () => geo?.dispose(), [geo])
  return geo ? <mesh geometry={geo} material={materials.props} castShadow={chunk.lod === 0} receiveShadow /> : null
}
```

Drei's `<Merged>` creates instanced meshes from a map of meshes — useful for a few props. It is not a static merge.

## 8. Direct Three.js implementation

**Static merge**

```ts
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

function mergeProps(parts: { geo: THREE.BufferGeometry; matrix: THREE.Matrix4 }[]) {
  const baked = parts.map(p => p.geo.clone().applyMatrix4(p.matrix))
  const merged = mergeGeometries(baked, false)   // false = no groups (same material)
  baked.forEach(g => g.dispose())
  merged?.computeBoundingSphere()
  return merged
}
```

All inputs must have the same attribute set (e.g. all have `uv`, `normal`, `color`); strip or add attributes first.

**BatchedMesh**

```ts
const batch = new THREE.BatchedMesh(maxInstances, maxVerts, maxIndices, materials.props)
const rockA = batch.addGeometry(geoA), rockB = batch.addGeometry(geoB)
const id = batch.addInstance(rockA)
batch.setMatrixAt(id, matrix)
batch.perObjectFrustumCulled = false   // chunk already culled; skip per-instance CPU test
batch.sortObjects = false              // opaque, no need
```

Disable `perObjectFrustumCulled` when the chunk group handles culling — otherwise it tests every instance on the CPU
every frame (contrary to our culling hierarchy).

**Atlases**: bake in the asset pipeline (see `texture-optimization`): one 2048² atlas per material family, 4–8 px
padding, mip-safe (padding ≥ 2^mipLevels used). AI-generated assets usually come with unique 1–2k textures each —
re-bake into atlas or replace with palette textures (flat colour swatches, 256² palette) which suits the
low-poly style and costs ~nothing.

## 9. Common mistakes

- One material instance per GLB (each `useGLTF` clone keeps its own materials) — remap to library materials.
- Merging an entire chunk incl. terrain and vegetation — lose LOD and instancing.
- Leaving `BatchedMesh.perObjectFrustumCulled = true` for thousands of static items.
- Different `material.defines`/`onBeforeCompile` per chunk → separate shader programs (check `info.programs`).
- Merging at runtime on the main thread for every chunk without a budget → hitches.

## 10. Profiling / debugging

- HUD draw calls and `info.programs`; compare across rotations and after walking 1 km (should be stable).
- Spector.js: count draws per frame, group by program; look for repeated identical state.
- Chrome Performance: `WebGLRenderer.render` self time vs GPU — high CPU with low GPU ⇒ draw-call bound ⇒ batch.
- Quick test: halve render radius; if FPS jumps with GPU idle, you are CPU/draw bound.
