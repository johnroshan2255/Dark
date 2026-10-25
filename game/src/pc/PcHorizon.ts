import * as pc from 'playcanvas'
import { activeMap } from '../world/map/FixedMap'
import { CHUNK_SIZE } from '../world/constants'
import { WorldFields } from '../world/WorldFields'
import type { FarRequest } from '../world/Streaming/chunk.worker'
import { groundPalette } from '../rendering/artStyle'
import { farOffset, type FarTerrainData } from '../world/Terrain/horizonGen'
import { applyWorldLook } from './materials/common'
import { linearToSrgbBytes } from './geometry'

/**
 * The HORIZON terrain on PlayCanvas — the three build's HorizonTerrain (its own worker, horizonGen's warped grid out
 * to `size`, re-centred every ~size/16 on the chunk grid, double-buffered): ONE mesh on the world look, its fragments
 * discarded inside the built chunk square (the hole), pushed back by a depth bias so the chunks win where they
 * overlap, its far forests painted as soft round crowns per ~11 m cell (fading to their mean colour under ~1.5 px).
 */
const DECL_VS = /* glsl */ `
attribute vec4 aCanopy;
varying vec4 vCanopy;
`
const MAIN_END_VS = /* glsl */ `
  vCanopy = aCanopy;
`
const DECL_PS = /* glsl */ `
uniform vec4 uHole;
varying vec4 vCanopy;
`
const ALBEDO_PS = /* glsl */ `
uniform vec3 material_diffuse;
void getAlbedo() {
  vec2 xz = vPositionW.xz;
  if (xz.x > uHole.x && xz.x < uHole.z && xz.y > uHole.y && xz.y < uHole.w) discard;
  vec3 c = material_diffuse.rgb;
  #ifdef STD_DIFFUSE_VERTEX
    c *= saturate(vVertexColor.{STD_DIFFUSE_VERTEX_CHANNEL});
  #endif
  if (vCanopy.a > 0.01) {
    vec2 cp = xz / 11.0;
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
    vec3 canopyC = mix(vCanopy.rgb * 1.6, c, 0.35);
    vec3 lit = canopyC * (0.8 + 0.5 * clamp(0.55 - dot(q / r, vec2(0.55, 0.45)), 0.0, 1.0));
    vec3 dotted = mix(c * (1.0 - 0.18 * sh), lit, crown * 0.7);
    vec3 mean = mix(c, canopyC, vCanopy.a * 0.4);
    c = mix(dotted, mean, smoothstep(0.35, 0.8, px));
  }
  dAlbedo = c;
}
`

export class PcHorizon {
  private readonly material: pc.StandardMaterial
  private readonly worker: Worker | null
  private readonly run: (msg: FarRequest) => void
  private pendingId = 0
  private cx = Number.NaN
  private cz = Number.NaN
  private mi: pc.MeshInstance | null = null
  private readonly node = new pc.GraphNode('horizon')
  private readonly layer: pc.Layer
  private readonly hole = new Float32Array(4)
  size = 2400
  res = 64

  /** @param runner the far-terrain requests on a shared worker pool (ChunkStreamer.side); else its own worker (viewer) */
  constructor(private readonly app: pc.AppBase, private readonly seed: number, runner?: (msg: FarRequest) => Promise<{ id: number; far: FarTerrainData }>) {
    this.layer = app.scene.layers.getLayerById(pc.LAYERID_WORLD)!
    const m = new pc.StandardMaterial()
    m.name = 'farTerrain'
    m.diffuse = new pc.Color(1, 1, 1)
    m.diffuseVertexColor = true
    ;(m as unknown as { vertexColorGamma: boolean }).vertexColorGamma = true
    m.depthBias = 4
    m.slopeDepthBias = 4
    applyWorldLook(m, { rim: 0.2, toon: 0.45, declVS: DECL_VS, mainEndVS: MAIN_END_VS, declPS: DECL_PS })
    m.getShaderChunks(pc.SHADERLANGUAGE_GLSL).set('diffusePS', ALBEDO_PS)
    m.setAttribute('aCanopy', pc.SEMANTIC_ATTR8)
    m.update()
    this.material = m
    const receive = (d: { id: number; far: FarTerrainData }) => {
      if (d.id === this.pendingId && d.far) this.build(d.far)
    }
    if (runner) {
      this.worker = null
      this.run = (msg) => void runner(msg).then(receive)
    } else {
      const w = (this.worker = new Worker(new URL('../world/Streaming/chunk.worker.ts', import.meta.url), { type: 'module' }))
      w.onmessage = (e: MessageEvent<{ id: number; far: FarTerrainData }>) => receive(e.data)
      this.run = (msg) => w.postMessage(msg)
    }
  }

  /** @param builtRadius chunks round the focus that are drawn by the streamed world (the hole). */
  update(x: number, z: number, builtRadius: number): void {
    const pcx = Math.floor(x / CHUNK_SIZE), pcz = Math.floor(z / CHUNK_SIZE), r = Math.max(0, builtRadius)
    this.hole.set([(pcx - r) * CHUNK_SIZE, (pcz - r) * CHUNK_SIZE, (pcx + r + 1) * CHUNK_SIZE, (pcz + r + 1) * CHUNK_SIZE])
    this.material.setParameter('uHole', this.hole)
    if (!(Math.hypot(x - this.cx, z - this.cz) < Math.max(96, this.size / 16))) {
      this.cx = Math.round(x / CHUNK_SIZE) * CHUNK_SIZE
      this.cz = Math.round(z / CHUNK_SIZE) * CHUNK_SIZE
      const msg: FarRequest = { type: 'far', id: ++this.pendingId, seed: this.seed, palette: groundPalette(), cx: this.cx, cz: this.cz, size: this.size, res: this.res, map: activeMap() }
      this.run(msg)
    }
  }

  dispose(): void {
    this.worker?.terminate()
    if (this.mi) {
      this.layer.removeMeshInstances([this.mi])
      this.mi.destroy()
      this.mi = null
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
        const h = d.heights[k]
        const low = h - 3 - 0.04 * Math.max(cell(i), cell(j))
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
    const m = new pc.Mesh(this.app.graphicsDevice)
    m.setPositions(pos)
    m.setNormals(pc.calculateNormals(pos as unknown as number[], idx as unknown as number[]))
    m.setColors32(linearToSrgbBytes(d.colors, n * n))
    m.setVertexStream(pc.SEMANTIC_ATTR8, d.canopy, 4)
    m.setIndices(idx)
    m.update(pc.PRIMITIVE_TRIANGLES, true)
    const mi = new pc.MeshInstance(m, this.material, this.node)
    mi.castShadow = false
    if (this.mi) {
      this.layer.removeMeshInstances([this.mi])
      this.mi.destroy()
    }
    this.layer.addMeshInstances([mi])
    this.mi = mi
  }
}
