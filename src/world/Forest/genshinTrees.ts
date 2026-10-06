import * as THREE from 'three'
import { ATLAS_CELLS, cellUv, GLOW_UV, SURFACE_UV } from '../../rendering/materials/FoliageAtlas'
import type { Rng } from '../noise/rng'
import { crownLump, Soup, srgb, sub, tuft, type V3 } from './treeParts'

/**
 * GENSHIN-STYLE TREES ('bright' art style; refs: Mondstadt broadleafs, Liyue's twisted pines, the Windrise oak).
 * Not a pole with a ball on top: a real skeleton —
 *   TRUNK   a curved tube (lean + S-bend) with a flared, rooted base and spiral bark grooves painted in the
 *           vertex colours (reads as a twisted trunk without extra geometry),
 *   LIMBS   2–5 curved branches forking from the trunk (+ sub-branches on the near level),
 *   CROWN   separate cloud-like leaf CLUMPS at the branch tips — a solid core + camera-facing leaf tufts — so
 *           the silhouette is lumpy with sky and branches showing between the masses. Each clump's normals point
 *           from between its own centre and the crown's, so the clumps read as volumes inside one soft crown.
 * Same vertex format and single material as treeFactory → still one instanced draw per species per chunk.
 * Built once with fixed seeds (identical for everyone); trunks start straight at the base (the trunk collider is
 * an upright capsule) and canopies stay ≥ ~3.5 m up (the eye and the driving camera pass under them).
 */

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/**
 * Bark tube along a polyline (parallel-transported rings, smooth radial normals). `twist` paints spiral grooves
 * (darker bands winding up the tube) into the colours — a twisted, carved trunk for free.
 */
export function tube(s: Soup, pts: V3[], radii: number[], sides: number, c0: THREE.Color, c1: THREE.Color, twist = 0): void {
  const n = pts.length
  const T = pts.map((_, i) => norm(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)])))
  let N: V3 = Math.abs(T[0][1]) < 0.95 ? norm(cross(T[0], [0, 1, 0])) : [1, 0, 0]
  const ring: { p: V3; d: V3; c: THREE.Color }[][] = []
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const m = sub(N, mul(T[i], dot(N, T[i])))
      if (Math.hypot(m[0], m[1], m[2]) > 1e-4) N = norm(m)
    }
    const B = cross(N, T[i])
    const t = n > 1 ? i / (n - 1) : 0
    const row: { p: V3; d: V3; c: THREE.Color }[] = []
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2
      const d = add(mul(N, Math.cos(a)), mul(B, Math.sin(a)))
      const groove = twist > 0 ? 1 - twist * (0.5 + 0.5 * Math.cos(a * 2 + t * 7)) : 1
      row.push({ p: add(pts[i], mul(d, radii[i])), d, c: c0.clone().lerp(c1, t).multiplyScalar(groove) })
    }
    ring.push(row)
  }
  const uv = SURFACE_UV.bark
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < sides; k++) {
      const A = ring[i][k], Bv = ring[i][k + 1], C = ring[i + 1][k + 1], D = ring[i + 1][k]
      s.vert(A.p, A.d, uv, A.c); s.vert(C.p, C.d, uv, C.c); s.vert(Bv.p, Bv.d, uv, Bv.c)
      s.vert(A.p, A.d, uv, A.c); s.vert(D.p, D.d, uv, D.c); s.vert(C.p, C.d, uv, C.c)
    }
  }
}

/** A curved branch from `p0` along `dir` (unit), bending up by `rise`·len² and sideways by a small wobble. */
function branchPts(p0: V3, dir: V3, len: number, rise: number, segs: number, wob: number, ph: number): V3[] {
  const side = norm(cross(dir, [0, 1, 0]))
  const pts: V3[] = []
  for (let k = 0; k <= segs; k++) {
    const t = k / segs
    pts.push(add(add(add(p0, mul(dir, len * t)), [0, rise * len * t * t, 0]), mul(side, Math.sin(t * 3.1 + ph) * wob * t)))
  }
  return pts
}

/**
 * LEAFY CORE: a jittered icosahedron/octahedron like `crownLump`, but textured with the dense middle of the leaf-
 * cluster atlas cell (uv from the vertex direction) instead of the opaque texel — a leafy mass, alpha-cut at its
 * gaps, that also dissolves near the eye like every foliage card (stylize nearFade). Under a canopy the tufts
 * collapse (they're keyed to the tree's base), so a solid core would show as a flat plate overhead.
 */
function leafCore(s: Soup, c: V3, r: number, crown: V3, rng: Rng, dark: THREE.Color, light: THREE.Color, detail: number, flat: number): void {
  const g = detail < 0 ? new THREE.OctahedronGeometry(1, 0) : new THREE.IcosahedronGeometry(1, detail)
  const p = g.getAttribute('position')
  const [u0, v0, u1, v1] = cellUv(ATLAS_CELLS.tuft)
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2, hu = (u1 - u0) * 0.2, hv = (v1 - v0) * 0.2
  const j = new Map<string, number>()
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
    const key = `${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`
    if (!j.has(key)) j.set(key, rng.range(0.85, 1.12))
    const k = j.get(key)!
    const v: V3 = [c[0] + x * r * k, c[1] + y * r * k * flat, c[2] + z * r * k]
    const n: V3 = [v[0] - crown[0], (v[1] - crown[1]) * 1.2 + 0.3, v[2] - crown[2]]
    const up = Math.min(1, Math.max(0, ((v[1] - crown[1]) / 1.6) * 0.5 + 0.5))
    s.vert(v, n, [cu + (x + z * 0.6) * hu, cv + (y + z * 0.4) * hv], dark.clone().lerp(light, up))
  }
  g.dispose()
}

