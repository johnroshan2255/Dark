---
name: react-three-fiber
description: Read before writing any R3F component, useFrame callback, or deciding whether something belongs in React or in the imperative hot path.
---

# React Three Fiber (R3F v9) in DARK

## 1. Purpose

R3F is our **composition and lifecycle layer**. It decides *what exists* in the scene (a chunk, a light, the
post pipeline) and cleans it up when it stops existing. It is **not** where per-frame game logic lives.

Rule of thumb:

| Belongs in React | Belongs in plain TS / Three.js |
|---|---|
| Which chunks are mounted | Player position, velocity |
| Chunk LOD level (changes a few times per second at most) | Instance matrices |
| UI mode (menu / playing / paused) | Camera pose |
| Time-of-day *phase* (for UI) | Time-of-day *interpolation* (sun angle, fog colour) |
| Debug overlay on/off | Monster movement, physics sync |

If a value changes every frame, putting it in React state costs a reconcile of the subtree every frame. At
60 fps that is 60 reconciles per second of work that produces zero new objects.

## 2. Architecture

```
<GameCanvas>                      src/app/Canvas.tsx  (renderer config, dpr clamp)
 └─ <GameProvider game>           one Game instance in context — created once, never re-created
     ├─ <GameLoopDriver>          useFrame(cb, -100)  → game.loop.tick(dt)   (runs first)
     ├─ <CameraRig/> <Lighting/> <Environment/>   mount objects, register them with systems
     ├─ <World>                   subscribes to chunk-set version, renders <WorldChunk> list
     └─ <Effects>                 useFrame(cb, 1)     → PostPipeline.render()  (takes over rendering)
```

Components *mount* Three objects and hand refs to systems (`game.lighting.registerSun(ref.current)`). Systems
mutate those objects directly each frame.

### useFrame priorities

- All callbacks are sorted by priority ascending; lower runs first.
- **Negative priorities** run before default (0) callbacks — use for simulation (`-100` for the game loop).
- **Any callback with priority > 0 disables R3F's automatic `gl.render(scene, camera)`**. Whoever registers it
  is now responsible for rendering. We have exactly one: `<Effects>` at priority `1`.
- Never register a second positive-priority callback "just for ordering" — you will get either double rendering
  (if both render) or confusion about who renders.

## 3. When to use

- Mount/unmount of anything with a GPU lifetime (geometry, material, textures, render targets).
- Composition of systems that the designer needs to toggle (`{debug && <ChunkDebug/>}`).
- Loading assets with Suspense (`useGLTF`, `useTexture`, `useLoader`).
- Low-frequency derived UI (HUD phase label, inventory).

## 4. When NOT to use

- Per-frame transforms (`<mesh position={pos}>` with `pos` from state) — mutate `ref.current.position` instead.
- Thousands of JSX children (`trees.map(t => <mesh/>)`) — one `InstancedMesh` per chunk per species.
- Drei `<Instances>/<Instance>` in hot paths: each `<Instance>` is a React component + an Object3D whose matrix
  is copied per frame. Fine for 50 items in a menu scene, wrong for 20 000 trees. Use raw `InstancedMesh`.
- Drei `<Html>` per object (DOM node per monster/nameplate, `getBoundingClientRect`/transform each frame). Use one
  overlay canvas or sprites.
- Heavy Drei helpers in the shipping scene: `<ContactShadows>` (extra render of the scene per frame),
  `<MeshReflectorMaterial>`, `<Sky>` with per-frame uniform churn, `<Stats>` (use our PerformanceMonitor).

## 5. Performance implications

| Thing | CPU | GPU | Memory |
|---|---|---|---|
| React reconcile of `<World>` with ~80 `<WorldChunk>` children | ~0.2–0.5 ms per re-render | 0 | small |
| setState every frame in a component with 10 children | 0.1–1 ms/frame + GC churn | 0 | garbage per frame |
| `useFrame` callback count | ~negligible each, but each closure runs every frame | 0 | — |
| JSX `<mesh>` per object | Object3D + fiber node (~2–4 KB) each, traversal cost each frame | 1 draw call each | yes |

Budget: React work on a normal gameplay frame should be **0 ms**. React should only run when chunks load/unload.

## 6. WebGL limitations

R3F adds nothing to WebGL itself — every limit in `skills/webgl` still applies. Things R3F *hides* that you must
still think about:

- Every `<mesh>` is a draw call unless you instance/batch.
- Shader programs compile on first render (can hitch 20–200 ms). Pre-warm with `gl.compile(scene, camera)` after
  loading a chunk type the first time.
- Context loss: R3F does not restore your custom render targets; `PostPipeline` must recreate on `webglcontextrestored`.

## 7. R3F implementation

### Canvas configuration

```tsx
import { Canvas } from '@react-three/fiber'
import * as THREE from 'three'

<Canvas
  dpr={[1, 1.5]}                      // clamp; 2× on a 4K display is 4× the pixels
  frameloop="always"                  // game: always. Menus/editors: "demand" + invalidate()
  gl={{ antialias: false, powerPreference: 'high-performance', stencil: false }}
  camera={{ fov: 70, near: 0.1, far: 400 }}
  shadows                             // enables gl.shadowMap; type configured in configureRenderer
  onCreated={({ gl }) => configureRenderer(gl)}
>
```

`frameloop` modes: `"always"` (game), `"demand"` (render only after `invalidate()` — editors, menus),
`"never"` (drive with `advance(timestamp)` yourself — useful for deterministic tests/recording).

