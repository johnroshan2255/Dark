import * as THREE from 'three'

/**
 * SUN, SKY AND AIR — one set of uniforms shared by every material of the world (same objects, so one write per frame
 * reaches all of them) and one GLSL chunk (`ATMOS_GLSL`) with the sky colour, the aerial perspective and the surface
 * light, so the ground, the grass, the sky and the haze between them always agree.
 *
 * The look: warm cinematic light — a golden sun low over the ridges, a pale cream-blue sky, peach haze toward the sun
 * and a cooler lavender one away from it, distant ranges dissolving into it layer by layer.
 */
const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b)

/** Keyframes by sun height (sin of the elevation): colours are linear, intensities scene-referred. Below the horizon
 *  the sky goes through dusk (−0.08 … −0.18) to NIGHT (deep blue, the moon lights the land). */
const KEYS = [
  { s: -0.38, sun: C(0.9, 0.38, 0.24), sunI: 0.0, zen: C(0.006, 0.011, 0.03), hor: C(0.02, 0.032, 0.07), glow: C(0.02, 0.025, 0.05), amb: 0.16, fog: 1.0 },
  { s: -0.18, sun: C(0.9, 0.38, 0.24), sunI: 0.0, zen: C(0.07, 0.06, 0.15), hor: C(0.34, 0.16, 0.24), glow: C(0.4, 0.12, 0.12), amb: 0.45, fog: 1.3 },
  { s: -0.08, sun: C(0.9, 0.38, 0.24), sunI: 0.0, zen: C(0.3, 0.24, 0.42), hor: C(1.05, 0.46, 0.5), glow: C(1.1, 0.35, 0.3), amb: 1.05, fog: 1.6 },
  // (golden hour → sunset, after the user's OTH sunset: a pink-violet sky, a red-orange sun, thick pink haze, the land
  //  still lit warm — never black)
  { s: 0.05, sun: C(1.0, 0.46, 0.28), sunI: 2.2, zen: C(0.42, 0.36, 0.58), hor: C(1.3, 0.62, 0.58), glow: C(1.6, 0.55, 0.35), amb: 1.35, fog: 1.7 },
  { s: 0.22, sun: C(1.0, 0.66, 0.42), sunI: 2.6, zen: C(0.38, 0.5, 0.78), hor: C(1.12, 0.8, 0.74), glow: C(1.2, 0.66, 0.42), amb: 0.92, fog: 1.25 },
  { s: 0.5, sun: C(1.0, 0.86, 0.7), sunI: 2.25, zen: C(0.4, 0.62, 0.88), hor: C(0.98, 0.88, 0.88), glow: C(0.95, 0.78, 0.6), amb: 0.8, fog: 1.0 },
  { s: 1.0, sun: C(1.0, 0.95, 0.88), sunI: 2.3, zen: C(0.32, 0.52, 0.86), hor: C(0.82, 0.88, 0.95), glow: C(0.8, 0.78, 0.7), amb: 0.82, fog: 1.0 },
]
const MOON = C(0.55, 0.68, 1.0)

/**
 * DAY AND NIGHT (the user: "sun, bloom and day-night like OTH"): the clock runs — a day takes `dayMinutes` real
 * minutes, the night passes 3× faster — the sun rises in the east, crosses the south 62° high, sets in the west (a
 * golden hour, a pink dusk), then night: the light switches to the MOON (opposite the sun, pale blue, dim), stars
 * come out (Sky.ts), the cars' headlights come on (`uHead*`, lit in every material's `headlight()`).
 */
export class Atmosphere {
  readonly uniforms = {
    uCamPos: { value: new THREE.Vector3() },
    /** The light's direction: the sun by day, the moon by night. */
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    uSkyZenith: { value: new THREE.Color() },
    uSkyHorizon: { value: new THREE.Color() },
    uSunGlow: { value: new THREE.Color() },
    uAmbSky: { value: new THREE.Color() },
    uAmbGround: { value: new THREE.Color() },
    /** x density at sea level (/m), y height falloff (/m), z max opacity, w the haze's brightness. */
    // (the user: "I don't need the far hills — just fog, I don't need to see that far, like OTH": a thick haze that
    //  swallows the land by ~2.5 km and reaches high, so the far ranges are gone too)
    uFog: { value: new THREE.Vector4(0.0013, 0.00022, 1.0, 1.0) },
    uTime: { value: 0 },
    uNoise: { value: null as THREE.Texture | null },
    /** 0 day … 1 full night (stars, the moon's disc, headlights). */
    uNight: { value: 0 },
    /** Headlights: the lamps' mid point (xyz) and on (w); their direction. */
    uHeadPos: { value: new THREE.Vector4() },
    uHeadDir: { value: new THREE.Vector3(0, 0, -1) },
  }
  /** Hours (6 sunrise … 12 noon … 18 sunset … 24 / 0 midnight). */
  hour = 15.5
  /** Real minutes for one daytime (06–18); the night runs 3× faster. 0 = the clock stands still. */
  dayMinutes = 24

