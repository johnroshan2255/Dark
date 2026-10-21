import { CELL_SIZE, CHUNK_RES, CHUNK_SIZE, CHUNK_VERTS } from '../constants'
import type { WorldFields } from '../WorldFields'
import { MAIN_STEP, MAIN_U, MAIN_W, TRACK_STEP, detailInfo, type DetailInfo, type Track } from '../Road/RoadDetail'
import { REGION, type NetRoad } from '../Road/RoadNetwork'
import { vertexColor, type VertexAttrs } from './vertexColor'

/**
 * ROAD RIBBONS (Road/RoadDetail.ts): the road-aligned detail mesh that carries the gutters, wheel ruts and potholes
 * the 2 m terrain grid can't. Per road, ROWS across it (main road: every 2 m of z, grid-aligned; tracks: every 1 m
 * of arclength, perpendicular to the smoothed direction) with vertices at the profile's breakpoints; height =
 * the grid surface G (exact triangle interpolation of the 2 m heights, same split as the mesh / Rapier) + Δ.
 * Each chunk keeps the part of every ribbon inside its square: triangles are clipped to the chunk (Sutherland–
 * Hodgman, intersections computed from the canonically ordered edge) → neighbours share bit-identical border
 * vertices, no cracks. Normals = the grid's interpolated normal tilted by Δ's gradient, colours = the grid's
 * interpolated vertex colours (+ a little AO in the hollows) → where Δ = 0 the ribbon is indistinguishable from the
 * terrain it lies on. Pure function of the seed (worker), chunk-local output; the same arrays feed the LOD0 mesh
 * (WorldChunk) and the trimesh collider (PhysicsWorld).
 */

export interface RoadSurfaceArrays {
  /** Ribbon vertices (chunk-local xyz), normals, linear colours, attributes (stride RD_ATTR), Δ, triangles. */
  rdPos: Float32Array
  rdNor: Float32Array
  rdCol: Float32Array
  /** Stride RD_ATTR: roadLat, netEdge, netType, biome desert, biome snow, wet (damp / standing water 0..1). */
  rdAttr: Float32Array
  rdDelta: Float32Array
  rdIdx: Uint32Array
  rdMinY: number
  rdMaxY: number
}
export const RD_ATTR = 6
/** Diagnostics (tests): ribbon vertices whose hollow the safety net flattened (should stay 0). */
export const rdStats = { clamped: 0, hollows: 0 }

const P = CHUNK_VERTS + 2
/** Record layout of a ribbon vertex while clipping: x y z nx ny nz r g b lat netE netT b0 b1 wet delta. */
const REC = 16

/** The global 2 m grid around one chunk: its own padded data, and anything outside evaluated lazily (and cached). */
class Grid {
  private readonly hm = new Map<number, number>()
  private readonly cm = new Map<number, Float32Array>()
  private readonly sm = new Map<number, boolean>()
  private readonly i0: number
  private readonly j0: number
  private readonly va: VertexAttrs = { netEdge: 99, netType: -1, b0: 0, b1: 0 }

  constructor(
    private readonly f: WorldFields,
    cx: number,
    cz: number,
    private readonly padded: Float32Array,
    private readonly colors: Float32Array,
    private readonly normals: Float32Array,
    private readonly biome: Float32Array,
    private readonly heights0: Float32Array,
  ) {
    this.i0 = cx * CHUNK_RES
    this.j0 = cz * CHUNK_RES
  }

  private key(ix: number, iz: number): number {
    return (ix + 1048576) * 2097152 + (iz + 1048576)
  }

  /** Unsunk grid height at global vertex (ix, iz) — Float32-rounded like the chunk data. */
  h(ix: number, iz: number): number {
    const i = ix - this.i0 + 1, j = iz - this.j0 + 1
    if (i >= 0 && i < P && j >= 0 && j < P) return this.padded[j * P + i]
    const k = this.key(ix, iz)
    let v = this.hm.get(k)
    if (v === undefined) {
      v = Math.fround(this.f.height(ix * CELL_SIZE, iz * CELL_SIZE))
      this.hm.set(k, v)
    }
    return v
  }

