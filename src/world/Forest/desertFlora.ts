import * as THREE from 'three'
import { SOLID_UV, SURFACE_UV } from '../../rendering/materials/FoliageAtlas'
import type { Rng } from '../noise/rng'

/**
 * DESERT FLORA (refer: south-western desert — saguaros, Joshua trees, agaves, sagebrush). Solid low-poly
 * geometry in the same vertex format as treeFactory (position, normal, uv → opaque atlas texel, colour,
 * bbCenter/bbOff = 0) so every species is one instanced draw on the shared vegetation material. They REPLACE
 * the forest species inside the desert (scatter.pickSpecies), so a desert chunk draws as many meshes as a forest one.
 *   saguaro   ribbed column + 0–3 elbowed arms, domed tops — L0 ≈ 400 tris, L1 ≈ 150, L2 ≈ 40
 *   joshua    shaggy forked trunk, spiky leaf balls at the branch tips — L0 ≈ 450, L1 ≈ 200, L2 ≈ 60
 *   agave / dry shrub (undergrowth) — ≈ 60 / 120 tris
 */
type V3 = [number, number, number]
const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)

export interface SoupLike {
  vert(p: V3, n: V3, uv: readonly [number, number], c: THREE.Color): void
}

/** Orthonormal frame around axis `d` (unit). */
function frame(d: V3): [V3, V3] {
  const a: V3 = Math.abs(d[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0]
  // u = normalize(a × d), v = d × u
  let u: V3 = [a[1] * d[2] - a[2] * d[1], a[2] * d[0] - a[0] * d[2], a[0] * d[1] - a[1] * d[0]]
  const l = Math.hypot(...u)
  u = [u[0] / l, u[1] / l, u[2] / l]
  const v: V3 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]]
  return [u, v]
}

/**
 * Tube p0 → p1 (radius r0 → r1) with `sides` faces; `rib` > 0 makes every other vertex recessed (cactus ribs:
 * dark grooves, light crests in the vertex colours). Smooth radial normals.
 */
function tube(s: SoupLike, p0: V3, p1: V3, r0: number, r1: number, sides: number, c0: THREE.Color, c1: THREE.Color, rib = 0, uv: readonly [number, number] = SOLID_UV): void {
  const d: V3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
  const L = Math.hypot(...d)
  const dn: V3 = [d[0] / L, d[1] / L, d[2] / L]
  const [u, v] = frame(dn)
  const groove = new THREE.Color()
  const at = (p: V3, r: number, i: number): [V3, V3, number] => {
    const a = (i / sides) * Math.PI * 2
    const k = rib > 0 && i % 2 === 1 ? 1 - rib : 1
    const ca = Math.cos(a), sa = Math.sin(a)
    const n: V3 = [u[0] * ca + v[0] * sa, u[1] * ca + v[1] * sa, u[2] * ca + v[2] * sa]
    return [[p[0] + n[0] * r * k, p[1] + n[1] * r * k, p[2] + n[2] * r * k], n, k]
  }
  for (let i = 0; i < sides; i++) {
    const [A, nA, kA] = at(p0, r0, i), [B, nB, kB] = at(p0, r0, i + 1)
    const [C, , ] = at(p1, r1, i + 1), [D, , ] = at(p1, r1, i)
    const col = (c: THREE.Color, k: number) => (k < 1 ? groove.copy(c).multiplyScalar(0.62) : c)
    const a0 = col(c0, kA).clone(), b0 = col(c0, kB).clone(), b1 = col(c1, kB).clone(), a1 = col(c1, kA).clone()
    s.vert(A, nA, uv, a0); s.vert(C, nB, uv, b1); s.vert(B, nB, uv, b0)
    s.vert(A, nA, uv, a0); s.vert(D, nA, uv, a1); s.vert(C, nB, uv, b1)
  }
}

/** Rounded cap (low cone) closing a tube end at `p` along `d`. */
function dome(s: SoupLike, p: V3, d: V3, r: number, sides: number, c: THREE.Color, top: THREE.Color): void {
  const [u, v] = frame(d)
  const apex: V3 = [p[0] + d[0] * r * 0.7, p[1] + d[1] * r * 0.7, p[2] + d[2] * r * 0.7]
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2
    const q = (a: number): [V3, V3] => {
      const n: V3 = [u[0] * Math.cos(a) + v[0] * Math.sin(a), u[1] * Math.cos(a) + v[1] * Math.sin(a), u[2] * Math.cos(a) + v[2] * Math.sin(a)]
      return [[p[0] + n[0] * r, p[1] + n[1] * r, p[2] + n[2] * r], [n[0] + d[0], n[1] + d[1], n[2] + d[2]]]
    }
    const [A, nA] = q(a0), [B, nB] = q(a1)
    s.vert(apex, d, SOLID_UV, top); s.vert(B, nB, SOLID_UV, c); s.vert(A, nA, SOLID_UV, c)
  }
}

