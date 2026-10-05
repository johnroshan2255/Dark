import { hashFloat } from '../noise/rng'

/**
 * LANDMARKS — what makes Genshin's world a set of PLACES instead of a road with trees: big, readable silhouettes
 * on the high ground that you see from far away and travel toward (Windrise's giant oak, Springvale's windmill,
 * the Thousand Winds ruins, a Statue of the Seven, Mondstadt's watchtowers; Sumeru's obelisks and gates;
 * Dragonspine's frosted giants and ice spires).
 *
 * Deterministic and global like the places: one LANDMARK_REGION grid, ≤ 1 landmark per region, put on the
 * HIGHEST suitable point of a 4×4 candidate grid (hilltops, plateau rims — where Genshin puts them), off the road,
 * the river, places and rock formations, never in the water. Kind by biome. The home landmark stands in view
 * ahead of the spawn so every game opens on one. No ground shaping: each sits on the lowest ground under its
 * footprint and its foundation reaches down (`LandmarkSystem` renders them, out to the tier's view distance,
 * with colliders when near).
 */
export const LandmarkKind = { GiantTree: 0, Windmill: 1, Ruins: 2, Statue: 3, Tower: 4, Obelisk: 5, Gate: 6, FrostTree: 7, IceSpire: 8 } as const
export const LANDMARK_REGION = 700

export interface Landmark {
  kind: number
  x: number
  z: number
  /** Base height: the lowest ground under the footprint (the foundation extends below it). */
  y: number
  rot: number
  /** Footprint radius (m): trees, grass and props keep out of it. */
  radius: number
  /** Hash for per-landmark variety (name, broken columns…). */
  variant: number
}

export interface LandmarkHost {
  seed: number
  height(x: number, z: number): number
  roadDistance(x: number, z: number): number
  riverDistance(x: number, z: number): number
  placeNear(x: number, z: number, margin: number): boolean
  formationNear(x: number, z: number, margin: number): boolean
  biome(x: number, z: number): [number, number]
  roadCenterX(z: number): number
  water: number
}

/** Per-kind size multiplier on the base meshes (landmarkGeometry) — giant tree ~64 m tall, tower ~50 m. */
export const LANDMARK_SCALE = [2, 1.3, 1.2, 1.6, 1.4, 1.4, 1.3, 1.6, 1.5]
export const LANDMARK_RADIUS = [26, 9, 18, 11, 10, 8, 13, 17, 13]
export const LANDMARK_ICONS = ['🌳', '🌬️', '🏛️', '🗿', '🗼', '🔺', '⛩️', '🌲', '❄️']
const NAMES: string[][] = [
  ['Windrise Oak', 'Elder Tree', 'Old Guardian Oak', 'The Great Bough'],
  ['Hillcrest Windmill', 'Old Mill', 'Breezy Windmill', 'Sunny Mill'],
  ['Temple of Winds', 'Fallen Colonnade', 'Ancient Ruins', 'Forgotten Temple'],
  ['Statue of the Wind', 'Watcher Statue', 'Shrine Statue', 'Old Statue'],
  ['Stone Watchtower', 'Lookout Tower', 'Old Keep Tower', 'Ridge Tower'],
  ['Sun Obelisk', 'Desert Needle', 'Glyph Obelisk', 'Sand Spire'],
  ['Gate of Sands', 'Ruined Gate', 'Old Desert Gate', 'Dune Gate'],
  ['Frostbearing Tree', 'Snowcrown Pine', 'Frozen Giant', 'Winter Elder'],
  ['Ice Spire', 'Crystal Peak', 'Frost Shards', 'Glacier Spike'],
]

/** Deterministic display name (compass + arrival banner). */
export function landmarkName(l: Landmark): string {
  const n = NAMES[l.kind]
  return n[Math.floor(l.variant * n.length) % n.length]
}

export class LandmarkField {
  private readonly cache = new Map<string, Landmark[]>()
  private homeMark: Landmark | null | undefined
  constructor(private readonly host: LandmarkHost) {}

