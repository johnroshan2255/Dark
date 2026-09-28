---
name: webgl
description: Read before adding anything that renders — explains draw calls, GPU/texture memory, overdraw, programs, render targets, MSAA, DPR and the frame budgets every feature must fit into.
---

# WebGL Performance

## 1. Purpose

Every visible feature costs CPU (JS traversal, uniform upload, draw submission), GPU (vertex + fragment work,
bandwidth) and memory (VRAM for buffers, textures, render targets). This skill gives the numbers and rules
for keeping DARK at a **stable 60 fps (16.6 ms) on a mid-range desktop GPU at 1080p** in WebGL2.
Stability beats peak fidelity: a 60 fps game with 2 ms spikes feels worse than a steady 60 fps game with less detail.

## 2. Architecture

Where cost is controlled in this codebase:

| Cost | Controlled by | File |
|---|---|---|
| Renderer flags, DPR clamp, `info.autoReset=false` | renderer config | `src/rendering/renderer/configureRenderer.ts` |
| Render resolution (dynamic scale), MSAA, extra passes | post pipeline | `src/rendering/postprocessing/PostPipeline.ts` |
| Material/program count | shared materials | `src/rendering/materials/MaterialLibrary.ts` |
| Draw calls | chunk culling + instancing | `src/optimization/culling/`, `src/optimization/instancing/` |
| Triangles | chunk LOD | `src/optimization/lod/` |
| Shadow cost | one directional map, LOD0 casters only | `src/rendering/shadows/` |
| Measurement | stats every frame | `src/debug/PerformanceMonitor.ts`, `src/debug/DebugHud.tsx` |

### Frame budget per quality tier (floor: ≥ 60 fps on every tier — see skills/mobile)

| Metric | LOW (₹15k phone, Intel UHD) | MEDIUM (iGPU, upper-mid phone) | HIGH (table below) |
|---|---|---|---|
| Frame time | ≤ 16.6 ms | ≤ 16.6 ms | ≤ 16.6 ms |
| Draw calls incl. shadow | ≤ 100 | ≤ 160 | ≤ 280 |
| Triangles (all passes) | ≤ 200 k | ≤ 420 k | ≤ 1.5 M |
| Pixels shaded (RT) | ≤ 0.6 MP | ≤ 1.5 MP | ≤ 4.7 MP |
| MSAA | 0 | 0 | 4 |
| Texture VRAM | ≤ 64 MB | ≤ 128 MB | ≤ 256 MB |
| Programs | ≤ 10 | ≤ 15 | ≤ 25 |

### HIGH-tier detail (GTX 1660 / RX 580 / M1 class, 1080p)

| Metric | Budget | Hard ceiling | Notes |
|---|---|---|---|
| Frame time | 16.6 ms | — | 60 fps |
| CPU JS per frame (game + render submit) | ≤ 6 ms | 9 ms | leaves room for GC + browser compositor |
| GPU per frame | ≤ 10 ms | 13 ms | measured with timer query where available |
| Draw calls (`info.render.calls`, incl. shadow pass) | ≤ 250 | 400 | shadow pass counts too |
| Triangles (main pass) | ≤ 1.5 M | 3 M | low-poly world; shadow pass adds ~30% |
| Programs (`info.programs.length`) | ≤ 25 | 40 | each = compile stall + VRAM |
| Texture VRAM | ≤ 256 MB | 512 MB | integrated GPUs share system RAM |
| Geometries (`info.memory.geometries`) | stable over time | — | growth ⇒ leak |
| Render targets | scene RT + shadow map | + 1 | each costs full-screen bandwidth |
| Fullscreen passes | 1 | 3 | at 1080p×1.5 DPR each ≈ 0.3–0.8 ms |

## 3. When to use

Read this before: adding a new object type, a new material, a texture, a render target, a post effect, a light,
changing shadow settings or DPR, or importing an AI-generated asset.

## 4. When NOT to use

- Not a substitute for measuring. Do not "optimize" something the profiler does not show as expensive
  (see `skills/profiling`).
- Do not trade away visual identity (fog, grading, silhouettes) to shave 0.2 ms when you are within budget.

## 5. Performance implications

### Draw calls (CPU-bound)
Each `Mesh` that passes culling = 1 draw call per material group, per pass (main + shadow). A draw call in
three.js costs ~5–20 µs of JS (uniform upload, state diffing, `drawElements`). 1000 calls ≈ 5–15 ms of CPU — the
whole budget. Fixes, in order: cull by chunk (fewer objects considered), instancing (1 call for N copies),
merging static geometry per chunk (`BufferGeometryUtils.mergeGeometries`), `BatchedMesh` for varied static props.