/** Saguaro: a ribbed column with elbowed arms that bend upward, domed tips. ~5.5 m tall at scale 1. */
export function saguaro(s: SoupLike, level: number, rng: Rng): void {
  const dark = srgb(0x3e5a2c), light = srgb(0x7f9a4e), tip = srgb(0x9cb064)
  const sides = [12, 8, 6][level]
  const rib = level === 2 ? 0 : 0.14
  const H = 5.6, R = 0.34
  const segs = level === 0 ? 3 : 1
  for (let k = 0; k < segs; k++) {
    const y0 = (k / segs) * H, y1 = ((k + 1) / segs) * H
    const r0 = R * (1 - 0.08 * (k / segs)), r1 = R * (1 - 0.08 * ((k + 1) / segs))
    tube(s, [0, y0 - (k === 0 ? 0.2 : 0), 0], [0, y1, 0], r0, r1, sides, dark.clone().lerp(light, k / segs * 0.4), dark.clone().lerp(light, 0.3 + (k + 1) / segs * 0.5), rib)
  }
  dome(s, [0, H, 0], [0, 1, 0], R * 0.92, sides, light, tip)
  const arms = level === 2 ? Math.min(2, 1 + rng.int(2)) : rng.int(4)
  const a0 = rng.next() * 6.28
  for (let i = 0; i < arms; i++) {
    const a = a0 + (i / Math.max(1, arms)) * Math.PI * 2 + rng.range(-0.5, 0.5)
    const dx = Math.cos(a), dz = Math.sin(a)
    const y = rng.range(1.9, 3.3)
    const out = rng.range(0.7, 1.0), up = rng.range(1.0, 2.0)
    const r = R * rng.range(0.6, 0.72)
    const p0: V3 = [dx * R * 0.5, y, dz * R * 0.5]
    const elbow: V3 = [dx * (R + out), y + 0.35, dz * (R + out)]
    const top: V3 = [elbow[0], elbow[1] + up, elbow[2]]
    const as = Math.max(6, sides - 2)
    tube(s, p0, elbow, r, r, as, dark, dark.clone().lerp(light, 0.4), rib)
    tube(s, elbow, top, r, r * 0.95, as, dark.clone().lerp(light, 0.35), light, rib)
    // Fill the elbow joint with a small cap so the bend reads as one limb.
    dome(s, elbow, [dx * 0.3, -0.95, dz * 0.3], r * 0.95, as, dark, dark)
    dome(s, top, [0, 1, 0], r * 0.92, as, light, tip)
  }
}

