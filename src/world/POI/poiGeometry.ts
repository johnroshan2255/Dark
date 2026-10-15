import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { SURFACE_UV, type SurfaceName } from '../../rendering/materials/FoliageAtlas'
import { PropType } from './poiLayout'
import { isBright } from '../../rendering/artStyle'

/**
 * Low-poly, Genshin-bright geometry for procedural places. All on the shared vegetation/atlas material
 * (solid texel + zero billboard attributes) → no extra shader programs. One geometry per PropType.
 * Each part names its PAINTED SURFACE (wood boards, shingle roof, stone, bark…; shaders/paint.ts).
 */
const srgb = (h: number) => new THREE.Color().setHex(h, THREE.SRGBColorSpace)

export function finish(g: THREE.BufferGeometry, hex: number, shadeBottom = 0.8, surf: SurfaceName = 'plain'): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g
  if (n !== g) g.dispose()
  n.deleteAttribute('uv')
  const pos = n.getAttribute('position')
  n.computeBoundingBox()
  const { min, max } = n.boundingBox!
  const c = srgb(hex)
  const [su, sv] = SURFACE_UV[surf]
  const col = new Float32Array(pos.count * 3)
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - min.y) / Math.max(1e-3, max.y - min.y)
    const k = shadeBottom + (1 - shadeBottom) * t
    col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k
    uv[i * 2] = su; uv[i * 2 + 1] = sv
  }
  n.setAttribute('color', new THREE.BufferAttribute(col, 3))
  n.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  n.setAttribute('bbCenter', new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3))
  n.setAttribute('bbOff', new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2))
  return n
}

const box = (w: number, h: number, d: number, hex: number, x = 0, y = 0, z = 0, surf: SurfaceName = 'plain') =>
  finish(new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z), hex, 0.8, surf)

/** Gable roof: triangular prism along Z, eaves overhang. */
function roof(w: number, h: number, d: number, hex: number, y: number): THREE.BufferGeometry {
  const s = new THREE.Shape()
  s.moveTo(-w / 2, 0)
  s.lineTo(w / 2, 0)
  s.lineTo(0, h)
  s.closePath()
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false }).translate(0, y, -d / 2)
  return finish(g, hex, 0.9, 'roof')
}

function tri(w: number, h: number): THREE.Shape {
  const s = new THREE.Shape()
  s.moveTo(-w / 2, 0)
  s.lineTo(w / 2, 0)
  s.lineTo(0, h)
  s.closePath()
  return s
}

/** A-frame roof as two thin slabs (not a solid prism, so the gable wall shows under the overhang). */
function slabs(w: number, h: number, d: number, hex: number, y: number): THREE.BufferGeometry[] {
  const len = Math.hypot(w / 2, h) + 0.25
  const ang = Math.atan2(h, w / 2)
  return [-1, 1].map((side) =>
    finish(new THREE.BoxGeometry(len, 0.22, d).rotateZ(side * -ang).translate((side * w) / 4, y + h / 2, 0), hex, 0.9, 'roof'),
  )
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

/**
 * Part on a wall face: `face` = the wall's outward normal (+z front, −z back, +x / −x sides) at half-depth `hd`;
 * u = position along the wall (left → right seen from outside), y = bottom, w × h, protruding `t` from the wall.
 */
type Face = '+z' | '-z' | '+x' | '-x'
function onWall(face: Face, hd: number, u: number, y: number, w: number, h: number, t: number, hex: number, out = 0): THREE.BufferGeometry {
  const c = hd + t / 2 + out
  if (face === '+z') return box(w, h, t, hex, u, y, c)
  if (face === '-z') return box(w, h, t, hex, -u, y, -c)
  if (face === '+x') return box(t, h, w, hex, c, y, -u)
  return box(t, h, w, hex, -c, y, u)
}

/** A framed window on a wall: glass, a white frame, a cross mullion, a sill. */
function windowOn(face: Face, hd: number, u: number, y: number, w: number, h: number, frame = 0xf2efe6, glass = 0x8fb4c8): THREE.BufferGeometry[] {
  const f = 0.11
  return [
    onWall(face, hd, u, y, w, h, 0.06, glass),
    onWall(face, hd, u, y - f, w + 2 * f, f, 0.1, frame), onWall(face, hd, u, y + h, w + 2 * f, f, 0.1, frame),
    onWall(face, hd, u - w / 2 - f / 2, y, f, h, 0.1, frame), onWall(face, hd, u + w / 2 + f / 2, y, f, h, 0.1, frame),
    onWall(face, hd, u, y + h / 2 - 0.03, w, 0.06, 0.08, frame), onWall(face, hd, u - 0.03, y, 0.06, h, 0.08, frame),
    onWall(face, hd, u, y - f - 0.06, w + 0.4, 0.08, 0.2, frame),
  ]
}

/** Vertical BOARDS covering a wall (`step` m wide, small dark gaps), each its own weathered tone and a darker,
 *  grimier foot — the wall box behind shows through the gaps. */
function boards(face: Face, hd: number, w: number, h: number, hex: number, seed: number, step = 0.32): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = []
  const base = new THREE.Color().setHex(hex)
  const n = Math.round(w / step)
  for (let i = 0; i < n; i++) {
    const r = Math.abs(Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453) % 1
    const k = 0.84 + 0.24 * r
    out.push(onWall(face, hd, -w / 2 + (i + 0.5) * (w / n), 0, w / n - 0.035, h - 0.02 * r, 0.03, base.clone().multiplyScalar(k).getHex()))
  }
  return out
}

