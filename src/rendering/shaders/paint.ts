/**
 * PAINTED SURFACES (the hand-painted prop look of refer/ + the forest-house study): instead of a painted
 * texture per asset, every solid surface paints itself in the fragment shader from its vertex colour, its
 * object-space position/normal and ONE fetch of the shared tiling brush texture (materials/BrushTexture.ts):
 *   STONE  brush strokes + blotches, pale tops, ragged moss caps          (rocks, ruins, chimneys)
 *   WOOD   boards (~0.3 m) with seams, per-board tint, grain, grime/moss at the base, moss on tops
 *   BARK   vertical fibres, darker base, moss creeping up one side         (trunks, poles, logs)
 *   PLAIN  soft brush strokes only                                         (canopy cores, plaster, glass)
 *   ROOF   shingle rows with offset joints, per-shingle tint, moss patches
 * The surface is picked by the vertex UV inside the atlas's opaque block (materials/FoliageAtlas SURFACE_UV)
 * → no extra attribute, geometry, draw call or shader program. Cost: 1 texture fetch + ~25–40 ALU on painted
 * solid fragments only (alpha-tested cards skip it); a plain branch on everything else.
 * Planar projection on the dominant normal axis (not triplanar): 1 fetch instead of 3; the seam at 45° edges
 * reads as a brush edge.
 */
export const SURFACE = { stone: 0, wood: 1, bark: 2, plain: 3, roof: 4 } as const

/** Vertex side: object-space position/normal + the surface id (−10 = not painted, e.g. an atlas card). */
export const PAINT_VERT_PARS = /* glsl */ `
varying vec3 vPObj;
varying vec3 vNObj;
varying float vSurf;`

/** @param surf GLSL expression for the surface id (a constant, or decoded from the atlas UV). */
export const paintVert = (surf: string) => /* glsl */ `
vPObj = transformed;
vNObj = objectNormal;
vSurf = ${surf};`

/** Decodes the atlas opaque block: u ∈ [0.9625, 1) in 0.0075 steps, v < 0.038. */
export const ATLAS_SURF = '(uv.x > 0.9625 && uv.y < 0.038) ? floor((uv.x - 0.9625) / 0.0075) : -10.0'

export const PAINT_FRAG_PARS = /* glsl */ `
uniform sampler2D uBrush;
varying vec3 vPObj;
varying vec3 vNObj;
varying float vSurf;
float pt_hash(float n) { return fract(sin(n) * 43758.5453); }
vec3 paintSurface(vec3 c, float id) {
  vec3 n = normalize(vNObj);
  vec3 an = abs(n);
  vec3 p = vPObj;
  // Dominant-axis planar projection: walls → (horizontal, height), tops → (x, z).
  vec2 pu = an.y > max(an.x, an.z) ? p.xz : (an.x > an.z ? p.zy : p.xy);
  const vec3 MOSS = vec3(0.16, 0.3, 0.07);
  float base = 1.0 - smoothstep(0.0, 1.1, p.y); // near the object's foot
  if (id < 0.5) {                                   // STONE
    vec4 b = texture2D(uBrush, pu * 0.45);
    c *= 0.74 + 0.36 * b.g + 0.3 * (b.r - 0.5);
    c = mix(c, c * 1.35 + 0.03, smoothstep(0.25, 0.9, n.y) * 0.55);
    float m = smoothstep(0.6, 0.78, n.y + (b.a - 0.5) * 0.8);
    c = mix(c, MOSS * (0.7 + 0.5 * b.r), m * 0.75);
  } else if (id < 1.5) {                            // WOOD boards
    float t = pu.x * 3.3;
    float fw = fwidth(t);
    float bf = fract(t);
    float bi = floor(t) + floor(pu.y * 0.35) * 17.0;
    vec4 b = texture2D(uBrush, vec2(pu.x * 0.8, pu.y * 0.16));
    float seam = (1.0 - smoothstep(0.0, 0.07 + fw, min(bf, 1.0 - bf))) * (1.0 - smoothstep(0.3, 0.6, fw));
    c *= (0.86 + 0.18 * pt_hash(bi * 7.13)) * (0.8 + 0.4 * b.b) * (1.0 - 0.5 * seam * step(an.y, 0.7));
    c *= 1.0 - 0.28 * base;                                                   // grime at the foot
    c = mix(c, MOSS * 0.9, base * smoothstep(0.35, 0.7, b.a) * 0.7);          // moss creeping up
    c = mix(c, MOSS * (0.8 + 0.5 * b.r), smoothstep(0.5, 0.75, n.y + (b.a - 0.5)) * 0.6);
  } else if (id < 2.5) {                            // BARK
    vec4 b = texture2D(uBrush, vec2(pu.x * 1.4, pu.y * 0.22));
    c *= (0.5 + 0.9 * b.b) * (0.9 + 0.2 * b.r);
    c *= 0.75 + 0.25 * smoothstep(0.0, 1.6, p.y);
    float side = smoothstep(-0.2, 0.8, n.x * 0.7 + n.z * 0.7) * (1.0 - smoothstep(0.2, 1.8, p.y));
    c = mix(c, MOSS * (0.8 + 0.5 * b.r), side * smoothstep(0.35, 0.65, b.a) * 0.75);
  } else if (id < 3.5) {                            // PLAIN
    vec4 b = texture2D(uBrush, pu * 0.7);
    c *= 0.9 + 0.22 * (b.r - 0.5) + 0.12 * (b.g - 0.5);
  } else {                                          // ROOF shingles
    float row = floor(p.y * 3.4);
    float t = pu.x * 2.4 + row * 0.5;
    float fw = fwidth(t) + fwidth(p.y * 3.4);
    float fade = 1.0 - smoothstep(0.3, 0.7, fw);
    vec4 b = texture2D(uBrush, pu * 0.22);
    float edge = 1.0 - smoothstep(0.0, 0.12, fract(p.y * 3.4));
    float joint = 1.0 - smoothstep(0.0, 0.05 + fw, min(fract(t), 1.0 - fract(t)));
    c *= (0.84 + 0.2 * pt_hash(floor(t) * 3.7 + row * 11.1)) * (1.0 - fade * (0.35 * edge + 0.3 * joint)) * (0.88 + 0.24 * b.r);
    // A few ragged moss patches (the rest of the roof stays its colour).
    c = mix(c, MOSS * (0.85 + 0.5 * b.r), smoothstep(0.64, 0.8, b.a) * 0.6);
  }
  return c;
}`
