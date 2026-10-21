import { CELL_SIZE, CHUNK_RES, CHUNK_SIZE, CHUNK_VERTS } from '../constants'
import { WorldFields } from '../WorldFields'
import { SINK } from '../Road/RoadDetail'
import { buildRoadSurface, type RoadSurfaceArrays } from './roadSurface'
import { vertexColor, type VertexAttrs } from './vertexColor'

const P = CHUNK_VERTS + 2 // padded grid for seamless normals

export interface TerrainArrays extends RoadSurfaceArrays {
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
  /** LOD0 / collider heights: `heights` with the grid vertices under a road ribbon sunk by SINK (Road/RoadDetail). */
  heights0: Float32Array
  minY0: number
}

const _va: VertexAttrs = { netEdge: 99, netType: -1, b0: 0, b1: 0 }

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
  const heights0 = new Float32Array(n)
  let minY0 = Infinity

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

      const wx = ox + ix * CELL_SIZE
      const wz = oz + iz * CELL_SIZE
      vertexColor(fields, wx, wz, h, ny, colors, i * 3, _va)
      biome[i * 2] = _va.b0
      biome[i * 2 + 1] = _va.b1
      roadLat[i] = wx - fields.roadCenterX(wz)
      netEdge[i] = _va.netEdge
      netType[i] = _va.netType
      // ROAD DETAIL (Road/RoadDetail.ts): grid vertices under a road ribbon sink at LOD0 (the ribbon is the surface).
      heights0[i] = fields.roadDetail.sunk(wx, wz) ? h - SINK : h
      if (heights0[i] < minY0) minY0 = heights0[i]
    }
  }
  const rd = buildRoadSurface(fields, cx, cz, padded, colors, normals, biome, heights0)
  return { heights, heights0, minY0, normals, colors, roadLat, netEdge, netType, biome, minY, maxY, ...rd }
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
