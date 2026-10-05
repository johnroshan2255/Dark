import { hashFloat } from '../noise/rng'
import type { PoiField } from '../POI/pois'

/**
 * Secondary road network (deterministic, global, evaluated per point like every other field):
 *  - Region grid of REGION m. Each region has ONE node: the highest of 4 hashed candidates (not in water)
 *    → roads lead up to hilltops / viewpoints.
 *  - A node links east / north to its neighbour with probability, and nodes near the main road link to it.
 *  - Each link = quadratic Bézier with a hashed bend, sampled into a polyline; heights along it follow the
 *    ground (valley floor + flattened places) with the grade limited to MAX_GRADE, never below the water.
 *  - Types: GRAVEL (wider, links to the main road) and TRAIL (narrow dirt track between hills).
 * Queries: `nearest(x, z)` → distance to the nearest road centreline, its height and type. Roads touching a
 * region are cached per region (built lazily; cache bounded).
 */
export const RoadType = { Gravel: 0, Trail: 1 } as const
export const REGION = 380
/** Polyline samples: one every ~SAMPLE_STEP m (18–64 per link) so the graded road follows the ground between samples. */
const SAMPLE_STEP = 14
const MIN_SAMPLES = 18
const MAX_SAMPLES = 64
/** Target road grade (rise per metre) where the ground allows; steeper ground makes a steeper trail. */
const MAX_GRADE = 0.22
/** The road stays within this height of the ground it crosses (m): cuts/fills are banks, never walls or ramps. */
const MAX_OFFSET = 3

export interface NetRoad {
  /** Build key: `i,j>e` / `i,j>n` (grid), `i,j>m` (to the main road), `poi:x,z` (driveway). */
  key: string
  type: number
  halfWidth: number
  /** Sample count. */
  n: number
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

  /**
   * Do two roads CROSS (an X, not a junction)? Segment intersections farther than JUNCTION m from every end of
   * both roads count; roads meeting at a shared node or ending on another road are junctions and allowed.
   */
  static crosses(p: NetRoad, q: NetRoad): boolean {
    const JUNCTION = 28
    if (p.maxX < q.minX || p.minX > q.maxX || p.maxZ < q.minZ || p.minZ > q.maxZ) return false
    const ends = [p.xs[0], p.zs[0], p.xs[p.n - 1], p.zs[p.n - 1], q.xs[0], q.zs[0], q.xs[q.n - 1], q.zs[q.n - 1]]
    for (let i = 0; i < p.n - 1; i++) {
      const ax = p.xs[i], az = p.zs[i], bx = p.xs[i + 1], bz = p.zs[i + 1]
      for (let j = 0; j < q.n - 1; j++) {
        const cx = q.xs[j], cz = q.zs[j], dx = q.xs[j + 1], dz = q.zs[j + 1]
        const r1x = bx - ax, r1z = bz - az, r2x = dx - cx, r2z = dz - cz
        const den = r1x * r2z - r1z * r2x
        if (Math.abs(den) < 1e-6) continue
        const t = ((cx - ax) * r2z - (cz - az) * r2x) / den
        const u = ((cx - ax) * r1z - (cz - az) * r1x) / den
        if (t < 0 || t > 1 || u < 0 || u > 1) continue
        const ix = ax + r1x * t, iz = az + r1z * t
        let junction = false
        for (let k = 0; k < 8; k += 2) if (Math.hypot(ix - ends[k], iz - ends[k + 1]) < JUNCTION) junction = true
        if (!junction) return true
      }
    }
    return false
  }

  /** The grid (E / N) links of the nodes around region (ci, cj): deterministic, independent of build order. */
  private gridLinks(ci: number, cj: number): NetRoad[] {
    const s = this.host.seed
    const out: NetRoad[] = []
    for (let j = cj - 2; j <= cj + 2; j++) {
      for (let i = ci - 2; i <= ci + 2; i++) {
        const a = this.node(i, j)
        if (!a) continue
        const e = this.node(i + 1, j)
        if (e && hashFloat(s, i, j, 960) < 0.55) {
          const r = this.link(`${i},${j}>e`, a, e, hashFloat(s, i, j, 962) < 0.4 ? RoadType.Gravel : RoadType.Trail)
          if (r) out.push(r)
        }
        const nn = this.node(i, j + 1)
        if (nn && hashFloat(s, i, j, 961) < 0.55) {
          const r = this.link(`${i},${j}>n`, a, nn, hashFloat(s, i, j, 963) < 0.4 ? RoadType.Gravel : RoadType.Trail)
          if (r) out.push(r)
        }
      }
    }
    return out
  }

