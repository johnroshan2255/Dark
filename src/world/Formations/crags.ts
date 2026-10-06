import { CELL_SIZE, CHUNK_RES, CHUNK_SIZE, CHUNK_VERTS } from '../constants'
import { hashFloat, Layer } from '../noise/rng'
import { sampleHeight } from '../Terrain/generateTerrain'
import { WorldFields } from '../WorldFields'
import type { BiomeWeights } from '../Biomes'

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
      if (fields.pois.near(wx, wz, 6) || fields.formations.near(wx, wz, 2) || fields.landmarks.near(wx, wz, 8)) continue
      addCrag(fields, out, lx, lz, wx, wz, h0, _g[0] / g, _g[1] / g, g, ws, wd, seed, gx, gz, L)
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
