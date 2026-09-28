---
name: world-streaming
description: Read before changing how chunks are generated, loaded, built, activated, cached, or disposed, or adding a system with its own activation radius.
---

# World Streaming

## 1. Purpose

The world is infinite in principle and never exists fully in memory. Only a ring of 64 m chunks around the
player (the union of all players' rings in co-op) is generated, built, rendered and simulated, each system with
its own radius.

## 2. Architecture

```
            radius 5: data cached (LRU)
      ┌───┬───┬───┬───┬───┬───┬───┬───┬───┐
      │ 2 │ 2 │ 2 │ 2 │ 2 │ 2 │ 2 │ 2 │ 2 │   render radius 4 (9×9 = 81 chunks)
      ├───┼───┼───┼───┼───┼───┼───┼───┼───┤   numbers = chunk LOD
      │ 2 │ 1 │ 1 │ 1 │ 1 │ 1 │ 1 │ 1 │ 2 │
      ├───┼───┼───┼───┼───┼───┼───┼───┼───┤
      │ 2 │ 1 │ 1 │ 1 │ 1 │ 1 │ 1 │ 1 │ 2 │
      ├───┼───┼───┼───┼───┼───┼───┼───┼───┤   ░ physics radius 1 (3×3)
      │ 2 │ 1 │ 1 │░0░│░0░│░0░│ 1 │ 1 │ 2 │   ▒ AI / audio radius 2 (5×5)
      ├───┼───┼───┼───┼───┼───┼───┼───┼───┤
      │ 2 │ 1 │ 1 │░0░│░P░│░0░│ 1 │ 1 │ 2 │   P = player chunk (interaction)
      ├───┼───┼───┼───┼───┼───┼───┼───┼───┤
      │ 2 │ 1 │ 1 │░0░│░0░│░0░│ 1 │ 1 │ 2 │
      └───┴───┴───┴───┴───┴───┴───┴───┴───┘
```

| System | Enter radius | Leave radius (hysteresis +1) |
|---|---|---|
| Data (worker result cached) | 5 | LRU eviction, cap 150 chunks |
| Render (meshes built) | 4 | 5 |
| Physics colliders | 1 | 2 |
| AI + monster animation | 2 | 3 |
| Audio emitters | 2 | 3 |
| Interaction | 0 | 0 (raycast-based) |

Pipeline per chunk:

```
request (cx,cz) ─▶ worker: generateChunk(seed,cx,cz) ─▶ ChunkData (typed arrays, transferred)
      ─▶ cache (LRU) ─▶ build queue ─▶ main thread build (≤ 1–2 per frame, ≤ 3 ms budget)
      ─▶ World version++ ─▶ React mounts <WorldChunk> ─▶ ChunkVisibility/LodSelector own it
      ─▶ physics ring? PhysicsWorld.addChunk()
leave render ring ─▶ unmount (dispose chunk-owned geometry) ─▶ data stays in LRU
```

Files: `src/world/Streaming/ChunkStreamer.ts` (ring math, request/unload decisions, queues),
`src/world/Streaming/chunk.worker.ts` (pure generation), `src/world/WorldManager.ts` (chunk map, build, stats),
`src/world/WorldChunk.ts` (imperative render object; React mounts only `WorldManager.root`), `src/physics/PhysicsWorld.ts` (colliders).

## 3. When to use

- Any content with world position: terrain, vegetation, props, POIs, monster spawns, audio emitters, lights.
- Any system whose cost scales with world area.

## 4. When NOT to use

- Global singletons: sky, sun, fog, player, post pipeline.
- Small handcrafted interiors (a cave system): stream the *entrance* with the chunk, load the interior as one unit
  when the player is within ~40 m of the entrance.
- Don't re-evaluate the ring every frame from scratch when the player chunk hasn't changed — only recompute on chunk
  change (plus drain queues each frame).

## 5. Performance implications

| Step | Where | CPU | Memory |
|---|---|---|---|
| Generate chunk (65² fbm heights + scatter) | worker | 2–6 ms (off main thread) | ~17 KB heights + ~10–40 KB instances |
| Transfer | postMessage transferables | ~0 (ownership move) | — |
| Build terrain LOD geometry | main | 0.3–1 ms | 65² × (pos+normal+color) ≈ 150 KB GPU |
| Build instances | main | 0.5 µs/instance | 64 B/instance |
| Heightfield collider | main (wasm) | 0.2–0.5 ms | ~20 KB |
| React mount chunk | main | 0.2–0.5 ms | — |
| Dispose | main | < 0.2 ms | frees GPU |

Budgets: main-thread chunk work ≤ 3 ms/frame; at sprint (~7 m/s) the player crosses a 64 m chunk every ~9 s and
a new ring edge is 9 chunks ⇒ ~1 chunk/s build rate is enough. BMX (~15 m/s) ⇒ ~2–3 chunks/s; still within
budget at 1 build/frame. Resident: 81 rendered chunks ≈ 15–25 MB GPU, cache 150 chunks ≈ 5–8 MB JS.

## 6. WebGL limitations

- GPU uploads happen on first render of a new buffer, on the main thread, inside `renderer.render` — a chunk
  "built" in JS still costs an upload hitch next frame. Budget builds per frame, not just per generate.
- New shader variants compile synchronously (unless `KHR_parallel_shader_compile` + `renderer.compileAsync`).
  Never introduce a new material/define combination per chunk; all chunk materials are pre-warmed at startup.
- Workers cannot touch WebGL (no OffscreenCanvas renderer here); they produce data only.
- `gl.deleteBuffer` only happens on `geometry.dispose()` — forgetting it leaks GPU memory silently.

## 7. R3F implementation

```tsx
// World.tsx — re-renders only when the chunk set or a chunk's LOD changes.
export function World() {
  const world = useGame().world
  const version = useSyncExternalStore(world.subscribe, world.getVersion)
  const chunks = useMemo(() => world.renderedChunks(), [version])
  return <>{chunks.map(c => <WorldChunk key={c.key} chunk={c} lod={c.lod} />)}</>
}
```

- `key` = `"cx,cz"` so React never reuses a component for a different chunk.
- Chunk-owned geometry (terrain LODs, merged props) is disposed in the `WorldChunk` effect cleanup.
- Shared geometry/materials use `dispose={null}` so R3F does not dispose them on unmount.
- The streamer update runs inside the game loop (`streaming` phase), never in a component body.

## 8. Direct Three.js implementation

**Worker**

```ts
// chunk.worker.ts
import { generateChunk } from '../WorldGenerator'
self.onmessage = (e: MessageEvent<{ seed: number; cx: number; cz: number }>) => {
  const d = generateChunk(e.data.seed, e.data.cx, e.data.cz)
  const transfer = [d.heights.buffer, ...Object.values(d.instances).map(a => a.buffer)]
  ;(self as unknown as Worker).postMessage(d, transfer)
}
```

```ts
const worker = new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' })
```

Use 1–2 workers (`Math.min(2, navigator.hardwareConcurrency - 2)`). Prioritise requests by distance (closest
first) and drop requests for chunks that left the ring before the result arrived.

**Ring update with hysteresis**

```ts
function updateRing(pcx: number, pcz: number) {
  for (let dz = -R_RENDER; dz <= R_RENDER; dz++)
    for (let dx = -R_RENDER; dx <= R_RENDER; dx++) request(pcx + dx, pcz + dz)
  for (const c of loaded.values())
    if (Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz)) > R_RENDER + 1) unload(c)
}
```

**Build budget**

```ts
const t0 = performance.now()
while (buildQueue.length && performance.now() - t0 < 3) build(buildQueue.shift()!)
```

Always build at least one per frame when the queue is non-empty, sort queue by distance each time the player
chunk changes.

**LRU cache**: `Map` insertion order; on access `delete` + `set`; evict oldest beyond cap. Cached data is pure,
so regeneration is always a valid fallback.

**Co-op**: host computes the ring union of all players for simulation (physics/AI); each client renders only
its own ring. Monsters beyond every player's AI ring are frozen or despawned (state saved per chunk).

**Floating origin**: at 64 m chunks float32 precision is fine to ~±10 km (≈1 mm). If the world ever exceeds that,
rebase the origin when the player passes 4 km (shift all roots + physics); not needed now.

## 9. Common mistakes

- Generating on the main thread "for now" and never moving it.
- Unload radius == load radius → load/unload thrash at borders.
- Leaking: removing a mesh from the scene without `geometry.dispose()`; forgetting to remove Rapier colliders.
- Disposing shared materials when a chunk unmounts.
- Sending `ChunkData` without transfer list (structured clone copies all arrays).
- Stale worker results for unloaded chunks being built anyway.
- Rebuilding the whole chunk list in React every frame.
- Using player *position* rather than *chunk* change to trigger ring recompute (runs every frame).

## 10. Profiling / debugging

- HUD: loaded/rendered/physics chunks, build queue length, worker in-flight count, `memory.geometries`.
- `F4` chunk debug overlay (`src/debug/ChunkDebug.ts`): bounds, LOD tint, physics ring.
- Leak test: walk/fly 2 km straight then back; `renderer.info.memory.geometries` and textures must return to the
  starting plateau. Chrome Memory → heap snapshot comparison for `BufferGeometry`.
- Chrome Performance: long tasks > 8 ms during streaming = budget violation; look for `build`, `upload`, `compile`.
- Teleport test (debug): jump 5 km; the ring should fill closest-first within ~2 s without a frame > 50 ms.
