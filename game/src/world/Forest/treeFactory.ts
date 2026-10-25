import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { ATLAS_CELLS, cellUv, SOLID_UV, SURFACE_UV } from '../../rendering/materials/FoliageAtlas'
import { isBright, isGenshin, isOverland, isStorybook } from '../../rendering/artStyle'
import { Rng } from '../noise/rng'
import { TreeSpecies } from '../types'
import { agave, dryShrub, joshua, saguaro } from './desertFlora'
import { crownLump, Soup, srgb, sub, tuft, type V3 } from './treeParts'
import { ANCIENT_TREE, broadleaf, cardBush, glowShrooms, gnarledSnag, leafPile, LIYUE_PINE, MAPLE_TREE, MONDSTADT_TREE, shroomTree, tube, twistedPine } from './genshinTrees'

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
  /** Level 1's geometry in the NEAR LOD band (LOW's near trees; createTreeLibrary). */
  near1?: THREE.BufferGeometry
  trunkRadius: number
  trunkHalfHeight: number
  /** Blender-modelled (assets/treeModels.ts): its colours are final — always the Genshin hue set, every art style. */
  modelled?: boolean
  /** Natural colours (the Tree It spruce): gentle per-tree variation only, no stylised hue set. */
  natural?: boolean
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

/**
 * TIERED PINE (2026-10-21, the Highlands' reference: low-poly stylised pines): a straight brown trunk and 4–8 stacked
 * SKIRTS, each a ring of faceted drooping petals (lime on top, mid green flanks, dark undersides), narrowing to a
 * pointed top. Flat-shaded facets (face normals) — the crisp low-poly read of the reference. Conifer maps
 * (map.json `trees: 'conifer'`) grow these in place of spruce / pine / fir (`createTreeLibrary({ tiered })`):
 * same species ids, so the impostor atlas, tints and colliders are unchanged.
 */
interface TieredOpts { height: number; radius: number; bare: number; tiers: [number, number, number]; petals: [number, number, number]; light: number; mid: number; dark: number; trunk: number }
function tieredPine(level: number, rng: Rng, o: TieredOpts): THREE.BufferGeometry {
  const s = new Soup()
  const H = o.height * rng.range(0.92, 1.08)
  const light = srgb(o.light), mid = srgb(o.mid), dark = srgb(o.dark), bark = srgb(o.trunk)
  solid(s, 0, o.bare + 1.2, 0.26, 0.17, level === 2 ? 4 : 6, bark.clone().multiplyScalar(0.7), bark, 0, SURFACE_UV.bark)
  const tri = (a: V3, b: V3, c: V3, col: THREE.Color) => {
    // face normal (flat shading), pointing out / up
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    let n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const L = Math.hypot(n[0], n[1], n[2]) || 1
    n = [n[0] / L, n[1] / L, n[2] / L]
    s.vert(a, n, SOLID_UV, col); s.vert(b, n, SOLID_UV, col); s.vert(c, n, SOLID_UV, col)
  }
  const tiers = o.tiers[level], petals = o.petals[level]
  const top = H, span = top - o.bare
  for (let t = 0; t < tiers; t++) {
    const k = t / tiers
    const y = o.bare + span * k * 0.88
    const r = o.radius * Math.pow(1 - k, 0.9) + 0.35
    const h = span / tiers * 1.75
    const apex: V3 = [0, Math.min(top, y + h), 0]
    const rot = rng.next() * 6.28
    const lit = light.clone().lerp(mid, 0.45 - 0.35 * k)
    const flank = mid.clone().lerp(dark, 0.25 - 0.15 * k)
    const under = dark.clone()
    for (let i = 0; i < petals; i++) {
      const a = rot + (i / petals) * Math.PI * 2
      const d = Math.PI / petals
      const rr = r * rng.range(0.9, 1.08)
      const droop = rr * rng.range(0.32, 0.46)
      // the petal: apex → left shoulder → pointed tip (drooping) → right shoulder
      const L: V3 = [Math.cos(a - d) * rr * 0.72, y - droop * 0.2, Math.sin(a - d) * rr * 0.72]
      const R: V3 = [Math.cos(a + d) * rr * 0.72, y - droop * 0.2, Math.sin(a + d) * rr * 0.72]
      const T: V3 = [Math.cos(a) * rr, y - droop, Math.sin(a) * rr]
      tri(apex, T, L, lit)
      tri(apex, R, T, flank)
      if (level < 2) {
        // the underside: dark, up to the trunk just under the skirt (seen from below / the side in shade)
        const core: V3 = [0, y + h * 0.18, 0]
        tri(core, L, T, under)
        tri(core, T, R, under)
      }
    }
  }
  return s.geometry('tieredpine')
}
const TIERED: TieredOpts = { height: 11, radius: 2.7, bare: 1.4, tiers: [7, 5, 3], petals: [9, 7, 5], light: 0xa8e063, mid: 0x5dbb4a, dark: 0x1b4a26, trunk: 0x8b5e3c }