/** Horizontal clapboard lines along a wall. */
function clapboards(face: Face, hd: number, w: number, h: number, hex: number, step = 0.42): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = []
  for (let y = step; y < h - 0.1; y += step) out.push(onWall(face, hd, 0, y, w, 0.06, 0.04, hex))
  return out
}

/** Steep gable roof as two thick slabs from the ridge past the eaves (0.55 m overhang) + white fascia and rake trim. */
function gable(w: number, h: number, d: number, y: number, hex: number, trim: number, detail: 'ribs' | 'shingles' = 'ribs'): THREE.BufferGeometry[] {
  const ang = Math.atan2(h, w / 2), ca = Math.cos(ang), sa = Math.sin(ang)
  const len = Math.hypot(w / 2, h) + 0.55, t = 0.26
  const out: THREE.BufferGeometry[] = []
  const rc = new THREE.Color().setHex(hex)
  for (const side of [-1, 1]) {
    // centre of the slab: half its length down the slope from the ridge, lifted onto the wall by half its thickness
    const cx = side * (ca * len / 2 + sa * t / 2), cy = y + h - sa * len / 2 + ca * t / 2
    out.push(finish(new THREE.BoxGeometry(len, t, d + 1.0).rotateZ(-side * ang).translate(cx, cy, 0), hex, 0.92))
    // Roof surface detail on top of the slab: standing-seam RIBS running down the slope (barn), or SHINGLE COURSES
    // along the eaves (house), each course its own tone — real roofing instead of a flat painted slab.
    const nx = side * sa, ny = ca // slab outward normal
    if (detail === 'ribs') {
      for (let z = -(d / 2 + 0.4); z <= d / 2 + 0.4; z += 0.55) out.push(finish(new THREE.BoxGeometry(len, 0.06, 0.06).rotateZ(-side * ang).translate(cx + nx * 0.15, cy + ny * 0.15, z), rc.clone().multiplyScalar(1.12).getHex(), 1))
    } else {
      for (let u = 0.3, i = 0; u < len - 0.1; u += 0.36, i++) {
        const k = 0.88 + 0.16 * ((i * 0.618) % 1)
        const px = side * ca * (u), py = y + h - sa * u
        out.push(finish(new THREE.BoxGeometry(0.4, 0.05, d + 1.0).rotateZ(-side * ang).translate(px + nx * 0.15, py + ny * 0.15, 0), rc.clone().multiplyScalar(k).getHex(), 1))
      }
    }
    for (const z of [-(d / 2 + 0.52), d / 2 + 0.52]) out.push(finish(new THREE.BoxGeometry(len, 0.16, 0.12).rotateZ(-side * ang).translate(cx - side * sa * 0.12, cy - ca * 0.12, z), trim, 1))
    const ex = side * ca * len, ey = y + h - sa * len
    out.push(finish(new THREE.BoxGeometry(0.14, 0.32, d + 1.04).translate(ex, ey, 0), trim, 1))
  }
  return out
}

