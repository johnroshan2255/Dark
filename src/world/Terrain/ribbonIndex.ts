import { CELL_SIZE, CHUNK_RES, CHUNK_SIZE } from '../constants'
import type { ChunkData } from '../types'
import { sampleHeight } from './generateTerrain'

/**
 * Point lookup on a chunk's road ribbon (Terrain/roadSurface.ts): 2 m buckets → the triangles overlapping each,
 * barycentric height + Δ. `groundOf` = the LOD0 / collider surface (ribbon where there is one, else the sunk grid).
 * Built lazily per chunk on the main thread (~0.1 ms for a road chunk; ~20 KB), queried in a few µs.
 */
export class RibbonIndex {
  private readonly start: Uint32Array
  private readonly tris: Uint32Array
  constructor(private readonly d: Pick<ChunkData, 'rdPos' | 'rdIdx' | 'rdDelta'>) {
    const N = CHUNK_RES, p = d.rdPos, ix = d.rdIdx
    const count = new Uint32Array(N * N + 1)
    const range = (t: number, f: (c: number) => void) => {
      let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity
      for (let k = 0; k < 3; k++) {
        const v = ix[t + k] * 3
        mnx = Math.min(mnx, p[v]); mxx = Math.max(mxx, p[v]); mnz = Math.min(mnz, p[v + 2]); mxz = Math.max(mxz, p[v + 2])
      }
      const i0 = Math.max(0, Math.floor(mnx / CELL_SIZE)), i1 = Math.min(N - 1, Math.floor(mxx / CELL_SIZE))
      const j0 = Math.max(0, Math.floor(mnz / CELL_SIZE)), j1 = Math.min(N - 1, Math.floor(mxz / CELL_SIZE))
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * N + i)
    }
    for (let t = 0; t < ix.length; t += 3) range(t, (c) => count[c + 1]++)
    for (let c = 0; c < N * N; c++) count[c + 1] += count[c]
    this.start = count
    this.tris = new Uint32Array(count[N * N])
    const fill = count.slice(0, N * N)
    for (let t = 0; t < ix.length; t += 3) range(t, (c) => (this.tris[fill[c]++] = t))
  }

  /** Ribbon height at chunk-local (lx, lz) (→ out[0] = height, out[1] = Δ), or false where there is no ribbon. */
  sample(lx: number, lz: number, out: number[]): boolean {
    const N = CHUNK_RES
    const c = Math.min(N - 1, Math.max(0, Math.floor(lz / CELL_SIZE))) * N + Math.min(N - 1, Math.max(0, Math.floor(lx / CELL_SIZE)))
    const p = this.d.rdPos, ix = this.d.rdIdx, dl = this.d.rdDelta
    for (let q = this.start[c]; q < this.start[c + 1]; q++) {
      const t = this.tris[q]
      const a = ix[t] * 3, b = ix[t + 1] * 3, cc = ix[t + 2] * 3
      const ax = p[a], az = p[a + 2], bx = p[b], bz = p[b + 2], cx = p[cc], cz = p[cc + 2]
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
      if (Math.abs(det) < 1e-12) continue
      const w0 = ((bz - cz) * (lx - cx) + (cx - bx) * (lz - cz)) / det
      const w1 = ((cz - az) * (lx - cx) + (ax - cx) * (lz - cz)) / det
      const w2 = 1 - w0 - w1
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue
      out[0] = w0 * p[a + 1] + w1 * p[b + 1] + w2 * p[cc + 1]
      out[1] = w0 * dl[ix[t]] + w1 * dl[ix[t + 1]] + w2 * dl[ix[t + 2]]
      return true
    }
    return false
  }
}

const _o = [0, 0]
/** The LOD0 / collider ground at chunk-local (lx, lz): the road ribbon where it exists, else the (sunk) grid. */
export function groundOf(d: ChunkData, index: RibbonIndex | null, lx: number, lz: number): number {
  if (index && index.sample(Math.min(CHUNK_SIZE, Math.max(0, lx)), Math.min(CHUNK_SIZE, Math.max(0, lz)), _o)) return _o[0]
  return sampleHeight(d.heights0, lx, lz)
}
