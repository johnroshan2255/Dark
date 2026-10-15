import { CHUNK_SIZE } from '../constants'
import { hashFloat } from '../noise/rng'
import { WorldFields } from '../WorldFields'
import type { CragMesh } from '../Formations/crags'

/**
 * ROPE BRIDGES (bright = "over the hill"): plank suspension bridges across the river that runs beside the main road
 * — the river's gorge (dry wash in the desert, frozen in the snow) gets a crossing every ~500 m (half the cells).
 * Placement is analytic (seed + cell → identical on every client of the same palette): at the cell's z the deck runs
 * straight across the river (along x) from bank top to bank top, sagging in the middle.
 *
 * The bridge is appended to the chunk that holds its midpoint, in the FORMATION mesh (WorldGenerator.formations):
 * one draw shared with the chunk's rock, and that mesh's exact trimesh collider makes the deck walkable AND drivable
 * (4 m wide: a car fits), the handrails stop you walking off. Trees / rocks / plants keep clear of it (scatter).
 * Cost: ~2.4–4 k tris per bridge (planks dominate), one bridge per ~1 km of road; 0 draws, 0 programs.
 */
const CELL = 500
const BW = 2.0 // half deck width (m): 4 m — a car fits with room to steer
const LAYER = 9 * 16 + 101

export interface Bridge {
  z: number
  xa: number
  xb: number
  ha: number
  hb: number
  sag: number
}

const cache = new Map<string, Bridge | null>()

