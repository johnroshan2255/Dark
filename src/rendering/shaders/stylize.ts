import * as THREE from 'three'
import { MIST_GLSL, SKY_GLSL, skyUniforms } from '../sky/skyShader'
import { globalUniforms, GUST_GLSL, SWAY_GLSL } from './uniforms'
import { isGenshin, isOverland, isStorybook } from '../artStyle'
import { ATLAS_SURF, PAINT_VERT_PARS, STONE_CLIFF_UV, paintFragPars, paintVert } from './paint'
import { WorldFields } from '../../world/WorldFields'
import { BIOME_GLSL } from '../biome/BiomeMap'

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
  /** Foliage cards (atlas surface < 0) dither out within uNearFade of the camera: driving through a forest never
   *  leaves the eye stuck inside leaves. Requires `surface: 'atlas'`. */
  nearFade?: boolean
  /** Trees bend and flutter with the wind (instanced foliage): uniforms.ts `foliageSway`. */
  sway?: boolean
  /** Darken with ground wetness (uWet): rain-soaked grass, bark, rocks. */
  wet?: boolean
  /**
   * BIOME COVER from the biome map (rendering/biome/BiomeMap.ts, 1 vertex texture fetch): in the snow, up-facing
   * surfaces (tree shelves, rock tops, roofs) carry snow broken up by noise; 'rock' also gets layered sandstone
   * STRATA in the desert. Per instance (keyed by its origin) for instanced meshes, per vertex for merged ones.
   */
  biomeCover?: 'foliage' | 'rock'
  /** World-scale STONE painting (cliff rock: formations + crags) instead of the unit-boulder brush scale. */
  cliffStone?: boolean
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

/**
 * OVERLAND palette (art of rally / over the hill): our albedos, hue kept, a touch less saturated and with the
 * shadows lifted (nothing near black — their shadows are lit by the warm sky), a faint warm cast. ~8 ALU. Linear.
 */
const OVERLAND_GLSL = /* glsl */ `
vec3 overlandPalette(vec3 c) {
  c = max(c, vec3(0.0));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 0.88);
  return c * 0.94 + 0.012;
}`

/**
 * SNOW & SAND surface (terrain): footprints / tyre tracks from the trail map (rendering/trails/TrailMap.ts) and
 * the micro-relief that makes the ground read as a material, not a colour — sand WIND RIPPLES and snow SASTRUGI
 * (wind-carved ridges) as normal perturbations, plus sun GLINTS. World-space, faded with distance (no aliasing).
 */
const TRAIL_GLSL = /* glsl */ `
uniform sampler2D uTrailMap; uniform vec4 uTrailRect; uniform float uTrailOn, uSurfaceDetail;
float trailAt(vec2 xz) {
  if (uTrailOn < 0.5) return 0.0;
  vec2 uv = (xz - uTrailRect.xy) * uTrailRect.zw;
  if (uv.x <= 0.002 || uv.y <= 0.002 || uv.x >= 0.998 || uv.y >= 0.998) return 0.0;
  return texture2D(uTrailMap, uv).r;
}
// Ground micro-relief gradient (world xz) for sand ripples + snow sastrugi + track imprints.
vec2 softGroundGrad(vec2 wp, vec2 biome, float dist) {
  vec2 g = vec2(0.0);
  if (uSurfaceDetail < 0.5) return g; // LOW: no micro-relief, glints or imprints (uniform branch → skipped)
  float near = 1.0 - smoothstep(18.0, 55.0, dist);
  if (biome.x > 0.02 && near > 0.0) {
    vec2 dir = vec2(0.8, 0.6);
    float ph = dot(wp, dir) * 2.6 + st_noise(wp * 0.3) * 4.0;
    // Asymmetric ripple (steeper lee side): derivative of sin + a little second harmonic.
    g += dir * (cos(ph) + 0.45 * cos(2.0 * ph + 0.6)) * 2.6 * 0.035 * biome.x * near;
  }
  if (biome.y > 0.02 && near > 0.0) {
    vec2 q = vec2(dot(wp, vec2(0.8, 0.6)), dot(wp, vec2(-0.6, 0.8)));
    float e = 0.15;
    float n0 = st_noise(q * vec2(0.9, 3.2));
    float nx = st_noise((q + vec2(e, 0.0)) * vec2(0.9, 3.2)), nz = st_noise((q + vec2(0.0, e)) * vec2(0.9, 3.2));
    vec2 gq = vec2(nx - n0, nz - n0) / e * 0.025; // soft: the cel-shading ramp turns strong bumps into hard stripes
    g += vec2(gq.x * 0.8 - gq.y * 0.6, gq.x * 0.6 + gq.y * 0.8) * biome.y * near;
  }
  // Tracks: pressed-in imprints (height −0.08 m × depth) → their walls catch the light.
  float soft = clamp(biome.x + biome.y, 0.0, 1.0);
  if (soft > 0.02 && dist < 30.0) {
    float te = 0.11;
    float tx = trailAt(wp + vec2(te, 0.0)) - trailAt(wp - vec2(te, 0.0));
    float tz = trailAt(wp + vec2(0.0, te)) - trailAt(wp - vec2(0.0, te));
    g -= vec2(tx, tz) / (2.0 * te) * (0.08 + 0.06 * biome.y) * soft;
  }
  return g;
}
`