/** BRIGHT (over the hill) farm buildings: board-and-batten / clapboard siding, white trim, framed windows. */
function othBarn(): THREE.BufferGeometry {
  // Weathered barn red-orange (their barn ≈ 227,124,69 lit), warm grey roof, off-white trim — muted, not toy colours.
  const W = 10, D = 8, H = 5.4, RH = 4.4, red = 0xb0563a, dark = 0x5a2618, white = 0xe8e0d0, roofC = 0x6a625c
  const parts: THREE.BufferGeometry[] = [
    box(W, H, D, dark),
    finish(new THREE.ExtrudeGeometry(tri(W, RH), { depth: D, bevelEnabled: false }).translate(0, H, -D / 2), red, 0.95),
    ...gable(W, RH, D, H, roofC, white, 'ribs'),
    ...boards('+z', D / 2, W, H, red, 1), ...boards('-z', D / 2, W, H, red, 2), ...boards('+x', W / 2, D, H, red, 3), ...boards('-x', W / 2, D, H, red, 4),
    box(W + 0.2, 0.35, D + 0.2, 0x7a746a), // stone sill
  ]
  // corner boards
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) parts.push(box(0.26, H, 0.26, white, x * (W / 2 + 0.02), 0, z * (D / 2 + 0.02)))
  // big sliding door with a white frame and X brace, loft door above
  parts.push(onWall('+z', D / 2, 0, 0, 3.8, 3.9, 0.12, 0x7a3624, 0.03))
  parts.push(onWall('+z', D / 2, -1.95, 0, 0.18, 3.9, 0.2, white), onWall('+z', D / 2, 1.95, 0, 0.18, 3.9, 0.2, white), onWall('+z', D / 2, 0, 3.9, 4.1, 0.18, 0.2, white))
  const brace = Math.hypot(3.7, 3.8), ba = Math.atan2(3.8, 3.7)
  for (const sg of [-1, 1]) parts.push(finish(new THREE.BoxGeometry(brace, 0.16, 0.1).rotateZ(sg * ba).translate(0, 1.95, D / 2 + 0.2), white, 1))
  parts.push(onWall('+z', D / 2, 0, 0, 0.12, 3.8, 0.18, white))
  parts.push(...windowOn('+z', D / 2, 0, 5.7, 1.3, 1.3, white, 0x6a2a1a))
  // windows along the sides and the back
  for (const u of [-2.2, 2.2]) parts.push(...windowOn('+x', W / 2, u, 2.3, 1.0, 1.1), ...windowOn('-x', W / 2, u, 2.3, 1.0, 1.1))
  parts.push(...windowOn('-z', D / 2, -2.5, 2.4, 1.0, 1.1), ...windowOn('-z', D / 2, 2.5, 2.4, 1.0, 1.1))
  // cupola on the ridge
  parts.push(box(1.2, 1.0, 1.2, white, 0, H + RH - 0.35, 0), finish(new THREE.ConeGeometry(1.05, 0.8, 4).rotateY(Math.PI / 4).translate(0, H + RH + 1.05, 0), roofC, 0.9))
  parts.push(box(1.4, 0.3, 0.14, 0x3c4048, 0, 0, D / 2 + 0.6)) // door track kicker
  return merged(parts, 'barn')
}