/** The bridge of z-cell `k` (null: none here). */
export function bridgeOf(fields: WorldFields, k: number): Bridge | null {
  if (fields.palette !== 0) return null
  const key = `${fields.seed},${k}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let b: Bridge | null = null
  if (hashFloat(fields.seed, k, 0, LAYER) < 0.5) {
    const z = k * CELL + CELL * (0.25 + 0.5 * hashFloat(fields.seed, k, 1, LAYER))
    const rc = fields.riverCenterX(z)
    // Walk out of the gorge both ways to the BANK TOPS: ground over the water and flat enough (slope < 0.3 across
    // the next 4 m) — the deck spans high across the gorge from plateau to plateau, so both ends lead onto open
    // ground (from the low bank shoulder the ends sat under steep banks / against cliffs).
    const top = WorldFields.WATER + 2.2
    const out = (dir: number): number => {
      for (let d = 10; d < 75; d += 1) {
        const x = rc + dir * d, h = fields.height(x, z)
        if (h >= top && Math.abs(fields.height(x + dir * 4, z) - h) < 1.2) return x + dir * 2
      }
      return NaN
    }
    // Road side: the flat valley floor (or the first ground 1 m over the bank shoulder). Far side: wherever the
    // bank rises to meet the deck level (it often keeps climbing into the hills — the bridge lands on the slope),
    // else its own flat top.
    let xa = out(-1)
    if (Number.isNaN(xa)) for (let d = 10; d < 60 && Number.isNaN(xa); d++) if (fields.height(rc - d, z) >= top + 1) xa = rc - d - 1
    const hRoad = Number.isNaN(xa) ? NaN : fields.height(xa, z)
    let xb = NaN
    for (let d = 10; d < 75 && Number.isNaN(xb); d++) if (fields.height(rc + d, z) >= hRoad - 0.5) xb = rc + d + 1.5
    if (Number.isNaN(xb)) xb = out(1)
    const span = xb - xa
    if (span >= 22 && span <= 95 && xa > fields.roadCenterX(z) + WorldFields.ROAD_HALF_WIDTH + 6) {
      // The deck must clear every bump between its ends and the channel (a bank lip higher than the end left
      // the car's nose against the ground): ha / hb = the highest ground on that half (+0.15 m); if that lifts the
      // end off the ground, the deck runs on back until it meets the ground again (≤ 15 m).
      const gh = (x: number) => Math.max(fields.height(x, z - BW), fields.height(x, z), fields.height(x, z + BW))
      let ha = gh(xa), hb = gh(xb)
      for (let x = xa; x < rc; x += 1) ha = Math.max(ha, gh(x))
      for (let x = xb; x > rc; x -= 1) hb = Math.max(hb, gh(x))
      ha += 0.15; hb += 0.15
      for (let i = 0; i < 15 && gh(xa) < ha - 0.3; i++) xa -= 1
      for (let i = 0; i < 15 && gh(xb) < hb - 0.3; i++) xb += 1
      // ≤ ~12 % deck grade
      if (Math.abs(ha - hb) < span * 0.12) {
        b = { z, xa, xb, ha, hb, sag: Math.min(1.6, span * 0.022) }
        // The deck must stay above the ground across its whole width all the way (a bank running obliquely to the
        // bridge rose through one side of the deck and stopped the car).
        for (let x = xa + 1; x < xb - 1 && b; x += 1) if (gh(x) > deckY(b, x) - 0.12) b = null
      }
    }
  }
  if (cache.size > 4000) cache.clear()
  cache.set(key, b)
  return b
}

/** Deck height at x (between the ends, sagging, never lower than 1.2 m over the water). */
export function deckY(b: Bridge, x: number): number {
  const t = Math.min(1, Math.max(0, (x - b.xa) / (b.xb - b.xa)))
  return Math.max(WorldFields.WATER + 1.2, b.ha + (b.hb - b.ha) * t - b.sag * 4 * t * (1 - t))
}

/** True if (x, z) is on / beside a bridge's path (keep trees, rocks and plants off it). */
export function nearBridge(fields: WorldFields, x: number, z: number, margin = 3): boolean {
  if (fields.palette !== 0) return false
  const k = Math.floor(z / CELL)
  for (let j = k - 1; j <= k + 1; j++) {
    const b = bridgeOf(fields, j)
    if (b && Math.abs(z - b.z) < BW + margin && x > b.xa - margin - 2 && x < b.xb + margin + 2) return true
  }
  return false
}

/** Append the bridges whose midpoint lies in chunk (cx, cz) to `out` (chunk-local, flat normals, linear colours). */
export function buildBridges(fields: WorldFields, cx: number, cz: number, out: CragMesh): number {
  if (fields.palette !== 0) return 0
  const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE
  let n = 0
  for (let k = Math.floor(z0 / CELL) - 1; k <= Math.floor((z0 + CHUNK_SIZE) / CELL) + 1; k++) {
    const b = bridgeOf(fields, k)
    if (!b) continue
    const mx = (b.xa + b.xb) / 2
    if (mx < x0 || mx >= x0 + CHUNK_SIZE || b.z < z0 || b.z >= z0 + CHUNK_SIZE) continue
    addBridge(fields, b, x0, z0, out)
    n++
  }
  return n
}

type V3 = [number, number, number]

/** Oriented box: centre c, unit axes u (length), v (up-ish), w (across); half sizes. Flat-shaded, 12 tris. */
function obox(out: CragMesh, c: V3, u: V3, v: V3, w: V3, hu: number, hv: number, hw: number, col: V3): void {
  const P = (su: number, sv: number, sw: number): V3 => [
    c[0] + u[0] * hu * su + v[0] * hv * sv + w[0] * hw * sw,
    c[1] + u[1] * hu * su + v[1] * hv * sv + w[1] * hw * sw,
    c[2] + u[2] * hu * su + v[2] * hv * sv + w[2] * hw * sw,
  ]
  const quad = (a: V3, b: V3, cc: V3, d: V3, n: V3, k: number) => {
    for (const p of [a, b, cc, a, cc, d]) {
      out.pos.push(p[0], p[1], p[2])
      out.nor.push(n[0], n[1], n[2])
      out.col.push(col[0] * k, col[1] * k, col[2] * k)
    }
  }
  const neg = (a: V3): V3 => [-a[0], -a[1], -a[2]]
  // Winding: counter-clockwise seen from outside (normal direction).
  quad(P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), v, 1) // top
  quad(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), neg(v), 0.55) // bottom
  quad(P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1), u, 0.85)
  quad(P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), neg(u), 0.85)
  quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), w, 0.8)
  quad(P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), P(1, -1, -1), neg(w), 0.8)
}

const srgbLin = (h: number): V3 => {
  const f = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return [f(((h >> 16) & 255) / 255), f(((h >> 8) & 255) / 255), f((h & 255) / 255)]
}
const SUB = srgbLin(0x3a2a1c), PLANK = srgbLin(0x9a7650), PLANK2 = srgbLin(0x7e5c3c), BEAM = srgbLin(0x5c4128), ROPE = srgbLin(0x6a5236), POST = srgbLin(0x6e5032)

/** Segment from p to q as a thin square beam of half-size r (ropes, hangers, posts). */
function beam(out: CragMesh, p: V3, q: V3, r: number, col: V3): void {
  const d: V3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]]
  const L = Math.hypot(d[0], d[1], d[2]) || 1
  const u: V3 = [d[0] / L, d[1] / L, d[2] / L]
  // any perpendicular: cross with z unless nearly parallel to it
  let w: V3 = Math.abs(u[2]) < 0.9 ? [u[1], -u[0], 0] : [0, u[2], -u[1]]
  const wl = Math.hypot(w[0], w[1], w[2]) || 1
  w = [w[0] / wl, w[1] / wl, w[2] / wl]
  const v: V3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
  obox(out, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2], u, v, w, L / 2, r, r, col)
}

function addBridge(fields: WorldFields, b: Bridge, x0: number, z0: number, out: CragMesh): void {
  const span = b.xb - b.xa
  const lz = b.z - z0
  const X = (x: number) => x - x0
  const W: V3 = [0, 0, 1]
  // Two stringers under the planks (continuous deck for the collider), in 2 m segments following the sag.
  const seg = Math.max(8, Math.round(span / 2))
  for (let i = 0; i < seg; i++) {
    const xa = b.xa - 1.5 + ((span + 3) * i) / seg, xb = b.xa - 1.5 + ((span + 3) * (i + 1)) / seg
    const ya = deckY(b, xa) - 0.16, yb = deckY(b, xb) - 0.16
    for (const s of [-1.2, 1.2]) beam(out, [X(xa), ya, lz + s], [X(xb), yb, lz + s], 0.11, BEAM)
    // Solid sub-deck 3 cm under the plank tops: the wheels' rays fell through the gaps between planks (rear wheels
    // spinning in the air); from above it reads as the dark gaps.
    const dx = xb - xa, dy = (yb - ya)
    const L = Math.hypot(dx, dy)
    obox(out, [X((xa + xb) / 2), (ya + yb) / 2 + 0.16 - 0.07, lz], [dx / L, dy / L, 0], [-dy / L, dx / L, 0], W, L / 2 + 0.02, 0.04, BW - 0.05, SUB)
  }
  // Planks across the deck, 0.26 m wide every 0.31 m, each a slightly different tone and length.
  const nP = Math.floor((span + 3) / 0.31)
  for (let i = 0; i <= nP; i++) {
    const x = b.xa - 1.5 + i * 0.31
    const y = deckY(b, x)
    const dydx = (deckY(b, x + 0.2) - deckY(b, x - 0.2)) / 0.4
    const L = Math.hypot(1, dydx)
    const u: V3 = [1 / L, dydx / L, 0], v: V3 = [-dydx / L, 1 / L, 0]
    const h = hashFloat(fields.seed, Math.round(x * 10), Math.round(b.z), 77)
    const col: V3 = h < 0.3 ? PLANK2 : PLANK
    const k = 0.88 + 0.22 * hashFloat(fields.seed, Math.round(x * 10), 3, 78)
    obox(out, [X(x), y - 0.05, lz + (h - 0.5) * 0.12], u, v, W, 0.13, 0.05, BW + 0.05 * h, [col[0] * k, col[1] * k, col[2] * k])
  }
  // Posts at both ends (on the bank tops), main ropes sagging between them, hangers down to the handrail, and the
  // handrail rope at 1.1 m along each side.
  const postH = 2.7
  const ends = [b.xa - 0.4, b.xb + 0.4]
  for (const ex of ends) {
    const gy = Math.min(deckY(b, ex), fields.height(ex, b.z)) - 0.4
    for (const s of [-1, 1]) beam(out, [X(ex), gy, lz + s * (BW + 0.15)], [X(ex), deckY(b, ex) + postH, lz + s * (BW + 0.15)], 0.13, POST)
    beam(out, [X(ex), deckY(b, ex) + postH - 0.25, lz - BW - 0.3], [X(ex), deckY(b, ex) + postH - 0.25, lz + BW + 0.3], 0.1, POST) // lintel
  }
  const ropeY = (x: number) => {
    const t = (x - ends[0]) / (ends[1] - ends[0])
    return deckY(b, x) + 1.15 + (postH - 0.35 - 1.15) * Math.pow(2 * t - 1, 2)
  }
  const rs = Math.max(10, Math.round(span / 1.5))
  for (const s of [-1, 1]) {
    const zz = lz + s * (BW + 0.15)
    for (let i = 0; i < rs; i++) {
      const xa = ends[0] + ((ends[1] - ends[0]) * i) / rs, xb = ends[0] + ((ends[1] - ends[0]) * (i + 1)) / rs
      beam(out, [X(xa), ropeY(xa), zz], [X(xb), ropeY(xb), zz], 0.045, ROPE) // main rope
      beam(out, [X(xa), deckY(b, xa) + 1.05, zz], [X(xb), deckY(b, xb) + 1.05, zz], 0.04, ROPE) // handrail
      if (i > 0) beam(out, [X(xa), deckY(b, xa) - 0.05, zz], [X(xa), ropeY(xa), zz], 0.03, ROPE) // hanger
    }
  }
}
