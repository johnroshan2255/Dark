import { CELL_SIZE, CHUNK_RES, CHUNK_SIZE, CHUNK_VERTS } from '../constants'
import { hashFloat, Layer } from '../noise/rng'
import { sampleHeight } from '../Terrain/generateTerrain'
import { WorldFields } from '../WorldFields'
import type { BiomeWeights } from '../Biomes'
import { nearBridge } from '../Road/bridges'

/**
 * CRAGS — Genshin's rocky hillsides (Starsnatch Cliff, Mt. Hulao, Stone Gate): a heightfield slope is only a smooth
 * sheet, so every STEEP slope is clad in real rock — irregular 8-sided columns of 4 kinked tiers standing in the hillside, their
 * base buried below the slope and their chiselled tops sticking out as ledges. Stacked down a cliff they break the
 * face (and its silhouette) into blocks of lit and shaded planes, with grass / sand / snow on the up-facing tops.
 *
 * Placement: one jittered candidate per GLOBAL cell per pass (Layer.Crags), kept with a probability rising with the slope
 * (≥ ~45°), off every road, out of the water and clear of places, formations and landmarks. Arithmetic + sqrt only
 * (no trig): identical on every client. The pieces are appended to the chunk's formation mesh → the same draw and
 * the same exact trimesh collider (PhysicsWorld), so you stand on the ledges and the truck hits the rock.
 * Cost: 56 tris per crag, ≤ 16 masses + ~22 blocks per chunk (≈ 2 k tris on a cliff chunk, 0 on flat ones), one draw shared with
 * formations; ~0.1 ms of worker time per chunk.
 */

/**
 * Two passes: MASSES (16 m cells, 16–26 m wide, nearly every steep cell) overlap into continuous rock walls; BLOCKS
 * (8 m cells, 5–11 m, a quarter of the cells) break them up. Salts are per pass (cell coords repeat between passes).
 */
const PASSES = [
  { cell: 16, ws: 8, wsVar: 5, wd: 5, wdVar: 3.5, keep: 1, base: 0.85, salt: 0 },
  { cell: 8, ws: 2.6, wsVar: 3, wd: 2.2, wdVar: 2.4, keep: 0.25, base: 0.25, salt: 64 },
] as const
/**
 * GENSHIN (palette 2): broad, smooth SLABS — Genshin's cliffs are a few big rounded rock masses with grassy tops, not
 * a field of narrow columns (that read as sharp, busy spikes). Masses ~1.5× wider and shorter-kinked, the small
 * block pass almost gone, outlines nearly convex.
 */
const PASSES_GENSHIN = [
  { cell: 16, ws: 12, wsVar: 6, wd: 6, wdVar: 3, keep: 0.75, base: 0.7, salt: 0 },
  { cell: 8, ws: 2.6, wsVar: 3, wd: 2.2, wdVar: 2.4, keep: 0.05, base: 0.25, salt: 64 },
] as const
/** Slope (|∇h|, rise per metre) where crags start (≈ 43°) and where every cell gets one (≈ 56°). */
export const CRAG_SLOPE0 = 0.95
const CRAG_SLOPE1 = 1.5

/** Height gradient (dh/dx, dh/dz) of the chunk's LOD0 grid at chunk-local (lx, lz), over ±2 m (one-sided at borders). */
export function gridSlope(heights: Float32Array, lx: number, lz: number, out: [number, number]): [number, number] {
  const ix = Math.min(CHUNK_RES, Math.max(0, Math.round(lx / CELL_SIZE)))
  const iz = Math.min(CHUNK_RES, Math.max(0, Math.round(lz / CELL_SIZE)))
  const x0 = Math.max(0, ix - 1), x1 = Math.min(CHUNK_RES, ix + 1)
  const z0 = Math.max(0, iz - 1), z1 = Math.min(CHUNK_RES, iz + 1)
  out[0] = (heights[iz * CHUNK_VERTS + x1] - heights[iz * CHUNK_VERTS + x0]) / ((x1 - x0) * CELL_SIZE)
  out[1] = (heights[z1 * CHUNK_VERTS + ix] - heights[z0 * CHUNK_VERTS + ix]) / ((z1 - z0) * CELL_SIZE)
  return out
}

