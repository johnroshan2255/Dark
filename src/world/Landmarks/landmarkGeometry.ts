import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { finish } from '../POI/poiGeometry'
import { LANDMARK_SCALE, LandmarkKind } from './landmarks'

/**
 * Landmark meshes (Genshin palette, built from primitives in code like the places): one geometry per kind in the
 * landmark's local frame (y = 0 at its base; foundations reach 4 m below for slopes). Same vertex format as the
 * place props (colour + atlas surface texel + zero billboard attributes) → drawn with the shared vegetation
 * material: no extra shader programs. Smooth normals are kept per part (round crowns, columns), the gradient
 * from `finish` darkens each part toward its base (cheap AO).
 *
 * Triangles (LOD-free; LandmarkSystem caps how many are drawn by the tier's view distance): giant tree ~2.6k,
 * windmill ~0.9k (+ rotor 0.1k), ruins ~2.2k, statue ~0.8k, tower ~1.1k, obelisk ~0.3k, gate ~0.2k,
 * frost tree ~1.2k, ice spire ~0.4k.
 */
export interface LandmarkCollider {
  /** Local offset, radius, bottom and height (m) of an upright cylinder. */
  x: number
  z: number
  r: number
  y0: number
  h: number
}

export interface LandmarkGeometries {
  body: THREE.BufferGeometry[]
  /** Far level of detail per kind (≈ ⅓–½ of the triangles; LandmarkSystem draws it past ~350 m). */
  far: THREE.BufferGeometry[]
  /** Windmill sails, centred on the hub (spins about local Z). */
  rotor: THREE.BufferGeometry
  /** Windmill hub position in the windmill's local frame. */
  hub: THREE.Vector3
  colliders: LandmarkCollider[][]
  dispose(): void
}

const C = {
  stone: 0xc9c1ae, stoneDark: 0x9a9384, slate: 0x7b8794, plaster: 0xeee3cc, roofRed: 0xb5513c, roofBlue: 0x4f72a8,
  wood: 0x7c5434, canvas: 0xf3ecdc, trunk: 0x76543a, leaf1: 0x86c23c, leaf2: 0x6aac2e, leaf3: 0xa8d64e,
  sand: 0xdcae6e, sandDark: 0xb98a52, glyph: 0x3fd0c8, gold: 0xe0b84c, statue: 0x8db3ab, white: 0xf2f0ea,
  pine: 0x2f5c48, snow: 0xf4f8fb, ice: 0xa6dcf2, iceLight: 0xdaf3ff, rockBlue: 0x7d8a99,
}

type G = THREE.BufferGeometry
/** Building the FAR level of detail: half the segments, detail-0 crowns, small parts dropped (see `merge`). */
let LO = false
const S = (n: number) => (LO ? Math.max(Math.min(n, 4), Math.round(n / 2)) : n)
const part = (g: G, hex: number, shade = 0.75, surf: 'stone' | 'wood' | 'bark' | 'plain' | 'roof' = 'plain') => finish(g, hex, shade, surf)
const cyl = (rt: number, rb: number, h: number, seg: number, hex: number, x = 0, y = 0, z = 0, surf: 'stone' | 'wood' | 'bark' | 'plain' | 'roof' = 'stone') =>
  part(new THREE.CylinderGeometry(rt, rb, h, S(seg)).translate(x, y + h / 2, z), hex, 0.78, surf)
const box = (w: number, h: number, d: number, hex: number, x = 0, y = 0, z = 0, surf: 'stone' | 'wood' | 'bark' | 'plain' | 'roof' = 'stone') =>
  part(new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z), hex, 0.8, surf)
const blob = (r: number, hex: number, x: number, y: number, z: number, squash = 0.8) =>
  part(new THREE.IcosahedronGeometry(r, LO ? 0 : 1).scale(1, squash, 1).translate(x, y, z), hex, 0.62)

function merge(parts: G[], name: string): G {
  if (LO) {
    // Far LOD: details under ~1 m (merlons, windows, flags, glyph strips, the small drums) vanish at that range.
    parts = parts.filter((p) => {
      p.computeBoundingBox()
      const b = p.boundingBox!
      const keep = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) > 1.6
      if (!keep) p.dispose()
      return keep
    })
  }
  const g = mergeGeometries(parts)!
  parts.forEach((p) => p.dispose())
  g.computeBoundingSphere()
  g.name = name
  return g
}

