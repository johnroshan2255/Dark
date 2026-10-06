import * as THREE from 'three'
import { CHUNK_SIZE } from '../constants'
import { chunkKey } from '../types'
import type { WorldFields } from '../WorldFields'
import type { SpeciesDef } from './treeFactory'
import { createImpostorMesh, speciesTreeAttrs } from '../WorldChunk'
import type { InstanceAttributes } from '../../optimization/instancing/InstanceBuilder'

/** Chunks per far-forest block side: one InstancedMesh (one draw) per 4×4 chunks = 256 m. */
const BLOCK = 4
/** Worker requests in flight. */
const INFLIGHT = 3

/**
 * FAR FOREST — the trees on the hills beyond the streamed chunks, out to the tier's `impostors.far` (360–900 m),
 * as octahedral impostors only (rendering/impostors). Genshin-style: the forest reaches the horizon instead of
 * stopping at the detail ring.
 *
 * Tree records come from the SAME deterministic scatter as the chunks (WorldGenerator.generateTrees in its own
 * worker: heights + scatter only, ~1–3 ms per chunk), and are instanced with the same hues / tints / shapes
 * (WorldChunk.speciesTreeAttrs) — when a chunk streams in, its impostors and the far forest's are the same trees
 * in the same places, so the hand-over is invisible. A chunk is covered here exactly while it has no built
 * chunk inside the render ring. Blocks of 4×4 chunks are one instanced draw each, frustum-culled, rebuilt (≤ 1 per
 * frame, ~0.3 ms) when their membership changes.
 *
 * Cost (HIGH, 700 m): ~25 k cards ≈ 50 k triangles, ~10–15 visible draws, ~2 MB instance buffers; LOW (360 m):
 * ~6 k cards, ≤ 8 draws. The trees fill only a few pixels each, so the fragment cost is small.
 */
export class FarForest {
  readonly root = new THREE.Group()
  private readonly worker: Worker
  private readonly data = new Map<string, Float32Array>()
  private readonly requested = new Set<string>()
  private readonly ids = new Map<number, { key: string; cx: number; cz: number }>()
  private nextId = 1
  private inflight = 0
  private readonly blocks = new Map<string, { mesh: THREE.InstancedMesh | null; sig: string }>()
  private wanted: { key: string; cx: number; cz: number; d: number }[] = []
  private dirty = true
  private cx = Number.NaN
  private cz = Number.NaN
  /** Far edge (m) and its chunk radius. */
  private far = 0
  private radius = 0
  enabled = false
  /** The drawn ground beyond the chunks (HorizonTerrain): far trees stand on it, re-seated when it is rebuilt. */
  ground: { heightAt(x: number, z: number): number | null; version: number } | null = null
  private groundVersion = -1

  constructor(
    private readonly seed: number,
    private readonly palette: number,
    private readonly fields: WorldFields,
    private readonly species: readonly SpeciesDef[],
    private readonly material: THREE.Material,
  ) {
    this.root.name = 'far-forest'
    this.root.matrixAutoUpdate = false
    this.worker = new Worker(new URL('../Streaming/chunk.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<{ id: number; trees: Float32Array }>) => {
      const req = this.ids.get(e.data.id)
      this.ids.delete(e.data.id)
      this.inflight--
      if (!req) return
      this.data.set(req.key, e.data.trees)
      this.dirty = true
    }
  }

  setRange(far: number): void {
    if (far === this.far) return
    this.far = far
    this.radius = Math.ceil(far / CHUNK_SIZE)
    this.cx = Number.NaN
  }

  /** Re-evaluate which chunks the far forest covers (when the player's chunk or the built set changes). */
  invalidate(): void {
    this.cx = Number.NaN
  }

  /**
   * @param covered true when a built chunk inside the render ring draws this chunk's trees itself.
   */
  update(pcx: number, pcz: number, covered: (key: string) => boolean): void {
    this.root.visible = this.enabled
    if (!this.enabled || !this.radius) return
    if (pcx !== this.cx || pcz !== this.cz) {
      this.cx = pcx
      this.cz = pcz
      const R = this.radius
      this.wanted = []
      for (let dz = -R; dz <= R; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          const cx = pcx + dx, cz = pcz + dz
          const key = chunkKey(cx, cz)
          if (covered(key)) continue
          this.wanted.push({ key, cx, cz, d: Math.hypot(dx, dz) })
        }
      }
      this.wanted.sort((a, b) => a.d - b.d)
      // Forget chunks well outside the ring.
      for (const key of this.data.keys()) {
        const [x, z] = key.split(',').map(Number)
        if (Math.max(Math.abs(x - pcx), Math.abs(z - pcz)) > R + 2) this.data.delete(key)
      }
      this.dirty = true
    }
    // Requests, nearest first.
    for (const w of this.wanted) {
      if (this.inflight >= INFLIGHT) break
      if (this.data.has(w.key) || this.requested.has(w.key)) continue
      const id = this.nextId++
      this.ids.set(id, w)
      this.requested.add(w.key)
      this.inflight++
      this.worker.postMessage({ type: 'trees', id, seed: this.seed, palette: this.palette, cx: w.cx, cz: w.cz })
    }
    for (const k of [...this.requested]) if (this.data.has(k)) this.requested.delete(k)
    if (this.ground && this.ground.version !== this.groundVersion) {
      this.groundVersion = this.ground.version
      for (const b of this.blocks.values()) b.sig = '' // re-seat every block on the new surface
      this.dirty = true
    }
    if (this.dirty) this.rebuild()
  }

