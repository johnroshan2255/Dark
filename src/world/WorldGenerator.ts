import { scatterForest } from './Forest/scatter'
import { caveAir, caveLight, cavePlan, caveWallTone, STONE_BED } from './Formations/caves'
import { stoneBed } from './Formations/stone'
import { scatterRoadProps } from './Road/roadProps'
import { layoutPois } from './POI/poiLayout'
import { CELL_SIZE, CHUNK_SIZE, CHUNK_VERTS } from './constants'
import { generateTerrain } from './Terrain/generateTerrain'
import { FM_TOP, type ChunkData } from './types'
import { WorldFields } from './WorldFields'
import { buildFormation, FORMATION_BED } from './Formations/formations'
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
   * Formations centred in this chunk, meshed (surface nets: 1 m voxels, 1.25 m for hillside caves — the layered stone's
   * ledges need ≥ 2 voxels) and coloured: up-facing faces carry the
   * ground cover (grass / sand / snow), the rest is rock (warm grey-tan; sandstone in the desert; blue-grey in the
   * snow) with horizontal bands. Then the chunk's CRAGS (Formations/crags.ts: faceted rock columns cladding the steep
   * slopes) in the same mesh — one draw and one trimesh collider for all the chunk's rock. Chunk-local coordinates.
   */
  private formations(cx: number, cz: number, heights: Float32Array) {
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE
    const list = this.fields.formations.centredIn(x0, z0, x0 + CHUNK_SIZE, z0 + CHUNK_SIZE)
    const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = []
    const roofed: number[] = [] // vertex indices inside a cave (no grass on their faces: rockTops)
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    const bw: [number, number] = [0, 0]
    for (const f of list) {
      const m = buildFormation(f, f.hill ? 1.25 : 1.0, (x, z) => this.fields.heightNoCave(x, z))
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
        // Formation-local position (the stone's beds are laid in it: stoneBed = the tone of this vertex's layer).
        const wx = m.positions[i] - f.x, wz = m.positions[i + 2] - f.z
        const lx = wx * fc + wz * fs, lz = -wx * fs + wz * fc, ly = m.positions[i + 1] - f.y
        const bed = plan ? stoneBed(f.seed + 5, lx, ly, lz, STONE_BED) : stoneBed(f.seed, lx, ly, lz, FORMATION_BED)
        const band = 0.65 * bed + 0.35 * (Math.sin(y * 0.9 + Math.sin(x * 0.07 + z * 0.05) * 2) * 0.5 + 0.5)
        // Baked AO (surface nets): dark crevices between the blocks and under the ledges.
        const ao = 0.38 + 0.62 * m.ao[i / 3]
        // Rock (linear RGB): warm tan-grey (Genshin's cliff stone, lit ≈ sRGB 145–155, 132–138, 112–120) / sandstone /
        // blue-grey, each bed its own tone.
        let r = 0.25 + 0.13 * band, g = 0.205 + 0.1 * band, bl = 0.14 + 0.07 * band
        if (sand > 0.5) (r = 0.42 + 0.2 * band), (g = 0.2 + 0.1 * band), (bl = 0.09 + 0.05 * band)
        else if (snow > 0.5) (r = 0.2 + 0.1 * band), (g = 0.22 + 0.1 * band), (bl = 0.26 + 0.1 * band)
        // Ground cover on top faces (and the pillars' grassy crowns).
        const up = m.normals[i + 1]
        const cover = Math.min(1, Math.max(0, (up - 0.55) / 0.3))
        const cr = sand > 0.5 ? 0.85 : snow > 0.5 ? 0.9 : 0.16, cg = sand > 0.5 ? 0.55 : snow > 0.5 ? 0.93 : 0.36, cb = sand > 0.5 ? 0.25 : snow > 0.5 ? 0.98 : 0.07
        if (plan) {
          // CAVE LIGHT baked into the rock (no runtime cost): interior surfaces (on the cave's air) darken with the
          // walk in from the mouth, pools of daylight under the skylights, cyan / violet light around the crystals; moss and
          // grass only where light reaches; the floor is damp dark earth.
          const inside = 1 - Math.min(1, Math.max(0, (caveAir(plan, f.seed, lx, ly, lz, 0) - 1.2) / 2.5))
          if (inside > 0.01) {
            if (inside > 0.5) roofed.push(pos.length / 3 - 1)
            caveLight(plan, lx, ly, lz, _cl)
            const L = _cl[0], k = 0.28 + 0.72 * Math.pow(L, 0.85), aoC = 0.24 + 0.76 * m.ao[i / 3] // deeper seams inside
            const moss = cover * Math.min(1, Math.max(0, (L - 0.55) / 0.35)) // only in real daylight (mouth, under skylights)
            // Cool blue-grey cave stone (Genshin's caves: slate walls, a darker worn-stone floor, teal in the shadows).
            // Each PLATE block its own shade (caveWallTone), its EDGES catching a cool light and the seams between
            // the plates dark (AO), the tops of the ledges lit from above and their undersides in shadow — the
            // painted, chiselled rock of the Chasm's walls rather than one smooth tone.
            // A KEY direction per cave (high, from one side — as if from the skylight): faces turned toward it are lit,
            // faces turned away fall into shade, so plates of the same height but facing different ways differ.
            const tone = 0.7 * caveWallTone(f.seed, lx, ly, lz) + 0.3 * band
            const ka = (f.seed % 628) / 100, ed = m.edge[i / 3]
            const nk = (m.normals[i] * Math.cos(ka) * 0.62 + m.normals[i + 1] * 0.78 + m.normals[i + 2] * Math.sin(ka) * 0.62)
            const lit = (0.5 + 0.62 * Math.max(0, nk) + 0.1 * Math.min(0, nk)) * (0.7 + 0.6 * tone) * (1 + 1.1 * ed)
            let cr2 = 0.2 * lit + 0.03 * ed, cg2 = 0.235 * lit + 0.05 * ed, cb2 = 0.28 * lit + 0.07 * ed
            cr2 += (0.12 - cr2) * cover * (1 - moss); cg2 += (0.135 - cg2) * cover * (1 - moss); cb2 += (0.15 - cb2) * cover * (1 - moss)
            cr2 += (0.14 - cr2) * moss; cg2 += (0.3 - cg2) * moss; cb2 += (0.08 - cb2) * moss
            // Crystal light pools on the rock (cyan / violet), not darkened by the AO as much as the stone: they light it.
            const gc = _cl[1] * inside, gv = _cl[2] * inside, ga = 0.6 + 0.4 * ao
            const cR = cr2 * k, cG = cg2 * k, cB = cb2 * k
            const o = r + (cr - r) * cover, og = g + (cg - g) * cover, ob = bl + (cb - bl) * cover
            const a2 = ao + (aoC - ao) * inside
            col.push((o + (cR - o) * inside) * a2 + (0.03 * gc + 0.13 * gv) * ga, (og + (cG - og) * inside) * a2 + (0.2 * gc + 0.04 * gv) * ga, (ob + (cB - ob) * inside) * a2 + (0.26 * gc + 0.2 * gv) * ga)
            continue
          }
        }
        col.push((r + (cr - r) * cover) * ao, (g + (cg - g) * cover) * ao, (bl + (cb - bl) * cover) * ao)
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
      fmTop: idx.length ? rockTops(pos, idx, roofed) : new Float32Array(0),
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
function rockTops(pos: number[], idx: number[], roofed: number[]): Float32Array {
  const { origin, cell, res } = FM_TOP
  const top = new Float32Array(res * res).fill(-1e9)
  const dark = new Uint8Array(pos.length / 3)
  for (const v of roofed) dark[v] = 1
  for (let t = 0; t < idx.length; t += 3) {
    if (dark[idx[t]] || dark[idx[t + 1]] || dark[idx[t + 2]]) continue // cave floors: no grass under the roof
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

const _cl: [number, number, number] = [0, 0, 0]

/** Buffers to transfer (zero-copy) when posting ChunkData from a worker. */
export function chunkTransferables(d: ChunkData): ArrayBuffer[] {
  return [d.heights, d.normals, d.colors, d.roadLat, d.netEdge, d.netType, d.biome, d.trees, d.rocks, d.plants, d.props, d.fmPos, d.fmNor, d.fmCol, d.fmIdx, d.fmBounds, d.fmTop].map((a) => a.buffer as ArrayBuffer)
}
