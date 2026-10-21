import { CHUNK_SIZE } from '../constants'
import { hashFloat, Layer } from '../noise/rng'
import { sampleHeight } from '../Terrain/generateTerrain'
import { WorldFields } from '../WorldFields'

/**
 * Roadside props placed along the analytic road (refer/roads hero): utility poles every POLE_SPACING m on the
 * right verge, wooden rail fence segments on stretches of the left verge. Keyed by GLOBAL road z, so a pole's
 * existence never depends on which chunk generated it; each chunk emits the props whose position falls inside
 * it. Stride PROP6: x, y, z, rotY, scale, type (chunk-local).
 */
export const RoadProp = { Pole: 0, Fence: 1 } as const
export const POLE_SPACING = 38
export const POLE_LATERAL = 5.6
export const FENCE_LATERAL = -6.4
export const FENCE_SEGMENT = 4

/** Rotation that aligns local +Z with the road direction at z. */
export function roadYaw(fields: WorldFields, z: number): number {
  const dxdz = (fields.roadCenterX(z + 1) - fields.roadCenterX(z - 1)) / 2
  return Math.atan2(dxdz, 1)
}

export function scatterRoadProps(fields: WorldFields, cx: number, cz: number, heights: Float32Array, out: number[] = []): number[] {
  const x0 = cx * CHUNK_SIZE
  const z0 = cz * CHUNK_SIZE
  const emit = (wx: number, wz: number, rot: number, scale: number, type: number) => {
    const lx = wx - x0
    const lz = wz - z0
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) return
    out.push(lx, sampleHeight(heights, lx, lz), lz, rot, scale, type)
  }
  // Poles: global multiples of POLE_SPACING along z.
  for (let k = Math.ceil(z0 / POLE_SPACING); k * POLE_SPACING < z0 + CHUNK_SIZE; k++) {
    const z = k * POLE_SPACING
    const x = fields.roadCenterX(z) + POLE_LATERAL
    // Genshin style (palette 0): NO power lines — Teyvat has none; a dirt road between landmarks. Over the hill
    // (1) keeps them all. Never through a rock formation.
    if (fields.palette === 0) continue
    if (fields.formations.near(x, z, 3)) continue
    emit(x, z, roadYaw(fields, z) + (hashFloat(fields.seed, k, 3, Layer.POI) - 0.5) * 0.08, 1, RoadProp.Pole)
  }
  // Fences: 4 m segments where a low-frequency mask says "fenced stretch" (≈ 40% of the road).
  for (let k = Math.ceil(z0 / FENCE_SEGMENT); k * FENCE_SEGMENT < z0 + CHUNK_SIZE; k++) {
    const z = (k + 0.5) * FENCE_SEGMENT
    const stretch = hashFloat(fields.seed, Math.floor(z / 60), 5, Layer.POI)
    if (stretch < (fields.palette === 0 ? 0.82 : 0.6)) continue
    if (fields.formations.near(fields.roadCenterX(z) + FENCE_LATERAL, z, 2)) continue
    if (hashFloat(fields.seed, k, 9, Layer.POI) < 0.08) continue // a missing/broken segment here and there
    const x = fields.roadCenterX(z) + FENCE_LATERAL
    emit(x, z, roadYaw(fields, z), 1, RoadProp.Fence)
  }
  return out
}
