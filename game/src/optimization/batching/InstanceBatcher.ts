import * as THREE from 'three'

/**
 * CROSS-CHUNK INSTANCE BATCHING. Every streamed chunk used to draw its own InstancedMesh per tree species, rock set,
 * fern / bush / shrub kind, pole and fence — ~50 draws on ULTRA, a draw per kind per chunk. The batcher takes those
 * meshes OUT of the scene (`adopt`) and draws each kind with ONE InstancedMesh for all chunks:
 *
 *  * a chunk's mesh stays the source of truth — WorldChunk keeps setting its `visible`, `count`, matrices, colours,
 *    `castShadow` and layers exactly as before (LOD switches, near-tree compaction, broken props); `sync()` polls
 *    them each frame (flags + buffer versions: ~1 µs per mesh) and mirrors the changes;
 *  * meshes that draw alike — same geometry buffers, material, shadow flags, layers and instanced attributes — share a
 *    batch; the chunk's offset is baked into each instance's translation (chunk meshes are chunk-local);
 *  * each source owns a range of its batch (first-fit allocator): showing / changing a source uploads only its range,
 *    hiding zeroes it (a zero matrix collapses the instance: no fragments) and frees it; holes past a quarter of the
 *    batch → compaction. Chunk frustum culling (WorldChunk.isVisible) still decides what is in the batches.
 * Shaders and materials are untouched (same programs, same look) — only the number of draws changes.
 */

interface Source {
  mesh: THREE.InstancedMesh
  ox: number
  oz: number
  /** 0 hidden, 1 in view, 2 out of view but kept for its sun shadow (the near rings). */
  chunkVisible: () => number
  batch: Batch | null
  start: number
  /** Written count and attribute versions (to notice changes). */
  count: number
  versions: number[]
  /** The mesh's instanced attributes (cached), the fixed part of its batch key, the last full key and its inputs. */
  attrs: [string, THREE.InstancedBufferAttribute][]
  fixedKey: string
  key: string
  keyIn: number[]
}

const ids = new WeakMap<object, number>()
let nextId = 1
const idOf = (o: object | null | undefined) => {
  if (!o) return 0
  let i = ids.get(o)
  if (i === undefined) ids.set(o, (i = nextId++))
  return i
}

