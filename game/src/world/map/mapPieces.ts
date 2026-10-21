import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { SURFACE_UV } from '../../rendering/materials/FoliageAtlas'
import { createPoiGeometries, finish, poiCollider } from '../POI/poiGeometry'
import { PropType } from '../POI/poiLayout'
import { createFenceGeometry } from '../Road/propMeshes'
import { beam, obox, srgbLin, type V3 } from '../Road/bridges'
import type { CragMesh } from '../Formations/crags'

/**
 * DARK'S OWN LOOK FOR A MAP'S SET PIECES (2026-10-21, "the camps and the bridge don't match our design"): the map's
 * camp gear, cabins and fences came as flat untextured clay (primary-coloured box tents, toy cars, a rainbow flag,
 * Bruno Simon's bright explosive crates). These types are drawn with the procedural world's place props instead —
 * the same geometry, painted surfaces (wood boards, shingles, stone via the atlas UV) and colours as Dark's
 * homesteads and oasis camps — and the toy cars and flags are left out. Every piece is position / normal / colour /
 * uv, non-indexed (one BatchedMesh). Built once per map session (~30 small geometries, < 5 ms).
 */
export interface Piece {
  geo: THREE.BufferGeometry
  /** Collider: [hx, hy, hz] box (base on the ground) or [r, hh] cylinder, in the piece's own frame; null = none. */
  collider: number[] | null
}

/** Map types drawn by nothing at all (they don't fit the style: toy cars, the rainbow flag). */
export const DROPPED = new Set(['car_jeep', 'car_van', 'car_hatch', 'car_buggy', 'flag'])

/** position / normal / color / uv only, non-indexed — the batch layout. */
function layout(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g
  if (!n.getAttribute('normal')) n.computeVertexNormals()
  for (const a of Object.keys(n.attributes)) if (!['position', 'normal', 'color', 'uv'].includes(a)) n.deleteAttribute(a)
  return n
}

const box = (w: number, h: number, d: number, hex: number, x: number, y: number, z: number, surf: keyof typeof SURFACE_UV = 'wood') =>
  finish(new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z), hex, 0.8, surf)

/** White canvas A-frame tent (the oasis camps' tent, bright): ridge along x, doorway at −x, a guy-rope pole each end. */
function tent(): THREE.BufferGeometry {
  const L = 1.4, W = 1.2, H = 1.9
  const canvas = 0xf4efe2, shade = 0xe0d8c6, door = 0x3a2e24
  const slab = (side: number) => {
    const len = Math.hypot(W, H) + 0.08, ang = Math.atan2(H, W)
    return finish(new THREE.BoxGeometry(2 * L, 0.05, len).rotateX(side * ang).translate(0, H / 2, (side * W) / 2), side > 0 ? canvas : shade, 0.85, 'plain')
  }
  const gable = (x: number, hex: number, scale = 1) => {
    const s = new THREE.Shape()
    s.moveTo(-W * scale, 0); s.lineTo(W * scale, 0); s.lineTo(0, H * scale); s.closePath()
    return finish(new THREE.ShapeGeometry(s).rotateY(Math.PI / 2).translate(x, 0, 0), hex, 0.85, 'plain')
  }
  const parts = [slab(1), slab(-1), gable(L - 0.02, shade), gable(-L + 0.02, canvas), gable(-L - 0.01, door, 0.62)]
  for (const x of [-L - 0.15, L + 0.15]) parts.push(box(0.05, H + 0.15, 0.05, 0x6a4a2e, x, 0, 0))
  const g = mergeGeometries(parts.map(layout))!
  parts.forEach((p) => p.dispose())
  return g
}

/** Picnic table: plank top on two A-legs, a bench each side. */
function picnicTable(): THREE.BufferGeometry {
  const wood = 0x8a6440, dark = 0x5a3e28
  const parts = [box(2.0, 0.07, 0.8, wood, 0, 0.72, 0), box(2.0, 0.06, 0.3, wood, 0, 0.42, 0.62), box(2.0, 0.06, 0.3, wood, 0, 0.42, -0.62)]
  for (const x of [-0.75, 0.75]) parts.push(box(0.08, 0.08, 1.55, dark, x, 0.36, 0), box(0.08, 0.72, 0.08, dark, x, 0, 0.3), box(0.08, 0.72, 0.08, dark, x, 0, -0.3))
  const g = mergeGeometries(parts.map(layout))!
  parts.forEach((p) => p.dispose())
  return g
}

