import type RAPIER from '@dimforge/rapier3d-compat'
import { group, Groups, type PhysicsWorld } from '../../physics/PhysicsWorld'

/**
 * VEHICLE SIMULATION (no rendering — tested in Node, tests/vehicle.test.ts). Both vehicles are real Rapier
 * DYNAMIC bodies driven by Rapier's DynamicRayCastVehicleController (the Bullet raycast-vehicle model):
 * per-wheel suspension springs + dampers (forces scale with chassis mass), engine force, brakes, steering,
 * tyre friction with a traction limit (frictionSlip ≈ μ) and side grip. On top of it:
 *   TRUCK  4WD with a torque/power curve (strong low-speed pull for hills, power-limited top speed), air drag +
 *          rolling resistance, speed-sensitive steering, handbrake = locked + slippery rear (slides), anti-roll
 *          assist (anti-roll bars), auto-righting after a rollover.
 *   BIKE   2 wheels on the centre line + a BALANCE controller: steady-state lean φ = atan(v²·tanδ / (g·L)) for the
 *          steered front wheel δ, reached with a PD roll torque — it leans INTO turns, stays up when slow (a foot
 *          down), and falls over when it crashes (rider thrown off). Human-power pedalling (P/v capped by max
 *          force): hills slow you right down.
 * Game convention: forward = −Z, up = +Y. Rapier: axle +X ⇒ positive engine force drives −Z; positive
 * steering turns LEFT (verified in tests/vehicle.test.ts with an unwrapped heading) — we negate it. Ray casts see terrain + static props only (not the player, monsters or the chassis).
 * Cost: ≤ 6 ray casts + 2 dynamic bodies per 60 Hz step (≈ 0.05 ms measured in the physics step).
 */
const GRAVITY = 20 // world gravity (PhysicsWorld): 2× real for snappy jumps — forces below are tuned for it
const RAY_GROUPS = group(0xffff, Groups.Terrain | Groups.Static)

export interface Controls {
  /** −1 … 1 (W/S or stick). */
  throttle: number
  /** −1 … 1 (D = +1 = right). */
  steer: number
  handbrake: boolean
  boost: boolean
}

export interface WheelState {
  /** Suspension compression offset from the rest pose (m, + = wheel pushed up). */
  lift: number
  /** Accumulated spin (rad, + = rolling forward). */
  spin: number
  /** Steering angle (rad, + = right). */
  steer: number
  contact: boolean
}

interface WheelSpec {
  /** Hub position in chassis space at the design ride height. */
  hub: [number, number, number]
  radius: number
  front: boolean
}

interface SimSpec {
  mass: number
  /** Colliders in chassis space: half extents, centre, mass share (COM falls where the mass is). */
  boxes: { half: [number, number, number]; at: [number, number, number]; mass: number }[]
  wheels: WheelSpec[]
  suspension: { rest: number; travel: number; stiffness: number; compression: number; relaxation: number }
  frictionSlip: number
  sideStiffness: number
}

abstract class VehicleBase {
  readonly body: RAPIER.RigidBody
  readonly vc: RAPIER.DynamicRayCastVehicleController
  readonly controls: Controls = { throttle: 0, steer: 0, handbrake: false, boost: false }
  readonly wheels: WheelState[]
  /** Signed forward speed (m/s, + = forward). */
  speed = 0
  protected steerAngle = 0
  protected readonly R: typeof RAPIER
  private readonly sag: number

