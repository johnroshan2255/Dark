---
name: lighting
description: Read before adding or changing any light, time-of-day phase, the flashlight, or emissive "light" props — covers DAY→EVENING→NIGHT→NIGHTMARE blending and the fixed light-slot pool.
---

# Lighting

## 1. Purpose

Lighting sells the horror: bright hazy day, orange evening, near-black night carved by the flashlight, and a
red-shifted nightmare realm. It must do this with a **constant, small set of real lights**, because every
additional light is per-fragment work on every lit pixel and changing the light count recompiles shaders.

## 2. Architecture

> **Implemented (current code):** time is continuous — `TimeOfDay.hours` ∈ [0, 24) advances by
> `dayLengthMinutes` (settings: paused / 6 / 24 / 60 min). The sun follows a LOW tilted arc (`sunDirection(h)`:
> rises behind the spawn view (−Z) at 06:00, only ~32° up (west) at noon so it is actually seen and shadows are long,
> sets DOWN THE ROAD (+Z) at 18:00 — the hero-shot composition); the moon is opposite. Sky has a drifting cloud
> layer lit by the key light. Params blend between hour
> keyframes NIGHT 0–4.8 → DAWN 6.2 → DAY 8.2–16.2 → EVENING 17.7 → DUSK 18.9 → NIGHT 20.3; NIGHTMARE is a separate
> 0..1 realm weight on top. ONE directional light is handed over sun ⇄ moon at the horizon where both intensities are
> ~0 (no light-count change). Day/night buttons call `goTo()` which fast-forwards (the sun visibly travels, never
> backwards). Sky: `src/rendering/sky/SkyDome.ts` (gradient with horizon == fog colour, sun disc/glow, moon, stars).
> God rays: `skills/postprocessing`. Fill (hemisphere) is deliberately high on every phase (DAY 1.35, EVENING 1.7,
> NIGHT 1.5 blue) and albedos are ≥ sRGB 0x30 — the references stay readable in shadow and at night. Tests: `tests/time.test.ts`. The phase-table design below is the original plan.

```
TimeOfDay (src/rendering/lighting/TimeOfDay.ts)          pure data: keyframes + blend(t) → LightingState
   │  phase: DAY → EVENING → NIGHT → NIGHTMARE (+ cycle back)
   ▼
LightingSystem (src/rendering/lighting/LightingSystem.ts) game-loop system "lighting"
   │  writes to: sun (DirectionalLight), hemi (HemisphereLight), ambient,
   │             scene.fog, scene.background, renderer exposure, grading uniforms
   │  moves sun + shadow camera with player (see skills/shadows)
   │  assigns LocalLightPool slots to nearest emitters
   ▼
<Lighting /> (src/scene/Lighting.tsx)                      creates the light objects once, registers them
<Environment /> (src/scene/Environment.tsx)                background colour + fog object
Flashlight (src/gameplay/flashlight/)                      SpotLight attached to camera
```

### Fixed light budget

| Light | Count | Shadow | Notes |
|---|---|---|---|
| DirectionalLight (sun / moon) | 1 | yes, 2048² | same object; colour/intensity/direction change |
| HemisphereLight | 1 | — | sky/ground fill, cheap |
| SpotLight (flashlight) | 1 per local player | optional 512² | remote players' flashlights: see slots |
| PointLight pool ("local slots") | 4 | **never** | campfires, lamps, remote flashlights as points |
| Emissive materials | unlimited | — | distant windows, eyes, lanterns; fog does the falloff |

Light count never changes at runtime. A disabled slot has `intensity = 0`.

### Keyframes (`TimeOfDay.ts`)

