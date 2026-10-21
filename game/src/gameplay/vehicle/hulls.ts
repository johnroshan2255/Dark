import { Vector3 } from 'three'
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js'

/**
 * BACKSTOP HULLS. A car's collider is its exact render mesh as a trimesh (VehicleSim, Groups.VehicleMesh: rocks,
 * trunks, props, formations, the road ribbon and the terrain's trimesh copy). A trimesh is a thin shell, though: a
 * hard enough landing could push it through the ground in one step. These convex pieces sit strictly INSIDE the body
 * and meet only the heightfield and formations — they touch nothing while the mesh does its job, and catch the body if
 * it ever didn't.
 *
 *  1. SOLID: a VOXEL grid (VOX m) of the body — surface voxels from the triangles, and every voxel lying between
 *     surface along x, y AND z (the closed body — between floor and roof, door and door — not the open space next to
 *     it). Then ERODED by one voxel: the points kept are ≥ VOX / 2 inside the surface.
 *  2. CELLS (≤ CELL m), cut at each WHEEL ARCH (hub z ± (r + ARCH_GAP), arch top = hub + r + travel, tyre inner face
 *     − SIDE_GAP): cells in an arch are dropped — the tyres stay free.
 *  3. MERGE neighbours (z runs, then across x, then y) while the merged hull holds ≤ MAX_GAP m of non-solid space per
 *     m² of its surface: a handful of pieces, still inside.
 * tests/vehicle.test.ts: every hull point is inside the mesh; the arches are free.
 * Cost: built once for the car you drive, cached on its model (≈ 0.1–0.4 s); at run time a few dozen small hulls.
 */
const VOX = 0.04
const CELL = 0.4
/** Clearance around each tyre (m): ahead / behind it and between it and the body. */
const ARCH_GAP = 0.06
const SIDE_GAP = 0.04
const MAX_GAP = 0.004

export interface HullWheel {
  hub: [number, number, number]
  radius: number
  /** Half the tyre width (m). */
  halfWidth: number
}

/** Point clouds (body space, xyz…) of the inset pieces; `travel` = suspension bump travel the arch keeps free. */
export function bodyHulls(tris: Float32Array, wheels: HullWheel[], travel: number): Float32Array[] {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < tris.length; i += 3) for (let a = 0; a < 3; a++) (lo[a] = Math.min(lo[a], tris[i + a])), (hi[a] = Math.max(hi[a], tris[i + a]))
  const vox = voxelise(tris, lo, hi)
  const { n, solid } = vox

  const arches = wheels.map((w) => [w.hub[2] - w.radius - ARCH_GAP, w.hub[2] + w.radius + ARCH_GAP] as const)
  const archTop = Math.max(...wheels.map((w) => w.hub[1] + w.radius + travel))
  const xi = Math.min(...wheels.map((w) => Math.abs(w.hub[0]) - w.halfWidth - SIDE_GAP))
  const xs = cuts(lo[0], hi[0], [-xi, xi], CELL), ys = cuts(lo[1], hi[1], [archTop], CELL), zs = cuts(lo[2], hi[2], arches.flat(), CELL)
  const nx = xs.length - 1, ny = ys.length - 1, nz = zs.length - 1
  const pts: (number[] | null)[] = new Array(nx * ny * nz).fill(null)

  // Eroded solid: a voxel whose six neighbours are solid too.
  const nxy = n[0] * n[1]
  for (let z = 1; z < n[2] - 1; z++) for (let y = 1; y < n[1] - 1; y++) for (let x = 1; x < n[0] - 1; x++) {
    const v = z * nxy + y * n[0] + x
    if (!solid[v] || !solid[v - 1] || !solid[v + 1] || !solid[v - n[0]] || !solid[v + n[0]] || !solid[v - nxy] || !solid[v + nxy]) continue
    const px = lo[0] + (x + 0.5) * VOX, py = lo[1] + (y + 0.5) * VOX, pz = lo[2] + (z + 0.5) * VOX
    if (Math.abs(px) > xi && py < archTop && arches.some(([a, b]) => pz > a && pz < b)) continue
    const i = span(xs, px), j = span(ys, py), k = span(zs, pz)
    ;(pts[(k * ny + j) * nx + i] ??= []).push(px, py, pz)
  }

  // Pieces: cell index boxes [i0, i1) × [j0, j1) × [k0, k1) with their points; merge along z, then x, then y.
  type Piece = { i: [number, number]; j: [number, number]; k: [number, number]; p: number[] }
  let pieces: Piece[] = []
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = pts[(k * ny + j) * nx + i]
    if (p && p.length >= 12) pieces.push({ i: [i, i + 1], j: [j, j + 1], k: [k, k + 1], p })
  }
  const fits = gapTest(vox, lo)
  for (const axis of ['k', 'i', 'j'] as const) {
    const others = (['i', 'j', 'k'] as const).filter((a) => a !== axis)
    const groups = new Map<string, Piece[]>()
    for (const q of pieces) {
      const key = others.map((a) => q[a].join(',')).join('|')
      const g = groups.get(key)
      if (g) g.push(q)
      else groups.set(key, [q])
    }
    const out: Piece[] = []
    for (const g of groups.values()) {
      g.sort((a, b) => a[axis][0] - b[axis][0])
      let cur = g[0]
      for (let s = 1; s < g.length; s++) {
        const q = g[s]
        const merged = cur[axis][1] === q[axis][0] ? cur.p.concat(q.p) : null
        if (merged && fits(merged)) cur = { ...cur, [axis]: [cur[axis][0], q[axis][1]], p: merged }
        else (out.push(cur), (cur = q))
      }
      out.push(cur)
    }
    pieces = out
  }
  return pieces.map((q) => hullPoints(q.p)).filter((p): p is Float32Array => p !== null)
}

