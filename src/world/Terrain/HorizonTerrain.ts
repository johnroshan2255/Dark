import * as THREE from 'three'
import { stylize } from '../../rendering/shaders/stylize'
import { CHUNK_SIZE } from '../constants'
import { WorldFields } from '../WorldFields'
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
        .replace('#include <common>', '#include <common>\nattribute vec4 canopy; varying vec2 vFarXZ; varying vec4 vCanopy;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvFarXZ = (modelMatrix * vec4(transformed, 1.0)).xz; vCanopy = canopy;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec4 uHole; varying vec2 vFarXZ; varying vec4 vCanopy;')
        .replace('void main() {', 'void main() {\n  if (vFarXZ.x > uHole.x && vFarXZ.x < uHole.z && vFarXZ.y > uHole.y && vFarXZ.y < uHole.w) discard;')
        .replace('#include <color_fragment>', `#include <color_fragment>
  // DISTANT TREE CROWNS (Genshin vistas: every far hill is dotted with trees, not a flat green): one round crown
  // per ~11 m cell where the forest density allows, lit on its sun side, darker below, with a soft shadow next to
  // it. Where crowns shrink under ~1.5 px the pattern fades to its mean colour (no shimmer). ~25 ALU, far mesh only.
  if (vCanopy.a > 0.01) {
    vec2 cp = vFarXZ / 11.0;
    vec2 ci = floor(cp);
    float h1 = fract(sin(dot(ci, vec2(127.1, 311.7))) * 43758.5453);
    float h2 = fract(sin(dot(ci, vec2(269.5, 183.3))) * 43758.5453);
    vec2 q = fract(cp) - 0.5 - (vec2(h1, h2) - 0.5) * 0.45;
    float r = 0.27 + 0.16 * h2;
    float d = length(q) / r;
    float px = max(fwidth(cp.x), fwidth(cp.y)) / r;
    float tree = step(h1, vCanopy.a);
    float crown = (1.0 - smoothstep(1.0 - px, 1.0 + px, d)) * tree;
    float sh = (1.0 - smoothstep(0.8, 1.3, length(q - vec2(0.12, 0.1)) / r)) * tree * (1.0 - crown);
    // Soft, not spotty: crowns are only part-way to the canopy colour (lifted toward the ground's), the shadow
    // is faint — far hills read as wooded texture, not as dark holes (they looked like distant objects).
    vec3 canopyC = mix(vCanopy.rgb * 1.6, diffuseColor.rgb, 0.35);
    vec3 lit = canopyC * (0.8 + 0.5 * clamp(0.55 - dot(q / r, vec2(0.55, 0.45)), 0.0, 1.0));
    vec3 dotted = mix(diffuseColor.rgb * (1.0 - 0.18 * sh), lit, crown * 0.7);
    vec3 mean = mix(diffuseColor.rgb, canopyC, vCanopy.a * 0.4);
    diffuseColor.rgb = mix(dotted, mean, smoothstep(0.35, 0.8, px));
  }`)
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
        // Sits below the true surface by more where cells are coarse: chords over valleys never poke through —
        // but DRY land never sinks under the water plane (it used to: every low meadow within ~11 m of the water
        // level flooded in the distance, so vistas read as a grey sea with green islands).
        const h = d.heights[k]
        const low = h - 3 - 0.04 * Math.max(cell(i), cell(j))
        // And on COARSE cells (LOW's 40² grid: 60–200 m) a lake vertex stays just under the surface — a deep one
        // dragged every triangle to its dry neighbours under water, so far lakes ballooned into a sea.
        const cs = Math.max(cell(i), cell(j))
        pos[k * 3 + 1] = h > WorldFields.WATER ? Math.max(low, Math.min(h, WorldFields.WATER + 0.3)) : cs > 30 ? Math.max(low, WorldFields.WATER - 0.6) : low
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
    g.setAttribute('canopy', new THREE.BufferAttribute(d.canopy, 4))
    g.setIndex(new THREE.BufferAttribute(idx, 1))
    g.computeVertexNormals()
    g.computeBoundingSphere()
    this.mesh.geometry.dispose()
    this.mesh.geometry = g
    this.mesh.visible = true
    this.grid = { pos, n, res: d.res, size: d.size, cx: d.cx, cz: d.cz }
    this.version++
  }

  /** Rebuild counter (the far forest re-seats its trees on a new horizon surface). */
  version = 0
  private grid: { pos: Float32Array; n: number; res: number; size: number; cx: number; cz: number } | null = null

  /**
   * Height of the DRAWN horizon surface at (x, z) (the same triangles as the mesh), or null outside it / before the
   * first build. The far forest stands its trees on it: the warped grid is 40–70 m coarse at 200–700 m and sits a
   * few metres under the true ground, so trees placed at the true height float over convex hills.
   */
  heightAt(x: number, z: number): number | null {
    const g = this.grid
    if (!g) return null
    const inv = (o: number) => {
      const t = o / (g.size * 0.5)
      return ((Math.sign(t) * Math.sqrt(Math.min(1, Math.abs(t))) + 1) * g.res) / 2
    }
    const gi = inv(x - g.cx), gj = inv(z - g.cz)
    if (gi < 0 || gj < 0 || gi >= g.res || gj >= g.res) return null
    const i = Math.floor(gi), j = Math.floor(gj)
    const P = (ii: number, jj: number) => g.pos[(jj * g.n + ii) * 3 + 1]
    // Local position inside the (non-uniform) cell, in real distances.
    const X = (ii: number) => g.pos[(j * g.n + ii) * 3], Z = (jj: number) => g.pos[(jj * g.n + i) * 3 + 2]
    const fx = (x - X(i)) / Math.max(1e-3, X(i + 1) - X(i)), fz = (z - Z(j)) / Math.max(1e-3, Z(j + 1) - Z(j))
    // Triangles (a, c, b) and (b, c, e) — split along b–c, as in build().
    const a = P(i, j), b = P(i + 1, j), c = P(i, j + 1), e = P(i + 1, j + 1)
    return fx + fz < 1 ? a + (b - a) * fx + (c - a) * fz : e + (c - e) * (1 - fx) + (b - e) * (1 - fz)
  }

  dispose(): void {
    this.worker.terminate()
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
