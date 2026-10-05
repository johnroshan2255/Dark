import { hashFloat } from './noise/rng'

/**
 * BIOMES — Genshin-style regions with soft borders (deterministic, global, evaluated per point like every
 * other field): the world is tiled by BIOME_CELL m cells, each with a jittered centre and ONE type picked by
 * hash (forest 50 %, desert 27 %, snow 23 %); the cells around the spawn are forest, so a new game always
 * starts in the familiar green valley and the sand / ice regions are found by travelling.
 * A point's biome WEIGHTS blend the nearest cells over BIOME_BLEND m (never a hard line), and high ground
 * becomes snow regardless (the snow line) so mountains get white peaks in every region.
 * Everything reads the weights: terrain relief (dunes / flatter deserts), ground palette, trees, rocks,
 * grass, the terrain shader's surface detail and the fog tint. Only arithmetic + sqrt → identical on every client.
 */
export const Biome = { Forest: 0, Desert: 1, Snow: 2 } as const
export const BIOME_CELL = 900
export const BIOME_BLEND = 260
/** Altitude where snow starts / is complete (m). Only the big massifs (up to ~260 m) wear snow caps — Genshin's
 *  green lands keep their hilltops green (snow belongs to the snow regions, Dragonspine). */
export const SNOW_LINE = [135, 175] as const

/** Weights (sum ≤ 1 for the named types; the rest is forest): [desert, snow]. */
export type BiomeWeights = [number, number]

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
  constructor(private readonly seed: number) {}

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
      const r = hashFloat(s, i, j, 3003)
      type = r < 0.5 ? Biome.Forest : r < 0.77 ? Biome.Desert : Biome.Snow
      // Findable: the main road (x ≈ 0 ± 115 m, along z) crosses cells (0, j) — the two cells two steps down
      // and up the road are always one desert and one snowfield, so both are reached by just driving.
      if (i === 0 && Math.abs(j) === 2) {
        const first = hashFloat(s, 3004) < 0.5 ? Biome.Desert : Biome.Snow
        type = j > 0 ? first : first === Biome.Desert ? Biome.Snow : Biome.Desert
      }
    }
    c = { x, z, type }
    if (this.cells.size > 4096) this.cells.clear()
    this.cells.set(key, c)
    return c
  }

  /**
   * Biome weights at (x, z) — [desert, snow]; forest = 1 − desert − snow. Nearest-cell blend: each of the
   * 3×3 surrounding cells gets weight (1 − (d − dMin) / BIOME_BLEND)² (0 beyond), normalised.
   * @param h terrain height for the snow line (omit for the pure region weights).
   */
  weights(x: number, z: number, out: BiomeWeights, h?: number): BiomeWeights {
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
    let sand = 0, snow = 0, sum = 0
    for (let k = 0; k < 9; k++) {
      const w0 = 1 - (d[k] - dMin) / BIOME_BLEND
      if (w0 <= 0) continue
      const w = w0 * w0
      sum += w
      if (this.nt[k] === Biome.Desert) sand += w
      else if (this.nt[k] === Biome.Snow) snow += w
    }
    sand /= sum
    snow /= sum
    if (h !== undefined) {
      // Snow line: white peaks in every region; deserts keep theirs a little higher (dry air).
      const lo = SNOW_LINE[0] + sand * 30, hi = SNOW_LINE[1] + sand * 30
      const k = Math.min(1, Math.max(0, (h - lo) / (hi - lo)))
      const alt = k * k * (3 - 2 * k)
      snow = Math.max(snow, alt)
      sand = Math.min(sand, 1 - snow)
    }
    out[0] = sand
    out[1] = snow
    return out
  }

  /** Dominant biome at (x, z) — HUD label. */
  dominant(x: number, z: number, h?: number): number {
    const w = this.weights(x, z, [0, 0], h)
    return w[1] > 0.5 ? Biome.Snow : w[0] > 0.5 ? Biome.Desert : Biome.Forest
  }
}

export const BIOME_NAMES = ['Forest', 'Desert', 'Snowfield'] as const
