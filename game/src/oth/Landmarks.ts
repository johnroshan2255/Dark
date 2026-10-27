import * as THREE from 'three'
import type { Atmosphere } from './Atmosphere'
import { Builder, woodMaterial } from './Bridges'
import type { Landmark, MapData } from './MapData'
import type { Tier } from './quality'
import type { TerrainShadow } from './TerrainShadow'

/**
 * LANDMARKS (2026-10-27, the user: "add those" — OTH's Canada: fire-watch towers above the forests, remote cabins,
 * fishing shacks, forgotten sawmills and mining tunnels, scenic viewpoints, fallen meteorites): the places
 * scripts/oth/scenery.mjs picked and levelled (`meta.landmarks`), built here from the bridges' kit — weathered logs and
 * planks, dark shingle roofs, field-stone, all flat-shaded in this world's light; a FIRE LOOKOUT's red roof stands out
 * from kilometres away (the haze leaves the far land readable); windows and lanterns GLOW warm at night. One merged
 * mesh, one draw (~20 k vertices for all of them). Each has its COLLIDERS (Physics.ts: boxes; a dock's deck is ground),
 * and is DISCOVERED when the car comes within ~40 m of its pad — saved in this browser (localStorage), shown on the
 * map and the compass (MapView.ts).
 */
export interface LandmarkCollider { c: THREE.Vector3; h: THREE.Vector3; q: THREE.Quaternion; ground: boolean }

const KEY = (id: string) => `oth.found.${id}`

export class Landmarks {
  readonly group = new THREE.Group()
  readonly list: Landmark[]
  readonly colliders: LandmarkCollider[] = []
  readonly found = new Set<number>()
  /** Called when a landmark is first reached (main.ts: a toast, the map). */
  onDiscover: ((l: Landmark, found: number, total: number) => void) | null = null
  private checkT = 0

  constructor(private readonly map: MapData, atmos: Atmosphere, shadow: TerrainShadow, tier: Tier, farGrid: THREE.Vector4) {
    this.list = map.meta.landmarks ?? []
    try { for (const id of JSON.parse(localStorage.getItem(KEY(map.meta.id)) ?? '[]') as number[]) this.found.add(id) } catch { /* (private window: nothing kept) */ }
    if (!this.list.length) return
    const b = new Builder(0x51a3c7)
    for (const l of this.list) {
      const from = b.count, cols: [THREE.Vector3, THREE.Vector3, boolean][] = []
      const col = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, ground = false) => cols.push([new THREE.Vector3(cx, cy, cz), new THREE.Vector3(hx, hy, hz), ground])
      KINDS[l.kind](b, l, col, map)
      const m = new THREE.Matrix4().compose(new THREE.Vector3(l.x, l.y, l.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), l.rot), new THREE.Vector3(1, 1, 1))
      b.transform(from, m)
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), l.rot)
      for (const [c, h, ground] of cols) this.colliders.push({ c: c.applyMatrix4(m), h, q, ground })
    }
    const mesh = new THREE.Mesh(b.geometry(), woodMaterial(atmos, shadow, tier, farGrid))
    mesh.frustumCulled = false // (one mesh over the whole box: always partly in view)
    this.group.add(mesh)
  }

  /** Discover what the car (x, z) has reached (checked twice a second). */
  update(dt: number, x: number, z: number): void {
    if ((this.checkT -= dt) > 0) return
    this.checkT = 0.5
    for (const l of this.list) {
      if (this.found.has(l.id) || (l.x - x) ** 2 + (l.z - z) ** 2 > (l.r + 40) ** 2) continue
      this.found.add(l.id)
      try { localStorage.setItem(KEY(this.map.meta.id), JSON.stringify([...this.found])) } catch { /* (not kept) */ }
      this.onDiscover?.(l, this.found.size, this.list.length)
    }
  }
}

