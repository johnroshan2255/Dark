import { CHUNK_SIZE } from '../constants'
import { hashFloat, Layer } from '../noise/rng'
import { sampleHeight } from '../Terrain/generateTerrain'
import { PROP_STRIDE, TREE_STRIDE, TreeSpecies } from '../types'
import { WorldFields } from '../WorldFields'
import { detailInfo } from '../Road/RoadDetail'
import { Biome, BIOME_COUNT, type BiomeWeights, type RegionWeights } from '../Biomes'
import { BIOMES, pickRegion, pickWeighted, regionRoll } from '../biomes/BiomeDefs'
import { CRAG_SLOPE0, gridSlope } from '../Formations/crags'
import { nearBridge } from '../Road/bridges'
import { nearCamp } from '../Road/camps'

const _bw: BiomeWeights = [0, 0]
const _wn: RegionWeights = new Float32Array(BIOME_COUNT)
const _sg: [number, number] = [0, 0]

/**
 * Jittered-grid scatter keyed by GLOBAL cell coordinates, so a cell's content never
 * depends on which chunk generated it (no seams, no neighbour lookups).
 * Cell sizes divide CHUNK_SIZE exactly.
 */

const TREE_CELL = 4
const ROCK_CELL = 8
const PLANT_CELL = 2
/** Share of the grove density that grows trees (1 = the old, denser forest). */
const TREE_SHARE = 0.6

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
      if (fields.map?.inPool(wx, wz)) continue // nor in a desert pool (FixedMap.pools)
      // Cliffs are bare rock (crags clad them): nothing grows on slopes the crags start on (Formations/crags.ts).
      gridSlope(heights, lx, lz, _sg)
      if (_sg[0] * _sg[0] + _sg[1] * _sg[1] > CRAG_SLOPE0 * CRAG_SLOPE0) continue
      if (fields.pois.near(wx, wz, layer === Layer.Trees ? 4 : 0)) continue // places are cleared
      // Rock formations stand clear (an arch over open ground, a cave hill, the pillars' feet).
      if (fields.formations.near(wx, wz, layer === Layer.Trees ? 3 : 0)) continue
      // Landmarks (giant trees, ruins, towers…) stand in a clearing — Genshin frames them, the forest doesn't hide them.
      if (fields.landmarks.near(wx, wz, layer === Layer.Trees ? 24 : 1)) continue
      const edge = fields.anyRoadEdge(wx, wz)
      // Keep every road clear — a boulder's footprint grows with its scale (unit rock radius ≈ 1.4 m), so big
      // ones stand well back from the edge instead of overhanging the track.
      if (edge < (layer === Layer.Trees ? 3.5 : layer === Layer.Rocks ? 1.0 + scale * 1.5 : 0.4)) continue
      // No bushes in a road's ditch / ruts (Road/RoadDetail) — they'd float over the hollow.
      if (layer === Layer.Plants && edge < 2.5 && fields.roadDetail.query(wx, wz, _di) < -0.03) continue
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
/**
 * OASIS weight (bright, over the hill): desert ground 0.6–9 m above the water, i.e. the banks of the desert's
 * rivers / lakes (which hold water in this style) → palms, bushes and the green band (groundColor).
 */
export function oasisAt(fields: WorldFields, wx: number, wz: number, h: number): number {
  if (fields.palette !== 0) return 0
  const wl = h - WorldFields.WATER
  if (wl < 0.6 || wl > 9) return 0
  const sand = fields.biome(wx, wz, _bw, h)[0]
  if (sand < 0.35) return 0
  return Math.min(1, (sand - 0.35) / 0.3) * (1 - Math.max(0, (wl - 3) / 6))
}

