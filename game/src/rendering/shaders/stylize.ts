import * as THREE from 'three'
import { MIST_GLSL, SKY_GLSL, skyUniforms } from '../sky/skyShader'
import { globalUniforms, GUST_GLSL, SWAY_GLSL } from './uniforms'
import { isBright, isGenshin, isOverland, isStorybook } from '../artStyle'
import { ATLAS_SURF, PAINT_VERT_PARS, STONE_CLIFF_UV, paintFragPars, paintVert } from './paint'
import { WorldFields } from '../../world/WorldFields'
import { BIOME_GLSL } from '../biome/BiomeMap'
import { SURFACE_NOISE_GLSL } from './surfaceNoise'

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
  /** Rock EROSION detail (runnels, weathering, stains, lichen: ROCK_EROSION_GLSL) — needs `biomeCover` (noise). */
  erosion?: boolean
  /** Procedural ROUGHNESS (surfaceNoise.ts): 'rock' (boulders, tors, pillars) or 'cliff' (formations, crag walls) — the
   *  profile's simplex / Worley relief tilts the normal. Vertices with `aPlain` = 1 are skipped (the bridges' planks and
   *  camps' tents sharing the formation mesh). */
  rockDetail?: 'rock' | 'cliff'
  /** The rock takes the HILLS' stone colour where it stands (hillStone: the terrain cliffs' albedo, the map's palette
   *  `cliff`, sand / snow) — its own vertex colour keeps only its light and dark. Needs `rockDetail` + `biomeCover`. */
  hillTint?: boolean
  /** Receives the IMAGE TREE SHADOWS (uTreeShade: the direct light is dimmed where a tree's shade image lies) — the
   *  ground, grass, rocks and the player; not the trees themselves. 1 texture fetch per fragment while it is on;
   *  'vertex' = per vertex instead (grass: thousands of small, overlapping blades — the fetch per pixel was most of
   *  the cost). */
  treeShade?: boolean | 'vertex'
}

/**
 * The HILLS' STONE (the terrain cliffs' albedo before their relief): the style's stone, or the map's own (palette `cliff`,
 * uCliffStone), varying over ~100 m (`region`). The terrain cliffs and the rocks standing on the hills (hillTint) share it,
 * so a crag reads as the hill it stands on — on every map, in its own colour.
 */
export const hillStoneGLSL = (gen: boolean): string => /* glsl */ `
vec3 hillStone(float region) {
  vec3 s = ${gen ? 'mix(vec3(0.47, 0.44, 0.37), vec3(0.55, 0.51, 0.42), region)' : 'mix(vec3(0.17, 0.21, 0.3), vec3(0.24, 0.25, 0.31), region)'};
  if (uCliffStone.w > 0.5) s = mix(uCliffStone.rgb * 0.72, uCliffStone.rgb, region); // (a map's own stone)
  return s;
}`

