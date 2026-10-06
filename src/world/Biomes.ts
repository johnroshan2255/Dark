import { hash4, hashFloat } from './noise/rng'
import { createNoise2D, fbm, type Noise2D } from './noise/simplex'

/**
 * BIOMES / REGIONS — Genshin-style regions with soft borders (deterministic, global, evaluated per point like
 * every other field). The world is tiled by BIOME_CELL m cells, each with a jittered centre and ONE region type.
 *
 * REGION LAYOUT (generator v2): a cell's type comes from a seeded CLIMATE at its centre — smooth temperature,
 * moisture and "magic" noise fields varying over a few cells — through a small climate table:
 *     cold → SNOW highlands · hot & dry → DESERT · drier → AUTUMN valley · moist + magic → MYSTIC wood · else FOREST
 * so neighbours make sense (forest ↔ autumn ↔ desert along the dry gradient, forest climbing into snow, mystic
 * pockets inside the green lands) and every seed draws its own map. Shares ≈ forest 50 %, autumn / desert / snow
 * 15 % each, mystic 5 % (tests/world.test.ts). The 3×3 cells around the spawn are forest; down the main road
 * (cells (0, j)) one side always runs forest → autumn → desert and the other forest → mystic → snow, so every
 * region is reached by just driving.
 *
 * A point's region WEIGHTS (`weightsN`, one per region, summing to 1) blend the nearest cells over BIOME_BLEND m
 * (never a hard line; borders warp with noise), and high ground becomes snow regardless (the snow line).
 * `weights()` keeps the original [desert, snow] view for the systems that only care about those two (autumn and
 * mystic count as green land there). Region definitions: world/biomes/BiomeDefs.ts.
 * Only arithmetic + sqrt + seeded noise → identical on every client.
 */
export const Biome = { Forest: 0, Desert: 1, Snow: 2, Autumn: 3, Mystic: 4 } as const
export const BIOME_COUNT = 5
export const BIOME_CELL = 900
export const BIOME_BLEND = 260
/** Altitude where snow starts / is complete (m). Only the big massifs (up to ~260 m) wear snow caps — Genshin's
 *  green lands keep their hilltops green (snow belongs to the snow regions, Dragonspine). */
export const SNOW_LINE = [135, 175] as const
/**
 * World generator version: mixed into the region layout, shown with the seed in the HUD. Bump it whenever a change
 * makes the same seed produce a different world, so shared `?seed=` links and co-op peers can tell (v1 = the
 * original random forest / desert / snow cells).
 */
export const WORLD_GEN_VERSION = 2

/** Weights (sum ≤ 1 for the named types; the rest is green land): [desert, snow]. */
export type BiomeWeights = [number, number]
/** One weight per region (index = Biome id), summing to 1. */
export type RegionWeights = Float32Array

/** Climate table thresholds (noise units; tuned so the shares match the header — tests check them). */
const CLIMATE = { snow: -0.4, hot: 0.19, dry: -0.01, autumn: -0.23, magic: 0.43 }

export class BiomeField {
  private readonly cells = new Map<string, { x: number; z: number; type: number }>()
  /** Border warp (m): borders wander with low-frequency noise instead of running straight between cells. */
  warp: ((x: number, z: number) => [number, number]) | null = null
  private lastCi = Number.NaN
  private lastCj = Number.NaN
  private readonly nx = new Float64Array(9)
  private readonly nz = new Float64Array(9)
  private readonly nt = new Int8Array(9)
  private readonly nd = new Float64Array(9)
  private readonly tmp = new Float32Array(BIOME_COUNT)
  private readonly temp: Noise2D
  private readonly moist: Noise2D
  private readonly magic: Noise2D
  /** Side of the main road (+1 / −1 in j) that runs forest → autumn → desert; the other runs mystic → snow. */
  private readonly drySide: number
  constructor(private readonly seed: number) {
    const v = WORLD_GEN_VERSION
    this.temp = createNoise2D(hash4(seed, 3101, v))
    this.moist = createNoise2D(hash4(seed, 3102, v))
    this.magic = createNoise2D(hash4(seed, 3103, v))
    this.drySide = hashFloat(seed, 3004) < 0.5 ? 1 : -1
  }

  /** The climate-table region at world (x, z) (before blending). Exposed for tests and the map. */
  climateType(x: number, z: number): number {
    const k = 1 / (BIOME_CELL * 7)
    const t = fbm(this.temp, x * k, z * k, 2)
    const m = fbm(this.moist, x * k + 17.3, z * k - 9.1, 2)
    if (t < CLIMATE.snow) return Biome.Snow
    if (t > CLIMATE.hot && m < CLIMATE.dry) return Biome.Desert
    if (m < CLIMATE.autumn) return Biome.Autumn
    if (fbm(this.magic, x * k * 1.6 - 4.4, z * k * 1.6 + 2.2, 2) > CLIMATE.magic && m > 0) return Biome.Mystic
    return Biome.Forest
  }

