---
name: physics
description: Read before touching Rapier — world stepping, terrain heightfields, colliders, character controller, BMX, activation radius, WASM memory.
---

# Physics (Rapier 3D, `@dimforge/rapier3d-compat` 0.21)

## 1. Purpose

Rapier handles everything that must *collide*: player, terrain, tree trunks, BMX, monsters, a few dynamic props.
It is **not** a representation of the whole world — only a small bubble around the player(s).

## 2. Architecture

```
src/physics/PhysicsWorld.ts
  init()            await RAPIER.init() once, create World(gravity -9.81)
  step(dt)          fixed 60 Hz accumulator, max 4 substeps, returns alpha for interpolation
  addChunk(chunk)   heightfield + trunk colliders for chunks with ring distance ≤ 1
  removeChunk(key)  removes the chunk's fixed body (and all its colliders)
  castRay / shape casts for gameplay queries
src/gameplay/player/   KinematicCharacterController + capsule
src/gameplay/bmx/      dynamic rigid body + raycast suspension (future)
src/debug/PhysicsDebug.ts  world.debugRender() → LineSegments (F6)
```

Per-chunk physics = **one fixed RigidBody** owning: 1 heightfield collider + N trunk cylinders + one CONVEX
HULL per rock (the rock's own 12-point shape, `propGeometries.ROCK_HULL`, scaled/rotated like its instance —
tested: a ray onto every rock hits it) + pole/fence/building boxes. Removing the body removes all its colliders.

**Vehicles are SIMULATED** (`gameplay/vehicle/VehicleSim.ts`, tested headless in `tests/vehicle.test.ts`): Rapier
DYNAMIC bodies + `DynamicRayCastVehicleController` (per-wheel spring/damper suspension, engine force, brakes, steering,
tyre friction limit + side grip). Rapier's positive steering turns LEFT — we negate it.
- **Truck** (1750 kg, COM 0.62 m): 4×4 with force/power curve (12 kN, 120 kW; automatic low range adds up to
  24 kN nose-up), drive split by wheel load (traction control), drag + rolling resistance, speed-sensitive steering,
  handbrake = locked slippery rear, anti-roll assist, wheelie/back-flip control on steep climbs, auto-righting after
  2 s on its side. Measured: 0→72 km/h 4.7 s, top ≈ 90 km/h, 25 m/s → 0 in 27 m, climbs 20°–60° from standstill.
- **Bike** (85 kg with rider, COM ≈ 0.9 m): 2 centre-line wheels, human power (900 W, 1500 W sprint, 900 N max),
  weight shift over the bars. BALANCE = roll is a hard constraint while riding, eased toward the physical lean
  φ = atan(v²·tanδ/(g·L)) — a torque PD on the tiny roll inertia explodes at 60 Hz and a velocity servo loses to the
  tyres above ~8 m/s (both measured). Crash = −5.5 m/s within 0.15 s → rider thrown + knocked down, constraint
  released, bike falls over. Measured: cruise 9.6 m/s, leans ±28° in full-lock turns, climbs 18°, not 32° (push it).
- Simulated only where the ground has colliders (physics ring); a parked truck outside it is frozen, a parked bike
  is kinematic scenery. Cost: ≈ +0.1 ms physics per 60 Hz step while driving (M4, HIGH and LOW).

## 3. When to use

- Player / monster / BMX collision and ground detection.
- Terrain collision (heightfield).
- Line-of-sight and interaction raycasts (`world.castRay`) — BVH-accelerated, far cheaper than Three raycasting.
- Dynamic props that the player must push (a few, not hundreds).

## 4. When NOT to use

- Grass, plants, mushrooms, rocks < 0.5 m, branches, foliage canopies — no collider.
- Distant chunks (ring > 1): no colliders at all.
- Decorative animation (swaying, debris particles) — do in shader/CPU without physics.
- Cosmetic ragdolls for every monster: only on death, only near, only a few at once.

## 5. Performance implications

| Item | CPU | Memory (WASM heap) |
|---|---|---|
| World step, 9 chunks, ~1 000 static colliders, 1–5 dynamic bodies | 0.1–0.4 ms | — |
| Heightfield 64×64 subdivisions | build ~0.05 ms | ~17 KB heights + BVH |
| Trunk cylinder collider (static) | ~0 when sleeping neighbours | ~300–500 B each |
| Character controller `computeColliderMovement` | 0.02–0.1 ms per character | — |
| `castRay` | ~1–5 µs | — |
| `debugRender()` | 1–10 ms (allocates big Float32Arrays) — debug only | high |