/** Joshua tree: a shaggy trunk that forks 2–3 times; each tip carries a ball of spiky blue-green leaves. ~6 m. */
export function joshua(s: SoupLike, level: number, rng: Rng): void {
  const bark = srgb(0x6b5a44), shag = srgb(0x8a7454)
  const leafD = srgb(0x3e5a3a), leafL = srgb(0x9aae6a)
  const sides = [7, 5, 4][level]
  const trunkTop: V3 = [rng.range(-0.2, 0.2), 2.4, rng.range(-0.2, 0.2)]
  tube(s, [0, -0.2, 0], trunkTop, 0.36, 0.26, sides, bark.clone().multiplyScalar(0.7), shag, 0, SURFACE_UV.bark)
  const tips: { p: V3; d: V3 }[] = []
  const grow = (from: V3, dir: V3, len: number, r: number, depth: number) => {
    const to: V3 = [from[0] + dir[0] * len, from[1] + dir[1] * len, from[2] + dir[2] * len]
    tube(s, from, to, r, r * 0.78, Math.max(4, sides - depth), bark, shag, 0, SURFACE_UV.bark)
    if (depth >= (level === 2 ? 1 : 2)) {
      tips.push({ p: to, d: dir })
      return
    }
    const n = 2
    const a0 = rng.next() * 6.28
    for (let i = 0; i < n; i++) {
      const a = a0 + i * Math.PI + rng.range(-0.4, 0.4)
      const spread = rng.range(0.45, 0.8)
      const nd: V3 = [dir[0] * 0.5 + Math.cos(a) * spread, 0.85, dir[2] * 0.5 + Math.sin(a) * spread]
      const l = Math.hypot(...nd)
      grow(to, [nd[0] / l, nd[1] / l, nd[2] / l], len * rng.range(0.7, 0.9), r * 0.75, depth + 1)
    }
  }
  const branches = level === 2 ? 2 : 2 + rng.int(2)
  const b0 = rng.next() * 6.28
  for (let i = 0; i < branches; i++) {
    const a = b0 + (i / branches) * Math.PI * 2 + rng.range(-0.3, 0.3)
    const d: V3 = [Math.cos(a) * 0.65, 0.76, Math.sin(a) * 0.65]
    const l = Math.hypot(...d)
    grow(trunkTop, [d[0] / l, d[1] / l, d[2] / l], rng.range(1.3, 1.7), 0.2, 0)
  }
  // Leaf balls: thin pointed spikes radiating from each tip (double-sided material), a dead-leaf skirt below.
  const spikes = [22, 12, 6][level]
  for (const { p, d } of tips) {
    const [u, v] = frame(d)
    for (let k = 0; k < spikes; k++) {
      const z = rng.range(-0.35, 1)
      const a = rng.next() * 6.28
      const rr = Math.sqrt(1 - z * z)
      const dir: V3 = [d[0] * z + (u[0] * Math.cos(a) + v[0] * Math.sin(a)) * rr, d[1] * z + (u[1] * Math.cos(a) + v[1] * Math.sin(a)) * rr, d[2] * z + (u[2] * Math.cos(a) + v[2] * Math.sin(a)) * rr]
      const len = rng.range(0.45, 0.7) * (level === 2 ? 1.4 : 1)
      const w = 0.07 * (level === 2 ? 2 : 1)
      const [su] = frame(dir)
      const tipP: V3 = [p[0] + dir[0] * len, p[1] + dir[1] * len, p[2] + dir[2] * len]
      const b0p: V3 = [p[0] + su[0] * w, p[1] + su[1] * w, p[2] + su[2] * w]
      const b1p: V3 = [p[0] - su[0] * w, p[1] - su[1] * w, p[2] - su[2] * w]
      s.vert(b0p, dir, SOLID_UV, leafD); s.vert(tipP, dir, SOLID_UV, leafL); s.vert(b1p, dir, SOLID_UV, leafD)
    }
    if (level < 2) tube(s, [p[0] - d[0] * 0.45, p[1] - d[1] * 0.45, p[2] - d[2] * 0.45], p, 0.2, 0.24, 5, shag.clone().multiplyScalar(0.8), shag, 0, SURFACE_UV.bark)
  }
}

/** Agave: a rosette of thick pointed blue-green leaves arching up and out. */
export function agave(s: SoupLike, rng: Rng): void {
  const base = srgb(0x4e6e62), tipC = srgb(0xa8b890)
  const n = 11
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2)
    const lean = rng.range(0.35, 1.0)
    const len = rng.range(0.55, 0.85)
    const dx = Math.cos(a), dz = Math.sin(a)
    const tip: V3 = [dx * len * lean, len * (1.15 - lean * 0.5), dz * len * lean]
    const w = 0.09
    const l: V3 = [-dz * w, 0, dx * w], r: V3 = [dz * w, 0, -dx * w]
    const mid: V3 = [dx * 0.05, 0.12, dz * 0.05] // folded V: the leaf's spine
    const nn: V3 = [dx * 0.6, 0.8, dz * 0.6]
    s.vert(l, nn, SOLID_UV, base); s.vert(tip, nn, SOLID_UV, tipC); s.vert(mid, nn, SOLID_UV, base)
    s.vert(mid, nn, SOLID_UV, base); s.vert(tip, nn, SOLID_UV, tipC); s.vert(r, nn, SOLID_UV, base)
  }
}

/** Sagebrush / creosote: a low, wide, grey-olive mound of jittered lumps with pale tops. */
export function dryShrub(s: SoupLike, rng: Rng): void {
  const dark = srgb(0x5a5a40), light = srgb(0xb4ac7c)
  const g = new THREE.IcosahedronGeometry(1, 0)
  const pos = g.getAttribute('position')
  for (let k = 0; k < 4; k++) {
    const c: V3 = [rng.range(-0.35, 0.35), 0.25 + rng.range(0, 0.15), rng.range(-0.35, 0.35)]
    const r = rng.range(0.28, 0.42)
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
      const j = 0.75 + 0.5 * ((Math.abs(x * 7.1 + y * 3.3 + z * 5.7 + k) % 1))
      const p: V3 = [c[0] + x * r * j, c[1] + y * r * 0.75 * j, c[2] + z * r * j]
      s.vert(p, [x, y + 0.3, z], SOLID_UV, dark.clone().lerp(light, Math.max(0, y * 0.5 + 0.5)))
    }
  }
  g.dispose()
}