  /** Colour (0..2), normal (3..5) and biome weights (6..7) of a global grid vertex: the chunk's own, or computed exactly
   *  as its owner does. */
  cn(ix: number, iz: number, out: number[]): void {
    const i = ix - this.i0, j = iz - this.j0
    if (i >= 0 && i <= CHUNK_RES && j >= 0 && j <= CHUNK_RES) {
      const v = j * CHUNK_VERTS + i, o = v * 3
      out[0] = this.colors[o]; out[1] = this.colors[o + 1]; out[2] = this.colors[o + 2]
      out[3] = this.normals[o]; out[4] = this.normals[o + 1]; out[5] = this.normals[o + 2]
      out[6] = this.biome[v * 2]; out[7] = this.biome[v * 2 + 1]
      return
    }
    const k = this.key(ix, iz)
    let c = this.cm.get(k)
    if (!c) {
      c = new Float32Array(8)
      const dx = this.h(ix + 1, iz) - this.h(ix - 1, iz), dz = this.h(ix, iz + 1) - this.h(ix, iz - 1)
      let nx = -dx, ny = 2 * CELL_SIZE, nz = -dz
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
      nx /= len; ny /= len; nz /= len
      vertexColor(this.f, ix * CELL_SIZE, iz * CELL_SIZE, this.h(ix, iz), ny, c, 0, this.va)
      c[3] = nx; c[4] = ny; c[5] = nz
      c[6] = this.va.b0; c[7] = this.va.b1
      this.cm.set(k, c)
    }
    for (let q = 0; q < 8; q++) out[q] = c[q]
  }

  /** Is the global grid vertex sunk (Road/RoadDetail.sunk)? */
  sunk(ix: number, iz: number): boolean {
    const i = ix - this.i0, j = iz - this.j0
    if (i >= 0 && i <= CHUNK_RES && j >= 0 && j <= CHUNK_RES) return this.heights0[j * CHUNK_VERTS + i] < this.padded[(j + 1) * P + i + 1]
    const k = this.key(ix, iz)
    let v = this.sm.get(k)
    if (v === undefined) {
      v = this.f.roadDetail.sunk(ix * CELL_SIZE, iz * CELL_SIZE)
      this.sm.set(k, v)
    }
    return v
  }

  /** The containing triangle of world (x, z) (same split as TerrainGeometry / sampleHeight / Rapier) → tri + weights. */
  tri(x: number, z: number, t: number[]): void {
    const gx = x / CELL_SIZE, gz = z / CELL_SIZE
    const ix = Math.floor(gx), iz = Math.floor(gz)
    const tx = gx - ix, tz = gz - iz
    if (tx + tz < 1) {
      t[0] = ix; t[1] = iz; t[2] = 1 - tx - tz
      t[3] = ix + 1; t[4] = iz; t[5] = tx
      t[6] = ix; t[7] = iz + 1; t[8] = tz
    } else {
      t[0] = ix + 1; t[1] = iz + 1; t[2] = tx + tz - 1
      t[3] = ix; t[4] = iz + 1; t[5] = 1 - tx
      t[6] = ix + 1; t[7] = iz; t[8] = 1 - tz
    }
  }

  /** Grid surface G at world (x, z) (the unsunk mesh's triangle). */
  G(x: number, z: number): number {
    const t = _tri
    this.tri(x, z, t)
    return this.h(t[0], t[1]) * t[2] + this.h(t[3], t[4]) * t[5] + this.h(t[6], t[7]) * t[8]
  }
}
const _tri = new Array<number>(9).fill(0)
const _cn = new Array<number>(8).fill(0)

