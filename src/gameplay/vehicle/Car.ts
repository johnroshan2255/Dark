import type RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { group, Groups, type PhysicsWorld } from '../../physics/PhysicsWorld'
import type { Input } from '../../input/Input'
import type { WorldFields } from '../../world/WorldFields'
import type { CharacterModel } from '../player/CharacterModel'
import type { PlayerController } from '../player/PlayerController'
import type { TruckModel } from '../../assets/loadModels'
import { stylize } from '../../rendering/shaders/stylize'

/**
 * PICKUP TRUCK (assets/loadModels: Sketchfab "Pickup Truck", CC-BY-4.0). E within 4 m to drive, E to get out.
 *   W throttle · S brake, then reverse · A/D steer · Shift boost · Space handbrake (touch: stick = W/S + A/D).
 * Own Rapier kinematic body: a BOX collider rotated with the heading and pitched to the slope, moved by a
 * character controller (blocked by trees/rocks/poles/buildings, climbs slopes up to 72°, steps over ~0.5 m).
 * Strong low-speed torque vs a gentle slope penalty → every hill that isn't a cliff is drivable.
 * Visuals: body sits on its four wheels (per-wheel ground sampling → pitch, roll, suspension travel);
 * wheels spin with distance and the FRONT wheels steer left/right with A/D.
 * Draws: body + 4 wheels (textured Lambert, both instanced → ONE program, 2 draws) + glass (shared vertex-colour
 * program, hidden in first person so you can see out).
 */
export const SEATS: [number, number, number][] = [[-0.38, 0.9, 0.3], [0.38, 0.9, 0.3], [-0.38, 0.9, 1.0], [0.38, 0.9, 1.0]]
const CLEARANCE = 0.38
/**
 * Measured on generated terrain (harness, trees removed): with a 60° limit the truck stalled on 49°+ hills —
 * a 50° hillside has local patches steeper than 60°. 72° climbs every hill (49° → 47 m, 53° → 54 m, see
 * skills/physics); the slope penalty still slows it on the steepest ones. Pitching the collider is essential.
 */
const MAX_CLIMB = (72 * Math.PI) / 180

export class Car {
  readonly root = new THREE.Group()
  private readonly body = new THREE.Group()
  private readonly wheels: THREE.InstancedMesh
  private readonly wheelPos: [number, number, number][]
  private readonly wheelR: number
  private readonly wheelbase: number
  private readonly track: number
  private readonly bodyMat: THREE.MeshLambertMaterial
  private readonly glassMesh: THREE.Mesh
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
  private lift = 0
  private readonly susp = [0, 0, 0, 0]
  driving = false
  near = false
  /** Third-person view (set by Game): the tinted glass is opaque, so first person hides it to see out. */
  showDriver = false

