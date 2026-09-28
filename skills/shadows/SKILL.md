---
name: shadows
description: Read before enabling castShadow/receiveShadow on anything, changing shadow map settings, or adding fake/baked shadows — defines the one-directional-shadow strategy.
---

# Shadows

## 1. Purpose

Shadows ground objects and give the forest depth, but in WebGL they are the easiest way to double frame cost.
DARK uses **one real shadow map** (sun/moon), tightly focused around the player, plus cheap fakes everywhere
else. Fog hides the edge where real shadows stop.

## 2. Architecture

```
DirectionalLight (sun/moon, from skills/lighting)
  shadow.mapSize 2048²
  shadow.camera: OrthographicCamera ±35 m (70 m square), near 1, far 200
  follows player, snapped to shadow-texel grid       src/rendering/shadows/ShadowFollow.ts
Casters: LOD0 chunk content only (trees, rocks, player, monsters within ~1 chunk)
Receivers: terrain + LOD0 props
Everything else:
  - AO baked into terrain / tree vertex colours       src/world/Terrain/, src/world/Forest/
  - blob shadow decals under characters, BMX, monsters  src/rendering/shadows/BlobShadows.ts (planned) (instanced quads)
  - fog + grading vignette for depth
Flashlight shadow: optional, 512², only when quality ≥ high
```

Caster assignment is part of chunk LOD: when a chunk's LOD changes, its instanced meshes get
`castShadow = lod === 0`. Changing `castShadow` on an object does not recompile programs for *that* object's
material (the shadow depth material is separate), but toggling `receiveShadow` does change the material
program — so `receiveShadow` stays fixed per material family (terrain always receives).

## 3. When to use

- Real shadow: things near the player whose contact with the ground matters (player, trees within 35 m, monsters,
  BMX, large rocks).
- Blob shadow: every moving character/vehicle (always, even when inside the real map — it adds contact darkening).
- Baked AO: static procedural content (tree base darkening, terrain in dips, cave walls).

## 4. When NOT to use

- No `castShadow` on grass, small plants, mushrooms, debris, particles — invisible in the map at 2048²/70 m
  (~3.4 cm per texel) or pure noise.
- No shadows from PointLights (cube map = 6 scene renders).
- No cascaded shadow maps (CSM) unless a measured need appears (e.g. a long sunset view down the road where
  distant tree shadows are clearly missing). CSM with 3 cascades = 3 shadow passes. Fog density at EVENING/NIGHT
  makes far shadows invisible anyway.
- No shadows inside caves from the sun: disable sun shadow (`intensity` to 0 and `shadow.autoUpdate=false`) when
  the player is underground; cave depth comes from darkness + flashlight.

## 5. Performance implications

| Setting | CPU | GPU | Memory |
|---|---|---|---|
| Sun shadow pass | +1 traversal & re-submit of casters (≈ +20–40% draw calls) | depth-only render of casters | 2048² ≈ 16 MB (4096² ≈ 64 MB) |
| PCF sampling (`PCFShadowMap`) | — | ~4–9 taps per receiving fragment | — |
| `VSMShadowMap` | — | + blur passes | 2 extra RTs |
| Flashlight 512² | +1 pass (cone only) | small | ~1 MB |
| Blob shadows (instanced) | 1 draw call total | tiny transparent quads | negligible |
| Baked vertex AO | at generation time | 0 | 0 (vertex colour already exists) |

Map resolution is a GPU fill cost only for the shadow pass (~0.2–0.8 ms at 2048²), but texel density is what
controls quality: `70 m / 2048 = 3.4 cm/texel`. Doubling frustum size halves quality; doubling map size
quadruples memory. Tighten the frustum before raising resolution.

Update cadence option: with `renderer.shadowMap.autoUpdate = false` and
`renderer.shadowMap.needsUpdate = true` every 2nd frame, the shadow pass cost halves. Only valid when the sun
and casters move slowly — moving monsters' shadows will visibly lag. Use at LOW quality only.

## 6. WebGL limitations

- Shadow maps are depth textures sampled per light per fragment; each shadow light consumes a texture unit
  (16 total on many GPUs, shared with maps).
- No hardware PCF control beyond `sampler2DShadow` comparisons three already uses; soft shadows are
  multiple taps.
- Depth precision: long `far` or wide frustum → acne/peter-panning. Keep `far - near` ≲ 200 m.
- Shadow light count changes (`castShadow` on a light) recompile all lit programs — decide at startup.

## 7. R3F implementation

```tsx
// in <Lighting />
<directionalLight
  ref={sun}
  castShadow
  shadow-mapSize={[2048, 2048]}
  shadow-bias={-0.0004}
  shadow-normalBias={0.03}
  shadow-camera-left={-35} shadow-camera-right={35}
  shadow-camera-top={35} shadow-camera-bottom={-35}
  shadow-camera-near={1} shadow-camera-far={200}
/>
```

`<Canvas shadows>` enables `gl.shadowMap`; we set the type explicitly in `configureRenderer`
(`THREE.PCFShadowMap`). In chunk components, `castShadow` is set imperatively on LOD change, not re-rendered
through JSX every frame.

## 8. Direct Three.js implementation

Follow + texel snapping (removes shimmering "crawling" edges as the player moves):