function pickSpecies(fields: WorldFields, wx: number, wz: number, r: number, h: number): number {
  // a conifer map (map.json trees: 'conifer'): spruce, pine and fir stands — the reference's tiered pines
  if (fields.map?.conifers && fields.biome(wx, wz, _bw, h)[0] < 0.5) return r < 0.5 ? TreeSpecies.Spruce : r < 0.82 ? TreeSpecies.Pine : TreeSpecies.Fir
  if (oasisAt(fields, wx, wz, h) > 0.2) return r < 0.85 ? TreeSpecies.Palm : TreeSpecies.Cactus
  if (fields.map && (fields.map.poolRing(wx, wz) > 0.3 || fields.map.palmCell(Math.floor(wx / TREE_CELL), Math.floor(wz / TREE_CELL)))) return TreeSpecies.Palm // a desert pool's palms / the map's kept palms
  if (fields.beach(wx, wz, h) > 0.4) return TreeSpecies.Palm // fixed maps: the few beach trees are palms
  const sp = pickBaseSpecies(fields, wx, wz, r, h)
  return sp === TreeSpecies.Birch ? broadleafStand(fields, wx, wz) : sp
}

/**
 * BROADLEAF STANDS (the reference shapes): every ~56 m cell grows mostly ONE broadleaf type — Mondstadt broadleaf,
 * slender forked tree, Windrise oak, curvy S-trunk or golden Liyue tree — with 20 % of its trees the common
 * Mondstadt/slender ones, so a forest reads as groves of distinct trees while a chunk adds only 1–2 draws.
 * Deterministic (hash of the cell / tree position + seed).
 */
const STAND_TYPES: readonly [number, number][] = [[TreeSpecies.Birch, 0.26], [TreeSpecies.Slender, 0.28], [TreeSpecies.Oak, 0.14], [TreeSpecies.Curvy, 0.18], [TreeSpecies.Golden, 0.14]]
function broadleafStand(fields: WorldFields, wx: number, wz: number): number {
  const cx = Math.floor(wx / 56), cz = Math.floor(wz / 56)
  if (regionRoll(fields.seed, wx, wz, 6162) < 0.2) return regionRoll(fields.seed, wx, wz, 6163) < 0.5 ? TreeSpecies.Birch : TreeSpecies.Slender
  return pickWeighted(STAND_TYPES, regionRoll(fields.seed, cx * 56 + 7, cz * 56 + 13, 6161))
}

function pickBaseSpecies(fields: WorldFields, wx: number, wz: number, r: number, h: number): number {
  const density = fields.forestDensity(wx, wz, h)
  const road = fields.roadDistance(wx, wz)
  const stand = fields.colorVariation(wx * 0.35, wz * 0.35) // low-frequency stand selector
  // REGION SPECIES: autumn valleys and mystic woods grow their own trees (BiomeDefs) — the tree picks a region in
  // proportion to the weights here (a mixed border, the share rising across the blend band), then a species.
  const wn = fields.region(wx, wz, _wn, h)
  if (wn[Biome.Autumn] + wn[Biome.Mystic] > 0.002) {
    const region = pickRegion(wn, regionRoll(fields.seed, wx, wz, 4711))
    if (region === Biome.Autumn || region === Biome.Mystic) {
      const sp = pickWeighted(BIOMES[region].trees, r)
      // Bright: the autumn valleys' birches are WHITE birches (their autumn groves), and more of them.
      if (fields.palette === 0 && region === Biome.Autumn && (sp === TreeSpecies.Birch || (sp === TreeSpecies.Maple && regionRoll(fields.seed, wx, wz, 4712) < 0.3))) return TreeSpecies.WhiteBirch
      return sp
    }
  }
  const w = fields.biome(wx, wz, _bw, h)
  // Desert: saguaros, Joshua trees and the odd dead snag; the desert's rim keeps a few hardy pines.
  // Snow: conifers only (snow on their shelves comes from the material's biome cover).
  if (w[0] > 0.8) return r < 0.55 ? TreeSpecies.Cactus : r < 0.88 ? TreeSpecies.Joshua : TreeSpecies.Dead
  if (w[0] > 0.5) return r < 0.35 ? TreeSpecies.Cactus : r < 0.6 ? TreeSpecies.Joshua : r < 0.8 ? TreeSpecies.Dead : TreeSpecies.Pine
  if (w[1] > 0.5) return r < 0.6 ? TreeSpecies.Spruce : r < 0.9 ? TreeSpecies.Fir : TreeSpecies.Dead
  // Genshin's green lands have no dead trees (palette 2): every tree is in leaf.
  const gen = fields.palette === 2
  if (r < 0.04 && !gen) return TreeSpecies.Dead
  // Genshin-style mixed forest: colourful broadleaf groves between conifer stands.
  if (road < 16) return r < 0.45 ? TreeSpecies.Spruce : r < 0.65 ? TreeSpecies.Pine : r < 0.8 ? TreeSpecies.Birch : TreeSpecies.Fir
  if (density < 0.35) return r < 0.12 && !gen ? TreeSpecies.Dead : r < 0.6 ? TreeSpecies.Birch : TreeSpecies.Pine
  if (stand > 0.6) return r < 0.55 ? TreeSpecies.Birch : r < 0.8 ? TreeSpecies.Pine : TreeSpecies.Spruce
  return r < 0.45 ? TreeSpecies.Spruce : r < 0.7 ? TreeSpecies.Fir : r < 0.85 ? TreeSpecies.Birch : TreeSpecies.Pine
}

