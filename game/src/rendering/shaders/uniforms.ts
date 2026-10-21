import * as THREE from 'three'

/**
 * Shared uniform OBJECTS. Materials reference these directly (onBeforeCompile / ShaderMaterial),
 * so one write per frame updates every program. See skills/shaders.
 */
/**
 * VALUE-NOISE LATTICE (stylize st_noise): Hoskins' hash12 at each of 256² integer points, R16F, repeat-wrapped,
 * linear-filtered. Sampled at (cell + smoothstep(fract) + 0.5) / 256, ONE bilinear fetch returns exactly the
 * smoothstep blend of the 4 corner hashes that st_noise used to compute with 4 hashes (~40 ALU) — 10–15 calls per
 * ground pixel. Only change: the pattern repeats every 256 noise cells (≥ 850 m for the big ground patches).
 */
function noiseLattice(): THREE.DataTexture {
  const N = 256
  const data = new Uint16Array(N * N)
  const fr = (x: number) => x - Math.floor(x)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let a = fr(x * 0.1031), b = fr(y * 0.1031), c = fr(x * 0.1031)
      const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33)
      a += d; b += d; c += d
      data[y * N + x] = THREE.DataUtils.toHalfFloat(fr((a + b) * c))
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.HalfFloatType)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.magFilter = t.minFilter = THREE.LinearFilter
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
}

export const globalUniforms = {
  /** st_noise lattice (see noiseLattice). */
  uNoiseTex: { value: noiseLattice() },
  uTime: { value: 0 },
  /** Wind direction (xz) × strength. */
  uWind: { value: new THREE.Vector2(0.9, 0.35) },
  /** Grass fade distances from the camera: x = start, y = end (m). Per quality tier. */
  uGrassFade: { value: new THREE.Vector2(30, 42) },
  uCameraPos: { value: new THREE.Vector3() },
  /** Player feet (grass parts around it). */
  uPlayerPos: { value: new THREE.Vector3(0, -1e4, 0) },
  /** Key light (sun/moon) direction in VIEW space and its colour × intensity — grass translucency. */
  uKeyDirView: { value: new THREE.Vector3(0, 1, 0) },
  uKeyColor: { value: new THREE.Color(0, 0, 0) },
  /** Aerial-perspective colour the fog takes when looking toward the key light, and how much. */
  uScatterColor: { value: new THREE.Color(1, 0.6, 0.3) },
  uScatterAmount: { value: 0.6 },
  /** Genshin cel-shading strength 0..1 (hard two-tone light/shadow terminator), per time of day. */
  uToon: { value: 1 },
  /** Distance fog on land: max amount, land tint (× sky colour), horizon-rim fade (start, end m). Per frame. */
  uFogMax: { value: 1 },
  uLandHaze: { value: new THREE.Color(1, 1, 1) },
  uFarEdge: { value: new THREE.Vector2(1e5, 1e5 + 1) },
  /** Streamed-detail edge: trees/props dither out between x and y (view depth, m) — not drawn beyond. */
  uCullFade: { value: new THREE.Vector2(1e5, 1e5 + 1) },
  /**
   * PER-TREE LOD CROSSFADE (camera → tree origin distance, m): LOD0 mesh → LOD1 mesh dither between x and y,
   * LOD1 mesh → octahedral impostor between z and w. Every tree geometry carries its band (`aLodBand`); the same
   * interleaved-gradient dither on both sides makes each pixel belong to exactly one LOD. x < 0 = off (legacy LOD).
   */
  uTreeLod: { value: new THREE.Vector4(-1, 0, 1e5, 1e5 + 1) }, // x < 0 = off (legacy chunk LOD)
  /** A fixed map's own dirt-road colour (linear rgb; w = 1 on, 0 = the default earth) — map.json `palette.dirt`. */
  uRoadSoil: { value: new THREE.Vector4(0.31, 0.225, 0.15, 0) },
  /**
   * AERIAL PERSPECTIVE (Genshin's distance "filter", stylize fog block): from x to y metres distant surfaces lose
   * saturation and contrast toward the haze (z = strength), so far detail reads as soft silhouettes long before the
   * tint covers it; w = how much warmer / brighter the haze is toward the sun (cooler away from it). ~12 ALU.
   */
  uAerial: { value: new THREE.Vector4(30, 600, 0.75, 0.65) },
  /** Far-forest edge: trees thin out (each vanishes whole at its own hashed distance) between x and y (m). */
  uImpFar: { value: new THREE.Vector2(1e5, 1e5 + 1) },
  /** Ground wetness 0..1 (weather): darker ground, a sheen toward the key light, sky-reflecting puddles on flat ground. */
  uWet: { value: 0 },
  /** Foliage cards dissolve this close to the eye (view depth, m): start, end. */
  uNearFade: { value: new THREE.Vector2(1.4, 3.0) },
  /** STORYBOOK art style: painted-shading weight, the painted light colour, world-up in view space. */
  uStoryAmt: { value: 1 },
  uStoryLight: { value: new THREE.Color(1, 1, 1) },
  uUpView: { value: new THREE.Vector3(0, 1, 0) },
  /** Shared hand-painted surface texture (materials/BrushTexture.ts), set by MaterialLibrary. */
  uBrush: { value: null as THREE.Texture | null },
  /** Region biome weights around the player (rendering/biome/BiomeMap.ts) and its rect: minX, minZ, 1/size, 1/size. */
  uBiomeMap: { value: null as THREE.Texture | null },
  uBiomeRect: { value: new THREE.Vector4(-1e5, -1e5, 1e-6, 1e-6) },
  /** Footprints / tyre tracks around the player (rendering/trails/TrailMap.ts) and its rect: minX, minZ, 1/size, 1/size. */
  uTrailMap: { value: null as THREE.Texture | null },
  /** 1 = the trail map is live (Ground & weather detail ≥ medium). */
  uTrailOn: { value: 0 },
  /** 1 = snow / sand micro-relief + glints in the terrain shader (Ground & weather detail ≥ medium). */
  uSurfaceDetail: { value: 0 },
  /** 1 = some snow or desert lies inside the biome map (else the biome-cover lookups are skipped entirely). */
  uBiomeActive: { value: 0 },
  uTrailRect: { value: new THREE.Vector4(-1e5, -1e5, 1e-6, 1e-6) },
  /** IMAGE TREE SHADOWS (rendering/shadows/TreeShadows): top-down shade image round the player (R = 0..1 shade), its
   *  rect (minX, minZ, 1/size, strength) and the switch (LOW shadow level; else 0 → the lookup is skipped). */
  uTreeShade: { value: null as THREE.Texture | null },
  uTreeShadeRect: { value: new THREE.Vector4(-1e5, -1e5, 1e-6, 0) },
  uTreeShadeOn: { value: 0 },
  /** DYNAMIC SHADOWS (rendering/shadows/DynamicShadow): the moving things' depth from the sun round the player, its
   *  world → uv/depth matrix, and the strength (0 = off: the sun map is not cached, or night / cave). */
  uDynShadow: { value: null as THREE.Texture | null },
  uDynShadowMat: { value: new THREE.Matrix4() },
  uDynShadowOn: { value: 0 },
}

