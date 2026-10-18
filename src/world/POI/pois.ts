import { hashFloat } from '../noise/rng'

/**
 * Procedural PLACES (deterministic, global, per 300 m region — like the road network):
 *  - FARM (p ≈ 0.5 per region the main road crosses): 45–110 m to one side of the main road, on gentle ground.
 *  - CABIN / RUINS / CAMP (p ≈ 0.55 per region): anywhere suitable, away from road, river and steep slopes.
 *  - LOOKOUT (one per LOOKOUT_REGION where the land has a real SUMMIT): a viewpoint on the peak, reached by a
 *    switchback trail (RoadNetwork driveway with a strict slope limit) — the reason to leave the valley road.
 * Each place flattens its ground to a base height measured on the valley-shaped ground (WorldFields), clears
 * trees (scatter), and gets a gravel road to the main road (RoadNetwork). Contents are laid out in `poiLayout.ts`.
 */
export const PoiType = { Farm: 0, Cabin: 1, Ruins: 2, Camp: 3, Lookout: 4 } as const
export const POI_REGION = 300

export interface Poi {
  type: number
  x: number
  z: number
  /** Layout rotation (rad). */
  rot: number
  /** Flattened radius (m). */
  radius: number
  baseH: number
  /** Hash for per-place variety (crop type, colours…). */
  variant: number
  /** Bright: the "farm" is a cozy HOMESTEAD — just the house in a fenced yard (no barn, no fields). */
  home?: boolean
}

export interface PoiHost {
  seed: number
  baseHeight(x: number, z: number): number
  roadCenterX(z: number): number
  riverDistance(x: number, z: number): number
  water: number
  /** Region biome weights [desert, snow] — places are only built in the green lands (none in snow or sand). */
  biome?(x: number, z: number): [number, number]
  /** Bright: farms are homesteads (smaller yard, the house only). */
  homestead?(): boolean
}

const RADIUS = [48, 16, 18, 14, 11]
/**
 * LOOKOUTS: ≤ 1 SUMMIT per LOOKOUT_REGION (600 m = 2 × 2 place regions): the 4 highest of a 6 × 6 sample grid, each
 * climbed to its local top (8 directions, 40 → 20 → 10 m steps); the first that is a real peak — PROMINENCE ≥ 16 m over
 * the ring 150 m round it, flanks ≤ 50 % on average over the top 48 m (a trail can wind up it) — dry, ≥ 140 m off the main road, ≥ 80 m off the river, and its top fits the place's blend
 * ring. Any biome (a desert butte, a snowy peak). ≤ ~250 height samples per 600 m cell, once (cached).
 */
export const LOOKOUT_REGION = 600
/** Place regions per lookout cell edge. */
const LOOK_PER = LOOKOUT_REGION / POI_REGION
const LOOKOUT_PROMINENCE = 16
const DIR8 = [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071]] as const
/** Homestead yard radius (bright's farm). */
const HOME_RADIUS = 26
const farmR = (h: PoiHost) => (h.homestead?.() ? HOME_RADIUS : RADIUS[0])

export class PoiField {
  private readonly cache = new Map<number, Poi[]>()
  private readonly lookouts = new Map<number, Poi | null>()
  private homeFarm: Poi | null | undefined
  constructor(private readonly host: PoiHost) {}

  /**
   * The HOME farm: every world has one farm right beside the road 70–230 m ahead of the spawn (z = 8, facing
   * +Z), so a place is in sight when the game starts. First gentle, dry candidate wins (deterministic).
   */
  home(): Poi | null {
    if (this.homeFarm !== undefined) return this.homeFarm
    const h = this.host, s = h.seed
    this.homeFarm = null
    const first = hashFloat(s, 1221) < 0.5 ? -1 : 1
    for (let z = 110; z <= 230 && !this.homeFarm; z += 20) {
      for (const side of [first, -first]) {
        const x = h.roadCenterX(z) + side * 61 // field edge ~13 m off the road (past the shoulder) → in view from the road
        if (h.riverDistance(x, z) < 70) continue
        const base = this.flatEnough(x, z, farmR(h))
        if (base === null) continue
        this.homeFarm = { type: PoiType.Farm, x, z, rot: side > 0 ? 0 : Math.PI, radius: farmR(h), baseH: base, variant: hashFloat(s, 1222), home: h.homestead?.() }
        break
      }
    }
    return this.homeFarm
  }

