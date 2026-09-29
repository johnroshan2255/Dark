import * as THREE from 'three'
import type { PhysicsWorld } from '../../physics/PhysicsWorld'
import type { Input } from '../../input/Input'
import type { WorldFields } from '../../world/WorldFields'
import type { CharacterModel } from '../player/CharacterModel'
import type { PlayerController } from '../player/PlayerController'
import type { TruckModel } from '../../assets/loadModels'
import { stylize } from '../../rendering/shaders/stylize'
import { CHUNK_SIZE } from '../../world/constants'
import { chunkKey } from '../../world/types'
import { TruckSim } from './VehicleSim'

/**
 * PICKUP TRUCK (assets/loadModels: Sketchfab "Pickup Truck", CC-BY-4.0) — a SIMULATED vehicle (VehicleSim
 * TruckSim: dynamic body, raycast suspension, 4×4 engine/brakes/tyre grip, see tests/vehicle.test.ts).
 *   E within 4 m to get in / out · W throttle · S brake, then reverse · A/D steer · Shift boost · Space handbrake
 *   (touch: stick = throttle + steer; the jump button taps the handbrake).
 * This class only maps input → controls and draws the simulated pose (interpolated between 60 Hz steps): body,
 * each wheel's real suspension travel, spin and steering angle. Parked outside the physics ring it is frozen
 * (no ground collider to rest on) and wakes when its chunk's colliders exist again.
 * Draws: body + 4 wheels + steering wheel (textured Lambert, all instanced → ONE program, 3 draws) + glass (shared
 * vertex-colour program, hidden in first person so you can see out).
 */
/** Seat (hip) points: driver sits BEHIND THE STEERING WHEEL (x aligned with it, ~0.6 m back), passenger beside;
 *  the cab has no rear bench, so the other two ride in the bed. */
export const SEATS: [number, number, number][] = [[-0.415, 0.9, 0.04], [0.4, 0.9, 0.04], [-0.45, 0.75, 1.5], [0.45, 0.75, 1.5]]
/** Steering-wheel turn at full lock (rad, ≈ 135° each way) — follows the driver's hands, not the speed-limited road wheels. */
const WHEEL_TURN = 2.35

export class Car {
  readonly root = new THREE.Group()
  private readonly body = new THREE.Group()
  private readonly wheels: THREE.InstancedMesh
  private readonly wheelPos: [number, number, number][]
  private readonly track: number
  private readonly bodyMat: THREE.MeshLambertMaterial
  private readonly glassMesh: THREE.Mesh
  private readonly steering: THREE.InstancedMesh
  private readonly steeringPivot: THREE.Vector3
  private readonly steeringAxis: THREE.Vector3
  /** Driver's hands on the wheel, −1 … 1 (smoothed steer input). */
  hands = 0
  readonly sim: TruckSim
  /** Interpolation: pose before the last physics step, and the current one. */
  private readonly prevP = new THREE.Vector3()
  private readonly prevQ = new THREE.Quaternion()
  private readonly curP = new THREE.Vector3()
  private readonly curQ = new THREE.Quaternion()
  /** Rendered (interpolated) position — camera, HUD, prompts. */
  readonly pos = new THREE.Vector3()
  driving = false
  near = false
  /** Third-person view (set by Game): the tinted glass is opaque, so first person hides it to see out. */
  showDriver = false

  constructor(
    glassMaterial: THREE.Material,
    truck: TruckModel,
    private readonly physics: PhysicsWorld,
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
    this.track = Math.abs(truck.wheelPos[1][0] - truck.wheelPos[0][0])
    this.wheels = new THREE.InstancedMesh(truck.wheel, this.bodyMat, 4)
    this.wheels.castShadow = true
    this.wheels.frustumCulled = false // instances move with the body; the truck is one small object
    this.body.add(this.wheels)
    // Steering wheel (split out of the body at load): turns with the driver's input. Instanced → same program.
    this.steering = new THREE.InstancedMesh(truck.steeringWheel, this.bodyMat, 1)
    this.steering.frustumCulled = false
    this.steeringPivot = new THREE.Vector3(...truck.steeringPivot)
    this.steeringAxis = new THREE.Vector3(...truck.steeringAxis)
    this.body.add(this.steering)
    this.sim = new TruckSim(physics, truck)
  }

