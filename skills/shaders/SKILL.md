---
name: shaders
description: Read before writing or patching any GLSL — choosing onBeforeCompile vs ShaderMaterial vs RawShaderMaterial, sharing uniforms, vegetation wind, and keeping the program count low.
---

# Shaders

## 1. Purpose

Custom shaders give DARK its stylized look (wind in trees, height fog, nightmare distortion, grading) without
adding geometry. They are also the fastest way to create hitches (program compiles) and GPU cost (per-fragment
ALU). This skill defines how to write them so they stay cheap, cached and consistent with three.js lighting/fog.

## 2. Architecture

```
src/rendering/shaders/
  chunks/        reusable GLSL strings (noise, wind, dither)
  patches/       onBeforeCompile patchers for built-in materials (wind, heightFog, dissolve)
  uniforms.ts    SHARED uniform objects: uTime, uWind, uNightmare, height-fog params
src/rendering/materials/MaterialLibrary.ts   creates every material once, applies patches, sets cache keys
src/rendering/postprocessing/GradingShader.ts  the one fullscreen ShaderMaterial
```

Decision table:

| Need | Use | Why |
|---|---|---|
| Built-in lighting/fog/shadows + small tweak (wind, height fog, dissolve) | `onBeforeCompile` patch on Lambert/Standard | keeps all three.js features, lights, shadows, fog, instancing |
| Unlit / fullscreen / special (grading, sky, fog cards) | `ShaderMaterial` | gets three's prefix (matrices, `#include` works, tonemapping/colorspace chunks) |
| Absolute control, no injected prefix | `RawShaderMaterial` | rarely: you must declare everything incl. precision and attributes |

## 3. When to use

- Per-vertex animation of many instances (wind sway, breathing monster flesh) — GPU does it, CPU cost 0.
- Effects that would otherwise need extra geometry or passes (height fog, dither fade for LOD transitions).
- The single post pass.

## 4. When NOT to use

- Don't write a custom lit shader from scratch — you'll lose shadows, fog, light count handling, and break
  when three updates. Patch instead.
- Don't use a shader for something done once per chunk on CPU (e.g. colour variation → bake into
  vertex colours / `instanceColor`).
- Don't add a unique shader per asset. Asset variety comes from textures/vertex colours on shared programs.

## 5. Performance implications

| Item | CPU | GPU | Memory |
|---|---|---|---|
| New program | 20–200 ms compile stall on first use (link + driver) | — | driver program cache |
| Uniform update (shared object) | ~0 (uploaded once per program per frame) | — | — |
| Per-material uniform objects | upload per material switch | — | — |
| Vertex wind (instanced) | 0 | ~15–25 ALU/vertex; trivial at our tri counts | — |
| Fragment noise (3D simplex) | 0 | ~50+ ALU/fragment — expensive over full screen | — |
| Texture lookup | 0 | bandwidth + latency; dependent reads worst | texture VRAM |
| `discard` / alphaTest | 0 | disables early-Z for that draw on some GPUs | — |

Rule of thumb at 1080p×1.5 DPR (~4.7 M fragments): every 10 ALU added to a shader covering the whole screen ≈
0.1–0.2 ms on mid-range GPUs. Vertex work is cheap in a low-poly world; **fragment work is the budget.**

## 6. WebGL limitations

- GLSL ES 3.00 (WebGL2). three injects `#version 300 es` and compat macros (`texture2D` → `texture`,
  `gl_FragColor` → `pc_fragColor`) for non-raw materials.
- Precision: three defaults to `highp` if supported (`renderer.capabilities.precision`). Some mobile GPUs
  support only `mediump` in fragments — not a desktop target, but don't assume `highp` on integer tricks.
- No compute, no storage buffers, no geometry shaders.
- Dynamic loops with non-constant bounds are allowed in WebGL2 but can unroll poorly; keep loop counts constant.
- Branching: GPUs execute both sides when fragments in a warp diverge. Uniform-based branches (same value for
  all fragments) are cheap; per-fragment branches on noise are not. Prefer `mix`/`step`.
- Every `#define` combination is a separate program. Defines are compile-time; uniforms are runtime.

## 7. R3F implementation

Materials are created in `MaterialLibrary` (plain TS) and passed into JSX — never created inline in JSX for
shared use:

```tsx
const mats = useGame().materials
<instancedMesh args={[geo, mats.foliage, count]} dispose={null} />   // dispose={null}: shared, don't free on unmount
```

Driving time uniforms from the game loop (one write updates every material):

```ts
// src/rendering/shaders/uniforms.ts
export const globalUniforms = {
  uTime: { value: 0 },
  uWind: { value: new THREE.Vector3(1, 0, 0.3) },   // xz dir * strength
  uNightmare: { value: 0 },                         // 0..1 blend
}
// LightingSystem / GameLoop:
globalUniforms.uTime.value += dt
```

