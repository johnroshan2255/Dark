import { scatterForest } from './Forest/scatter'
import { scatterRoadProps } from './Road/roadProps'
import { layoutPois } from './POI/poiLayout'
import { CHUNK_SIZE } from './constants'
import { generateTerrain } from './Terrain/generateTerrain'
import type { ChunkData } from './types'
import { WorldFields } from './WorldFields'
import { buildFormation } from './Formations/formations'

/**
 * Deterministic chunk generator: (seed, cx, cz) → ChunkData.
 *
 * Pipeline per chunk (skills/procedural-world):
 *   fields(seed) → terrain → road (baked into terrain + colours) → forest → props (grass is placed around the player at runtime: Forest/GrassField.ts)
 *   → [caves → POIs → monster spawns: not yet implemented]
 *
 * Runs inside chunk.worker.ts; also callable on the main thread (tests, tools).
 */
export class WorldGenerator {
  readonly fields: WorldFields

  constructor(readonly seed: number, palette = 0) {
    this.fields = new WorldFields(seed)
    this.fields.palette = palette
  }

  private props(cx: number, cz: number, heights: Float32Array): Float32Array {
    const out = scatterRoadProps(this.fields, cx, cz, heights)
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE
    layoutPois(this.fields.pois.inBox(x0, z0, x0 + CHUNK_SIZE, z0 + CHUNK_SIZE), cx, cz, heights, this.seed, out)
    return new Float32Array(out)
  }

  /**
   * Formations centred in this chunk, meshed (surface nets, 1.5 m voxels) and coloured: up-facing faces carry the
   * ground cover (grass / sand / snow), the rest is rock (warm grey-tan; sandstone in the desert; blue-grey in the
   * snow) with horizontal bands. Chunk-local coordinates.
   */
  private formations(cx: number, cz: number) {
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE
    const list = this.fields.formations.centredIn(x0, z0, x0 + CHUNK_SIZE, z0 + CHUNK_SIZE)
    const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = []
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    const bw: [number, number] = [0, 0]
    for (const f of list) {
      const m = buildFormation(f, 1.5)
      const w = this.fields.biome(f.x, f.z, bw)
      const sand = w[0], snow = w[1]
      const base = pos.length / 3
      for (let i = 0; i < m.positions.length; i += 3) {
        const x = m.positions[i] - x0, y = m.positions[i + 1], z = m.positions[i + 2] - z0
        pos.push(x, y, z)
        nor.push(m.normals[i], m.normals[i + 1], m.normals[i + 2])
        b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.min(b[2], z)
        b[3] = Math.max(b[3], x); b[4] = Math.max(b[4], y); b[5] = Math.max(b[5], z)
        const band = Math.sin(y * 0.9 + Math.sin(x * 0.07 + z * 0.05) * 2) * 0.5 + 0.5
        // Rock (linear RGB): warm grey-tan / sandstone / blue-grey, banded.
        let r = 0.16 + 0.12 * band, g = 0.15 + 0.1 * band, bl = 0.13 + 0.07 * band
        if (sand > 0.5) (r = 0.42 + 0.2 * band), (g = 0.2 + 0.1 * band), (bl = 0.09 + 0.05 * band)
        else if (snow > 0.5) (r = 0.2 + 0.1 * band), (g = 0.22 + 0.1 * band), (bl = 0.26 + 0.1 * band)
        // Ground cover on top faces (and the pillars' grassy crowns).
        const up = m.normals[i + 1]
        const cover = Math.min(1, Math.max(0, (up - 0.55) / 0.3))
        const cr = sand > 0.5 ? 0.85 : snow > 0.5 ? 0.9 : 0.16, cg = sand > 0.5 ? 0.55 : snow > 0.5 ? 0.93 : 0.36, cb = sand > 0.5 ? 0.25 : snow > 0.5 ? 0.98 : 0.07
        col.push(r + (cr - r) * cover, g + (cg - g) * cover, bl + (cb - bl) * cover)
      }
      for (let i = 0; i < m.indices.length; i++) idx.push(m.indices[i] + base)
    }
    return {
      fmPos: new Float32Array(pos), fmNor: new Float32Array(nor), fmCol: new Float32Array(col), fmIdx: new Uint32Array(idx),
      fmBounds: new Float32Array(list.length ? b : []),
    }
  }

  generateChunk(cx: number, cz: number): ChunkData {
    const t0 = performance.now()
    const terrain = generateTerrain(this.fields, cx, cz)
    const forest = scatterForest(this.fields, cx, cz, terrain.heights)
    const fm = this.formations(cx, cz)
    return {
      cx,
      cz,
      seed: this.seed,
      ...terrain,
      ...forest,
      props: this.props(cx, cz, terrain.heights),
      ...fm,
      genMs: performance.now() - t0,
    }
  }
}

/** Buffers to transfer (zero-copy) when posting ChunkData from a worker. */
export function chunkTransferables(d: ChunkData): ArrayBuffer[] {
  return [d.heights, d.normals, d.colors, d.roadLat, d.netEdge, d.netType, d.biome, d.trees, d.rocks, d.plants, d.props, d.fmPos, d.fmNor, d.fmCol, d.fmIdx, d.fmBounds].map((a) => a.buffer as ArrayBuffer)
}