interface Voxels {
  n: [number, number, number]
  solid: Uint8Array
}

/** The solid: surface voxels (triangles sampled at VOX / 2) and every voxel between surface along x, y and z. */
function voxelise(tris: Float32Array, lo: number[], hi: number[]): Voxels {
  const n = [0, 1, 2].map((a) => Math.max(1, Math.ceil((hi[a] - lo[a]) / VOX))) as [number, number, number]
  const nx = n[0], nxy = n[0] * n[1]
  const surf = new Uint8Array(nxy * n[2])
  const mark = (x: number, y: number, z: number) => {
    const i = Math.min(nx - 1, Math.max(0, Math.floor((x - lo[0]) / VOX)))
    const j = Math.min(n[1] - 1, Math.max(0, Math.floor((y - lo[1]) / VOX)))
    const k = Math.min(n[2] - 1, Math.max(0, Math.floor((z - lo[2]) / VOX)))
    surf[k * nxy + j * nx + i] = 1
  }
  for (let t = 0; t < tris.length; t += 9) {
    const ax = tris[t], ay = tris[t + 1], az = tris[t + 2]
    const ux = tris[t + 3] - ax, uy = tris[t + 4] - ay, uz = tris[t + 5] - az
    const vx = tris[t + 6] - ax, vy = tris[t + 7] - ay, vz = tris[t + 8] - az
    const m = Math.ceil(Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(ux - vx, uy - vy, uz - vz)) / (VOX * 0.5))
    for (let a = 0; a <= m; a++) for (let b = 0; a + b <= m; b++) mark(ax + (ux * a + vx * b) / m, ay + (uy * a + vy * b) / m, az + (uz * a + vz * b) / m)
  }
  // Inside the surface's extent along each axis (count per voxel: 3 = solid).
  const inside = new Uint8Array(surf.length)
  const fill = (len: number, at: (s: number) => number) => {
    let a = -1, b = -1
    for (let s = 0; s < len; s++) if (surf[at(s)]) (a < 0 && (a = s)), (b = s)
    for (let s = Math.max(0, a); a >= 0 && s <= b; s++) inside[at(s)]++
  }
  for (let z = 0; z < n[2]; z++) for (let y = 0; y < n[1]; y++) fill(nx, (x) => z * nxy + y * nx + x)
  for (let z = 0; z < n[2]; z++) for (let x = 0; x < nx; x++) fill(n[1], (y) => z * nxy + y * nx + x)
  for (let y = 0; y < n[1]; y++) for (let x = 0; x < nx; x++) fill(n[2], (z) => z * nxy + y * nx + x)
  const solid = new Uint8Array(surf.length)
  for (let v = 0; v < solid.length; v++) solid[v] = surf[v] || inside[v] === 3 ? 1 : 0
  return { n, solid }
}

