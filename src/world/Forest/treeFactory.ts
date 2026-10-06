import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { ATLAS_CELLS, cellUv, SOLID_UV, SURFACE_UV } from '../../rendering/materials/FoliageAtlas'
import { isGenshin, isOverland, isStorybook } from '../../rendering/artStyle'
import { Rng } from '../noise/rng'
import { TreeSpecies } from '../types'
import { agave, dryShrub, joshua, saguaro } from './desertFlora'
import { crownLump, Soup, srgb, sub, tuft, type V3 } from './treeParts'
import { ANCIENT_TREE, broadleaf, cardBush, glowShrooms, gnarledSnag, leafPile, LIYUE_PINE, MAPLE_TREE, MONDSTADT_TREE, shroomTree, twistedPine } from './genshinTrees'

/**
 * Procedural stylized trees (refer/forest, refer/roads hero) built from alpha-tested FOLIAGE CARDS on a solid
 * core, with "canopy" normals (pointing out of the crown volume instead of per-face) — the standard trick for
 * soft, painterly foliage shading instead of faceted low-poly.
 *
 * Every part (cards, cores, trunks) is in ONE geometry with ONE material (solid parts sample an opaque atlas
 * texel), so a species is still one instanced draw call. Built once with fixed seeds → identical everywhere.
 *   levels: [0] near (dense sprays)  [1] mid (fewer, larger cards — LOW's near level)  [2] far (core + few cards)
 * Canopies start ≥ ~3 m up (bare trunks below): the eye (1.6 m) and the driving camera (~3.5 m) pass UNDER the
 * foliage through a forest instead of inside it; the foliage material also dithers out cards within ~2.5 m
 * of the camera (stylize `nearFade`).
 */
export interface SpeciesDef {
  id: number
  name: string
  levels: [THREE.BufferGeometry, THREE.BufferGeometry, THREE.BufferGeometry]
  trunkRadius: number
  trunkHalfHeight: number
}

/** A flat card p0→p1 with half-width vector `side`; normals from `centre` (canopy volume). */
function card(s: Soup, p0: V3, p1: V3, side: V3, cell: number, centre: V3, c0: THREE.Color, c1: THREE.Color, upBias = 0.35): void {
  const [u0, v0, u1, v1] = cellUv(cell)
  const corners: [V3, [number, number], THREE.Color][] = [
    [[p0[0] - side[0], p0[1] - side[1], p0[2] - side[2]], [u0, v0], c0],
    [[p0[0] + side[0], p0[1] + side[1], p0[2] + side[2]], [u0, v1], c0],
    [[p1[0] + side[0], p1[1] + side[1], p1[2] + side[2]], [u1, v1], c1],
    [[p1[0] - side[0], p1[1] - side[1], p1[2] - side[2]], [u1, v0], c1],
  ]
  const n = (p: V3): V3 => {
    const d = sub(p, centre)
    return [d[0], d[1] * 0.6 + upBias * Math.hypot(d[0], d[2]), d[2]]
  }
  for (const i of [0, 1, 2, 0, 2, 3]) s.vert(corners[i][0], n(corners[i][0]), corners[i][1], corners[i][2])
}

/** Solid tapered cylinder / cone (trunk or canopy core) with smooth radial (+up-biased) normals. */
function solid(s: Soup, y0: number, y1: number, r0: number, r1: number, sides: number, c0: THREE.Color, c1: THREE.Color, upBias = 0, uv: readonly [number, number] = SOLID_UV): void {
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2
    const a1 = ((i + 1) / sides) * Math.PI * 2
    const q = (a: number, y: number, r: number): V3 => [Math.cos(a) * r, y, Math.sin(a) * r]
    const n = (a: number): V3 => [Math.cos(a), upBias, Math.sin(a)]
    const A = q(a0, y0, r0), B = q(a1, y0, r0), C = q(a1, y1, r1), D = q(a0, y1, r1)
    s.vert(A, n(a0), uv, c0); s.vert(C, n(a1), uv, c1); s.vert(B, n(a1), uv, c0)
    s.vert(A, n(a0), uv, c0); s.vert(D, n(a0), uv, c1); s.vert(C, n(a1), uv, c1)
  }
}

/** Solid lumpy blob with spherical normals (crown cores, bushes). */
function blob(s: Soup, c: V3, r: number, flat: number, rng: Rng, col: THREE.Color, detail = 0): void {
  const g = new THREE.IcosahedronGeometry(1, detail)
  const p = g.getAttribute('position')
  const j = new Map<string, number>()
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
    const key = `${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`
    if (!j.has(key)) j.set(key, rng.range(0.8, 1.15))
    const k = j.get(key)!
    const v: V3 = [c[0] + x * r * k, c[1] + y * r * k * flat, c[2] + z * r * k]
    const shade = 0.7 + 0.3 * (y * 0.5 + 0.5)
    s.vert(v, [x, y, z], SOLID_UV, col.clone().multiplyScalar(shade))
  }
  g.dispose()
}

