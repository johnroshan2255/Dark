---
name: threejs
description: Read when you need direct Three.js control — scene graph cost, matrices, geometry attributes, instancing, raycasting, layers, render order.
---

# Direct Three.js (r186) in DARK

## 1. Purpose

R3F gives us composition; Three.js is the engine. Every performance-sensitive system (terrain, vegetation,
monsters, post, culling) is written against Three.js directly. This skill covers the scene-graph-level costs
that R3F hides.

## 2. Architecture

```
Scene
 ├─ WorldRoot (Group, matrixAutoUpdate=false)
 │    └─ Chunk groups (one per loaded chunk, visible toggled by ChunkVisibility)
 │         ├─ Terrain Mesh              (static: matrixAutoUpdate=false)
 │         └─ InstancedMesh × species × LOD
 ├─ Dynamic root (players, monsters, BMX — matrices updated each frame)
 ├─ Lights (sun + target, hemi, flashlight)
 └─ Debug root (layer 1 — hidden unless debug)
```

Static and dynamic content are separated so we can disable automatic matrix work on the static part.

## 3. When to use

- Anything that updates at frame rate.
- Anything with more than ~50 instances.
- Custom geometry (terrain, roads), custom materials/shaders, render targets.
- Querying renderer state: `renderer.info`, `renderer.capabilities`, `renderer.getContext()`.

## 4. When NOT to use

- Simple one-off scene objects with no hot path (a menu prop) — JSX is clearer.
- Do not bypass R3F's lifecycle for things that are naturally mount/unmount; if you build imperatively, you own
  disposal.

## 5. Performance implications

`renderer.render(scene, camera)` does, every frame:

1. `scene.updateMatrixWorld()` — visits **every** Object3D; for each with `matrixAutoUpdate`, recomposes `matrix`
   from position/quaternion/scale (~50–100 ns each). 10 000 objects ≈ 0.5–1 ms.
2. Projects & frustum-tests every visible object with `frustumCulled` (bounding sphere, ~30 ns each).
3. Sorts opaque/transparent lists.
4. Per draw: program/uniform/state changes and a `drawElements` call (~5–20 µs CPU each in WebGL).

| Choice | CPU per frame | GPU | Memory |
|---|---|---|---|
| 10 000 Meshes | 1–3 ms traversal + 10 000 draws (unplayable) | draw-bound | ~10 MB JS objects |
| 1 InstancedMesh × 10 000 | ~0 traversal, 1 draw | vertex-bound only | 640 KB matrices |
| `matrixAutoUpdate=false` on 5 000 static | saves ~0.3–0.5 ms | 0 | — |
| Raycast vs 1 InstancedMesh of 10 000 | tests every instance (~1–3 ms!) | 0 | — |

## 6. WebGL limitations

- Draw call overhead is CPU-side and high in WebGL (validation in browser + ANGLE). Target < 300 draws/frame.
- No multi-draw-indirect; `BatchedMesh` uses `WEBGL_multi_draw` when available, otherwise loops.
- `gl_InstanceID` and instanced attributes available in WebGL2 (our minimum).
- Uniform limits: ~1024 vec4 per stage on desktop; don't put large arrays of lights/bones in uniforms.

## 7. R3F implementation

Direct mutation inside R3F:

```tsx
const mesh = useRef<THREE.Mesh>(null!)
useLayoutEffect(() => {
  mesh.current.matrixAutoUpdate = false
  mesh.current.updateMatrix()
}, [])
return <mesh ref={mesh} position={[x, 0, z]} geometry={geo} material={mat} />
```

Or mount a pre-built object: `<primitive object={chunkGroup} dispose={null} />`.

## 8. Direct Three.js implementation

### Static objects

```ts
obj.position.set(x, y, z)
obj.updateMatrix()
obj.matrixAutoUpdate = false            // no recompose each frame
// Whole static subtree, if its world matrices never change after placement:
group.updateMatrixWorld(true)
group.matrixWorldAutoUpdate = false     // r15x+: skips updateMatrixWorld recursion into it
```

If you later move a static object: set values, call `updateMatrix()` and `updateMatrixWorld(true)` yourself.

### Layers (cheap visibility masks)

```ts
const LAYER_DEBUG = 1
debugHelper.layers.set(LAYER_DEBUG)
camera.layers.enable(LAYER_DEBUG)   // toggle debug view without scene changes
sun.shadow.camera.layers           // shadow camera uses light.shadow.camera layers
```

Layers are tested per object before frustum test — cheap. Use them for debug, first-person-only meshes, and
"not in shadow pass" (lights render shadows using `light.shadow.camera.layers`).

### renderOrder

