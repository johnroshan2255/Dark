import { hash4 } from '../noise/rng'
import type { Formation } from './formations'
import { plateOffset, plateTone, stoneOffset } from './stone'

/**
 * HILLSIDE CAVES (Genshin's overworld caves): a dark arched MOUTH in a hillside / cliff, a WINDING tunnel sloping
 * down into a big CHAMBER — stalactites and stalagmites, a still POOL in a basin, one or two SKYLIGHTS letting
 * sunbeams in, glowing CRYSTAL clusters on the walls — and a narrow side passage to a hidden ALCOVE with a treasure
 * chest. Everything derives from the formation's seed (hash-based, identical on every client and in the workers).
 *
 * How it sits in a heightfield world: the terrain is CARVED below the cave's air (WorldFields.height → caveCarve), and
 * a rock CAP follows the hill's own surface 1.6 m above the original ground over the whole footprint — so from outside
 * it is a rocky outcrop on the hillside (grass grows on its top), the tunnel is carved through that cap, and nothing
 * of the carved terrain is ever visible. The rock mesh is the floor, walls and roof (surface nets + trimesh collider,
 * like every formation).
 *
 * Local frame (as every formation): origin at (f.x, f.y, f.z), +x = INTO the hill (uphill), y up. The mouth is at
 * x = MOUTH_X.
 */
export interface CavePlan {
  /** Tunnel FLOOR points (local) and the tunnel radius at each: mouth → … → chamber. */
  path: [number, number, number][]
  radius: number[]
  /** Chamber: centre and radii (x, y, z); its floor height. */
  chamber: [number, number, number]
  cr: [number, number, number]
  floor: number
  /**
   * The chamber's VAULT (Genshin's caverns: sheer walls, then a high dark roof): upright walls `wallH` m tall around
   * an irregular plan (bays: the radius × 1 + l0·sin(3a + l1) + l2·sin(5a + l3)), then a dome `roofH` m high.
   */
  wallH: number
  roofH: number
  lobes: [number, number, number, number]
  /** Side passage (chamber edge → alcove) and the alcove (centre on its floor, radius). */
  side: [[number, number, number], [number, number, number]]
  alcove: [number, number, number]
  alcoveR: number
  /** Skylights: [x, z, radius] (vertical shafts from the chamber ceiling to the sky). */
  holes: [number, number, number][]
  /** Pool: [x, z, rx, rz] in a basin in the chamber floor; water surface height. */
  pool: [number, number, number, number]
  waterY: number
  /** Stalactites (hanging, [x, top y, z, r, length]) and stalagmites ([x, base y, z, r, height]). */
  stalactites: [number, number, number, number, number][]
  stalagmites: [number, number, number, number, number][]
  /** Crystal clusters on the walls: position + outward normal (local) + hue (CrystalHue). */
  crystals: [number, number, number, number, number, number, number][]
  /** Fallen blocks at the foot of the walls: centre, half sizes, yaw (angular rounded boxes, part of the collider). */
  rubble: [number, number, number, number, number, number, number][]
  /** Cumulative tunnel length at each path point (light falls off with the walk in). */
  along: number[]
  /** Local bounds of the air (x/z) for the footprint, with the cap margin. */
  min: [number, number]
  max: [number, number]
}

export const MOUTH_X = -26
/** Crystal colours (Genshin's ores): cyan Crystal Chunk, deep-blue Magical Crystal, violet Amethyst. */
export const CrystalHue = { Cyan: 0, Blue: 1, Violet: 2 } as const
const CAP_H = 1.6
const CAP_MARGIN = 3
/**
 * The terrain is carved (deep below the floor) out to CARVE_REACH m beyond the air's footprint: a terrain triangle
 * spans ≤ 2.8 m, so the steep sliver between a carved and an uncarved grid point stays ≥ 1.7 m clear of the rough
 * air (it reaches ~1.5 m past the footprint) — no terrain blades inside the cave. Below the natural ground, the rock
 * is SOLID out to SOLID_REACH (> CARVE_REACH + 2.8), so the carve never shows as a pit beyond the cap's rough rim.
 */
export const CARVE_REACH = 4.5
const SOLID_REACH = 7.6
/** The chamber's wall radius / its plan radius (cr): the bays reach out to ~VAULT × 1.16. */
const VAULT = 0.84
/** The interior walls' plates (plateOffset): plate size in plan and bed height, m. */
const WALL_CELL = 3.4, WALL_BED = 2.6
/** Bed height of the cave's outer stone (stoneOffset / stoneBed with seed + 5). */
export const STONE_BED = 3.4

const plans = new Map<number, CavePlan>()

