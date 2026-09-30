import * as THREE from 'three'
import { hashFloat } from '../../world/noise/rng'

/**
 * Builds per-chunk InstancedMeshes from packed placement arrays
 * ([x, y, z, rotY, scale, ...] with a given stride).
 *
 * LOD variants of one species SHARE the same instanceMatrix / instanceColor attributes,
 * so the GPU buffer is uploaded once and switching LOD costs nothing but a visibility flip.
 * Chunk-level culling decides main-view visibility; each mesh still gets a bounding sphere over its
 * instances and frustumCulled = true so the SHADOW passes cull casters outside the light frustum
 * (otherwise every LOD0 chunk's trees are drawn into the sun map — measured +36 draws on LOW).
 * Cost: one sphere test per mesh per pass (a few hundred per frame).
 */

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _e = new THREE.Euler()
const _c = new THREE.Color()
const _t: [number, number, number] = [1, 1, 1]

/** Vertical scale jitter of record `k` when `shape` = 0 (rocks): PhysicsWorld builds the rock hulls with the same factor. */
export function instanceYScale(k: number): number {
  return 0.9 + 0.2 * hashFloat(k, 7)
}

export interface InstanceAttributes {
  matrix: THREE.InstancedBufferAttribute
  color: THREE.InstancedBufferAttribute
  count: number
}

export function buildInstanceAttributes(
  data: Float32Array,
  stride: number,
  filter?: (i: number) => boolean,
  tint = 0.18,
  /** Shape variation: independent width/height scale ±shape and a lean of up to shape×12°. */
  shape = 0,
  /** Hue palette (linear RGB multipliers) picked per ~20 m stand + per tree → clustered colour variety. */
  hues?: readonly (readonly [number, number, number])[],
  /** World origin of the chunk (x, z) — colour stands must be keyed by WORLD position, not chunk-local. */
  origin: readonly [number, number] = [0, 0],
  /** Extra per-instance colour multiplier from the record offset (biome tints: frosted / sun-dried). */
  tintAt?: (o: number, out: [number, number, number]) => void,
): InstanceAttributes | null {
  const total = data.length / stride
  let count = 0
  for (let k = 0; k < total; k++) if (!filter || filter(k * stride)) count++
  if (count === 0) return null
  const matrices = new Float32Array(count * 16)
  const colors = new Float32Array(count * 3)
  let n = 0
  for (let k = 0; k < total; k++) {
    const o = k * stride
    if (filter && !filter(o)) continue
    _p.set(data[o], data[o + 1], data[o + 2])
    const sc = data[o + 4]
    if (shape > 0) {
      const lean = (hashFloat(k, 11) - 0.5) * shape * 0.42
      _e.set(lean, data[o + 3], (hashFloat(k, 13) - 0.5) * shape * 0.42, 'YXZ')
      _q.setFromEuler(_e)
      const wide = 1 + (hashFloat(k, 17) - 0.5) * 2 * shape
      _s.set(sc * wide, sc * (1 + (hashFloat(k, 7) - 0.35) * 2 * shape), sc * wide)
    } else {
      _q.setFromAxisAngle(_up, data[o + 3])
      _s.set(sc, sc * instanceYScale(k), sc)
    }
    _m.compose(_p, _q, _s).toArray(matrices, n * 16)
    let v = 1 - tint + tint * 2 * hashFloat(k, 3)
    let bx = 1, by = 1, bz = 1
    if (tintAt) {
      tintAt(o, _t)
      bx = _t[0]; by = _t[1]; bz = _t[2]
    }
    if (hues) {
      const wx = Math.floor(data[o] + origin[0]), wz = Math.floor(data[o + 2] + origin[1])
      const stand = hashFloat(Math.floor(wx / 28), Math.floor(wz / 28), 71)
      const pick = hashFloat(wx, wz, 9) < 0.65 ? stand : hashFloat(wx, wz, 13) // 65 % follow the stand, 35 % individual
      const hh = hues[Math.min(hues.length - 1, Math.floor(pick * hues.length))]
      _c.setRGB(v * hh[0] * bx, v * hh[1] * by, v * hh[2] * bz).toArray(colors, n * 3)
    } else {
      _c.setRGB(v * bx, v * (0.97 + 0.06 * hashFloat(k, 5)) * by, v * bz).toArray(colors, n * 3)
    }
    n++
  }
  return {
    matrix: new THREE.InstancedBufferAttribute(matrices, 16),
    color: new THREE.InstancedBufferAttribute(colors, 3),
    count,
  }
}

export function createInstancedMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  attrs: InstanceAttributes,
  name: string,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, attrs.count)
  mesh.instanceMatrix = attrs.matrix
  mesh.instanceColor = attrs.color
  mesh.computeBoundingSphere()
  mesh.frustumCulled = true
  mesh.matrixAutoUpdate = false
  mesh.name = name
  return mesh
}
