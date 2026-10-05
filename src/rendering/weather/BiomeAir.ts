import * as THREE from 'three'
import type { LightingParams } from '../lighting/TimeOfDay'

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

const lum = (c: THREE.Color) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722

/** Re-tint `p` toward a colour of the same brightness (keeps the phase's exposure, changes its hue). */
function hueToward(c: THREE.Color, target: THREE.Color, k: number, gain = 1): void {
  const l = lum(c)
  _c.copy(target).multiplyScalar((l / Math.max(lum(target), 1e-4)) * gain)
  c.lerp(_c, k)
}

/** @param sand desert weight under the player · @param snow snow weight (incl. the snow line) */
export function applyBiomeAir(p: LightingParams, sand: number, snow: number): void {
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
}
