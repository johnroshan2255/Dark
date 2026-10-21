import * as THREE from 'three'
import { MAX_RENDER_RADIUS, RADIUS } from '../world/constants'
import type { WorldChunk } from '../world/WorldChunk'

const LOD_COLORS = [new THREE.Color(0x3cff6e), new THREE.Color(0xffd23c), new THREE.Color(0x3cb4ff)]
const CULLED = new THREE.Color(0xff2a2a)
const EDGES = [0, 1, 1, 3, 3, 2, 2, 0, 4, 5, 5, 7, 7, 6, 6, 4, 0, 4, 1, 5, 2, 6, 3, 7]

/**
 * Chunk AABBs as one LineSegments draw call: green/yellow/blue = LOD0/1/2, red = frustum-culled.
 * Buffers are preallocated for the maximum loaded ring; rewritten only while enabled.
 */
export class ChunkDebug {
  readonly object: THREE.LineSegments
  private readonly pos: Float32Array
  private readonly col: Float32Array
  private readonly max: number

  constructor() {
    const side = 2 * (MAX_RENDER_RADIUS + RADIUS.unloadMargin) + 1
    this.max = side * side
    this.pos = new Float32Array(this.max * 24 * 3)
    this.col = new Float32Array(this.max * 24 * 3)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage))
    this.object = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, fog: false, depthTest: false, transparent: true, opacity: 0.8 }))
    this.object.frustumCulled = false
    this.object.renderOrder = 999
    this.object.visible = false
    this.object.name = 'debug/chunks'
  }

  set enabled(v: boolean) {
    this.object.visible = v
  }
  get enabled(): boolean {
    return this.object.visible
  }

  update(chunks: Iterable<WorldChunk>): void {
    if (!this.object.visible) return
    let n = 0
    const corner = new THREE.Vector3()
    for (const c of chunks) {
      if (n >= this.max) break
      const b = c.bounds
      const color = c.isVisible ? LOD_COLORS[Math.max(0, c.lod)] : CULLED
      for (let e = 0; e < 24; e++) {
        const k = EDGES[e]
        corner.set(k & 1 ? b.max.x : b.min.x, k & 4 ? b.max.y : b.min.y, k & 2 ? b.max.z : b.min.z)
        const o = (n * 24 + e) * 3
        corner.toArray(this.pos, o)
        color.toArray(this.col, o)
      }
      n++
    }
    const g = this.object.geometry
    g.setDrawRange(0, n * 24)
    g.attributes.position.needsUpdate = true
    g.attributes.color.needsUpdate = true
  }
}
