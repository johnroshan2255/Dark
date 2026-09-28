import * as THREE from 'three'
import { stylize } from '../../rendering/shaders/stylize'
import { CHUNK_SIZE } from '../constants'
import type { FarRequest } from '../Streaming/chunk.worker'
import type { FarTerrainData } from './horizonGen'

/**
 * Low-detail HORIZON terrain out to ~1–1.5 km, so hills, valleys, lakes and forests far beyond the streamed
 * chunks stay visible (views from hilltops, refer/environment/procedural-world-vista). One mesh, one draw call.
 *
 *  - Generated in its own worker; rebuilt when the player moves `size/6` from its centre (double-buffered:
 *    the old mesh stays until the new one arrives).
 *  - Inside the loaded chunk area (minus one ring) its fragments are discarded, so detailed chunks show;
 *    in the overlap ring it sits 3 m lower with polygon offset → chunks win, no z-fighting.
 *  - Same painterly material patch (rim + sky-coloured fog) as the chunk terrain.
 */
export interface FarSettings {
  size: number
  res: number
}

export class HorizonTerrain {
  readonly mesh: THREE.Mesh
  readonly material: THREE.MeshLambertMaterial
  private readonly worker: Worker
  private pendingId = 0
  private centre = new THREE.Vector2(Number.NaN, Number.NaN)
  private settings: FarSettings = { size: 1600, res: 64 }
  /** Loaded-area hole: minX, minZ, maxX, maxZ (world). */
  private readonly hole = new THREE.Vector4(0, 0, 0, 0)
  genMs = 0

  constructor(private readonly seed: number) {
    const m = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 })
    m.name = 'lib/far-terrain'
    const hole = this.hole
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uHole = { value: hole }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFarXZ;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvFarXZ = (modelMatrix * vec4(transformed, 1.0)).xz;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec4 uHole; varying vec2 vFarXZ;')
        .replace('void main() {', 'void main() {\n  if (vFarXZ.x > uHole.x && vFarXZ.x < uHole.z && vFarXZ.y > uHole.y && vFarXZ.y < uHole.w) discard;')
    }
    m.customProgramCacheKey = () => 'far-terrain'
    this.material = stylize(m, { key: 'far', rim: 0.2, toon: 0.45 })
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material)
    this.mesh.name = 'far-terrain'
    this.mesh.frustumCulled = false
    this.mesh.receiveShadow = false
    this.mesh.visible = false
    this.worker = new Worker(new URL('../Streaming/chunk.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<{ id: number; far: FarTerrainData }>) => {
      if (e.data.id === this.pendingId && e.data.far) this.build(e.data.far)
    }
  }

  configure(s: FarSettings): void {
    if (s.size === this.settings.size && s.res === this.settings.res) return
    this.settings = { ...s }
    this.centre.set(Number.NaN, Number.NaN)
  }

  /** @param ring loaded chunk radius around the player's chunk (for the hole). */
  update(focus: THREE.Vector3, ring: number): void {
    const pcx = Math.floor(focus.x / CHUNK_SIZE)
    const pcz = Math.floor(focus.z / CHUNK_SIZE)
    const r = Math.max(0, ring - 1)
    this.hole.set((pcx - r) * CHUNK_SIZE, (pcz - r) * CHUNK_SIZE, (pcx + r + 1) * CHUNK_SIZE, (pcz + r + 1) * CHUNK_SIZE)
    const step = this.settings.size / this.settings.res
    const moved = Math.hypot(focus.x - this.centre.x, focus.z - this.centre.y)
    if (!(moved < this.settings.size / 6)) {
      // Snap to the grid step so vertices don't swim between rebuilds.
      this.centre.set(Math.round(focus.x / step) * step, Math.round(focus.z / step) * step)
      const msg: FarRequest = { type: 'far', id: ++this.pendingId, seed: this.seed, cx: this.centre.x, cz: this.centre.y, size: this.settings.size, res: this.settings.res }
      this.worker.postMessage(msg)
    }
  }

  private build(d: FarTerrainData): void {
    const n = d.res + 1
    const step = d.size / d.res
    const pos = new Float32Array(n * n * 3)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i
        pos[k * 3] = d.cx - d.size / 2 + i * step
        pos[k * 3 + 1] = d.heights[k] - 3
        pos[k * 3 + 2] = d.cz - d.size / 2 + j * step
      }
    }
    const idx = new Uint32Array(d.res * d.res * 6)
    let t = 0
    for (let j = 0; j < d.res; j++) {
      for (let i = 0; i < d.res; i++) {
        const a = j * n + i, b = a + 1, c = a + n, e = c + 1
        idx[t++] = a; idx[t++] = c; idx[t++] = b
        idx[t++] = b; idx[t++] = c; idx[t++] = e
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.BufferAttribute(d.colors, 3))
    g.setIndex(new THREE.BufferAttribute(idx, 1))
    g.computeVertexNormals()
    g.computeBoundingSphere()
    this.mesh.geometry.dispose()
    this.mesh.geometry = g
    this.mesh.visible = true
  }

  dispose(): void {
    this.worker.terminate()
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
