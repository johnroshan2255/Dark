import { hash4 } from '../noise/rng'
import type { Formation } from './formations'

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
  /** Crystal clusters on the walls: position + outward normal (local). */
  crystals: [number, number, number, number, number, number][]
  /** Cumulative tunnel length at each path point (light falls off with the walk in). */
  along: number[]
  /** Local bounds of the air (x/z) for the footprint, with the cap margin. */
  min: [number, number]
  max: [number, number]
}

export const MOUTH_X = -26
const CAP_H = 1.6
const CAP_MARGIN = 3

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
  const ceil = (x: number, z: number) => chamber[1] + cr[1] * Math.sqrt(Math.max(0, 1 - ((x - chamber[0]) / cr[0]) ** 2 - ((z - chamber[2]) / cr[2]) ** 2))
  const stalactites: [number, number, number, number, number][] = []
  for (let i = 0; i < 12; i++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * 0.75
    const x = chamber[0] + Math.cos(a) * d * cr[0], z = chamber[2] + Math.sin(a) * d * cr[2]
    if (holes.some(([hx, hz, hr]) => Math.hypot(x - hx, z - hz) < hr + 2.5)) continue
    stalactites.push([x, ceil(x, z) + 0.6, z, rng(0.9, 1.5), rng(2.5, 5.5)])
  }
  const stalagmites: [number, number, number, number, number][] = []
  for (let i = 0; i < 10; i++) {
    const a = rnd() * Math.PI * 2, d = rng(0.6, 0.85)
    const x = chamber[0] + Math.cos(a) * d * cr[0], z = chamber[2] + Math.sin(a) * d * cr[2]
    if (Math.hypot(x - pool[0], z - pool[1]) < Math.max(pool[2], pool[3]) + 1.5) continue
    if (x < chamber[0] - cr[0] * 0.5 && Math.abs(z - last[2]) < 6) continue // keep the way in clear
    if (Math.hypot(x - sa[0], z - sa[2]) < 5) continue // and the side passage
    stalagmites.push([x, floor - 0.4, z, rng(0.8, 1.3), rng(1.8, 4)])
  }
  const along = [0]
  for (let i = 1; i < path.length; i++) along.push(along[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]))
  let mnx = Infinity, mnz = Infinity, mxx = -Infinity, mxz = -Infinity
  const grow = (x: number, z: number, r: number) => { mnx = Math.min(mnx, x - r); mxx = Math.max(mxx, x + r); mnz = Math.min(mnz, z - r); mxz = Math.max(mxz, z + r) }
  path.forEach((q, i) => grow(q[0], q[2], radius[i]))
  grow(chamber[0], chamber[2], Math.max(cr[0], cr[2]))
  grow(alcove[0], alcove[2], 5)
  p = {
    path, radius, chamber, cr, floor, side: [sa, alcove], alcove, alcoveR: rng(4.2, 5.2), holes, pool, waterY,
    stalactites, stalagmites, crystals: [], along, min: [mnx - CAP_MARGIN - 2, mnz - CAP_MARGIN - 2], max: [mxx + CAP_MARGIN + 2, mxz + CAP_MARGIN + 2],
  }
  p.crystals = placeCrystals(p, rnd, s)
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
  for (let i = 0; i < p.path.length - 1; i++) {
    const a = p.path[i], b = p.path[i + 1]
    const R = (p.radius[i] + p.radius[i + 1]) / 2
    const t = segT(x, y - 0.55 * R, z, a, b)
    const cx = a[0] + (b[0] - a[0]) * t, cy = a[1] + (b[1] - a[1]) * t + 0.55 * R, cz = a[2] + (b[2] - a[2]) * t
    const fl = a[1] + (b[1] - a[1]) * t
    d = smin(d, Math.max(Math.hypot(x - cx, y - cy, z - cz) - R, fl - y), 2.5)
  }
  // Last tunnel point → chamber (wide throat).
  {
    const a = p.path[p.path.length - 1], c = p.chamber
    const b = [c[0] - p.cr[0] * 0.6, p.floor, c[2]]
    const R = p.radius[p.radius.length - 1] * 1.15
    const t = segT(x, y - 0.55 * R, z, a, b)
    const cx = a[0] + (b[0] - a[0]) * t, cy = a[1] + (b[1] - a[1]) * t + 0.55 * R, cz = a[2] + (b[2] - a[2]) * t
    d = smin(d, Math.max(Math.hypot(x - cx, y - cy, z - cz) - R, a[1] + (b[1] - a[1]) * t - y), 3)
  }
  const c = p.chamber, cr = p.cr
  d = smin(d, Math.max(ell(x - c[0], y - c[1], z - c[2], cr[0], cr[1], cr[2]), p.floor - y), 3)
  // Pool basin (below the floor).
  d = Math.min(d, ell(x - p.pool[0], y - p.floor, z - p.pool[1], p.pool[2], 1.6, p.pool[3]))
  // Side passage (narrow, 2.4 m) and the alcove.
  {
    const [a, b] = p.side
    const R = 2.4
    const t = segT(x, y - 1.3, z, a, b)
    const cx = a[0] + (b[0] - a[0]) * t, cy = a[1] + (b[1] - a[1]) * t + 1.3, cz = a[2] + (b[2] - a[2]) * t
    d = smin(d, Math.max(Math.hypot(x - cx, y - cy, z - cz) - R, a[1] + (b[1] - a[1]) * t - y), 1.5)
    const al = p.alcove
    d = smin(d, Math.max(ell(x - al[0], y - al[1] - 1.6, z - al[2], p.alcoveR, 3.4, p.alcoveR), al[1] - y), 1.5)
  }
  // Skylights: vertical shafts from the ceiling to the sky.
  for (const [hx, hz, hr] of p.holes) {
    if (y > c[1]) d = Math.min(d, Math.hypot(x - hx, z - hz) - hr * (1 + 0.15 * Math.max(0, y - c[1] - cr[1]) / 10))
  }
  return rough ? d + noise3(seed + 11, x * 0.22, y * 0.22, z * 0.22) * 0.9 + noise3(seed + 12, x * 0.6, y * 0.6, z * 0.6) * 0.3 : d
}

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

