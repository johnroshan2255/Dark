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
 * come out (Sky.ts), the cars' headlights come on (`uHead*` / `uTail`, painted on every material by `headlight()`).
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
    /** The HAZE: clear air to x m, then AERIAL PERSPECTIVE over a length of y m (the tier's fogNear / haze, shorter
     *  in the rain — main.ts, update) — and its colour (the sky's horizon leaning to its zenith: a blue-grey). */
    uFogRange: { value: new THREE.Vector2(130, 2600) },
    uFogColor: { value: new THREE.Color() },
    uTime: { value: 0 },
    uNoise: { value: null as THREE.Texture | null },
    /** 0 day … 1 full night (stars, the moon's disc, headlights). */
    uNight: { value: 0 },
    /** Headlights (Vehicle.lights): the left lamp (xyz) and on (w), the right lamp, the car's forward and up axes;
     *  the tail lamps' middle (xyz) and the brake light (w, 0 … 1). */
    uHeadL: { value: new THREE.Vector4() },
    uHeadR: { value: new THREE.Vector3() },
    uHeadDir: { value: new THREE.Vector3(0, 0, -1) },
    uHeadUp: { value: new THREE.Vector3(0, 1, 0) },
    uTail: { value: new THREE.Vector4() },
    /** WEATHER (`weather`, below): cloud cover 0 … 1, rain 0 … 1, how wet the land is 0 … 1, the wind (m/s, xz). */
    uCloud: { value: 0.25 },
    uRain: { value: 0 },
    uWet: { value: 0 },
    uWind: { value: new THREE.Vector2(2.2, 0.9) },
    /** 1 without the post pass (Glow.ts): the sky paints the bloom's halo round the sun, the haze glows toward it. */
    uGlow: { value: 0 },
  }
  /** WEATHER (2026-10-27, OTH has it): spells of CLEAR, CLOUDY and RAIN a few real minutes each, easing into one another
   *  (the clouds over a minute, the rain over ~25 s once the sky is heavy); the land gets wet in the rain over ~40 s and
   *  dries over ~3 min. `?weather=clear|cloudy|rain` pins it, K steps through them. */
  weather: 'auto' | 'clear' | 'cloudy' | 'rain' = 'auto'
  private spell: 'clear' | 'cloudy' | 'rain' = 'clear'
  private spellLeft = 240
  private wseed = (Date.now() & 0xffff) | 1
  /** The haze's length (m) in clear air (main.ts sets it from the tier). */
  hazeLen = 2600
  /** Hours (6 sunrise … 12 noon … 18 sunset … 24 / 0 midnight). */
  hour = 15.5
  /** Real minutes for one daytime (06–18); the night runs 3× faster. 0 = the clock stands still. */
  dayMinutes = 24

  constructor(noise: THREE.Texture) {
    this.uniforms.uNoise.value = noise
  }

  /** Advance the clock and the weather by dt real seconds. */
  tick(dt: number): void {
    this.tickWeather(dt)
    if (this.dayMinutes <= 0) return
    const night = this.hour < 6 || this.hour > 18.6
    this.hour = (this.hour + (dt * 12 * (night ? 3 : 1)) / (this.dayMinutes * 60)) % 24
  }

  private tickWeather(dt: number): void {
    const u = this.uniforms
    let kind = this.weather === 'auto' ? this.spell : this.weather
    if (this.weather === 'auto' && (this.spellLeft -= dt) <= 0) {
      this.wseed = (Math.imul(this.wseed, 1103515245) + 12345) >>> 0
      const r = (this.wseed >>> 8) / 16777216
      this.spell = kind = r < 0.45 ? 'clear' : r < 0.75 ? 'cloudy' : 'rain'
      this.spellLeft = 180 + ((this.wseed >>> 4) % 240)
    }
    const cloudT = kind === 'rain' ? 0.95 : kind === 'cloudy' ? 0.62 : 0.22
    const rainT = kind === 'rain' && u.uCloud.value > 0.75 ? 1 : 0
    const ease = (v: number, t: number, rate: number) => (v < t ? Math.min(t, v + dt * rate) : Math.max(t, v - dt * rate))
    u.uCloud.value = ease(u.uCloud.value, cloudT, 1 / 60)
    u.uRain.value = ease(u.uRain.value, rainT, 1 / 25)
    u.uWet.value = ease(u.uWet.value, u.uRain.value > 0.3 ? 1 : 0, u.uRain.value > 0.3 ? 1 / 40 : 1 / 180)
  }

  /** Snap the weather to its target (the shot harness, a forced change). */
  settleWeather(): void {
    for (let i = 0; i < 400; i++) this.tickWeather(1)
  }

  /** K: clear → cloudy → rain → auto. */
  stepWeather(): string {
    const order = ['auto', 'clear', 'cloudy', 'rain'] as const
    this.weather = order[(order.indexOf(this.weather) + 1) % order.length]
    return this.weather
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
    // (under a heavy sky the sun dims and the sky goes a soft grey, its brightness kept)
    const overcast = THREE.MathUtils.smoothstep(u.uCloud.value, 0.45, 1.0)
    const sunI = (a.sunI + (b.sunI - a.sunI) * f) * (1 - 0.72 * overcast)
    u.uSkyZenith.value.copy(a.zen).lerp(b.zen, f)
    u.uSkyHorizon.value.copy(a.hor).lerp(b.hor, f)
    u.uSunGlow.value.copy(a.glow).lerp(b.glow, f).multiplyScalar(1 - 0.8 * overcast)
    for (const c of [u.uSkyZenith.value, u.uSkyHorizon.value]) {
      const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
      c.lerp(new THREE.Color(l * 0.95, l, l * 1.04), 0.75 * overcast)
    }
    u.uFogRange.value.y = this.hazeLen * (1 - 0.45 * u.uRain.value)
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
      u.uSunDisc.value.copy(MOON).multiplyScalar(0.16 * night)
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
    // a floor on the sky's fill through dusk (the land darker than by day, its colours still its own) — but deep in
    // the night it gives way (2026-10-27, the user: "night needs more darkness, like in real life"): only the moon's
    // cold light is left, the land a dark silhouette against the sky, what the headlights paint is what you see
    floorLum(u.uAmbSky.value, THREE.MathUtils.lerp(0.22, 0.022, night))
    floorLum(u.uAmbGround.value, THREE.MathUtils.lerp(0.09, 0.006, night))
    // the HAZE's colour: the horizon leaning to the zenith, much of its tint kept — far ridges go blue-grey in layers
    keepTint(u.uFogColor.value.copy(u.uSkyHorizon.value).lerp(u.uSkyZenith.value, 0.42), 0.75)
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
uniform vec4 uHeadL;
uniform vec3 uHeadR;
uniform vec3 uHeadDir;
uniform vec3 uHeadUp;
uniform vec4 uTail;
uniform float uCloud;
uniform float uRain;
uniform float uWet;
uniform vec2 uWind;
uniform float uGlow;

// HEADLIGHTS, PAINTED (the user, 2026-10-27: "the light comes from the centre of the front, not the headlamps — use a
// light like paint, not an actual light"): from EACH lamp a beam whose footprint is an ellipse in angle space (wide,
// low, aimed a little down), laid on in three soft VALUE BANDS (a painter's hot core, body and fringe) with a soft edge,
// fading over 16 … 46 m; a surface takes it almost flat (little N·L), so the pool on the track reads as a shape of
// light painted onto the ground. The two beams overlap ahead of the car.
float beamOf(vec3 lamp, vec3 wpos) {
  vec3 v = wpos - lamp;
  float a = dot(v, uHeadDir);
  if (a < 0.3) return 0.0;
  vec3 side = normalize(cross(uHeadDir, uHeadUp));
  vec2 ang = vec2(dot(v, side), dot(v, uHeadUp) + 0.07 * a) / a;
  float r = length(ang / vec2(0.40, 0.17));
  float b = (1.0 - smoothstep(0.78, 1.0, r)) * (1.0 - smoothstep(16.0, 46.0, a)) * smoothstep(0.3, 1.2, a)
          * (0.45 + 0.55 * (1.0 - smoothstep(0.0, 0.6, r)));
  float q = b * 3.0;
  return (floor(q) + smoothstep(0.3, 0.7, fract(q))) / 3.0;
}
// The car's lights on a surface at wpos (normal N): the two painted beams, and behind the car the BRAKE lights' red
// pool on the ground (strong at night, a hint by day).
vec3 headlight(vec3 albedo, vec3 N, vec3 wpos) {
  vec3 c = vec3(0.0);
  if (uHeadL.w > 0.5) {
    float b1 = beamOf(uHeadL.xyz, wpos), b2 = beamOf(uHeadR, wpos);
    float B = max(b1, b2) * 0.75 + (b1 + b2) * 0.25;
    float face = 0.6 + 0.4 * clamp(dot(N, normalize((uHeadL.xyz + uHeadR) * 0.5 - wpos)), 0.0, 1.0);
    c += albedo * vec3(1.0, 0.88, 0.66) * (3.2 * B * face);
  }
  if (uTail.w > 0.01) {
    vec3 v = wpos - uTail.xyz;
    float a = -dot(v, uHeadDir), side = length(v - dot(v, uHeadDir) * uHeadDir - dot(v, uHeadUp) * uHeadUp);
    float pool = 1.0 - smoothstep(0.0, 1.0, (side * 0.8 + max(a, 0.0) * 0.35 + max(-a, 0.0) * 4.0) / 3.2);
    c += albedo * vec3(1.0, 0.08, 0.04) * (1.1 * uTail.w * pool * (0.15 + 0.85 * uNight));
  }
  return c;
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

// THE HAZE (2026-10-27 — before, a solid white fog hid everything past ~900 m; now the whole 16 km world is drawn, so
// landmarks and far ranges can be seen and driven to): clear air round the player (uFogRange.x), then AERIAL
// PERSPECTIVE — each farther ridge paler and bluer (1 − e^(−d / uFogRange.y)), a little thicker low in the valleys,
// never solid (≤ 94 %): the far mountains stand as layered blue silhouettes. Its colour: the horizon leaning to the
// zenith (dark at night), a faint glow toward the sun.
vec3 fogColor(vec3 d) {
  float s = max(dot(d, uSunDir), 0.0);
  // (without the post pass the bloom's spread over the hazy ridges toward the sun is painted here: wider, warmer)
  return uFogColor + uSunGlow * (0.18 * pow(s, 6.0) + uGlow * (0.22 * pow(s, 3.0) + 0.35 * pow(s, 24.0))) * (1.0 - uNight);
}
float fogAmount(vec3 wpos) {
  float d = max(length(wpos - uCamPos) - uFogRange.x, 0.0);
  float a = 1.0 - exp(-d / uFogRange.y);
  float low = exp(-max(wpos.y - 30.0, 0.0) / 380.0);
  return min(a * (0.86 + 0.14 * low), 0.94);
}
vec3 applyAtmos(vec3 col, vec3 wpos) {
  return mix(col, fogColor(normalize(wpos - uCamPos)), fogAmount(wpos));
}

// Ambient: sky from above, warm bounce from below.
vec3 ambient(vec3 N) {
  return mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5);
}

// STYLIZED ROCK FILL (2026-10-27, Over the Hill's soft pale rock: its shade a light blue-grey, never near black — ours
// lit 8 : 1 sun to shade went black): the sky's light again, strongest on the faces turned from the sun — the cool of
// the shade. Rock only (the terrain's rock, the boulders); it follows the sky, so the nights stay dark.
vec3 rockFill(vec3 albedo, vec3 N) { return albedo * uAmbSky * (0.45 + 0.8 * (1.0 - clamp(dot(N, uSunDir) * 1.5, 0.0, 1.0))); }

// GGX distribution (art-directed spec: rough ground, a soft wide sheen).
float ggx(float NoH, float r) {
  float a = r * r;
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159 * d * d);
}

// Surface light: wrapped diffuse (soft terminator, painterly), sky / bounce ambient, a GGX lobe.
vec3 shade(vec3 albedo, vec3 N, vec3 V, float rough, float f0, float ao, float sunVis, float wrap) {
  // WET (the rain): every surface darker, what faces up glossy — a sky sheen and a sharper sun glint
  float wet = uWet * smoothstep(0.1, 0.8, N.y);
  // (the sheen by the surface: rock and wood glossy, grass and earth hardly — a field doesn't turn to a mirror)
  float gloss = wet * (0.12 + 0.88 * (1.0 - smoothstep(0.6, 0.95, rough)));
  albedo *= 1.0 - 0.28 * uWet;
  rough = mix(rough, 0.2, wet * 0.85);
  f0 = mix(f0, 0.05, wet);
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
  if (wet > 0.01) {
    float fr = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    col += skyColor(reflect(-V, N)) * fr * gloss * 0.45;
  }
  return col;
}
`
