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
  /** CHUNK_VERTS² × 2: biome weights (desert, snow) — see world/Biomes.ts. */
  biome: Float32Array
  minY: number
  maxY: number
  /** Stride TREE_STRIDE: x, y, z, rotY, scale, species. */
  trees: Float32Array
  /** Stride PROP_STRIDE: x, y, z, rotY, scale. */
  rocks: Float32Array
  plants: Float32Array
  /** Roadside props (poles, fences), stride 6: x, y, z, rotY, scale, type — see Road/roadProps.ts. */
  props: Float32Array
  /** Rock formations centred in this chunk (World/Formations): chunk-local positions, normals, colours, indices,
   *  and their bounds [minX, minY, minZ, maxX, maxY, maxZ] (chunk-local; empty arrays when none). */
  fmPos: Float32Array
  fmNor: Float32Array
  fmCol: Float32Array
  fmIdx: Uint32Array
  fmBounds: Float32Array
  /** Generation time in ms (profiling). */
  genMs: number
}

export const TREE_STRIDE = 6
export const PROP_STRIDE = 5

/** Cactus (saguaro) and Joshua grow only in the desert (Forest/desertFlora.ts). */
/** Maple grows in the autumn valleys; Ancient (giant violet tree) and Shroom (glowing mushroom tree) in the mystic woods
 *  (world/biomes/BiomeDefs.ts). Region species REPLACE the forest ones there, so a chunk's draw count stays flat. */
export const TreeSpecies = { Spruce: 0, Dead: 1, Fir: 2, Pine: 3, Birch: 4, Cactus: 5, Joshua: 6, Maple: 7, Ancient: 8, Shroom: 9 } as const
export const TREE_SPECIES_COUNT = 10
/** Trunk collider radius at scale 1, indexed by species id (see Forest/treeFactory.ts). */
export const TRUNK_RADIUS = [0.24, 0.22, 0.28, 0.32, 0.3, 0.34, 0.3, 0.3, 0.6, 0.26] as const

export const chunkKey = (cx: number, cz: number): string => `${cx},${cz}`

/** Water level (m) — mirrors WorldFields.WATER (kept here so physics/helpers need no WorldFields import). */
export const WATER_LEVEL = -6
/**
 * Snow weight above which standing water is FROZEN (matches the water shader's ice ramp): the ground there is
 * the ice surface at the water level — physics, feet and the camera stand on it.
 */
export const ICE_SNOW = 0.32
/** Vertex `i` of a chunk: its ground height, raised to the ice surface where the water is frozen. */
export function solidHeight(d: ChunkData, i: number): number {
  const h = d.heights[i]
  return h < WATER_LEVEL && d.biome[i * 2 + 1] > ICE_SNOW ? WATER_LEVEL : h
}
