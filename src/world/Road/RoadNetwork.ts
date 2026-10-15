import { hashFloat } from '../noise/rng'
import type { PoiField } from '../POI/pois'

/**
 * Secondary road network (deterministic, global, evaluated per point like every other field):
 *  - Region grid of REGION m. Each region has ONE node: the highest of 4 hashed candidates (not in water)
 *    → roads lead up to hilltops / viewpoints.
 *  - CONNECTED by construction (a spanning tree rooted at the main road, like a drainage network): every node's
 *    road leads to a neighbour nearer the main road or onto the main road itself (`parentLink`); a node that can't
 *    get there has no road at all. Extra E / N loop roads join two connected nodes (`loopLink`). So no road ever
 *    starts or ends in the middle of nowhere — only at the main road, a hilltop node or a place.
 *  - Each link = quadratic Bézier with a hashed bend, sampled into a polyline; heights along it follow the
 *    ground (valley floor + flattened places) with the grade limited to MAX_GRADE, never below the water.
 *  - Types: GRAVEL (wider, links to the main road) and TRAIL (narrow dirt track between hills).
 * Queries: `nearest(x, z)` → distance to the nearest road centreline, its height and type. Roads touching a
 * region are cached per region (built lazily; cache bounded).
 */
export const RoadType = { Gravel: 0, Trail: 1 } as const
const NB4 = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const
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
  /** Ground under each sample BEFORE grading (cut / fill = hs − gs) — Road/RoadDetail gates its ditches by it. */
  gs: Float32Array
  /** Arclength (m) from the first sample to each sample. */
  cum: Float32Array
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

/** `nearestRoad` result: the road itself, the distance to its centreline, the arclength of the nearest point and
 *  the SIGNED lateral offset (+ = left of the direction of travel, first sample → last). */
export interface RoadRef {
  road: NetRoad | null
  dist: number
  s: number
  side: number
  height: number
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
  private readonly parents = new Map<string, NetRoad | null>()
  private readonly loops = new Map<string, NetRoad | null>()
  private readonly drives = new Map<string, NetRoad | null>()

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

  /** Distance (m) of node (i, j) from the main road's centreline (Infinity: no node) and its side (±1). */
  private dist(i: number, j: number): number {
    const a = this.node(i, j)
    return a ? Math.abs(a[0] - this.host.roadCenterX(a[1])) : Infinity
  }
  private side(i: number, j: number): number {
    const a = this.node(i, j)
    return a && a[0] < this.host.roadCenterX(a[1]) ? -1 : 1
  }
  /** Strict priority between nodes: nearer the main road first, then (j, i) — total, so every check terminates. */
  private before(p: number, q: number, i: number, j: number): boolean {
    const dp = this.dist(p, q), d = this.dist(i, j)
    return dp < d || (dp === d && (q < j || (q === j && p < i)))
  }

  /**
   * TREE LINK of node (i, j) — the road from this hilltop toward the main road (a drainage-network / spanning-tree
   * construction, the standard way to grow a CONNECTED road net procedurally). A node's parent is the main road
   * itself (when it is within 0.9 region) or one of its 4 neighbours on the same side of the main road that is
   * strictly nearer to it (≥ 40 m) and itself connected. Candidates: main first, then the shortest; the first whose
   * graded road is buildable (length, no cliff, clear of the main corridor) and crosses no higher-priority tree
   * link wins. Distances strictly decrease along parents → no cycles, every kept node reaches the main road, and the
   * recursion terminates. A node with no valid parent gets NO road at all (before: links were kept or dropped one by
   * one on their own hash, leaving trail chains that started and ended in the middle of nowhere).
   */
  private parentLink(i: number, j: number): NetRoad | null {
    const key = `${i},${j}`
    const hit = this.parents.get(key)
    if (hit !== undefined) return hit
    const a = this.node(i, j)
    let best: NetRoad | null = null
    if (a) {
      const s = this.host.seed
      const d = this.dist(i, j), side = this.side(i, j)
      const cands: NetRoad[] = []
      if (d < REGION * 0.9) {
        const r = this.shape(`${i},${j}>m`, a, null, RoadType.Gravel)
        if (r) cands.push(r)
      }
      const nbs: NetRoad[] = []
      for (const [di, dj] of NB4) {
        const b = this.node(i + di, j + dj)
        if (!b || this.side(i + di, j + dj) !== side || this.dist(i + di, j + dj) > d - 40) continue
        if (!this.parentLink(i + di, j + dj)) continue // that neighbour is cut off itself
        const type = hashFloat(s, i, j, 962 + di * 3 + dj) < 0.4 ? RoadType.Gravel : RoadType.Trail
        const r = this.shape(`${i},${j}>p${di},${dj}`, a, b, type)
        if (r) nbs.push(r)
      }
      nbs.sort((x, y) => x.cum[x.n - 1] - y.cum[y.n - 1])
      cands.push(...nbs)
      for (const r of cands) {
        let ok = true
        for (let q = j - 2; q <= j + 2 && ok; q++) {
          for (let p = i - 2; p <= i + 2 && ok; p++) {
            if ((p === i && q === j) || !this.before(p, q, i, j)) continue
            const o = this.parentLink(p, q)
            if (o && RoadNetwork.crosses(r, o)) ok = false
          }
        }
        if (ok) { best = r; break }
      }
    }
    if (this.parents.size > 6000) this.parents.clear()
    this.parents.set(key, best)
    return best
  }