/** The cave of a (hill-cave) formation: deterministic from its seed, cached. */
export function cavePlan(f: Formation): CavePlan {
  let p = plans.get(f.seed)
  if (p) return p
  const s = f.seed
  let k = 0
  const rnd = () => hash4(s, 7001, k++, 3) / 4294967296
  const rng = (a: number, b: number) => a + (b - a) * rnd()
  // Tunnel: mouth → 2 bends → chamber, sloping down 3–6 m.
  const r0 = rng(3.8, 4.6)
  const path: [number, number, number][] = [[MOUTH_X - 2, 0.2, 0]]
  path.push([MOUTH_X + 3, 0.2, 0])
  path.push([-12, -rng(0.5, 1.6), rng(-6, 6)])
  path.push([0, -rng(2.2, 3.6), rng(-7, 7)])
  const radius = [r0, r0, rng(3.6, 4.4), rng(3.8, 4.6)]
  const cr: [number, number, number] = [rng(13, 16), rng(9, 11.5), rng(11, 14)]
  const last = path[path.length - 1]
  const floor = last[1] - rng(1, 2)
  const chamber: [number, number, number] = [last[0] + cr[0] * 0.85, floor + cr[1] * 0.6, last[2] + rng(-3, 3)]
  const wallH = rng(5, 7), roofH = cr[1] * 1.55 - wallH
  const lobes: [number, number, number, number] = [rng(0.05, 0.1), rnd() * 6.28, rng(0.03, 0.06), rnd() * 6.28]
  // Side passage to the hidden alcove (off the chamber's far side, left or right).
  const side = rnd() < 0.5 ? -1 : 1
  const sa: [number, number, number] = [chamber[0] + cr[0] * 0.35, floor, chamber[2] + side * cr[2] * 0.7]
  const alcove: [number, number, number] = [sa[0] + rng(4, 8), floor + rng(-0.5, 1.5), sa[2] + side * rng(9, 12)]
  // Skylights over the chamber (1–2).
  const holes: [number, number, number][] = []
  const nh = rnd() < 0.55 ? 2 : 1
  for (let i = 0; i < nh; i++) holes.push([chamber[0] + rng(-0.45, 0.45) * cr[0], chamber[2] + rng(-0.4, 0.4) * cr[2], rng(2.2, 3.4)])
  // Pool basin on the floor, away from the entrance side and the alcove passage.
  const pool: [number, number, number, number] = [chamber[0] + rng(-0.1, 0.35) * cr[0], chamber[2] - side * rng(0.2, 0.4) * cr[2], rng(3.8, 5.5), rng(3.2, 4.5)]
  const waterY = floor - 0.45
  // Stalactites over the chamber, stalagmites around its edge.
  const ceil = (x: number, z: number) => floor + wallH + roofH * Math.sqrt(Math.max(0, 1 - ((x - chamber[0]) / (cr[0] * VAULT)) ** 2 - ((z - chamber[2]) / (cr[2] * VAULT)) ** 2))
  const stalactites: [number, number, number, number, number][] = []
  for (let i = 0; i < 12; i++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * 0.75
    const x = chamber[0] + Math.cos(a) * d * cr[0], z = chamber[2] + Math.sin(a) * d * cr[2]
    if (holes.some(([hx, hz, hr]) => Math.hypot(x - hx, z - hz) < hr + 2.5)) continue
    stalactites.push([x, ceil(x, z) + 0.8, z, rng(1.0, 1.7), rng(3, 6.5)])
  }
  const stalagmites: [number, number, number, number, number][] = []
  for (let i = 0; i < 10; i++) {
    const a = rnd() * Math.PI * 2, d = rng(0.45, 0.68)
    const x = chamber[0] + Math.cos(a) * d * cr[0], z = chamber[2] + Math.sin(a) * d * cr[2]
    if (Math.hypot(x - pool[0], z - pool[1]) < Math.max(pool[2], pool[3]) + 1.5) continue
    if (x < chamber[0] - cr[0] * 0.5 && Math.abs(z - last[2]) < 6) continue // keep the way in clear
    if (Math.hypot(x - sa[0], z - sa[2]) < 5) continue // and the side passage
    stalagmites.push([x, floor - 0.4, z, rng(0.9, 1.5), rng(2, 4.5)])
  }
  const along = [0]
  for (let i = 1; i < path.length; i++) along.push(along[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]))
  let mnx = Infinity, mnz = Infinity, mxx = -Infinity, mxz = -Infinity
  const grow = (x: number, z: number, r: number) => { mnx = Math.min(mnx, x - r); mxx = Math.max(mxx, x + r); mnz = Math.min(mnz, z - r); mxz = Math.max(mxz, z + r) }
  path.forEach((q, i) => grow(q[0], q[2], radius[i]))
  grow(chamber[0], chamber[2], Math.max(cr[0], cr[2]))
  grow(alcove[0], alcove[2], 5)
  p = {
    path, radius, chamber, cr, floor, wallH, roofH, lobes, side: [sa, alcove], alcove, alcoveR: rng(4.2, 5.2), holes, pool, waterY,
    stalactites, stalagmites, crystals: [], rubble: [], along, min: [mnx - SOLID_REACH - 1.5, mnz - SOLID_REACH - 1.5], max: [mxx + SOLID_REACH + 1.5, mxz + SOLID_REACH + 1.5],
  }
  p.crystals = placeCrystals(p, rnd, s)
  p.rubble = placeRubble(p, rnd, s)
  if (plans.size > 64) plans.clear()
  plans.set(f.seed, p)
  return p
}