/** Rock erosion, colour part (after the albedo patches, before the snow cover). Sets eroW / eroG / eroTan. */
export const ROCK_EROSION_GLSL = /* glsl */ `
{ // ROCK EROSION (world space): RUNNELS fluting the walls (wavering vertical noise ~1.2 m apart; the across-face
  // slope tilts the normal in the normal block, the flute floors are darker), blotchy WEATHERING (2–5 m patches),
  // rain STAINS streaking down from the lips, LICHEN blotches. Side faces only for the runnels / stains (tops keep
  // their cover); the fine part fades out past ~90 m (no shimmer) and is skipped on LOW. ≤ 7 noise lookups.
  vec3 wnE = normalize(normalize(vNormal) * mat3(viewMatrix));
  float nearE = (1.0 - smoothstep(35.0, 90.0, length(vWPos - cameraPosition))) * step(0.5, uSurfaceDetail);
  float sideE = 1.0 - smoothstep(0.45, 0.8, wnE.y);
  bool xFaceE = abs(wnE.x) > abs(wnE.z);
  float uE = xFaceE ? vWPos.z : vWPos.x, yE = vWPos.y;
  eroTan = xFaceE ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  float blot = st_noise(vWPos.xz * 0.3 + vec2(yE * 0.21, -yE * 0.13));
  float stainE = st_noise(vec2(uE * 1.6, yE * 0.06));
  float k = (0.88 + 0.24 * blot) * (1.0 - 0.18 * smoothstep(0.5, 0.85, stainE) * sideE);
  if (nearE > 0.0) {
    float wv = st_noise(vec2(uE * 0.2, yE * 0.1)) * 1.8;
    float r0 = st_noise(vec2(uE * 0.8 + wv, yE * 0.15));
    float r1 = st_noise(vec2((uE + 0.1) * 0.8 + wv, yE * 0.15));
    eroW = sideE * nearE;
    eroG = (r1 - r0) / 0.1;
    float rib = smoothstep(0.25, 0.75, r0); // 0 = flute floor, 1 = rib
    float lich = smoothstep(0.64, 0.72, st_noise(vWPos.xz * 0.9 + vec2(yE * 0.6)));
    k *= mix(1.0, 0.72 + 0.36 * rib, eroW);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.18, 1.14, 0.92) + vec3(0.025, 0.025, 0.0), lich * 0.45 * nearE);
  }
  diffuseColor.rgb *= k;
}`


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
export const TRAIL_GLSL = /* glsl */ `
uniform sampler2D uTrailMap; uniform vec4 uTrailRect; uniform float uTrailOn, uSurfaceDetail; uniform vec4 uRoadSoil, uCliffStone, uCliffMoss;
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

export const NOISE = /* glsl */ `
// Sin-free hash (Hoskins' hash12): ~8 ALU, no transcendental, and stable on mediump/phone GPUs where
// fract(sin(x)·43758) loses its bits for large x. Every procedural pattern below goes through it.
float st_hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
// Value noise = the smoothstep blend of the 4 lattice hashes, read as ONE bilinear fetch of the pre-hashed lattice
// (uniforms.ts noiseLattice): the coordinate is warped so the hardware's linear weights are the smoothstep ones.
uniform sampler2D uNoiseTex;
float st_noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return textureLod(uNoiseTex, (mod(i, 256.0) + f + 0.5) / 256.0, 0.0).r;
}
`

/**
 * DYNAMIC SHADOW lookup (rendering/shadows/DynamicShadow): the car / player / bike / monsters' depth from the sun
 * round the player, 4-tap PCF → 0..1 in shadow. Used while the sun's world shadow map is cached.
 */
export const DYN_SHADOW_GLSL = /* glsl */ `
uniform sampler2D uDynShadow; uniform mat4 uDynShadowMat; uniform float uDynShadowOn;
float dynShadowAt(vec3 wp) {
  vec3 c = (uDynShadowMat * vec4(wp, 1.0)).xyz;
  if (c.x <= 0.0 || c.y <= 0.0 || c.x >= 1.0 || c.y >= 1.0 || c.z >= 1.0) return 0.0;
  float z = c.z - 0.0008, t = 0.75 / 1024.0;
  return (step(textureLod(uDynShadow, c.xy + vec2(-t, -t), 0.0).r, z) + step(textureLod(uDynShadow, c.xy + vec2(t, -t), 0.0).r, z)
    + step(textureLod(uDynShadow, c.xy + vec2(-t, t), 0.0).r, z) + step(textureLod(uDynShadow, c.xy + vec2(t, t), 0.0).r, z)) * 0.25;
}
`

export function stylize<T extends THREE.Material>(material: T, o: StylizeOptions): T {
  const prev = material.onBeforeCompile.bind(material)
  const rim = o.rim ?? 0.5
  const story = isStorybook() && !o.lit
  const over = isOverland()
  const gen = isGenshin()
  const bright = isBright()
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
      uRoadSoil: u.uRoadSoil,
      uCliffStone: u.uCliffStone,
      uCliffMoss: u.uCliffMoss,
      uNoiseTex: u.uNoiseTex,
      uBiomeActive: u.uBiomeActive,
      uSnowLine: u.uSnowLine,
      uTreeShade: u.uTreeShade,
      uTreeShadeRect: u.uTreeShadeRect,
      uTreeShadeOn: u.uTreeShadeOn,
      uDynShadow: u.uDynShadow,
      uDynShadowMat: u.uDynShadowMat,
      uDynShadowOn: u.uDynShadowOn,
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
          #ifdef USE_BATCHING
            wp4 = batchingMatrix * wp4;
          #endif
          vWPos = (modelMatrix * wp4).xyz; }
        ${o.cheapFog ? 'vFogSky = vec3(-1.0);' : 'vFogSky = skyColor(normalize((vec4(normalize(mvPosition.xyz), 0.0) * viewMatrix).xyz), false);'}`,
      )
    if (o.treeShade === 'vertex') {
      vs = vs
        .replace('#include <common>', '#include <common>\nuniform sampler2D uTreeShade; uniform vec4 uTreeShadeRect; uniform float uTreeShadeOn; varying float vTreeShade;\n' + DYN_SHADOW_GLSL)
        .replace('vWPos = (modelMatrix * wp4).xyz; }', `vWPos = (modelMatrix * wp4).xyz; }
  vTreeShade = 0.0;
  if (uTreeShadeOn > 0.5) {
    vec2 tuv = (vWPos.xz - uTreeShadeRect.xy) * uTreeShadeRect.z;
    if (tuv.x > 0.0 && tuv.y > 0.0 && tuv.x < 1.0 && tuv.y < 1.0) vTreeShade = textureLod(uTreeShade, tuv, 0.0).r * uTreeShadeRect.w;
  }
  if (uDynShadowOn > 0.0) vTreeShade = max(vTreeShade, dynShadowAt(vWPos) * uDynShadowOn);`)
    }
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
          #elif defined(USE_BATCHING)
            vec3 bOrigin = (modelMatrix * batchingMatrix * vec4(transformed, 1.0)).xyz; // (MeshBatcher: chunk meshes)
            vec3 bN = mat3(modelMatrix) * mat3(batchingMatrix) * objectNormal;
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
    if (o.rockDetail) {
      vs = vs
        .replace('#include <common>', '#include <common>\nattribute float aPlain;\nvarying float vPlain;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPlain = aPlain;')
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
        .replace('#include <common>', '#include <common>\nattribute float roadLat;\nattribute vec2 roadNet;\nattribute vec2 biome;\nattribute float mud;\nvarying float vRoadLat;\nvarying vec2 vRoadNet;\nvarying vec2 vBiome;\nvarying float vMud;\nvarying vec3 vWorldPos;\nvarying float vUpN;\nvarying vec2 vNxz;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvRoadLat = roadLat;\nvRoadNet = roadNet;\nvBiome = biome;\nvMud = mud;\n#ifdef USE_BATCHING\nvWorldPos = (modelMatrix * batchingMatrix * vec4(transformed, 1.0)).xyz; // (TerrainBatch: the chunk origin)\n#else\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#endif\nvUpN = normal.y; // terrain normals are world-space (the mesh is only translated)\nvNxz = normal.xz;')
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
${o.biomeCover ? 'varying vec2 vBiomeW; varying float vSnowUp;\n' + (o.terrain ? '' : NOISE) : ''}${(o.erosion || o.rockDetail) && !o.terrain ? 'uniform float uSurfaceDetail;\n' : ''}${o.rockDetail && !o.terrain ? 'varying float vPlain;\nvec3 rockBump = vec3(0.0);\n' + SURFACE_NOISE_GLSL + '\n' : ''}${o.hillTint ? 'uniform vec4 uCliffStone;\n' + hillStoneGLSL(gen) + '\n' : ''}${o.erosion ? 'float eroW = 0.0; float eroG = 0.0; vec3 eroTan = vec3(1.0, 0.0, 0.0); // rock erosion: runnel weight, slope, face tangent\n' : ''}
${o.terrain ? 'varying float vRoadLat; varying vec2 vRoadNet; varying vec2 vBiome; varying float vMud; varying vec3 vWorldPos; varying float vUpN; varying vec2 vNxz;\nfloat wetPuddle = 0.0; // set in the terrain colour block, read after lighting (puddle mirror)\nfloat cliffW = 0.0; vec3 cliffTilt = vec3(0.0); // cliff weight + rock-surface normal tilt: set in the colour block, read in the normal block\nvec3 groundBump = vec3(0.0); // the ground\'s soil relief + stones (world space), read in the normal block\nfloat roadDirt = 0.0; // bare dirt road weight (bright: clumpy relief in the normal block)\nfloat snowRoad = 0.0, snowRut = 0.0; // the road / its wheel ruts here, for the snow surface (surfSnow)\n' + NOISE + GUST_GLSL + TRAIL_GLSL + hillStoneGLSL(gen) + SURFACE_NOISE_GLSL : ''}
${story ? STORY_GLSL : ''}${over ? OVERLAND_GLSL : ''}
${o.treeShade === 'vertex' ? 'varying float vTreeShade;\n' : ''}${o.treeShade ? 'uniform sampler2D uTreeShade; uniform vec4 uTreeShadeRect; uniform float uTreeShadeOn;\nfloat stTreeShade = 0.0; // image tree shadow / dynamic shadow here (0..1): dims the direct light (lights_lambert_pars)' : ''}
${o.treeShade === true ? DYN_SHADOW_GLSL : ''}`,
    )
    if (o.treeShade === 'vertex') fs = fs.replace('#include <lights_fragment_begin>', 'stTreeShade = vTreeShade;\n#include <lights_fragment_begin>')
    else if (o.treeShade) {
      fs = fs.replace(
        '#include <lights_fragment_begin>',
        `if (uTreeShadeOn > 0.5) {
  vec2 tuv = (vWPos.xz - uTreeShadeRect.xy) * uTreeShadeRect.z;
  if (tuv.x > 0.0 && tuv.y > 0.0 && tuv.x < 1.0 && tuv.y < 1.0) stTreeShade = texture2D(uTreeShade, tuv).r * uTreeShadeRect.w;
  ${o.terrain || o.biomeCover === 'rock' ? `// (a top-down shade image smears into blotches down a steep face: only on ground / rock that faces the sky)
  stTreeShade *= smoothstep(0.35, 0.7, (normalize(vNormal) * mat3(viewMatrix)).y);` : ''}
}
if (uDynShadowOn > 0.0) stTreeShade = max(stTreeShade, dynShadowAt(vWPos) * uDynShadowOn);
#include <lights_fragment_begin>`,
      )
    }
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
  dotNL = mix(dotNL, ${gen ? 'smoothstep(-0.05, 0.5, dotNL) * 0.6 + dotNL * 0.4' : 'smoothstep(0.0, 0.16, dotNL) * 0.82 + dotNL * 0.18'}, uToon * ${(o.toon ?? 1).toFixed(2)});${o.treeShade ? '\n  dotNL *= 1.0 - stTreeShade; // image tree shadow (LOW) / dynamic shadow (cached sun map)' : ''}`, // Genshin scenery: a SOFT terminator (the hard cel step is for characters)
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
    if (o.rockDetail) {
      // HILL TINT: the hills' stone here (the terrain cliffs' region noise, sand → sandstone, snow → cold), lit and darkened
      // by the rock's own vertex colour relative to its body (crags ≈ 0.47 luminance, boulders' ROCK_BODY ≈ 0.21): its
      // tone and painted foot shade stay, its hue is the hill's — never the grass's green around it.
      // (only on a map with its own hill stone, palette `cliff`: without one — Island's snow and grass hills, the endless
      // world — the style's dark slate cliff colour turned every boulder navy; they keep their light granite)
      const tint = o.hillTint ? `if (uCliffStone.w > 0.5) { float rl = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 hs = hillStone(st_noise(vWPos.xz * 0.008 + vec2(vWPos.y * 0.01)));
  hs = mix(hs, vec3(0.6, 0.31, 0.19), vBiomeW.x) * mix(vec3(1.0), vec3(0.9, 0.96, 1.08), vBiomeW.y);
  diffuseColor.rgb = hs * clamp(rl / ${o.rockDetail === 'cliff' ? '0.47' : '0.21'}, 0.6, 1.3); }\n` : ''
      fs = fs.replace('#include <color_fragment>', `#include <color_fragment>\nif (vPlain < 0.5) { ${tint}diffuseColor.rgb = ${o.rockDetail === 'cliff' ? 'surfCliff' : 'surfRock'}(diffuseColor.rgb, vWPos, normalize(normalize(vNormal) * mat3(viewMatrix)), length(vWPos - cameraPosition)); rockBump = surfBump; }`)
      fs = fs.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n  if (vPlain < 0.5) normal = normalize(normal + mat3(viewMatrix) * rockBump);')
    }
    if (o.erosion) {
      fs = fs.replace('#include <alphamap_fragment>', `${ROCK_EROSION_GLSL}\n#include <alphamap_fragment>`)
      // runnels: the flute's across-face slope tilts the normal → the ribs catch the light, the flutes fall into shade
      fs = fs.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n  if (eroW > 0.01) normal = normalize(normal + mat3(viewMatrix) * eroTan * clamp(eroG * 0.22, -0.7, 0.7) * eroW);')
    }
    if (o.terrain) {
      fs = fs.replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
  { // Snow / sand micro-relief + track imprints (world-space gradient → view-space normal).
    vec2 sg = softGroundGrad(vWorldPos.xz, vBiome, length(vWorldPos - cameraPosition));
    if (dot(sg, sg) > 1e-8) normal = normalize(normal + mat3(viewMatrix) * vec3(-sg.x, 0.0, -sg.y));
  }
  // (the roads' clumpy relief is surfRoad's, in groundBump below — real simplex / Worley noise, not lattice clods)
  // CLIFFS: the cliff roughness (cliffTilt, from the colour block above) tilts the normal — ledges, flutes and grit catch
  // the light on one smooth face; the GROUND's and ROADS' roughness (groundBump) likewise, off the cliffs.
  if (cliffW > 0.01) normal = normalize(normal + mat3(viewMatrix) * cliffTilt * cliffW);
  groundBump *= 1.0 - cliffW;
  if (dot(groundBump, groundBump) > 1e-6) normal = normalize(normal + mat3(viewMatrix) * groundBump);`,
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
  ${gen ? `// ANIME GRASS GROUND (Genshin): the meadow floor takes the same lime hue as the grass blades (world/Forest/grass.ts,
  // ground colour → lime at the same brightness) — the blades' roots and the ground between them are ONE colour, so
  // a sparser field (LOW / phones) still reads as a continuous lawn instead of blades on olive soil.
  { float gl = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.223, 0.546, 0.061) * (gl / 0.442), 0.6 * green); }` : ''}
  if (fine && green > 0.0) {
    float streak = st_noise(vec2(wp.x * 6.0 + wp.y * 1.5, wp.y * 6.0 - wp.x * 1.5));
    diffuseColor.rgb *= 1.0 + green * ((streak - 0.5) * 0.14 + windGust(wp, uTimeS, uWindS) * 0.14);
  }`}
  // GROUND roughness (surfaceNoise.ts surfGround, 2026-10-24, every map / style): crumbly soil clods and loose gravel
  // (Worley pebbles, domed, contact-shadowed) as real relief tilting the normal (groundBump, the normal block), on bare
  // soil, banks and dry ground; lush grass keeps a trace (the blades cover it), snow none. The road blocks below take
  // over on the tracks with their own (packed) profile.
  {
    float lush = smoothstep(0.0, 0.03, diffuseColor.g - diffuseColor.b) * smoothstep(0.0, 0.02, diffuseColor.g - diffuseColor.r * 0.8) * (1.0 - vBiome.x);
    float bare = (1.0 - 0.85 * lush) * (1.0 - vBiome.y);
    diffuseColor.rgb = surfGround(diffuseColor.rgb, vWorldPos, normalize(vec3(vNxz.x, vUpN, vNxz.y)), length(vWorldPos - cameraPosition), bare);
    groundBump = surfBump;
    // MEADOW variation (2026-10-25, the user: "the Highlands and map 3 ground has no noise like the Island — add noise
    // so it feels realistic"): a bright palette green was one flat colour beyond the blades. Real meadows vary at every
    // scale: ~25 m / ~8 m patches sunnier-drier (yellower) or deeper-cooler, ~1 m tussocks, small worn spots where the
    // map's earth shows through, and (MEDIUM+, near) a fine blade grain. Value noise only (5–6 lookups), every tier.
    if (lush > 0.0) {
      float wl = lush * (1.0 - vBiome.y);
      float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      float m1 = st_noise(wp * 0.04 + 3.7), m2 = st_noise(wp * 0.13 + 11.3);
      float dryM = smoothstep(0.45, 0.85, m1 * 0.65 + m2 * 0.35);
      float deepM = smoothstep(0.5, 0.15, m1 * 0.5 + m2 * 0.5);
      vec3 cm = diffuseColor.rgb;
      cm = mix(cm, cm * vec3(1.05, 0.9, 0.5) + vec3(0.04, 0.025, 0.0), dryM * 0.85);
      cm = mix(cm, cm * vec3(0.55, 0.7, 0.72), deepM * 0.75);
      cm *= 0.74 + 0.32 * m2;
      float t1 = st_noise(wp * 0.9 + 5.1), t2 = st_noise(wp * 2.3 + 1.7);
      cm *= 0.78 + 0.26 * t1 + 0.12 * t2;
      float worn = smoothstep(0.72, 0.88, st_noise(wp * 0.35 + 21.0) * 0.7 + t2 * 0.3);
      vec3 earth = (uRoadSoil.w > 0.5 ? uRoadSoil.rgb : vec3(0.31, 0.225, 0.15)) * (0.9 + 0.6 * lum) * (0.85 + 0.3 * t1);
      cm = mix(cm, earth, worn * 0.65);
      diffuseColor.rgb = mix(diffuseColor.rgb, cm, wl);
    }
    // relief on ALL the ground, grass or bare (surfaceNoise.ts surfTurf: sculpted earth — swells, chipped plates,
    // pebble clusters — lit through the normal); not on snow
    float tw = 1.0 - vBiome.y;
    if (tw > 0.0) {
      vec3 ct = surfTurf(diffuseColor.rgb, vWorldPos, normalize(vec3(vNxz.x, vUpN, vNxz.y)), length(vWorldPos - cameraPosition), bare);
      groundBump += surfBump * tw;
      diffuseColor.rgb = mix(diffuseColor.rgb, ct, tw);
    }
  }
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
    ${bright ? `// BRIGHT (over the hill): flat warm sandstone — the cliff's block facets (cliffTilt below) carry the detail.
    vec3 strata = vec3(0.6, 0.31, 0.19) * (0.9 + 0.14 * n1);` : 'vec3 strata = mix(vec3(0.62, 0.3, 0.15), vec3(0.78, 0.47, 0.27), band) * (0.93 + 0.1 * band2) * (fine ? 0.9 + 0.2 * st_noise(wp * 0.11) : 1.0);'}
    diffuseColor.rgb = mix(diffuseColor.rgb, strata, steep * vBiome.x * 0.85);
  }
  // CLIFFS (green lands + snow; the desert has its own strata above): one continuous face of real stone — the
  // CLIFF roughness (surfaceNoise.ts surfCliff: ridged beds, flutes, jointing, grit; its relief tilts the normal, cliffTilt in
  // the normal block), moss on the ledges and lips. The meadow ends in a crisp, irregular lip at the cliff edge
  // instead of washing grey over half-steep banks.
  cliffW = 1.0 - smoothstep(0.6, 0.67, vUpN + (st_noise(wp * 0.15) - 0.5) * 0.1);
  {
    float cliff = cliffW * (1.0 - vBiome.x);
    if (cliffW > 0.01) {
      // the face's horizontal axis (z for faces looking ±x, else x): the wall patches below are laid out along it
      float u = abs(vNxz.x) > abs(vNxz.y) ? wp.y : wp.x;
      // (2026-10-24: SMOOTH real rock in every style — the stacked Voronoi BLOCKS, each lit by its own tilted plane, read as
      // sharp triangles; now one continuous face with the CLIFF roughness profile (surfaceNoise.ts) — ledges, flutes, joints and
      // relief, its bump as the normal tilt.)
      if (cliff > 0.01) {
        float region = fine ? st_noise(wp * 0.008 + vec2(vWorldPos.y * 0.01)) : n1;
        // (Genshin: warm light-grey stone, lit ≈ 170,166,150 on screen — the blue comes from the cool sky fill in the shade;
        //  other styles slate blue ↔ lavender grey; a map's own stone over either: Zhangjiajie's tan sandstone)
        vec3 stone = hillStone(region);
        // (the slope faces the sky more than the crags' walls standing on it: its albedo sits a little lower)
        stone *= ${bright ? '0.9' : '0.8'};
        stone = surfCliff(stone, vWorldPos, normalize(vec3(vNxz.x, vUpN, vNxz.y)), length(vWorldPos - cameraPosition));
        cliffTilt = surfBump;
        if (uCliffStone.w > 1.5) {
          // a map's NATURAL SANDSTONE (uCliffStone.w = 2 — Zhangjiajie): no stacked blocks, a smooth face streaked down
          // its height — pale and grey bands, rust stains, dark wet runnels — and thin strata lines across it
          float s1 = st_noise(vec2(u * 0.22, vWorldPos.y * 0.01)), s2 = st_noise(vec2(u * 0.9 + 7.0, vWorldPos.y * 0.035));
          // FLUTES: the light turns across the face in vertical grooves (a normal tilt along the face, ~6–15 m apart,
          // finer ones between) — breaks the big flat planes of the heightfield's walls in the cel ramp
          float fl = st_noise(vec2(u * 0.11, vWorldPos.y * 0.004)) - st_noise(vec2(u * 0.11 + 0.35, vWorldPos.y * 0.004));
          float fl2 = st_noise(vec2(u * 0.45 + 3.0, vWorldPos.y * 0.012)) - st_noise(vec2(u * 0.45 + 3.25, vWorldPos.y * 0.012));
          cliffTilt = surfBump + vec3(-vNxz.y, 0.0, vNxz.x) * (fl * 2.4 + fl2 * 1.1) + vec3(0.0, (s2 - 0.5) * 0.25, 0.0);
          stone = mix(uCliffStone.rgb * 0.62, uCliffStone.rgb * 1.08, s1 * 0.65 + s2 * 0.35);
          float rust = smoothstep(0.7, 0.82, st_noise(vec2(u * 0.12 + 3.0, vWorldPos.y * 0.008)));
          stone = mix(stone, stone * vec3(1.1, 0.9, 0.74), rust * 0.45);
          float wetS = smoothstep(0.62, 0.74, st_noise(vec2(u * 0.4 + 9.0, vWorldPos.y * 0.006)));
          stone *= 1.0 - 0.5 * wetS;
          float layer = sin(vWorldPos.y * 0.21 + st_noise(wp * 0.015) * 4.0) * 0.5 + 0.5;
          stone *= 1.0 - 0.22 * smoothstep(0.82, 0.97, layer);
        }
        float mn = st_noise(wp * 0.21 + vec2(vWorldPos.y * 0.13));
        float moss = smoothstep(0.63, 0.7, vUpN + (mn - 0.5) * 0.2);
        stone = mix(stone, vec3(0.2, 0.3, 0.07) * (0.8 + 0.4 * mn), moss * (1.0 - vBiome.y) * 0.75);
        if (uCliffMoss.w > 0.0) {
          // a map's wall vegetation: rust streaks down the stone, then long hanging patches of shrubs and moss
          float rs = st_noise(vec2(u * 0.11, vWorldPos.y * 0.006));
          stone = mix(stone, stone * vec3(1.12, 0.78, 0.52), smoothstep(0.6, 0.72, rs) * (uCliffStone.w > 1.5 ? 0.0 : 0.8)); // (natural stone: its own, thinner rust)
          float hang = st_noise(vec2(u * 0.05, vWorldPos.y * 0.016)) * 0.62 + st_noise(vec2(u * 0.19, vWorldPos.y * 0.05)) * 0.38;
          float cov = smoothstep(1.0 - uCliffMoss.w - 0.06, 1.0 - uCliffMoss.w + 0.06, hang);
          stone = mix(stone, uCliffMoss.rgb * (0.7 + 0.55 * mn) * (0.85 + 0.3 * st_noise(vec2(u * 0.09, vWorldPos.y * 0.05) + 2.9)), cov);
        }
        stone *= mix(vec3(1.0), vec3(0.9, 0.96, 1.08), vBiome.y);${bright ? `
        // BRIGHT: snow clings to every ledge and less-steep part of a snowy cliff, its edge broken into long
        // horizontal brush strokes (their painted snow banks), slab tops snowed over.
        if (vBiome.y > 0.05) {
          float sk = st_noise(vec2(u * 0.3, vWorldPos.y * 2.4)) * 0.65 + st_noise(vec2(u * 1.2, vWorldPos.y * 7.0)) * 0.35;
          float sc = vBiome.y * smoothstep(0.5, 0.62, vUpN + (sk - 0.5) * 0.5);
          stone = mix(stone, vec3(0.82, 0.87, 0.95), sc);
        }` : ''}
        diffuseColor.rgb = mix(diffuseColor.rgb, stone, cliff);
      }
    }
  }
  if (vBiome.y > 0.01) {
    if (fine) {
      float sparkle = ${bright ? '0.0; // bright: matte snow (no confetti)' : 'step(0.988, st_hash(floor(wp * 22.0))) * 0.5;'}
      diffuseColor.rgb *= 1.0 + vBiome.y * ((st_noise(wp * 0.25) - 0.5) * 0.1 + sparkle);
    }
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.94, 0.97, 1.05), vBiome.y * 0.5);
  }
  // Under water: the bed darkens and turns blue-green with depth (seen through the semi-clear water);
  // a soft foam/wet line right at the shore.
  // (In the desert there is no water: basins and the river's bed are dry sand / clay pans — no wet tint there.
  //  In the snow the water is frozen: no wet band or foam at the ice edge either.)
  float wetZone = 1.0 - smoothstep(0.35, 0.6, ${bright ? 'vBiome.y' : 'vBiome.x + vBiome.y'}); // (bright: desert oases are wet)
  float wd = (${WATER_LEVEL.toFixed(2)} - vWorldPos.y);
  diffuseColor.rgb *= 1.0 - 0.35 * smoothstep(-0.8, 0.0, wd) * step(wd, 0.0) * 0.5 * wetZone; // wet dark band above
  ${!over && !story ? '// Genshin: the lake bed glows turquoise through clear shallows, deepening to teal.\n  ' : ''}if (wd > 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb * ${bright ? 'vec3(0.85, 1.0, 1.12)' : !over && !story ? 'vec3(0.45, 0.9, 0.88)' : 'vec3(0.5, 0.66, 0.7)'}, ${bright ? 'vec3(0.12, 0.32, 0.55)' : !over && !story ? 'vec3(0.01, 0.12, 0.14)' : 'vec3(0.015, 0.045, 0.055)'}, smoothstep(0.0, ${bright ? '4.0' : !over && !story ? '5.0' : '3.5'}, wd)), ${bright ? '1.0' : '1.0 - smoothstep(0.35, 0.6, vBiome.x)'});
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
    ${bright ? `// BRIGHT (over the hill): the desert track IS the sand — packed a shade darker with two darker wheel ruts.
    road = mix(road, diffuseColor.rgb * (0.88 - rutS * 0.16) * (0.95 + 0.1 * n2), vBiome.x * 0.92);` : 'road = mix(road, diffuseColor.rgb, vBiome.x * 0.4 * smoothstep(0.35, 0.75, st_noise(wp * 0.45 + 3.0)));'}
    ${bright ? `// BRIGHT: the main road is painted like the MUD TRACKS (hard, not a soft path) — packed darker earth in the carved
    // ruts (±1.35 m), loose crumbly soil with pebbles between and outside them, a darker berm line, ragged edges that
    // spill bare earth into the verge; in the desert the same over the sand's colour.
    {
      float s1 = st_noise(wp * 8.0), s3 = st_noise(wp * 0.7);
      float rutM = 1.0 - smoothstep(0.16, 0.4, abs(lat - 1.35));
      vec3 soilM = mix(vec3(0.34, 0.27, 0.2), diffuseColor.rgb * 0.82, vBiome.x * 0.85);
      vec3 looseM = soilM * (0.84 + 0.3 * s1 + (fine ? 0.12 * st_noise(wp * 3.1) - 0.06 : 0.0));
      if (fine) {
        vec2 pc = wp * 5.0, pi = floor(pc);
        float ph = st_hash(pi);
        vec2 pd = fract(pc) - 0.5 - (vec2(fract(ph * 7.3), fract(ph * 3.9)) - 0.5) * 0.4;
        float pr = 0.1 + 0.14 * fract(ph * 3.17);
        float peb = (1.0 - smoothstep(pr - 0.05, pr, length(pd))) * step(0.66, fract(ph * 11.3)) * (1.0 - rutM * 0.8);
        looseM = mix(looseM, vec3(0.5, 0.47, 0.43) * (0.8 + 0.35 * fract(ph * 5.1) - pd.y * 0.6), peb * 0.75);
      }
      vec3 hard = mix(looseM, soilM * (0.62 + 0.12 * s3), rutM);
      hard *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.35, abs(lat - 2.85))); // the berm's shaded inner face
      float edgeN = st_noise(wp * 0.3 + 4.0) * 0.65 + st_noise(wp * 1.7) * 0.35;
      float bareM = 1.0 - smoothstep(HALF + 0.1 + edgeN * 0.9, HALF + 0.6 + edgeN * 0.9, lat);
      road = mix(road, hard, bareM * (1.0 - vBiome.y * 0.85));
    }
    ` : ''}diffuseColor.rgb = mix(diffuseColor.rgb, road, 1.0 - smoothstep(HALF + 0.9, HALF + 1.6, lat));
    // ROAD roughness (surfaceNoise.ts surfRoad): packed grit, smoother in the wheel ruts, loose stones toward the edges
    { float rm = (1.0 - smoothstep(HALF + 0.9, HALF + 1.6, lat)) * (1.0 - vBiome.y * 0.8);
      groundBump *= 1.0 - rm;
      if (rm > 0.01) {
        float rutR = 1.0 - smoothstep(0.2, 0.55, abs(lat - 1.35));
        diffuseColor.rgb = mix(diffuseColor.rgb, surfRoad(diffuseColor.rgb, vWorldPos, normalize(vec3(vNxz.x, vUpN, vNxz.y)), length(vWorldPos - cameraPosition), rutR), rm);
        groundBump += surfBump * rm;
      } }
    roadDirt = (1.0 - smoothstep(HALF + 0.3, HALF + 1.0, lat)) * (1.0 - vBiome.y);
    snowRoad = 1.0 - smoothstep(HALF + 0.6, HALF + 1.4, lat); snowRut = rutS;
  }
  // OFF-ROAD TRACKS (network roads: GRAVEL type 0, TRAIL type 1 — the "mud roads"). Road/RoadDetail carves their
  // geometry on the LOD0 ribbon (two wheel ruts, the centre hump left standing, potholes, ditches); this paints it:
  // packed, darker, smoother earth in the RUTS, loose stony / crumbly ground between and outside them, a patchy
  // GRASSY HUMP down the middle, ragged grass-eaten EDGES, loose stones on gravel; mud + water come from vMud below.
  // vRoadNet.x = distance from the road EDGE (<0 on it). ~35 ALU (LOW skips the fine noise).
  if (vRoadNet.y > -0.5 && vRoadNet.x < 0.8) {
    float e = vRoadNet.x;
    bool gravelT = vRoadNet.y < 0.5;
    float lat = max(0.0, e + (gravelT ? 2.3 : 1.35)); // from the centreline
    float s1 = st_noise(wp * 8.0), s3 = st_noise(wp * 0.7);
    float rut = 1.0 - smoothstep(0.12, 0.36, abs(lat - (gravelT ? 0.8 : 0.74)));
    // EACH MAP'S OWN TRACK (2026-10-24): the gravel is its dirt (palette \`dirt\`) and its hills' stone (palette \`cliff\`), not one
    // fixed grey-beige; the lusher the ground around it (the meadow's green), the more the grass eats in from the edges
    // and down the hump — a lime meadow's track is a narrow worn path, a bare valley's a wide stony bed.
    float lushT = smoothstep(0.0, 0.05, diffuseColor.g - max(diffuseColor.r, diffuseColor.b)) * (1.0 - vBiome.x) * (1.0 - vBiome.y);
    vec3 mapDirt = uRoadSoil.w > 0.5 ? uRoadSoil.rgb : vec3(0.31, 0.225, 0.15);
    vec3 gravelC = uRoadSoil.w > 0.5 ? mix(vec3(0.36, 0.31, 0.25), mapDirt * 0.95, 0.55) : vec3(0.36, 0.31, 0.25);
    if (uCliffStone.w > 0.5) gravelC = mix(gravelC, uCliffStone.rgb * 0.68, 0.3);
    vec3 pebC = uCliffStone.w > 0.5 ? uCliffStone.rgb * 0.95 : vec3(0.5, 0.48, 0.45);
    vec3 soil = gravelT ? gravelC : mapDirt; // (a map's own dirt)
    vec3 loose = soil * (0.8 + 0.3 * s1 + (fine ? 0.12 * st_noise(wp * 3.1) - 0.06 : 0.0));
    if (gravelT) {
      // Loose round pebbles (one hashed pebble per 0.2 m cell, ~40 % of cells), lit on top.
      vec2 pc = wp * 5.0, pi = floor(pc);
      float ph = st_hash(pi);
      vec2 pd = fract(pc) - (0.3 + 0.4 * vec2(ph, fract(ph * 7.31)));
      float pr = 0.12 + 0.16 * fract(ph * 3.17);
      float peb = (1.0 - smoothstep(pr - 0.06, pr, length(pd))) * step(0.6, fract(ph * 11.3)) * (1.0 - rut * 0.7);
      loose = mix(loose, pebC * (0.8 + 0.35 * fract(ph * 5.1) - pd.y * 0.6), peb * 0.8);
    }
    vec3 surf = mix(loose, soil * (0.6 + 0.12 * s3), rut);
    float hump = (1.0 - smoothstep(0.2, 0.46, lat + (s1 - 0.5) * 0.14)) * smoothstep(0.3, 0.62, s3 + (gravelT ? -0.12 : 0.18) + 0.2 * lushT);
    surf = mix(surf, diffuseColor.rgb * (0.88 + 0.16 * s1), hump * 0.85);
    // Ragged edges: grass eats into the track here, bare earth spills past the edge there (±0.5 m).
    float edgeN = st_noise(wp * 0.3 + 4.0) * 0.65 + st_noise(wp * 1.7) * 0.35;
    float bare = 1.0 - smoothstep(-0.65 + edgeN * 0.95 - 0.45 * lushT, -0.25 + edgeN * 0.95 - 0.45 * lushT, e);
    // (2026-10-25, junctions: the MAIN ROAD wins over a track crossing or joining it — the track's paint stopped in a
    //  straight line at the road ribbon's edge and in a sawtooth along the 2 m grid's triangles there)
    bare *= smoothstep(HALF + 0.6, HALF + 2.2, abs(vRoadLat));
    // Snow: packed snow, icy blue-grey ruts. Sand: drifted over the track.
    surf = mix(surf, vec3(0.7, 0.75, 0.84) * (0.88 + 0.15 * s1) * (1.0 - rut * 0.2), vBiome.y * 0.8);
    surf = mix(surf, diffuseColor.rgb, vBiome.x * 0.5 * smoothstep(0.3, 0.7, s3));
    diffuseColor.rgb = mix(diffuseColor.rgb, surf, bare);
    // (the track's own roughness: packed in the ruts, loose stones between them — surfRoad)
    groundBump *= 1.0 - bare;
    if (bare > 0.01) {
      diffuseColor.rgb = mix(diffuseColor.rgb, surfRoad(diffuseColor.rgb, vWorldPos, normalize(vec3(vNxz.x, vUpN, vNxz.y)), length(vWorldPos - cameraPosition), rut), bare * (1.0 - vBiome.y * 0.8));
      groundBump += surfBump * bare * (1.0 - vBiome.y * 0.8);
    }
    roadDirt = max(roadDirt, bare * (1.0 - vBiome.y));
    if (bare > snowRoad) { snowRoad = bare; snowRut = rut; }
  }
  // SNOW SURFACE (surfaceNoise.ts surfSnow): drifts, wind ripples, crust, thin patches over grass; packed snow, polished
  // ruts and slush on the roads — every snowfield, over the colour above (not on the cliffs: they have their own rock)
  if (vBiome.y > 0.02) {
    float sw = smoothstep(0.02, 0.5, vBiome.y) * (1.0 - cliffW);
    vec3 sc = surfSnow(diffuseColor.rgb, vWorldPos, normalize(vec3(vNxz.x, vUpN, vNxz.y)), length(vWorldPos - cameraPosition), snowRoad, snowRut);
    diffuseColor.rgb = mix(diffuseColor.rgb, sc, sw);
    groundBump = mix(groundBump, surfBump, sw);
  }
  // MUD + STANDING WATER (vMud: the road ribbon's damp weight, 0 elsewhere): dark wet earth in the rut bottoms,
  // potholes and ditch bottoms; the deepest hollows of muddy stretches always hold water, and every hollow collects
  // it when it rains (the puddle mirror after lighting). Slushy grey in the snow, nothing in the desert.
  if (vMud > 0.01) {
    float m = clamp(vMud * 1.3, 0.0, 1.0) * (1.0 - vBiome.x);
    vec3 mudC = mix(vec3(0.12, 0.085, 0.055), vec3(0.4, 0.43, 0.5), vBiome.y) * (0.85 + 0.3 * n1);
    diffuseColor.rgb = mix(diffuseColor.rgb, mudC, m * 0.8);
    float water = smoothstep(0.6, 0.78, vMud + 0.3 * uWet) * (1.0 - vBiome.x) * (1.0 - smoothstep(0.25, 0.4, vBiome.y)) * smoothstep(0.75, 0.9, vUpN);
    wetPuddle = max(wetPuddle, water);
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
  ${o.biomeCover === 'rock' && bright ? `// BRIGHT: no desert re-tint — slab rock, formations and boulders are already sandstone in their vertex /
  // instance colours, and the same mesh carries the bridges' planks and the camps' white tents.` : o.biomeCover === 'rock' ? `// Desert sandstone: wavy horizontal strata in warm reds and creams.
  if (vBiomeW.x > 0.02) {
    float band = sin(vWPos.y * 3.3 + bn * 2.4) * 0.5 + 0.5;
    vec3 strata = mix(vec3(0.62, 0.3, 0.16), vec3(0.86, 0.62, 0.4), band) * (0.8 + 0.3 * bn);
    diffuseColor.rgb = mix(diffuseColor.rgb, strata, vBiomeW.x * 0.75);
  }` : ''}
  // Snow cover: up-facing surfaces whiten (tops of shelves, not the undersides seen from below the canopy).
  float up = vSnowUp + (bn - 0.5) * 0.55;${o.biomeCover === 'rock' && bright ? `
  // BRIGHT: a PAINTED snow edge on rock (their snow banks): long horizontal brush strokes break the line.
  { float sk = st_noise(vec2((vWPos.x + vWPos.z) * 0.35, vWPos.y * 3.2)) * 0.65 + st_noise(vec2((vWPos.x - vWPos.z) * 1.1, vWPos.y * 9.0)) * 0.35;
    up = vSnowUp + (sk - 0.5) * 0.9; }` : ''}
  // (Card canopies — Genshin / storybook — carry snow on both faces of every upward-facing card: Dragonspine's
  //  conifers are heavy with it; the overland solid shelves only on their top faces.)
  float cover = vBiomeW.y * smoothstep(${o.biomeCover === 'rock' ? '0.05, 0.4' : over ? '0.45, 0.85' : '0.0, 0.55'}, up) * (gl_FrontFacing ? 1.0 : ${over ? '0.3' : '0.4'});${o.biomeCover === 'foliage' && !over ? `
  // (2026-10-24, real snowy conifers: snow lies in CLUMPS on the branch tops open to the sky — a noise mask over ~0.5–3 m,
  //  favouring the most sky-facing parts — and the dark green needles show between and beneath; never a white tree.)
  cover *= 0.9 * smoothstep(0.38, 0.62, bn * 0.55 + st_noise(vWPos.xz * 0.35 + vec2(vWPos.y * 0.5, 3.7)) * 0.45 + 0.25 * (up - 0.4));` : ''}
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
  ${o.terrain && !bright ? `{ // Sun glints on snow and sand: sparse cells that flash toward the key light (view dependent).
    // (Not in bright: over the hill's sand and snow are matte — the glints read as white confetti around the car.)
    float gd = length(vWorldPos - cameraPosition);
    float soft = (vBiome.y + vBiome.x * 0.55) * uSurfaceDetail;
    if (soft > 0.02 && gd < 45.0) {
      vec3 Hg = normalize(V + uKeyDirView);
      float cell = st_hash(floor(vWorldPos.xz * 24.0 + floor(vWorldPos.y * 24.0)));
      float glint = step(0.985, cell) * pow(clamp(dot(normal, Hg), 0.0, 1.0), 30.0) * soft * (1.0 - smoothstep(12.0, 45.0, gd));
      outgoingLight += uKeyColor * glint * 3.0;
    }
  }
  if (uWet > 0.01 || wetPuddle > 0.001) {
    // Sheen: a broad specular lobe toward the key light on wet ground; puddles mirror the sky (Fresnel-ish) — rain
    // puddles, and the standing water in the road ribbon's ruts / potholes / ditches (vMud) even when it's dry.
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
  material.customProgramCacheKey = () => `${prevKey()}|stylize2-${o.key}${o.biomeCover ? '-bc' : ''}${o.erosion ? '-ero' : ''}${o.rockDetail ? '-rd' + o.rockDetail : ''}${o.hillTint ? '-ht' : ''}${o.treeShade ? (o.treeShade === 'vertex' ? '-tsv' : '-ts') : ''}${story ? '-story' : ''}${over ? '-over' : ''}${gen ? '-gen' : ''}`
  return material
}