/** Pseudo-random in [0, 1) from a small integer (geometry variety is fixed per kind, so no seed needed). */
const r01 = (i: number) => {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

function giantTree(): G {
  const p: G[] = []
  // Flared roots, a massive tapering trunk, five big boughs, a wide dome of round crowns (Windrise's oak).
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3
    p.push(part(new THREE.CylinderGeometry(0.5, 1.5, 8, S(6)).rotateZ(-1.05).translate(3.2, 1.2, 0).rotateY(a), C.trunk, 0.7, 'bark'))
  }
  p.push(cyl(2.1, 3.4, 18, 12, C.trunk, 0, -2, 0, 'bark'))
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.8
    p.push(part(new THREE.CylinderGeometry(0.45, 1.1, 11, S(6)).translate(0, 5.5, 0).rotateZ(-0.95 - 0.15 * r01(i)).translate(0, 13 + r01(i + 9) * 2, 0).rotateY(a), C.trunk, 0.75, 'bark'))
  }
  const leaves = [C.leaf1, C.leaf2, C.leaf3]
  p.push(blob(10, C.leaf1, 0, 25, 0, 0.62))
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + r01(i) * 0.5
    const d = 10 + r01(i + 3) * 3
    p.push(blob(6.5 + r01(i + 5) * 2, leaves[i % 3], Math.cos(a) * d, 21 + r01(i + 7) * 3, Math.sin(a) * d, 0.7))
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 1
    p.push(blob(6, C.leaf3, Math.cos(a) * 4.5, 29.5, Math.sin(a) * 4.5, 0.75))
  }
  return merge(p, 'landmark.giantTree')
}

function windmill(): G {
  const p: G[] = []
  p.push(cyl(4.4, 5.2, 8, 14, C.stoneDark, 0, -4, 0))
  p.push(cyl(2.9, 3.9, 14, 12, C.plaster, 0, 4, 0, 'plain'))
  // Timber bands and a door, a cone roof with a little cap.
  p.push(cyl(3.55, 3.6, 0.5, 12, C.wood, 0, 8.5, 0, 'wood'))
  p.push(cyl(3.2, 3.25, 0.5, 12, C.wood, 0, 13, 0, 'wood'))
  p.push(box(1.6, 2.8, 0.5, C.wood, 0, 4, 3.7, 'wood'))
  p.push(part(new THREE.ConeGeometry(3.9, 5.5, S(12)).translate(0, 18 + 2.75, 0), C.roofRed, 0.85, 'roof'))
  p.push(cyl(0.25, 0.25, 1.6, 6, C.wood, 0, 23.4, 0, 'wood'))
  p.push(part(new THREE.CylinderGeometry(0.6, 0.6, 2.2, S(8)).rotateX(Math.PI / 2).translate(0, 17, 3.6), C.wood, 0.85, 'wood'))
  return merge(p, 'landmark.windmill')
}

function windmillRotor(): G {
  const p: G[] = []
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2
    p.push(part(new THREE.BoxGeometry(0.35, 12, 0.35).translate(0, 6, 0).rotateZ(a), C.wood, 0.9, 'wood'))
    p.push(part(new THREE.BoxGeometry(2.6, 8.5, 0.12).translate(1.5, 7.2, 0.1).rotateZ(a), C.canvas, 0.85, 'plain'))
  }
  p.push(part(new THREE.SphereGeometry(0.75, S(8), S(6)), C.wood, 0.9, 'wood'))
  return merge(p, 'landmark.windmillRotor')
}

