import * as THREE from 'three'
import type { MapData } from './MapData'
import type { Vehicle } from './Vehicle'

/**
 * The CHASE CAMERA: behind and above the car, swinging round after its heading with a little lag (so a slide shows),
 * pulled back a touch with speed. Drag (mouse / finger) orbits it; it eases back behind the car 1.5 s after you let
 * go. ZOOM (3.5–40 m, eased): the mouse wheel, a two-finger pinch, the + / − keys and the on-screen + / − buttons
 * (`zoom`). Never under the ground.
 */
export class ChaseCam {
  private yaw = 0
  private orbit = 0
  private pitch = 0.22
  private dist = 9
  private distTo = 9
  private idle = 0
  private drag = false
  private lx = 0
  private ly = 0
  private readonly touches = new Map<number, { x: number; y: number }>()
  private pinch = 0
  enabled = true
  private readonly look = new THREE.Vector3()

  constructor(readonly camera: THREE.PerspectiveCamera, private readonly map: MapData, private readonly car: Vehicle, dom: HTMLElement) {
    dom.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest?.('.oth-touch')) return
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      this.drag = this.touches.size === 1; this.lx = e.clientX; this.ly = e.clientY
      if (this.touches.size === 2) this.pinch = this.spread()
    })
    const up = (e: PointerEvent) => {
      this.touches.delete(e.pointerId)
      this.drag = false
      this.pinch = 0
    }
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('pointermove', (e) => {
      const t = this.touches.get(e.pointerId)
      if (t) { t.x = e.clientX; t.y = e.clientY }
      if (!this.enabled) return
      // two fingers: PINCH to zoom (apart = closer)
      if (this.touches.size === 2 && this.pinch > 0) {
        const d = this.spread()
        if (d > 0) { this.zoom(this.pinch / d); this.pinch = d }
        return
      }
      if (!this.drag) return
      this.orbit -= (e.clientX - this.lx) * 0.006
      this.pitch = THREE.MathUtils.clamp(this.pitch + (e.clientY - this.ly) * 0.004, -0.1, 1.2)
      this.lx = e.clientX; this.ly = e.clientY
      this.idle = 0
    })
    dom.addEventListener('wheel', (e) => { if (this.enabled) this.zoom(e.deltaY > 0 ? 1.12 : 0.89) }, { passive: true })
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Equal' || e.code === 'NumpadAdd') this.zoom(0.85)
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') this.zoom(1.18)
    })
  }

  /** Zoom: the distance × k (< 1 closer), 3.5–40 m; the camera eases there. */
  zoom(k: number): void {
    this.distTo = THREE.MathUtils.clamp(this.distTo * k, 3.5, 40)
  }

  private spread(): number {
    const [a, b] = [...this.touches.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }

  snap(): void {
    if (this.car.sim) this.yaw = this.car.sim.heading
  }

  update(dt: number): void {
    if (!this.car.sim) return
    const h = this.car.sim.heading
    let d = h - this.yaw
    d = Math.atan2(Math.sin(d), Math.cos(d))
    this.yaw += d * Math.min(1, dt * 3.2)
    if (!this.drag) {
      this.idle += dt
      if (this.idle > 1.5) this.orbit *= Math.max(0, 1 - dt * 1.8)
    }
    this.dist += (this.distTo - this.dist) * Math.min(1, dt * 8)
    const a = this.yaw + this.orbit
    const speed = Math.abs(this.car.sim.speed)
    const dist = this.dist * (1 + Math.min(speed, 30) / 90)
    const p = this.car.pos
    this.look.set(p.x, p.y + 1.6, p.z)
    const cx = p.x + Math.sin(a) * Math.cos(this.pitch) * dist
    const cz = p.z + Math.cos(a) * Math.cos(this.pitch) * dist
    let cy = p.y + 1.6 + Math.sin(this.pitch) * dist
    cy = Math.max(cy, this.map.height(cx, cz) + 1.2)
    this.camera.position.set(cx, cy, cz)
    this.camera.lookAt(this.look)
    this.camera.updateMatrixWorld()
  }
}