  set castShadow(v: boolean) {
    this.root.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).castShadow = v) : 0))
  }

  get heading(): number {
    return this.sim.heading
  }
  get speed(): number {
    return this.sim.speed
  }

  /** LOW tier: a smaller texture copy (GPU memory). */
  setMap(map: THREE.Texture): void {
    if (this.bodyMat.map === map) return
    this.bodyMat.map = map
    this.bodyMat.needsUpdate = true
  }

  park(x: number, z: number, heading: number): void {
    this.sim.place(x, this.fields.height(x, z), z, heading)
    this.readPose(this.curP, this.curQ)
    this.prevP.copy(this.curP)
    this.prevQ.copy(this.curQ)
    this.pos.copy(this.curP)
  }

  private readPose(p: THREE.Vector3, q: THREE.Quaternion): void {
    const t = this.sim.body.translation(), r = this.sim.body.rotation()
    p.set(t.x, t.y, t.z)
    q.set(r.x, r.y, r.z, r.w)
  }

  toggle(): boolean {
    const p = this.player
    if (this.driving) {
      this.driving = false
      // Climb out of the driver's door (left side).
      const h = this.heading
      const c = Math.cos(h), s = Math.sin(h)
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
    const i = this.input
    const drive = this.driving && !this.player.dead
    const c = this.sim.controls
    c.throttle = drive ? Math.max(-1, Math.min(1, (i.down('KeyW') ? 1 : 0) - (i.down('KeyS') ? 1 : 0) + i.touchMove.y)) : 0
    c.steer = drive ? Math.max(-1, Math.min(1, (i.down('KeyD') ? 1 : 0) - (i.down('KeyA') ? 1 : 0) + i.touchMove.x)) : 0
    c.handbrake = drive && i.down('Space')
    c.boost = drive && i.down('ShiftLeft')
    // Only simulate where the ground has colliders (the physics ring follows the player); frozen elsewhere.
    const t = this.sim.body.translation()
    const key = chunkKey(Math.floor(t.x / CHUNK_SIZE), Math.floor(t.z / CHUNK_SIZE))
    this.sim.enabled = this.driving || this.physics.hasChunk(key)
    this.readPose(this.prevP, this.prevQ)
    this.sim.step(dt)
    this.sim.keepAbove(this.fields.height(t.x, t.z))
    if (this.driving) this.player.carryTo(this.seatWorld(0)) // streaming, grass, monsters follow the truck
  }

  /**
   * Feet position such that the FPP eye (feet + 1.62 m) sits at the driver's head, through the body's full
   * simulated orientation (so the view stays in the cab on any slope).
   */
  seatWorld(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    const [sx, sy, sz] = SEATS[i]
    this.readPose(_p, _q)
    out.set(sx, sy + 0.66, sz).applyQuaternion(_q).add(_p)
    out.y -= 1.62
    return out
  }

  /** Render frame: interpolated simulated pose; wheels from the simulation; headlights; camera follow. */
  update(dt: number, alpha: number, flashOrigin: THREE.Vector3, flashTarget: THREE.Vector3): void {
    const p = this.player
    this.readPose(this.curP, this.curQ)
    this.pos.lerpVectors(this.prevP, this.curP, alpha)
    this.root.position.copy(this.pos)
    this.root.quaternion.slerpQuaternions(this.prevQ, this.curQ, alpha)
    this.near = !this.driving && Math.hypot(p.curr.x - this.pos.x, p.curr.z - this.pos.z) < 4
    const w = this.sim.wheels
    this.wheelPos.forEach(([x, y, z], k) => {
      const rightSide = k === 1 || k === 3
      const spin = -w[k].spin
      // Right wheels = the left wheel turned 180° (rim faces out); their spin reverses accordingly.
      _e.set(rightSide ? -spin : spin, (rightSide ? Math.PI : 0) - w[k].steer, 0, 'YXZ')
      _m.compose(_v.set(x, y + w[k].lift, z), _q.setFromEuler(_e), _one)
      this.wheels.setMatrixAt(k, _m)
    })
    this.wheels.instanceMatrix.needsUpdate = true
    // Steering wheel: D (right) turns it clockwise as the driver sees it = +rotation about the column axis,
    // which points forward/down away from the driver (verified numerically: D moves the rim's top to +X).
    const c = this.sim.controls
    this.hands += ((this.driving ? c.steer : 0) - this.hands) * Math.min(1, dt * 7)
    _q.setFromAxisAngle(this.steeringAxis, this.hands * WHEEL_TURN)
    this.steering.setMatrixAt(0, _m.compose(this.steeringPivot, _q, _one))
    this.steering.instanceMatrix.needsUpdate = true
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
    this.sim.dispose()
    this.wheels.dispose()
    this.steering.dispose()
    this.bodyMat.dispose()
  }
}

const _e = new THREE.Euler()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _v = new THREE.Vector3()
const _p = new THREE.Vector3()
const _one = new THREE.Vector3(1, 1, 1)
