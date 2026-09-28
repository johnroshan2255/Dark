---
name: instancing
description: Read before placing any repeated object (trees, rocks, grass, plants, mushrooms, debris, cave formations, props) in the world.
---

# Instancing

## 1. Purpose

Draw N copies of one geometry+material in **one draw call**. The CPU cost of a draw call (~5–20 µs in WebGL incl.
Three's state setup) dominates small meshes; 5 000 trees as Meshes = 5 000 calls = unplayable. As an
`InstancedMesh` it is 1 call.

Use for: trees, rocks, grass, plants, mushrooms, road debris, repeated cave formations (stalagmites), fence
posts, any environmental prop that appears > ~8 times with the same mesh/material.

## 2. Architecture

**Per-chunk, per-species, per-LOD InstancedMesh** (`src/optimization/instancing/InstanceBuilder.ts`).

```
chunk (3,-2)
 ├─ terrain mesh
 ├─ InstancedMesh  pine    LOD0   count 180
 ├─ InstancedMesh  birch   LOD0   count 60
 ├─ InstancedMesh  rock    LOD0   count 40
 └─ InstancedMesh  plant   LOD0   count 400   (LOD0 only)
```

Generator output (worker, `src/world/Forest/scatter.ts`) is a packed `Float32Array` per species:
`[x, y, z, rotY, scale, tint] × n`, chunk-local. `InstanceBuilder` converts it to `instanceMatrix` once on the
main thread when the chunk is built; matrices are **static** afterwards.

Geometries and materials are shared across all chunks (created once in `MaterialLibrary` / geometry cache).

### Per-chunk vs global pool

| | Per-chunk InstancedMesh (chosen) | Global pool per species |
|---|---|---|
| Culling | chunk group `visible` — free | must compact visible ranges into buffer on every visibility change |
| Draw calls | visibleChunks × species (~20 × 4 = 80) | species count (~4) |
| Streaming | create/dispose with chunk | slot allocator, fragmentation |
| LOD | swap per chunk | one LOD for all or split pools |
| Upload | once per chunk load | partial `updateRange` uploads |

Per-chunk wins on simplicity and CPU; the ~80 draw calls fit the budget (see `webgl`, `batching`). Revisit with
`BatchedMesh` or a global pool only if draw calls from vegetation exceed ~150.

## 3. When to use

- ≥ ~8 copies of same geometry + material within a chunk or visible set.
- Static or rarely changing transforms.
- Variation expressible by transform + `instanceColor` (or a per-instance attribute read in the shader).

## 4. When NOT to use

- Unique hero props, GLBs with many sub-meshes/materials (instance each sub-mesh or merge first).
- Objects needing individual interaction logic *and* frequent transform changes (doors, pickups) — use normal
  Meshes; there are few of them.
- Skinned characters: `InstancedMesh` does not skin. Monsters are individual `SkinnedMesh` (few) or baked vertex
  animation textures (future).
- Objects that need different materials per instance → group by material first.

## 5. Performance implications

| | CPU | GPU | Memory |
|---|---|---|---|
| One InstancedMesh draw | ~10 µs | vertices × count | geometry shared |
| instanceMatrix | build once: ~0.5 µs/instance | 64 B/instance read in VS | 64 B/instance (+12 B instanceColor) |
| 20 k trees visible @ 60 tris | — | 1.2 M tris — too many: LOD1 12 tris ⇒ 240 k | 1.3 MB matrices |
| Updating all matrices per frame (DynamicDrawUsage) | 0.5 µs × n + upload | bandwidth | — |
| Frustum test | 1 sphere per InstancedMesh | — | — |

Budget: ≤ 30 k vegetation instances visible, ≤ 400 k vegetation triangles.

## 6. WebGL limitations

- WebGL2 supports instanced drawing natively (`drawElementsInstanced`); no indirect draw, so `count` is set from JS.
- Per-instance attributes are vertex attributes (max 16 attributes total; a mat4 uses 4) — keep extra
  per-instance data to 1–2 vec4s.
- `instanceColor` multiplies material colour and works with Lambert/Standard; custom per-instance data needs
  `onBeforeCompile` or a custom shader.
- Shadow pass redraws instanced meshes: `castShadow` on 180 pines in a LOD0 chunk ⇒ another 180 × tris.

## 7. R3F implementation

Prefer raw `<instancedMesh>` with an effect that fills matrices once:

```tsx
function ChunkInstances({ data, geometry, material, castShadow }: Props) {
  const ref = useRef<THREE.InstancedMesh>(null!)
  const count = data.length / STRIDE
  useLayoutEffect(() => {
    writeInstanceMatrices(ref.current, data)   // InstanceBuilder
    ref.current.computeBoundingSphere()
  }, [data])
  return <instancedMesh ref={ref} args={[geometry, material, count]} castShadow={castShadow} receiveShadow />
}
```

- `args` change ⇒ R3F recreates the object; keep `count` fixed per chunk data (use the `count` trick below
  instead of changing args).
- Do not pass shared geometry/material through `args` *and* let R3F dispose them: shared resources must be
  excluded from auto-disposal (`dispose={null}` on the element).

**Drei `<Instances>/<Instance>`**: each `<Instance>` is a React component + `Object3D` whose matrix is copied
into the buffer every frame. Good for < ~100 interactive instances; for 1 000+ static vegetation it costs React
reconciliation and per-frame JS. Use raw `InstancedMesh` for the world. Drei `<Merged>` is fine for a few props.

## 8. Direct Three.js implementation

```ts
const STRIDE = 6 // x,y,z,rotY,scale,tint
const _o = new THREE.Object3D(), _c = new THREE.Color()

export function writeInstanceMatrices(mesh: THREE.InstancedMesh, d: Float32Array) {
  const n = d.length / STRIDE
  for (let i = 0; i < n; i++) {
    const k = i * STRIDE
    _o.position.set(d[k], d[k + 1], d[k + 2])
    _o.rotation.set(0, d[k + 3], 0)
    _o.scale.setScalar(d[k + 4])
    _o.updateMatrix()
    mesh.setMatrixAt(i, _o.matrix)
    mesh.setColorAt(i, _c.setScalar(d[k + 5]))
  }
  mesh.count = n
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
}
```

- **Static vs dynamic**: default `StaticDrawUsage` for world. Use
  `mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)` only when updating every frame (debris physics, swarm).
  For occasional updates use `instanceMatrix.addUpdateRange(start*16, n*16)`.
- **Count trick**: allocate capacity once (`new InstancedMesh(geo, mat, 512)`), set `mesh.count = used`. Hide
  one instance by swapping it with the last and decrementing `count` — no reallocation.
- **Grass field (implemented: `src/world/Forest/GrassField.ts`, `grass.ts`)** — NOT per chunk: a G×G window of
  8 m tiles around the player mapped toroidally onto slots of ONE InstancedMesh (1 draw call, cost ∝ radius²).
  Tiles entering the window are refilled nearest-first (4/frame, partial `addUpdateRange` uploads). Clumps of
  5–8 curved tapered blades (3 tris each), base colour = the terrain colour underneath (reads as a carpet, not
  tufts), few dry tufts, wind + distance shrink in the vertex shader, backlit translucency in the fragment.
- **Trees (implemented: `src/world/Forest/treeFactory.ts`)** — 5 procedural species × 3 levels. Near chunks: one
  InstancedMesh per species present; FAR chunks merge species (conifers → one mesh with spruce's far geometry,
  birches → one) so a far chunk costs ≤ 2 tree draws. All levels of a group share one instance-attribute set.
  Per-instance non-uniform scale + lean (`buildInstanceAttributes(..., shape)`).
- **Grass / small plants wind** — do it in the vertex shader, zero CPU:

```ts
material.onBeforeCompile = (s) => {
  s.uniforms.uTime = timeUniform
  s.vertexShader = 'uniform float uTime;\n' + s.vertexShader.replace('#include <begin_vertex>', `
    #include <begin_vertex>
    vec4 wp = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float sway = sin(uTime * 1.7 + wp.x * 0.3 + wp.z * 0.2) * 0.08 * position.y;
    transformed.x += sway; transformed.z += sway * 0.6;`)
}
```

Keep one shared `timeUniform` object; set `material.customProgramCacheKey` if variants exist.

- **BatchedMesh** (r159+): many *different* geometries sharing one material in one draw, per-instance
  visibility, internal per-instance frustum culling (CPU, per frame). Good for mixed props in a chunk (debris set,
  cave formations with 6 variants). Not better than InstancedMesh for a single species. See `batching`.

## 9. Common mistakes

- Instancing a multi-material GLB as one mesh (only first material renders) — split by primitive.
- Forgetting `computeBoundingSphere()` → instances disappear at screen edges; "fixing" with `frustumCulled=false`.
- `DynamicDrawUsage` on static vegetation.
- Creating a new geometry/material per chunk instead of sharing (programs and VBOs multiply; check
  `renderer.info.memory.geometries`).
- React auto-disposing shared geometry when a chunk unmounts → other chunks render nothing.
- Placing instances with `Math.random()` (breaks determinism — use the chunk RNG).
- Casting shadows from grass/plants.

## 10. Profiling / debugging

- HUD: `visibleInstances`, draw calls, triangles, `memory.geometries` (should stay flat while walking).
- Spector.js: verify one `drawElementsInstanced` per species per visible chunk.
- Temporarily set `mesh.count = 0` for a species to measure its GPU cost (frame time delta).
- If GPU-bound on vegetation: check tris per instance × visible count first, then fragment overdraw of leaves.
