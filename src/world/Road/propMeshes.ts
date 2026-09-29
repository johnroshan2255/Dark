import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { isStorybook } from '../../rendering/artStyle'
import { SOLID_UV, SURFACE_UV } from '../../rendering/materials/FoliageAtlas'
import { CHUNK_SIZE } from '../constants'
import type { ChunkData } from '../types'
import type { WorldFields } from '../WorldFields'
import { POLE_LATERAL, POLE_SPACING, RoadProp, roadYaw } from './roadProps'

/**
 * Geometry for roadside props, on the shared vegetation (atlas) material via the atlas's opaque texel, so
 * they add no shader program. Wires are LineSegments (1 draw per chunk, no lighting needed).
 */
const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)

function part(g: THREE.BufferGeometry, color: number, shadeBottom = 0.75, surf: readonly [number, number] = SOLID_UV): THREE.BufferGeometry {
  const ng = g.toNonIndexed()
  g.dispose()
  const pos = ng.getAttribute('position')
  const n = pos.count
  const col = new Float32Array(n * 3)
  const uv = new Float32Array(n * 2)
  ng.computeBoundingBox()
  const { min, max } = ng.boundingBox!
  const c = srgb(color)
  for (let i = 0; i < n; i++) {
    const t = (pos.getY(i) - min.y) / Math.max(1e-3, max.y - min.y)
    const k = shadeBottom + (1 - shadeBottom) * t
    col[i * 3] = c.r * k
    col[i * 3 + 1] = c.g * k
    col[i * 3 + 2] = c.b * k
    uv[i * 2] = surf[0]
    uv[i * 2 + 1] = surf[1]
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3))
  ng.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return ng
}

export const WIRE_ATTACH: [number, number][] = [[-1.05, 8.95], [0, 8.95], [1.05, 8.95]]

export function createPoleGeometry(): THREE.BufferGeometry {
  const parts = [
    part(new THREE.CylinderGeometry(0.12, 0.17, 9.6, 7).translate(0, 4.8, 0), isStorybook() ? 0xa8502e : 0x5b4a3a, 0.6, SURFACE_UV.bark),
    part(new THREE.BoxGeometry(2.6, 0.14, 0.14).translate(0, 8.75, 0), isStorybook() ? 0xb85a36 : 0x4e4033, 0.75, SURFACE_UV.bark),
    ...WIRE_ATTACH.map(([x, y]) => part(new THREE.CylinderGeometry(0.05, 0.06, 0.2, 5).translate(x, y - 0.1, 0), 0x9aa3ad, 0.9)),
  ]
  const g = mergeGeometries(parts)!
  parts.forEach((p) => p.dispose())
  g.name = 'utility-pole'
  g.computeBoundingSphere()
  return g
}

export function createFenceGeometry(): THREE.BufferGeometry {
  const wood = 0x6d5a45
  const parts = [
    part(new THREE.BoxGeometry(0.14, 1.25, 0.14).translate(0, 0.62, -2), wood, 0.55, SURFACE_UV.bark),
    part(new THREE.BoxGeometry(0.07, 0.12, 4.05).translate(0, 0.48, 0).rotateX(0.01), wood, 0.85),
    part(new THREE.BoxGeometry(0.07, 0.12, 4.05).translate(0, 0.98, 0).rotateX(-0.012), wood, 0.9),
  ]
  const g = mergeGeometries(parts)!
  parts.forEach((p) => p.dispose())
  g.name = 'fence-segment'
  g.computeBoundingSphere()
  return g
}

/**
 * Sagging wires from every pole in this chunk to the next pole down the road (computed analytically, so spans
 * crossing into the next chunk need no neighbour data). Chunk-local positions.
 */
export function buildWires(d: ChunkData, fields: WorldFields, material: THREE.LineBasicMaterial): THREE.LineSegments | null {
  const p = d.props
  const pts: number[] = []
  const ox = d.cx * CHUNK_SIZE
  const oz = d.cz * CHUNK_SIZE
  const SEG = 10
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  for (let i = 0; i < p.length; i += 6) {
    if (p[i + 5] !== RoadProp.Pole) continue
    const wz0 = p[i + 2] + oz
    const wz1 = wz0 + POLE_SPACING
    const wx1 = fields.roadCenterX(wz1) + POLE_LATERAL
    const y1 = fields.height(wx1, wz1)
    const r0 = p[i + 3]
    const r1 = roadYaw(fields, wz1)
    for (const [ax, ay] of WIRE_ATTACH) {
      a.set(p[i] + Math.cos(r0) * ax, p[i + 1] + ay, p[i + 2] - Math.sin(r0) * ax)
      b.set(wx1 - ox + Math.cos(r1) * ax, y1 + ay, wz1 - oz - Math.sin(r1) * ax)
      let px = a.x, py = a.y, pz = a.z
      for (let s = 1; s <= SEG; s++) {
        const t = s / SEG
        const x = a.x + (b.x - a.x) * t
        const z = a.z + (b.z - a.z) * t
        const y = a.y + (b.y - a.y) * t - 1.1 * 4 * t * (1 - t)
        pts.push(px, py, pz, x, y, z)
        px = x; py = y; pz = z
      }
    }
  }
  if (!pts.length) return null
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  g.computeBoundingSphere()
  const lines = new THREE.LineSegments(g, material)
  lines.name = 'wires'
  return lines
}