/**
 * FROND PINE (the PlayCanvas soft look — Over the Hill's spruces, 2026-10-25 "the pine must look like this"): a full,
 * dense CONE from near the ground to a pointed leader — many short whorls of broad drooping fronds (the atlas's solid
 * frond blades, drawFrondSpray: lit upper half, shaded lower), each card a diamond laid along the blade's diagonal and
 * folded on its midrib like a tent (a lit ridge, shaded flanks). NO solid core (it read as a cone with fronds stuck
 * on): the whorls overlap so densely that the fronds alone close the tree, dark toward the trunk.
 * `leaf`: the replaced species' own average frond colour (the colour stays the map's). LOD0 / 1 / 2 ≈ 440 / 180 / 70 tris.
 */
function frondPine(level: number, rng: Rng, H: number, leaf: THREE.Color): THREE.BufferGeometry {
  const s = new Soup()
  const bark = srgb(0x5a3a26)
  const R = H * 0.26, yb = H * 0.05
  solid(s, 0, H * 0.5, H * 0.022, H * 0.012, level === 2 ? 4 : 6, bark.clone().multiplyScalar(0.7), bark, 0, SURFACE_UV.bark)
  // slot 0 of the spray cell (a green frond; stem at the slot's bottom-left corner, tip at its top-right)
  const [u0, v0, u1, v1] = cellUv(ATLAS_CELLS.spray)
  // (inset from the slot's edges: the neighbouring slot bled into the cards as streaks)
  const uvAt = (S: number, T: number): [number, number] => [u0 + (0.02 + S * 0.46) * (u1 - u0), v0 + (0.52 + T * 0.46) * (v1 - v0)]
  const tiers = [22, 11, 6][level]
  for (let k = 0; k < tiers; k++) {
    const t = k / (tiers - 1)
    const y = yb + (H * 0.88 - yb) * Math.pow(t, 0.9)
    const r = R * Math.pow(1 - t, 1.0) + H * 0.03
    const n = Math.max(5, Math.round((level === 0 ? 12 : level === 1 ? 9 : 7) - t * 5))
    const a0 = rng.next() * Math.PI * 2
    // dark at the trunk (the tree's own shade inside), the tips the old pine's frond colour; the lower whorls a bit darker
    const base = leaf.clone().multiplyScalar(0.3 + 0.1 * t), tip = leaf.clone().multiplyScalar(0.95 + 0.12 * t)
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2)
      const dx = Math.cos(a), dz = Math.sin(a)
      const L = (r * rng.range(1.15, 1.4) + H * 0.025) * (level === 2 ? 1.2 : level === 1 ? 1.1 : 1)
      const droop = L * (0.5 - 0.22 * t) * rng.range(0.85, 1.15)
      const B: V3 = [dx * H * 0.01, y + L * 0.08, dz * H * 0.01]
      const T: V3 = [dx * L, y - droop, dz * L]
      const M: V3 = [(B[0] + T[0]) / 2, (B[1] + T[1]) / 2, (B[2] + T[2]) / 2]
      // the diamond's side corners: wide to each side and well below the midrib (a tent: the whorl reads as a skirt)
      const hw = L * 0.6, fold = L * 0.3
      const Ls: V3 = [M[0] - dz * hw, M[1] - fold, M[2] + dx * hw]
      const Rs: V3 = [M[0] + dz * hw, M[1] - fold, M[2] - dx * hw]
      const nrm = (p: V3): V3 => [p[0], 0.55 * Math.hypot(p[0], p[2]) + 0.2, p[2]]
      const mid = base.clone().lerp(tip, 0.5)
      const v = (p: V3, uv: [number, number], c: THREE.Color) => s.vert(p, nrm(p), uv, c)
      v(B, uvAt(0, 0), base); v(Rs, uvAt(1, 0), mid); v(T, uvAt(1, 1), tip)
      v(B, uvAt(0, 0), base); v(T, uvAt(1, 1), tip); v(Ls, uvAt(0, 1), mid)
    }
  }
  // the leader: two crossed upright fronds at the top
  if (level < 2) {
    const L = H * 0.12, top = leaf.clone().multiplyScalar(0.9)
    for (const [dx, dz] of [[1, 0], [0, 1]]) {
      const B: V3 = [0, H * 0.86, 0], T: V3 = [0, H * 0.86 + L, 0], M: V3 = [0, H * 0.86 + L / 2, 0]
      const Ls: V3 = [M[0] - dz * L * 0.35, M[1], M[2] + dx * L * 0.35], Rs: V3 = [M[0] + dz * L * 0.35, M[1], M[2] - dx * L * 0.35]
      const nrm: V3 = [0, 1, 0]
      s.vert(B, nrm, uvAt(0, 0), top); s.vert(Rs, nrm, uvAt(1, 0), top); s.vert(T, nrm, uvAt(1, 1), top)
      s.vert(B, nrm, uvAt(0, 0), top); s.vert(T, nrm, uvAt(1, 1), top); s.vert(Ls, nrm, uvAt(0, 1), top)
    }
  }
  return s.geometry('frondpine')
}

