import { CHUNK_SIZE, LOD_COUNT, LOD_HYSTERESIS } from '../../world/constants'

/**
 * Chunk-level LOD with hysteresis. One decision per chunk per frame (≤ ~100 chunks),
 * never per object. See skills/lod.
 */

/** Continuous Chebyshev distance (in chunks) from a world position to a chunk's centre. */
export function chunkDistance(px: number, pz: number, cx: number, cz: number): number {
  const dx = Math.abs(px / CHUNK_SIZE - (cx + 0.5))
  const dz = Math.abs(pz / CHUNK_SIZE - (cz + 0.5))
  return Math.max(dx, dz)
}

/** @param rings LOD boundaries in chunk units (per quality tier). */
export function selectLod(current: number, dist: number, rings: readonly number[]): number {
  let lod = current < 0 ? rawLod(dist, rings) : current
  // Step at most one level per frame; only cross a ring once past the hysteresis band.
  if (lod > 0 && dist < rings[lod - 1] - LOD_HYSTERESIS) lod--
  else if (lod < LOD_COUNT - 1 && dist > rings[lod] + LOD_HYSTERESIS) lod++
  return lod
}

function rawLod(dist: number, rings: readonly number[]): number {
  let lod = 0
  while (lod < rings.length && dist > rings[lod]) lod++
  return lod
}
