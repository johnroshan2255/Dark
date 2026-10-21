---
name: culling
description: Read before adding anything that decides what is drawn, simulated, or updated — chunk visibility, frustum/distance culling, cave/room visibility, monster/physics activation.
---

# Culling & Activation

## 1. Purpose

Do less work for things the player cannot see or affect. "Culling" here covers three separate budgets:

| Budget | What culling saves | Owner |
|---|---|---|
| Render | draw calls, vertex/fragment work, CPU scene traversal | `ChunkVisibility` + Three's per-object frustum test |
| Simulation | Rapier bodies, monster AI ticks, animation mixers | streaming radii (see `world-streaming`) |
| Update | per-frame JS callbacks (`useFrame`, system updates) | activation flags on systems |

The rule of this project: **cull big things first, small things never individually on the CPU.**

```
World
 └─ loaded chunk ring (streaming radius 4)           ← removed entirely if outside
     └─ chunk AABB vs frustum   (≤ 81 tests/frame)  ← ChunkVisibility sets group.visible
         └─ spatial groups inside chunk (terrain, InstancedMesh per species/LOD, prop batches)
             └─ Three per-object frustum test (≈5–15 objects per visible chunk)
                 └─ individual instances: GPU only (vertex shader / fog), never CPU
```

## 2. Architecture

- `src/optimization/culling/ChunkVisibility.ts` — once per frame after streaming:
  1. Build a `Frustum` from `camera.projectionMatrix * camera.matrixWorldInverse`.
  2. For every *rendered* chunk (≤ 9×9 = 81): test the chunk's world `Box3` (x/z = chunk bounds,
     y = `[minHeight, maxHeight + 30 m]` for canopy).
  3. Set `chunk.root.visible`. An invisible `Group` short-circuits Three's traversal: children are not projected,
     not sorted, not frustum-tested.
  4. Write stats: `visibleChunks`, `culledChunks`, `visibleInstances` (sum of `InstancedMesh.count` of visible chunks).
- Chunk LOD (`src/optimization/lod/LodSelector.ts`) runs in the same pass — same distance data.
- Distance culling is implicit: outside render radius the chunk is not built at all; fog (`FogExp2`) is tuned so
  the radius-4 edge (~256 m) is at >97 % fog density. Fog *is* the far plane; set `camera.far` ≈ 300 m.
- Simulation activation uses chunk rings, not frusta: a monster behind you must still hunt you.

| Radius (chunks, Chebyshev) | Activates |
|---|---|
| 0 | interaction raycasts, pickups |
| 1 | physics colliders (heightfield + trunks), shadows cast |
| 2 | monster AI + animation, audio emitters |
| 4 | rendering |
| 5 | generated data cached |

## 3. When to use

- Anything that exists in many chunks (vegetation, props, lights, monsters, sound emitters).
- Anything with a per-frame cost (AI, mixers, particle systems, point lights).
- Enclosed spaces (caves, buildings) where the frustum sees "through" rock.

## 4. When NOT to use

- Do not add CPU visibility tests for individual instances (trees, grass, rocks). 5 000 sphere tests/frame costs
  ~0.3–0.6 ms JS and, worse, forces re-uploading `instanceMatrix` every frame. The GPU rejects off-screen
  triangles cheaply after the vertex shader.
- Do not cull the player's own flashlight, the sun, or anything the post pass depends on.
- Do not occlusion-cull the open forest. Fog and LOD are cheaper than any occlusion system.
- Do not unmount/remount React components to hide things that toggle often (see §7).

## 5. Performance implications

