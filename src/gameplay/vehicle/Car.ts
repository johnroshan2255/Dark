import type RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { group, Groups, type PhysicsWorld } from '../../physics/PhysicsWorld'
import type { Input } from '../../input/Input'
import type { WorldFields } from '../../world/WorldFields'
import type { CharacterModel } from '../player/CharacterModel'
import type { PlayerController } from '../player/PlayerController'

/**
 * 4-seat car (a cute rounded Genshin-style SUV). Own Rapier kinematic body + BOX collider driven by its own
 * character controller (so it can't squeeze between trees; climbs slopes up to 40°). E within 3.5 m to drive,
 * E again to get out. W/S throttle / brake-reverse, A/D steer, Shift boost. Body pitches/rolls to the ground,
 * wheels spin and steer. SEATS holds 4 local seat positions (driver + 3 passengers, for co-op).
 */
const srgb = (h: number) => new THREE.Color().setHex(h, THREE.SRGBColorSpace)
const HALF = { x: 0.95, y: 0.6, z: 2.1 }
const WHEEL_R = 0.4
const WHEELBASE = 2.7
export const SEATS: [number, number, number][] = [[-0.42, 0.75, -0.1], [0.42, 0.75, -0.1], [-0.42, 0.75, 0.85], [0.42, 0.75, 0.85]]

function col(g: THREE.BufferGeometry, hex: number, k = 1): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g
  if (n !== g) g.dispose()
  n.deleteAttribute('uv')
  const c = srgb(hex).multiplyScalar(k)
  const a = new Float32Array(n.getAttribute('position').count * 3)
  for (let i = 0; i < a.length; i += 3) c.toArray(a, i)
  n.setAttribute('color', new THREE.BufferAttribute(a, 3))
  return n
}
const box = (w: number, h: number, d: number, hex: number, x: number, y: number, z: number, k = 1) => col(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex, k)

export class Car {
  readonly root = new THREE.Group()
  private readonly body = new THREE.Group()
  /** All 4 wheels in ONE instanced draw (spin/steer written into the instance matrices each frame). */
  private readonly wheels: THREE.InstancedMesh
  private static readonly WHEEL_POS = [[-0.88, -1.35], [0.88, -1.35], [-0.88, 1.35], [0.88, 1.35]] as const
  private readonly geos: THREE.BufferGeometry[] = []
  private readonly rb: RAPIER.RigidBody
  private readonly collider: RAPIER.Collider
  private readonly ctl: RAPIER.KinematicCharacterController
  readonly pos = new THREE.Vector3()
  private readonly prev = new THREE.Vector3()
  readonly renderPos = new THREE.Vector3()
  heading = 0
  speed = 0
  private steer = 0
  private vy = 0
  private travelled = 0
  private pitch = 0
  private roll = 0
  driving = false
  near = false
  /** Show the seated driver (third-person view only). */
  showDriver = true