// ---- distance helpers --------------------------------------------------------------------------------------
const segT = (x: number, y: number, z: number, a: number[], b: number[]) => {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2]
  return Math.max(0, Math.min(1, ((x - a[0]) * bx + (y - a[1]) * by + (z - a[2]) * bz) / (bx * bx + by * by + bz * bz)))
}
const ell = (x: number, y: number, z: number, a: number, b: number, c: number) => {
  const k0 = Math.hypot(x / a, y / b, z / c), k1 = Math.hypot(x / (a * a), y / (b * b), z / (c * c))
  return k1 > 1e-6 ? (k0 * (k0 - 1)) / k1 : -Math.min(a, b, c)
}
/** Rounded box: centre offset (x, y, z), half sizes (a, b, c), corner radius r. */
const rbox = (x: number, y: number, z: number, a: number, b: number, c: number, r: number) => {
  const qx = Math.abs(x) - a + r, qy = Math.abs(y) - b + r, qz = Math.abs(z) - c + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r
}
/**
 * A faceted SPIKE (stalactite / stalagmite): a hexagonal pyramid, base radius r at h = 0 tapering to a blunt tip at
 * h = L (h = height along it), rotated by `rot` about its axis — chunky facets like Genshin's, not a smooth drip.
 */
const spike = (x: number, h: number, z: number, r: number, L: number, rot: number) => {
  const c = Math.cos(rot), s = Math.sin(rot)
  const u = Math.abs(x * c + z * s), v = Math.abs(-x * s + z * c)
  const hex = Math.max(u * 0.866 + v * 0.5, v)
  const t = Math.min(1, Math.max(0, h / L))
  return Math.max((hex - (r * (1 - t) + 0.12)) * 0.9, -h - 1, h - L)
}
const smin = (a: number, b: number, k: number) => {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k))
  return b + (a - b) * h - k * h * (1 - h)
}
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

/**
 * The cave's AIR (negative inside): tunnels with flat floors, the chamber, the pool basin, the side passage, the
 * alcove and the skylight shafts, smoothly joined, walls roughened. `rough` = 0 skips the noise (cheap queries).
 */
