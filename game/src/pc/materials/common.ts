import * as pc from 'playcanvas'
import { MIST_GLSL, SKY_GLSL } from '../../rendering/sky/skyShader'
import { pcGlsl } from './glsl'

/**
 * SHARED LOOK of every DARK world material on PlayCanvas — as shader-chunk overrides of the engine's StandardMaterial
 * (its lighting, cascaded shadows, clustered lights and tone mapping stay the engine's):
 *  - TOON ramp on the diffuse term (lightDiffuseLambertPS): a soft cel terminator, × the time of day's uToon; the
 *    map's look WRAPS the light past the terminator (uWrap — the soft look: long smooth gradients, no hard edge);
 *  - RIM light (endPS, before the fog): silhouettes facing the key light catch its colour (× the look's uRimK);
 *  - SKY-COLOURED FOG (fogPS): fogged surfaces fade to the SKY in their direction (the vertex shader evaluates the
 *    sky function per vertex → vFogSky), capped on land (uFogMax, uLandHaze), dissolving fully at the horizon rim
 *    (uFarEdge), with AERIAL PERSPECTIVE (desaturate / lift toward the haze, warmer toward the sun) and the analytic
 *    ground MIST. The same as the three build's stylize fog block, in world space.
 * World-space throughout: uCamPos (camera), uKeyDirW (direction to the key light), uKeyColor.
 */
export const WORLD_DECL_VS = /* glsl */ `
uniform vec3 uCamPos;
${SKY_GLSL}
varying vec3 vFogSky;
`
/** (end of the vertex main: the sky colour in this vertex's direction — the fog colour, interpolated) */
export const WORLD_MAIN_END_VS = /* glsl */ `
  vFogSky = skyColor(normalize(vPositionW - uCamPos), false);
`
export const WORLD_DECL_PS = /* glsl */ `
uniform vec3 uCamPos; uniform vec3 uKeyDirW; uniform vec3 uKeyColor;
uniform float uToon; uniform float uRim; uniform float uToonK; uniform float uWrap; uniform float uRimK;
uniform float uFogMax; uniform vec3 uLandHaze; uniform vec2 uFarEdge; uniform vec4 uAerial;
${SKY_GLSL}
${MIST_GLSL}
varying vec3 vFogSky;
`

/** Hemisphere ambient (PcLighting sets uHemiSky / uHemiGround: linear, × intensity, ÷ π). */
export const HEMI_AMBIENT_PS = /* glsl */ `
uniform vec3 uHemiSky; uniform vec3 uHemiGround;
void addAmbient(vec3 worldNormal) {
  dDiffuseLight += mix(uHemiGround, uHemiSky, worldNormal.y * 0.5 + 0.5);
}
`

export const TOON_LAMBERT_PS = /* glsl */ `
float getLightDiffuse(vec3 worldNormal, vec3 viewDir, vec3 lightDirNorm) {
  float d = max((dot(worldNormal, -lightDirNorm) + uWrap) / (1.0 + uWrap), 0.0);
  return mix(d, smoothstep(0.0, 0.16, d) * 0.82 + d * 0.18, uToon * uToonK);
}
`