| Operation | CPU | GPU | Memory |
|---|---|---|---|
| 81 AABB-frustum tests | ~0.01 ms | — | — |
| Three per-object frustum test | ~0.2 µs/object | — | — |
| `visible=false` on a chunk group | saves traversal of all children | saves all its draw calls | nothing freed |
| Unmount chunk | React reconcile + `dispose()` ~0.2–1 ms | frees VBOs/textures | frees |
| Per-instance CPU cull (don't) | ~0.1 µs/instance + matrix re-upload | upload bandwidth | — |
| Monster AI tick | 0.02–0.2 ms each | — | — |
| Active Rapier body | step cost scales with active+nearby bodies | — | ~1 KB wasm |

Target: visibility + LOD pass < 0.1 ms per frame.

## 6. WebGL limitations

- No GPU-driven culling: WebGL2 has no compute shaders, no indirect draw, no `multiDrawIndirect`. Culling that
  reduces draw calls must happen on the CPU at group granularity.
- Hardware occlusion queries (`ANY_SAMPLES_PASSED`) exist in WebGL2 but results are async (1–3 frames late)
  and each query is a draw call; only viable for a handful of big occluders — not worth it here.
- Three's frustum test uses the geometry's **bounding sphere**; for `InstancedMesh` the default sphere is the
  source geometry's, not the instances' — call `computeBoundingSphere()` after writing matrices (three ≥ r151
  computes it over instances).
- `SkinnedMesh` bounding spheres are computed from the bind pose; animated limbs can pop. Enlarge or compute
  `skinnedMesh.computeBoundingSphere()` periodically.

## 7. R3F implementation

Lifecycle rule:

| Change frequency | Use |
|---|---|
| Changes every frame or on camera turn | `object.visible = …` via ref, inside the loop |
| Changes on a chunk ring crossing (seconds) | `WorldManager` creates/disposes `WorldChunk` (imperative, budgeted) |
| Changes on gameplay mode (rare) | React mount/unmount of a whole subsystem (`<World>`, `<Effects>`) |

```tsx
// World.tsx — React owns only the mount point; chunks live under world.root.
export function World() {
  const game = useGame()
  return <primitive object={game.world.root} dispose={null} />
}
// WorldChunk.ts implements Cullable { bounds: Box3; ring: number; setVisible(v) } → group.visible = v
```

```ts
// Inside the visibility system — never setState here.
for (const c of world.renderedChunks()) {
  const vis = frustum.intersectsBox(c.bounds)
  if (c.root) c.root.visible = vis
  vis ? stats.visibleChunks++ : stats.culledChunks++
}
```

Never write `visible={isVisible}` from React state updated per frame — each toggle re-renders the chunk subtree.

Drei's `<Detailed>`/`<Bvh>`/`<AdaptiveDpr>` are fine for one-off hero objects, not for the world hot path.

## 8. Direct Three.js implementation

```ts
const _m = new THREE.Matrix4()
const frustum = new THREE.Frustum()

export function updateChunkVisibility(camera: THREE.Camera, chunks: Iterable<LoadedChunk>) {
  _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  frustum.setFromProjectionMatrix(_m)
  for (const c of chunks) if (c.root) c.root.visible = frustum.intersectsBox(c.bounds)
}
```

Instanced vegetation inside a chunk:

```ts
mesh.instanceMatrix.needsUpdate = true
mesh.computeBoundingSphere()   // covers all instances; Three culls whole mesh in one test
mesh.frustumCulled = true      // keep true — it's one test per mesh
```

Set `frustumCulled = false` only for objects whose bounds are wrong by design (fullscreen quads, sky dome,
vertex-shader-displaced grass where you'd otherwise inflate the sphere).

**Spatial partitioning choice**

| Structure | Use for | Why |
|---|---|---|
| Uniform chunk grid (64 m) | everything world-scale | O(1) lookup by `floor(x/64)`, matches streaming |
| Sub-grid inside chunk (16 m cells) | monster/pickup queries, "what's near me" | cheap bucket arrays |
| Quadtree | only if chunk content becomes very non-uniform | usually not needed with a grid |
| BVH (`three-mesh-bvh`) | raycasts against complex meshes (cave interiors, GLB props) | not for visibility |
| Rapier query pipeline | raycasts vs colliders (interaction, AI line-of-sight) | already built |

**Caves / rooms: cell & portal visibility (practical version)**

```
 Forest (outdoor cell) ──portal A── Cave entrance ──portal B── Chamber 1 ──portal C── Chamber 2
```

- Author caves as cells (`Group` each) connected by portals (quad + AABB).
- Each frame: find the camera's cell (point-in-AABB). Visible = current cell + cells reachable through portals
  whose quad intersects the frustum (optionally shrink the frustum to the portal's screen rect — skip unless
  profiling shows need). Depth-limit to 2 portals.
- When inside a cave cell, **hide outdoor chunks beyond radius 1** and swap fog to cave fog. This is the biggest
  win: the forest is ~70 % of draw calls.

**Activation**

```ts
// Monster AI: ring-based, with hysteresis; frozen monsters keep state but skip update/animation.
const d = chebyshev(monster.chunk, player.chunk)
if (!monster.active && d <= 2) activate(monster)
else if (monster.active && d > 3) deactivate(monster)   // +1 ring hysteresis
```

Physics activation: colliders are created by `PhysicsWorld` when a chunk enters radius 1 and removed when it
leaves radius 2. Dynamic bodies outside the ring are put to sleep (`body.sleep()`) or removed and re-spawned from
saved state.

Lights: point lights (lanterns, campfires) are pooled — keep ≤ 4 real `PointLight`s, assign them to the nearest
emitters each 250 ms; the rest are emissive-only. Changing the *number* of lights recompiles shaders — keep the
count constant and set `intensity = 0` instead.

## 9. Common mistakes

- Per-tree `Mesh` + Three's per-object culling "because Three already culls" — CPU traversal of 20k objects.
- CPU-culling instances and repacking `instanceMatrix` every frame.
- `frustumCulled = false` on InstancedMesh because instances vanished → real fix: `computeBoundingSphere()`.
- Toggling visibility through React state; mount/unmount on camera rotation.
- Chunk Box3 ignoring tree height → canopy pops out at screen top.
- Forgetting `camera.updateMatrixWorld()` before building the frustum (1-frame lag, edge popping).
- Culling monsters with the frustum → AI stops when the player turns away.
- Adding/removing lights at runtime (shader recompile hitch of 20–200 ms).
- Using `layers` for culling — layers still traverse; use `visible` on groups.

## 10. Profiling / debugging

- HUD (`F3`, `src/debug/PerformanceMonitor.ts`): visible/culled chunks, visible instances, draw calls, triangles.
  Rotate 360° in place: draw calls should roughly halve when looking at the sky/ground.
- `F4` (`src/debug/CullingDebug.ts`, `ChunkDebug.ts`): chunk Box3 helpers coloured green (visible) / red (culled),
  LOD tint.
- Debug freeze: freeze the culling frustum, then fly the camera out to see what is actually drawn.
- Chrome Performance panel: the visibility pass must not appear as a hot function; if it does, you are iterating
  objects instead of chunks.
- `renderer.info.render.calls` with `info.autoReset=false` (reset once per frame) — compare with expected
  `visibleChunks × meshesPerChunk + fixed`.
