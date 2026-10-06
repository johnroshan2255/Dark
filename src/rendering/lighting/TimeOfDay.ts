import * as THREE from 'three'
import type { ArtStyle } from '../artStyle'

/**
 * Continuous day/night cycle. Time is in game hours [0, 24). The sun moves on a low tilted arc:
 * rises behind the spawn view (−Z) at 06:00, ~32° high to the west (−X) at noon, and SETS DOWN THE ROAD
 * (+Z) at 18:00 — the refer/roads hero composition. The moon is opposite (rises behind at dusk).
 * Lighting/fog/grading params are blended between hour keyframes; the NIGHTMARE realm is a
 * separate weight blended on top. Light COUNT never changes — see skills/lighting.
 */
export type TimeLabel = 'DAWN' | 'DAY' | 'EVENING' | 'DUSK' | 'NIGHT'

export interface LightingParams {
  sunColor: THREE.Color
  sunIntensity: number
  moonColor: THREE.Color
  moonIntensity: number
  hemiSky: THREE.Color
  hemiGround: THREE.Color
  hemiIntensity: number
  /** Fog colour == sky horizon colour (skills/fog). */
  fogColor: THREE.Color
  skyZenith: THREE.Color
  /** Fog is fully clear up to fogStart and complete at fogEnd (metres; capped by the tier's horizon distance — the horizon terrain covers the far view). */
  fogStart: number
  fogEnd: number
  exposure: number
  stars: number
  /** Screen-space glare streak strength (light source on screen). */
  rays: number
  /** Volumetric shaft (shadow-map in-scatter) strength — visible from any view direction. */
  shafts: number
  /** Cloud coverage 0..1. */
  clouds: number
  /** Split-tone strength: cool shadows / warm highlights (painterly grade). */
  split: number
  /** Aerial-perspective haze amount (0..1) — layered depth through the forest. */
  haze: number
  /** Volumetric ground mist: density at its base (per m), base height (m, world) and vertical falloff (1/m). */
  mistDensity: number
  mistBase: number
  mistFalloff: number
  /** White cumulus clouds (day) vs painted dusk clouds. */
  cloudWhite: number
  /** Storm 0..1 (weather): clouds go to a dark grey lid, lower and heavier. */
  storm: number
  /** Cel-shading strength (uToon). */
  toon: number
  /** Most the distance fog may cover LAND (hills keep their shape; only the horizon mesh's rim reaches the sky). */
  fogMax: number
  /** Aerial-perspective tint of distant land (× the sky colour in that direction): blue-green hills, not white. */
  landHaze: THREE.Color
  /** STORYBOOK only: weight of the unlit hand-painted shading over real lighting (0 = lit, 1 = fully painted). */
  painted: number
  /** STORYBOOK only: the light "painted into" the colours (albedo × this; sky-side brighter). */
  paintLight: THREE.Color
  // grading (PostPipeline)
  tint: THREE.Color
  lift: THREE.Color
  saturation: number
  contrast: number
  vignette: number
  grain: number
  distortion: number
}

const c = (hex: number) => new THREE.Color(hex) // sRGB hex → linear working space

function key(p: Partial<LightingParams> & Record<string, unknown>): LightingParams {
  return {
    sunColor: c(0xfff0d8), sunIntensity: 0, moonColor: c(0xa8bcff), moonIntensity: 0,
    hemiSky: c(0x808080), hemiGround: c(0x202020), hemiIntensity: 0.5, fogColor: c(0x808080), skyZenith: c(0x404060),
    fogStart: 60, fogEnd: 1000, exposure: 1, stars: 0, rays: 0, shafts: 0, clouds: 0.4, split: 0.45, haze: 0.4, mistDensity: 0.006, mistBase: -2, mistFalloff: 0.09, cloudWhite: 0, storm: 0, toon: 0.7, painted: 0, paintLight: c(0xffffff), fogMax: 1, landHaze: c(0xffffff), tint: c(0xffffff), lift: c(0x000000), saturation: 0.85,
    contrast: 1.05, vignette: 0.3, grain: 0.04, distortion: 0,
    ...p,
  } as LightingParams
}

