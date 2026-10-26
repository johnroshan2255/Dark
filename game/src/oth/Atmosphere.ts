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
  { s: -0.38, sun: C(0.9, 0.38, 0.24), sunI: 0.0, zen: C(0.006, 0.011, 0.03), hor: C(0.02, 0.032, 0.07), glow: C(0.02, 0.025, 0.05), amb: 0.16 },
  { s: -0.18, sun: C(0.9, 0.38, 0.24), sunI: 0.0, zen: C(0.07, 0.06, 0.15), hor: C(0.34, 0.16, 0.24), glow: C(0.4, 0.12, 0.12), amb: 0.45 },
  { s: -0.08, sun: C(0.9, 0.38, 0.24), sunI: 0.0, zen: C(0.3, 0.24, 0.42), hor: C(1.05, 0.46, 0.5), glow: C(1.1, 0.35, 0.3), amb: 1.05 },
  // (golden hour → sunset, after the user's OTH sunset: a pink-violet sky, a red-orange sun, thick pink haze, the land
  //  still lit warm — never black)
  { s: 0.05, sun: C(1.0, 0.46, 0.28), sunI: 2.2, zen: C(0.42, 0.36, 0.58), hor: C(1.3, 0.62, 0.58), glow: C(1.6, 0.55, 0.35), amb: 1.35 },
  { s: 0.22, sun: C(1.0, 0.66, 0.42), sunI: 2.6, zen: C(0.38, 0.5, 0.78), hor: C(1.12, 0.8, 0.74), glow: C(1.2, 0.66, 0.42), amb: 0.92 },
  { s: 0.5, sun: C(1.0, 0.86, 0.7), sunI: 2.25, zen: C(0.4, 0.62, 0.88), hor: C(0.98, 0.88, 0.88), glow: C(0.95, 0.78, 0.6), amb: 0.8 },
  { s: 1.0, sun: C(1.0, 0.95, 0.88), sunI: 2.3, zen: C(0.32, 0.52, 0.86), hor: C(0.82, 0.88, 0.95), glow: C(0.8, 0.78, 0.7), amb: 0.82 },
]
const MOON = C(0.55, 0.68, 1.0)
/** A colour scaled up (its tint kept) to at least luminance min. */
function floorLum(c: THREE.Color, min: number): void {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  if (l < min) c.multiplyScalar(min / Math.max(l, 1e-4))
}
/** A colour pulled toward its own grey (its luminance kept): k of its tint left. */
function keepTint(c: THREE.Color, k: number): THREE.Color {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  return c.setRGB(l + (c.r - l) * k, l + (c.g - l) * k, l + (c.b - l) * k)
}

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
    /** The sun's own colour (vivid: its disc in the sky, its glint on the water) — uSunColor is its LIGHT on the land. */
    uSunDisc: { value: new THREE.Color() },
    uAmbSky: { value: new THREE.Color() },
    uAmbGround: { value: new THREE.Color() },
    /** The FOG: clear to x m, solid from y m (the tier's fogNear / fogEnd — main.ts) — and its colour (the sky's
     *  horizon, its tint mostly gone: white by day, pale warm at sunset, dark at night). */
    uFogRange: { value: new THREE.Vector2(130, 850) },
    uFogColor: { value: new THREE.Color() },
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
    const night = THREE.MathUtils.smoothstep(-s, 0.06, 0.2)
    u.uNight.value = night
    if (s > -0.05) {
      u.uSunDir.value.copy(sun)
      u.uSunDisc.value.copy(a.sun).lerp(b.sun, f).multiplyScalar(sunI)
    } else {
      // the MOON: opposite the sun, its light fading in as the sun sinks
      u.uSunDir.value.copy(sun).negate()
      if (u.uSunDir.value.y < 0.15) u.uSunDir.value.y = 0.15
      u.uSunDir.value.normalize()
      u.uSunDisc.value.copy(MOON).multiplyScalar(0.42 * night)
    }
    // sky fill: the sky's average (bluer than its horizon); ground bounce: warm by day, cool and dim by night
    u.uAmbSky.value.copy(u.uSkyZenith.value).lerp(u.uSkyHorizon.value, 0.4).multiplyScalar(0.62 * amb)
    u.uAmbSky.value.lerp(MOON.clone().multiplyScalar(0.07), night * 0.8)
    u.uAmbGround.value.setRGB(0.42, 0.34, 0.22).multiplyScalar(0.55 * amb + 0.12 * sunI).lerp(MOON.clone().multiplyScalar(0.025), night)
    // the LIGHT ON THE LAND keeps every colour true at every hour (the user: "when the time changes to evening, night,
    // morning, the terrain, grass and trees all change colour with it"): the sun's, the sky's and the bounce's light
    // lose most of their tint — a warm / cool hint is left, the brightness still follows the day; the SKY itself (its
    // colours, the sun's disc, the haze, the glint on the water) stays as vivid as the keyframes paint it
    keepTint(u.uSunColor.value.copy(u.uSunDisc.value), 0.3)
    keepTint(u.uAmbSky.value, 0.35)
    keepTint(u.uAmbGround.value, 0.5)
    // and never near-black: from dusk through the night the sky's fill keeps a floor (~2/3 of noon's) — the land darker
    // than by day, its colours still its own (deep in the dark the tone curve would crush them to brown)
    floorLum(u.uAmbSky.value, 0.22)
    floorLum(u.uAmbGround.value, 0.09)
    keepTint(u.uFogColor.value.copy(u.uSkyHorizon.value), 0.3)
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
uniform vec3 uSunDisc;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSunGlow;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform vec2 uFogRange;
uniform vec3 uFogColor;
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
  // (the lower sky is the fog: the fogged land melts into it, no horizon line)
  c = mix(c, uFogColor + uSunGlow * (0.18 * pow(s, 6.0)) * (1.0 - uNight), 1.0 - smoothstep(-0.02, 0.2, y));
  return c;
}

// THE FOG (the user: "no far mountains — a white fog hiding everything far, just a filter, not volumetric"): clear
// round the player (uFogRange.x), thickening with distance into a solid fog by uFogRange.y — nothing beyond is drawn
// (the tier's far plane and reaches end just past it). Its colour: the sky's horizon with the tint mostly gone (white
// by day, pale warm at sunset, dark at night), a faint glow toward the sun.
vec3 fogColor(vec3 d) {
  return uFogColor + uSunGlow * (0.18 * pow(max(dot(d, uSunDir), 0.0), 6.0)) * (1.0 - uNight);
}
float fogAmount(vec3 wpos) {
  float t = clamp((length(wpos - uCamPos) - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0);
  return 1.0 - (1.0 - t) * (1.0 - t) * (1.0 - t); // (eases in: the near haze faint, the last stretch solid)
}
vec3 applyAtmos(vec3 col, vec3 wpos) {
  return mix(col, fogColor(normalize(wpos - uCamPos)), fogAmount(wpos));
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
