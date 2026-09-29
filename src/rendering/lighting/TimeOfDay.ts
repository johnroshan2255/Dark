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
  /** White cumulus clouds (day) vs painted dusk clouds. */
  cloudWhite: number
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
    fogStart: 60, fogEnd: 1000, exposure: 1, stars: 0, rays: 0, shafts: 0, clouds: 0.4, split: 0.45, haze: 0.4, cloudWhite: 0, toon: 0.7, painted: 0, paintLight: c(0xffffff), fogMax: 1, landHaze: c(0xffffff), tint: c(0xffffff), lift: c(0x000000), saturation: 0.85,
    contrast: 1.05, vignette: 0.3, grain: 0.04, distortion: 0,
    ...p,
  } as LightingParams
}

const NIGHT = key({
  moonColor: c(0xa8bcff), moonIntensity: 1.6, hemiSky: c(0x3a5a8e), hemiGround: c(0x121a2a), hemiIntensity: 1.5,
  fogColor: c(0x1a2a48), skyZenith: c(0x070e24), fogStart: 40, fogEnd: 520, exposure: 1.85, stars: 1, rays: 0.6, shafts: 1.1,
  clouds: 0.3,
  tint: c(0xdde8ff), lift: c(0x010206), saturation: 0.9, contrast: 1.06, vignette: 0.32, grain: 0.03,
  haze: 0.35,
})
const DAWN = key({
  sunColor: c(0xffb27a), sunIntensity: 1.8, hemiSky: c(0x8d8fb0), hemiGround: c(0x3a302c), hemiIntensity: 1.1,
  fogColor: c(0xb08a86), skyZenith: c(0x4a5c8a), fogStart: 60, fogEnd: 950, exposure: 1.1, stars: 0.15, rays: 1, shafts: 1.1,
  clouds: 0.4,
  tint: c(0xfff0e8), vignette: 0.3, grain: 0.035,
  haze: 0.5, cloudWhite: 0.45, toon: 0.85, fogMax: 0.72, landHaze: c(0xb4b8cc),
})
// Clear golden-afternoon day (refer/environment/day-evening.png): strong warm key, bluer sky, lower fill
// so shadows read, lighter hazy horizon.
// GENSHIN DAY: saturated blue sky with white cumulus, warm-white sun, BRIGHT sky-blue fill (shadows are light
// and cool, never black), cel-shaded volumes, clear air (little haze), vivid colour, no vignette/grain.
const DAY = key({
  sunColor: c(0xfff2dc), sunIntensity: 2.9, hemiSky: c(0xb4d6ff), hemiGround: c(0x6f8f4c), hemiIntensity: 1.75,
  fogColor: c(0xcfe5f8), skyZenith: c(0x2a78e4), fogStart: 140, fogEnd: 1900, exposure: 1.0, rays: 0.35, shafts: 0.2,
  clouds: 0.5, split: 0.12, saturation: 1.2, contrast: 1.02, vignette: 0.05, grain: 0,
  haze: 0.16, cloudWhite: 1, toon: 1, fogMax: 0.62, landHaze: c(0xa8c4cc),
})
const EVENING = key({
  // refer/roads hero: strong warm key, COOL blue-violet fill (shadows read blue), peach horizon toward the sun
  // (sky shader), blue-violet sky away from it.
  sunColor: c(0xffb468), sunIntensity: 3.6, hemiSky: c(0x6f86c8), hemiGround: c(0x46404a), hemiIntensity: 1.25,
  fogColor: c(0x6f86ba), skyZenith: c(0x2c5aa8), fogStart: 50, fogEnd: 1150, exposure: 1.5, stars: 0.05, rays: 0.35,
  shafts: 0.65, clouds: 0.55, split: 0.6, tint: c(0xfff4e8), lift: c(0x04050c), saturation: 1.0, contrast: 1.1, vignette: 0.3,
  haze: 0.55, toon: 0.85, fogMax: 0.75, landHaze: c(0xb0b8d4),
})
const DUSK = key({
  sunColor: c(0xff6a40), sunIntensity: 0.8, moonIntensity: 0.5, hemiSky: c(0x4a5078), hemiGround: c(0x1c1620),
  hemiIntensity: 1.0, fogColor: c(0x5a4660), skyZenith: c(0x1d2447), fogStart: 50, fogEnd: 800, exposure: 1.25, stars: 0.5,
  rays: 0.6, shafts: 0.7, clouds: 0.45, lift: c(0x030208), vignette: 0.4, grain: 0.045,
  haze: 0.5, fogMax: 0.9, landHaze: c(0xc8c4d4),
})
const NIGHTMARE = key({
  // refer/nightmare: glowing crimson sky, near-black silhouettes, dark red-brown ground — not a flat red wash.
  sunColor: c(0xff4a30), sunIntensity: 1.1, moonColor: c(0xff4a30), moonIntensity: 1.1, hemiSky: c(0x7a2a30),
  hemiGround: c(0x140608), hemiIntensity: 1.1, fogColor: c(0x6a1a1c), skyZenith: c(0x1a0508), fogStart: 28, fogEnd: 380,
  exposure: 1.35, rays: 0.8, shafts: 1.0, clouds: 0.65, split: 0.4, tint: c(0xffe8e4), lift: c(0x050002), saturation: 0.85,
  contrast: 1.22, vignette: 0.5, grain: 0.06, distortion: 1,
  haze: 0.55,
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

const STORY_SCHEDULE: [number, LightingParams, TimeLabel][] = SCHEDULE.map(([h, p, l]) => [
  h,
  p === DAWN ? STORY_DAWN : p === DAY ? STORY_DAY : p === EVENING ? STORY_EVENING : p === DUSK ? STORY_DUSK : p === NIGHT ? STORY_NIGHT : p,
  l,
])

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
  style: ArtStyle = 'bright'
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
      this.hours = (this.hours + (dt * 24) / (this.dayLengthMinutes * 60)) % 24
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
    const sched = this.style === 'storybook' ? STORY_SCHEDULE : SCHEDULE
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
