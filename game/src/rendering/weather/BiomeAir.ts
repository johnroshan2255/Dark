import * as THREE from 'three'
import type { LightingParams } from '../lighting/TimeOfDay'
import { isBright } from '../artStyle'

/**
 * BIOME AIR: the region under the player re-tints the blended time-of-day params in place (before the lights,
 * the sky and the weather read them), so a biome feels different, not just looks a different colour:
 *  - SNOW: cold, clean air — blue-white horizon and haze, a deeper blue zenith, a whiter sun, and strong cool
 *    BOUNCE light from the snow (hemisphere ground colour) so shadows go light and blue as on real snowfields.
 *  - DESERT: hot, bleached air — pale warm haze, a washed-out zenith, a hard bright sun, an orange sand bounce,
 *    slightly lower saturation and more aerial haze (heat).
 * Multiplicative / lerped on whatever phase is active, so dawn, dusk and night keep their character.
 * Cost: a few colour ops per frame.
 */
const _c = new THREE.Color()
const SNOW_FOG = new THREE.Color(0.86, 0.92, 1.0)
const SNOW_ZENITH = new THREE.Color(0.18, 0.36, 0.78)
const SNOW_BOUNCE = new THREE.Color(0.72, 0.8, 0.95)
const SAND_FOG = new THREE.Color(1.0, 0.9, 0.72)
const SAND_ZENITH = new THREE.Color(0.26, 0.48, 0.86)
const SAND_BOUNCE = new THREE.Color(0.85, 0.6, 0.35)
const SNOW_TINT_OTH = new THREE.Color(0.94, 0.98, 1.04)
const SNOW_SHADE_OTH = new THREE.Color(0.5, 0.72, 1.0)
const SNOW_CYAN = new THREE.Color(0.7, 0.95, 1.12)
const SNOW_CYAN_FILL = new THREE.Color(0.35, 0.78, 1.0)
const sst = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const OTH_SAND_FILL = new THREE.Color(1.0, 0.8, 0.7)
const OTH_SAND_ZENITH = new THREE.Color(0.58, 0.86, 1.0)
const OTH_SAND_HAZE = new THREE.Color(1.0, 0.9, 0.86)
const OTH_SAND_LAND = new THREE.Color(1.0, 0.8, 0.74) // far mesas fade to pink-peach layers

// AUTUMN: warm golden air — honey haze, a warmer lower-feeling sun, an amber bounce from the leaf-strewn ground.
const AUT_FOG = new THREE.Color(1.0, 0.86, 0.66)
const AUT_SUN = new THREE.Color(1.0, 0.82, 0.6)
const AUT_BOUNCE = new THREE.Color(0.9, 0.62, 0.32)
// MYSTIC: violet mist — lavender fog and haze, a deeper blue-violet zenith, a cooler dimmer sun, teal bounce,
// thick ground mist pooling between the giants.
const MYS_FOG = new THREE.Color(0.74, 0.68, 1.0)
const MYS_ZENITH = new THREE.Color(0.24, 0.22, 0.7)
const MYS_SUN = new THREE.Color(0.82, 0.86, 1.0)
const MYS_BOUNCE = new THREE.Color(0.42, 0.7, 0.78)
const lum = (c: THREE.Color) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722

/** Re-tint `p` toward a colour of the same brightness (keeps the phase's exposure, changes its hue). */
function hueToward(c: THREE.Color, target: THREE.Color, k: number, gain = 1): void {
  const l = lum(c)
  _c.copy(target).multiplyScalar((l / Math.max(lum(target), 1e-4)) * gain)
  c.lerp(_c, k)
}

/**
 * @param sand desert weight under the player · @param snow snow weight (incl. the snow line)
 * @param autumn / @param mystic the other region weights (world/biomes/BiomeDefs.ts)
 */
