import * as THREE from 'three'
import { CELL_SIZE, CHUNK_SIZE, CHUNK_VERTS } from '../constants'
import { hashFloat } from '../noise/rng'
import { sampleHeight } from '../Terrain/generateTerrain'
import { chunkKey } from '../types'
import type { WorldChunk } from '../WorldChunk'
import { WorldFields } from '../WorldFields'
import { createGrassGeometry } from './grass'
import { farmFieldAt } from '../POI/pois'

/**
 * Dense grass carpet AROUND THE PLAYER — cost ∝ radius², independent of loaded chunks. ONE draw call.
 *
 * A G×G window of 8 m tiles is mapped toroidally onto fixed slots of one InstancedMesh
 * (slot = (tx mod G, tz mod G)). When the player moves, tiles that enter the window are refilled
 * (nearest first, TILE_FILLS_PER_FRAME per frame) with partial buffer uploads; slots still holding a tile
 * that left the window sit outside the fade radius, so the shader has already shrunk them to nothing.
 *
 * Placement is deterministic (hash of world tile + index), heights come from loaded chunk data (exact
 * match with the rendered terrain), colour from the terrain vertex colour underneath + dry/yellow tufts.
 */
const TILE = 8
const TILE_FILLS_PER_FRAME = 4
const DRY_KEY = 0x6a55

export interface GrassSettings {
  /** Fade-out radius (m). */
  radius: number
  /** Individual blades per m² (per 1 m patch). */
  density: number
  /** Blade segments: 1 = 1 tri (LOW), 2 = 3 tris curved (MEDIUM/HIGH). */
  blades: number
}

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0)

export class GrassField {
  readonly root = new THREE.Group()
  private mesh: THREE.InstancedMesh | null = null
  private geometry: THREE.BufferGeometry | null = null
  private g = 0
  private perTile = 0
  private slotTx = new Int32Array(0)
  private slotTz = new Int32Array(0)
  private slotOk = new Uint8Array(0)
  private settings: GrassSettings | null = null
  private readonly order: { dx: number; dz: number; d: number }[] = []
  /** Stats. */
  instances = 0
  fillsLastFrame = 0

  constructor(
    private readonly material: THREE.Material,
    private readonly fields: WorldFields,
    private readonly chunks: Map<string, WorldChunk>,
  ) {
    this.root.name = 'grass-field'
  }

