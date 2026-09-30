/// <reference lib="webworker" />
import { generateFarTerrain } from '../Terrain/horizonGen'
import { chunkTransferables, WorldGenerator } from '../WorldGenerator'

export interface ChunkRequest {
  id: number
  seed: number
  /** Ground palette id (rendering/artStyle groundPalette) — colours only. */
  palette: number
  cx: number
  cz: number
}

/** Horizon-terrain request (same worker file, separate worker instance — see FarTerrain). */
export interface FarRequest {
  type: 'far'
  id: number
  seed: number
  palette: number
  cx: number
  cz: number
  size: number
  res: number
}

let gen: WorldGenerator | null = null

self.onmessage = (e: MessageEvent<ChunkRequest | FarRequest>) => {
  const msg = e.data
  if (!gen || gen.seed !== msg.seed || gen.fields.palette !== msg.palette) gen = new WorldGenerator(msg.seed, msg.palette)
  const post = (self as unknown as DedicatedWorkerGlobalScope).postMessage.bind(self)
  if ('type' in msg && msg.type === 'far') {
    const far = generateFarTerrain(gen.fields, msg.cx, msg.cz, msg.size, msg.res)
    post({ id: msg.id, far }, [far.heights.buffer, far.colors.buffer])
    return
  }
  const data = gen.generateChunk(msg.cx, msg.cz)
  post({ id: msg.id, data }, chunkTransferables(data))
}