### CPU scene traversal
`renderer.render` walks the whole scene graph every frame: `updateMatrixWorld`, frustum test, sort. Cost is
~0.2–0.5 µs per Object3D even when invisible-but-attached. 20k Object3Ds ≈ 5 ms. Rules:
- Set `group.visible = false` on culled chunks — traversal stops at invisible parents.
- Static objects: `matrixAutoUpdate = false`, call `updateMatrix()` once.
- Never create one Object3D per tree/grass blade. Use `InstancedMesh`.

### Shader complexity (GPU)
Fragment cost × pixels shaded. `MeshStandardMaterial` ≈ 2–3× the ALU of `MeshLambertMaterial`; each extra
light adds a loop iteration per fragment; each shadow-casting light adds shadow map sampling (PCF = 4–16 taps).
Terrain and vegetation cover most pixels → they use Lambert (see `MaterialLibrary.ts`).

### Overdraw and transparency
Opaque objects are sorted front-to-back so early-Z rejects hidden fragments. Transparent objects are sorted
back-to-front, do not write depth, and every layer is shaded: 10 overlapping fog sprites = 10× fill cost for
those pixels. Rules:
- Foliage uses `alphaTest` (cutout, opaque queue), never `transparent: true`.
- Particle/fog cards: small on screen, few layers, low resolution texture, `depthWrite:false`.
- Full-screen transparent quads are post effects in disguise — put them in the grading pass.

### Texture memory
Uncompressed RGBA8: `w × h × 4 bytes × 1.33` (mip chain).

| Size | RGBA8 + mips | BC7 / ASTC 4×4 (1 B/px) | BC1 / ETC1S→BC1 (0.5 B/px) |
|---|---|---|---|
| 512² | 1.4 MB | 0.35 MB | 0.17 MB |
| 1024² | 5.6 MB | 1.4 MB | 0.7 MB |
| 2048² | 22.3 MB | 5.6 MB | 2.8 MB |
| 4096² | 89 MB | 22 MB | 11 MB |

PNG/JPEG size on disk is irrelevant — the GPU stores decoded RGBA. KTX2 (Basis Universal) stays compressed in
VRAM and uploads without a main-thread decode. Use ETC1S for albedo/props (smallest), UASTC for normal maps and
hero textures. Load with `KTX2Loader` (drei `useKTX2`). AI-generated assets usually ship 2048²–4096² PNGs:
downscale to ≤ 1024² (props) / 512² (small props) — see `skills/texture-optimization`.

### Material count and program compilation
Each unique combination of material type + defines (fog, shadows, instancing, vertex colors, map presence,
light counts…) compiles a GPU program: **20–200 ms stall** the first time it is rendered. Symptoms: hitch when
a new chunk type, the flashlight, or night lighting first appears. Rules:
- Share material instances (`MaterialLibrary`), do not clone per mesh.
- Keep light count constant (toggle `intensity`, not `visible`, see `skills/lighting`).
- Warm up at load: `await renderer.compileAsync(scene, camera)` with every material variant present once
  (uses `KHR_parallel_shader_compile` when available).

### Geometry count
Each `BufferGeometry` = VBO/IBO in VRAM plus a VAO. Share geometry between meshes and instances. Use
`Uint16` indices when < 65 536 vertices. Terrain LOD geometries are cached per chunk and disposed on unload.

### Shadow-map cost
A shadow-casting light re-renders every caster into a depth map: extra draw calls + vertex work, and PCF taps
on every receiving fragment. 2048² depth map = 16 MB (depth + RGBA packing on some paths). See `skills/shadows`.

### Post-processing and render targets
Each fullscreen pass at 1920×1080 = 2.07 M fragments; at DPR 1.5 = 4.67 M. A simple pass is ~0.3 ms, a blur
chain 1–2 ms, SSAO 3–8 ms. Every RT = `w × h × bytesPerPixel`: HalfFloat RGBA = 8 B/px → 1080p ≈ 16.6 MB, with
MSAA ×4 the multisample renderbuffer is ≈ 66 MB. See `skills/postprocessing`.

### MSAA
Canvas `antialias:true` only affects the default framebuffer, which we never render the scene into (we render to
an RT). So: canvas `antialias:false`, RT `samples: 4`. MSAA cost scales with samples × resolution; if GPU bound,
drop to `samples: 2` or 0 before lowering resolution.

### Resolution scaling and device pixel ratio
Fragment cost is proportional to pixels. DPR 2 = 4× the pixels of DPR 1. We clamp DPR to `[1, 1.5]` and then apply
a dynamic `renderScale` (0.5–1.0) to the scene RT only; the grading pass upsamples. A 0.75 render scale saves
~44% of fragment work with grain/fog hiding the softness.

## 6. WebGL limitations

- **No compute shaders**, no indirect draw, no mesh shaders, no bindless textures. GPU-driven culling is not
  available; culling is CPU-side and must be coarse (chunks).