// ---------------------------------------------------------------------------------------------------- the kit
type Col = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, ground?: boolean) => void
type RGB = [number, number, number]
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const X = V(1, 0, 0), Y = V(0, 1, 0), Z = V(0, 0, 1)
const ROOF: RGB = [0.13, 0.095, 0.075], RED_ROOF: RGB = [0.46, 0.13, 0.08], TIN: RGB = [0.4, 0.27, 0.18]
const STONE: RGB = [0.4, 0.4, 0.41], DARK: RGB = [0.035, 0.03, 0.028], GLASS: RGB = [0.06, 0.065, 0.075]
const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k]
/** An axis-aligned box in the landmark's own frame. */
const box = (b: Builder, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, c: RGB) => b.box(V(cx, cy, cz), X, Y, Z, hx, hy, hz, c)
/** A gable ROOF over a w × d footprint, its ridge along z, eaves at y0, the ridge h higher, an overhang; slabs (both
 *  sides drawn) and the two gable ends' triangles down to the walls' top (wallY). */
function gable(b: Builder, w: number, d: number, y0: number, h: number, over: number, c: RGB, gableC: RGB, wallY = y0) {
  const W = w / 2 + over, D = d / 2 + over, Ls = Math.hypot(W, h)
  for (const sx of [-1, 1]) {
    const u = V(-sx * W, h, 0).normalize(), n = V(sx * h, W, 0).normalize()
    b.box(V((sx * W) / 2, y0 + h / 2, 0), u, n, Z, Ls / 2, 0.07, D, shade(c, sx > 0 ? 1 : 0.92))
  }
  const hi = y0 + h * ((W - over) / W)
  for (const sz of [-1, 1]) {
    const z = (sz * d) / 2, a = V(-w / 2, wallY, z), c2 = V(w / 2, wallY, z), t = V(0, hi, z)
    if (sz > 0) { b.tri(a, c2, t, gableC); b.tri(c2, a, t, shade(gableC, 0.7)) } else { b.tri(c2, a, t, gableC); b.tri(a, c2, t, shade(gableC, 0.7)) }
  }
}
/** A pyramid (hip) roof over a square of half size s at y0, apex h above. */
function hip(b: Builder, s: number, y0: number, h: number, c: RGB) {
  const ap = V(0, y0 + h, 0), cs = [V(-s, y0, -s), V(s, y0, -s), V(s, y0, s), V(-s, y0, s)]
  for (let i = 0; i < 4; i++) { const p = cs[i], q = cs[(i + 1) % 4]; b.tri(q, p, ap, shade(c, 0.85 + 0.15 * (i % 2))); b.tri(p, q, ap, shade(c, 0.6)) }
}
/** A LOG CABIN wall course: logs stacked along x (at z) or along z (at x), crossing at the corners. */
function logWalls(b: Builder, w: number, d: number, hgt: number, r: number) {
  const n = Math.round(hgt / (r * 2))
  for (let i = 0; i < n; i++) {
    const y = r + i * r * 2
    for (const sz of [-1, 1]) b.log(V(-w / 2 - 0.3, y, (sz * d) / 2), V(w / 2 + 0.3, y, (sz * d) / 2), r, b.wood(0.95))
    for (const sx of [-1, 1]) b.log(V((sx * w) / 2, y + r, -d / 2 - 0.3), V((sx * w) / 2, y + r, d / 2 + 0.3), r, b.wood(0.9))
  }
}
/** A window: a dark frame proud of the wall, glass that glows at night (normal along `out`). */
function windowAt(b: Builder, c: THREE.Vector3, out: THREE.Vector3, along: THREE.Vector3, hw: number, hh: number) {
  b.box(c, along, Y, out, hw + 0.08, hh + 0.08, 0.05, b.wood(0.6))
  b.setGlow(1)
  b.box(c.clone().addScaledVector(out, 0.04), along, Y, out, hw, hh, 0.03, GLASS)
  b.setGlow(0)
}

