import * as pc from 'playcanvas'
import { GUST_GLSL, SWAY_GLSL } from '../../rendering/shaders/uniforms'
import { NOISE } from '../../rendering/shaders/stylize'
import { ATLAS_SURF, PAINT_FRAG_PARS, paintFragPars, STONE_CLIFF_UV } from '../../rendering/shaders/paint'
import { activeLook } from '../look'
import { applyWorldLook } from './common'
import { pcGlsl } from './glsl'

/**
 * VEGETATION on PlayCanvas — trees, plants, roadside props, places (the three build's `vegetation` material): ONE
 * StandardMaterial for the whole forest — the foliage atlas as its diffuse + opacity maps (alpha test 0.42, two-sided,
 * the engine's shadow pass gets the cut-outs for free), with DARK's look in its chunks:
 *  - vertex (every pass — the shadows move with the trees): WIND SWAY (SWAY_GLSL, instanced), canopy NEAR FADE
 *    (cards collapse toward the trunk close to the eye) and camera-facing BILLBOARD tufts (bbCenter / bbOff);
 *  - albedo: atlas × vertex colour × the instance's colour (the bark keeps its own hue, only the brightness), the
 *    PAINTED SURFACES of solids (paint.ts: bark grooves, wood boards, stone, roof shingles — picked by the atlas UV),
 *    SNOW cover on what faces the sky (the instance's snow weight, CPU-side), wet darkening, the far-edge dither;
 *  - light: leaf cards softly WRAPPED (no cel step), solids the toon ramp; a trace of rim on leaves + their backlit
 *    translucency; the shared sky fog.
 * Instance data: the engine's matrix (ATTR11/12/14/15) + ATTR13 = colour rgb + snow (geometry.ts instanceFormat).
 * Mesh extras: bbCenter (ATTR8, vec3), bbOff (ATTR9, vec2).
 */
const DECL_VS = /* glsl */ `
attribute vec4 aInst;
varying vec4 vInst; varying vec3 vPObj; varying vec3 vNObj; varying float vSurf; varying vec3 vBall;
`

/** transformCoreVS: the engine's (no morphing) + DARK's per-vertex motion in getLocalPosition (defined in litUserCodeVS). */
const TRANSFORM_CORE_VS = /* glsl */ `
// (every pass — the shadow casters move with the trees: the motion's inputs are declared here, not forward-only)
uniform float uTime;
uniform vec2 uWind;
uniform vec2 uNearFade;
#ifndef VIEWMATRIX
#define VIEWMATRIX
uniform mat4 matrix_view;
#endif
attribute vec3 bbCenter;
attribute vec2 bbOff;
attribute vec4 vertex_position;
uniform mat4 matrix_viewProjection;
uniform mat4 matrix_model;
#if defined(INSTANCING)
  #include "transformInstancingVS"
#else
  mat4 getModelMatrix() { return matrix_model; }
#endif
vec3 gBbWorld = vec3(0.0);
vec3 gBall = vec3(0.0);
vec3 getLocalPosition(vec3 vertexPosition);
`
/** transformVS: the engine's world position + the billboard's camera-facing world offset. */
const TRANSFORM_VS = /* glsl */ `
vec4 evalWorldPosition(vec3 vertexPosition, mat4 modelMatrix) {
  vec3 localPos = getLocalPosition(vertexPosition);
  vec4 posW = modelMatrix * vec4(localPos, 1.0);
  posW.xyz += gBbWorld;
  return posW;
}
vec4 getPosition() {
  dModelMatrix = getModelMatrix();
  vec4 posW = evalWorldPosition(vertex_position.xyz, dModelMatrix);
  dPositionW = posW.xyz;
  return matrix_viewProjection * posW;
}
vec3 getWorldPosition() { return dPositionW; }
`
const USER_CODE_VS = /* glsl */ `
${GUST_GLSL}
${SWAY_GLSL}
vec3 getLocalPosition(vec3 p) {
  #ifdef INSTANCING
    mat4 im = mat4(instance_line1, instance_line2, instance_line3, instance_line4);
    vec3 io = (matrix_model * vec4(instance_line4.xyz, 1.0)).xyz;
    float depth = -(matrix_view * vec4(io, 1.0)).z;
    float nearK = smoothstep(uNearFade.x, uNearFade.y, depth);
    #ifdef UV0
      vec2 uv = vertex_texCoord0;
      float surf = ${ATLAS_SURF};
      // canopy parts (cards, tufts, the plain canopy cores) collapse toward the trunk close to the eye
      if (surf < -0.5 || abs(surf - 3.0) < 0.5) p.xz *= nearK;
    #endif
    if (dot(bbOff, bbOff) > 0.0) {
      // camera-facing tuft: its centre sways with the tree, the corner offset is laid out in view space
      vec3 c = foliageSway(bbCenter, io.xz, uTime, uWind);
      c.xz *= nearK;
      float bs = length(instance_line1.xyz) * nearK;
      vec3 right = vec3(matrix_view[0][0], matrix_view[1][0], matrix_view[2][0]);
      vec3 up = vec3(matrix_view[0][1], matrix_view[1][1], matrix_view[2][1]);
      gBbWorld = (right * bbOff.x + up * bbOff.y) * bs;
      // (the card's own BALL: its view-plane offset, 1 at the painted clump's rim — the soft look's puffy normal)
      gBall = (right * bbOff.x + up * bbOff.y) / (length(bbOff) * 0.65);
      return c;
    }
    return foliageSway(p, io.xz, uTime, uWind);
  #else
    return p;
  #endif
}
`
const MAIN_END_VS = /* glsl */ `
  #ifdef INSTANCING
    vInst = aInst;
  #else
    vInst = vec4(1.0, 1.0, 1.0, 0.0);
  #endif
  vPObj = vertex_position.xyz;
  vBall = gBall;
  #ifdef NORMALS
    vNObj = vertex_normal;
  #endif
  #ifdef UV0
    { vec2 uv = vertex_texCoord0; vSurf = ${ATLAS_SURF};
      // instance hues tint the LEAVES; the BARK keeps its colour (only the instance's brightness)
      if (uv.x > 0.9775 && uv.x < 0.985 && uv.y < 0.038) vInst.rgb = vec3(dot(vInst.rgb, vec3(0.3, 0.5, 0.2))); }
  #else
    vSurf = 3.0;
  #endif
`

