import { WorldFields } from '../WorldFields'
import { groundColor } from './groundColor'

/**
 * Horizon terrain data (pure, worker-side): a (res+1)² grid of heights + linear colours covering `size` m
 * around (cx, cz). Forested ground is painted dark conifer green so distant hills read as forest
 * (refer/environment/procedural-world-vista); steep ground → rock; shores → sand.
 */
export interface FarTerrainData {
  cx: number
  cz: number
  size: number
  res: number
  heights: Float32Array
  colors: Float32Array
}

const FOREST = [0.03, 0.058, 0.04]
const TEAL = [0.02, 0.045, 0.045]
const OLIVE_C = [0.07, 0.085, 0.03]
const GOLD_C = [0.16, 0.13, 0.035]
const AUTUMN = [0.22, 0.08, 0.025]

export function generateFarTerrain(fields: WorldFields, cx: number, cz: number, size: number, res: number): FarTerrainData {
  const n = res + 1
  const step = size / res
  const x0 = cx - size / 2
  const z0 = cz - size / 2
  const heights = new Float32Array(n * n)
  const colors = new Float32Array(n * n * 3)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[j * n + i] = fields.height(x0 + i * step, z0 + j * step)
  const mix = (c: number[], t: [number, number, number] | readonly number[], k: number) => {
    c[0] += (t[0] - c[0]) * k
    c[1] += (t[1] - c[1]) * k
    c[2] += (t[2] - c[2]) * k
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i
      const x = x0 + i * step
      const z = z0 + j * step
      const h = heights[k]
      const hx = heights[j * n + Math.min(n - 1, i + 1)] - heights[j * n + Math.max(0, i - 1)]
      const hz = heights[Math.min(n - 1, j + 1) * n + i] - heights[Math.max(0, j - 1) * n + i]
      const slope = Math.hypot(hx, hz) / (2 * step)
      const c: [number, number, number] = [0, 0, 0]
      groundColor(fields, x, z, h, Math.min(1, slope * 0.8), c)
      // Canopy seen from afar: clustered dark-teal / olive / golden stands (refer vista), not one green.
      const forest = h > WorldFields.WATER + 1 ? fields.forestDensity(x, z) : 0
      const stand = fields.colorVariation(x * 0.4 + 57, z * 0.4 - 13)
      const canopy = stand < 0.3 ? TEAL : stand < 0.55 ? FOREST : stand < 0.75 ? OLIVE_C : stand < 0.9 ? GOLD_C : AUTUMN
      mix(c, canopy, Math.min(1, forest * 1.4))
      colors[k * 3] = c[0]
      colors[k * 3 + 1] = c[1]
      colors[k * 3 + 2] = c[2]
    }
  }
  return { cx, cz, size, res, heights, colors }
}
