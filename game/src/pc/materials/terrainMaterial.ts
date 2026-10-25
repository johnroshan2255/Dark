import * as pc from 'playcanvas'
import { GUST_GLSL } from '../../rendering/shaders/uniforms'
import { NOISE, TRAIL_GLSL, hillStoneGLSL } from '../../rendering/shaders/stylize'
import { SURFACE_NOISE_GLSL } from '../../rendering/shaders/surfaceNoise'
import { WorldFields } from '../../world/WorldFields'
import { activeLook } from '../look'
import { applyWorldLook } from './common'

/**
 * The TERRAIN on PlayCanvas: the engine's StandardMaterial (vertex-colour albedo, its lights, cascaded shadows, tone
 * mapping) with DARK's ground painted in its shader chunks — the port of the three build's stylize terrain block
 * (bright style), in world space:
 *  - diffusePS (getAlbedo): the ground's colour noise and painted brush, meadow variation, ground / turf relief, the
 *    desert, the CLIFFS (the map's stone, natural sandstone streaks, moss, hanging vegetation, snow on ledges), snow,
 *    the shore and the lake bed, wet ground and puddles, the ROAD (packed earth with ruts and berms), the off-road
 *    TRACKS (gravel / trail: ruts, hump, ragged edges, pebbles), the snow surface, mud and standing water. It also
 *    computes the relief (groundBump, cliffTilt) — getNormal runs right after it;
 *  - normalMapPS (getNormal): that relief + the sand ripples / sastrugi tilt the normal;
 *  - the shared world look (common.ts): toon ramp, rim, sky-coloured fog with aerial perspective and mist.
 * Vertex data (TerrainGeometry's: the three build's attribute set): colour (sRGB bytes), roadLat (ATTR8), roadNet
 * (netEdge, netType — ATTR9), biome (desert, snow — ATTR10), mud (ATTR7). TERRAIN_ATTRS maps them for toPcMesh.
 * Compile time (measured, the forward shader): D3D11 (Windows Chrome's default ANGLE) ~12 s on a first visit (then
 * Chrome's program cache), OpenGL 1.3 s, Vulkan ~0 — the cliffs (~40 %), roads, tracks and snow each add a share.
 */
const WATER = WorldFields.WATER.toFixed(2)

const DECL_VS = /* glsl */ `
attribute float aRoadLat; attribute vec2 aRoadNet; attribute vec2 aBiome; attribute float aMud;
varying vec4 vRoad; varying vec2 vBiomeT;
`
const MAIN_END_VS = /* glsl */ `
  vRoad = vec4(aRoadLat, aRoadNet, aMud); vBiomeT = aBiome;
`
const DECL_PS = /* glsl */ `
uniform float uTime; uniform vec2 uWind; uniform float uWet; uniform sampler2D uBrush;
// (the map's look: × the contrast of the fine colour noise, about its mean — the soft look keeps the big colour
//  regions and lets the lit relief carry the detail)
uniform float uDetailK;
#define SN_DETAIL_K uDetailK
#define uTimeS uTime
#define uWindS uWind
varying vec4 vRoad; varying vec2 vBiomeT;
float wetPuddle = 0.0;
float cliffW = 0.0; vec3 cliffTilt = vec3(0.0);
vec3 groundBump = vec3(0.0);
float roadDirt = 0.0;
float snowRoad = 0.0, snowRut = 0.0;
${NOISE}
${GUST_GLSL}
${TRAIL_GLSL}
${hillStoneGLSL(false)}
${SURFACE_NOISE_GLSL}
`