export function applyBiomeAir(p: LightingParams, sand: number, snow: number, autumn = 0, mystic = 0): void {
  if (autumn > 0.001) {
    hueToward(p.fogColor, AUT_FOG, 0.55 * autumn, 1 + 0.04 * autumn)
    hueToward(p.landHaze, AUT_FOG, 0.5 * autumn)
    hueToward(p.sunColor, AUT_SUN, 0.45 * autumn)
    hueToward(p.hemiGround, AUT_BOUNCE, 0.6 * autumn)
    hueToward(p.tint, AUT_SUN, 0.12 * autumn)
    p.haze = Math.min(1, p.haze + 0.1 * autumn)
    p.saturation *= 1 + 0.06 * autumn
  }
  if (mystic > 0.001) {
    hueToward(p.fogColor, MYS_FOG, 0.7 * mystic)
    hueToward(p.landHaze, MYS_FOG, 0.65 * mystic)
    hueToward(p.skyZenith, MYS_ZENITH, 0.55 * mystic)
    hueToward(p.sunColor, MYS_SUN, 0.4 * mystic)
    hueToward(p.hemiSky, MYS_FOG, 0.35 * mystic)
    hueToward(p.hemiGround, MYS_BOUNCE, 0.6 * mystic)
    p.sunIntensity *= 1 - 0.18 * mystic
    p.haze = Math.min(1, p.haze + 0.18 * mystic)
    // Ground mist between the giants (the analytic height mist on every tier — no extra pass).
    p.mistDensity = p.mistDensity * (1 - mystic) + Math.max(p.mistDensity, 0.012) * mystic
    p.mistBase += 2 * mystic
  }
  if (snow > 0.001) {
    hueToward(p.fogColor, SNOW_FOG, 0.75 * snow, 1 + 0.08 * snow)
    hueToward(p.skyZenith, SNOW_ZENITH, 0.6 * snow)
    hueToward(p.landHaze, SNOW_FOG, 0.6 * snow)
    hueToward(p.sunColor, SNOW_FOG, 0.35 * snow)
    hueToward(p.hemiSky, SNOW_ZENITH, 0.3 * snow)
    // Snow bounce: the ground half of the sky light becomes bright and cool (light blue shadows).
    hueToward(p.hemiGround, SNOW_BOUNCE, 0.85 * snow, 1)
    p.hemiGround.multiplyScalar(1 + 1.6 * snow)
    hueToward(p.tint, SNOW_FOG, 0.25 * snow)
    p.saturation *= 1 - 0.08 * snow
  }
  if (sand > 0.001) {
    hueToward(p.fogColor, SAND_FOG, 0.6 * sand, 1 + 0.06 * sand)
    hueToward(p.skyZenith, SAND_ZENITH, 0.7 * sand, 1 + 0.05 * sand)
    hueToward(p.landHaze, SAND_FOG, 0.55 * sand)
    hueToward(p.hemiGround, SAND_BOUNCE, 0.7 * sand)
    p.hemiGround.multiplyScalar(1 + 0.6 * sand)
    p.sunIntensity *= 1 + 0.15 * sand
    p.haze = Math.min(1, p.haze + 0.15 * sand)
    p.mistDensity *= 1 - 0.6 * sand // dry air: no valley mist over the dunes
    p.saturation *= 1 - 0.05 * sand
  }
  if (snow > 0.001 && isBright()) {
    // BRIGHT snow stays BLUE-WHITE (their snow trucks: cyan-blue shade): undo the warm white balance and fill of the
    // bright keys over the snowfield — the warm grade turned the snow beige-grey (189,187,192).
    hueToward(p.tint, SNOW_TINT_OTH, 0.9 * snow)
    hueToward(p.hemiSky, SNOW_SHADE_OTH, 0.85 * snow, 1 + 0.1 * snow) // deep blue shade on the snow (theirs: cyan-blue)
    hueToward(p.fogColor, SNOW_FOG, 0.6 * snow)
    hueToward(p.landHaze, SNOW_FOG, 0.7 * snow)
    p.split *= 1 - 0.7 * snow
    // BLUE HOUR on the snow (their snow-truck shot): around dusk the whole snowfield goes CYAN — the white balance and
    // the fill swing to cyan-blue (stars ramp in at dusk → the blend weight; full night keeps its own moonlight).
    const bh = sst(0.02, 0.3, p.stars) * (1 - sst(0.6, 0.95, p.stars)) * snow
    if (bh > 0.001) {
      hueToward(p.tint, SNOW_CYAN, 0.85 * bh, 1 + 0.08 * bh)
      hueToward(p.hemiSky, SNOW_CYAN_FILL, 0.9 * bh, 1 + 0.25 * bh)
      hueToward(p.fogColor, SNOW_CYAN_FILL, 0.6 * bh)
      p.saturation *= 1 + 0.25 * bh
    }
  }
  if (sand > 0.001 && isBright()) {
    // BRIGHT (over the hill): a pale, almost white-cyan sky, thick warm haze over a clear sky, and WARM shade — the
    // blue sky fill on orange sand read as olive (measured shadowed sand 95,90,67 vs their 178,134,98).
    hueToward(p.hemiSky, OTH_SAND_FILL, 0.75 * sand, 1 + 0.4 * sand)
    hueToward(p.fogColor, OTH_SAND_HAZE, 0.8 * sand, 1 + 0.25 * sand)
    // Zenith at the HORIZON's brightness (pale sky by day, still dark at night) — hueToward kept the deep-blue
    // zenith's low luminance, which turned the pale target into a grey lid.
    _c.copy(OTH_SAND_ZENITH).multiplyScalar(lum(p.fogColor) / lum(OTH_SAND_HAZE))
    p.skyZenith.lerp(_c, 0.85 * sand)
    hueToward(p.landHaze, OTH_SAND_LAND, 0.85 * sand, 1 + 0.1 * sand)
    p.clouds *= 1 - 0.75 * sand
    p.hemiIntensity *= 1 + 0.3 * sand // lighter, warm shade (theirs ≈ 178,134,98)
    p.haze = Math.min(1, p.haze + 0.24 * sand)
    p.fogMax = Math.min(0.92, p.fogMax + 0.1 * sand)
    p.split *= 1 - 0.8 * sand // no cool split-toned shadows
  }
}

