import { CELL_SIZE, CHUNK_RES, CHUNK_SIZE, CHUNK_VERTS } from '../constants'
import { hash4, hashFloat, Layer } from '../noise/rng'
import { sampleHeight } from '../Terrain/generateTerrain'
import { WorldFields } from '../WorldFields'
import type { BiomeWeights } from '../Biomes'
import { nearBridge } from '../Road/bridges'
import { MAIN_DITCH_IN, MAIN_DITCH_W } from '../Road/RoadDetail'
const MAIN_DITCH_OUT = MAIN_DITCH_IN + MAIN_DITCH_W

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

/** Smooth 3D value noise in [0, 1] at world (x, y, z) / cell (hash per lattice corner, smoothstep blend). */
function vnoise3(seed: number, x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  let fx = x - ix, fy = y - iy, fz = z - iz
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz)
  const c = (a: number, b: number, d: number) => hash4(seed, ix + a, iy + b, iz + d) / 4294967296
  const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * fx, x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * fx
  const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * fx, x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * fx
  const y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy
  return y0 + (y1 - y0) * fz
}

/**
 * EROSION over the crags (user, 2026-10-18: "the rocks and hills were good but repeating — add natural erosion and
 * noise over them"): a radial scale for a rock vertex at WORLD (x, y, z), so the same placement recipe never gives
 * the same rock twice and neighbouring stones share the weathering of the place they stand in:
 *   - lumps (3.2 m and 1.2 m noise, ±16 % / ±7 %): bulges and hollows in the outline;
 *   - RUNNELS: noise stretched 5× vertically (1.5 m across, 7 m tall) cuts flutes into the walls — rain runs down
 *     them, so they are stronger high on the rock and fade toward the buried foot (`up` 0..1);
 *   - spalling: the rim of the top weathers back (smaller near the crown).
 * The fine detail (runnels, cracks, stains, lichen) is painted in the rock shader (stylize `erosion`).
 */
function erode(seed: number, x: number, y: number, z: number, up: number): number {
  const lump = (vnoise3(seed, x / 3.2, y / 3.2, z / 3.2) - 0.5) * 0.32 + (vnoise3(seed + 1, x / 1.2, y / 1.2, z / 1.2) - 0.5) * 0.14
  const run = vnoise3(seed + 2, x / 1.5, y / 7, z / 1.5)
  const flute = -Math.max(0, 0.55 - run) * 0.35 * (0.3 + 0.7 * up)
  return 1 + lump + flute - 0.06 * up * up
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
      // Clear of every road (bright tors: their spread across the slope and the rubble below them). The canyon
      // walls 10 m off the road get rock too (with the old across-slope margin they stayed bare sand slopes).
      if (fields.anyRoadEdge(wx, wz) < (fields.palette === 0 ? 3 + Math.max(wd * 1.7 + 1.5, ws * 1.3) : 4 + ws)) continue
      if (fields.pois.near(wx, wz, 6) || fields.formations.near(wx, wz, 2) || fields.landmarks.near(wx, wz, 8) || nearBridge(fields, wx, wz, Math.max(ws, wd) * 1.4 + 4)) continue
      if (fields.palette === 0) addTor(fields, out, lx, lz, wx, wz, h0, _g[0] / g, _g[1] / g, g, ws, wd, seed, gx, gz, L, P.salt > 0)
      else addCrag(fields, out, lx, lz, wx, wz, h0, _g[0] / g, _g[1] / g, g, ws, wd, seed, gx, gz, L)
      count++
    }
  }
  }
  if (fields.palette === 0) count += canyonWalls(fields, cx, cz, out)
  return count
}

/**
 * BRIGHT CANYON WALLS: where a gorge / desert canyon wall stands beside the main road (WorldFields.gorge — a narrow
 * 5–9 m steep band the random crag cells rarely hit), both walls are lined with slab stacks every ~7 m along the
 * road, from below road level to just over the wall top — a continuous wall of piled rock like their canyons.
 * Deterministic per 7 m step (salted hash); clear of the road (≥ 5 m), secondary roads, places and bridges.
 */