export function caveAir(p: CavePlan, seed: number, x: number, y: number, z: number, rough = 1): number {
  let d = 1e9
  // The floor of the nearest air piece: the roughness fades out toward it (a walkable floor, rough walls and roof).
  // And its radius (narrow passages get gentler relief: a 2.4 m passage must stay walkable) and its wall distance
  // (where the FLOOR is the nearer surface the relief stays off: no rock rising out of the floor).
  // The walking routes keep a smooth CORE (each piece shrunk by `m` m, same floor) that the relief can never close:
  // ≥ 3.2 m of headroom and ≥ 2.7 m of width through the tunnel, the side passage and the alcove.
  let near = 1e9, fl0 = p.floor, r0 = 10, sh0 = 0, core = 1e9
  const track = (sh: number, fl: number, R: number, m: number) => {
    const di = Math.max(sh, fl - y)
    if (di < near) (near = di), (fl0 = fl), (r0 = R), (sh0 = sh)
    if (m > 0) core = Math.min(core, Math.max(sh + m, fl - y))
    return di
  }
  for (let i = 0; i < p.path.length - 1; i++) {
    const a = p.path[i], b = p.path[i + 1]
    const R = (p.radius[i] + p.radius[i + 1]) / 2
    const t = segT(x, y - 0.55 * R, z, a, b)
    const cx = a[0] + (b[0] - a[0]) * t, cy = a[1] + (b[1] - a[1]) * t + 0.55 * R, cz = a[2] + (b[2] - a[2]) * t
    const fl = a[1] + (b[1] - a[1]) * t
    const di = track(Math.hypot(x - cx, y - cy, z - cz) - R, fl, R, R * 0.55)
    d = smin(d, di, 2.5)
  }
  // Last tunnel point → chamber (wide throat).
  {
    const a = p.path[p.path.length - 1], c = p.chamber
    const b = [c[0] - p.cr[0] * 0.6, p.floor, c[2]]
    const R = p.radius[p.radius.length - 1] * 1.15
    const t = segT(x, y - 0.55 * R, z, a, b)
    const cx = a[0] + (b[0] - a[0]) * t, cy = a[1] + (b[1] - a[1]) * t + 0.55 * R, cz = a[2] + (b[2] - a[2]) * t
    const fl = a[1] + (b[1] - a[1]) * t
    const di = track(Math.hypot(x - cx, y - cy, z - cz) - R, fl, R, R * 0.55)
    d = smin(d, di, 3)
  }
  const c = p.chamber, cr = p.cr
  {
    // The VAULT: sheer walls (an elliptic cylinder with bays) up to wallH, then the dome; flat floor.
    const dx = x - c[0], dz = z - c[2], a = Math.atan2(dz * cr[0], dx * cr[2]), lb = p.lobes
    const bay = VAULT * (1 + lb[0] * Math.sin(3 * a + lb[1]) + lb[2] * Math.sin(5 * a + lb[3]))
    const di = track(ell(dx, Math.max(0, y - p.floor - p.wallH), dz, cr[0] * bay, p.roofH, cr[2] * bay), p.floor, 10, 0)
    d = smin(d, di, 2.2)
  }
  // Pool basin (below the floor).
  d = Math.min(d, ell(x - p.pool[0], y - p.floor, z - p.pool[1], p.pool[2], 1.6, p.pool[3]))
  // Side passage (narrow, 2.4 m) and the alcove.
  {
    const [a, b] = p.side
    const R = 2.4
    const t = segT(x, y - 1.3, z, a, b)
    const cx = a[0] + (b[0] - a[0]) * t, cy = a[1] + (b[1] - a[1]) * t + 1.3, cz = a[2] + (b[2] - a[2]) * t
    const fl = a[1] + (b[1] - a[1]) * t
    const di = track(Math.hypot(x - cx, y - cy, z - cz) - R, fl, R, 0.45)
    d = smin(d, di, 1.5)
    const al = p.alcove
    const da = track(ell(x - al[0], y - al[1] - 1.6, z - al[2], p.alcoveR, 3.4, p.alcoveR), al[1], p.alcoveR, 1.8)
    d = smin(d, da, 1.5)
  }
  // Skylights: vertical shafts from the ceiling to the sky.
  for (const [hx, hz, hr] of p.holes) {
    if (y > c[1]) d = Math.min(d, Math.hypot(x - hx, z - hz) - hr * (1 + 0.15 * Math.max(0, y - c[1] - cr[1]) / 10))
  }
  // Far from the wall (the relief is ≤ ~2.6 m) the rough field can't change sign: skip it (most of the grid).
  if (!rough || d > 6 || d < -6) return d
  // PLATED walls (Genshin's cave stone, plateOffset: upright angular plates ±1.7 m, ledges, each face its own tilt),
  // biased INTO the rock (+0.25·amp: the air never bulges more than ~1 m past its plan — the terrain carve reaches
  // CARVE_REACH beyond it) + a little noise; full ≥ 2.5 m above the floor, ~12 % on it (≤ ±0.2 m: the player's
  // 0.45 m autostep climbs it); gentler in narrow passages (r0).
  const wall = Math.min(1, Math.max(0, (sh0 - (fl0 - y) + 1.5) / 1.5))
  const k = (0.12 + 0.88 * Math.min(1, Math.max(0, (y - fl0 - 0.3) / 2.2)) * wall) * Math.min(1, Math.max(0.18, (r0 - 1.9) / 2.6))
  const amp = 3.4
  const rd = d + (plateOffset(seed + 21, x, y, z, amp, WALL_CELL, WALL_BED) + amp * 0.25 + noise3(seed + 11, x * 0.22, y * 0.22, z * 0.22) * 0.3 + noise3(seed + 12, x * 0.7, y * 0.7, z * 0.7) * 0.12) * k
  return Math.min(rd, core)
}

/** The shade of the wall plate at a local point (0..1): its block's own tone (plateTone, same cells as caveAir). */
export const caveWallTone = (seed: number, x: number, y: number, z: number) => plateTone(seed + 21, x, y, z, WALL_CELL, WALL_BED)