// Octagon directions (exact constants — no trig at runtime).
const R2 = 0.70710678
const DIRS = [1, 0, R2, R2, 0, 1, -R2, R2, -1, 0, -R2, -R2, 0, -1, R2, -R2]
const N = 8
/** Tiers of a crag: height fraction, radius scale (base, random range). Kinked tiers → stacked, sculpted rock. */
const TIERS = [[0, 1, 0], [0.38, 0.94, 0.16], [0.74, 0.84, 0.18], [1, 0.58, 0.24]] as const

export interface CragMesh {
  pos: number[]
  nor: number[]
  col: number[]
}

const _g: [number, number] = [0, 0]
const _bw: BiomeWeights = [0, 0]

/** Append the crags of chunk (cx, cz) to `out` (chunk-local positions, flat normals, linear vertex colours). */
export function buildCrags(fields: WorldFields, cx: number, cz: number, heights: Float32Array, out: CragMesh): number {
  const seed = fields.seed
  let count = 0
  for (const P of fields.palette === 2 ? PASSES_GENSHIN : PASSES) {
  const CRAG_CELL = P.cell
  const per = CHUNK_SIZE / CRAG_CELL
  const L = Layer.Crags * 16 + P.salt
  for (let j = 0; j < per; j++) {
    for (let i = 0; i < per; i++) {
      const gx = cx * per + i, gz = cz * per + j
      const lx = (i + 0.15 + 0.7 * hashFloat(seed, gx, gz, L)) * CRAG_CELL
      const lz = (j + 0.15 + 0.7 * hashFloat(seed, gx, gz, L + 1)) * CRAG_CELL
      gridSlope(heights, lx, lz, _g)
      const g = Math.sqrt(_g[0] * _g[0] + _g[1] * _g[1])
      if (g < CRAG_SLOPE0) continue
      const t = Math.min(1, (g - CRAG_SLOPE0) / (CRAG_SLOPE1 - CRAG_SLOPE0))
      if (hashFloat(seed, gx, gz, L + 2) > (P.base + (1 - P.base) * t) * P.keep) continue
      const wx = cx * CHUNK_SIZE + lx, wz = cz * CHUNK_SIZE + lz
      const h0 = sampleHeight(heights, lx, lz)
      if (h0 < WorldFields.WATER + 0.5) continue
      const r = hashFloat(seed, gx, gz, L + 3)
      const ws = P.ws + P.wsVar * r // half-width across the slope
      const wd = P.wd + P.wdVar * hashFloat(seed, gx, gz, L + 4) // half-depth down the slope
      if (fields.anyRoadEdge(wx, wz) < 4 + ws) continue
      if (fields.pois.near(wx, wz, 6) || fields.formations.near(wx, wz, 2) || fields.landmarks.near(wx, wz, 8) || nearBridge(fields, wx, wz, Math.max(ws, wd) * 1.4 + 4)) continue
      if (fields.palette === 0) addSlabs(fields, out, lx, lz, wx, wz, h0, _g[0] / g, _g[1] / g, g, ws, wd, seed, gx, gz, L, P.salt > 0)
      else addCrag(fields, out, lx, lz, wx, wz, h0, _g[0] / g, _g[1] / g, g, ws, wd, seed, gx, gz, L)
      count++
    }
  }
  }
  return count
}

