import { WorldFields as WF } from '../../../world/WorldFields'
import { MAIN_DITCH_IN, detailInfo } from '../../../world/Road/RoadDetail'
import { Surf, blendRoughness, type SurfaceMix } from './tyre'

/**
 * What the tyres are on, in DARK (skills/realistic-vehicle-system §8.7): deterministic from the seed — the main
 * road is asphalt with a gravel shoulder, gravel roads and trails are dirt with MUD in their wet stretches, rut
 * bottoms and potholes (world/Road/RoadDetail: the ruts, potholes and gutters themselves are collider geometry),
 * off the road it is the region's ground (forest / autumn / mystic grass, desert sand, snowfield snow), damp mud
 * in a gutter's bottom, and frozen water is ice. Weights blend over ~1 m at a road edge and by the region weights at
 * a biome border, so grip never jumps. On a track the roughness follows the ruts: packed and smoother in them
 * (washboard on gravel), rougher and stonier on the hump and the edges. `wet` = the weather's ground wetness.
 * Cost: one road-detail query (≈ 1–3 µs), one road-network query and one region-weight lookup — one wheel per
 * physics step.
 */
const rw = new Float32Array(5)
const di = detailInfo()
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export function sampleSurface(fields: WF, x: number, z: number, wet: number, out: SurfaceMix): void {
  const w = out.w
  w.fill(0)
  out.wet = wet
  out.wash = 0
  if (fields.surface(x, z) === WF.WATER) {
    w[Surf.Ice] = 1
    return blendRoughness(out)
  }
  const main = fields.roadDistance(x, z) - WF.ROAD_HALF_WIDTH
  const net = fields.netRoad(x, z, 20)
  const netEdge = net ? net.dist - net.halfWidth : Infinity
  fields.roadDetail.query(x, z, di)
  const onMain = clamp01(0.5 - main)
  // The main road's gravel shoulder, out to its gutter.
  const shoulder = clamp01((MAIN_DITCH_IN - WF.ROAD_HALF_WIDTH + 0.1 - main) / 0.4) * (1 - onMain)
  const onNet = clamp01(0.5 - netEdge) * (1 - onMain - shoulder)
  // Mud on a track: its wet stretches (more in the ruts), potholes.
  const mud = di.kind === 2 ? clamp01(di.mud * (0.35 + 0.65 * di.rut) + di.pothole * (0.5 + 0.5 * di.mud)) * di.feat : 0
  w[Surf.Asphalt] += onMain
  w[Surf.Dirt] += shoulder + onNet * (1 - mud) // gravel roads and trails alike
  w[Surf.Mud] += onNet * mud
  const off = 1 - onMain - shoulder - onNet
  if (off > 0) {
    // A gutter's damp bottom.
    const ditch = clamp01(di.ditch * 0.6) * off
    w[Surf.Mud] += ditch
    const rest = off - ditch
    // Regions: 0 forest, 1 desert, 2 snowfield, 3 autumn, 4 mystic (world/Biomes BIOME_NAMES).
    fields.region(x, z, rw)
    w[Surf.Grass] += rest * (rw[0] + rw[3] + rw[4])
    w[Surf.Sand] += rest * rw[1]
    w[Surf.Snow] += rest * rw[2]
  }
  blendRoughness(out)
  if (di.kind === 2 && onNet > 0) {
    // Packed, smoother ruts; a rough, stony hump and edges.
    const k = onNet * di.feat
    out.rough *= 1 + k * (0.3 - 0.65 * di.rut)
    out.stones *= 1 + k * (di.type === 0 ? 0.4 : 0.1) * (1 - di.rut)
    // Washboard on gravel roads, in the ruts, where it's dry enough to corrugate.
    if (di.type === 0) {
      out.wash = 0.011 * k * di.rut * (1 - di.mud)
      out.washX = di.dx
      out.washZ = di.dz
    }
  }
}
