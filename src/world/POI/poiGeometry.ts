import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { GLOW_UV, SURFACE_UV, type SurfaceName } from '../../rendering/materials/FoliageAtlas'
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

/** A part on the GLOW surface (FoliageAtlas GLOW_UV: emissive in the shader, bloom on MEDIUM+) — lit windows. */
function glow(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setXY(i, GLOW_UV[0], GLOW_UV[1])
  return g
}

/** A thick roof slab from (x0, y0) to (x1, y1) (the eave end extended by `over`), depth d, with standing-seam ribs. */
function roofSlab(x0: number, y0: number, x1: number, y1: number, d: number, hex: number, trim: number, over = 0.55): THREE.BufferGeometry[] {
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy)
  const ux = dx / L, uy = dy / L
  const nx = -uy * Math.sign(ux || 1), ny = Math.abs(ux) // up-facing normal of the slope
  const len = L + over, t = 0.26
  const cx = x0 + ux * len / 2 + nx * t / 2, cy = y0 + uy * len / 2 + ny * t / 2
  const ang = Math.atan2(uy, ux)
  const out = [finish(new THREE.BoxGeometry(len, t, d + 1.0).rotateZ(ang).translate(cx, cy, 0), hex, 0.92)]
  const rib = new THREE.Color().setHex(hex).multiplyScalar(1.12).getHex()
  for (let z = -(d / 2 + 0.4); z <= d / 2 + 0.4; z += 0.55) out.push(finish(new THREE.BoxGeometry(len, 0.06, 0.06).rotateZ(ang).translate(cx + nx * 0.15, cy + ny * 0.15, z), rib, 1))
  const ex = x0 + ux * len, ey = y0 + uy * len
  out.push(finish(new THREE.BoxGeometry(0.14, 0.32, d + 1.04).translate(ex, ey, 0), trim, 1)) // fascia at the eave
  for (const z of [-(d / 2 + 0.52), d / 2 + 0.52]) out.push(finish(new THREE.BoxGeometry(len, 0.16, 0.12).rotateZ(ang).translate(cx - nx * 0.12, cy - ny * 0.12, z), trim, 1))
  return out
}

/**
 * BRIGHT (over the hill) BARN, after their farm barn: a SALTBOX — the ridge off-centre, the long rear slope sweeping
 * down over a LEAN-TO shed (open bay on posts) — weathered vertical boards with dark gaps, ribbed metal roof, off-white
 * trim and corner boards, an X-braced sliding door on its track, a LIT loft window (glow → bloom at dusk) and lit side
 * windows, a cupola. Footprint x −5.75…5.75 × z ±4 (collider).
 */
