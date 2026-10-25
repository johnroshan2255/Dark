import * as pc from 'playcanvas'
import { NOISE, hillStoneGLSL } from '../../rendering/shaders/stylize'
import { SURFACE_NOISE_GLSL } from '../../rendering/shaders/surfaceNoise'
import { activeLook } from '../look'
import { applyWorldLook } from './common'

/**
 * ROCK on PlayCanvas — the boulders (instanced, 'rock') and the rock formations / crags (merged chunk meshes, 'cliff'):
 * the three build's rock / cliffRock materials (bright): the procedural ROUGHNESS of surfaceNoise.ts (surfRock: lumps,
 * grit, fractures — surfCliff: beds, masses, flutes, joints) as colour AND relief tilting the normal, the HILL TINT
 * (the hills' own stone where the map has one: palette `cliff`), a PAINTED snow edge on what faces the sky (long
 * horizontal brush strokes), wet darkening, a soft toon ramp. Vertices with aPlain = 1 (the bridges' planks and the
 * camps' tents sharing the formation mesh) skip the rock surface.
 * Snow: instanced → the instance's w (geometry.ts instanceFormat); the pooled formations (RangePool) → the same
 * ATTR13 as a per-VERTEX stream ((1, 1, 1, the chunk's snow) baked into their range).
 */
const DECL_VS = /* glsl */ `
attribute vec4 aInst; attribute float aPlain;
varying vec4 vInst; varying float vPlain;
`
const MAIN_END_VS = /* glsl */ `
  vInst = aInst;
  // (only the pooled formations carry aPlain: the instanced boulders' program must not read a stream they lack)
  #ifdef INSTANCING
    vPlain = 0.0;
  #else
    vPlain = aPlain;
  #endif
`
const DECL_PS = /* glsl */ `
uniform float uWet; uniform vec2 uCullFade; uniform float uSurfaceDetail; uniform vec4 uCliffStone;
uniform float uDetailK;
#define SN_DETAIL_K uDetailK
varying vec4 vInst; varying float vPlain;
vec3 rockBump = vec3(0.0);
${NOISE}
${hillStoneGLSL(false)}
${SURFACE_NOISE_GLSL}
`
const albedoPS = (cliff: boolean) => /* glsl */ `
uniform vec3 material_diffuse;
void getAlbedo() {
  float depth = gl_FragCoord.z / gl_FragCoord.w;
  float cf = smoothstep(uCullFade.x, uCullFade.y, depth);
  // (the CLIFFS keep early depth rejection: a discard anywhere in the shader turns it off — Zhangjiajie's pillars stand
  //  layers deep and every hidden layer was shaded; their far edge dissolves in the rim fog instead)
  ${cliff ? '' : 'if (cf > 0.0 && cf >= fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))) discard;'}
  vec3 c = material_diffuse.rgb;
  #ifdef STD_DIFFUSE_VERTEX
    c *= saturate(vVertexColor.{STD_DIFFUSE_VERTEX_CHANNEL});
  #endif
  c *= vInst.rgb;
  vec3 P = vPositionW;
  vec3 nW = normalize(dVertexNormalW);
  if (vPlain < 0.5) {
    if (uCliffStone.w > 0.5) {
      float rl = dot(c, vec3(0.2126, 0.7152, 0.0722));
      vec3 hs = hillStone(st_noise(P.xz * 0.008 + vec2(P.y * 0.01)));
      hs *= mix(vec3(1.0), vec3(0.9, 0.96, 1.08), vInst.w);
      c = hs * clamp(rl / ${cliff ? '0.47' : '0.21'}, 0.6, 1.3);
    }
    c = ${cliff ? 'surfCliff' : 'surfRock'}(c, P, nW, length(P - uCamPos));
    rockBump = surfBump;
    // PAINTED snow edge on rock (bright): long horizontal brush strokes break the line
    if (vInst.w > 0.01) {
      float bn = st_noise(P.xz * 1.4 + vec2(P.y * 0.9));
      float sk = st_noise(vec2((P.x + P.z) * 0.35, P.y * 3.2)) * 0.65 + st_noise(vec2((P.x - P.z) * 1.1, P.y * 9.0)) * 0.35;
      float up = nW.y + (sk - 0.5) * 0.9;
      float cover = vInst.w * smoothstep(0.05, 0.4, up);
      c = mix(c, vec3(0.8, 0.85, 0.93) * (0.92 + 0.12 * bn), cover);
    }
  }
  dAlbedo = c * (1.0 - 0.3 * uWet);
}
`
/**
 * THE SOFT ROCK (map.json look 'soft' — the Over the Hill reference: low-poly stones, smoothly shaded, ONE colour): the
 * stone tone (the map's hill stone, the instance's tint, the geometry's darker foot) with only a broad drift; the
 * crumpled RELIEF texture (uRelief) on the three planes facing the rock's axes, blended by the normal, faint — the light
 * shapes it; a soft snow cap. No procedural surface noise: 3 fetches.
 */