/** One ribbon (a stretch of one road): rows × J vertices, evaluated lazily. */
interface Src {
  id: number
  rows: number
  J: number
  /** Global row index of row 0 (canonical vertex keys across chunks). */
  k0: number
  u: number[]
  /** Row centre, lateral unit direction (x, z) and the row parameter (z for the main road, arclength for tracks). */
  cx: Float64Array
  cz: Float64Array
  lx: Float64Array
  lz: Float64Array
  s: Float64Array
  track: Track | null
  /** Tracks: the ruts' sideways wander per row (the rut vertices follow it). */
  wan: Float64Array | null
}

/** Fresh empty arrays each time (they are transferred = detached by the worker's postMessage). */
const empty = (): RoadSurfaceArrays => ({ rdPos: new Float32Array(0), rdNor: new Float32Array(0), rdCol: new Float32Array(0), rdAttr: new Float32Array(0), rdDelta: new Float32Array(0), rdIdx: new Uint32Array(0), rdMinY: 0, rdMaxY: 0 })

export function buildRoadSurface(f: WorldFields, cx: number, cz: number, padded: Float32Array, colors: Float32Array, normals: Float32Array, biome: Float32Array, heights0: Float32Array): RoadSurfaceArrays {
  const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE, x1 = x0 + CHUNK_SIZE, z1 = z0 + CHUNK_SIZE
  const srcs: Src[] = []
  const rd = f.roadDetail
  // MAIN ROAD: rows at z = 2k from one row before the chunk to one after (normals), if it comes near.
  {
    const k0 = Math.floor(z0 / MAIN_STEP) - 1, k1 = Math.ceil(z1 / MAIN_STEP) + 1
    let near = false
    for (let k = k0; k <= k1 && !near; k++) {
      const c = f.roadCenterX(k * MAIN_STEP)
      if (c + MAIN_W >= x0 - 1 && c - MAIN_W <= x1 + 1) near = true
    }
    if (near) {
      const rows = k1 - k0 + 1
      const u = [...MAIN_U.slice(1).reverse().map((v) => -v), ...MAIN_U]
      const s: Src = { id: 0, rows, J: u.length, k0, u, cx: new Float64Array(rows), cz: new Float64Array(rows), lx: new Float64Array(rows).fill(1), lz: new Float64Array(rows), s: new Float64Array(rows), track: null, wan: null }
      for (let r = 0; r < rows; r++) {
        const z = (k0 + r) * MAIN_STEP
        s.cz[r] = z
        s.cx[r] = f.roadCenterX(z)
        s.s[r] = z
      }
      srcs.push(s)
    }
  }
  // NETWORK TRACKS: every run of every road whose rows come within reach of the chunk.
  {
    const seen = new Set<NetRoad>()
    const pad = 14
    const p = [0, 0, 0], tn = [0, 0]
    for (let cj = Math.floor((z0 - pad) / REGION); cj <= Math.floor((z1 + pad) / REGION); cj++) {
      for (let ci = Math.floor((x0 - pad) / REGION); ci <= Math.floor((x1 + pad) / REGION); ci++) {
        for (const r of f.network.roadsIn(ci, cj)) {
          if (seen.has(r)) continue
          seen.add(r)
          if (r.maxX < x0 - pad || r.minX > x1 + pad || r.maxZ < z0 - pad || r.minZ > z1 + pad) continue
          const t = rd.track(r)
          const reach = t.prof.W + 2
          for (let q = 0; q < t.runs.length; q += 2) {
            const ka = Math.round(t.runs[q] / TRACK_STEP), kb = Math.round(t.runs[q + 1] / TRACK_STEP)
            let k = ka
            while (k <= kb) {
              // Find the next stretch of rows whose centre is within reach of the chunk.
              const isNear = (kk: number) => {
                rd.point(r, kk * TRACK_STEP, p)
                return p[0] >= x0 - reach && p[0] <= x1 + reach && p[1] >= z0 - reach && p[1] <= z1 + reach
              }
              while (k <= kb && !isNear(k)) k++
              if (k > kb) break
              let e = k
              while (e + 1 <= kb && isNear(e + 1)) e++
              const ra = Math.max(ka, k - 1), rb = Math.min(kb, e + 1)
              const rows = rb - ra + 1
              const u = [...t.prof.u.slice(1).reverse().map((v) => -v), ...t.prof.u]
              const s: Src = { id: srcs.length, rows, J: u.length, k0: ra, u, cx: new Float64Array(rows), cz: new Float64Array(rows), lx: new Float64Array(rows), lz: new Float64Array(rows), s: new Float64Array(rows), track: t, wan: null }
              const wan = (s.wan = new Float64Array(rows))
              for (let i = 0; i < rows; i++) {
                const sv = (ra + i) * TRACK_STEP
                wan[i] = rd.wander(t, sv)
                rd.point(r, sv, p)
                rd.tangent(r, t.L, sv, tn)
                s.cx[i] = p[0]; s.cz[i] = p[1]
                s.lx[i] = -tn[1]; s.lz[i] = tn[0] // left of travel = + side (RoadNetwork.nearestRoad)
                s.s[i] = sv
              }
              srcs.push(s)
              k = e + 2
            }
          }
        }
      }
    }
  }
  if (!srcs.length) return empty()

  const grid = new Grid(f, cx, cz, padded, colors, normals, biome, heights0)
  const info: DetailInfo = detailInfo()
  const pos: number[] = [], nor: number[] = [], col: number[] = [], att: number[] = [], del: number[] = [], idx: number[] = []
  const outIdx = new Map<string, number>()
  let minY = Infinity, maxY = -Infinity
  const emit = (key: string, v: Float64Array): number => {
    let i = outIdx.get(key)
    if (i !== undefined) return i
    i = pos.length / 3
    pos.push(v[0] - x0, v[1], v[2] - z0)
    nor.push(v[3], v[4], v[5])
    col.push(v[6], v[7], v[8])
    att.push(v[9], v[10], v[11], v[12], v[13], v[14])
    del.push(v[15])
    if (v[1] < minY) minY = v[1]
    if (v[1] > maxY) maxY = v[1]
    outIdx.set(key, i)
    return i
  }

  for (const src of srcs) {
    const { rows, J } = src
    const n = rows * J
    const X = new Float64Array(n), Z = new Float64Array(n), U = new Float64Array(n), Gv = new Float64Array(n), D = new Float64Array(n), Wt = new Float64Array(n)
    const state = new Uint8Array(n) // 1 = G + Δ known
    const pr = src.track?.prof
    for (let r = 0; r < rows; r++) {
      for (let j = 0; j < J; j++) {
        // Track rows: the rut vertices wander with the ruts.
        const au = Math.abs(src.u[j])
        const u = pr && au >= pr.rutLo - 1e-6 && au <= pr.rutHi + 1e-6 ? src.u[j] + src.wan![r] : src.u[j]
        U[r * J + j] = u
        X[r * J + j] = src.cx[r] + src.lx[r] * u
        Z[r * J + j] = src.cz[r] + src.lz[r] * u
      }
    }
    const geom = (v: number) => {
      if (state[v]) return
      state[v] = 1
      const r = (v / J) | 0
      const x = X[v], z = Z[v]
      Gv[v] = grid.G(x, z)
      let d = src.track ? rd.trackDetail(src.track, src.s[r], U[v], info) : rd.mainDetail(x, z, U[v], info)
      let wet = info.wet
      // Safety net: a hollow only over a FULLY sunk grid triangle (the margins guarantee it; tests check it never bites).
      if (d < 0) {
        rdStats.hollows++
        grid.tri(x, z, _tri)
        if (!grid.sunk(_tri[0], _tri[1]) || !grid.sunk(_tri[3], _tri[4]) || !grid.sunk(_tri[6], _tri[7])) (d = 0), (wet = 0), rdStats.clamped++
      }
      D[v] = d
      Wt[v] = wet
    }
    // Needed quads: bbox intersects the chunk square.
    const qNeed = new Uint8Array((rows - 1) * (J - 1))
    for (let r = 0; r < rows - 1; r++) {
      for (let j = 0; j < J - 1; j++) {
        const a = r * J + j, b = a + 1, c = a + J, d = c + 1
        const mnx = Math.min(X[a], X[b], X[c], X[d]), mxx = Math.max(X[a], X[b], X[c], X[d])
        const mnz = Math.min(Z[a], Z[b], Z[c], Z[d]), mxz = Math.max(Z[a], Z[b], Z[c], Z[d])
        if (mxx < x0 || mnx > x1 || mxz < z0 || mnz > z1) continue
        qNeed[r * (J - 1) + j] = 1
        for (const v of [a, b, c, d]) {
          geom(v)
          const vr = (v / J) | 0, vj = v - vr * J
          if (vj > 0) geom(v - 1)
          if (vj < J - 1) geom(v + 1)
          if (vr > 0) geom(v - J)
          if (vr < rows - 1) geom(v + J)
        }
      }
    }
    // Full vertex record (position, normal, colour, attributes) of vertex v.
    const recs = new Map<number, Float64Array>()
    const rec = (v: number): Float64Array => {
      let o = recs.get(v)
      if (o) return o
      o = new Float64Array(REC)
      const r = (v / J) | 0, j = v - r * J
      const x = X[v], z = Z[v], g = Gv[v], d = D[v]
      o[0] = x; o[1] = g + d; o[2] = z
      // Grid normal + colour, interpolated like the GPU does on the terrain triangle.
      grid.tri(x, z, _tri)
      let nx = 0, ny = 0, nz = 0, cr = 0, cg = 0, cb = 0, b0 = 0, b1 = 0
      for (let q = 0; q < 9; q += 3) {
        grid.cn(_tri[q], _tri[q + 1], _cn)
        const w = _tri[q + 2]
        cr += _cn[0] * w; cg += _cn[1] * w; cb += _cn[2] * w
        nx += _cn[3] * w; ny += _cn[4] * w; nz += _cn[5] * w
        b0 += _cn[6] * w; b1 += _cn[7] * w
      }
      // Δ's gradient from the neighbours (across: j ± 1, along: r ± 1) tilts the grid normal.
      const ja = j > 0 ? v - 1 : v, jb = j < J - 1 ? v + 1 : v
      const ra = r > 0 && state[v - J] ? v - J : v, rb = r < rows - 1 && state[v + J] ? v + J : v
      const e1x = X[jb] - X[ja], e1z = Z[jb] - Z[ja], d1 = D[jb] - D[ja]
      const e2x = X[rb] - X[ra], e2z = Z[rb] - Z[ra], d2 = D[rb] - D[ra]
      const det = e1x * e2z - e1z * e2x
      let gx = 0, gz = 0
      if (Math.abs(det) > 1e-9) {
        gx = (d1 * e2z - e1z * d2) / det
        gz = (e1x * d2 - d1 * e2x) / det
      }
      const sx = -nx / ny + gx, sz = -nz / ny + gz
      const il = 1 / Math.sqrt(sx * sx + 1 + sz * sz)
      o[3] = -sx * il; o[4] = il; o[5] = -sz * il
      // A little ambient occlusion in the hollows (the ditch bottom, deep ruts).
      const ao = 1 - Math.min(0.22, Math.max(0, -d) * 0.65)
      o[6] = cr * ao; o[7] = cg * ao; o[8] = cb * ao
      o[9] = x - f.roadCenterX(z)
      if (src.track) {
        // Track rows: the edge distance in the row's own frame, shifted by the ruts' wander — the painted ruts, hump
        // and edges sit exactly on the carved ones.
        o[10] = Math.abs(U[v] - src.wan![r]) - src.track.prof.hw
        o[11] = src.track.road.type
      } else {
        const nr = f.netRoad(x, z, 10)
        o[10] = nr ? nr.dist - nr.halfWidth : 99
        o[11] = nr ? nr.type : -1
      }
      o[12] = b0; o[13] = b1 // interpolated like the terrain's attribute (the GPU does the same between grid vertices)
      o[14] = Wt[v]
      o[15] = d
      recs.set(v, o)
      return o
    }
    const vkey = (v: number) => {
      const r = (v / J) | 0
      return `${src.track ? src.track.road.key : 'main'}:${src.k0 + r}:${v - r * J}`
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let j = 0; j < J - 1; j++) {
        if (!qNeed[r * (J - 1) + j]) continue
        const a = r * J + j, b = a + 1, c = a + J, d = c + 1
        const inside = [a, b, c, d].every((v) => X[v] >= x0 && X[v] <= x1 && Z[v] >= z0 && Z[v] <= z1)
        for (const t of [[a, b, c], [b, d, c]]) {
          if (inside) tri(emitOrig(t[0]), emitOrig(t[1]), emitOrig(t[2]))
          else clipTri(t.map((v) => ({ key: vkey(v), v: rec(v) })))
        }
      }
    }
    function emitOrig(v: number): number {
      return emit(vkey(v), rec(v))
    }
  }

  /** Emit a triangle facing up (+y). */
  function tri(a: number, b: number, c: number): void {
    const ax = pos[a * 3], az = pos[a * 3 + 2]
    const ux = pos[b * 3] - ax, uz = pos[b * 3 + 2] - az, vx = pos[c * 3] - ax, vz = pos[c * 3 + 2] - az
    const ny = uz * vx - ux * vz
    if (Math.abs(ny) < 1e-7) return // degenerate (a sliver from clipping)
    if (ny > 0) idx.push(a, b, c)
    else idx.push(a, c, b)
  }

  /** Clip a triangle to the chunk square (x0..x1, z0..z1) and emit it as a fan. */
  function clipTri(poly: { key: string; v: Float64Array }[]): void {
    for (let plane = 0; plane < 4 && poly.length; plane++) {
      const axis = plane < 2 ? 0 : 2
      const lim = plane === 0 ? x0 : plane === 1 ? x1 : plane === 2 ? z0 : z1
      const keep = (p: Float64Array) => (plane % 2 === 0 ? p[axis] >= lim : p[axis] <= lim)
      const out: { key: string; v: Float64Array }[] = []
      for (let i = 0; i < poly.length; i++) {
        const A = poly[i], B = poly[(i + 1) % poly.length]
        const ina = keep(A.v), inb = keep(B.v)
        if (ina) out.push(A)
        if (ina !== inb) out.push(cut(A, B, axis, lim, plane))
      }
      poly = out
    }
    if (poly.length < 3) return
    const ids = poly.map((p) => emit(p.key, p.v))
    for (let i = 1; i < ids.length - 1; i++) tri(ids[0], ids[i], ids[i + 1])
  }

  /** Edge ∩ plane, computed from the canonically ordered endpoints (bit-identical in both chunks sharing it). */
  function cut(A: { key: string; v: Float64Array }, B: { key: string; v: Float64Array }, axis: number, lim: number, plane: number): { key: string; v: Float64Array } {
    const sw = A.v[0] > B.v[0] || (A.v[0] === B.v[0] && (A.v[2] > B.v[2] || (A.v[2] === B.v[2] && A.v[1] > B.v[1])))
    const p = sw ? B : A, q = sw ? A : B
    const t = (lim - p.v[axis]) / (q.v[axis] - p.v[axis])
    const o = new Float64Array(REC)
    for (let k = 0; k < REC; k++) o[k] = p.v[k] + (q.v[k] - p.v[k]) * t
    o[axis] = lim
    o[11] = t < 0.5 ? p.v[11] : q.v[11] // road type: nearest end, not a blend
    return { key: `${p.key}|${q.key}|${plane}`, v: o }
  }

  if (!idx.length) return empty()
  return {
    rdPos: new Float32Array(pos), rdNor: new Float32Array(nor), rdCol: new Float32Array(col), rdAttr: new Float32Array(att),
    rdDelta: new Float32Array(del), rdIdx: new Uint32Array(idx), rdMinY: minY, rdMaxY: maxY,
  }
}
