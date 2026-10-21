import * as THREE from 'three'

/**
 * ALL CHUNK TERRAIN IN ONE DRAW: a BatchedMesh (WEBGL_multi_draw — one call; where the extension is missing three
 * loops the draws itself, so nothing is worse than before). Each streamed chunk owns a SLOT: one geometry range
 * reserved at the size of a full-detail (LOD0) chunk and one instance placed at the chunk's origin. A LOD switch
 * copies the new grid into the slot (`setGeometryAt`), an unloaded chunk's slot is hidden and reused — the batch never
 * fragments. BatchedMesh culls per instance against the camera (and the light, in the shadow pass) and sorts the
 * opaque draws front to back (early-z), which the per-chunk meshes got from three's own culling.
 *
 * The chunk keeps building and switching its terrain meshes exactly as before; they just leave the scene (`sync`
 * mirrors the visible one into the slot). Cost: ~28 draws → 1 on ULTRA; GPU memory = slots × LOD0 size (~120 slots ×
 * ~1.3 k vertices × 60 B ≈ 9 MB); a LOD switch re-uploads one chunk's grid.
 */
export interface TerrainSource {
  readonly key: string
  /** The chunk's terrain mesh being shown now (null: none). */
  terrainMesh(): THREE.Mesh | null
  /** Chunk drawn at all (frustum / distance; the near rings always). */
  isVisible: boolean
  readonly originX: number
  readonly originZ: number
}

interface Slot {
  geom: number
  inst: number
  shown: THREE.BufferGeometry | null
}

const _m = new THREE.Matrix4()

export class TerrainBatch {
  mesh: THREE.BatchedMesh | null = null
  private readonly slots = new Map<string, Slot>()
  private readonly spare: Slot[] = []
  private cap = 0
  /** Chunks whose terrain wouldn't fit a slot (drawn by their own mesh, as before). */
  private readonly loose = new Set<string>()

  constructor(
    private readonly root: THREE.Object3D,
    private readonly material: THREE.Material,
    private readonly layersMask: number,
    /** Slot size: a full-detail (LOD0) chunk grid's vertex / index counts. */
    private readonly reserveV: number,
    private readonly reserveI: number,
  ) {}

  /** Mirror every chunk's shown terrain into its slot (per frame, after culling). */
  sync(chunks: Iterable<TerrainSource>): void {
    for (const c of chunks) {
      const src = c.terrainMesh()
      if (!src) continue
      if (this.loose.has(c.key)) continue
      const g = src.geometry
      let slot = this.slots.get(c.key)
      if (!slot) {
        const s = this.alloc(g)
        if (!s) {
          this.loose.add(c.key)
          continue
        }
        slot = s
        this.slots.set(c.key, slot)
        this.mesh!.setMatrixAt(slot.inst, _m.makeTranslation(c.originX, 0, c.originZ))
      }
      if (slot.shown !== g) {
        if (g.getAttribute('position').count > this.reserveV || (g.index?.count ?? 0) > this.reserveI) {
          // (bigger than a slot: leave this chunk to its own mesh)
          this.free(c.key)
          this.loose.add(c.key)
          continue
        }
        this.mesh!.setGeometryAt(slot.geom, g)
        slot.shown = g
      }
      // the chunk's own meshes leave the scene (built lazily per LOD: detach whichever is current)
      if (src.parent) src.removeFromParent()
      this.mesh!.setVisibleAt(slot.inst, c.isVisible)
    }
  }

  /** The chunk is unloaded: its slot goes back to the pool. */
  free(key: string): void {
    this.loose.delete(key)
    const s = this.slots.get(key)
    if (!s || !this.mesh) return
    this.mesh.setVisibleAt(s.inst, false)
    s.shown = null
    this.slots.delete(key)
    this.spare.push(s)
  }

  private alloc(g: THREE.BufferGeometry): Slot | null {
    const spare = this.spare.pop()
    if (spare) return spare
    if (!this.mesh) {
      this.cap = 64
      const m = new THREE.BatchedMesh(this.cap, this.cap * this.reserveV, this.cap * this.reserveI, this.material)
      m.name = 'terrain'
      m.receiveShadow = true
      m.castShadow = true
      m.layers.mask = this.layersMask
      m.perObjectFrustumCulled = true
      m.sortObjects = true
      m.frustumCulled = false
      this.root.add(m)
      this.mesh = m
    }
    const m = this.mesh
    if (g.getAttribute('position').count > this.reserveV || (g.index?.count ?? 0) > this.reserveI) return null
    if (m.instanceCount >= this.cap) {
      this.cap *= 2
      m.setInstanceCount(this.cap)
      m.setGeometrySize(this.cap * this.reserveV, this.cap * this.reserveI)
    }
    const geom = m.addGeometry(g, this.reserveV, this.reserveI)
    const inst = m.addInstance(geom)
    return { geom, inst, shown: g }
  }

  dispose(): void {
    this.mesh?.dispose()
    this.mesh?.removeFromParent()
    this.mesh = null
  }
}