  /** Cell (i, j): jittered centre + type. The 3×3 cells around the origin are always forest (spawn). */
  cell(i: number, j: number): { x: number; z: number; type: number } {
    const key = `${i},${j}`
    let c = this.cells.get(key)
    if (c) return c
    const s = this.seed
    const x = (i + 0.25 + 0.5 * hashFloat(s, i, j, 3001)) * BIOME_CELL
    const z = (j + 0.25 + 0.5 * hashFloat(s, i, j, 3002)) * BIOME_CELL
    let type: number = Biome.Forest
    if (Math.abs(i) > 1 || Math.abs(j) > 1) {
      type = this.climateType(x, z)
      // Findable: the main road (x ≈ 0 ± 115 m, along z) crosses cells (0, j) — two and three steps along it the
      // regions are fixed: forest → AUTUMN → DESERT on the dry side, forest → MYSTIC → SNOW on the other.
      if (i === 0 && (Math.abs(j) === 2 || Math.abs(j) === 3)) {
        const dry = Math.sign(j) === this.drySide
        type = Math.abs(j) === 2 ? (dry ? Biome.Autumn : Biome.Mystic) : dry ? Biome.Desert : Biome.Snow
      }
    }
    c = { x, z, type }
    if (this.cells.size > 4096) this.cells.clear()
    this.cells.set(key, c)
    return c
  }

  /**
   * Region weights at (x, z), one per region (index = Biome id), summing to 1. Nearest-cell blend: each of the 3×3
   * surrounding cells gets weight (1 − (d − dMin) / BIOME_BLEND)² (0 beyond), normalised.
   * @param h terrain height for the snow line (omit for the pure region weights).
   */
  weightsN(x: number, z: number, out: RegionWeights, h?: number): RegionWeights {
    if (this.warp) {
      const w = this.warp(x, z)
      x += w[0]
      z += w[1]
    }
    const ci = Math.floor(x / BIOME_CELL), cj = Math.floor(z / BIOME_CELL)
    // The 3×3 neighbourhood is shared by every point of a chunk → cached between calls (no map lookups).
    if (ci !== this.lastCi || cj !== this.lastCj) {
      this.lastCi = ci
      this.lastCj = cj
      let k = 0
      for (let j = cj - 1; j <= cj + 1; j++) {
        for (let i = ci - 1; i <= ci + 1; i++) {
          const c = this.cell(i, j)
          this.nx[k] = c.x
          this.nz[k] = c.z
          this.nt[k] = c.type
          k++
        }
      }
    }
    const d = this.nd
    let dMin = Infinity
    for (let k = 0; k < 9; k++) {
      const dx = x - this.nx[k], dz = z - this.nz[k]
      const dd = Math.sqrt(dx * dx + dz * dz)
      d[k] = dd
      if (dd < dMin) dMin = dd
    }
    out.fill(0)
    let sum = 0
    for (let k = 0; k < 9; k++) {
      const w0 = 1 - (d[k] - dMin) / BIOME_BLEND
      if (w0 <= 0) continue
      const w = w0 * w0
      sum += w
      out[this.nt[k]] += w
    }
    for (let b = 0; b < BIOME_COUNT; b++) out[b] /= sum
    if (h !== undefined) {
      // Snow line: white peaks in every region; deserts keep theirs a little higher (dry air). The other regions
      // give up their share proportionally, so the weights still sum to 1.
      const sand = out[Biome.Desert]
      const lo = SNOW_LINE[0] + sand * 30, hi = SNOW_LINE[1] + sand * 30
      const k = Math.min(1, Math.max(0, (h - lo) / (hi - lo)))
      const alt = k * k * (3 - 2 * k)
      const snow = out[Biome.Snow]
      if (alt > snow) {
        const rest = 1 - snow, keep = rest > 1e-6 ? (1 - alt) / rest : 0
        for (let b = 0; b < BIOME_COUNT; b++) out[b] = b === Biome.Snow ? alt : out[b] * keep
      }
    }
    return out
  }

  /** [desert, snow] view of `weightsN` (autumn and mystic count as green land here). */
  weights(x: number, z: number, out: BiomeWeights, h?: number): BiomeWeights {
    const w = this.weightsN(x, z, this.tmp, h)
    out[0] = w[Biome.Desert]
    out[1] = w[Biome.Snow]
    return out
  }

  /** Dominant region at (x, z) — HUD label, map. */
  dominant(x: number, z: number, h?: number): number {
    const w = this.weightsN(x, z, this.tmp, h)
    let best = 0
    for (let b = 1; b < BIOME_COUNT; b++) if (w[b] > w[best]) best = b
    return best
  }
}

export const BIOME_NAMES = ['Forest', 'Desert', 'Snowfield', 'Autumn Valley', 'Mystic Wood'] as const