function othHouse(): THREE.BufferGeometry {
  const W = 8, D = 6, H = 4.4, RH = 3.0, wall = 0xe2d6bc, line = 0xbcae92, white = 0xeee8da, roofC = 0x7a4032, shut = 0x44606a
  const parts: THREE.BufferGeometry[] = [
    box(W, H, D, wall),
    finish(new THREE.ExtrudeGeometry(tri(W, RH), { depth: D, bevelEnabled: false }).translate(0, H, -D / 2), wall, 0.95),
    ...gable(W, RH, D, H, roofC, white, 'shingles'),
    ...clapboards('+z', D / 2, W, H, line), ...clapboards('-z', D / 2, W, H, line), ...clapboards('+x', W / 2, D, H, line), ...clapboards('-x', W / 2, D, H, line),
    box(W + 0.3, 0.45, D + 0.3, 0x8a8478, 0, 0, 0), // foundation
  ]
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) parts.push(box(0.22, H, 0.22, white, x * (W / 2 + 0.02), 0, z * (D / 2 + 0.02)))
  // door + porch (deck, two posts, a small shed roof)
  parts.push(onWall('+z', D / 2, 0, 0.45, 1.1, 2.2, 0.1, 0x5a7a44), onWall('+z', D / 2, 0, 2.65, 1.4, 0.16, 0.16, white))
  parts.push(box(3.4, 0.25, 1.8, 0x7a5a40, 0, 0.2, D / 2 + 0.9), box(3.6, 0.14, 2.1, roofC, 0, 2.95, D / 2 + 1.0))
  for (const x of [-1.5, 1.5]) parts.push(box(0.16, 2.5, 0.16, white, x, 0.45, D / 2 + 1.7))
  // windows with shutters
  for (const u of [-2.6, 2.6]) {
    parts.push(...windowOn('+z', D / 2, u, 1.5, 1.0, 1.25, white))
    parts.push(onWall('+z', D / 2, u - 0.85, 1.4, 0.42, 1.45, 0.06, shut), onWall('+z', D / 2, u + 0.85, 1.4, 0.42, 1.45, 0.06, shut))
  }
  for (const u of [-1.4, 1.4]) parts.push(...windowOn('+x', W / 2, u, 1.6, 0.9, 1.15, white), ...windowOn('-x', W / 2, u, 1.6, 0.9, 1.15, white))
  parts.push(...windowOn('-z', D / 2, 0, 1.6, 1.0, 1.15, white), ...windowOn('+z', D / 2, 0, H + 0.6, 0.8, 0.8, white))
  parts.push(box(0.8, 2.6, 0.8, 0x8a5a48, 2.6, H + 0.8, -1.2), box(1.0, 0.18, 1.0, 0x6a6460, 2.6, H + 3.4, -1.2))
  return merged(parts, 'house')
}