/** Horizontal distance (m) to the cave's air footprint (negative inside). */
export function caveFootprint(p: CavePlan, x: number, z: number): number {
  let d = 1e9
  for (let i = 0; i < p.path.length - 1; i++) {
    const a = p.path[i], b = p.path[i + 1]
    const t = segT(x, 0, z, [a[0], 0, a[2]], [b[0], 0, b[2]])
    d = Math.min(d, Math.hypot(x - (a[0] + (b[0] - a[0]) * t), z - (a[2] + (b[2] - a[2]) * t)) - Math.max(p.radius[i], p.radius[i + 1]))
  }
  const a = p.path[p.path.length - 1], c = p.chamber
  {
    const t = segT(x, 0, z, [a[0], 0, a[2]], [c[0], 0, c[2]])
    d = Math.min(d, Math.hypot(x - (a[0] + (c[0] - a[0]) * t), z - (a[2] + (c[2] - a[2]) * t)) - p.radius[p.radius.length - 1] * 1.2)
  }
  d = Math.min(d, (Math.hypot((x - c[0]) / p.cr[0], (z - c[2]) / p.cr[2]) - 1) * Math.min(p.cr[0], p.cr[2]))
  {
    const [sa, sb] = p.side
    const t = segT(x, 0, z, [sa[0], 0, sa[2]], [sb[0], 0, sb[2]])
    d = Math.min(d, Math.hypot(x - (sa[0] + (sb[0] - sa[0]) * t), z - (sa[2] + (sb[2] - sa[2]) * t)) - 2.6)
    d = Math.min(d, Math.hypot(x - p.alcove[0], z - p.alcove[2]) - p.alcoveR)
  }
  return d
}

/** Lowest air floor under (x, z) (local) — the terrain is carved below it. */
export function caveFloorAt(p: CavePlan, x: number, z: number): number {
  let best = p.floor - 1.8 // the pool basin is the deepest part of the chamber
  for (let i = 0; i < p.path.length - 1; i++) {
    const a = p.path[i], b = p.path[i + 1]
    const t = segT(x, 0, z, [a[0], 0, a[2]], [b[0], 0, b[2]])
    if (Math.hypot(x - (a[0] + (b[0] - a[0]) * t), z - (a[2] + (b[2] - a[2]) * t)) < p.radius[i] + 4) best = Math.min(best, a[1] + (b[1] - a[1]) * t)
  }
  return Math.min(best, p.alcove[1])
}

/** Rock kept over the cave's air (m): ≥ 2 voxels (1.25 m) plus the stone relief, so the roof always meshes closed. */
const ROOF_T = 3.2
/** The raised roof's flanks fall ~1.1 m per m (a steep rocky knoll) and reach ≤ DOME_REACH m past the air. */
const DOME_SLOPE = 1.1, DOME_REACH = 7

const roofs = new Map<number, ((x: number, z: number) => number) & { max: number }>()
/**
 * The cave's ROOF height (local) per column: the top of its air + ROOF_T, falling away at DOME_SLOPE beyond it — on a
 * 2 m grid. Where the hill above the cave is lower than this (a tall chamber vault under a ridge or a shoulder), the
 * rock cap is RAISED to it (caveRock): the cave reads as a rocky knoll on the hillside instead of its air bursting out
 * through the hill (open cracks to the sky, the blue interior plates showing outside) or a roof thinner than a voxel
 * (holes in the mesh). The skylight shafts stay open (their air cuts through any rock); nothing is raised in front of
 * the mouth (its brow and apron are designed). Cached per cave; ~20 k air samples once per build (worker).
 */