/** fogPS replacement (fragment only — the lit forward pass). `amount` scales the fog (monsters < 1). */
export function worldFogPS(amount = 1): string {
  const k = amount.toFixed(3)
  return /* glsl */ `
float dBlendModeFogFactor = 1.0;
uniform float fog_start; uniform float fog_end;
vec3 addFog(vec3 color) {
  vec3 wd = vPositionW - uCamPos;
  float wl = max(length(wd), 1e-3);
  float depth = gl_FragCoord.z / gl_FragCoord.w;
  float fogFactor = max(smoothstep(fog_start, fog_end, depth), skyHaze(depth)) * ${k};
  vec3 fogCol = vFogSky;
  float rim = smoothstep(uFarEdge.x, uFarEdge.y, depth);
  fogFactor = max(min(fogFactor, uFogMax), rim);
  fogCol = mix(fogCol * uLandHaze, fogCol, rim);
  vec3 vd = wd / wl;
  float toSun = pow(max(dot(vd, normalize(uSkySunDir)), 0.0), 5.0) * uSkySunVis * uAerial.w;
  fogCol = mix(fogCol * vec3(0.94, 0.98, 1.06), fogCol * 0.7 + uSkySunColor * 0.45, toSun);
  float ap = smoothstep(uAerial.x, uAerial.y, depth) * uAerial.z * ${k};
  float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float hazeLum = dot(fogCol, vec3(0.2126, 0.7152, 0.0722));
  vec3 hazeHue = fogCol / max(hazeLum, 1e-3);
  vec3 c = mix(color, hazeHue * lum, ap * 0.6);
  color = mix(c, c * 0.55 + hazeLum * 0.45, ap * 0.7);
  float mist = mistAmount(vd, wl) * ${k};
  fogFactor = 1.0 - (1.0 - fogFactor) * (1.0 - mist);
  return mix(color, fogCol, fogFactor);
}
`
}

/** endPS replacement: the engine's combine, + `extra` (GLSL using litArgs_*, may add to gl_FragColor), the rim light,
 *  then fog, tone mapping, gamma as the engine does. */
export function worldEndPS(extra = ''): string {
  return /* glsl */ `
  gl_FragColor.rgb = combineColor(litArgs_albedo, litArgs_sheen_specularity, litArgs_clearcoat_specularity);
  gl_FragColor.rgb += litArgs_emission;
  {
    vec3 V = normalize(uCamPos - vPositionW);
    float ndv = clamp(dot(litArgs_worldNormal, V), 0.0, 1.0);
    float back = pow(clamp(dot(-V, uKeyDirW), 0.0, 1.0), 2.0);
    gl_FragColor.rgb += uKeyColor * litArgs_albedo * pow(1.0 - ndv, 3.0) * (0.3 + back * 1.4) * uRim * uRimK;
    ${extra}
  }
  gl_FragColor.rgb = addFog(gl_FragColor.rgb);
  gl_FragColor.rgb = toneMap(gl_FragColor.rgb);
  gl_FragColor.rgb = gammaCorrectOutput(gl_FragColor.rgb);
`
}

/** Apply the shared chunks to a StandardMaterial (rim / toon weights per material as its own parameters). */
export function applyWorldLook(m: pc.StandardMaterial, o: { rim: number; toon: number; declVS?: string; mainEndVS?: string; declPS?: string; endExtra?: string; fogAmount?: number }): void {
  const ch = m.getShaderChunks(pc.SHADERLANGUAGE_GLSL)
  // (FORWARD_PASS only: the shadow / depth passes compile none of the sky, fog or ground-painting code — the big
  //  terrain shader compiled into every pass took 12.5 s to build at load)
  ch.set('litUserDeclarationVS', pcGlsl(`#ifdef FORWARD_PASS
${WORLD_DECL_VS}${o.declVS ?? ''}
#endif
`))
  ch.set('litUserMainEndVS', `#ifdef FORWARD_PASS
${WORLD_MAIN_END_VS}${o.mainEndVS ?? ''}
#endif
`)
  ch.set('litUserDeclarationPS', pcGlsl(`#ifdef FORWARD_PASS
${WORLD_DECL_PS}${o.declPS ?? ''}
#endif
`))
  ch.set('lightDiffuseLambertPS', TOON_LAMBERT_PS)
  ch.set('ambientPS', HEMI_AMBIENT_PS)
  ch.set('fogPS', worldFogPS(o.fogAmount))
  ch.set('endPS', worldEndPS(o.endExtra))
  // MATTE (Lambert, as the three build): no specular term at all — PlayCanvas compiles the GGX lobe and the env
  // reflection out of the shader when specular is black and metalness is off (standard-material-options-builder)
  m.useMetalness = false
  m.specular = new pc.Color(0, 0, 0)
  m.setParameter('uRim', o.rim)
  m.setParameter('uToonK', o.toon)
  m.useFog = true
}