const NIGHT = key({
  moonColor: c(0xa8bcff), moonIntensity: 1.6, hemiSky: c(0x3a5a8e), hemiGround: c(0x121a2a), hemiIntensity: 1.5,
  fogColor: c(0x1a2a48), skyZenith: c(0x070e24), fogStart: 40, fogEnd: 520, exposure: 1.85, stars: 1, rays: 0.6, shafts: 1.1,
  clouds: 0.3,
  tint: c(0xdde8ff), lift: c(0x010206), saturation: 0.9, contrast: 1.06, vignette: 0.32, grain: 0.03,
  haze: 0.35, mistDensity: 0.014, mistBase: 1, mistFalloff: 0.075,
})
const DAWN = key({
  sunColor: c(0xffb27a), sunIntensity: 1.8, hemiSky: c(0x8d8fb0), hemiGround: c(0x3a302c), hemiIntensity: 1.1,
  fogColor: c(0xb08a86), skyZenith: c(0x4a5c8a), fogStart: 60, fogEnd: 950, exposure: 1.1, stars: 0.15, rays: 1, shafts: 1.1,
  clouds: 0.4,
  tint: c(0xfff0e8), vignette: 0.3, grain: 0.035,
  haze: 0.5, cloudWhite: 0.45, toon: 0.85, fogMax: 0.72, landHaze: c(0xb4b8cc), mistDensity: 0.022, mistBase: 2, mistFalloff: 0.08,
})
// Clear golden-afternoon day (refer/environment/day-evening.png): strong warm key, bluer sky, lower fill
// so shadows read, lighter hazy horizon.
// GENSHIN DAY: saturated blue sky with white cumulus, warm-white sun, BRIGHT sky-blue fill (shadows are light
// and cool, never black), cel-shaded volumes, clear air (little haze), vivid colour, no vignette/grain.
const DAY = key({
  sunColor: c(0xfff2dc), sunIntensity: 2.9, hemiSky: c(0xb4d6ff), hemiGround: c(0x6f8f4c), hemiIntensity: 1.75,
  fogColor: c(0xcfe5f8), skyZenith: c(0x2a78e4), fogStart: 140, fogEnd: 1900, exposure: 1.0, rays: 0.35, shafts: 0.2,
  clouds: 0.5, split: 0.12, saturation: 1.2, contrast: 1.02, vignette: 0.05, grain: 0,
  // Genshin's distance stays green under a light sky-blue veil (Windwail / Starfell vistas) — not grey-teal, and
  // almost no ground mist by day (it pooled ~1 optical depth over every lowland: vistas read as a grey sea).
  haze: 0.12, cloudWhite: 1, toon: 1, fogMax: 0.5, landHaze: c(0xbcd8f2), mistDensity: 0.0004, mistBase: -6, mistFalloff: 0.12,
})
const EVENING = key({
  // refer/roads hero: strong warm key, COOL blue-violet fill (shadows read blue), peach horizon toward the sun
  // (sky shader), blue-violet sky away from it.
  sunColor: c(0xffb468), sunIntensity: 3.6, hemiSky: c(0x6f86c8), hemiGround: c(0x46404a), hemiIntensity: 1.25,
  fogColor: c(0x6f86ba), skyZenith: c(0x2c5aa8), fogStart: 50, fogEnd: 1150, exposure: 1.5, stars: 0.05, rays: 0.35,
  shafts: 0.65, clouds: 0.55, split: 0.6, tint: c(0xfff4e8), lift: c(0x04050c), saturation: 1.0, contrast: 1.1, vignette: 0.3,
  haze: 0.55, toon: 0.85, fogMax: 0.75, landHaze: c(0xb0b8d4), mistDensity: 0.009, mistBase: 0, mistFalloff: 0.085,
})
const DUSK = key({
  sunColor: c(0xff6a40), sunIntensity: 0.8, moonIntensity: 0.5, hemiSky: c(0x4a5078), hemiGround: c(0x1c1620),
  hemiIntensity: 1.0, fogColor: c(0x5a4660), skyZenith: c(0x1d2447), fogStart: 50, fogEnd: 800, exposure: 1.25, stars: 0.5,
  rays: 0.6, shafts: 0.7, clouds: 0.45, lift: c(0x030208), vignette: 0.4, grain: 0.045,
  haze: 0.5, fogMax: 0.9, landHaze: c(0xc8c4d4), mistDensity: 0.014, mistBase: 1, mistFalloff: 0.08,
})
const NIGHTMARE = key({
  // refer/nightmare: glowing crimson sky, near-black silhouettes, dark red-brown ground — not a flat red wash.
  sunColor: c(0xff4a30), sunIntensity: 1.1, moonColor: c(0xff4a30), moonIntensity: 1.1, hemiSky: c(0x7a2a30),
  hemiGround: c(0x140608), hemiIntensity: 1.1, fogColor: c(0x6a1a1c), skyZenith: c(0x1a0508), fogStart: 28, fogEnd: 380,
  exposure: 1.35, rays: 0.8, shafts: 1.0, clouds: 0.65, split: 0.4, tint: c(0xffe8e4), lift: c(0x050002), saturation: 0.85,
  contrast: 1.22, vignette: 0.5, grain: 0.06, distortion: 1,
  haze: 0.55, mistDensity: 0.02, mistBase: 3, mistFalloff: 0.07,
})