const ALBEDO_PS = /* glsl */ `
void getAlbedo() {
  vec3 c = saturate(vVertexColor.rgb);
  vec3 nW = normalize(vNormalW);
  float upN = nW.y; vec2 nxz = nW.xz;
  vec3 P = vPositionW;
  vec2 wp = P.xz;
  float dist = length(P - uCamPos);
  vec2 bio = vBiomeT;
  bool fine = uSurfaceDetail > 0.5;
  float n1 = st_noise(wp * 0.33), n2 = fine ? st_noise(wp * 1.9) : 0.5;
  c *= 0.905 + 0.22 * n1 + uDetailK * (0.12 * (n2 - 0.5) + (fine ? 0.05 * (st_noise(wp * 7.0) - 0.5) : 0.0));
  vec4 gb = texture2D(uBrush, wp * 0.045);
  c *= 1.0 + uDetailK * (0.2 * (gb.g - 0.5) + 0.26 * (gb.r - 0.5));
  float green = smoothstep(0.0, 0.03, c.g - c.b) * smoothstep(0.0, 0.02, c.g - c.r * 0.8) * (1.0 - bio.x - bio.y);
  if (fine && green > 0.0) {
    float streak = st_noise(vec2(wp.x * 6.0 + wp.y * 1.5, wp.y * 6.0 - wp.x * 1.5));
    c *= 1.0 + green * ((streak - 0.5) * 0.14 * uDetailK + windGust(wp, uTimeS, uWindS) * 0.14);
  }
  {
    float lush = smoothstep(0.0, 0.03, c.g - c.b) * smoothstep(0.0, 0.02, c.g - c.r * 0.8) * (1.0 - bio.x);
    float bare = (1.0 - 0.85 * lush) * (1.0 - bio.y);
    c = surfGround(c, P, nW, dist, bare);
    groundBump = surfBump;
    if (lush > 0.0) {
      float wl = lush * (1.0 - bio.y);
      float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float m1 = st_noise(wp * 0.04 + 3.7), m2 = st_noise(wp * 0.13 + 11.3);
      float dryM = smoothstep(0.45, 0.85, m1 * 0.65 + m2 * 0.35);
      float deepM = smoothstep(0.5, 0.15, m1 * 0.5 + m2 * 0.5);
      vec3 cm = c;
      cm = mix(cm, cm * vec3(1.05, 0.9, 0.5) + vec3(0.04, 0.025, 0.0), dryM * 0.85);
      cm = mix(cm, cm * vec3(0.55, 0.7, 0.72), deepM * 0.75);
      cm *= 0.74 + 0.32 * m2;
      float t1 = st_noise(wp * 0.9 + 5.1), t2 = st_noise(wp * 2.3 + 1.7);
      cm *= 0.97 + uDetailK * (0.26 * (t1 - 0.5) + 0.12 * (t2 - 0.5));
      float worn = smoothstep(0.72, 0.88, st_noise(wp * 0.35 + 21.0) * 0.7 + t2 * 0.3);
      vec3 earth = (uRoadSoil.w > 0.5 ? uRoadSoil.rgb : vec3(0.31, 0.225, 0.15)) * (0.9 + 0.6 * lum) * (0.85 + 0.3 * t1);
      cm = mix(cm, earth, worn * 0.65);
      c = mix(c, cm, wl);
    }
    float tw = 1.0 - bio.y;
    if (tw > 0.0) {
      vec3 ct = surfTurf(c, P, nW, dist, bare);
      groundBump += surfBump * tw;
      c = mix(c, ct, tw);
    }
  }
  if (bio.x > 0.01) {
    float steep = 1.0 - smoothstep(0.55, 0.85, upN);
    if (fine) {
      float rip = sin((wp.x * 0.9 + wp.y * 0.35) * 2.2 + st_noise(wp * 0.3) * 4.0) * 0.5 + 0.5;
      c *= 1.0 + bio.x * ((rip - 0.5) * 0.16 * (1.0 - steep) + (st_hash(floor(wp * 14.0)) - 0.5) * 0.06);
    }
    vec3 strata = vec3(0.6, 0.31, 0.19) * (0.9 + 0.14 * n1);
    c = mix(c, strata, steep * bio.x * 0.85);
  }
  cliffW = 1.0 - smoothstep(0.6, 0.67, upN + (st_noise(wp * 0.15) - 0.5) * 0.1);
  {
    float cliff = cliffW * (1.0 - bio.x);
    if (cliff > 0.01) {
      float u = abs(nxz.x) > abs(nxz.y) ? wp.y : wp.x;
      float region = fine ? st_noise(wp * 0.008 + vec2(P.y * 0.01)) : n1;
      vec3 stone = hillStone(region) * 0.9;
      stone = surfCliff(stone, P, nW, dist);
      cliffTilt = surfBump;
      if (uCliffStone.w > 1.5) {
        float s1 = st_noise(vec2(u * 0.22, P.y * 0.01)), s2 = st_noise(vec2(u * 0.9 + 7.0, P.y * 0.035));
        float fl = st_noise(vec2(u * 0.11, P.y * 0.004)) - st_noise(vec2(u * 0.11 + 0.35, P.y * 0.004));
        float fl2 = st_noise(vec2(u * 0.45 + 3.0, P.y * 0.012)) - st_noise(vec2(u * 0.45 + 3.25, P.y * 0.012));
        cliffTilt = surfBump + vec3(-nxz.y, 0.0, nxz.x) * (fl * 2.4 + fl2 * 1.1) * uDetailK + vec3(0.0, (s2 - 0.5) * 0.25, 0.0);
        stone = mix(uCliffStone.rgb * 0.62, uCliffStone.rgb * 1.08, 0.5 + ((s1 - 0.5) * 0.65 + (s2 - 0.5) * 0.35) * uDetailK);
        float rust = smoothstep(0.7, 0.82, st_noise(vec2(u * 0.12 + 3.0, P.y * 0.008)));
        stone = mix(stone, stone * vec3(1.1, 0.9, 0.74), rust * 0.45);
        float wetS = smoothstep(0.62, 0.74, st_noise(vec2(u * 0.4 + 9.0, P.y * 0.006)));
        stone *= 1.0 - 0.5 * wetS * uDetailK;
        float layer = sin(P.y * 0.21 + st_noise(wp * 0.015) * 4.0) * 0.5 + 0.5;
        stone *= 1.0 - 0.22 * smoothstep(0.82, 0.97, layer) * uDetailK;
      }
      float mn = st_noise(wp * 0.21 + vec2(P.y * 0.13));
      float moss = smoothstep(0.63, 0.7, upN + (mn - 0.5) * 0.2);
      stone = mix(stone, vec3(0.2, 0.3, 0.07) * (0.8 + 0.4 * mn), moss * (1.0 - bio.y) * 0.75);
      if (uCliffMoss.w > 0.0) {
        float rs = st_noise(vec2(u * 0.11, P.y * 0.006));
        stone = mix(stone, stone * vec3(1.12, 0.78, 0.52), smoothstep(0.6, 0.72, rs) * (uCliffStone.w > 1.5 ? 0.0 : 0.8));
        float hang = st_noise(vec2(u * 0.05, P.y * 0.016)) * 0.62 + st_noise(vec2(u * 0.19, P.y * 0.05)) * 0.38;
        float cov = smoothstep(1.0 - uCliffMoss.w - 0.06, 1.0 - uCliffMoss.w + 0.06, hang);
        stone = mix(stone, uCliffMoss.rgb * (0.7 + 0.55 * mn) * (0.85 + 0.3 * st_noise(vec2(u * 0.09, P.y * 0.05) + 2.9)), cov);
      }
      stone *= mix(vec3(1.0), vec3(0.9, 0.96, 1.08), bio.y);
      if (bio.y > 0.05) {
        float sk = st_noise(vec2(u * 0.3, P.y * 2.4)) * 0.65 + st_noise(vec2(u * 1.2, P.y * 7.0)) * 0.35;
        float sc = bio.y * smoothstep(0.5, 0.62, upN + (sk - 0.5) * 0.5);
        stone = mix(stone, vec3(0.82, 0.87, 0.95), sc);
      }
      c = mix(c, stone, cliff);
    }
  }
  if (bio.y > 0.01) {
    if (fine) c *= 1.0 + bio.y * ((st_noise(wp * 0.25) - 0.5) * 0.1);
    c = mix(c, c * vec3(0.94, 0.97, 1.05), bio.y * 0.5);
  }
  float wetZone = 1.0 - smoothstep(0.35, 0.6, bio.y);
  float wd = ${WATER} - P.y;
  c *= 1.0 - 0.35 * smoothstep(-0.8, 0.0, wd) * step(wd, 0.0) * 0.5 * wetZone;
  if (wd > 0.0) c = mix(c, mix(c * vec3(0.85, 1.0, 1.12), vec3(0.12, 0.32, 0.55), smoothstep(0.0, 4.0, wd)), 1.0);
  wd = mix(-10.0, wd, wetZone);
  float foam = 1.0 - smoothstep(0.0, 0.18, abs(wd - 0.04));
  if (foam > 0.0) c += vec3(0.25, 0.27, 0.27) * foam * (0.5 + 0.5 * st_noise(wp * 3.0 + vec2(uTimeS * 0.3)));
  {
    float tk = bio.x + bio.y > 0.02 ? trailAt(wp) * clamp(bio.x + bio.y, 0.0, 1.0) : 0.0;
    if (tk > 0.003) {
      c *= mix(vec3(1.0), vec3(0.58, 0.68, 0.86), tk * bio.y);
      c *= mix(vec3(1.0), vec3(0.8, 0.7, 0.58), tk * bio.x * 0.8);
    }
  }
  if (uWet > 0.01) {
    c *= 1.0 - 0.35 * uWet;
    float flatGround = smoothstep(0.85, 0.97, upN);
    float pm = st_noise(wp * 0.35 + 5.0) * 0.6 + st_noise(wp * 1.4 + 9.0) * 0.4;
    wetPuddle = smoothstep(0.62, 0.72, pm + 0.12 * uWet) * flatGround * uWet;
  }
  float lat = abs(vRoad.x);
  const float HALF = 2.7;
  if (lat < HALF + 1.6) {
    float a3 = st_noise(wp * 6.0);
    float g1 = st_noise(wp * 9.0), g2 = st_noise(wp * 23.0);
    vec3 gravel = vec3(0.27, 0.23, 0.18) * (0.72 + 0.28 * g1 + 0.22 * g2 + 0.1 * n2);
    vec3 dirt = vec3(0.66, 0.52, 0.34) * (0.84 + 0.2 * n2 + 0.1 * a3 + 0.08 * st_noise(wp * 2.3));
    float ruts = (1.0 - smoothstep(0.25, 0.55, abs(lat - 1.35)));
    dirt *= 1.0 - ruts * 0.18 * uDetailK;
    vec3 road = mix(dirt, gravel * 1.5, smoothstep(HALF - 0.1, HALF + 0.25, lat));
    float edgeN0 = st_noise(wp * 0.11 + 4.0) * 0.65 + st_noise(wp * 0.6 + 2.0) * 0.35;
    float edge0 = 2.0 + (edgeN0 - 0.5) * 1.8;
    float median = (1.0 - smoothstep(0.3, 0.55, lat + (st_noise(wp * 0.9) - 0.5) * 0.3)) * smoothstep(0.5, 0.62, st_noise(vec2(P.z * 0.012, 1.3)));
    float bareR = (1.0 - smoothstep(edge0 - 0.45, edge0 + 0.3, lat)) * (1.0 - median * 0.85);
    road = mix(c * (0.9 + 0.1 * a3), dirt * (1.0 + 0.06 * (1.0 - ruts)), bareR);
    float rutS = 1.0 - smoothstep(0.2, 0.6, abs(lat - 1.35));
    vec3 packedSnow = vec3(0.68, 0.73, 0.82) * (0.9 + 0.12 * n2) * (1.0 - rutS * 0.25);
    road = mix(road, packedSnow, bio.y * 0.85);
    road = mix(road, c * (0.88 - rutS * 0.16) * (0.95 + 0.1 * n2), bio.x * 0.92);
    {
      float s1 = st_noise(wp * 8.0), s3 = st_noise(wp * 0.7);
      float rutM = 1.0 - smoothstep(0.16, 0.4, abs(lat - 1.35));
      vec3 soilM = mix(vec3(0.34, 0.27, 0.2), c * 0.82, bio.x * 0.85);
      vec3 looseM = soilM * (0.84 + 0.3 * s1 + (fine ? 0.12 * st_noise(wp * 3.1) - 0.06 : 0.0));
      if (fine) {
        vec2 pc = wp * 5.0, pi = floor(pc);
        float ph = st_hash(pi);
        vec2 pd = fract(pc) - 0.5 - (vec2(fract(ph * 7.3), fract(ph * 3.9)) - 0.5) * 0.4;
        float pr = 0.1 + 0.14 * fract(ph * 3.17);
        float peb = (1.0 - smoothstep(pr - 0.05, pr, length(pd))) * step(0.66, fract(ph * 11.3)) * (1.0 - rutM * 0.8);
        looseM = mix(looseM, vec3(0.5, 0.47, 0.43) * (0.8 + 0.35 * fract(ph * 5.1) - pd.y * 0.6), peb * 0.75 * uDetailK);
      }
      vec3 hard = mix(looseM, soilM * (0.62 + 0.12 * s3), rutM);
      hard *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.35, abs(lat - 2.85)));
      float edgeN = st_noise(wp * 0.3 + 4.0) * 0.65 + st_noise(wp * 1.7) * 0.35;
      float bareM = 1.0 - smoothstep(HALF + 0.1 + edgeN * 0.9, HALF + 0.6 + edgeN * 0.9, lat);
      road = mix(road, hard, bareM * (1.0 - bio.y * 0.85));
    }
    c = mix(c, road, 1.0 - smoothstep(HALF + 0.9, HALF + 1.6, lat));
    { float rm = (1.0 - smoothstep(HALF + 0.9, HALF + 1.6, lat)) * (1.0 - bio.y * 0.8);
      groundBump *= 1.0 - rm;
      if (rm > 0.01) {
        float rutR = 1.0 - smoothstep(0.2, 0.55, abs(lat - 1.35));
        c = mix(c, surfRoad(c, P, nW, dist, rutR), rm);
        groundBump += surfBump * rm;
      } }
    roadDirt = (1.0 - smoothstep(HALF + 0.3, HALF + 1.0, lat)) * (1.0 - bio.y);
    snowRoad = 1.0 - smoothstep(HALF + 0.6, HALF + 1.4, lat); snowRut = rutS;
  }
  if (vRoad.z > -0.5 && vRoad.y < 0.8) {
    float e = vRoad.y;
    bool gravelT = vRoad.z < 0.5;
    float latT = max(0.0, e + (gravelT ? 2.3 : 1.35));
    float s1 = st_noise(wp * 8.0), s3 = st_noise(wp * 0.7);
    float rut = 1.0 - smoothstep(0.12, 0.36, abs(latT - (gravelT ? 0.8 : 0.74)));
    float lushT = smoothstep(0.0, 0.05, c.g - max(c.r, c.b)) * (1.0 - bio.x) * (1.0 - bio.y);
    vec3 mapDirt = uRoadSoil.w > 0.5 ? uRoadSoil.rgb : vec3(0.31, 0.225, 0.15);
    vec3 gravelC = uRoadSoil.w > 0.5 ? mix(vec3(0.36, 0.31, 0.25), mapDirt * 0.95, 0.55) : vec3(0.36, 0.31, 0.25);
    if (uCliffStone.w > 0.5) gravelC = mix(gravelC, uCliffStone.rgb * 0.68, 0.3);
    vec3 pebC = uCliffStone.w > 0.5 ? uCliffStone.rgb * 0.95 : vec3(0.5, 0.48, 0.45);
    vec3 soil = gravelT ? gravelC : mapDirt;
    vec3 loose = soil * (0.8 + 0.3 * s1 + (fine ? 0.12 * st_noise(wp * 3.1) - 0.06 : 0.0));
    if (gravelT) {
      vec2 pc = wp * 5.0, pi = floor(pc);
      float ph = st_hash(pi);
      vec2 pd = fract(pc) - (0.3 + 0.4 * vec2(ph, fract(ph * 7.31)));
      float pr = 0.12 + 0.16 * fract(ph * 3.17);
      float peb = (1.0 - smoothstep(pr - 0.06, pr, length(pd))) * step(0.6, fract(ph * 11.3)) * (1.0 - rut * 0.7);
      loose = mix(loose, pebC * (0.8 + 0.35 * fract(ph * 5.1) - pd.y * 0.6), peb * 0.8 * uDetailK);
    }
    vec3 surf = mix(loose, soil * (0.6 + 0.12 * s3), rut * (0.4 + 0.6 * uDetailK));
    float hump = (1.0 - smoothstep(0.2, 0.46, latT + (s1 - 0.5) * 0.14)) * smoothstep(0.3, 0.62, s3 + (gravelT ? -0.12 : 0.18) + 0.2 * lushT);
    surf = mix(surf, c * (0.88 + 0.16 * s1), hump * 0.85);
    float edgeN = st_noise(wp * 0.3 + 4.0) * 0.65 + st_noise(wp * 1.7) * 0.35;
    float bareT = 1.0 - smoothstep(-0.65 + edgeN * 0.95 - 0.45 * lushT, -0.25 + edgeN * 0.95 - 0.45 * lushT, e);
    // (junctions: the MAIN ROAD wins over a track crossing or joining it — no straight edge at the ribbon, no sawtooth)
    bareT *= smoothstep(HALF + 0.6, HALF + 2.2, lat);
    surf = mix(surf, vec3(0.7, 0.75, 0.84) * (0.88 + 0.15 * s1) * (1.0 - rut * 0.2), bio.y * 0.8);
    surf = mix(surf, c, bio.x * 0.5 * smoothstep(0.3, 0.7, s3));
    c = mix(c, surf, bareT);
    groundBump *= 1.0 - bareT;
    if (bareT > 0.01) {
      c = mix(c, surfRoad(c, P, nW, dist, rut), bareT * (1.0 - bio.y * 0.8));
      groundBump += surfBump * bareT * (1.0 - bio.y * 0.8);
    }
    roadDirt = max(roadDirt, bareT * (1.0 - bio.y));
    if (bareT > snowRoad) { snowRoad = bareT; snowRut = rut; }
  }
  if (bio.y > 0.02) {
    float sw = smoothstep(0.02, 0.5, bio.y) * (1.0 - cliffW);
    vec3 sc = surfSnow(c, P, nW, dist, snowRoad, snowRut);
    c = mix(c, sc, sw);
    groundBump = mix(groundBump, surfBump, sw);
  }
  float mudW = vRoad.w;
  if (mudW > 0.01) {
    float m = clamp(mudW * 1.3, 0.0, 1.0) * (1.0 - bio.x);
    vec3 mudC = mix(vec3(0.12, 0.085, 0.055), vec3(0.4, 0.43, 0.5), bio.y) * (0.85 + 0.3 * n1);
    c = mix(c, mudC, m * 0.8);
    float water = smoothstep(0.6, 0.78, mudW + 0.3 * uWet) * (1.0 - bio.x) * (1.0 - smoothstep(0.25, 0.4, bio.y)) * smoothstep(0.75, 0.9, upN);
    wetPuddle = max(wetPuddle, water);
  }
  dAlbedo = c;
}
`

