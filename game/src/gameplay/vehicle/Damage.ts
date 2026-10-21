import * as THREE from 'three'
import { triangles } from './hulls'

/**
 * CAR DAMAGE (GTA-style): crashes and falls dent the body where they hit, the dented shape becomes the car's collider,
 * and the damage builds 0 → 100 %: engine SMOKE from 50 %, FIRE from 90 %, an EXPLOSION at 100 % (VehicleFx, Game).
 *
 *  - IMPACT: the chassis' velocity change over the last 4 fixed steps (67 ms), gravity added back — tyres, brakes
 *    and suspension never change it that fast; a wall, a tree, a rock or a hard landing do. Above ~6 m/s the hit
 *    counts: damage ≈ 4 % per m/s over the threshold (≤ 45 % in one hit; a 40 km/h tree ≈ 20 %, a 90 km/h wall ≈
 *    60 %, a 10 m fall ≈ 25 %), then a 0.3 s cooldown (one crash = one hit).
 *  - DENT where the push came from: the body / door / glass vertices within R of the contact point move inward
 *    (smooth fall-off + a little crumple noise), crumpled faces get flat normals (bent metal catches the light).
 *  - COLLIDER: the exact trimesh is rebuilt from the dented mesh 0.4 s after the last hit (≈ 5–20 ms, only then).
 * Cost: nothing per frame but a velocity ring; a dent ≈ 1–3 ms on the CPU (vertex loop over the body).
 */
export interface DentPart {
  geo: THREE.BufferGeometry
  /** Car space → this part's space (doors: hinge space, closed). */
  toLocal: THREE.Matrix4
  /** In the collider (the cabin is not). */
  collider: boolean
  /** Vertices of `geo` that belong to it (the body: the shell's, not the merged cabin's). */
  count?: number
}

const WINDOW = 4
const THRESHOLD = 6
const PER_MS = 4
const MAX_HIT = 45

export class Damage {
  /** 0 … 100. */
  level = 0
  /** Exploded (a burnt wreck). */
  wrecked = false
  private readonly hist: THREE.Vector3[] = Array.from({ length: WINDOW + 1 }, () => new THREE.Vector3())
  private head = 0
  private filled = 0
  private cooldown = 0
  private rebuildT = -1
  /** A hit: amount (%), world contact point, severity m/s — Game shakes the camera / plays the crunch. */
  onHit: ((amount: number, at: THREE.Vector3, severity: number) => void) | null = null
  /** The exact collider changed (VehicleSim.replaceMesh). */
  onCollider: ((tris: Float32Array) => void) | null = null

  constructor(
    private readonly parts: DentPart[],
    /** Body box in car space: centre and half extents. */
    private readonly centre: THREE.Vector3,
    private readonly half: THREE.Vector3,
  ) {}

  /**
   * Fixed step (before the sim step): the body's velocity now (world), its orientation, gravity (m/s², +down);
   * `enabled` = false while the car flies / floats (no crash damage then).
   */
  step(dt: number, vel: THREE.Vector3, q: THREE.Quaternion, gravity: number, enabled: boolean): void {
    this.cooldown = Math.max(0, this.cooldown - dt)
    if (this.rebuildT >= 0 && (this.rebuildT -= dt) < 0) this.rebuild()
    this.head = (this.head + 1) % (WINDOW + 1)
    this.hist[this.head].copy(vel)
    this.filled = Math.min(WINDOW + 1, this.filled + 1)
    if (!enabled || this.wrecked || this.filled <= WINDOW || this.cooldown > 0) return
    const old = this.hist[(this.head + 1) % (WINDOW + 1)]
    _dv.copy(vel).sub(old)
    _dv.y += gravity * dt * WINDOW // (free fall is not an impact)
    const sev = _dv.length() - THRESHOLD
    if (sev <= 0) return
    this.cooldown = 0.3
    // The push came FROM the contact side: the contact is opposite the velocity change (car space).
    _d.copy(_dv).negate().normalize().applyQuaternion(_qi.copy(q).invert())
    this.hit(_d, sev)
  }