  constructor(noise: THREE.Texture) {
    this.uniforms.uNoise.value = noise
  }

  /** Advance the clock by dt real seconds. */
  tick(dt: number): void {
    if (this.dayMinutes <= 0) return
    const night = this.hour < 6 || this.hour > 18.6
    this.hour = (this.hour + (dt * 12 * (night ? 3 : 1)) / (this.dayMinutes * 60)) % 24
  }

  /** "HH:MM". */
  get clock(): string {
    const h = Math.floor(this.hour), m = Math.floor((this.hour - h) * 60)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }

  update(cam: THREE.Vector3, t: number): void {
    const u = this.uniforms
    u.uCamPos.value.copy(cam)
    u.uTime.value = t
    // the sun's path: east at 6, south (+z) at noon, west at 18, under the ground at night; 62° at its highest
    const az = ((this.hour - 6) / 12) * Math.PI
    const el = Math.sin(az) * THREE.MathUtils.degToRad(62)
    const sun = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize()
    const s = sun.y
    let i = 0
    while (i < KEYS.length - 2 && s > KEYS[i + 1].s) i++
    const a = KEYS[i], b = KEYS[i + 1]
    const f = THREE.MathUtils.clamp((s - a.s) / (b.s - a.s), 0, 1)
    const sunI = a.sunI + (b.sunI - a.sunI) * f
    u.uSkyZenith.value.copy(a.zen).lerp(b.zen, f)
    u.uSkyHorizon.value.copy(a.hor).lerp(b.hor, f)
    u.uSunGlow.value.copy(a.glow).lerp(b.glow, f)
    const amb = a.amb + (b.amb - a.amb) * f
    // the haze thickens toward sunset (OTH's pink evening air), thins again at night
    u.uFog.value.x = 0.0013 * (a.fog + (b.fog - a.fog) * f)
    const night = THREE.MathUtils.smoothstep(-s, 0.06, 0.2)
    u.uNight.value = night
    if (s > -0.05) {
      u.uSunDir.value.copy(sun)
      u.uSunColor.value.copy(a.sun).lerp(b.sun, f).multiplyScalar(sunI)
    } else {
      // the MOON: opposite the sun, its light fading in as the sun sinks
      u.uSunDir.value.copy(sun).negate()
      if (u.uSunDir.value.y < 0.15) u.uSunDir.value.y = 0.15
      u.uSunDir.value.normalize()
      u.uSunColor.value.copy(MOON).multiplyScalar(0.42 * night)
    }
    // sky fill: the sky's average (bluer than its horizon); ground bounce: warm by day, cool and dim by night
    u.uAmbSky.value.copy(u.uSkyZenith.value).lerp(u.uSkyHorizon.value, 0.4).multiplyScalar(0.62 * amb)
    u.uAmbSky.value.lerp(MOON.clone().multiplyScalar(0.07), night * 0.8)
    u.uAmbGround.value.setRGB(0.42, 0.34, 0.22).multiplyScalar(0.55 * amb + 0.12 * sunI).lerp(MOON.clone().multiplyScalar(0.025), night)
  }
}

/** First line of every world fragment shader (GLSL3: three's tone-map / colour-space chunks write gl_FragColor). */
export const FRAG_OUT = /* glsl */ `
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
`

