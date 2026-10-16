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
/**
 * DRIVABLE grade (rise per metre, ≈ 17°): a straight node link steeper than this anywhere is re-routed over the
 * terrain (A*, contour-following, switchbacks) when that gives a flatter road. Before: straight Béziers between
 * hilltops ran up 45–90 % pitches — no car climbs them (a 4×4 in low range stalled at 50 %).
 */
const DRIVE_GRADE = 0.3
/** A re-routed link stays within this of its ends' box (m): nodes lie ≥ 57 m inside their region and a link's far
 *  end is a neighbour node or the main road ≤ 0.9 region off, so the road stays within 2 regions of its node — the
 *  region lists (links of nodes within 2 regions) still see it everywhere. */
const BOX_MARGIN = 420
/** A re-routed link may be at most this × the straight one's length (else the straight one stays). */
const DETOUR_MAX = 4

/**
 * Largest height difference (m) two roads `d` m apart (centre to centre) may have: one's embankment (WorldFields:
 * NET_SHOULDER 4 + NET_EMBANKMENT 1.6 · |Δh| beyond its edge, ≤ 38 m) must not reach the other's edge (half-widths
 * ≤ 2.3 m). Where it did, the terrain blend (a weighted mean of the roads' heights) raised a 2.7 m hump INTO the
 * lower road and walled the ground between them.
 */
const bankMax = (d: number) => (d - 4.6 - 4) / 1.6
/** Centre distance past which two roads' embankments can never touch (m). */
const BANK_REACH = 4.6 + 38

/** Steepest sample-to-sample grade of a graded road. */
function maxGrade(r: NetRoad): number {
  let g = 0
  for (let i = 1; i < r.n; i++) g = Math.max(g, Math.abs(r.hs[i] - r.hs[i - 1]) / Math.max(0.5, r.cum[i] - r.cum[i - 1]))
  return g
}

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
  /** A straight node link's ends (for `drivable`): the node, the other node (null = the main road), length, drop.
   *  On the road itself — not in a bounded cache — so the result never depends on what was evicted (co-op). */
  link?: { a: [number, number]; b: [number, number] | null; len: number; drop: number }
}

/**
 * Graded height of road `r` on segment i at parameter t ∈ [0, 1]. The samples' grade breaks (every ~14 m) are rounded
 * into parabolic VERTICAL CURVES, as road design does: each interior sample's curve spans ± half the shorter adjacent
 * segment, tangent to both grades at its ends (correction Δg·(c − |d|)² / 4c), so the height is C1 along the road.
 * Linear interpolation left a sharp crest / sag at every sample — a −45 % → 0 % break at the foot of a hill (a ford's
 * causeway) dug the bumper in and stopped a truck dead from 40 km/h. Ends (junctions, the main road, bridges) are exact.
 */
export function roadHeightAt(r: NetRoad, i: number, t: number): number {
  const h0 = r.hs[i], h1 = r.hs[i + 1], l = r.cum[i + 1] - r.cum[i]
  let h = h0 + (h1 - h0) * t
  if (!(l > 0)) return h
  const g = (h1 - h0) / l, s = t * l
  if (i > 0) {
    const lp = r.cum[i] - r.cum[i - 1], c = 0.5 * Math.min(l, lp)
    if (c > 0 && s < c) h += (g - (h0 - r.hs[i - 1]) / lp) * (c - s) ** 2 / (4 * c)
  }
  if (i < r.n - 2) {
    const ln = r.cum[i + 2] - r.cum[i + 1], c = 0.5 * Math.min(l, ln), d = l - s
    if (c > 0 && d < c) h += ((r.hs[i + 2] - h1) / ln - g) * (c - d) ** 2 / (4 * c)
  }
  return h
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
  /** Rope bridge of z-cell k (bright; Road/bridges.ts) — its two ends get roads (`bridgeLinks`). */
  bridge?(k: number): { z: number; xa: number; xb: number; ha: number; hb: number } | null
  /** Is (x, z) a destination a road may end at (a place, a landmark)? */
  destination?(x: number, z: number): boolean
  /** Extra destinations needing a road (bright oasis camps), centres in the z range. */
  camps?(minZ: number, maxZ: number): { x: number; z: number }[]
}

/** Roads only exist within this distance (m) of the main road — keeps the graph finite (every query terminates). */
export const NET_BAND = 2400
/** Bridge z-cells (Road/bridges.ts CELL). */
const BRIDGE_CELL = 500
const NB8 = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]] as const