  constructor(
    material: THREE.Material,
    physics: PhysicsWorld,
    private readonly fields: WorldFields,
    private readonly player: PlayerController,
    private readonly character: CharacterModel,
    private readonly input: Input,
    paint = 0x3aa6b8,
  ) {
    this.root.name = 'car'
    this.root.add(this.body)
    const shell = mergeGeometries([
      box(1.86, 0.7, 4.1, paint, 0, 0.75, 0),
      box(1.7, 0.18, 3.9, paint, 0, 1.18, 0, 1.08), // shoulder line
      box(1.6, 0.75, 2.2, paint, 0, 1.62, 0.25, 1.12), // cabin
      box(1.64, 0.55, 2.0, 0x243548, 0, 1.64, 0.25), // window band
      box(1.5, 0.08, 2.1, 0xf2f0e8, 0, 2.03, 0.25), // white roof
      box(1.9, 0.22, 0.25, 0x5a5e66, 0, 0.5, -2.05), box(1.9, 0.22, 0.25, 0x5a5e66, 0, 0.5, 2.05), // bumpers
      box(0.36, 0.2, 0.08, 0xfff4c8, -0.62, 0.9, -2.06, 2.2), box(0.36, 0.2, 0.08, 0xfff4c8, 0.62, 0.9, -2.06, 2.2), // headlights (bright)
      box(0.3, 0.16, 0.08, 0xff3a2a, -0.66, 0.9, 2.06, 1.6), box(0.3, 0.16, 0.08, 0xff3a2a, 0.66, 0.9, 2.06, 1.6), // tail lights
      box(1.2, 0.14, 0.8, 0x2a2a2a, 0, 2.12, 0.3), // roof rack
    ])!
    this.geos.push(shell)
    const shellMesh = new THREE.Mesh(shell, material)
    shellMesh.castShadow = true
    this.body.add(shellMesh)
    const wg = mergeGeometries([
      col(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.3, 14).rotateZ(Math.PI / 2), 0x1d1d20),
      col(new THREE.CylinderGeometry(WHEEL_R * 0.55, WHEEL_R * 0.55, 0.32, 8).rotateZ(Math.PI / 2), 0xc8c8cc),
    ])!
    this.geos.push(wg)
    this.wheels = new THREE.InstancedMesh(wg, material, 4)
    this.wheels.castShadow = true
    this.wheels.frustumCulled = false // instances move with the body; the car is one small object
    this.body.add(this.wheels)
    const R = physics.R
    this.rb = physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased())
    this.collider = physics.world.createCollider(
      R.ColliderDesc.cuboid(HALF.x, HALF.y, HALF.z).setTranslation(0, HALF.y + 0.25, 0).setCollisionGroups(group(Groups.Vehicle, 0xffff & ~Groups.Player)),
      this.rb,
    )
    const c = physics.world.createCharacterController(0.05)
    c.setUp({ x: 0, y: 1, z: 0 })
    c.enableAutostep(0.4, 0.3, true)
    c.enableSnapToGround(0.6)
    c.setMaxSlopeClimbAngle((40 * Math.PI) / 180)
    c.setMinSlopeSlideAngle((50 * Math.PI) / 180)
    this.ctl = c
  }

  set castShadow(v: boolean) {
    this.root.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).castShadow = v) : 0))
  }

  park(x: number, z: number, heading: number): void {
    const y = this.fields.height(x, z)
    this.pos.set(x, y, z)
    this.prev.copy(this.pos)
    this.renderPos.copy(this.pos)
    this.heading = heading
    this.rb.setTranslation({ x, y, z }, true)
  }

  toggle(): boolean {
    const p = this.player
    if (this.driving) {
      this.driving = false
      this.speed = 0
      const side = new THREE.Vector3(-Math.cos(this.heading) * 1.8, 0, Math.sin(this.heading) * 1.8)
      const x = this.pos.x + side.x, z = this.pos.z + side.z
      p.collider.setEnabled(true)
      p.inVehicle = false
      p.teleport(new THREE.Vector3(x, this.fields.height(x, z) + 0.2, z))
      return true
    }
    if (!this.near || p.dead || p.ride.riding) return false
    this.driving = true
    p.inVehicle = true
    p.collider.setEnabled(false)
    p.yaw = this.heading
    return true
  }

  /** Fixed step (60 Hz), called inside physics.advance before world.step(). */
  fixedUpdate(dt: number): void {
    this.prev.copy(this.pos)
    const i = this.input
    const drive = this.driving && !this.player.dead
    const thr = drive ? Math.max(-1, Math.min(1, (i.down('KeyW') ? 1 : 0) - (i.down('KeyS') ? 1 : 0) + i.touchMove.y)) : 0
    const st = drive ? Math.max(-1, Math.min(1, (i.down('KeyD') ? 1 : 0) - (i.down('KeyA') ? 1 : 0) + i.touchMove.x)) : 0
    this.steer += (st - this.steer) * Math.min(1, dt * 5)
    const max = i.down('ShiftLeft') && drive ? 24 : 17
    if (thr > 0) this.speed += (max * thr - this.speed) * (1 - Math.exp(-0.55 * dt))
    else if (thr < 0) this.speed = this.speed > 0.5 ? this.speed - 16 * dt : Math.max(-6, this.speed - 5 * dt)
    else this.speed *= Math.exp(-(drive ? 0.25 : 3) * dt)
    // Bicycle-model turning, reduced at high speed for stability.
    const turn = (Math.tan(this.steer * 0.55) * this.speed) / WHEELBASE / (1 + Math.abs(this.speed) * 0.04)
    this.heading -= turn * dt
    this.vy = this.ctlGrounded ? Math.max(this.vy, -2) : this.vy - 20 * dt
    const want = { x: -Math.sin(this.heading) * this.speed * dt, y: this.vy * dt, z: -Math.cos(this.heading) * this.speed * dt }
    this.ctl.computeColliderMovement(this.collider, want, undefined, undefined, (c) => c !== this.player.collider)
    const mv = this.ctl.computedMovement()
    this.ctlGrounded = this.ctl.computedGrounded()
    if (this.ctlGrounded && this.vy < 0) this.vy = 0
    const w = Math.hypot(want.x, want.z)
    const got = Math.hypot(mv.x, mv.y, mv.z)
    if (w > 1e-3 && got / w < 0.4) this.speed *= got / w // crashed into something
    const horiz = Math.hypot(mv.x, mv.z)
    if (horiz > 1e-4) this.speed -= (mv.y / horiz) * 6 * dt * Math.sign(this.speed) // hills slow you down / speed you up
    this.travelled += got * Math.sign(this.speed)
    const t = this.rb.translation()
    this.pos.set(t.x + mv.x, t.y + mv.y, t.z + mv.z)
    // Streaming guard: the terrain collider under the car may not exist yet (spawn, fast driving into a chunk
    // still building) — never sink below the analytic ground, or the car falls out of the world for good.
    const ground = this.fields.height(this.pos.x, this.pos.z)
    if (this.pos.y < ground - 0.15) {
      this.pos.y = ground
      this.vy = 0
      this.ctlGrounded = true
    }
    this.rb.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y, z: this.pos.z })
    if (this.driving) {
      // Keep the (disabled) player body with the car so streaming, grass, monsters follow it.
      const s = this.seatWorld(0)
      this.player.teleport(s)
    }
  }
  private ctlGrounded = false

  seatWorld(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    const [sx, sy, sz] = SEATS[i]
    const c = Math.cos(this.heading), s = Math.sin(this.heading)
    // Feet position such that the seated hips sit on the seat and the FPP eye is below the roof.
    return out.set(this.pos.x + sx * c + sz * s, this.pos.y + sy - 0.96, this.pos.z - sx * s + sz * c)
  }

  /** Render frame: interpolate, orient to the ground, pose the driver, headlights. */
  update(dt: number, alpha: number, flashOrigin: THREE.Vector3, flashTarget: THREE.Vector3): void {
    const p = this.player
    this.renderPos.lerpVectors(this.prev, this.pos, alpha)
    this.near = !this.driving && Math.hypot(p.curr.x - this.pos.x, p.curr.z - this.pos.z) < 3.5
    // Pitch / roll from the terrain under the wheels.
    const f = this.fields
    const fx = -Math.sin(this.heading), fz = -Math.cos(this.heading)
    const rx = Math.cos(this.heading), rz = -Math.sin(this.heading)
    const hf = f.height(this.renderPos.x + fx * 1.4, this.renderPos.z + fz * 1.4)
    const hb = f.height(this.renderPos.x - fx * 1.4, this.renderPos.z - fz * 1.4)
    const hr = f.height(this.renderPos.x + rx * 0.9, this.renderPos.z + rz * 0.9)
    const hl = f.height(this.renderPos.x - rx * 0.9, this.renderPos.z - rz * 0.9)
    this.pitch += (Math.atan2(hf - hb, 2.8) - this.pitch) * Math.min(1, dt * 8)
    this.roll += (Math.atan2(hr - hl, 1.8) - this.roll) * Math.min(1, dt * 8)
    this.root.position.copy(this.renderPos)
    this.root.rotation.set(this.pitch, this.heading, -this.roll, 'YXZ')
    _e.set(-this.travelled / WHEEL_R, 0, 0, 'YXZ')
    Car.WHEEL_POS.forEach(([x, z], i) => {
      _e.y = i < 2 ? -this.steer * 0.5 : 0
      _m.compose(_v.set(x, WHEEL_R, z), _q.setFromEuler(_e), _one)
      this.wheels.setMatrixAt(i, _m)
    })
    this.wheels.instanceMatrix.needsUpdate = true
    this.root.updateMatrixWorld()
    if (this.driving) {
      // Driver seated (visible through the windows); camera auto-follows the heading.
      const s = this.seatWorld(0)
      this.character.root.visible = this.showDriver
      this.character.ride(s, this.heading, 0, -this.roll * 0.5)
      this.character.root.rotation.x = 0.05
      if (p.lookIdle > 0.6) {
        let d = this.heading - p.yaw
        d = Math.atan2(Math.sin(d), Math.cos(d))
        p.yaw += d * Math.min(1, dt * 3)
      }
      // Flashlight becomes the headlights.
      flashOrigin.set(0, 0.9, -2.2).applyMatrix4(this.root.matrixWorld)
      flashTarget.set(0, 0, -26).applyMatrix4(this.root.matrixWorld)
    }
  }

  dispose(): void {
    this.wheels.dispose()
    this.geos.forEach((g) => g.dispose())
  }
}

const _e = new THREE.Euler()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _v = new THREE.Vector3()
const _one = new THREE.Vector3(1, 1, 1)