/** Uniform declarations + the shared functions. Include in vertex AND fragment shaders that need them. */
export const ATMOS_GLSL = /* glsl */ `
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSunGlow;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform vec4 uFog;
uniform float uTime;
uniform sampler2D uNoise;
uniform float uNight;
uniform vec4 uHeadPos;
uniform vec3 uHeadDir;

// The car's HEADLIGHTS on a surface at wpos (normal N): a warm cone ~30° wide, ~60 m long.
vec3 headlight(vec3 albedo, vec3 N, vec3 wpos) {
  if (uHeadPos.w < 0.5) return vec3(0.0);
  vec3 L = uHeadPos.xyz - wpos;
  float d = length(L);
  L /= d;
  float cone = smoothstep(0.82, 0.95, dot(-L, uHeadDir));
  float near = smoothstep(90.0, 4.0, d);
  return albedo * vec3(1.0, 0.9, 0.72) * (9.0 * cone * near / (1.0 + d * d * 0.012)) * max(dot(N, L) * 0.8 + 0.2, 0.0);
}

// The sky in direction d: zenith → a broad warm horizon band, the sun's glow round it.
vec3 skyColor(vec3 d) {
  float y = d.y;
  float up = clamp(y, 0.0, 1.0);
  vec3 c = mix(uSkyHorizon, uSkyZenith, pow(up, 0.55));
  // a thin brighter band right at the horizon, and below it the haze a touch darker
  c = mix(c, uSkyHorizon * 1.06, exp(-abs(y) * 26.0) * 0.6);
  c *= 1.0 - clamp(-y * 1.4, 0.0, 0.18);
  float s = max(dot(d, uSunDir), 0.0);
  c += uSunGlow * (0.3 * pow(s, 4.0) + 0.6 * pow(s, 24.0)) * (0.6 + 0.4 * (1.0 - up));
  return c;
}

// What the haze looks like along d: the sky near the horizon in that direction (so far ridges melt into the sky).
vec3 hazeColor(vec3 d) {
  vec3 h = normalize(vec3(d.x, clamp(d.y, -0.05, 0.12), d.z));
  // (exactly the sky's colour at the horizon: whatever the fog swallows dissolves into the sky, no silhouette left)
  return skyColor(h) * uFog.w;
}

// Aerial perspective: exponential height fog integrated along the view ray (analytic), toward hazeColor — from
// FOG_START m on: round the player the air is clear, the colours pure (the user: "no fog near us, it dulls the
// colours"); the haze builds beyond it and swallows the far hills (~1.5 km).
const float FOG_START = 140.0;
float fogAmount(vec3 wpos) {
  vec3 v = wpos - uCamPos;
  float dist = length(v);
  float b = uFog.y;
  float dy = v.y * b;
  float k = abs(dy) > 1e-4 ? (1.0 - exp(-dy)) / dy : 1.0;
  float od = uFog.x * exp(-b * uCamPos.y) * max(dist - FOG_START, 0.0) * k;
  return (1.0 - exp(-od)) * uFog.z;
}
vec3 applyAtmos(vec3 col, vec3 wpos) {
  vec3 dir = normalize(wpos - uCamPos);
  return mix(col, hazeColor(dir), fogAmount(wpos));
}

// Ambient: sky from above, warm bounce from below.
vec3 ambient(vec3 N) {
  return mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5);
}

// GGX distribution (art-directed spec: rough ground, a soft wide sheen).
float ggx(float NoH, float r) {
  float a = r * r;
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159 * d * d);
}

// Surface light: wrapped diffuse (soft terminator, painterly), sky / bounce ambient, a GGX lobe.
vec3 shade(vec3 albedo, vec3 N, vec3 V, float rough, float f0, float ao, float sunVis, float wrap) {
  float NoL = dot(N, uSunDir);
  float diff = clamp((NoL + wrap) / (1.0 + wrap), 0.0, 1.0);
  diff *= diff * (3.0 - 2.0 * diff) * 0.35 + 0.65; // a gentle S: fuller light faces, softer shade
  vec3 col = albedo * (uSunColor * diff * sunVis + ambient(N) * ao);
#ifdef OTH_SPEC
  vec3 H = normalize(uSunDir + V);
  float NoH = max(dot(N, H), 0.0);
  float VoH = max(dot(V, H), 0.0);
  float F = f0 + (1.0 - f0) * pow(1.0 - VoH, 5.0);
  col += uSunColor * sunVis * ggx(NoH, rough) * F * max(NoL, 0.0) * 0.25;
#endif
  return col;
}
`