  /** The node → main-road links around region (ci, cj) (depend only on grid links → deterministic). */
  private mainLinks(ci: number, cj: number): NetRoad[] {
    const out: NetRoad[] = []
    for (let j = cj - 2; j <= cj + 2; j++) {
      for (let i = ci - 2; i <= ci + 2; i++) {
        const a = this.node(i, j)
        if (!a || Math.abs(a[0] - this.host.roadCenterX(a[1])) >= REGION * 0.9) continue
        const r = this.link(`${i},${j}>m`, a, null, RoadType.Gravel)
        if (r) out.push(r)
      }
    }
    return out
  }

  /**
   * Road between two points (or to the main road when `b` is null). Links are REJECTED when they would cut
   * across another road (an "intercept" — two graded roads crossing mid-way at different heights): grid links
   * never cross the main road's corridor (nodes on opposite sides connect through it), node→main links never
   * cross a grid link, and driveways cross neither. Priority grid < main < driveway keeps it order-independent.
   */
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
    const SAMPLES = Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, Math.round(len / SAMPLE_STEP) + 1))
    const xs = new Float32Array(SAMPLES), zs = new Float32Array(SAMPLES), raw = new Float32Array(SAMPLES), hs = new Float32Array(SAMPLES)
    for (let i = 0; i < SAMPLES; i++) {
      const t = i / (SAMPLES - 1)
      const u = 1 - t
      xs[i] = u * u * a[0] + 2 * u * t * cx + t * t * bx
      zs[i] = u * u * a[1] + 2 * u * t * cz + t * t * bz
      raw[i] = this.host.baseHeight(xs[i], zs[i])
    }
    // Crossing guards (see the doc comment). The main-road corridor: bed + shoulder + a margin.
    const CORRIDOR = 2.7 + 9 + 4
    const kind = key.startsWith('poi:') ? 2 : key.endsWith('>m') ? 1 : 0
    if (kind === 0) {
      for (let i = 0; i < SAMPLES; i++) {
        if (Math.abs(xs[i] - this.host.roadCenterX(zs[i])) < CORRIDOR) {
          this.built.set(key, null)
          return null
        }
      }
    } else {
      const probe: NetRoad = { key, type, halfWidth: 0, n: SAMPLES, xs, zs, hs, minX: Math.min(...xs), minZ: Math.min(...zs), maxX: Math.max(...xs), maxZ: Math.max(...zs) }
      const ci = Math.floor(a[0] / REGION), cj = Math.floor(a[1] / REGION)
      const others = kind === 1 ? this.gridLinks(ci, cj) : [...this.gridLinks(ci, cj), ...this.mainLinks(ci, cj)]
      if (kind === 2 && this.host.pois) {
        // Driveways vs driveways: a place yields to the driveways of places EARLIER in (z, x) order — a strict
        // order, so the recursion through link() terminates and the result is the same on every client.
        for (const q of this.host.pois.inBox(a[0] - 800, a[1] - 800, a[0] + 800, a[1] + 800)) {
          if (q.z > a[1] || (q.z === a[1] && q.x >= a[0])) continue
          if (Math.abs(q.x - this.host.roadCenterX(q.z)) > REGION * 1.8) continue
          const o = this.link(`poi:${Math.floor(q.x)},${Math.floor(q.z)}`, [q.x, q.z], null, RoadType.Gravel)
          if (o) others.push(o)
        }
      }
      for (const o of others) {
        if (RoadNetwork.crosses(probe, o)) {
          this.built.set(key, null)
          return null
        }
      }
    }
    // Grade within a band around the ground: the road never sits more than MAX_OFFSET above or below the
    // terrain it crosses (no ramps floating over a valley, no trenches), and inside that band the grade is
    // smoothed to MAX_GRADE where the ground allows. Both ends are exact (the node; the main road bed).
    const mh = b ? 0 : this.host.mainRoadHeight(bz)
    if (!b) raw[SAMPLES - 1] = mh
    const segLen = Math.max(1, len / (SAMPLES - 1))
    const maxRise = segLen * MAX_GRADE
    hs.set(raw)
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 1; i < SAMPLES; i++) hs[i] = Math.min(hs[i - 1] + maxRise, Math.max(hs[i - 1] - maxRise, hs[i]))
      for (let i = SAMPLES - 2; i >= 0; i--) hs[i] = Math.min(hs[i + 1] + maxRise, Math.max(hs[i + 1] - maxRise, hs[i]))
      for (let i = 0; i < SAMPLES; i++) hs[i] = Math.min(raw[i] + MAX_OFFSET, Math.max(raw[i] - MAX_OFFSET, hs[i]))
    }
    for (let i = 1; i < SAMPLES - 1; i++) hs[i] = Math.min(raw[i] + MAX_OFFSET, Math.max(raw[i] - MAX_OFFSET, (hs[i - 1] + 2 * hs[i] + hs[i + 1]) * 0.25))
    hs[0] = raw[0]
    hs[SAMPLES - 1] = raw[SAMPLES - 1]
    for (let i = 0; i < SAMPLES; i++) hs[i] = Math.max(this.host.water + 1.2, hs[i]) // fords: a causeway just above the water
    // Inside a place's flattened disc the road lies exactly on the place's base (no bump through a farmyard).
    if (this.host.pois) {
      for (let i = 0; i < SAMPLES; i++) {
        const p = this.host.pois.near(xs[i], zs[i])
        if (p && Math.hypot(xs[i] - p.x, zs[i] - p.z) < p.radius * 0.6) hs[i] = p.baseH
      }
    }
    // A road can't climb a cliff: links whose graded profile still exceeds ~90 % (42°) anywhere (plateau edges, karst
    // walls) are not built — the network routes around the uplands instead of painting a track up a rock face.
    for (let i = 1; i < SAMPLES; i++) {
      if (Math.abs(hs[i] - hs[i - 1]) > segLen * 0.9) {
        this.built.set(key, null)
        return null
      }
    }
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    for (let i = 0; i < SAMPLES; i++) {
      minX = Math.min(minX, xs[i]); maxX = Math.max(maxX, xs[i]); minZ = Math.min(minZ, zs[i]); maxZ = Math.max(maxZ, zs[i])
    }
    r = { key, type, halfWidth: type === RoadType.Gravel ? 2.3 : 1.35, n: SAMPLES, xs, zs, hs, minX, minZ, maxX, maxZ }
    if (this.built.size > 4000) this.built.clear()
    this.built.set(key, r)
    return r
  }

  /** Roads touching region (ci, cj) — tests / debug. */
  roadsIn(ci: number, cj: number): NetRoad[] {
    return this.roadsForCell(ci, cj)
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

  /** Distance to each road's nearest point within `maxDist` (m): calls `fn` once per road in range. */
  private forEachRoad(x: number, z: number, maxDist: number, fn: (dist: number, height: number, type: number, halfWidth: number) => void): void {
    const roads = this.roadsForCell(Math.floor(x / REGION), Math.floor(z / REGION))
    for (const r of roads) {
      if (x < r.minX - maxDist || x > r.maxX + maxDist || z < r.minZ - maxDist || z > r.maxZ + maxDist) continue
      let bestD = maxDist, bestH = 0
      for (let i = 0; i < r.n - 1; i++) {
        const ax = r.xs[i], az = r.zs[i], bx = r.xs[i + 1], bz = r.zs[i + 1]
        // Segment AABB early-out (most segments of a long road are far from the point).
        if (x < Math.min(ax, bx) - bestD || x > Math.max(ax, bx) + bestD || z < Math.min(az, bz) - bestD || z > Math.max(az, bz) + bestD) continue
        const vx = bx - ax, vz = bz - az
        const l2 = vx * vx + vz * vz
        let t = ((x - ax) * vx + (z - az) * vz) / l2
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const px = ax + vx * t - x, pz = az + vz * t - z
        const d = Math.sqrt(px * px + pz * pz)
        if (d < bestD) {
          bestD = d
          bestH = r.hs[i] + (r.hs[i + 1] - r.hs[i]) * t
        }
      }
      if (bestD < maxDist) fn(bestD, bestH, r.type, r.halfWidth)
    }
  }

  /** Nearest network road to (x, z) within `maxDist` (m), or null. */
  nearest(x: number, z: number, maxDist = 30, out?: RoadHit): RoadHit | null {
    let bestD = maxDist, bestH = 0, bestT = -1, bestW = 0
    this.forEachRoad(x, z, maxDist, (d, h, type, hw) => {
      if (d < bestD) (bestD = d), (bestH = h), (bestT = type), (bestW = hw)
    })
    if (bestT < 0) return null
    const o = out ?? { dist: 0, height: 0, type: 0, halfWidth: 0 }
    o.dist = bestD
    o.height = bestH
    o.type = bestT
    o.halfWidth = bestW
    return o
  }

  /**
   * Terrain height with every road in range blended in (`weight(dist − halfWidth, roadH − h)` → 0..1): where
   * roads meet or cross, both pull the ground and the result is continuous — picking only the nearest road
   * stepped between two graded heights at the seam.
   */
  blendHeight(x: number, z: number, h: number, maxDist: number, weight: (edgeDist: number, diff: number) => number, scale = 1): number {
    let sumW = 0, sumWH = 0, maxW = 0
    this.forEachRoad(x, z, maxDist, (d, rh, _type, hw) => {
      const w = weight(d - hw, rh - h)
      if (w <= 0) return
      sumW += w
      sumWH += w * rh
      if (w > maxW) maxW = w
    })
    if (sumW <= 0) return h
    // Target = the roads' weighted mean height; strength = the strongest single pull (roads sharing a node
    // must not add up to a triple embankment). Continuous as any road's weight fades in or out.
    return h + (sumWH / sumW - h) * maxW * scale
  }
}