// STORYBOOK art style (the forest-house study, artStyle.ts): the same sun path, but an UNLIT painting —
// materials show their (pastel-remapped) colour × `paintLight`, lighter on sky-facing sides; no sun shading,
// rim or cel terminator (stylize.ts). Pale slate-blue sky and a close pale haze that swallows the distance like
// the diorama's edge (partial: land keeps its shape, see fogMax/landHaze). Grading stays neutral (the palette is done in the materials). At night `painted` drops
// so the flashlight and moon still light the world (the horror mood is kept). God rays / volumetric shafts
// and bloom are kept (the sun shadow map still renders: it feeds the shafts; the painted shading hides the
// cast shadows by day). Sky/fog/haze are pale, so shafts read as soft light through the trees.
const STORY_BASE = { toon: 0, split: 0.1, saturation: 1.0, contrast: 1.0, lift: c(0x000000), vignette: 0.08, grain: 0 }
const STORY_DAWN = key({
  ...DAWN, ...STORY_BASE, painted: 1, paintLight: c(0xf2dcd0), fogColor: c(0xc4b8c0), skyZenith: c(0x8a9cb8),
  fogStart: 40, fogEnd: 1400, exposure: 1.0, clouds: 0.25, cloudWhite: 0.7, haze: 0.24, tint: c(0xffffff), fogMax: 0.7, landHaze: c(0xc8ccd4),
})
const STORY_DAY = key({
  ...DAY, ...STORY_BASE, painted: 1, paintLight: c(0xf4f4ee), fogColor: c(0xb6c6d2), skyZenith: c(0x93adc4),
  fogStart: 45, fogEnd: 1500, exposure: 1.0, clouds: 0.22, cloudWhite: 1, haze: 0.22, tint: c(0xffffff), fogMax: 0.66, landHaze: c(0xc4d2d4),
})
const STORY_EVENING = key({
  ...EVENING, ...STORY_BASE, painted: 1, paintLight: c(0xf2d8c0), fogColor: c(0xb4b2c0), skyZenith: c(0x7a8cae),
  fogStart: 40, fogEnd: 1400, exposure: 1.0, clouds: 0.3, cloudWhite: 0.6, haze: 0.26, tint: c(0xffffff), fogMax: 0.72, landHaze: c(0xc4c4d4),
})
const STORY_DUSK = key({ ...DUSK, painted: 0.7, paintLight: c(0x5c5270), toon: 0 })
const STORY_NIGHT = key({ ...NIGHT, painted: 0.45, paintLight: c(0x1c2a44), toon: 0 })