/** A species' average leaf vertex colour (its foliage: not the bark / solid texels) and height, from level 0. */
function foliageOf(g: THREE.BufferGeometry): { leaf: THREE.Color; height: number } {
  const uv = g.getAttribute('uv'), col = g.getAttribute('color'), pos = g.getAttribute('position')
  const sum = [0, 0, 0]
  let n = 0, top = 0
  for (let i = 0; i < pos.count; i++) {
    top = Math.max(top, pos.getY(i))
    if (!uv || !col || (uv.getX(i) > 0.95 && uv.getY(i) < 0.05)) continue
    sum[0] += col.getX(i); sum[1] += col.getY(i); sum[2] += col.getZ(i); n++
  }
  // (as it is: the old pine's colour, not rescaled — a brightened copy read lime)
  const leaf = n ? new THREE.Color(sum[0] / n, sum[1] / n, sum[2] / n) : srgb(0x3f7a3a)
  return { leaf, height: top || 11 }
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

/**
 * The drawn trunk's radius (model units, unscaled) `y` up a Blender-modelled species' trunk: the LOD0 mesh cut by
 * that horizontal plane (within 3 × the collider radius of the axis), the outermost cut in each of 16 directions, the
 * median of those — a root fin or a low branch on a few sides doesn't count. Null for code-built species (or nothing
 * there). Cached per species and 5 cm of height; a triangle scan the first time (tow straps).
 */
export function trunkGirth(id: number, y: number, colliderR: number): number | null {
  const def = EXTRA_SPECIES.find((s) => s.id === id)
  if (!def) return null
  const key = id * 1000 + Math.round(y * 20)
  let r = GIRTH.get(key)
  if (r === undefined) {
    const geo = def.levels[0], p = geo.getAttribute('position'), idx = geo.index
    const n = idx ? idx.count : p.count
    const sector = new Float32Array(16)
    const v = (k: number) => (idx ? idx.getX(k) : k)
    const cut = (a: number, b: number) => {
      const ya = p.getY(a) - y, yb = p.getY(b) - y
      if ((ya > 0) === (yb > 0)) return
      const t = ya / (ya - yb)
      const x = p.getX(a) + (p.getX(b) - p.getX(a)) * t, z = p.getZ(a) + (p.getZ(b) - p.getZ(a)) * t
      const h = Math.hypot(x, z)
      if (h > colliderR * 3) return
      const k = Math.floor((Math.atan2(z, x) / (Math.PI * 2) + 1) * 16) % 16
      if (h > sector[k]) sector[k] = h
    }
    for (let i = 0; i + 2 < n; i += 3) {
      const a = v(i), b = v(i + 1), c = v(i + 2)
      cut(a, b)
      cut(b, c)
      cut(c, a)
    }
    const filled = [...sector].filter((v) => v > 0).sort((a, b) => a - b)
    r = filled.length >= 8 ? filled[filled.length >> 1] : 0
    GIRTH.set(key, r)
  }
  return r > 0 ? r : null
}
const GIRTH = new Map<number, number>()

/** A map's own leaf colours for the tiered pines (sRGB hex; FixedMap.leaves — map.json palette leafLight / leafMid / leafDark). */
export interface LeafColours { light: number; mid: number; dark: number }

/**
 * THE TREE IT SPRUCE (scripts/blender/spruce_treeit.py; the user's Tree It spruce, optimised) is every conifer: its
 * green variants are registered as the spruce / pine / fir species (treeModels.ts) on every map and the endless world,
 * in place of the tiered pines too; on an autumn-pine map (map.json `pines: 'autumn'`) the fir slot (18 % of the
 * scatter) grows the variant with warm autumn tips. Spray cards on the atlas's spray cell, which holds the Tree It
 * needle sheet (LOD0 512, LOD1 276, LOD2 102 triangles; the tiered pines 264 / 140 / 38).
 */
let AUTUMN: { spruce: THREE.BufferGeometry[]; pine: THREE.BufferGeometry[]; fir: THREE.BufferGeometry[] } | null = null
export function registerAutumnPines(p: NonNullable<typeof AUTUMN>): void {
  AUTUMN = p
}

/**
 * SOFT-LOOK BROADLEAF (the PlayCanvas soft look): the bark vertices (the atlas's bark texel) of a broadleaf take a warm
 * BROWN, a little darker at the foot (2026-10-25: "its trunk brown not white" — the pale aspen white is gone), and its
 * leaves (every other vertex, linear colour) LEAF_K darker ("leafs bit darker"; the bushes keep their own).
 */
const LEAF_K = 0.8
function aspenBark(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const r = g.clone()
  const uv = r.getAttribute('uv'), col = r.getAttribute('color'), pos = r.getAttribute('position')
  if (!uv || !col) return r
  const solid = (u: number, v: number) => u > 0.95 && v < 0.05 // (the atlas's opaque block: bark and other solids)
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i)
    if (u > 0.9775 && u < 0.985 && v < 0.038) {
      const k = 0.72 + 0.28 * Math.min(1, Math.max(0, pos.getY(i) / 3))
      col.setXYZ(i, 0.2 * k, 0.12 * k, 0.07 * k) // (sRGB ≈ #7c5f4a mid-trunk)
    } else if (!solid(u, v)) col.setXYZ(i, col.getX(i) * LEAF_K, col.getY(i) * LEAF_K, col.getZ(i) * LEAF_K)
  }
  return r
}