/** A leaf CLUMP: solid core + tufts over its upper/outer surface. `flat` squashes it (Liyue pine pads). */
function clump(s: Soup, c: V3, r: number, crown: V3, level: number, tufts: number, rng: Rng, dark: THREE.Color, light: THREE.Color, flat = 0.78, tuftK = 0.5): void {
  const nc = lerp3(c, crown, 0.55)
  // Core: the crown's shadowed interior up close (dark, ≤ ⅓ toward the light colour, smaller than the clump) so it
  // reads as depth behind the leaf tufts, not as a bright faceted plate; on the far level it IS the clump.
  // (Far: a rounded icosahedron, not the octahedron — flat octahedra read as bare diamonds on the skyline.)
  if (level >= 2) crownLump(s, c, r * 1.05, nc, rng, dark.clone().lerp(light, 0.2), light, 0, Math.max(flat, 0.55))
  else leafCore(s, c, r * (level === 0 ? 0.62 : 0.66), nc, rng, dark.clone().multiplyScalar(0.85), dark.clone().lerp(light, 0.5), 0, flat)
  if (level >= 2) return
  const n = level === 0 ? tufts : Math.max(5, Math.round(tufts * 0.6))
  for (let i = 0; i < n; i++) {
    // Stratified over the clump's upper/outer surface (golden-angle spiral) → even cover, no bald patches.
    const u = 1 - ((i + 0.5) / n) * 1.3
    const a = i * 2.39996 + rng.range(-0.3, 0.3)
    const q = Math.sqrt(Math.max(0, 1 - u * u))
    const rr = r * rng.range(0.78, 0.95)
    const p: V3 = [c[0] + q * Math.cos(a) * rr, c[1] + u * rr * flat, c[2] + q * Math.sin(a) * rr]
    tuft(s, p, r * tuftK * (level === 0 ? 1.0 : 1.3) * rng.range(0.85, 1.15), nc, dark, light)
  }
}

export interface BroadleafOpts {
  /** Height of the fork (top of the trunk), m. */
  fork: number
  trunkR: number
  limbs: number
  /** Limb length (≈ crown radius), m. */
  spread: number
  clumpR: number
  lean: number
  /** Tufts per clump on the near level. */
  tufts: number
  roots: number
  bark: number
  dark: number
  light: number
  /** Spiral-groove strength in the bark colours (0–0.3). */
  twist: number
  /** Genshin crown: one CUMULUS volume (cumulusCrown) instead of separate clumps per branch tip. */
  cumulus?: boolean
  /** Genshin crown: large fixed leaf-cluster cards over the crown volume with one spherized normal field
   *  (cardCrown) — the 'genshin' art style. */
  plates?: boolean
}

/** Fills `s` with a broadleaf tree (shared by the species and the giant landmark oak). */
export function broadleafInto(s: Soup, level: number, rng: Rng, o: BroadleafOpts): void {
  if (o.plates) return spreadTree(s, level, rng, o)
  const bark = srgb(o.bark), barkD = bark.clone().multiplyScalar(0.55)
  const dark = srgb(o.dark), light = srgb(o.light)
  const sides = [8, 5, 4][level], segs = [7, 3, 2][level]
  // Trunk: straight at the foot, leaning and S-bending above (twisted look), flared into the roots.
  const la = rng.next() * Math.PI * 2, lean = o.lean * rng.range(0.6, 1)
  const lx = Math.cos(la) * lean, lz = Math.sin(la) * lean
  const wob = o.fork * rng.range(0.03, 0.06), ph = rng.next() * 6.28
  const tp: V3[] = [], tr: number[] = []
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    tp.push([lx * o.fork * t * t + Math.sin(t * 3 + ph) * wob * t, t * o.fork, lz * o.fork * t * t + Math.cos(t * 2.6 + ph) * wob * t])
    tr.push(o.trunkR * (1 + 0.6 * (1 - t) ** 5) * (1 - 0.3 * t))
  }
  tube(s, tp, tr, sides, barkD, bark, o.twist)
  // Roots: flared buttresses running out and down into the ground.
  if (level === 0) {
    const nr = o.roots
    const a0 = rng.next() * 6.28
    for (let i = 0; i < nr; i++) {
      const a = a0 + (i / nr) * Math.PI * 2 + rng.range(-0.25, 0.25)
      const ca = Math.cos(a), sa = Math.sin(a), L = o.trunkR * rng.range(2.6, 3.6)
      const pts: V3[] = [[ca * o.trunkR * 0.5, o.trunkR * 1.6, sa * o.trunkR * 0.5], [ca * o.trunkR * 1.3, o.trunkR * 0.45, sa * o.trunkR * 1.3], [ca * L, -o.trunkR * 0.5, sa * L]]
      tube(s, pts, [o.trunkR * 0.55, o.trunkR * 0.4, o.trunkR * 0.08], level === 0 ? 5 : 4, barkD, bark.clone().multiplyScalar(0.8))
    }
  }
  // Limbs from the fork, curving up and out; sub-branches on the near level. Clumps at every tip.
  const F = tp[segs], rF = tr[segs]
  const crown: V3 = [F[0] + lx * 2, F[1] + o.spread * 0.45, F[2] + lz * 2]
  const tips: [V3, number][] = []
  const ab = rng.next() * Math.PI * 2
  const lsegs = [4, 2, 2][level]
  for (let j = 0; j < o.limbs; j++) {
    const a = ab + (j / o.limbs) * Math.PI * 2 + rng.range(-0.35, 0.35)
    const el = rng.range(0.45, 0.85)
    const dir = norm([Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)])
    const len = o.spread * rng.range(0.8, 1.1)
    const pts = branchPts(F, dir, len, 0.12, lsegs, len * 0.08, rng.next() * 6.28)
    if (level < 2) tube(s, pts, pts.map((_, k) => rF * 0.72 * (1 - (k / lsegs) * 0.72)), [5, 3][level], barkD, bark, o.twist * 0.6)
    tips.push([pts[lsegs], 1])
    if (level === 0) tips.push([pts[Math.max(1, lsegs - 2)], 0.7]) // inner clump along the limb → a fuller crown
    if (level === 0 && rng.next() < 0.75) {
      const b0 = pts[2]
      const a2 = a + (rng.next() < 0.5 ? -1 : 1) * rng.range(0.6, 1.0)
      const d2 = norm([Math.cos(a2), rng.range(0.25, 0.6), Math.sin(a2)])
      const p2 = branchPts(b0, d2, len * 0.55, 0.15, 2, 0, 0)
      tube(s, p2, [rF * 0.32, rF * 0.22, rF * 0.12], 4, barkD, bark)
      tips.push([p2[2], 0.75])
    }
  }
  // Leader up the middle → the crown's top clump.
  const top: V3 = [F[0] + lx * 1.5, F[1] + o.spread * 0.85, F[2] + lz * 1.5]
  if (level < 2) tube(s, [F, lerp3(F, top, 0.5), top], [rF * 0.6, rF * 0.4, rF * 0.2], [5, 3][level], barkD, bark)
  tips.push([top, 1.15])
  if (o.plates) {
    cardCrown(s, tips, o, level, rng, dark, light)
    return
  }
  if (o.cumulus) {
    const lobes: Lobe[] = tips.map(([tip, k]) => {
      const r = o.clumpR * k * rng.range(0.92, 1.1)
      return { c: [tip[0], tip[1] + r * 0.25, tip[2]], r }
    })
    cumulusCrown(s, lobes, level, rng, dark, light, o.tufts)
    return
  }
  for (const [tip, k] of tips) {
    const r = o.clumpR * k * rng.range(0.85, 1.12)
    clump(s, [tip[0], tip[1] + r * 0.3, tip[2]], r, crown, level, o.tufts, rng, dark, light)
  }
}

