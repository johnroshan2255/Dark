import * as THREE from 'three'
import { impostorQuad } from '../../rendering/impostors/Impostors'

/**
 * EVERY TREE IMPOSTOR IN ONE DRAW. The streamed chunks' impostor cards (per-tree LOD) and the far forest's blocks
 * used to be one InstancedMesh each — 40–50 draws on ULTRA, the largest single share of the frame's draw calls.
 * Here they share one InstancedMesh: each source (a chunk, a far-forest block) owns a RANGE of its instance slots.
 *
 *  * add / re-add: the source's cards are copied into a free range (first fit, else appended) and only that range is
 *    uploaded (`addUpdateRange`);
 *  * hide / remove: its range is zeroed — a zero matrix collapses the card to a point (no fragments, 4 vertices) —
 *    and freed for reuse; the draw keeps the high-water count;
 *  * when the holes pass a quarter of the slots the batch is compacted (one full upload).
 * No per-chunk frustum culling: a card is 2 triangles and a few pixels, cheaper than the draws the culling saved;
 * rebuilds happen only when chunks stream / change LOD, never as the camera turns.
 *
 * Cost (ULTRA, the island): ~12 k cards → 1 draw instead of ~47; ~480 KB instance buffers; an update copies only the
 * changed source (≤ 2 k cards, < 0.1 ms).
 */
interface Source {
  matrix: Float32Array
  color: Float32Array
  slot: Float32Array
  count: number
  ox: number
  oz: number
  visible: boolean
  /** Where its cards are in the batch (−1 = not written). */
  start: number
}

const _zero = new Float32Array(16)

export class ImpostorBatch {
  readonly mesh: THREE.InstancedMesh
  private readonly geo: THREE.BufferGeometry
  private readonly sources = new Map<string, Source>()
  /** Free ranges [start, count], sorted by start. */
  private free: [number, number][] = []
  private used = 0
  private cap = 0
  private holes = 0
  private matrix!: THREE.InstancedBufferAttribute
  private color!: THREE.InstancedBufferAttribute
  private slot!: THREE.InstancedBufferAttribute