/** Instanced attributes of a source mesh: [name, attribute] (instanceMatrix / instanceColor first). */
function instAttrs(m: THREE.InstancedMesh): [string, THREE.InstancedBufferAttribute][] {
  const out: [string, THREE.InstancedBufferAttribute][] = [['instanceMatrix', m.instanceMatrix]]
  if (m.instanceColor) out.push(['instanceColor', m.instanceColor])
  for (const [name, a] of Object.entries(m.geometry.attributes)) if ((a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute) out.push([name, a as THREE.InstancedBufferAttribute])
  return out
}

/** The parts of a batch key that never change for a mesh (geometry buffers, instanced attribute names). */
function fixedKeyOf(m: THREE.InstancedMesh): string {
  const g = m.geometry
  const inst = Object.entries(g.attributes).filter(([, a]) => (a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute).map(([n]) => n).sort().join(',')
  return `${idOf(g.attributes.position)}|${idOf(g.index)}|${inst}`
}

/** The parts that can change (material, shadows, layers, colour buffer, render order) — into `out`, true if changed. */
function dynKey(m: THREE.InstancedMesh, out: number[]): boolean {
  const v0 = idOf(m.material as THREE.Material), v1 = (m.castShadow ? 1 : 0) | (m.receiveShadow ? 2 : 0) | (m.instanceColor ? 4 : 0), v2 = m.layers.mask, v3 = m.renderOrder
  if (out[0] === v0 && out[1] === v1 && out[2] === v2 && out[3] === v3) return false
  out[0] = v0
  out[1] = v1
  out[2] = v2
  out[3] = v3
  return true
}

class Batch {
  readonly mesh: THREE.InstancedMesh
  private readonly geo: THREE.BufferGeometry
  /** Batch attributes by name, with item size. */
  private attrs = new Map<string, THREE.InstancedBufferAttribute>()
  private free: [number, number][] = []
  used = 0
  private cap = 0
  private holes = 0
  readonly sources = new Set<Source>()

  constructor(readonly key: string, proto: THREE.InstancedMesh, shadowOnly = false) {
    const g = new THREE.BufferGeometry()
    for (const [name, a] of Object.entries(proto.geometry.attributes)) if (!(a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute) g.setAttribute(name, a)
    g.setIndex(proto.geometry.index)
    for (const gr of proto.geometry.groups) g.addGroup(gr.start, gr.count, gr.materialIndex)
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7)
    this.geo = g
    this.mesh = new THREE.InstancedMesh(g, proto.material, 1)
    this.mesh.name = proto.name
    this.mesh.frustumCulled = false
    this.mesh.matrixAutoUpdate = false
    this.mesh.castShadow = proto.castShadow
    this.mesh.receiveShadow = proto.receiveShadow
    this.mesh.layers.mask = proto.layers.mask
    this.mesh.renderOrder = proto.renderOrder
    this.mesh.count = 0
    this.grow(proto, Math.max(256, proto.instanceMatrix.count))
    if (shadowOnly) {
      // drawn into the shadow map only: every other render (main camera, reflections) sees 0 instances (no draw)
      this.mesh.name += '.shadow'
      this.mesh.onBeforeRender = () => {
        this.mesh.count = 0
      }
      this.mesh.onAfterRender = () => {
        this.mesh.count = this.used
      }
    }
  }

  private grow(proto: THREE.InstancedMesh, cap: number): void {
    const old = this.attrs
    this.attrs = new Map()
    for (const [name, a] of instAttrs(proto)) {
      const arr = new Float32Array(cap * a.itemSize)
      const prev = old.get(name)
      if (prev) arr.set((prev.array as Float32Array).subarray(0, this.used * a.itemSize))
      const na = new THREE.InstancedBufferAttribute(arr, a.itemSize).setUsage(THREE.DynamicDrawUsage)
      this.attrs.set(name, na)
      if (name === 'instanceMatrix') this.mesh.instanceMatrix = na
      else if (name === 'instanceColor') this.mesh.instanceColor = na
      else this.geo.setAttribute(name, na)
    }
    this.cap = cap
  }

  write(s: Source): void {
    const n = s.mesh.count
    s.count = n
    s.versions = s.attrs.map(([, a]) => a.version)
    if (!n) return
    let at = -1
    for (let i = 0; i < this.free.length; i++) {
      const f = this.free[i]
      if (f[1] >= n) {
        at = f[0]
        if (f[1] === n) this.free.splice(i, 1)
        else (f[0] += n), (f[1] -= n)
        this.holes -= n
        break
      }
    }
    if (at < 0) {
      if (this.used + n > this.cap) this.grow(s.mesh, Math.max(this.cap * 2, this.used + n + 256))
      at = this.used
      this.used += n
    }
    s.start = at
    for (const [name, a] of s.attrs) {
      const dst = this.attrs.get(name)
      if (!dst) continue
      const k = a.itemSize
      ;(dst.array as Float32Array).set((a.array as Float32Array).subarray(0, n * k), at * k)
      if (name === 'instanceMatrix') {
        const M = dst.array as Float32Array
        for (let i = 0; i < n; i++) {
          M[(at + i) * 16 + 12] += s.ox
          M[(at + i) * 16 + 14] += s.oz
        }
      }
      dst.addUpdateRange(at * k, n * k)
      dst.needsUpdate = true
    }
    this.mesh.count = this.used
  }

  release(s: Source): void {
    if (s.start < 0) return
    const n = s.count
    const M = this.attrs.get('instanceMatrix')!
    ;(M.array as Float32Array).fill(0, s.start * 16, (s.start + n) * 16)
    M.addUpdateRange(s.start * 16, n * 16)
    M.needsUpdate = true
    this.free.push([s.start, n])
    this.free.sort((a, b) => a[0] - b[0])
    const merged: [number, number][] = []
    for (const f of this.free) {
      const last = merged[merged.length - 1]
      if (last && last[0] + last[1] === f[0]) last[1] += f[1]
      else merged.push([f[0], f[1]])
    }
    this.free = merged
    this.holes += n
    const tail = this.free[this.free.length - 1]
    if (tail && tail[0] + tail[1] === this.used) {
      this.used = tail[0]
      this.holes -= tail[1]
      this.free.pop()
    }
    s.start = -1
    this.mesh.count = this.used
    this.mesh.visible = this.used > 0
  }

  /** Too many holes: rewrite the shown sources contiguously. */
  maybeCompact(): void {
    if (this.holes < 64 || this.holes < this.used * 0.25) return
    this.used = 0
    this.holes = 0
    this.free = []
    ;(this.attrs.get('instanceMatrix')!.array as Float32Array).fill(0)
    for (const s of this.sources) if (s.start >= 0) this.write(s)
    this.mesh.count = this.used
  }

  dispose(): void {
    this.geo.dispose()
    this.mesh.dispose()
  }
}

export class InstanceBatcher {
  readonly root = new THREE.Group()
  private readonly sources = new Map<THREE.InstancedMesh, Source>()
  private readonly batches = new Map<string, Batch>()
  private readonly byOwner = new Map<object, Source[]>()

  constructor() {
    this.root.name = 'instance-batches'
    this.root.matrixAutoUpdate = false
  }

  /** Take over `mesh` (a chunk's InstancedMesh, chunk-local at (ox, oz)): it leaves the scene, a batch draws it. */
  adopt(owner: object, mesh: THREE.InstancedMesh, ox: number, oz: number, chunkVisible: () => number): void {
    mesh.removeFromParent()
    const s: Source = { mesh, ox, oz, chunkVisible, batch: null, start: -1, count: 0, versions: [], attrs: instAttrs(mesh), fixedKey: fixedKeyOf(mesh), key: '', keyIn: [] }
    this.sources.set(mesh, s)
    let list = this.byOwner.get(owner)
    if (!list) this.byOwner.set(owner, (list = []))
    list.push(s)
  }

  /** The owner (a chunk) is going away: its meshes leave their batches. */
  release(owner: object): void {
    for (const s of this.byOwner.get(owner) ?? []) {
      this.detach(s)
      this.sources.delete(s.mesh)
    }
    this.byOwner.delete(owner)
  }

  private detach(s: Source): void {
    if (!s.batch) return
    s.batch.release(s)
    s.batch.sources.delete(s)
    if (!s.batch.sources.size) {
      s.batch.mesh.removeFromParent()
      s.batch.dispose()
      this.batches.delete(s.batch.key)
    }
    s.batch = null
  }

  /** Per frame: mirror every source's visibility / content / draw state into the batches. */
  sync(): void {
    for (const s of this.sources.values()) {
      const m = s.mesh
      // in view → the main batch; out of view (a near ring kept for shadows) → a shadow-only batch, if it casts
      const state = m.visible && m.count > 0 ? s.chunkVisible() : 0
      const show = state === 1 || (state === 2 && m.castShadow)
      if (!show) {
        if (s.batch && s.start >= 0) s.batch.release(s)
        continue
      }
      if (dynKey(m, s.keyIn)) {
        s.attrs = instAttrs(m) // (a colour buffer may have been added)
        s.key = `${s.fixedKey}|${s.keyIn.join(',')}`
      }
      const key = state === 2 ? `${s.key}|shadow` : s.key
      if (!s.batch || s.batch.key !== key) {
        this.detach(s)
        let b = this.batches.get(key)
        if (!b) {
          b = new Batch(key, m, state === 2)
          this.batches.set(key, b)
          this.root.add(b.mesh)
        }
        b.sources.add(s)
        s.batch = b
      }
      const b = s.batch
      if (s.start >= 0) {
        // changed since written? (count, or any instanced buffer re-uploaded)
        let same = s.count === m.count
        if (same) {
          const a = s.attrs
          for (let i = 0; i < a.length; i++) if (a[i][1].version !== s.versions[i]) (same = false)
        }
        if (same) continue
        b.release(s)
      }
      b.write(s)
      b.mesh.visible = true
    }
    for (const b of this.batches.values()) b.maybeCompact()
  }

  /** Draws the batches make (stats) and instances in them. */
  get stats(): { batches: number; instances: number } {
    let n = 0
    for (const b of this.batches.values()) n += b.used
    return { batches: this.batches.size, instances: n }
  }

  dispose(): void {
    for (const b of this.batches.values()) b.dispose()
    this.batches.clear()
    this.sources.clear()
    this.byOwner.clear()
  }
}