function ruins(): G {
  const p: G[] = []
  // Round stepped platform, a colonnade (some columns broken), lintels between the standing pairs, fallen drums.
  p.push(cyl(13, 13.6, 5.5, 28, C.stoneDark, 0, -4.5, 0))
  p.push(cyl(14.6, 15.2, 4, 28, C.stoneDark, 0, -4.6, 0))
  p.push(cyl(12.4, 12.6, 0.25, 28, C.stone, 0, 1, 0))
  const N = 10, R = 10
  const full: boolean[] = []
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2
    const x = Math.cos(a) * R, z = Math.sin(a) * R
    const broken = r01(i + 20) < 0.4
    full.push(!broken)
    const h = broken ? 2 + r01(i + 30) * 4 : 9
    p.push(box(2.2, 0.8, 2.2, C.stone, x, 1, z))
    p.push(cyl(0.85, 0.95, h, 10, C.stone, x, 1.8, z))
    if (!broken) p.push(box(2.4, 0.7, 2.4, C.stone, x, 1.8 + h, z))
  }
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N
    if (!full[i] || !full[j]) continue
    const a = ((i + 0.5) / N) * Math.PI * 2
    const len = 2 * R * Math.sin(Math.PI / N) + 2.2
    p.push(part(new THREE.BoxGeometry(len, 1.1, 1.6).translate(0, 11.5 + 0.55, 0).rotateY(-a + Math.PI / 2).translate(Math.cos(a) * R * Math.cos(Math.PI / N), 0, Math.sin(a) * R * Math.cos(Math.PI / N)), C.stone, 0.85, 'stone'))
  }
  for (let i = 0; i < 3; i++) {
    const a = r01(i + 40) * Math.PI * 2, d = 4 + r01(i + 50) * 9
    p.push(part(new THREE.CylinderGeometry(0.9, 0.9, 2.6 + r01(i) * 2, 10).rotateZ(Math.PI / 2).rotateY(a * 1.7).translate(Math.cos(a) * d, 1.9, Math.sin(a) * d), C.stone, 0.8, 'stone'))
  }
  p.push(box(3, 1.4, 2, C.stoneDark, 0, 1, 0))
  return merge(p, 'landmark.ruins')
}

function statue(): G {
  const p: G[] = []
  // Stepped plinth, pedestal, a robed winged figure holding up a glowing orb (a Statue of the Seven).
  p.push(box(10.5, 5.2, 10.5, C.stoneDark, 0, -4, 0))
  p.push(box(8.4, 1.2, 8.4, C.stone, 0, 1.2, 0))
  p.push(box(6.4, 1.2, 6.4, C.stone, 0, 2.4, 0))
  p.push(cyl(1.9, 2.3, 3, 10, C.stone, 0, 3.6, 0))
  p.push(part(new THREE.ConeGeometry(1.8, 5.6, S(10)).translate(0, 6.6 + 2.8, 0), C.statue, 0.75, 'stone'))
  p.push(cyl(0.7, 0.95, 1.8, 8, C.statue, 0, 11.2, 0))
  p.push(part(new THREE.SphereGeometry(0.62, S(10), S(8)).translate(0, 13.6, 0), C.statue, 0.9, 'stone'))
  for (const side of [-1, 1]) {
    p.push(part(new THREE.BoxGeometry(0.25, 4.6, 2.4).rotateZ(side * 0.5).rotateY(side * 0.35).translate(side * 1.6, 12.4, -0.9), C.white, 0.85, 'stone'))
  }
  p.push(part(new THREE.BoxGeometry(0.35, 2.6, 0.35).rotateZ(-0.35).translate(0.9, 13.6, 0.3), C.statue, 0.9, 'stone'))
  p.push(part(new THREE.IcosahedronGeometry(0.75, LO ? 0 : 1).translate(1.4, 15.1, 0.3), C.glyph, 1, 'plain'))
  p.push(box(0.6, 0.3, 0.6, C.gold, 0, 3.55, 3.25))
  return merge(p, 'landmark.statue')
}

function tower(): G {
  const p: G[] = []
  p.push(cyl(5.3, 6, 7, 14, C.stoneDark, 0, -5, 0))
  p.push(cyl(4.3, 4.9, 22, 14, C.stone, 0, 2, 0))
  p.push(cyl(4.75, 4.8, 0.7, 14, C.stoneDark, 0, 9, 0))
  p.push(cyl(4.5, 4.55, 0.7, 14, C.stoneDark, 0, 17, 0))
  p.push(cyl(5.2, 4.6, 1.4, 14, C.stone, 0, 24, 0))
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2
    p.push(part(new THREE.BoxGeometry(1.4, 1.3, 0.9).translate(0, 25.4 + 0.65, 4.8).rotateY(a), C.stone, 0.85, 'stone'))
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4
    p.push(part(new THREE.BoxGeometry(0.7, 2.2, 0.4).translate(0, 12 + i * 4, 4.55).rotateY(a), 0x2a2a30, 1, 'plain'))
  }
  p.push(cyl(0.6, 0.6, 2, 8, C.stone, 0, 25.4, 0))
  p.push(part(new THREE.ConeGeometry(3.4, 6, S(12)).translate(0, 27.4 + 3, 0), C.roofBlue, 0.85, 'roof'))
  p.push(cyl(0.12, 0.12, 4, 4, C.wood, 0, 33, 0, 'wood'))
  p.push(box(1.8, 1, 0.08, C.roofRed, 0.9, 35.6, 0, 'plain'))
  return merge(p, 'landmark.tower')
}