/**
 * GENSHIN SPREADING TREE (the 'genshin' style broadleaves): a SHORT bare trunk (foliage starts low, ~2 m), then THICK
 * LIMBS leaving the trunk at several heights — low ones long and nearly horizontal, high ones shorter and steeper —
 * each ending in leaf clusters, with more clusters along the limbs, so the canopy is a wide, layered mass reaching
 * from low to high instead of one ball on a pole. ASYMMETRIC: limbs on one side (the lean side) reach ~40 % further
 * and the leader leans that way; azimuths are jittered golden-angle steps, so every species' silhouette is lopsided
 * (random instance rotation + scale then varies it tree to tree). Leaf clusters: cardCrown (fixed leaf-cluster cards,
 * one spherized normal field). Low-poly: tube limbs of 3–5 sides, 2 segments.
 */
function spreadTree(s: Soup, level: number, rng: Rng, o: BroadleafOpts): void {
  const bark = srgb(o.bark), barkD = bark.clone().multiplyScalar(0.55)
  const dark = srgb(o.dark), light = srgb(o.light)
  const sides = [8, 5, 4][level]
  // Trunk + leader: a short trunk to the first limb, continuing (thinner, leaning to the heavy side) to the top.
  const la = rng.next() * Math.PI * 2
  const heavy: V3 = [Math.cos(la), 0, Math.sin(la)]
  const H = o.fork + o.spread * 0.85
  const segs = [8, 4, 3][level]
  const tp: V3[] = [], tr: number[] = []
  const ph = rng.next() * 6.28
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    const lean = (o.spread * 0.25 + o.lean * H) * t * t
    tp.push([heavy[0] * lean + Math.sin(t * 3 + ph) * 0.12 * o.trunkR * 4 * t, t * H, heavy[2] * lean + Math.cos(t * 2.6 + ph) * 0.12 * o.trunkR * 4 * t])
    tr.push(o.trunkR * (1 + 0.6 * (1 - t) ** 5) * (1 - 0.62 * t))
  }
  tube(s, tp, tr, sides, barkD, bark, o.twist)
  const at = (t: number): [V3, number] => {
    const f = t * segs, i = Math.min(segs - 1, Math.floor(f)), k = f - i
    return [lerp3(tp[i], tp[i + 1], k), tr[i] + (tr[i + 1] - tr[i]) * k]
  }
  if (level === 0) {
    const a0 = rng.next() * 6.28
    for (let i = 0; i < o.roots; i++) {
      const a = a0 + (i / o.roots) * Math.PI * 2 + rng.range(-0.25, 0.25)
      const ca = Math.cos(a), sa = Math.sin(a), L = o.trunkR * rng.range(2.6, 3.6)
      tube(s, [[ca * o.trunkR * 0.5, o.trunkR * 1.6, sa * o.trunkR * 0.5], [ca * o.trunkR * 1.3, o.trunkR * 0.45, sa * o.trunkR * 1.3], [ca * L, -o.trunkR * 0.5, sa * L]],
        [o.trunkR * 0.55, o.trunkR * 0.4, o.trunkR * 0.08], 5, barkD, bark.clone().multiplyScalar(0.8))
    }
  }
  const tips: [V3, number][] = []
  const n = o.limbs + 1
  const a0 = rng.next() * Math.PI * 2
  for (let j = 0; j < n; j++) {
    // Origins from the fork height up the trunk; the lowest limbs are the longest and flattest.
    const t = (o.fork / H) + (j / n) * (0.8 - o.fork / H) + rng.range(-0.03, 0.03)
    const [p0, r0] = at(Math.min(0.9, t))
    const a = a0 + j * 2.39996 + rng.range(-0.35, 0.35)
    const side = 1 + 0.4 * Math.max(0, Math.cos(a - la)) // the heavy side reaches further
    const low = 1 - j / n
    const el = rng.range(0.12, 0.3) + (1 - low) * 0.45
    const dir = norm([Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)])
    const len = o.spread * (0.6 + 0.6 * low) * side * rng.range(0.85, 1.15)
    const pts = branchPts(p0, dir, len, 0.1, 2, len * 0.12, rng.next() * 6.28)
    // The wood ends INSIDE the tip's leaf cluster (a bare stub poked out of the foliage otherwise).
    if (level < 2) tube(s, [pts[0], pts[1], lerp3(pts[1], pts[2], 0.7)], [r0 * 0.78, r0 * 0.5, r0 * 0.24], [5, 3][level], barkD, bark, o.twist * 0.6)
    tips.push([pts[2], 0.9 + 0.25 * low])
    if (level === 0) tips.push([pts[1], 0.65]) // cluster along the limb
    if (level === 0 && low > 0.4 && rng.next() < 0.7) {
      // A sub-branch off a low limb: more clusters at that height, widening the canopy.
      const a2 = a + (rng.next() < 0.5 ? -1 : 1) * rng.range(0.5, 0.9)
      const p2 = branchPts(pts[1], norm([Math.cos(a2), rng.range(0.1, 0.35), Math.sin(a2)]), len * 0.5, 0.12, 2, 0, 0)
      tube(s, [p2[0], p2[1], lerp3(p2[1], p2[2], 0.6)], [r0 * 0.4, r0 * 0.26, r0 * 0.12], 4, barkD, bark)
      tips.push([p2[2], 0.75])
    }
  }
  tips.push([tp[segs], 1.05]) // the crown's top on the leader
  cardCrown(s, tips, o, level, rng, dark, light, 1.15)
}