  constructor(
    protected readonly physics: PhysicsWorld,
    protected readonly spec: SimSpec,
  ) {
    const R = (this.R = physics.R)
    this.body = physics.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setCanSleep(true).setAngularDamping(0.4).setLinearDamping(0.02).setCcdEnabled(true),
    )
    for (const b of spec.boxes) {
      physics.world.createCollider(
        R.ColliderDesc.cuboid(...b.half).setTranslation(...b.at).setMass(b.mass).setFriction(0.35).setRestitution(0.05)
          .setCollisionGroups(group(Groups.Vehicle, 0xffff & ~Groups.Player)),
        this.body,
      )
    }
    const vc = (this.vc = physics.world.createVehicleController(this.body))
    vc.indexUpAxis = 1
    ;(vc as unknown as { setIndexForwardAxis: number }).setIndexForwardAxis = 2
    const s = spec.suspension
    // Static sag: all wheels share the weight → k·x·m·n = m·g ⇒ x = g / (n·k). Mount the ray so the wheel sits
    // at its design hub height when the truck rests on flat ground.
    this.sag = GRAVITY / (spec.wheels.length * s.stiffness)
    spec.wheels.forEach((w, i) => {
      vc.addWheel({ x: w.hub[0], y: w.hub[1] + s.rest - this.sag, z: w.hub[2] }, { x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 }, s.rest, w.radius)
      vc.setWheelSuspensionStiffness(i, s.stiffness)
      vc.setWheelSuspensionCompression(i, s.compression)
      vc.setWheelSuspensionRelaxation(i, s.relaxation)
      vc.setWheelMaxSuspensionTravel(i, s.travel)
      vc.setWheelMaxSuspensionForce(i, spec.mass * GRAVITY * 3)
      vc.setWheelFrictionSlip(i, spec.frictionSlip)
      vc.setWheelSideFrictionStiffness(i, spec.sideStiffness)
    })
    this.wheels = spec.wheels.map(() => ({ lift: 0, spin: 0, steer: 0, contact: false }))
  }

  /** Place at rest (ground point at y), facing `heading` (0 = −Z; + turns left, game yaw), nose-up `pitch`. */
  place(x: number, y: number, z: number, heading: number, pitch = 0): void {
    this.body.setTranslation({ x, y: y + 0.05, z }, true)
    // q = yaw(heading about +Y) · pitch(about +X: nose up)
    const cy = Math.cos(heading / 2), sy = Math.sin(heading / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2)
    this.body.setRotation({ x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp }, true)
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    this.speed = 0
  }

  set enabled(v: boolean) {
    if (this.body.isEnabled() !== v) this.body.setEnabled(v)
  }
  get enabled(): boolean {
    return this.body.isEnabled()
  }

  /** World-space forward (−Z of the chassis) and up axes. */
  protected axes(): { f: [number, number, number]; u: [number, number, number]; r: [number, number, number] } {
    const q = this.body.rotation()
    const rot = (x: number, y: number, z: number): [number, number, number] => {
      // v' = q v q*
      const ix = q.w * x + q.y * z - q.z * y, iy = q.w * y + q.z * x - q.x * z, iz = q.w * z + q.x * y - q.y * x, iw = -q.x * x - q.y * y - q.z * z
      return [ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y, iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z, iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x]
    }
    return { f: rot(0, 0, -1), u: rot(0, 1, 0), r: rot(1, 0, 0) }
  }

  /** Heading (yaw, game convention) from the chassis forward axis. */
  get heading(): number {
    const { f } = this.axes()
    return Math.atan2(-f[0], -f[2])
  }

  /** Drive forces for this step (engine per wheel, brakes, steering, extra body forces). */
  protected abstract drive(dt: number, v: number): void
  /** After the tyre impulses of this step (velocity-level corrections, e.g. the bike's balance). */
  protected afterWheels(_dt: number, _v: number): void {}

  /** One fixed step: controls → wheel forces → raycast vehicle update. Call before world.step(). */
  step(dt: number): void {
    if (!this.enabled) return
    const lv = this.body.linvel()
    const { f } = this.axes()
    this.speed = lv.x * f[0] + lv.y * f[1] + lv.z * f[2]
    this.body.resetForces(false)
    this.body.resetTorques(false)
    const moving = Math.abs(this.speed) > 0.05 || Math.abs(this.controls.throttle) > 0.01
    if (moving) this.body.wakeUp()
    this.drive(dt, this.speed)
    this.vc.updateVehicle(dt, undefined, RAY_GROUPS, (c) => c.parent()?.handle !== this.body.handle)
    this.afterWheels(dt, this.speed)
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]
      const len = this.vc.wheelSuspensionLength(i) ?? this.spec.suspension.rest
      w.lift = this.spec.suspension.rest - this.sag - len
      w.spin = this.vc.wheelRotation(i) ?? 0
      w.steer = -(this.vc.wheelSteering(i) ?? 0)
      w.contact = this.vc.wheelIsInContact(i)
    }
  }

  /** Streaming guard: the ground collider under a fast vehicle may not exist yet — never fall out of the world. */
  keepAbove(ground: number): void {
    const t = this.body.translation()
    if (t.y < ground - 0.6) {
      this.body.setTranslation({ x: t.x, y: ground + 0.3, z: t.z }, true)
      const v = this.body.linvel()
      this.body.setLinvel({ x: v.x, y: Math.max(0, v.y), z: v.z }, true)
    }
  }

  /** World-up component of the chassis up axis (1 = upright, < 0 = upside down). */
  axesUp(): number {
    return this.axes().u[1]
  }

  /** Roll (+ = right side down) and pitch (+ = nose up) of the chassis. */
  attitude(): { roll: number; pitch: number } {
    const { f, u, r } = this.axes()
    return { roll: Math.atan2(-r[1], u[1]), pitch: Math.asin(Math.max(-1, Math.min(1, f[1]))) }
  }

  dispose(): void {
    this.physics.world.removeVehicleController(this.vc)
    this.physics.world.removeRigidBody(this.body)
  }
}