- Opaque objects are sorted front-to-back per material/program; transparent back-to-front.
- Set `renderOrder` for: sky/background (−1000, `depthWrite=false`), first-person hands (last, with depth clear),
  fog cards/particles (after opaque).
- `renderer.sortObjects = false` saves sort time only if you control order entirely — we don't.

### BufferGeometry attributes

```ts
const g = new THREE.BufferGeometry()
g.setAttribute('position', new THREE.BufferAttribute(positions, 3))           // Float32Array
g.setAttribute('normal', new THREE.BufferAttribute(normals, 3, false))
g.setAttribute('color', new THREE.BufferAttribute(colors, 3, true))           // Uint8Array normalized → 3 B/vertex vs 12
g.setIndex(new THREE.BufferAttribute(indices, 1))                             // Uint16 if < 65 536 verts
g.boundingBox = chunkBox.clone()                                              // set explicitly: avoids compute pass
g.boundingSphere = chunkSphere.clone()
```

- Use `Uint16Array` indices when vertex count < 65 536 (33×33 terrain + skirts ≈ 1 200 ✔).
- Normalized `Uint8`/`Int8` for colors/normals when precision allows; halves/quarters upload size.
- Dynamic buffers: `attr.setUsage(THREE.DynamicDrawUsage)`; update ranges with
  `attr.addUpdateRange(start, count); attr.needsUpdate = true` — uploads only that range.
- Delete CPU copies you'll never read again: after first upload, `attr.onUpload(function () { this.array = null })`
  (only for geometry you never raycast/rebuild on CPU).

### InstancedMesh

```ts
const im = new THREE.InstancedMesh(geometry, material, maxCount)
im.instanceMatrix.setUsage(THREE.StaticDrawUsage)   // vegetation: written once
im.count = actualCount                               // draw only this many
for (let i = 0; i < n; i++) { m.compose(p, q, s); im.setMatrixAt(i, m) }
im.instanceMatrix.needsUpdate = true
im.computeBoundingSphere()                           // covers all instances (r15x+), needed for frustum culling
im.frustumCulled = true
```

- `setColorAt` allocates `instanceColor` lazily — call once before the first render or the shader compiles twice.
- Shadows: `im.castShadow` applies to all instances; use a separate low-LOD instanced mesh for shadow casting
  if needed.

### Raycasting cost

- `Raycaster.intersectObjects(scene.children, true)` traverses everything and tests triangles — **never** per frame.
- InstancedMesh raycast tests every instance's bounding sphere then triangles — thousands of instances = ms.
- For gameplay queries use **Rapier** (`world.castRay`) — BVH-accelerated and already contains what matters.
- For interaction: gather candidates from the player's chunk, raycast only those; set `raycaster.far`.
- `raycaster.layers` to skip debug/vegetation.

### Scene traversal

- `scene.traverse` is O(n) and allocates nothing, but callback cost adds up; never traverse per frame.
- `getObjectByName` is a traversal — cache refs.
- Removing children: `parent.remove(child)` is O(children) (array splice). For many removals, rebuild the array or
  pool and toggle `visible`.

### Frustum test by hand

```ts
const frustum = new THREE.Frustum(), pv = new THREE.Matrix4()
pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
frustum.setFromProjectionMatrix(pv)
chunk.group.visible = frustum.intersectsBox(chunk.box)
```

## 9. Common mistakes

1. Leaving `matrixAutoUpdate=true` on thousands of static objects.
2. Calling `computeBoundingSphere()` on InstancedMesh before setting matrices (sphere covers origin only → culled wrongly).
3. Forgetting `instanceMatrix.needsUpdate = true`.
4. Mixing `Float32` colors where normalized `Uint8` suffices.
5. Changing `material.fog`, `defines`, light counts, or `castShadow`/`receiveShadow` at runtime → shader recompiles.
6. Toggling lights' `visible` → changes light count → **every lit material recompiles**. Set `intensity = 0`
   instead, keep light count constant.
7. Recursive `raycast` from mouse move over the entire scene.
8. `new THREE.Color()`/`Vector3()` in hot loops.

## 10. Profiling / debugging

- `renderer.info.render.{calls,triangles}`, `.memory.{geometries,textures}`, `.programs.length` (HUD, `F3`).
- Chrome Performance: `updateMatrixWorld` and `projectObject` self-time → scene graph too big.
- Spector.js (browser extension) to capture one frame: inspect every draw call, state change, and uniform upload.
- Count objects: `let n = 0; scene.traverse(() => n++)` in the console.
- `renderer.debug.checkShaderErrors = false` in production (saves a sync `getProgramInfoLog` per compile).