interface Lobe { c: V3; r: number }

/**
 * Crown lobes: one per branch tip (+ a smaller tucked one) plus a fill ring and a cap so the crown is FULL.
 * Shared by the plate and card crowns.
 */
function crownLobes(tips: [V3, number][], o: BroadleafOpts, level: number, rng: Rng): Lobe[] {
  const lobes: Lobe[] = []
  for (const [tip, k] of tips) {
    const r = o.clumpR * k * rng.range(0.95, 1.12)
    lobes.push({ c: [tip[0], tip[1] + r * 0.15, tip[2]], r })
    if (level === 0 && k >= 1) {
      const a = rng.next() * Math.PI * 2
      lobes.push({ c: [tip[0] + Math.cos(a) * r * 0.55, tip[1] - r * 0.42, tip[2] + Math.sin(a) * r * 0.55], r: r * 0.78 })
    }
  }
  let cx = 0, cy = 0, cz = 0, rad = 0
  for (const p of lobes) { cx += p.c[0] / lobes.length; cy += p.c[1] / lobes.length; cz += p.c[2] / lobes.length }
  for (const p of lobes) rad = Math.max(rad, Math.hypot(p.c[0] - cx, p.c[2] - cz))
  const nf = o.plates ? (level === 0 ? 4 : level === 1 ? 3 : 2) : level === 0 ? 6 : level === 1 ? 3 : 0
  const a0 = rng.next() * Math.PI * 2
  for (let i = 0; i < nf; i++) {
    const a = a0 + (i / nf) * Math.PI * 2
    lobes.push({ c: [cx + Math.cos(a) * rad * 0.62, cy + rng.range(-0.25, 0.35) * o.clumpR, cz + Math.sin(a) * rad * 0.62], r: o.clumpR * rng.range(0.95, 1.15) })
  }
  if (level < 2 || o.plates) lobes.push({ c: [cx, cy + o.clumpR * 0.75, cz], r: o.clumpR * 1.1 })
  return lobes
}

/**
 * GENSHIN CARD CROWN — the method seen in close-ups of Genshin's trees and bushes:
 *  - the crown is many LARGE FIXED cards (not camera-facing) at random orientations, crossing each other, spread
 *    over the crown volume (biased to its outer shell) — from below you see the lacy planes of leaf cut-outs;
 *  - each card shows a cluster of lobed leaves in flat tones (FoliageAtlas drawTuftGenshin);
 *  - ALL shading comes from one SPHERIZED normal field (from the crown centre, + an upward bias) → one smooth
 *    light → shade gradient across the whole crown (yellow-green top, blue-green underside), plus vertex-colour
 *    DEPTH: cards darken toward the crown's centre (the interior reads deep and teal). The rim light in the
 *    vegetation shader brightens the silhouette against the sky, as in Genshin.
 * Cost: 2 tris per card (≈ 12–14 lobes × 7 cards on L0 ≈ 200 tris + small cores) — less than the billboard crowns.
 */
