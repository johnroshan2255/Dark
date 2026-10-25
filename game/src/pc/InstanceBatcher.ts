import * as pc from 'playcanvas'
import { instanceFormat } from './geometry'
import { LayerSet } from './layerSet'

/** One chunk's share of an instanced draw: its instances (20 floats each: matrix + colour/snow) for one mesh + material. */
export interface InstEntry {
  mesh: pc.Mesh
  material: pc.Material
  data: Float32Array
  count: number
  castShadow: boolean
  /** additive glow (lamps): never a shadow caster */
  glow?: boolean
}

interface Chunk {
  entries: InstEntry[]
  box: pc.BoundingBox
}

interface Batch {
  mesh: pc.Mesh
  material: pc.Material
  castShadow: boolean
  mi: pc.MeshInstance | null
  /** its depth pre-pass twin (same mesh, same instance buffer) */
  twin: pc.MeshInstance | null
  vb: pc.VertexBuffer | null
  capacity: number
}

/** A material drawn over a depth pre-pass: the entries' material → the lit pass's and the depth pass's, its layer. */
export interface Prepass {
  from: pc.Material
  main: pc.Material
  depth: pc.Material
  layer: pc.Layer
}

const FLOATS = 20

/**
 * WORLD INSTANCE BATCHER: every chunk's trees, rocks, plants and props of the same mesh + material drawn as ONE
 * instanced draw for the whole streamed world (a chunk each was ~10 draws × 49 chunks, ×3 with the shadow cascades;
 * now one per mesh kind). The CPU packs the instances of the chunks that matter into one buffer — re-packed only when
 * the chunk set / LODs change or the view moved enough (≥ 6 m or ~8°), not per frame:
 *  - chunks in the camera's view (their boxes against the frustum, widened a little), and
 *  - chunks within the sun's shadow range of the camera (they cast into the view even when off screen).
 * Cost of a re-pack: a copy of the visible instances (~tens of KB) + one buffer upload.
 */
export class InstanceBatcher {
  private readonly shown: LayerSet
  private readonly node: pc.GraphNode
  private readonly chunks = new Map<string, Chunk>()
  private readonly batches = new Map<string, Batch>()
  private dirty = true
  private readonly lastPos = new pc.Vec3(1e9, 0, 0)
  private readonly lastFwd = new pc.Vec3()
  private readonly frustum = new pc.Frustum()
  private readonly vp = new pc.Mat4()
  private readonly ids = new WeakMap<object, number>()
  private nextId = 1
  /** Chunks within this distance (m, centre) always draw: their shadows reach the view. */
  shadowRange = 110
  /** packed instances in the current buffers (stats) */
  instances = 0

  private readonly shownDepth: LayerSet | null

  constructor(private readonly app: pc.AppBase, private readonly prepass: Prepass | null = null) {
    this.shown = new LayerSet(app)
    this.shownDepth = prepass ? new LayerSet(app, prepass.layer) : null
    this.node = new pc.GraphNode('worldInstances')
  }

  private id(o: object): number {
    let i = this.ids.get(o)
    if (!i) this.ids.set(o, (i = this.nextId++))
    return i
  }

  /** The chunk's current instanced entries (its LOD's), or null to remove it. */
  setChunk(key: string, entries: InstEntry[] | null, box: pc.BoundingBox): void {
    if (!entries || !entries.length) {
      if (this.chunks.delete(key)) this.dirty = true
      return
    }
    this.chunks.set(key, { entries, box })
    this.dirty = true
  }