/**
 * The cave formation's ROCK (negative inside): the hill-hugging CAP over the footprint (= the original ground +1.6 m,
 * `ground` gives it in local coordinates), an arched BROW and flanking rocks around the mouth, minus the air, plus
 * the stalactites and stalagmites.
 */
export function caveRock(f: Formation, ground: (x: number, z: number) => number): (x: number, y: number, z: number) => number {
  const p = cavePlan(f), s = f.seed
  const m = p.path[0], R0 = p.radius[0]
  const mx = MOUTH_X
  return (x, y, z) => {
    const fp = caveFootprint(p, x, z)
    // The cap THICKENS toward the mouth into a rock FACE in the hillside (≈ 2 m of roof over the opening, fading back
    // to the 1.6 m cap ~14 m in), and widens there, so the mouth is a dark arch in a cliff, not a free-standing gate.
    let rock = Math.max(y - (ground(x, z) + CAP_H), fp - CAP_MARGIN)
    // The mouth: a ROUNDED rock mass bulging out of the hillside around the opening (merges into the cap and the
    // slope behind), with a low overhanging brow — a dark arch in a rocky face, not a free-standing block.
    const mass = ell(x - (mx + 7), y - (m[1] + R0 * 0.9), z - m[2], 10, 1.55 * R0 + 5, R0 + 11)
    const brow = ell(x - (mx + 0.8), y - (m[1] + 1.55 * R0 + 0.8), z - m[2], 2.4, 2, R0 + 2.5)
    rock = smin(rock, smin(mass, brow, 2), 3)
    rock += noise3(s + 5, x * 0.12, y * 0.12, z * 0.12) * 1.1 + noise3(s + 6, x * 0.35, y * 0.35, z * 0.35) * 0.35
    let d = Math.max(rock, -caveAir(p, s, x, y, z))
    for (const [sx, top, sz, r, L] of p.stalactites) d = smin(d, ell(x - sx, y - (top - L * 0.5), z - sz, r, L * 0.55, r), 0.6)
    for (const [sx, base, sz, r, L] of p.stalagmites) d = smin(d, ell(x - sx, y - (base + L * 0.4), z - sz, r * 1.15, L * 0.6, r * 1.15), 0.6)
    return d
  }
}

/**
 * Baked LIGHT at a local point inside the cave (0 = black, 1 = daylight): daylight from the mouth fading with the
 * walk in, pools of light under the skylights; + the cyan GLOW of nearby crystals (returned separately).
 */
export function caveLight(p: CavePlan, x: number, y: number, z: number, out: [number, number]): [number, number] {
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
  let glow = 0
  for (const c of p.crystals) glow += Math.exp(-Math.hypot(x - c[0], y - c[1], z - c[2]) / 1.1) // a small pool of cyan around each cluster
  out[1] = Math.min(0.7, glow)
  return out
}

/** Crystal clusters: march from the chamber / alcove centres in hashed directions to the wall (air SDF ≥ 0). */
function placeCrystals(p: CavePlan, rnd: () => number, seed: number): [number, number, number, number, number, number][] {
  const out: [number, number, number, number, number, number][] = []
  const starts: [number[], number][] = [[[p.chamber[0], p.floor + 2.5, p.chamber[2]], 14], [[p.alcove[0], p.alcove[1] + 1.5, p.alcove[2]], 5]]
  for (const [o, n] of starts) {
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, e = (rnd() - 0.35) * 1.1
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
      out.push([x, y, z, -gx / gl, -gy / gl, -gz / gl])
    }
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
