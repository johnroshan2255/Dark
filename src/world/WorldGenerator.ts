import { scatterForest } from './Forest/scatter'
import { scatterRoadProps } from './Road/roadProps'
import { layoutPois } from './POI/poiLayout'
import { CHUNK_SIZE } from './constants'
import { generateTerrain } from './Terrain/generateTerrain'
import type { ChunkData } from './types'
import { WorldFields } from './WorldFields'

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

  constructor(readonly seed: number) {
    this.fields = new WorldFields(seed)
  }

  private props(cx: number, cz: number, heights: Float32Array): Float32Array {
    const out = scatterRoadProps(this.fields, cx, cz, heights)
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE
    layoutPois(this.fields.pois.inBox(x0, z0, x0 + CHUNK_SIZE, z0 + CHUNK_SIZE), cx, cz, heights, this.seed, out)
    return new Float32Array(out)
  }

  generateChunk(cx: number, cz: number): ChunkData {
    const t0 = performance.now()
    const terrain = generateTerrain(this.fields, cx, cz)
    const forest = scatterForest(this.fields, cx, cz, terrain.heights)
    return {
      cx,
      cz,
      seed: this.seed,
      ...terrain,
      ...forest,
      props: this.props(cx, cz, terrain.heights),
      genMs: performance.now() - t0,
    }
  }
}

/** Buffers to transfer (zero-copy) when posting ChunkData from a worker. */
export function chunkTransferables(d: ChunkData): ArrayBuffer[] {
  return [d.heights, d.normals, d.colors, d.roadLat, d.netEdge, d.netType, d.trees, d.rocks, d.plants, d.props].map((a) => a.buffer as ArrayBuffer)
}