const declPS = (stone?: string) => /* glsl */ `
uniform float uWet; uniform vec2 uCullFade; uniform float uTime;
varying vec4 vInst; varying vec3 vBall;
float gLeaf = 0.0;
${NOISE}
${(stone ? paintFragPars(stone) : PAINT_FRAG_PARS).replace('uniform sampler2D uBrush;', 'uniform sampler2D uBrush;')}
`

/**
 * THE SPRAY CARDS (diffuse AND opacity — the shadow pass cuts the same shape): the soft look moves every card on the
 * spruce sheet (atlas cell 0, 2 × 2 slots: green, dry, twig, green) onto a GREEN frond — the dry sprays and twigs drew
 * brown speckles and see-through gaps — and samples a LEAF texel's colour and cut-out from a coarser mip (uLeafBlur):
 * the needles close into one solid painted FROND (the Over the Hill spruce), the solid block (trunks) stays sharp.
 */
const sprayGlsl = (soft: boolean) => /* glsl */ `
#ifndef DARK_SPRAY_UV
#define DARK_SPRAY_UV
uniform float uLeafBlur;
vec2 sprayUv(vec2 uv) {
  ${soft ? `const vec4 C = vec4(${(10 / 2048).toFixed(5)}, ${(0.5 + 10 / 1024).toFixed(5)}, ${(0.25 - 10 / 2048).toFixed(5)}, ${(1 - 10 / 1024).toFixed(5)});
  if (uv.x > C.x && uv.x < C.z && uv.y > C.y && uv.y < C.w) {
    vec2 st = (uv - C.xy) / (C.zw - C.xy);
    if (st.y > 0.5 && st.x > 0.5) st.x -= 0.5; // dry spray → the green one
    else if (st.y < 0.5 && st.x < 0.5) st.x += 0.5; // twigs → the spare green one
    uv = C.xy + st * (C.zw - C.xy);
  }` : ''}
  return uv;
}
// (the conifer cells — u < 0.25: the spruce sheet, the conifer sprays — get the frond blur; every other leaf, the round
//  discs, stays crisp at its own size)
float frondCell(vec2 uv) { return (uv.x < 0.25 && !(uv.x > 0.95 && uv.y < 0.05)) ? 1.0 : 0.0; }
float leafBias(vec2 uv) { return frondCell(uv) * uLeafBlur; }
#endif
`
const opacityPS = (soft: boolean) => /* glsl */ `
${sprayGlsl(soft)}
uniform float material_opacity;
uniform float material_alphaDitherScale;
void getOpacity() {
  dAlpha = material_opacity;
  #ifdef STD_OPACITY_TEXTURE
    dAlpha *= texture2DBias({STD_OPACITY_TEXTURE_NAME}, sprayUv({STD_OPACITY_TEXTURE_UV}), {STD_TEXTURE_BIAS} + leafBias({STD_OPACITY_TEXTURE_UV})).{STD_OPACITY_TEXTURE_CHANNEL};
  #endif
  // (soft: the blurred cut-out stretched — a frond's body opaque, only its outer FRINGE fades, dithered, soft)
  // MIP-LEVEL ALPHA SCALING (Ben Golus, "Anti-aliased alpha test"): a shrinking texture averages its coverage below the
  // cut-off and the far foliage erodes into thin pencil-like strokes — × (1 + 0.25 · mip level) keeps its full shape
  #ifdef STD_OPACITY_TEXTURE
  {
    vec2 tuv = {STD_OPACITY_TEXTURE_UV} * vec2(2048.0, 1024.0);
    float lod = max(0.0, 0.5 * log2(max(dot(dFdx(tuv), dFdx(tuv)), dot(dFdy(tuv), dFdy(tuv)))));
    dAlpha *= 1.0 + lod * 0.25;
  }
  #endif
  ${soft ? 'dAlpha = mix(dAlpha, smoothstep(0.08, 0.5, dAlpha), frondCell({STD_OPACITY_TEXTURE_UV}));' : ''}
}
`
const albedoPS = (soft: boolean) => /* glsl */ `
${sprayGlsl(soft)}
uniform vec3 material_diffuse;
void getAlbedo() {
  // (far edge of the streamed detail: dissolve with an interleaved-gradient dither — no sorting, no blend)
  float depth = gl_FragCoord.z / gl_FragCoord.w;
  float cf = smoothstep(uCullFade.x, uCullFade.y, depth);
  if (cf > 0.0 && cf >= fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))) discard;
  dAlbedo = material_diffuse.rgb;
  #ifdef STD_DIFFUSE_TEXTURE
    vec4 tx = texture2DBias({STD_DIFFUSE_TEXTURE_NAME}, sprayUv({STD_DIFFUSE_TEXTURE_UV}), {STD_TEXTURE_BIAS} + leafBias({STD_DIFFUSE_TEXTURE_UV}));
    #ifdef SOFT_VEG
      // (un-premultiply: the atlas's clear texels are black — averaged into a coarse mip they drew a dark BORDER on
      //  every leaf card — on the round-leaf clumps a dark rim round EVERY leaf: the crowns read as pencil drawings)
      if (vSurf < -0.5) tx.rgb /= max(tx.a, 0.02);
    #endif
    dAlbedo *= {STD_DIFFUSE_TEXTURE_DECODE}(tx).{STD_DIFFUSE_TEXTURE_CHANNEL};
  #endif
  #ifdef STD_DIFFUSE_VERTEX
    dAlbedo *= saturate(vVertexColor.{STD_DIFFUSE_VERTEX_CHANNEL});
  #endif
  #ifdef SOFT_VEG
    // THE CROWN'S VOLUME: deep inside and low, light at the outer tips and the top — the crown reads as a puffy mass
    // (outer tips at 1.0, not above: with the clumps' ball light the crowns went lime)
    if (vSurf < -0.5) dAlbedo *= mix(0.55, 1.0, smoothstep(0.3, 2.8, length(vPObj.xz))) * mix(0.85, 1.05, smoothstep(1.0, 13.0, vPObj.y));
  #endif
  #ifdef SOFT_VEG
    // (golden larches: a gold instance — r > g — recolours the whole crown from its brightness: green × gold is olive)
    if (vSurf < -0.5) dAlbedo = mix(dAlbedo, vec3(1.0, 0.74, 0.2) * (0.5 + 2.4 * dot(dAlbedo, vec3(0.2126, 0.7152, 0.0722))), smoothstep(0.05, 0.2, vInst.r - vInst.g));
  #endif
  dAlbedo *= vInst.rgb;
  gLeaf = vSurf < -0.5 ? 1.0 : 0.0;
  #ifdef SOFT_VEG
    // (CALM greens, as theirs: about a third of the saturation out, a touch warmer and lighter — soft pastel foliage)
    if (gLeaf > 0.5) dAlbedo = mix(mix(vec3(dot(dAlbedo, vec3(0.2126, 0.7152, 0.0722))), dAlbedo, 0.88) * vec3(1.06, 1.04, 0.9) * (1.0 + 0.35 * frondCell(vUv0)), dAlbedo, smoothstep(0.05, 0.2, vInst.r - vInst.g)); // (the golden larches stay vivid)
  #endif
  #ifdef SOFT_VEG
    // (the soft look: PLAIN solids — the pines' skirts, canopy cores — stay one clean colour; bark, wood, roofs keep their paint)
    if (vSurf > -0.5 && abs(vSurf - 3.0) > 0.5) dAlbedo = paintSurface(dAlbedo, floor(vSurf + 0.5));
  #else
    if (vSurf > -0.5) dAlbedo = paintSurface(dAlbedo, floor(vSurf + 0.5));
  #endif
  // SNOW on what faces the sky (the instance's snow weight): clumps on the branch tops, needles between and beneath
  if (vInst.w > 0.01) {
    vec3 P = vPositionW;
    float bn = st_noise(P.xz * 1.4 + vec2(P.y * 0.9));
    float up = normalize(dVertexNormalW).y + (bn - 0.5) * 0.55;
    float cover = vInst.w * smoothstep(0.0, 0.55, up) * (gl_FrontFacing ? 1.0 : 0.4);
    cover *= 0.9 * smoothstep(0.38, 0.62, bn * 0.55 + st_noise(P.xz * 0.35 + vec2(P.y * 0.5, 3.7)) * 0.45 + 0.25 * (up - 0.4));
    dAlbedo = mix(dAlbedo, vec3(0.8, 0.85, 0.93) * (0.92 + 0.12 * bn), cover);
  }
  dAlbedo *= 1.0 - 0.3 * uWet;
}
`
/**
 * THE SOFT LOOK's leaf normal — the PUFFY crown (Over the Hill's aspens; 2026-10-25, the user: ours look "drawn with
 * paper and pencil"): a camera-facing clump card is lit as a small BALL (its view-plane offset vBall + the way to the
 * eye), mixed with the crown's rounded normal — every clump bulges with its own lit top and shaded underside, the crown
 * reads as a pile of soft lumps. (The billboard's facet alone faces the eye: every card lit alike — a flat drawing.)
 * Flat spray cards keep half the crown normal, half their facet (turned to the crown's side). Solids: the vertex normal.
 */