/** Pickup-truck dimensions from the model (assets/loadModels TruckModel). */
export interface TruckDims {
  wheelPos: [number, number, number][]
  wheelRadius: number
  half: { x: number; y: number; z: number }
}

export class TruckSim extends VehicleBase {
  static readonly MASS = 1750
  /** Drive force limit (N) on the flat, and the extra an automatic low range adds nose-up (m·g·sin 60° ≈ 30 kN). */
  static readonly MAX_FORCE = 12000
  static readonly LOW_RANGE = 24000
  static readonly POWER = 120_000
  private upsideDown = 0

  constructor(physics: PhysicsWorld, d: TruckDims) {
    const h = d.half
    super(physics, {
      mass: TruckSim.MASS,
      // Heavy low frame (engine, axles, fuel) + light cab/bed → centre of mass ≈ 0.62 m: rollover ≈ 1.2 g sideways,
      // back-flip tip-over ≈ 68° on a climb.
      boxes: [
        { half: [h.x * 0.9, 0.2, h.z * 0.93], at: [0, 0.54, 0], mass: TruckSim.MASS * 0.85 },
        { half: [h.x * 0.86, 0.42, h.z * 0.36], at: [0, 1.28, -h.z * 0.1], mass: TruckSim.MASS * 0.1 },
        { half: [h.x * 0.88, 0.2, h.z * 0.42], at: [0, 1.05, h.z * 0.55], mass: TruckSim.MASS * 0.05 },
      ],
      wheels: d.wheelPos.map((p, i) => ({ hub: p, radius: d.wheelRadius, front: i < 2 })),
      suspension: { rest: 0.32, travel: 0.24, stiffness: 36, compression: 2.6, relaxation: 3.8 },
      frictionSlip: 2.4,
      sideStiffness: 0.55,
    })
  }

