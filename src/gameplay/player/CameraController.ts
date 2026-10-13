import type RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import type { PhysicsWorld } from '../../physics/PhysicsWorld'
import type { WorldFields } from '../../world/WorldFields'
import type { CharacterModel } from './CharacterModel'
import { EYE_HEIGHT, type PlayerController } from './PlayerController'
import type { Car } from '../vehicle/Car'

export type CameraMode = 'fpp' | 'tpp'

const TPP_DISTANCE = 4.4
const TPP_SHOULDER = 0.55
const TPP_PIVOT = 2.3

// SIMULATION DRIVING CAMERA (sim.arcade false; skills/realistic-vehicle-system §8.10) — tunables:
/** Chase lag spring ω (rad/s, critically damped): the camera trails by a/ω² → ≈0.3 m at 5 m/s², 0.6 m braking at 10. */
const CHASE_W = 4
/** Chase lag clamps (m): horizontal, vertical; vertical velocity changes feed it at this share (landings, crests). */
const CHASE_MAX = 0.7
const CHASE_MAX_Y = 0.35
const CHASE_VERT = 0.5
/** Chase yaw in a slide: this share of the slip angle (velocity direction) — 70 % heading / 30 % velocity. */
const CHASE_SLIP = 0.3
/** Recentre rate (1/s) after LOOK_IDLE s without mouse / touch look (the same delay and rate as before). */
const RECENTRE = 3
const LOOK_IDLE = 0.6
/** Share of the chassis pitch (slope) the chase view follows, and its smoothing rate (1/s). */
const SLOPE_FOLLOW = 0.5
const SLOPE_RATE = 3
/** Chase distance grows by this many m per m/s above 5 m/s, up to SPEED_DIST_MAX m. */
const SPEED_DIST = 0.035
const SPEED_DIST_MAX = 1.3
/** First person: head inertia — offset −a·0.004 m per m/s² (≈80 ms response), ≤ 4 cm (3 cm vertical). */
const HEAD_W = 12
const HEAD_GAIN = 0.004 * HEAD_W * HEAD_W
const HEAD_VERT = 0.5
const HEAD_MAX = 0.04
const HEAD_MAX_Y = 0.03
/** A velocity change bigger than this in one frame is a teleport / car swap, not a crash: ignored (m/s). */
const DV_TELEPORT = 40

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

/** Exact critically-damped settle of (x, v) toward 0 over dt — frame-rate independent. Velocity changes of the thing
 *  followed are added to v as impulses by the caller (the lagging point keeps its velocity), so in steady
 *  acceleration a the offset settles at a/ω² and at constant velocity it settles at 0. */
function settle(x: THREE.Vector3, v: THREE.Vector3, w: number, dt: number): void {
  const ex = Math.exp(-w * dt)
  const bx = v.x + w * x.x, by = v.y + w * x.y, bz = v.z + w * x.z
  x.set((x.x + bx * dt) * ex, (x.y + by * dt) * ex, (x.z + bz * dt) * ex)
  v.set((v.x - w * bx * dt) * ex, (v.y - w * by * dt) * ex, (v.z - w * bz * dt) * ex)
}

/**
 * First/third-person camera. TPP: over-the-shoulder orbit around a pivot above the player, pulled in
 * by a Rapier ray cast (terrain + trunks) so it never goes through the world; fast in, slow out.
 * Also decides where the flashlight sits and aims (eye in FPP, hand in TPP → aims at the view centre).
 */
