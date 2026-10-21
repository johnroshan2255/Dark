---
name: postprocessing
description: Read before adding any fullscreen effect, render target, bloom/SSAO, or changing how the frame reaches the screen — DARK uses one combined grading pass.
---

# Post-processing

## 1. Purpose

Post-processing provides the stylized, filmic horror look: colour grading per phase, vignette, film grain,
nightmare distortion, tone mapping. In a browser every fullscreen pass costs bandwidth and fill, so DARK does
**all of it in one pass** over a single scene render target.

## 2. Architecture

> **Implemented (current code):**
> ```
> scene → HalfFloat RT (+ DepthTexture; MSAA only when AA = MSAA 2×/4×)
>       → Light-shaft pass (1/4, LOW 1/6 res), one RT: R = screen-space glare (12/20/32 samples, only when the
>         light is on screen), G = VOLUMETRIC shafts — march camera→depth sampling the sun/moon shadow map
>         (sampler2DShadow, 8/14/24 steps, range = shadow extent × 1.2, forward-scatter phase) → shafts through
>         trees from ANY view direction, day and night; B = depth code for the upsample
>       → grading pass upsamples rays with a 4-tap depth-aware (joint bilateral) filter (no blocky halos)
>       → Grading pass: [FXAA (9 fetches) + clamped sharpen (reuses FXAA's corner fetches)] or nightmare warp,
>         + rays × key-light colour, grade, tone map, sRGB, contrast, vignette, grain (settings: on/off)
> ```
> AA modes (settings, 'auto' = tier default): Off / FXAA / MSAA 2× / MSAA 4×. Tier defaults: LOW & MEDIUM FXAA,
> HIGH MSAA 4×. Sharpening counters bilinear-upscale softness when render scale < 1 (the "blurry" complaint).
> Verified by zoomed headless crops: no AA = stair-steps; FXAA+sharpen ≈ MSAA 4× edges at ~0.3 ms.
> **Decision vs pmndrs `postprocessing`:** we now have AA + god rays, the threshold §8 names; we still keep the
> custom pipeline because it is exactly 1 small + 1 fullscreen pass, runs the same on phones, and every cost is
> tier-controlled. Revisit if bloom + SSAO + DOF are all required.

```
useFrame(priority 1) in <Effects/>  (src/scene/Effects.tsx)   ← positive priority: R3F stops auto-rendering
  └─ PostPipeline.render()          (src/rendering/postprocessing/PostPipeline.ts)
       1. gl.info.reset()                       (autoReset=false; see skills/webgl)
       2. render scene → sceneRT
            WebGLRenderTarget(w·scale, h·scale, { type: HalfFloatType, samples: 4 })
            (shadow map pass happens inside this render call)
       3. render fullscreen triangle with GradingShader → screen (null target)
            reads sceneRT.texture
            grade: lift/gamma/gain, saturation, contrast, tint (from TimeOfDay)
            vignette, grain (animated), nightmare distortion + chromatic offset (uNightmare 0..1)
            #include <tonemapping_fragment>   → renderer.toneMapping (ACES) + exposure
            #include <colorspace_fragment>    → linear → sRGB
```

Why render to an RT at all: dynamic resolution (`renderScale`), MSAA control on the RT, HalfFloat headroom
so grading happens *before* tone mapping, and one place to add depth-based effects later.

Scene RT is linear HDR. Tone mapping happens **once**, in the grading pass. three only applies
`renderer.toneMapping` when rendering to the screen (or when the material requests it), so the scene pass
into the RT is left linear automatically.

## 3. When to use

- Mood per phase: tint/saturation/contrast/vignette keyed from `TimeOfDay` (see `skills/lighting`).
- Screen-space feedback: damage pulse, sanity/nightmare warping, flashlight flicker darkening.
- Anything that must affect the whole image uniformly.

## 4. When NOT to use

- Local effects (glowing eyes, lantern halo) → emissive + small additive sprite, not bloom.
- Depth/AO → baked vertex AO + fog (see `skills/shadows`), not SSAO.
- Don't add a second pass for a new effect until the combined shader is measured to be the bottleneck — add a
  uniform-controlled term to `GradingShader` instead.