```ts
export type Phase = 'DAY' | 'EVENING' | 'NIGHT' | 'NIGHTMARE'

export interface LightingKey {
  sunDir: [number, number, number]     // normalized, points *from* light toward scene origin inverse
  sunColor: number; sunIntensity: number
  hemiSky: number; hemiGround: number; hemiIntensity: number
  fogColor: number; fogDensity: number
  exposure: number
  grade: { tint: [number, number, number]; saturation: number; contrast: number; vignette: number }
}

export const KEYS: Record<Phase, LightingKey> = {
  DAY:       { sunDir: [0.4, 0.8, 0.3],  sunColor: 0xfff1d6, sunIntensity: 2.2, hemiSky: 0xbcd3e6, hemiGround: 0x4a4636, hemiIntensity: 0.9, fogColor: 0xa9b8bf, fogDensity: 0.010, exposure: 1.0,  grade: { tint: [1, 1, 1],        saturation: 0.9,  contrast: 1.05, vignette: 0.25 } },
  EVENING:   { sunDir: [0.8, 0.18, 0.2], sunColor: 0xff9a52, sunIntensity: 1.4, hemiSky: 0x8a6f7a, hemiGround: 0x2e2420, hemiIntensity: 0.6, fogColor: 0x7a5e5a, fogDensity: 0.016, exposure: 1.05, grade: { tint: [1.08, 0.96, 0.88], saturation: 0.85, contrast: 1.1,  vignette: 0.35 } },
  NIGHT:     { sunDir: [-0.3, 0.6, -0.4],sunColor: 0x7d95c8, sunIntensity: 0.18,hemiSky: 0x1b2433, hemiGround: 0x07080a, hemiIntensity: 0.25,fogColor: 0x0b0f16, fogDensity: 0.030, exposure: 1.2,  grade: { tint: [0.85, 0.95, 1.1], saturation: 0.6,  contrast: 1.15, vignette: 0.55 } },
  NIGHTMARE: { sunDir: [0.1, 0.9, 0.2],  sunColor: 0xa01010, sunIntensity: 0.35,hemiSky: 0x2a0606, hemiGround: 0x050000, hemiIntensity: 0.3, fogColor: 0x1a0304, fogDensity: 0.040, exposure: 1.15, grade: { tint: [1.25, 0.8, 0.8],  saturation: 0.7,  contrast: 1.25, vignette: 0.7 } },
}
```

Blending: `blend(a, b, t)` lerps numbers, lerps colours **in linear space** (`Color.lerp` on linear colours),
and slerps/normalizes `sunDir`. Transition time is data (e.g. 90 s DAY→EVENING, 8 s into NIGHTMARE).
All output goes into one reused `LightingState` object — no allocation per frame.

Moon trick: at NIGHT the "sun" is the moon — same DirectionalLight, low intensity, cold colour, still casts
the single shadow. Never add a second directional light for the moon.

## 3. When to use

- Adding a phase or tuning a mood → edit `KEYS`, not the light objects.
- Adding a light-emitting prop → register an **emitter** with `LocalLightPool`, give the mesh an emissive
  material. Do not add a light to the scene.
- Flashlight behaviour (battery flicker, cone width) → flashlight module drives the one SpotLight.

## 4. When NOT to use

- Do not use a real light for something small or far: eyes, windows, distant lanterns, fireflies → emissive +
  fog (+ a small additive sprite if it must glow).
- Do not use `RectAreaLight` (expensive, needs LTC textures, no shadows).
- Do not use Drei `<Environment>` HDRI for a night horror scene: it adds a PMREM texture and IBL cost to every
  Standard material and flattens darkness. A tiny procedural sky colour + hemisphere light is enough.
- No shadow-casting `PointLight` — ever. A point shadow is a **cube map: 6 extra scene renders**.

## 5. Performance implications

| Item | CPU | GPU | Memory |
|---|---|---|---|
| Directional + shadow | shadow pass re-submits casters (~+30% draw calls) | PCF taps on all receivers, depth render | 2048² depth ≈ 16 MB |
| Hemisphere | negligible | ~1 mix per fragment | — |
| SpotLight no shadow | uniform upload | cone + attenuation per fragment | — |
| SpotLight 512² shadow | 1 extra pass (flashlight frustum only) | PCF taps | ~1 MB |
| Each PointLight slot | uniform upload | loop iteration per lit fragment (~3–5% of lit shading at 1080p) | — |
| Changing light count | **program recompile: 20–200 ms per material** | — | new programs |
| TimeOfDay blend | < 0.02 ms | — | — |

Lambert is per-fragment in current three.js but still ~2× cheaper than Standard per light.

## 6. WebGL limitations

- Light uniforms are baked into the program: `NUM_POINT_LIGHTS`, `NUM_SPOT_LIGHTS`, `NUM_DIR_LIGHTS`, shadow
  counts. `light.visible = false` *removes* the light from the count → recompile. Toggle `intensity`.
- Uniform vector limits cap practical light counts (~8–16 before trouble on weaker GPUs).
- `SpotLight.map` (cookie texture) **only works when `castShadow` is true** (it uses the shadow matrix). If the
  flashlight shadow is disabled for performance, fake the cookie with a wider penumbra instead.
- No deferred shading; cost is (lights × lit pixels) forward.

## 7. R3F implementation

```tsx
// src/scene/Lighting.tsx (shape)
export function Lighting() {
  const game = useGame()
  const sun = useRef<THREE.DirectionalLight>(null!)
  const hemi = useRef<THREE.HemisphereLight>(null!)
  const slots = useRef<THREE.PointLight[]>([])

  useLayoutEffect(() => {
    game.lighting.register({ sun: sun.current, hemi: hemi.current, slots: slots.current })
    return () => game.lighting.unregister()
  }, [game])

  return (
    <>
      <directionalLight ref={sun} castShadow shadow-mapSize={[2048, 2048]} />
      <hemisphereLight ref={hemi} />
      {[0, 1, 2, 3].map(i => (
        <pointLight key={i} ref={el => { if (el) slots.current[i] = el }}
                    intensity={0} distance={14} decay={2} castShadow={false} />
      ))}
    </>
  )
}
```

