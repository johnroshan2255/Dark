import * as THREE from 'three'

/**
 * CROSS-CHUNK MESH BATCHING for the chunks' one-off meshes — rock formations and crags, the road ribbon, place
 * buildings: one BatchedMesh (WEBGL_multi_draw — a single call) per material / shadow / layer combination instead of
 * a draw per chunk (the endless world's formations alone were 28 draws on ULTRA).
 *
 * Like InstanceBatcher, the chunk's meshes stay the source of truth (WorldChunk keeps toggling `visible`,
 * `castShadow`, layers) and leave the scene; `sync()` mirrors them each frame. Each source gets a geometry SLOT in its
 * batch: a slot freed by an unloaded chunk is reused by the next geometry that fits (BatchedMesh itself never reuses
 * space), else the batch appends and grows. BatchedMesh culls per source (camera and shadow camera) and sorts the
 * opaque draws front to back.
 */
interface Slot {
  geom: number
  inst: number
  v: number
  i: number
}

interface Source {
  mesh: THREE.Mesh
  matrix: THREE.Matrix4
  chunkVisible: () => boolean
  batch: Batch | null
  slot: Slot | null
  key: string
  keyIn: number[]
}

const ids = new WeakMap<object, number>()
let nextId = 1
const idOf = (o: object) => {
  let i = ids.get(o)
  if (i === undefined) ids.set(o, (i = nextId++))
  return i
}

/** Attribute layout: batches only take geometries with exactly these attributes. */
function layoutOf(g: THREE.BufferGeometry): string {
  return Object.entries(g.attributes).map(([n, a]) => `${n}${(a as THREE.BufferAttribute).itemSize}`).sort().join(',') + (g.index ? '|i' : '')
}

class Batch {
  readonly mesh: THREE.BatchedMesh
  private readonly free: Slot[] = []
  private maxV: number
  private maxI: number
  private usedV = 0
  private usedI = 0
  readonly sources = new Set<Source>()

  constructor(readonly key: string, proto: THREE.Mesh, v: number, i: number) {
    this.maxV = Math.max(16384, v * 8)
    this.maxI = Math.max(65536, i * 8)
    const m = new THREE.BatchedMesh(64, this.maxV, this.maxI, proto.material as THREE.Material)
    m.name = proto.name || 'batch'
    m.castShadow = proto.castShadow
    m.receiveShadow = proto.receiveShadow
    m.layers.mask = proto.layers.mask
    m.renderOrder = proto.renderOrder
    m.perObjectFrustumCulled = true
    m.sortObjects = true
    m.frustumCulled = false
    this.mesh = m
  }

  add(s: Source): void {
    const g = s.mesh.geometry
    const v = g.getAttribute('position').count, i = g.index?.count ?? 0
    const m = this.mesh
    // a freed slot that fits (smallest first)
    let best = -1
    for (let k = 0; k < this.free.length; k++) if (this.free[k].v >= v && this.free[k].i >= i && (best < 0 || this.free[k].v < this.free[best].v)) best = k
    if (best >= 0) {
      const slot = this.free.splice(best, 1)[0]
      m.setGeometryAt(slot.geom, g)
      m.setMatrixAt(slot.inst, s.matrix)
      m.setVisibleAt(slot.inst, true)
      s.slot = slot
      return
    }
    if (this.usedV + v > this.maxV || this.usedI + i > this.maxI) {
      this.maxV = Math.max(this.maxV * 2, this.usedV + v)
      this.maxI = Math.max(this.maxI * 2, this.usedI + i)
      m.setGeometrySize(this.maxV, this.maxI)
    }
    if (m.instanceCount >= m.maxInstanceCount) m.setInstanceCount(m.maxInstanceCount * 2)
    const geom = m.addGeometry(g)
    const inst = m.addInstance(geom)
    m.setMatrixAt(inst, s.matrix)
    this.usedV += v
    this.usedI += i
    s.slot = { geom, inst, v, i }
  }

  remove(s: Source): void {
    if (!s.slot) return
    this.mesh.setVisibleAt(s.slot.inst, false)
    this.free.push(s.slot)
    s.slot = null
  }

  dispose(): void {
    this.mesh.dispose()
  }
}

export class MeshBatcher {
  readonly root = new THREE.Group()
  private readonly sources = new Map<THREE.Mesh, Source>()
  private readonly batches = new Map<string, Batch>()
  private readonly byOwner = new Map<object, Source[]>()

  constructor() {
    this.root.name = 'mesh-batches'
    this.root.matrixAutoUpdate = false
  }

  /** Take over a chunk's static mesh (`matrix` = its world placement). */
  adopt(owner: object, mesh: THREE.Mesh, matrix: THREE.Matrix4, chunkVisible: () => boolean): void {
    mesh.removeFromParent()
    const s: Source = { mesh, matrix: matrix.clone(), chunkVisible, batch: null, slot: null, key: '', keyIn: [] }
    this.sources.set(mesh, s)
    let list = this.byOwner.get(owner)
    if (!list) this.byOwner.set(owner, (list = []))
    list.push(s)
  }

  release(owner: object): void {
    for (const s of this.byOwner.get(owner) ?? []) {
      s.batch?.remove(s)
      s.batch?.sources.delete(s)
      this.sources.delete(s.mesh)
    }
    this.byOwner.delete(owner)
  }

  sync(): void {
    for (const s of this.sources.values()) {
      const m = s.mesh
      const show = m.visible && s.chunkVisible()
      if (!show) {
        if (s.slot) s.batch!.remove(s)
        continue
      }
      const k0 = idOf(m.material as THREE.Material), k1 = (m.castShadow ? 1 : 0) | (m.receiveShadow ? 2 : 0), k2 = m.layers.mask, k3 = m.renderOrder
      const ki = s.keyIn
      if (ki[0] !== k0 || ki[1] !== k1 || ki[2] !== k2 || ki[3] !== k3) {
        ki[0] = k0
        ki[1] = k1
        ki[2] = k2
        ki[3] = k3
        s.key = `${ki.join(',')}|${layoutOf(m.geometry)}`
      }
      if (!s.batch || s.batch.key !== s.key) {
        if (s.slot) s.batch!.remove(s)
        s.batch?.sources.delete(s)
        let b = this.batches.get(s.key)
        if (!b) {
          const g = m.geometry
          b = new Batch(s.key, m, g.getAttribute('position').count, g.index?.count ?? 0)
          this.batches.set(s.key, b)
          this.root.add(b.mesh)
        }
        b.sources.add(s)
        s.batch = b
      }
      if (!s.slot) s.batch.add(s)
    }
  }

  get count(): number {
    return this.batches.size
  }

  dispose(): void {
    for (const b of this.batches.values()) b.dispose()
    this.batches.clear()
    this.sources.clear()
    this.byOwner.clear()
  }
}
