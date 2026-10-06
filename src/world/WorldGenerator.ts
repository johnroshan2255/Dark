import { scatterForest } from './Forest/scatter'
import { caveAir, caveLight, cavePlan } from './Formations/caves'
import { scatterRoadProps } from './Road/roadProps'
import { layoutPois } from './POI/poiLayout'
import { CELL_SIZE, CHUNK_SIZE, CHUNK_VERTS } from './constants'
import { generateTerrain } from './Terrain/generateTerrain'
import { FM_TOP, type ChunkData } from './types'
import { WorldFields } from './WorldFields'
import { buildFormation } from './Formations/formations'
import { buildCrags } from './Formations/crags'

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
   * snow) with horizontal bands. Then the chunk's CRAGS (Formations/crags.ts: faceted rock columns cladding the steep
   * slopes) in the same mesh — one draw and one trimesh collider for all the chunk's rock. Chunk-local coordinates.
   */
  private formations(cx: number, cz: number, heights: Float32Array) {
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE
    const list = this.fields.formations.centredIn(x0, z0, x0 + CHUNK_SIZE, z0 + CHUNK_SIZE)
    const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = []
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    const bw: [number, number] = [0, 0]
    for (const f of list) {
      const m = buildFormation(f, f.hill ? 1.25 : 1.5, (x, z) => this.fields.heightNoCave(x, z))
      const w = this.fields.biome(f.x, f.z, bw)
      const sand = w[0], snow = w[1]
      const base = pos.length / 3
      const plan = f.hill ? cavePlan(f) : null
      const fc = Math.cos(f.rot), fs = Math.sin(f.rot)
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
        if (plan) {
          // CAVE LIGHT baked into the rock (no runtime cost): interior surfaces (on the cave's air) darken with the
          // walk in from the mouth, pools of daylight under the skylights, a cyan glow around the crystals; moss and
          // grass only where light reaches; the floor is damp dark earth.
          const wx = m.positions[i] - f.x, wz = m.positions[i + 2] - f.z
          const lx = wx * fc + wz * fs, lz = -wx * fs + wz * fc, ly = m.positions[i + 1] - f.y
          const inside = 1 - Math.min(1, Math.max(0, (caveAir(plan, f.seed, lx, ly, lz, 0) - 1.2) / 2.5))
          if (inside > 0.01) {
            caveLight(plan, lx, ly, lz, _cl)
            const L = _cl[0], k = 0.09 + 0.91 * Math.pow(L, 0.85)
            const moss = cover * Math.min(1, Math.max(0, (L - 0.4) / 0.45)) // only in real daylight (mouth, under skylights)
            // Cool blue-grey cave stone; damp earth underfoot.
            let cr2 = 0.2 + 0.06 * band, cg2 = 0.21 + 0.05 * band, cb2 = 0.24 + 0.04 * band
            cr2 += (0.16 - cr2) * cover * (1 - moss); cg2 += (0.13 - cg2) * cover * (1 - moss); cb2 += (0.1 - cb2) * cover * (1 - moss)
            cr2 += (0.14 - cr2) * moss; cg2 += (0.3 - cg2) * moss; cb2 += (0.08 - cb2) * moss
            const glow = _cl[1]
            const cR = cr2 * k + 0.02 * glow, cG = cg2 * k + 0.12 * glow, cB = cb2 * k + 0.16 * glow
            const o = r + (cr - r) * cover, og = g + (cg - g) * cover, ob = bl + (cb - bl) * cover
            col.push(o + (cR - o) * inside, og + (cG - og) * inside, ob + (cB - ob) * inside)
            continue
          }
        }
        col.push(r + (cr - r) * cover, g + (cg - g) * cover, bl + (cb - bl) * cover)
      }
      for (let i = 0; i < m.indices.length; i++) idx.push(m.indices[i] + base)
    }
    const crag = { pos: [] as number[], nor: [] as number[], col: [] as number[] }
    buildCrags(this.fields, cx, cz, heights, crag)
    for (let i = 0; i < crag.pos.length; i += 3) {
      const x = crag.pos[i], y = crag.pos[i + 1], z = crag.pos[i + 2]
      idx.push(pos.length / 3)
      pos.push(x, y, z)
      b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.min(b[2], z)
      b[3] = Math.max(b[3], x); b[4] = Math.max(b[4], y); b[5] = Math.max(b[5], z)
    }
    for (const v of crag.nor) nor.push(v)
    for (const v of crag.col) col.push(v)
    return {
      fmPos: new Float32Array(pos), fmNor: new Float32Array(nor), fmCol: new Float32Array(col), fmIdx: new Uint32Array(idx),
      fmBounds: new Float32Array(idx.length ? b : []),
      fmTop: idx.length ? rockTops(pos, idx) : new Float32Array(0),
    }
  }

  /**
   * Just the chunk's TREE records (far forest, beyond the streamed chunks): the same heights (fields.height on the
   * chunk grid, = generateTerrain's) and the same scatter, so a far impostor stands exactly where the chunk's
   * tree will when the chunk streams in. ~1–3 ms in a worker (no colours, normals, rocks, plants, props).
   */
  generateTrees(cx: number, cz: number): Float32Array {
    const heights = new Float32Array(CHUNK_VERTS * CHUNK_VERTS)
    const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE
    for (let iz = 0; iz < CHUNK_VERTS; iz++) {
      for (let ix = 0; ix < CHUNK_VERTS; ix++) heights[iz * CHUNK_VERTS + ix] = this.fields.height(ox + ix * CELL_SIZE, oz + iz * CELL_SIZE)
    }
    return scatterForest(this.fields, cx, cz, heights, true).trees
  }

  generateChunk(cx: number, cz: number): ChunkData {
    const t0 = performance.now()
    const terrain = generateTerrain(this.fields, cx, cz)
    const forest = scatterForest(this.fields, cx, cz, terrain.heights)
    const fm = this.formations(cx, cz, terrain.heights)
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

/** Rock-top grid (ChunkData.fmTop): rasterise the up-facing triangles (face normal y > 0.8) of the chunk's rock mesh
 *  into a 2 m grid over chunk-local [−32, 96)², keeping the highest surface per cell. ~0.1–0.5 ms on a rocky chunk. */
function rockTops(pos: number[], idx: number[]): Float32Array {
  const { origin, cell, res } = FM_TOP
  const top = new Float32Array(res * res).fill(-1e9)
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2], bx = pos[b], by = pos[b + 1], bz = pos[b + 2], cx = pos[c], cy = pos[c + 1], cz = pos[c + 2]
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const nl = Math.hypot(nx, ny, nz)
    if (nl < 1e-9 || Math.abs(ny) / nl < 0.8) continue // only (near-)flat faces, either winding
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - origin) / cell)), i1 = Math.min(res - 1, Math.floor((Math.max(ax, bx, cx) - origin) / cell))
    const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - origin) / cell)), j1 = Math.min(res - 1, Math.floor((Math.max(az, bz, cz) - origin) / cell))
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
    if (Math.abs(det) < 1e-9) continue
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = origin + (i + 0.5) * cell, pz = origin + (j + 0.5) * cell
      const w0 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / det
      const w1 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / det
      const w2 = 1 - w0 - w1
      if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue
      const y = w0 * ay + w1 * by + w2 * cy
      const k = j * res + i
      if (y > top[k]) top[k] = y
    }
  }
  return top
}

const _cl: [number, number] = [0, 0]

/** Buffers to transfer (zero-copy) when posting ChunkData from a worker. */
export function chunkTransferables(d: ChunkData): ArrayBuffer[] {
  return [d.heights, d.normals, d.colors, d.roadLat, d.netEdge, d.netType, d.biome, d.trees, d.rocks, d.plants, d.props, d.fmPos, d.fmNor, d.fmCol, d.fmIdx, d.fmBounds, d.fmTop].map((a) => a.buffer as ArrayBuffer)
}