/** A fixed map's own air (FixedMap.palette skyZenith / skyHaze, linear rgb). */
export interface MapAir {
  zenith?: THREE.Color; haze?: THREE.Color; /** density / m, base (m), falloff / m */ mist?: [number, number, number]
  /** The map's LIGHT (map.json `light`): sun / sky-fill / ground-bounce hues, white balance, cel strength, split tone,
   *  saturation — Zhangjiajie: a neutral sun and a cool pale fill (the bright style's golden light turned its jade
   *  forest yellow and its grey-beige stone orange) and soft shading. */
  light?: { sun?: THREE.Color; fill?: THREE.Color; bounce?: THREE.Color; tint?: THREE.Color; toon?: number; split?: number; saturation?: number }
}

/** The daylight weight for applyMapAir from the sun's direction (y up): 0.55 with the sun low or down, 1 from ~35° up. */
export function dayWeight(sunY: number): number {
  const t = Math.min(1, Math.max(0, (sunY - 0.15) / 0.42))
  // (a 55 % share stays at a low sun: the dawn's and evening's own salmon alone washed the whole map pink-magenta)
  return 0.55 + 0.45 * t * t * (3 - 2 * t)
}

/**
 * MAP AIR: a fixed map's sky (Zhangjiajie's atlas: a clear mid-blue zenith over a soft blue-grey horizon, the far
 * spires and ridges fading into that blue-grey). Each colour is re-hued to the map's at the phase's own brightness,
 * so dawn, dusk and night keep their light; a little more aerial haze, the depth of the atlas's layered spires.
 * After applyBiomeAir (a map's region air is its own). Cost: a few colour ops per frame.
 */
export function applyMapAir(p: LightingParams, air: MapAir, day = 1): void {
  // `day` (0..1, the sun's height — dayWeight): the map's hues are its DAYLIGHT; a low sun keeps the phase's own (the
  // warm dawn sun, the evening's salmon, the night's blue — pulled 85 % to the map's white sun and pale haze, dawn and
  // evening went a flat grey-green wash, 2026-10-26)
  const L = air.light
  const shade = Math.max(day, 0.8)
  if (L) {
    if (L.sun) hueToward(p.sunColor, L.sun, 0.85 * day)
    // (the sun and the sky carry the hour's colour; the shade's fill, the bounce and the white balance stay mostly the
    //  map's — the evening's own violet fill and tint at full turned the whole map magenta)
    if (L.fill) hueToward(p.hemiSky, L.fill, 0.85 * shade)
    if (L.bounce) hueToward(p.hemiGround, L.bounce, 0.85 * shade)
    if (L.tint) hueToward(p.tint, L.tint, 0.9 * shade)
    if (L.toon !== undefined) p.toon = Math.min(p.toon, L.toon)
    if (L.split !== undefined) p.split = Math.min(p.split, L.split)
    if (L.saturation !== undefined) p.saturation *= 1 + (L.saturation - 1) * day
  }
  if (air.zenith) hueToward(p.skyZenith, air.zenith, 0.8 * day)
  if (air.haze) {
    const h = 0.25 + 0.75 * day
    hueToward(p.fogColor, air.haze, 0.8 * h)
    hueToward(p.landHaze, air.haze, 0.85 * h)
    hueToward(p.tint, air.haze, 0.08 * shade)
  }
  // the map's valley mist (Zhangjiajie's gorges full of cloud), never thinner than the phase's own (dawn, rain)
  if (air.mist) {
    // (a misty phase — dawn, dusk, rain — THICKENS the map's mist by a share of its extra, never replaces it: its own
    //  ground-hugging density lifted to the map's 25 m base with the map's slow falloff filled every valley with a grey
    //  soup — 2026-10-25, "in morning it looks bad, at evening not good")
    p.mistDensity = air.mist[0] + Math.max(0, p.mistDensity - 0.002) * 0.15
    p.mistBase = Math.max(p.mistBase, air.mist[1])
    p.mistFalloff = air.mist[2]
    // (the mist is the map's depth: the distance tint of the land stays lighter, so the far towers keep their rust and
    // green — at the bright day's 0.72 they were blue-grey cut-outs from a tower top)
    p.fogMax = Math.min(p.fogMax, 0.3)
    p.haze *= 0.4
  }
}
