---
name: memory
description: Read when creating/destroying GPU resources, Rapier objects, caches or per-frame allocations — disposal, pools, LRU, GC pauses.
---

# Memory: GPU, WASM, JS heap

## 1. Purpose

A streaming open world creates and destroys resources continuously. Every leak is multiplied by the number of
chunks visited. A 30-minute session walking in one direction must reach a **flat** memory plateau.

Three memory pools, three different rules:

| Pool | Freed by | Leak symptom |
|---|---|---|
| GPU (VRAM) | explicit `dispose()` only | `renderer.info.memory` counts grow; eventual context loss |
| WASM heap (Rapier) | explicit `remove*/free()`; heap never shrinks | Rapier slows, heap grows |
| JS heap | GC (when unreachable) | GC pauses (5–50 ms hitches), growth in heap snapshots |

## 2. Architecture

```
ChunkData (typed arrays)        ← LRU cache (ring ≤ 5 + slack), recycled Float32Arrays from a pool
   │ build
   ▼
Chunk GPU resources             ← owned by WorldChunk; disposed on unmount (terrain geometry per LOD)
   shared: MaterialLibrary materials, species geometries  (never disposed by chunks, dispose={null})
Chunk physics body              ← owned by PhysicsWorld, removed when leaving physics ring (+ hysteresis)
Scratch math objects            ← module-scope, reused every frame
```

Ownership rule: **whoever creates a resource disposes it**. Shared resources are owned by a library with an
explicit lifetime (game session).

## 3. When to use

- Every chunk load/unload, LOD switch, asset load, render target resize, monster spawn/despawn.
- Every hot loop (per frame / per entity / per instance).

## 4. When NOT to use

- Don't pool things created once per session (the renderer, the post pipeline).
- Don't hand-manage memory of small, rare objects (UI state) — GC is fine.
- Don't prematurely pool Three objects that are cheap and rare (a few Groups on chunk load are fine).

## 5. Performance implications

| Operation | Cost |
|---|---|
| `new THREE.Vector3()` in a loop over 10 000 items per frame | ~0.5 MB/s garbage → minor GC every few seconds (1–5 ms) |
| Geometry upload 33×33 terrain (~150 KB) | ~0.1–0.3 ms on first render |
| `geometry.dispose()` | cheap; deletes GL buffers on next render |
| Chunk LRU of 121 entries × ~40 KB (heights + instances) | ~5 MB JS heap |
| Rapier heightfield per chunk | ~20–40 KB WASM heap |

Major GC on a heap with large churn can pause 10–50 ms — visible stutter. Keep steady-state allocation near zero.

## 6. WebGL limitations

- No API to query real VRAM usage; `renderer.info.memory` only counts *objects*, not bytes. Estimate bytes yourself.
- Context loss (`webglcontextlost`) when VRAM is exhausted or the GPU resets; all GPU resources are gone. Keep CPU
  sources (or the ability to regenerate from seed) for anything procedural.
- Deleting GL objects is asynchronous on the driver side; memory may lag a few frames.

## 7. R3F implementation

```tsx
// Geometry built per LOD — not tracked by R3F because it came from useMemo
function Terrain({ data, lod }: { data: ChunkData; lod: number }) {
  const geo = useMemo(() => buildTerrainGeometry(data, lod), [data, lod])
  useEffect(() => () => geo.dispose(), [geo])            // runs on LOD change and unmount
  return <mesh geometry={geo} material={lib.terrain} dispose={null} />  // don't dispose shared material
}
```

- JSX-created resources (`<boxGeometry/>`, `<meshLambertMaterial/>`) are disposed automatically by R3F on unmount.
- `dispose={null}` stops disposal for that element **and its children** — use it on owners of shared resources.
- `useGLTF` caches by URL for the session; call `useGLTF.clear(url)` and dispose the scene's resources if an asset
  category truly goes away (rare).

## 8. Direct Three.js implementation

### Full disposal of a subtree we built imperatively