export function createTreeLibrary(opts: { tiered?: boolean; leaves?: LeafColours; autumn?: boolean; aspen?: boolean } = {}): { species: SpeciesDef[]; dispose(): void } {
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
    { id: TreeSpecies.Palm, name: 'palm', levels: build(palm, 1414, 'palm'), trunkRadius: 0.22, trunkHalfHeight: 3.5 },
    // WHITE BIRCH (bright autumn — their autumn grove): slim WHITE trunks, a tall narrow crown of dark-red → orange
    // leaf cards (genshinTrees broadleaf, code-built).
    { id: TreeSpecies.WhiteBirch, name: 'whitebirch', levels: build((l, r) => broadleaf(l, r, { ...MONDSTADT_TREE, plates: true, fork: 6.0, trunkR: 0.19, limbs: 4, spread: 1.6, clumpR: 1.25, lean: 0.04, roots: 0, bark: 0xeeeae2, dark: 0x7a1e14, light: 0xf0902a }, 'whitebirch'), 1515, 'whitebirch'), trunkRadius: 0.22, trunkHalfHeight: 3 },
    // Region species (world/biomes/BiomeDefs.ts): autumn maple, mystic ancient giant and glowing mushroom tree.
    { id: TreeSpecies.Maple, name: 'maple', levels: build((l, r) => broadleaf(l, r, isGenshin() ? { ...MAPLE_TREE, plates: true, fork: 1.8, spread: 3.9, limbs: 5, clumpR: 1.65 } : MAPLE_TREE, 'maple'), 808, 'maple'), trunkRadius: 0.3, trunkHalfHeight: 3 },
    { id: TreeSpecies.Ancient, name: 'ancient', levels: build((l, r) => broadleaf(l, r, isGenshin() ? { ...ANCIENT_TREE, plates: true, fork: 3.0, spread: 5.4, limbs: 6, clumpR: 2.3 } : ANCIENT_TREE, 'ancient'), 909, 'ancient'), trunkRadius: 0.6, trunkHalfHeight: 4 },
    { id: TreeSpecies.Shroom, name: 'shroom', levels: build(shroomTree, 1010, 'shroom'), trunkRadius: 0.26, trunkHalfHeight: 2.5 },
  ]
  // Broadleaf STAND types (scatter.ts): code-built fallbacks are copies of the birch (the Blender models replace them).
  const birchDef = species.find((s) => s.id === TreeSpecies.Birch)!
  for (const [id, name] of [[TreeSpecies.Oak, 'oak'], [TreeSpecies.Slender, 'slender'], [TreeSpecies.Golden, 'golden'], [TreeSpecies.Curvy, 'curvy']] as const)
    species.push({ ...birchDef, id, name, levels: birchDef.levels.map((g) => g.clone()) as SpeciesDef['levels'] })
  // The Tree It set (assets/treeModels.ts): code-built fallbacks — the broadleaves copy the birch, the juniper the fir.
  const firDef = species.find((s) => s.id === TreeSpecies.Fir)!
  for (const [id, name, def] of [[TreeSpecies.Beech, 'beech', birchDef], [TreeSpecies.Elm, 'elm', birchDef], [TreeSpecies.Bamboo, 'bamboo', birchDef], [TreeSpecies.Acacia, 'acacia', birchDef], [TreeSpecies.Juniper, 'juniper', firDef]] as const)
    species.push({ ...def, id, name, levels: def.levels.map((g) => g.clone()) as SpeciesDef['levels'] })
  // Registered species (e.g. GLB models, `registerTreeSpecies`) replace the built-in one with the same id.
  for (const extra of EXTRA_SPECIES) {
    const i = species.findIndex((s) => s.id === extra.id)
    if (i >= 0) species[i].levels.forEach((g) => g.dispose())
    if (i >= 0) species[i] = extra
    else species.push(extra)
  }
  // Conifer maps: the tiered pines replace spruce / fir / pine (after the modelled ones: they win here)
  if (opts.tiered) {
    const T: TieredOpts = opts.leaves ? { ...TIERED, ...opts.leaves } : TIERED
    const tiered: [number, string, number, TieredOpts][] = [
      [TreeSpecies.Spruce, 'spruce', 101, T],
      [TreeSpecies.Fir, 'fir', 303, { ...T, height: 8.5, radius: 2.4, tiers: [6, 4, 3] }],
      [TreeSpecies.Pine, 'pine', 404, { ...T, height: 14, radius: 3.0, bare: 2.2, tiers: [8, 5, 3] }],
    ]
    for (const [id, name, seed, o] of tiered) {
      const i = species.findIndex((s) => s.id === id)
      if (i < 0) continue
      // (with the Tree It spruce loaded — registered as spruce / fir / pine — only the tiered pines' trunk collider is
      // kept: the server's statics stay those of the scatter)
      if (AUTUMN) {
        species[i] = { ...species[i], trunkRadius: 0.26, trunkHalfHeight: 3 }
        continue
      }
      if (!EXTRA_SPECIES.includes(species[i])) species[i].levels.forEach((g) => g.dispose())
      species[i] = { id, name, levels: build((l, r) => tieredPine(l, r, o), seed, name), trunkRadius: 0.26, trunkHalfHeight: 3 }
    }
  }
  // Autumn-pine maps: the fir slot grows the gold-tipped Tree It variant (only the mesh — the collider stays)
  if (opts.autumn && AUTUMN) {
    const i = species.findIndex((s) => s.id === TreeSpecies.Fir)
    if (i >= 0) species[i] = { ...species[i], levels: AUTUMN.fir.map((g) => g.clone()) as SpeciesDef['levels'] }
  }
  if (opts.aspen) {
    // (the Tree It broadleaves — sparse sprays on thin stems, they read as bamboo — grow the modelled birch's forked
    //  trunk and full rounded crown: Over the Hill's aspens; only the mesh, the colliders stay)
    const birch = species.find((x) => x.id === TreeSpecies.Birch)
    for (const id of [TreeSpecies.Beech, TreeSpecies.Elm, TreeSpecies.Acacia, TreeSpecies.Bamboo]) {
      const i = species.findIndex((x) => x.id === id)
      if (birch && i >= 0) species[i] = { ...species[i], levels: birch.levels.map((g) => g.clone()) as SpeciesDef['levels'] }
    }
    const broad = new Set<number>([TreeSpecies.Birch, TreeSpecies.Beech, TreeSpecies.Elm, TreeSpecies.Acacia, TreeSpecies.Bamboo, TreeSpecies.Slender, TreeSpecies.Curvy, TreeSpecies.Golden, TreeSpecies.Oak, TreeSpecies.Maple, TreeSpecies.WhiteBirch])
    for (let i = 0; i < species.length; i++) if (broad.has(species[i].id)) species[i] = { ...species[i], levels: species[i].levels.map(aspenBark) as SpeciesDef['levels'] }
    // the conifers: full frond-cone pines (frondPine) in the replaced species' own height and colour — the colliders stay
    for (const [id, seed] of [[TreeSpecies.Spruce, 111], [TreeSpecies.Fir, 313], [TreeSpecies.Pine, 414]] as const) {
      const i = species.findIndex((x) => x.id === id)
      if (i < 0) continue
      const { leaf, height } = foliageOf(species[i].levels[0])
      species[i] = { ...species[i], levels: build((l, r) => frondPine(l, r, height, leaf), seed, species[i].name) }
    }
  }
  // Per-tree LOD bands (uniforms.ts uTreeLod): level 0 = band 1 (near), level 1 = band 2 (mid), level 2 = band 3
  // (the legacy far mesh, never faded). `near1` = level 1's geometry tagged as the NEAR band — LOW's near trees.
  const band = (g: THREE.BufferGeometry, b: number) => g.setAttribute('aLodBand', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(b), 1))
  for (const s of species) {
    s.levels.forEach((g, l) => band(g, l + 1))
    s.near1 = band(s.levels[1].clone(), 1)
  }
  return { species, dispose: () => species.forEach((s) => (s.levels.forEach((g) => g.dispose()), s.near1?.dispose())) }
}