function cardCrown(s: Soup, tips: [V3, number][], o: BroadleafOpts, level: number, rng: Rng, dark: THREE.Color, light: THREE.Color, cardK = 1): void {
  const lobes = crownLobes(tips, o, level, rng)
  const g: V3 = [0, 0, 0]
  for (const p of lobes) { g[0] += p.c[0] / lobes.length; g[1] += p.c[1] / lobes.length; g[2] += p.c[2] / lobes.length }
  let Rc = 0, yLo = Infinity, yHi = -Infinity
  for (const p of lobes) {
    Rc = Math.max(Rc, Math.hypot(p.c[0] - g[0], p.c[1] - g[1], p.c[2] - g[2]) + p.r)
    yLo = Math.min(yLo, p.c[1] - p.r * 0.7); yHi = Math.max(yHi, p.c[1] + p.r * 0.8)
  }
  const mid = dark.clone().lerp(light, 0.45)
  // Colour at a world point: height in the crown (top light → underside dark) × depth toward the centre.
  const colAt = (p: V3, out: THREE.Color) => {
    const t = Math.min(1, Math.max(0, (p[1] - yLo) / Math.max(0.5, yHi - yLo)))
    out.copy(dark).lerp(light, 0.1 + 0.9 * t * t * (3 - 2 * t)) // a clear sunlit top over a teal underside
    const dc = Math.hypot(p[0] - g[0], p[1] - g[1], p[2] - g[2]) / Rc
    return out.multiplyScalar(0.62 + 0.38 * Math.min(1, Math.max(0, (dc - 0.15) / 0.7)))
  }
  const nAt = (p: V3): V3 => {
    const d: V3 = [p[0] - g[0], (p[1] - g[1]) * 1.15, p[2] - g[2]]
    const l = Math.hypot(d[0], d[1], d[2]) || 1
    return [d[0] / l, d[1] / l + 0.3, d[2] / l]
  }
  void mid
  // OPAQUE FOLIAGE CORE per cluster (all levels): a rounded lump in the crown's own gradient (never darker than its
  // surroundings — the old dark cores read as diamonds) that FILLS the crown, so no branch / sky shows through gaps
  // between cards. Opaque and drawn first → the cards behind it are early-z rejected (cheaper than more cards).
  const c = new THREE.Color(), cLo = new THREE.Color(), cHi = new THREE.Color()
  for (const p of lobes) {
    colAt([p.c[0], p.c[1] - p.r * 0.6, p.c[2]], cLo)
    colAt([p.c[0], p.c[1] + p.r * 0.6, p.c[2]], cHi)
    const k = level === 0 ? 0.62 : level === 1 ? 0.72 : 1.0
    crownLump(s, p.c, p.r * k, g, rng, cLo.multiplyScalar(0.95), cHi, level === 0 ? 1 : 0, level >= 2 ? 0.78 : 0.82)
  }
  const [u0, v0, u1, v1] = cellUv(ATLAS_CELLS.tuft)
  // Cards per cluster: full (9) near; level 1 (LOW up close, mid range elsewhere) 4 bigger ones over the core; level 2
  // (far) 2 big ones — enough for a leafy silhouette around the lump (each is 2 tris, small on screen).
  const per = level === 0 ? 9 : level === 1 ? 4 : 2
  for (const p of lobes) {
    for (let i = 0; i < per; i++) {
      // Position: in the lobe, biased to its outer shell (and away from the crown centre).
      const u = rng.next() * 2 - 1, a = rng.next() * Math.PI * 2, q = Math.sqrt(1 - u * u)
      const rr = p.r * (0.5 + 0.45 * Math.sqrt(rng.next()))
      const pos: V3 = [p.c[0] + q * Math.cos(a) * rr, p.c[1] + u * rr * 0.75, p.c[2] + q * Math.sin(a) * rr]
      // Orientation: a random direction pulled toward "outward" (cards mostly face out of the crown).
      const out = nAt(pos)
      const rd: V3 = [rng.next() * 2 - 1, rng.next() * 2 - 1, rng.next() * 2 - 1]
      // (mostly outward: fully random cards were often seen edge-on → thin streaks across the crown)
      const n = norm([rd[0] * 0.55 + out[0], rd[1] * 0.55 + out[1], rd[2] * 0.55 + out[2]])
      const t1 = norm(Math.abs(n[1]) < 0.9 ? cross(n, [0, 1, 0]) : cross(n, [1, 0, 0]))
      const t2 = cross(n, t1)
      const roll = rng.next() * Math.PI * 2, cr = Math.cos(roll), sr = Math.sin(roll)
      const ax = add(mul(t1, cr), mul(t2, sr)), ay = add(mul(t1, -sr), mul(t2, cr))
      const w = p.r * (level === 0 ? 0.95 : level === 1 ? 1.25 : 1.35) * cardK * rng.range(0.85, 1.15), h = w * rng.range(0.8, 0.95)
      const mir = rng.next() < 0.5
      const corners: [number, number, number, number][] = [[-1, -1, mir ? u1 : u0, v0], [1, -1, mir ? u0 : u1, v0], [1, 1, mir ? u0 : u1, v1], [-1, 1, mir ? u1 : u0, v1]]
      const P = corners.map(([sx, sy]) => add(pos, add(mul(ax, sx * w), mul(ay, sy * h))))
      for (const j of [0, 1, 2, 0, 2, 3]) {
        const v = P[j]
        s.vert(v, nAt(v), [corners[j][2], corners[j][3]], colAt(v, c).clone())
      }
    }
  }
}