/**
 * Big rolling wind GUSTS (Genshin-style): bright bands sweeping across the meadow along the wind. Shared by
 * grass (sway + tip highlight) and the painted ground beyond the grass, so the waves continue to the horizon.
 */
/**
 * Tree SWAY (shared by the foliage vertex shader and the billboard tufts): object-space point `p` of an
 * instance whose world xz is `ixz` bends with height — a slow whole-tree lean plus a faster flutter, both
 * scaled by the wind and the rolling gusts. Tall parts move most; the trunk base stays put.
 */
export const SWAY_GLSL = /* glsl */ `
vec3 foliageSway(vec3 p, vec2 ixz, float t, vec2 wind) {
  float h = max(p.y, 0.0);
  float k = h * h * 0.01;
  float ws = length(wind);
  vec2 dir = wind / max(ws, 1e-4);
  float phase = dot(ixz, vec2(0.37, 0.61));
  float gust = windGust(ixz, t, wind);
  // ~15 cm lean + ±15 cm sway at the top of a 17 m tree in a strong wind (ws ≈ 1.8); a whisper in still air.
  float lean = (0.35 + 0.65 * gust) * ws * 0.09; // (30 % of the last pass: crowns barely lean, they breathe)
  float sway = sin(t * 1.1 + phase) * 0.5 + sin(t * 2.7 + phase * 1.7 + h * 0.4) * 0.2;
  p.xz += dir * k * (lean + sway * ws * 0.06);
  return p;
}`

export const GUST_GLSL = /* glsl */ `
float windGust(vec2 xz, float t, vec2 wind) {
  vec2 d = normalize(wind + 1e-4);
  float n = sin(dot(xz, d) * 0.045 - t * 1.05 + sin(xz.x * 0.013 + xz.y * 0.017) * 2.4);
  return smoothstep(0.35, 1.0, n);
}`