export function caveRoof(p: CavePlan, seed: number): ((x: number, z: number) => number) & { max: number } {
  const hit = roofs.get(seed)
  if (hit) return hit
  const G = 2, x0 = p.min[0], z0 = p.min[1]
  const nx = Math.ceil((p.max[0] - x0) / G) + 1, nz = Math.ceil((p.max[1] - z0) / G) + 1
  const top = new Float32Array(nx * nz).fill(-Infinity)
  const yHi = Math.max(p.chamber[1] + p.cr[1] * 1.6, p.alcove[1] + 7, ...p.path.map((q, i) => q[1] + 2.6 * p.radius[i])) + 4
  const yLo = Math.min(p.floor, p.alcove[1], ...p.path.map((q) => q[1])) - 2
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const lx = x0 + i * G, lz = z0 + j * G
    if (lx < MOUTH_X + 3 || caveFootprint(p, lx, lz) > 3.5) continue
    if (caveAir(p, seed, lx, yHi, lz) < 0) continue // a skylight shaft: open to the sky on purpose
    for (let y = yHi; y > yLo; y -= 0.5) if (caveAir(p, seed, lx, y, lz) < 0) { top[j * nx + i] = y + 0.5; break }
  }
  // Roof = max over the air columns within DOME_REACH of (their top + ROOF_T − slope · distance); one cell of slack so
  // the bilinear lookup between grid points never dips under the air.
  const roof = new Float32Array(nx * nz).fill(-Infinity)
  const R = Math.ceil(DOME_REACH / G) + 1
  let max = -Infinity
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    if (x0 + i * G < MOUTH_X + 1) continue
    let v = -Infinity
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      const ii = i + di, jj = j + dj
      if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue
      const t = top[jj * nx + ii]
      if (t === -Infinity) continue
      v = Math.max(v, t + ROOF_T - DOME_SLOPE * Math.max(0, Math.hypot(di, dj) * G - G))
    }
    roof[j * nx + i] = v
    max = Math.max(max, v)
  }
  const fn = ((x: number, z: number) => {
    const fx = (x - x0) / G, fz = (z - z0) / G
    if (fx < 0 || fz < 0 || fx > nx - 1 || fz > nz - 1) return -Infinity
    const i = Math.min(nx - 2, Math.floor(fx)), j = Math.min(nz - 2, Math.floor(fz)), u = fx - i, w = fz - j
    const a = roof[j * nx + i], b = roof[j * nx + i + 1], c = roof[(j + 1) * nx + i], d = roof[(j + 1) * nx + i + 1]
    // Missing corners (no air near) → the lowest present one (never raises rock where there is no cave).
    const lo = Math.min(...[a, b, c, d].filter((q) => q > -Infinity))
    if (lo === Infinity) return -Infinity
    const k = (q: number) => (q === -Infinity ? lo - 4 : q)
    return k(a) * (1 - u) * (1 - w) + k(b) * u * (1 - w) + k(c) * (1 - u) * w + k(d) * u * w
  }) as ((x: number, z: number) => number) & { max: number }
  fn.max = max
  roofs.set(seed, fn)
  return fn
}

/**
 * The cave formation's ROCK (negative inside): the hill-hugging CAP over the footprint (= the original ground +1.6 m,
 * `ground` gives it in local coordinates) — RAISED over the air where the hill is too low (caveRoof) — an arched BROW
 * and flanking rocks around the mouth, minus the air, plus the stalactites and stalagmites.
 */
export function caveRock(f: Formation, ground: (x: number, z: number) => number): (x: number, y: number, z: number) => number {
  const p = cavePlan(f), s = f.seed
  const m = p.path[0], R0 = p.radius[0]
  const mx = MOUTH_X
  const roof = caveRoof(p, s)
  return (x, y, z) => {
    const fp = caveFootprint(p, x, z)
    // The cap THICKENS toward the mouth into a rock FACE in the hillside (≈ 2 m of roof over the opening, fading back
    // to the 1.6 m cap ~14 m in), and widens there, so the mouth is a dark arch in a cliff, not a free-standing gate.
    const g = ground(x, z)
    let rock = Math.max(y - (g + CAP_H), fp - CAP_MARGIN)
    // Never less than ROOF_T of rock over the air: a knoll rises where the hill above the cave is too low.
    if (fp < DOME_REACH + 1) rock = Math.min(rock, Math.max(y - roof(x, z), fp - DOME_REACH - 1))
    // The mouth: a CLIFF FACE standing out of the hillside (a rounded block, its front a near-vertical wall a little
    // ahead of the opening, merging into the cap and the slope behind) with an OVERHANGING LEDGE above the opening —
    // Genshin's cave mouths are a dark recess under a layered rock shelf, not an arch or a dome.
    const top = m[1] + 1.55 * R0 + 3.2
    const face = rbox(x - (mx + 9), y - (m[1] + top) * 0.5 + 1, z - m[2], 10.5, (top - m[1]) * 0.5 + 2, R0 + 10, 3)
    const shelf = rbox(x - (mx + 0.5), y - (m[1] + 1.55 * R0 + 1.6), z - m[2], 3.2, 1.1, R0 + 5.5, 0.8)
    rock = smin(rock, Math.min(face, shelf), 2.5)
    rock += stoneOffset(s + 5, x, y, z, 3.2, STONE_BED) + noise3(s + 6, x * 0.35, y * 0.35, z * 0.35) * 0.3
    // A smooth CORE the stone relief can't gouge: ≥ 1.9 m of solid rock over the air everywhere (> 1.5 voxels: the
    // roof meshes closed — the ±3 m plates used to cut it to a few cm, cracks of sky in the ceiling).
    if (fp < DOME_REACH + 1) rock = Math.min(rock, Math.max(y - (roof(x, z) - ROOF_T + 1.9), fp - DOME_REACH - 1))
    // Solid under the natural ground out to SOLID_REACH (0.3 m down: hidden under the uncarved terrain).
    rock = Math.min(rock, Math.max(y - (g - 0.3), fp - SOLID_REACH))
    let d = Math.max(rock, -caveAir(p, s, x, y, z))
    // The ENTRANCE APRON: in front of the mouth the rock is cut down to the hillside's own surface (widening outward),
    // so the floor runs up the slope straight into the tunnel — no lip to climb (the player autosteps 0.45 m).
    const ent = Math.max(Math.abs(z - m[2]) - (R0 + 0.4) - Math.max(0, mx + 1 - x) * 0.6, x - (mx + 1), g - y, y - (g + 1.45 * R0))
    d = Math.max(d, -ent)
    for (const [sx, top, sz, r, L] of p.stalactites) d = smin(d, spike(x - sx, top - y, z - sz, r, L, sx + sz), 0.5)
    for (const [sx, base, sz, r, L] of p.stalagmites) d = smin(d, spike(x - sx, y - base, z - sz, r * 1.2, L, sx - sz), 0.5)
    for (const [bx, by, bz, hx, hy, hz, yaw] of p.rubble) {
      const dx = x - bx, dz = z - bz
      if (dx * dx + dz * dz > (hx + hz + 1) ** 2) continue
      const c = Math.cos(yaw), s = Math.sin(yaw)
      d = Math.min(d, rbox(dx * c + dz * s, y - by, -dx * s + dz * c, hx, hy, hz, 0.22))
    }
    return d
  }
}

