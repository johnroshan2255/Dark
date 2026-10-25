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
// (2026-10-24, the user: "not a lot of rocks — use the actual terrain": a tor on ~1 steep cell in 4, not on nearly every
//  one — the hills' own eroded cliffs (terrain shader surfCliff) carry the slopes, outcrops stand out here and there)
const PASSES = [
  { cell: 16, ws: 8, wsVar: 5, wd: 5, wdVar: 3.5, keep: 0.32, base: 0.35, salt: 0 },
  { cell: 8, ws: 2.6, wsVar: 3, wd: 2.2, wdVar: 2.4, keep: 0.08, base: 0.25, salt: 64 },
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
      // (a map's own crag size, map.json `cragScale` — Zhangjiajie: stones on its eroded slopes, not 25 m blocks on
      // its 70° walls; the slope that sets a tor's height capped there too)
      const cs = fields.map?.cragScale ?? 1
      const ws = (P.ws + P.wsVar * r) * cs // half-width across the slope
      const wd = (P.wd + P.wdVar * hashFloat(seed, gx, gz, L + 4)) * cs // half-depth down the slope
      // Clear of every road (bright tors: their spread across the slope and the rubble below them). The canyon
      // walls 10 m off the road get rock too (with the old across-slope margin they stayed bare sand slopes).
      if (fields.anyRoadEdge(wx, wz) < (fields.palette === 0 ? 3 + Math.max(wd * 1.7 + 1.5, ws * 1.3) : 4 + ws)) continue
      if (fields.pois.near(wx, wz, 6) || fields.formations.near(wx, wz, 2) || fields.landmarks.near(wx, wz, 8) || nearBridge(fields, wx, wz, Math.max(ws, wd) * 1.4 + 4)) continue
      if (fields.palette === 0) addTor(fields, out, lx, lz, wx, wz, h0, _g[0] / g, _g[1] / g, cs < 1 ? Math.min(g, 1.8) : g, ws, wd, seed, gx, gz, L, P.salt > 0)
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
  const faceK = 0.0 // fully rounded (radial) shading in every style — smooth rock, no facets (2026-10-24)
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
 * centre → readable planes with soft, rounded edges. (2026-10-24: jointed rounded-box blocks — superellipse sections, flat crowns, mesh-averaged normals, 10 sides, 4 rings,
 * colour per vertex — smooth weathered stone; the surface detail is the material's rock surface.)
 * (Replaced the layered slab stacks: they read as one repeated pattern — "every cliff looks the same".)
 * Arithmetic + sqrt only (no trig: angles from a fixed 10-direction table, jittered). Cost: 70 tris per boulder,
 * ~8–12 boulders per mass crag (~700 tris), 1–3 per small one; same draw / collider as before (formation mesh).
 */
// 10 directions (exact constants), jittered per boulder — rounder outlines than the old 7 (2026-10-24: "smooth, not sharp").
const SIDES = 10
const DIR7 = [1, 0, 0.809017, 0.5877853, 0.309017, 0.9510565, -0.309017, 0.9510565, -0.809017, 0.5877853, -1, 0, -0.809017, -0.5877853, -0.309017, -0.9510565, 0.309017, -0.9510565, 0.809017, -0.5877853]

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
  // (a map's own stone, palette `stone` = its loose boulders' colour: the crags take its hue, at their usual ×2.6
  //  brightness over the boulders' default body — the two read as the same rock, as they do by default)
  const st = fields.map?.palette.stone
  if (st) (br = st[0] * 2.6), (bg = st[1] * 2.6), (bb = st[2] * 2.6)
  br += (0.6 - br) * sand; bg += (0.3 - bg) * sand; bb += (0.18 - bb) * sand
  br += (0.36 - br) * snow; bg += (0.39 - bg) * snow; bb += (0.45 - bb) * snow
  const green = (1 - sand) * (1 - snow)
  const MOSS = [0.2, 0.42, 0.03], SNOW = [0.82, 0.86, 0.94]
  /**
   * One BOULDER standing at (bx, bz) (chunk-local), ground height gy: footprint half-sizes (a along d, b along s),
   * height H above the ground (its foot buried `bury` m), leaning (lx2, lz2) m at the top, hash salt k0.
   * (2026-10-24, "a lot of balls of hills": a JOINTED GRANITE BLOCK, not an egg — a rounded-RECTANGLE section (a
   * superellipse through the 10 directions), near-vertical sides, a broad flat-ish crown on a rounded shoulder; normals
   * are the mesh's own, averaged over the faces at each corner — flat faces read flat, only the edges round off.)
   */
  const boulder = (bx: number, bz: number, gy: number, a: number, b: number, H: number, bury: number, lean: number, k0: number) => {
    const hb = (k: number) => hashFloat(seed, gx, gz, L + 2000 + k0 * 61 + k)
    // own turn (a unit vector from two hashes, no trig)
    let rc = hb(0) - 0.5, rs = hb(1) - 0.5
    const rl = Math.sqrt(rc * rc + rs * rs) || 1
    rc /= rl; rs /= rl
    const lnx = (hb(2) - 0.5) * 2 * lean, lnz = (hb(3) - 0.5) * 2 * lean
    // crown slope (rise per m of the footprint along a / b): a gently tilted block top
    const tpa = (hb(7) - 0.5) * 0.4 * (H / Math.max(a, b)) * 0.25, tpb = (hb(8) - 0.5) * 0.4 * (H / Math.max(a, b)) * 0.25
    // rings: foot (buried), belly, shoulder, crown ring; then the crown centre — on a ROUNDED profile (2026-10-25, the
    // user: "so sharp — make it smooth", at no extra cost on phones: the same 4 rings, the shoulder pulled in and the
    // crown ring low and narrow, so the top rolls over instead of a flat lid on a hard edge)
    const sh = 0.66 + 0.08 * hb(5)
    const RINGS = [[-bury, 0.98], [H * (0.32 + 0.12 * hb(4)), 1.0], [H * sh, 0.9], [H * (sh + 0.17), 0.58 + 0.06 * hb(6)]]
    const R: number[][] = []
    for (let r = 0; r < RINGS.length; r++) {
      const [y, sc] = RINGS[r]
      const t = Math.max(0, y) / H
      for (let k = 0; k < SIDES; k++) {
        // jittered direction → a superellipse (|u|⁴ + |v|⁴ = 1): flat sides, rounded corners, every block its own
        const jx = DIR7[k * 2] + (hb(10 + k) - 0.5) * 0.2, jz = DIR7[k * 2 + 1] + (hb(17 + k) - 0.5) * 0.2
        const jl = Math.sqrt(jx * jx + jz * jz) || 1, ux = jx / jl, uz = jz / jl
        // (70 % of the way to the square: big blocks read jointed, small rubble stays a rounded stone, not a sugar cube)
        // (2026-10-25: at most 18 % — a soft rounded block, not a box)
        const box = 1 + (1 / Math.sqrt(Math.sqrt(ux ** 4 + uz ** 4)) - 1) * Math.min(0.18, 0.06 + 0.04 * H)
        const ca = ux * rc - uz * rs, cb = ux * rs + uz * rc
        const rad = sc * box * (0.9 + 0.14 * hb(24 + k) + 0.04 * hb(24 + r * 7 + k))
        const pa = ca * a * rad, pb = cb * b * rad
        // (the top rings tilt with the block's crown)
        const vy = gy + y + (hb(45 + r * 7 + k) - 0.5) * 0.05 * H + (r >= 2 ? (pa * tpa + pb * tpb) * (r === 3 ? 1 : 0.6) : 0)
        const ex = dx * pa + sx * pb, ez = dz * pa + sz * pb
        const e = r === 0 ? 1 : erode(seed, wx - lx + bx + ex, vy, wz - lz + bz + ez, t)
        R.push([bx + ex * e + lnx * t, vy, bz + ez * e + lnz * t])
      }
    }
    R.push([bx + lnx + (hb(70) - 0.5) * 0.2 * a, gy + H * (sh + 0.27 + 0.05 * vnoise3(seed + 3, (wx - lx + bx) / 4, gy / 4, (wz - lz + bz) / 4)), bz + lnz + (hb(71) - 0.5) * 0.2 * b])
    const TOP = R.length - 1
    const cx = bx + lnx * 0.5, cy = gy + H * 0.4, cz = bz + lnz * 0.5
    // colour: the boulder's tone, its moss / snow / bare top
    const tone = 0.82 + 0.3 * hb(72)
    const moss = green * (hb(73) < 0.8 ? 0.65 + 0.35 * hb(74) : 0) + snow * 0.9
    const capC = snow > 0.5 ? SNOW : MOSS
    // per vertex: darker toward the buried foot (painted AO); moss / snow where the crown faces up
    const shade = (py: number, up: number) => {
      const k = tone * (0.7 + 0.3 * Math.min(1, Math.max(0, (py - gy) / H)))
      const c = [br * k, bg * k, bb * k]
      const m = moss * Math.min(1, Math.max(0, (up - 0.45) / 0.35)) * (0.45 + 0.55 * hb(77))
      if (m > 0) for (let q = 0; q < 3; q++) c[q] += (capC[q] * (0.85 + 0.3 * hb(75)) - c[q]) * m
      return c
    }
    // the triangles (corner indices into R), each wound outward (away from the block's centre)
    const tris: number[] = []
    const add = (i: number, j: number, k: number) => {
      const A = R[i], B = R[j], C = R[k]
      const nx = (B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1])
      const ny = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2])
      const nz = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])
      const out = nx * ((A[0] + B[0] + C[0]) / 3 - cx) + ny * ((A[1] + B[1] + C[1]) / 3 - cy) + nz * ((A[2] + B[2] + C[2]) / 3 - cz) >= 0
      if (out) tris.push(i, j, k)
      else tris.push(i, k, j)
    }
    for (let r = 0; r < RINGS.length - 1; r++) {
      for (let k = 0; k < SIDES; k++) {
        const A = r * SIDES + k, B = r * SIDES + ((k + 1) % SIDES), C = (r + 1) * SIDES + ((k + 1) % SIDES), D = (r + 1) * SIDES + k
        add(A, B, C)
        add(A, C, D)
      }
    }
    const last = (RINGS.length - 1) * SIDES
    for (let k = 0; k < SIDES; k++) add(TOP, last + k, last + ((k + 1) % SIDES))
    // corner normals: the area-weighted sum of the faces meeting there
    const N = new Float32Array(R.length * 3)
    for (let t = 0; t < tris.length; t += 3) {
      const A = R[tris[t]], B = R[tris[t + 1]], C = R[tris[t + 2]]
      const nx = (B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1])
      const ny = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2])
      const nz = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])
      for (let q = 0; q < 3; q++) (N[tris[t + q] * 3] += nx), (N[tris[t + q] * 3 + 1] += ny), (N[tris[t + q] * 3 + 2] += nz)
    }
    for (const i of tris) {
      const p = R[i]
      const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2]
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
      out.pos.push(p[0], p[1], p[2])
      out.nor.push(nx / nl, ny / nl, nz / nl)
      const c = shade(p[1], ny / nl)
      out.col.push(c[0], c[1], c[2])
    }
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
    // broad blocks: width 50–80 % of the height (the core), squatter at the rim; never wider than the footprint —
    // neighbouring blocks overlap into ONE jointed outcrop (thin 30 % pillars stood apart as a heap of balls)
    const a = Math.min(wd * 0.8, Math.max(0.8, H * (0.5 + 0.3 * hf(160 + i) + 0.25 * r))), b = Math.min(ws * 0.8, Math.max(0.8, H * (0.5 + 0.3 * hf(180 + i) + 0.25 * r)))
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
