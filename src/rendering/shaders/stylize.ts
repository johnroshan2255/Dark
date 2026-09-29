import * as THREE from 'three'
import { SKY_GLSL, skyUniforms } from '../sky/skyShader'
import { globalUniforms, GUST_GLSL } from './uniforms'
import { isStorybook } from '../artStyle'
import { ATLAS_SURF, PAINT_FRAG_PARS, PAINT_VERT_PARS, paintVert } from './paint'
import { WorldFields } from '../../world/WorldFields'

const WATER_LEVEL = WorldFields.WATER

/**
 * Shared "painterly" patch for every world material (Lambert-based), per refer/roads hero:
 *  - RIM light: silhouettes facing the key light (sun/moon) catch a warm/cool edge — the orange-rimmed
 *    trees of the reference. ~6 ALU/fragment.
 *  - SKY-COLOURED FOG (aerial perspective): fogged geometry fades to the sky colour in its direction
 *    (sky/skyShader.ts) — sun glow, sunset band and mountain ridges show through distant hills.
 *  - optional: no back-face normal flip (foliage cards / grass light like their volume, not black behind)
 *  - optional TERRAIN detail: world-space noise breakup + painted ROAD (asphalt grain, cracks, worn yellow
 *    centre dashes, broken white edge lines, gravel shoulders) from the per-vertex `roadLat` attribute —
 *    zero extra geometry or draw calls.
 * Composes with an existing onBeforeCompile (e.g. grass wind). One program variant per `key`.
 */
export interface StylizeOptions {
  key: string
  rim?: number
  noFlip?: boolean
  terrain?: boolean
  /** Scale on the fog factor (monsters use < 1 so their silhouettes read through the haze). */
  fogAmount?: number
  /** Near-only geometry (grass): plain fog colour instead of the per-vertex sky colour (saves ~100 ALU/vertex). */
  cheapFog?: boolean
  /** Cel-shading weight for this material (× the global uToon). Terrain uses less so hills keep their shape. */
  toon?: number
  /** Dither out past the streamed-detail edge (uCullFade): trees/props dissolve into the horizon hills. */
  cullFade?: boolean
  /** Keep real lighting in the STORYBOOK art style (monsters: their rim-lit silhouettes are the gameplay read). */
  lit?: boolean
  /** Hand-painted solid surfaces (shaders/paint.ts): 'atlas' = picked per vertex by the atlas UV, or one SURFACE id. */
  surface?: 'atlas' | number
}

/**
 * STORYBOOK palette (forest-house study): our Genshin albedos → its pale pastel sage painting. Hue kept,
 * saturation halved, luminance lifted and compressed (dark greens become mid sage, nothing is near-black or
 * glaring), a slight warm-sage cast. ~12 ALU. Linear space.
 */
const STORY_GLSL = /* glsl */ `
uniform float uStoryAmt; uniform vec3 uStoryLight; uniform vec3 uUpView;
vec3 storyPalette(vec3 c) {
  c = max(c, vec3(0.0));
  float l = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
  vec3 ch = mix(vec3(1.0), c / l, 0.5);
  vec3 o = ch * (0.05 + 0.66 * sqrt(l));
  return o * vec3(1.0, 1.0, 0.9);
}`

const NOISE = /* glsl */ `
float st_hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float st_noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(st_hash(i), st_hash(i + vec2(1.0, 0.0)), f.x), mix(st_hash(i + vec2(0.0, 1.0)), st_hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`

