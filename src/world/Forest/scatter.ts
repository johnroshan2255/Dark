import { CHUNK_SIZE } from '../constants'
import { hashFloat, Layer } from '../noise/rng'
import { sampleHeight } from '../Terrain/generateTerrain'
import { PROP_STRIDE, TREE_STRIDE, TreeSpecies } from '../types'
import { WorldFields } from '../WorldFields'
import type { BiomeWeights } from '../Biomes'

const _bw: BiomeWeights = [0, 0]

/**
 * Jittered-grid scatter keyed by GLOBAL cell coordinates, so a cell's content never
 * depends on which chunk generated it (no seams, no neighbour lookups).
 * Cell sizes divide CHUNK_SIZE exactly.
 */

const TREE_CELL = 4
const ROCK_CELL = 8
const PLANT_CELL = 2

interface ScatterCtx {
  fields: WorldFields
  cx: number
  cz: number
  heights: Float32Array
}

function scatter(
  ctx: ScatterCtx,
  cell: number,
  layer: number,
  stride: number,
  accept: (wx: number, wz: number, r: number, h: number) => number, // returns scale, or 0 to reject
  extra?: (wx: number, wz: number, r: number, h: number) => number,
): Float32Array {
  const { fields, cx, cz, heights } = ctx
  const perEdge = CHUNK_SIZE / cell
  const out = new Float32Array(perEdge * perEdge * stride)
  let n = 0
  const seed = fields.seed
  for (let j = 0; j < perEdge; j++) {
    for (let i = 0; i < perEdge; i++) {
      const gx = cx * perEdge + i
      const gz = cz * perEdge + j
      const r0 = hashFloat(seed, gx, gz, layer * 16 + 0)
      const r1 = hashFloat(seed, gx, gz, layer * 16 + 1)
      const r2 = hashFloat(seed, gx, gz, layer * 16 + 2)
      const r3 = hashFloat(seed, gx, gz, layer * 16 + 3)
      const lx = (i + 0.1 + 0.8 * r0) * cell
      const lz = (j + 0.1 + 0.8 * r1) * cell
      const wx = cx * CHUNK_SIZE + lx
      const wz = cz * CHUNK_SIZE + lz
      const h = sampleHeight(heights, lx, lz)
      const scale = accept(wx, wz, r2, h)
      if (scale <= 0) continue
      if (layer !== Layer.Rocks && h < WorldFields.WATER + 0.9) continue // no trees/plants in water
      if (fields.pois.near(wx, wz, layer === Layer.Trees ? 4 : 0)) continue // places are cleared
      const edge = fields.anyRoadEdge(wx, wz)
      // Keep every road clear — a boulder's footprint grows with its scale (unit rock radius ≈ 1.4 m), so big
      // ones stand well back from the edge instead of overhanging the track.
      if (edge < (layer === Layer.Trees ? 3.5 : layer === Layer.Rocks ? 1.0 + scale * 1.5 : 0.4)) continue
      out[n] = lx
      out[n + 1] = h
      out[n + 2] = lz
      out[n + 3] = r3 * Math.PI * 2
      out[n + 4] = scale
      if (extra) out[n + 5] = extra(wx, wz, r3, h)
      n += stride
    }
  }
  return out.slice(0, n)
}

/**
 * Species by region so the forest reads in stands, not confetti (refer/roads hero):
 *  - road verges (< 14 m): birch/aspen groves mixed with spruce
 *  - dense forest: spruce + fir, a few pines
 *  - sparse / dry: pine stands, dead snags, some birch
 * `r` is the per-tree uniform random from the scatter cell (deterministic).
 */