function desert(fn: (s: Soup, level: number, rng: Rng) => void, name: string): (level: number, rng: Rng) => THREE.BufferGeometry {
  return (level, rng) => {
    const s = new Soup()
    fn(s, level, rng)
    return s.geometry(name)
  }
}

/**
 * OASIS PALM (bright — over the hill's oases): a slim ringed trunk 6–8.5 m tall curving out to one side, a crown of
 * a STAR of 20 long, narrow, hard-drooping dark-green fronds (fern-cell cards in 3 segments, crossed near),
 * a dark crown core and dates. Tris L0/L1/L2 ≈ 330 / 120 / 60.
 */
function palm(level: number, rng: Rng): THREE.BufferGeometry {
  const s = new Soup()
  const H = rng.range(6, 8.5), lean = rng.range(0.7, 1.7), la = rng.next() * Math.PI * 2
  const segs = [7, 4, 2][level], sides = [6, 5, 4][level]
  const pts: V3[] = [], radii: number[] = []
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, off = lean * Math.pow(t, 1.7)
    pts.push([Math.cos(la) * off, t * H, Math.sin(la) * off])
    radii.push((0.26 - 0.1 * t) * (level === 0 && i % 2 === 1 ? 1.08 : 1)) // ringed bark: every other ring bulges
  }
  tube(s, pts, radii, sides, srgb(0x6a5440), srgb(0xa48c6a))
  const T = pts[segs]
  // Their palms: a STAR of many long, NARROW, drooping dark-green fronds (not a flat umbrella of wide cards).
  const dark = srgb(0x22401c), light = srgb(0x6a8c36)
  blob(s, [T[0], T[1] - 0.05, T[2]], 0.32, 0.8, rng, srgb(0x3a4a22))
  if (level === 0) for (let k = 0; k < 4; k++) blob(s, [T[0] + rng.range(-0.22, 0.22), T[1] - 0.35, T[2] + rng.range(-0.22, 0.22)], 0.11, 1, rng, srgb(0x9a6026))
  const n = [20, 12, 8][level]
  const centre: V3 = [T[0], T[1] - 0.4, T[2]]
  for (let f = 0; f < n; f++) {
    const a = (f / n) * Math.PI * 2 + rng.range(-0.15, 0.15)
    const dx = Math.cos(a), dz = Math.sin(a)
    // some fronds stand up out of the crown, most arch out and droop hard
    const up = f % 4 === 0 ? 0.9 : 0.25
    const len = rng.range(2.8, 3.6) * (up > 0.5 ? 0.8 : 1)
    const p0: V3 = [T[0], T[1], T[2]]
    const p1: V3 = [T[0] + dx * len * 0.4, T[1] + up * 0.9 + 0.3, T[2] + dz * len * 0.4]
    const p2: V3 = [T[0] + dx * len * 0.78, T[1] + up * 0.7 - 0.45, T[2] + dz * len * 0.78]
    const p3: V3 = [T[0] + dx * len * 1.02, T[1] + up * 0.3 - 1.7, T[2] + dz * len * 1.02]
    const w = 0.26
    const flat: V3 = [-dz * w, 0.02, dx * w], tall: V3 = [-dz * w * 0.35, w * 0.9, dx * w * 0.35]
    const segsF: [V3, V3, THREE.Color, THREE.Color][] = level === 2 ? [[p0, p1, dark, light], [p1, p3, light, dark]] : [[p0, p1, dark, light], [p1, p2, light, light], [p2, p3, light, dark]]
    for (const [qa, qb, ca, cb] of segsF) {
      card(s, qa, qb, flat, ATLAS_CELLS.fern, centre, ca, cb, 0.6)
      if (level === 0) card(s, qa, qb, tall, ATLAS_CELLS.fern, centre, ca, cb, 0.6) // crossed: reads from the side too
    }
  }
  return s.geometry('palm')
}