If you really need a local shader in JSX, use `<shaderMaterial args={[{ uniforms, vertexShader, fragmentShader }]} />`
with `uniforms` from `useMemo` — never a new object literal each render (would recreate the material).

## 8. Direct Three.js implementation

### Wind sway for instanced vegetation (patch on Lambert)

```ts
// planned: src/rendering/shaders/patches/wind.ts — the grass version of this patch lives in src/world/Forest/grass.ts
import { globalUniforms } from '../uniforms'

export function applyWind(material: THREE.MeshLambertMaterial, strength = 1) {
  material.onBeforeCompile = shader => {
    shader.uniforms.uTime = globalUniforms.uTime          // share the SAME object
    shader.uniforms.uWind = globalUniforms.uWind
    shader.uniforms.uWindStrength = { value: strength }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform vec3 uWind; uniform float uWindStrength;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // per-instance phase from instance translation (no extra attribute)
        #ifdef USE_INSTANCING
          vec3 iPos = instanceMatrix[3].xyz;
        #else
          vec3 iPos = vec3(0.0);
        #endif
        float phase = dot(iPos.xz, vec2(0.13, 0.17));
        float bend = max(position.y, 0.0);                 // pivot at base, tip moves most
        bend *= bend * 0.08 * uWindStrength;
        float sway = sin(uTime * 1.3 + phase) + 0.35 * sin(uTime * 3.1 + phase * 1.7);
        transformed.xz += uWind.xz * sway * bend;`)
  }
  material.customProgramCacheKey = () => `wind`
}
```

Note: `transformed` is in object (pre-instance) space; sway direction rotates with instance rotation. For
exact world-space wind, transform `uWind` by the inverse instance rotation or accept it (usually unnoticeable
with random rotations). Shadows: the depth pass uses a *different* material; for swaying shadows assign
`mesh.customDepthMaterial` with the same patch — or accept static shadows at our shadow resolution (default).

### `customProgramCacheKey`

three caches programs by material type + parameters + `onBeforeCompile.toString()`. Closures with different
captured values but identical source produce the **same** key → wrong shader reused. Always set a key that
encodes everything that changes the generated GLSL:

```ts
material.customProgramCacheKey = () => `wind:${hasTipColor ? 1 : 0}`
```

and keep the number of distinct keys tiny.

### Avoiding program explosion

Programs multiply by: material type × defines (map, vertexColors, alphaTest>0, fog, instancing, shadows
receive/cast, light counts, skinning, morph, flatShading, `side`) × patch key. Checklist:
- Same material instance for all trees of a species type (instanced).
- `alphaTest` set on the material at creation; don't toggle between 0 and >0 at runtime.
- `vertexColors` either always on for a material family or never.
- Shared GLB materials remapped to library materials in the loader (see `skills/asset-optimization`).
- Warm up with `renderer.compileAsync(scene, camera)` after the first chunks load.

Target: ≤ 25 programs total (`renderer.info.programs.length`).

### Dither fade (LOD transitions without transparency)

```glsl
// fragment, before output; uFade 0..1 per instanced mesh or per instance attribute
float d = fract(dot(gl_FragCoord.xy, vec2(0.0671, 0.00584)) * 52.98);   // interleaved gradient noise
if (d > uFade) discard;
```

Cheap cross-fade between LODs that stays in the opaque queue; grain in the post pass hides the pattern.

## 9. Common mistakes

- `shader.uniforms.uTime = { value: 0 }` inside `onBeforeCompile` → each material has its own copy that
  nothing updates. Assign the shared object.
- Relying on `onBeforeCompile.toString()` for caching with closures → wrong shader reused across variants.
- Replacing a chunk that doesn't exist in that material (e.g. `#include <fog_vertex>` when the string changed
  between three versions) → silent no-op. Assert: `if (!src.includes(token)) throw`.
- Using per-fragment `if` on noise → divergence; use `step/mix`.
- Heavy noise in fragment shaders for large surfaces (terrain) → bake to texture or vertex colour.
- Forgetting `#include <tonemapping_fragment>` / `<colorspace_fragment>` in a ShaderMaterial that renders to
  screen → washed out or too dark vs the rest.
- Mutating `material.defines` at runtime without `material.needsUpdate = true` (and a compile hitch when you do).

## 10. Profiling/debugging

- `renderer.debug.checkShaderErrors = true` (default) in dev; set `false` in production to save link-time checks.
- `renderer.info.programs` — list includes cache keys; log `.map(p => p.name + ' ' + p.cacheKey.slice(0, 60))`
  to find duplicate variants.
- Spector.js → program tab shows final GLSL source (verify patches applied).
- Fragment cost test: temporarily make the patch output a constant colour and compare GPU ms.
- Compile hitches appear in Chrome Performance panel as long `drawElements`/`useProgram` tasks on first use.
