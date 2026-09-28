/**
 * Pure chunk data produced by the generator (worker-safe: typed arrays + numbers only,
 * all buffers are transferable). Positions are chunk-local metres.
 */
export interface ChunkData {
  cx: number
  cz: number
  seed: number
  /** CHUNK_VERTS² heights, index = iz * CHUNK_VERTS + ix. */
  heights: Float32Array
  /** CHUNK_VERTS² × 3, computed from a padded height grid so borders are seamless. */
  normals: Float32Array
  /** CHUNK_VERTS² × 3 linear RGB albedo. */
  colors: Float32Array
  /** CHUNK_VERTS² signed lateral distance to the road centreline (m) — drives the painted road shader. */
  roadLat: Float32Array
  /** CHUNK_VERTS²: distance from the nearest secondary road's edge (m, <0 on it; 99 = none). */
  netEdge: Float32Array
  /** CHUNK_VERTS²: that road's type (RoadType) or -1. */
  netType: Float32Array
  minY: number
  maxY: number
  /** Stride TREE_STRIDE: x, y, z, rotY, scale, species. */
  trees: Float32Array
  /** Stride PROP_STRIDE: x, y, z, rotY, scale. */
  rocks: Float32Array
  plants: Float32Array
  /** Roadside props (poles, fences), stride 6: x, y, z, rotY, scale, type — see Road/roadProps.ts. */
  props: Float32Array
  /** Generation time in ms (profiling). */
  genMs: number
}

export const TREE_STRIDE = 6
export const PROP_STRIDE = 5

export const TreeSpecies = { Spruce: 0, Dead: 1, Fir: 2, Pine: 3, Birch: 4 } as const
export const TREE_SPECIES_COUNT = 5
/** Trunk collider radius at scale 1, indexed by species id (see Forest/treeFactory.ts). */
export const TRUNK_RADIUS = [0.24, 0.22, 0.28, 0.26, 0.16] as const

export const chunkKey = (cx: number, cz: number): string => `${cx},${cz}`