/** Leaf/needle cluster: cards arranged over a sphere, facing outward, spherical normals. */
function cluster(s: Soup, c: V3, r: number, cards: number, cell: number, rng: Rng, dark: THREE.Color, light: THREE.Color): void {
  for (let i = 0; i < cards; i++) {
    const u = rng.next() * 2 - 1
    const a = rng.next() * Math.PI * 2
    const d: V3 = [Math.sqrt(1 - u * u) * Math.cos(a), u * 0.75 + 0.2, Math.sqrt(1 - u * u) * Math.sin(a)]
    const size = r * rng.range(0.85, 1.25)
    const centre: V3 = [c[0] + d[0] * r * 0.55, c[1] + d[1] * r * 0.55, c[2] + d[2] * r * 0.55]
    // Card plane perpendicular to d: pick two tangent axes.
    const t1: V3 = Math.abs(d[1]) < 0.9 ? [-d[2], 0, d[0]] : [1, 0, 0]
    const l1 = Math.hypot(...t1)
    const tx: V3 = [t1[0] / l1, t1[1] / l1, t1[2] / l1]
    const ty: V3 = [d[1] * tx[2] - d[2] * tx[1], d[2] * tx[0] - d[0] * tx[2], d[0] * tx[1] - d[1] * tx[0]]
    const half = size * 0.5
    const p0: V3 = [centre[0] - ty[0] * half, centre[1] - ty[1] * half, centre[2] - ty[2] * half]
    const p1: V3 = [centre[0] + ty[0] * half, centre[1] + ty[1] * half, centre[2] + ty[2] * half]
    const side: V3 = [tx[0] * half, tx[1] * half, tx[2] * half]
    const k = 0.5 + 0.5 * (d[1] * 0.5 + 0.5)
    card(s, p0, p1, side, cell, c, dark.clone().lerp(light, k * 0.6), dark.clone().lerp(light, k), 0.2)
  }
}

interface ConiferOpts {
  height: number
  radius: number
  /** Trunk height without branches (m). */
  bare: number
  tiers: number[]
  points: number[]
  droop: number
  dark: number
  light: number
  trunk: number
}

/**
 * One drooping SKIRT: solid star cone (alternating long/short points, tips hanging below the base, slightly
 * up-turned), soft canopy normals, lighter top; plus hanging needle-FRINGE cards along the rim (level 0: all
 * gaps, level 1: every other, level 2: none). Double-sided material → the back face is the underside.
 */
function skirt(s: Soup, c: V3, r: number, h: number, points: number, droop: number, dark: THREE.Color, light: THREE.Color, lit: number, level: number, rng: Rng): void {
  const [fu0, fv0, fu1, fv1] = cellUv(ATLAS_CELLS.spray)
  const rot = rng.next() * 6.28
  const y = c[1]
  const apex: V3 = [c[0], y + h, c[2]]
  const n = points * 2
  const ring: V3[] = []
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2 + rng.range(-0.1, 0.1)
    const long = i % 2 === 0
    const rr = r * (long ? rng.range(0.92, 1.1) : rng.range(0.62, 0.74))
    const dy = -(long ? droop : droop * 0.4) * rr + (long ? rng.range(0, 0.12) * rr : 0)
    ring.push([c[0] + Math.cos(a) * rr, y + dy, c[2] + Math.sin(a) * rr])
  }
  const topC = dark.clone().lerp(light, lit)
  const rimC = dark.clone().lerp(light, lit * 0.5)
  const nrm = (p: V3): V3 => [p[0] - c[0], (p[1] - y) * 0.8 + 0.55 * Math.hypot(p[0] - c[0], p[2] - c[2]), p[2] - c[2]]
  for (let i = 0; i < n; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % n]
    s.vert(apex, [0, 1, 0], SOLID_UV, topC); s.vert(b, nrm(b), SOLID_UV, rimC); s.vert(a, nrm(a), SOLID_UV, rimC)
  }
  if (level >= 2) return
  for (let i = 0; i < n; i += level === 0 ? 1 : 2) {
    const a = ring[i]
    const b = ring[(i + 1) % n]
    const drop = r * rng.range(0.28, 0.42)
    const out = (p: V3, k: number, dy: number): V3 => [c[0] + (p[0] - c[0]) * k, p[1] + dy, c[2] + (p[2] - c[2]) * k]
    const A = out(a, 1.06, 0.05), B = out(b, 1.06, 0.05), C = out(b, 1.08, -drop), D = out(a, 1.08, -drop)
    const na = nrm(a), nb = nrm(b)
    const fc = rimC.clone().multiplyScalar(0.9)
    s.vert(A, na, [fu0, fv1], fc); s.vert(B, nb, [fu1, fv1], fc); s.vert(C, nb, [fu1, fv0], fc)
    s.vert(A, na, [fu0, fv1], fc); s.vert(C, nb, [fu1, fv0], fc); s.vert(D, na, [fu0, fv0], fc)
  }
}

/**
 * Painted spruce/fir (refer/roads hero, refer/forest): trunk + thin dark core + IRREGULAR drooping branch
 * clumps spiralling up the trunk (golden angle + jitter, lengths ±35%, ~12% skipped → sky shows through),
 * each clump = 2 crossed branch-spray cards. Canopy normals from the trunk axis → soft painterly light;
 * colour darkens toward trunk/bottom, lightens toward tips/top. Far level keeps solid skirts (cheap).
 */
