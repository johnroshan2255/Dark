import * as THREE from 'three'
import type RAPIER from '@dimforge/rapier3d-compat'
import { group, Groups, type PhysicsWorld } from '../../physics/PhysicsWorld'
import { PILLAR_STRIDE, type FixedMap } from './FixedMap'
import { stylize } from '../../rendering/shaders/stylize'

/**
 * SANDSTONE PILLARS (Zhangjiajie & Wulingyuan; map.json `pillars`, scripts/blender/zhangjiajie/build.py): thousands of
 * fluted quartz-sandstone columns — horizontal strata, darker grooves, a talus mound at the foot (that one is in the
 * ground grid), and a crown of green (pines on top, shrubs on the ledges) as in the concept.
 * Why meshes, not the ground grid: the terrain is 2 m only near the player (4 m, 8 m further, ~58 m on the horizon) —
 * a 20 m column there turned into a cone, and the skyline (the whole point of the map) into soft pyramids.
 *
 * Drawing: VARIANTS shapes × 3 LODs, each an InstancedMesh (vertex colours: the map's palette) on PILLAR_MATERIAL —
 * the boulders' flat-colour stone look WITHOUT their cull fade (they dissolve with their chunk; the pillars are the
 * skyline) — ≤ 9 draws for every pillar on the map, +1 program. Each pillar is one instance scaled (radius, height, radius); every
 * REBIN_M of movement the instances are re-sorted into the LODs by distance (~4 k matrices copied, < 1 ms).
 * LOD0 (< LOD0_M): ~900 tris, LOD1 (< LOD1_M): ~140, LOD2: ~30 (a skyline prism with its green top).
 * Physics: one fixed body, a cylinder per pillar (Static: the car, the player, the camera ray, bots on the server via
 * statics.bin — `addColliders` is also what scripts/export-statics.mjs calls).
 */
const VARIANTS = 5
const LOD0_M = 150
const LOD1_M = 430
const REBIN_M = 10
/** Collider radius as a share of the pillar's: the flutes' grooves (the ridges stand out to ~1.28 r). */
const COLLIDE_R = 1.0

type Pal = { rock: THREE.Color; cliff: THREE.Color; pale: THREE.Color; grey: THREE.Color; green: THREE.Color; greenDark: THREE.Color }

/** Deterministic hash → [0, 1). */
function h01(a: number, b: number, c = 0): number {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453
  return s - Math.floor(s)
}

/**
 * The five SILHOUETTES (radius × y, unit space): a straight column, a tapering spire, two tiers with a wooded ledge,
 * a bulging crown, a leaning column (its axis drifts LEAN radii sideways by the top). `ledge`: the tiered one's shelf.
 */
const PROFILE = [
  (y: number) => 1 - 0.14 * y,
  (y: number) => 1 - 0.5 * y ** 1.3,
  (y: number) => (y < 0.48 ? 1 - 0.06 * y : y > 0.56 ? 0.66 - 0.08 * (y - 0.56) : 0.97 - 0.31 * ((y - 0.48) / 0.08)),
  (y: number) => 0.9 + 0.14 * Math.sin(Math.PI * y ** 0.8) - 0.1 * y,
  (y: number) => 1 - 0.22 * y,
]
const LEAN = [0, 0, 0, 0, 0.45]
const LEDGE = [0, 0, 0.52, 0, 0]

/**
 * One pillar in unit space (radius ≈ 1 at the foot, height 1): `segs` facets round, `rings` strata up — flutes, the
 * variant's silhouette, stepped strata, grey bands, dark water streaks down some grooves — and its green: a canopy of
 * `blobs` lumps over the top (the pines on Zhangjiajie's columns), `ledges` shrubs clinging to the sides. Non-indexed:
 * flat-shaded facets, like the world's low-poly rock.
 */
