import * as pc from 'playcanvas'
import type * as THREE from 'three'
import { SRGB_LUT } from './geometry'

/**
 * ONE DRAW PER MATERIAL for the streamed world's static meshes (terrain, road ribbons, rock formations, places) —
 * PlayCanvas's MULTI-DRAW (MeshInstance.setMultiDraw → WEBGL_multi_draw; an internal loop of draws where the extension
 * is missing), the engine's counterpart of the three build's BatchedMesh terrain:
 *  - every chunk's mesh lives in a RANGE of one shared vertex + index buffer (world space: the chunk origin is baked
 *    in; indices offset to the range), allocated first-fit from free lists that coalesce, the buffers growing ×1.5
 *    when full (one re-upload);
 *  - the sub-draws are the ranges that matter this frame — in the camera's view, or within the shadow range (they
 *    cast into it) — sorted NEAR TO FAR (early depth rejection inside the one call); rebuilt only when ranges change or
 *    the view moved / turned enough;
 *  - a write uploads only that range's bytes (VertexBuffer / IndexBuffer partial unlock).
 * Draws: 1 per pool per pass (main + each shadow cascade) instead of 1 per chunk.
 * Memory: the buffers hold the shown meshes only (+ the free gaps; the engine keeps a CPU copy as for any mesh).
 */
export interface PoolAttr {
  /** three attribute name */
  name: string
  semantic: string
  components: number
  /** 'f32' floats · 'srgb8' linear colours → sRGB bytes (vertex colours) */
  kind: 'f32' | 'srgb8'
}

interface Range {
  v: number
  vn: number
  i: number
  in: number
  box: pc.BoundingBox
  dist: number
}

interface Free {
  at: number
  n: number
}

const _sphere = new pc.BoundingSphere()

export class RangePool {
  readonly mi: pc.MeshInstance
  private readonly mesh: pc.Mesh
  private readonly format: pc.VertexFormat
  private vb: pc.VertexBuffer
  private ib: pc.IndexBuffer
  private vCap: number
  private iCap: number
  private freeV: Free[]
  private freeI: Free[]
  private readonly ranges = new Map<string, Range>()
  private dirty = true
  private readonly lastPos = new pc.Vec3(1e9, 0, 0)
  private readonly lastFwd = new pc.Vec3()
  private readonly frustum = new pc.Frustum()
  private readonly vp = new pc.Mat4()
  private readonly list: Range[] = []
  private cmdMain: pc.DrawCommands | undefined
  private cmdShadow: pc.DrawCommands | undefined
  private cmdCap = 0
  private readonly shadowList: Range[] = []
  private boundCam: pc.CameraComponent | null = null
  private readonly offsets: { a: PoolAttr; off: number; stride: number }[] = []
  /** ranges within this distance (m) always draw: they cast into the view */
  shadowRange = 110
  /** sub-draws issued last update (stats) */
  drawn = 0

  constructor(private readonly device: pc.GraphicsDevice, node: pc.GraphNode, material: pc.Material, attrs: PoolAttr[], vCap = 1 << 16, iCap = 1 << 18, primitive: number = pc.PRIMITIVE_TRIANGLES) {
    this.format = new pc.VertexFormat(device, attrs.map((a) => ({
      semantic: a.semantic,
      components: a.kind === 'srgb8' ? 4 : a.components,
      type: a.kind === 'srgb8' ? pc.TYPE_UINT8 : pc.TYPE_FLOAT32,
      normalize: a.kind === 'srgb8',
    })))
    for (const el of this.format.elements) {
      const a = attrs.find((x) => x.semantic === el.name)!
      this.offsets.push({ a, off: el.offset, stride: el.stride })
    }
    this.vCap = vCap
    this.iCap = iCap
    this.vb = new pc.VertexBuffer(device, this.format, vCap, { usage: pc.BUFFER_DYNAMIC })
    this.ib = new pc.IndexBuffer(device, pc.INDEXFORMAT_UINT32, iCap, pc.BUFFER_DYNAMIC)
    this.freeV = [{ at: 0, n: vCap }]
    this.freeI = [{ at: 0, n: iCap }]
    this.mesh = new pc.Mesh(device)
    this.mesh.vertexBuffer = this.vb
    this.mesh.indexBuffer[0] = this.ib
    this.mesh.primitive[0] = { type: primitive, base: 0, baseVertex: 0, count: 0, indexed: true }
    this.mesh.aabb = new pc.BoundingBox(new pc.Vec3(), new pc.Vec3(1e5, 1e5, 1e5))
    this.mi = new pc.MeshInstance(this.mesh, material, node)
    this.mi.cull = false // (the pool culls its ranges itself)
    this.mi.receiveShadow = true
  }