function othBarn(): THREE.BufferGeometry {
  const red = 0xb0563a, gap = 0x5a2618, white = 0xe8e0d0, roofC = 0x6a625c, lamp = 0xc08a40
  const L0 = -2.25, R0 = 5.75, D = 8, H = 5.6, RX = 2.75, RH = 4.2, LT = -5.75, cx = (L0 + R0) / 2, W = R0 - L0
  const k = RH / (RX - L0), ltH = H - k * (L0 - LT) // lean-to eave height on the long slope
  const parts: THREE.BufferGeometry[] = [
    box(W, H, D, gap, cx),
    box(W + 0.2, 0.35, D + 0.2, 0x7a746a, cx), // stone sill
  ]
  // gable end walls (asymmetric triangle) + boards on the walls
  const gableShape = new THREE.Shape()
  gableShape.moveTo(L0, 0); gableShape.lineTo(R0, 0); gableShape.lineTo(RX, RH); gableShape.closePath()
  parts.push(finish(new THREE.ExtrudeGeometry(gableShape, { depth: D, bevelEnabled: false }).translate(0, H, -D / 2), red, 0.95))
  const wallBoards = (face: Face, hd: number, w: number, h: number, sd: number, shift = 0) =>
    boards(face, hd, w, h, red, sd).map((g) => g.translate(face === '+z' || face === '-z' ? shift : 0, 0, 0))
  parts.push(...wallBoards('+z', D / 2, W, H, 1, cx), ...wallBoards('-z', D / 2, W, H, 2, cx))
  parts.push(...boards('+x', 0, D, H, red, 3).map((g) => g.translate(R0, 0, 0)))
  // roof: short front slope + the long saltbox slope over the lean-to
  parts.push(...roofSlab(RX, H + RH, R0, H, D, roofC, white), ...roofSlab(RX, H + RH, LT, ltH, D, roofC, white, 0.45))
  // lean-to: back + side walls of boards, an open front bay on posts, dark inside
  parts.push(box(L0 - LT, ltH - 0.1, D - 0.2, 0x2a1c14, (L0 + LT) / 2))
  parts.push(...boards('-x', 0, D, ltH, red, 5).map((g) => g.translate(LT, 0, 0)))
  parts.push(...boards('-z', D / 2, L0 - LT, ltH, red, 6).map((g) => g.translate((L0 + LT) / 2, 0, 0)))
  for (const z of [-D / 2 + 0.2, 0, D / 2 - 0.2]) parts.push(box(0.2, ltH, 0.2, 0x7a5a3a, LT + 0.15, 0, z))
  // corner boards
  for (const [x, z] of [[L0, -1], [R0, -1], [L0, 1], [R0, 1]]) parts.push(box(0.26, H, 0.26, white, x, 0, z * (D / 2 + 0.02)))
  // sliding door (X brace, frame, track) centred on the body front
  const f = (u: number, y: number, w: number, h: number, t: number, hex: number, o = 0) => onWall('+z', D / 2, u, y, w, h, t, hex, o).translate(cx, 0, 0)
  parts.push(f(0, 0, 3.8, 3.9, 0.12, 0x7a3624, 0.03), f(-1.95, 0, 0.18, 3.9, 0.2, white), f(1.95, 0, 0.18, 3.9, 0.2, white), f(0, 3.9, 4.1, 0.18, 0.2, white), f(0, 0, 0.12, 3.8, 0.18, white))
  const brace = Math.hypot(3.7, 3.8), ba = Math.atan2(3.8, 3.7)
  for (const sg of [-1, 1]) parts.push(finish(new THREE.BoxGeometry(brace, 0.16, 0.1).rotateZ(sg * ba).translate(cx, 1.95, D / 2 + 0.2), white, 1))
  parts.push(f(0, 4.2, 6.2, 0.14, 0.24, 0x3c4048)) // door track
  // lit loft window + lit side windows (glass on the glow surface), framed
  parts.push(...windowOn('+z', D / 2, 0, 5.6, 1.3, 1.3, white, lamp).map((g, i) => (i === 0 ? glow(g) : g).translate(cx, 0, 0)))
  for (const u of [-2.0, 2.0]) parts.push(...windowOn('+x', 0, u, 2.3, 1.0, 1.1, white, lamp).map((g, i) => (i === 0 ? glow(g) : g).translate(R0, 0, 0)))
  parts.push(...windowOn('-z', D / 2, -2.0, 2.4, 1.0, 1.1, white, 0x6a7a84).map((g) => g.translate(cx, 0, 0)))
  // cupola on the ridge
  parts.push(box(1.2, 1.0, 1.2, white, RX, H + RH - 0.35, 0), finish(new THREE.ConeGeometry(1.05, 0.8, 4).rotateY(Math.PI / 4).translate(RX, H + RH + 1.05, 0), roofC, 0.9))
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
    parts.push(...windowOn('+z', D / 2, u, 1.5, 1.0, 1.25, white, 0xc08a40).map((g, i) => (i === 0 ? glow(g) : g))) // lit
    parts.push(onWall('+z', D / 2, u - 0.85, 1.4, 0.42, 1.45, 0.06, shut), onWall('+z', D / 2, u + 0.85, 1.4, 0.42, 1.45, 0.06, shut))
  }
  for (const u of [-1.4, 1.4]) parts.push(...windowOn('+x', W / 2, u, 1.6, 0.9, 1.15, white), ...windowOn('-x', W / 2, u, 1.6, 0.9, 1.15, white))
  parts.push(...windowOn('-z', D / 2, 0, 1.6, 1.0, 1.15, white), ...windowOn('+z', D / 2, 0, H + 0.6, 0.8, 0.8, white))
  parts.push(box(0.8, 2.6, 0.8, 0x8a5a48, 2.6, H + 0.8, -1.2), box(1.0, 0.18, 1.0, 0x6a6460, 2.6, H + 3.4, -1.2))
  return merged(parts, 'house')
}

/** Cylinder part (posts, barrels, logs) along +y, `sides` facets. */
const cyl = (r0: number, r1: number, h: number, sides: number, hex: number, x = 0, y = 0, z = 0, surf: SurfaceName = 'plain') =>
  finish(new THREE.CylinderGeometry(r1, r0, h, sides).translate(x, y + h / 2, z), hex, 0.8, surf)

/**
 * COZY DETAILS (over the hill's lived-in places): small props merged into the place mesh (no extra draws).
 * Warm lights (lantern glass, lamp) are on the GLOW surface → they glow at dusk / night (bloom on MEDIUM+).
 */