  constructor(
    glassMaterial: THREE.Material,
    truck: TruckModel,
    physics: PhysicsWorld,
    private readonly fields: WorldFields,
    private readonly player: PlayerController,
    private readonly character: CharacterModel,
    private readonly input: Input,
  ) {
    this.root.name = 'car'
    this.root.add(this.body)
    this.bodyMat = stylize(new THREE.MeshLambertMaterial({ map: truck.map }), { key: 'truck', rim: 0.45 })
    this.bodyMat.name = 'lib/truck'
    // Body as a 1-instance InstancedMesh: it then shares the wheels' (instanced) program → 1 truck program, not 2.
    const bodyMesh = new THREE.InstancedMesh(truck.body, this.bodyMat, 1)
    bodyMesh.setMatrixAt(0, new THREE.Matrix4())
    bodyMesh.frustumCulled = false
    const glassMesh = (this.glassMesh = new THREE.Mesh(truck.glass, glassMaterial))
    for (const m of [bodyMesh, glassMesh]) (m.castShadow = true), this.body.add(m)
    this.wheelPos = truck.wheelPos
    this.wheelR = truck.wheelRadius
    this.wheelbase = Math.abs(truck.wheelPos[2][2] - truck.wheelPos[0][2])
    this.track = Math.abs(truck.wheelPos[1][0] - truck.wheelPos[0][0])
    this.wheels = new THREE.InstancedMesh(truck.wheel, this.bodyMat, 4)
    this.wheels.castShadow = true
    this.wheels.frustumCulled = false // instances move with the body; the truck is one small object
    this.body.add(this.wheels)

    const R = physics.R
    const h = truck.half
    const hy = (h.y * 2 - CLEARANCE) / 2 * 0.8
    this.rb = physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased())
    this.collider = physics.world.createCollider(
      R.ColliderDesc.cuboid(h.x * 0.92, hy, h.z * 0.94).setTranslation(0, CLEARANCE + hy, 0).setCollisionGroups(group(Groups.Vehicle, 0xffff & ~Groups.Player)),
      this.rb,
    )
    const c = physics.world.createCharacterController(0.05)
    c.setUp({ x: 0, y: 1, z: 0 })
    c.enableAutostep(0.5, 0.3, true)
    c.enableSnapToGround(1.0)
    c.setMaxSlopeClimbAngle(MAX_CLIMB)
    c.setMinSlopeSlideAngle(MAX_CLIMB + (5 * Math.PI) / 180)
    this.ctl = c
  }

  set castShadow(v: boolean) {
    this.root.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).castShadow = v) : 0))
  }

  /** LOW tier: a smaller texture copy (GPU memory). */
  setMap(map: THREE.Texture): void {
    if (this.bodyMat.map === map) return
    this.bodyMat.map = map
    this.bodyMat.needsUpdate = true
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
      // Climb out of the driver's door (left side).
      const c = Math.cos(this.heading), s = Math.sin(this.heading)
      const x = this.pos.x - c * (this.track * 0.5 + 1.2), z = this.pos.z + s * (this.track * 0.5 + 1.2)
      p.collider.setEnabled(true)
      p.inVehicle = false
      p.teleport(new THREE.Vector3(x, this.fields.height(x, z) + 0.2, z))
      this.character.root.visible = true
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
    const handbrake = drive && i.down('Space')
    // Steering: quick to turn in, self-centres; less lock at speed (stable on fast roads).
    this.steer += (st - this.steer) * Math.min(1, dt * (st === 0 ? 6 : 4))
    const max = i.down('ShiftLeft') && drive ? 26 : 18
    if (handbrake) this.speed *= Math.exp(-3.5 * dt)
    else if (thr > 0) {
      // Torque curve: strong pull from standstill (hills), easing off toward top speed.
      if (this.speed < 0) this.speed = Math.min(0, this.speed + 14 * dt)
      else this.speed += (max * thr - this.speed) * (1 - Math.exp(-0.75 * dt)) + 3.2 * thr * dt * (1 - this.speed / max)
    } else if (thr < 0) this.speed = this.speed > 0.5 ? this.speed - 16 * dt : Math.max(-7, this.speed - 6 * dt)
    else this.speed *= Math.exp(-(drive ? 0.3 : 3) * dt)
    // Bicycle-model turning (reverse turns the other way, like a real car); reduced at high speed.
    const lock = 0.6 / (1 + Math.abs(this.speed) * 0.035)
    const turn = (Math.tan(this.steer * lock) * this.speed) / this.wheelbase
    this.heading -= turn * dt
    this.vy = this.ctlGrounded ? Math.max(this.vy, -2) : this.vy - 20 * dt
    const want = { x: -Math.sin(this.heading) * this.speed * dt, y: this.vy * dt, z: -Math.cos(this.heading) * this.speed * dt }
    // Collider follows heading + ground pitch, so the box lies on slopes instead of hanging off the crest.
    _q.setFromEuler(_e.set(this.pitch, this.heading, 0, 'YXZ'))
    this.rb.setRotation(_q, true)
    this.ctl.computeColliderMovement(this.collider, want, undefined, undefined, (col) => col !== this.player.collider)
    const mv = this.ctl.computedMovement()
    this.ctlGrounded = this.ctl.computedGrounded()
    if (this.ctlGrounded && this.vy < 0) this.vy = 0
    const w = Math.hypot(want.x, want.z)
    const got = Math.hypot(mv.x, mv.y, mv.z)
    if (w > 1e-3 && got / w < 0.35) this.speed *= Math.max(got / w, 0.2) // hit something solid
    const horiz = Math.hypot(mv.x, mv.z)
    if (horiz > 1e-4) this.speed -= (mv.y / horiz) * 3.6 * dt * Math.sign(this.speed) // gravity along the slope
    this.travelled += got * Math.sign(this.speed)
    const t = this.rb.translation()
    this.pos.set(t.x + mv.x, t.y + mv.y, t.z + mv.z)
    // Streaming guard: never fall below the analytic ground (terrain collider not built yet at speed).
    const ground = this.fields.height(this.pos.x, this.pos.z)
    if (this.pos.y < ground - 0.4) {
      this.pos.y = ground
      this.vy = 0
      this.ctlGrounded = true
    }
    this.rb.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y, z: this.pos.z })
    this.rb.setNextKinematicRotation(_q)
    if (this.driving) this.player.teleport(this.seatWorld(0)) // streaming, grass, monsters follow the truck
  }
  private ctlGrounded = false

  /**
   * Feet position such that the FPP eye (feet + 1.62 m) sits at the driver's head: the head point goes through
   * the body's full transform (heading, pitch, roll, lift) so the view stays inside the cab on any slope.
   */
  seatWorld(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    const [sx, sy, sz] = SEATS[i]
    _m.makeRotationFromEuler(_e.set(this.pitch, this.heading, this.roll, 'YXZ'))
    out.set(sx, sy + 0.66, sz).applyMatrix4(_m)
    return out.set(this.pos.x + out.x, this.pos.y + this.lift + out.y - 1.62, this.pos.z + out.z)
  }

  /** Render frame: interpolate, sit the body on its wheels, spin + steer the wheels, headlights. */
  update(dt: number, alpha: number, flashOrigin: THREE.Vector3, flashTarget: THREE.Vector3): void {
    const p = this.player
    this.renderPos.lerpVectors(this.prev, this.pos, alpha)
    this.near = !this.driving && Math.hypot(p.curr.x - this.pos.x, p.curr.z - this.pos.z) < 4
    // Ground under each wheel → body pitch, roll, height; the rest becomes per-wheel suspension travel.
    const f = this.fields
    const c = Math.cos(this.heading), s = Math.sin(this.heading)
    const g = this.wheelPos.map(([x, , z]) => f.height(this.renderPos.x + x * c + z * s, this.renderPos.z - x * s + z * c))
    const front = (g[0] + g[1]) / 2, rear = (g[2] + g[3]) / 2, left = (g[0] + g[2]) / 2, right = (g[1] + g[3]) / 2
    const k = Math.min(1, dt * 10)
    this.pitch += (Math.atan2(front - rear, this.wheelbase) - this.pitch) * k
    this.roll += (Math.atan2(right - left, this.track) - this.roll) * k
    // Sit on the wheels when on terrain (the flat collider can hang above a crest); trust physics otherwise.
    const avg = (g[0] + g[1] + g[2] + g[3]) / 4
    const targetLift = Math.abs(avg - this.renderPos.y) < 1.2 ? avg - this.renderPos.y : 0
    this.lift += (targetLift - this.lift) * k
    this.root.position.set(this.renderPos.x, this.renderPos.y + this.lift, this.renderPos.z)
    this.root.rotation.set(this.pitch, this.heading, this.roll, 'YXZ') // right side higher → +Z roll lifts +X
    // Suspension: what the body plane doesn't absorb, each wheel does (±12 cm).
    const plane = [front + (left - right) / 2 - avg, front - (left - right) / 2 - avg, rear + (left - right) / 2 - avg, rear - (left - right) / 2 - avg]
    const spin = -this.travelled / this.wheelR
    this.wheelPos.forEach(([x, y, z], i) => {
      this.susp[i] += (THREE.MathUtils.clamp(g[i] - avg - plane[i], -0.12, 0.12) - this.susp[i]) * k
      const rightSide = i === 1 || i === 3
      // Right wheels = the left wheel turned 180° (rim faces out); their spin reverses accordingly.
      _e.set(rightSide ? -spin : spin, (rightSide ? Math.PI : 0) + (i < 2 ? -this.steer * 0.6 : 0), 0, 'YXZ')
      _m.compose(_v.set(x, y + this.susp[i], z), _q.setFromEuler(_e), _one)
      this.wheels.setMatrixAt(i, _m)
    })
    this.wheels.instanceMatrix.needsUpdate = true
    this.root.updateMatrixWorld()
    this.glassMesh.visible = !this.driving || this.showDriver
    if (this.driving) {
      this.character.root.visible = false // inside the cab (opaque glass)
      if (p.lookIdle > 0.6) {
        let d = this.heading - p.yaw
        d = Math.atan2(Math.sin(d), Math.cos(d))
        p.yaw += d * Math.min(1, dt * 3)
      }
      // Flashlight becomes the headlights.
      flashOrigin.set(0, 0.95, -2.6).applyMatrix4(this.root.matrixWorld)
      flashTarget.set(0, 0, -28).applyMatrix4(this.root.matrixWorld)
    }
  }

  dispose(): void {
    this.wheels.dispose()
    this.bodyMat.dispose()
  }
}

const _e = new THREE.Euler()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _v = new THREE.Vector3()
const _one = new THREE.Vector3(1, 1, 1)