function addCrag(
  fields: WorldFields, out: CragMesh, lx: number, lz: number, wx: number, wz: number, h0: number,
  ux: number, uz: number, g: number, ws: number, wd: number, seed: number, gx: number, gz: number, L: number,
): void {
  const hf = (k: number) => hashFloat(seed, gx, gz, L + 5 + k)
  // Frame: d = downhill (the face looks out of the hill), s = across the slope.
  const dx = -ux, dz = -uz, sx = -dz, sz = dx
  // Random rotation of the octagon (a unit vector from two hashes, normalised — no trig).
  let rc = hf(0) - 0.5, rs = hf(1) - 0.5
  const rl = Math.sqrt(rc * rc + rs * rs) || 1
  rc /= rl; rs /= rl
  // Vertical extent: the bottom tier is buried below the slope at the downhill edge; the top is a ledge standing
  // 25–100 % of the slope's drop above the centre (buried at the uphill side, exposed toward the valley).
  const reach = Math.max(ws, wd)
  const yb = h0 - g * reach * 1.5 - 2
  const yt = h0 + (0.25 + 0.75 * hf(2)) * g * wd + hf(3) * 3
  const yspan = yt - yb
  const gen = fields.palette === 2
  // Genshin (palette 2): rounded slab tops, not pointed crowns.
  const jag = (gen ? 0.07 : 0.22) * ws
  // Tier centres wander (outward lean + sideways kinks) → the column breaks into stacked, offset blocks.
  const T = TIERS.length
  const cx: number[] = [], cz: number[] = []
  for (let t = 0; t < T; t++) {
    // (Genshin: much smaller kinks — smooth, rounded rock masses, not stacked sharp blocks.)
    const lean = t === 0 ? 0 : (hf(50 + t) - 0.4) * (gen ? 0.08 : 0.22) * wd * t
    const side = t === 0 ? 0 : (hf(55 + t) - 0.5) * (gen ? 0.08 : 0.25) * ws
    cx.push(lx + dx * lean + sx * side)
    cz.push(lz + dz * lean + sz * side)
  }
  // Vertices: tier t, corner k (chunk-local) + a horizontal radial direction per vertex (for soft normals).
  const P: number[] = [], RN: number[] = []
  for (let t = 0; t < T; t++) {
    const [fy, sc, var_] = TIERS[t]
    const tierS = sc + var_ * (hf(60 + t) - 0.5) * 2
    for (let k = 0; k < N; k++) {
      const hx = DIRS[k * 2], hz = DIRS[k * 2 + 1]
      const ca = hx * rc - hz * rs, cb = hx * rs + hz * rc
      const jit = gen ? 0.94 + 0.08 * hf(10 + t * N + k) : 0.68 + 0.5 * hf(10 + t * N + k) // irregular outline (Genshin: near-convex slabs)
      const a = ca * wd * tierS * jit, b = cb * ws * tierS * jit
      const ox = dx * a + sx * b, oz = dz * a + sz * b
      const y = yb + yspan * fy + (t === T - 1 ? (hf(40 + k) - 0.5) * 2 * jag : t > 0 ? (hf(30 + t * N + k) - 0.5) * (gen ? 0.04 : 0.12) * yspan : 0)
      P.push(cx[t] + ox, y, cz[t] + oz)
      const ol = Math.sqrt(ox * ox + oz * oz) || 1
      RN.push(ox / ol, oz / ol)
    }
  }
  const capX = cx[T - 1], capZ = cz[T - 1], capY = yt + jag * (0.15 + 0.35 * hf(48))
  // Rock colour (linear): Genshin slate blue-grey with warm lavender-grey patches; sandstone in the desert,
  // cold grey-blue in the snow. Per vertex: darker toward the buried foot (painted AO), ±12 % mottling.
  const w = fields.biome(wx, wz, _bw, h0)
  const sand = w[0], snow = w[1]
  const v0 = 0.88 + 0.24 * hf(41), warm0 = hf(42)
  const rock = (vi: number, o: number[]) => {
    const fy = (P[vi * 3 + 1] - yb) / yspan
    const wm = Math.min(1, warm0 * 0.6 + hf(70 + (vi % 24)) * 0.5)
    // = the terrain's cliff stone (stylize CLIFFS): slate blue-grey, or Genshin's warm light grey (palette 2).
    let r = gen ? 0.47 + 0.08 * wm : 0.17 + 0.07 * wm, gg = gen ? 0.44 + 0.07 * wm : 0.21 + 0.04 * wm, b = gen ? 0.37 + 0.05 * wm : 0.3 + 0.01 * wm
    r += (0.46 - r) * sand; gg += (0.23 - gg) * sand; b += (0.12 - b) * sand
    r += (0.22 - r) * snow; gg += (0.25 - gg) * snow; b += (0.32 - b) * snow
    const k = v0 * (0.58 + 0.42 * Math.min(1, Math.max(0, fy))) * (0.88 + 0.24 * hf(100 + (vi % 32)))
    o[0] = r * k; o[1] = gg * k; o[2] = b * k
    return o
  }
  // Ground cover on the cap (meadow / warm sand / snow), fading to rock at the rim; moss drips onto the top tier.
  const cover = [0.1 + (0.62 - 0.1) * sand + (0.86 - 0.1) * snow, 0.21 + (0.42 - 0.21) * sand + (0.89 - 0.21) * snow, 0.04 + (0.2 - 0.04) * sand + (0.95 - 0.04) * snow]
  const MOSS = [0.1, 0.19, 0.04]
  const c0 = [0, 0, 0], c1 = [0, 0, 0], c2 = [0, 0, 0]
  const mix = (o: number[], t: readonly number[], k: number) => { o[0] += (t[0] - o[0]) * k; o[1] += (t[1] - o[1]) * k; o[2] += (t[2] - o[2]) * k }

  // One triangle: winding fixed so the face looks away from (ox, oz) (or up on the cap); per-vertex normals blend
  // the flat face normal with the vertex's radial (or up) direction → readable planes, but soft painted shading
  // instead of hard toy facets.
  // Facet share of the shading normal: Genshin's rock reads as soft rounded slabs (more radial), else planes.
  const faceK = fields.palette === 2 ? 0.0 : 0.55 // Genshin: fully rounded (radial) shading — smooth rock, no facets
  const tri = (a: number, b: number, c: number, ca: number[], cb: number[], cc: number[], ox: number, oz: number, cap: boolean) => {
    let A = a, B = b, C = c, CA = ca, CB = cb, CC = cc
    const px = (i: number) => (i < 0 ? capX : P[i * 3]), py = (i: number) => (i < 0 ? capY : P[i * 3 + 1]), pz = (i: number) => (i < 0 ? capZ : P[i * 3 + 2])
    let nx = (py(B) - py(A)) * (pz(C) - pz(A)) - (pz(B) - pz(A)) * (py(C) - py(A))
    let ny = (pz(B) - pz(A)) * (px(C) - px(A)) - (px(B) - px(A)) * (pz(C) - pz(A))
    let nz = (px(B) - px(A)) * (py(C) - py(A)) - (py(B) - py(A)) * (px(C) - px(A))
    const flip = cap ? ny < 0 : nx * ((px(A) + px(B) + px(C)) / 3 - ox) + nz * ((pz(A) + pz(B) + pz(C)) / 3 - oz) < 0
    if (flip) { nx = -nx; ny = -ny; nz = -nz; B = c; C = b; CB = cc; CC = cb }
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    nx /= nl; ny /= nl; nz /= nl
    const verts = [A, B, C], cols = [CA, CB, CC]
    for (let q = 0; q < 3; q++) {
      const i = verts[q]
      out.pos.push(px(i), py(i), pz(i))
      let mx: number, my: number, mz: number
      if (cap || i < 0) (mx = nx * 0.5), (my = ny * 0.5 + 0.5), (mz = nz * 0.5)
      else if (faceK === 0) { // rounded: radial out, tilting up toward the top tier (a dome, not a cylinder)
        const fy = (py(i) - yb) / yspan
        mx = RN[i * 2]; my = -0.15 + 0.75 * fy * fy; mz = RN[i * 2 + 1]
      }
      else (mx = nx * faceK + RN[i * 2] * (1 - faceK)), (my = ny * faceK), (mz = nz * faceK + RN[i * 2 + 1] * (1 - faceK))
      const ml = Math.sqrt(mx * mx + my * my + mz * mz) || 1
      out.nor.push(mx / ml, my / ml, mz / ml)
      out.col.push(cols[q][0], cols[q][1], cols[q][2])
    }
  }
  const sideCol = (vi: number, o: number[]) => {
    rock(vi, o)
    if (vi >= (T - 1) * N) mix(o, MOSS, (0.08 + 0.22 * hf(110 + (vi % N))) * (1 - snow) * (1 - sand)) // moss creeping over the rim
    return o
  }
  for (let t = 0; t < T - 1; t++) {
    for (let k = 0; k < N; k++) {
      const a = t * N + k, b = t * N + ((k + 1) % N), c = (t + 1) * N + ((k + 1) % N), d = (t + 1) * N + k
      const ox = (cx[t] + cx[t + 1]) / 2, oz = (cz[t] + cz[t + 1]) / 2
      tri(a, b, c, sideCol(a, c0).slice(), sideCol(b, c1).slice(), sideCol(c, c2).slice(), ox, oz, false)
      tri(a, c, d, sideCol(a, c0).slice(), sideCol(c, c1).slice(), sideCol(d, c2).slice(), ox, oz, false)
    }
  }
  // Jagged cap: a fan from a raised centre (grass at the centre fading to rock at the rim).
  const capCol = cover.slice()
  for (let k = 0; k < N; k++) {
    const a = (T - 1) * N + k, b = (T - 1) * N + ((k + 1) % N)
    const ra = rock(a, c0).slice(), rb = rock(b, c1).slice()
    mix(ra, cover, 0.4); mix(rb, cover, 0.4)
    tri(-1, a, b, capCol, ra, rb, capX, capZ, true)
  }
}