  /** Apply a hit from car-space direction `dir` (unit, centre → contact) with severity `sev` (m/s over the threshold). */
  hit(dir: THREE.Vector3, sev: number): void {
    const amount = Math.min(MAX_HIT, sev * PER_MS)
    this.level = Math.min(100, this.level + amount)
    // Contact: where the ray from the body centre along dir leaves the body box.
    const t = Math.min(...[0, 1, 2].map((i) => (Math.abs(dir.getComponent(i)) > 1e-4 ? this.half.getComponent(i) / Math.abs(dir.getComponent(i)) : 1e9)))
    _p.copy(dir).multiplyScalar(t).add(this.centre)
    this.dent(_p, dir, Math.min(0.95, 0.35 + 0.045 * sev), Math.min(0.24, 0.016 * sev + 0.02))
    this.rebuildT = 0.4
    this.onHit?.(amount, _p, sev)
  }

  /** Push the vertices within `radius` of `at` (car space) inward (−dir) by up to `depth` (m). */
  private dent(at: THREE.Vector3, dir: THREE.Vector3, radius: number, depth: number): void {
    const r2 = radius * radius
    for (const part of this.parts) {
      const pos = part.geo.getAttribute('position') as THREE.BufferAttribute
      _a.copy(at).applyMatrix4(part.toLocal)
      _in.copy(dir).negate().transformDirection(part.toLocal)
      const n = part.count ?? pos.count
      let touched = false
      for (let i = 0; i < n; i++) {
        const dx = pos.getX(i) - _a.x, dy = pos.getY(i) - _a.y, dz = pos.getZ(i) - _a.z
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 >= r2) continue
        const f = 1 - d2 / r2
        // crumple: a fixed hash of the vertex position wrinkles the dent (no two crashes look the same)
        const h = Math.sin(pos.getX(i) * 91.7 + pos.getY(i) * 47.3 + pos.getZ(i) * 13.1) * 43758.5453
        const crumple = 0.75 + 0.5 * (h - Math.floor(h))
        const m = depth * f * f * crumple
        pos.setXYZ(i, pos.getX(i) + _in.x * m, pos.getY(i) + _in.y * m, pos.getZ(i) + _in.z * m)
        touched = true
      }
      if (!touched) continue
      pos.needsUpdate = true
      flatNormals(part.geo, _a, radius * 1.05, n)
      part.geo.computeBoundingSphere()
    }
  }

  /** The exact collider from the dented shapes (car space). */
  private rebuild(): void {
    this.rebuildT = -1
    if (!this.onCollider) return
    const soup = triangles(this.parts.filter((p) => p.collider).map((p) => {
      const pos = p.geo.getAttribute('position') as THREE.BufferAttribute
      const n = p.count ?? pos.count
      // (doors: back from hinge space to car space)
      const back = _m.copy(p.toLocal).invert()
      const arr = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        _a.fromBufferAttribute(pos, i).applyMatrix4(back)
        arr[i * 3] = _a.x; arr[i * 3 + 1] = _a.y; arr[i * 3 + 2] = _a.z
      }
      return { position: arr, index: null }
    }))
    this.onCollider(soup)
  }
}

/** Flat (face) normals for the triangles near `at` (non-indexed geometry, first `count` vertices). */
function flatNormals(g: THREE.BufferGeometry, at: THREE.Vector3, radius: number, count: number): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const nor = g.getAttribute('normal') as THREE.BufferAttribute | undefined
  if (!nor || g.index) return
  const r2 = radius * radius
  for (let i = 0; i + 2 < count; i += 3) {
    _t0.fromBufferAttribute(pos, i); _t1.fromBufferAttribute(pos, i + 1); _t2.fromBufferAttribute(pos, i + 2)
    if (_t0.distanceToSquared(at) > r2 && _t1.distanceToSquared(at) > r2 && _t2.distanceToSquared(at) > r2) continue
    _t1.sub(_t0); _t2.sub(_t0)
    _t0.crossVectors(_t1, _t2)
    if (_t0.lengthSq() < 1e-12) continue
    _t0.normalize()
    // keep the side the original normal faced (both-sided body: the inside stays the inside)
    _t1.fromBufferAttribute(nor, i)
    if (_t1.dot(_t0) < 0) _t0.negate()
    for (let k = 0; k < 3; k++) nor.setXYZ(i + k, _t0.x, _t0.y, _t0.z)
  }
  nor.needsUpdate = true
}

const _dv = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3(), _a = new THREE.Vector3(), _in = new THREE.Vector3()
const _qi = new THREE.Quaternion(), _m = new THREE.Matrix4()
const _t0 = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3()