/**
 * GENSHIN CUMULUS CROWN: the branch-tip lobes are merged into ONE soft volume, as Genshin's broadleaves read
 * (Starfell Valley / Windrise refs) — not a bunch of balls. Leaf cards (billboarded leaf-mass tufts) are spread
 * EVENLY over the OUTER surface of the union of lobes (points inside a neighbouring lobe are skipped), each lit
 * with a normal pointing out of the whole crown (blended with its lobe), coloured by its height in the crown: a
 * pale top fading to a teal underside. Small dark inner cores fill the gaps (no visible plates).
 */
function cumulusCrown(s: Soup, lobes: Lobe[], level: number, rng: Rng, dark: THREE.Color, light: THREE.Color, tuftsPerLobe: number): void {
  let y0 = Infinity, y1 = -Infinity
  const ctr: V3 = [0, 0, 0]
  for (const l of lobes) {
    y0 = Math.min(y0, l.c[1] - l.r); y1 = Math.max(y1, l.c[1] + l.r)
    ctr[0] += l.c[0] / lobes.length; ctr[1] += l.c[1] / lobes.length; ctr[2] += l.c[2] / lobes.length
  }
  const span = Math.max(0.5, y1 - y0)
  const shade = (y: number, up: number) => Math.min(1, Math.max(0, ((y - y0) / span) * 0.8 + up * 0.25))
  // Inner cores: the crown's shaded interior, seen only through gaps between the cards.
  const coreDark = dark.clone().multiplyScalar(0.85), coreMid = dark.clone().lerp(light, 0.3)
  // Near levels: LEAF-textured cores (alpha-cut, so no smooth plate shows between the cards); far: plain lumps.
  for (const l of lobes) {
    if (level >= 2) crownLump(s, l.c, l.r * 0.95, ctr, rng, coreDark, light.clone().lerp(dark, 0.25), -1, 0.85)
    else leafCore(s, l.c, l.r * 0.72, ctr, rng, coreDark, coreMid, level === 0 ? 0 : -1, 0.85) // a fuller core → a smooth, rounded silhouette
  }
  if (level >= 2) return
  const [u0, v0, u1, v1] = cellUv(ATLAS_CELLS.tuft)
  const per = level === 0 ? tuftsPerLobe : Math.max(4, Math.round(tuftsPerLobe * 0.45))
  for (const l of lobes) {
    for (let i = 0; i < per; i++) {
      // Golden-spiral points over the lobe's upper ~85 % (the underside of a crown stays sparse and dark).
      const u = 1 - ((i + 0.5) / per) * 1.7
      const a = i * 2.39996 + rng.range(-0.25, 0.25)
      const q = Math.sqrt(Math.max(0, 1 - u * u))
      const rr = l.r * rng.range(0.86, 1.0)
      const p: V3 = [l.c[0] + q * Math.cos(a) * rr, l.c[1] + u * rr * 0.85, l.c[2] + q * Math.sin(a) * rr]
      // Only on the OUTER surface of the union: skip points buried in another lobe.
      if (lobes.some((m) => m !== l && (p[0] - m.c[0]) ** 2 + (p[1] - m.c[1]) ** 2 + (p[2] - m.c[2]) ** 2 < (m.r * 0.82) ** 2)) continue
      const ln: V3 = [p[0] - l.c[0], p[1] - l.c[1], p[2] - l.c[2]]
      const gn: V3 = [p[0] - ctr[0], p[1] - ctr[1], p[2] - ctr[2]]
      const gl = Math.hypot(gn[0], gn[1], gn[2]) || 1, ll = Math.hypot(ln[0], ln[1], ln[2]) || 1
      const n: V3 = [gn[0] / gl * 0.65 + ln[0] / ll * 0.35, gn[1] / gl * 0.65 + ln[1] / ll * 0.35 + 0.15, gn[2] / gl * 0.65 + ln[2] / ll * 0.35]
      const k = shade(p[1], n[1])
      const cb = dark.clone().lerp(light, k * 0.75), ct = dark.clone().lerp(light, Math.min(1, k * 0.75 + 0.3))
      const r = l.r * (level === 0 ? 0.6 : 0.78) * rng.range(0.9, 1.1) // bigger, overlapping leaf masses: soft crown, no jagged speckle
      const quad: [number, number, number, number, THREE.Color][] = [[-r, -r, u0, v0, cb], [r, -r, u1, v0, cb], [r, r, u1, v1, ct], [-r, r, u0, v1, ct]]
      for (const j of [0, 1, 2, 0, 2, 3]) {
        const [ox, oy, uu, vv, col] = quad[j]
        s.vert([p[0] + ox, p[1] + oy, p[2]], n, [uu, vv], col, p, [ox, oy])
      }
    }
  }
}

export function broadleaf(level: number, rng: Rng, o: BroadleafOpts, name: string): THREE.BufferGeometry {
  const s = new Soup()
  broadleafInto(s, level, rng, o)
  return s.geometry(name)
}

/** Mondstadt broadleaf (the 'birch' slot): warm bark, a fork at ~4 m, 3 limbs, cloud clumps. */
export const MONDSTADT_TREE: BroadleafOpts = {
  fork: 4.0, trunkR: 0.3, limbs: 3, spread: 2.8, clumpR: 1.9, lean: 0.12, tufts: 10, roots: 4,
  bark: 0x7a5236, dark: 0x3b6a2c, light: 0xb2d052, twist: 0.18,
}