/** Road corridor kept open of trees (refer/roads hero: grassy verges, trees set back, a long view down the road). */
const CLEAR_ROAD = WorldFields.ROAD_HALF_WIDTH + 9

/** A tree at (wx, wz)? Its scale, or 0 (the tree layer's accept — also asked by beachTreeNear). */
function treeAccept(fields: WorldFields, wx: number, wz: number, r: number, h: number): number {
  const d = fields.roadDistance(wx, wz)
  if (d < CLEAR_ROAD) return 0
  if (nearBridge(fields, wx, wz, 4) || nearCamp(fields, wx, wz, 3)) return 0 // rope bridges / camps: clear
  // Forest thickens with distance from the road (verge → treeline), instead of a wall at the kerb.
  // Desert (Sumeru): mostly BARE sand and rock — cacti and Joshua trees only in scattered clumps (~1/4 of
  // the ground), a lone one now and then between them (forestDensity is ~0 on sand).
  const sand = fields.biome(wx, wz, _bw, h)[0]
  const clump = Math.min(1, Math.max(0, (fields.colorVariation(wx * 0.5 + 91, wz * 0.5 - 37) - 0.62) * 5))
  // Trees: 60 % of the grove density (the player asked for fewer — more open meadow between thinner groves).
  // Fixed maps: the BEACH stays open — a tenth of the trees, and its low sand no longer counts as oasis palm
  // groves (2026-10-21, "remove lot of rocks and trees from beach area").
  // 2026-10-21 ("reduce beach trees to 20 %"): none of its own — only the map's kept palms (below), each with a
  // bush clump round it (beachTreeNear).
  const beach = fields.beach(wx, wz, h)
  const density = Math.max(fields.forestDensity(wx, wz, h) * TREE_SHARE, sand * (0.012 + 0.11 * clump)) * Math.min(1, 0.3 + (d - CLEAR_ROAD) / 45) * (fields.palette === 1 ? 0.55 : 1) * (1 - beach) // overland: big trees, spaced
  // Fixed maps: a palm or two at each desert pool (FixedMap.poolRing; pickSpecies makes them palms).
  if (fields.map) {
    const ring = fields.map.poolRing(wx, wz)
    if (ring > 0.5 && r < 0.035 * ring) return 0.9 + r * 8
    // the map's kept palms (FixedMap.palmCell: a fifth of its palm sites) — the beach's only trees
    if (fields.map.palmCell(Math.floor(wx / TREE_CELL), Math.floor(wz / TREE_CELL))) return 0.95 + r * 0.4
  }
  const oas = oasisAt(fields, wx, wz, h) * (1 - 0.9 * beach)
  if (oas > 0.2) { // palm groves along the oasis water
    const dp = 0.45 * oas
    return r > dp ? 0 : 0.85 + (r / dp) * 0.4
  }
  if (r > density * 0.9) return 0
  return 1.0 + (r / Math.max(density, 1e-3)) * 0.65 // tall framing trees (refs)
}

