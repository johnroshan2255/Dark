/**
 * World-scale constants. Changing these changes the budget of every system —
 * see ARCHITECTURE.md §3 and skills/world-streaming.
 */

/** Chunk edge length in metres. */
export const CHUNK_SIZE = 64
/** Terrain cells per chunk edge at LOD0 (2 m spacing → deliberately low-poly). */
export const CHUNK_RES = 32
/** Vertices per chunk edge at LOD0. */
export const CHUNK_VERTS = CHUNK_RES + 1
export const CELL_SIZE = CHUNK_SIZE / CHUNK_RES

/**
 * Streaming radii in chunks (Chebyshev distance from the player's chunk).
 * The RENDER radius is per quality tier (rendering/quality/QualityTiers.ts); this is its maximum.
 */
export const MAX_RENDER_RADIUS = 4

export const RADIUS = {
  /** Extra ring before a rendered chunk is unloaded (hysteresis). */
  unloadMargin: 1,
  /** Chunks with Rapier colliders. */
  physics: 1,
  /** Chunks where monsters are simulated. */
  ai: 2,
  audio: 2,
} as const

/** LOD ring boundaries are per tier (QualitySettings.lodRings); hysteresis is global. */
export const LOD_HYSTERESIS = 0.35
/** Terrain vertex stride per LOD level: 2 m, 4 m, 8 m. */
export const LOD_TERRAIN_STRIDE = [1, 2, 4] as const
export const LOD_COUNT = 3

/** Cached ChunkData entries retained after unload. */
export const CHUNK_DATA_CACHE = 96
