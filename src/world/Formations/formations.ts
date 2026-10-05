import { hash4, hashFloat } from '../noise/rng'
import { surfaceNets, type VoxelMesh } from './surfaceNets'

/**
 * ROCK FORMATIONS — the landmarks a heightfield can't make (Genshin's arches, caves, karst pillars, overhangs):
 * each is a small signed-distance shape meshed with surface nets (voxels → smooth mesh), placed deterministically
 * on the terrain like the places: one region grid (FORMATION_REGION m), ≤ 2 per region, off the road, out of the
 * water and away from farms / camps. Kinds by biome:
 *   ARCH      a weathered stone arch spanning ~28 m (green lands, desert sandstone, snow)
 *   CAVE      a rock hill with a TUNNEL through it — wide enough to drive through, a chamber in the middle
 *   PILLARS   a cluster of tall karst columns (Liyue's Jueyun Karst), grassy tops, ledges down their sides
 *   OUTCROP   a boulder pile with an overhanging slab you can shelter under
 * The mesh (and its trimesh collider) is built in the chunk worker of the chunk holding the formation's centre;
 * trees, rocks, grass and places keep out of its footprint. Shape noise is 3D value noise (arithmetic only).
 */
export const FormationKind = { Arch: 0, Cave: 1, Pillars: 2, Outcrop: 3 } as const
export const FORMATION_REGION = 340
/** Road segment length (m): each may hold one formation ON the road (arch over it / tunnel through a hill /
 *  pillars beside it) — landmarks you drive through, not only ones you see from a hilltop. */
export const ROAD_SEGMENT = 240

export interface Formation {
  kind: number
  x: number
  z: number
  /** Base height (m): a little below the lowest ground under the footprint (no gaps on slopes). */
  y: number
  rot: number
  /** Footprint radius (m). */
  radius: number
  seed: number
  /** Built ON the main road: an arch spanning it, or a cave hill it tunnels straight through. */
  road?: boolean
}

export interface FormationHost {
  seed: number
  height(x: number, z: number): number
  roadDistance(x: number, z: number): number
  riverDistance(x: number, z: number): number
  /** A farm / cabin / camp near (x, z) within margin? */
  placeNear(x: number, z: number, margin: number): boolean
  biome(x: number, z: number): [number, number]
  roadCenterX(z: number): number
  roadHeight(z: number): number
  water: number
}

const RADIUS = [20, 26, 24, 15]

export class FormationField {
  private readonly cache = new Map<string, Formation[]>()
  constructor(private readonly host: FormationHost) {}