  /** Rebuild the blocks whose members changed (≤ 1 per call; stays dirty until all are current). */
  private rebuild(): void {
    const byBlock = new Map<string, { bx: number; bz: number; keys: string[] }>()
    for (const w of this.wanted) {
      if (!this.data.has(w.key)) continue
      const bx = Math.floor(w.cx / BLOCK), bz = Math.floor(w.cz / BLOCK)
      const bk = `${bx},${bz}`
      let b = byBlock.get(bk)
      if (!b) byBlock.set(bk, (b = { bx, bz, keys: [] }))
      b.keys.push(w.key)
    }
    for (const [bk, blk] of this.blocks) {
      if (byBlock.has(bk)) continue
      blk.mesh && (blk.mesh.removeFromParent(), blk.mesh.geometry.dispose(), blk.mesh.dispose())
      this.blocks.delete(bk)
    }
    let budget = 1
    let pending = false
    for (const [bk, b] of byBlock) {
      const sig = b.keys.sort().join(';')
      const cur = this.blocks.get(bk)
      if (cur && cur.sig === sig) continue
      if (budget-- <= 0) {
        pending = true
        continue
      }
      const ox = b.bx * BLOCK * CHUNK_SIZE, oz = b.bz * BLOCK * CHUNK_SIZE
      const list: { sp: SpeciesDef; attrs: InstanceAttributes; offset: [number, number] }[] = []
      for (const key of b.keys) {
        const [cx, cz] = key.split(',').map(Number)
        const origin: [number, number] = [cx * CHUNK_SIZE, cz * CHUNK_SIZE]
        for (const e of speciesTreeAttrs(this.data.get(key)!, origin, this.fields, this.species)) list.push({ ...e, offset: [origin[0] - ox, origin[1] - oz] })
      }
      const mesh = createImpostorMesh(list, this.species, this.material)
      if (mesh && this.ground) {
        // Stand on the horizon surface that is actually drawn here.
        const m = mesh.instanceMatrix.array as Float32Array
        for (let k = 0; k < mesh.count; k++) {
          const h = this.ground.heightAt(ox + m[k * 16 + 12], oz + m[k * 16 + 14])
          if (h !== null) m[k * 16 + 13] = h
        }
      }
      if (cur?.mesh) (cur.mesh.removeFromParent(), cur.mesh.geometry.dispose(), cur.mesh.dispose())
      if (mesh) {
        mesh.position.set(ox, 0, oz)
        mesh.updateMatrix()
        mesh.computeBoundingSphere()
        mesh.frustumCulled = true
        this.root.add(mesh)
        mesh.updateMatrixWorld(true)
      }
      this.blocks.set(bk, { mesh, sig })
    }
    this.dirty = pending || this.inflight > 0
  }

  /** Cards and draws (stats). */
  get count(): number {
    let n = 0
    for (const b of this.blocks.values()) n += b.mesh?.count ?? 0
    return n
  }

  dispose(): void {
    this.worker.terminate()
    for (const b of this.blocks.values()) b.mesh && (b.mesh.geometry.dispose(), b.mesh.dispose())
    this.blocks.clear()
    this.root.removeFromParent()
  }
}
