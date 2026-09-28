import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { SOLID_UV } from '../../rendering/materials/FoliageAtlas'
import { PropType } from './poiLayout'

/**
 * Low-poly, Genshin-bright geometry for procedural places. All on the shared vegetation/atlas material
 * (solid texel + zero billboard attributes) → no extra shader programs. One geometry per PropType.
 */
const srgb = (h: number) => new THREE.Color().setHex(h, THREE.SRGBColorSpace)

function finish(g: THREE.BufferGeometry, hex: number, shadeBottom = 0.8): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g
  if (n !== g) g.dispose()
  n.deleteAttribute('uv')
  const pos = n.getAttribute('position')
  n.computeBoundingBox()
  const { min, max } = n.boundingBox!
  const c = srgb(hex)
  const col = new Float32Array(pos.count * 3)
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - min.y) / Math.max(1e-3, max.y - min.y)
    const k = shadeBottom + (1 - shadeBottom) * t
    col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k
    uv[i * 2] = SOLID_UV[0]; uv[i * 2 + 1] = SOLID_UV[1]
  }
  n.setAttribute('color', new THREE.BufferAttribute(col, 3))
  n.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  n.setAttribute('bbCenter', new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3))
  n.setAttribute('bbOff', new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2))
  return n
}

const box = (w: number, h: number, d: number, hex: number, x = 0, y = 0, z = 0, ry = 0) =>
  finish(new THREE.BoxGeometry(w, h, d).rotateY(ry).translate(x, y + h / 2, z), hex)

/** Gable roof: triangular prism along Z, eaves overhang. */
function roof(w: number, h: number, d: number, hex: number, y: number): THREE.BufferGeometry {
  const s = new THREE.Shape()
  s.moveTo(-w / 2, 0)
  s.lineTo(w / 2, 0)
  s.lineTo(0, h)
  s.closePath()
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false }).translate(0, y, -d / 2)
  return finish(g, hex, 0.9)
}

function merged(parts: THREE.BufferGeometry[], name: string): THREE.BufferGeometry {
  const g = mergeGeometries(parts)!
  parts.forEach((p) => p.dispose())
  g.computeVertexNormals()
  g.computeBoundingSphere()
  g.name = name
  return g
}

function crossQuads(w: number, h: number, hex: number, n: number, taper = 0.3): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  for (let i = 0; i < n; i++) {
    const s = new THREE.Shape()
    s.moveTo(-w / 2, 0)
    s.lineTo(w / 2, 0)
    s.lineTo((w / 2) * taper, h)
    s.lineTo((-w / 2) * taper, h)
    s.closePath()
    parts.push(finish(new THREE.ShapeGeometry(s).rotateY((i / n) * Math.PI), hex, 0.6))
  }
  return merged(parts, 'crop')
}

