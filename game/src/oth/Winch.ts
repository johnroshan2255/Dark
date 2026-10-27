import * as THREE from 'three'
import type { MapData } from './MapData'
import type { Rocks } from './Rocks'
import { TREE_STRIDE, type Trees } from './Trees'
import type { Vehicle } from './Vehicle'

/**
 * THE WINCH (2026-10-27, OTH: "your trusty winch" — stuck in mud, up a ledge, out of a river): E (or WINCH) hooks the
 * cable from the front bumper to the best anchor ahead within 35 m — a tree's trunk or a boulder (the nearest one in
 * front, ±70°) — and REELS IN at 1.5 m/s: while the cable is taut it pulls the car toward the anchor (a spring capped
 * at ~1.3 g of the car's weight, damped along the cable), so you steer and give it gas and the winch does the rest.
 * E again lets go; it lets go itself at the anchor. The cable: a dark camera-facing ribbon that sags while slack.
 * One draw (34 vertices rewritten per frame), ≈ 0.01 ms CPU.
 */
const REACH = 35
const SEG = 16

export class Winch {
  readonly mesh: THREE.Mesh
  private anchor: THREE.Vector3 | null = null
  private what = ''
  private len = 0
  private readonly hook = new THREE.Vector3()
  private readonly pos: Float32Array
  private readonly geo: THREE.BufferGeometry
  private readonly v = new THREE.Vector3()
  private readonly w = new THREE.Vector3()
  private readonly tc = new THREE.Vector3()
  /** Messages (main.ts: the toast). */
  onMessage: ((m: string) => void) | null = null

  constructor(private readonly map: MapData, private readonly car: Vehicle, private readonly trees: Trees, private readonly rocks: Rocks) {
    this.pos = new Float32Array((SEG + 1) * 2 * 3)
    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    const idx: number[] = []
    for (let i = 0; i < SEG; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2) }
    this.geo.setIndex(idx)
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.12, 0.1, 0.085), side: THREE.DoubleSide }))
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    window.addEventListener('keydown', (e) => { if (e.code === 'KeyE' && !e.repeat) this.toggle() })
  }

  get attached(): boolean { return this.anchor !== null }

  toggle(): void {
    if (this.anchor) { this.anchor = null; this.mesh.visible = false; this.onMessage?.('Winch released'); return }
    const sim = this.car.sim
    if (!sim) return
    this.hookPoint()
    const f = this.forward()
    let best: THREE.Vector3 | null = null, bd = 1e9, what = ''
    const consider = (x: number, y: number, z: number, kind: string) => {
      const dx = x - this.hook.x, dz = z - this.hook.z, d = Math.hypot(dx, dz)
      if (d > REACH || d < 2.5 || (dx * f.x + dz * f.z) / d < 0.34) return
      if (d < bd) { bd = d; best = new THREE.Vector3(x, y, z); what = kind }
    }
    const t = this.trees.data
    for (let i = 0; i < this.trees.count; i++) {
      const o = i * TREE_STRIDE
      if ((t[o] - this.hook.x) ** 2 + (t[o + 2] - this.hook.z) ** 2 > REACH * REACH) continue
      consider(t[o], t[o + 1] + 1.5, t[o + 2], t[o + 5] >= 3 ? 'a birch' : t[o + 5] === 2 ? 'a dead snag' : 'a spruce')
    }
    for (const r of this.rocks.all) if (r.s > 1.2) consider(r.x, this.map.height(r.x, r.z) + Math.min(1.2, r.s * r.sy * 0.5), r.z, 'a boulder')
    if (!best) { this.onMessage?.('Winch: nothing to hook within 35 m ahead'); return }
    this.anchor = best
    this.what = what
    this.len = bd
    this.mesh.visible = true
    this.onMessage?.(`Winch hooked to ${what} · ${Math.round(bd)} m — reeling in`)
  }

  /** Physics step: reel in, pull while taut. */
  fixed(dt: number): void {
    const a = this.anchor, sim = this.car.sim
    if (!a || !sim) return
    this.hookPoint()
    this.v.subVectors(a, this.hook)
    const d = this.v.length()
    this.len = Math.max(2.5, this.len - 1.5 * dt)
    if (d < 3.2 && this.len <= 2.6) { this.anchor = null; this.mesh.visible = false; this.onMessage?.(`Winched up to ${this.what}`); return }
    if (d <= this.len) return
    const b = sim.body, m = b.mass(), lv = b.linvel()
    this.v.divideScalar(d)
    const along = lv.x * this.v.x + lv.y * this.v.y + lv.z * this.v.z
    const F = Math.min(m * 9.81 * 1.3, m * 9.81 * 2.2 * (d - this.len) - m * 1.6 * along)
    if (F <= 0) return
    b.applyImpulseAtPoint({ x: this.v.x * F * dt, y: this.v.y * F * dt, z: this.v.z * F * dt }, { x: this.hook.x, y: this.hook.y, z: this.hook.z }, true)
  }

  /** Per frame: the cable from the bumper to the anchor, sagging while slack. */
  update(camera: THREE.Camera): void {
    const a = this.anchor
    if (!a) return
    this.hookPoint()
    const d = this.hook.distanceTo(a), sag = Math.sqrt(Math.max(0, this.len * this.len - d * d)) * 0.5
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG
      this.v.lerpVectors(this.hook, a, t)
      this.v.y -= sag * 4 * t * (1 - t)
      this.v.y = Math.max(this.v.y, this.map.height(this.v.x, this.v.z) + 0.3)
      // (a ribbon facing the camera, 7 cm wide: it reads over the grass and the mud)
      this.tc.copy(camera.position).sub(this.v).normalize()
      this.w.subVectors(a, this.hook).cross(this.tc).normalize().multiplyScalar(0.035)
      if (!Number.isFinite(this.w.x)) this.w.set(0.015, 0, 0)
      this.pos.set([this.v.x - this.w.x, this.v.y - this.w.y, this.v.z - this.w.z, this.v.x + this.w.x, this.v.y + this.w.y, this.v.z + this.w.z], i * 6)
    }
    this.geo.attributes.position.needsUpdate = true
    this.geo.computeBoundingSphere()
  }

  private forward(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(this.car.root.quaternion)
  }

  /** The cable's end on the car: the front bumper's middle, a little up. */
  private hookPoint(): void {
    const md = this.car.model
    const z = md ? -md.half.z - 0.05 : -2.2
    this.hook.set(0, (md ? md.wheelRadius : 0.4) + 0.45, z).applyQuaternion(this.car.root.quaternion).add(this.car.root.position)
  }
}