const NORMAL_PS = /* glsl */ `
void getNormal() {
  dNormalW = dVertexNormalW;
  vec2 sg = softGroundGrad(vPositionW.xz, vBiomeT, length(vPositionW - uCamPos));
  if (dot(sg, sg) > 1e-8) dNormalW = normalize(dNormalW + vec3(-sg.x, 0.0, -sg.y));
  if (cliffW > 0.01) dNormalW = normalize(dNormalW + cliffTilt * cliffW);
  groundBump *= 1.0 - cliffW;
  if (dot(groundBump, groundBump) > 1e-6) dNormalW = normalize(dNormalW + groundBump);
}
`

/**
 * THE SOFT GROUND (map.json look 'soft' — the Over the Hill reference): every surface ONE calm colour (the map's
 * palette: the vertex colour, the road soil, the cliff stone, sand, snow) with only a broad ±6 % drift over tens of
 * metres — no colour noise, brush, pebble discs or streaks; the DETAIL is the crumpled relief texture (uRelief:
 * detailRelief.ts) tilting the normal, so the sun draws it — strong on bare earth, roads and cliffs, faint on turf —
 * and its crevices a little darker. Two texture fetches instead of the procedural surface noise (surfaceNoise.ts):
 * cheaper on every tier. The road keeps soft wheel ruts and its ragged verge, the shore its foam, the weather its
 * wet ground and puddles.
 */