function pillarGeometry(v: number, segs: number, rings: number, blobs: number, ledges: number, pal: Pal): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = []
  const ph1 = h01(v, 1) * 6.28, ph2 = h01(v, 2) * 6.28
  const fl1 = 0.15 + 0.06 * h01(v, 3), fl2 = 0.07
  const prof = PROFILE[v], lean = LEAN[v]
  const flute = (th: number) => (segs >= 12 ? 1 + fl1 * Math.sin(6 * th + ph1) + fl2 * Math.sin(11 * th + ph2) : 1 + 0.06 * Math.sin(3 * th + ph1))
  const ringY = (k: number) => (k === 0 ? -0.06 : k / rings)
  const ringR = (k: number) => {
    const y = Math.max(0, ringY(k))
    // the silhouette, and STRATA: each band a little in or out (a stepped, layered face)
    return prof(y) * (rings > 3 ? 1 + 0.07 * (h01(v, 10 + k) - 0.5) : 1)
  }
  const leanX = (y: number) => lean * Math.max(0, y) ** 1.5
  const c = new THREE.Color(), cb = new THREE.Color()
  const rockAt = (k: number, s: number, th: number, out: THREE.Color) => {
    const band = h01(v, 40 + k)
    // quartz sandstone: grey with beige / tan bands (the concept's columns; the palette's warm tones alone read orange
    // in the low sun)
    out.copy(pal.rock).lerp(pal.cliff, 0.25 + 0.45 * band).lerp(pal.grey, 0.32)
    if (band > 0.8) out.lerp(pal.pale, 0.4)                           // a pale stratum
    else if (band < 0.25) out.lerp(pal.grey, 0.5)                     // a grey one
    const f = flute(th)
    out.multiplyScalar(0.72 + 0.5 * Math.min(1, Math.max(0, (f - 0.85) / 0.35))) // grooves dark, ridges light
    if (h01(v, 300 + s) > 0.78 && ringY(k) < 0.25 + 0.7 * h01(v, 320 + s)) out.multiplyScalar(0.72) // water streaks
    if (ringY(k) < 0.08) out.multiplyScalar(0.8)                      // the damp foot
    return out
  }
  const push = (x: number, y: number, z: number, cc: THREE.Color) => {
    pos.push(x, y, z)
    col.push(cc.r, cc.g, cc.b)
  }
  const vert = (k: number, s: number) => {
    const th = (s / segs) * Math.PI * 2
    const r = ringR(k) * flute(th)
    const y = ringY(k)
    return [Math.cos(th) * r + leanX(y), y, Math.sin(th) * r, th] as const
  }
  // the column
  for (let k = 0; k < rings; k++) {
    for (let s = 0; s < segs; s++) {
      const a = vert(k, s), b = vert(k, s + 1), d = vert(k + 1, s), e = vert(k + 1, s + 1)
      rockAt(k, s, (a[3] + b[3]) / 2, c)
      push(a[0], a[1], a[2], c); push(d[0], d[1], d[2], c); push(b[0], b[1], b[2], c)
      push(b[0], b[1], b[2], c); push(d[0], d[1], d[2], c); push(e[0], e[1], e[2], c)
    }
  }
  // the top: a low green dome over the last ring (soil and moss under the trees)
  const rTop = prof(1), xTop = leanX(1), apex = 1.03
  for (let s = 0; s < segs; s++) {
    const a = vert(rings, s), b = vert(rings, s + 1)
    cb.copy(pal.greenDark).lerp(pal.green, h01(v, 70 + s) * 0.5)
    push(a[0], 1, a[2], cb); push(xTop, apex, 0, cb); push(b[0], 1, b[2], cb)
  }
  // canopy lumps: low-poly octahedra (the pines' crowns from afar) over the top, on the ledges, clinging to the sides
  const lump = (x: number, y: number, z: number, sx: number, sy: number, k: number) => {
    cb.copy(pal.greenDark).lerp(pal.green, 0.15 + 0.75 * h01(v, 90 + k))
    const P = [[sx, 0, 0], [-sx, 0, 0], [0, sy, 0], [0, -sy * 0.5, 0], [0, 0, sx], [0, 0, -sx]]
    const F = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]]
    for (const f of F) {
      c.copy(cb).multiplyScalar(f.includes(2) ? 1 : 0.68)
      for (const i of f) push(x + P[i][0], y + P[i][1], z + P[i][2], c)
    }
  }
  for (let k = 0; k < blobs; k++) {
    const a = h01(v, 100 + k) * 6.28, rr = Math.sqrt(h01(v, 120 + k)) * 0.85 * rTop
    const big = k === 0 ? 1.4 : 1
    lump(xTop + Math.cos(a) * rr, apex - 0.006, Math.sin(a) * rr, (0.28 + 0.2 * h01(v, 140 + k)) * rTop * big, (0.045 + 0.04 * h01(v, 160 + k)) * big, k)
  }
  for (let k = 0; k < ledges; k++) {
    const shelf = LEDGE[v] && k < ledges / 2
    const y = shelf ? LEDGE[v] + 0.04 : 0.2 + 0.7 * h01(v, 200 + k), a = h01(v, 220 + k) * 6.28
    const kk = Math.min(rings, Math.max(0, Math.round(y * rings)))
    const r = ringR(kk) * flute(a) * (shelf ? 1.15 : 0.97)
    lump(Math.cos(a) * r + leanX(y), y, Math.sin(a) * r, (0.2 + 0.12 * h01(v, 240 + k)) * (shelf ? 1.3 : 1), 0.035, 50 + k)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

export class PillarField {
  readonly root = new THREE.Group()
  /** [variant][lod] */
  private readonly meshes: THREE.InstancedMesh[][] = []
  /** Each pillar's instance matrix (16 floats) and its variant. */
  private readonly mats: Float32Array
  private readonly variant: Uint8Array
  private readonly n: number
  private lastX = Number.NaN
  private lastZ = Number.NaN
  private far = 0
  private body: RAPIER.RigidBody | null = null

  private readonly material = stylize(new THREE.MeshLambertMaterial({ vertexColors: true }), { key: 'pillar', treeShade: true, rim: 0.2, toon: 0.12, wet: true })

  constructor(private readonly map: FixedMap, private readonly physics: PhysicsWorld) {
    this.root.name = 'pillars'
    const p = map.pillars
    this.n = p.length / PILLAR_STRIDE
    const pal: Pal = {
      rock: new THREE.Color().setRGB(...(map.palette.rock ?? [0.2, 0.17, 0.13])),
      cliff: new THREE.Color().setRGB(...(map.palette.cliff ?? [0.37, 0.3, 0.22])),
      pale: new THREE.Color().setRGB(...(map.palette.sand ?? [0.62, 0.45, 0.28])),
      grey: new THREE.Color(0.2, 0.2, 0.19),
      green: new THREE.Color().setRGB(...(map.palette.grass ?? [0.13, 0.25, 0.1])),
      greenDark: new THREE.Color().setRGB(...(map.palette.grassDark ?? [0.02, 0.07, 0.04])),
    }
    this.mats = new Float32Array(this.n * 16)
    this.variant = new Uint8Array(this.n)
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
    const perVariant = new Array(VARIANTS).fill(0)
    for (let i = 0; i < this.n; i++) {
      const o = i * PILLAR_STRIDE
      t.set(p[o], p[o + 1], p[o + 2])
      q.setFromAxisAngle(up, p[o + 5])
      s.set(p[o + 3], p[o + 4], p[o + 3])
      m.compose(t, q, s).toArray(this.mats, i * 16)
      this.variant[i] = p[o + 6] % VARIANTS
      perVariant[this.variant[i]]++
    }
    const LODS: [number, number, number, number][] = [[24, 14, 14, 12], [11, 6, 6, 4], [8, 3, 3, 0]] // segs, rings, top lumps, ledge lumps
    for (let v = 0; v < VARIANTS; v++) {
      this.meshes.push(LODS.map(([sg, rg, bl, lg], l) => {
        const mesh = new THREE.InstancedMesh(pillarGeometry(v, sg, rg, bl, lg, pal), this.material, Math.max(1, perVariant[v]))
        mesh.name = `pillars.v${v}.lod${l}`
        mesh.count = 0
        mesh.frustumCulled = false
        mesh.castShadow = l < 2
        mesh.receiveShadow = true
        this.root.add(mesh)
        return mesh
      }))
    }
    this.addColliders(physics)
  }

  /** A cylinder per pillar on one fixed body (Static). Also used by scripts/export-statics.mjs on its scratch world. */
  addColliders(physics: PhysicsWorld): RAPIER.RigidBody | null {
    const p = this.map.pillars
    if (!p.length) return null
    const R = physics.R
    const body = physics.world.createRigidBody(R.RigidBodyDesc.fixed())
    for (let o = 0; o < p.length; o += PILLAR_STRIDE) {
      physics.world.createCollider(
        R.ColliderDesc.cylinder(p[o + 4] / 2, p[o + 3] * COLLIDE_R).setTranslation(p[o], p[o + 1] + p[o + 4] / 2, p[o + 2]).setCollisionGroups(group(Groups.Static, 0xffff)).setFriction(0.8),
        body,
      )
    }
    if (physics === this.physics) this.body = body
    return body
  }

  /** Per frame: re-sort the instances into the LODs once the player has moved REBIN_M; past `far` m (the tier's view
   *  distance: the fog is complete there) none are drawn. */
  update(focus: THREE.Vector3, far: number): void {
    if (Math.hypot(focus.x - this.lastX, focus.z - this.lastZ) < REBIN_M && far === this.far) return
    this.far = far
    this.lastX = focus.x
    this.lastZ = focus.z
    const p = this.map.pillars
    const counts = this.meshes.map(() => [0, 0, 0])
    const l0 = LOD0_M * LOD0_M, l1 = LOD1_M * LOD1_M, lf = far * far
    for (let i = 0; i < this.n; i++) {
      const o = i * PILLAR_STRIDE
      const dx = p[o] - focus.x, dz = p[o + 2] - focus.z
      // (a wide pillar counts as nearer: its LOD switch is measured to its face)
      const d = Math.max(0, Math.sqrt(dx * dx + dz * dz) - p[o + 3])
      if (d * d > lf) continue
      const lod = d * d < l0 ? 0 : d * d < l1 ? 1 : 2
      const v = this.variant[i]
      const mesh = this.meshes[v][lod]
      ;(mesh.instanceMatrix.array as Float32Array).set(this.mats.subarray(i * 16, i * 16 + 16), counts[v][lod] * 16)
      counts[v][lod]++
    }
    for (let v = 0; v < VARIANTS; v++) {
      for (let l = 0; l < 3; l++) {
        const mesh = this.meshes[v][l]
        mesh.count = counts[v][l]
        mesh.visible = mesh.count > 0
        mesh.instanceMatrix.needsUpdate = true
      }
    }
  }

  dispose(): void {
    for (const row of this.meshes) for (const m of row) m.geometry.dispose()
    this.material.dispose()
    if (this.body) this.physics.world.removeRigidBody(this.body)
  }
}