/** Merge test: the convex hull of `p` holds at most MAX_GAP m of non-solid voxels per m² of its surface. */
function gapTest(vox: Voxels, lo: number[]): (p: number[]) => boolean {
  const { n, solid } = vox
  const v = new Vector3()
  return (p) => {
    const hull = convex(p)
    if (!hull) return false
    let area = 0
    for (const f of hull.faces) area += f.area
    const b0 = [Infinity, Infinity, Infinity], b1 = [-Infinity, -Infinity, -Infinity]
    for (let s = 0; s < p.length; s += 3) for (let a = 0; a < 3; a++) (b0[a] = Math.min(b0[a], p[s + a])), (b1[a] = Math.max(b1[a], p[s + a]))
    const g = (a: number, x: number) => Math.min(n[a] - 1, Math.max(0, Math.floor((x - lo[a]) / VOX)))
    const limit = (MAX_GAP * area) / (VOX * VOX * VOX)
    let gaps = 0
    for (let z = g(2, b0[2]); z <= g(2, b1[2]); z++) for (let y = g(1, b0[1]); y <= g(1, b1[1]); y++) for (let x = g(0, b0[0]); x <= g(0, b1[0]); x++) {
      if (solid[(z * n[1] + y) * n[0] + x]) continue
      v.set(lo[0] + (x + 0.5) * VOX, lo[1] + (y + 0.5) * VOX, lo[2] + (z + 0.5) * VOX)
      if (hull.containsPoint(v) && ++gaps > limit) return false
    }
    return true
  }
}

function convex(p: number[]): ConvexHull | null {
  const v: Vector3[] = []
  for (let s = 0; s < p.length; s += 3) v.push(new Vector3(p[s], p[s + 1], p[s + 2]))
  try {
    const h = new ConvexHull().setFromPoints(v)
    return h.faces.length >= 4 ? h : null
  } catch {
    return null
  }
}

/** The hull's own vertices (Rapier gets the few points that matter), or null for a flat sliver. */
function hullPoints(p: number[]): Float32Array | null {
  const h = convex(p)
  if (!h) return null
  // (the corners, from the faces — `h.vertices` still lists every input point)
  const seen = new Set<Vector3>(), out: number[] = []
  for (const f of h.faces) {
    let e = f.edge
    do {
      const q = e.head().point
      if (!seen.has(q)) (seen.add(q), out.push(q.x, q.y, q.z))
      e = e.next
    } while (e !== f.edge)
  }
  const e = [0, 1, 2].map((a) => {
    let mn = Infinity, mx = -Infinity
    for (let s = a; s < out.length; s += 3) (mn = Math.min(mn, out[s])), (mx = Math.max(mx, out[s]))
    return mx - mn
  })
  return out.length >= 12 && e.every((d) => d > 0.003) ? Float32Array.from(out) : null
}

/** Index of the cell [c[i], c[i+1]] holding a. */
function span(c: number[], a: number): number {
  let i = 0
  while (i < c.length - 2 && c[i + 1] < a) i++
  return i
}

/** Cut points over [lo, hi]: the given ones (inside the range) plus even subdivisions ≤ step between them. */
function cuts(lo: number, hi: number, at: number[], step: number): number[] {
  const fixed = [lo, ...at.filter((v) => v > lo && v < hi), hi].sort((a, b) => a - b)
  const out = [lo]
  for (let i = 1; i < fixed.length; i++) {
    const a = fixed[i - 1], b = fixed[i]
    if (b - a < 1e-4) continue
    const n = Math.max(1, Math.ceil((b - a) / step - 1e-6))
    for (let k = 1; k <= n; k++) out.push(a + ((b - a) * k) / n)
  }
  return out
}

/** All triangles of the geometries as one flat xyz… array (indexed or not), each moved by its offset. */
export function triangles(parts: { position: ArrayLike<number>; index: ArrayLike<number> | null; offset?: [number, number, number] }[]): Float32Array {
  let n = 0
  for (const p of parts) n += (p.index ? p.index.length : p.position.length / 3) * 3
  const out = new Float32Array(n)
  let o = 0
  for (const p of parts) {
    const [dx, dy, dz] = p.offset ?? [0, 0, 0]
    const count = p.index ? p.index.length : p.position.length / 3
    for (let i = 0; i < count; i++) {
      const v = (p.index ? p.index[i] : i) * 3
      out[o++] = p.position[v] + dx; out[o++] = p.position[v + 1] + dy; out[o++] = p.position[v + 2] + dz
    }
  }
  return out
}
