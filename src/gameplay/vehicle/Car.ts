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
import { STOCK_TRUCK, TruckSim, type TruckTune } from './VehicleSim'
import { vehicleDef, type VehicleTuning } from './catalogue'

/**
 * PICKUP TRUCK (assets/loadModels: Sketchfab "Pickup Truck", CC-BY-4.0) — a SIMULATED vehicle (VehicleSim
 * TruckSim: dynamic body, raycast suspension, 4×4 engine/brakes/tyre grip, see tests/vehicle.test.ts).
 *   E within 4 m to get in / out · W throttle · S brake, then reverse · A/D steer · Shift boost · Space handbrake
 *   = DRIFT at speed (or Shift + steer for a power slide; VehicleSim) (touch: stick = throttle + steer; the
 *   JUMP button becomes DRIFT). Exhaust puffs and tyre smoke / dust come from rendering/particles/VehicleFx.
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
  private readonly half: { x: number; y: number; z: number }
  private readonly wheelRadius: number
  private readonly bodyMat: THREE.MeshLambertMaterial
  private readonly glassMesh: THREE.Mesh
  private readonly steering: THREE.InstancedMesh | null
  private readonly steeringPivot: THREE.Vector3
  private readonly steeringAxis: THREE.Vector3
  /** Paint colour (linear) for the masked panels, and the tyre size multiplier (render). */
  private readonly paint = { value: new THREE.Color(1, 1, 1) }
  private tyre = 1
  /** Catalogue id of the loaded model. */
  readonly modelId: string
  /** Headlights (F while driving; auto from the darkness when you get in). */
  lights = false
  /** Brake lights this frame (S / handbrake while rolling). */
  braking = false
  private readonly lamps: THREE.Mesh
  private readonly lampMat: THREE.ShaderMaterial
  /** Headlamp centre and aim in car space (the spot light + beam). */
  private readonly headPos = new THREE.Vector3()
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
    tuning: VehicleTuning | null = null,
  ) {
    this.root.name = 'car'
    this.root.add(this.body)
    this.modelId = truck.id
    // Vertex colours carry the baked material colours (white where a texture is used); the paint colour tints
    // the masked panels only (`paintMask` attribute) — the garage's colour picker.
    const mat = new THREE.MeshLambertMaterial({ ...(truck.map ? { map: truck.map } : {}), vertexColors: true })
    const paint = this.paint
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uPaint = paint
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float paintMask; varying float vPaint;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPaint = paintMask;')
      // Paint REPLACES the panel's hue (keeps its shading/luminance) so a red coat on a blue textured van is red,
      // not black; white = the model's own colours (stock look).
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uPaint; varying float vPaint;')
        .replace('#include <color_fragment>', `#include <color_fragment>
        { float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
          float isWhite = step(2.95, uPaint.r + uPaint.g + uPaint.b);
          diffuseColor.rgb = mix(diffuseColor.rgb, uPaint * (lum * 1.3 + 0.08), vPaint * (1.0 - isWhite)); }`)
    }
    mat.customProgramCacheKey = () => `truck-paint-${truck.map ? 'tex' : 'flat'}`
    this.bodyMat = stylize(mat, { key: 'truck', rim: 0.45 })
    this.bodyMat.name = 'lib/truck'
    // Body as a 1-instance InstancedMesh: it then shares the wheels' (instanced) program → 1 truck program, not 2.
    const bodyMesh = new THREE.InstancedMesh(truck.body, this.bodyMat, 1)
    bodyMesh.setMatrixAt(0, new THREE.Matrix4())
    bodyMesh.frustumCulled = false
    const glassMesh = (this.glassMesh = new THREE.Mesh(truck.glass, glassMaterial))
    for (const m of [bodyMesh, glassMesh]) (m.castShadow = true), this.body.add(m)
    this.wheelPos = truck.wheelPos
    this.half = truck.half
    this.wheelRadius = truck.wheelRadius
    this.track = Math.abs(truck.wheelPos[1][0] - truck.wheelPos[0][0])
    this.wheels = new THREE.InstancedMesh(truck.wheel, this.bodyMat, 4)
    this.wheels.castShadow = true
    this.wheels.frustumCulled = false // instances move with the body; the truck is one small object
    this.body.add(this.wheels)
    // Steering wheel (split out of the body at load, when the model has one): turns with the driver's input.
    this.steering = truck.steeringWheel ? new THREE.InstancedMesh(truck.steeringWheel, this.bodyMat, 1) : null
    this.steeringPivot = new THREE.Vector3(...truck.steeringPivot)
    this.steeringAxis = new THREE.Vector3(...truck.steeringAxis)
    if (this.steering) {
      this.steering.frustumCulled = false
      this.body.add(this.steering)
    }
    const t = tuning ?? { ...STOCK_TRUCK, paint: '#ffffff' }
    this.sim = new TruckSim(physics, truck, t)
    this.applyLook(t)
    // LAMPS: two head + two tail quads (additive, HDR when lit → bloom), positions from the catalogue or the body box.
    const def = vehicleDef(truck.id)
    const h = truck.half, b = truck.bottom
    // Just OUTSIDE the body box (a lamp inside the bumper geometry fails the depth test and never shows).
    const head = def.lamps?.head ?? [h.x * 0.62, b + h.y * 0.62, truck.front - 0.03]
    const tail = def.lamps?.tail ?? [h.x * 0.66, b + h.y * 0.62, truck.rear + 0.03]
    this.headPos.set(0, head[1], head[2])
    const pos: number[] = [], id: number[] = [], corner: number[] = [], idx: number[] = []
    const quad = (cx: number, cy: number, cz: number, w: number, hh: number, back: boolean, lamp: number) => {
      const base = pos.length / 3
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        pos.push(cx + u * w * (back ? -1 : 1), cy + v * hh, cz)
        id.push(lamp)
        corner.push(u, v)
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
    for (const side of [-1, 1]) {
      quad(side * head[0], head[1], head[2], 0.17, 0.11, false, 0)
      quad(side * tail[0], tail[1], tail[2], 0.2, 0.08, true, 1)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('lampId', new THREE.Float32BufferAttribute(id, 1))
    g.setAttribute('corner', new THREE.Float32BufferAttribute(corner, 2))
    g.setIndex(idx)
    this.lampMat = new THREE.ShaderMaterial({
      name: 'CarLamps', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      uniforms: { uHead: { value: 0 }, uTail: { value: 0 }, uBrake: { value: 0 }, uDark: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float lampId; attribute vec2 corner; varying float vId; varying vec2 vC;
        void main() { vId = lampId; vC = corner; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uHead, uTail, uBrake, uDark; varying float vId; varying vec2 vC;
        void main() {
          float d = length(vC);
          float soft = smoothstep(1.0, 0.35, d);
          // Heads: warm white, HDR when on (bloom halo), a faint lens even when off. Tails: dim red with the
          // lights, bright red under braking — always visible a little by day (a real brake light).
          vec3 head = vec3(1.0, 0.93, 0.78) * (0.12 + uHead * (1.6 + 2.4 * uDark));
          vec3 tail = vec3(1.0, 0.1, 0.06) * (0.1 + uTail * 0.6 + uBrake * (1.4 + 1.6 * uDark));
          vec3 c = vId < 0.5 ? head : tail;
          gl_FragColor = vec4(c * soft, 1.0);
        }`,
    })
    this.lamps = new THREE.Mesh(g, this.lampMat)
    this.lamps.frustumCulled = false
    this.lamps.renderOrder = 9
    this.body.add(this.lamps)
  }

  /** Headlamp origin and a point 28 m down the road (world) — the spot light and the beam when the lights are on. */
  headlamp(origin: THREE.Vector3, target: THREE.Vector3): void {
    origin.copy(this.headPos).applyMatrix4(this.root.matrixWorld)
    target.set(0, this.headPos.y - 1.2, this.headPos.z - 28).applyMatrix4(this.root.matrixWorld)
  }

  /** Lamp uniforms once per frame (darkness 0 day … 1 night). */
  updateLamps(darkness: number): void {
    const c = this.sim.controls
    const v = this.sim.speed
    this.braking = this.driving && ((c.throttle < -0.01 && v > 0.5) || (c.handbrake && Math.abs(v) > 1))
    const u = this.lampMat.uniforms
    u.uHead.value = this.lights ? 1 : 0
    u.uTail.value = this.lights ? 1 : 0
    u.uBrake.value = this.braking ? 1 : 0
    u.uDark.value = darkness
  }

  /** Garage: apply a setup live — physics via the sim, paint + tyre size on the meshes. */
  retune(t: Partial<VehicleTuning>): void {
    const { paint: _p, ...phys } = t
    if (Object.keys(phys).length) this.sim.retune(phys as Partial<TruckTune>)
    this.applyLook(t)
  }

  private applyLook(t: Partial<VehicleTuning>): void {
    if (t.paint) this.paint.value.setStyle(t.paint) // sRGB hex → linear (ColorManagement)
    if (t.tyre !== undefined) this.tyre = t.tyre
  }

  get tune(): TruckTune {
    return this.sim.tune
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
  /** World velocity of the chassis (m/s) — streaming looks ahead along it. */
  velocity(out: THREE.Vector3): THREE.Vector3 {
    const v = this.sim.body.linvel()
    return out.set(v.x, v.y, v.z)
  }

  /** Exhaust tip (world): rear left, under the bumper — through the rendered (interpolated) pose. */
  exhaustWorld(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-0.42, 0.3, this.half.z * 0.96).applyMatrix4(this.root.matrixWorld)
  }

  /** Ground contact point under wheel k (world, rendered pose). */
  wheelContact(k: number, out: THREE.Vector3): THREE.Vector3 {
    const [x, y, z] = this.wheelPos[k]
    return out.set(x, y + this.sim.wheels[k].lift - this.wheelRadius + 0.05, z).applyMatrix4(this.root.matrixWorld) // hub sits (tyre−1)·r higher, tread (tyre)·r lower: net the same
  }

  /** Chassis forward axis in world space (rendered pose). */
  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, -1).transformDirection(this.root.matrixWorld)
  }

  /** LOW tier: a smaller texture copy (GPU memory). */
  setMap(map: THREE.Texture | null): void {
    if (!map || this.bodyMat.map === map) return
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
    c.boost = drive && (i.down('ShiftLeft') || i.down('ShiftRight'))
    c.parked = !drive
    // Only simulate where the ground has colliders (the physics ring follows the player AND runs ahead of a
    // moving vehicle, WorldManager); frozen elsewhere — while driving too, so a fast truck waits a few frames at
    // a chunk that hasn't streamed in instead of falling through the road.
    const t = this.sim.body.translation()
    const key = chunkKey(Math.floor(t.x / CHUNK_SIZE), Math.floor(t.z / CHUNK_SIZE))
    this.sim.enabled = this.physics.hasChunk(key)
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
      // Bigger tyres: scaled about the hub, hub raised so the tread stays on the ground (as in the sim).
      _m.compose(_v.set(x, y + w[k].lift + (this.tyre - 1) * this.wheelRadius, z), _q.setFromEuler(_e), _s.setScalar(this.tyre))
      this.wheels.setMatrixAt(k, _m)
    })
    this.wheels.instanceMatrix.needsUpdate = true
    // Steering wheel: D (right) turns it clockwise as the driver sees it = +rotation about the column axis,
    // which points forward/down away from the driver (verified numerically: D moves the rim's top to +X).
    const c = this.sim.controls
    this.hands += ((this.driving ? c.steer : 0) - this.hands) * Math.min(1, dt * 7)
    if (this.steering) {
      _q.setFromAxisAngle(this.steeringAxis, this.hands * WHEEL_TURN)
      this.steering.setMatrixAt(0, _m.compose(this.steeringPivot, _q, _one))
      this.steering.instanceMatrix.needsUpdate = true
    }
    this.root.updateMatrixWorld()
    this.glassMesh.visible = !this.driving || this.showDriver
    if (this.driving) {
      this.character.root.visible = false // inside the cab (opaque glass)
      if (p.lookIdle > 0.6) {
        let d = this.heading - p.yaw
        d = Math.atan2(Math.sin(d), Math.cos(d))
        p.yaw += d * Math.min(1, dt * 3)
      }
      // The spot light becomes the headlights (Game gates it by `lights`).
      this.headlamp(flashOrigin, flashTarget)
    }
  }

  dispose(): void {
    this.root.removeFromParent()
    this.lamps.geometry.dispose()
    this.lampMat.dispose()
    this.sim.dispose()
    this.wheels.dispose()
    this.steering?.dispose()
    this.bodyMat.dispose()
  }
}

const _e = new THREE.Euler()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _v = new THREE.Vector3()
const _p = new THREE.Vector3()
const _one = new THREE.Vector3(1, 1, 1)
const _s = new THREE.Vector3(1, 1, 1)