function conifer(level: number, rng: Rng, o: ConiferOpts): THREE.BufferGeometry {
  const s = new Soup()
  const H = o.height
  const dark = srgb(o.dark)
  const light = srgb(o.light)
  const bark = srgb(o.trunk)
  solid(s, 0, H * 0.9, 0.2, 0.05, level === 2 ? 4 : 6, bark.clone().multiplyScalar(0.6), bark, 0, SURFACE_UV.bark)
  if (level === 2) {
    const tiers = o.tiers[2]
    for (let t = 0; t < tiers; t++) {
      const k = t / tiers
      const y = o.bare + (H * 0.93 - o.bare) * k
      skirt(s, [0, y, 0], o.radius * Math.pow(1 - k, 1.1) + 0.3, Math.max(0.9, (H - y) * 0.34), o.points[2], o.droop, dark, light, 0.35 + 0.5 * k, 2, rng)
    }
    return s.geometry('conifer')
  }
  // Thin core: only plugs the densest gaps near the trunk.
  solid(s, o.bare + 0.5, H * 0.96, o.radius * 0.32, 0.02, 5, dark.clone().multiplyScalar(0.45), dark.clone().multiplyScalar(0.7), 0.4)
  const [u0, v0, u1, v1] = cellUv(ATLAS_CELLS.spray)
  const clumps = level === 0 ? 42 : 16
  const GOLD = 2.39996
  for (let i = 0; i < clumps; i++) {
    if (rng.next() < 0.08) continue
    const k = (i + rng.next() * 0.7) / clumps
    const y = o.bare + (H * 0.94 - o.bare) * k
    const a = i * GOLD + rng.range(-0.35, 0.35)
    const L = (o.radius * Math.pow(1 - k, 0.9) + 0.35) * rng.range(0.65, 1.3) * (level === 1 ? 1.15 : 1)
    const droop = o.droop * rng.range(0.6, 1.3) * (0.55 + 0.45 * k) // the lowest branches droop least: the canopy stays above the eye
    const dx = Math.cos(a), dz = Math.sin(a)
    const p0: V3 = [dx * 0.08, y, dz * 0.08]
    const p1: V3 = [dx * L * Math.cos(droop), y - L * Math.sin(droop), dz * L * Math.cos(droop)]
    const w = L * (level === 0 ? 0.55 : 0.62)
    const centre: V3 = [0, y + 0.4, 0]
    const base = dark.clone().lerp(light, 0.1 + 0.35 * k)
    const tip = dark.clone().lerp(light, 0.45 + 0.45 * k)
    // Card 1: upright (seen from the side) — hanging needles downward. Card 2: tilted flat (seen from below/above).
    const up: V3 = [0, w, 0]
    const flat: V3 = [-dz * w * 0.9, w * 0.35, dx * w * 0.9]
    for (const side of level === 0 ? [up, flat] : [up, flat]) {
      const c0: V3 = [p0[0] - side[0] * 0.25, p0[1] - side[1] * 0.25, p0[2] - side[2] * 0.25]
      const c1: V3 = [p1[0] - side[0] * 0.25, p1[1] - side[1] * 0.25, p1[2] - side[2] * 0.25]
      cardUv(s, c0, c1, side, [u0, v0, u1, v1], centre, base, tip)
    }
    // Fluffy tuft near the branch end (silhouette clump).
    const tc: V3 = [p0[0] + (p1[0] - p0[0]) * 0.7, p0[1] + (p1[1] - p0[1]) * 0.7 + 0.1, p0[2] + (p1[2] - p0[2]) * 0.7]
    tuft(s, tc, L * (level === 0 ? 0.42 : 0.5), [0, y + 0.3, 0], dark.clone().lerp(light, 0.1 + 0.3 * k), dark.clone().lerp(light, 0.5 + 0.45 * k))
    // Genshin-style mass: a second, inner tuft so the cone is a dense fluffy volume, not a skeleton.
    if (level === 0) {
      const ti: V3 = [p0[0] + (p1[0] - p0[0]) * 0.35, p0[1] + (p1[1] - p0[1]) * 0.35 + 0.25, p0[2] + (p1[2] - p0[2]) * 0.35]
      tuft(s, ti, L * 0.4, [0, y + 0.3, 0], dark.clone().lerp(light, 0.05 + 0.25 * k), dark.clone().lerp(light, 0.35 + 0.4 * k))
    }
  }
  // Top: short upward sprays + spire.
  for (let i = 0; i < 4; i++) {
    const a = i * 1.57 + rng.range(-0.3, 0.3)
    const y = H * 0.9
    const p0: V3 = [0, y, 0]
    const p1: V3 = [Math.cos(a) * 0.55, y + 0.5, Math.sin(a) * 0.55]
    cardUv(s, p0, p1, [0, 0.35, 0], [u0, v0, u1, v1], [0, y, 0], light, light)
  }
  const sp: V3 = [0, H * 1.03, 0]
  for (let i = 0; i < 5; i++) {
    const a0 = (i / 5) * 6.283, a1 = ((i + 1) / 5) * 6.283
    const q0: V3 = [Math.cos(a0) * 0.22, H * 0.9, Math.sin(a0) * 0.22]
    const q1: V3 = [Math.cos(a1) * 0.22, H * 0.9, Math.sin(a1) * 0.22]
    s.vert(sp, [0, 1, 0], SOLID_UV, light); s.vert(q1, [q1[0], 0.3, q1[2]], SOLID_UV, dark); s.vert(q0, [q0[0], 0.3, q0[2]], SOLID_UV, dark)
  }
  return s.geometry('conifer')
}

