import * as THREE from 'three'
import { stylize } from '../../rendering/shaders/stylize'
import { CHUNK_SIZE } from '../constants'
import type { FarRequest } from '../Streaming/chunk.worker'
import { groundPalette } from '../../rendering/artStyle'
import { farOffset, type FarTerrainData } from './horizonGen'

/**
 * Low-detail HORIZON terrain out to 2.4–4.4 km (tier), on a warped grid (dense near the player, coarse at the
 * rim — horizonGen.farOffset), so hills, valleys, lakes and forests far beyond the streamed
 * chunks stay visible (views from hilltops, refer/environment/procedural-world-vista). One mesh, one draw call.
 *
 *  - Generated in its own worker; rebuilt when the player moves `size/6` from its centre (double-buffered:
 *    the old mesh stays until the new one arrives).
 *  - Inside the BUILT chunk area (WorldManager.builtRadius) its fragments are discarded, so detailed chunks
 *    show; in the overlap ring it sits 3 m lower with polygon offset → chunks win, no z-fighting. A chunk that
 *    hasn't streamed in yet is covered by the horizon hills instead of showing a hole into the sky.
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

  /** @param builtRadius chunk radius around the player's chunk inside which every chunk is BUILT (the hole). */
  update(focus: THREE.Vector3, builtRadius: number): void {
    const pcx = Math.floor(focus.x / CHUNK_SIZE)
    const pcz = Math.floor(focus.z / CHUNK_SIZE)
    const r = Math.max(0, builtRadius)
    this.hole.set((pcx - r) * CHUNK_SIZE, (pcz - r) * CHUNK_SIZE, (pcx + r + 1) * CHUNK_SIZE, (pcz + r + 1) * CHUNK_SIZE)
    const moved = Math.hypot(focus.x - this.centre.x, focus.z - this.centre.y)
    // The fine part of the warped grid must stay under the chunk-ring edge → re-centre every ~size/16.
    if (!(moved < Math.max(96, this.settings.size / 16))) {
      // Snap to the chunk grid so vertices don't swim between rebuilds.
      this.centre.set(Math.round(focus.x / CHUNK_SIZE) * CHUNK_SIZE, Math.round(focus.z / CHUNK_SIZE) * CHUNK_SIZE)
      const msg: FarRequest = { type: 'far', id: ++this.pendingId, seed: this.seed, palette: groundPalette(), cx: this.centre.x, cz: this.centre.y, size: this.settings.size, res: this.settings.res }
      this.worker.postMessage(msg)
    }
  }

  private build(d: FarTerrainData): void {
    const n = d.res + 1
    const off = Array.from({ length: n }, (_, i) => farOffset(i, d.res, d.size))
    const cell = (i: number) => off[Math.min(n - 1, i + 1)] - off[Math.max(0, i - 1)]
    const pos = new Float32Array(n * n * 3)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i
        pos[k * 3] = d.cx + off[i]
        // Sits below the true surface by more where cells are coarse: chords over valleys never poke through.
        pos[k * 3 + 1] = d.heights[k] - 3 - 0.04 * Math.max(cell(i), cell(j))
        pos[k * 3 + 2] = d.cz + off[j]
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