const NOISE = /* glsl */ `
// Sin-free hash (Hoskins' hash12): ~8 ALU, no transcendental, and stable on mediump/phone GPUs where
// fract(sin(x)·43758) loses its bits for large x. Every procedural pattern below goes through it.
float st_hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
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
  const over = isOverland()
  const gen = isGenshin()
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
      uAerial: u.uAerial,
      uLandHaze: u.uLandHaze,
      uFarEdge: u.uFarEdge,
      uCullFade: u.uCullFade,
      uNearFade: u.uNearFade,
      uWet: u.uWet,
      uBiomeMap: u.uBiomeMap,
      uBiomeRect: u.uBiomeRect,
      uTrailMap: u.uTrailMap,
      uTrailRect: u.uTrailRect,
      uTrailOn: u.uTrailOn,
      uSurfaceDetail: u.uSurfaceDetail,
      uBiomeActive: u.uBiomeActive,
      ...skyUniforms,
    })
    let vs = shader.vertexShader
    let fs = shader.fragmentShader
    // Sky-coloured fog: the sky colour in the fragment's direction, evaluated PER VERTEX (it varies smoothly;
    // per-pixel it cost ~1 ms at 1080p on HIGH — measured) and interpolated.
    vs = vs
      .replace('#include <common>', `#include <common>\n${vs.includes('uSkyHorizon') ? '' : SKY_GLSL}\nvarying vec3 vFogSky;\nvarying vec3 vWPos;`)
      .replace(
        '#include <fog_vertex>',
        `#include <fog_vertex>
        { vec4 wp4 = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            wp4 = instanceMatrix * wp4;
          #endif
          vWPos = (modelMatrix * wp4).xyz; }
        ${o.cheapFog ? 'vFogSky = vec3(-1.0);' : 'vFogSky = skyColor(normalize((vec4(normalize(mvPosition.xyz), 0.0) * viewMatrix).xyz), false);'}`,
      )
    if (o.biomeCover) {
      vs = vs
        .replace('#include <common>', `#include <common>\n${BIOME_GLSL}\nvarying vec2 vBiomeW; varying float vSnowUp;${o.key === 'landmark' ? '\nattribute float aBaseY;' : ''}`)
        .replace(
          '#include <fog_vertex>',
          `#include <fog_vertex>
        {
          #ifdef USE_INSTANCING
            vec3 bOrigin = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
            vec3 bN = mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal;
          #else
            vec3 bOrigin = (modelMatrix * vec4(transformed, 1.0)).xyz;
            vec3 bN = mat3(modelMatrix) * objectNormal;
          #endif
          ${o.key === 'landmark' ? 'bOrigin.y = aBaseY; // merged landmarks: the snow line at the foot (LandmarkSystem)' : ''}
          vBiomeW = biomeWithSnowLine(bOrigin.xz, bOrigin.y);
          vSnowUp = normalize(bN).y;
        }`,
        )
    }
    if (o.nearFade) {
      // Canopy parts of an instance within uNearFade of the eye COLLAPSE toward the trunk (cards, tufts and the
      // overland solid shelves; trunks/props keep their shape) — a smooth shrink instead of a dither, which read
      // as a dotted green haze around the truck when driving under a tree.
      vs = vs
        .replace('#include <common>', `#include <common>\n${vs.includes('uniform vec2 uNearFade') ? '' : 'uniform vec2 uNearFade;'}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
        { float nfSurf = ${ATLAS_SURF};
          if (nfSurf < -0.5 || abs(nfSurf - 3.0) < 0.5) {
            float nfDepth = -(modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).z;
            transformed.xz *= smoothstep(uNearFade.x, uNearFade.y, nfDepth);
          } }
        #endif`)
    }
    if (o.sway) {
      vs = vs
        .replace('#include <common>', `#include <common>\n${vs.includes('uniform float uTimeS') ? '' : 'uniform float uTimeS; uniform vec2 uWindS;'}\n${vs.includes('float windGust(') ? '' : GUST_GLSL}\n${vs.includes('vec3 foliageSway(') ? '' : SWAY_GLSL}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          transformed = foliageSway(transformed, (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xz, uTimeS, uWindS);
        #endif`)
    }
    if (o.terrain) {
      vs = vs
        .replace('#include <common>', '#include <common>\nattribute float roadLat;\nattribute vec2 roadNet;\nattribute vec2 biome;\nvarying float vRoadLat;\nvarying vec2 vRoadNet;\nvarying vec2 vBiome;\nvarying vec3 vWorldPos;\nvarying float vUpN;\nvarying vec2 vNxz;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvRoadLat = roadLat;\nvRoadNet = roadNet;\nvBiome = biome;\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvUpN = normal.y; // terrain normals are world-space (the mesh is only translated)\nvNxz = normal.xz;')
    }
    if (o.surface !== undefined) {
      const surf = o.surface === 'atlas' ? ATLAS_SURF : o.surface.toFixed(1)
      // GLOW (atlas surfaces only): solids authored on GLOW_UV (FoliageAtlas — the opaque block, v ∈ [0.024, 0.038))
      // are emissive: mystic mushrooms and their spots. A varying, no attribute / program.
      const glow = o.surface === 'atlas'
      vs = vs
        .replace('#include <common>', `#include <common>\n${PAINT_VERT_PARS}${glow ? '\nvarying float vGlow;' : ''}`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n${paintVert(surf)}${glow ? '\nvGlow = (uv.x > 0.9625 && uv.y > 0.024 && uv.y < 0.038) ? 1.0 : 0.0;' : ''}`)
    }
    // Declare only what an earlier patch (e.g. grass) hasn't declared already.
    const decl = (d: string) => (fs.includes(d) ? '' : d + '\n')
    fs = fs.replace(
      '#include <common>',
      `#include <common>
${decl('uniform vec3 uKeyDirView;')}${decl('uniform vec3 uKeyColor;')}uniform vec3 uScatterColor; uniform float uScatterAmount; uniform float uRim; uniform float uToon; uniform float uTimeS; uniform vec2 uWindS;
uniform vec2 uSkyHaze;
uniform float uFogMax; uniform vec3 uLandHaze; uniform vec2 uFarEdge; uniform vec2 uCullFade; uniform vec2 uNearFade; uniform float uWet; uniform vec4 uAerial;
${fs.includes('uSkySunDir') ? '' : 'uniform vec3 uSkySunDir; uniform vec3 uSkySunColor; uniform float uSkySunVis;'}
float skyHaze(float d) { return uSkyHaze.x * (1.0 - exp(-max(d - 12.0, 0.0) / uSkyHaze.y)); }
varying vec3 vFogSky; varying vec3 vWPos;
${fs.includes('uSkyMist') ? '' : MIST_GLSL}
${o.terrain || o.surface !== undefined ? 'uniform sampler2D uBrush;\n' : ''}${o.surface !== undefined ? paintFragPars(o.cliffStone ? STONE_CLIFF_UV : undefined).replace('uniform sampler2D uBrush;', '') : ''}${o.surface === 'atlas' ? '\nvarying float vGlow;' : ''}
${o.biomeCover ? 'varying vec2 vBiomeW; varying float vSnowUp;\n' + (o.terrain ? '' : NOISE) : ''}
${o.terrain ? 'varying float vRoadLat; varying vec2 vRoadNet; varying vec2 vBiome; varying vec3 vWorldPos; varying float vUpN; varying vec2 vNxz;\nfloat wetPuddle = 0.0; // set in the terrain colour block, read after lighting (puddle mirror)\nfloat cliffW = 0.0; vec3 cliffTilt = vec3(0.0); // cliff weight + per-block normal tilt: set in the colour block, read in the normal block\n' + NOISE + GUST_GLSL + TRAIL_GLSL : ''}
${story ? STORY_GLSL : ''}${over ? OVERLAND_GLSL : ''}`,
    )
    // Genshin CEL SHADING: N·L through a narrow ramp → lit / shadow sides with a crisp soft-edged terminator
    // (a little linear falloff kept so volumes still read). Shadows stay light because the sky fill is bright.
    fs = fs.replace(
      '#include <lights_lambert_pars_fragment>',
      THREE.ShaderChunk.lights_lambert_pars_fragment.replace(
        'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );',
        `float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
  ${o.surface === 'atlas' ? `// LEAF CARDS (vSurf < 0): softly WRAPPED light — a long gentle gradient across the crown (Genshin's soft
  // volume), the far side still ~40 % lit (dark gaps between puffs read as holes); no cel step on leaves.
  if (vSurf < -0.5) dotNL = mix(0.4, 1.0, smoothstep(-0.5, 0.95, dot(geometryNormal, directLight.direction))); else` : ''}
  dotNL = mix(dotNL, ${gen ? 'smoothstep(-0.05, 0.5, dotNL) * 0.6 + dotNL * 0.4' : 'smoothstep(0.0, 0.16, dotNL) * 0.82 + dotNL * 0.18'}, uToon * ${(o.toon ?? 1).toFixed(2)});`, // Genshin scenery: a SOFT terminator (the hard cel step is for characters)
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
    if (o.terrain) {
      fs = fs.replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
  { // Snow / sand micro-relief + track imprints (world-space gradient → view-space normal).
    vec2 sg = softGroundGrad(vWorldPos.xz, vBiome, length(vWorldPos - cameraPosition));
    if (dot(sg, sg) > 1e-8) normal = normalize(normal + mat3(viewMatrix) * vec3(-sg.x, 0.0, -sg.y));
  }
  // FACETED CLIFFS (Genshin's angular rock): each block of the face (found in the colour block above) is lit by
  // its own tilted normal → planes of light and shade without extra geometry.
  if (cliffW > 0.01) normal = normalize(normal + mat3(viewMatrix) * cliffTilt * cliffW);`,
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
  // DETAIL (uSurfaceDetail: MEDIUM+; LOW = phones) — the fine noise layers are a uniform branch, so LOW skips their
  // hashes (the brush texture below still breaks the ground up) and hold-60 can toggle them without a recompile.
  bool fine = uSurfaceDetail > 0.5;
  float n1 = st_noise(wp * 0.33), n2 = fine ? st_noise(wp * 1.9) : 0.5;
  diffuseColor.rgb *= 0.82 + 0.22 * n1 + 0.12 * n2 + (fine ? 0.05 * st_noise(wp * 7.0) : 0.025);
${over ? `  // OVERLAND: flat colour fields — only the big soft patches above, plus faint blade streaks on the straw so
  // the meadow reads as grass beyond the real blades (no brush fetch, no gust bands).
  float straw = smoothstep(0.0, 0.05, diffuseColor.r - diffuseColor.b) * (1.0 - vBiome.x - vBiome.y);
  float streak = st_noise(wp * 9.0) * 0.5 + st_noise(wp * 23.0) * 0.5;
  diffuseColor.rgb *= 1.0 + straw * (streak - 0.5) * 0.14;` : `  // Painted ground (BrushTexture, 1 fetch): ~1.5 m brush strokes + soft watercolour blotches, strokes
  // running across the slope like a painter's dabs.
  vec4 gb = texture2D(uBrush, wp * 0.045);
  diffuseColor.rgb *= 0.9 + 0.2 * gb.g + 0.26 * (gb.r - 0.5);
  // Painted meadow beyond the real grass (Genshin): on green ground, soft blade streaks + the same rolling
  // wind-gust bands as the grass, so the meadow reads continuous to the horizon.
  float green = smoothstep(0.0, 0.03, diffuseColor.g - diffuseColor.b) * smoothstep(0.0, 0.02, diffuseColor.g - diffuseColor.r * 0.8) * (1.0 - vBiome.x - vBiome.y);
  // (Grass is the same in every style and takes the ground's own colour — no per-style ground tint under it.)
  if (fine && green > 0.0) {
    float streak = st_noise(vec2(wp.x * 6.0 + wp.y * 1.5, wp.y * 6.0 - wp.x * 1.5));
    diffuseColor.rgb *= 1.0 + green * ((streak - 0.5) * 0.14 + windGust(wp, uTimeS, uWindS) * 0.14);
  }`}
  // BIOMES (per-vertex weights): sand = wind ripples + fine grain; snow = sparkle + soft drifts (blue-white shading).
  if (vBiome.x > 0.01) {
    float steep = 1.0 - smoothstep(0.55, 0.85, vUpN);
    if (fine) {
      float rip = sin((wp.x * 0.9 + wp.y * 0.35) * 2.2 + st_noise(wp * 0.3) * 4.0) * 0.5 + 0.5;
      diffuseColor.rgb *= 1.0 + vBiome.x * ((rip - 0.5) * 0.16 * (1.0 - steep) + (st_hash(floor(wp * 14.0)) - 0.5) * 0.06);
    }
    // Mesa cliffs (Sumeru): broad, soft red-orange sandstone bands with faint fine layering — not zebra stripes.
    float band = smoothstep(0.15, 0.85, sin(vWorldPos.y * 0.42 + st_noise(wp * 0.05) * 3.0) * 0.5 + 0.5);
    float band2 = sin(vWorldPos.y * 2.6 + n1 * 2.0) * 0.5 + 0.5;
    vec3 strata = mix(vec3(0.62, 0.3, 0.15), vec3(0.78, 0.47, 0.27), band) * (0.93 + 0.1 * band2) * (fine ? 0.9 + 0.2 * st_noise(wp * 0.11) : 1.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, strata, steep * vBiome.x * 0.85);
  }
  // CLIFFS (green lands + snow; the desert has its own strata above) — Genshin's rock (Starsnatch Cliff, Mt. Hulao,
  // Stone Gate): cool slate blue-grey stone built from big angular BLOCKS stacked into tall COLUMNS. Each block is
  // its own plane (cliffTilt, applied in the normal block) so the cel ramp splits the face into pale lit planes and
  // blue shadow planes — no lines are drawn. Each block is painted with a soft gradient (rounded, lit top → darker
  // foot) and some carry yellow-green moss on top. The meadow ends in a crisp, irregular lip at the cliff edge
  // instead of washing grey over half-steep banks.
  cliffW = 1.0 - smoothstep(0.6, 0.67, vUpN + (st_noise(wp * 0.15) - 0.5) * 0.1);
  {
    float cliff = cliffW * (1.0 - vBiome.x);
    if (cliffW > 0.01) {
      // Blocks ~11 m wide × ~24 m tall (Voronoi) → big upright columns (small even cells read as scales). The face is projected on the horizontal axis it
      // runs along (z for faces looking ±x, else x), so the columns stay vertical on a sloping face; where the face
      // turns past 45° the blocks restart — it reads as one more facet edge. rel = fragment − the block's centre,
      // in block units (rel.y > 0: upper part).
      float u = abs(vNxz.x) > abs(vNxz.y) ? wp.y : wp.x;
      // Genshin (Mondstadt cliffs): broad HORIZONTAL plates (~16 m × 7 m) — layered rock, not tall columns.
      vec2 fp = ${gen ? 'vec2(u / 16.0, vWorldPos.y / 7.0)' : 'vec2(u / 11.0, vWorldPos.y / 24.0)'};
      vec2 ip = floor(fp), cell = ip, rel = vec2(0.0);
      if (fine) {
        float bd = 9.0;
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
          vec2 c = ip + vec2(float(i), float(j));
          vec2 d = fp - c - vec2(st_hash(c), st_hash(c + 17.3));
          float dd = dot(d, d);
          if (dd < bd) { bd = dd; cell = c; rel = d; }
        }
      } else {
        // LOW: staggered columns instead of the 3×3 Voronoi search (2 hashes instead of 18) — each column of
        // blocks is shifted by its own amount, so the face still reads as stacked upright blocks.
        float col = floor(fp.x);
        float fy = fp.y + st_hash(vec2(col, 4.7));
        cell = vec2(col, floor(fy));
        rel = vec2(fract(fp.x) - 0.5, fract(fy) - 0.5);
      }
      float top = smoothstep(0.05, 0.5, rel.y);
      cliffTilt = vec3((st_hash(cell + 3.1) - 0.5) * 1.3, (st_hash(cell + 5.7) - 0.3) * 0.5 + top * 0.8, (st_hash(cell + 9.2) - 0.5) * 1.3)${gen ? ' * 0.12' : ''}; // Genshin: smooth rock — barely any facet tilt
      if (cliff > 0.01) {
        float region = fine ? st_noise(wp * 0.008 + vec2(vWorldPos.y * 0.01)) : n1;
        ${gen ? `// GENSHIN (reference-matched): warm light-grey stone (lit ≈ 170,166,150 on screen); the blue comes from the
        // cool sky fill in the shade, not from the albedo.
        vec3 stone = mix(vec3(0.47, 0.44, 0.37), vec3(0.55, 0.51, 0.42), region);` : 'vec3 stone = mix(vec3(0.17, 0.21, 0.3), vec3(0.24, 0.25, 0.31), region); // slate blue ↔ lavender grey'}
        stone *= 0.86 + 0.28 * st_hash(cell + 1.3);
        stone *= 0.76 + 0.34 * smoothstep(-0.55, 0.55, rel.y);
        if (fine) stone *= 0.94 + 0.12 * st_noise(vec2(u * 0.22, vWorldPos.y * 0.04));
        // Match the crags standing on it (cliffRock material, Formations/crags.ts): the same vertical brush streaks
        // (paint.ts STONE at STONE_CLIFF_UV) and the same mid-tone — the slope faces the sky more than the crags'
        // walls, so its albedo sits lower (×0.74; measured on screen: was ~18 % brighter than the crags).
        vec4 cb = texture2D(uBrush, vec2(u * 0.07, vWorldPos.y * 0.022));
        stone *= (0.74 + 0.36 * cb.g + 0.3 * (cb.r - 0.5)) * 0.74;
        float mn = st_noise(wp * 0.21 + vec2(vWorldPos.y * 0.13));
        float moss = max(smoothstep(0.63, 0.7, vUpN + (mn - 0.5) * 0.2), top * smoothstep(0.55, 0.75, mn) * step(0.7, st_hash(cell + 7.7)));
        stone = mix(stone, vec3(0.2, 0.3, 0.07) * (0.8 + 0.4 * mn), moss * (1.0 - vBiome.y) * 0.75);
        stone *= mix(vec3(1.0), vec3(0.9, 0.96, 1.08), vBiome.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, stone, cliff);
      }
    }
  }
  if (vBiome.y > 0.01) {
    if (fine) {
      float sparkle = step(0.988, st_hash(floor(wp * 22.0))) * 0.5;
      diffuseColor.rgb *= 1.0 + vBiome.y * ((st_noise(wp * 0.25) - 0.5) * 0.1 + sparkle);
    }
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.94, 0.97, 1.05), vBiome.y * 0.5);
  }
  // Under water: the bed darkens and turns blue-green with depth (seen through the semi-clear water);
  // a soft foam/wet line right at the shore.
  // (In the desert there is no water: basins and the river's bed are dry sand / clay pans — no wet tint there.
  //  In the snow the water is frozen: no wet band or foam at the ice edge either.)
  float wetZone = 1.0 - smoothstep(0.35, 0.6, vBiome.x + vBiome.y);
  float wd = (${WATER_LEVEL.toFixed(2)} - vWorldPos.y);
  diffuseColor.rgb *= 1.0 - 0.35 * smoothstep(-0.8, 0.0, wd) * step(wd, 0.0) * 0.5 * wetZone; // wet dark band above
  ${!over && !story ? '// Genshin: the lake bed glows turquoise through clear shallows, deepening to teal.\n  ' : ''}if (wd > 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb * ${!over && !story ? 'vec3(0.45, 0.9, 0.88)' : 'vec3(0.5, 0.66, 0.7)'}, ${!over && !story ? 'vec3(0.01, 0.12, 0.14)' : 'vec3(0.015, 0.045, 0.055)'}, smoothstep(0.0, ${!over && !story ? '5.0' : '3.5'}, wd)), 1.0 - smoothstep(0.35, 0.6, vBiome.x));
  wd = mix(-10.0, wd, wetZone); // kills the shore foam line below outside the wet zone
  float foam = 1.0 - smoothstep(0.0, 0.18, abs(wd - 0.04));
  if (foam > 0.0) diffuseColor.rgb += vec3(0.25, 0.27, 0.27) * foam * (0.5 + 0.5 * st_noise(wp * 3.0 + vec2(uTimeS * 0.3))); // shoreline only
  // TRACKS in the snow (compacted blue-grey) and on sand (darker, disturbed): footprints and tyre ruts.
  {
    float tk = vBiome.x + vBiome.y > 0.02 ? trailAt(wp) * clamp(vBiome.x + vBiome.y, 0.0, 1.0) : 0.0;
    if (tk > 0.003) {
      diffuseColor.rgb *= mix(vec3(1.0), vec3(0.58, 0.68, 0.86), tk * vBiome.y); // compacted snow: blue-grey
      diffuseColor.rgb *= mix(vec3(1.0), vec3(0.8, 0.7, 0.58), tk * vBiome.x * 0.8);
    }
  }
  // WET GROUND (weather): darker, saturated soil; puddles in the dips of flat ground (noise mask) that mirror the
  // sky (vFogSky = the sky colour in the view direction, already per vertex); a sheen toward the key light
  // is added after lighting below. Puddles collect on the road and flat meadow, never on slopes.
  if (uWet > 0.01) {
    diffuseColor.rgb *= 1.0 - 0.35 * uWet;
    float flatGround = smoothstep(0.85, 0.97, vUpN);
    float pm = st_noise(wp * 0.35 + 5.0) * 0.6 + st_noise(wp * 1.4 + 9.0) * 0.4;
    wetPuddle = smoothstep(0.62, 0.72, pm + 0.12 * uWet) * flatGround * uWet;
  }
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
    ${!story ? `// DIRT TRACK with two darker wheel ruts — over the hill and Genshin both have earth paths, never asphalt.
    vec3 dirt = ${over ? 'vec3(0.58, 0.47, 0.32)' : 'vec3(0.66, 0.52, 0.34)'} * (0.84 + 0.2 * n2 + 0.1 * a3 + 0.08 * st_noise(wp * 2.3));
    float ruts = (1.0 - smoothstep(0.25, 0.55, abs(lat - 1.35)));
    dirt *= 1.0 - ruts * 0.18;
    vec3 road = mix(dirt, gravel * 1.5, smoothstep(HALF - 0.1, HALF + 0.25, lat));${over ? '' : `
    // GENSHIN PATH (Windrise / Starfell): a worn earth track, not a lane — the bare dirt is narrower than the
    // drivable bed with soft WAVY grassy edges (1.2–2.8 m half-width), and along some stretches a grass strip
    // grows down the middle between the wheel tracks. The ground beyond stays the meadow's colour.
    float edgeN = st_noise(wp * 0.11 + 4.0) * 0.65 + st_noise(wp * 0.6 + 2.0) * 0.35;
    float edge = 2.0 + (edgeN - 0.5) * 1.8;
    float median = (1.0 - smoothstep(0.3, 0.55, lat + (st_noise(wp * 0.9) - 0.5) * 0.3)) * smoothstep(0.5, 0.62, st_noise(vec2(vWorldPos.z * 0.012, 1.3)));
    float bare = (1.0 - smoothstep(edge - 0.45, edge + 0.3, lat)) * (1.0 - median * 0.85);
    road = mix(diffuseColor.rgb * (0.9 + 0.1 * a3), dirt * (1.0 + 0.06 * (1.0 - ruts)), bare);`}` : `vec3 road = mix(asphalt, gravel, smoothstep(HALF - 0.1, HALF + 0.25, lat));`}
    // Biomes: packed snow with darker icy wheel ruts on the snowfields; drifts of sand over the desert track.
    float rutS = 1.0 - smoothstep(0.2, 0.6, abs(lat - 1.35));
    vec3 packedSnow = vec3(0.68, 0.73, 0.82) * (0.9 + 0.12 * n2) * (1.0 - rutS * 0.25);
    road = mix(road, packedSnow, vBiome.y * 0.85);
    road = mix(road, diffuseColor.rgb, vBiome.x * 0.4 * smoothstep(0.35, 0.75, st_noise(wp * 0.45 + 3.0)));
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
    surf = mix(surf, vec3(0.7, 0.75, 0.84) * (0.88 + 0.15 * s1), vBiome.y * 0.8);
    diffuseColor.rgb = mix(diffuseColor.rgb, surf, 1.0 - smoothstep(-0.2, 1.2 + 0.5 * s1, e));
  }
}`,
      )
    }
    if (o.biomeCover) {
      // After every albedo patch (vertex colour, painted surface, gold caps) so the snow sits on top of them.
      fs = fs.replace(
        '#include <alphamap_fragment>',
        /* glsl */ `{
  float bn = st_noise(vWPos.xz * 1.4 + vec2(vWPos.y * 0.9));
  ${o.biomeCover === 'rock' ? `// Desert sandstone: wavy horizontal strata in warm reds and creams.
  if (vBiomeW.x > 0.02) {
    float band = sin(vWPos.y * 3.3 + bn * 2.4) * 0.5 + 0.5;
    vec3 strata = mix(vec3(0.62, 0.3, 0.16), vec3(0.86, 0.62, 0.4), band) * (0.8 + 0.3 * bn);
    diffuseColor.rgb = mix(diffuseColor.rgb, strata, vBiomeW.x * 0.75);
  }` : ''}
  // Snow cover: up-facing surfaces whiten (tops of shelves, not the undersides seen from below the canopy).
  float up = vSnowUp + (bn - 0.5) * 0.55;
  // (Card canopies — Genshin / storybook — carry snow on both faces of every upward-facing card: Dragonspine's
  //  conifers are heavy with it; the overland solid shelves only on their top faces.)
  float cover = vBiomeW.y * smoothstep(${o.biomeCover === 'rock' ? '0.05, 0.4' : over ? '0.45, 0.85' : '-0.25, 0.3'}, up) * (gl_FrontFacing ? 1.0 : ${over ? '0.3' : '1.0'});
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 0.85, 0.93) * (0.92 + 0.12 * bn), cover);
}
#include <alphamap_fragment>`,
      )
    }
    if (over) fs = fs.replace('#include <alphamap_fragment>', 'diffuseColor.rgb = overlandPalette(diffuseColor.rgb);\n#include <alphamap_fragment>')
    if (o.wet) fs = fs.replace('#include <alphamap_fragment>', 'diffuseColor.rgb *= 1.0 - 0.3 * uWet; // soaked\n#include <alphamap_fragment>')
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
  outgoingLight += uKeyColor * diffuseColor.rgb * pow(1.0 - ndv, 3.0) * (0.3 + back * 1.4) * uRim${story ? ' * (1.0 - uStoryAmt)' : ''}${o.surface === 'atlas' ? ' * (vSurf < -0.5 ? 0.2 : 1.0)' : ''};${o.surface === 'atlas' ? `
  // (Leaves keep only a trace of the rim — a full rim made every crown edge glow, the "shiny" look.)
  // Leaves seen against the sun GLOW through (translucency): a warm lift on the backlit side of every crown.
  if (vSurf < -0.5) outgoingLight += uKeyColor * diffuseColor.rgb * back * 0.15;
  // Emissive mushrooms (vGlow): their own light on top of the lit colour — bright in the shade, glowing at night,
  // bloom picks it up on MEDIUM+ (LOW: no bloom, a bright flat colour).
  outgoingLight = mix(outgoingLight, max(outgoingLight, diffuseColor.rgb * 1.9), vGlow);` : ''}
  ${o.terrain ? `{ // Sun glints on snow and sand: sparse cells that flash toward the key light (view dependent).
    float gd = length(vWorldPos - cameraPosition);
    float soft = (vBiome.y + vBiome.x * 0.55) * uSurfaceDetail;
    if (soft > 0.02 && gd < 45.0) {
      vec3 Hg = normalize(V + uKeyDirView);
      float cell = st_hash(floor(vWorldPos.xz * 24.0 + floor(vWorldPos.y * 24.0)));
      float glint = step(0.985, cell) * pow(clamp(dot(normal, Hg), 0.0, 1.0), 30.0) * soft * (1.0 - smoothstep(12.0, 45.0, gd));
      outgoingLight += uKeyColor * glint * 3.0;
    }
  }
  if (uWet > 0.01) {
    // Sheen: a broad specular lobe toward the key light on wet ground; puddles mirror the sky (Fresnel-ish).
    vec3 H = normalize(V + uKeyDirView);
    float sheen = pow(clamp(dot(normal, H), 0.0, 1.0), 24.0) * uWet * 0.5;
    outgoingLight += uKeyColor * sheen;
    if (wetPuddle > 0.001) {
      vec3 mirror = vFogSky.r < 0.0 ? fogColor : vFogSky;
      float fr = 0.25 + 0.75 * pow(1.0 - ndv, 2.0);
      outgoingLight = mix(outgoingLight, mirror * 0.9 + uKeyColor * pow(clamp(dot(normal, H), 0.0, 1.0), 180.0) * 2.0, wetPuddle * fr);
    }
  }` : ''}
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
  // AERIAL PERSPECTIVE (Genshin): the haze is brighter and warmer looking toward the sun (light scattered forward
  // through the air), cooler and bluer away from it — and, before the tint covers anything, distant surfaces lose
  // saturation and contrast toward the haze, so far hills, trees and rocks read as soft layered silhouettes (each
  // ridge paler than the one in front) instead of sharp small detail. Near field (< uAerial.x) untouched. ~12 ALU.
  { vec3 vd = normalize(vWPos - cameraPosition);
    float toSun = pow(max(dot(vd, normalize(uSkySunDir)), 0.0), 5.0) * uSkySunVis * uAerial.w;
    fogCol = mix(fogCol * vec3(0.94, 0.98, 1.06), fogCol * 0.7 + uSkySunColor * 0.45, toSun);
    float ap = smoothstep(uAerial.x, uAerial.y, vFogDepth) * uAerial.z * ${(o.fogAmount ?? 1).toFixed(3)};
    float lum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    float hazeLum = dot(fogCol, vec3(0.2126, 0.7152, 0.0722));
    // Saturation falls off first — toward the HAZE's hue (sky blue by day), not grey: far land goes blue (Genshin).
    vec3 hazeHue = fogCol / max(hazeLum, 1e-3);
    vec3 c = mix(gl_FragColor.rgb, hazeHue * lum, ap * 0.6);
    gl_FragColor.rgb = mix(c, c * 0.55 + hazeLum * 0.45, ap * 0.7); // then contrast: shadows lift, lights settle
  }
  // Volumetric ground mist (height fog integrated along the view ray; sky/skyShader MIST_GLSL): pools in the
  // valleys and over the water, thins up the hills. Composited with the distance fog as two transmittances.
  { vec3 wd = vWPos - cameraPosition; float wl = max(length(wd), 1e-3);
    float mist = mistAmount(wd / wl, wl) * ${(o.fogAmount ?? 1).toFixed(3)}${o.key === 'grass' ? ' * smoothstep(10.0, 45.0, wl)' : ''}; // (near grass: no grey veil)
    fogFactor = 1.0 - (1.0 - fogFactor) * (1.0 - mist); }
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogCol, fogFactor);
#endif`,
      )
    shader.vertexShader = vs
    shader.fragmentShader = fs
  }
  const prevKey = material.customProgramCacheKey.bind(material)
  material.customProgramCacheKey = () => `${prevKey()}|stylize2-${o.key}${o.biomeCover ? '-bc' : ''}${story ? '-story' : ''}${over ? '-over' : ''}${gen ? '-gen' : ''}`
  return material
}
