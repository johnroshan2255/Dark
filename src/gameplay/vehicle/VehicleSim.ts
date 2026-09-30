import type RAPIER from '@dimforge/rapier3d-compat'
import { group, Groups, type PhysicsWorld } from '../../physics/PhysicsWorld'

/**
 * VEHICLE SIMULATION (no rendering — tested in Node, tests/vehicle.test.ts). Both vehicles are real Rapier
 * DYNAMIC bodies driven by Rapier's DynamicRayCastVehicleController (the Bullet raycast-vehicle model):
 * per-wheel suspension springs + dampers (forces scale with chassis mass), engine force, brakes, steering,
 * tyre friction with a traction limit (frictionSlip ≈ μ) and side grip. On top of it:
 *   TRUCK  4WD with a torque/power curve (strong low-speed pull for hills, power-limited top speed), air drag +
 *          rolling resistance, speed-sensitive steering, handbrake = locked + slippery rear (slides), anti-roll
 *          assist (anti-roll bars), auto-righting after a rollover, and a DRIFT mode (see TruckSim.drive).
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
  /** Nobody at the controls (parked): the brakes are locked and it never creeps or rolls away. */
  parked?: boolean
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
    this.holding = false
    this.drive(dt, this.speed)
    this.vc.updateVehicle(dt, undefined, RAY_GROUPS, (c) => c.parent()?.handle !== this.body.handle)
    this.afterWheels(dt, this.speed)
    // Hill hold, AFTER the tyre impulses (they re-add a little drift every step): the horizontal velocity and
    // the yaw spin are cancelled, the suspension keeps settling vertically.
    if (this.holding) {
      const v = this.body.linvel()
      this.body.setLinvel({ x: 0, y: v.y, z: 0 }, false) // vertical kept: the suspension must still settle
      const w = this.body.angvel()
      this.body.setAngvel({ x: w.x * 0.5, y: 0, z: w.z * 0.5 }, false)
    }
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]
      const len = this.vc.wheelSuspensionLength(i) ?? this.spec.suspension.rest
      w.lift = this.spec.suspension.rest - this.sag - len
      w.spin = this.vc.wheelRotation(i) ?? 0
      w.steer = -(this.vc.wheelSteering(i) ?? 0)
      w.contact = this.vc.wheelIsInContact(i)
    }
  }

  private holding = false
  /** Hill hold this step (applied after the tyre impulses in `step`). */
  protected hold(): void {
    this.holding = true
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

/** The tunable part of a truck's setup (gameplay/vehicle/catalogue.ts `VehicleTuning`, minus paint). */
export interface TruckTune {
  /** kW */
  power: number
  /** kN on the flat */
  force: number
  boost: number
  grip: number
  suspension: number
  tyre: number
  mass: number
}
export const STOCK_TRUCK: TruckTune = { power: 120, force: 12, boost: 2.2, grip: 2.4, suspension: 36, tyre: 1, mass: 1750 }

export class TruckSim extends VehicleBase {
  /** Extra force an automatic low range adds nose-up, per kg (m·g·sin 60° for 1750 kg ≈ 24 kN). */
  static readonly LOW_RANGE_PER_KG = 24000 / 1750
  private upsideDown = 0
  /** Live setup (retune() changes it in place). */
  readonly tune: TruckTune
  private readonly colliders: RAPIER.Collider[] = []
  private readonly massShare = [0.85, 0.1, 0.05]
  private readonly baseRadius: number
  /** Drift state. `lateral`: sideways speed of the chassis (m/s, + = sliding to the right); `drift`: smoothed
   *  0..1 slide amount (camera / audio / HUD); `wheelSlip[i]`: 0..1 tyre slip per wheel (tyre smoke, dust). */
  lateral = 0
  drift = 0
  drifting = false
  readonly wheelSlip = [0, 0, 0, 0]
  private driftHold = 0

  constructor(physics: PhysicsWorld, d: TruckDims, tune: TruckTune = STOCK_TRUCK) {
    const h = d.half
    const t = { ...tune }
    const r = d.wheelRadius * t.tyre
    super(physics, {
      mass: t.mass,
      // Heavy low frame (engine, axles, fuel) + light cab/bed → centre of mass ≈ 0.62 m: rollover ≈ 1.2 g sideways,
      // back-flip tip-over ≈ 68° on a climb.
      boxes: [
        { half: [h.x * 0.9, 0.2, h.z * 0.93], at: [0, 0.54, 0], mass: t.mass * 0.85 },
        { half: [h.x * 0.86, 0.42, h.z * 0.36], at: [0, 1.28, -h.z * 0.1], mass: t.mass * 0.1 },
        { half: [h.x * 0.88, 0.2, h.z * 0.42], at: [0, 1.05, h.z * 0.55], mass: t.mass * 0.05 },
      ],
      // Bigger tyres lift the hubs so the tread still sits on the ground.
      wheels: d.wheelPos.map((p, i) => ({ hub: [p[0], p[1] + (r - d.wheelRadius), p[2]] as [number, number, number], radius: r, front: i < 2 })),
      suspension: { rest: 0.32, travel: 0.24, stiffness: t.suspension, compression: 2.6, relaxation: 3.8 },
      frictionSlip: t.grip,
      sideStiffness: 0.55,
    })
    this.tune = t
    this.baseRadius = d.wheelRadius
    // Keep the colliders for live retuning (mass).
    for (let i = 0; i < this.body.numColliders(); i++) this.colliders.push(this.body.collider(i))
  }

  /** Change the setup live (garage sliders): mass, springs, grip and tyre size go straight to Rapier. */
  retune(t: Partial<TruckTune>): void {
    Object.assign(this.tune, t)
    if (t.mass !== undefined) this.colliders.forEach((c, i) => c.setMass(this.tune.mass * (this.massShare[i] ?? 0)))
    for (let i = 0; i < 4; i++) {
      if (t.suspension !== undefined) this.vc.setWheelSuspensionStiffness(i, this.tune.suspension)
      if (t.grip !== undefined) this.vc.setWheelFrictionSlip(i, this.tune.grip)
      if (t.tyre !== undefined) {
        const r = this.baseRadius * this.tune.tyre
        this.vc.setWheelRadius(i, r)
        const hub = this.spec.wheels[i].hub
        const sag = GRAVITY / (4 * this.tune.suspension)
        this.vc.setWheelChassisConnectionPointCs(i, { x: hub[0], y: hub[1] + (r - this.baseRadius) + this.spec.suspension.rest - sag, z: hub[2] })
      }
    }
  }

  /** Current tyre radius (m). */
  get wheelRadius(): number {
    return this.baseRadius * this.tune.tyre
  }

  protected drive(dt: number, v: number): void {
    const c = this.controls
    const vc = this.vc
    const T = this.tune
    const m = T.mass
    const av = Math.abs(v)
    // Engine: constant force at low speed (gearing), constant power above it; boost = more power.
    // BOOST (Shift / touch BOOST): a real kick — 2.2× power, 1.4× force cap, and a lower drag ceiling
    // (top ≈ 90 km/h → ≈ 125 km/h); measured 0→72 km/h 4.7 s → ~3 s.
    const power = T.power * 1000 * (c.boost ? T.boost : 1)
    const climb = Math.max(0, Math.sin(this.attitude().pitch)) // automatic low range on steep uphill
    const maxForce = T.force * 1000 * (c.boost ? 1.4 : 1) + TruckSim.LOW_RANGE_PER_KG * m * Math.min(1, climb * 1.3)
    const pull = Math.min(maxForce, (power * (1 + climb * 2)) / Math.max(av, 0.5))
    // DRIFT: the rear steps out on the handbrake (Space / touch JUMP) at speed, or on a boosted power slide
    // (Shift + steer); once the truck is sliding it stays in drift mode ~0.35 s after the trigger lets go, so
    // throttle + counter-steer hold the slide. While drifting the rear tyres keep only ~10 % of their side
    // grip (the front keeps most of it, so counter-steering bites), the drive is biased to the rear axle, the
    // steering lock opens up at speed, and a spin guard damps the yaw once the slide passes ~60°.
    const { r: right } = this.axes()
    const lv0 = this.body.linvel()
    this.lateral = lv0.x * right[0] + lv0.y * right[1] + lv0.z * right[2]
    const slipAngle = Math.atan2(Math.abs(this.lateral), Math.max(av, 0.5))
    const trigger = (c.handbrake && av > 3) || (c.boost && Math.abs(c.steer) > 0.3 && av > 7)
    if (trigger || (slipAngle > 0.28 && av > 4)) this.driftHold = 0.35
    else this.driftHold = Math.max(0, this.driftHold - dt)
    const drifting = (this.drifting = trigger || this.driftHold > 0)
    this.drift += ((drifting ? Math.min(1, slipAngle / 0.6) : 0) - this.drift) * Math.min(1, dt * 8)
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
    // HILL HOLD: parked, or idle at a crawl, the brakes lock and the chassis is held — a truck left on a slope
    // used to creep backwards (~0.25 m/s) through the raycast tyres' low-speed drift.
    if (c.parked || (Math.abs(c.throttle) < 0.01 && av < 1.2)) {
      brake = 1
      this.hold()
    }
    // Brake impulse per wheel per step: ~1 g of deceleration at full pedal (tyres limit it further).
    const brakeImp = (brake * m * GRAVITY * 0.5 * dt) / 4
    // Steering: full lock slow, much less at speed (stable at 25 m/s); smoothed like a steering rack.
    const lock = 0.62 / (1 + av * (drifting ? 0.05 : 0.12))
    this.steerAngle += (c.steer * lock - this.steerAngle) * Math.min(1, dt * (c.steer === 0 ? 7 : drifting ? 8 : 5))
    // 4×4 with traction control: drive split by each wheel's load (last step's suspension force) — on a steep
    // climb the weight sits on the rear axle and an equal split would waste the drive on the light front wheels.
    let load = 0
    const n = [0, 1, 2, 3].map((i) => (this.wheels[i].contact ? Math.max(0, vc.wheelSuspensionForce(i) ?? 0) : 0))
    for (const x of n) load += x
    const burnout = c.throttle > 0.9 && av < 2.5 && !c.handbrake
    for (let i = 0; i < 4; i++) {
      const front = i < 2
      // Drifting: 75 % of the drive on the rear axle (the slide is held on the throttle); else by wheel load.
      vc.setWheelEngineForce(i, drifting ? (engine * (front ? 0.25 : 0.75)) / 2 : load > 1 ? (engine * n[i]) / load : engine / 4)
      const hb = c.handbrake && !front
      vc.setWheelBrake(i, hb ? (m * GRAVITY * 1.2 * dt) / 4 : brakeImp)
      // Side stiffness is the share of the lateral velocity the tyre cancels PER STEP (Bullet model): 0.55 holds
      // the line within a few frames; a sliding rear needs ~0.05 (time constant ≈ 0.3 s) to step out and stay out.
      vc.setWheelSideFrictionStiffness(i, hb ? 0.03 : drifting ? (front ? 0.5 : 0.06) : 0.55)
      // Tyre slip for the effects: sideways slide (rear counts fully), a locked rear on the handbrake, a burnout.
      const w = this.wheels[i]
      const slide = Math.min(1, Math.abs(this.lateral) / 6) * (front ? 0.45 : 1)
      const spin = burnout && w.contact ? 0.55 : 0
      const target = w.contact ? Math.max(slide * (drifting ? 1 : 0.5), hb && av > 2 ? 0.7 : 0, spin) : 0
      this.wheelSlip[i] += (target - this.wheelSlip[i]) * Math.min(1, dt * 10)
      // Ackermann-ish: the inner front wheel turns a little more.
      if (front) vc.setWheelSteering(i, -this.steerAngle * (1 + 0.08 * Math.sign(this.steerAngle) * (i === 1 ? 1 : -1)))
    }
    // Aerodynamic drag (terminal ≈ 30 m/s on the flat) + rolling resistance, opposite to the velocity.
    const lv = this.body.linvel()
    const sp = Math.hypot(lv.x, lv.y, lv.z)
    if (sp > 0.05) {
      const drag = (c.boost ? 3.4 : 5.6) * (m / 1750) * sp * sp + 0.012 * m * GRAVITY
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
      // Drift spin guard: past ~60° of slide the yaw rate is damped so a slide ends in a save, not a spin.
      if (drifting && slipAngle > 1.0) {
        const yawRate = w.x * u[0] + w.y * u[1] + w.z * u[2]
        const ty = -yawRate * m * 1.6 * Math.min(1, (slipAngle - 1.0) * 2)
        this.body.addTorque({ x: u[0] * ty, y: u[1] * ty, z: u[2] * ty }, true)
      }
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
    // Hill hold: a foot down — stopped on a slope with no pedalling, the bike stays put (it rolled backwards).
    if (c.parked || (Math.abs(c.throttle) < 0.01 && av < 0.8)) {
      brake = 1
      this.hold()
    }
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