/** Copy of `src` scaled / turned about y (radians), in the batch layout. */
function variant(src: THREE.BufferGeometry, scale = 1, rotY = 0, parts: [number, number, number][] = [[0, 0, 0]]): THREE.BufferGeometry {
  const gs = parts.map(([x, y, z]) => layout(src.clone()).rotateY(rotY).scale(scale, scale, scale).translate(x, y, z))
  const g = gs.length === 1 ? gs[0] : mergeGeometries(gs)!
  if (gs.length > 1) gs.forEach((p) => p.dispose())
  return g
}

/** The map type → Dark piece table. */
export function darkPieces(): Map<string, Piece> {
  const poi = createPoiGeometries()
  const P = (t: number) => poi.get(t)!
  const fence = createFenceGeometry()
  const out = new Map<string, Piece>()
  const col = (t: number, s = 1) => poiCollider(t)?.map((v) => v * s) ?? null
  const t = tent()
  for (const k of ['tent_orange', 'tent_red', 'tent_blue']) out.set(k, { geo: k === 'tent_orange' ? t : t.clone(), collider: [1.45, 0.95, 1.25] })
  out.set('campfire', { geo: variant(P(PropType.Campfire), 1.3), collider: null })
  out.set('camp_chair', { geo: variant(P(PropType.Chair), 1.2), collider: null })
  out.set('picnic_table', { geo: picnicTable(), collider: [1.0, 0.39, 0.78] })
  out.set('crate', { geo: variant(P(PropType.Crate), 1.6), collider: col(PropType.Crate, 1.6) })
  // Bruno's explosive-crate pyramids → three plain crates (two down, one on top)
  out.set('b_crate', { geo: variant(P(PropType.Crate), 1.5, 0, [[-0.48, 0, 0], [0.48, 0, 0.05], [0, 0.75, 0]]), collider: [0.95, 0.75, 0.48] })
  out.set('b_brick', { geo: variant(P(PropType.Woodpile), 1.3), collider: col(PropType.Woodpile, 1.3) })
  out.set('barrel', { geo: variant(P(PropType.Barrel), 1.3), collider: col(PropType.Barrel, 1.3) })
  out.set('signpost', { geo: variant(P(PropType.Signpost), 1.2), collider: col(PropType.Signpost, 1.2) })
  out.set('lamp_post', { geo: variant(P(PropType.LampPost), 1.3), collider: col(PropType.LampPost, 1.3) })
  out.set('cabin', { geo: variant(P(PropType.Cabin), 1.15), collider: col(PropType.Cabin, 1.15) })
  out.set('shack', { geo: variant(P(PropType.Cabin), 1.0), collider: col(PropType.Cabin, 1.0) })
  // map fence segments run along their x (4.2 m); Dark's along its z (4.05 m)
  out.set('fence', { geo: variant(fence, 1, Math.PI / 2), collider: null })
  poi.forEach((g) => g.dispose())
  fence.dispose()
  return out
}

/** Colliders that stand on a road would block it (a desert pillar left on a rebuilt road): these types are dropped
 *  there. Ramps, gates, the stunt pieces and signposts stand on roads on purpose. */
export const ROAD_BLOCKERS = new Set(['pillar', 'ice_block', 'tire_stack', 'crate', 'barrel', 'b_crate', 'b_brick', 'caravan', 'picnic_table',
  'tent_orange', 'tent_red', 'tent_blue', 'cabin', 'shack', 'snowman', 'igloo', 'water_tower', 'windmill', 'umbrella', 'gallery'])

// ---------------------------------------------------------------- bridges
const PLANK = srgbLin(0x9a7650), PLANK2 = srgbLin(0x7e5c3c), BEAM = srgbLin(0x5c4128), ROPE = srgbLin(0x6a5236), POST = srgbLin(0x6e5032), SUB = srgbLin(0x3a2a1c)

/**
 * A map road's bridge in Dark's style (Road/bridges.ts: the plank suspension bridge) — along the road's own path
 * (`xs / zs / ys`: the deck centre line, the samples before / after the gorge on the banks), `hw` half deck width.
 * Stringers + a solid sub-deck just under the planks (the car's hulls ride it), planks across, posts at the ends,
 * main ropes sagging between them, hangers and a handrail rope each side. The deck starts / ends 1.5 m out on the
 * banks, flush with the road. Returns the mesh (batch layout, wood paint) and its collision soup (deck + posts).
 */