Static colliders cost almost nothing per step (broad-phase only). Dynamic bodies and contacts cost.

## 6. WebGL limitations

None directly — physics is CPU/WASM. Browser-specific constraints:

- Single-threaded WASM (no SIMD threads without cross-origin isolation). Budget ≤ 2 ms per frame.
- WASM heap only grows; freeing objects returns memory to Rapier's allocator but the heap never shrinks.
- Tab throttling: `requestAnimationFrame` stops in background tabs → clamp dt and cap substeps.

## 7. R3F implementation

Physics is owned by `Game` (plain TS), not by React components. Components only register visuals:

```tsx
function PlayerVisual() {
  const ref = useRef<THREE.Group>(null!)
  const game = useGame()
  useLayoutEffect(() => game.player.setVisual(ref.current), [game])
  return <group ref={ref}>{/* first-person hands later */}</group>
}
```

Stepping happens in `GameLoop`'s fixed stage (called from `useFrame(..., -100)`), never inside components.
We do not use `@react-three/rapier`: it creates bodies per component and steps on its own schedule, which fights
chunk-based activation.

## 8. Direct implementation

### Init

```ts
import RAPIER from '@dimforge/rapier3d-compat'
await RAPIER.init()                                 // must resolve before any Rapier call
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
world.timestep = 1 / 60
```

### Fixed timestep accumulator

```ts
const STEP = 1 / 60, MAX_SUBSTEPS = 4
let acc = 0
export function stepPhysics(dt: number, fixedUpdate: (h: number) => void): number {
  acc += Math.min(dt, 0.1)
  let n = 0
  while (acc >= STEP && n < MAX_SUBSTEPS) {
    fixedUpdate(STEP)          // player controller, BMX forces
    world.step()
    acc -= STEP; n++
  }
  if (n === MAX_SUBSTEPS) acc = 0   // spiral-of-death guard
  return acc / STEP                 // alpha: interpolate render pose prev→current
}
```

Render transforms interpolate `prev` and `curr` poses with `alpha`, so movement is smooth at 144 Hz displays.

### Heightfield per chunk (verified layout, Rapier 0.21)

Verified by raycast test:

- `nrows` / `ncols` are **subdivision counts** (N), not sample counts; `heights.length === (N+1)²`.
- Index is **`ix * (N + 1) + iz`** (column-major: outer index walks +X, inner index walks +Z).
- The field is **centered** on the collider origin, spanning `[-scale.x/2, +scale.x/2]` × `[-scale.z/2, +scale.z/2]`.

Our generator stores heights row-major as `heights[iz * (N+1) + ix]`, so transpose:

```ts
const N = 64, SIZE = 64
function heightfieldFor(chunk: { cx: number; cz: number; heights: Float32Array }) {
  const hf = new Float32Array((N + 1) * (N + 1))
  for (let iz = 0; iz <= N; iz++)
    for (let ix = 0; ix <= N; ix++)
      hf[ix * (N + 1) + iz] = chunk.heights[iz * (N + 1) + ix]

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(chunk.cx * SIZE + SIZE / 2, 0, chunk.cz * SIZE + SIZE / 2),
  )
  world.createCollider(RAPIER.ColliderDesc.heightfield(N, N, hf, { x: SIZE, y: 1, z: SIZE }), body)
  return body
}
```

**Always verify after changing chunk constants**: cast a ray down at a few points and compare to
`sampleHeight(x, z)` from the generator (|Δ| < 0.05 m). `PhysicsDebug` (F6) should show the wireframe lying
exactly on the terrain mesh.

### Simplified colliders

```ts
// Tree trunk: cylinder only, no canopy. Only for trees in physics radius.
const half = 1.5, r = trunkRadius
world.createCollider(
  RAPIER.ColliderDesc.cylinder(half, r).setTranslation(x - bodyX, y + half, z - bodyZ),
  chunkBody,
)
```

| Object | Collider |
|---|---|
| Tree | cylinder trunk (h 3 m) |
| Rock ≥ 0.5 m | ball or cuboid; convex hull only for large boulders |
| Car wreck / prop | 1–3 cuboids |
| Cave | trimesh of *collision proxy* mesh (low-poly, separate from render mesh) |
| Monster | capsule (kinematic) |
| Player | capsule r 0.35, half-height 0.55 |