/** Card with an explicit uv rect (u along p0→p1, v across `side`). */
function cardUv(s: Soup, p0: V3, p1: V3, side: V3, uv: [number, number, number, number], centre: V3, c0: THREE.Color, c1: THREE.Color): void {
  const [u0, v0, u1, v1] = uv
  const P: [V3, [number, number], THREE.Color][] = [
    [p0, [u0, v0], c0],
    [[p0[0] + side[0], p0[1] + side[1], p0[2] + side[2]], [u0, v1], c0],
    [[p1[0] + side[0], p1[1] + side[1], p1[2] + side[2]], [u1, v1], c1],
    [p1, [u1, v0], c1],
  ]
  const n = (p: V3): V3 => [p[0] - centre[0], (p[1] - centre[1]) * 0.5 + 0.45 * Math.hypot(p[0] - centre[0], p[2] - centre[2]), p[2] - centre[2]]
  for (const i of [0, 1, 2, 0, 2, 3]) s.vert(P[i][0], n(P[i][0]), P[i][1], P[i][2])
}

/**
 * STORYBOOK conifer (the forest-house study): neat STACKED drooping tiers — each a solid star cone with a
 * hanging fringe of brush-fan cards (atlas spray cell = `drawBrushSpray` in this style) — on a straight
 * orange-red trunk, pale sage with lit tier tops and darker undersides. Level 0 ≈ 7 tiers with full fringes,
 * 1 fewer tiers / every other fringe, 2 solid tiers only. Triangle count is at or below the default conifer.
 */
function storyConifer(level: number, rng: Rng, o: { height: number; radius: number; bare: number; droop: number; trunk: number }): THREE.BufferGeometry {
  const s = new Soup()
  const H = o.height
  const dark = srgb(0x2e4836)
  const light = srgb(0x9cb57e)
  const bark = srgb(o.trunk)
  solid(s, 0, H * 0.92, 0.2, 0.05, level === 2 ? 4 : 6, bark.clone().multiplyScalar(0.7), bark, 0, SURFACE_UV.bark)
  const tiers = [7, 5, 4][level]
  const points = [7, 6, 5][level]
  for (let t = 0; t < tiers; t++) {
    const k = t / tiers
    const y = o.bare + (H * 0.86 - o.bare) * k
    const r = o.radius * Math.pow(1 - k, 0.95) + 0.35
    skirt(s, [0, y, 0], r, Math.max(0.9, (H - y) * 0.3), points, o.droop, dark, light, 0.4 + 0.5 * k, level, rng)
  }
  skirt(s, [0, H * 0.88, 0], 0.5, H * 0.14, 5, 0.3, dark, light, 0.9, 2, rng) // spire
  return s.geometry('conifer')
}

/**
 * OVERLAND conifer (over the hill / art of rally): SOLID stacked spiky tiers — no cards, no tufts — many long/
 * short points per tier and a strong droop for the ragged silhouette, a tall bare trunk, saturated green
 * darkening toward the bottom (the per-stand hue palette adds the golden larches). Level 0 ≈ 9 tiers × 9
 * points (≈ 330 tris), 1 ≈ 6 × 7, 2 ≈ 4 × 6 — every level cheaper than the card conifers, no overdraw.
 */
function overConifer(level: number, rng: Rng, o: { height: number; radius: number; bare: number; droop: number; trunk: number; dark: number; light: number }): THREE.BufferGeometry {
  const s = new Soup()
  const H = o.height
  const dark = srgb(o.dark)
  const light = srgb(o.light)
  const bark = srgb(o.trunk)
  solid(s, 0, H * 0.95, 0.2, 0.05, level === 2 ? 4 : 6, bark.clone().multiplyScalar(0.7), bark, 0, SURFACE_UV.bark)
  // Over the hill's spruce: a tall narrow cone of many THIN horizontal SHELVES — flat star tiers with sharp
  // alternating long/short points, stacked closely, a slight droop, no cards or tufts. Dark green base, the
  // tops of the upper shelves lighter (yellow-green). ≈ 16 × 9-point tiers at level 0 (~600 tris), 9 × 7 at
  // level 1, 5 × 6 at level 2 — all solid, no overdraw.
  const tiers = [16, 9, 5][level]
  const points = [9, 7, 6][level]
  for (let t = 0; t < tiers; t++) {
    const k = t / tiers
    const y = o.bare + (H * 0.92 - o.bare) * k
    const r = o.radius * Math.pow(1 - k, 0.85) + 0.22
    skirt(s, [0, y, 0], r, Math.max(0.35, (H - y) * 0.12), points, o.droop * (0.7 + 0.3 * k), dark, light, 0.25 + 0.7 * k, 2, rng)
  }
  skirt(s, [0, H * 0.93, 0], 0.35, H * 0.09, 5, 0.3, dark, light, 0.95, 2, rng) // spire
  return s.geometry('conifer')
}

/** OVERLAND broadleaf: banded trunk + a few SOLID crown lumps shaded as one volume (no tufts). */
function overBirch(level: number, rng: Rng): THREE.BufferGeometry {
  const s = new Soup()
  const barkL = srgb(0xd9d4c4)
  const barkD = srgb(0x55504a)
  const segs = level === 0 ? 4 : 2
  for (let k = 0; k < segs; k++) {
    const y0 = (k / segs) * 7.2, y1 = ((k + 1) / segs) * 7.2
    const c = k % 3 === 1 && level === 0 ? barkD : barkL
    solid(s, y0, y1, 0.2 - k * 0.025, 0.2 - (k + 1) * 0.025, level === 2 ? 4 : 6, c.clone().multiplyScalar(0.75), c, 0, SURFACE_UV.bark)
  }
  const dark = srgb(0x8a6420), light = srgb(0xe8b848) // autumn gold-orange crowns (their round trees)
  const centre: V3 = [0, 7.0, 0]
  const lumps = [7, 4, 1][level]
  for (let i = 0; i < lumps; i++) {
    const u = rng.next() * 2 - 1
    const a = rng.next() * Math.PI * 2
    const rr = i === 0 ? 0 : rng.range(0.55, 1.0)
    const c: V3 = [centre[0] + Math.sqrt(1 - u * u) * Math.cos(a) * rr * 1.2, centre[1] + u * rr * 0.8, centre[2] + Math.sqrt(1 - u * u) * Math.sin(a) * rr * 1.2]
    const r = (i === 0 ? 1.7 : rng.range(0.9, 1.25)) * (lumps === 1 ? 1.9 : 1)
    crownLump(s, c, r, centre, rng, dark, light, level === 0 && i < 3 ? 1 : 0)
  }
  return s.geometry('birch')
}