  region(ci: number, cj: number): Formation[] {
    const key = `${ci},${cj}`
    let list = this.cache.get(key)
    if (list) return list
    list = []
    const h = this.host, s = h.seed
    for (let n = 0; n < 2; n++) {
      if (hashFloat(s, ci, cj, 4100 + n * 7) > (n === 0 ? 0.75 : 0.35)) continue
      const x = (ci + 0.15 + 0.7 * hashFloat(s, ci, cj, 4101 + n * 7)) * FORMATION_REGION
      const z = (cj + 0.15 + 0.7 * hashFloat(s, ci, cj, 4102 + n * 7)) * FORMATION_REGION
      const bw = h.biome(x, z)
      const r = hashFloat(s, ci, cj, 4103 + n * 7)
      // Desert: arches and pillars (sandstone); snow: caves and arches (ice-rimed); green: all four.
      const kind = bw[0] > 0.5 ? (r < 0.5 ? FormationKind.Arch : FormationKind.Pillars)
        : bw[1] > 0.5 ? (r < 0.55 ? FormationKind.Cave : FormationKind.Arch)
        : r < 0.25 ? FormationKind.Arch : r < 0.5 ? FormationKind.Cave : r < 0.78 ? FormationKind.Pillars : FormationKind.Outcrop
      const radius = RADIUS[kind]
      if (h.roadDistance(x, z) < radius + 22 || h.riverDistance(x, z) < radius + 12) continue
      if (h.placeNear(x, z, radius + 25) || list.some((f) => Math.hypot(f.x - x, f.z - z) < f.radius + radius + 20)) continue
      let lo = Infinity
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2
        lo = Math.min(lo, h.height(x + Math.cos(ang) * radius * 0.8, z + Math.sin(ang) * radius * 0.8))
      }
      lo = Math.min(lo, h.height(x, z))
      if (lo < h.water + 1.5) continue
      list.push({ kind, x, z, y: lo - 1.5, rot: hashFloat(s, ci, cj, 4104 + n * 7) * Math.PI * 2, radius, seed: hash4(s, ci, cj, 4105 + n) })
    }
    if (this.cache.size > 2000) this.cache.clear()
    this.cache.set(key, list)
    return list
  }

  private readonly roadCache = new Map<number, Formation | null>()

  /** The formation of road segment k (z in [k·ROAD_SEGMENT, (k+1)·ROAD_SEGMENT)), or null (~15 % roll none). */
  roadFormation(k: number): Formation | null {
    let f = this.roadCache.get(k)
    if (f !== undefined) return f
    f = null
    const h = this.host, s = h.seed
    // The spawn stretch stays open (the start view), every other segment rolls.
    if (Math.abs(k) >= 1 && hashFloat(s, k, 4200) < 0.85) {
      const z = (k + 0.25 + 0.5 * hashFloat(s, k, 4201)) * ROAD_SEGMENT
      const rx = h.roadCenterX(z)
      const dir = h.roadCenterX(z + 1) - h.roadCenterX(z - 1) // dx per 2 m of z
      const len = Math.hypot(dir, 2)
      const rdx = dir / len, rdz = 2 / len // road direction (unit, world x/z)
      const bw = h.biome(rx, z)
      const r = hashFloat(s, k, 4202)
      const kind = bw[0] > 0.5 ? (r < 0.6 ? FormationKind.Arch : FormationKind.Pillars)
        : bw[1] > 0.5 ? (r < 0.5 ? FormationKind.Cave : FormationKind.Arch)
        : r < 0.4 ? FormationKind.Arch : r < 0.7 ? FormationKind.Cave : FormationKind.Pillars
      const ry = h.roadHeight(z)
      if (kind === FormationKind.Pillars) {
        // Beside the road (26–34 m to one side), on the ground there.
        const side = hashFloat(s, k, 4203) < 0.5 ? -1 : 1
        const off = 26 + hashFloat(s, k, 4204) * 8
        const x = rx + side * off * rdz, zz = z - side * off * rdx
        const gy = Math.min(h.height(x, zz), h.height(x + 8, zz), h.height(x - 8, zz), h.height(x, zz + 8), h.height(x, zz - 8))
        if (gy > h.water + 1.5 && !h.placeNear(x, zz, 30)) f = { kind, x, z: zz, y: gy - 1.5, rot: hashFloat(s, k, 4205) * 6.28, radius: RADIUS[kind], seed: hash4(s, k, 4206, 1) }
      } else if (!h.placeNear(rx, z, 35) && ry > h.water + 1) {
        // Arch: its span across the road (local x ⟂ road, local z = road). Cave: the tunnel along the road (local x = road).
        const rot = kind === FormationKind.Arch ? Math.atan2(-rdx, rdz) : Math.atan2(rdz, rdx)
        f = { kind, x: rx, z, y: ry - (kind === FormationKind.Arch ? 1.5 : 0.6), rot, radius: kind === FormationKind.Cave ? 34 : 22, seed: hash4(s, k, 4206, 2), road: true }
      }
    }
    if (this.roadCache.size > 2000) this.roadCache.clear()
    this.roadCache.set(k, f)
    return f
  }

  /** Formations whose footprint (+margin) covers (x, z). */
  near(x: number, z: number, margin = 0): Formation | null {
    const ci = Math.floor(x / FORMATION_REGION), cj = Math.floor(z / FORMATION_REGION)
    for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) {
      for (const f of this.region(i, j)) if (Math.hypot(x - f.x, z - f.z) < f.radius + margin) return f
    }
    const k = Math.floor(z / ROAD_SEGMENT)
    for (let kk = k - 1; kk <= k + 1; kk++) {
      const f = this.roadFormation(kk)
      if (f && Math.hypot(x - f.x, z - f.z) < f.radius + margin) return f
    }
    return null
  }

  /** Formations whose CENTRE lies in the box (the chunk that owns their mesh). */
  centredIn(minX: number, minZ: number, maxX: number, maxZ: number): Formation[] {
    const out: Formation[] = []
    for (let j = Math.floor(minZ / FORMATION_REGION); j <= Math.floor(maxZ / FORMATION_REGION); j++) {
      for (let i = Math.floor(minX / FORMATION_REGION); i <= Math.floor(maxX / FORMATION_REGION); i++) {
        for (const f of this.region(i, j)) if (f.x >= minX && f.x < maxX && f.z >= minZ && f.z < maxZ) out.push(f)
      }
    }
    for (let k = Math.floor(minZ / ROAD_SEGMENT) - 1; k <= Math.floor(maxZ / ROAD_SEGMENT) + 1; k++) {
      const f = this.roadFormation(k)
      if (f && f.x >= minX && f.x < maxX && f.z >= minZ && f.z < maxZ) out.push(f)
    }
    return out
  }
}