  update(cam: pc.CameraComponent): void {
    const pos = cam.entity.getPosition(), fwd = cam.entity.forward
    if (!this.dirty && pos.distance(this.lastPos) < 6 && fwd.dot(this.lastFwd) > 0.99) return
    this.dirty = false
    this.lastPos.copy(pos)
    this.lastFwd.copy(fwd)
    this.vp.mul2(cam.projectionMatrix, cam.viewMatrix)
    this.frustum.setFromMat4(this.vp)
    // which chunks draw, and how many instances each batch gets
    const counts = new Map<string, number>()
    const live: Chunk[] = []
    const sphere = new pc.BoundingSphere()
    for (const c of this.chunks.values()) {
      const ctr = c.box.center
      const near = Math.hypot(ctr.x - pos.x, ctr.z - pos.z) < this.shadowRange
      sphere.center.copy(ctr)
      sphere.radius = c.box.halfExtents.length() + 8
      if (!near && !this.frustum.containsSphere(sphere)) continue
      live.push(c)
      for (const e of c.entries) {
        const k = `${this.id(e.mesh)}|${this.id(e.material)}`
        counts.set(k, (counts.get(k) ?? 0) + e.count)
        if (!this.batches.has(k)) this.batches.set(k, { mesh: e.mesh, material: e.material, castShadow: e.castShadow, mi: null, twin: null, vb: null, capacity: 0 })
      }
    }
    // (re)size each batch's buffer, then pack
    const offs = new Map<string, number>()
    const views = new Map<string, Float32Array>()
    const dev = this.app.graphicsDevice
    for (const [k, b] of this.batches) {
      const n = counts.get(k) ?? 0
      if (n > b.capacity) {
        b.vb?.destroy()
        b.capacity = Math.ceil(n * 1.5) + 16
        b.vb = new pc.VertexBuffer(dev, instanceFormat(dev), b.capacity, { usage: pc.BUFFER_DYNAMIC })
        if (b.mi) b.mi.setInstancing(b.vb)
        if (b.twin) b.twin.setInstancing(b.vb)
      }
      if (n && b.vb) views.set(k, new Float32Array(b.vb.lock() as ArrayBuffer))
      offs.set(k, 0)
    }
    for (const c of live) {
      for (const e of c.entries) {
        const k = `${this.id(e.mesh)}|${this.id(e.material)}`
        const v = views.get(k)!
        const o = offs.get(k)!
        v.set(e.data.subarray(0, e.count * FLOATS), o * FLOATS)
        offs.set(k, o + e.count)
      }
    }
    // the world's box for the engine's own (coarse) culling of every batch
    const lo = new pc.Vec3(1e9, 1e9, 1e9), hi = new pc.Vec3(-1e9, -1e9, -1e9)
    for (const c of live) {
      const a = c.box.getMin(), z = c.box.getMax()
      lo.set(Math.min(lo.x, a.x), Math.min(lo.y, a.y), Math.min(lo.z, a.z))
      hi.set(Math.max(hi.x, z.x), Math.max(hi.y, z.y), Math.max(hi.z, z.z))
    }
    const box = new pc.BoundingBox()
    box.setMinMax(lo, hi)
    const list: pc.MeshInstance[] = []
    const depth: pc.MeshInstance[] = []
    let total = 0
    const pp = this.prepass
    for (const [k, b] of this.batches) {
      const n = counts.get(k) ?? 0
      if (b.vb && views.has(k)) b.vb.unlock()
      if (!n) continue
      const pre = pp && b.material === pp.from
      if (!b.mi) {
        b.mi = new pc.MeshInstance(b.mesh, pre ? pp.main : b.material, this.node) // (instances carry world matrices: an identity node)
        b.mi.setInstancing(b.vb!)
      }
      b.mi.instancingCount = n
      b.mi.castShadow = b.castShadow
      b.mi.receiveShadow = true
      b.mi.setCustomAabb(box)
      list.push(b.mi)
      if (pre) {
        if (!b.twin) {
          b.twin = new pc.MeshInstance(b.mesh, pp.depth, this.node)
          b.twin.setInstancing(b.vb!)
          b.twin.castShadow = false
        }
        b.twin.instancingCount = n
        b.twin.setCustomAabb(box)
        depth.push(b.twin)
      }
      total += n
    }
    this.instances = total
    this.shown.set(list)
    this.shownDepth?.set(depth)
  }
}