/** Hour keyframes (cyclic). */
const SCHEDULE: [number, LightingParams, TimeLabel][] = [
  [0, NIGHT, 'NIGHT'],
  [4.8, NIGHT, 'NIGHT'],
  [6.2, DAWN, 'DAWN'],
  [8.2, DAY, 'DAY'],
  [14.6, DAY, 'DAY'],
  [15.9, EVENING, 'EVENING'], // sun ≈ 16° up: disc sits well above the ridges, as in the hero shot
  [18.6, DUSK, 'DUSK'],
  [20.3, NIGHT, 'NIGHT'],
]

// OVERLAND art style (the "over the hill" / art of rally look, artStyle.ts): the same sun path lit normally
// (Lambert + soft two-tone), but the AIR is the picture — warm cream haze by day that thickens into a peach
// glow at dawn/evening (everything toward the sun goes salmon, hills fade in layers), a pale lavender-blue
// zenith with few clouds, lifted low-contrast shadows, bloom, no vignette/grain/paint filter. Night is a soft
// blue-grey with stars (not the horror indigo), the monsters still come.
const OVER_BASE = { toon: 0.6, grain: 0, painted: 0, contrast: 0.98, lift: c(0x000000), cloudWhite: 1 }
const OVER_DAWN = key({
  // Their sunrise trail: everything toward the sun goes SALMON-RED (trees included), pale peach sky, glowing haze.
  ...OVER_BASE, sunColor: c(0xff9a68), sunIntensity: 3.0, hemiSky: c(0xe8b0b4), hemiGround: c(0xb07058), hemiIntensity: 1.6,
  fogColor: c(0xf8c0a8), skyZenith: c(0xe0a4b4), fogStart: 90, fogEnd: 1000, exposure: 1.4, stars: 0, rays: 0.9, shafts: 0.9,
  clouds: 0.06, split: 0.45, saturation: 1.3, contrast: 1.0, vignette: 0.06, tint: c(0xfff0e8),
  haze: 0.5, fogMax: 0.82, landHaze: c(0xf4c8b8), mistDensity: 0.024, mistBase: 2, mistFalloff: 0.08,
})
// Their midday is already golden hour: pink-lavender zenith, pale peach horizon, warm sun, lifted warm shadows.
const OVER_DAY = key({
  ...OVER_BASE, sunColor: c(0xfff0d8), sunIntensity: 3.3, hemiSky: c(0xeed8dc), hemiGround: c(0xc0a060), hemiIntensity: 1.5,
  fogColor: c(0xfaecd8), skyZenith: c(0xf0c4cc), fogStart: 160, fogEnd: 1500, exposure: 1.28, rays: 0.35, shafts: 0.2,
  clouds: 0.06, split: 0.35, saturation: 1.3, contrast: 1.06, vignette: 0.05, tint: c(0xfff8f0),
  haze: 0.26, fogMax: 0.72, landHaze: c(0xf6e2d4), mistDensity: 0.003, mistBase: -3, mistFalloff: 0.1,
})
const OVER_EVENING = key({
  // Their golden evening is HIGH-KEY: near-white peach sky, pale glowing haze, light yellow grass — not orange.
  ...OVER_BASE, sunColor: c(0xffe0b0), sunIntensity: 3.6, hemiSky: c(0xf2e0e0), hemiGround: c(0xd4b478), hemiIntensity: 2.1,
  fogColor: c(0xfae6d0), skyZenith: c(0xecc8cc), fogStart: 150, fogEnd: 1300, exposure: 1.5, stars: 0, rays: 0.6, shafts: 0.6,
  clouds: 0.06, split: 0.35, saturation: 1.05, contrast: 0.96, vignette: 0.04, tint: c(0xfff8f2),
  haze: 0.26, fogMax: 0.72, landHaze: c(0xf8ead8), mistDensity: 0.006, mistBase: 0, mistFalloff: 0.085,
})
// Their dusk/night is MAGENTA-PURPLE: pink-violet sky, purple mountain silhouettes, the straw going red-orange.
const OVER_DUSK = key({
  ...OVER_BASE, sunColor: c(0xffa070), sunIntensity: 1.6, moonIntensity: 0.5, hemiSky: c(0xb878a8), hemiGround: c(0x6a3420),
  hemiIntensity: 1.5, fogColor: c(0xd090b0), skyZenith: c(0x78409a), fogStart: 90, fogEnd: 900, exposure: 1.7, stars: 0.15,
  rays: 0.5, shafts: 0.6, clouds: 0.06, vignette: 0.15, saturation: 1.1, tint: c(0xffeef4),
  haze: 0.4, fogMax: 0.82, landHaze: c(0xd090b0), mistDensity: 0.014, mistBase: 1, mistFalloff: 0.08,
})
const OVER_NIGHT = key({
  // Their night camp: deep blue-grey sky with stars, blue mountain layers, the meadow a dim olive — not purple.
  ...OVER_BASE, moonColor: c(0xbcc8ff), moonIntensity: 2.0, hemiSky: c(0x4a5a84), hemiGround: c(0x22222a), hemiIntensity: 1.6,
  fogColor: c(0x3c4664), skyZenith: c(0x182036), fogStart: 150, fogEnd: 900, exposure: 2.1, stars: 1, rays: 0.4, shafts: 0.8,
  clouds: 0.08, tint: c(0xe0e6ff), saturation: 0.8, contrast: 1.06, vignette: 0.18,
  haze: 0.2, fogMax: 0.8, landHaze: c(0x8c98b8), mistDensity: 0.012, mistBase: 1, mistFalloff: 0.075,
})