  /** The LOOKOUT of LOOKOUT_REGION cell (li, lj), or null (no drivable summit there). */
  lookout(li: number, lj: number): Poi | null {
    const key = li * 131072 + lj
    const hit = this.lookouts.get(key)
    if (hit !== undefined) return hit
    const h = this.host, s = h.seed
    let out: Poi | null = null
    // The 4 highest of a 6 × 6 sample grid, each climbed to its local top; the first that passes (highest first) wins.
    const cand: [number, number, number][] = []
    for (let j = 0; j < 6; j++) {
      for (let i = 0; i < 6; i++) {
        const x = (li + (i + 0.2 + 0.6 * hashFloat(s, li * 6 + i, lj * 6 + j, 1301)) / 6) * LOOKOUT_REGION
        const z = (lj + (j + 0.2 + 0.6 * hashFloat(s, li * 6 + i, lj * 6 + j, 1302)) / 6) * LOOKOUT_REGION
        cand.push([h.baseHeight(x, z), x, z])
      }
    }
    cand.sort((p, q) => q[0] - p[0] || p[1] - q[1])
    const tried: [number, number][] = []
    for (const [h0, x0, z0] of cand.slice(0, 4)) {
      let bx = x0, bz = z0, bh = h0
      for (const step of [40, 20, 10]) {
        for (let it = 0; it < 4; it++) {
          let moved = false
          for (const [dx, dz] of DIR8) {
            const y = h.baseHeight(bx + dx * step, bz + dz * step)
            if (y > bh) (bh = y), (bx += dx * step), (bz += dz * step), (moved = true)
          }
          if (!moved) break
        }
      }
      if (tried.some(([x, z]) => Math.hypot(x - bx, z - bz) < 30)) continue // (the same top again)
      tried.push([bx, bz])
      // (the climb may leave the cell: the summit belongs to the cell it ends in — a neighbour finds the same peak)
      if (Math.floor(bx / LOOKOUT_REGION) !== li || Math.floor(bz / LOOKOUT_REGION) !== lj) continue
      if (bh <= h.water + 8 || Math.abs(bx - h.roadCenterX(bz)) <= 140 || h.riverDistance(bx, bz) <= 80) continue
      // (a NEEDLE — flanks averaging > 50 % over the top 48 m — has no drivable way up: not a lookout)
      let cone = 0
      for (let k = 0; k < 8; k++) cone += (bh - h.baseHeight(bx + DIR8[k][0] * 48, bz + DIR8[k][1] * 48)) / 8
      if (cone > 24) continue
      let ring = 0, low = Infinity, lowA = 0
      for (let k = 0; k < 8; k++) {
        const y = h.baseHeight(bx + DIR8[k][0] * 150, bz + DIR8[k][1] * 150)
        ring += y / 8
        if (y < low) (low = y), (lowA = k)
      }
      if (bh - ring < LOOKOUT_PROMINENCE) continue
      const r = RADIUS[PoiType.Lookout]
      let lo = bh, sum = bh
      for (let k = 0; k < 8; k++) {
        const y = h.baseHeight(bx + DIR8[k][0] * r * 0.7, bz + DIR8[k][1] * r * 0.7)
        lo = Math.min(lo, y); sum += y
      }
      // The top is flattened to just under the peak (a terrace on the summit, not a crater): it must fit the blend.
      if (bh - lo > r * 0.45) continue
      // rot: the terrace faces the BEST VIEW — down the lowest side of the peak.
      const rot = Math.atan2(DIR8[lowA][0], DIR8[lowA][1])
      out = { type: PoiType.Lookout, x: bx, z: bz, rot, radius: r, baseH: (sum / 9 + bh) / 2, variant: hashFloat(s, li, lj, 1303) }
      break
    }
    if (this.lookouts.size > 2000) this.lookouts.clear()
    this.lookouts.set(key, out)
    return out
  }