```ts
// src/rendering/shadows/ShadowFollow.ts
const _lightSpace = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _p = new THREE.Vector3()

export function followShadow(sun: THREE.DirectionalLight, focus: THREE.Vector3, sunDir: THREE.Vector3) {
  const cam = sun.shadow.camera as THREE.OrthographicCamera
  const worldPerTexel = (cam.right - cam.left) / sun.shadow.mapSize.x

  // light-space basis: orientation depends only on the light direction
  _lightSpace.lookAt(new THREE.Vector3(0, 0, 0), sunDir.clone().negate(), THREE.Object3D.DEFAULT_UP)
  _inv.copy(_lightSpace).invert()

  // snap the focus point to the texel grid in light space
  _p.copy(focus).applyMatrix4(_inv)
  _p.x = Math.floor(_p.x / worldPerTexel) * worldPerTexel
  _p.y = Math.floor(_p.y / worldPerTexel) * worldPerTexel
  _p.applyMatrix4(_lightSpace)

  sun.target.position.copy(_p)
  sun.position.copy(_p).addScaledVector(sunDir, 100)
  sun.target.updateMatrixWorld()
}
```

(Hoist the `new Vector3`s into module temporaries in real code.)

Casters by LOD:

```ts
function applyChunkShadowLod(chunk: ChunkRender, lod: number) {
  const cast = lod === 0
  for (const m of chunk.instanced) m.castShadow = cast && m.userData.canCastShadow
  chunk.terrain.castShadow = false   // terrain self-shadowing is invisible at this scale; receive only
  chunk.terrain.receiveShadow = true
}
```

Blob shadows: one `InstancedMesh` of a unit quad with a radial-gradient texture (64², alpha), `depthWrite:false`,
`transparent:true`, `polygonOffset` to avoid z-fighting, positioned at ground height under each character
every frame (≤ 8 instances: 4 players + nearby monsters).

Baked AO in vertex colours (at generation, in the worker):

```ts
// terrain: darken concave cells; forest: darken ground near trunks
ao = clamp(1 - k * (avgNeighbourHeight - h), 0.55, 1)
color *= ao
```

Flashlight shadow (quality ≥ high only, decided at startup):

```ts
spot.castShadow = quality >= Quality.High
spot.shadow.mapSize.set(512, 512)
spot.shadow.camera.near = 0.3; spot.shadow.camera.far = 30
spot.shadow.bias = -0.0008
```

## 9. Common mistakes

- **Shadow-only proxies via layers don't work in three.js** — `WebGLShadowMap.renderObject` tests layers
  against the MAIN camera. Budget shadow casters by choosing the per-tier near geometry level instead.
- **Over-long shadow depth range** (`far = 260`) at low sun pulls whole chunk rows of terrain into the pass; use
  `far = SHADOW_LIGHT_DISTANCE + 1.5 × extent`.

- **Visible shadow-frustum rectangle** once the near field is fog-free: fade directional shadows over the outer
  20% of the map (`ShadowEdgeFade.ts`, global chunk patch) and use extents LOW 34 / MEDIUM 40 / HIGH 50 m.
- **Hard-edged low-poly shadows at night** read as boxes — moon uses PCF `shadow.radius = 4` (sun 2).
- **Only LOD0 terrain casting** cuts hill shadows at chunk borders — terrain casts at every LOD.

- **`frustumCulled = false` on casters** (because chunk culling handles the main view) disables culling in the
  SHADOW pass too → every LOD0 chunk is drawn into the sun map. Keep per-mesh bounding spheres +
  `frustumCulled = true` (measured on LOW: peak 111 → 93 draws, 215k → 175k tris). The sun shadow map is also the
  input of the volumetric shafts (skills/postprocessing).

- **A `castShadow` light with no shadow map** (e.g. `shadow.autoUpdate = false` before the map was ever
  rendered): lit programs sample a non-depth texture → `GL_INVALID_OPERATION` → every lit draw is dropped →
  fog-only frame. Always render the map once (`shadow.needsUpdate = true`) when `castShadow` turns on or the map is
  disposed — `LightingSystem.update` enforces this.

- `castShadow` on every instanced species at every LOD → shadow pass draws the whole ring.
- Huge ortho frustum (±200 m) "so shadows reach the horizon" → blurry 20 cm texels, acne.
- Not snapping to texels → shadow edges swim as the player walks.
- Bias only (no `normalBias`) on low-poly faceted terrain → acne on slopes. Use normalBias 0.02–0.05.
- Forgetting `sun.target` in the scene (shadow camera never re-aims).
- Toggling `light.castShadow` at runtime for "quality" → recompile hitch.
- `receiveShadow` on alpha-tested foliage cards far away — pays PCF on thousands of fragments for invisible results.

## 10. Profiling/debugging

- `THREE.CameraHelper(sun.shadow.camera)` toggled from the chunk debug (`F4`) to see the frustum follow.
- HUD draw calls with shadows on vs `sun.castShadow` temporarily false at startup (debug build flag) → shadow pass cost.
- GPU timer (Chrome): compare frame GPU ms with map 1024/2048/4096.
- Spector.js: the shadow pass appears as a separate framebuffer bind with depth-only draws — count them.
- Acne test: stand on slopes at EVENING (low sun angle) — worst case for bias.