/**
 * Distance (m) from (wx, wz) to the nearest BEACH tree within 5 m (Infinity: none) — the tree layer's own hashed
 * cells recomputed (scatter: cell gx → x = (gx + 0.1 + 0.8·r0)·TREE_CELL), so a plant can grow in its clump without
 * the trees being stored. (Beach trees: fixed maps' beach ≥ 0.4, ~4 neighbouring cells × a few field reads.)
 */
function beachTreeNear(fields: WorldFields, wx: number, wz: number): number {
  let best = Infinity
  const seed = fields.seed, L = Layer.Trees * 16
  for (let gz = Math.floor((wz - 5) / TREE_CELL); gz <= Math.floor((wz + 5) / TREE_CELL); gz++) {
    for (let gx = Math.floor((wx - 5) / TREE_CELL); gx <= Math.floor((wx + 5) / TREE_CELL); gx++) {
      const x = (gx + 0.1 + 0.8 * hashFloat(seed, gx, gz, L)) * TREE_CELL, z = (gz + 0.1 + 0.8 * hashFloat(seed, gx, gz, L + 1)) * TREE_CELL
      const d = Math.hypot(x - wx, z - wz)
      if (d >= best || d > 5) continue
      const h = fields.height(x, z)
      if (h < WorldFields.WATER + 0.9 || fields.beach(x, z, h) < 0.4) continue
      if (treeAccept(fields, x, z, hashFloat(seed, gx, gz, L + 2), h) > 0) best = d
    }
  }
  return best
}