Never use render meshes as trimesh colliders for props.

### Activation radius

- Colliders exist for chunks with ring distance ≤ 1 (3×3 chunks, 192 m square).
- Co-op host: union of each player's 3×3 ring.
- Monster bodies exist only for AI-active monsters (ring ≤ 2); beyond that, monsters are data only.
- Streaming adds colliders **ahead** of the player: create when a chunk enters ring 1, remove when it leaves
  ring 2 (hysteresis).

### Player: KinematicCharacterController

```ts
const controller = world.createCharacterController(0.02)   // skin offset
controller.enableAutostep(0.4, 0.2, true)                  // step up 40 cm curbs/roots
controller.enableSnapToGround(0.3)
controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180)
controller.setMinSlopeSlideAngle((35 * Math.PI) / 180)

const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 20, 0))
const collider = world.createCollider(RAPIER.ColliderDesc.capsule(0.55, 0.35), body)

function movePlayer(desired: { x: number; y: number; z: number }) {
  controller.computeColliderMovement(collider, desired)
  const m = controller.computedMovement()
  const p = body.translation()
  body.setNextKinematicTranslation({ x: p.x + m.x, y: p.y + m.y, z: p.z + m.z })
  return controller.computedGrounded()
}
```

Vertical velocity (gravity/jump) is integrated by us; reset to 0 when grounded.

### BMX (planned)

- Dynamic rigid body (cuboid chassis), mass ~12 kg bike + rider ~70 kg as one body; lock roll with angular damping
  + upright torque (arcade feel, not a sim).
- 2 raycast "wheels": each fixed step, `castRay` down from wheel mount; spring force `k*(rest - dist) - c*vel`
  applied with `applyImpulseAtPoint`. Steering = yaw torque scaled by speed.
- CCD on (`setCcdEnabled(true)`) — BMX can reach 12+ m/s off slopes.

### Sleeping

Dynamic bodies sleep automatically when still. Don't call `setTranslation`/`wakeUp` on sleeping props each frame.
Kinematic bodies are always simulated — only create them for active characters.

### Collision groups

```ts
// 16-bit membership << 16 | 16-bit filter
const G = { TERRAIN: 1 << 0, STATIC: 1 << 1, PLAYER: 1 << 2, MONSTER: 1 << 3, BMX: 1 << 4, SENSOR: 1 << 5 }
const groups = (member: number, filter: number) => (member << 16) | filter
desc.setCollisionGroups(groups(G.PLAYER, G.TERRAIN | G.STATIC | G.MONSTER))
```

### Freeing WASM objects

- `world.removeRigidBody(body)` removes attached colliders.
- `world.removeCollider(c, true)` for colliders without a body.
- `world.removeCharacterController(controller)`.
- `world.free()` on shutdown; `Ray`s and query results are JS-side and cheap, but avoid allocating `new Ray` per
  frame — reuse one and mutate `ray.origin`/`ray.dir`.

### Debug render

```ts
const { vertices, colors } = world.debugRender()
lines.geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3))
lines.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4))
```

Only when debug is enabled; throttle to every 4th frame if heavy.

## 9. Common mistakes

1. Using `nrows = N + 1` → WASM `unreachable` crash (verified).
2. Forgetting the heightfield is centered → terrain collider offset by half a chunk.
3. Not transposing row-major heights → terrain collision mirrored along the diagonal.
4. Stepping with variable dt → jitter and non-determinism; always fixed step.
5. Colliders for every tree in every loaded chunk (50 chunks × 150 trees = 7 500 colliders for nothing).
6. Trimesh colliders from AI render meshes (100k tris) → slow queries, tunneling on thin tris.
7. Leaking bodies when chunks unload (heap grows forever) — track body per chunk key.
8. Reading `body.translation()` in hot loops: allocates a new object each call — read once per step.

## 10. Profiling / debugging

- HUD (`F3`): active bodies = `world.bodies.len()`, colliders = `world.colliders.len()`, step time (measured around
  `world.step()`).
- `F6`: collider wireframes. Check heightfield alignment at chunk borders and trunk placement.
- Heightfield test: sample 16 random points per chunk in dev, `castRay` vs generator height, warn if Δ > 0.05 m.
- Chrome Performance: Rapier shows as `wasm-function[…]` under `step` — should be < 1 ms.
- Watch collider count while walking in a straight line: must be bounded (~9 chunks' worth), not growing.
