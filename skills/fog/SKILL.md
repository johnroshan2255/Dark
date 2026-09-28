---
name: fog
description: Read before changing fog, view distance, sky colour or streaming radius, or adding volumetric-looking effects — fog is both the mood and the view-distance budget.
---

# Fog

## 1. Purpose

Fog is DARK's most important visual *and* performance tool:
- **Mood**: silhouettes of trees dissolving into grey/black is the horror look.
- **Budget**: if nothing is visible past ~150 m, nothing needs to be streamed, rendered, or LOD'd past it.
  Fog density → effective view distance → render radius → draw calls and memory.

## 2. Architecture

> **Implemented (current code) — supersedes the FogExp2 design below.** Players found exponential fog made
> everything near look blurry and dark; the references are crisp near and only misty far away. We now use
> `THREE.Fog` (three evaluates `smoothstep(near, far, depth)`): 0% fog up to `fogStart`, 100% at `fogEnd`.
> Per phase (TimeOfDay): DAY 70→260 m, EVENING 55→230, DAWN 50→220, DUSK 45→200, NIGHT 35→170, NIGHTMARE 28→150.
> `fog.far = min(fogEnd, fogLimit(renderRadius))` (ring edge − 4 m) and `fog.near = min(fogStart, 0.55 × far)`, so
> LOW (128 m ring) still hides its edge. Shafts/god rays use the SAME curve (`uFog` = near/far) for transmittance.
> Lesson: a clear near field exposes dark albedos and missing fill light — palette and hemisphere fill were raised
> together with this change (skills/lighting).

```
TimeOfDay keyframe (fogColor, fogDensity)             src/rendering/lighting/TimeOfDay.ts
   ▼
LightingSystem.apply()  → scene.fog (FogExp2) colour/density, scene.background = same colour
   ▼
All built-in materials apply fog in fragment (fog_fragment chunk)
Optional height fog patch (low-lying valley mist)      src/rendering/fog/HeightFog.ts (planned)
Camera far plane = where fog reaches ~99%              src/scene/Camera.tsx
Streaming render radius (4 chunks × 64 m = 256 m)      ARCHITECTURE.md §3
```

### Visibility per phase (FogExp2: `factor = 1 - exp(-(density·d)²)`)

| Phase | Density | 50% fogged at | 95% at | 99% at |
|---|---|---|---|---|
| DAY | 0.010 | 83 m | 173 m | 215 m |
| EVENING | 0.016 | 52 m | 108 m | 134 m |
| NIGHT | 0.030 | 28 m | 58 m | 72 m |
| NIGHTMARE | 0.040 | 21 m | 43 m | 54 m |

`d99 = sqrt(ln(100)) / density ≈ 2.146 / density`. DAY at 0.010 → 215 m, which fits inside the 256 m render
radius with LOD2 at the edge. **If you lower DAY density, you must raise the render radius** (and pay for it) or
chunks will visibly pop at the horizon.

Camera `far` = `d99(currentDensity) + 20 m`, clamped to the render radius. Pixels beyond far are skipped entirely
(and the depth range improves).

## 3. When to use

- Every outdoor scene. Fog colour == background colour == sky horizon colour, always.
- Height fog for valleys, road dips, the swamp/lake areas, and cave mouths.
- Fog cards (see §8) sparingly, near the road, for rolling-mist moments.

## 4. When NOT to use

- Caves: switch to near-black fog colour with high density instead of adding darkness lights; don't layer
  extra fog cards in tight spaces (overdraw close to camera is full-screen overdraw).
- Don't implement raymarched volumetric fog in the browser at full res (5–10 ms GPU). Fake it.
- Don't use linear `THREE.Fog` for the main look — its hard `far` boundary reads as a wall; use it only for
  special cases (e.g. a stylized nightmare wall).

## 5. Performance implications

| Technique | CPU | GPU | Memory |
|---|---|---|---|
| FogExp2 (built-in) | 0 (uniform upload) | ~4 ALU per fragment | 0 |
| Height fog patch | 0 | ~8 extra ALU + 1 varying per fragment | 0 (1 extra program variant per material type) |
| Fog cards (N camera-facing quads) | 1 instanced draw | overdraw: each layer shades its pixels; 10 large cards near camera can cost 1–2 ms | 1 small texture (128²) |
| Depth-faded sprites (soft particles) | same | + depth texture read per fragment | needs scene depth texture (RT depthTexture) |
| Raymarched volume | 0 | 3–10 ms | 3D noise texture |

The real win is indirect: density 0.03 at NIGHT lets the game safely drop to render radius 2 (LOD2 far ring
unused), saving ~40% draw calls. Streaming can read fog density to shrink its render radius at night — but keep
data/physics radii unchanged so the world stays consistent.