  /**
   * LOOP LINKS: extra E / N roads between two CONNECTED neighbouring nodes on the same side (≈ 35 %), so the net has
   * circuits instead of being only a tree — never a dead end, because both ends already reach the main road. Skipped
   * where it would duplicate a tree link or cross any tree link; N loops also yield to E loops (E loops depend on
   * tree links only → no cyclic dependency).
   */
  private loopLink(i: number, j: number, dir: 'e' | 'n'): NetRoad | null {
    const key = `${i},${j}>${dir}`
    const hit = this.loops.get(key)
    if (hit !== undefined) return hit
    let r: NetRoad | null = null
    const s = this.host.seed
    const bi = dir === 'e' ? i + 1 : i, bj = dir === 'e' ? j : j + 1
    const a = this.node(i, j), b = this.node(bi, bj)
    const pa = a && b ? this.parentLink(i, j) : null, pb = a && b ? this.parentLink(bi, bj) : null
    if (a && b && pa && pb && this.side(i, j) === this.side(bi, bj) && hashFloat(s, i, j, dir === 'e' ? 960 : 961) < 0.35 &&
      pa.key !== `${i},${j}>p${bi - i},${bj - j}` && pb.key !== `${bi},${bj}>p${i - bi},${j - bj}`) {
      r = this.shape(key, a, b, hashFloat(s, i, j, dir === 'e' ? 962 : 963) < 0.4 ? RoadType.Gravel : RoadType.Trail)
      for (let q = j - 2; q <= j + 2 && r; q++) {
        for (let p = i - 2; p <= i + 2 && r; p++) {
          const o = this.parentLink(p, q)
          if (o && RoadNetwork.crosses(r, o)) r = null
          if (r && dir === 'n') {
            const e = this.loopLink(p, q, 'e')
            if (e && RoadNetwork.crosses(r, e)) r = null
          }
        }
      }
    }
    if (this.loops.size > 6000) this.loops.clear()
    this.loops.set(key, r)
    return r
  }