The sun's `target` must be in the scene (`scene.add(sun.target)`) or its direction is stale — do it in
`register`. All per-frame writes happen inside `LightingSystem.update()` called by the game loop, not in React.

Flashlight attached to the camera:

```tsx
function Flashlight() {
  const camera = useThree(s => s.camera)
  const spot = useMemo(() => {
    const l = new THREE.SpotLight(0xfff2dd, 40, 32, THREE.MathUtils.degToRad(24), 0.45, 2)
    l.position.set(0.25, -0.2, 0)            // hand offset, camera space
    l.target.position.set(0.25, -0.2, -1)    // points forward (-Z in camera space)
    return l
  }, [])
  useLayoutEffect(() => {
    camera.add(spot); camera.add(spot.target)   // both children of camera → follow look direction
    return () => { camera.remove(spot); camera.remove(spot.target) }
  }, [camera, spot])
  return <primitive object={camera} />       // camera must be in the scene graph for children to render
}
```

Light and target must both be children of the camera (a target parented to the light moves with it and the
cone never turns). Toggle with `spot.intensity = on ? 40 : 0`, never `visible`.

## 8. Direct Three.js implementation

Local light pool — nearest emitters get the 4 real lights:

```ts
// src/rendering/lighting/LightingSystem.ts (excerpt)
interface Emitter { x: number; y: number; z: number; color: THREE.Color; intensity: number; range: number; flicker: number }

updateLocalLights(px: number, pz: number, emitters: Emitter[]) {
  // emitters come from active chunks only (≤ ~50), not the whole world
  best.length = 0
  for (const e of emitters) {
    const d2 = (e.x - px) ** 2 + (e.z - pz) ** 2
    if (d2 < 40 * 40) insertSorted(best, e, d2, this.slots.length)   // keep top N
  }
  for (let i = 0; i < this.slots.length; i++) {
    const s = this.slots[i], e = best[i]
    if (!e) { s.intensity = 0; continue }
    s.position.set(e.x, e.y, e.z); s.color.copy(e.color); s.distance = e.range
    // fade by distance so reassigning a slot never pops
    const fade = 1 - smoothstep(30, 40, Math.sqrt(dist2(e, px, pz)))
    s.intensity = e.intensity * fade * (1 + e.flicker * noise1(time * 9 + i))
  }
}
```

Applying a blended state:

```ts
apply(s: LightingState, scene: THREE.Scene, gl: THREE.WebGLRenderer, player: THREE.Vector3) {
  this.sun.color.copy(s.sunColor); this.sun.intensity = s.sunIntensity
  this.sun.position.copy(player).addScaledVector(s.sunDir, 80)
  this.sun.target.position.copy(player)
  this.hemi.color.copy(s.hemiSky); this.hemi.groundColor.copy(s.hemiGround); this.hemi.intensity = s.hemiIntensity
  const fog = scene.fog as THREE.FogExp2; fog.color.copy(s.fogColor); fog.density = s.fogDensity
  ;(scene.background as THREE.Color).copy(s.fogColor)           // sky == fog colour: horizon disappears
  gl.toneMappingExposure = s.exposure
  grading.uniforms.uTint.value.copy(s.tint)                      // see skills/postprocessing
}
```

## 9. Common mistakes

- Adding a PointLight per lamp/campfire → N×lit-pixel cost + recompile when chunks stream in. Use the pool.
- `castShadow` on point lights (6 renders each).
- Toggling `visible`/`castShadow` → hitch. Keep counts constant, toggle intensity.
- Forgetting `sun.target` in the scene → shadows/direction stuck at origin.
- Lerping hex colours in sRGB → muddy transitions. three `Color` values are linear; lerp those.
- Night made by just lowering everything → black mush. Keep hemisphere sky slightly blue, keep silhouettes
  readable against fog colour; darkness should come from fog + vignette, not zero light.
- Flashlight too narrow with hard edge → looks like a laser; use penumbra 0.4–0.6 and decay 2.
- Physically huge intensities without adjusting exposure between phases.

## 10. Profiling/debugging

- HUD shows `programs`: cycle phases with `T` and toggle flashlight with `F` — the count must not increase after
  the first full cycle (else a light/define is changing).
- Spector.js: check `NUM_POINT_LIGHTS` define in program source is constant.
- GPU cost of the pool: set slot intensities to 0 vs 1 does **not** change cost (loop still runs); to measure,
  compare builds with 0 and 4 slots at full resolution.
- Debug overlay (planned): draw emitter positions and slot assignments as colored spheres.