  /** Footprint check: dry, clear of road / river / places / formations; returns the base height or null. */
  private fit(x: number, z: number, r: number): number | null {
    const h = this.host
    if (h.roadDistance(x, z) < r + 30 || h.riverDistance(x, z) < r + 28) return null
    if (h.placeNear(x, z, r + 20) || h.formationNear(x, z, r + 8)) return null
    let lo = h.height(x, z), hi = lo
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      const g = h.height(x + Math.cos(a) * r * 0.8, z + Math.sin(a) * r * 0.8)
      lo = Math.min(lo, g); hi = Math.max(hi, g)
    }
    // Some slope is fine (foundations reach 4–5 m down; half-buried on a hillside is right), a cliff edge is not.
    if (lo < h.water + 1.5 || hi - lo > 6) return null
    return lo - 0.3
  }

  private kindFor(x: number, z: number, t: number): number {
    const [sand, snow] = this.host.biome(x, z)
    if (sand > 0.5) return t < 0.55 ? LandmarkKind.Obelisk : LandmarkKind.Gate
    if (snow > 0.5) return t < 0.45 ? LandmarkKind.FrostTree : t < 0.8 ? LandmarkKind.IceSpire : LandmarkKind.Tower
    if (sand > 0.15 || snow > 0.15) return LandmarkKind.Tower
    return t < 0.24 ? LandmarkKind.GiantTree : t < 0.44 ? LandmarkKind.Windmill : t < 0.66 ? LandmarkKind.Ruins : t < 0.82 ? LandmarkKind.Statue : LandmarkKind.Tower
  }

  /**
   * HOME landmark: a giant oak (Windrise) on the highest fitting ground 180–800 m ahead of the spawn, 70–300 m
   * to a side of the road, with its crown in clear sight from the spawn — the game opens looking at it (Game),
   * somewhere to go instead of down an endless road.
   */
  home(): Landmark | null {
    if (this.homeMark !== undefined) return this.homeMark
    const h = this.host, s = h.seed
    this.homeMark = null
    // Visible from the spawn wins over merely high; with no visible spot, the best hidden one.
    let best = -Infinity
    for (let z = 180; z <= 800; z += 30) {
      for (const side of [-1, 1]) {
        for (let d = 70; d <= 300; d += 30) {
          const x = h.roadCenterX(z) + side * d
          const y = this.fit(x, z, 18)
          if (y === null) continue
          const seen = this.seenFromSpawn(x, z, y + 50)
          const score = (seen ? 1000 : 0) + y - Math.hypot(x, z) * 0.03 + hashFloat(s, Math.round(x), Math.round(z), 2601) * 4
          if (score > best) {
            best = score
            this.homeMark = { kind: LandmarkKind.GiantTree, x, z, y, rot: hashFloat(s, 2602) * Math.PI * 2, radius: LANDMARK_RADIUS[0], variant: hashFloat(s, 2603) * 0.25 }
          }
        }
      }
    }
    return this.homeMark
  }

  /** Clear line of sight from the spawn's eye (road at z = 8) to (x, y, z)? Sampled every ~10 m with 2 m slack. */
  private seenFromSpawn(x: number, z: number, y: number): boolean {
    const h = this.host
    const sx = h.roadCenterX(8), sz = 8, sy = h.height(sx, sz) + 1.7
    const n = Math.ceil(Math.hypot(x - sx, z - sz) / 10)
    for (let i = 1; i < n; i++) {
      const t = i / n
      if (h.height(sx + (x - sx) * t, sz + (z - sz) * t) > sy + (y - sy) * t - 2) return false
    }
    return true
  }

  region(ci: number, cj: number): Landmark[] {
    const key = `${ci},${cj}`
    let list = this.cache.get(key)
    if (list) return list
    list = []
    const h = this.host, s = h.seed
    const hm = this.home()
    const inHere = (l: Landmark) => Math.floor(l.x / LANDMARK_REGION) === ci && Math.floor(l.z / LANDMARK_REGION) === cj
    if (hm && inHere(hm)) list.push(hm)
    else if (hashFloat(s, ci, cj, 2610) < 0.8) {
      // Highest fitting candidate first (with the largest footprint), then the kind from the biome THERE.
      let bx = 0, bz = 0, by = -Infinity
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          const x = (ci + 0.15 + 0.7 * ((i + hashFloat(s, ci * 8 + i, cj * 8 + j, 2612)) / 4)) * LANDMARK_REGION
          const z = (cj + 0.15 + 0.7 * ((j + hashFloat(s, ci * 8 + i, cj * 8 + j, 2613)) / 4)) * LANDMARK_REGION
          if (hm && Math.hypot(hm.x - x, hm.z - z) < 400) continue
          const y = this.fit(x, z, 15)
          if (y !== null && y > by) { bx = x; bz = z; by = y }
        }
      }
      if (by > -Infinity) {
        const kind = this.kindFor(bx, bz, hashFloat(s, ci, cj, 2611))
        list.push({ kind, x: bx, z: bz, y: by, rot: hashFloat(s, ci, cj, 2614) * Math.PI * 2, radius: LANDMARK_RADIUS[kind], variant: hashFloat(s, ci, cj, 2615) })
      }
    }
    if (this.cache.size > 2000) this.cache.clear()
    this.cache.set(key, list)
    return list
  }

  /** The landmark whose footprint (+margin) covers (x, z), or null. */
  near(x: number, z: number, margin = 0): Landmark | null {
    const ci = Math.floor(x / LANDMARK_REGION), cj = Math.floor(z / LANDMARK_REGION)
    for (let j = cj - 1; j <= cj + 1; j++) {
      for (let i = ci - 1; i <= ci + 1; i++) {
        for (const l of this.region(i, j)) if (Math.hypot(x - l.x, z - l.z) < l.radius + margin) return l
      }
    }
    return null
  }

  /** All landmarks inside the box. */
  inBox(minX: number, minZ: number, maxX: number, maxZ: number): Landmark[] {
    const out: Landmark[] = []
    for (let j = Math.floor(minZ / LANDMARK_REGION); j <= Math.floor(maxZ / LANDMARK_REGION); j++) {
      for (let i = Math.floor(minX / LANDMARK_REGION); i <= Math.floor(maxX / LANDMARK_REGION); i++) {
        for (const l of this.region(i, j)) if (l.x >= minX && l.x <= maxX && l.z >= minZ && l.z <= maxZ) out.push(l)
      }
    }
    return out
  }
}
