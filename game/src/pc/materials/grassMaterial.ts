import * as pc from 'playcanvas'
import type * as THREE from 'three'
import { GUST_GLSL } from '../../rendering/shaders/uniforms'
import { attrSemantic, type MaterialBank, type PcMat } from '../ThreeMirror'
import { activeLook } from '../look'
import { applyWorldLook } from './common'
import { pcGlsl } from './glsl'

/**
 * GRASS on PlayCanvas — the three build's grass material (world/Forest/grass.ts createGrassMaterial, BRIGHT strap
 * clumps) as an engine StandardMaterial, drawing GrassField's own instanced patches (its CPU side — tiles, the clump
 * mass field, density, slopes, compaction to the patches in view — runs unchanged; the render bridge uploads them):
 *  - vertex (getLocalPosition): each blade's root on the slope under it (iSlope), its height from the clump MASS field
 *    (iMass: soft-edged masses with bare ground between), the near / mid / far BAND fades and distance thinning (each
 *    blade at its own threshold — no rings or squares), WIND sway with the shared gusts, PARTING round the player,
 *    blades widening with distance (no sub-pixel shimmer), flowers;
 *  - colour (per vertex): the ground-matched vertex colour × the instance colour, a lighter tip hue by the soft world
 *    patches, gust bands, flower colours;
 *  - light: the shared toon / hemisphere / rim / sky fog, no back-face normal flip (blades light like the field's
 *    volume), warm translucent tips toward the sun, darker when wet.
 * Blades that fade to nothing collapse to their root (zero area: no fragments).
 */
const TRANSFORM_CORE_VS = /* glsl */ `
attribute vec4 vertex_position;
uniform mat4 matrix_viewProjection;
uniform mat4 matrix_model;
#if defined(INSTANCING)
  #include "transformInstancingVS"
#else
  mat4 getModelMatrix() { return matrix_model; }
#endif
uniform float uTime; uniform vec2 uWind; uniform vec4 uGrassBand; uniform vec2 uGrassThin; uniform vec3 uPlayerPos;
attribute float tip; attribute float flower; attribute vec2 bladeRoot; attribute float bladeId;
attribute float iDensity; attribute vec2 iSlope; attribute vec3 iMass;
${GUST_GLSL}
float gHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float gVN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1, 0)), f.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), f.x), f.y); }
float gPatch(vec2 xz) { return gVN(xz * 0.04) * 0.65 + gVN(xz * 0.13 + 17.0) * 0.35; }
vec4 gBW; float gGust = 0.0; float gFade = 0.0; float gDist = 0.0; float gMass = 1.0;
vec3 getLocalPosition(vec3 p) {
  #ifdef INSTANCING
    mat4 im = mat4(instance_line1, instance_line2, instance_line3, instance_line4);
    gBW = im * vec4(bladeRoot.x, 0.0, bladeRoot.y, 1.0);
    vec4 bw = gBW;
    float dist = distance(bw.xz, uPlayerPos.xz);
    vec3 patchO = im[3].xyz;
    float h = fract(bladeId * 7.31 + gHash(patchO.xz) * 13.7);
    float h2 = gHash(bw.xz + 5.3);
    // bright clump masses (GrassField.massField per patch: value + gradient at this blade's root)
    gMass = smoothstep(0.0, 0.3, iMass.x + dot(iMass.yz, bladeRoot)) * step(0.02, iDensity);
    float fade = smoothstep(0.06, 0.2, gMass);
    #ifdef SOFT_GRASS
      fade = smoothstep(0.02, 0.1, gMass); // (one continuous sheet, as theirs: the masses no longer cut it into clumps)
    #endif
    float jit = (h2 - 0.5) * 0.36;
    fade *= smoothstep(uGrassBand.x, uGrassBand.y, dist + jit * (uGrassBand.y - uGrassBand.x));
    fade *= 1.0 - smoothstep(uGrassBand.z, uGrassBand.w, dist + jit * (uGrassBand.w - uGrassBand.z));
    float keep = 1.0 - smoothstep(uGrassThin.x, uGrassThin.y, dist) * 0.6;
    fade *= 1.0 - smoothstep(keep - 0.15, keep, h);
    if (flower > 0.5 && gHash(bw.xz) > 0.1) fade = 0.0;
    gFade = fade;
    gDist = dist;
    if (fade <= 0.001) return vec3(bladeRoot.x, 0.0, bladeRoot.y);
    gGust = windGust(bw.xz, uTime, uWind);
    vec2 ax = normalize(im[0].xz), az = normalize(im[2].xz);
    vec2 rootL = bladeRoot;
    vec3 t = vec3(rootL.x, 0.0, rootL.y) + (p - vec3(rootL.x, 0.0, rootL.y)) * fade;
    t.y += dot(iSlope, rootL);
    #ifdef SOFT_GRASS
      t.y *= (0.92 + 0.16 * gHash(bw.xz + 3.1)) * (0.8 + 0.25 * gMass);
    #else
      t.y *= (0.92 + 0.16 * gHash(bw.xz + 3.1)) * (0.25 + 0.95 * gMass);
    #endif
    #ifdef SOFT_GRASS
      t.y *= 0.85; // (a knee-high soft meadow)
    #endif
    t.xz = rootL + (t.xz - rootL) * (1.0 + dist * 0.08);
    float t2 = tip * tip;
    float phase = dot(bw.xz, vec2(0.37, 0.29));
    float sway = (sin(uTime * 2.1 + phase) * 0.4 + sin(uTime * 4.7 + phase * 1.9) * 0.12) * (0.5 + 0.7 * gGust) + gGust * 0.35;
    t.xz += vec2(dot(uWind, ax), dot(uWind, az)) * sway * t2 * 0.036;
    vec2 dp = bw.xz - uPlayerPos.xz;
    float pd = length(dp);
    float push = (1.0 - smoothstep(0.3, 1.2, pd)) * step(abs(bw.y - uPlayerPos.y), 2.0);
    vec2 pl = pd > 1e-3 ? dp / pd : vec2(0.0);
    t.xz += vec2(dot(pl, ax), dot(pl, az)) * push * t2 * 0.4;
    t.y *= 1.0 - push * 0.5;
    return t;
  #else
    return p;
  #endif
}
`
const DECL_VS = /* glsl */ `
attribute vec4 vertex_color; attribute vec3 instanceColor;
uniform vec4 uPalGrass;
varying vec3 vGrassCol; varying float vTip;
`
const MAIN_END_VS = /* glsl */ `
  {
    vec3 c = vertex_color.rgb;
    c = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); // (sRGB bytes → linear)
    #ifdef INSTANCING
      c *= instanceColor;
    #endif
    vec4 bwc = gBW;
    float tn = sin(bwc.x * 0.11 + sin(bwc.z * 0.07) * 3.0) * 0.5 + 0.5;
    float bh = gHash(bwc.xz + 7.7);
    vec3 tipHue = mix(vec3(0.9, 1.05, 0.92), vec3(1.2, 1.08, 0.68), tn) * (0.9 + 0.2 * bh);
    #ifdef SOFT_GRASS
      // SOFT: the ground's own colour, root to tip (the geometry's 0.55 → 1 root shade undone, a faint lighter tip):
      // the field reads as one soft mass, no dark straps or hue flecks
      // (each blade keeps its own stroke: a darker root, a bright tip — theirs read blade by blade, never a smear)
      c *= (0.7 + 0.6 * tip) / (0.55 + 0.45 * tip);
      // (one meadow colour up to the track: the ground's soil tint at the verges drew brown straw)
      if (uPalGrass.w > 0.5) c = mix(c, uPalGrass.rgb * (0.7 + 0.6 * tip), 0.6);
      c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, 0.66) * vec3(1.08, 1.04, 0.88); // (calm warm greens)
    #else
      c *= mix(vec3(1.0), tipHue, tip);
      c *= 1.0 + gGust * 0.1 * tip;
    #endif
    if (flower > 0.5) { float fh = gHash(bwc.xz + 1.3); c = fh > 0.66 ? vec3(0.95, 0.92, 0.82) : fh > 0.33 ? vec3(0.95, 0.72, 0.12) : vec3(0.3, 0.75, 0.95); }
    vGrassCol = c;
    vTip = tip;
  }
`
const DECL_PS = /* glsl */ `
uniform float uWet;
varying vec3 vGrassCol; varying float vTip;
`
/** SOFT: the blades lean toward the ground's up-facing normal — lit with the field, each blade still its own */
const SOFT_NORMAL_PS = /* glsl */ `
void getNormal() {
  dNormalW = normalize(mix(dVertexNormalW, vec3(0.0, 1.0, 0.0), 0.4));
}
`
const ALBEDO_PS = /* glsl */ `
void getAlbedo() {
  dAlbedo = vGrassCol * (1.0 - 0.3 * uWet);
}
`
/** warm soft sunlit (translucent) tips */
const END_EXTRA = /* glsl */ `
    gl_FragColor.rgb += uKeyColor * litArgs_albedo * (pow(max(dot(-V, uKeyDirW), 0.0), 4.0) * 0.2 + 0.1) * vTip;
`