  private flatEnough(x: number, z: number, r: number): number | null {
    const h = this.host
    // No farms, cabins, camps or ruins in the desert or on the snowfields (their own places come later).
    const b = h.biome?.(x, z)
    if (b && (b[0] > 0.25 || b[1] > 0.25)) return null
    const samples = [h.baseHeight(x, z)]
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      samples.push(h.baseHeight(x + Math.cos(a) * r * 0.7, z + Math.sin(a) * r * 0.7))
    }
    const lo = Math.min(...samples), hi = Math.max(...samples)
    // Relief across the place must fit its blend ring (0.4 r): otherwise the flattened disc ends in a cliff.
    if (hi - lo > r * 0.28 || lo < h.water + 2) return null
    return samples.reduce((a, b) => a + b, 0) / samples.length
  }

  region(ci: number, cj: number): Poi[] {
    const key = ci * 131072 + cj // (a number: this runs ~9 × per ground height sample — string keys were 19 % of world generation)
    let list = this.cache.get(key)
    if (list) return list
    list = []
    const h = this.host
    const s = h.seed
    const x0 = ci * POI_REGION, z0 = cj * POI_REGION
    const hf = this.home()
    if (hf && Math.floor(hf.x / POI_REGION) === ci && Math.floor(hf.z / POI_REGION) === cj) list.push(hf)
    // This region's share of the 900 m cell's lookout (the summit decides the region it stands in).
    const lk = this.lookout(Math.floor(ci / LOOK_PER), Math.floor(cj / LOOK_PER))
    if (lk && Math.floor(lk.x / POI_REGION) === ci && Math.floor(lk.z / POI_REGION) === cj && (!hf || Math.hypot(hf.x - lk.x, hf.z - lk.z) > 200)) list.push(lk)
    const look = list.find((q) => q.type === PoiType.Lookout)
    const clear = (x: number, z: number, d: number) => (!hf || Math.hypot(hf.x - x, hf.z - z) > d) && (!look || Math.hypot(look.x - x, look.z - z) > 90)
    // Farm beside the main road.
    if (hashFloat(s, ci, cj, 1201) < 0.5) {
      const z = z0 + (0.2 + 0.6 * hashFloat(s, ci, cj, 1202)) * POI_REGION
      const side = hashFloat(s, ci, cj, 1203) < 0.5 ? -1 : 1
      const x = h.roadCenterX(z) + side * (58 + hashFloat(s, ci, cj, 1204) * 45)
      if (x >= x0 && x < x0 + POI_REGION && h.riverDistance(x, z) > 70 && clear(x, z, 160)) {
        const base = this.flatEnough(x, z, farmR(h))
        if (base !== null) list.push({ type: PoiType.Farm, x, z, rot: side > 0 ? 0 : Math.PI, radius: farmR(h), baseH: base, variant: hashFloat(s, ci, cj, 1205), home: h.homestead?.() })
      }
    }
    // One smaller place in the wild.
    if (hashFloat(s, ci, cj, 1210) < 0.55) {
      const x = x0 + (0.15 + 0.7 * hashFloat(s, ci, cj, 1211)) * POI_REGION
      const z = z0 + (0.15 + 0.7 * hashFloat(s, ci, cj, 1212)) * POI_REGION
      const t = 1 + Math.floor(hashFloat(s, ci, cj, 1213) * 3)
      if (Math.abs(x - h.roadCenterX(z)) > 45 && h.riverDistance(x, z) > 40 && !list.some((p) => Math.hypot(p.x - x, p.z - z) < 90) && clear(x, z, 90)) {
        const base = this.flatEnough(x, z, RADIUS[t])
        if (base !== null) list.push({ type: t, x, z, rot: hashFloat(s, ci, cj, 1214) * Math.PI * 2, radius: RADIUS[t], baseH: base, variant: hashFloat(s, ci, cj, 1215) })
      }
    }
    if (this.cache.size > 3000) this.cache.clear()
    this.cache.set(key, list)
    return list
  }

  /** Places whose radius (+margin) covers (x, z). */
  near(x: number, z: number, margin = 0): Poi | null {
    const ci = Math.floor(x / POI_REGION), cj = Math.floor(z / POI_REGION)
    for (let j = cj - 1; j <= cj + 1; j++) {
      for (let i = ci - 1; i <= ci + 1; i++) {
        for (const p of this.region(i, j)) if (Math.hypot(x - p.x, z - p.z) < p.radius + margin) return p
      }
    }
    return null
  }

  /** All places in regions overlapping the box (for chunk layout and roads). */
  inBox(minX: number, minZ: number, maxX: number, maxZ: number): Poi[] {
    const out: Poi[] = []
    for (let j = Math.floor((minZ - 60) / POI_REGION); j <= Math.floor((maxZ + 60) / POI_REGION); j++) {
      for (let i = Math.floor((minX - 60) / POI_REGION); i <= Math.floor((maxX + 60) / POI_REGION); i++) {
        for (const p of this.region(i, j)) if (p.x + p.radius > minX && p.x - p.radius < maxX && p.z + p.radius > minZ && p.z - p.radius < maxZ) out.push(p)
      }
    }
    return out
  }
}