function cozyProps(m: Map<number, THREE.BufferGeometry>): void {
  const wood = 0x8a6440, dark = 0x5a3e28, weathered = 0xb8ab94, iron = 0x3a3a3e, warm = 0xffb850
  // SUMMIT VIEWPOINT (PoiType.Lookout): a round stone terrace (r 4.2 m, 0.4 m tall, its foot buried), a timber railing
  // round the view side (+z), a brass telescope on a post at the rail, a stone CAIRN and a 7.5 m pole with a big
  // red-orange FLAG — the mark you see on the skyline from the valley. ~600 tris, merged into the place mesh.
  {
    const stone = 0x9a948a, flag = 0xe0502a
    const parts = [cyl(4.0, 4.4, 1.0, 14, stone, 0, -0.6, 0, 'stone'), cyl(3.7, 3.95, 0.04, 14, 0xb2ab9e, 0, 0.4, 0, 'stone')]
    for (let i = 0; i <= 6; i++) {
      const a = -1.05 + (i / 6) * 2.1
      parts.push(box(0.14, 1.0, 0.14, dark, Math.sin(a) * 3.85, 0.4, Math.cos(a) * 3.85, 'wood'))
      if (i < 6) {
        const b = a + 0.175, l = 2 * 3.85 * Math.sin(0.175)
        parts.push(finish(new THREE.BoxGeometry(l + 0.1, 0.09, 0.1).rotateY(b).translate(Math.sin(b) * 3.85 * Math.cos(0.175), 1.36, Math.cos(b) * 3.85 * Math.cos(0.175)), wood, 1, 'wood'))
      }
    }
    // (BoxGeometry along x rotated by b about y: its length runs along (cos b, −sin b) — tangent to the circle at angle b)
    parts.push(cyl(0.05, 0.06, 1.15, 6, iron, 0, 0.4, 3.0), finish(new THREE.CylinderGeometry(0.07, 0.09, 0.7, 8).rotateX(Math.PI / 2 - 0.25).translate(0, 1.6, 3.0), 0xb08a3c, 0.9))
    ;[[0.7, 0.32], [0.55, 0.3], [0.42, 0.26], [0.3, 0.24], [0.18, 0.2]].reduce((y, [r, hh], i) => {
      parts.push(finish(new THREE.IcosahedronGeometry(r, 0).scale(1, hh / r, 1).rotateY(i * 1.1).translate(-2.6 + (i % 2) * 0.06, y + hh * 0.9, -1.8), i % 2 ? 0x8a857c : 0xa49e92, 0.8, 'stone'))
      return y + hh * 1.6
    }, 0.4)
    parts.push(cyl(0.06, 0.08, 7.5, 6, 0xd8d0c0, 2.8, 0.4, -2.2), finish(new THREE.BoxGeometry(1.7, 1.05, 0.05).translate(2.8 + 0.85, 7.25, -2.2), flag, 0.9))
    m.set(PropType.Viewpoint, merged(parts, 'viewpoint'))
  }
  // Porch / garden chair: slatted seat, back, legs.
  m.set(PropType.Chair, merged([
    box(0.5, 0.06, 0.5, wood, 0, 0.42, 0, 'wood'), box(0.5, 0.5, 0.06, wood, 0, 0.48, -0.22, 'wood'),
    ...[[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]].map(([x, z]) => box(0.05, 0.42, 0.05, dark, x, 0, z)),
    box(0.05, 0.25, 0.05, dark, -0.22, 0.48, 0), box(0.05, 0.25, 0.05, dark, 0.22, 0.48, 0),
  ], 'chair'))
  // Hanging / standing lantern: iron frame, glowing glass.
  m.set(PropType.Lantern, merged([
    box(0.2, 0.04, 0.2, iron, 0, 0, 0), glow(box(0.14, 0.22, 0.14, warm, 0, 0.04, 0)), box(0.2, 0.04, 0.2, iron, 0, 0.26, 0),
    finish(new THREE.ConeGeometry(0.13, 0.1, 4).rotateY(Math.PI / 4).translate(0, 0.35, 0), iron, 0.9), box(0.03, 0.08, 0.03, iron, 0, 0.4, 0),
  ], 'lantern'))
  // Barrel with hoops.
  m.set(PropType.Barrel, merged([
    cyl(0.3, 0.3, 0.85, 10, 0x8a5a34, 0, 0, 0, 'wood'), cyl(0.31, 0.31, 0.06, 10, iron, 0, 0.12), cyl(0.31, 0.31, 0.06, 10, iron, 0, 0.66),
    cyl(0.27, 0.27, 0.02, 10, 0x6a4428, 0, 0.85),
  ], 'barrel'))
  // Wooden crate (planked).
  m.set(PropType.Crate, merged([box(0.6, 0.5, 0.6, 0xa07a4c, 0, 0, 0, 'wood'), box(0.62, 0.06, 0.62, dark, 0, 0.22, 0), box(0.06, 0.5, 0.62, dark, 0, 0, 0)], 'crate'))
  // Picket fence: 2 m section of pointed weathered-white pickets on two rails (along x).
  {
    const parts = [box(2, 0.06, 0.05, weathered, 0, 0.3, 0), box(2, 0.06, 0.05, weathered, 0, 0.7, 0)]
    for (let i = 0; i < 8; i++) {
      const x = -0.875 + i * 0.25
      parts.push(box(0.09, 0.85, 0.03, weathered, x, 0, 0.04), finish(new THREE.ConeGeometry(0.065, 0.12, 4).rotateY(Math.PI / 4).translate(x, 0.91, 0.04), weathered, 1))
    }
    parts.push(box(0.1, 1.0, 0.1, 0x9a8c74, -1, 0, 0))
    m.set(PropType.Picket, merged(parts, 'picket'))
  }
  // Mailbox on a post (red flag up).
  m.set(PropType.Mailbox, merged([
    box(0.1, 1.05, 0.1, dark, 0, 0, 0), box(0.28, 0.24, 0.45, 0x4a6e8a, 0, 1.05, 0),
    finish(new THREE.CylinderGeometry(0.14, 0.14, 0.45, 8, 1, false, 0, Math.PI).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).translate(0, 1.29, 0), 0x4a6e8a, 1),
    box(0.03, 0.2, 0.08, 0xc23a2a, 0.16, 1.2, -0.12),
  ], 'mailbox'))
  // Stepping stones: 3 flat irregular slabs along +z.
  m.set(PropType.Stones, merged([0, 1, 2].map((i) => finish(new THREE.CylinderGeometry(0.38 + 0.06 * (i % 2), 0.42, 0.08, 7).rotateY(i * 1.3).scale(1, 1, 0.8).translate((i % 2) * 0.15 - 0.07, 0.01, i * 0.9), 0x9a948a, 0.85, 'stone')), 'stones'))
  // Flower bed: a low plank box of soil with colourful blooms on leafy mounds.
  {
    const parts = [box(2.4, 0.22, 0.9, 0x7a5434, 0, 0, 0, 'wood'), box(2.3, 0.04, 0.8, 0x4a3424, 0, 0.2, 0)]
    const cols = [0xe86a8a, 0xf2c84a, 0xf0f0f0, 0xb07ae8, 0xf08a3a]
    for (let i = 0; i < 9; i++) {
      const x = -0.95 + (i % 5) * 0.48 + (i >= 5 ? 0.24 : 0), z = i >= 5 ? 0.18 : -0.16
      parts.push(finish(new THREE.IcosahedronGeometry(0.2, 0).scale(1, 0.7, 1).translate(x, 0.32, z), 0x4f7a34, 0.7))
      parts.push(finish(new THREE.IcosahedronGeometry(0.09, 0).translate(x + 0.04, 0.46, z), cols[i % cols.length], 1))
    }
    m.set(PropType.FlowerBed, merged(parts, 'flowerbed'))
  }
  // Laundry line: two T-posts, a line, hanging cloths.
  {
    const parts = [box(0.08, 1.9, 0.08, dark, -2, 0, 0), box(0.08, 1.9, 0.08, dark, 2, 0, 0), box(4, 0.02, 0.02, 0xd8d0c0, 0, 1.8, 0)]
    const cloth = [0xf2efe6, 0x6a8ab8, 0xd86a5a, 0xf2efe6, 0xe8c86a]
    let x = -1.6
    for (let i = 0; i < 5; i++) {
      const w = 0.4 + (i % 3) * 0.15, h = 0.5 + (i % 2) * 0.25
      parts.push(box(w, h, 0.02, cloth[i], x + w / 2, 1.8 - h, 0))
      x += w + 0.12
    }
    m.set(PropType.Laundry, merged(parts, 'laundry'))
  }
  // Chopping stump with an axe in it.
  m.set(PropType.Stump, merged([
    cyl(0.32, 0.3, 0.5, 9, 0x7a5236, 0, 0, 0, 'bark'), cyl(0.29, 0.29, 0.02, 9, 0xc8a878, 0, 0.5),
    finish(new THREE.BoxGeometry(0.04, 0.6, 0.04).rotateZ(-0.5).translate(0.14, 0.78, 0), 0x8a6a44, 1), box(0.18, 0.1, 0.03, 0x8a8a90, 0, 0.5, 0),
  ], 'stump'))
  // Wooden bench.
  m.set(PropType.Bench, merged([
    box(1.6, 0.06, 0.4, wood, 0, 0.42, 0, 'wood'), box(1.6, 0.3, 0.05, wood, 0, 0.6, -0.18, 'wood'),
    ...[-0.7, 0.7].flatMap((x) => [box(0.06, 0.42, 0.36, dark, x, 0, 0), box(0.06, 0.32, 0.05, dark, x, 0.45, -0.18)]),
  ], 'bench'))
  // Signpost: a post with two arrow boards (to the place / back to the road).
  m.set(PropType.Signpost, merged([
    box(0.12, 2.2, 0.12, dark, 0, 0, 0),
    finish(new THREE.ExtrudeGeometry((() => { const sh = new THREE.Shape(); sh.moveTo(0, -0.14); sh.lineTo(0.85, -0.14); sh.lineTo(1.05, 0); sh.lineTo(0.85, 0.14); sh.lineTo(0, 0.14); sh.closePath(); return sh })(), { depth: 0.04, bevelEnabled: false }).translate(0.04, 1.85, -0.02), 0xc8a06a, 1, 'wood'),
    finish(new THREE.ExtrudeGeometry((() => { const sh = new THREE.Shape(); sh.moveTo(0, -0.12); sh.lineTo(-0.7, -0.12); sh.lineTo(-0.88, 0); sh.lineTo(-0.7, 0.12); sh.lineTo(0, 0.12); sh.closePath(); return sh })(), { depth: 0.04, bevelEnabled: false }).rotateY(0.5).translate(-0.04, 1.5, 0), 0xb08a58, 1, 'wood'),
    finish(new THREE.ConeGeometry(0.1, 0.12, 4).rotateY(Math.PI / 4).translate(0, 2.26, 0), dark, 1),
  ], 'signpost'))
  // Lamp post at the gate: a pole with an arm and a hanging glowing lantern.
  m.set(PropType.LampPost, merged([
    box(0.12, 2.6, 0.12, dark, 0, 0, 0), box(0.7, 0.07, 0.07, dark, 0.3, 2.45, 0), box(0.04, 0.2, 0.04, iron, 0.6, 2.25, 0),
    box(0.22, 0.04, 0.22, iron, 0.6, 1.95, 0), glow(box(0.16, 0.24, 0.16, warm, 0.6, 1.99, 0)), finish(new THREE.ConeGeometry(0.15, 0.12, 4).rotateY(Math.PI / 4).translate(0.6, 2.3, 0), iron, 1),
  ], 'lamppost'))
  // Log seat (round log lying on its side).
  m.set(PropType.LogSeat, merged([finish(new THREE.CylinderGeometry(0.22, 0.24, 1.6, 8).rotateZ(Math.PI / 2).translate(0, 0.22, 0), 0x6e4a2e, 0.8, 'bark')], 'logseat'))
}