export class RoadNetwork {
  private readonly nodes = new Map<string, [number, number] | null>()
  private readonly cellRoads = new Map<string, NetRoad[]>()
  private readonly built = new Map<string, NetRoad | null>()
  private readonly parents = new Map<string, NetRoad | null>()
  private readonly loops = new Map<string, NetRoad | null>()
  private readonly drives = new Map<string, NetRoad | null>()
  private readonly tents = new Map<string, NetRoad | null>()
  private readonly lives = new Map<string, boolean>()
  private readonly bridgeRoads = new Map<number, NetRoad[] | null>()

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
    n = best && Math.abs(best[0] - this.host.roadCenterX(best[1])) <= NET_BAND ? best : null
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
      const clear = (r: NetRoad) => {
        for (let q = j - 2; q <= j + 2; q++) {
          for (let p = i - 2; p <= i + 2; p++) {
            if ((p === i && q === j) || !this.before(p, q, i, j)) continue
            const o = this.parentLink(p, q)
            if (o && RoadNetwork.crosses(r, o)) return false
          }
        }
        return true
      }
      // The first candidate that is DRIVABLE (straight, or re-routed: `drivable`) wins; the first clear one only if
      // none is (a steep straight link whose route doesn't fit the terrain may have a neighbour that routes fine).
      let walls: NetRoad[] | null = null
      for (const r of cands) {
        if (!clear(r)) continue
        if (!best) best = r
        if (maxGrade(r) <= DRIVE_GRADE) { best = r; break }
        if (!walls) {
          walls = []
          for (let q = j - 2; q <= j + 2; q++) for (let p = i - 2; p <= i + 2; p++) {
            if ((p === i && q === j) || !this.before(p, q, i, j)) continue
            const o = this.parentLink(p, q)
            if (o) walls.push(o)
          }
        }
        const d = this.drivable(r, walls)
        if (d !== r && clear(d)) { best = d; break }
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
      const clear = (r: NetRoad) => {
        for (let q = j - 2; q <= j + 2; q++) {
          for (let p = i - 2; p <= i + 2; p++) {
            const o = this.parentLink(p, q)
            if (o && RoadNetwork.crosses(r, o)) return false
            if (dir === 'n') {
              const e = this.loopLink(p, q, 'e')
              if (e && RoadNetwork.crosses(r, e)) return false
            }
          }
        }
        return true
      }
      r = this.shape(key, a, b, hashFloat(s, i, j, dir === 'e' ? 962 : 963) < 0.4 ? RoadType.Gravel : RoadType.Trail)
      if (r && !clear(r)) r = null
      if (r && maxGrade(r) > DRIVE_GRADE) {
        const walls: NetRoad[] = []
        for (let q = j - 2; q <= j + 2; q++) for (let p = i - 2; p <= i + 2; p++) {
          const o = this.parentLink(p, q)
          if (o) walls.push(o)
          const e = dir === 'n' ? this.loopLink(p, q, 'e') : null
          if (e) walls.push(e)
        }
        const d = this.drivable(r, walls)
        if (d !== r && clear(d)) r = d
      }
    }
    if (this.loops.size > 6000) this.loops.clear()
    this.loops.set(key, r)
    return r
  }

  /** Is node m = (mi, mj)'s tree link pointing at (i, j)? (= m is a structural child of (i, j)). */
  private childOf(mi: number, mj: number, i: number, j: number): boolean {
    const r = this.parentLink(mi, mj)
    return !!r && r.key === `${mi},${mj}>p${i - mi},${j - mj}`
  }

  /** Loops touching node (i, j). */
  private loopsAt(i: number, j: number): boolean {
    return !!(this.loopLink(i, j, 'e') || this.loopLink(i, j, 'n') || this.loopLink(i - 1, j, 'e') || this.loopLink(i, j - 1, 'n'))
  }

  /** A STRUCTURAL LEAF: on the tree, no tree children, no loops, not at a destination → its road would dead-end. */
  private leaf(i: number, j: number): boolean {
    const a = this.node(i, j)
    if (!a || !this.parentLink(i, j) || this.loopsAt(i, j)) return false
    if (this.host.destination?.(a[0], a[1])) return false
    for (const [di, dj] of NB8.slice(0, 4)) if (this.childOf(i + di, j + dj, i, j)) return false
    return true
  }

  /**
   * TENTATIVE CLOSURE of a leaf (no dead ends): a second road from the leaf to another tree node among its 8
   * neighbours (not its parent) or onto the main road, shortest buildable first, crossing no tree link or loop.
   * Computed independently of other closures (no recursion); `closure` then resolves conflicts pairwise.
   */
  private tentClosure(i: number, j: number): NetRoad | null {
    const key = `${i},${j}`
    const hit = this.tents.get(key)
    if (hit !== undefined) return hit
    let best: NetRoad | null = null
    if (this.leaf(i, j)) {
      const a = this.node(i, j)!
      const par = this.parentLink(i, j)!.key
      const s = this.host.seed
      const cands: NetRoad[] = []
      for (const [di, dj] of NB8) {
        if (par === `${i},${j}>p${di},${dj}`) continue
        const b = this.node(i + di, j + dj)
        if (!b || !this.parentLink(i + di, j + dj) || this.side(i + di, j + dj) !== this.side(i, j)) continue
        const r = this.shape(`${i},${j}>c${di},${dj}`, a, b, hashFloat(s, i, j, 970 + di * 3 + dj) < 0.4 ? RoadType.Gravel : RoadType.Trail)
        if (r) cands.push(r)
      }
      if (par !== `${i},${j}>m` && this.dist(i, j) < REGION * 1.6) {
        const r = this.shape(`${i},${j}>cm`, a, null, RoadType.Gravel)
        if (r) cands.push(r)
      }
      cands.sort((x, y) => x.cum[x.n - 1] - y.cum[y.n - 1])
      const clear = (r: NetRoad) => {
        for (let q = j - 2; q <= j + 2; q++) {
          for (let p = i - 2; p <= i + 2; p++) {
            const o = this.parentLink(p, q)
            if (o && RoadNetwork.crosses(r, o)) return false
            for (const d of ['e', 'n'] as const) { const l = this.loopLink(p, q, d); if (l && RoadNetwork.crosses(r, l)) return false }
          }
        }
        return true
      }
      let walls: NetRoad[] | null = null
      for (const r of cands) {
        if (!clear(r)) continue
        if (!best) best = r
        if (maxGrade(r) <= DRIVE_GRADE) { best = r; break }
        if (!walls) {
          walls = []
          for (let q = j - 2; q <= j + 2; q++) for (let p = i - 2; p <= i + 2; p++) {
            const o = this.parentLink(p, q)
            if (o) walls.push(o)
            for (const d of ['e', 'n'] as const) { const l = this.loopLink(p, q, d); if (l) walls.push(l) }
          }
        }
        const d = this.drivable(r, walls)
        if (d !== r && clear(d)) { best = d; break }
      }
    }
    if (this.tents.size > 6000) this.tents.clear()
    this.tents.set(key, best)
    return best
  }

  /** The closure's target node offset (or null for the main road / none). */
  private static target(r: NetRoad): [number, number] | null {
    const m = /c(-?\d+),(-?\d+)$/.exec(r.key)
    return m ? [Number(m[1]), Number(m[2])] : null
  }

  /** FINAL closure: the tentative one, unless an EARLIER leaf's (strict j, i order) tentative closure crosses it or
   *  already joins the same pair (pairwise rule — finite, deterministic). */
  private closure(i: number, j: number): NetRoad | null {
    const r = this.tentClosure(i, j)
    if (!r) return null
    const t = RoadNetwork.target(r)
    for (let q = j - 2; q <= j; q++) {
      for (let p = i - 2; p <= i + 2; p++) {
        if (q === j && p >= i) continue
        const o = this.tentClosure(p, q)
        if (!o) continue
        if (RoadNetwork.crosses(r, o)) return null
        const to = RoadNetwork.target(o)
        if (t && to && p + to[0] === i && q + to[1] === j && i + t[0] === p && j + t[1] === q) return null // the same pair
      }
    }
    return r
  }

  /** Does a final closure of a neighbour end at (i, j)? */
  private closedInto(i: number, j: number): boolean {
    for (const [di, dj] of NB8) {
      const r = this.closure(i + di, j + dj)
      const t = r && RoadNetwork.target(r)
      if (t && di + t[0] === 0 && dj + t[1] === 0) return true
    }
    return false
  }

  /**
   * LIVE node (its tree road is built): on the tree, and its road LEADS somewhere — a live child, a loop, its own
   * closure, a closure ending at it, or a destination. Children are strictly farther from the main road and the
   * network is bounded (NET_BAND) → the recursion is finite. Every live node therefore has degree ≥ 2 or is a
   * destination: NO dead ends. Dead branches are pruned back to the nearest junction.
   */
  private live(i: number, j: number): boolean {
    const key = `${i},${j}`
    const hit = this.lives.get(key)
    if (hit !== undefined) return hit
    let v = false
    const a = this.node(i, j)
    if (a && this.parentLink(i, j)) {
      v = this.loopsAt(i, j) || !!this.closure(i, j) || this.closedInto(i, j) || !!this.host.destination?.(a[0], a[1])
      for (const [di, dj] of NB8.slice(0, 4)) if (!v && this.childOf(i + di, j + dj, i, j) && this.live(i + di, j + dj)) v = true
    }
    if (this.lives.size > 6000) this.lives.clear()
    this.lives.set(key, v)
    return v
  }

  /** Live tree links, loops and closures of the nodes in [i0, i1] × [j0, j1]. */
  private netLinks(i0: number, j0: number, i1: number, j1: number, out: NetRoad[]): NetRoad[] {
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const list = [this.loopLink(i, j, 'e'), this.loopLink(i, j, 'n'), this.closure(i, j)]
        if (this.live(i, j)) list.push(this.parentLink(i, j))
        for (const r of list) if (r && !out.includes(r)) out.push(r)
      }
    }
    return out
  }

  /**
   * A* ROUTE (Dijkstra on an 8-connected 12 m grid within `R` m of `a`): the cheapest path over the terrain from `a`
   * to the FIRST road it reaches — the main road or any of `goals` (live network roads, earlier driveways). Step cost
   * = length × (1 + 14·grade² + water, +40 over 31°); grades over 0.93 (43°) are impassable, the main road's corridor only as the
   * goal. Because it stops at the first road, it can never cut across one: it ENDS on it (a junction, at that road's
   * graded height). The cell path is simplified (Ramer–Douglas–Peucker 4 m), rounded (Chaikin ×2), resampled every
   * ~10 m and graded like every road (`finishRoad`). Deterministic (fixed grid, stable tie order). ~2–8 ms, cached.
   */
  private route(key: string, a: [number, number], ah: number | undefined, goals: NetRoad[], type: number, R = 900, sideOf = 0): NetRoad | null {
    const hit = this.built.get(key)
    if (hit !== undefined) return hit
    // Stricter and stricter slope limits until the graded road passes (a path along 40° ground can't be graded).
    // A pass that reaches NO road at all (it flooded the whole grid) ends it: a stricter one reaches less.
    let r: NetRoad | null = null
    for (const maxG of [0.93, 0.5, 0.32]) {
      this.built.delete(key)
      r = this.search(key, a, ah, goals, type, R, sideOf, maxG)
      if (r || !this.reached) break
    }
    this.built.set(key, r)
    return r
  }

  /**
   * A drivable ROUTE between two nodes (or a node and the main road when `b` is null) for a link whose straight
   * shape is too steep: the same A* with `b` as its only goal (the main road's corridor is a wall), strictest slope
   * limit first. Keeps the link's key (the tree / loop / closure rules match on it). null: no route.
   */
  private routeTo(key: string, a: [number, number], b: [number, number] | null, type: number, len: number, walls: NetRoad[] = []): NetRoad | null {
    const R = Math.min(1400, len + 240)
    // (cost ≥ length: a route longer than the detour cap is never kept anyway)
    const cap = DETOUR_MAX * Math.max(len, 60) * 4
    for (const maxG of [0.32, 0.45, 0.6]) {
      const r = this.search(key, a, undefined, [], type, R, 0, maxG, b ?? undefined, walls, cap, true)
      if (r) return r
    }
    return null
  }

  /** Did the last `search` reach a goal (its road may still have failed grading)? */
  private reached = false

  /**
   * `to` (a node) / `link`: a node link's route (`routeTo`) — A* to the point, the main road's corridor a wall, a
   * penalty for running along the main road, `walls` never crossed, cost-capped at `maxCost`; the slope limit is
   * judged per 12 m step and over two steps (no sawtooth), the path rounded only where that keeps it drivable.
   * Otherwise the original connector search (driveways, camps, bridge ends) — unchanged.
   */
  private search(key: string, a: [number, number], ah: number | undefined, goals: NetRoad[], type: number, R: number, sideOf: number, maxG: number, to?: [number, number], walls: NetRoad[] = [], maxCost = Infinity, link = false): NetRoad | null {
    const C = R > 1500 ? 24 : 12, N = Math.ceil(R / C) * 2 + 1, half = (N - 1) / 2
    const ox = a[0] - half * C, oz = a[1] - half * C
    // Heights on a HALF-cell grid (cell centres at even indices, step midpoints at odd ones), each sampled once.
    const M = N * 2 - 1
    const HH = new Float32Array(M * M).fill(NaN)
    const hHalf = (hx: number, hz: number) => {
      const k = hz * M + hx
      let h = HH[k]
      if (h !== h) { h = this.host.baseHeight(ox + hx * C * 0.5, oz + hz * C * 0.5); HH[k] = h }
      return h
    }
    const hAt = (i: number) => hHalf((i % N) * 2, Math.floor(i / N) * 2)
    // Goal cells: on / beside a goal road (rasterised every 4 m) or on the main road.
    const goal = new Map<number, [NetRoad, number]>() // cell → goal road and the sample index
    for (const r of goals) {
      for (let i = 0; i < r.n - 1; i++) {
        const l = Math.hypot(r.xs[i + 1] - r.xs[i], r.zs[i + 1] - r.zs[i]), n = Math.max(1, Math.ceil(l / 4))
        for (let k = 0; k <= n; k++) {
          const x = r.xs[i] + (r.xs[i + 1] - r.xs[i]) * (k / n), z = r.zs[i] + (r.zs[i + 1] - r.zs[i]) * (k / n)
          const gi = Math.round((x - ox) / C), gj = Math.round((z - oz) / C)
          if (gi >= 0 && gj >= 0 && gi < N && gj < N && !goal.has(gj * N + gi)) goal.set(gj * N + gi, [r, i + k / n])
        }
      }
    }
    // WALLS: roads this one must not cross (rasterised every 4 m) — except within 30 m of its own ends (junctions).
    const wall = new Uint8Array(walls.length ? N * N : 0)
    for (const r of walls) {
      for (let i = 0; i < r.n - 1; i++) {
        const l = Math.hypot(r.xs[i + 1] - r.xs[i], r.zs[i + 1] - r.zs[i]), n = Math.max(1, Math.ceil(l / 4))
        for (let k = 0; k <= n; k++) {
          const x = r.xs[i] + (r.xs[i + 1] - r.xs[i]) * (k / n), z = r.zs[i] + (r.zs[i + 1] - r.zs[i]) * (k / n)
          if (Math.hypot(x - a[0], z - a[1]) < 30 || (to && Math.hypot(x - to[0], z - to[1]) < 30)) continue
          const gi = Math.round((x - ox) / C), gj = Math.round((z - oz) / C)
          if (gi >= 0 && gj >= 0 && gi < N && gj < N) wall[gj * N + gi] = 1
        }
      }
    }
    const main = (i: number) => {
      const x = ox + (i % N) * C, z = oz + Math.floor(i / N) * C
      return Math.abs(x - this.host.roadCenterX(z)) < C * 0.75
    }
    const inCorr = (i: number) => {
      const x = ox + (i % N) * C, z = oz + Math.floor(i / N) * C
      return Math.abs(x - this.host.roadCenterX(z)) < 2.7 + 9
    }
    const start = half * N + half
    const toCell = to ? Math.round((to[1] - oz) / C) * N + Math.round((to[0] - ox) / C) : -1
    if (to && (Math.abs(Math.round((to[0] - ox) / C) - half) > half || Math.abs(Math.round((to[1] - oz) / C) - half) > half)) return null
    const dist = new Float32Array(N * N).fill(Infinity), prev = new Int32Array(N * N).fill(-1)
    // binary heap of (cost, cell)
    const hc: number[] = [], hi: number[] = []
    const push = (c: number, i: number) => {
      let k = hc.length; hc.push(c); hi.push(i)
      while (k > 0) { const p = (k - 1) >> 1; if (hc[p] < hc[k] || (hc[p] === hc[k] && hi[p] < hi[k])) break; [hc[p], hc[k]] = [hc[k], hc[p]]; [hi[p], hi[k]] = [hi[k], hi[p]]; k = p }
    }
    const pop = (): number => {
      const top = hi[0], lc = hc.pop()!, li = hi.pop()!
      if (hc.length) {
        hc[0] = lc; hi[0] = li
        let k = 0
        for (;;) {
          const l = k * 2 + 1, r = l + 1
          let m = k
          if (l < hc.length && (hc[l] < hc[m] || (hc[l] === hc[m] && hi[l] < hi[m]))) m = l
          if (r < hc.length && (hc[r] < hc[m] || (hc[r] === hc[m] && hi[r] < hi[m]))) m = r
          if (m === k) break
          ;[hc[m], hc[k]] = [hc[k], hc[m]]; [hi[m], hi[k]] = [hi[k], hi[m]]; k = m
        }
      }
      return top
    }
    // A* toward a point target (straight-line distance: admissible, every step costs ≥ its length); a search for
    // the first road of many stays a plain Dijkstra (h = 0).
    const tx = to ? Math.round((to[0] - ox) / C) : 0, tz = to ? Math.round((to[1] - oz) / C) : 0
    const heur = to ? (i: number) => C * Math.hypot((i % N) - tx, ((i / N) | 0) - tz) : () => 0
    dist[start] = 0
    push(heur(start), start)
    let end = -1
    this.reached = false
    const water = this.host.water
    while (hc.length) {
      const fi = hc[0]
      const i = pop()
      const d0 = dist[i]
      if (fi > d0 + heur(i) + 1e-3) continue // a stale heap entry
      if (d0 > maxCost) break // (a strict pass that would need a far longer road than the lax one: give up)
      // A goal only where the ground is at the road's level (a road at the foot of a cliff is not reached from its top).
      if (to) {
        if (i === toCell) { end = i; break }
      } else if (i !== start) {
        const gg = goal.get(i)
        if (gg) {
          const k = Math.min(gg[0].n - 2, Math.floor(gg[1])), t = gg[1] - k
          if (Math.abs(hAt(i) - roadHeightAt(gg[0], k, t)) < 3) { end = i; break }
        } else if (!sideOf && main(i)) {
          const z = oz + Math.floor(i / N) * C
          if (Math.abs(hAt(i) - this.host.mainRoadHeight(z)) < 3) { end = i; break }
        }
      }
      const ix = i % N, iz = (i / N) | 0
      const h0 = hAt(i)
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue
        const jx = ix + dx, jz = iz + dz
        if (jx < 0 || jz < 0 || jx >= N || jz >= N) continue
        const j = jz * N + jx
        // (a diagonal step may not slip between two wall cells either)
        if (wall.length && (wall[j] || (dx && dz && wall[iz * N + jx] && wall[jz * N + ix]))) continue
        const len = C * (dx && dz ? 1.41421356 : 1)
        const h1 = hAt(j)
        // Grade over the step (what the graded road climbs: small bumps inside a cell are graded over) against the
        // pass's limit; the ground halfway against the cliff limit (a cliff edge inside a cell is not crossed unseen).
        const hm = hHalf(ix + jx, iz + jz)
        const gh = Math.max(Math.abs(hm - h0), Math.abs(h1 - hm)) / (len * 0.5)
        const g = link ? Math.abs(h1 - h0) / len : gh
        if (g > maxG || gh > 0.93) continue // (> 43°: a cliff; 31–43°: a steep ramp, heavily penalised)
        // …and over TWO steps (from the previous cell): a 12 m sawtooth (down-diagonal, back, down-diagonal) keeps
        // every step under the limit while running straight down the slope — smoothing then makes it a straight
        // plunge. Real contour legs and hairpins pass.
        const pi = prev[i]
        if (link && pi >= 0 && maxG < 0.9) {
          const d2 = C * Math.hypot((pi % N) - jx, ((pi / N) | 0) - jz)
          if (d2 > 0 && Math.abs(h1 - hAt(pi)) / d2 > maxG + 0.04) continue
        }
        // A link turns ≤ 90° per step AND over two steps: a hairpin spans ≥ 4–5 cells (≥ ~15 m radius, a mountain
        // road's) — one turning round a cell or two (5–6 m) ran the truck (11.8 m turning circle) off a causeway.
        if (link && pi >= 0) {
          const ax = ix - (pi % N), az = iz - ((pi / N) | 0)
          if (ax * dx + az * dz < 0) continue
          const ppi = prev[pi]
          if (ppi >= 0 && ((pi % N) - (ppi % N)) * dx + (((pi / N) | 0) - ((ppi / N) | 0)) * dz < 0) continue
        }
        if (inCorr(j) && (to || !(!sideOf && main(j)))) continue // only into the main road's corridor to END on it
        // Another road's cell where it can't be joined (it runs on a fill / in a cut here): a WALL — never cross it.
        const gj = goal.get(j)
        if (gj) {
          const k = Math.min(gj[0].n - 2, Math.floor(gj[1])), t = gj[1] - k
          if (Math.abs(h1 - roadHeightAt(gj[0], k, t)) >= 3) continue
        }
        if (sideOf && Math.sign(ox + jx * C - this.host.roadCenterX(oz + jz * C)) !== sideOf) continue
        const wet = h1 < water + 0.6 ? 6 : 0
        // Beside the main road (≤ 30 m, not ending on it): heavily penalised — a route may come down onto it, not run
        // along it on the hillside above (that left a 12 m wall at the main road's shoulder).
        const along = link && !main(j) && Math.abs(ox + jx * C - this.host.roadCenterX(oz + jz * C)) < 30 ? 12 : 0
        const c = d0 + len * (1 + 14 * g * g + (g > 0.6 ? 40 : 0) + wet + along)
        if (c < dist[j]) { dist[j] = c; prev[j] = i; push(c + heur(j), j) }
      }
    }
    let road: NetRoad | null = null
    this.reached = end >= 0
    if (end >= 0) {
      // cells → points (start exact), end snapped onto the goal road / main road centreline
      const cells: number[] = []
      for (let i = end; i >= 0; i = prev[i]) cells.push(i)
      cells.reverse()
      let pts: [number, number][] = cells.map((i) => [ox + (i % N) * C, oz + Math.floor(i / N) * C])
      pts[0] = [a[0], a[1]]
      const g = to ? undefined : goal.get(end)
      let endH: number
      if (to) {
        pts[pts.length - 1] = [to[0], to[1]]
        endH = this.host.baseHeight(to[0], to[1]) // = the node's own height (its roads start there)
      } else if (g) {
        const [r, f] = g, k = Math.min(r.n - 2, Math.floor(f)), t = f - k
        const px = r.xs[k] + (r.xs[k + 1] - r.xs[k]) * t, pz = r.zs[k] + (r.zs[k + 1] - r.zs[k]) * t
        pts[pts.length - 1] = [px, pz]
        endH = roadHeightAt(r, k, t)
      } else {
        const z = pts[pts.length - 1][1]
        pts[pts.length - 1] = [this.host.roadCenterX(z), z]
        endH = this.host.mainRoadHeight(z)
      }
      // RDP simplify (4 m), then Chaikin ×2 (keeping the end points), resample ~10 m.
      const rdp = (p: [number, number][], eps: number): [number, number][] => {
        if (p.length < 3) return p
        const [ax, az] = p[0], [bx, bz] = p[p.length - 1]
        const L = Math.hypot(bx - ax, bz - az) || 1
        let md = 0, mi = 0
        for (let i = 1; i < p.length - 1; i++) { const d = Math.abs((bx - ax) * (az - p[i][1]) - (ax - p[i][0]) * (bz - az)) / L; if (d > md) (md = d), (mi = i) }
        return md > eps ? [...rdp(p.slice(0, mi + 1), eps).slice(0, -1), ...rdp(p.slice(mi), eps)] : [p[0], p[p.length - 1]]
      }
      const chaikin = (p: [number, number][], n: number): [number, number][] => {
        for (let it = 0; it < n; it++) {
          const q: [number, number][] = [p[0]]
          for (let i = 0; i < p.length - 1; i++) {
            const [x0, z0] = p[i], [x1, z1] = p[i + 1]
            if (i > 0) q.push([x0 * 0.75 + x1 * 0.25, z0 * 0.75 + z1 * 0.25])
            if (i < p.length - 2) q.push([x0 * 0.25 + x1 * 0.75, z0 * 0.25 + z1 * 0.75])
          }
          q.push(p[p.length - 1])
          p = q
        }
        return p
      }
      // Resample ~10 m; the ground under each sample; `cliff` = it runs over a drop (> 0.9 rise per metre between
      // 3 m probes), `steep` = the steepest sample-to-sample ground grade.
      const resample = (p: [number, number][]) => {
        let total = 0
        for (let i = 1; i < p.length; i++) total += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])
        const S = Math.max(2, Math.min(160, Math.round(total / 10) + 1))
        const xs = new Float32Array(S), zs = new Float32Array(S), raw = new Float32Array(S)
        let seg = 0, acc = 0
        for (let k = 0; k < S; k++) {
          const want = (total * k) / (S - 1)
          while (seg < p.length - 2 && acc + Math.hypot(p[seg + 1][0] - p[seg][0], p[seg + 1][1] - p[seg][1]) < want) { acc += Math.hypot(p[seg + 1][0] - p[seg][0], p[seg + 1][1] - p[seg][1]); seg++ }
          const l = Math.hypot(p[seg + 1][0] - p[seg][0], p[seg + 1][1] - p[seg][1]) || 1
          const t = Math.min(1, Math.max(0, (want - acc) / l))
          xs[k] = p[seg][0] + (p[seg + 1][0] - p[seg][0]) * t
          zs[k] = p[seg][1] + (p[seg + 1][1] - p[seg][1]) * t
          raw[k] = this.host.baseHeight(xs[k], zs[k])
        }
        raw[S - 1] = endH
        if (ah !== undefined) raw[0] = ah
        let cliff = false
        for (let i = 0; i < p.length - 1 && !cliff; i++) {
          const l = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]), n = Math.max(1, Math.ceil(l / 3))
          let hp = this.host.baseHeight(p[i][0], p[i][1])
          for (let k = 1; k <= n && !cliff; k++) {
            const hq = this.host.baseHeight(p[i][0] + (p[i + 1][0] - p[i][0]) * (k / n), p[i][1] + (p[i + 1][1] - p[i][1]) * (k / n))
            if (Math.abs(hq - hp) > (l / n) * 0.9) cliff = true
            hp = hq
          }
        }
        let steep = 0
        const step = total / (S - 1)
        for (let k = 2; k < S - 1; k++) steep = Math.max(steep, Math.abs(raw[k] - raw[k - 1]) / Math.max(1, step))
        return { xs, zs, raw, total, cliff, steep }
      }
      // Rounded (RDP 4 m + Chaikin ×2) first; a rounded curve cuts the corners of a switchback straight up the hill,
      // so if it climbs steeper than the pass allowed (or runs over a drop) fall back to a lightly rounded path, then
      // to the exact cell path.
      const exact = rdp(pts.slice(), 1)
      const tries = [chaikin(rdp(pts, 4), 2), chaikin(exact, 1), exact]
      let pick = resample(tries[0])
      if (!link) { if (pick.cliff) pick = resample(exact) } // (a connector: the exact cell path where the curve runs over a drop)
      else {
        const lim = Math.min(0.93, maxG + 0.1)
        for (let k = 1; k < tries.length && (pick.cliff || pick.steep > lim); k++) {
          const q = resample(tries[k])
          if (!q.cliff && (pick.cliff || q.steep < pick.steep)) pick = q
        }
      }
      if (pick.total >= 4) {
        this.built.delete(key)
        // A link is graded like every road (rise-limited to MAX_GRADE within ±MAX_OFFSET of the ground): its 12 m steps
        // are drivable, the ground's 2 m bumps between them are cut / filled (a 0.45 limit left 40–70 % pitches).
        // (A connector already hugs the ground; on the strictest pass it may be a steep 4×4 track: grade 0.45.)
        road = this.finishRoad(key, type, pick.xs, pick.zs, pick.raw, link || maxG >= 0.4 ? MAX_GRADE : 0.45)
      }
    }
    return road
  }

  /** Tentative driveway of a place: a connector to the nearest road (any kind) within 700 m. */
  private tentDrive(p: { x: number; z: number }): NetRoad | null {
    const key = `poi:${Math.floor(p.x)},${Math.floor(p.z)}`
    const hit = this.drives.get(key)
    if (hit !== undefined) return hit
    const ci = Math.floor(p.x / REGION), cj = Math.floor(p.z / REGION)
    // Fine search within 1.3 km; a remote place falls back to a coarse (24 m) search over 2.6 km.
    const r = this.route(key, [p.x, p.z], undefined, this.netLinks(ci - 5, cj - 5, ci + 5, cj + 5, []), RoadType.Gravel, 1300) ??
      this.route(key + '~', [p.x, p.z], undefined, this.netLinks(ci - 8, cj - 8, ci + 8, cj + 8, []), RoadType.Gravel, 2600)
    if (this.drives.size > 4000) this.drives.clear()
    this.drives.set(key, r)
    return r
  }

  /** DRIVEWAY of a place: its tentative connector unless it crosses the tentative one of a place EARLIER in (z, x)
   *  order within 800 m (pairwise, non-recursive); then the next candidates are not tried (rare). */
  private driveway(p: { x: number; z: number }): NetRoad | null {
    const fk = `${Math.floor(p.x)},${Math.floor(p.z)}`
    const done = this.finalDrives.get(fk)
    if (done !== undefined) return done
    const out = this.driveway0(p)
    if (this.finalDrives.size > 4000) this.finalDrives.clear()
    this.finalDrives.set(fk, out)
    return out
  }
  private readonly finalDrives = new Map<string, NetRoad | null>()
  private driveway0(p: { x: number; z: number }): NetRoad | null {
    const r = this.tentDrive(p)
    if (!r) return null
    // Earlier places' BUILT drives (strict (z, x) order → the recursion is finite): only those exist to cross or join
    // (a dropped tentative one is not a road — ending on one was a dead end, avoiding one lost the place its road).
    const earlier: NetRoad[] = []
    let clash = false
    const box = Math.max(800, r.maxX - r.minX + 400, r.maxZ - r.minZ + 400)
    for (const q of this.host.pois?.inBox(p.x - box, p.z - box, p.x + box, p.z + box) ?? []) {
      if (q.z > p.z || (q.z === p.z && q.x >= p.x)) continue
      if (!this.tentDrive(q)) continue
      const o = this.driveway(q)
      if (!o) continue
      earlier.push(o)
      if (RoadNetwork.crosses(r, o)) clash = true
    }
    if (!clash) return r
    // It would cross an earlier place's drive: route again with those drives as goals too — it then ENDS on the
    // first one it meets (a junction) instead of crossing it. (Earlier drives are tentative ones: non-recursive.)
    const ci = Math.floor(p.x / REGION), cj = Math.floor(p.z / REGION)
    const goals = [...this.netLinks(ci - 8, cj - 8, ci + 8, cj + 8, []), ...earlier]
    const key = `poi:${Math.floor(p.x)},${Math.floor(p.z)}`
    const r2 = this.route(key + '+', [p.x, p.z], undefined, goals, RoadType.Gravel, 1300) ?? this.route(key + '+~', [p.x, p.z], undefined, goals, RoadType.Gravel, 2600)
    return r2 && !earlier.some((o) => RoadNetwork.crosses(r2, o)) ? r2 : null
  }

  /** The road from a place (its driveway; null if none). */
  placeRoad(p: { x: number; z: number }): NetRoad | null {
    return this.driveway(p)
  }

  /** Camp track: a connector (trail) to the nearest road within 700 m. */
  campRoad(c: { x: number; z: number }): NetRoad | null {
    const key = `camp:${Math.floor(c.x)},${Math.floor(c.z)}`
    const hit = this.drives.get(key)
    if (hit !== undefined) return hit
    const ci = Math.floor(c.x / REGION), cj = Math.floor(c.z / REGION)
    const r = this.route(key, [c.x, c.z], undefined, this.netLinks(ci - 3, cj - 3, ci + 3, cj + 3, []), RoadType.Trail)
    this.drives.set(key, r)
    return r
  }

  /**
   * BRIDGE ROADS (bright rope bridges): the near end (on the main road's side) gets a short track straight onto the
   * main road, the far end a connector into the network on the far side. A bridge is built ONLY if both exist
   * (`bridgeOK`) — no bridge to nowhere. The roads end exactly at the deck's height.
   */
  bridgeLinks(k: number): NetRoad[] | null {
    const hit = this.bridgeRoads.get(k)
    if (hit !== undefined) return hit
    this.bridgeRoads.set(k, null) // (guards re-entry while building)
    let out: NetRoad[] | null = null
    const b = this.host.bridge?.(k)
    if (b) {
      const side = Math.sign(b.xb - this.host.roadCenterX(b.z)) || 1
      const near = this.shape(`br${k}a`, [b.xa - side * 0.5, b.z], null, RoadType.Trail, undefined, b.ha, 6, b.z)
      const ci = Math.floor(b.xb / REGION), cj = Math.floor(b.z / REGION)
      const far = this.route(`br${k}b`, [b.xb + side * 0.5, b.z], b.hb, this.netLinks(ci - 3, cj - 3, ci + 3, cj + 3, []), RoadType.Trail, 900, side)
      if (near && far) out = [near, far]
    }
    if (this.bridgeRoads.size > 1000) this.bridgeRoads.clear()
    this.bridgeRoads.set(k, out)
    return out
  }

  /** Is the bridge of z-cell k built (both ends lead to roads)? */
  bridgeOK(k: number): boolean {
    return !!this.bridgeLinks(k)
  }

  /**
   * One road's GEOMETRY between two points (or to the main road when `b` is null): a quadratic Bézier with a hashed
   * bend, graded along the ground. null when too short / long, when a node-to-node road would run through the main
   * road's corridor (nodes on opposite sides connect through it), or when it would climb a cliff. Crossing rules
   * between roads are the callers' (parentLink / loopLink / driveway).
   */
  private shape(key: string, a: [number, number], b: [number, number] | null, type: number, endH?: number, startH?: number, minLen = 30, mainZ?: number): NetRoad | null {
    let r = this.built.get(key)
    if (r !== undefined) return r
    const s = this.host.seed
    let bx: number, bz: number
    if (b) [bx, bz] = b
    else {
      bz = mainZ ?? a[1] + (hashFloat(s, Math.floor(a[0]), Math.floor(a[1]), 950) - 0.5) * 120
      bx = this.host.roadCenterX(bz)
    }
    const dx = bx - a[0], dz = bz - a[1]
    const len = Math.hypot(dx, dz)
    if (len < minLen || len > REGION * 1.9) {
      this.built.set(key, null)
      return null
    }
    const bend = mainZ !== undefined ? 0 : (hashFloat(s, Math.floor(a[0]), Math.floor(bz), 951) - 0.5) * 0.6 * len
    const cx = (a[0] + bx) / 2 - (dz / len) * bend
    const cz = (a[1] + bz) / 2 + (dx / len) * bend
    const SAMPLES = Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, Math.round(len / SAMPLE_STEP) + 1))
    const xs = new Float32Array(SAMPLES), zs = new Float32Array(SAMPLES), raw = new Float32Array(SAMPLES)
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
    if (!b) raw[SAMPLES - 1] = this.host.mainRoadHeight(bz)
    else if (endH !== undefined) raw[SAMPLES - 1] = endH // a junction: the joined road's own height
    if (startH !== undefined) raw[0] = startH // a bridge deck end
    const r2 = this.finishRoad(key, type, xs, zs, raw)
    if (r2 && endH === undefined && startH === undefined && mainZ === undefined) r2.link = { a, b, len, drop: Math.abs(r2.hs[0] - r2.hs[SAMPLES - 1]) }
    return r2
  }

  private readonly drivables = new Map<string, NetRoad>()

  /**
   * The DRIVABLE version of a chosen node link: if its straight shape is steeper than DRIVE_GRADE anywhere, the
   * terrain-following route between the same ends (`routeTo`), same key — when that is flatter, not an absurd
   * detour (≤ DETOUR_MAX × the straight length, or × what the height difference needs at DRIVE_GRADE) and stays
   * within BOX_MARGIN of its ends' box (the region lists see every road within 2 regions of its node). Only CHOSEN
   * links are routed (the candidates are compared on their cheap straight shapes): ~15 ms per steep link.
   * Callers re-check crossings on the result and keep the straight one if it crosses.
   */
  /**
   * Does a routed road suit the terrain shaping (WorldFields embankments: NET_SHOULDER 4 + 1.6·|Δh| ≤ 38 m beyond
   * its edge)?
   *  - Its embankment never reaches the main road's 12 m shoulder: centre distance ≥ 12 + 2.3 + 4 + 1.6·|Δh| (except
   *    its last 40 m, coming down onto it) — a hillside route 35 m off and 22 m above the main road walled it 12 m.
   *  - Its switchback legs (> 50 m apart along it) never come so close at such a height difference that one's
   *    embankment reaches the other (`bankMax`) — two legs 9 m apart and 6.8 m apart in height made a 72° bank.
   *    Same against the roads already there (`others`), away from its own ends (the junctions).
   */
  private fits(q: NetRoad, others: NetRoad[]): boolean {
    const L = q.cum[q.n - 1]
    for (let k = 1; k < q.n - 1; k++) {
      if (q.cum[k] >= L - 40) break
      const z = q.zs[k]
      if (Math.abs(q.xs[k] - this.host.roadCenterX(z)) < Math.min(52.5, 18.5 + 1.6 * Math.abs(q.hs[k] - this.host.mainRoadHeight(z)))) return false
    }
    for (let i = 0; i < q.n; i++) {
      for (let j = i + 1; j < q.n; j++) {
        if (q.cum[j] - q.cum[i] <= 50) continue
        const d = Math.hypot(q.xs[j] - q.xs[i], q.zs[j] - q.zs[i])
        if (d < BANK_REACH && Math.abs(q.hs[j] - q.hs[i]) > bankMax(d)) return false
      }
    }
    const x0 = q.xs[0], z0 = q.zs[0], x1 = q.xs[q.n - 1], z1 = q.zs[q.n - 1]
    for (const o of others) {
      if (o.maxX < q.minX - BANK_REACH || o.minX > q.maxX + BANK_REACH || o.maxZ < q.minZ - BANK_REACH || o.minZ > q.maxZ + BANK_REACH) continue
      for (let i = 0; i < q.n; i++) {
        if (Math.hypot(q.xs[i] - x0, q.zs[i] - z0) < 40 || Math.hypot(q.xs[i] - x1, q.zs[i] - z1) < 40) continue // (the junction itself)
        for (let j = 0; j < o.n; j++) {
          const d = Math.hypot(o.xs[j] - q.xs[i], o.zs[j] - q.zs[i])
          if (d < BANK_REACH && Math.abs(o.hs[j] - q.hs[i]) > bankMax(d)) return false
        }
      }
    }
    return true
  }

  private drivable(r: NetRoad, walls: NetRoad[]): NetRoad {
    const hit = this.drivables.get(r.key)
    if (hit) return hit
    let out = r
    const e = r.link
    if (e && maxGrade(r) > DRIVE_GRADE) {
      const q = this.routeTo(r.key + '~d', e.a, e.b, r.type, e.len, walls)
      const bx0 = Math.min(r.xs[0], r.xs[r.n - 1]) - BOX_MARGIN, bx1 = Math.max(r.xs[0], r.xs[r.n - 1]) + BOX_MARGIN
      const bz0 = Math.min(r.zs[0], r.zs[r.n - 1]) - BOX_MARGIN, bz1 = Math.max(r.zs[0], r.zs[r.n - 1]) + BOX_MARGIN
      if (q && q.cum[q.n - 1] <= DETOUR_MAX * Math.max(e.len, 60, e.drop / DRIVE_GRADE) && maxGrade(q) < maxGrade(r) - 0.05 &&
        q.minX >= bx0 && q.maxX <= bx1 && q.minZ >= bz0 && q.maxZ <= bz1 && this.fits(q, walls)) out = { ...q, key: r.key }
    }
    if (this.drivables.size > 4000) this.drivables.clear()
    this.drivables.set(r.key, out)
    return out
  }

  /**
   * Grade a polyline (raw = the ground under each sample; its first / last entries may already be set to the exact
   * end heights) and package it as a road; null (cached) if it would climb a cliff.
   */
  private finishRoad(key: string, type: number, xs: Float32Array, zs: Float32Array, raw: Float32Array, grade = MAX_GRADE): NetRoad | null {
    let r: NetRoad | null
    const SAMPLES = xs.length
    let len = 0
    for (let i = 1; i < SAMPLES; i++) len += Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1])
    const hs = new Float32Array(SAMPLES)
    // Grade within a band around the ground: the road never sits more than MAX_OFFSET above or below the
    // terrain it crosses (no ramps floating over a valley, no trenches), and inside that band the grade is
    // smoothed to MAX_GRADE where the ground allows. Both ends are exact (the node; the main road bed).
    const segLen = Math.max(1, len / (SAMPLES - 1))
    const maxRise = segLen * grade
    // FIXED heights: both ends (exact: the node / a junction's road height / a bridge deck / the main road bed) and
    // inside a place's flattened disc (the road lies on the place's base — no bump through a farmyard).
    const fixed = new Uint8Array(SAMPLES)
    hs.set(raw)
    fixed[0] = fixed[SAMPLES - 1] = 1
    if (this.host.pois) {
      for (let i = 0; i < SAMPLES; i++) {
        const p = this.host.pois.near(xs[i], zs[i])
        if (p && Math.hypot(xs[i] - p.x, zs[i] - p.z) < p.radius * 0.6) (hs[i] = p.baseH), (fixed[i] = 1)
      }
    }
    // The BAND the road may sit in around the ground: ±MAX_OFFSET, widened next to a fixed height that is off the
    // ground (a junction, a farmyard) by exactly what a MAX_GRADE ramp from it needs — so it meets them on a ramp.
    const band = new Float32Array(SAMPLES).fill(MAX_OFFSET)
    for (let f = 0; f < SAMPLES; f++) {
      if (!fixed[f]) continue
      const off = Math.abs(hs[f] - raw[f])
      if (off <= MAX_OFFSET) continue
      for (let i = 0; i < SAMPLES; i++) band[i] = Math.max(band[i], off - maxRise * Math.abs(i - f))
    }
    const clampBand = (i: number, v: number) => Math.min(raw[i] + band[i], Math.max(raw[i] - band[i], v))
    // Grade within the band: rise-limited (MAX_GRADE) both ways where the ground allows, never more than the band off
    // the ground (no ramps floating over a valley, no trenches).
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 1; i < SAMPLES; i++) if (!fixed[i]) hs[i] = clampBand(i, Math.min(hs[i - 1] + maxRise, Math.max(hs[i - 1] - maxRise, hs[i])))
      for (let i = SAMPLES - 2; i >= 0; i--) if (!fixed[i]) hs[i] = clampBand(i, Math.min(hs[i + 1] + maxRise, Math.max(hs[i + 1] - maxRise, hs[i])))
    }
    for (let i = 1; i < SAMPLES - 1; i++) if (!fixed[i] && !fixed[i - 1] && !fixed[i + 1]) hs[i] = clampBand(i, (hs[i - 1] + 2 * hs[i] + hs[i + 1]) * 0.25)
    for (let i = 0; i < SAMPLES; i++) if (!fixed[i]) hs[i] = Math.max(this.host.water + 1.2, hs[i]) // fords: a causeway just above the water
    // A road can't climb a cliff: links whose graded profile still exceeds ~90 % (42°) anywhere (plateau edges, karst
    // walls, a valley it would have to bridge) are not built — the tree / router finds another way.
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
      const r = this.driveway(p)
      if (r && r.maxX >= x0 && r.minX <= x1 && r.maxZ >= z0 && r.minZ <= z1 && !list.includes(r)) list.push(r)
    }
    // Camps (bright oases): a track to the nearest road, like a place's driveway.
    for (const c of this.host.camps?.(z0 - 700, z1 + 700) ?? []) {
      const r = this.campRoad(c)
      if (r && r.maxX >= x0 && r.minX <= x1 && r.maxZ >= z0 && r.minZ <= z1 && !list.includes(r)) list.push(r)
    }
    // Bridge roads (bright): both ends of every built bridge whose cell is near.
    if (this.host.bridge) {
      for (let k = Math.floor((z0 - 700) / BRIDGE_CELL); k <= Math.floor((z1 + 700) / BRIDGE_CELL); k++) {
        for (const r of this.bridgeLinks(k) ?? []) if (r.maxX >= x0 && r.minX <= x1 && r.maxZ >= z0 && r.minZ <= z1 && !list.includes(r)) list.push(r)
      }
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
          bestH = roadHeightAt(r, i, t)
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