export class CameraController {
  mode: CameraMode = 'fpp'
  /** Vehicle view: farther and higher behind (car). null = on foot / bike. */
  vehicle: { distance: number; pivot: number } | null = null
  /** The car the player is in / climbing into: its chassis never pulls the camera in (the pivot is inside it). */
  ignoreBody: RAPIER.RigidBody | null = null
  /** Garage turntable: orbit this point (the parked car) slowly; the player and look input are ignored. */
  garage: THREE.Vector3 | null = null
  private orbit = 0
  /** Dev / screenshot vista: first-person eye raised this many metres above the player (0 = normal). */
  lift = 0
  readonly flashOrigin = new THREE.Vector3()
  readonly flashTarget = new THREE.Vector3()
  private dist = TPP_DISTANCE
  private bob = 0
  /** 0..1 screen shake, set by hits and lightning. */
  shake = 0
  private readonly fwd = new THREE.Vector3()
  private readonly right = new THREE.Vector3()
  private readonly pivot = new THREE.Vector3()
  private readonly desired = new THREE.Vector3()
  private readonly ray: RAPIER.Ray
  /** The car being driven with Simulation handling (Game sets it every frame), else null: chassis-attached first
   *  person and the weighted chase view. Arcade and on foot use the plain paths below. */
  car: Car | null = null
  private driveOn = false
  private readonly carPos = new THREE.Vector3()
  private readonly carQ = new THREE.Quaternion()
  private readonly carQi = new THREE.Quaternion()
  private readonly look = new THREE.Quaternion()
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ')
  private readonly vel = new THREE.Vector3()
  private readonly lastVel = new THREE.Vector3()
  private readonly dv = new THREE.Vector3()
  private readonly tmp = new THREE.Vector3()
  /** Chase lag (world, m: car − lagging camera anchor) and its rate; FPP head offset (car space, m) and its rate. */
  private readonly lag = new THREE.Vector3()
  private readonly lagV = new THREE.Vector3()
  private readonly head = new THREE.Vector3()
  private readonly headV = new THREE.Vector3()
  private lastHeading = 0
  private slope = 0

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly fields: WorldFields,
    private readonly character: CharacterModel,
    private readonly blob: THREE.Mesh,
  ) {
    this.ray = new physics.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })
  }

  update(dt: number, cam: THREE.PerspectiveCamera, p: PlayerController, flashlightOn: boolean): void {
    if (this.garage) {
      // Turntable: 7 m out, 2.2 m up, a slow lap every ~40 s, looking at the car's roofline.
      this.orbit += dt * 0.16
      const g = this.garage
      const ground = this.fields.surface(g.x + Math.sin(this.orbit) * 7, g.z + Math.cos(this.orbit) * 7)
      cam.position.set(g.x + Math.sin(this.orbit) * 7, Math.max(g.y + 2.2, ground + 1.2), g.z + Math.cos(this.orbit) * 7)
      // Look past the car's left so it sits in the open RIGHT half of the screen (the garage panel is on the left).
      const dx = g.x - cam.position.x, dz = g.z - cam.position.z, l = Math.hypot(dx, dz)
      cam.lookAt(g.x + (dz / l) * 1.7, g.y + 1.0, g.z - (dx / l) * 1.7)
      cam.updateMatrixWorld()
      this.character.root.visible = false
      this.blob.visible = false
      this.flashOrigin.copy(cam.position)
      this.flashTarget.copy(g)
      return
    }
    const pos = p.renderPosition
    const cy = Math.cos(p.yaw)
    const sy = Math.sin(p.yaw)
    const cp = Math.cos(p.pitch)
    this.fwd.set(-sy * cp, Math.sin(p.pitch), -cy * cp)
    this.right.set(cy, 0, -sy)
    const tpp = this.mode === 'tpp'

    // Screen shake (hits, near lightning) decays; knockdown drops the view to the ground and rolls it.
    this.shake = Math.max(0, this.shake - dt * 2.5)
    const sh = this.shake * this.shake
    const shx = (Math.random() - 0.5) * sh * 0.25
    const shy = (Math.random() - 0.5) * sh * 0.25
    const k = p.knock
    const car = this.car
    if (!car) this.driveOn = false
    if (car) this.drive(dt, cam, p, car, tpp, shx, shy, k)
    else if (!tpp) {
      const speed = p.grounded ? p.horizontalSpeed : 0
      this.bob += dt * speed * 1.9
      const bobY = Math.sin(this.bob * 2) * 0.035 * Math.min(1, speed / 3)
      cam.position.set(pos.x, pos.y + EYE_HEIGHT * (1 - k * 0.8) + bobY + this.lift, pos.z)
      cam.rotation.set(p.pitch * (1 - k) + k * 0.25 + shy, p.yaw + shx, k * 1.2, 'YXZ')
      cam.updateMatrixWorld()
      this.flashOrigin.set(0.18, -0.2, 0).applyMatrix4(cam.matrixWorld)
      this.flashTarget.copy(cam.position).addScaledVector(this.fwd, 10)
    } else {
      const vd = this.vehicle
      this.pivot.set(pos.x, pos.y + (vd ? vd.pivot : TPP_PIVOT), pos.z).addScaledVector(this.right, vd ? 0 : TPP_SHOULDER * 0.35)
      this.desired.copy(this.pivot).addScaledVector(this.fwd, -(vd ? vd.distance : TPP_DISTANCE)).addScaledVector(this.right, vd ? 0 : TPP_SHOULDER * 0.65)
      this.placeOrbit(dt, cam, p)
      cam.rotation.set(p.pitch + shy, p.yaw + shx, k * 0.15, 'YXZ')
      cam.updateMatrixWorld()
    }

    // Character: visible in TPP only. Faces the view when aiming the flashlight, else the move direction.
    this.character.root.visible = tpp
    // In / getting into a car the body is posed by the car (Car.updateEntry, after this); the bike re-poses it itself.
    const inCar = p.inVehicle && !p.ride.riding
    this.blob.visible = tpp && this.blob.userData.enabled !== false && !inCar
    if (tpp && !inCar) {
      const moving = p.horizontalSpeed > 0.4
      const targetYaw = flashlightOn || !moving ? (flashlightOn ? p.yaw : this.character.yaw) : Math.atan2(-p.velocity.x, -p.velocity.z)
      this.character.animate(dt, pos, targetYaw, p.horizontalSpeed, p.grounded, flashlightOn, p.pitch, p.velocity.y, k, p.tumbling ? { angle: p.tumble, yaw: p.tumbleYaw } : null) // knockdown / bail tumble / get-up posed inside
      this.blob.position.set(pos.x, this.physics.groundBelow(pos.x, pos.z, pos.y + 0.6, this.fields.surface(pos.x, pos.z)) + 0.03, pos.z)
      this.character.handPosition(this.flashOrigin)
      this.flashTarget.copy(cam.position).addScaledVector(this.fwd, 28)
    }
  }

  /** Third person: camera on the ray pivot → desired, pulled in on collision (fast in, slow out), above the ground. */
  private placeOrbit(dt: number, cam: THREE.PerspectiveCamera, p: PlayerController): void {
    // Pull in on collision (exclude the player's own capsule).
    const dx = this.desired.x - this.pivot.x
    const dy = this.desired.y - this.pivot.y
    const dz = this.desired.z - this.pivot.z
    const len = Math.hypot(dx, dy, dz)
    this.ray.origin = { x: this.pivot.x, y: this.pivot.y, z: this.pivot.z }
    this.ray.dir = { x: dx / len, y: dy / len, z: dz / len }
    const hit = this.physics.world.castRay(this.ray, len, true, undefined, undefined, p.collider, this.ignoreBody ?? undefined)
    const target = hit ? Math.max(0.35, hit.timeOfImpact - 0.3) : len
    // (named `pull`, NOT `k`: shadowing the knockdown amount made the camera roll ~0.5° and wobble every frame)
    const pull = target < this.dist ? 1 - Math.exp(-30 * dt) : 1 - Math.exp(-4 * dt)
    this.dist += (target - this.dist) * pull
    const t = this.dist / len
    cam.position.set(this.pivot.x + dx * t, this.pivot.y + dy * t, this.pivot.z + dz * t)
    const ground = this.fields.surface(cam.position.x, cam.position.z) + 0.3
    if (cam.position.y < ground) cam.position.y = ground
  }

  /**
   * Driving with Simulation handling — the camera shows the physics. Reads only the rendered (interpolated) chassis
   * pose (Car.renderPose, the same one Car.update draws after this) and the body's velocity; velocity changes
   * between frames are the chassis acceleration (as impulses into critically-damped springs, frame-rate independent).
   *  FPP: the eye is fixed in the cab (car space) and the view takes the chassis's pitch and roll — bumps, body
   *   roll, nose dive, slopes; mouse / touch look is relative to the car (carried with it as it turns) and recentres
   *   on the bonnet after LOOK_IDLE s. The head sways −a·0.004 m per m/s² (≤ 4 cm), spring-damped.
   *  TPP chase: trails the car on a spring (a/ω²: drops back under acceleration, closes in under braking, swings wide
   *   in a corner), recentres to 70 % heading / 30 % velocity direction (a slide is seen from the side), follows
   *   half the slope, and backs off a little with speed. Collision pull-in as on foot.
   * CPU: ~30 flops + 1 trig set + the TPP ray cast (as before) per frame; no allocations.
   */
  private drive(dt: number, cam: THREE.PerspectiveCamera, p: PlayerController, car: Car, tpp: boolean, shx: number, shy: number, k: number): void {
    car.renderPose(this.physics.alpha, this.carPos, this.carQ)
    car.velocity(this.vel)
    const f = this.tmp.set(0, 0, -1).applyQuaternion(this.carQ)
    const flat = Math.hypot(f.x, f.z)
    // (on its roof / nose the heading is undefined: keep the last one)
    const heading = flat > 0.2 ? Math.atan2(-f.x, -f.z) : this.driveOn ? this.lastHeading : p.yaw
    const chassisPitch = Math.atan2(f.y, flat)
    if (!this.driveOn) {
      this.driveOn = true
      this.lastVel.copy(this.vel)
      this.lag.set(0, 0, 0)
      this.lagV.set(0, 0, 0)
      this.head.set(0, 0, 0)
      this.headV.set(0, 0, 0)
      this.lastHeading = heading
      this.slope = chassisPitch * SLOPE_FOLLOW
    }
    const dv = this.dv.subVectors(this.vel, this.lastVel)
    this.lastVel.copy(this.vel)
    if (dv.lengthSq() > DV_TELEPORT * DV_TELEPORT) dv.set(0, 0, 0)
    const centre = p.lookIdle > LOOK_IDLE ? 1 - Math.exp(-RECENTRE * dt) : 0

    if (!tpp) {
      // The look turns with the car, then (idle) eases back to straight ahead.
      p.yaw += wrap(heading - this.lastHeading)
      p.yaw += wrap(heading - p.yaw) * centre
      // Head inertia, car space: the head lags the chassis (moves opposite its acceleration).
      dv.applyQuaternion(this.carQi.copy(this.carQ).invert())
      this.headV.x -= dv.x * HEAD_GAIN
      this.headV.y -= dv.y * HEAD_GAIN * HEAD_VERT
      this.headV.z -= dv.z * HEAD_GAIN
      settle(this.head, this.headV, HEAD_W, dt)
      const h = this.head, hv = this.headV
      if (Math.abs(h.x) > HEAD_MAX) (h.x = Math.sign(h.x) * HEAD_MAX), (hv.x = 0)
      if (Math.abs(h.y) > HEAD_MAX_Y) (h.y = Math.sign(h.y) * HEAD_MAX_Y), (hv.y = 0)
      if (Math.abs(h.z) > HEAD_MAX) (h.z = Math.sign(h.z) * HEAD_MAX), (hv.z = 0)
      cam.position.copy(car.eyeLocal).add(h).applyQuaternion(this.carQ).add(this.carPos)
      this.euler.set(p.pitch * (1 - k) + k * 0.25 + shy, wrap(p.yaw - heading) + shx, k * 1.2)
      cam.quaternion.copy(this.carQ).multiply(this.look.setFromEuler(this.euler))
      cam.updateMatrixWorld()
      this.fwd.set(0, 0, -1).applyQuaternion(cam.quaternion)
      this.flashOrigin.set(0.18, -0.2, 0).applyMatrix4(cam.matrixWorld)
      this.flashTarget.copy(cam.position).addScaledVector(this.fwd, 10)
    } else {
      // Positional lag (world): the anchor keeps its velocity when the car's changes.
      this.lagV.x += dv.x
      this.lagV.y += dv.y * CHASE_VERT
      this.lagV.z += dv.z
      settle(this.lag, this.lagV, CHASE_W, dt)
      const g = this.lag, gv = this.lagV
      const lh = Math.hypot(g.x, g.z)
      if (lh > CHASE_MAX) {
        const nx = g.x / lh, nz = g.z / lh
        g.x = nx * CHASE_MAX
        g.z = nz * CHASE_MAX
        const out = gv.x * nx + gv.z * nz
        if (out > 0) (gv.x -= out * nx), (gv.z -= out * nz)
      }
      if (Math.abs(g.y) > CHASE_MAX_Y) {
        g.y = Math.sign(g.y) * CHASE_MAX_Y
        if (gv.y * g.y > 0) gv.y = 0
      }
      // Chase yaw: 70 % heading / 30 % direction of travel (a slide reads from the side); reversing: the heading.
      const sp = Math.hypot(this.vel.x, this.vel.z)
      let want = heading
      if (car.speed > -1 && sp > 3) {
        const slip = wrap(Math.atan2(-this.vel.x, -this.vel.z) - heading)
        if (Math.abs(slip) < Math.PI / 2) want += slip * CHASE_SLIP * Math.min(1, (sp - 3) / 5)
      }
      p.yaw += wrap(want - p.yaw) * centre
      // Pitch: the player's pitch plus part of the chassis pitch (uphill → lower behind, looking up the slope).
      this.slope += (chassisPitch * SLOPE_FOLLOW - this.slope) * (1 - Math.exp(-SLOPE_RATE * dt))
      const pitch = THREE.MathUtils.clamp(p.pitch + this.slope, -1.45, 1.45)
      const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw), cp = Math.cos(pitch)
      this.fwd.set(-sy * cp, Math.sin(pitch), -cy * cp)
      const vd = this.vehicle
      // Pivot above the driver's seat (as on foot: feet + pivot height) from the rendered pose.
      this.pivot.copy(car.eyeLocal).applyQuaternion(this.carQ).add(this.carPos)
      this.pivot.y += (vd ? vd.pivot : TPP_PIVOT) - EYE_HEIGHT
      const dist = (vd ? vd.distance : 8) + Math.min(SPEED_DIST_MAX, Math.max(0, sp - 5) * SPEED_DIST)
      this.desired.copy(this.pivot).addScaledVector(this.fwd, -dist).sub(this.lag)
      this.placeOrbit(dt, cam, p)
      cam.rotation.set(pitch + shy, p.yaw + shx, k * 0.15, 'YXZ')
      cam.updateMatrixWorld()
    }
    this.lastHeading = heading
  }
}