/** WORLD TREE (the giant landmark oak, landmark units — LANDMARK_SCALE doubles it): buttress roots, 5 huge limbs. */
export const WORLD_TREE: BroadleafOpts = {
  fork: 13, trunkR: 2.5, limbs: 5, spread: 11, clumpR: 6.4, lean: 0.05, tufts: 22, roots: 7,
  bark: 0x76543a, dark: 0x4b8a2c, light: 0xb8de58, twist: 0.22,
}

export interface PineOpts {
  height: number
  trunkR: number
  branches: number
  bark: number
  dark: number
  light: number
}

/**
 * LIYUE PINE (the 'pine' slot): a twisted, leaning trunk (strong S-bend), a few near-horizontal branches from the
 * upper half, each ending in a FLAT cloud pad (Huangshan pines) — leaf tufts over a squashed core.
 */
export function twistedPine(level: number, rng: Rng, o: PineOpts): THREE.BufferGeometry {
  const s = new Soup()
  const bark = srgb(o.bark), barkD = bark.clone().multiplyScalar(0.5)
  const dark = srgb(o.dark), light = srgb(o.light)
  const segs = [9, 4, 3][level], sides = [7, 5, 4][level]
  const la = rng.next() * Math.PI * 2
  const lx = Math.cos(la), lz = Math.sin(la), px = -lz, pz = lx
  const amp = o.height * rng.range(0.07, 0.1), lean = o.height * rng.range(0.1, 0.16)
  const tp: V3[] = [], tr: number[] = []
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    const sb = Math.sin(t * Math.PI * 1.6) * amp * t // S-bend across the lean
    tp.push([lx * lean * t * t + px * sb, t * o.height, lz * lean * t * t + pz * sb])
    tr.push(o.trunkR * (1 + 0.5 * (1 - t) ** 5) * (1 - 0.65 * t))
  }
  tube(s, tp, tr, sides, barkD, bark, 0.22)
  const crown = tp[segs]
  const pad = (c: V3, r: number) => clump(s, c, r, [crown[0], c[1] + 0.6, crown[2]], level, 9, rng, dark, light, 0.42, 0.5)
  const nb = [o.branches, Math.max(2, o.branches - 1), 2][level]
  const ab = rng.next() * Math.PI * 2
  for (let j = 0; j < nb; j++) {
    const t = 0.3 + (j / nb) * 0.55 // pads from low on the trunk to near the top (no tall bare pole)
    const i0 = Math.round(t * segs)
    const p0 = tp[i0]
    const a = ab + j * 2.4 + rng.range(-0.3, 0.3)
    const len = o.height * rng.range(0.22, 0.32) * (1.15 - t * 0.5)
    const dir = norm([Math.cos(a), rng.range(0.05, 0.2), Math.sin(a)])
    const pts = branchPts(p0, dir, len, 0.18, [3, 2, 1][level], len * 0.1, rng.next() * 6.28)
    if (level < 2) tube(s, pts, pts.map((_, k) => tr[i0] * 0.55 * (1 - (k / (pts.length - 1)) * 0.7)), [4, 3][level], barkD, bark)
    pad(pts[pts.length - 1], o.height * rng.range(0.2, 0.26)) // big pads: a full canopy
  }
  pad([crown[0], crown[1] + 0.3, crown[2]], o.height * 0.24)
  return s.geometry('pine')
}

export const LIYUE_PINE: PineOpts = { height: 10.5, trunkR: 0.32, branches: 4, bark: 0x6e4a34, dark: 0x1e4436, light: 0x6f9e4c }

/** A GNARLED SNAG (the 'dead' slot): twisted grey trunk, a few crooked bare branches. */
export function gnarledSnag(level: number, rng: Rng): THREE.BufferGeometry {
  const s = new Soup()
  const c = srgb(0x7a6e62), cd = c.clone().multiplyScalar(0.5)
  const segs = [6, 4, 2][level], h = 6.8
  const ph = rng.next() * 6.28
  const tp: V3[] = [], tr: number[] = []
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    tp.push([Math.sin(t * 4 + ph) * 0.35 * t, t * h, Math.cos(t * 3.4 + ph) * 0.35 * t])
    tr.push(0.26 * (1 + 0.5 * (1 - t) ** 5) * (1 - 0.8 * t))
  }
  tube(s, tp, tr, [6, 5, 4][level], cd, c, 0.25)
  const nb = [5, 3, 0][level]
  for (let j = 0; j < nb; j++) {
    const i0 = Math.max(1, Math.round(rng.range(0.45, 0.9) * segs))
    const a = rng.next() * Math.PI * 2
    const dir = norm([Math.cos(a), rng.range(0.3, 0.9), Math.sin(a)])
    const len = rng.range(1.0, 2.0)
    const pts = branchPts(tp[i0], dir, len, -0.1, 2, 0.25, rng.next() * 6.28)
    tube(s, pts, [tr[i0] * 0.45, tr[i0] * 0.25, 0.02], 4, cd, c)
  }
  return s.geometry('dead')
}

// ---- REGION SPECIES (world/biomes/BiomeDefs.ts) ------------------------------------------------------------------

/** AUTUMN MAPLE: a lower fork, four wide limbs, a broad flat cumulus crown in orange (instance hues: gold → red). */
export const MAPLE_TREE: BroadleafOpts = {
  fork: 3.4, trunkR: 0.3, limbs: 4, spread: 3.3, clumpR: 2.0, lean: 0.1, tufts: 11, roots: 4, cumulus: true,
  bark: 0x5e4232, dark: 0x9a3418, light: 0xf2a23a, twist: 0.2,
}