  constructor(material: THREE.Material) {
    const q = impostorQuad()
    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', q.getAttribute('position'))
    this.geo.setAttribute('normal', q.getAttribute('normal'))
    this.geo.setIndex(q.getIndex())
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7)
    this.mesh = new THREE.InstancedMesh(this.geo, material, 1)
    this.mesh.name = 'impostors'
    this.mesh.frustumCulled = false
    this.mesh.matrixAutoUpdate = false
    this.grow(4096)
    this.mesh.count = 0
  }

  /** Total cards drawn (stats). */
  get count(): number {
    return this.used - this.holes
  }

  /** Add or replace a source: its cards (an InstancedMesh's matrices / colours / aSlot) offset by (ox, oz). */
  set(key: string, src: THREE.InstancedMesh | null, ox: number, oz: number, visible: boolean): void {
    this.remove(key)
    if (!src || !src.count) return
    const s: Source = {
      matrix: src.instanceMatrix.array as Float32Array,
      color: src.instanceColor!.array as Float32Array,
      slot: (src.geometry.getAttribute('aSlot') as THREE.InstancedBufferAttribute).array as Float32Array,
      count: src.count,
      ox,
      oz,
      visible: false,
      start: -1,
    }
    this.sources.set(key, s)
    if (visible) this.setVisible(key, true)
  }

  setVisible(key: string, visible: boolean): void {
    const s = this.sources.get(key)
    if (!s || s.visible === visible) return
    s.visible = visible
    if (visible) this.write(s)
    else this.release(s)
  }

  remove(key: string): void {
    const s = this.sources.get(key)
    if (!s) return
    this.release(s)
    this.sources.delete(key)
  }

  private write(s: Source): void {
    let at = -1
    for (let i = 0; i < this.free.length; i++) {
      const f = this.free[i]
      if (f[1] >= s.count) {
        at = f[0]
        if (f[1] === s.count) this.free.splice(i, 1)
        else (f[0] += s.count), (f[1] -= s.count)
        this.holes -= s.count
        break
      }
    }
    if (at < 0) {
      if (this.used + s.count > this.cap) this.grow(Math.max(this.cap * 2, this.used + s.count + 1024))
      at = this.used
      this.used += s.count
    }
    s.start = at
    const M = this.matrix.array as Float32Array, C = this.color.array as Float32Array, S = this.slot.array as Float32Array
    M.set(s.matrix.subarray(0, s.count * 16), at * 16)
    for (let k = 0; k < s.count; k++) {
      M[(at + k) * 16 + 12] += s.ox
      M[(at + k) * 16 + 14] += s.oz
    }
    C.set(s.color.subarray(0, s.count * 3), at * 3)
    S.set(s.slot.subarray(0, s.count), at)
    this.upload(at, s.count)
    this.mesh.count = this.used
  }

  private release(s: Source): void {
    if (s.start < 0) return
    const M = this.matrix.array as Float32Array
    for (let k = 0; k < s.count; k++) M.set(_zero, (s.start + k) * 16)
    this.matrix.addUpdateRange(s.start * 16, s.count * 16)
    this.matrix.needsUpdate = true
    this.free.push([s.start, s.count])
    this.free.sort((a, b) => a[0] - b[0])
    // merge neighbours; a hole at the end shrinks the draw
    const merged: [number, number][] = []
    for (const f of this.free) {
      const last = merged[merged.length - 1]
      if (last && last[0] + last[1] === f[0]) last[1] += f[1]
      else merged.push([f[0], f[1]])
    }
    this.free = merged
    this.holes += s.count
    const tail = this.free[this.free.length - 1]
    if (tail && tail[0] + tail[1] === this.used) {
      this.used = tail[0]
      this.holes -= tail[1]
      this.free.pop()
    }
    s.start = -1
    this.mesh.count = this.used
    if (this.holes > 2048 && this.holes > this.used * 0.25) this.compact()
  }

  /** Rewrite every visible source contiguously (one full upload). */
  private compact(): void {
    this.used = 0
    this.holes = 0
    this.free = []
    ;(this.matrix.array as Float32Array).fill(0)
    for (const s of this.sources.values()) {
      s.start = -1
      if (s.visible) this.write(s)
    }
    this.mesh.count = this.used
  }

  private grow(cap: number): void {
    const keep = this.used
    const m = new Float32Array(cap * 16), c = new Float32Array(cap * 3), sl = new Float32Array(cap)
    if (this.matrix) {
      m.set((this.matrix.array as Float32Array).subarray(0, keep * 16))
      c.set((this.color.array as Float32Array).subarray(0, keep * 3))
      sl.set((this.slot.array as Float32Array).subarray(0, keep))
    }
    this.cap = cap
    this.matrix = new THREE.InstancedBufferAttribute(m, 16).setUsage(THREE.DynamicDrawUsage)
    this.color = new THREE.InstancedBufferAttribute(c, 3).setUsage(THREE.DynamicDrawUsage)
    this.slot = new THREE.InstancedBufferAttribute(sl, 1).setUsage(THREE.DynamicDrawUsage)
    this.mesh.instanceMatrix = this.matrix
    this.mesh.instanceColor = this.color
    this.geo.setAttribute('aSlot', this.slot)
  }

  private upload(start: number, count: number): void {
    this.matrix.addUpdateRange(start * 16, count * 16)
    this.color.addUpdateRange(start * 3, count * 3)
    this.slot.addUpdateRange(start, count)
    this.matrix.needsUpdate = this.color.needsUpdate = this.slot.needsUpdate = true
  }

  dispose(): void {
    this.geo.dispose()
    this.mesh.dispose()
  }
}