export function mapBridge(xs: number[], zs: number[], ys: number[], hw: number): { geo: THREE.BufferGeometry; tris: Float32Array } {
  const vis: CragMesh = { pos: [], nor: [], col: [] }
  const colm: CragMesh = { pos: [], nor: [], col: [] }
  // centre line at 1 m steps, extended 1.5 m past each end
  const pts: V3[] = []
  const n = xs.length
  const ext = (i: number, j: number): V3 => {
    const dx = xs[i] - xs[j], dz = zs[i] - zs[j], l = Math.hypot(dx, dz) || 1
    return [xs[i] + (dx / l) * 1.5, ys[i], zs[i] + (dz / l) * 1.5]
  }
  const line: V3[] = [ext(0, 1), ...xs.map((x, i): V3 => [x, ys[i], zs[i]]), ext(n - 1, n - 2)]
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1], L = Math.hypot(b[0] - a[0], b[2] - a[2]), k = Math.max(1, Math.round(L))
    for (let j = 0; j < k; j++) pts.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k, a[2] + ((b[2] - a[2]) * j) / k])
  }
  pts.push(line[line.length - 1])
  const across = (i: number): V3 => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]
    const dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1
    return [-dz / l, 0, dx / l]
  }
  const off = (p: V3, w: V3, s: number, dy = 0): V3 => [p[0] + w[0] * s, p[1] + dy, p[2] + w[2] * s]
  // deck: stringers + sub-deck per 1 m segment (also the collider), planks every 0.31 m
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], w = across(i)
    for (const s of [-hw * 0.7, hw * 0.7]) beam(vis, off(a, w, s, -0.2), off(b, w, s, -0.2), 0.11, BEAM)
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz) || 1
    const u: V3 = [dx / L, dy / L, dz / L]
    const v: V3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
    const up: V3 = v[1] < 0 ? [-v[0], -v[1], -v[2]] : v
    const c: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 0.07, (a[2] + b[2]) / 2]
    obox(vis, c, u, up, w, L / 2 + 0.02, 0.04, hw - 0.05, SUB)
    obox(colm, [c[0], c[1] + 0.02, c[2]], u, up, w, L / 2 + 0.05, 0.06, hw, SUB)
  }
  let acc = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], L = Math.hypot(b[0] - a[0], b[2] - a[2])
    for (; acc < L; acc += 0.31) {
      const t = acc / L, p: V3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - 0.03, a[2] + (b[2] - a[2]) * t]
      const w = across(i), u: V3 = [w[2], 0, -w[0]]
      const h = Math.abs(Math.sin(p[0] * 12.9898 + p[2] * 78.233) * 43758.5453) % 1
      const k = 0.88 + 0.22 * ((h * 7.1) % 1), col = h < 0.3 ? PLANK2 : PLANK
      obox(vis, off(p, w, (h - 0.5) * 0.12), u, [0, 1, 0], w, 0.13, 0.04, hw + 0.05 * h, [col[0] * k, col[1] * k, col[2] * k])
    }
    acc -= L
  }
  // posts (the bank ends), lintel, main ropes, hangers, handrails
  const postH = 2.7, first = 1, last = pts.length - 2
  for (const i of [first, last]) {
    const p = pts[i], w = across(i)
    for (const s of [-1, 1]) {
      beam(vis, off(p, w, s * (hw + 0.15), -1.2), off(p, w, s * (hw + 0.15), postH), 0.13, POST)
      beam(colm, off(p, w, s * (hw + 0.15), -1.2), off(p, w, s * (hw + 0.15), postH), 0.13, POST)
    }
    beam(vis, off(p, w, -hw - 0.3, postH - 0.25), off(p, w, hw + 0.3, postH - 0.25), 0.1, POST)
  }
  const ropeY = (i: number) => {
    const t = (i - first) / (last - first)
    return 1.15 + (postH - 0.35 - 1.15) * Math.pow(2 * t - 1, 2)
  }
  for (const s of [-1, 1]) {
    for (let i = first; i < last; i++) {
      const a = pts[i], b = pts[i + 1], wa = across(i), wb = across(i + 1)
      beam(vis, off(a, wa, s * (hw + 0.15), ropeY(i)), off(b, wb, s * (hw + 0.15), ropeY(i + 1)), 0.045, ROPE)
      beam(vis, off(a, wa, s * (hw + 0.15), 1.05), off(b, wb, s * (hw + 0.15), 1.05), 0.04, ROPE)
      if (i > first && (i - first) % 2 === 0) beam(vis, off(a, wa, s * (hw + 0.15), -0.05), off(a, wa, s * (hw + 0.15), ropeY(i)), 0.03, ROPE)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(vis.pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(vis.nor, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(vis.col, 3))
  const uv = new Float32Array((vis.pos.length / 3) * 2)
  for (let i = 0; i < uv.length; i += 2) (uv[i] = SURFACE_UV.wood[0]), (uv[i + 1] = SURFACE_UV.wood[1])
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return { geo: g, tris: Float32Array.from(colm.pos) }
}
