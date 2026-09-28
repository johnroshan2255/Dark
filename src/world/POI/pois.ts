import { hashFloat } from '../noise/rng'

/**
 * Procedural PLACES (deterministic, global, per 300 m region — like the road network):
 *  - FARM (p ≈ 0.5 per region the main road crosses): 45–110 m to one side of the main road, on gentle ground.
 *  - CABIN / RUINS / CAMP (p ≈ 0.55 per region): anywhere suitable, away from road, river and steep slopes.
 * Each place flattens its ground to a base height (WorldFields.height), clears trees (scatter), and gets a
 * gravel road to the main road (RoadNetwork). Contents are laid out in `poiLayout.ts`.
 */
export const PoiType = { Farm: 0, Cabin: 1, Ruins: 2, Camp: 3 } as const
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
}

export interface PoiHost {
  seed: number
  baseHeight(x: number, z: number): number
  roadCenterX(z: number): number
  riverDistance(x: number, z: number): number
  water: number
}

const RADIUS = [48, 16, 18, 14]

export class PoiField {
  private readonly cache = new Map<string, Poi[]>()
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
        const x = h.roadCenterX(z) + side * 56 // field edge ~8 m off the road → in view from the road
        if (h.riverDistance(x, z) < 70) continue
        const base = this.flatEnough(x, z, RADIUS[PoiType.Farm])
        if (base === null) continue
        this.homeFarm = { type: PoiType.Farm, x, z, rot: side > 0 ? 0 : Math.PI, radius: RADIUS[0], baseH: base, variant: hashFloat(s, 1222) }
        break
      }
    }
    return this.homeFarm
  }

  private flatEnough(x: number, z: number, r: number): number | null {
    const h = this.host
    const samples = [h.baseHeight(x, z)]
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      samples.push(h.baseHeight(x + Math.cos(a) * r * 0.7, z + Math.sin(a) * r * 0.7))
    }
    const lo = Math.min(...samples), hi = Math.max(...samples)
    if (hi - lo > r * 0.35 || lo < h.water + 2) return null
    return samples.reduce((a, b) => a + b, 0) / samples.length
  }

  region(ci: number, cj: number): Poi[] {
    const key = `${ci},${cj}`
    let list = this.cache.get(key)
    if (list) return list
    list = []
    const h = this.host
    const s = h.seed
    const x0 = ci * POI_REGION, z0 = cj * POI_REGION
    const hf = this.home()
    if (hf && Math.floor(hf.x / POI_REGION) === ci && Math.floor(hf.z / POI_REGION) === cj) list.push(hf)
    const clear = (x: number, z: number, d: number) => !hf || Math.hypot(hf.x - x, hf.z - z) > d
    // Farm beside the main road.
    if (hashFloat(s, ci, cj, 1201) < 0.5) {
      const z = z0 + (0.2 + 0.6 * hashFloat(s, ci, cj, 1202)) * POI_REGION
      const side = hashFloat(s, ci, cj, 1203) < 0.5 ? -1 : 1
      const x = h.roadCenterX(z) + side * (58 + hashFloat(s, ci, cj, 1204) * 45)
      if (x >= x0 && x < x0 + POI_REGION && h.riverDistance(x, z) > 70 && clear(x, z, 160)) {
        const base = this.flatEnough(x, z, RADIUS[PoiType.Farm])
        if (base !== null) list.push({ type: PoiType.Farm, x, z, rot: side > 0 ? 0 : Math.PI, radius: RADIUS[0], baseH: base, variant: hashFloat(s, ci, cj, 1205) })
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
  if (p.type !== PoiType.Farm) return 0
  const [lx, lz] = toLocal(p, x, z)
  for (const f of FARM_FIELDS) if (lx > f[0] && lx < f[2] && lz > f[1] && lz < f[3]) return 1
  return 0
}

const NAMES: string[][] = [
  ['Sunflower Farm', 'Willow Farm', 'Meadowbrook Farm', 'Honey Hill Farm', 'Old Mill Farm', 'Clover Farm'],
  ['Lakeside Cabin', "Hunter's Cabin", 'Pinewood Cabin', "Woodcutter's Hut"],
  ['Old Ruins', 'Mossy Ruins', 'Forgotten Keep', 'Broken Chapel'],
  ["Traveller's Camp", 'Scout Camp', 'Ember Camp', 'Starlight Camp'],
]
export const POI_ICONS = ['🌾', '🏠', '🏛️', '⛺']

/** Deterministic display name of a place (HUD markers and the arrival banner). */
export function poiName(p: Poi): string {
  const n = NAMES[p.type]
  return n[Math.floor(p.variant * n.length) % n.length]
}