// ---- shape ------------------------------------------------------------------------------------------------

/** 3D value noise in [-1, 1] (hash lattice + smooth trilinear) — arithmetic only, identical on every client. */
function noise3(seed: number, x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  const fx = x - ix, fy = y - iy, fz = z - iz
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz)
  const h = (a: number, b: number, c: number) => (hash4(seed, ix + a, iy + b, iz + c) / 4294967296) * 2 - 1
  const x00 = h(0, 0, 0) + (h(1, 0, 0) - h(0, 0, 0)) * u, x10 = h(0, 1, 0) + (h(1, 1, 0) - h(0, 1, 0)) * u
  const x01 = h(0, 0, 1) + (h(1, 0, 1) - h(0, 0, 1)) * u, x11 = h(0, 1, 1) + (h(1, 1, 1) - h(0, 1, 1)) * u
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v
  return y0 + (y1 - y0) * w
}

const sdEllipsoid = (x: number, y: number, z: number, a: number, b: number, c: number) => {
  const k0 = Math.hypot(x / a, y / b, z / c), k1 = Math.hypot(x / (a * a), y / (b * b), z / (c * c))
  return k1 > 1e-6 ? (k0 * (k0 - 1)) / k1 : -Math.min(a, b, c)
}
const sdCapsule = (x: number, y: number, z: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number) => {
  const pax = x - ax, pay = y - ay, paz = z - az, bax = bx - ax, bay = by - ay, baz = bz - az
  const t = Math.max(0, Math.min(1, (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz)))
  return Math.hypot(pax - bax * t, pay - bay * t, paz - baz * t) - r
}
const smin = (a: number, b: number, k: number) => {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k))
  return b + (a - b) * h - k * h * (1 - h)
}