// GENSHIN art style (reference-matched: Windrise, Galesong Hill, Springvale, Windwail screenshots, sampled):
// a cobalt zenith over a pale cyan horizon, a warm-white sun, and a BRIGHT cool sky fill so shadows stay light
// and blue-teal (Genshin never crushes shade to black); a NEUTRAL grade (the colours are in the albedos — the
// 'bright' style's saturation 1.2 drove the meadow's blue channel to zero = neon olive); soft cel terminator;
// strong blue aerial perspective on distant land (far hills go sky-cyan). Night/dusk keep the game's mood.
const GEN_BASE = { painted: 0, grain: 0, vignette: 0.04, lift: c(0x000000) }
const GEN_DAWN = key({
  ...DAWN, ...GEN_BASE, sunColor: c(0xffc89a), sunIntensity: 2.2, hemiSky: c(0xa8b8e0), hemiGround: c(0x6a6a58), hemiIntensity: 1.6,
  fogColor: c(0xe8c8c0), skyZenith: c(0x5a84c8), saturation: 1.0, contrast: 1.0, split: 0.15, toon: 0.8,
  clouds: 0.45, cloudWhite: 0.7, fogStart: 50, fogEnd: 800, fogMax: 0.82, landHaze: c(0xc8c8e0), haze: 0.42, mistDensity: 0.016, mistBase: 0, mistFalloff: 0.085,
})
const GEN_DAY = key({
  ...DAY, ...GEN_BASE, sunColor: c(0xfff2dc), sunIntensity: 2.9, hemiSky: c(0xa8d4ff), hemiGround: c(0x8aa878), hemiIntensity: 2.25,
  fogColor: c(0xc2e6f4), skyZenith: c(0x0f86e2), exposure: 1.1, saturation: 1.0, contrast: 1.0, split: 0.1, toon: 0.8,
  // Visible ATMOSPHERIC DEPTH (Genshin daytime): a pale-blue veil builds from ~60 m — a hill 400 m off is ~40 %
  // sky-tinted, 1 km ~75 % — and a thin milky mist lies in the valleys and over water.
  clouds: 0.3, cloudWhite: 1, fogStart: 60, fogEnd: 900, haze: 0.4, fogMax: 0.8, landHaze: c(0xa2ccf4), mistDensity: 0.006, mistBase: -4, mistFalloff: 0.1,
})
const GEN_EVENING = key({
  ...EVENING, ...GEN_BASE, sunColor: c(0xffc890), sunIntensity: 3.0, hemiSky: c(0x9cb4e8), hemiGround: c(0x6a6458), hemiIntensity: 1.7,
  fogColor: c(0xe8c4a8), skyZenith: c(0x3a6cc4), saturation: 1.0, contrast: 1.02, split: 0.3, toon: 0.8, fogMax: 0.82,
  fogStart: 50, fogEnd: 800, landHaze: c(0xd4c8dc), haze: 0.5, mistDensity: 0.012, mistBase: 0, mistFalloff: 0.085,
})
const GEN_DUSK = key({ ...DUSK, ...GEN_BASE, saturation: 0.95, vignette: 0.2 })
const GEN_NIGHT = key({ ...NIGHT, ...GEN_BASE, vignette: 0.2 })