/** MYSTIC ANCIENT: a giant violet-blue broadleaf — thick twisting trunk, buttress roots, five huge limbs. */
export const ANCIENT_TREE: BroadleafOpts = {
  fork: 6.2, trunkR: 0.62, limbs: 5, spread: 4.8, clumpR: 2.9, lean: 0.07, tufts: 11, roots: 6, cumulus: true,
  bark: 0x5c4e66, dark: 0x34287a, light: 0xa48cf0, twist: 0.3,
}

/**
 * MYSTIC SHROOM: a giant mushroom — a leaning, curving stalk, a wide flat cap (magenta → violet) with GLOWING spots
 * on top and a faintly glowing gill ring underneath (GLOW_UV: emissive in the vegetation shader, bloom on MEDIUM+).
 */
export function shroomTree(level: number, rng: Rng): THREE.BufferGeometry {
  const s = new Soup()
  const stalk = srgb(0xd8d0e8), stalkD = srgb(0x8a7aa8)
  const segs = [6, 4, 2][level]
  const h = 5.2, la = rng.next() * Math.PI * 2
  const pts: V3[] = [], radii: number[] = []
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    pts.push([Math.cos(la) * 0.9 * t * t, h * t, Math.sin(la) * 0.9 * t * t])
    radii.push(0.42 * (1 + 0.5 * (1 - t) ** 4) * (1 - 0.35 * t))
  }
  tube(s, pts, radii, [7, 5, 4][level], stalkD, stalk)
  const top = pts[segs]
  const capR = 2.5
  const capC: V3 = [top[0], top[1] + 0.15, top[2]]
  const capD = srgb(0x6a2a8a), capL = srgb(0xd85ac8)
  crownLump(s, capC, capR, [capC[0], capC[1] - 1.2, capC[2]], rng, capD, capL, level === 0 ? 1 : level === 1 ? 0 : -1, 0.36)
  // Gill ring under the cap (soft glow) and glowing spots on top.
  const glowD = srgb(0x5ad8f0), glowL = srgb(0xb8f4ff)
  if (level < 2) crownLump(s, [capC[0], capC[1] - 0.35, capC[2]], capR * 0.82, capC, rng, glowD, glowD, -1, 0.12, GLOW_UV)
  const spots = [9, 5, 0][level]
  for (let i = 0; i < spots; i++) {
    const a = rng.next() * Math.PI * 2, d = Math.sqrt(rng.next()) * capR * 0.8
    const y = capC[1] + capR * 0.36 * Math.sqrt(Math.max(0, 1 - (d / capR) ** 2)) - 0.02
    crownLump(s, [capC[0] + Math.cos(a) * d, y, capC[2] + Math.sin(a) * d], rng.range(0.16, 0.3), [capC[0], capC[1] - 2, capC[2]], rng, glowD, glowL, -1, 0.5, GLOW_UV)
  }
  return s.geometry('shroom')
}

/** AUTUMN LEAF PILE: a low drift of fallen leaves (flat leaf-mass cards on the ground) — gold / orange / red. */
export function leafPile(rng: Rng): THREE.BufferGeometry {
  const s = new Soup()
  const d = srgb(0x9a3a18), l = srgb(0xf0a640)
  crownLump(s, [0, 0.02, 0], 0.55, [0, -0.6, 0], rng, d, l, 0, 0.22)
  for (let i = 0; i < 6; i++) {
    const a = rng.next() * Math.PI * 2, r = rng.range(0.1, 0.5)
    tuft(s, [Math.cos(a) * r, 0.14, Math.sin(a) * r], rng.range(0.2, 0.3), [0, -0.5, 0], d, l)
  }
  return s.geometry('leafPile')
}

/** MYSTIC GLOW SHROOMS: a cluster of 3–4 small mushrooms with glowing cyan / violet caps. */
export function glowShrooms(rng: Rng): THREE.BufferGeometry {
  const s = new Soup()
  const stem = srgb(0xe6e0f0), stemD = srgb(0x9a8ab8)
  const caps = [[0x5ae0f0, 0xc8faff], [0xb070f0, 0xe8c8ff]] as const
  const n = 4
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.4, 0.4), r = i === 0 ? 0 : rng.range(0.15, 0.32)
    const x = Math.cos(a) * r, z = Math.sin(a) * r, h = rng.range(0.18, 0.42) * (i === 0 ? 1.3 : 1)
    tube(s, [[x, 0, z], [x + 0.02, h * 0.6, z], [x, h, z]], [0.035, 0.03, 0.025], 4, stemD, stem)
    const [cd, cl] = caps[i % 2]
    crownLump(s, [x, h, z], h * 0.42 + 0.04, [x, h - 0.2, z], rng, srgb(cd), srgb(cl), -1, 0.5, GLOW_UV)
  }
  return s.geometry('glowShrooms')
}

/**
 * GENSHIN BUSH (close-up reference): the card crown method at bush scale — ~14 fixed leaf-cluster cards over a low
 * dome (0.65 m radius), spherized normals from the dome centre, darker toward the centre and the ground.
 */
export function cardBush(rng: Rng, dark: THREE.Color, light: THREE.Color): THREE.BufferGeometry {
  const s = new Soup()
  const tips: [V3, number][] = [[[0, 0.35, 0], 1]]
  cardCrown(s, tips, { ...MONDSTADT_TREE, clumpR: 0.55, plates: true }, 1, rng, dark, light)
  return s.geometry('bush')
}