  get count(): number {
    return this.ranges.size
  }

  /** Put (or replace) `key`'s mesh: a three geometry, offset by (ox, oz). Null removes it. */
  set(key: string, g: THREE.BufferGeometry | null, ox = 0, oz = 0, extra?: (attr: string, out: Float32Array, n: number) => boolean): void {
    this.remove(key)
    if (!g) return
    const pos = g.getAttribute('position')
    const idx = g.getIndex()
    if (!pos || !idx || !pos.count) return
    const vn = pos.count, inn = idx.count
    let v = this.take(this.freeV, vn)
    if (v < 0) {
      this.growV(vn)
      v = this.take(this.freeV, vn)
    }
    let i = this.take(this.freeI, inn)
    if (i < 0) {
      this.growI(inn)
      i = this.take(this.freeI, inn)
    }
    // vertices
    const storage = this.vb.lock() as ArrayBuffer
    const f32 = new Float32Array(storage), u8 = new Uint8Array(storage)
    let lo = Infinity, hi = -Infinity, ylo = Infinity, yhi = -Infinity, zlo = Infinity, zhi = -Infinity
    for (const { a, off, stride } of this.offsets) {
      const src = g.getAttribute(a.name) as THREE.BufferAttribute | undefined
      const k = a.components
      if (a.kind === 'srgb8') {
        for (let n = 0; n < vn; n++) {
          const o = off + (v + n) * stride
          if (src) for (let c = 0; c < 3; c++) u8[o + c] = SRGB_LUT[Math.min(1023, Math.max(0, Math.round(src.getComponent(n, c) * 1023)))]
          else u8[o] = u8[o + 1] = u8[o + 2] = 255
          u8[o + 3] = 255
        }
        continue
      }
      const sk = src ? src.itemSize : 0
      const arr = src ? (src.array as ArrayLike<number>) : null
      const plain = !!src && !(src as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute
      const tmp = extra && !src ? new Float32Array(vn * k) : null
      const fromExtra = tmp ? extra!(a.name, tmp, vn) : false
      for (let n = 0; n < vn; n++) {
        const o = (off + (v + n) * stride) >> 2
        for (let c = 0; c < k; c++) {
          let x = fromExtra ? tmp![n * k + c] : c < sk ? (plain ? arr![n * sk + c] : src!.getComponent(n, c)) : 0
          if (a.semantic === pc.SEMANTIC_POSITION) x += c === 0 ? ox : c === 2 ? oz : 0
          f32[o + c] = x
        }
        if (a.semantic === pc.SEMANTIC_POSITION) {
          const x = f32[o], y = f32[o + 1], z = f32[o + 2]
          if (x < lo) lo = x
          if (x > hi) hi = x
          if (y < ylo) ylo = y
          if (y > yhi) yhi = y
          if (z < zlo) zlo = z
          if (z > zhi) zhi = z
        }
      }
    }
    const fs = this.format.size
    this.vb.unlock(v * fs, vn * fs)
    // indices (offset to the range)
    const istore = new Uint32Array(this.ib.lock() as ArrayBuffer)
    const ia = idx.array as ArrayLike<number>
    for (let n = 0; n < inn; n++) istore[i + n] = ia[n] + v
    this.ib.unlock(i * 4, inn * 4)
    const box = new pc.BoundingBox()
    box.setMinMax(new pc.Vec3(lo, ylo, zlo), new pc.Vec3(hi, yhi, zhi))
    this.ranges.set(key, { v, vn, i, in: inn, box, dist: 0 })
    this.dirty = true
  }

  has(key: string): boolean {
    return this.ranges.has(key)
  }

  remove(key: string): void {
    const r = this.ranges.get(key)
    if (!r) return
    this.ranges.delete(key)
    this.give(this.freeV, r.v, r.vn)
    this.give(this.freeI, r.i, r.in)
    this.dirty = true
  }

  /** The sub-draws for this frame (re-listed when ranges changed or the view moved ≥ 6 m / turned ~8°). */
  update(cam: pc.CameraComponent): void {
    const pos = cam.entity.getPosition(), fwd = cam.entity.forward
    if (!this.dirty && pos.distance(this.lastPos) < 6 && fwd.dot(this.lastFwd) > 0.99) return
    this.dirty = false
    this.lastPos.copy(pos)
    this.lastFwd.copy(fwd)
    this.vp.mul2(cam.projectionMatrix, cam.viewMatrix)
    this.frustum.setFromMat4(this.vp)
    // the CAMERA's draws: the ranges in its view; the SHADOW passes' (the shared set — a light's camera has no
    // component): the ranges near enough to cast into the visible shadow distance
    const list = this.list, sh = this.shadowList
    list.length = 0
    sh.length = 0
    for (const r of this.ranges.values()) {
      const c = r.box.center
      const d = Math.hypot(c.x - pos.x, c.z - pos.z)
      r.dist = d
      if (d - r.box.halfExtents.x < this.shadowRange) sh.push(r)
      _sphere.center.copy(c)
      _sphere.radius = r.box.halfExtents.length() + 4
      if (this.frustum.containsSphere(_sphere)) list.push(r)
    }
    list.sort((a, b) => a.dist - b.dist) // near → far: early-z inside the one draw
    const need = Math.max(list.length, sh.length)
    if (!this.cmdMain || need > this.cmdCap || this.boundCam !== cam) {
      this.cmdCap = Math.max(16, Math.ceil(need * 1.5))
      this.cmdMain = this.mi.setMultiDraw(cam, this.cmdCap)
      this.cmdShadow = this.mi.setMultiDraw(null, this.cmdCap)
      this.boundCam = cam
    }
    let n = 0
    for (const r of list) this.cmdMain!.add(n++, r.in, 1, r.i)
    this.cmdMain!.update(n)
    let m = 0
    for (const r of sh) this.cmdShadow!.add(m++, r.in, 1, r.i)
    this.cmdShadow!.update(m)
    this.drawn = n
    // (with no ranges the instance draws nothing: leave the layer's list alone, an empty multi-draw is a no-op)
    this.mi.visible = n + m > 0
  }

  private take(list: Free[], n: number): number {
    for (let k = 0; k < list.length; k++) {
      const f = list[k]
      if (f.n < n) continue
      const at = f.at
      f.at += n
      f.n -= n
      if (!f.n) list.splice(k, 1)
      return at
    }
    return -1
  }

  private give(list: Free[], at: number, n: number): void {
    // sorted insert + coalesce with the neighbours
    let k = 0
    while (k < list.length && list[k].at < at) k++
    list.splice(k, 0, { at, n })
    if (k + 1 < list.length && at + n === list[k + 1].at) {
      list[k].n += list[k + 1].n
      list.splice(k + 1, 1)
    }
    if (k > 0 && list[k - 1].at + list[k - 1].n === at) {
      list[k - 1].n += list[k].n
      list.splice(k, 1)
    }
  }

  private growV(need: number): void {
    const cap = Math.max(Math.ceil(this.vCap * 1.5), this.vCap + need)
    const nb = new pc.VertexBuffer(this.device, this.format, cap, { usage: pc.BUFFER_DYNAMIC })
    new Uint8Array(nb.lock() as ArrayBuffer).set(new Uint8Array(this.vb.lock() as ArrayBuffer))
    nb.unlock()
    this.vb.destroy()
    this.vb = nb
    this.mesh.vertexBuffer = nb
    this.give(this.freeV, this.vCap, cap - this.vCap)
    this.vCap = cap
  }

  private growI(need: number): void {
    const cap = Math.max(Math.ceil(this.iCap * 1.5), this.iCap + need)
    const nb = new pc.IndexBuffer(this.device, pc.INDEXFORMAT_UINT32, cap, pc.BUFFER_DYNAMIC)
    new Uint32Array(nb.lock() as ArrayBuffer).set(new Uint32Array(this.ib.lock() as ArrayBuffer))
    nb.unlock()
    this.ib.destroy()
    this.ib = nb
    this.mesh.indexBuffer[0] = nb
    this.give(this.freeI, this.iCap, cap - this.iCap)
    this.iCap = cap
  }

  destroy(): void {
    this.mi.destroy()
    this.vb.destroy()
    this.ib.destroy()
  }
}