const _di = detailInfo()
export function scatterForest(fields: WorldFields, cx: number, cz: number, heights: Float32Array, treesOnly = false) {
  const ctx: ScatterCtx = { fields, cx, cz, heights }
  const trees = scatter(
    ctx,
    TREE_CELL,
    Layer.Trees,
    TREE_STRIDE,
    (wx, wz, r, h) => treeAccept(fields, wx, wz, r, h),
    (wx, wz, r, h) => pickSpecies(fields, wx, wz, r, h),
  )

  // Far forest (FarForest): trees only — the impostor ring needs nothing else.
  if (treesOnly) return { trees, rocks: new Float32Array(0), plants: new Float32Array(0) }
  const rocks = scatter(ctx, ROCK_CELL, Layer.Rocks, PROP_STRIDE, (wx, wz, r, h) => {
    if (nearBridge(fields, wx, wz) || nearCamp(fields, wx, wz)) return 0
    if (fields.palette === 0 && h < WorldFields.WATER + 0.3) return 0 // bright: no boulders in the (oasis) water
    const w = fields.biome(wx, wz, _bw, h)
    // Bright desert (their canyon floors): twice the stones — RUBBLE everywhere — and the biggest ones truck-sized
    // (up to ~7 m), so you drive between boulders.
    const oth = fields.palette === 0 ? w[0] : 0
    // Fixed maps (2026-10-21, "it has a lot of rocks"): the sand keeps ~30 % of its stones, the beach ~4 %, and the
    // truck-sized boulders stay under ~4.5 m (the mesas' cliffs carry the big rock now).
    const few = fields.map ? 1 - w[0] * (0.7 + 0.26 * fields.beach(wx, wz, h)) : 1
    const p = 0.14 * (1 + w[0] * 1.2 + w[1] * 0.5) * (1 + 1.2 * oth) * few // sparse (≈ 9 per chunk in the forest); deserts and snowfields stonier
    if (r >= p) return 0
    const t = r / p
    const scale = 0.4 + t * t * t * (2.2 + (fields.map ? 2 : 4.6) * oth) // mostly small stones, a rare 2.6 m boulder (bright desert: up to ~7 m)
    // The main road and its shoulders stay clear; big boulders further out (footprint ≈ 1.4 m × scale).
    if (fields.roadDistance(wx, wz) < WorldFields.ROAD_HALF_WIDTH + 1.5 + scale * 1.5) return 0
    return scale
  })

  const plants = scatter(ctx, PLANT_CELL, Layer.Plants, PROP_STRIDE, (wx, wz, r, h) => {
    if (fields.roadDistance(wx, wz) < WorldFields.ROAD_HALF_WIDTH + 0.3 || nearBridge(fields, wx, wz, 1) || nearCamp(fields, wx, wz)) return 0
    // Undergrowth: dense on the verges (refer/roads: ferns lining the road), sparse under canopy; none on snow.
    const rd = fields.roadDistance(wx, wz) - WorldFields.ROAD_HALF_WIDTH
    const verge = rd > 1.5 && rd < 12 ? 0.45 * (1 - Math.abs(rd - 5) / 7) : 0
    const w = fields.biome(wx, wz, _bw, h)
    // Region undergrowth density (BiomeDefs.plantDensity, blended): leaf piles in the autumn valleys, a carpet of
    // ferns and glowing mushrooms in the mystic woods.
    const rw = fields.region(wx, wz, _wn, h)
    const green = rw[Biome.Forest] + rw[Biome.Autumn] + rw[Biome.Mystic]
    const reg = green > 0.01 ? (rw[Biome.Forest] + rw[Biome.Autumn] * BIOMES[Biome.Autumn].plantDensity + rw[Biome.Mystic] * BIOMES[Biome.Mystic].plantDensity) / green : 1
    // Overland palette: half the undergrowth — open straw meadows with a few bushes, not a carpet of dark spots.
    // Desert: sparse agaves and dry shrubs instead (WorldChunk picks the desert meshes by the biome at the plant).
    // SMALL bushes only, and ~40 % of the old count (the player asked for few, small ones): 0.45–0.8 scale
    // (was 0.7–1.6 — the big leafy mounds), a lighter verge band.
    const density = ((0.1 + fields.forestDensity(wx, wz, h) * 0.28 + Math.max(0, verge) * 1.1) * (1 - w[0] - w[1]) * 0.4 * Math.min(1.6, reg) + w[0] * (fields.palette === 0 ? 0.11 + 0.35 * oasisAt(fields, wx, wz, h) : 0.05)) * (fields.palette === 1 ? 0.45 : 1)
    let d2 = density
    if (fields.map) {
      // Fixed maps (2026-10-21, "too many bushes; group them"; refs: desert springs / seeps — shrubs and grass
      // round the water, the sand between nearly bare — and palm coasts — sea-grape shrubs clumped under the palms):
      // DESERT bushes only in the green ring round its pools; the BEACH none of its own, a clump round each of its
      // few trees (1.3–4.5 m from the trunk).
      const b = fields.beach(wx, wz, h)
      const green = density - w[0] * (fields.palette === 0 ? 0.11 + 0.35 * oasisAt(fields, wx, wz, h) : 0.05) * (fields.palette === 1 ? 0.45 : 1)
      d2 = Math.max(0, green) * (1 - b) + w[0] * (1 - b) * 0.4 * fields.map.poolRing(wx, wz)
      if (b > 0.2) {
        const t = beachTreeNear(fields, wx, wz)
        // a dense clump under the palm, bigger bushes than the undergrowth (sea grape under coconut palms)
        if (t > 1.2 && t < 4.8 && r < 0.85 * b) return 0.75 + (r / (0.85 * b)) * 0.45
      }
    }
    return r < d2 ? 0.45 + (r / Math.max(d2, 1e-3)) * 0.35 : 0
  })

  return { trees, rocks, plants }
}