```ts
function disposeObject(root: THREE.Object3D, shared: Set<object>) {
  root.traverse(o => {
    const m = o as THREE.Mesh
    if (m.geometry && !shared.has(m.geometry)) m.geometry.dispose()
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : []
    for (const mat of mats) {
      if (shared.has(mat)) continue
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture && !shared.has(v)) v.dispose()
      mat.dispose()
    }
    if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose() // frees instance attrs
  })
  root.removeFromParent()
}
```

`material.dispose()` does not dispose textures; `InstancedMesh.dispose()` releases instance buffers (not the
geometry/material).

### Render targets

```ts
rt.setSize(w, h)   // reuse on resize — don't dispose + recreate unless format/samples change
rt.dispose()       // on pipeline teardown or format change
```

### Rapier

```ts
world.removeRigidBody(chunkBody)          // also removes its colliders
world.removeCharacterController(ctrl)
world.free()                              // session end
// Reuse query objects:
const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })
ray.origin.x = px; ray.origin.y = py; ray.origin.z = pz
```

`body.translation()` / `linvel()` return new JS objects each call — call once per body per step.

### Scratch objects (no per-frame allocation)

```ts
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _box = new THREE.Box3()
export function updateVisibility(chunks: Chunk[], frustum: THREE.Frustum) {
  for (const c of chunks) c.group.visible = frustum.intersectsBox(c.box)   // no allocation
}
```

Module-scope scratch is safe because JS is single-threaded; never hold a scratch object across calls.
Avoid in hot paths: array spread, `map/filter` producing arrays, closures created per iteration, template strings,
`Object.entries`.

### Typed-array pools

```ts
export class Float32Pool {
  private free = new Map<number, Float32Array[]>()
  get(len: number) { return this.free.get(len)?.pop() ?? new Float32Array(len) }
  release(a: Float32Array) { let l = this.free.get(a.length); if (!l) this.free.set(a.length, (l = [])); if (l.length < 64) l.push(a) }
}
```

Caveat: arrays **transferred** from a worker (`postMessage(msg, [buf])`) become detached in the sender. Pool on
the receiving side, or transfer them back to the worker for reuse.

### LRU cache for ChunkData

```ts
export class LRU<K, V> {
  private map = new Map<K, V>()
  constructor(private cap: number, private onEvict?: (k: K, v: V) => void) {}
  get(k: K) { const v = this.map.get(k); if (v !== undefined) { this.map.delete(k); this.map.set(k, v) } return v }
  set(k: K, v: V) {
    this.map.delete(k); this.map.set(k, v)
    while (this.map.size > this.cap) { const [ok, ov] = this.map.entries().next().value!; this.map.delete(ok); this.onEvict?.(ok, ov) }
  }
}
```

Data cache capacity ≈ (2×5+1)² = 121 chunks + ~30 slack. Data can always be regenerated from the seed, so eviction
is safe.

## 9. Common mistakes

1. Relying on GC for GPU resources — geometries/textures stay in VRAM until `dispose()`.
2. Disposing a shared material from a chunk → next frame, every chunk using it recompiles/re-uploads.
3. Rebuilding the render target on every resize event (30 per second while dragging).
4. Keeping references to unloaded chunks in debug arrays/maps (debug tools leak too).
5. Forgetting worker-transferred buffers are detached.
6. Rapier bodies not removed with chunk → WASM heap grows, broad-phase slows.
7. `console.log` of objects in hot paths — DevTools retains them (a leak while DevTools is open).
8. Closures in `useFrame` capturing large objects from old renders.

## 10. Profiling / debugging

- HUD (`F3`): `geometries`, `textures`, `programs`, active chunks, Rapier bodies/colliders. Walk in one direction
  for 2 minutes: all must plateau.
- Chrome Memory → Heap snapshot before/after walking; compare "Objects allocated between snapshots", filter
  `BufferGeometry`, `Float32Array`, `WorldChunk`.
- Chrome Performance with "Memory" checkbox: sawtooth = allocation churn; look for GC events > 5 ms.
- `performance.memory.usedJSHeapSize` (Chrome only) in HUD.
- Rapier heap: `world.bodies.len()`, `world.colliders.len()` over time.
- Force context loss test: `renderer.getContext().getExtension('WEBGL_lose_context').loseContext()`.