export function createPoiGeometries(): Map<number, THREE.BufferGeometry> {
  const m = new Map<number, THREE.BufferGeometry>()
  if (isBright()) {
    m.set(PropType.House, othHouse())
    m.set(PropType.Barn, othBarn())
  } else {
  m.set(PropType.House, merged([
    box(8, 4.4, 6, 0xeadcc0, 0, 0, 0, 'wood'),
    roof(9.2, 2.8, 7, 0xc8583a, 4.4),
    box(1.2, 2.2, 0.15, 0x6a4a34, 0, 0, 3.02, 'wood'),
    box(1.1, 1.0, 0.12, 0x8fb8d0, -2.6, 2.0, 3.02), box(1.1, 1.0, 0.12, 0x8fb8d0, 2.6, 2.0, 3.02),
    box(0.8, 2.2, 0.8, 0x8a7a70, 2.6, 5.0, -1.2, 'stone'),
  ], 'house'))
  m.set(PropType.Barn, merged([
    box(10, 5.4, 8, 0xa8352e, 0, 0, 0, 'wood'),
    roof(11, 3.4, 9, 0x4c4c56, 5.4),
    box(3.6, 3.8, 0.15, 0x7a2420, 0, 0, 4.02, 'wood'),
    box(0.25, 3.8, 0.2, 0xf1ece0, -1.8, 0, 4.1), box(0.25, 3.8, 0.2, 0xf1ece0, 1.8, 0, 4.1), box(3.8, 0.25, 0.2, 0xf1ece0, 0, 3.8, 4.1),
  ], 'barn'))
  }
  m.set(PropType.Hay, merged([finish(new THREE.CylinderGeometry(0.62, 0.62, 1.2, isBright() ? 14 : 10).rotateZ(Math.PI / 2).translate(0, 0.62, 0), isBright() ? 0xc4a868 : 0xd9b44a, 0.75)], 'hay'))
  m.set(PropType.Wheat, crossQuads(0.5, 0.95, 0xd8b650, 2))
  m.set(PropType.Corn, merged([crossQuads(0.35, 1.9, 0x8aa83e, 2), finish(new THREE.ConeGeometry(0.07, 0.35, 4).translate(0.05, 1.3, 0), 0xe8c85a)], 'corn'))
  m.set(PropType.Cabbage, merged([finish(new THREE.IcosahedronGeometry(0.3, 0).scale(1, 0.7, 1).translate(0, 0.2, 0), 0x6fa84a, 0.6)], 'cabbage'))
  // Forest A-FRAME cabin (the forest-house study): steep shingled roof slabs almost to the ground, overhanging
  // a slate-blue plank gable with door + warm window, a porch deck with a step, stone chimney. ~150 tris.
  const slate = 0x4f6a86, trim = 0x2e3e52, deck = 0x6a5442
  m.set(PropType.Cabin, merged([
    box(6.4, 0.3, 5.6, deck, 0, 0, 0, 'wood'),
    finish(new THREE.ExtrudeGeometry(tri(5.8, 4.9), { depth: 5.0, bevelEnabled: false }).translate(0, 0.3, -2.5), slate, 0.8, 'wood'),
    ...slabs(6.6, 5.2, 5.9, 0x6f8a6a, 0.25),
    box(1.1, 2.1, 0.12, trim, 0, 0.3, 2.52, 'wood'),
    box(0.9, 0.75, 0.1, 0xf3d68a, 0, 2.9, 2.52), // warm lit window
    box(3.2, 0.22, 1.3, deck, 0, 0.08, 3.4, 'wood'),
    box(1.4, 0.14, 0.5, deck, 0, 0, 4.25, 'wood'),
    box(0.6, 1.8, 0.6, 0x7d7a78, 1.3, 3.4, -1.3, 'stone'),
  ], 'cabin'))
  m.set(PropType.Tent, merged([finish(new THREE.ConeGeometry(1.5, 1.8, 4).rotateY(Math.PI / 4).scale(1, 1, 1.3).translate(0, 0.9, 0), 0xe0762f, 0.7)], 'tent'))
  m.set(PropType.Campfire, merged([
    ...Array.from({ length: 7 }, (_, i) => box(0.25, 0.18, 0.25, 0x7c7a78, Math.cos((i / 7) * 6.28) * 0.55, 0, Math.sin((i / 7) * 6.28) * 0.55, 'stone')),
    finish(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 5).rotateZ(1.3).translate(0, 0.15, 0), 0x4a3222, 0.8, 'bark'),
    finish(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 5).rotateZ(1.3).rotateY(1.6).translate(0, 0.15, 0), 0x4a3222, 0.8, 'bark'),
    finish(new THREE.ConeGeometry(0.28, 0.6, 5).translate(0, 0.45, 0), 0xffa030, 1),
  ], 'campfire'))
  m.set(PropType.RuinWall, merged([
    box(4, 2.2, 0.7, 0x8e8890, 0, 0, 0, 'stone'), box(1.4, 0.9, 0.7, 0x8e8890, -1.3, 2.2, 0, 'stone'), box(0.9, 0.5, 0.7, 0x8e8890, 0.6, 2.2, 0, 'stone'),
    box(1.1, 0.4, 1.2, 0x6f8a58, -1.2, 3.1, 0, 'stone'), // moss cap
  ], 'ruinWall'))
  m.set(PropType.RuinPillar, merged([box(1.1, 0.4, 1.1, 0x8e8890, 0, 0, 0, 'stone'), finish(new THREE.CylinderGeometry(0.34, 0.38, 2.4, 8).translate(0, 1.6, 0), 0xa39da2, 0.8, 'stone')], 'ruinPillar'))
  m.set(PropType.Woodpile, merged(Array.from({ length: 6 }, (_, i) => finish(new THREE.CylinderGeometry(0.14, 0.14, 1.4, 6).rotateX(Math.PI / 2).translate((i % 3) * 0.3 - 0.3 + (i >= 3 ? 0.15 : 0), 0.14 + (i >= 3 ? 0.26 : 0), 0), 0x7a5236, 0.8, 'bark')), 'woodpile'))
  return m
}

/** Collider half-extents per prop type ([hx, hy, hz] box, or [r, hh] cylinder when length 2). null = no collider. */
export const POI_COLLIDERS: Record<number, number[] | null> = {
  [PropType.House]: [4, 2.2, 3],
  [PropType.Barn]: [5, 2.7, 4],
  [PropType.Hay]: [0.6, 0.6, 0.62],
  [PropType.Cabin]: [3.2, 2.2, 2.8],
  [PropType.Tent]: [1.1, 0.8, 1.3],
  [PropType.RuinWall]: [2, 1.1, 0.35],
  [PropType.RuinPillar]: [0.4, 1.4],
  [PropType.Woodpile]: [0.5, 0.35, 0.7],
}
