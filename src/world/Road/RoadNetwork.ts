import { hashFloat } from '../noise/rng'
import type { PoiField } from '../POI/pois'

/**
 * Secondary road network (deterministic, global, evaluated per point like every other field):
 *  - Region grid of REGION m. Each region has ONE node: the highest of 4 hashed candidates (not in water)
 *    → roads lead up to hilltops / viewpoints.
 *  - A node links east / north to its neighbour with probability, and nodes near the main road link to it.
 *  - Each link = quadratic Bézier with a hashed bend, sampled into a polyline; heights along it are the
 *    terrain heights smoothed along the road (graded trail up the hill), never below the water.
 *  - Types: GRAVEL (wider, links to the main road) and TRAIL (narrow dirt track between hills).
 * Queries: `nearest(x, z)` → distance to the nearest road centreline, its height and type. Roads touching a
 * region are cached per region (built lazily; cache bounded).
 */
export const RoadType = { Gravel: 0, Trail: 1 } as const
export const REGION = 380
const SAMPLES = 18

export interface NetRoad {
  type: number
  halfWidth: number
  xs: Float32Array
  zs: Float32Array
  hs: Float32Array
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

export interface RoadHit {
  dist: number
  height: number
  type: number
  halfWidth: number
}

export interface NetworkHost {
  pois?: PoiField
  seed: number
  /** Terrain height without any road flattening (natural + river). */
  baseHeight(x: number, z: number): number
  roadCenterX(z: number): number
  mainRoadHeight(z: number): number
  water: number
}

export class RoadNetwork {
  private readonly nodes = new Map<string, [number, number] | null>()
  private readonly cellRoads = new Map<string, NetRoad[]>()
  private readonly built = new Map<string, NetRoad | null>()

  constructor(private readonly host: NetworkHost) {}

  private node(ci: number, cj: number): [number, number] | null {
    const key = `${ci},${cj}`
    let n = this.nodes.get(key)
    if (n !== undefined) return n
    const s = this.host.seed
    let best: [number, number] | null = null
    let bestH = -Infinity
    for (let k = 0; k < 4; k++) {
      const x = (ci + 0.15 + 0.7 * hashFloat(s, ci, cj, 900 + k * 2)) * REGION
      const z = (cj + 0.15 + 0.7 * hashFloat(s, ci, cj, 901 + k * 2)) * REGION
      const h = this.host.baseHeight(x, z)
      if (h > bestH && h > this.host.water + 3) (bestH = h), (best = [x, z])
    }
    n = best
    if (this.nodes.size > 4000) this.nodes.clear()
    this.nodes.set(key, n)
    return n
  }

  /** Road between two points (or to the main road when `b` is null). */
  private link(key: string, a: [number, number], b: [number, number] | null, type: number): NetRoad | null {
    let r = this.built.get(key)
    if (r !== undefined) return r
    const s = this.host.seed
    let bx: number, bz: number
    if (b) [bx, bz] = b
    else {
      bz = a[1] + (hashFloat(s, Math.floor(a[0]), Math.floor(a[1]), 950) - 0.5) * 120
      bx = this.host.roadCenterX(bz)
    }
    const dx = bx - a[0], dz = bz - a[1]
    const len = Math.hypot(dx, dz)
    if (len < 30 || len > REGION * 1.9) {
      this.built.set(key, null)
      return null
    }
    const bend = (hashFloat(s, Math.floor(a[0]), Math.floor(bz), 951) - 0.5) * 0.6 * len
    const cx = (a[0] + bx) / 2 - (dz / len) * bend
    const cz = (a[1] + bz) / 2 + (dx / len) * bend
    const xs = new Float32Array(SAMPLES), zs = new Float32Array(SAMPLES), raw = new Float32Array(SAMPLES), hs = new Float32Array(SAMPLES)
    for (let i = 0; i < SAMPLES; i++) {
      const t = i / (SAMPLES - 1)
      const u = 1 - t
      xs[i] = u * u * a[0] + 2 * u * t * cx + t * t * bx
      zs[i] = u * u * a[1] + 2 * u * t * cz + t * t * bz
      raw[i] = this.host.baseHeight(xs[i], zs[i])
    }
    // Grade the road: smooth heights along it, keep it out of the water, meet the main road at its level.
    for (let i = 0; i < SAMPLES; i++) {
      let sum = 0, w = 0
      for (let k = -2; k <= 2; k++) {
        const j = Math.min(SAMPLES - 1, Math.max(0, i + k))
        const ww = 3 - Math.abs(k)
        sum += raw[j] * ww
        w += ww
      }
      hs[i] = Math.max(this.host.water + 1.2, sum / w)
    }
    if (!b) {
      const mh = this.host.mainRoadHeight(bz)
      for (let i = 0; i < SAMPLES; i++) {
        const k = Math.max(0, (i - (SAMPLES - 5)) / 4)
        hs[i] += (mh - hs[i]) * Math.min(1, k)
      }
    }
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    for (let i = 0; i < SAMPLES; i++) {
      minX = Math.min(minX, xs[i]); maxX = Math.max(maxX, xs[i]); minZ = Math.min(minZ, zs[i]); maxZ = Math.max(maxZ, zs[i])
    }
    r = { type, halfWidth: type === RoadType.Gravel ? 2.3 : 1.35, xs, zs, hs, minX, minZ, maxX, maxZ }
    if (this.built.size > 4000) this.built.clear()
    this.built.set(key, r)
    return r
  }

