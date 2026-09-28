---
name: profiling
description: Read before optimizing anything or when fps drops — how to measure CPU vs GPU cost, read the F3 HUD, use DevTools/Spector.js, and detect memory leaks.
---

# Profiling

## 1. Purpose

"Do not optimize blindly." Every major feature must answer *how much does this cost on CPU, GPU and memory?*
with a measurement. This skill defines the in-game monitor, the external tools, and the procedure for finding
the actual bottleneck.

## 2. Architecture

```
src/debug/PerformanceMonitor.ts     collects metrics each frame into a plain mutable object (no React)
  beginFrame()  ← GameLoop start (performance.now)
  endFrame()    ← after PostPipeline.render() submitted
  gpu timer     ← EXT_disjoint_timer_query_webgl2 around the whole frame (when available)
  reads         renderer.info (autoReset=false → reset once per frame by PostPipeline)
                WorldManager (active/visible/culled chunks, visible instances)
                PhysicsWorld (bodies, colliders), Monsters (active), PostPipeline (renderScale), DPR
src/debug/DebugHud.tsx              DOM overlay; setInterval 250 ms writes textContent via refs (0 React renders/frame)
src/debug/CullingDebug.ts / ChunkDebug.ts / PhysicsDebug.ts   visual overlays (F4 / F6)
```

### Metrics shown on `F3`

| Metric | Source | Budget |
|---|---|---|
| FPS / frame ms (avg + max over 1 s) | rAF delta | 60 / 16.6, max < 25 |
| CPU ms | `performance.now()` from loop start to after last `gl.render` returns | ≤ 6 |
| GPU ms | timer query, 2–3 frames latency | ≤ 10 (or `n/a`) |
| draw calls | `info.render.calls` | ≤ 250 |
| triangles | `info.render.triangles` | ≤ 1.5 M |
| geometries / textures | `info.memory.*` | stable over time |
| programs | `info.programs.length` | ≤ 25, plateau |
| chunks: loaded / visible / culled | WorldManager | visible ~⅓ of loaded |
| visible instances | sum of `mesh.count` in visible chunks | — |
| physics bodies / colliders | Rapier `world.bodies.len()` / `colliders.len()` | colliders only near player |
| active monsters | AI system | ≤ 8 |
| DPR / render scale / RT size | renderer, PostPipeline | — |

CPU ms measures JS work + WebGL *command submission*, not GPU execution. GPU work runs asynchronously; a long
GPU frame appears as a long `requestAnimationFrame` gap, not as CPU ms.

## 3. When to use

- Before any optimization PR: record HUD numbers at the three test spots (see §10) before and after.
- When adding a feature: note its cost in the PR description (CPU ms, GPU ms, draw calls, MB).
- Whenever fps is below 60 or frame max > 25 ms.

## 4. When NOT to use

- Don't profile in dev mode with React StrictMode double-invocation for startup costs — use `npm run build &&
  npm run preview` for real numbers.
- Don't trust a single frame; use 1-second averages and max.
- Don't profile with DevTools open *docked* and the Performance panel recording for fps numbers — overhead is
  10–30%; use it for relative breakdowns only.

## 5. Performance implications

The monitor itself must be cheap:

| Part | CPU | GPU | Memory |
|---|---|---|---|
| Metric collection | ~0.02 ms/frame (field reads, no allocation) | — | fixed ring buffer (120 floats) |
| Timer query | ~0.01 ms | negligible | 3 query objects |
| HUD DOM write at 4 Hz | ~0.1 ms per write, 4×/s | compositor | — |
| Physics debug lines (F6) | 1–3 ms (`world.debugRender()` + buffer upload) | lines | buffers — **debug only** |
| Chunk bounds (F4) | ~0.1 ms | 1 draw per helper | small |

Never update React state from `useFrame` for the HUD — a React render per frame costs 0.5–2 ms and allocates.

## 6. WebGL limitations

- `EXT_disjoint_timer_query_webgl2`: available in Chrome/Edge desktop (precision reduced to ~0.1 ms, sometimes
  disabled by flags/drivers); **not exposed in Firefox and Safari**. Show `GPU n/a` and fall back to the
  resolution test.
- Results arrive 1–3 frames later; must poll `QUERY_RESULT_AVAILABLE`, never block.
- `GPU_DISJOINT_EXT` true → discard the sample (context switch, power state change).
- Only one `TIME_ELAPSED` query can be active at a time — no nesting. For per-pass timing, run sequential
  queries (scene, then grading).
- No GPU memory API; `renderer.info.memory` counts objects, not bytes. Estimate bytes from textures' dimensions.
- `performance.memory` (JS heap) is Chrome-only and coarse.

## 7. R3F implementation

```tsx
// src/debug/DebugHud.tsx (shape)
export function DebugHud({ monitor }: { monitor: PerformanceMonitor }) {
  const el = useRef<HTMLPreElement>(null)
  const [open, setOpen] = useState(true)           // React state only for toggling
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.code === 'F3') { e.preventDefault(); setOpen(o => !o) } }
    addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => { if (el.current) el.current.textContent = monitor.format() }, 250)
    return () => clearInterval(id)
  }, [open, monitor])
  return open ? <pre ref={el} className="debug-hud" /> : null
}
```

The HUD lives in the DOM (outside `<Canvas>`), so it costs nothing on the WebGL side. drei's `<Stats>` /
`<StatsGl>` are acceptable for quick checks but don't know about chunks/physics — the project HUD is canonical.

## 8. Direct Three.js implementation

```ts
// src/debug/PerformanceMonitor.ts (GPU timer core)
export class GpuTimer {
  private ext: any
  private pool: WebGLQuery[] = []
  private pending: WebGLQuery[] = []
  lastMs = NaN