/** Desert undergrowth: agave rosettes and grey-olive dry shrubs (replace ferns/bushes on sand, WorldChunk). */
export function createDesertUndergrowth(): { agave: THREE.BufferGeometry; shrub: THREE.BufferGeometry } {
  const rng = new Rng(919)
  const a = new Soup()
  agave(a, rng)
  // Bright (over the hill): the desert bush is LEAFY like the trees (leaf-cluster cards, their olive-yellow
  // ≈ 151,149,58 → 177,161,70), ~1.5 m across — not a solid green ball.
  if (isBright()) return { agave: a.geometry('agave'), shrub: cardBush(rng, srgb(0x3e5a2a), srgb(0xa4c870), true).scale(1.9, 1.6, 1.9) }
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
/** A bush mesh scaled (w across, h up) — its camera-facing tufts' centres and offsets with it. */
function scaledBush(g: THREE.BufferGeometry, w: number, h: number): THREE.BufferGeometry {
  g.scale(w, h, w)
  const c = g.getAttribute('bbCenter'), o = g.getAttribute('bbOff')
  if (c) for (let i = 0; i < c.count; i++) c.setXYZ(i, c.getX(i) * w, c.getY(i) * h, c.getZ(i) * w)
  if (o) for (let i = 0; i < o.count; i++) o.setXY(i, o.getX(i) * w, o.getY(i) * h)
  g.computeBoundingSphere()
  return g
}
/** @param soft the PlayCanvas soft look's bush: Over the Hill's rich deep-green clumps (round leaf discs), lighter on top */
export function createUndergrowth(soft = false): { fern: THREE.BufferGeometry; bush: THREE.BufferGeometry } {
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
  // (soft: their mounds, ~1.5 m — a LUMPY mound of four lobes, wider than tall, not one ball)
  if (soft) return { fern, bush: scaledBush(cardBush(rng, srgb(0x1c4a2e), srgb(0x72b85a), true, [[[0, 0.42, 0], 1], [[0.42, 0.26, 0.12], 0.8], [[-0.34, 0.24, 0.3], 0.75], [[-0.12, 0.28, -0.4], 0.75]]), 1.45, 1.25) }
  if (isGenshin()) { const gb = cardBush(rng, srgb(0x1e5a44), srgb(0x8cc860)); return { fern, bush: gb } }
  // Bright (over the hill): leafy bushes made like the tree crowns (leaf-cluster cards), warm olive → yellow-green.
  if (isBright()) return { fern, bush: cardBush(rng, srgb(0x3a4c24), srgb(0xa4b25a), true) }
  return { fern, bush: b.geometry('bush') }
}
