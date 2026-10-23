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
  /** Per vertex: canopy colour (rgb, linear) + forest density (a) — the shader draws tree crowns from it. */
  canopy: Float32Array
}

/**
 * WARPED grid: vertex i of res sits at offset farOffset(i) from the centre — dense near the player (where it
 * meets the streamed chunks), coarse toward the multi-km rim — so hills reach the horizon for a few k tris.
 * Shared by the worker (sampling) and HorizonTerrain (mesh) so both agree exactly.
 */
export const FAR_WARP = 2
export function farOffset(i: number, res: number, size: number): number {
  const t = (2 * i) / res - 1
  return Math.sign(t) * Math.pow(Math.abs(t), FAR_WARP) * size * 0.5
}

const FOREST = [0.03, 0.058, 0.04]
const TEAL = [0.02, 0.045, 0.045]
const OLIVE_C = [0.07, 0.085, 0.03]
const GOLD_C = [0.16, 0.13, 0.035]
const AUTUMN = [0.22, 0.08, 0.025]
const BW: [number, number] = [0, 0]

export function generateFarTerrain(fields: WorldFields, cx: number, cz: number, size: number, res: number): FarTerrainData {
  const n = res + 1
  const off = Array.from({ length: n }, (_, i) => farOffset(i, res, size))
  const heights = new Float32Array(n * n)
  const colors = new Float32Array(n * n * 3)
  const canopyOut = new Float32Array(n * n * 4)
  // (a fixed map: the mean of five points across the vertex's cell — a point sample in a 26 m river channel pulled a
  // whole 60 m horizon cell under the water: a lake along the valley that isn't there; Zhangjiajie, 2026-10-23. On a
  // CLIFF — the five points > 30 m apart — the HIGHEST: a tower or table keeps its flat top and its height on the
  // skyline (their mean shaved the tables into fins with sky between; the lowest turned Zhangjiajie's towers into
  // needles).)
  const box = !!fields.map
  const top = new Uint8Array(n * n)                 // (vertices standing for a tower / table top: coloured as one)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = cx + off[i], z = cz + off[j]
      if (!box) {
        heights[j * n + i] = fields.heightNoCave(x, z)
        continue
      }
      const dx = (off[Math.min(n - 1, i + 1)] - off[Math.max(0, i - 1)]) / 6, dz = (off[Math.min(n - 1, j + 1)] - off[Math.max(0, j - 1)]) / 6
      const h0 = fields.heightNoCave(x, z), h1 = fields.heightNoCave(x + dx, z), h2 = fields.heightNoCave(x - dx, z), h3 = fields.heightNoCave(x, z + dz), h4 = fields.heightNoCave(x, z - dz)
      const lo = Math.min(h0, h1, h2, h3, h4)
      const hi = Math.max(h0, h1, h2, h3, h4)
      heights[j * n + i] = hi - lo > 30 ? hi : (h0 + h1 + h2 + h3 + h4) / 5
      if (hi - lo > 30) top[j * n + i] = 1
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i
      const x = cx + off[i]
      const z = cz + off[j]
      const h = heights[k]
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(n - 1, j + 1)
      const hx = (heights[j * n + i1] - heights[j * n + i0]) / Math.max(1e-3, off[i1] - off[i0])
      const hz = (heights[j1 * n + i] - heights[j0 * n + i]) / Math.max(1e-3, off[j1] - off[j0])
      const slope = Math.hypot(hx, hz)
      const c: [number, number, number] = [0, 0, 0]
      groundColor(fields, x, z, h, top[k] ? 0 : Math.min(1, slope * 0.8), c)
      // Canopy seen from afar: clustered dark-teal / olive / golden stands (refer vista), not one green.
      const forest = h > WorldFields.WATER + 1 ? fields.forestDensity(x, z, h) : 0
      const stand = fields.colorVariation(x * 0.4 + 57, z * 0.4 - 13)
      const canopy = stand < 0.3 ? TEAL : stand < 0.55 ? FOREST : stand < 0.75 ? OLIVE_C : stand < 0.9 ? GOLD_C : AUTUMN
      // The ground stays ground-coloured: the shader draws individual crowns (canopy colour) at this density
      // and only blends to the mean where crowns are smaller than a pixel (HorizonTerrain).
      canopyOut[k * 4] = canopy[0]
      canopyOut[k * 4 + 1] = canopy[1]
      canopyOut[k * 4 + 2] = canopy[2]
      // Plus Genshin's lone trees scattered over every green meadow (~1 crown per 10 cells), not only groves.
      const bw = fields.biomes.weights(x, z, BW)
      const meadow = h > WorldFields.WATER + 1 && slope < 0.5 ? 0.1 * (1 - bw[0]) * (1 - bw[1] * 0.6) : 0
      canopyOut[k * 4 + 3] = Math.min(1, Math.max(forest * 0.85, meadow)) // matches the thinner groves (scatter TREE_SHARE)
      colors[k * 3] = c[0]
      colors[k * 3 + 1] = c[1]
      colors[k * 3 + 2] = c[2]
    }
  }
  return { cx, cz, size, res, heights, colors, canopy: canopyOut }
}