function spruce(level: number, rng: Rng): THREE.BufferGeometry {
  if (isOverland()) return overConifer(level, rng, { height: 16, radius: 2.9, bare: 2.2, droop: 0.42, trunk: 0x4a3222, dark: 0x22482a, light: 0x7aa636 })
  if (isStorybook()) return storyConifer(level, rng, { height: 11, radius: 2.5, bare: 4.2, droop: 0.55, trunk: 0x9a4a2e })
  // Genshin (reference-matched): conifers are a mid TEAL (sampled ≈ 40, 88, 90 on screen), not near-black.
  if (isGenshin()) return conifer(level, rng, { height: 11, radius: 2.6, bare: 4.4, tiers: [8, 4, 3], points: [6, 5, 4], droop: 0.5, dark: 0x2e6660, light: 0x78b49a, trunk: 0x5a4434 })
  return conifer(level, rng, { height: 11, radius: 2.6, bare: 4.4, tiers: [8, 4, 3], points: [6, 5, 4], droop: 0.5, dark: 0x16302e, light: 0x4c7a5c, trunk: 0x4e3a2e })
}

function fir(level: number, rng: Rng): THREE.BufferGeometry {
  if (isOverland()) return overConifer(level, rng, { height: 13, radius: 3.1, bare: 2.0, droop: 0.4, trunk: 0x46301f, dark: 0x1e4228, light: 0x6c9e34 })
  if (isStorybook()) return storyConifer(level, rng, { height: 9.5, radius: 2.7, bare: 4.0, droop: 0.45, trunk: 0x9a4a2e })
  if (isGenshin()) return conifer(level, rng, { height: 9.5, radius: 2.9, bare: 4.1, tiers: [7, 4, 3], points: [7, 5, 4], droop: 0.38, dark: 0x2c605c, light: 0x70ac94, trunk: 0x56402f })
  return conifer(level, rng, { height: 9.5, radius: 2.9, bare: 4.1, tiers: [7, 4, 3], points: [7, 5, 4], droop: 0.38, dark: 0x15292c, light: 0x3f6a5a, trunk: 0x4a372c })
}

/** Tall pine: long bare reddish trunk, a few flat drooping PADS offset around the top third (refs). */
function pine(level: number, rng: Rng): THREE.BufferGeometry {
  // Overland: the tallest, narrowest spire of the stand (their skyline pines), long bare trunk.
  if (isOverland()) return overConifer(level, rng, { height: 19, radius: 2.6, bare: 4.2, droop: 0.42, trunk: 0x54392a, dark: 0x21482a, light: 0x7aa438 })
  // Storybook: the tall redwood-like conifer of the reference (long bare orange-red trunk, tiers up top).
  if (isStorybook()) return storyConifer(level, rng, { height: 12.5, radius: 2.3, bare: 5.2, droop: 0.5, trunk: 0xa8502e })
  // Genshin: Liyue's twisted pine — S-bent trunk, flat cloud pads on near-horizontal branches (genshinTrees.ts).
  return twistedPine(level, rng, isGenshin() ? { ...LIYUE_PINE, branches: 6, dark: 0x1e5246, light: 0x7cc690, bark: 0x7a5640 } : LIYUE_PINE)
}

/** The previous pine (straight pole + pads), kept for reference / comparison shots. */
export function polePine(level: number, rng: Rng): THREE.BufferGeometry {
  const s = new Soup()
  const bark = srgb(0x7a4a32)
  const dark = srgb(0x1f3d2c)
  const light = srgb(0x557f4f)
  // Genshin proportions: ~4 m of bare trunk (the driving camera and the eye pass under the crown), then a big fluffy crown.
  solid(s, 0, 9.2, 0.3, 0.12, level === 2 ? 4 : 6, bark.clone().multiplyScalar(0.6), bark, 0, SURFACE_UV.bark)
  const pads = [6, 4, 2][level]
  for (let i = 0; i < pads; i++) {
    const k = i / pads
    const a = rng.next() * 6.28
    const off = i === pads - 1 ? 0 : rng.range(0.5, 1.1)
    const c: V3 = [Math.cos(a) * off, 5.2 + k * 4.0, Math.sin(a) * off]
    const pr = rng.range(1.7, 2.3) * (1 - k * 0.45)
    skirt(s, c, pr, 0.8, level === 0 ? 6 : 5, 0.22, dark, light, 0.55, level, rng)
    // Fluffy rim: tufts around each pad.
    const nt = level === 0 ? 10 : level === 1 ? 5 : 0
    for (let t = 0; t < nt; t++) {
      const ta = (t / nt) * Math.PI * 2 + rng.range(-0.3, 0.3)
      tuft(s, [c[0] + Math.cos(ta) * pr * 0.75, c[1] + 0.2 + rng.range(-0.15, 0.35), c[2] + Math.sin(ta) * pr * 0.75], pr * 0.55, c, dark, light)
    }
  }
  return s.geometry('pine')
}