function canyonWalls(fields: WorldFields, cx: number, cz: number, out: CragMesh): number {
  const seed = fields.seed, x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE
  const STEP = 7, L = Layer.Crags * 16 + 128
  let n = 0
  for (let k = Math.ceil(z0 / STEP); k * STEP < z0 + CHUNK_SIZE; k++) {
    for (const side of [-1, 1]) {
      const z = k * STEP + (hashFloat(seed, k, side, L) - 0.5) * 3
      const rx = fields.roadCenterX(z)
      const rh = fields.roadHeight(z)
      // (NOT a fence of equal stacks every 7 m: ~1/4 of the steps are gaps, the set-back varies 15–20 m, the width
      // 3–8 m and the top ±3 m about the wall's crest — a ragged natural wall)
      if (hashFloat(seed, k, side, L + 9) < 0.25) continue
      const dOut = WorldFields.ROAD_HALF_WIDTH + 12.5 + hashFloat(seed, k, side, L + 1) * 5
      const x = rx + side * dOut
      if (x < x0 || x >= x0 + CHUNK_SIZE || z < z0 || z >= z0 + CHUNK_SIZE) continue
      const top = fields.height(rx + side * (WorldFields.ROAD_HALF_WIDTH + 24), z)
      if (top - rh < 8) continue // no wall here
      if (fields.netRoad(x, z, 12) || fields.pois.near(x, z, 8) || nearBridge(fields, x, z, 8) || fields.landmarks.near(x, z, 8)) continue
      const ws = 3 + 5 * hashFloat(seed, k, side, L + 2) ** 1.5, wd = 3 + 2.5 * hashFloat(seed, k, side, L + 3)
      const h0 = fields.height(x, z)
      addTor(fields, out, x - x0, z - z0, x, z, h0, side, 0, (top - rh) / 12, ws, wd, seed, k, side, L + 10, false,
        [rh - 1.5, top - 3 + 6 * hashFloat(seed, k, side, L + 4)])
      n++
      // BOULDER FIELD (their canyon floors): big angular boulders between the road and the wall, 1.5–4 m tall,
      // 1–2 per step and side, never closer than 2.5 m to the road's edge.
      for (let b = 0; b < 2; b++) {
        if (hashFloat(seed, k, side * 3 + b, L + 20) > 0.75) continue
        const zb = z + (hashFloat(seed, k, side * 3 + b, L + 21) - 0.5) * 6
        const rxb = fields.roadCenterX(zb)
        const bs = 1.4 + 1.8 * hashFloat(seed, k, side * 3 + b, L + 23)
        // (the slab reaches ≤ 1.15 × its size from its centre → its edge stays ≥ 0.8 m beyond the gutter)
        const db = MAIN_DITCH_OUT + 0.8 + bs * 1.15 + hashFloat(seed, k, side * 3 + b, L + 22) * 2.5 // on the canyon floor, before the wall
        const xb = rxb + side * db
        if (xb < x0 || xb >= x0 + CHUNK_SIZE || zb < z0 || zb >= z0 + CHUNK_SIZE) continue
        if (fields.netRoad(xb, zb, 8 + bs) || nearBridge(fields, xb, zb, 4 + bs)) continue
        const hb0 = fields.height(xb, zb)
        addTor(fields, out, xb - x0, zb - z0, xb, zb, hb0, side, 0, 0.4, bs, bs * 0.9, seed, k * 7 + b, side, L + 80, true,
          [hb0 - 0.5, hb0 + bs * (0.55 + 0.4 * hashFloat(seed, k, side * 3 + b, L + 24))]) // squat: wider than tall
        n++
      }
      // STEPPED SHELF at the wall's foot on every other step (their canyon floors: low layered ledges), 1–2 slabs.
      if (k % 2 === 0 && hashFloat(seed, k, side, L + 5) < 0.5) {
        const xs = rx + side * (dOut - 5.2), sw = 3 + 2.5 * hashFloat(seed, k, side, L + 6), sd = 2 + 1.2 * hashFloat(seed, k, side, L + 7)
        if (xs >= x0 && xs < x0 + CHUNK_SIZE && Math.abs(xs - rx) > WorldFields.ROAD_HALF_WIDTH + 3 + sd)
          addTor(fields, out, xs - x0, z - z0, xs, z, fields.height(xs, z), side, 0, 0.5, sw, sd, seed, k, side, L + 60, true,
            [rh - 1, rh + 1.2 + 1.8 * hashFloat(seed, k, side, L + 8)])
      }
    }
  }
  return n
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
      const e = t === 0 ? 1 : erode(seed, wx - lx + cx[t] + ox, y, wz - lz + cz[t] + oz, fy)
      P.push(cx[t] + ox * e, y, cz[t] + oz * e)
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
 * BRIGHT (palette 0) — ROCK OUTCROPS as GRANITE TORS (the user's reference, 2026-10-16: a mossy mound of upright
 * weathered boulders): each crag is a CLUSTER of upright, rounded-angular boulders packed into a mound — the tallest
 * in the middle / uphill, shorter ones around them, small rubble spilling down the slope at the foot. Every boulder
 * is its own shape (a jittered 6-sided body, a shoulder and a domed top, leaning its own way), buried in the ground at
 * its own spot; the tops carry MOSS / grass in the green lands (most boulders, varying amounts), snow in the snow,
 * bare sandstone in the desert; a darker foot (painted AO). Shading: face normals bent ~45 % toward the boulder's
 * centre → readable planes with soft, rounded edges.
 * (Replaced the layered slab stacks: they read as one repeated pattern — "every cliff looks the same".)
 * Arithmetic + sqrt only (no trig: angles from a fixed 6-direction table, jittered). Cost: 35 tris per boulder,
 * ~8–12 boulders per mass crag (~300 tris), 1–3 per small one; same draw / collider as before (formation mesh).
 */
// 7 directions (exact constants), jittered per boulder.
const SIDES = 7
const DIR7 = [1, 0, 0.6234898, 0.7818315, -0.2225209, 0.9749279, -0.9009689, 0.4338837, -0.9009689, -0.4338837, -0.2225209, -0.9749279, 0.6234898, -0.7818315]

function addTor(
  fields: WorldFields, out: CragMesh, lx: number, lz: number, wx: number, wz: number, h0: number,
  ux: number, uz: number, g: number, ws: number, wd: number, seed: number, gx: number, gz: number, L: number, small: boolean,
  range?: [number, number],
): void {
  const hf = (k: number) => hashFloat(seed, gx, gz, L + 5 + k)
  // Frame: d = downhill (the face looks out of the hill), s = across the slope.
  const dx = -ux, dz = -uz, sx = -dz, sz = dx
  // Mound height above the ground at its centre.
  const T = range ? Math.max(1.5, range[1] - h0) : Math.max(small ? 1.2 : 3, (0.35 + 0.7 * hf(2)) * g * wd + 1.5 + hf(3) * 3)
  const w = fields.biome(wx, wz, _bw, h0)
  const sand = w[0], snow = w[1]
  // Granite light grey (linear ≈ sRGB 150,150,144), warm sandstone in the desert, cold grey-blue in the snow.
  let br = 0.58, bg = 0.57, bb = 0.52
  br += (0.6 - br) * sand; bg += (0.3 - bg) * sand; bb += (0.18 - bb) * sand
  br += (0.36 - br) * snow; bg += (0.39 - bg) * snow; bb += (0.45 - bb) * snow
  const green = (1 - sand) * (1 - snow)
  const MOSS = [0.2, 0.42, 0.03], SNOW = [0.82, 0.86, 0.94]
  let face = 0
  const tri = (A: number[], B: number[], C: number[], col: number[], cx: number, cy: number, cz: number, soft: number) => {
    let bx = B[0], by = B[1], bz = B[2], ex = C[0], ey = C[1], ez = C[2]
    const ax = A[0], ay = A[1], az = A[2]
    let nx = (by - ay) * (ez - az) - (bz - az) * (ey - ay)
    let ny = (bz - az) * (ex - ax) - (bx - ax) * (ez - az)
    let nz = (bx - ax) * (ey - ay) - (by - ay) * (ex - ax)
    // outward = away from the boulder's centre
    const mx = (ax + bx + ex) / 3 - cx, my = (ay + by + ey) / 3 - cy, mz = (az + bz + ez) / 3 - cz
    if (nx * mx + ny * my + nz * mz < 0) {
      nx = -nx; ny = -ny; nz = -nz
      const tx = bx, ty = by, tz = bz; bx = ex; by = ey; bz = ez; ex = tx; ey = ty; ez = tz
    }
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    nx /= nl; ny /= nl; nz /= nl
    const pts = [ax, ay, az, bx, by, bz, ex, ey, ez]
    for (let q = 0; q < 3; q++) {
      const px = pts[q * 3], py = pts[q * 3 + 1], pz = pts[q * 3 + 2]
      // bent toward the radial direction from the centre: rounded edges, still readable planes
      let rx = px - cx, ry = py - cy, rz = pz - cz
      const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1
      rx = nx * (1 - soft) + (rx / rl) * soft; ry = ny * (1 - soft) + (ry / rl) * soft; rz = nz * (1 - soft) + (rz / rl) * soft
      const ql = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1
      out.pos.push(px, py, pz)
      out.nor.push(rx / ql, ry / ql, rz / ql)
      out.col.push(col[0], col[1], col[2])
    }
    return ny
  }
  /**
   * One BOULDER standing at (bx, bz) (chunk-local), ground height gy: footprint half-sizes (a along d, b along s),
   * height H above the ground (its foot buried `bury` m), leaning (lx2, lz2) m at the top, hash salt k0.
   */
  const boulder = (bx: number, bz: number, gy: number, a: number, b: number, H: number, bury: number, lean: number, k0: number) => {
    const hb = (k: number) => hashFloat(seed, gx, gz, L + 2000 + k0 * 61 + k)
    // own turn (a unit vector from two hashes, no trig)
    let rc = hb(0) - 0.5, rs = hb(1) - 0.5
    const rl = Math.sqrt(rc * rc + rs * rs) || 1
    rc /= rl; rs /= rl
    const lnx = (hb(2) - 0.5) * 2 * lean, lnz = (hb(3) - 0.5) * 2 * lean
    // crown slope (rise per m of the footprint along a / b): ±0.35
    const tpa = (hb(7) - 0.5) * 0.7 * (H / Math.max(a, b)) * 0.25, tpb = (hb(8) - 0.5) * 0.7 * (H / Math.max(a, b)) * 0.25
    // rings: foot (buried), belly, shoulder; then the domed top centre
    const RINGS = [[-bury, 0.95], [H * (0.42 + 0.18 * hb(4)), 1.03], [H * (0.7 + 0.12 * hb(5)), 0.62 + 0.18 * hb(6)]]
    const R: number[][] = []
    for (let r = 0; r < RINGS.length; r++) {
      const [y, sc] = RINGS[r]
      const t = Math.max(0, y) / H
      for (let k = 0; k < SIDES; k++) {
        // jittered direction + radius → an irregular 7-gon, every boulder its own outline
        const jx = DIR7[k * 2] + (hb(10 + k) - 0.5) * 0.5, jz = DIR7[k * 2 + 1] + (hb(17 + k) - 0.5) * 0.5
        const ca = jx * rc - jz * rs, cb = jx * rs + jz * rc
        const rad = sc * (0.75 + 0.4 * hb(24 + r * 7 + k))
        const pa = ca * a * rad, pb = cb * b * rad
        // (the shoulder ring tilts with the boulder's top: a sloped, not flat, crown)
        const vy = gy + y + (hb(45 + r * 7 + k) - 0.5) * 0.14 * H + (r === 2 ? (pa * tpa + pb * tpb) : 0)
        const ex = dx * pa + sx * pb, ez = dz * pa + sz * pb
        const e = r === 0 ? 1 : erode(seed, wx - lx + bx + ex, vy, wz - lz + bz + ez, t)
        R.push([bx + ex * e + lnx * t, vy, bz + ez * e + lnz * t])
      }
    }
    const top = [bx + lnx + (hb(70) - 0.5) * 0.3 * a, gy + H * (0.9 + 0.2 * vnoise3(seed + 3, (wx - lx + bx) / 4, gy / 4, (wz - lz + bz) / 4)), bz + lnz + (hb(71) - 0.5) * 0.3 * b]
    const cx = bx + lnx * 0.5, cy = gy + H * 0.45, cz = bz + lnz * 0.5
    // colour: the boulder's tone, its moss / snow / bare top
    const tone = 0.82 + 0.3 * hb(72)
    const moss = green * (hb(73) < 0.8 ? 0.65 + 0.35 * hb(74) : 0) + snow * 0.9
    const capC = snow > 0.5 ? SNOW : MOSS
    const shade = (fy: number, up: number) => {
      const plane = 0.93 + 0.14 * hashFloat(seed, gx, gz, L + 4000 + face++)
      const k = tone * plane * (0.7 + 0.3 * Math.min(1, Math.max(0, fy)))
      const c = [br * k, bg * k, bb * k]
      // moss / snow on the up-facing planes (more on flatter ones), a little creeping over the shoulder
      // (patchy: each plane its own share — no hard green lid; a few lower faces carry a little too)
      const fr = hashFloat(seed, gx, gz, L + 6000 + face)
      const m = moss * (Math.min(1, Math.max(0, (up - 0.35) / 0.4)) * (0.45 + 0.55 * fr) + (up < 0.3 && fr > 0.8 ? 0.25 : 0))
      if (m > 0) for (let q = 0; q < 3; q++) c[q] += (capC[q] * (0.85 + 0.3 * hb(75)) - c[q]) * m
      return c
    }
    const V = (r: number, k: number) => R[r * SIDES + (k % SIDES)]
    for (let r = 0; r < 2; r++) {
      for (let k = 0; k < SIDES; k++) {
        const A = V(r, k), B = V(r, k + 1), C = V(r + 1, k + 1), D = V(r + 1, k)
        // (a side plane's "up" from its corner heights: the shoulder band tilts up, the belly is ~vertical)
        const up = r === 1 ? 0.62 + 0.25 * hb(76 + k) : 0
        const fy = ((A[1] + C[1]) / 2 - gy) / H
        const c = shade(fy, up)
        tri(A, B, C, c, cx, cy, cz, 0.45)
        tri(A, C, D, c, cx, cy, cz, 0.45)
      }
    }
    for (let k = 0; k < SIDES; k++) tri(top, V(2, k), V(2, k + 1), shade(1, 0.95), cx, cy, cz, 0.35)
  }
  const ground = (px: number, pz: number) => fields.height(wx + (px - lx), wz + (pz - lz))
  if (small) {
    // A small crag: 1–3 boulders.
    const n = 1 + Math.floor(hf(4) * 3)
    for (let i = 0; i < n; i++) {
      const o = (hf(10 + i) - 0.5) * ws, p = (hf(20 + i) - 0.5) * wd
      const px = lx + sx * o + dx * p, pz = lz + sz * o + dz * p
      const s = Math.max(0.8, Math.min(ws, wd) * (0.45 + 0.4 * hf(30 + i)))
      const H = range ? Math.max(0.8, range[1] - ground(px, pz)) * (0.7 + 0.3 * hf(40 + i)) : s * (0.9 + 0.9 * hf(40 + i))
      boulder(px, pz, ground(px, pz), s * (0.8 + 0.3 * hf(50 + i)), s * (0.8 + 0.3 * hf(55 + i)), H, 0.4 + g * s * 0.6, s * 0.15, i)
    }
    return
  }
  // A TOR: the core of tall upright boulders, a ring of shorter ones, rubble downhill.
  const n = 7 + Math.floor(hf(4) * 6)
  for (let i = 0; i < n; i++) {
    // position in the footprint ellipse (sqrt → even spread), its distance from the core sets its size
    let u = hf(100 + i) * 2 - 1, v = hf(120 + i) * 2 - 1
    const l = Math.sqrt(u * u + v * v)
    if (l > 1) (u /= l), (v /= l)
    const r = Math.min(1, Math.sqrt(u * u + v * v))
    // uphill (v < 0 = toward the hill) a little taller
    const size = (1.15 - 0.7 * r) * (0.7 + 0.6 * hf(140 + i)) * (1 - 0.15 * v)
    const px = lx + sx * u * ws * 0.6 + dx * v * wd * 0.6, pz = lz + sz * u * ws * 0.6 + dz * v * wd * 0.6
    const gy = ground(px, pz)
    // (height ≤ 2.5 × the footprint: a 30 m canyon wall gets a pile of boulders, not 25 m needles)
    const H = Math.max(1.2, Math.min(T * size, 2.5 * Math.min(ws, wd) * (0.7 + 0.5 * hf(150 + i))))
    // upright: width 30–55 % of the height (the core), squatter at the rim; never wider than the footprint
    const a = Math.min(wd * 0.7, Math.max(0.7, H * (0.3 + 0.25 * hf(160 + i) + 0.25 * r))), b = Math.min(ws * 0.7, Math.max(0.7, H * (0.3 + 0.25 * hf(180 + i) + 0.25 * r)))
    boulder(px, pz, gy, a, b, H, 0.6 + g * Math.max(a, b) * 0.8, H * 0.08, 10 + i)
  }
  // RUBBLE: small boulders spilt down the slope below the tor (not below a canyon wall: that's the road side —
  // its boulder field is placed by canyonWalls, clear of the road).
  const nr = range ? 0 : 3 + Math.floor(hf(5) * 4)
  for (let i = 0; i < nr; i++) {
    const o = (hf(200 + i) - 0.5) * ws * 1.6, p = wd * (0.8 + 0.7 * hf(220 + i))
    const px = lx + sx * o + dx * p, pz = lz + sz * o + dz * p
    const s = 0.5 + 1.2 * hf(240 + i) ** 2
    boulder(px, pz, ground(px, pz), s * (0.9 + 0.4 * hf(260 + i)), s, s * (0.6 + 0.6 * hf(280 + i)), 0.25 + g * s * 0.5, s * 0.1, 40 + i)
  }
}
