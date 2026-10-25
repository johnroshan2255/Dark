import * as pc from 'playcanvas'
import type * as THREE from 'three'

/**
 * GEOMETRY on PlayCanvas: the game's procedural geometry builders (trees, rocks, plants, props — engine-free data in
 * three's BufferGeometry container) converted ONCE into engine meshes, cached per source geometry (shared by every
 * chunk that instances it). Colours: the builders' LINEAR floats packed as sRGB bytes (4× smaller than floats, and
 * 8-bit sRGB keeps the dark greens' precision); the materials decode them (vertexColorGamma). Extra attributes go
 * to the semantics in `extra` (attribute name → SEMANTIC_ATTRn), the shader reads them by the material's
 * setAttribute names.
 */
export const SRGB_LUT = Uint8Array.from({ length: 1024 }, (_, i) => {
  const v = i / 1023
  return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055))
})

/** Linear rgb floats (stride 3, or 4 with `alpha`) → sRGB RGBA bytes. */
export function linearToSrgbBytes(lin: ArrayLike<number>, n: number, stride = 3): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out[i * 4 + c] = SRGB_LUT[Math.min(1023, Math.max(0, Math.round(lin[i * stride + c] * 1023)))]
    out[i * 4 + 3] = stride === 4 ? Math.round(Math.min(1, Math.max(0, lin[i * stride + 3])) * 255) : 255
  }
  return out
}

const cache = new WeakMap<THREE.BufferGeometry, Map<string, pc.Mesh>>()

/** Reads an attribute (plain or interleaved) into a tight Float32Array. */
function readAttr(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const n = a.count, k = a.itemSize
  if (!('isInterleavedBufferAttribute' in a) && a.array instanceof Float32Array && a.array.length === n * k) return a.array
  const out = new Float32Array(n * k)
  for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) out[i * k + c] = a.getComponent(i, c)
  return out
}

/** The engine mesh of a three BufferGeometry (cached per geometry and `extra` map). */
export function toPcMesh(device: pc.GraphicsDevice, g: THREE.BufferGeometry, extra: Record<string, string> = {}): pc.Mesh {
  const key = JSON.stringify(extra)
  let byKey = cache.get(g)
  if (!byKey) cache.set(g, (byKey = new Map()))
  const hit = byKey.get(key)
  if (hit) return hit
  const pos = g.getAttribute('position')
  const n = pos.count
  const m = new pc.Mesh(device)
  m.setPositions(readAttr(pos))
  const nor = g.getAttribute('normal')
  if (nor) m.setNormals(readAttr(nor))
  const col = g.getAttribute('color')
  if (col) m.setColors32(linearToSrgbBytes(readAttr(col), n, col.itemSize))
  const uv = g.getAttribute('uv')
  if (uv) m.setUvs(0, readAttr(uv))
  for (const [name, semantic] of Object.entries(extra)) {
    const a = g.getAttribute(name)
    if (a) m.setVertexStream(semantic, readAttr(a), a.itemSize)
  }
  const idx = g.getIndex()
  if (idx) m.setIndices(n < 65536 ? Uint16Array.from(idx.array as ArrayLike<number>) : Uint32Array.from(idx.array as ArrayLike<number>))
  m.update(pc.PRIMITIVE_TRIANGLES, true)
  byKey.set(key, m)
  return m
}

/**
 * INSTANCE buffer layout of DARK's instanced world (trees, rocks, plants, props): the engine's instancing matrix
 * (ATTR11, 12, 14, 15 — three's column-major instanceMatrix elements as they are) + ATTR13 = instance colour (rgb,
 * linear multiplier) and w = the instance's snow weight (biome cover, computed on the CPU at its root: no biome
 * texture fetch in the shader).
 */
export function instanceFormat(device: pc.GraphicsDevice): pc.VertexFormat {
  return (fmtCache.get(device) as pc.VertexFormat | undefined) ?? fmtCache.set(device, new pc.VertexFormat(device, [
    { semantic: pc.SEMANTIC_ATTR11, components: 4, type: pc.TYPE_FLOAT32 },
    { semantic: pc.SEMANTIC_ATTR12, components: 4, type: pc.TYPE_FLOAT32 },
    { semantic: pc.SEMANTIC_ATTR14, components: 4, type: pc.TYPE_FLOAT32 },
    { semantic: pc.SEMANTIC_ATTR15, components: 4, type: pc.TYPE_FLOAT32 },
    { semantic: pc.SEMANTIC_ATTR13, components: 4, type: pc.TYPE_FLOAT32 },
  ])).get(device)!
}
const fmtCache = new WeakMap<pc.GraphicsDevice, pc.VertexFormat>()

/** Packs chunk-local matrices (16 per instance; moved to WORLD by origin) + colours + snow -> 20 floats per instance. */
export function packInstances(matrices: Float32Array, colors: Float32Array | null, snow: Float32Array | null, count: number, origin: readonly [number, number]): Float32Array {
  const data = new Float32Array(count * 20)
  for (let i = 0; i < count; i++) {
    data.set(matrices.subarray(i * 16, i * 16 + 16), i * 20)
    data[i * 20 + 12] += origin[0]
    data[i * 20 + 14] += origin[1]
    const o = i * 20 + 16
    if (colors) (data[o] = colors[i * 3]), (data[o + 1] = colors[i * 3 + 1]), (data[o + 2] = colors[i * 3 + 2])
    else data[o] = data[o + 1] = data[o + 2] = 1
    data[o + 3] = snow ? snow[i] : 0
  }
  return data
}

/** Packs matrices (16 per instance) + colours (3 per) + snow (1 per, optional) into one instance vertex buffer. */
export function instanceBuffer(device: pc.GraphicsDevice, matrices: Float32Array, colors: Float32Array | null, snow: Float32Array | null, count: number): pc.VertexBuffer {
  const data = new Float32Array(count * 20)
  for (let i = 0; i < count; i++) {
    data.set(matrices.subarray(i * 16, i * 16 + 16), i * 20)
    const o = i * 20 + 16
    if (colors) (data[o] = colors[i * 3]), (data[o + 1] = colors[i * 3 + 1]), (data[o + 2] = colors[i * 3 + 2])
    else data[o] = data[o + 1] = data[o + 2] = 1
    data[o + 3] = snow ? snow[i] : 0
  }
  return new pc.VertexBuffer(device, instanceFormat(device), count, { data })
}

/** An instanced MeshInstance (the engine's hardware instancing; culled as a whole by `aabb`, set by the caller). */
export function instancedMI(mesh: pc.Mesh, material: pc.Material, vb: pc.VertexBuffer, count: number): pc.MeshInstance {
  const mi = new pc.MeshInstance(mesh, material)
  mi.setInstancing(vb)
  mi.instancingCount = count
  return mi
}