/** Signed distance of a formation in its local frame (origin on the base, y up, x along its axis). */
export function formationSdf(f: Formation): (x: number, y: number, z: number) => number {
  const s = f.seed
  const rough = (x: number, y: number, z: number, amp: number) =>
    noise3(s, x * 0.12, y * 0.12, z * 0.12) * amp + noise3(s + 7, x * 0.35, y * 0.35, z * 0.35) * amp * 0.35
  switch (f.kind) {
    case FormationKind.Arch: {
      // A vertical half-ring (torus in the x–y plane) whose feet sink into the ground, thickest at the feet.
      const R = 13 + ((s >>> 0) % 5), r = 4.2
      return (x, y, z) => {
        const q = Math.hypot(x, y - 1) - R
        const thick = r + Math.max(0, 6 - y) * 0.35
        return Math.max(Math.hypot(q, z * 1.25) - thick, -y - 3) + rough(x, y, z, 1.6)
      }
    }
    case FormationKind.Cave: {
      if (f.road) {
        // ROAD TUNNEL: a long rock hill the road runs straight through (local x = the road) — a 5.6 m-radius bore
        // whose floor lies below the road bed, so the road itself is the floor.
        return (x, y, z) => {
          const hill = sdEllipsoid(x, y - 2, z, 34, 15, 17) + rough(x, y, z, 2.4)
          const bore = sdCapsule(x, y, z, -46, 2.6, 0, 46, 2.6, 0, 5.6) + noise3(s + 3, x * 0.2, y * 0.2, z * 0.2) * 0.5
          return Math.max(hill, -bore)
        }
      }
      // Rock hill with a drivable tunnel (5 m radius, floor below ground → the terrain is the floor) and a chamber.
      return (x, y, z) => {
        const hill = sdEllipsoid(x, y - 2, z, 22, 15, 17) + rough(x, y, z, 2.2)
        const tunnel = sdCapsule(x, y, z, -32, 2.5, -3, 32, 2.5, 3, 5.2) + noise3(s + 3, x * 0.2, y * 0.2, z * 0.2) * 0.8
        const chamber = sdEllipsoid(x, y - 4, z, 9, 7, 8)
        return Math.max(hill, -Math.min(tunnel, chamber))
      }
    }
    case FormationKind.Pillars: {
      // 4–6 karst columns of 22–48 m, leaning a little, banded ledges, flat grassy tops.
      const cols: [number, number, number, number, number][] = []
      const n = 4 + (s % 3)
      for (let i = 0; i < n; i++) {
        // Unsigned shifts (>>>): the seed is a uint32 — a signed >> made some heights / radii negative.
        const a = (i / n) * Math.PI * 2 + ((s >>> (i * 3)) % 7) * 0.2
        const d = i === 0 ? 0 : 8 + ((s >>> (i * 2)) % 9)
        const hgt = 22 + ((s >>> (i * 4)) % 27)
        cols.push([Math.cos(a) * d, Math.sin(a) * d, hgt, 4 + ((s >>> i) % 4), (((s >>> (i * 5)) % 5) - 2) * 0.03])
      }
      return (x, y, z) => {
        let d = 1e9
        for (const [cx, cz, hgt, rad, lean] of cols) {
          const ox = x - cx - y * lean, oz = z - cz
          const taper = rad * (1 - 0.25 * Math.min(1, Math.max(0, y) / hgt))
          const ledges = Math.max(0, Math.sin(y * 0.55 + cx) * 0.9)
          const side = Math.hypot(ox, oz) - taper - ledges
          d = smin(d, Math.max(side, y - hgt, -y - 4), 2.5)
        }
        return d + rough(x, y, z, 1.2)
      }
    }
    default: {
      // Boulder pile with a tilted overhanging slab on top.
      return (x, y, z) => {
        const a = sdEllipsoid(x + 3, y - 2, z, 8, 6, 7)
        const b = sdEllipsoid(x - 5, y - 1, z + 3, 6, 5, 6)
        const c = sdEllipsoid(x - 1, y - 1, z - 6, 5, 4, 5)
        const slab = sdEllipsoid(x - 4, y - 8.5 - x * 0.12, z, 12, 1.8, 7)
        return smin(smin(smin(a, b, 2.5), c, 2.5), slab, 1.5) + rough(x, y, z, 1.4)
      }
    }
  }
}

/** Local bounds (min, max) of each kind (generous; the mesher's grid). */
function bounds(f: Formation): [[number, number, number], [number, number, number]] {
  switch (f.kind) {
    case FormationKind.Arch: return [[-24, -4, -8], [24, 22, 8]]
    case FormationKind.Cave: return f.road ? [[-38, -4, -20], [38, 20, 20]] : [[-26, -4, -21], [26, 20, 21]]
    case FormationKind.Pillars: return [[-24, -5, -24], [24, 52, 24]]
    default: return [[-16, -3, -14], [16, 13, 14]]
  }
}

/**
 * The formation's mesh in WORLD coordinates (rotated, on its base), at voxel size `step` (1.5 m near-detail;
 * LOW builds 2.5 m — the shape is smooth, so coarse voxels mostly cost silhouette detail).
 */
export function buildFormation(f: Formation, step: number): VoxelMesh {
  const [lo, hi] = bounds(f)
  const size: [number, number, number] = [Math.ceil((hi[0] - lo[0]) / step), Math.ceil((hi[1] - lo[1]) / step), Math.ceil((hi[2] - lo[2]) / step)]
  const m = surfaceNets(formationSdf(f), lo, size, step)
  const c = Math.cos(f.rot), sn = Math.sin(f.rot)
  for (let i = 0; i < m.positions.length; i += 3) {
    const x = m.positions[i], z = m.positions[i + 2], nx = m.normals[i], nz = m.normals[i + 2]
    m.positions[i] = f.x + x * c - z * sn
    m.positions[i + 1] += f.y
    m.positions[i + 2] = f.z + x * sn + z * c
    m.normals[i] = nx * c - nz * sn
    m.normals[i + 2] = nx * sn + nz * c
  }
  return m
}
