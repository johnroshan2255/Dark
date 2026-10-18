/// <reference lib="webworker" />
import { generateFarTerrain } from '../Terrain/horizonGen'
import { chunkTransferables, WorldGenerator } from '../WorldGenerator'
import type { Landmark } from '../Landmarks/landmarks'
import type { RoadExport } from '../Road/RoadNetwork'

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

/** Far-forest request: a chunk's tree records only (FarForest, its own worker instance). */
export interface TreesRequest {
  type: 'trees'
  id: number
  seed: number
  palette: number
  cx: number
  cz: number
}

/** Landmark request: the landmark regions [i0..i1] × [j0..j1] (LANDMARK_REGION grid) and the home landmark
 *  (LandmarkSystem, its own worker instance — placing landmarks runs the road network's A*, never on the main thread). */
export interface LandmarksRequest {
  type: 'landmarks'
  id: number
  seed: number
  palette: number
  i0: number
  j0: number
  i1: number
  j1: number
}

export interface LandmarksResponse {
  id: number
  regions: [number, number, Landmark[]][]
  home: Landmark | null
}

let gen: WorldGenerator | null = null
/** Roads another chunk worker built (ChunkStreamer forwards them) — imported once this worker has its generator. */
const early: RoadExport[] = []

/** Roads built by another chunk worker (same seed, same deterministic roads): import instead of building again. */
export interface RoadsMessage {
  type: 'roads'
  roads: RoadExport
}

self.onmessage = (e: MessageEvent<ChunkRequest | FarRequest | TreesRequest | LandmarksRequest | RoadsMessage>) => {
  const msg = e.data
  if ('type' in msg && msg.type === 'roads') {
    if (gen) gen.fields.network.importRoads(msg.roads)
    else early.push(msg.roads)
    return
  }
  if (!gen || gen.seed !== msg.seed || gen.fields.palette !== msg.palette) {
    gen = new WorldGenerator(msg.seed, msg.palette)
    for (const r of early.splice(0)) gen.fields.network.importRoads(r)
  }
  const post = (self as unknown as DedicatedWorkerGlobalScope).postMessage.bind(self)
  if ('type' in msg && msg.type === 'landmarks') {
    const lm = gen.fields.landmarks
    const regions: [number, number, Landmark[]][] = []
    for (let j = msg.j0; j <= msg.j1; j++) for (let i = msg.i0; i <= msg.i1; i++) regions.push([i, j, lm.region(i, j)])
    post({ id: msg.id, regions, home: lm.home() } satisfies LandmarksResponse)
    return
  }
  if ('type' in msg && msg.type === 'trees') {
    const trees = gen.generateTrees(msg.cx, msg.cz)
    post({ id: msg.id, trees }, [trees.buffer])
    return
  }
  if ('type' in msg && msg.type === 'far') {
    const far = generateFarTerrain(gen.fields, msg.cx, msg.cz, msg.size, msg.res)
    post({ id: msg.id, far }, [far.heights.buffer, far.colors.buffer, far.canopy.buffer])
    return
  }
  const data = gen.generateChunk(msg.cx, msg.cz)
  // + the road lists this chunk built (RoadNetwork.exportNew): the main thread's queries near the player reuse them
  // instead of running the road A* again in a frame.
  post({ id: msg.id, data, roads: gen.fields.network.exportNew() }, chunkTransferables(data))
}