## 5. Performance implications

At 1920×1080, DPR 1.5, renderScale 1.0 → 2880×1620 ≈ 4.67 M pixels.

| Item | CPU | GPU | Memory |
|---|---|---|---|
| Scene RT HalfFloat RGBA | — | writes 8 B/px | 4.67 M × 8 = 37 MB |
| MSAA ×4 renderbuffer + resolve | — | resolve blit ~0.2–0.4 ms | ~150 MB at DPR 1.5 (≈ 66 MB at 1080p DPR 1) |
| Grading pass (1 texture read, ~40 ALU) | 1 draw call | ~0.3–0.6 ms | — |
| Bloom (mip chain 5 levels, pmndrs) | ~10 draw calls | 1–2 ms | +~30% of scene RT |
| SSAO / N8AO (half res) | several passes | 2–6 ms | normal/depth RTs |
| pmndrs `postprocessing` baseline | EffectComposer overhead | merges effects into 1 pass | 1–2 RTs |
| three `EffectComposer` | each Pass = 1 fullscreen draw | N × 0.3 ms | ping-pong RTs |

MSAA memory is the surprise: if VRAM is tight (integrated GPUs), `samples: 2` or 0 with grain hiding aliasing.
The dynamic resolution scaler adjusts `renderScale` in steps of 0.1 between 0.6 and 1.0 based on GPU/frame time.

## 6. WebGL limitations

- Rendering into float RTs needs `EXT_color_buffer_float` / half float support — WebGL2 desktop has it; always
  check `renderer.extensions.has('EXT_color_buffer_float')` and fall back to `UnsignedByteType`.
- MSAA RTs (`samples > 0`) are renderbuffers resolved via blit; you can't sample depth from an MSAA target
  directly — a depth-reading effect needs a separate resolved depth texture.
- Float texture linear filtering (`OES_texture_float_linear`) isn't guaranteed; HalfFloat linear filtering is.
- `MAX_SAMPLES` varies (`renderer.capabilities.maxSamples`); clamp.

## 7. R3F implementation

```tsx
// src/scene/Effects.tsx (shape)
export function Effects() {
  const { gl, scene, camera, size } = useThree()
  const game = useGame()
  const pipeline = useMemo(() => new PostPipeline(gl), [gl])

  useEffect(() => { game.post = pipeline; return () => { pipeline.dispose(); game.post = null } }, [game, pipeline])
  useEffect(() => pipeline.setSize(size.width, size.height, gl.getPixelRatio()), [pipeline, size, gl])

  // priority 1 → R3F no longer calls gl.render itself; we own the frame
  useFrame(() => pipeline.render(scene, camera), 1)
  return null
}
```

`GameLoopDriver` uses priority `-100` so game systems run before the render. Any other component with a
positive priority also takes over rendering — keep exactly one (this one).

## 8. Direct Three.js implementation

```ts
// src/rendering/postprocessing/PostPipeline.ts (core)
export class PostPipeline {
  renderScale = 1
  readonly target: THREE.WebGLRenderTarget
  readonly grading = new THREE.ShaderMaterial(GradingShader)
  private quad: THREE.Mesh
  private orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  constructor(private gl: THREE.WebGLRenderer) {
    const hdr = gl.extensions.has('EXT_color_buffer_float') || gl.extensions.has('EXT_color_buffer_half_float')
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      samples: Math.min(4, gl.capabilities.maxSamples),
      depthBuffer: true, stencilBuffer: false,
    })
    // one oversized triangle covers the screen: no diagonal seam, 3 vertices
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2))
    this.quad = new THREE.Mesh(geo, this.grading)
    this.quad.frustumCulled = false
    this.grading.uniforms.tScene.value = this.target.texture
  }

  setSize(w: number, h: number, dpr: number) {
    this.target.setSize(Math.max(1, Math.floor(w * dpr * this.renderScale)),
                        Math.max(1, Math.floor(h * dpr * this.renderScale)))
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    const gl = this.gl
    gl.info.reset()
    gl.setRenderTarget(this.target)
    gl.render(scene, camera)
    gl.setRenderTarget(null)
    gl.render(this.quad, this.orthoCam)
  }

  dispose() { this.target.dispose(); this.grading.dispose(); this.quad.geometry.dispose() }
}
```