const SOFT_NORMAL_PS = /* glsl */ `
void getNormal() {
  vec3 N = normalize(dVertexNormalW);
  if (gLeaf > 0.5) {
    // (screen derivatives: on a billboard their cross points at the eye — the view direction isn't known yet here)
    vec3 F = normalize(cross(dFdx(vPositionW), dFdy(vPositionW)));
    float r2 = dot(vBall, vBall);
    if (r2 > 0.0) {
      vec3 B = normalize(vBall + F * sqrt(max(1.0 - r2, 0.0)));
      N = normalize(mix(N, B, 0.62));
    } else {
      F *= sign(dot(F, N) + 1e-4);
      N = normalize(mix(N, F, 0.5));
    }
  }
  dNormalW = N;
}
`
/**
 * Leaf cards: a long soft wrap across the crown (the far side ~40 % lit; soft: ~15 % — the sky fill lifts it, the
 * clumps' undersides read as shade and the volume shows); solids: the toon ramp.
 */
const lambertPS = (soft: boolean) => /* glsl */ `
${soft ? 'uniform float uDetailLight;' : ''}
float getLightDiffuse(vec3 worldNormal, vec3 viewDir, vec3 lightDirNorm) {
  float nl = dot(worldNormal, -lightDirNorm);
  if (gLeaf > 0.5) return ${soft ? 'mix(mix(0.4, 0.15, uDetailLight), 1.0, smoothstep(-0.35, 0.85, nl))' : 'mix(0.4, 1.0, smoothstep(-0.5, 0.95, nl))'};
  float d = max((nl + uWrap) / (1.0 + uWrap), 0.0);
  return mix(d, smoothstep(0.0, 0.16, d) * 0.82 + d * 0.18, uToon * uToonK);
}
`
/** (after the rim: leaves keep only a trace of it, and glow through against the sun) */
const LEAF_END = /* glsl */ `
    if (gLeaf > 0.5) gl_FragColor.rgb += uKeyColor * litArgs_albedo * (back * 0.15 - pow(1.0 - ndv, 3.0) * (0.3 + back * 1.4) * uRim * uRimK * 0.8);
`