export function createPoiGeometries(): Map<number, THREE.BufferGeometry> {
  const m = new Map<number, THREE.BufferGeometry>()
  cozyProps(m)
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
  [PropType.Barn]: [5, 2.7, 4], // bright's saltbox barn + lean-to: poiCollider()
  [PropType.Hay]: [0.6, 0.6, 0.62],
  [PropType.Cabin]: [3.2, 2.2, 2.8],
  [PropType.Tent]: [1.1, 0.8, 1.3],
  [PropType.RuinWall]: [2, 1.1, 0.35],
  [PropType.RuinPillar]: [0.4, 1.4],
  [PropType.Woodpile]: [0.5, 0.35, 0.7],
  [PropType.Barrel]: [0.3, 0.42],
  [PropType.Crate]: [0.3, 0.25, 0.3],
  [PropType.Mailbox]: [0.1, 0.6],
  [PropType.Signpost]: [0.08, 1.1],
  [PropType.LampPost]: [0.08, 1.3],
  [PropType.Bench]: [0.8, 0.35, 0.22],
  [PropType.Stump]: [0.3, 0.25],
  [PropType.FlowerBed]: [1.2, 0.15, 0.45],
  [PropType.Viewpoint]: [4.2, 0.2], // the terrace (0.4 m: the 0.45 m autostep walks up it)
}

/** Collider of a prop type for the session's art style (bright's barn has a lean-to: x −5.75…5.75). */
export function poiCollider(t: number): number[] | null {
  if (t === PropType.Barn && isBright()) return [5.75, 2.8, 4]
  return POI_COLLIDERS[t] ?? null
}