/** Birch/aspen: banded white trunk, soft rounded crown MASSES (smooth normals) with leaf tufts at the edge. */
/**
 * STORYBOOK birch (the reference's pale snags): slim cream trunk with orange-rust bands, a few thin bare
 * branches reaching up, two small brush-fan sprays near the top. Far level = trunk only.
 */
function storyBirch(level: number, rng: Rng): THREE.BufferGeometry {
  const s = new Soup()
  const cream = srgb(0xe6d8c2), rust = srgb(0xc8744a)
  const segs = level === 0 ? 6 : 3
  for (let k = 0; k < segs; k++) {
    const y0 = (k / segs) * 6.8, y1 = ((k + 1) / segs) * 6.8
    const c = k % 2 === 1 ? rust : cream
    solid(s, y0, y1, 0.16 - k * 0.018, 0.16 - (k + 1) * 0.018, level === 2 ? 4 : 5, c.clone().multiplyScalar(0.85), c, 0, SURFACE_UV.bark)
  }
  if (level === 2) return s.geometry('birch')
  const m = new THREE.Matrix4(), nm = new THREE.Matrix3(), p = new THREE.Vector3(), n = new THREE.Vector3()
  for (let i = 0; i < (level === 0 ? 5 : 3); i++) {
    const y = rng.range(3.8, 6.2), a = rng.next() * 6.28, len = rng.range(0.7, 1.4)
    const b = new Soup()
    solid(b, 0, len, 0.05, 0.012, 4, cream.clone().multiplyScalar(0.8), cream, 0, SURFACE_UV.bark)
    m.makeRotationFromEuler(new THREE.Euler(0, -a, -0.6 + rng.range(-0.2, 0.2), 'YXZ')).setPosition(0, y, 0)
    nm.getNormalMatrix(m)
    for (let v = 0; v < b.pos.length / 3; v++) {
      p.fromArray(b.pos, v * 3).applyMatrix4(m)
      n.fromArray(b.nor, v * 3).applyMatrix3(nm)
      s.vert([p.x, p.y, p.z], [n.x, n.y, n.z], SURFACE_UV.bark, new THREE.Color(b.col[v * 3], b.col[v * 3 + 1], b.col[v * 3 + 2]))
    }
  }
  const [u0, v0, u1, v1] = cellUv(ATLAS_CELLS.spray)
  const dark = srgb(0x4a6444), light = srgb(0x9cb57e)
  for (let i = 0; i < 3; i++) {
    const a = rng.next() * 6.28, y = 6.0 + i * 0.35
    cardUv(s, [0, y, 0], [Math.cos(a) * 1.1, y - 0.3, Math.sin(a) * 1.1], [0, 0.7, 0], [u0, v0, u1, v1], [0, y, 0], dark, light)
  }
  return s.geometry('birch')
}

function birch(level: number, rng: Rng): THREE.BufferGeometry {
  if (isOverland()) return overBirch(level, rng)
  if (isStorybook()) return storyBirch(level, rng)
  // Genshin: a Mondstadt broadleaf — rooted, twisting trunk, forked limbs, cloud clumps (genshinTrees.ts).
  // Genshin (reference-matched): fresh mid green with teal shade (sampled broadleaf ≈ 75,125,60 lit / 45,90,75 shade).
  return broadleaf(level, rng, isGenshin() ? { ...MONDSTADT_TREE, plates: true, fork: 2.0, spread: 3.7, limbs: 5, clumpR: 1.6, lean: 0.06, dark: 0x1a5248, light: 0xb4dc6c, bark: 0x7e5a3e } : MONDSTADT_TREE, 'birch')
}

/** The previous birch (pole + ball crown), kept for reference / comparison shots. */
export function ballBirch(level: number, rng: Rng): THREE.BufferGeometry {
  const s = new Soup()
  const barkL = srgb(0xd9d4c4)
  const barkD = srgb(0x55504a)
  const segs = level === 0 ? 4 : 2
  for (let k = 0; k < segs; k++) {
    const y0 = (k / segs) * 7.2
    const y1 = ((k + 1) / segs) * 7.2
    const c = k % 3 === 1 && level === 0 ? barkD : barkL
    solid(s, y0, y1, 0.2 - k * 0.025, 0.2 - (k + 1) * 0.025, level === 2 ? 4 : 6, c.clone().multiplyScalar(0.75), c, 0, SURFACE_UV.bark)
  }
  // Crown = a cumulus of small lumps shaded as ONE soft volume (normals from the crown centre, not per lump):
  // bumpy painted silhouette, smooth painterly light — refer/roads roadside trees.
  const dark = srgb(0x44603a)
  const light = srgb(0x8c9c4c)
  const centre: V3 = [0, 6.9, 0]
  // Near/mid: small solid core + a cloud of camera-facing tufts over the crown (fluffy tree). Far: lumps.
  if (level < 2) {
    crownLump(s, centre, 1.6, centre, rng, dark, light, 0)
    const n = level === 0 ? 44 : 18
    for (let i = 0; i < n; i++) {
      const u = rng.next() * 2 - 1
      const a = rng.next() * Math.PI * 2
      const rr = rng.range(0.75, 1.2)
      const c: V3 = [Math.sqrt(1 - u * u) * Math.cos(a) * rr * 2.1, centre[1] + u * rr * 1.5 + 0.2, Math.sqrt(1 - u * u) * Math.sin(a) * rr * 2.1]
      tuft(s, c, rng.range(0.8, 1.1) * (level === 1 ? 1.35 : 1), centre, dark, light)
    }
    return s.geometry('birch')
  }
  const lumps = [8, 4, 1][level]
  for (let i = 0; i < lumps; i++) {
    const u = rng.next() * 2 - 1
    const a = rng.next() * Math.PI * 2
    const rr = i === 0 ? 0 : rng.range(0.55, 1.0)
    const c: V3 = [centre[0] + Math.sqrt(1 - u * u) * Math.cos(a) * rr * 1.1, centre[1] + u * rr * 0.75, centre[2] + Math.sqrt(1 - u * u) * Math.sin(a) * rr * 1.1]
    const r = (i === 0 ? 1.6 : rng.range(0.9, 1.2)) * (lumps === 1 ? 1.9 : 1)
    crownLump(s, c, r, centre, rng, dark, light, level === 0 && i < 3 ? 1 : 0)
  }
  return s.geometry('birch')
}

