import { hash4, hashFloat } from '../noise/rng'
import { dropIslands, surfaceNets, type VoxelMesh } from './surfaceNets'
import { CARVE_REACH, cavePlan, caveFloorAt, caveFootprint, caveRock, MOUTH_X, toLocal } from './caves'
import { stoneOffset } from './stone'

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
/** Bed height of the formations' layered stone (stoneOffset / stoneBed with the formation's seed). */
export const FORMATION_BED = 3.2
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
  /** HILLSIDE CAVE (Formations/caves.ts): dug into a slope, mouth facing downhill, terrain carved under its air. */
  hill?: boolean
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
  /** A secondary road within `margin` of (x, z)? (Hillside caves keep clear of them; lazily bound, the network is
   *  built from the places after the formations.) */
  netRoadNear?(x: number, z: number, margin: number): boolean
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
      // CAVES ON HILLS / CLIFFS: where the ground slopes (≥ ~14°) the cave is dug INTO the slope — the mouth here,
      // facing downhill, the chamber ~40 m in (Formations/caves.ts). Flat ground keeps the free-standing rock-hill cave.
      if (kind === FormationKind.Cave) {
        const gx = (h.height(x + 8, z) - h.height(x - 8, z)) / 16, gz = (h.height(x, z + 8) - h.height(x, z - 8)) / 16
        const g = Math.hypot(gx, gz)
        if (g > 0.42) { // ≥ ~23°: a real hillside / cliff (the hill rises fast behind the mouth)
          const rot = Math.atan2(gz / g, gx / g) // local +x = uphill
          const cxw = x - MOUTH_X * Math.cos(rot), czw = z - MOUTH_X * Math.sin(rot) // centre ~26 m in from the mouth
          const R = 48
          const my = h.height(x, z)
          if (h.roadDistance(cxw, czw) < R + 10 || h.roadDistance(x, z) < 14 || h.riverDistance(cxw, czw) < R || my < h.water + 2) continue
          if (h.placeNear(cxw, czw, R + 20) || list.some((o) => Math.hypot(o.x - cxw, o.z - czw) < o.radius + R + 20)) continue
          // No secondary road through the hill (the carve would drop the road's verge into the tunnel).
          let road = false
          for (let a = 0; a < 8 && !road; a++) road = !!h.netRoadNear?.(cxw + Math.cos(a * 0.785) * 30, czw + Math.sin(a * 0.785) * 30, 32)
          if (road || h.netRoadNear?.(cxw, czw, 40)) continue
          list.push({ kind, x: cxw, z: czw, y: my - 0.2, rot, radius: R, seed: hash4(s, ci, cj, 4105 + n), hill: true })
          continue
        }
      }
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

  private readonly _l: [number, number] = [0, 0]
  /**
   * Terrain under a HILLSIDE CAVE: the ground `h` at (x, z), carved down below the cave's air (its floor − 2.2 m)
   * where it would cut through the tunnel or the chamber — the cave's rock mesh is the floor there. Else `h`.
   */
  caveCarve(x: number, z: number, h: number): number {
    const ci = Math.floor(x / FORMATION_REGION), cj = Math.floor(z / FORMATION_REGION)
    for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) {
      for (const f of this.region(i, j)) {
        if (!f.hill || Math.abs(x - f.x) > f.radius || Math.abs(z - f.z) > f.radius) continue
        const [lx, lz] = toLocal(f, x, z, this._l)
        const p = cavePlan(f)
        if (caveFootprint(p, lx, lz) > CARVE_REACH) continue
        const floor = f.y + caveFloorAt(p, lx, lz) - 2.2
        if (h > floor) return floor
      }
    }
    return h
  }

  /** Hillside caves within `r` m of (x, z) (rendering / interaction: CaveSystem). */
  cavesNear(x: number, z: number, r: number, out: Formation[] = []): Formation[] {
    out.length = 0
    const ci = Math.floor(x / FORMATION_REGION), cj = Math.floor(z / FORMATION_REGION)
    const k = Math.ceil(r / FORMATION_REGION)
    for (let j = cj - k; j <= cj + k; j++) for (let i = ci - k; i <= ci + k; i++) {
      for (const f of this.region(i, j)) if (f.hill && Math.hypot(x - f.x, z - f.z) < r + f.radius) out.push(f)
    }
    return out
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
  // Layered, jointed stone (stoneOffset: ledges + blocks, Genshin's cliffs) over a softer large-scale lumpiness.
  const rough = (x: number, y: number, z: number, amp: number) =>
    stoneOffset(s, x, y, z, amp * 1.6, FORMATION_BED) + noise3(s, x * 0.12, y * 0.12, z * 0.12) * amp * 0.5 + noise3(s + 7, x * 0.35, y * 0.35, z * 0.35) * amp * 0.15
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
 * The formation's mesh in WORLD coordinates (rotated, on its base), at voxel size `step` (1 m near-detail, 1.25 m for hillside caves;
 * LOW builds 2.5 m — the shape is smooth, so coarse voxels mostly cost silhouette detail).
 */
export function buildFormation(f: Formation, step: number, ground?: (x: number, z: number) => number): VoxelMesh {
  const c = Math.cos(f.rot), sn = Math.sin(f.rot)
  let lo: [number, number, number], hi: [number, number, number], sdf: (x: number, y: number, z: number) => number
  if (f.hill && ground) {
    // HILLSIDE CAVE: the original ground (pre-carve) on a 2 m grid in the local frame (bilinear) → the rock cap.
    const p = cavePlan(f)
    const G = 2, gx0 = p.min[0], gz0 = p.min[1]
    const nx = Math.ceil((p.max[0] - gx0) / G) + 1, nz = Math.ceil((p.max[1] - gz0) / G) + 1
    const H = new Float32Array(nx * nz)
    let top = -Infinity
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const lx = gx0 + i * G, lz = gz0 + j * G
      const v = ground(f.x + lx * c - lz * sn, f.z + lx * sn + lz * c) - f.y
      H[j * nx + i] = v
      if (caveFootprint(p, lx, lz) < 4) top = Math.max(top, v)
    }
    const hl = (x: number, z: number) => {
      const fx = Math.min(nx - 1.001, Math.max(0, (x - gx0) / G)), fz = Math.min(nz - 1.001, Math.max(0, (z - gz0) / G))
      const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j
      return H[j * nx + i] * (1 - u) * (1 - v) + H[j * nx + i + 1] * u * (1 - v) + H[(j + 1) * nx + i] * (1 - u) * v + H[(j + 1) * nx + i + 1] * u * v
    }
    lo = [p.min[0], Math.min(p.floor, p.alcove[1], ...p.path.map((q) => q[1])) - 4, p.min[1]]
    hi = [p.max[0], Math.min(60, Math.max(top, p.chamber[1] + p.cr[1]) + 4), p.max[1]]
    sdf = caveRock(f, hl)
  } else {
    ;[lo, hi] = bounds(f)
    sdf = formationSdf(f)
  }
  const size: [number, number, number] = [Math.ceil((hi[0] - lo[0]) / step), Math.ceil((hi[1] - lo[1]) / step), Math.ceil((hi[2] - lo[2]) / step)]
  const m = dropIslands(surfaceNets(sdf, lo, size, step, f.hill ? 0.3 : step * 0.5), 150) // caves: crisp plate faces
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