/** The base schedule with each phase's params swapped for a style's. */
function styled(map: Map<LightingParams, LightingParams>): [number, LightingParams, TimeLabel][] {
  return SCHEDULE.map(([h, p, l]) => [h, map.get(p) ?? p, l])
}
const STORY_SCHEDULE = styled(new Map([[DAWN, STORY_DAWN], [DAY, STORY_DAY], [EVENING, STORY_EVENING], [DUSK, STORY_DUSK], [NIGHT, STORY_NIGHT]]))
const OVER_SCHEDULE = styled(new Map([[DAWN, OVER_DAWN], [DAY, OVER_DAY], [EVENING, OVER_EVENING], [DUSK, OVER_DUSK], [NIGHT, OVER_NIGHT]]))
const GEN_SCHEDULE = styled(new Map([[DAWN, GEN_DAWN], [DAY, GEN_DAY], [EVENING, GEN_EVENING], [DUSK, GEN_DUSK], [NIGHT, GEN_NIGHT]]))

/** Named jump targets for the T key / buttons. */
export const TIME_PRESETS: { label: TimeLabel; hours: number }[] = [
  { label: 'DAWN', hours: 6.4 },
  { label: 'DAY', hours: 11 },
  { label: 'EVENING', hours: 16.1 },
  { label: 'NIGHT', hours: 22.5 },
]

/** Arc tilt: noon elevation = 90° − TILT ≈ 32° → long shadows and a sun you actually see. */
const TILT = (58 * Math.PI) / 180

function cloneParams(p: LightingParams): LightingParams {
  const o = { ...p }
  for (const k of Object.keys(o) as (keyof LightingParams)[]) {
    const v = o[k]
    if (v instanceof THREE.Color) (o as Record<string, unknown>)[k] = v.clone()
  }
  return o
}

function lerpParams(out: LightingParams, a: LightingParams, b: LightingParams, t: number): void {
  for (const k of Object.keys(out) as (keyof LightingParams)[]) {
    const av = a[k]
    const bv = b[k]
    if (av instanceof THREE.Color) (out[k] as THREE.Color).copy(av).lerp(bv as THREE.Color, t)
    else (out as unknown as Record<string, number>)[k] = (av as number) + ((bv as number) - (av as number)) * t
  }
}

const smooth = (t: number) => t * t * (3 - 2 * t)

/** Sun direction (unit, towards the sun) for a given hour. Pure — unit-tested. */
export function sunDirection(hours: number, out = new THREE.Vector3()): THREE.Vector3 {
  const theta = ((hours - 6) / 12) * Math.PI
  return out.set(-Math.sin(theta) * Math.sin(TILT), Math.sin(theta) * Math.cos(TILT), -Math.cos(theta))
}