  /** Tree + loop links of the nodes in [i0, i1] × [j0, j1]. */
  private netLinks(i0: number, j0: number, i1: number, j1: number, out: NetRoad[]): NetRoad[] {
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (const r of [this.parentLink(i, j), this.loopLink(i, j, 'e'), this.loopLink(i, j, 'n')]) if (r && !out.includes(r)) out.push(r)
      }
    }
    return out
  }

  /**
   * Driveway from a place to the main road: the shared geometry + grading (`shape`), rejected if it would cut across
   * any network road, or the driveway of a place EARLIER in (z, x) order (strict order → the recursion terminates and
   * every client gets the same result).
   */
  private driveway(p: { x: number; z: number }): NetRoad | null {
    const key = `poi:${Math.floor(p.x)},${Math.floor(p.z)}`
    const hit = this.drives.get(key)
    if (hit !== undefined) return hit
    let r = this.shape(key, [p.x, p.z], null, RoadType.Gravel)
    if (r) {
      const ci = Math.floor(p.x / REGION), cj = Math.floor(p.z / REGION)
      const others = this.netLinks(ci - 2, cj - 2, ci + 2, cj + 2, [])
      for (const q of this.host.pois?.inBox(p.x - 800, p.z - 800, p.x + 800, p.z + 800) ?? []) {
        if (q.z > p.z || (q.z === p.z && q.x >= p.x)) continue
        if (Math.abs(q.x - this.host.roadCenterX(q.z)) > REGION * 1.8) continue
        const o = this.driveway(q)
        if (o) others.push(o)
      }
      for (const o of others) if (RoadNetwork.crosses(r, o)) { r = null; break }
    }
    if (this.drives.size > 4000) this.drives.clear()
    this.drives.set(key, r)
    return r
  }

  /**
   * One road's GEOMETRY between two points (or to the main road when `b` is null): a quadratic Bézier with a hashed
   * bend, graded along the ground. null when too short / long, when a node-to-node road would run through the main
   * road's corridor (nodes on opposite sides connect through it), or when it would climb a cliff. Crossing rules
   * between roads are the callers' (parentLink / loopLink / driveway).
   */
  private shape(key: string, a: [number, number], b: [number, number] | null, type: number): NetRoad | null {
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
    // The main-road corridor (bed + shoulder + a margin): only roads that END on the main road may enter it.
    const CORRIDOR = 2.7 + 9 + 4
    if (b) {
      for (let i = 0; i < SAMPLES; i++) {
        if (Math.abs(xs[i] - this.host.roadCenterX(zs[i])) < CORRIDOR) {
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
    const cum = new Float32Array(SAMPLES)
    for (let i = 1; i < SAMPLES; i++) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1])
    r = { key, type, halfWidth: type === RoadType.Gravel ? 2.3 : 1.35, n: SAMPLES, xs, zs, hs, gs: raw, cum, minX, minZ, maxX, maxZ }
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
    const x0 = ci * REGION - 40, z0 = cj * REGION - 40, x1 = (ci + 1) * REGION + 40, z1 = (cj + 1) * REGION + 40
    // Links run from a node to a 4-neighbour or the main road (bent ≤ 0.3 × length) → nodes within ±2 regions.
    list = this.netLinks(ci - 2, cj - 2, ci + 2, cj + 2, []).filter((r) => r.maxX >= x0 && r.minX <= x1 && r.maxZ >= z0 && r.minZ <= z1)
    // Driveways: every place gets a gravel road to the main road (unless it would cut across another road).
    for (const p of this.host.pois?.inBox(x0 - 400, z0 - 400, x1 + 400, z1 + 400) ?? []) {
      if (Math.abs(p.x - this.host.roadCenterX(p.z)) > REGION * 1.8) continue
      const r = this.driveway(p)
      if (r && r.maxX >= x0 && r.minX <= x1 && r.maxZ >= z0 && r.minZ <= z1 && !list.includes(r)) list.push(r)
    }
    if (this.cellRoads.size > 2000) this.cellRoads.clear()
    this.cellRoads.set(key, list)
    return list
  }

  /**
   * Each road's nearest point within `maxDist` (m): calls `fn` once per road in range with the distance, the graded
   * height there, the segment index and its parameter t.
   */
  private scan(x: number, z: number, maxDist: number, fn: (r: NetRoad, dist: number, height: number, seg: number, t: number) => void): void {
    const roads = this.roadsForCell(Math.floor(x / REGION), Math.floor(z / REGION))
    for (const r of roads) {
      if (x < r.minX - maxDist || x > r.maxX + maxDist || z < r.minZ - maxDist || z > r.maxZ + maxDist) continue
      let bestD = maxDist, bestH = 0, bestI = -1, bestT = 0
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
          bestI = i
          bestT = t
        }
      }
      if (bestI >= 0) fn(r, bestD, bestH, bestI, bestT)
    }
  }

  /** Distance to each road's nearest point within `maxDist` (m): calls `fn` once per road in range. */
  private forEachRoad(x: number, z: number, maxDist: number, fn: (dist: number, height: number, type: number, halfWidth: number) => void): void {
    this.scan(x, z, maxDist, (r, d, h) => fn(d, h, r.type, r.halfWidth))
  }

  /**
   * The nearest road (optionally other than `exclude`) within `maxDist` with its arclength and signed lateral offset
   * at the nearest point — what Road/RoadDetail evaluates its ruts, potholes and ditches in. Same choice as
   * `nearest` (strictly smallest distance, first road on a tie).
   */
  nearestRoad(x: number, z: number, maxDist: number, out: RoadRef, exclude: NetRoad | null = null): RoadRef | null {
    let best: NetRoad | null = null, bestD = maxDist, bestH = 0, bestI = 0, bestT = 0
    this.scan(x, z, maxDist, (r, d, h, i, t) => {
      if (r !== exclude && d < bestD) (best = r), (bestD = d), (bestH = h), (bestI = i), (bestT = t)
    })
    out.road = best
    if (!best) return null
    const r: NetRoad = best
    const vx = r.xs[bestI + 1] - r.xs[bestI], vz = r.zs[bestI + 1] - r.zs[bestI]
    const l = Math.sqrt(vx * vx + vz * vz)
    out.dist = bestD
    out.height = bestH
    out.s = r.cum[bestI] + l * bestT
    // + = left of travel: cross((v), (p − a)) > 0.
    out.side = (vx * (z - r.zs[bestI]) - vz * (x - r.xs[bestI])) >= 0 ? bestD : -bestD
    return out
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