const softAlbedoPS = (cliff: boolean) => /* glsl */ `
uniform vec3 material_diffuse;
uniform sampler2D uRelief;
vec3 sRockN = vec3(0.0);
void getAlbedo() {
  float depth = gl_FragCoord.z / gl_FragCoord.w;
  float cf = smoothstep(uCullFade.x, uCullFade.y, depth);
  // (the CLIFFS keep early depth rejection: a discard anywhere in the shader turns it off — Zhangjiajie's pillars stand
  //  layers deep and every hidden layer was shaded; their far edge dissolves in the rim fog instead)
  ${cliff ? '' : 'if (cf > 0.0 && cf >= fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))) discard;'}
  vec3 c = material_diffuse.rgb;
  #ifdef STD_DIFFUSE_VERTEX
    c *= saturate(vVertexColor.{STD_DIFFUSE_VERTEX_CHANNEL});
  #endif
  c *= vInst.rgb;
  vec3 P = vPositionW;
  vec3 nW = normalize(dVertexNormalW);
  if (vPlain < 0.5) {
    if (uCliffStone.w > 0.5) {
      float rl = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = uCliffStone.rgb * ${cliff ? '0.85' : '0.8'} * clamp(rl / ${cliff ? '0.47' : '0.21'}, 0.75, 1.2);
    }
    c *= 0.95 + 0.1 * st_noise(P.xz * 0.05 + vec2(P.y * 0.05));
    // the relief on the three axis planes, weighted by the normal (sharpened: few seams)
    vec3 w = pow(abs(nW), vec3(4.0));
    w /= w.x + w.y + w.z;
    vec4 rx = texture2D(uRelief, P.zy * 0.25), ry = texture2D(uRelief, P.xz * 0.25), rz = texture2D(uRelief, P.xy * 0.25);
    vec2 dx = rx.rg * 2.0 - 1.0, dy = ry.rg * 2.0 - 1.0, dz = rz.rg * 2.0 - 1.0;
    sRockN = vec3(0.0, dx.y, dx.x) * w.x + vec3(dy.x, 0.0, dy.y) * w.y + vec3(dz.x, dz.y, 0.0) * w.z;
    float hgt = rx.b * w.x + ry.b * w.y + rz.b * w.z;
    c *= 1.0 - 0.03 * (1.0 - smoothstep(0.25, 0.6, hgt));
    if (vInst.w > 0.01) {
      float up = nW.y + (st_noise(P.xz * 0.4 + vec2(P.y * 0.3)) - 0.5) * 0.4;
      c = mix(c, vec3(0.84, 0.88, 0.95), vInst.w * smoothstep(0.1, 0.55, up));
    }
  }
  dAlbedo = c * (1.0 - 0.3 * uWet);
}
`
const SOFT_NORMAL_PS = /* glsl */ `
uniform float uDetailLight;
void getNormal() {
  dNormalW = dVertexNormalW;
  if (vPlain < 0.5) dNormalW = normalize(dNormalW + sRockN * 0.12 * uDetailLight);
}
`
const NORMAL_PS = /* glsl */ `
void getNormal() {
  dNormalW = dVertexNormalW;
  if (vPlain < 0.5 && dot(rockBump, rockBump) > 1e-8) dNormalW = normalize(dNormalW + rockBump);
}
`

export function createRockMaterial(kind: 'rock' | 'cliff'): pc.StandardMaterial {
  const m = new pc.StandardMaterial()
  m.name = kind === 'cliff' ? 'cliffRock' : 'rock'
  m.diffuse = new pc.Color(1, 1, 1)
  m.diffuseVertexColor = true
  ;(m as unknown as { vertexColorGamma: boolean }).vertexColorGamma = true
  applyWorldLook(m, { rim: 0.2, toon: 0.12, declVS: DECL_VS, mainEndVS: MAIN_END_VS, declPS: DECL_PS })
  const ch = m.getShaderChunks(pc.SHADERLANGUAGE_GLSL)
  const soft = activeLook().soft
  ch.set('diffusePS', soft ? softAlbedoPS(kind === 'cliff') : albedoPS(kind === 'cliff'))
  ch.set('normalMapPS', soft ? SOFT_NORMAL_PS : NORMAL_PS)
  m.setAttribute('aInst', pc.SEMANTIC_ATTR13)
  m.setAttribute('aPlain', pc.SEMANTIC_ATTR10)
  m.update()
  return m
}