export interface VegetationOpts {
  /** rim strength (bright: 1.1) */
  rim?: number
  /** STONE brush coordinates (cliff-scale strokes for formations) */
  stone?: string
  name?: string
  /** drawn over its depth pre-pass (createVegetationDepthMaterial): depth test ≤, no depth write */
  prepassed?: boolean
}

export function createVegetationMaterial(atlas: pc.Texture, o: VegetationOpts = {}): pc.StandardMaterial {
  const m = new pc.StandardMaterial()
  m.name = o.name ?? 'vegetation'
  m.diffuse = new pc.Color(1, 1, 1)
  m.diffuseMap = atlas
  m.diffuseVertexColor = true
  ;(m as unknown as { vertexColorGamma: boolean }).vertexColorGamma = true
  m.opacityMap = atlas
  m.opacityMapChannel = 'a'
  const soft = activeLook().soft
  // (the soft look: the blurred cut-out is tested lower — the frond fills out to its painted silhouette)
  m.alphaTest = soft ? 0.3 : 0.42
  m.cull = pc.CULLFACE_NONE
  applyWorldLook(m, { rim: o.rim ?? 1.1, toon: 1, declVS: DECL_VS, mainEndVS: MAIN_END_VS, declPS: (soft ? '#define SOFT_VEG\n' : '') + declPS(o.stone), endExtra: LEAF_END })
  const ch = m.getShaderChunks(pc.SHADERLANGUAGE_GLSL)
  ch.set('transformCoreVS', TRANSFORM_CORE_VS)
  ch.set('transformVS', TRANSFORM_VS)
  ch.set('litUserCodeVS', pcGlsl(USER_CODE_VS))
  ch.set('diffusePS', albedoPS(soft))
  ch.set('opacityPS', opacityPS(soft))
  if (soft) ch.set('normalMapPS', SOFT_NORMAL_PS)
  ch.set('lightDiffuseLambertPS', lambertPS(soft))
  m.setAttribute('aInst', pc.SEMANTIC_ATTR13)
  m.setAttribute('bbCenter', pc.SEMANTIC_ATTR8)
  m.setAttribute('bbOff', pc.SEMANTIC_ATTR9)
  if (o.prepassed) {
    // (drawn after its DEPTH PRE-PASS twin — createVegetationDepthMaterial: the depth is already there, so only the
    //  frontmost leaf pixel passes the test and is lit; no depth write of its own)
    m.depthWrite = false
    m.depthFunc = pc.FUNC_LESSEQUAL
  }
  m.update()
  return m
}