  protected drive(dt: number, v: number): void {
    const c = this.controls
    const vc = this.vc
    const m = TruckSim.MASS
    const av = Math.abs(v)
    // Engine: constant force at low speed (gearing), constant power above it; boost = more power.
    const power = TruckSim.POWER * (c.boost ? 1.45 : 1)
    const climb = Math.max(0, Math.sin(this.attitude().pitch)) // automatic low range on steep uphill
    const maxForce = TruckSim.MAX_FORCE + TruckSim.LOW_RANGE * Math.min(1, climb * 1.3)
    const pull = Math.min(maxForce, (power * (1 + climb * 2)) / Math.max(av, 0.5))
    let engine = 0, brake = 0
    if (c.throttle > 0.01) engine = pull * c.throttle // (rolling back on a hill: the wheels drive forward, no brake)
    // Wheelie / back-flip control on steep climbs: all the weight is on the rear axle and the drive torque lifts
    // the nose (static tip-over ≈ 64°) — ease off whenever the front wheels leave the ground, so it crawls.
    const frontDown = this.wheels[0].contact || this.wheels[1].contact
    const wheelie = !frontDown && (this.wheels[2].contact || this.wheels[3].contact) && climb > 0.3
    if (wheelie && engine > 0) engine *= 0.7
    else if (c.throttle < -0.01) {
      if (v > 0.8) brake = -c.throttle
      else engine = -Math.min(maxForce * 0.7, power / Math.max(av, 0.5)) * -c.throttle * (v < -9 ? 0 : 1) // reverse, ≤ 9 m/s
    } else if (av < 0.6) brake = 0.6 // holding still (parking)
    // Brake impulse per wheel per step: ~1 g of deceleration at full pedal (tyres limit it further).
    const brakeImp = (brake * m * GRAVITY * 0.5 * dt) / 4
    // Steering: full lock slow, much less at speed (stable at 25 m/s); smoothed like a steering rack.
    const lock = 0.62 / (1 + av * 0.12)
    this.steerAngle += (c.steer * lock - this.steerAngle) * Math.min(1, dt * (c.steer === 0 ? 7 : 5))
    // 4×4 with traction control: drive split by each wheel's load (last step's suspension force) — on a steep
    // climb the weight sits on the rear axle and an equal split would waste the drive on the light front wheels.
    let load = 0
    const n = [0, 1, 2, 3].map((i) => (this.wheels[i].contact ? Math.max(0, vc.wheelSuspensionForce(i) ?? 0) : 0))
    for (const x of n) load += x
    for (let i = 0; i < 4; i++) {
      const front = i < 2
      vc.setWheelEngineForce(i, load > 1 ? (engine * n[i]) / load : engine / 4)
      const hb = c.handbrake && !front
      vc.setWheelBrake(i, hb ? (m * GRAVITY * 1.2 * dt) / 4 : brakeImp)
      vc.setWheelSideFrictionStiffness(i, hb ? 0.25 : 0.55)
      // Ackermann-ish: the inner front wheel turns a little more.
      if (front) vc.setWheelSteering(i, -this.steerAngle * (1 + 0.08 * Math.sign(this.steerAngle) * (i === 1 ? 1 : -1)))
    }
    // Aerodynamic drag (terminal ≈ 30 m/s on the flat) + rolling resistance, opposite to the velocity.
    const lv = this.body.linvel()
    const sp = Math.hypot(lv.x, lv.y, lv.z)
    if (sp > 0.05) {
      const drag = 5.6 * sp * sp + 0.012 * m * GRAVITY
      this.body.addForce({ x: (-lv.x / sp) * drag, y: (-lv.y / sp) * drag, z: (-lv.z / sp) * drag }, true)
    }
    // Anti-roll assist (anti-roll bars + a little stability control): resists roll rate and large roll angles
    // while the wheels are down, so hard cornering leans the body instead of flipping it at the first bump.
    const { roll } = this.attitude()
    const { f, u } = this.axes()
    const w = this.body.angvel()
    const rollRate = w.x * f[0] + w.y * f[1] + w.z * f[2] // + = rolling right-side-down (rotation about the forward axis)
    const grounded = this.wheels.filter((x) => x.contact).length >= 2
    if (grounded) {
      const tq = (-roll * 9 - rollRate * 3.2) * m * 0.9
      this.body.addTorque({ x: f[0] * tq, y: f[1] * tq, z: f[2] * tq }, true) // torque along +forward raises roll
    }
    // Pitch assist on steep climbs (the nose lifting off): damps the pitch-up and pushes the nose back down.
    if (wheelie) {
      const { r } = this.axes()
      const pitchRate = w.x * r[0] + w.y * r[1] + w.z * r[2] // + = nose rising
      const tq = -(Math.max(0, pitchRate) * 4 + 1.2) * m * 1.2
      this.body.addTorque({ x: r[0] * tq, y: r[1] * tq, z: r[2] * tq }, true)
    }
    // Auto-righting: on its side / roof for 2 s at a crawl → set back on the wheels (game rule, not physics).
    this.upsideDown = u[1] < 0.35 && av < 2 ? this.upsideDown + dt : 0
    if (this.upsideDown > 2) {
      const t = this.body.translation()
      this.place(t.x, t.y + 1.2, t.z, this.heading)
      this.upsideDown = 0
    }
  }
}

/** BMX dimensions (scaled bike space, gameplay/bmx/Bike). */
export interface BikeDims {
  front: [number, number, number]
  rear: [number, number, number]
  wheelRadius: number
}

export class BikeSim extends VehicleBase {
  static readonly MASS = 85 // bike 11 kg + rider
  /** Human power (W): cruising / sprinting out of the saddle; max pedal force caps the climbing. */
  static readonly POWER = 900
  static readonly SPRINT = 1500
  /** Max pedal force (N): also the wheelie limit — F·h < m·g·d(rear contact → COM) with COM 0.9 m high. */
  static readonly MAX_FORCE = 900
  /** Balance controller on (rider in control); off = it falls over. */
  balancing = true
  /** Current lean (rad, + = right side down) and the balance target. */
  lean = 0
  targetLean = 0
  private readonly wheelbase: number

  constructor(physics: PhysicsWorld, d: BikeDims) {
    super(physics, {
      mass: BikeSim.MASS,
      // Frame low, rider mass high (COM ≈ 1.0 m) — like a real bike + rider.
      boxes: [
        { half: [0.08, 0.2, 0.42], at: [0, 0.52, 0], mass: 14 },
        { half: [0.18, 0.3, 0.2], at: [0, 0.98, -0.04], mass: BikeSim.MASS - 14 },
      ],
      wheels: [
        { hub: d.front, radius: d.wheelRadius, front: true },
        { hub: d.rear, radius: d.wheelRadius, front: false },
      ],
      // Tyres + fork: stiff (3–4 cm sag), near-critically damped (ω = √(2k) ≈ 25).
      suspension: { rest: 0.14, travel: 0.12, stiffness: 320, compression: 12, relaxation: 16 },
      frictionSlip: 1.6,
      sideStiffness: 1.1,
    })
    this.wheelbase = Math.abs(d.front[2] - d.rear[2])
  }