  constructor(private gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
  }
  get available() { return !!this.ext }

  begin() {
    if (!this.ext || this.pending.length > 3) return false    // don't pile up
    const q = this.pool.pop() ?? this.gl.createQuery()!
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q)
    this.pending.push(q)
    return true
  }
  end() { if (this.ext) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT) }

  poll() {
    if (!this.ext) return
    const gl = this.gl
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT)
    while (this.pending.length) {
      const q = this.pending[0]
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number
      if (!disjoint) this.lastMs = ns / 1e6
      this.pool.push(this.pending.shift()!)
    }
  }
}
```

Usage per frame: `poll()` at frame start, `begin()` before the scene render, `end()` after the grading pass.
Get the raw context with `renderer.getContext() as WebGL2RenderingContext`.

Reading renderer stats (`info.autoReset = false`, reset in `PostPipeline.render()` before the scene pass):

```ts
const i = renderer.info
stats.calls = i.render.calls; stats.triangles = i.render.triangles
stats.geometries = i.memory.geometries; stats.textures = i.memory.textures
stats.programs = i.programs?.length ?? 0
```

Texture VRAM estimate (debug only, on demand — not per frame):

```ts
let bytes = 0
scene.traverse(o => { /* collect unique textures from materials */ })
for (const t of unique) { const { width: w = 0, height: h = 0 } = t.image ?? {}; bytes += w * h * 4 * (t.generateMipmaps ? 1.33 : 1) }
```

(KTX2 compressed textures: use `0.5–1 B/px` instead of 4.)

## 9. Common mistakes

- Optimizing draw calls when GPU-bound (or shaders when CPU-bound). Always run the resolution test first.
- Reading `renderer.info` with `autoReset = true` → only the last pass (the grading triangle, 1 call).
- Measuring in dev build (unminified, React dev checks, Vite HMR) and concluding production numbers.
- Blocking on `QUERY_RESULT` or `gl.finish()` / `readPixels` to "measure GPU" → stalls the pipeline, distorts numbers.
- Averaging fps — hides spikes. Track frame-time max and a 1% low.
- Forgetting vsync: 60 Hz display caps at 60; test headroom on a 120/144 Hz display or read CPU/GPU ms directly.
- Leaving physics debug render on while measuring (1–3 ms by itself).

## 10. Profiling/debugging

### Procedure: is it CPU or GPU bound?

1. Open HUD (`F3`), stand at a test spot, wait 3 s for averages.
2. Press `[` until render scale = 0.5 (pixels ÷ 4).
   - fps rises a lot → **GPU fill bound**: shaders, overdraw, shadow PCF, MSAA, post. Try `samples` 4→0, disable
     shadow receive, fog cards off.
   - fps unchanged → **CPU bound** (or vertex bound): check CPU ms, draw calls, JS profile.
3. If CPU ms high: Chrome DevTools → Performance → record 5 s → Bottom-Up by self time. Typical suspects:
   `WebGLRenderer.render` (too many objects/draws), `projectObject` (scene traversal), `updateMatrixWorld`,
   generation/meshing on main thread (should be in worker), Rapier `step`, GC (Minor GC spikes → allocations).
4. If draw calls high: Spector.js capture (browser extension) → group draws by program/mesh; find non-instanced
   repeats and objects in culled chunks still drawing.
5. If spikes: Performance panel → look for long tasks at chunk load (meshing, collider creation, program compile).

### Test spots (fixed seed `DARK-DEV`)
- Dense forest at DAY (max vegetation + shadow casters).
- Road straight at EVENING looking along the road (max view distance).
- NIGHT with flashlight in forest (light + fog worst case).

### Memory leak check
Walk in a straight line for 2 minutes (streaming churn), then return. `info.memory.geometries` and `.textures`
must return to the same plateau; Rapier collider count must return to the near-ring count. Monotonic growth =
missing `dispose()` or collider removal. Chrome Memory tab → heap snapshot diff for JS-side leaks (retained
`ChunkData` typed arrays).

### Other tools
- `about:gpu` / `chrome://gpu` — ANGLE backend, GPU, extension availability, driver bug workarounds.
- `chrome://tracing` (or Perfetto) with `gpu` category — actual GPU process timing when timer queries are missing.
- Firefox Profiler with "Graphics" preset; Safari Web Inspector → Timelines → Canvas for WebGL call counts.
- `renderer.info.programs` listing to find unexpected program variants (see `skills/shaders`).