/**
 * Baked LIGHT at a local point inside the cave (0 = black, 1 = daylight): daylight from the mouth fading with the
 * walk in, pools of light under the skylights; + the GLOW of nearby crystals (returned separately: [1] cyan / blue,
 * [2] violet) — the pool of coloured light each cluster casts on the rock around it.
 */
export function caveLight(p: CavePlan, x: number, y: number, z: number, out: [number, number, number]): [number, number, number] {
  // Distance walked in along the tunnel (nearest segment), the chamber at the far end.
  let best = 1e9, walk = 0
  for (let i = 0; i < p.path.length - 1; i++) {
    const a = p.path[i], b = p.path[i + 1]
    const t = segT(x, y, z, a, b)
    const dd = Math.hypot(x - (a[0] + (b[0] - a[0]) * t), y - (a[1] + (b[1] - a[1]) * t), z - (a[2] + (b[2] - a[2]) * t))
    if (dd < best) (best = dd), (walk = p.along[i] + t * (p.along[i + 1] - p.along[i]))
  }
  const dc = Math.hypot(x - p.chamber[0], z - p.chamber[2])
  if (dc < Math.max(p.cr[0], p.cr[2]) * 1.1 && dc < best) walk = p.along[p.along.length - 1] + 6 + dc * 0.4
  if (Math.hypot(x - p.alcove[0], z - p.alcove[2]) < p.alcoveR + 6) walk = Math.max(walk, p.along[p.along.length - 1] + 22)
  const ent = Math.exp(-Math.max(0, walk - 3) / 9)
  let sky = 0
  for (const [hx, hz, hr] of p.holes) sky += Math.exp(-Math.max(0, Math.hypot(x - hx, z - hz) - hr) / 2.4)
  out[0] = Math.min(1, ent + 0.9 * sky)
  let glow = 0, violet = 0
  for (const c of p.crystals) {
    const g = Math.exp(-Math.hypot(x - c[0], y - c[1], z - c[2]) / 1.8) // a pool of light around each cluster
    if (c[6] === CrystalHue.Violet) violet += g
    else glow += g
  }
  out[1] = Math.min(0.9, glow)
  out[2] = Math.min(0.9, violet)
  return out
}