const KINDS: Record<Landmark['kind'], (b: Builder, l: Landmark, col: Col, map: MapData) => void> = {
  /** FIRE LOOKOUT: four splayed log legs 13 m up, X-braced, a ladder; on top a catwalk with a rail round the cab (lit
   *  windows all round), its RED hip roof seen from afar. */
  tower(b, _l, col) {
    const H = 13, base = 2.4, top = 1.7
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      b.log(V(sx * base, -0.8, sz * base), V(sx * top, H, sz * top), 0.17, b.wood(0.85))
      col(sx * (base + top) / 2, H / 2, sz * (base + top) / 2, 0.3, H / 2, 0.3)
    }
    // X braces on each side at three levels
    for (let lv = 0; lv < 3; lv++) {
      const y0 = 0.6 + lv * 4.1, y1 = y0 + 4.1, k0 = base + (top - base) * (y0 / H), k1 = base + (top - base) * (y1 / H)
      for (let s = 0; s < 4; s++) {
        const a = (s * Math.PI) / 2, ca = Math.cos(a), sa = Math.sin(a), t = (k: number, side: number) => V(ca * k - sa * k * side, 0, sa * k + ca * k * side)
        const p0 = t(k0, -1).setY(y0), p1 = t(k1, 1).setY(y1), p2 = t(k0, 1).setY(y0), p3 = t(k1, -1).setY(y1)
        b.log(p0, p1, 0.07, b.wood(0.75)); b.log(p2, p3, 0.07, b.wood(0.75))
      }
    }
    // the ladder up the front face
    const lz = base + 0.25
    for (const sx of [-0.35, 0.35]) b.log(V(sx, 0, lz), V(sx, H, top + 0.25), 0.05, b.wood(0.8))
    for (let r = 0; r < 26; r++) { const t = r / 26, y = t * H, z = lz + (top + 0.25 - lz) * t; b.log(V(-0.35, y, z), V(0.35, y, z), 0.035, b.wood(0.8)) }
    // the catwalk floor, its rail, the cab with windows, the red roof
    box(b, 0, H + 0.12, 0, 2.6, 0.12, 2.6, b.wood(0.9))
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2, ca = Math.cos(a), sa = Math.sin(a)
      const p = (u: number, v: number) => V(ca * u - sa * v, 0, sa * u + ca * v)
      b.log(p(-2.55, 2.55).setY(H + 1.2), p(2.55, 2.55).setY(H + 1.2), 0.05, b.wood(0.85))
      b.log(p(2.55, 2.55).setY(H + 0.24), p(2.55, 2.55).setY(H + 1.25), 0.05, b.wood(0.85))
    }
    box(b, 0, H + 0.24 + 0.5, 0, 1.6, 0.5, 1.6, b.wood(1.05))
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2, out = V(Math.sin(a), 0, Math.cos(a)), along = V(Math.cos(a), 0, -Math.sin(a))
      windowAt(b, out.clone().multiplyScalar(1.6).setY(H + 1.65), out, along, 1.25, 0.42)
    }
    box(b, 0, H + 2.15, 0, 1.62, 0.08, 1.62, b.wood(0.7))
    hip(b, 2.1, H + 2.2, 1.4, RED_ROOF)
  },

  /** VIEWPOINT: a stone cairn, a bench looking out over the drop, a signpost and a short log rail at the edge. */
  view(b, _l, col) {
    for (let i = 0; i < 4; i++) box(b, -2.2 + (i % 2) * 0.1, 0.22 + i * 0.36, -1.2, 0.62 - i * 0.12, 0.18, 0.55 - i * 0.1, shade(STONE, 0.85 + 0.1 * (i % 2)))
    col(-2.2, 0.75, -1.2, 0.65, 0.75, 0.6)
    box(b, 0, 0.45, 0.6, 1.0, 0.05, 0.22, b.wood())
    box(b, 0, 0.75, 0.42, 1.0, 0.18, 0.03, b.wood())
    for (const sx of [-0.85, 0.85]) box(b, sx, 0.22, 0.6, 0.05, 0.22, 0.18, b.wood(0.7))
    col(0, 0.45, 0.6, 1.05, 0.45, 0.3)
    b.log(V(2.2, -0.3, -0.6), V(2.2, 2.3, -0.6), 0.08, b.wood(0.8))
    box(b, 2.2, 2.0, -0.5, 0.55, 0.16, 0.03, b.wood(1.1))
    col(2.2, 1.1, -0.6, 0.15, 1.1, 0.15)
    for (const sx of [-2.6, 0, 2.6]) b.log(V(sx, -0.3, 2.6), V(sx, 0.9, 2.6), 0.08, b.wood(0.8))
    b.log(V(-2.9, 0.8, 2.6), V(2.9, 0.8, 2.6), 0.07, b.wood(0.85))
    col(0, 0.5, 2.6, 3.0, 0.5, 0.15)
  },

  /** LOG CABIN: notched log walls, a door and lit windows, a shingle gable roof, a stone chimney, a porch and a woodpile. */
  cabin(b, _l, col) {
    const w = 5.2, d = 4.2, hgt = 2.4
    logWalls(b, w, d, hgt, 0.15)
    box(b, 0.9, 1.0, d / 2 + 0.17, 0.45, 1.0, 0.05, shade(DARK, 3))
    windowAt(b, V(-1.2, 1.35, d / 2 + 0.17), Z, X, 0.42, 0.35)
    windowAt(b, V(w / 2 + 0.17, 1.35, 0), X, Z, 0.4, 0.35)
    gable(b, w + 0.6, d + 0.6, hgt + 0.15, 1.7, 0.35, ROOF, b.wood(0.85), hgt + 0.15)
    box(b, -w / 2 - 0.1, 2.3, -0.8, 0.45, 2.3, 0.45, STONE)
    col(0, 1.4, 0, w / 2 + 0.3, 1.4, d / 2 + 0.3)
    col(-w / 2 - 0.1, 2.3, -0.8, 0.5, 2.3, 0.5)
    // the porch: planks, two posts
    box(b, 0, 0.12, d / 2 + 1.0, w / 2 + 0.2, 0.08, 0.8, b.wood(1.05))
    for (const sx of [-w / 2, w / 2]) b.log(V(sx, 0, d / 2 + 1.7), V(sx, hgt + 0.4, d / 2 + 1.7), 0.09, b.wood(0.8))
    // the woodpile against the far wall
    for (let r = 0; r < 3; r++) for (let i = 0; i < 4 - r; i++) b.log(V(w / 2 + 0.6, 0.18 + r * 0.32, -1.6 + i * 0.36 + r * 0.18), V(w / 2 + 1.6, 0.18 + r * 0.32, -1.6 + i * 0.36 + r * 0.18), 0.16, b.wood(1.1))
    col(w / 2 + 1.1, 0.5, -1.0, 0.55, 0.5, 0.8)
  },

  /** FISHING SHACK: a plank shed with a lean-to roof and a lit window, a DOCK out over the lake on posts (drivable), a
   *  rowboat tied alongside. */
  shack(b, l, col, map) {
    const w = 3.0, d = 2.6
    for (let i = 0; i < 9; i++) {
      const x = -w / 2 + (i + 0.5) * (w / 9)
      for (const sz of [-1, 1]) box(b, x, 1.1, (sz * d) / 2, w / 18 - 0.01, 1.1 + (sz > 0 ? 0.25 : -0.05), 0.04, b.wood())
    }
    for (let i = 0; i < 8; i++) { const z = -d / 2 + (i + 0.5) * (d / 8); for (const sx of [-1, 1]) box(b, (sx * w) / 2, 1.15, z, 0.04, 1.15, d / 16 - 0.01, b.wood()) }
    box(b, 0.7, 0.95, d / 2 + 0.06, 0.4, 0.95, 0.04, shade(DARK, 3))
    windowAt(b, V(w / 2 + 0.06, 1.4, 0), X, Z, 0.35, 0.3)
    b.box(V(0, 2.5, 0), X, V(0, 1, -0.25).normalize(), V(0, 0.25, 1).normalize(), w / 2 + 0.4, 0.06, d / 2 + 0.45, ROOF)
    col(0, 1.2, 0, w / 2 + 0.1, 1.2, d / 2 + 0.1)
    // the dock: from the shack's front out over the water, 1.8 m wide, at the lake's level + 0.45
    const lake = map.meta.water.lake.level, top = lake + 0.45 - l.y, len = 12
    for (let i = 0; i < Math.round(len / 0.3); i++) box(b, 0, top - 0.04, d / 2 + 1.2 + i * 0.3, 0.9 + (b.rnd() - 0.5) * 0.1, 0.04, 0.13, b.wood())
    for (let i = 0; i <= 4; i++) for (const sx of [-0.85, 0.85]) b.log(V(sx, top - 2.5, d / 2 + 1.2 + i * 2.9), V(sx, top + 0.15, d / 2 + 1.2 + i * 2.9), 0.09, b.wood(0.75))
    col(0, top - 0.15, d / 2 + 1.1 + len / 2, 1.0, 0.15, len / 2, true)
    // the rowboat: a little hull of planks beside the dock's end
    const bz = d / 2 + len - 1.5, by = lake + 0.12 - l.y
    box(b, 1.75, by, bz, 0.5, 0.08, 1.4, shade([0.3, 0.42, 0.45], 1))
    for (const sx of [-1, 1]) {
      const v = V(sx * 0.5, 1, 0).normalize(), w = new THREE.Vector3().crossVectors(Z, v)
      b.box(V(1.75 + sx * 0.5, by + 0.18, bz), Z, v, w, 1.4, 0.2, 0.04, [0.32, 0.46, 0.5])
    }
  },

  /** SAWMILL: an open shed on posts under a long rusty-tin gable roof, the saw bench in it, stacked LOG PILES in the
   *  yard, a sawdust heap and a little office hut. */
  sawmill(b, _l, col) {
    const L = 12, W = 6, Hh = 3.6
    for (const sx of [-1, 1]) for (let i = 0; i < 4; i++) {
      const z = -L / 2 + (i * L) / 3
      b.log(V((sx * W) / 2, -0.3, z), V((sx * W) / 2, Hh, z), 0.13, b.wood(0.8))
      col((sx * W) / 2, Hh / 2, z, 0.18, Hh / 2, 0.18)
    }
    for (const sx of [-1, 1]) b.log(V((sx * W) / 2, Hh, -L / 2 - 0.3), V((sx * W) / 2, Hh, L / 2 + 0.3), 0.12, b.wood(0.75))
    gable(b, W, L, Hh + 0.1, 1.6, 0.5, TIN, b.wood(0.8))
    // the saw bench, a log on it, the blade
    box(b, 0, 0.45, 0, 0.6, 0.45, 4.2, b.wood(0.7))
    b.log(V(0, 1.15, -3.8), V(0, 1.15, 1.0), 0.3, b.wood(1.15))
    b.box(V(0, 1.2, 2.0), Y, Z, X, 0.55, 0.55, 0.02, [0.55, 0.56, 0.58])
    col(0, 0.6, 0, 0.7, 0.6, 4.2)
    // log piles in the yard: pyramids of long logs
    for (const [px, pz] of [[W / 2 + 3.5, -3.5], [W / 2 + 3.5, 2.5], [-W / 2 - 3.8, 4]] as const) {
      for (let r = 0; r < 4; r++) for (let i = 0; i < 4 - r; i++) {
        const x = px - 0.95 + i * 0.62 + r * 0.31, y = 0.3 + r * 0.53
        b.log(V(x, y, pz - 2.6), V(x, y, pz + 2.6), 0.3, b.wood(1.1))
      }
      col(px, 1.0, pz, 1.4, 1.0, 2.7)
    }
    // the sawdust heap
    const sd: RGB = [0.62, 0.48, 0.3], hc = V(-W / 2 - 2.6, 0, -3.5), ring: THREE.Vector3[] = []
    for (let a = 0; a < 8; a++) ring.push(V(hc.x + Math.cos((a / 8) * 6.283) * 2.0, -0.1, hc.z + Math.sin((a / 8) * 6.283) * 1.6))
    for (let a = 0; a < 8; a++) b.tri(ring[(a + 1) % 8], ring[a], V(hc.x, 1.1, hc.z), shade(sd, 0.9 + 0.1 * (a % 2)))
    // the office hut
    box(b, -W / 2 - 3.2, 1.2, 1.2 - 4, 1.4, 1.2, 1.2, b.wood(0.95))
    windowAt(b, V(-W / 2 - 3.2 + 1.42, 1.4, -2.8), X, Z, 0.35, 0.3)
    gable(b, 2.8, 2.4, 2.4, 0.9, 0.25, ROOF, b.wood(0.85))
    col(-W / 2 - 3.2, 1.2, -2.8, 1.5, 1.2, 1.3)
  },

  /** MINE: a timber portal set into the rock's face, the black mouth of the tunnel behind it, a lantern, ore-cart
   *  RAILS out of it and a cart on them. */
  mine(b, _l, col) {
    const hw = 1.6, hh = 2.8
    // the ADIT: timber-lined walls and a plank roof running back into the rock, the frame at its mouth, the dark
    // beyond it a black face just behind the frame (the hill closes round the rest)
    for (const sx of [-1, 1]) for (let i = 0; i < 6; i++) box(b, sx * (hw - 0.05), 0.25 + i * 0.47, -1.6, 0.05, 0.22, 1.8, b.wood(0.7))
    box(b, 0, hh + 0.05, -1.6, hw + 0.15, 0.08, 1.8, b.wood(0.6))
    b.quad(V(-hw + 0.1, 0, 0.05), V(hw - 0.1, 0, 0.05), V(hw - 0.1, hh, 0.05), V(-hw + 0.1, hh, 0.05), DARK)
    for (const sx of [-1, 1]) { b.log(V(sx * hw, -0.3, 0.3), V(sx * hw, hh, 0.3), 0.2, b.wood(0.75)); col(sx * hw, hh / 2, 0.3, 0.25, hh / 2, 0.25) }
    b.log(V(-hw - 0.5, hh + 0.1, 0.3), V(hw + 0.5, hh + 0.1, 0.3), 0.22, b.wood(0.7))
    col(0, hh / 2, -0.5, hw, hh / 2, 0.5)
    b.setGlow(1)
    box(b, hw - 0.4, hh - 0.5, 0.6, 0.1, 0.14, 0.1, [0.5, 0.35, 0.15])
    b.setGlow(0)
    // rails and sleepers out to the yard
    for (let i = 0; i < 14; i++) box(b, 0, 0.05, 0.6 + i * 0.6, 0.75, 0.05, 0.1, b.wood(0.6))
    for (const sx of [-0.45, 0.45]) box(b, sx, 0.13, 0.6 + 4.2, 0.03, 0.04, 4.2, [0.22, 0.2, 0.19])
    // the ore cart
    box(b, 0, 0.75, 5.0, 0.6, 0.4, 0.85, [0.28, 0.2, 0.15])
    box(b, 0, 1.1, 5.0, 0.5, 0.1, 0.75, [0.2, 0.17, 0.15])
    for (const sx of [-0.45, 0.45]) for (const sz of [-0.5, 0.5]) b.box(V(sx, 0.32, 5.0 + sz), Z, Y, X, 0.2, 0.2, 0.05, DARK)
    col(0, 0.75, 5.0, 0.65, 0.6, 0.9)
  },

  /** METEORITE: a dark scorched boulder in its crater, cracks glowing ember-orange at night, chips scattered round. */
  /** The HIDDEN PLACES (terrain.py builds them — the basin, its fall and pool, the flowers): nothing to add. */
  falls() {},
  meadow() {},
  meteorite(b, _l, col) {
    const ico = new THREE.IcosahedronGeometry(1, 1), pos = ico.getAttribute('position')
    const pts: THREE.Vector3[] = []
    for (let i = 0; i < pos.count; i++) {
      const p = V(pos.getX(i), pos.getY(i), pos.getZ(i))
      const k = 1.5 + 0.35 * Math.sin(p.x * 5.1 + p.y * 3.3) * Math.cos(p.z * 4.7)
      pts.push(p.multiply(V(k * 1.15, k * 0.8, k)).add(V(0, 0.9, 0)))
    }
    for (let i = 0; i < pts.length; i += 3) {
      const glow = (i / 3) % 7 === 3
      if (glow) b.setGlow(0.7)
      b.tri(pts[i], pts[i + 1], pts[i + 2], glow ? [0.35, 0.12, 0.04] : shade([0.1, 0.09, 0.085], 0.8 + b.rnd() * 0.4))
      if (glow) b.setGlow(0)
    }
    col(0, 0.9, 0, 1.6, 1.0, 1.6)
    for (let i = 0; i < 9; i++) {
      const a = b.rnd() * 6.283, r = 3 + b.rnd() * 5, s = 0.15 + b.rnd() * 0.25
      b.box(V(Math.cos(a) * r, s * 0.6, Math.sin(a) * r), X, Y, Z, s, s * 0.7, s * 1.2, shade([0.12, 0.11, 0.1], 0.8 + b.rnd() * 0.5))
    }
  },
}