### The game loop driver

```tsx
function GameLoopDriver() {
  const game = useGame()
  useFrame((_state, dt) => game.loop.tick(Math.min(dt, 0.1)), -100)
  return null
}
```

### Rendering ownership

```tsx
function Effects() {
  const game = useGame()
  useFrame(({ gl, scene, camera }) => game.post.render(gl, scene, camera), 1) // priority > 0 → we render
  return null
}
```

### Refs instead of state

```tsx
function Flashlight() {
  const light = useRef<THREE.SpotLight>(null!)
  const game = useGame()
  useLayoutEffect(() => game.flashlight.attach(light.current), [game])
  return <spotLight ref={light} angle={0.45} penumbra={0.6} distance={35} decay={2} />
}
```

### External store for low-frequency state

```ts
// src/game/GameState.ts (shape)
type Listener = () => void
export function createStore<T>(initial: T) {
  let state = initial
  const listeners = new Set<Listener>()
  return {
    get: () => state,
    set: (patch: Partial<T>) => { state = { ...state, ...patch }; listeners.forEach(l => l()) },
    subscribe: (l: Listener) => { listeners.add(l); return () => listeners.delete(l) },
  }
}

// component
const phase = useSyncExternalStore(store.subscribe, () => store.get().phase)
```

Select a **primitive or a stable reference** in the snapshot getter; returning a new object each call causes an
infinite render loop.

### useThree selectors

```ts
const gl = useThree(s => s.gl)          // re-renders only if gl changes (never)
const size = useThree(s => s.size)      // re-renders on resize — fine
// BAD: const state = useThree()  → re-renders on every store change
```

For non-reactive access inside callbacks, select the store getter: `const get = useThree(s => s.get)`, then
call `get()` when you need current state.

### Raw access (always allowed)

```ts
const get = useThree(s => s.get)
const { gl, scene, camera } = get()      // or the useFrame state argument
gl.info, gl.capabilities, gl.getContext(), gl.shadowMap, scene.traverse(...)
```

### Disposal

- R3F calls `.dispose()` on objects/geometries/materials it created from JSX when they unmount.
- **Shared resources** (MaterialLibrary materials, shared tree geometry) must not be disposed by a chunk unmount:
  pass them as props with `dispose={null}` on the owning element, or attach via `<primitive object={x} dispose={null}/>`.

```tsx
<instancedMesh args={[lib.treeGeometry, lib.foliage, count]} dispose={null} />
```

- Resources created in `useMemo` are **not** tracked — dispose in effect cleanup:

```tsx
const geo = useMemo(() => buildTerrainGeometry(data, lod), [data, lod])
useEffect(() => () => geo.dispose(), [geo])
```

### Drei — where it earns its place

```tsx
import { useGLTF, useTexture } from '@react-three/drei'
// Draco/meshopt/KTX2 wiring in one place:
useGLTF.setDecoderPath?.('/draco/')     // only if we ship draco assets (we prefer meshopt)
const gltf = useGLTF('/models/trees/pine.lod0.glb', false, true) // (path, draco, meshopt)
useGLTF.preload('/models/trees/pine.lod0.glb')
```

KTX2 with drei's GLTF loader extension hook:

```ts
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
const ktx2 = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(gl)
useGLTF(url, false, true, loader => loader.setKTX2Loader(ktx2))
```

Create **one** KTX2Loader per renderer; each owns a worker pool.

## 8. Direct Three.js implementation

When a system has many objects or high churn, build it imperatively and mount a single root:

```tsx
function MonsterLayer() {
  const game = useGame()
  const root = useMemo(() => new THREE.Group(), [])
  useLayoutEffect(() => { game.monsters.setRoot(root); return () => game.monsters.setRoot(null) }, [game, root])
  return <primitive object={root} dispose={null} />
}
```

`game.monsters` adds/removes children, pools meshes, and disposes explicitly. React sees one object.

## 9. Common mistakes

1. `useState` for position/rotation updated in `useFrame`.
2. Creating `new THREE.Vector3()` inside `useFrame` (GC pressure) — hoist scratch objects to module scope.
3. Two positive-priority `useFrame`s → double render or black screen.
4. Unstable `args` arrays (`args={[new BoxGeometry()]}` inline) → object recreated every render.
5. Forgetting `dispose={null}` on shared materials → next chunk renders with a disposed (recompiled) material.
6. `useThree()` without selector → component re-renders on every resize/pointer event.
7. Passing new object literals to memoized chunks → every chunk re-renders on every World update.
8. Suspense boundaries too high: one slow GLB blanks the whole world. Put boundaries per feature.
9. Using R3F pointer events (`onClick` on meshes) on large scenes — raycasts all event-bound objects each pointer
   move. Use our own interaction raycast against a small candidate list.

## 10. Profiling / debugging

- React DevTools Profiler → "Highlight updates": during normal walking, **nothing** should flash.
- Count renders: `console.count('WorldChunk render ' + key)` temporarily; expect it only on load/LOD change.
- Chrome Performance panel: look for `performWorkUntilDeadline`/`commitRoot` in gameplay frames — should be absent.
- `gl.info.render.calls/triangles` via our HUD (`F3`); with `info.autoReset=false` it counts all passes.
- Verify ownership: temporarily log in `<Effects>` render; if the scene draws while `<Effects>` is unmounted, some
  other positive-priority callback or default render is active.