const SOFT_DECL_PS = /* glsl */ `
uniform sampler2D uRelief; uniform vec4 uPalGrass; uniform vec4 uPalDirt;
float sRelief = 0.3;
vec3 sReliefN = vec3(0.0);
`
const SOFT_ALBEDO_PS = /* glsl */ `
vec4 reliefAt(vec2 uv) { return texture2D(uRelief, uv); }
void getAlbedo() {
  vec3 c = saturate(vVertexColor.rgb);
  vec3 nW = normalize(vNormalW);
  float upN = nW.y; vec2 nxz = nW.xz;
  vec3 P = vPositionW;
  vec2 wp = P.xz;
  vec2 bio = vBiomeT;
  float n1 = st_noise(wp * 0.02);
  // THE GRASS / BARE-EARTH EDGE, redrawn: the vertex colours blend linearly across the 2 m triangles (straight,
  // polygonal edges) — the colour's place between the map's dirt and grass is re-thresholded through a ragged noise
  // (2 octaves, ≈ 1–4 m), so a clearing's edge is organic
  // (the vertex colour's ROCK tint on steep ground — a blurry gradient over the triangles — out: the shader draws the
  //  rock itself, with a defined edge, below)
  if (uPalGrass.w > 0.5 && uCliffStone.w > 0.5) {
    vec3 gr = mix(uCliffStone.rgb, uCliffMoss.rgb, uCliffMoss.w * 0.8) - uPalGrass.rgb;
    c -= gr * clamp(dot(c - uPalGrass.rgb, gr) / max(dot(gr, gr), 1e-4), 0.0, 1.0);
  }
  if (uPalGrass.w > 0.5 && bio.x + bio.y < 0.5) {
    vec3 gd = uPalGrass.rgb - uPalDirt.rgb;
    float t = clamp(dot(c - uPalDirt.rgb, gd) / max(dot(gd, gd), 1e-4), 0.0, 1.0);
    float en = st_noise(wp * 0.9) * 0.5 + st_noise(wp * 2.7 + 3.1) * 0.3 + st_noise(wp * 0.25 + 7.0) * 0.2;
    c += gd * (smoothstep(0.32, 0.68, t + (en - 0.5) * 0.6) - t) * (1.0 - bio.x - bio.y);
  }
  c *= (0.94 + 0.12 * n1) * (0.92 + 0.16 * st_noise(wp * 0.07 + 2.0));
  // a calmer, warmer green: a third of the saturation out (the reference's soft pastel ground)
  c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, 0.66) * vec3(1.06, 1.03, 0.9);
  float lush = smoothstep(0.0, 0.03, c.g - c.b) * smoothstep(0.0, 0.02, c.g - c.r * 0.8) * (1.0 - bio.x - bio.y);
  sRelief = mix(0.75, 0.28, lush);
  // DESERT: the sand as it is; steep banks show the red strata
  if (bio.x > 0.01) {
    float steep = 1.0 - smoothstep(0.55, 0.85, upN);
    c = mix(c, vec3(0.6, 0.31, 0.19) * (0.95 + 0.1 * n1), steep * bio.x * 0.85);
    sRelief = mix(sRelief, 0.55, bio.x);
  }
  // CLIFFS: the map's stone, one tone; its hanging vegetation in soft-edged patches; snow on the ledges
  float u = abs(nxz.x) > abs(nxz.y) ? wp.y : wp.x;
  // (a defined edge between the grass and the rock — no pale halo)
  cliffW = 1.0 - smoothstep(0.625, 0.645, upN + (st_noise(wp * 0.15) - 0.5) * 0.1 + (st_noise(wp * 0.6) - 0.5) * 0.04);
  float cliff = cliffW * (1.0 - bio.x);
  if (cliff > 0.01) {
    vec3 stone = uCliffStone.w > 0.5 ? uCliffStone.rgb * 0.85 : hillStone(n1) * 0.9;
    // (isotropic world-space patterns: nothing stretched down the face, no seam where the face turns)
    vec2 q = wp + vec2(P.y * 0.71, -P.y * 0.53);
    stone *= 0.94 + 0.12 * st_noise(q * 0.03);
    if (uCliffMoss.w > 0.0) {
      // (vegetation holds on the LEDGES and the gentler parts of the face — by slope, a little noise; the map's share
      //  moves the line — never random blobs on a sheer wall)
      float hang = st_noise(q * 0.045 + 3.0) * 0.65 + st_noise(q * 0.13 + 9.0) * 0.35;
      float hold = upN + (hang - 0.5) * 0.22 + (uCliffMoss.w - 0.4) * 0.35;
      stone = mix(stone, uCliffMoss.rgb * 0.95, smoothstep(0.53, 0.58, hold));
    }
    if (bio.y > 0.05) stone = mix(stone, vec3(0.82, 0.87, 0.95), bio.y * smoothstep(0.45, 0.62, upN));
    c = mix(c, stone, cliff);
    sRelief = mix(sRelief, 0.3, cliff); // (big faces stay clean planes: a faint, broad relief)
  }
  // SNOW: one soft white, blue in the hollows the relief makes
  if (bio.y > 0.02) {
    float sw = smoothstep(0.02, 0.5, bio.y) * (1.0 - cliffW);
    c = mix(c, vec3(0.86, 0.9, 0.97) * (0.96 + 0.06 * n1), sw);
    sRelief = mix(sRelief, 0.4, sw);
  }
  // SHORE: the waterline, the lake bed, the foam line
  float wetZone = 1.0 - smoothstep(0.35, 0.6, bio.y);
  float wd = ${WATER} - P.y;
  c *= 1.0 - 0.35 * smoothstep(-0.8, 0.0, wd) * step(wd, 0.0) * 0.5 * wetZone;
  if (wd > 0.0) c = mix(c * vec3(0.85, 1.0, 1.12), vec3(0.12, 0.32, 0.55), smoothstep(0.0, 4.0, wd));
  wd = mix(-10.0, wd, wetZone);
  c += vec3(0.25, 0.27, 0.27) * (1.0 - smoothstep(0.0, 0.18, abs(wd - 0.04)));
  if (uWet > 0.01) {
    c *= 1.0 - 0.35 * uWet;
    float pm = st_noise(wp * 0.35 + 5.0) * 0.6 + st_noise(wp * 1.4 + 9.0) * 0.4;
    wetPuddle = smoothstep(0.62, 0.72, pm + 0.12 * uWet) * smoothstep(0.85, 0.97, upN) * uWet;
  }
  // ROAD: the map's soil, flat; the wheel ruts a shade darker and smoother; a ragged soft verge
  vec3 soilC = uRoadSoil.w > 0.5 ? uRoadSoil.rgb * 1.25 : vec3(0.5, 0.4, 0.28);
  float lat = abs(vRoad.x);
  const float HALF = 2.7;
  if (lat < HALF + 1.6) {
    float ruts = 1.0 - smoothstep(0.2, 0.75, abs(lat - 1.35));
    vec3 road = soilC * (0.97 + 0.06 * n1) * (1.0 - 0.1 * ruts);
    road = mix(road, vec3(0.7, 0.75, 0.84) * (1.0 - 0.12 * ruts), bio.y * 0.85);
    road = mix(road, c * (0.92 - 0.08 * ruts), bio.x * 0.9);
    float edgeN = st_noise(wp * 0.11 + 4.0) * 0.65 + st_noise(wp * 0.6 + 2.0) * 0.35;
    float bare = 1.0 - smoothstep(HALF - 0.4 + edgeN * 1.4, HALF + 0.4 + edgeN * 1.4, lat);
    c = mix(c, road, bare);
    sRelief = mix(sRelief, mix(0.45, 0.25, ruts), bare); // (packed dirt: smooth, a trace of grain)
    roadDirt = bare * (1.0 - bio.y);
  }
  // OFF-ROAD TRACKS (gravel / trail): the same calm soil, a little greyer on gravel, soft ruts and verge
  // (the track network's type is −1 off it: interpolated across a triangle, a hard test cuts a straight line along the
  //  triangles — a weight, re-thresholded through ragged noise, gives the patch an organic edge)
  float netN = st_noise(wp * 0.7 + 1.3) * 0.6 + st_noise(wp * 2.2 + 8.1) * 0.4;
  float netW = smoothstep(0.35, 0.65, smoothstep(-1.0, 0.0, vRoad.z) + (netN - 0.5) * 0.7) * (1.0 - smoothstep(2.0, 3.5, vRoad.y));
  if (netW > 0.001) {
    float e = vRoad.y;
    // (2026-10-25, "terrain lifts on roads": where a trail meets a track the nearest road's TYPE flips 0 → 1 between
    //  two grid vertices — a hard gravel / trail test (its soil, its rut offset) drew a straight-edged patch across the
    //  junction. One packed soil, the gravel's grey a smooth weight, no painted ruts: Over the Hill's plain dirt roads.)
    float gT = 1.0 - smoothstep(0.15, 0.85, vRoad.z);
    vec3 surf = mix(soilC, mix(soilC, uCliffStone.w > 0.5 ? uCliffStone.rgb * 0.75 : vec3(0.4, 0.37, 0.33), 0.15), gT);
    surf = mix(surf, vec3(0.7, 0.75, 0.84), bio.y * 0.8);
    surf = mix(surf, c, bio.x * 0.5);
    // (a wide ragged verge: the track's edge data is interpolated over the terrain's 2 m triangles — a narrow one draws
    //  their straight lines)
    float edgeN = st_noise(wp * 0.12 + 4.0) * 0.45 + st_noise(wp * 0.45 + 1.0) * 0.35 + st_noise(wp * 1.6) * 0.2;
    float eo = (edgeN - 0.5) * 4.0; // (±2 m of ragged verge)
    float bareT = (1.0 - smoothstep(-1.8 + eo, 0.7 + eo, e)) * smoothstep(HALF + 0.6, HALF + 2.2, lat) * netW;
    surf = mix(surf, c, 0.25); // (a track in the grass is worn ground, not a painted strip)
    c = mix(c, surf, bareT);
    sRelief = mix(sRelief, 0.35, bareT); // (packed dirt: a calm relief, no rut stripes)
    roadDirt = max(roadDirt, bareT * (1.0 - bio.y));
  }
  // MUD and standing water
  float mudW = vRoad.w;
  if (mudW > 0.01) {
    float m = clamp(mudW * 1.3, 0.0, 1.0) * (1.0 - bio.x);
    c = mix(c, mix(vec3(0.12, 0.085, 0.055), vec3(0.4, 0.43, 0.5), bio.y), m * 0.8);
    wetPuddle = max(wetPuddle, smoothstep(0.6, 0.78, mudW + 0.3 * uWet) * (1.0 - bio.x) * (1.0 - smoothstep(0.25, 0.4, bio.y)) * smoothstep(0.75, 0.9, upN));
  }
  // THE RELIEF: two scales (≈ 1.5 m and 0.5 m tiles, the small one turned: no visible repeat), on the ground plane;
  // cliffs take it on their face (the horizontal axis × height). Its crevices darken the colour a little.
  float hgt;
  if (cliffW > 0.5) {
    // (three planes weighted by the normal — no plane stretches over a slope)
    vec3 w = pow(abs(nW), vec3(4.0));
    w /= w.x + w.y + w.z;
    vec4 rx = reliefAt(P.zy * 0.12), ry = reliefAt(wp * 0.12), rz = reliefAt(P.xy * 0.12);
    vec2 dx = rx.rg * 2.0 - 1.0, dy = ry.rg * 2.0 - 1.0, dz = rz.rg * 2.0 - 1.0;
    sReliefN = vec3(0.0, dx.y, dx.x) * w.x + vec3(dy.x, 0.0, dy.y) * w.y + vec3(dz.x, dz.y, 0.0) * w.z;
    hgt = rx.b * w.x + ry.b * w.y + rz.b * w.z;
  } else {
    vec4 r1 = reliefAt(wp * 0.67);
    vec4 r2 = reliefAt(vec2(wp.x * 0.87 + wp.y * 0.5, wp.y * 0.87 - wp.x * 0.5) * 2.0);
    vec2 d = (r1.rg * 2.0 - 1.0) * 0.6 + (r2.rg * 2.0 - 1.0) * 0.4;
    sReliefN = vec3(d.x, 0.0, d.y);
    hgt = r1.b * 0.6 + r2.b * 0.4;
  }
  c *= 1.0 - min(sRelief, 1.0) * 0.07 * (1.0 - smoothstep(0.25, 0.6, hgt));
  dAlbedo = c;
}
`
const SOFT_NORMAL_PS = /* glsl */ `
// (× the light's height: a low sun or moon raked the fine relief into hard grain — the evening / night ground read sharp)
uniform float uDetailLight;
void getNormal() {
  // (the relief is a world-space normal offset: the ground plane's, or the cliffs' three planes)
  vec3 N = normalize(dVertexNormalW);
  if (cliffW > 0.01) {
    // CLIFFS as low-poly FACETS (the reference's rock walls): the triangle's own normal — a heightmap stretches its
    // triangles down a sheer wall, and their interpolated normals drew long smears
    vec3 F = normalize(cross(dFdx(vPositionW), dFdy(vPositionW)));
    F *= sign(dot(F, N));
    N = normalize(mix(N, F, 0.85 * cliffW));
  }
  dNormalW = normalize(N + sReliefN * sRelief * uDetailLight);
}
`

