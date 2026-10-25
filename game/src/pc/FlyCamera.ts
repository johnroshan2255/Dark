import * as pc from 'playcanvas'

/**
 * A free FLY camera for the PlayCanvas milestones: WASD / arrows to move (Shift faster, Q / E down / up), the mouse to
 * look (click to lock the pointer); on touch, one finger drags to look and a second finger held down flies forward.
 */
export class FlyCamera {
  private yaw = 0
  private pitch = -8
  private readonly pos = new pc.Vec3()
  private touches = 0
  private lastTouch: { x: number; y: number } | null = null

  constructor(private readonly app: pc.AppBase, private readonly cam: pc.Entity, canvas: HTMLCanvasElement) {
    canvas.addEventListener('click', () => {
      if (!('ontouchstart' in window)) canvas.requestPointerLock?.()
    })
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return
      this.yaw -= e.movementX * 0.12
      this.pitch = Math.max(-89, Math.min(89, this.pitch - e.movementY * 0.12))
    })
    canvas.addEventListener('touchstart', (e) => {
      this.touches = e.touches.length
      this.lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    }, { passive: true })
    canvas.addEventListener('touchmove', (e) => {
      const t = e.touches[0]
      if (this.lastTouch) {
        this.yaw -= (t.clientX - this.lastTouch.x) * 0.25
        this.pitch = Math.max(-89, Math.min(89, this.pitch - (t.clientY - this.lastTouch.y) * 0.25))
      }
      this.lastTouch = { x: t.clientX, y: t.clientY }
    }, { passive: true })
    canvas.addEventListener('touchend', (e) => {
      this.touches = e.touches.length
      if (!e.touches.length) this.lastTouch = null
    }, { passive: true })
  }

  place(x: number, y: number, z: number): void {
    this.pos.set(x, y, z)
  }

  update(dt: number): void {
    const k = this.app.keyboard!
    const fast = k.isPressed(pc.KEY_SHIFT) ? 40 : 12
    const f = this.cam.forward, r = this.cam.right
    const move = new pc.Vec3()
    if (k.isPressed(pc.KEY_W) || k.isPressed(pc.KEY_UP) || this.touches >= 2) move.add(f)
    if (k.isPressed(pc.KEY_S) || k.isPressed(pc.KEY_DOWN)) move.sub(f)
    if (k.isPressed(pc.KEY_D) || k.isPressed(pc.KEY_RIGHT)) move.add(r)
    if (k.isPressed(pc.KEY_A) || k.isPressed(pc.KEY_LEFT)) move.sub(r)
    if (k.isPressed(pc.KEY_E)) move.y += 1
    if (k.isPressed(pc.KEY_Q)) move.y -= 1
    if (move.lengthSq() > 0) this.pos.add(move.normalize().mulScalar(fast * dt))
    this.cam.setPosition(this.pos)
    this.cam.setEulerAngles(this.pitch, this.yaw, 0)
  }
}