function pickSpecies(fields: WorldFields, wx: number, wz: number, r: number, h: number): number {
  const density = fields.forestDensity(wx, wz, h)
  const road = fields.roadDistance(wx, wz)
  const stand = fields.colorVariation(wx * 0.35, wz * 0.35) // low-frequency stand selector
  const w = fields.biome(wx, wz, _bw, h)
  // Desert: dead snags and a few hardy pines. Snow: conifers only (frosted by the chunk's instance tint).
  if (w[0] > 0.5) return r < 0.55 ? TreeSpecies.Dead : TreeSpecies.Pine
  if (w[1] > 0.5) return r < 0.6 ? TreeSpecies.Spruce : r < 0.9 ? TreeSpecies.Fir : TreeSpecies.Dead
  if (r < 0.04) return TreeSpecies.Dead
  // Genshin-style mixed forest: colourful broadleaf groves between conifer stands.
  if (road < 16) return r < 0.45 ? TreeSpecies.Spruce : r < 0.65 ? TreeSpecies.Pine : r < 0.8 ? TreeSpecies.Birch : TreeSpecies.Fir
  if (density < 0.35) return r < 0.12 ? TreeSpecies.Dead : r < 0.6 ? TreeSpecies.Birch : TreeSpecies.Pine
  if (stand > 0.6) return r < 0.55 ? TreeSpecies.Birch : r < 0.8 ? TreeSpecies.Pine : TreeSpecies.Spruce
  return r < 0.45 ? TreeSpecies.Spruce : r < 0.7 ? TreeSpecies.Fir : r < 0.85 ? TreeSpecies.Birch : TreeSpecies.Pine
}

export function scatterForest(fields: WorldFields, cx: number, cz: number, heights: Float32Array) {
  const ctx: ScatterCtx = { fields, cx, cz, heights }
  // Open road corridor (refer/roads hero): grassy verges, trees set back, a long view down the road.
  const clearRoad = WorldFields.ROAD_HALF_WIDTH + 9

  const trees = scatter(
    ctx,
    TREE_CELL,
    Layer.Trees,
    TREE_STRIDE,
    (wx, wz, r, h) => {
      const d = fields.roadDistance(wx, wz)
      if (d < clearRoad) return 0
      // Forest thickens with distance from the road (verge → treeline), instead of a wall at the kerb.
      const density = fields.forestDensity(wx, wz, h) * Math.min(1, 0.3 + (d - clearRoad) / 45) * (fields.palette === 1 ? 0.55 : 1) // overland: big trees, spaced
      if (r > density * 0.9) return 0
      return 1.0 + (r / Math.max(density, 1e-3)) * 0.65 // tall framing trees (refs)
    },
    (wx, wz, r, h) => pickSpecies(fields, wx, wz, r, h),
  )

  const rocks = scatter(ctx, ROCK_CELL, Layer.Rocks, PROP_STRIDE, (wx, wz, r, h) => {
    const w = fields.biome(wx, wz, _bw, h)
    const p = 0.14 * (1 + w[0] * 1.2 + w[1] * 0.5) // sparse (≈ 9 per chunk in the forest); deserts and snowfields stonier
    if (r >= p) return 0
    const t = r / p
    const scale = 0.4 + t * t * t * 2.2 // mostly small stones, a rare 2.6 m boulder (was 0.5–5.4 at 2.5× the count)
    // The main road and its shoulders stay clear; big boulders further out (footprint ≈ 1.4 m × scale).
    if (fields.roadDistance(wx, wz) < WorldFields.ROAD_HALF_WIDTH + 1.5 + scale * 1.5) return 0
    return scale
  })

  const plants = scatter(ctx, PLANT_CELL, Layer.Plants, PROP_STRIDE, (wx, wz, r, h) => {
    if (fields.roadDistance(wx, wz) < WorldFields.ROAD_HALF_WIDTH + 0.3) return 0
    // Undergrowth: dense on the verges (refer/roads: ferns lining the road), sparse under canopy; none on sand or snow.
    const rd = fields.roadDistance(wx, wz) - WorldFields.ROAD_HALF_WIDTH
    const verge = rd > 1.5 && rd < 12 ? 0.45 * (1 - Math.abs(rd - 5) / 7) : 0
    const w = fields.biome(wx, wz, _bw, h)
    // Overland palette: half the undergrowth — open straw meadows with a few bushes, not a carpet of dark spots.
    const density = (0.1 + fields.forestDensity(wx, wz, h) * 0.28 + Math.max(0, verge) * 1.1) * (1 - w[0] - w[1] * 0.85) * (fields.palette === 1 ? 0.45 : 1)
    return r < density ? 0.7 + r * 2 : 0
  })

  return { trees, rocks, plants }
}