function dead(level: number, rng: Rng): THREE.BufferGeometry {
  if (!isOverland() && !isStorybook()) return gnarledSnag(level, rng)
  const s = new Soup()
  const c = srgb(0x6e665c)
  solid(s, 0, 7, 0.24, 0.05, level === 2 ? 4 : 6, c.clone().multiplyScalar(0.6), c, 0, SURFACE_UV.bark)
  const branches = [6, 3, 0][level]
  const m = new THREE.Matrix4()
  const nm = new THREE.Matrix3()
  const p = new THREE.Vector3()
  const n = new THREE.Vector3()
  for (let i = 0; i < branches; i++) {
    const y = rng.range(3.4, 6.4)
    const a = rng.next() * 6.28
    const len = rng.range(0.9, 1.8)
    const b = new Soup()
    solid(b, 0, len, 0.07, 0.015, 4, c.clone().multiplyScalar(0.7), c, 0, SURFACE_UV.bark)
    m.makeRotationFromEuler(new THREE.Euler(0, -a, -1.0 + rng.range(-0.2, 0.2), 'YXZ')).setPosition(0, y, 0)
    nm.getNormalMatrix(m)
    for (let v = 0; v < b.pos.length / 3; v++) {
      p.fromArray(b.pos, v * 3).applyMatrix4(m)
      n.fromArray(b.nor, v * 3).applyMatrix3(nm)
      s.vert([p.x, p.y, p.z], [n.x, n.y, n.z], SURFACE_UV.bark, new THREE.Color(b.col[v * 3], b.col[v * 3 + 1], b.col[v * 3 + 2]))
    }
  }
  return s.geometry('dead')
}

/**
 * SPECIES REGISTRY: a GLB / GLTF tree (three detail levels on the shared vegetation material's vertex format — see
 * skills/asset-optimization and `npm run validate:assets`) can replace or add a species before the world is built:
 * `registerTreeSpecies({ id: TreeSpecies.Maple, name: 'maple', levels: [l0, l1, l2], trunkRadius, trunkHalfHeight })`.
 * Region tables (BiomeDefs) refer to species ids only, so nothing else changes.
 */
const EXTRA_SPECIES: SpeciesDef[] = []
export function registerTreeSpecies(def: SpeciesDef): void {
  const i = EXTRA_SPECIES.findIndex((s) => s.id === def.id)
  if (i >= 0) EXTRA_SPECIES[i] = def
  else EXTRA_SPECIES.push(def)
}

