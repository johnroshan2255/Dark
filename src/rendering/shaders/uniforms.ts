import * as THREE from 'three'

/**
 * Shared uniform OBJECTS. Materials reference these directly (onBeforeCompile / ShaderMaterial),
 * so one write per frame updates every program. See skills/shaders.
 */
export const globalUniforms = {
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
  // ~1 m lean + ±1 m sway at the top of a 17 m tree in a strong wind (ws ≈ 1.8); a whisper in still air.
  float lean = (0.35 + 0.65 * gust) * ws * 0.6;
  float sway = sin(t * 1.1 + phase) * 0.5 + sin(t * 2.7 + phase * 1.7 + h * 0.4) * 0.2;
  p.xz += dir * k * (lean + sway * ws * 0.4);
  return p;
}`

export const GUST_GLSL = /* glsl */ `
float windGust(vec2 xz, float t, vec2 wind) {
  vec2 d = normalize(wind + 1e-4);
  float n = sin(dot(xz, d) * 0.045 - t * 1.05 + sin(xz.x * 0.013 + xz.y * 0.017) * 2.4);
  return smoothstep(0.35, 1.0, n);
}`
