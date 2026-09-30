import { CELL_SIZE, CHUNK_RES, CHUNK_SIZE, CHUNK_VERTS } from '../constants'
import { WorldFields } from '../WorldFields'
import { groundColor } from './groundColor'
import { farmFieldAt, toLocal } from '../POI/pois'
import { PALETTE } from './terrainPalette'
import type { BiomeWeights } from '../Biomes'

const P = CHUNK_VERTS + 2 // padded grid for seamless normals

export interface TerrainArrays {
  heights: Float32Array
  normals: Float32Array
  colors: Float32Array
  roadLat: Float32Array
  netEdge: Float32Array
  netType: Float32Array
  /** CHUNK_VERTS² × 2 biome weights (desert, snow) incl. the snow line — terrain shader surface detail. */
  biome: Float32Array
  minY: number
  maxY: number
}

type RGB = ArrayLike<number>

/** Lerp out[o..o+2] toward b in place. */
function toward(out: Float32Array, o: number, b: RGB, t: number): void {
  out[o] += (b[0] - out[o]) * t
  out[o + 1] += (b[1] - out[o + 1]) * t
  out[o + 2] += (b[2] - out[o + 2]) * t
}

export function generateTerrain(fields: WorldFields, cx: number, cz: number): TerrainArrays {
  const ox = cx * CHUNK_SIZE
  const oz = cz * CHUNK_SIZE

  // Padded heights (one extra sample on every side) so normals match across chunk borders.
  const padded = new Float32Array(P * P)
  for (let iz = 0; iz < P; iz++) {
    for (let ix = 0; ix < P; ix++) {
      padded[iz * P + ix] = fields.height(ox + (ix - 1) * CELL_SIZE, oz + (iz - 1) * CELL_SIZE)
    }
  }

  const n = CHUNK_VERTS * CHUNK_VERTS
  const heights = new Float32Array(n)
  const normals = new Float32Array(n * 3)
  const colors = new Float32Array(n * 3)
  const roadLat = new Float32Array(n)
  const netEdge = new Float32Array(n).fill(99)
  const netType = new Float32Array(n).fill(-1)
  const biome = new Float32Array(n * 2)
  let minY = Infinity
  let maxY = -Infinity
  const gc: [number, number, number] = [0, 0, 0]
  const bw: BiomeWeights = [0, 0]

  for (let iz = 0; iz <= CHUNK_RES; iz++) {
    for (let ix = 0; ix <= CHUNK_RES; ix++) {
      const pi = (iz + 1) * P + (ix + 1)
      const h = padded[pi]
      const i = iz * CHUNK_VERTS + ix
      heights[i] = h
      if (h < minY) minY = h
      if (h > maxY) maxY = h

      // Central-difference normal.
      const dx = padded[pi + 1] - padded[pi - 1]
      const dz = padded[pi + P] - padded[pi - P]
      let nx = -dx
      let ny = 2 * CELL_SIZE
      let nz = -dz
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
      nx /= len
      ny /= len
      nz /= len
      normals[i * 3] = nx
      normals[i * 3 + 1] = ny
      normals[i * 3 + 2] = nz

      // Ground albedo: shared varied patchwork (groundColor.ts).
      const wx = ox + ix * CELL_SIZE
      const wz = oz + iz * CELL_SIZE
      groundColor(fields, wx, wz, h, 1 - ny, gc)
      colors[i * 3] = gc[0]; colors[i * 3 + 1] = gc[1]; colors[i * 3 + 2] = gc[2]
      fields.biome(wx, wz, bw, h)
      biome[i * 2] = bw[0]
      biome[i * 2 + 1] = bw[1]
      const poi = fields.pois.near(wx, wz)
      if (poi) {
        if (farmFieldAt(poi, wx, wz)) {
          const [flx] = toLocal(poi, wx, wz)
          const row = Math.abs(((flx % 1.3) + 1.3) % 1.3 - 0.65) / 0.65
          toward(colors, i * 3, row < 0.45 ? PALETTE.soilDark : PALETTE.soil, 0.92)
        } else {
          const dc = Math.hypot(wx - poi.x, wz - poi.z) / poi.radius
          if (poi.type !== 0 && dc < 0.45) toward(colors, i * 3, PALETTE.dirt, 0.6 * (1 - dc / 0.45)) // trampled camp/ruin ground
        }
      }
      roadLat[i] = wx - fields.roadCenterX(wz)
      const nr = fields.netRoad(wx, wz, 10)
      if (nr) {
        netEdge[i] = nr.dist - nr.halfWidth
        netType[i] = nr.type
        // Base colour under/near the track: bare earth (the shader paints the surface detail).
        if (netEdge[i] < 2.5) toward(colors, i * 3, PALETTE.dirt, Math.min(1, (2.5 - netEdge[i]) / 2.5) * 0.8)
      }
      const road = fields.roadInfluence(wx, wz)
      if (road > 0) {
        const surface = road >= 1 ? PALETTE.road : PALETTE.roadEdge
        const k = road >= 1 ? 1 : road * road * 0.85
        toward(colors, i * 3, surface, k)
      }
    }
  }
  return { heights, normals, colors, roadLat, netEdge, netType, biome, minY, maxY }
}

/**
 * Height at chunk-local (lx, lz) matching the LOD0 mesh triangulation
 * (quads split along the (1,0)-(0,1) diagonal — the same split Rapier's heightfield uses;
 * TerrainGeometry must agree. Verified by tests/world.test.ts).
 */
export function sampleHeight(heights: Float32Array, lx: number, lz: number): number {
  const fx = Math.min(Math.max(lx / CELL_SIZE, 0), CHUNK_RES - 1e-6)
  const fz = Math.min(Math.max(lz / CELL_SIZE, 0), CHUNK_RES - 1e-6)
  const ix = Math.floor(fx)
  const iz = Math.floor(fz)
  const tx = fx - ix
  const tz = fz - iz
  const i = iz * CHUNK_VERTS + ix
  const h00 = heights[i]
  const h10 = heights[i + 1]
  const h01 = heights[i + CHUNK_VERTS]
  const h11 = heights[i + CHUNK_VERTS + 1]
  return tx + tz < 1
    ? h00 + (h10 - h00) * tx + (h01 - h00) * tz
    : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz)
}