- **Program compilation is synchronous** on the first draw unless `KHR_parallel_shader_compile` + `compileAsync`.
- `MAX_TEXTURE_IMAGE_UNITS` is 16 on many GPUs: lights with shadows + maps can exceed it.
- Uniform limits (`MAX_FRAGMENT_UNIFORM_VECTORS` ~1024) cap light count per material.
- Timer queries (`EXT_disjoint_timer_query_webgl2`) are missing in Firefox/Safari and coarse in Chrome.
- Context loss can happen (driver reset, tab backgrounded on some OS). Handle `webglcontextlost`.
- Integrated GPUs and ANGLE (Windows → D3D11) change the cost profile; test there.
- Float RT filtering (`OES_texture_float_linear`) is not guaranteed; HalfFloat is safe with
  `EXT_color_buffer_half_float` / `EXT_color_buffer_float`.

## 7. R3F implementation

```tsx
// src/app/Canvas.tsx (shape)
import { Canvas } from '@react-three/fiber'
import * as THREE from 'three'
import { configureRenderer } from '../rendering/renderer/configureRenderer'

<Canvas
  dpr={[1, 1.5]}                       // clamp DPR — never let a 3× laptop render 9× pixels
  gl={{ antialias: false, powerPreference: 'high-performance', stencil: false }}
  camera={{ fov: 70, near: 0.1, far: 400 }}
  onCreated={({ gl }) => configureRenderer(gl)}
>
  ...
</Canvas>
```

Rules for R3F:
- Anything changing per frame is mutated in `useFrame` via refs — never `setState` per frame.
- JSX `<mesh>` per repeated object is forbidden for vegetation/props → `InstancedMesh` built in `useMemo`.
- R3F auto-disposes geometry/material created in JSX on unmount. Shared library materials must be passed with
  `dispose={null}` on the owning element so unmounting a chunk does not destroy a shared material.
- Access raw objects any time: `const { gl, scene, camera } = useThree()`.

## 8. Direct Three.js implementation

```ts
// src/rendering/renderer/configureRenderer.ts (shape)
export function configureRenderer(gl: THREE.WebGLRenderer) {
  gl.info.autoReset = false            // we render several passes; reset once per frame in the loop
  gl.outputColorSpace = THREE.SRGBColorSpace
  gl.toneMapping = THREE.ACESFilmicToneMapping // applied in the grading pass when drawing to screen
  gl.shadowMap.enabled = true
  gl.shadowMap.type = THREE.PCFShadowMap
  gl.sortObjects = true                // needed for front-to-back opaque sort

  const caps = gl.capabilities
  console.info('[gpu]', {
    maxTextures: caps.maxTextures, maxTextureSize: caps.maxTextureSize,
    maxSamples: caps.maxSamples, precision: caps.precision,
  })
  gl.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); /* pause loop */ })
}

// warm up programs once the first chunks + lights exist
await gl.compileAsync(scene, camera)
```

Freeing memory — three.js does not GC GPU resources:

```ts
geometry.dispose(); material.dispose(); texture.dispose(); renderTarget.dispose()
instancedMesh.dispose() // frees instance attribute buffers
```

## 9. Common mistakes

- Using `transparent: true` for leaves → sorting cost + overdraw. Use `alphaTest: 0.5`.
- Letting DPR follow `window.devicePixelRatio` (3 on some laptops = 9× pixels).
- `antialias: true` on the canvas while rendering into an RT — pays cost, gets nothing.
- Cloning materials per mesh "to change a color" → program is shared but uniforms/state switches multiply;
  use vertex colors or `instanceColor`.
- Toggling `light.visible` or `castShadow` at runtime → recompiles every lit program.
- Loading 4K PNG textures from AI tools unmodified → 89 MB each.
- Forgetting `dispose()` on chunk unload → `info.memory.geometries` climbs forever.
- Reading `renderer.info` with `autoReset=true` after multiple `render()` calls → only last pass counted.
- `readPixels` / `getError` / sync queries in the frame loop → pipeline stall.
- Creating `new THREE.Vector3()` per object per frame → GC spikes; reuse module-level temporaries.

## 10. Profiling/debugging

- `F3` HUD (`src/debug/DebugHud.tsx`): calls, triangles, programs, geometries, textures, CPU/GPU ms, DPR, scale.
- CPU vs GPU bound test: drop render scale to 0.5 (`[`). If fps rises → fragment/GPU bound; if unchanged →
  CPU bound (draw calls, JS). Details in `skills/profiling`.
- Spector.js capture of one frame: lists every draw call, its program, state changes, textures.
- Chrome `about:gpu` for ANGLE backend and extension availability; `chrome://tracing` for GPU process.
- Watch `renderer.info.programs.length` while walking and cycling time of day — it must plateau after warmup.