  /** All roads whose bounds (+40 m) touch region (ci, cj). */
  private roadsForCell(ci: number, cj: number): NetRoad[] {
    const key = `${ci},${cj}`
    let list = this.cellRoads.get(key)
    if (list) return list
    list = []
    const s = this.host.seed
    const x0 = ci * REGION - 40, z0 = cj * REGION - 40, x1 = (ci + 1) * REGION + 40, z1 = (cj + 1) * REGION + 40
    for (let j = cj - 2; j <= cj + 1; j++) {
      for (let i = ci - 2; i <= ci + 1; i++) {
        const a = this.node(i, j)
        if (!a) continue
        const cand: NetRoad[] = []
        const e = this.node(i + 1, j)
        if (e && hashFloat(s, i, j, 960) < 0.55) {
          const r = this.link(`${i},${j}>e`, a, e, hashFloat(s, i, j, 962) < 0.4 ? RoadType.Gravel : RoadType.Trail)
          if (r) cand.push(r)
        }
        const nn = this.node(i, j + 1)
        if (nn && hashFloat(s, i, j, 961) < 0.55) {
          const r = this.link(`${i},${j}>n`, a, nn, hashFloat(s, i, j, 963) < 0.4 ? RoadType.Gravel : RoadType.Trail)
          if (r) cand.push(r)
        }
        if (Math.abs(a[0] - this.host.roadCenterX(a[1])) < REGION * 0.9) {
          const r = this.link(`${i},${j}>m`, a, null, RoadType.Gravel)
          if (r) cand.push(r)
        }
        for (const r of cand) if (r.maxX >= x0 && r.minX <= x1 && r.maxZ >= z0 && r.minZ <= z1 && !list.includes(r)) list.push(r)
      }
    }
    // Driveways: every place gets a gravel road to the main road.
    for (const p of this.host.pois?.inBox(x0 - 400, z0 - 400, x1 + 400, z1 + 400) ?? []) {
      if (Math.abs(p.x - this.host.roadCenterX(p.z)) > REGION * 1.8) continue
      const r = this.link(`poi:${Math.floor(p.x)},${Math.floor(p.z)}`, [p.x, p.z], null, RoadType.Gravel)
      if (r && r.maxX >= x0 && r.minX <= x1 && r.maxZ >= z0 && r.minZ <= z1 && !list.includes(r)) list.push(r)
    }
    if (this.cellRoads.size > 2000) this.cellRoads.clear()
    this.cellRoads.set(key, list)
    return list
  }

  /** Nearest network road to (x, z) within `maxDist` (m), or null. */
  nearest(x: number, z: number, maxDist = 30, out?: RoadHit): RoadHit | null {
    const roads = this.roadsForCell(Math.floor(x / REGION), Math.floor(z / REGION))
    let bestD = maxDist, bestH = 0, bestT = -1, bestW = 0
    for (const r of roads) {
      if (x < r.minX - maxDist || x > r.maxX + maxDist || z < r.minZ - maxDist || z > r.maxZ + maxDist) continue
      for (let i = 0; i < SAMPLES - 1; i++) {
        const ax = r.xs[i], az = r.zs[i], bx = r.xs[i + 1], bz = r.zs[i + 1]
        const vx = bx - ax, vz = bz - az
        const l2 = vx * vx + vz * vz
        let t = ((x - ax) * vx + (z - az) * vz) / l2
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const px = ax + vx * t - x, pz = az + vz * t - z
        const d = Math.sqrt(px * px + pz * pz)
        if (d < bestD) {
          bestD = d
          bestH = r.hs[i] + (r.hs[i + 1] - r.hs[i]) * t
          bestT = r.type
          bestW = r.halfWidth
        }
      }
    }
    if (bestT < 0) return null
    const o = out ?? { dist: 0, height: 0, type: 0, halfWidth: 0 }
    o.dist = bestD
    o.height = bestH
    o.type = bestT
    o.halfWidth = bestW
    return o
  }
}
