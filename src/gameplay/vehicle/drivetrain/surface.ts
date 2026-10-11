import { WorldFields as WF } from '../../../world/WorldFields'
import { Surf, blendRoughness, type SurfaceMix } from './tyre'

/**
 * What the tyres are on, in DARK (skills/realistic-vehicle-system §8.7): deterministic from the seed — the main
 * road is asphalt, gravel roads and trails are dirt, off the road it is the region's ground (forest / autumn /
 * mystic grass, desert sand, snowfield snow) and frozen water is ice. Weights blend over ~1 m at a road edge and
 * by the region weights at a biome border, so grip never jumps. `wet` = the weather's ground wetness.
 * Cost: one road-edge query, one road-network query and one region-weight lookup — one wheel per physics step.
 */
const rw = new Float32Array(5)

export function sampleSurface(fields: WF, x: number, z: number, wet: number, out: SurfaceMix): void {
  const w = out.w
  w.fill(0)
  out.wet = wet
  if (fields.surface(x, z) === WF.WATER) {
    w[Surf.Ice] = 1
    return blendRoughness(out)
  }
  const main = fields.roadDistance(x, z) - WF.ROAD_HALF_WIDTH
  const net = fields.netRoad(x, z, 20)
  const netEdge = net ? net.dist - net.halfWidth : Infinity
  const onMain = Math.max(0, Math.min(1, 0.5 - main))
  const onNet = Math.max(0, Math.min(1, 0.5 - netEdge)) * (1 - onMain)
  w[Surf.Asphalt] += onMain
  w[Surf.Dirt] += onNet // gravel roads and trails alike
  const off = 1 - onMain - onNet
  if (off <= 0) return blendRoughness(out)
  // Regions: 0 forest, 1 desert, 2 snowfield, 3 autumn, 4 mystic (world/Biomes BIOME_NAMES).
  fields.region(x, z, rw)
  w[Surf.Grass] += off * (rw[0] + rw[3] + rw[4])
  w[Surf.Sand] += off * rw[1]
  w[Surf.Snow] += off * rw[2]
  blendRoughness(out)
}
