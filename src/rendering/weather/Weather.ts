import * as THREE from 'three'
import type { LightingParams } from '../lighting/TimeOfDay'
import { hashFloat } from '../../world/noise/rng'

/**
 * DYNAMIC WEATHER (over the hill: "day/night cycle and dynamic weather"). Three slow, deterministic fields —
 * CLOUD cover, RAIN and WIND — drift through the day: the target of each is a hash of (seed, day, 20-minute slot),
 * smoothed over ~2 game-hours, so every client with the same seed and clock sees the same sky (co-op safe).
 * They modulate the time-of-day lighting in place (`apply`): clouds dim and cool the sun, thicken the haze and
 * grey the sky; rain adds a grey-blue wash, darker ground and a wet sheen; wind scales the shared wind uniform
 * (grass, trees, fog banks, smoke). Cost: arithmetic per frame; the rain particles are one extra draw.
 */
export type WeatherKind = 'clear' | 'cloudy' | 'rain'

export class Weather {
  /** 0..1 fields (smoothed). */
  cloud = 0
  rain = 0
  wind = 0.5
  /** Ground wetness 0..1: follows the rain up quickly and dries out over ~6 game-minutes after it stops. */
  wet = 0
  /** Manual override (debug key / tests): null = automatic. */
  force: WeatherKind | null = null
  private readonly target = { cloud: 0, rain: 0, wind: 0.5 }
  private readonly baseWind = new THREE.Vector2()
  private readonly fog = new THREE.Color()
  private readonly grey = new THREE.Color(0.62, 0.64, 0.68)
  private readonly greyLid = new THREE.Color(0.62, 0.64, 0.68).multiplyScalar(0.72)
  private readonly greyRain = new THREE.Color(0.62, 0.64, 0.68).multiplyScalar(0.8)
  private readonly greyRainZenith = new THREE.Color(0.62, 0.64, 0.68).multiplyScalar(0.55)
  constructor(private readonly seed: number, baseWind: THREE.Vector2) {
    this.baseWind.copy(baseWind)
  }

  /** @param hours game hours [0, 24) · @param day game day counter (from TimeOfDay). */
  update(dt: number, hours: number, day: number): void {
    const slot = Math.floor(hours * 3) // 20-minute weather slots
    const s = this.seed, d = day * 100 + slot
    let cloud: number, rain: number, wind: number
    if (this.force) {
      cloud = this.force === 'clear' ? 0.05 : this.force === 'cloudy' ? 0.75 : 1
      rain = this.force === 'rain' ? 0.9 : 0
      wind = this.force === 'clear' ? 0.45 : this.force === 'cloudy' ? 0.7 : 0.95
    } else {
      // Mostly fair (their world is a sunny road trip): cloud builds a third of the time, rain ~12 % of slots.
      const c = hashFloat(s, d, 7001), r = hashFloat(s, d, 7002), w = hashFloat(s, d, 7003)
      cloud = c < 0.62 ? c * 0.3 : 0.4 + (c - 0.62) * 1.5
      rain = cloud > 0.8 && r < 0.6 ? 0.5 + r * 0.6 : 0
      wind = 0.3 + w * 0.5 + rain * 0.35
    }
    this.target.cloud = Math.min(1, cloud)
    this.target.rain = Math.min(1, rain)
    this.target.wind = Math.min(1, wind)
    // Smooth over ~2 game hours of the default 24-minute day (≈ 2 real minutes); rain starts/stops faster.
    const k = 1 - Math.exp(-dt / 90), kr = 1 - Math.exp(-dt / 40)
    this.cloud += (this.target.cloud - this.cloud) * k
    // Rain only falls from a sky that has actually clouded over: the target is gated by the CURRENT cover, so a
    // front rolls in (clouds first, ~1.5 real minutes), then the rain starts; it stops before the sky clears.
    const gate = Math.min(1, Math.max(0, (this.cloud - 0.6) / 0.25))
    this.rain += (this.target.rain * gate - this.rain) * kr
    this.wind += (this.target.wind - this.wind) * k
    const wetTarget = Math.min(1, this.rain * 1.4)
    this.wet += (wetTarget - this.wet) * (1 - Math.exp(-dt / (wetTarget > this.wet ? 12 : 150)))
  }

  get kind(): WeatherKind {
    return this.rain > 0.3 ? 'rain' : this.cloud > 0.55 ? 'cloudy' : 'clear'
  }

  /** Modulates the blended time-of-day params in place (after the phase blend, before the systems read them). */
  apply(p: LightingParams, wind: THREE.Vector2): void {
    const c = this.cloud, r = this.rain
    if (c > 0.001) {
      // Overcast: a low grey lid — the sky, fog and haze all go to the same grey, the sun goes flat.
      p.clouds = Math.max(p.clouds, 0.35 + c * 0.6)
      p.cloudWhite = Math.max(0, p.cloudWhite - c * 0.7)
      p.storm = Math.max(p.storm, c * 0.7)
      p.sunIntensity *= 1 - 0.7 * c
      p.hemiIntensity *= 1 + 0.2 * c
      p.haze = Math.min(1, p.haze + 0.25 * c)
      p.fogColor.lerp(this.fog.copy(p.fogColor).lerp(this.grey, 0.75), c * 0.8)
      p.skyZenith.lerp(this.greyLid, c * 0.75)
      p.landHaze.lerp(this.grey, c * 0.6)
      p.saturation *= 1 - 0.22 * c
      p.contrast *= 1 - 0.04 * c
      p.rays *= 1 - 0.85 * c
      p.shafts *= 1 - 0.7 * c
    }
    if (r > 0.001) {
      // Rain: darker, colder, wetter air; the sky lid nearly black-grey; thicker mist in the hollows.
      p.storm = Math.max(p.storm, 0.7 + 0.3 * r)
      p.sunIntensity *= 1 - 0.6 * r
      p.hemiSky.lerp(this.grey, r * 0.7)
      p.hemiGround.multiplyScalar(1 - 0.4 * r)
      p.fogColor.lerp(this.greyRain, r * 0.5)
      p.skyZenith.lerp(this.greyRainZenith, r * 0.6)
      p.exposure *= 1 - 0.15 * r
      p.fogStart *= 1 - 0.45 * r
      p.fogEnd *= 1 - 0.3 * r
      p.mistDensity += 0.008 * r
      p.saturation *= 1 - 0.25 * r
    }
    wind.copy(this.baseWind).multiplyScalar(0.5 + this.wind * 1.4)
  }
}
