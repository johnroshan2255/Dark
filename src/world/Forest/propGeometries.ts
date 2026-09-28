import * as THREE from 'three'
import { hash4 } from '../noise/rng'
import { createFenceGeometry, createPoleGeometry } from '../Road/propMeshes'
import { createPoiGeometries } from '../POI/poiGeometry'
import { createTreeLibrary, createUndergrowth, type SpeciesDef } from './treeFactory'

/**
 * Placeholder low-poly vegetation/prop geometry built in code, until AI-generated
 * GLB assets pass the asset pipeline (skills/asset-optimization). Shared by every chunk.
 * Colours are linear albedo baked per vertex (tip darkening = cheap fake AO).
 */

const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)


export interface PropGeometries {
  /** Tree species library (5 species × 3 detail levels). */
  trees: SpeciesDef[]
  rock: THREE.BufferGeometry
  fern: THREE.BufferGeometry
  bush: THREE.BufferGeometry
  pole: THREE.BufferGeometry
  fence: THREE.BufferGeometry
  wire: THREE.LineBasicMaterial
  /** Procedural-place geometry by PropType. */
  poi: Map<number, THREE.BufferGeometry>
  dispose(): void
}

/**
 * Boulder: lumpy low-poly rock, Genshin warm-grey stone with pale tops and bright moss caps. Per-FACE colours (flat look).
 */
function makeRock(): THREE.BufferGeometry {
  const g0 = new THREE.IcosahedronGeometry(1, 1)
  const pos0 = g0.getAttribute('position')
  for (let i = 0; i < pos0.count; i++) {
    const x = pos0.getX(i), y = pos0.getY(i), z = pos0.getZ(i)
    const k = 0.72 + (hash4(Math.round(x * 100), Math.round(y * 100), Math.round(z * 100)) / 4294967296) * 0.5
    pos0.setXYZ(i, x * k * 1.15, Math.max(y * k * 0.62, -0.25), z * k)
  }
  const g = g0.index ? g0.toNonIndexed() : g0
  g.deleteAttribute('uv')
  const pos = g.getAttribute('position')
  const col = new Float32Array(pos.count * 3)
  // Genshin stone: warm light grey, pale sunlit tops, bright moss caps.
  const body = srgb(0x6a6c74), mid = srgb(0x8c8c90), top = srgb(0xb8b4a8), moss = srgb(0x6e9a3e)
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), tmp = new THREE.Color()
  for (let f = 0; f < pos.count; f += 3) {
    a.fromBufferAttribute(pos, f); b.fromBufferAttribute(pos, f + 1); c.fromBufferAttribute(pos, f + 2)
    n.crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize()
    const up = n.y
    tmp.copy(body).lerp(mid, THREE.MathUtils.smoothstep(up, -0.3, 0.35)).lerp(top, THREE.MathUtils.smoothstep(up, 0.35, 0.85))
    if (up > 0.7 && hash4(f, 7) / 4294967296 < 0.6) tmp.lerp(moss, 0.6)
    for (let k = 0; k < 3; k++) tmp.toArray(col, (f + k) * 3)
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.translate(0, 0.2, 0)
  g0.dispose()
  g.name = 'rock'
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

export function createPropGeometries(): PropGeometries {
  const lib = createTreeLibrary()
  const rock = makeRock()
  const { fern, bush } = createUndergrowth()
  const pole = createPoleGeometry()
  const fence = createFenceGeometry()
  const poi = createPoiGeometries()
  const wire = new THREE.LineBasicMaterial({ color: new THREE.Color().setHex(0x141414, THREE.SRGBColorSpace) })
  // Every geometry on the shared vegetation material must carry the billboard attributes (zeros = normal geo).
  for (const g of [fern, bush, pole, fence]) {
    const n = g.getAttribute('position').count
    if (!g.getAttribute('bbCenter')) g.setAttribute('bbCenter', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3))
    if (!g.getAttribute('bbOff')) g.setAttribute('bbOff', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2))
  }
  return {
    trees: lib.species,
    rock,
    fern,
    bush,
    pole,
    fence,
    wire,
    poi,
    dispose: () => {
      lib.dispose()
      ;[rock, fern, bush, pole, fence].forEach((g) => g.dispose())
      wire.dispose()
      poi.forEach((g) => g.dispose())
    },
  }
}