export function createPoiGeometries(): Map<number, THREE.BufferGeometry> {
  const m = new Map<number, THREE.BufferGeometry>()
  m.set(PropType.House, merged([
    box(8, 4.4, 6, 0xeadcc0),
    roof(9.2, 2.8, 7, 0xc8583a, 4.4),
    box(1.2, 2.2, 0.15, 0x6a4a34, 0, 0, 3.02),
    box(1.1, 1.0, 0.12, 0x8fb8d0, -2.6, 2.0, 3.02), box(1.1, 1.0, 0.12, 0x8fb8d0, 2.6, 2.0, 3.02),
    box(0.8, 2.2, 0.8, 0x8a7a70, 2.6, 5.0, -1.2),
  ], 'house'))
  m.set(PropType.Barn, merged([
    box(10, 5.4, 8, 0xa8352e),
    roof(11, 3.4, 9, 0x4c4c56, 5.4),
    box(3.6, 3.8, 0.15, 0x7a2420, 0, 0, 4.02),
    box(0.25, 3.8, 0.2, 0xf1ece0, -1.8, 0, 4.1), box(0.25, 3.8, 0.2, 0xf1ece0, 1.8, 0, 4.1), box(3.8, 0.25, 0.2, 0xf1ece0, 0, 3.8, 4.1),
  ], 'barn'))
  m.set(PropType.Hay, merged([finish(new THREE.CylinderGeometry(0.62, 0.62, 1.2, 10).rotateZ(Math.PI / 2).translate(0, 0.62, 0), 0xd9b44a, 0.75)], 'hay'))
  m.set(PropType.Wheat, crossQuads(0.5, 0.95, 0xd8b650, 2))
  m.set(PropType.Corn, merged([crossQuads(0.35, 1.9, 0x8aa83e, 2), finish(new THREE.ConeGeometry(0.07, 0.35, 4).translate(0.05, 1.3, 0), 0xe8c85a)], 'corn'))
  m.set(PropType.Cabbage, merged([finish(new THREE.IcosahedronGeometry(0.3, 0).scale(1, 0.7, 1).translate(0, 0.2, 0), 0x6fa84a, 0.6)], 'cabbage'))
  m.set(PropType.Cabin, merged([
    box(6, 3, 5, 0x7a5236),
    roof(7, 2.2, 6, 0x3f5a3c, 3),
    box(1, 2, 0.12, 0x4a3222, 0, 0, 2.52),
    box(0.9, 0.8, 0.1, 0xf3d68a, 1.8, 1.4, 2.52), // warm lit window
    box(0.7, 2.4, 0.7, 0x7d7a78, -2.2, 3, -1.4),
  ], 'cabin'))
  m.set(PropType.Tent, merged([finish(new THREE.ConeGeometry(1.5, 1.8, 4).rotateY(Math.PI / 4).scale(1, 1, 1.3).translate(0, 0.9, 0), 0xe0762f, 0.7)], 'tent'))
  m.set(PropType.Campfire, merged([
    ...Array.from({ length: 7 }, (_, i) => box(0.25, 0.18, 0.25, 0x7c7a78, Math.cos((i / 7) * 6.28) * 0.55, 0, Math.sin((i / 7) * 6.28) * 0.55)),
    finish(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 5).rotateZ(1.3).translate(0, 0.15, 0), 0x4a3222),
    finish(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 5).rotateZ(1.3).rotateY(1.6).translate(0, 0.15, 0), 0x4a3222),
    finish(new THREE.ConeGeometry(0.28, 0.6, 5).translate(0, 0.45, 0), 0xffa030, 1),
  ], 'campfire'))
  m.set(PropType.RuinWall, merged([
    box(4, 2.2, 0.7, 0x8e8890), box(1.4, 0.9, 0.7, 0x8e8890, -1.3, 2.2, 0), box(0.9, 0.5, 0.7, 0x8e8890, 0.6, 2.2, 0),
    box(1.1, 0.4, 1.2, 0x6f8a58, -1.2, 3.1, 0), // moss cap
  ], 'ruinWall'))
  m.set(PropType.RuinPillar, merged([box(1.1, 0.4, 1.1, 0x8e8890), finish(new THREE.CylinderGeometry(0.34, 0.38, 2.4, 8).translate(0, 1.6, 0), 0xa39da2)], 'ruinPillar'))
  m.set(PropType.Woodpile, merged(Array.from({ length: 6 }, (_, i) => finish(new THREE.CylinderGeometry(0.14, 0.14, 1.4, 6).rotateX(Math.PI / 2).translate((i % 3) * 0.3 - 0.3 + (i >= 3 ? 0.15 : 0), 0.14 + (i >= 3 ? 0.26 : 0), 0), 0x7a5236)), 'woodpile'))
  return m
}

/** Collider half-extents per prop type ([hx, hy, hz] box, or [r, hh] cylinder when length 2). null = no collider. */
export const POI_COLLIDERS: Record<number, number[] | null> = {
  [PropType.House]: [4, 2.2, 3],
  [PropType.Barn]: [5, 2.7, 4],
  [PropType.Hay]: [0.6, 0.6, 0.62],
  [PropType.Cabin]: [3, 1.5, 2.5],
  [PropType.Tent]: [1.1, 0.8, 1.3],
  [PropType.RuinWall]: [2, 1.1, 0.35],
  [PropType.RuinPillar]: [0.4, 1.4],
  [PropType.Woodpile]: [0.5, 0.35, 0.7],
}