function obelisk(): G {
  const p: G[] = []
  p.push(box(7, 6, 7, C.sandDark, 0, -4, 0))
  p.push(box(5.2, 1.2, 5.2, C.sand, 0, 2, 0))
  p.push(part(new THREE.CylinderGeometry(1.2, 2.2, 20, S(4)).rotateY(Math.PI / 4).translate(0, 3.2 + 10, 0), C.sand, 0.72, 'stone'))
  p.push(part(new THREE.CylinderGeometry(2.0, 2.05, 0.6, S(4)).rotateY(Math.PI / 4).translate(0, 9, 0), C.glyph, 1, 'plain'))
  p.push(part(new THREE.CylinderGeometry(1.62, 1.66, 0.5, S(4)).rotateY(Math.PI / 4).translate(0, 16, 0), C.glyph, 1, 'plain'))
  p.push(part(new THREE.ConeGeometry(1.25, 2.4, S(4)).rotateY(Math.PI / 4).translate(0, 23.2 + 1.2, 0), C.gold, 0.9, 'plain'))
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.6
    p.push(part(new THREE.BoxGeometry(1.6, 1.2 + r01(i) * 1.4, 1.6).rotateY(a).rotateZ(0.2 * (r01(i + 4) - 0.5)).translate(Math.cos(a) * 6, 0.4, Math.sin(a) * 6), C.sand, 0.8, 'stone'))
  }
  return merge(p, 'landmark.obelisk')
}

function gate(): G {
  const p: G[] = []
  for (const x of [-6, 6]) {
    p.push(box(3.4, 5, 3.4, C.sandDark, x, -4, 0))
    p.push(box(2.6, 13, 2.6, C.sand, x, 1, 0))
    p.push(box(3.2, 0.8, 3.2, C.sandDark, x, 14, 0))
  }
  p.push(box(17, 2.4, 3.4, C.sand, 0, 14.8, 0))
  p.push(box(12, 0.5, 0.1, C.glyph, 0, 15.8, 1.72, 'plain'))
  p.push(box(12, 0.5, 0.1, C.glyph, 0, 15.8, -1.72, 'plain'))
  p.push(part(new THREE.BoxGeometry(2.6, 7, 2.6).rotateZ(1.2).translate(9.5, 1.2, 4), C.sand, 0.8, 'stone'))
  return merge(p, 'landmark.gate')
}

function frostTree(): G {
  const p: G[] = []
  // A giant snow-laden fir (Dragonspine): stacked cones with white caps, two smaller firs beside it.
  const fir = (x: number, z: number, s: number) => {
    p.push(cyl(0.9 * s, 1.5 * s, 8 * s, 8, C.trunk, x, -2, z, 'bark'))
    for (let i = 0; i < 5; i++) {
      const r = (9 - i * 1.5) * s, y = (4 + i * 5) * s, h = 8 * s
      p.push(part(new THREE.ConeGeometry(r, h, S(10)).translate(x, y + h / 2, z), C.pine, 0.6, 'plain'))
      p.push(part(new THREE.ConeGeometry(r * 0.78, h * 0.42, S(10)).translate(x, y + h * 0.78, z), C.snow, 0.9, 'plain'))
    }
  }
  fir(0, 0, 1)
  fir(10, 4, 0.5)
  fir(-8, -7, 0.42)
  return merge(p, 'landmark.frostTree')
}