/** The depth pre-pass's albedo: nothing — only the far-edge dither the lit pass applies (the same pixels dissolve). */
const DEPTH_ALBEDO_PS = /* glsl */ `
uniform vec2 uCullFade;
void getAlbedo() {
  float depth = gl_FragCoord.z / gl_FragCoord.w;
  float cf = smoothstep(uCullFade.x, uCullFade.y, depth);
  if (cf > 0.0 && cf >= fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))) discard;
  dAlbedo = vec3(0.0);
}
`

/**
 * THE LEAVES' DEPTH PRE-PASS (2026-10-25: the leaf cards were half the frame — every crown is many alpha-tested cards
 * deep and each card's pixels were lit and fogged before the next card covered them): the same vertex motion (sway,
 * billboards, near fade) and the same cut-out, no lighting, no colour — it only writes depth, in a layer drawn before
 * the world. The lit pass (`prepassed`) then shades each pixel once. Cost: the leaves' vertices twice (cheap: the
 * cards are few vertices, many pixels).
 */
export function createVegetationDepthMaterial(atlas: pc.Texture): pc.StandardMaterial {
  const m = new pc.StandardMaterial()
  m.name = 'vegetationDepth'
  m.useLighting = false
  m.useFog = false
  m.useSkybox = false
  m.diffuse = new pc.Color(0, 0, 0)
  m.opacityMap = atlas
  m.opacityMapChannel = 'a'
  const soft = activeLook().soft
  m.alphaTest = soft ? 0.3 : 0.42
  m.cull = pc.CULLFACE_NONE
  m.redWrite = m.greenWrite = m.blueWrite = m.alphaWrite = false
  const ch = m.getShaderChunks(pc.SHADERLANGUAGE_GLSL)
  ch.set('transformCoreVS', TRANSFORM_CORE_VS)
  ch.set('transformVS', TRANSFORM_VS)
  ch.set('litUserCodeVS', pcGlsl(USER_CODE_VS))
  ch.set('diffusePS', DEPTH_ALBEDO_PS)
  ch.set('opacityPS', opacityPS(soft))
  m.setAttribute('bbCenter', pc.SEMANTIC_ATTR8)
  m.setAttribute('bbOff', pc.SEMANTIC_ATTR9)
  m.update()
  return m
}
export { STONE_CLIFF_UV }