export function stylize<T extends THREE.Material>(material: T, o: StylizeOptions): T {
  const prev = material.onBeforeCompile.bind(material)
  const rim = o.rim ?? 0.5
  const story = isStorybook() && !o.lit
  material.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer)
    const u = globalUniforms
    Object.assign(shader.uniforms, {
      uKeyDirView: u.uKeyDirView,
      uKeyColor: u.uKeyColor,
      uScatterColor: u.uScatterColor,
      uScatterAmount: u.uScatterAmount,
      uRim: { value: rim },
      uToon: u.uToon,
      uTimeS: globalUniforms.uTime,
      uWindS: globalUniforms.uWind,
      uBrush: u.uBrush,
      uStoryAmt: u.uStoryAmt,
      uStoryLight: u.uStoryLight,
      uUpView: u.uUpView,
      uFogMax: u.uFogMax,
      uLandHaze: u.uLandHaze,
      uFarEdge: u.uFarEdge,
      uCullFade: u.uCullFade,
      ...skyUniforms,
    })
    let vs = shader.vertexShader
    let fs = shader.fragmentShader
    // Sky-coloured fog: the sky colour in the fragment's direction, evaluated PER VERTEX (it varies smoothly;
    // per-pixel it cost ~1 ms at 1080p on HIGH — measured) and interpolated.
    vs = vs
      .replace('#include <common>', `#include <common>\n${vs.includes('uSkyHorizon') ? '' : SKY_GLSL}\nvarying vec3 vFogSky;`)
      .replace('#include <fog_vertex>', o.cheapFog ? '#include <fog_vertex>\nvFogSky = vec3(-1.0);' : `#include <fog_vertex>\nvFogSky = skyColor(normalize((vec4(normalize(mvPosition.xyz), 0.0) * viewMatrix).xyz), false);`)
    if (o.terrain) {
      vs = vs
        .replace('#include <common>', '#include <common>\nattribute float roadLat;\nattribute vec2 roadNet;\nvarying float vRoadLat;\nvarying vec2 vRoadNet;\nvarying vec3 vWorldPos;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvRoadLat = roadLat;\nvRoadNet = roadNet;\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    }
    if (o.surface !== undefined) {
      const surf = o.surface === 'atlas' ? ATLAS_SURF : o.surface.toFixed(1)
      vs = vs
        .replace('#include <common>', `#include <common>\n${PAINT_VERT_PARS}`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n${paintVert(surf)}`)
    }
    // Declare only what an earlier patch (e.g. grass) hasn't declared already.
    const decl = (d: string) => (fs.includes(d) ? '' : d + '\n')
    fs = fs.replace(
      '#include <common>',
      `#include <common>
${decl('uniform vec3 uKeyDirView;')}${decl('uniform vec3 uKeyColor;')}uniform vec3 uScatterColor; uniform float uScatterAmount; uniform float uRim; uniform float uToon; uniform float uTimeS; uniform vec2 uWindS;
uniform vec2 uSkyHaze;
uniform float uFogMax; uniform vec3 uLandHaze; uniform vec2 uFarEdge; uniform vec2 uCullFade;
float skyHaze(float d) { return uSkyHaze.x * (1.0 - exp(-max(d - 12.0, 0.0) / uSkyHaze.y)); }
varying vec3 vFogSky;
${o.terrain || o.surface !== undefined ? 'uniform sampler2D uBrush;\n' : ''}${o.surface !== undefined ? PAINT_FRAG_PARS.replace('uniform sampler2D uBrush;', '') : ''}
${o.terrain ? 'varying float vRoadLat; varying vec2 vRoadNet; varying vec3 vWorldPos;\n' + NOISE + GUST_GLSL : ''}
${story ? STORY_GLSL : ''}`,
    )
    // Genshin CEL SHADING: N·L through a narrow ramp → lit / shadow sides with a crisp soft-edged terminator
    // (a little linear falloff kept so volumes still read). Shadows stay light because the sky fill is bright.
    fs = fs.replace(
      '#include <lights_lambert_pars_fragment>',
      THREE.ShaderChunk.lights_lambert_pars_fragment.replace(
        'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );',
        `float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
  dotNL = mix(dotNL, smoothstep(0.0, 0.16, dotNL) * 0.82 + dotNL * 0.18, uToon * ${(o.toon ?? 1).toFixed(2)});`,
      ),
    )
    if (o.cullFade) {
      // Interleaved-gradient dither: fragments vanish progressively across the fade band (no sorting, no blend).
      fs = fs.replace(
        '#include <alphatest_fragment>',
        `#ifdef USE_FOG
  { float cf = smoothstep(uCullFade.x, uCullFade.y, vFogDepth);
    if (cf > 0.0 && cf >= fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))) discard; }
#endif
#include <alphatest_fragment>`,
      )
    }
    if (o.noFlip) {
      fs = fs.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'))
    }
    if (o.surface !== undefined) {
      fs = fs.replace('#include <color_fragment>', '#include <color_fragment>\nif (vSurf > -0.5) diffuseColor.rgb = paintSurface(diffuseColor.rgb, floor(vSurf + 0.5));')
    }
    if (o.terrain) {
      fs = fs.replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
{
  vec2 wp = vWorldPos.xz;
  float n1 = st_noise(wp * 0.33), n2 = st_noise(wp * 1.9), n3 = st_hash(floor(wp * 6.0));
  diffuseColor.rgb *= 0.82 + 0.22 * n1 + 0.12 * n2 + 0.05 * st_noise(wp * 7.0);
  // Painted ground (BrushTexture, 1 fetch): ~1.5 m brush strokes + soft watercolour blotches, strokes
  // running across the slope like a painter's dabs.
  vec4 gb = texture2D(uBrush, wp * 0.045);
  diffuseColor.rgb *= 0.9 + 0.2 * gb.g + 0.26 * (gb.r - 0.5);
  // Painted meadow beyond the real grass (Genshin): on green ground, soft blade streaks + the same rolling
  // wind-gust bands as the grass, so the meadow reads continuous to the horizon.
  float green = smoothstep(0.0, 0.03, diffuseColor.g - diffuseColor.b) * smoothstep(0.0, 0.02, diffuseColor.g - diffuseColor.r * 0.8);
  float streak = st_noise(vec2(wp.x * 6.0 + wp.y * 1.5, wp.y * 6.0 - wp.x * 1.5));
  diffuseColor.rgb *= 1.0 + green * ((streak - 0.5) * 0.14 + windGust(wp, uTimeS, uWindS) * 0.14);
  // Under water: the bed darkens and turns blue-green with depth (seen through the semi-clear water);
  // a soft foam/wet line right at the shore.
  float wd = ${WATER_LEVEL.toFixed(2)} - vWorldPos.y;
  diffuseColor.rgb *= 1.0 - 0.35 * smoothstep(-0.8, 0.0, wd) * step(wd, 0.0) * 0.5; // wet dark band above
  if (wd > 0.0) diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.5, 0.66, 0.7), vec3(0.015, 0.045, 0.055), smoothstep(0.0, 3.5, wd));
  diffuseColor.rgb += vec3(0.25, 0.27, 0.27) * (1.0 - smoothstep(0.0, 0.18, abs(wd - 0.04))) * (0.5 + 0.5 * st_noise(wp * 3.0 + vec2(uTimeS * 0.3)));
  float lat = abs(vRoadLat);
  const float HALF = 2.7;
  if (lat < HALF + 1.6) {
    float a3 = st_noise(wp * 6.0);
    // Weathered grey-blue country asphalt with lighter worn/patched areas (refer/roads).
    float worn = smoothstep(0.45, 0.8, st_noise(wp * 0.18 + 11.0));
    vec3 asphalt = mix(vec3(0.19, 0.2, 0.24), vec3(0.3, 0.3, 0.32), worn * 0.7) * (0.82 + 0.24 * n2 + 0.12 * a3);
    // Hairline cracks, broken into fragments (contour of one noise, masked by another).
    float cn = st_noise(wp * 1.3 + 7.0) - 0.5;
    float crack = (1.0 - smoothstep(0.0, fwidth(cn) * 1.2 + 1e-4, abs(cn))) * smoothstep(0.55, 0.75, st_noise(wp * 0.9 + 3.0)); // ~1 px wide at any distance
    asphalt *= 1.0 - crack * 0.3;
    // Faded, worn centre dashes only (no edge lines on a back road).
    float dash = step(fract(vWorldPos.z / 9.0), 0.4) * (1.0 - smoothstep(0.06, 0.1, lat));
    asphalt = mix(asphalt, vec3(0.55, 0.45, 0.2), dash * (0.3 + 0.35 * a3) * (1.0 - worn * 0.5));
    float g1 = st_noise(wp * 9.0), g2 = st_noise(wp * 23.0);
    vec3 gravel = vec3(0.27, 0.23, 0.18) * (0.72 + 0.28 * g1 + 0.22 * g2 + 0.1 * n2);
    vec3 road = mix(asphalt, gravel, smoothstep(HALF - 0.1, HALF + 0.25, lat));
    diffuseColor.rgb = mix(diffuseColor.rgb, road, 1.0 - smoothstep(HALF + 0.9, HALF + 1.6, lat));
  }
  // Secondary roads: GRAVEL (type 0: grey-brown stones, two darker wheel ruts) / TRAIL (type 1: packed dirt,
  // grass strip down the middle). vRoadNet.x = distance from the road EDGE (<0 on it).
  if (vRoadNet.y > -0.5 && vRoadNet.x < 1.2) {
    float e = vRoadNet.x;
    float s1 = st_noise(wp * 8.0), s2 = st_hash(floor(wp * 5.0)), s3 = st_noise(wp * 0.7);
    vec3 surf;
    if (vRoadNet.y < 0.5) {
      surf = vec3(0.3, 0.27, 0.22) * (0.75 + 0.3 * s1 + 0.12 * s2);
      float rut = (1.0 - smoothstep(0.25, 0.5, abs(-e - 0.9))) ;               // ~0.9 m in from each edge
      surf *= 1.0 - rut * 0.25;
    } else {
      surf = vec3(0.28, 0.21, 0.14) * (0.78 + 0.25 * s1 + 0.1 * s3);
      float mid = 1.0 - smoothstep(0.0, 0.35, abs(-e - 1.35));                 // centre of a 2.7 m track
      surf = mix(surf, diffuseColor.rgb * 1.1, mid * 0.75 * step(0.35, s3));   // grass strip
    }
    diffuseColor.rgb = mix(diffuseColor.rgb, surf, 1.0 - smoothstep(-0.2, 1.2 + 0.5 * s1, e));
  }
}`,
      )
    }
    if (story) {
      // Palette after every albedo patch (vertex colour, painted surfaces, terrain/road) and before lighting.
      fs = fs.replace('#include <alphamap_fragment>', 'diffuseColor.rgb = storyPalette(diffuseColor.rgb);\n#include <alphamap_fragment>')
      // UNLIT painting: albedo × painted light, sky-facing sides lighter (the baked "top light" of the
      // reference). Replaces the lit result by uStoryAmt (1 by day; less at night so the flashlight/moon work).
      fs = fs.replace(
        '#include <opaque_fragment>',
        `{
  float upk = dot(normal, uUpView) * 0.5 + 0.5;
  vec3 painted = diffuseColor.rgb * uStoryLight * (0.74 + 0.3 * upk);
  outgoingLight = mix(outgoingLight, painted, uStoryAmt);
}
#include <opaque_fragment>`,
      )
    }
    fs = fs
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `{
  vec3 V = normalize(vViewPosition);
  float ndv = clamp(dot(normal, V), 0.0, 1.0);
  float back = pow(clamp(dot(-V, uKeyDirView), 0.0, 1.0), 2.0);
  outgoingLight += uKeyColor * diffuseColor.rgb * pow(1.0 - ndv, 3.0) * (0.3 + back * 1.4) * uRim${story ? ' * (1.0 - uStoryAmt)' : ''};
}
#include <opaque_fragment>`,
      )
      .replace(
        '#include <fog_fragment>',
        /* glsl */ `#ifdef USE_FOG
  float fogFactor = max(smoothstep(fogNear, fogFar, vFogDepth), skyHaze(vFogDepth)) * ${(o.fogAmount ?? 1).toFixed(3)};
  vec3 fogCol = vFogSky.r < 0.0 ? fogColor : vFogSky;
  // Distant LAND keeps its shape under a blue-green aerial tint (never a white wall); only the horizon
  // mesh's outer rim dissolves fully into the sky colour.
  float rim = smoothstep(uFarEdge.x, uFarEdge.y, vFogDepth);
  fogFactor = max(min(fogFactor, uFogMax), rim);
  fogCol = mix(fogCol * uLandHaze, fogCol, rim);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogCol, fogFactor);
#endif`,
      )
    shader.vertexShader = vs
    shader.fragmentShader = fs
  }
  const prevKey = material.customProgramCacheKey.bind(material)
  material.customProgramCacheKey = () => `${prevKey()}|stylize-${o.key}${story ? '-story' : ''}`
  return material
}