/** Point in a place's local frame (x right, z forward after un-rotating). */
export function toLocal(p: Poi, x: number, z: number): [number, number] {
  const dx = x - p.x, dz = z - p.z
  const c = Math.cos(-p.rot), s = Math.sin(-p.rot)
  return [dx * c - dz * s, dx * s + dz * c]
}

export function toWorld(p: Poi, lx: number, lz: number): [number, number] {
  const c = Math.cos(p.rot), s = Math.sin(p.rot)
  return [p.x + lx * c - lz * s, p.z + lx * s + lz * c]
}

/** Farm field rectangles in local coords: [x0, z0, x1, z1]. */
export const FARM_FIELDS: [number, number, number, number][] = [
  [-34, -32, -4, -6],
  [4, -32, 34, -6],
]

/** 0 outside fields; 1 inside a farm crop field (tilled soil, crops, no grass/trees). */
export function farmFieldAt(p: Poi, x: number, z: number): number {
  if (p.type !== PoiType.Farm || p.home) return 0
  const [lx, lz] = toLocal(p, x, z)
  for (const f of FARM_FIELDS) if (lx > f[0] && lx < f[2] && lz > f[1] && lz < f[3]) return 1
  return 0
}

/** Inside a homestead's fenced yard (+ the back yard) — a mown lawn: no tall grass. */
export function homeYardAt(p: Poi, x: number, z: number): boolean {
  if (!p.home) return false
  const [lx, lz] = toLocal(p, x, z)
  return lx > -9.5 && lx < 14 && Math.abs(lz) < 10.5
}

const NAMES: string[][] = [
  ['Sunflower Farm', 'Willow Farm', 'Meadowbrook Farm', 'Honey Hill Farm', 'Old Mill Farm', 'Clover Farm'],
  ['Lakeside Cabin', "Hunter's Cabin", 'Pinewood Cabin', "Woodcutter's Hut"],
  ['Old Ruins', 'Mossy Ruins', 'Forgotten Keep', 'Broken Chapel'],
  ["Traveller's Camp", 'Scout Camp', 'Ember Camp', 'Starlight Camp'],
  ['Eagle Point', 'Sunset Lookout', 'High Cairn', 'Windy Summit', 'Crown Rock', 'Skyview Point', 'Hawk Ridge', 'Cloudrest Peak'],
]
export const POI_ICONS = ['🌾', '🏠', '🏛️', '⛺', '⛰️']
const HOME_NAMES = ['Willow Cottage', 'Hearthstone House', 'Birch Hollow', 'Lantern House', 'Old Miller\'s House', 'Meadow Cottage']
/** HUD icon of a place (bright homesteads: a house). */
export function poiIcon(p: Poi): string {
  return p.home ? '🏡' : POI_ICONS[p.type]
}

/** Deterministic display name of a place (HUD markers and the arrival banner). */
export function poiName(p: Poi): string {
  const n = p.home ? HOME_NAMES : NAMES[p.type]
  return n[Math.floor(p.variant * n.length) % n.length]
}