export function createTreeLibrary(): { species: SpeciesDef[]; dispose(): void } {
  const build = (fn: (l: number, r: Rng) => THREE.BufferGeometry, seed: number, name: string) =>
    [0, 1, 2].map((l) => {
      const soup = fn(l, new Rng(seed + l))
      // Index the triangle soup (shared corners of cards, tube rings, lumps): the vegetation vertex shader (sway,
      // billboarding, per-vertex sky fog) then runs once per unique vertex instead of 3× per triangle — it is the
      // trees' main GPU cost on phones (fixed per frame, and again in the shadow pass). Identical image.
      const g = mergeVertices(soup, 1e-5)
      soup.dispose()
      g.computeBoundingSphere()
      g.name = `${name}.lod${l}`
      return g
    }) as SpeciesDef['levels']
  const species: SpeciesDef[] = [
    { id: TreeSpecies.Spruce, name: 'spruce', levels: build(spruce, 101, 'spruce'), trunkRadius: 0.24, trunkHalfHeight: 3 },
    { id: TreeSpecies.Dead, name: 'dead', levels: build(dead, 202, 'dead'), trunkRadius: 0.22, trunkHalfHeight: 3 },
    { id: TreeSpecies.Fir, name: 'fir', levels: build(fir, 303, 'fir'), trunkRadius: 0.28, trunkHalfHeight: 3 },
    { id: TreeSpecies.Pine, name: 'pine', levels: build(pine, 404, 'pine'), trunkRadius: 0.32, trunkHalfHeight: 4 },
    { id: TreeSpecies.Birch, name: 'birch', levels: build(birch, 505, 'birch'), trunkRadius: 0.3, trunkHalfHeight: 3 },
    { id: TreeSpecies.Cactus, name: 'cactus', levels: build(desert(saguaro, 'cactus'), 606, 'cactus'), trunkRadius: 0.34, trunkHalfHeight: 3 },
    { id: TreeSpecies.Joshua, name: 'joshua', levels: build(desert(joshua, 'joshua'), 707, 'joshua'), trunkRadius: 0.3, trunkHalfHeight: 1.5 },
    // Region species (world/biomes/BiomeDefs.ts): autumn maple, mystic ancient giant and glowing mushroom tree.
    { id: TreeSpecies.Maple, name: 'maple', levels: build((l, r) => broadleaf(l, r, isGenshin() ? { ...MAPLE_TREE, plates: true, fork: 1.8, spread: 3.9, limbs: 5, clumpR: 1.65 } : MAPLE_TREE, 'maple'), 808, 'maple'), trunkRadius: 0.3, trunkHalfHeight: 3 },
    { id: TreeSpecies.Ancient, name: 'ancient', levels: build((l, r) => broadleaf(l, r, isGenshin() ? { ...ANCIENT_TREE, plates: true, fork: 3.0, spread: 5.4, limbs: 6, clumpR: 2.3 } : ANCIENT_TREE, 'ancient'), 909, 'ancient'), trunkRadius: 0.6, trunkHalfHeight: 4 },
    { id: TreeSpecies.Shroom, name: 'shroom', levels: build(shroomTree, 1010, 'shroom'), trunkRadius: 0.26, trunkHalfHeight: 2.5 },
  ]
  // Registered species (e.g. GLB models, `registerTreeSpecies`) replace the built-in one with the same id.
  for (const extra of EXTRA_SPECIES) {
    const i = species.findIndex((s) => s.id === extra.id)
    if (i >= 0) species[i].levels.forEach((g) => g.dispose())
    if (i >= 0) species[i] = extra
    else species.push(extra)
  }
  return { species, dispose: () => species.forEach((s) => s.levels.forEach((g) => g.dispose())) }
}

function desert(fn: (s: Soup, level: number, rng: Rng) => void, name: string): (level: number, rng: Rng) => THREE.BufferGeometry {
  return (level, rng) => {
    const s = new Soup()
    fn(s, level, rng)
    return s.geometry(name)
  }
}

/** Desert undergrowth: agave rosettes and grey-olive dry shrubs (replace ferns/bushes on sand, WorldChunk). */
export function createDesertUndergrowth(): { agave: THREE.BufferGeometry; shrub: THREE.BufferGeometry } {
  const rng = new Rng(919)
  const a = new Soup()
  agave(a, rng)
  const b = new Soup()
  dryShrub(b, rng)
  return { agave: a.geometry('agave'), shrub: b.geometry('dryShrub') }
}

/** Region undergrowth: autumn leaf piles and mystic glowing mushroom clusters (BiomeDefs Plant). */
export function createRegionUndergrowth(): { leafPile: THREE.BufferGeometry; glowShroom: THREE.BufferGeometry } {
  const rng = new Rng(929)
  const lp = mergeVertices(leafPile(rng), 1e-5), gs = mergeVertices(glowShrooms(rng), 1e-5)
  lp.computeBoundingSphere(); gs.computeBoundingSphere()
  lp.name = 'leafPile'; gs.name = 'glowShroom'
  return { leafPile: lp, glowShroom: gs }
}

/** Fern: 6 arched frond cards (fern cell). Bush: blob + leaf cards. */
export function createUndergrowth(): { fern: THREE.BufferGeometry; bush: THREE.BufferGeometry } {
  const rng = new Rng(909)
  const s = new Soup()
  // Overland: lighter olive-green undergrowth (their bushes are soft green mounds, not dark spots).
  const over = isOverland()
  const dark = srgb(over ? 0x3e6a2e : 0x2c4a26)
  const light = srgb(over ? 0x8ab04c : 0x5f7e3c)
  for (let f = 0; f < 6; f++) {
    const a = (f / 6) * Math.PI * 2 + rng.range(-0.25, 0.25)
    const len = rng.range(0.7, 1.0)
    const dx = Math.cos(a), dz = Math.sin(a)
    const p0: V3 = [0, 0.02, 0]
    const p1: V3 = [dx * len * 0.8, 0.45 * len, dz * len * 0.8]
    const hw = len * 0.28
    card(s, p0, p1, [-dz * hw, 0.05, dx * hw], ATLAS_CELLS.fern, [0, -0.4, 0], dark, light, 0.8)
  }
  const fern = s.geometry('fern')
  const b = new Soup()
  const bd = srgb(over ? 0x3c6a2c : 0x2a4424), bl = srgb(over ? 0x92b852 : 0x6e8a3e)
  blob(b, [0, 0.3, 0], 0.22, 0.8, rng, bd)
  cluster(b, [0, 0.45, 0], 0.6, 5, ATLAS_CELLS.leaves, rng, bd, bl)
  for (let i = 0; i < 7; i++) {
    const a = rng.next() * Math.PI * 2, u = rng.range(0.15, 0.7)
    tuft(b, [Math.cos(a) * 0.4, u, Math.sin(a) * 0.4], rng.range(0.22, 0.32), [0, 0.2, 0], bd, bl)
  }
  // Genshin: the bush is built like the crowns — leaf-cluster cards with one smooth normal field (genshinTrees).
  if (isGenshin()) { const gb = cardBush(rng, srgb(0x1e5a44), srgb(0x8cc860)); return { fern, bush: gb } }
  return { fern, bush: b.geometry('bush') }
}