function iceSpire(): G {
  const p: G[] = []
  p.push(part(new THREE.IcosahedronGeometry(6, LO ? 0 : 0).scale(1.2, 0.6, 1).translate(0, 0.5, 0), C.rockBlue, 0.75, 'stone'))
  const shards = [[0, 0, 22, 2.6, 0, 0], [3, 2, 14, 1.8, 0.25, 0.1], [-3, 1, 12, 1.6, -0.3, 0.15], [1, -3, 10, 1.4, 0.1, -0.35], [-2, -2, 8, 1.2, -0.2, -0.3], [4, -1, 7, 1.1, 0.4, -0.1], [-4, 3, 9, 1.3, -0.35, 0.3]]
  shards.forEach(([x, z, h, r, tx, tz], i) => {
    const g = new THREE.OctahedronGeometry(1, 0).scale(r, h / 2, r).translate(0, h / 2, 0).rotateX(tz).rotateZ(-tx).translate(x, 1.5, z)
    p.push(part(g, i % 2 ? C.iceLight : C.ice, 0.7, 'plain'))
  })
  return merge(p, 'landmark.iceSpire')
}

function buildAll(): G[] {
  const body: G[] = []
  body[LandmarkKind.GiantTree] = giantTree()
  body[LandmarkKind.Windmill] = windmill()
  body[LandmarkKind.Ruins] = ruins()
  body[LandmarkKind.Statue] = statue()
  body[LandmarkKind.Tower] = tower()
  body[LandmarkKind.Obelisk] = obelisk()
  body[LandmarkKind.Gate] = gate()
  body[LandmarkKind.FrostTree] = frostTree()
  body[LandmarkKind.IceSpire] = iceSpire()
  return body
}

export function createLandmarkGeometries(): LandmarkGeometries {
  const body = buildAll()
  LO = true
  const far = buildAll()
  LO = false
  const colliders: LandmarkCollider[][] = []
  colliders[LandmarkKind.GiantTree] = [{ x: 0, z: 0, r: 3.2, y0: -2, h: 20 }]
  colliders[LandmarkKind.Windmill] = [{ x: 0, z: 0, r: 4.6, y0: -4, h: 22 }]
  const ruinCols: LandmarkCollider[] = [{ x: 0, z: 0, r: 13.4, y0: -4.5, h: 5.75 }]
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2
    ruinCols.push({ x: Math.cos(a) * 10, z: Math.sin(a) * 10, r: 1.1, y0: 1, h: r01(i + 20) < 0.4 ? 2.8 + r01(i + 30) * 4 : 11.5 })
  }
  colliders[LandmarkKind.Ruins] = ruinCols
  colliders[LandmarkKind.Statue] = [{ x: 0, z: 0, r: 5, y0: -4, h: 7.6 }, { x: 0, z: 0, r: 2.1, y0: 3.6, h: 9 }]
  colliders[LandmarkKind.Tower] = [{ x: 0, z: 0, r: 5, y0: -5, h: 30.4 }]
  colliders[LandmarkKind.Obelisk] = [{ x: 0, z: 0, r: 3.6, y0: -4, h: 7.2 }, { x: 0, z: 0, r: 2, y0: 3, h: 21 }]
  colliders[LandmarkKind.Gate] = [{ x: -6, z: 0, r: 1.9, y0: -4, h: 19 }, { x: 6, z: 0, r: 1.9, y0: -4, h: 19 }]
  colliders[LandmarkKind.FrostTree] = [{ x: 0, z: 0, r: 2, y0: -2, h: 12 }]
  colliders[LandmarkKind.IceSpire] = [{ x: 0, z: 0, r: 5, y0: -1, h: 10 }]
  // Genshin exaggerates its landmarks (the Windrise oak dwarfs the meadow): scale each kind so it reads from
  // 0.5–2 km away. Footprints in landmarks.ts (LANDMARK_RADIUS) match these.
  const rotor = windmillRotor()
  const hub = new THREE.Vector3(0, 17, 4.8)
  LANDMARK_SCALE.forEach((k, kind) => {
    body[kind].scale(k, k, k).computeBoundingSphere()
    far[kind].scale(k, k, k).computeBoundingSphere()
    for (const c of colliders[kind]) { c.x *= k; c.z *= k; c.r *= k; c.y0 *= k; c.h *= k }
  })
  const ws = LANDMARK_SCALE[LandmarkKind.Windmill]
  rotor.scale(ws, ws, ws)
  hub.multiplyScalar(ws)
  return {
    body,
    far,
    rotor,
    hub,
    colliders,
    dispose() {
      body.forEach((g) => g.dispose())
      far.forEach((g) => g.dispose())
      rotor.dispose()
    },
  }
}