  configure(s: GrassSettings): void {
    const prev = this.settings
    this.settings = { ...s }
    const g = Math.ceil((s.radius * 2) / TILE) + 1
    const perTile = TILE * TILE // one 1 m² patch per cell
    if (prev && prev.blades === s.blades && prev.density === s.density && g === this.g) return
    this.dispose()
    this.g = g
    this.perTile = perTile
    this.geometry = createGrassGeometry(Math.round(s.density), s.blades)
    const count = g * g * perTile
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, count)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage)
    mesh.frustumCulled = false // surrounds the camera
    mesh.receiveShadow = true
    mesh.castShadow = false
    mesh.matrixAutoUpdate = false
    mesh.name = 'grass'
    ;(mesh.instanceMatrix.array as Float32Array).fill(0) // all degenerate until filled
    this.mesh = mesh
    this.root.add(mesh)
    this.slotTx = new Int32Array(g * g).fill(0x7fffffff)
    this.slotTz = new Int32Array(g * g).fill(0x7fffffff)
    this.slotOk = new Uint8Array(g * g)
    // Window offsets sorted nearest-first (fill priority).
    this.order.length = 0
    const half = Math.floor(g / 2)
    for (let dz = -half; dz < g - half; dz++) for (let dx = -half; dx < g - half; dx++) this.order.push({ dx, dz, d: dx * dx + dz * dz })
    this.order.sort((a, b) => a.d - b.d)
    this.instances = count
  }

  update(focus: THREE.Vector3): void {
    const mesh = this.mesh
    if (!mesh) return
    const ctx = Math.floor(focus.x / TILE)
    const ctz = Math.floor(focus.z / TILE)
    const g = this.g
    let fills = 0
    for (const o of this.order) {
      if (fills >= TILE_FILLS_PER_FRAME) break
      const tx = ctx + o.dx
      const tz = ctz + o.dz
      const slot = (((tx % g) + g) % g) + (((tz % g) + g) % g) * g
      if (this.slotTx[slot] === tx && this.slotTz[slot] === tz && this.slotOk[slot]) continue
      this.slotTx[slot] = tx
      this.slotTz[slot] = tz
      this.slotOk[slot] = this.fillTile(slot, tx, tz) ? 1 : 0
      fills++
    }
    this.fillsLastFrame = fills
  }

  /** Returns false if the terrain under the tile isn't loaded yet (retried next frames). */
  private fillTile(slot: number, tx: number, tz: number): boolean {
    const mesh = this.mesh!
    const mats = mesh.instanceMatrix.array as Float32Array
    const cols = mesh.instanceColor!.array as Float32Array
    const n = this.perTile
    const base = slot * n
    const x0 = tx * TILE
    const z0 = tz * TILE
    const cxc = Math.floor((x0 + TILE / 2) / CHUNK_SIZE)
    const czc = Math.floor((z0 + TILE / 2) / CHUNK_SIZE)
    let ok = this.chunks.has(chunkKey(cxc, czc))
    // Meadow factor once per tile (fbm is the expensive part): open ground & verges dense, deep forest sparse.
    const meadow = 0.45 + 0.55 * (1 - this.fields.forestDensity(x0 + TILE / 2, z0 + TILE / 2))
    const seed = this.fields.seed
    for (let i = 0; i < n; i++) {
      // Jittered 1 m grid: patches tile gap-free; random rotation hides the tiling.
      const wx = x0 + (i % TILE) + 0.5 + (hashFloat(seed, tx, tz, i * 4 + 1) - 0.5) * 0.3
      const wz = z0 + Math.floor(i / TILE) + 0.5 + (hashFloat(seed, tx, tz, i * 4 + 2) - 0.5) * 0.3
      const r = hashFloat(seed, tx, tz, i * 4 + 3)
      const chunk = this.chunks.get(chunkKey(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE)))
      const road = this.fields.roadDistance(wx, wz) - WorldFields.ROAD_HALF_WIDTH
      const verge = road < 9 ? 1 - road / 12 : 0
      if (!chunk) ok = false
      // Continuous meadow (no soil gaps); only dense forest floor thins it.
      if (!chunk || road < 0.3 || r > Math.max(meadow, verge)) {
        ZERO.toArray(mats, (base + i) * 16)
        continue
      }
      const d = chunk.data
      const lx = wx - d.cx * CHUNK_SIZE
      const lz = wz - d.cz * CHUNK_SIZE
      const gh = sampleHeight(d.heights, lx, lz)
      const ni = Math.min(CHUNK_VERTS - 1, Math.round(lz / CELL_SIZE)) * CHUNK_VERTS + Math.min(CHUNK_VERTS - 1, Math.round(lx / CELL_SIZE))
      const fp = this.fields.pois.near(wx, wz)
      if (gh < WorldFields.WATER + 0.5 || d.netEdge[ni] < -0.3 || (fp && farmFieldAt(fp, wx, wz))) {
        ZERO.toArray(mats, (base + i) * 16)
        continue
      }
      _p.set(wx, gh - 0.04, wz)
      _q.setFromAxisAngle(_up, r * 97.0)
      const sc = 0.9 + hashFloat(seed, tx, tz, i * 4) * 0.25 + verge * 0.3
      _s.set(1, sc, 1) // XZ stays 1 so patches keep tiling
      _m.compose(_p, _q, _s).toArray(mats, (base + i) * 16)
      const vi = Math.min(CHUNK_VERTS - 1, Math.round(lz / CELL_SIZE)) * CHUNK_VERTS + Math.min(CHUNK_VERTS - 1, Math.round(lx / CELL_SIZE))
      const o = (base + i) * 3
      // Base colour = the ground's own colour (blades melt into the terrain → a carpet, not tufts); only a
      // few dry clumps on sunny verges (refs), and a slight per-clump hue jitter.
      const dry = hashFloat(seed, tx, tz, i * 4 + DRY_KEY) < 0.03 + verge * 0.06
      const j = 0.92 + hashFloat(seed, tx, tz, i * 4 + DRY_KEY + 1) * 0.16
      const tr = d.colors[vi * 3], tg = d.colors[vi * 3 + 1], tb = d.colors[vi * 3 + 2]
      if (dry) {
        cols[o] = tr * 1.3; cols[o + 1] = tg * 1.15; cols[o + 2] = tb * 0.7
      } else {
        cols[o] = tr * 0.95 * j; cols[o + 1] = tg * 1.05 * j; cols[o + 2] = tb * 0.95 * j
      }
    }
    mesh.instanceMatrix.addUpdateRange(base * 16, n * 16)
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor!.addUpdateRange(base * 3, n * 3)
    mesh.instanceColor!.needsUpdate = true
    return ok
  }

  get triangles(): number {
    return this.mesh ? this.instances * (this.geometry!.getAttribute('position').count / 3) : 0
  }

  dispose(): void {
    if (this.mesh) {
      this.root.remove(this.mesh)
      this.mesh.dispose()
      this.mesh = null
    }
    this.geometry?.dispose()
    this.geometry = null
  }
}