  protected drive(dt: number, v: number): void {
    const c = this.controls
    const vc = this.vc
    const av = Math.abs(v)
    const power = c.boost ? BikeSim.SPRINT : BikeSim.POWER
    let pedal = 0, brake = 0
    if (!this.balancing) brake = 0.4
    else if (c.throttle > 0.01) pedal = Math.min(BikeSim.MAX_FORCE, power / Math.max(av, 0.8)) * c.throttle * (v < -0.5 ? 0 : 1)
    else if (c.throttle < -0.01) {
      if (v > 0.4) brake = -c.throttle
      else pedal = -Math.min(180, 150 / Math.max(av, 0.5)) * -c.throttle * (v < -2 ? 0 : 1) // walk it backwards
    } else if (av < 0.3) brake = 0.5
    // Wheelie guard: the rider eases off when the front wheel lifts, and leans over the bars while pushing
    // hard (weight shift ≈ a nose-down moment of ~85 % of the drive moment F·h).
    if (!this.wheels[0].contact && pedal > 0) pedal *= 0.3
    if (pedal > 0) {
      const { r } = this.axes()
      const tq = -pedal * 0.9 * 0.85
      this.body.addTorque({ x: r[0] * tq, y: r[1] * tq, z: r[2] * tq }, true)
    }
    vc.setWheelEngineForce(0, 0)
    vc.setWheelEngineForce(1, pedal)
    const brakeImp = brake * BikeSim.MASS * GRAVITY * 0.7 * dt
    vc.setWheelBrake(0, brakeImp * 0.6)
    vc.setWheelBrake(1, brakeImp * 0.4)
    // Steering: tight at walking pace, gentle at speed (you steer a fast bike mostly by leaning).
    const lock = 0.55 / (1 + av * 0.22)
    this.steerAngle += ((this.balancing ? c.steer : 0) * lock - this.steerAngle) * Math.min(1, dt * 6)
    vc.setWheelSteering(0, -this.steerAngle)
    // Air drag + rolling resistance.
    const lv = this.body.linvel()
    const sp = Math.hypot(lv.x, lv.y, lv.z)
    if (sp > 0.05) {
      const drag = 0.45 * sp * sp + 0.008 * BikeSim.MASS * GRAVITY
      this.body.addForce({ x: (-lv.x / sp) * drag, y: (-lv.y / sp) * drag, z: (-lv.z / sp) * drag }, true)
    }
  }

  /**
   * BALANCE, after the tyre impulses of the step (side friction at ground level is what tips a bike over):
   * steady-state turn lean φ = atan(v²·tanδ / (g·L)). Roll is a HARD constraint while the rider balances — the
   * orientation is rebuilt from the simulated heading + pitch with the lean eased toward φ, and the roll part of
   * the spin is removed. (A torque PD on the tiny centre-of-mass roll inertia explodes at 60 Hz, and a soft
   * roll-rate servo loses to the tyres above ~8 m/s — measured.) Everything else stays simulated; with
   * balancing off (crash) the constraint is released and the bike falls over under gravity.
   */
  protected afterWheels(dt: number, v: number): void {
    const { roll, pitch } = this.attitude()
    this.lean = roll
    if (!this.balancing) {
      this.targetLean = roll
      return
    }
    const phi = Math.atan((v * v * Math.tan(this.steerAngle)) / (GRAVITY * this.wheelbase))
    this.targetLean = Math.max(-0.7, Math.min(0.7, phi))
    const r = roll + (this.targetLean - roll) * Math.min(1, dt * 7)
    const h = this.heading
    // q = yaw(h, +Y) · pitch(p, +X) · roll(r, about the forward −Z axis: + lowers the right side)
    const cy = Math.cos(h / 2), sy = Math.sin(h / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2), cr = Math.cos(r / 2), sr = Math.sin(r / 2)
    const qy = { w: cy, x: 0, y: sy, z: 0 }, qp = { w: cp, x: sp, y: 0, z: 0 }, qr = { w: cr, x: 0, y: 0, z: -sr }
    const mul = (a: typeof qy, b: typeof qy) => ({
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z, x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    })
    this.body.setRotation(mul(mul(qy, qp), qr), true)
    const { f } = this.axes()
    const w = this.body.angvel()
    const rr = w.x * f[0] + w.y * f[1] + w.z * f[2]
    this.body.setAngvel({ x: w.x - f[0] * rr, y: w.y - f[1] * rr, z: w.z - f[2] * rr }, true)
  }
}