## 6. WebGL limitations

- Built-in fog is per-fragment distance from camera (`vFogDepth` = view-space depth), not radial distance and
  not height aware. Height requires a shader patch.
- `ShaderMaterial` does not get fog unless `fog: true` and you include `fog_pars_*` / `fog_fragment` chunks.
- Soft particles need a depth texture; our scene RT must be created with `depthTexture` to support them
  (adds ~8 MB at 1080p; only enable when used).
- Transparent fog cards don't write depth → sorting issues with other transparents.

## 7. R3F implementation

```tsx
// src/scene/Environment.tsx (shape)
export function Environment() {
  const game = useGame()
  const scene = useThree(s => s.scene)
  useLayoutEffect(() => {
    scene.fog = new THREE.FogExp2(0xa9b8bf, 0.01)
    scene.background = new THREE.Color(0xa9b8bf)
    game.lighting.attachFog(scene.fog as THREE.FogExp2, scene.background as THREE.Color)
    return () => { scene.fog = null; scene.background = null }
  }, [scene, game])
  return null
}
```

JSX form `<fogExp2 attach="fog" args={[color, density]} />` also works, but density is mutated every frame by the
lighting system, so we own the object imperatively and never re-render it.

## 8. Direct Three.js implementation

### Height fog via `onBeforeCompile`

Adds exponential ground mist that thickens below `uFogHeight`. Applied to library materials only
(`MaterialLibrary.ts`), sharing one uniform object so all materials update together.

```ts
// src/rendering/fog/HeightFog.ts (planned)
export const heightFogUniforms = {
  uFogHeight: { value: 4.0 },          // world Y where mist starts
  uFogHeightFalloff: { value: 0.25 },
  uFogHeightDensity: { value: 0.6 },   // 0 disables (keeps program identical)
}

export function applyHeightFog(material: THREE.Material) {
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, heightFogUniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vHFWorldY;')
      .replace('#include <fog_vertex>', `#include <fog_vertex>
        vec4 hfWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          hfWorld = instanceMatrix * hfWorld;
        #endif
        vHFWorldY = (modelMatrix * hfWorld).y;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vHFWorldY;
        uniform float uFogHeight, uFogHeightFalloff, uFogHeightDensity;`)
      .replace('#include <fog_fragment>', `
        #ifdef USE_FOG
          float distFog = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          float h = max(uFogHeight - vHFWorldY, 0.0);
          float heightFog = (1.0 - exp(-h * uFogHeightFalloff)) * uFogHeightDensity
                          * (1.0 - exp(-vFogDepth * 0.08));   // no mist on your own feet
          float f = clamp(max(distFog, heightFog), 0.0, 1.0);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, f);
        #endif`)
  }
  material.customProgramCacheKey = () => 'heightfog1'
}
```

This assumes `FogExp2` (the `fogDensity` uniform exists only with `FOG_EXP2`). Uniforms are shared objects, so
`heightFogUniforms.uFogHeightDensity.value = x` updates every patched material with no recompile.

Alternative: patch `THREE.ShaderChunk.fog_fragment` globally at startup (before any compile) — affects every
built-in material including GLB assets, no per-material hook. Prefer per-material when only terrain/vegetation
need it.

### Fog cards

Large soft quads placed by the generator in low areas near the road, rendered as one `InstancedMesh`:
`MeshBasicMaterial({ map: mistTex(128²), transparent: true, depthWrite: false, opacity: 0.25, fog: true })`,
billboarded around Y in the vertex shader, fade out when `vFogDepth < 6` (prevents full-screen overdraw when
the camera walks through). Budget: ≤ 30 visible cards, each ≤ 1/6 of the screen.

## 9. Common mistakes

- Fog colour ≠ background → bright/dark halo line at the horizon and floating silhouettes.
- Tuning fog without updating streaming radius → pop-in at the horizon (or wasted rendering behind a wall of fog).
- `transparent` fog planes intersecting the camera → full-screen 4–8× overdraw spikes.
- `ShaderMaterial` custom objects not fogged → glowing unfogged objects in the distance.
- Emissive materials: fog is applied after emissive, so distant lanterns fade correctly — don't set `fog:false`
  "to make them glow", use a small additive sprite instead.
- Changing `scene.fog` type (Fog ↔ FogExp2) at runtime → recompiles every material.

## 10. Profiling/debugging

- HUD shows current fog density and d99 distance next to render radius; warn if d99 > render radius × 64 m.
- Debug toggle: fog density 0 → reveals pop-in and the true extent of the loaded ring (great for testing
  streaming/culling).
- Overdraw check for fog cards: temporarily render cards with additive `0x101010` colour → bright areas = overdraw.
- Spector.js: confirm patched materials share a single program per material type (cache key working).