/** (wet sheen toward the key light and sky-mirroring puddles — after the lighting, before the fog) */
const WET_END = /* glsl */ `
    if (uWet > 0.01 || wetPuddle > 0.001) {
      vec3 H = normalize(V + uKeyDirW);
      float sheen = pow(clamp(dot(litArgs_worldNormal, H), 0.0, 1.0), 24.0) * uWet * 0.5;
      gl_FragColor.rgb += uKeyColor * sheen;
      if (wetPuddle > 0.001) {
        float fr = 0.25 + 0.75 * pow(1.0 - ndv, 2.0);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vFogSky * 0.7 + uKeyColor * pow(clamp(dot(litArgs_worldNormal, H), 0.0, 1.0), 180.0) * 2.0, wetPuddle * fr);
      }
    }
`

/** TerrainGeometry attribute → semantic (geometry.ts toPcMesh `extra`). */
export const TERRAIN_ATTRS: Record<string, string> = { roadLat: pc.SEMANTIC_ATTR8, roadNet: pc.SEMANTIC_ATTR9, biome: pc.SEMANTIC_ATTR10, mud: pc.SEMANTIC_ATTR7 }

export function createTerrainMaterial(): pc.StandardMaterial {
  const m = new pc.StandardMaterial()
  m.name = 'terrain'
  m.diffuse = new pc.Color(1, 1, 1)
  m.diffuseVertexColor = true
  ;(m as unknown as { vertexColorGamma: boolean }).vertexColorGamma = true // (sRGB bytes → linear; a runtime flag, not in the typings)
  const soft = activeLook().soft
  applyWorldLook(m, { rim: 0.25, toon: 0.45, declVS: DECL_VS, mainEndVS: MAIN_END_VS, declPS: DECL_PS + (soft ? SOFT_DECL_PS : ''), endExtra: WET_END })
  const ch = m.getShaderChunks(pc.SHADERLANGUAGE_GLSL)
  ch.set('diffusePS', soft ? SOFT_ALBEDO_PS : ALBEDO_PS)
  ch.set('normalMapPS', soft ? SOFT_NORMAL_PS : NORMAL_PS)
  m.setAttribute('aRoadLat', pc.SEMANTIC_ATTR8)
  m.setAttribute('aRoadNet', pc.SEMANTIC_ATTR9)
  m.setAttribute('aBiome', pc.SEMANTIC_ATTR10)
  m.setAttribute('aMud', pc.SEMANTIC_ATTR7)
  m.update()
  return m
}