```ts
// src/rendering/postprocessing/GradingShader.ts (fragment core)
export const GradingShader = {
  uniforms: {
    tScene: { value: null as THREE.Texture | null },
    uTime: { value: 0 }, uTint: { value: new THREE.Vector3(1, 1, 1) },
    uSaturation: { value: 1 }, uContrast: { value: 1 }, uVignette: { value: 0.3 },
    uGrain: { value: 0.05 }, uNightmare: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tScene; uniform float uTime, uSaturation, uContrast, uVignette, uGrain, uNightmare;
    uniform vec3 uTint; varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      // nightmare: slow wobble + chromatic split, scaled by uNightmare (0 = identical to no effect)
      uv += uNightmare * 0.004 * vec2(sin(uv.y * 40.0 + uTime * 2.0), cos(uv.x * 35.0 + uTime * 1.7));
      vec2 ca = (uv - 0.5) * 0.006 * uNightmare;
      vec3 c = vec3(texture2D(tScene, uv + ca).r, texture2D(tScene, uv).g, texture2D(tScene, uv - ca).b);

      c *= uTint;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      c = (c - 0.18) * uContrast + 0.18;                       // pivot on mid grey, linear space
      float v = smoothstep(0.85, 0.25, length(vUv - 0.5) * (1.0 + uVignette));
      c *= mix(1.0, v, uVignette);
      c += (hash(vUv * 1000.0 + fract(uTime)) - 0.5) * uGrain * (0.3 + l);
      gl_FragColor = vec4(max(c, 0.0), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  depthTest: false, depthWrite: false,
}
```

`ShaderMaterial` gets tone mapping/colour space chunks from three's program prefix; `toneMapped` defaults to
`true`, so `renderer.toneMapping` and `toneMappingExposure` apply when drawing to the screen.

### When to adopt a library

- **pmndrs `postprocessing`**: adopt if we need ≥ 2 of bloom / SMAA / DOF / god rays. It merges compatible
  effects into one fullscreen shader, keeps HalfFloat buffers, and its bloom (mipmap blur) is the best-performing
  option available. Our grading would become a custom `Effect`.
- **three `EffectComposer`** (examples/jsm): every Pass is its own fullscreen draw + ping-pong RT. Fine for
  prototypes; avoid stacking > 2 passes.
- Bloom cost is the mip chain: downsample + upsample ~5 levels ≈ 10 draws, 1–2 ms. Use a high threshold so only
  emissives (eyes, lanterns, nightmare veins) bloom.
- SSAO in browser: 2–6 ms even at half res. Only consider in caves at LOW render radius, and prefer baked AO.

## 9. Common mistakes

- A second component with `useFrame(..., 1+)` → double rendering or fighting for the frame.
- Tone mapping twice (renderer toneMapping applied to the RT pass *and* in grading) — keep scene pass linear.
- Grading after tone mapping → clipped highlights, banding; grade in linear HDR before `tonemapping_fragment`.
- Forgetting `setSize` on resize/DPR change → blurry or stretched frame.
- `info.autoReset=true` with multipass → HUD shows only the fullscreen triangle's stats (1 call).
- `UnsignedByteType` scene RT with dark night scenes → visible banding in fog gradients (use HalfFloat; grain helps).
- Allocating RTs per frame or per effect toggle; allocate once, toggle via uniforms.

## 10. Profiling/debugging

- GPU timer (Chrome) around the grading draw vs scene draw (`src/debug/PerformanceMonitor.ts`).
- Toggle `renderScale` with `[` / `]` and watch GPU ms — fragment-bound scenes scale ~linearly with pixels.
- Debug uniform `uDebugView` (planned): 0 = final, 1 = raw scene (no grade), 2 = luminance — for tuning phases.
- Spector.js: expect exactly 2 framebuffer targets per frame (+ shadow map): sceneRT, then canvas.
- Check `renderer.capabilities.maxSamples` and `EXT_color_buffer_float` in the HUD's GPU info block.
