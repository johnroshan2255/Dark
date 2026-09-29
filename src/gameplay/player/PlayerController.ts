import type RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import type { Input } from '../../input/Input'
import { group, Groups, type PhysicsWorld } from '../../physics/PhysicsWorld'

const HALF_HEIGHT = 0.55
const RADIUS = 0.35
/** Capsule centre above feet. */
const CENTER = HALF_HEIGHT + RADIUS
export const EYE_HEIGHT = 1.62

const WALK = 3.6
const SPRINT = 6.5
const JUMP = 6.2
const GRAVITY = -20
const ACCEL = 12

/**
 * First-person character on Rapier's KinematicCharacterController.
 * Simulated in the fixed step; rendering reads the interpolated `renderPosition`.
 * No React state is touched per frame.
 */
export class PlayerController {
  yaw = 0
  pitch = 0
  sensitivity = 0.0022
  /** Feet position at the previous / current fixed step. */
  readonly prev = new THREE.Vector3()
  readonly curr = new THREE.Vector3()
  readonly renderPosition = new THREE.Vector3()
  readonly velocity = new THREE.Vector3()
  grounded = false
  /** Frozen until colliders exist under the player (streaming not ready). */
  frozen = true
  /** Seconds of lost control after being hit/thrown (no movement input). */
  stunned = 0
  /** 0..1 knocked-down amount (camera + character fall to the ground while > 0). */
  knock = 0
  /** Dead: no input at all. */
  dead = false
  /** Riding state, written by Bike from its simulation (gameplay/vehicle/VehicleSim BikeSim). While riding the
   *  player is carried like in the truck (`inVehicle`): collider off, teleported onto the saddle each step. */
  readonly ride = { riding: false, heading: 0, speed: 0, steer: 0, travelled: 0 }
  /** Inside a car: the car moves this body (collider disabled); no own movement. */
  inVehicle = false
  /** Seconds since the last mouse / touch look input (bike camera auto-follow). */
  lookIdle = 99

  private readonly body: RAPIER.RigidBody
  readonly collider: RAPIER.Collider
  private readonly controller: RAPIER.KinematicCharacterController
  private readonly mouse = { x: 0, y: 0 }
  private readonly wish = new THREE.Vector3()
  private jumpQueued = false

  constructor(
    physics: PhysicsWorld,
    private readonly input: Input,
    spawn: THREE.Vector3,
  ) {
    const R = physics.R
    this.body = physics.world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y + CENTER, spawn.z),
    )
    this.collider = physics.world.createCollider(
      R.ColliderDesc.capsule(HALF_HEIGHT, RADIUS).setCollisionGroups(group(Groups.Player, 0xffff & ~Groups.Player)),
      this.body,
    )
    const c = physics.world.createCharacterController(0.02)
    c.setUp({ x: 0, y: 1, z: 0 })
    c.enableAutostep(0.45, 0.25, true)
    c.enableSnapToGround(0.45)
    // Hills must be climbable (up to 62°); only near-cliffs make you slide.
    c.setMaxSlopeClimbAngle((62 * Math.PI) / 180)
    c.setMinSlopeSlideAngle((68 * Math.PI) / 180)
    c.setApplyImpulsesToDynamicBodies(true)
    this.controller = c
    this.curr.copy(spawn)
    this.prev.copy(spawn)
    this.renderPosition.copy(spawn)
    input.onPress('Space', () => (this.jumpQueued = true))
  }

  /** Per render frame: mouse look (not tied to the fixed step, so it stays responsive). */
  look(): void {
    this.input.consumeMouse(this.mouse)
    this.lookIdle = this.mouse.x !== 0 || this.mouse.y !== 0 ? 0 : this.lookIdle + 1 / 60
    this.yaw -= this.mouse.x * this.sensitivity
    this.pitch = THREE.MathUtils.clamp(this.pitch - this.mouse.y * this.sensitivity, -1.45, 1.45)
  }

  /** Hit reaction: velocity kick and `stun` seconds without control; stun ≥ 1 s knocks the player down. */
  applyImpulse(vx: number, vy: number, vz: number, stun: number): void {
    this.velocity.x += vx
    this.velocity.z += vz
    this.velocity.y = Math.max(this.velocity.y, vy)
    this.stunned = Math.max(this.stunned, stun)
    if (stun >= 1) this.knockTarget = 1
  }

  private knockTarget = 0

  fixedUpdate(dt: number): void {
    this.prev.copy(this.curr)
    if (this.frozen || this.inVehicle) return
    // Knockdown: fall fast, get up slowly once the stun ends.
    if (this.stunned <= 0.4 && !this.dead) this.knockTarget = 0
    if (this.dead) this.knockTarget = 1
    this.knock += (this.knockTarget - this.knock) * Math.min(1, dt * (this.knockTarget > this.knock ? 9 : 2.2))
    const locked = this.stunned > 0 || this.dead
    this.stunned = Math.max(0, this.stunned - dt)
    const i = this.input
    const fwd = locked ? 0 : (i.down('KeyW') ? 1 : 0) - (i.down('KeyS') ? 1 : 0) + i.touchMove.y
    const strafe = locked ? 0 : (i.down('KeyD') ? 1 : 0) - (i.down('KeyA') ? 1 : 0) + i.touchMove.x
    // Touch: full joystick deflection sprints (no separate sprint button needed).
    const stick = Math.hypot(i.touchMove.x, i.touchMove.y)
    const speed = i.down('ShiftLeft') || stick > 0.92 ? SPRINT : WALK
    const sy = Math.sin(this.yaw)
    const cy = Math.cos(this.yaw)
    this.wish.set(strafe * cy - fwd * sy, 0, -strafe * sy - fwd * cy)
    if (this.wish.lengthSq() > 1) this.wish.normalize()
    this.wish.multiplyScalar(speed)

    const k = 1 - Math.exp(-(locked ? 2.5 : ACCEL) * dt) // thrown players slide to a stop
    this.velocity.x += (this.wish.x - this.velocity.x) * k
    this.velocity.z += (this.wish.z - this.velocity.z) * k
    if (this.grounded && this.velocity.y <= 0.5) {
      this.velocity.y = this.jumpQueued && !locked ? JUMP : Math.max(this.velocity.y, -2)
    }
    this.jumpQueued = false
    this.velocity.y += GRAVITY * dt

    this.controller.computeColliderMovement(this.collider, {
      x: this.velocity.x * dt,
      y: this.velocity.y * dt,
      z: this.velocity.z * dt,
    })
    const mv = this.controller.computedMovement()
    this.grounded = this.controller.computedGrounded()
    if (this.grounded && this.velocity.y < 0) this.velocity.y = 0
    const t = this.body.translation()
    this.body.setNextKinematicTranslation({ x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z })
    this.curr.set(t.x + mv.x, t.y + mv.y - CENTER, t.z + mv.z)
  }

  /** Called after physics.advance with its interpolation alpha. */
  interpolate(alpha: number): void {
    this.renderPosition.lerpVectors(this.prev, this.curr, alpha)
  }

  /** Carried by a vehicle (collider disabled): move without breaking render interpolation (prev stays). */
  carryTo(p: THREE.Vector3): void {
    this.body.setTranslation({ x: p.x, y: p.y + CENTER, z: p.z }, true)
    this.curr.copy(p)
    this.velocity.set(0, 0, 0)
  }

  teleport(p: THREE.Vector3): void {
    this.body.setTranslation({ x: p.x, y: p.y + CENTER, z: p.z }, true)
    this.curr.copy(p)
    this.prev.copy(p)
    this.velocity.set(0, 0, 0)
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z)
  }
}