/**
 * BRIGHT (palette 0) — "over the hill" canyon rock: each crag is a STACK of 2–6 broad, thick SLABS (pancakes of
 * rock 2.5–6 m high), each its own size, rotation and offset, so the cliff reads as piled blocks with overhanging
 * lips and dark undersides. Every slab is an irregular octagon with 4 rings (tucked foot, belly, rounded shoulder, top
 * rim) and SMOOTH rounded normals (15 % facet) → soft boulders like theirs, not hard prisms; one colour per slab
 * (no paint strokes / strata — the shape carries the detail), shaded foot → lighter shoulder and top, dark undersides.
 * Cost: ≈ 56 tris per slab (sides 48 + top 8, + 8 under an overhang); masses avg ~4 slabs ≈ 230 tris per crag.
 */
/** Slab rings: height fraction, radius scale, normal tilt (rad, − = facing down / + = up) → a rounded, bevelled
 *  block: tucked-in foot, full belly, rounded shoulder, narrower top rim. */
const SLAB_RINGS = [[0, 0.86, -0.75], [0.22, 1, -0.05], [0.74, 0.97, 0.3], [1, 0.8, 0.95]] as const

function addSlabs(
  fields: WorldFields, out: CragMesh, lx: number, lz: number, wx: number, wz: number, h0: number,
  ux: number, uz: number, g: number, ws: number, wd: number, seed: number, gx: number, gz: number, L: number, small: boolean,
): void {
  const hf = (k: number) => hashFloat(seed, gx, gz, L + 5 + k)
  const dx = -ux, dz = -uz, sx = -dz, sz = dx
  const reach = Math.max(ws, wd)
  const yb = h0 - g * reach * 1.2 - 1.5
  const yt = h0 + (0.3 + 0.8 * hf(2)) * g * wd + hf(3) * 3
  const yspan = yt - yb
  const w = fields.biome(wx, wz, _bw, h0)
  const sand = w[0], snow = w[1]
  // Base rock colour (linear): warm sandstone in the desert, cool blue-grey stone in the green lands, grey-blue in
  // the snow; ±10 % per crag.
  const v0 = 0.9 + 0.2 * hf(41)
  let br = 0.3 + 0.04 * hf(42), bg = 0.3 + 0.02 * hf(43), bb = 0.32 + 0.03 * hf(44)
  br += (0.62 - br) * sand; bg += (0.31 - bg) * sand; bb += (0.19 - bb) * sand
  br += (0.42 - br) * snow; bg += (0.46 - bg) * snow; bb += (0.54 - bb) * snow
  const cover = [0.13 + (0.7 - 0.13) * sand + (0.86 - 0.13) * snow, 0.27 + (0.42 - 0.27) * sand + (0.89 - 0.27) * snow, 0.05 + (0.24 - 0.05) * sand + (0.95 - 0.05) * snow]
  // Slabs: 2.5–6 m thick each (small blocks: 1–2 slabs).
  const nMax = small ? 2 : 6
  const n = Math.max(1, Math.min(nMax, Math.round(yspan / (3.2 + 2.2 * hf(4)))))
  const slabH = yspan / n
  let ox0 = lx, oz0 = lz
  for (let si = 0; si < n; si++) {
    const hs = (k: number) => hf(200 + si * 23 + k)
    const y0 = yb + si * slabH - (si > 0 ? 0.25 : 0), y1 = yb + (si + 1) * slabH
    // Upper slabs a little smaller on average, each wider or narrower (pancake stack with lips), leaning out.
    const sc = (1 - 0.35 * (si / Math.max(1, n))) * (0.78 + 0.34 * hs(0))
    const lean = (hs(1) - 0.35) * 0.18 * wd, side = (hs(2) - 0.5) * 0.3 * ws
    const cxs = ox0 + dx * lean + sx * side, czs = oz0 + dz * lean + sz * side
    ox0 = lx + (cxs - lx) * 0.5; oz0 = lz + (czs - lz) * 0.5
    let rc = hs(3) - 0.5, rs = hs(4) - 0.5
    const rl = Math.sqrt(rc * rc + rs * rs) || 1
    rc /= rl; rs /= rl
    // Ring vertices (chunk-local).
    const R: number[] = []
    const jit: number[] = []
    for (let k = 0; k < N; k++) jit.push(0.8 + 0.22 * hs(10 + k))
    for (let r = 0; r < SLAB_RINGS.length; r++) {
      const [fy, rs2] = SLAB_RINGS[r]
      const y = y0 + (y1 - y0) * fy + (r === SLAB_RINGS.length - 1 ? (hs(30 + r) - 0.5) * 0.25 : 0)
      for (let k = 0; k < N; k++) {
        const hx = DIRS[k * 2], hz = DIRS[k * 2 + 1]
        const ca = hx * rc - hz * rs, cb = hx * rs + hz * rc
        const a = ca * wd * sc * rs2 * jit[k], b = cb * ws * sc * rs2 * jit[k]
        R.push(cxs + dx * a + sx * b, y + (r === SLAB_RINGS.length - 1 ? (hs(40 + k) - 0.5) * 0.18 * slabH : 0), czs + dz * a + sz * b)
      }
    }
    // Slab colour: its own tone (±9 %), darker toward the buried foot of the stack, lighter tops.
    const tone = v0 * (0.91 + 0.18 * hs(5)) * (0.72 + 0.28 * Math.min(1, (si + 0.5) / n))
    const side3 = [br * tone, bg * tone, bb * tone]
    const lip = [side3[0] * 0.62, side3[1] * 0.62, side3[2] * 0.66] // under the bevel / underside: in shade
    const top3 = [side3[0] * 1.14, side3[1] * 1.12, side3[2] * 1.1]
    if (si === n - 1) { const k = 0.55 + 0.25 * hs(6); top3[0] += (cover[0] - top3[0]) * k; top3[1] += (cover[1] - top3[1]) * k; top3[2] += (cover[2] - top3[2]) * k }
    const cyTop = y1 + 0.08 * slabH
    const tri = (A: number[], B: number[], C: number[], ca: number[], cb: number[], cc: number[], ref: number[], up: number): void => {
      let ax = A[0], ay = A[1], az = A[2], bx = B[0], by = B[1], bz = B[2], cx2 = C[0], cy = C[1], cz2 = C[2]
      let nx = (by - ay) * (cz2 - az) - (bz - az) * (cy - ay)
      let ny = (bz - az) * (cx2 - ax) - (bx - ax) * (cz2 - az)
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx2 - ax)
      let c1 = cb, c2 = cc
      const flip = up !== 0 ? ny * up < 0 : nx * ((ax + bx + cx2) / 3 - ref[0]) + nz * ((az + bz + cz2) / 3 - ref[2]) < 0
      if (flip) {
        nx = -nx; ny = -ny; nz = -nz
        const tx = bx, ty = by, tz = bz; bx = cx2; by = cy; bz = cz2; cx2 = tx; cy = ty; cz2 = tz
        c1 = cc; c2 = cb
      }
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
      nx /= nl; ny /= nl; nz /= nl
      const P3 = [ax, ay, az, bx, by, bz, cx2, cy, cz2], C3 = [ca, c1, c2]
      const T3 = flip ? [A[3], C[3], B[3]] : [A[3], B[3], C[3]]
      for (let q = 0; q < 3; q++) {
        const px = P3[q * 3], py = P3[q * 3 + 1], pz = P3[q * 3 + 2]
        // SOFT, rounded shading: a smooth normal per vertex (out from the slab's axis, tilted down at the foot and
        // up over the shoulder; straight up / down at the cap centres) with only 15 % of the flat face mixed in —
        // the light rolls over each block instead of breaking into hard facets.
        let rx = px - ref[0], rz = pz - ref[2]
        const rl2 = Math.sqrt(rx * rx + rz * rz)
        const t = T3[q]
        let sx2: number, sy2: number, sz2: number
        if (rl2 < 1e-3 || t === undefined) (sx2 = 0), (sy2 = up < 0 ? -1 : 1), (sz2 = 0)
        else (rx /= rl2), (rz /= rl2), (sx2 = rx * Math.cos(t)), (sy2 = Math.sin(t)), (sz2 = rz * Math.cos(t))
        let mx = nx * 0.15 + sx2 * 0.85, my = ny * 0.15 + sy2 * 0.85, mz = nz * 0.15 + sz2 * 0.85
        const ml = Math.sqrt(mx * mx + my * my + mz * mz) || 1
        mx /= ml; my /= ml; mz /= ml
        out.pos.push(px, py, pz)
        out.nor.push(mx, my, mz)
        out.col.push(C3[q][0], C3[q][1], C3[q][2])
      }
    }
    const V = (r: number, k: number) => [R[(r * N + k) * 3], R[(r * N + k) * 3 + 1], R[(r * N + k) * 3 + 2], SLAB_RINGS[r][2]]
    const ref = [cxs, 0, czs]
    // Colour by ring: shaded foot → body → lighter shoulder (soft painted AO, no hard bands).
    const ringCol = [lip, side3.map((v) => v * 0.94), side3, side3.map((v, i) => v + (top3[i] - v) * 0.4)]
    for (let r = 0; r < SLAB_RINGS.length - 1; r++) {
      const ca = ringCol[r], cb = ringCol[r + 1]
      for (let k = 0; k < N; k++) {
        const k1 = (k + 1) % N
        tri(V(r, k), V(r, k1), V(r + 1, k1), ca, ca, cb, ref, 0)
        tri(V(r, k), V(r + 1, k1), V(r + 1, k), ca, cb, cb, ref, 0)
      }
    }
    const topC = [cxs, cyTop, czs, Math.PI / 2]
    const T = SLAB_RINGS.length - 1
    for (let k = 0; k < N; k++) tri(topC, V(T, k), V(T, (k + 1) % N), top3, top3, top3, ref, 1)
    // Underside of an overhanging slab (visible from below).
    if (si > 0) {
      const botC = [cxs, y0 - 0.05, czs, -Math.PI / 2]
      for (let k = 0; k < N; k++) tri(botC, V(0, k), V(0, (k + 1) % N), lip, lip, lip, ref, -1)
    }
  }
}
