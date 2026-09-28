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
}

/**
 * Big rolling wind GUSTS (Genshin-style): bright bands sweeping across the meadow along the wind. Shared by
 * grass (sway + tip highlight) and the painted ground beyond the grass, so the waves continue to the horizon.
 */
export const GUST_GLSL = /* glsl */ `
float windGust(vec2 xz, float t, vec2 wind) {
  vec2 d = normalize(wind + 1e-4);
  float n = sin(dot(xz, d) * 0.045 - t * 1.05 + sin(xz.x * 0.013 + xz.y * 0.017) * 2.4);
  return smoothstep(0.35, 1.0, n);
}`
