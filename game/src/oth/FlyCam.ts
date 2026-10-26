import * as THREE from 'three'
import type { MapData } from './MapData'

/**
 * A free camera for looking at the world until the 4×4s drive in: drag (or pointer lock on click) to look, WASD to
 * move, Space / C up and down, Shift fast, wheel = speed. Never below eye height over the ground. Touch: one finger
 * looks, two fingers move forward.
 * yaw: forward = (−sin yaw, 0, −cos yaw) — 0 looks north (−z).
 */
export class FlyCam {
  yaw = 0
  pitch = -0.05
  speed = 18
  private keys = new Set<string>()
  private drag = false
  private lx = 0
  private ly = 0
  private touches = 0

  constructor(readonly camera: THREE.PerspectiveCamera, private readonly map: MapData, dom: HTMLElement) {
    window.addEventListener('keydown', (e) => this.keys.add(e.code))
    window.addEventListener('keyup', (e) => this.keys.delete(e.code))
    window.addEventListener('blur', () => this.keys.clear())
    dom.addEventListener('pointerdown', (e) => { this.drag = true; this.lx = e.clientX; this.ly = e.clientY; this.touches++ })
    window.addEventListener('pointerup', () => { this.drag = false; this.touches = Math.max(0, this.touches - 1) })
    window.addEventListener('pointercancel', () => { this.drag = false; this.touches = 0 })
    window.addEventListener('pointermove', (e) => {
      if (!this.drag) return
      this.look(e.clientX - this.lx, e.clientY - this.ly)
      this.lx = e.clientX; this.ly = e.clientY
    })
    dom.addEventListener('wheel', (e) => { this.speed = THREE.MathUtils.clamp(this.speed * (e.deltaY > 0 ? 0.85 : 1.18), 2, 600) }, { passive: true })
  }

  private look(dx: number, dy: number): void {
    this.yaw -= dx * 0.0035
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0035, -1.5, 1.5)
  }

  place(x: number, z: number, agl: number, yaw: number, pitch: number): void {
    this.camera.position.set(x, this.map.height(x, z) + agl, z)
    this.yaw = yaw
    this.pitch = pitch
    this.apply()
  }

  update(dt: number): void {
    const k = this.keys, p = this.camera.position
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw)
    const v = this.speed * (k.has('ShiftLeft') || k.has('ShiftRight') ? 5 : 1) * dt
    let mx = 0, mz = 0, my = 0
    if (k.has('KeyW') || k.has('ArrowUp') || this.touches >= 2) { mx += fx; mz += fz }
    if (k.has('KeyS') || k.has('ArrowDown')) { mx -= fx; mz -= fz }
    if (k.has('KeyA') || k.has('ArrowLeft')) { mx += fz; mz -= fx }
    if (k.has('KeyD') || k.has('ArrowRight')) { mx -= fz; mz += fx }
    if (k.has('Space')) my += 1
    if (k.has('KeyC')) my -= 1
    // forward follows the pitch (fly where you look)
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch)
    const fwd = k.has('KeyW') || k.has('ArrowUp') ? 1 : k.has('KeyS') || k.has('ArrowDown') ? -1 : 0
    p.x += mx * v * (fwd ? cp : 1)
    p.z += mz * v * (fwd ? cp : 1)
    p.y += my * v + fwd * sp * v
    const floor = this.map.height(p.x, p.z) + 1.7
    if (p.y < floor) p.y = floor
    this.apply()
  }

  private apply(): void {
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ')
    this.camera.updateMatrixWorld()
  }
}