/** Crystal clusters: march from the chamber / alcove centres in hashed directions to the wall (air SDF ≥ 0). */
function placeCrystals(p: CavePlan, rnd: () => number, seed: number): [number, number, number, number, number, number, number][] {
  const out: [number, number, number, number, number, number, number][] = []
  // The chamber: cyan with a few deep-blue clusters; the treasure alcove: violet amethyst (a different light guards it).
  const starts: [number[], number, boolean][] = [[[p.chamber[0], p.floor + 2.5, p.chamber[2]], 16, false], [[p.alcove[0], p.alcove[1] + 1.5, p.alcove[2]], 6, true]]
  for (const [o, n, alcove] of starts) {
    for (let i = 0; i < n; i++) {
      // Mostly aimed low (Genshin's clusters grow out of the ground at the foot of the walls), a quarter up the walls.
      const a = rnd() * Math.PI * 2, e = rnd() < 0.75 ? -0.12 - rnd() * 0.5 : rnd() * 0.6
      const dx = Math.cos(a) * Math.cos(e), dy = Math.sin(e), dz = Math.sin(a) * Math.cos(e)
      let t = 0.5
      for (let k = 0; k < 60 && t < 30; k++) {
        const d = caveAir(p, seed, o[0] + dx * t, o[1] + dy * t, o[2] + dz * t)
        if (d >= 0) break
        t += Math.max(0.25, -d * 0.8)
      }
      const x = o[0] + dx * t, y = o[1] + dy * t, z = o[2] + dz * t
      if (t >= 30 || p.holes.some(([hx, hz, hr]) => Math.hypot(x - hx, z - hz) < hr + 1)) continue
      // Outward normal = −gradient of the air SDF (pointing back into the cave).
      const e2 = 0.3
      const gx = caveAir(p, seed, x + e2, y, z) - caveAir(p, seed, x - e2, y, z)
      const gy = caveAir(p, seed, x, y + e2, z) - caveAir(p, seed, x, y - e2, z)
      const gz = caveAir(p, seed, x, y, z + e2) - caveAir(p, seed, x, y, z - e2)
      const gl = Math.hypot(gx, gy, gz) || 1
      out.push([x, y, z, -gx / gl, -gy / gl, -gz / gl, alcove ? CrystalHue.Violet : rnd() < 0.22 ? CrystalHue.Blue : CrystalHue.Cyan])
    }
  }
  return out
}

/**
 * FALLEN BLOCKS at the foot of the chamber's walls (Genshin's caverns always have a talus of angular blocks where the
 * wall meets the floor): march from the centre at knee height to the wall, set a block half into it. Kept clear of
 * the way in, the side passage, the pool and the crystals (the player's routes stay open).
 */
function placeRubble(p: CavePlan, rnd: () => number, seed: number): [number, number, number, number, number, number, number][] {
  const out: [number, number, number, number, number, number, number][] = []
  const rng = (a: number, b: number) => a + (b - a) * rnd()
  const c = p.chamber, last = p.path[p.path.length - 1], throat = [c[0] - p.cr[0] * 0.6, c[2]], sa = p.side[0]
  const segD = (x: number, z: number, a: number[], b: number[]) => {
    const t = segT(x, 0, z, [a[0], 0, a[1]], [b[0], 0, b[1]])
    return Math.hypot(x - (a[0] + (b[0] - a[0]) * t), z - (a[1] + (b[1] - a[1]) * t))
  }
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a), y = p.floor + 0.8
    let t = 2
    for (let k = 0; k < 60 && t < 30; k++) {
      const d = caveAir(p, seed, c[0] + dx * t, y, c[2] + dz * t)
      if (d >= 0) break
      t += Math.max(0.25, -d * 0.8)
    }
    const sz = rng(0.7, 1.6)
    const x = c[0] + dx * (t - sz * 0.4), z = c[2] + dz * (t - sz * 0.4)
    if (t >= 30 || segD(x, z, [last[0], last[2]], throat) < 7 || segD(x, z, [sa[0], sa[2]], [p.alcove[0], p.alcove[2]]) < sz + 3.5) continue
    if (Math.hypot(x - p.alcove[0], z - p.alcove[2]) < p.alcoveR + 2) continue
    if (Math.hypot(x - p.pool[0], z - p.pool[1]) < Math.max(p.pool[2], p.pool[3]) + 1.5) continue
    if (p.crystals.some((q) => Math.hypot(x - q[0], z - q[2]) < sz + 1.8)) continue
    if (out.some((q) => Math.hypot(x - q[0], z - q[2]) < (sz + q[3]) * 0.7)) continue
    out.push([x, p.floor + sz * rng(0.1, 0.4), z, sz * rng(0.9, 1.4), sz * rng(0.6, 1.0), sz * rng(0.8, 1.2), rnd() * Math.PI])
  }
  return out
}

/** World → cave-local (x, z) of a formation. */
export function toLocal(f: Formation, wx: number, wz: number, out: [number, number]): [number, number] {
  const c = Math.cos(f.rot), s = Math.sin(f.rot), dx = wx - f.x, dz = wz - f.z
  out[0] = dx * c + dz * s
  out[1] = -dx * s + dz * c
  return out
}
