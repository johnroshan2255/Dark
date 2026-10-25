import type { FixedMap } from '../world/map/FixedMap'

/**
 * The map's LOOK on PlayCanvas: 'crisp' (DARK's cel look: toon terminator, rim outlines, sharpened, full-contrast
 * painted detail) or 'soft' (map.json `look: "soft"` — the Over the Hill reference, 2026-10-25). The soft look is
 * built into the MATERIALS, not laid over the screen: the terrain, rocks and grass compile their own soft paths
 * (flat palette colour, the crumpled relief texture lit by the sun — terrainMaterial / rockMaterial / grassMaterial),
 * the light wraps past the terminator with faint rims (uWrap, uRimK), leaf clumps take a coarser colour mip
 * (uLeafBlur), cars are matte and dusty. Nothing is applied to the screen: the image stays as clear as the crisp one.
 * `?soft=1|0` overrides the map for a side-by-side. No extra draws; the soft ground is cheaper than the crisp one.
 */
export interface Look {
  soft: boolean
  /** × the time of day's cel strength (uToon) */
  toonK: number
  /** × the sky / ground fill (hemisphere ambient): shade lit by the sky, readable, not crushed */
  fillK: number
  /** × the scene exposure (the soft look's high key) */
  exposureK: number
  /** the moon: × strength, pull to silver 0..1; the sky fill's floor (linear rgb ÷ π) — readable nights and dusks */
  moonK: number
  moonSilver: number
  fillFloor: [number, number, number]
  /** soft cast-shadow edges (the engine's PCF5 on HIGH / ULTRA) */
  softShadows: boolean
  /** the ground bounce's floor: × the sky fill's brightness (in the bounce's own hue; 0 = as the time of day has it) */
  bounceK: number
  /** the sun's cast shadows: how dark (the engine's light shadowIntensity — soft: shade keeps a quarter of the sun) */
  shadowK: number
  /** wrapped diffuse: light reaches this far past the terminator (0 = Lambert) */
  wrap: number
  /** × every material's rim light */
  rimK: number
  /** × the contrast of the surfaces' fine colour noise (ground brush, streaks, pebbles, cliff bands) */
  detailK: number
  /** mip bias on the leaf cards' colour (their cut-out stays sharp): the clump reads as one soft mass */
  leafBlur: number
  /** cars: × the paint sheen, the least road dust (0..1), paint saturation */
  carGloss: number
  carDust: number
  carSat: number
  /** the cars' own light wrap (crisp forms: the reference's vehicles read clean, lit top / shaded sides) */
  carWrap: number
}

const CRISP: Look = {
  soft: false, toonK: 1, fillK: 1, exposureK: 1, moonK: 1, moonSilver: 0, fillFloor: [0, 0, 0], softShadows: false, bounceK: 0, shadowK: 1, wrap: 0, rimK: 1, detailK: 1, leafBlur: 0,
  carGloss: 1, carDust: 0, carSat: 1, carWrap: 0,
}

const SOFT: Look = {
  soft: true, toonK: 0, fillK: 1.5, exposureK: 1.25, moonK: 2.2, moonSilver: 0.5, fillFloor: [0.05, 0.065, 0.11], softShadows: true, bounceK: 0.45, shadowK: 0.72, wrap: 0.45, rimK: 0.25, detailK: 0.4, leafBlur: 0,
  carGloss: 0.7, carDust: 0, carSat: 1, carWrap: 0.08,
}

let current: Look = CRISP

export function lookFor(map: FixedMap | null): Look {
  const o = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('soft') : null
  const soft = o !== null ? o !== '0' : map?.look === 'soft'
  return soft ? SOFT : CRISP
}

/** The game sets it once, before its materials are made. */
export function setLook(l: Look): void {
  current = l
}

export function activeLook(): Look {
  return current
}
