import type { WorldFields } from '../WorldFields'
import { groundColor } from './groundColor'
import { farmFieldAt, toLocal } from '../POI/pois'
import { PALETTE } from './terrainPalette'
import type { BiomeWeights } from '../Biomes'

type RGB = ArrayLike<number>

/** Lerp out[o..o+2] toward b in place. */
function toward(out: Float32Array, o: number, b: RGB, t: number): void {
  out[o] += (b[0] - out[o]) * t
  out[o + 1] += (b[1] - out[o + 1]) * t
  out[o + 2] += (b[2] - out[o + 2]) * t
}

/** Per-vertex attributes besides the colour (vertexColor's second output). */
export interface VertexAttrs {
  netEdge: number
  netType: number
  b0: number
  b1: number
}
const _gc: [number, number, number] = [0, 0, 0]
const _bw: BiomeWeights = [0, 0]

/**
 * The terrain colour of a grid vertex at world (wx, wz) with height h and normal.y ny (linear RGB → out[o..o+2]),
 * and its secondary-road / biome attributes. Shared by the chunk grid and the road ribbons (which interpolate
 * it at grid vertices just outside their chunk) — one definition, so a ribbon matches the ground it lies on.
 */
export function vertexColor(fields: WorldFields, wx: number, wz: number, h: number, ny: number, colors: Float32Array, o: number, va: VertexAttrs): void {
  // Ground albedo: shared varied patchwork (groundColor.ts).
  const gc = _gc
  groundColor(fields, wx, wz, h, 1 - ny, gc)
  colors[o] = gc[0]; colors[o + 1] = gc[1]; colors[o + 2] = gc[2]
  fields.biome(wx, wz, _bw, h)
  va.b0 = _bw[0]
  va.b1 = _bw[1]
  const poi = fields.pois.near(wx, wz)
  if (poi) {
    if (farmFieldAt(poi, wx, wz)) {
      const [flx] = toLocal(poi, wx, wz)
      const row = Math.abs(((flx % 1.3) + 1.3) % 1.3 - 0.65) / 0.65
      toward(colors, o, row < 0.45 ? PALETTE.soilDark : PALETTE.soil, 0.92)
    } else {
      const dc = Math.hypot(wx - poi.x, wz - poi.z) / poi.radius
      if (poi.type !== 0 && dc < 0.45) toward(colors, o, PALETTE.dirt, 0.6 * (1 - dc / 0.45)) // trampled camp/ruin ground
    }
  }
  va.netEdge = 99
  va.netType = -1
  const nr = fields.netRoad(wx, wz, 10)
  if (nr) {
    va.netEdge = nr.dist - nr.halfWidth
    va.netType = nr.type
    // Base colour under/near the track: bare earth (the shader paints the surface detail).
    if (va.netEdge < 2.5) toward(colors, o, PALETTE.dirt, Math.min(1, (2.5 - va.netEdge) / 2.5) * 0.8)
  }
  const road = fields.roadInfluence(wx, wz)
  if (road > 0) {
    const surface = road >= 1 ? PALETTE.road : PALETTE.roadEdge
    const k = road >= 1 ? 1 : road * road * 0.85
    toward(colors, o, surface, k)
  }
}