export class TimeOfDay {
  /** Game hours [0, 24). */
  hours: number
  /** Game days elapsed (weather slots are keyed by day + hour). */
  day = 0
  /** Real minutes for a full 24 h cycle; 0 = paused. */
  dayLengthMinutes = 24
  /** Nightmare realm weight 0..1 and its target. */
  nightmare = 0
  nightmareTarget = 0
  readonly current: LightingParams
  readonly sunDir = new THREE.Vector3()
  readonly moonDir = new THREE.Vector3()
  label: TimeLabel = 'DAY'
  /** Art style: picks the keyframe set (values only — same uniforms, same cost). */
  style: ArtStyle = 'overland'
  /** Fast-forward animation state (the sun visibly travels to the target). */
  private anim: { from: number; to: number; t: number; seconds: number } | null = null
  private readonly scratch: LightingParams

  constructor(hours = 17) {
    this.hours = hours
    this.current = cloneParams(DAY)
    this.scratch = cloneParams(DAY)
    this.evaluate()
  }

  get isNight(): boolean {
    return this.hours < 6 || this.hours >= 19
  }

  get animating(): boolean {
    return this.anim !== null
  }

  /** Animate forward in time to `hours` over `seconds` (never backwards: the sun keeps its path). */
  goTo(hours: number, seconds = 7): void {
    let to = hours
    while (to <= this.hours + 0.01) to += 24
    this.anim = { from: this.hours, to, t: 0, seconds }
  }

  toggleDayNight(): void {
    this.goTo(this.isNight ? 9.5 : 22)
  }

  /** Jump to the next named preset after the current time. */
  nextPreset(): TimeLabel {
    const h = this.anim ? this.anim.to % 24 : this.hours
    const next = TIME_PRESETS.find((p) => p.hours > h + 0.05) ?? TIME_PRESETS[0]
    this.goTo(next.hours)
    return next.label
  }

  setNightmare(on: boolean): void {
    this.nightmareTarget = on ? 1 : 0
  }

  update(dt: number): void {
    if (this.anim) {
      const a = this.anim
      a.t = Math.min(1, a.t + dt / a.seconds)
      this.hours = (a.from + (a.to - a.from) * smooth(a.t)) % 24
      if (a.t >= 1) this.anim = null
    } else if (this.dayLengthMinutes > 0) {
      const h = this.hours + (dt * 24) / (this.dayLengthMinutes * 60)
      if (h >= 24) this.day++
      this.hours = h % 24
    }
    const k = dt / 2.5
    this.nightmare += Math.max(-k, Math.min(k, this.nightmareTarget - this.nightmare))
    this.evaluate()
  }

  setStyle(style: ArtStyle): void {
    this.style = style
    this.evaluate()
  }

  private evaluate(): void {
    const h = this.hours
    const sched = this.style === 'storybook' ? STORY_SCHEDULE : this.style === 'overland' ? OVER_SCHEDULE : this.style === 'genshin' ? GEN_SCHEDULE : SCHEDULE
    let i = sched.length - 1
    for (let j = 0; j < sched.length; j++) if (sched[j][0] <= h) i = j
    const [h0, p0, l0] = sched[i]
    const [h1raw, p1] = sched[(i + 1) % sched.length]
    const h1 = h1raw <= h0 ? h1raw + 24 : h1raw
    const t = smooth(Math.min(1, Math.max(0, (h - h0) / (h1 - h0))))
    lerpParams(this.scratch, p0, p1, t)
    this.label = l0
    if (this.nightmare > 0.001) lerpParams(this.current, this.scratch, NIGHTMARE, smooth(this.nightmare))
    else lerpParams(this.current, this.scratch, this.scratch, 0)
    sunDirection(h, this.sunDir)
    this.moonDir.copy(this.sunDir).negate()
  }
}
