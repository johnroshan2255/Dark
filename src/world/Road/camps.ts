import { CHUNK_SIZE } from '../constants'
import { hashFloat } from '../noise/rng'
import { WorldFields } from '../WorldFields'
import type { CragMesh } from '../Formations/crags'
import { beam, bridgeOf, obox, srgbLin, type V3 } from './bridges'

/**
 * OASIS CAMPS (bright — their oasis has white tents): on ~3/4 of the 450 m stretches of the river where it runs
 * through the desert, a camp of 2–3 white canvas A-frame tents round a campfire with supply crates, on the first flat
 * ground up from the oasis water (the bank top overlooking it). Analytic placement (seed + cell), built into the chunk's formation mesh
 * (0 draws, exact trimesh collider) like the rope bridges; trees, rocks and plants keep clear (scatter).
 * Cost: ~150 tris per camp.
 */
const CELL = 450
const LAYER = 9 * 16 + 141
const RADIUS = 7

export interface Camp { x: number; z: number; h: number }

const cache = new Map<string, Camp | null>()

export function campOf(fields: WorldFields, k: number): Camp | null {
  if (fields.palette !== 0) return null
  const key = `${fields.seed},${k}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let c: Camp | null = null
  if (hashFloat(fields.seed, k, 0, LAYER) < 0.75) {
    const z = k * CELL + CELL * (0.2 + 0.6 * hashFloat(fields.seed, k, 1, LAYER))
    const rc = fields.riverCenterX(z)
    const side = hashFloat(fields.seed, k, 2, LAYER) < 0.5 ? -1 : 1
    const bw: [number, number] = [0, 0]
    if (fields.biome(rc, z, bw)[0] > 0.7) {
      // Walk out from the river to gentle ground 1.5–6 m above the water.
      // (The desert banks climb steeply out of the water, so the camp sits on the first FLAT ground walking up
      // from the oasis — the bank top overlooking it — within 80 m.)
      for (let d = 10; d < 80 && !c; d += 1) {
        const x = rc + side * d, h = fields.heightNoNet(x, z), wl = h - WorldFields.WATER
        if (wl < 1) continue
        if (wl > 40) break
        const flat = Math.abs(fields.heightNoNet(x + 4, z) - h) + Math.abs(fields.heightNoNet(x - 4, z) - h) + Math.abs(fields.heightNoNet(x, z + 4) - h) + Math.abs(fields.heightNoNet(x, z - 4) - h)
        if (flat > 3 || fields.roadDistance(x, z) < 14 || nearBridgeSite(fields, x, z, 10)) continue
        c = { x, z, h }
      }
    }
  }
  if (cache.size > 4000) cache.clear()
  cache.set(key, c)
  return c
}

/** Near a bridge SITE (built or not — camps must not depend on the road network, which connects them). */
function nearBridgeSite(fields: WorldFields, x: number, z: number, m: number): boolean {
  const k = Math.floor(z / 500)
  for (let j = k - 1; j <= k + 1; j++) {
    const b = bridgeOf(fields, j)
    if (b && Math.abs(z - b.z) < 2 + m && x > b.xa - m - 2 && x < b.xb + m + 2) return true
  }
  return false
}

/** Camps whose centre lies in the box (the road network gives each a track). */
export function campsIn(fields: WorldFields, minZ: number, maxZ: number): Camp[] {
  const out: Camp[] = []
  for (let k = Math.floor(minZ / CELL); k <= Math.floor(maxZ / CELL); k++) { const c = campOf(fields, k); if (c && c.z >= minZ && c.z <= maxZ) out.push(c) }
  return out
}

/** True near a camp (keep trees / rocks / plants off it). */
export function nearCamp(fields: WorldFields, x: number, z: number, margin = 0): boolean {
  if (fields.palette !== 0) return false
  const k = Math.floor(z / CELL)
  for (let j = k - 1; j <= k + 1; j++) {
    const c = campOf(fields, j)
    if (c && Math.hypot(x - c.x, z - c.z) < RADIUS + margin) return true
  }
  return false
}

const CANVAS = srgbLin(0xfaf6ec), CANVAS_D = srgbLin(0xe2dccc), DOOR = srgbLin(0x3a2e24), STONE = srgbLin(0x6e665e), LOG = srgbLin(0x5a3e28), CRATE = srgbLin(0x8a6a44), EMBER = srgbLin(0xd8701c)

/** One flat triangle, wound to face AWAY from `inside` (the rock material culls back faces). */
function tri(out: CragMesh, a: V3, b0: V3, c0: V3, col: V3, inside: V3): void {
  let b = b0, c = c0
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const l = Math.hypot(nx, ny, nz) || 1
  nx /= l; ny /= l; nz /= l
  const mx = (a[0] + b[0] + c[0]) / 3 - inside[0], my = (a[1] + b[1] + c[1]) / 3 - inside[1], mz = (a[2] + b[2] + c[2]) / 3 - inside[2]
  if (nx * mx + ny * my + nz * mz < 0) { nx = -nx; ny = -ny; nz = -nz; const t = b; b = c; c = t }
  out.pos.push(...a, ...b, ...c)
  for (let i = 0; i < 3; i++) out.nor.push(nx, ny, nz), out.col.push(col[0], col[1], col[2])
}

/** White A-frame tent: ridge along its local x, centred at (x, y, z), facing (fx, fz). */
function tent(out: CragMesh, x: number, y: number, z: number, fx: number, fz: number, L: number, W: number, H: number): void {
  const sx = -fz, sz = fx // local x (ridge) = (fx, fz), local z = (sx, sz)
  const P = (lx: number, ly: number, lz: number): V3 => [x + fx * lx + sx * lz, y + ly, z + fz * lx + sz * lz]
  const f0 = P(-L, 0, -W), f1 = P(-L, 0, W), fT = P(-L, H, 0), b0 = P(L, 0, -W), b1 = P(L, 0, W), bT = P(L, H, 0)
  const C = P(0, H * 0.35, 0)
  // roof planes (the sun side lighter), the back end closed, the front end with a dark doorway
  tri(out, f0, fT, bT, CANVAS, C); tri(out, f0, bT, b0, CANVAS, C)
  tri(out, f1, b1, bT, CANVAS_D, C); tri(out, f1, bT, fT, CANVAS_D, C)
  tri(out, b0, bT, b1, CANVAS_D, C)
  tri(out, f0, f1, fT, CANVAS_D, C)
  const d0 = P(-L - 0.02, 0, -W * 0.45), d1 = P(-L - 0.02, 0, W * 0.45), dT = P(-L - 0.02, H * 0.7, 0)
  tri(out, d0, d1, dT, DOOR, C)
}

export function buildCamps(fields: WorldFields, cx: number, cz: number, out: CragMesh): number {
  if (fields.palette !== 0) return 0
  const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE
  let n = 0
  for (let k = Math.floor(z0 / CELL) - 1; k <= Math.floor((z0 + CHUNK_SIZE) / CELL) + 1; k++) {
    const c = campOf(fields, k)
    if (!c || c.x < x0 || c.x >= x0 + CHUNK_SIZE || c.z < z0 || c.z >= z0 + CHUNK_SIZE) continue
    const s = fields.seed, X = (x: number) => x - x0, Zz = (z: number) => z - z0
    // campfire: a ring of stones, two crossed logs, embers
    for (let i = 0; i < 8; i++) {
      const dxs = [1, 0.71, 0, -0.71, -1, -0.71, 0, 0.71][i], dzs = [0, 0.71, 1, 0.71, 0, -0.71, -1, -0.71][i]
      const px = c.x + dxs * 0.75, pz = c.z + dzs * 0.75
      obox(out, [X(px), fields.height(px, pz) + 0.1, Zz(pz)], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.17, 0.12, 0.17, STONE)
    }
    const gy = fields.height(c.x, c.z)
    beam(out, [X(c.x - 0.55), gy + 0.12, Zz(c.z - 0.2)], [X(c.x + 0.55), gy + 0.2, Zz(c.z + 0.2)], 0.08, LOG)
    beam(out, [X(c.x - 0.2), gy + 0.2, Zz(c.z + 0.55)], [X(c.x + 0.2), gy + 0.12, Zz(c.z - 0.55)], 0.08, LOG)
    obox(out, [X(c.x), gy + 0.1, Zz(c.z)], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.25, 0.05, 0.25, EMBER)
    // 2–3 tents facing the fire
    const nt = 2 + (hashFloat(s, k, 5, LAYER) < 0.5 ? 1 : 0)
    const dirs: [number, number][] = [[1, 0], [-0.5, 0.866], [-0.5, -0.866]]
    for (let t = 0; t < nt; t++) {
      let [dx, dz] = dirs[t]
      const r = hashFloat(s, k, 10 + t, LAYER) - 0.5
      dx += -dz * r * 0.6; dz += dx * r * 0.6
      const l = Math.hypot(dx, dz)
      dx /= l; dz /= l
      const tx = c.x + dx * 5, tz = c.z + dz * 5
      const ty = Math.min(fields.height(tx - 1, tz), fields.height(tx + 1, tz), fields.height(tx, tz - 1), fields.height(tx, tz + 1)) - 0.05
      // ridge across the radial direction, doorway (local −x) toward the fire
      tent(out, X(tx), ty, Zz(tz), -dz, dx, 1.8, 1.5, 2.3)
    }
    // supply crates
    for (let i = 0; i < 3; i++) {
      const px = c.x + 2.2 + i * 0.75, pz = c.z - 2.4 + (i % 2) * 0.4
      obox(out, [X(px), fields.height(px, pz) + 0.3, Zz(pz)], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.32, 0.3, 0.32, CRATE)
    }
    n++
  }
  return n
}