interface GrassData {
  band: { value: THREE.Vector4 }
  thin: { value: THREE.Vector2 }
}

export function grassMaterial(src: THREE.Material, bank: MaterialBank): PcMat {
  void bank
  const d = src.userData.pc as GrassData
  const m = new pc.StandardMaterial()
  m.name = 'grass'
  m.diffuse = new pc.Color(1, 1, 1)
  m.useMetalness = false
  const soft = activeLook().soft
  const def = soft ? '#define SOFT_GRASS\n' : ''
  applyWorldLook(m, { rim: 0.2, toon: 1, declVS: def + DECL_VS, mainEndVS: MAIN_END_VS, declPS: DECL_PS, endExtra: soft ? '' : END_EXTRA })
  const ch = m.getShaderChunks(pc.SHADERLANGUAGE_GLSL)
  ch.set('transformCoreVS', pcGlsl(def + TRANSFORM_CORE_VS))
  if (soft) ch.set('normalMapPS', SOFT_NORMAL_PS)
  ch.set('diffusePS', ALBEDO_PS)
  // (the attribute names → the bridge's semantics; the instance attributes are registered by the same names)
  const taken = new Set<string>([pc.SEMANTIC_ATTR11, pc.SEMANTIC_ATTR12, pc.SEMANTIC_ATTR14, pc.SEMANTIC_ATTR15])
  for (const a of ['tip', 'flower', 'bladeRoot', 'bladeId', 'instanceColor', 'iDensity', 'iSlope', 'iMass']) {
    const sem = attrSemantic(a, taken)
    if (sem) {
      taken.add(sem)
      m.setAttribute(a, sem)
    }
  }
  m.setAttribute('vertex_color', pc.SEMANTIC_COLOR)
  m.cull = pc.CULLFACE_NONE
  m.update()
  const band = new Float32Array(4), thin = new Float32Array(2)
  const sync = () => {
    const b = d.band.value
    band[0] = b.x; band[1] = b.y; band[2] = b.z; band[3] = b.w
    thin[0] = d.thin.value.x; thin[1] = d.thin.value.y
    m.setParameter('uGrassBand', band)
    m.setParameter('uGrassThin', thin)
  }
  sync()
  return { material: m, sync }
}
