import type RAPIER from '@dimforge/rapier3d-compat'
import { group, Groups, type PhysicsWorld } from '../../physics/PhysicsWorld'
import { Drivetrain, type ChassisIn, type DriverInput, type WheelIn } from './drivetrain/Drivetrain'
import type { Resolved } from './drivetrain/spec'
import { Surf, TYRE_KINDS, gripFor, roughness, surfaceMix, type SurfaceMix } from './drivetrain/tyre'

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
/** The GROUND alone (terrain, road ribbon, formation floors): what the wheel rays see in the drivetrain mode — stones,
 *  props and kerbs reach the wheel only through the tyre envelope, measured against this same ground (once). */
const GROUND_GROUPS = group(0xffff, Groups.Terrain | Groups.StaticMesh)
/** Real gravity: the realistic drivetrain runs the car at 9.81 (body gravity scale) so real numbers work unchanged. */
const G_REAL = 9.81
/** The steepest slope the climb assist lets the tyres feel (rad, ≈ 26°). */
const SLOPE_EFF = 0.45

export interface Controls {
  /** Nobody at the controls (parked): the brakes are locked and it never creeps or rolls away. */
  parked?: boolean
  /** −1 … 1 (W/S or stick). */
  throttle: number
  /** −1 … 1 (D = +1 = right). */
  steer: number
  handbrake: boolean
  boost: boolean
  /** The brake (S / stick back) is pressed, even while the throttle is held too — arcade: a tap while steering
   *  at speed starts a drift (Asphalt). */
  brake?: boolean
  /** 0..1 foot brake held TOGETHER with the gas (W + S, touch DRIFT + stick forward at a standstill) — Simulation
   *  handling: left-foot braking / a brake-stand burnout (Drivetrain `DriverInput.brake`). */
  footBrake?: number
  /** −1 … 1 (↓ / ↑, touch ▼ ▲): on the ground raises / lowers the body (air suspension); flying = climb / sink. */
  lift?: number
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

/** A massless collision piece: a convex hull of points (xyz…), a capsule a → b of radius r, a box, or the exact body
 *  as a triangle soup (xyz… per corner; Groups.VehicleMesh — the hulls then only meet terrain and formations). */
export type Shape =
  | { hull: Float32Array }
  | { trimesh: Float32Array }
  | { capsule: [[number, number, number], [number, number, number], number] }
  | { box: [number, number, number]; at: [number, number, number] }

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
  /** Collision shapes from the model (chassis space). Given: they collide and the boxes only carry the mass. */
  shapes?: Shape[]
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
  /** Signed rim speed of the wheels (m/s, + = rolling forward): the spin rate × radius averaged over the wheels —
   *  faster than `speed` in a burnout or a drift, slower on locked brakes. The engine note follows it. */
  wheelSpeed = 0
  /** Chassis velocity at the start of the last step (before contacts) — a smashed prop gives most of it back. */
  readonly preVel = { x: 0, y: 0, z: 0 }
  protected steerAngle = 0
  protected readonly R: typeof RAPIER
  /** Per wheel: suspension rest length (without the air-suspension ride) and static sag — the rendered `lift`. */
  protected readonly restW: number[]
  protected readonly sagW: number[]
  /** Per wheel: the ground-roughness bump under it this step (m, + = the ground is higher) — the wheel rides it. */
  protected readonly bumpW = [0, 0, 0, 0, 0, 0, 0, 0]

  constructor(
    protected readonly physics: PhysicsWorld,
    protected readonly spec: SimSpec,
  ) {
    const R = (this.R = physics.R)
    this.body = physics.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setCanSleep(true).setAngularDamping(0.4).setLinearDamping(0.02).setCcdEnabled(true),
    )
    const groups = group(Groups.Vehicle, 0xffff & ~Groups.Player)
    if (spec.shapes) {
      // With the exact mesh: it meets EVERYTHING — rocks, trunks, props, debris, monsters, the bike, the formation and
      // road-ribbon trimeshes, and the terrain as PhysicsWorld.vehicleGround's trimesh copy (Rapier has no trimesh ⇄
      // heightfield contact). The hulls are then an inset BACKSTOP against the heightfield and formations: strictly
      // inside the body, they touch only if the thin mesh were ever pushed through the ground (a hard landing).
      const exact = spec.shapes.some((s) => 'trimesh' in s)
      for (const s of spec.shapes) {
        const d = shapeDesc(R, s)
        const g = 'trimesh' in s ? group(Groups.VehicleMesh, 0xffff & ~Groups.Player & ~Groups.Terrain)
          : exact ? group(Groups.Vehicle, Groups.Terrain | Groups.StaticMesh) : groups
        if (d) {
          const col = physics.world.createCollider(d.setDensity(0).setFriction(0.35).setRestitution(0.05).setCollisionGroups(g), this.body)
          if ('trimesh' in s) (this.meshCollider = col), (this.meshGroups = g)
        }
      }
      this.boxMass(spec.mass)
    } else {
      for (const b of spec.boxes) {
        physics.world.createCollider(
          R.ColliderDesc.cuboid(...b.half).setTranslation(...b.at).setMass(b.mass).setFriction(0.35).setRestitution(0.05).setCollisionGroups(groups),
          this.body,
        )
      }
    }
    const vc = (this.vc = physics.world.createVehicleController(this.body))
    vc.indexUpAxis = 1
    ;(vc as unknown as { setIndexForwardAxis: number }).setIndexForwardAxis = 2
    const s = spec.suspension
    // Static sag: all wheels share the weight → k·x·m·n = m·g ⇒ x = g / (n·k). Mount the ray so the wheel sits
    // at its design hub height when the truck rests on flat ground.
    const sag = GRAVITY / (spec.wheels.length * s.stiffness)
    this.restW = spec.wheels.map(() => s.rest)
    this.sagW = spec.wheels.map(() => sag)
    spec.wheels.forEach((w, i) => {
      vc.addWheel({ x: w.hub[0], y: w.hub[1] + s.rest - sag, z: w.hub[2] }, { x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 }, s.rest, w.radius)
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

  /** Mass, centre of mass and inertia of the spec's boxes scaled to `total` kg, on the body (the shape colliders
   *  are massless). Products of inertia are dropped (the boxes sit on the centre line). */
  protected boxMass(total: number): void {
    const bs = this.spec.boxes, sum = bs.reduce((s, b) => s + b.mass, 0)
    let cx = 0, cy = 0, cz = 0
    for (const b of bs) (cx += b.mass * b.at[0]), (cy += b.mass * b.at[1]), (cz += b.mass * b.at[2])
    cx /= sum; cy /= sum; cz /= sum
    let ix = 0, iy = 0, iz = 0
    for (const b of bs) {
      const m = (b.mass / sum) * total, [hx, hy, hz] = b.half, dx = b.at[0] - cx, dy = b.at[1] - cy, dz = b.at[2] - cz
      ix += (m / 3) * (hy * hy + hz * hz) + m * (dy * dy + dz * dz)
      iy += (m / 3) * (hx * hx + hz * hz) + m * (dx * dx + dz * dz)
      iz += (m / 3) * (hx * hx + hy * hy) + m * (dx * dx + dy * dy)
    }
    this.body.setAdditionalMassProperties(total, { x: cx, y: cy, z: cz }, { x: ix, y: iy, z: iz }, { x: 0, y: 0, z: 0, w: 1 }, true)
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

  /** What the wheel rays see (collision groups). */
  protected wheelRayGroups(): number {
    return RAY_GROUPS
  }
  /** Drive forces for this step (engine per wheel, brakes, steering, extra body forces). */
  protected abstract drive(dt: number, v: number): void
  /** After the tyre impulses of this step (velocity-level corrections, e.g. the bike's balance). */
  protected afterWheels(_dt: number, _v: number): void {}
  /** Replaces the wheel step entirely this step (the truck's hover flight); false = drive on the wheels. */
  protected hoverStep(_dt: number): boolean {
    return false
  }

  /** The exact body collider (trimesh) when the car has one — swapped for the dented shape (Damage). */
  private meshCollider: RAPIER.Collider | null = null
  private meshGroups = 0
  /** Replace the exact body collider with a deformed copy of the mesh (xyz… per corner; Damage after a crash). */
  replaceMesh(tris: Float32Array): void {
    if (!this.meshCollider) return
    const d = shapeDesc(this.R, { trimesh: tris })
    if (!d) return
    const w = this.physics.world
    const old = this.meshCollider
    this.meshCollider = w.createCollider(d.setDensity(0).setFriction(0.35).setRestitution(0.05).setCollisionGroups(this.meshGroups), this.body)
    this.colliderSwapped(old, this.meshCollider)
    w.removeCollider(old, false)
  }
  /** A body collider was replaced (subclasses keeping collider lists update them). */
  protected colliderSwapped(_old: RAPIER.Collider, _now: RAPIER.Collider): void {}

  /**
   * UNHOOK (Car, every fixed step): a crash dents the hollow body mesh (Damage → replaceMesh) around a trunk or
   * post, which then holds it from the inside — backing away pulled the bumper's inner face against the trunk and
   * the car sat still under full reverse ("stuck", reload); the same with the ground's trimesh caught inside the
   * body. Stalled (< 0.4 m/s) under throttle for 1.2 s, pushing AWAY from a prop the mesh touches or with the mesh
   * on the ground's trimesh: the mesh ignores props and the ground trimesh for 0.6 s (the hulls still stand on the
   * heightfield and rock formations) and the car drives out. Pushing INTO a prop stays a wall. `push` = the
   * throttle's direction (+ forward, − reverse, 0 none).
   * Cost: one contact-pair walk of the mesh collider per step while stalled under throttle, else nothing.
   */
  unhook(dt: number, push: number): void {
    const mc = this.meshCollider
    if (!mc) return
    if (this.ghost > 0) {
      if ((this.ghost -= dt) <= 0) mc.setCollisionGroups(this.meshGroups)
      return
    }
    if (push === 0 || Math.abs(this.speed) > 0.4) return void (this.hooked = 0)
    const { f } = this.axes(), w = this.physics.world, t = this.body.translation()
    let away = false
    w.contactPairsWith(mc, (o) => {
      const member = o.collisionGroups() >>> 16
      if (away) return
      // The ground's trimesh inside the hollow body (the rear down on its bump stops over a crest or a ditch):
      // contacts from above AND below clamp the car where it is.
      if (member & Groups.TerrainMesh) return w.contactPair(mc, o, (m) => void (m.numContacts() && (away = true)))
      if (!(member & Groups.Static) || member & Groups.StaticMesh) return
      w.contactPair(mc, o, (m) => {
        if (!m.numContacts()) return
        // (a trunk's collider sits at the trunk: its direction in the ground plane says ahead or behind)
        const p = o.translation(), dx = p.x - t.x, dz = p.z - t.z
        const ahead = (dx * f[0] + dz * f[2]) / Math.max(0.1, Math.hypot(dx, dz))
        if (ahead * push < -0.2) away = true
      })
    })
    this.hooked = away ? this.hooked + dt : 0
    if (this.hooked > 1.2) {
      this.hooked = 0
      this.ghost = 0.6
      mc.setCollisionGroups(this.meshGroups & ~(Groups.Static | Groups.TerrainMesh))
    }
  }
  private hooked = 0
  private ghost = 0

  /** One fixed step: controls → wheel forces → raycast vehicle update. Call before world.step(). */
  step(dt: number): void {
    if (!this.enabled) return
    const lv = this.body.linvel()
    this.preVel.x = lv.x; this.preVel.y = lv.y; this.preVel.z = lv.z
    const { f } = this.axes()
    this.speed = lv.x * f[0] + lv.y * f[1] + lv.z * f[2]
    this.body.resetForces(false)
    this.body.resetTorques(false)
    const moving = Math.abs(this.speed) > 0.05 || Math.abs(this.controls.throttle) > 0.01
    if (moving) this.body.wakeUp()
    this.holding = false
    if (this.hoverStep(dt)) {
      for (const w of this.wheels) (w.contact = false), (w.lift *= 1 - Math.min(1, dt * 6))
      this.wheelSpeed = this.speed
      return
    }
    this.drive(dt, this.speed)
    this.vc.updateVehicle(dt, undefined, this.wheelRayGroups(), (c) => c.parent()?.handle !== this.body.handle)
    this.afterWheels(dt, this.speed)
    // Hill hold, AFTER the tyre impulses (they re-add a little drift every step): the horizontal velocity and
    // the yaw spin are cancelled, the suspension keeps settling vertically.
    if (this.holding) {
      const v = this.body.linvel()
      this.body.setLinvel({ x: 0, y: v.y, z: 0 }, false) // vertical kept: the suspension must still settle
      const w = this.body.angvel()
      this.body.setAngvel({ x: w.x * 0.5, y: 0, z: w.z * 0.5 }, false)
    }
    let rim = 0
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]
      const len = this.vc.wheelSuspensionLength(i) ?? this.restW[i]
      w.lift = this.restW[i] - this.sagW[i] - len + this.bumpW[i]
      const spin = this.drawnSpin(i) ?? this.vc.wheelRotation(i) ?? 0
      rim += ((spin - w.spin) / dt) * this.spec.wheels[i].radius
      w.spin = spin
      w.steer = -(this.vc.wheelSteering(i) ?? 0)
      w.contact = this.vc.wheelIsInContact(i)
    }
    const ws = rim / Math.max(1, this.wheels.length)
    this.wheelSpeed = Number.isFinite(ws) ? ws : this.speed
  }

  /** The wheel's own spin angle (rad) when a model simulates it (the drivetrain: wheelspin, locked brakes, a wheel
   *  spinning in the air); null = Rapier's, which only rolls the wheel with the ground under it. */
  protected drawnSpin(_i: number): number | null {
    return null
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
  /** Height (m, truck space) of the body's underside ahead of the front / behind the rear wheels — the bumper
   *  collision boxes start there. Absent: the frame height (0.34 m). */
  overhang?: { front: number; rear: number }
  /** Body collision hulls cut from the mesh (gameplay/vehicle/hulls); absent: the frame + cab boxes collide. */
  hulls?: Float32Array[]
  /** The body's render triangles (xyz… per corner, closed doors): the exact collider for everything but terrain. */
  mesh?: Float32Array
  /** Half the tyre width (m): the tyre envelope also samples the tread edges. Absent: the centre line only. */
  tyreHalfWidth?: number
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
  protected colliderSwapped(old: RAPIER.Collider, now: RAPIER.Collider): void {
    const i = this.colliders.indexOf(old)
    if (i >= 0) this.colliders[i] = now
  }
  /** Each collider's share of the mass (legacy model), in creation order. */
  private readonly massShare: number[]
  private readonly baseRadius: number
  private readonly dims: TruckDims
  /** Drift state. `lateral`: sideways speed of the chassis (m/s, + = sliding to the right); `drift`: smoothed
   *  0..1 slide amount (camera / audio / HUD); `wheelSlip[i]`: 0..1 tyre slip per wheel (tyre smoke, dust). */
  lateral = 0
  drift = 0
  drifting = false
  readonly wheelSlip = [0, 0, 0, 0]
  private driftHold = 0
  /**
   * ARCADE handling (Asphalt-style option, Settings → Handling; the default is the realistic model): Rapier
   * still does suspension, contacts and crashes, but the feel is scripted — punchy acceleration to a high top speed, the car goes where
   * it points (no understeer), DRIFT by tapping the brake (or the handbrake) while steering at speed: the slide
   * holds a 20–45° angle, keeps its speed and fills the NITRO bar; nitro (Shift / BOOST) burns it for a big kick;
   * in the air the car levels itself and lands on its wheels; it practically never rolls. Off = the realistic
   * model above (power-limited, real tyre grip) — tests cover both.
   */
  arcade = false
  /** Nitro bar 0..1 (arcade): filled by drifting, air time and smashing props; burnt by the boost. */
  nitro = 1
  /** Nitro burning this step (arcade). */
  nitroOn = false
  /** Seconds airborne (all wheels off the ground). */
  airTime = 0
  /** Arcade drift direction: −1 sliding into a left turn, +1 right, 0 gripping. */
  private driftDir = 0
  private driftExit = 0
  private steerIn = 0

  constructor(physics: PhysicsWorld, d: TruckDims, tune: TruckTune = STOCK_TRUCK) {
    const h = d.half
    const t = { ...tune }
    const r = d.wheelRadius * t.tyre
    super(physics, {
      mass: t.mass,
      // Heavy low frame (engine, axles, fuel) + light cab/bed → centre of mass ≈ 0.62 m: rollover ≈ 1.2 g sideways,
      // back-flip tip-over ≈ 68° on a climb.
      // The low frame leaves the WHEELS free (a spine between them + bumpers + sills): the tyres meet stones and
      // kerbs through their rays (tyreEnvelope) and ride up them; a frame box over the wheel corners caught the
      // stone first and stopped the car dead.
      boxes: [
        ...frameBoxes(d, t.mass * 0.85),
        { half: [h.x * 0.86, 0.42, h.z * 0.36], at: [0, 1.28, -h.z * 0.1], mass: t.mass * 0.1 },
        { half: [h.x * 0.88, 0.2, h.z * 0.42], at: [0, 1.05, h.z * 0.55], mass: t.mass * 0.05 },
      ],
      // Bigger tyres lift the hubs so the tread still sits on the ground.
      wheels: d.wheelPos.map((p, i) => ({ hub: [p[0], p[1] + (r - d.wheelRadius), p[2]] as [number, number, number], radius: r, front: i < 2 })),
      suspension: { rest: 0.32, travel: 0.24, stiffness: t.suspension, compression: 2.6, relaxation: 3.8 },
      frictionSlip: t.grip,
      sideStiffness: 0.55,
      shapes: d.hulls && [...d.hulls.map((hull): Shape => ({ hull })), ...(d.mesh ? [{ trimesh: d.mesh }] : [])],
    })
    this.tune = t
    this.massShare = this.spec.boxes.map((b) => b.mass / t.mass)
    this.baseRadius = d.wheelRadius
    this.dims = d
    this.mode = 'legacy'
    // Keep the colliders for live retuning (mass).
    for (let i = 0; i < this.body.numColliders(); i++) this.colliders.push(this.body.collider(i))
  }

  /** ARCADE drive (see `arcade`): longitudinal force, drift state, nitro; the wheels roll free (visuals, contacts). */
  private driveArcade(dt: number, v: number): void {
    const c = this.controls, vc = this.vc, T = this.tune, m = T.mass
    const { f, u, r } = this.axes()
    const lv = this.body.linvel()
    const vf = v
    const vr = lv.x * r[0] + lv.y * r[1] + lv.z * r[2]
    const sp = Math.hypot(vf, vr)
    this.lateral = vr
      const contacts = this.wheels.filter((w) => w.contact).length
    // Arcade control only on ground that is ground (not a wall or a cliff the truck has run up).
    const grounded = contacts >= 2 && u[1] > 0.6
    this.airTime = contacts === 0 ? this.airTime + dt : 0
    this.steerIn += (c.steer - this.steerIn) * Math.min(1, dt * 12)
    // ---- drift state (Asphalt: tap the brake while steering at speed; or the handbrake) ----
    const steering = Math.abs(c.steer) > 0.3
    if (!this.driftDir && grounded && vf > 11 && steering && (c.handbrake || c.brake || c.throttle < -0.1)) {
      this.driftDir = Math.sign(c.steer)
      this.driftExit = 0
    }
    if (this.driftDir) {
      // Ends when the steer is released or turned the other way for a moment, or the speed is gone.
      const holding = c.steer * this.driftDir > 0.15
      this.driftExit = holding ? 0 : this.driftExit + dt
      if (this.driftExit > (c.steer * this.driftDir < -0.3 ? 0.12 : 0.3) || vf < 6) this.driftDir = 0
    }
    const drifting = (this.drifting = this.driftDir !== 0)
    const slip = Math.atan2(Math.abs(vr), Math.max(Math.abs(vf), 0.5))
    this.drift += ((drifting ? Math.min(1, slip / 0.5) : 0) - this.drift) * Math.min(1, dt * 8)
    // ---- nitro ----
    this.nitroOn = c.boost && this.nitro > 0.01 && c.throttle > -0.1 && vf > -1
    if (this.nitroOn) this.nitro = Math.max(0, this.nitro - dt * 0.28) // a full bar ≈ 3.6 s
    if (drifting && grounded) this.nitro = Math.min(1, this.nitro + dt * 0.24 * Math.min(1, slip / 0.35))
    if (this.airTime > 0.35) this.nitro = Math.min(1, this.nitro + dt * 0.15)
    // ---- longitudinal ----
    const top = arcadeTopSpeed(T) * (this.nitroOn ? 1.32 : 1)
    const A = (6 + 3 * (T.force / 12)) * Math.pow(1750 / m, 0.35) * (this.nitroOn ? 1.7 : 1)
    let a = 0
    const thr = this.nitroOn ? Math.max(1, c.throttle) : c.throttle
    if (c.parked || (Math.abs(thr) < 0.01 && Math.abs(vf) < 1.2 && !drifting)) {
      this.hold()
    } else if (thr > 0.01) {
      a = vf < -1 ? 22 * thr : A * thr * (1 - Math.min(1.2, (vf / top) ** 2))
    } else if (thr < -0.01) {
      if (vf > 1) a = drifting ? -3 * -thr : -22 * -thr // braking (a tap in a corner starts a drift instead)
      else a = vf > -9 ? -7 * -thr : 0 // reverse, ≤ 32 km/h
    } else {
      a = -Math.sign(vf) * (1.4 + 0.0006 * vf * vf) // coasting: engine braking + drag
    }
    if (drifting) a -= 0.03 * vf * (c.throttle > 0.1 ? 0.3 : 1) // a slide scrubs a little speed
    // Gentle hills matter less than in the sim (half of gravity's pull along the slope is cancelled) — never on
    // steep ground: no driving up walls.
    if (Math.abs(f[1]) < 0.3) a += 0.5 * 20 * f[1]
    if (grounded) {
      const F = m * a
      this.body.addForce({ x: f[0] * F, y: f[1] * F, z: f[2] * F }, true)
      // Downforce at speed, straight DOWN (along the chassis it glued the truck to walls): planted over crests
      // instead of floating (≈ +0.4 g at 50 m/s).
      this.body.addForce({ x: 0, y: -m * 0.0032 * sp * sp, z: 0 }, true)
    }
    // Wheels: rolling free (the force above drives the chassis), brakes only to hold still, steering for show.
    const lock = 0.55 / (1 + Math.abs(vf) * 0.04)
    this.steerAngle += ((drifting ? -this.driftDir * 0.35 + c.steer * 0.25 : c.steer * lock) - this.steerAngle) * Math.min(1, dt * 10)
    for (let i = 0; i < 4; i++) {
      const front = i < 2
      vc.setWheelEngineForce(i, 0)
      vc.setWheelBrake(i, c.parked || (Math.abs(thr) < 0.01 && Math.abs(vf) < 1.2 && !drifting) ? (m * 20 * 0.5 * dt) / 4 : 0)
      // Side grip is applied by afterWheels (velocity alignment); the tyres keep almost none of their own (0.12
      // per step killed every slide: time constant 0.14 s) — none at all in a drift.
      vc.setWheelSideFrictionStiffness(i, drifting ? 0 : 0.02)
      if (front) vc.setWheelSteering(i, -this.steerAngle)
      const w = this.wheels[i]
      const target = w.contact ? Math.max(drifting ? Math.min(1, slip / 0.35) * (front ? 0.45 : 1) : 0, thr > 0.9 && vf < 3 ? 0.5 : 0) : 0
      this.wheelSlip[i] += (target - this.wheelSlip[i]) * Math.min(1, dt * 10)
    }
  }

  /**
   * ARCADE grip, steering and air control at the velocity level, after the tyre impulses: the yaw rate is SET
   * from the stick (turn radius 5.5 m + 0.32 s × speed — tight and never understeering), the horizontal velocity
   * is ROTATED toward the nose keeping its length (grip without scrubbing speed: ~9 rad/s gripping, ~1.6 rad/s
   * in a drift so the slide holds its angle, capped at ~45°), roll is damped hard; airborne, the chassis levels
   * toward upright and the stick yaws it a little.
   */
  protected afterWheels(dt: number, v: number): void {
    if (this.mode === 'drivetrain') return this.afterReal(dt)
    if (!this.arcade || this.boat >= 0.5) return
    const { f, u, r } = this.axes()
    const lv = this.body.linvel(), w = this.body.angvel()
    const contacts = this.wheels.filter((x) => x.contact).length
    const st = this.steerIn
    const dd = this.driftDir
    if (contacts >= 2 && u[1] > 0.6) {
      const vf = lv.x * f[0] + lv.y * f[1] + lv.z * f[2]
      const vr = lv.x * r[0] + lv.y * r[1] + lv.z * r[2]
      const vu = lv.x * u[0] + lv.y * u[1] + lv.z * u[2]
      const dir = vf >= -0.5 ? 1 : -1
      // Turn radius grows with speed (9 m at 36 km/h, 40 m at 135, 60 m at 170): quick in town, carving at speed.
      const av = Math.abs(vf)
      const R = 5.5 + 0.2 * av + 0.02 * av * av
      let yawT = (-st * dir * av) / R
      const into = st * dd
      // In a drift the nose swings ~1.35× faster into the corner; counter-steer straightens it.
      if (dd) yawT = ((-dd * av) / R) * (into > 0 ? 1.1 + 0.35 * into : 0.3)
      yawT = Math.max(-2.2, Math.min(2.2, yawT))
      const wu = w.x * u[0] + w.y * u[1] + w.z * u[2]
      const wf = w.x * f[0] + w.y * f[1] + w.z * f[2]
      const dwu = (yawT - wu) * Math.min(1, dt * (dd ? 7 : 11))
      const dwf = -wf * Math.min(1, dt * 6) // roll damping
      this.body.setAngvel({ x: w.x + u[0] * dwu + f[0] * dwf, y: w.y + u[1] * dwu + f[1] * dwf, z: w.z + u[2] * dwu + f[2] * dwf }, true)
      // Velocity toward the nose (or the tail when reversing), keeping its length. In a drift it follows the nose
      // at the nose's own yaw rate, corrected toward a 30–40° slide (more with the stick held into the turn).
      // Error = the velocity's angle from the nose (forward) or from the tail (reversing), wrapped to ±π; the
      // velocity turns toward it. (Reversing used to turn it the WRONG way — the error doubled each step and
      // the truck stalled, rocking, instead of backing up.)
      const theta = Math.atan2(vr, vf)
      const slip = dir > 0 ? theta : Math.atan2(Math.sin(theta - Math.PI), Math.cos(theta - Math.PI))
      const target = 0.52 + 0.13 * Math.max(0, into)
      const rate = dd ? Math.max(0, Math.abs(wu) + 3 * (Math.abs(slip) - target)) : 9
      const turn = Math.sign(slip) * Math.min(Math.abs(slip), rate * dt)
      const ang = theta - turn
      const len = Math.hypot(vf, vr) * (dd ? 1 : 1 - 0.08 * Math.abs(turn))
      const nf = Math.cos(ang) * len, nr = Math.sin(ang) * len
      this.body.setLinvel({ x: f[0] * nf + r[0] * nr + u[0] * vu, y: f[1] * nf + r[1] * nr + u[1] * vu, z: f[2] * nf + r[2] * nr + u[2] * vu }, true)
    } else if (contacts === 0) {
      // Air: level out (pitch / roll toward upright), keep the yaw under the stick.
      const ex = -u[2], ez = u[0] // ω = u × worldUp = (−u.z, 0, u.x): rotates u toward up
      const k = Math.min(1, dt * 2.5)
      const yaw = -st * 1.4
      this.body.setAngvel({ x: w.x * (1 - k) + ex * 3 * k, y: w.y + (yaw - w.y) * Math.min(1, dt * 3), z: w.z * (1 - k) + ez * 3 * k }, true)
    }
    void v
  }

  /** Change the setup live (garage sliders): mass, springs, grip and tyre size go straight to Rapier (or, with
   *  the drivetrain active, into its spec-derived setup). */
  retune(t: Partial<TruckTune>): void {
    Object.assign(this.tune, t)
    if (this.mode === 'drivetrain') return this.configure('drivetrain')
    if (this.mode !== 'legacy') return
    if (t.mass !== undefined) {
      if (this.spec.shapes) this.boxMass(this.tune.mass)
      else this.colliders.forEach((c, i) => c.setMass(this.tune.mass * (this.massShare[i] ?? 0)))
    }
    for (let i = 0; i < 4; i++) {
      if (t.suspension !== undefined) this.vc.setWheelSuspensionStiffness(i, this.tune.suspension)
      if (t.grip !== undefined) this.vc.setWheelFrictionSlip(i, this.tune.grip)
      if (t.tyre !== undefined || t.suspension !== undefined) {
        const r = this.baseRadius * this.tune.tyre
        this.vc.setWheelRadius(i, r)
        const hub = this.spec.wheels[i].hub
        const sag = (this.sagW[i] = GRAVITY / (4 * this.tune.suspension))
        this.vc.setWheelChassisConnectionPointCs(i, { x: hub[0], y: hub[1] + (r - this.baseRadius) + this.spec.suspension.rest - sag, z: hub[2] })
      }
    }
  }

  // ======================= REALISTIC DRIVETRAIN (skills/realistic-vehicle-system) =======================

  /**
   * The car's spec-driven drivetrain (`setDrivetrain`), or null = the legacy realistic model. It runs whenever the
   * car is on its wheels in Simulation handling: not arcade, not flying, hull folded away (boat = 0) — the boat
   * and hover handling keep their own model and Rapier setup, and hand back here when they end.
   */
  drivetrain: Drivetrain | null = null
  /** The car's stock setup: the garage sliders scale the spec relative to it (power, mass, grip, springs). */
  private ref: TruckTune = { ...STOCK_TRUCK }
  private mode: 'legacy' | 'drivetrain' | 'none' = 'none'
  /** Surface under a world point (x, z) → weights + wetness. Set by Car; tests leave it on asphalt. */
  surface: (x: number, z: number, out: SurfaceMix) => void = () => {}
  private readonly mixes: SurfaceMix[] = []
  private surfI = 0
  private readonly wIn: WheelIn[] = []
  private readonly chIn: ChassisIn = { speed: 0, yawRate: 0, latAccel: 0, pitch: 0, g: G_REAL, rearVy: 0 }
  private readonly din: DriverInput = { throttle: 0, steer: 0, handbrake: false, boost: false, parked: false, brake: 0 }
  private readonly arb: number[] = []
  private readonly travelW: number[] = []
  private readonly kBump: number[] = []
  /** Per wheel: where the bump stop starts (compression, m) and the hard stop's rate past `travelW` (N/m). */
  private readonly bumpAt: number[] = []
  private readonly kHard: number[] = []
  /** Per wheel: the corner's static weight (N). */
  private readonly cornerW: number[] = []
  private readonly fc = [0, 0, 0]
  private readonly lc = [0, 0, 0]

  /** Install (or remove, null) the spec-driven drivetrain; `stock` = the catalogue's stock tuning. */
  setDrivetrain(R: Resolved | null, stock?: TruckTune): void {
    this.drivetrain = R ? new Drivetrain(R) : null
    if (stock) this.ref = { ...stock }
    this.mixes.length = this.wIn.length = 0
    for (let i = 0; i < 4; i++) {
      this.mixes.push(surfaceMix())
      this.wIn.push({ contact: false, Fz: 0, vx: 0, vy: 0, gx: 0, gy: 0, sx: 0, sy: 0, hx: 0, hy: 0 })
    }
    this.mode = 'none'
  }

  /** The drivetrain while it is the model driving the car (Simulation handling, on the wheels), else null —
   *  what the HUD, audio and effects read (the SIM owns every number). */
  get real(): Drivetrain | null {
    return this.mode === 'drivetrain' ? this.drivetrain : null
  }

  /** Tyre noise from the drivetrain (Simulation handling, null otherwise): the worst slide angle and wheelspin /
   *  lock of the wheels on the ground, what they stand on (hard / gravel / soft shares), and a tyre on fire
   *  (1: the crackle). Reused object. */
  tyreNoise(): { slide: number; spin: number; hard: number; gravel: number; soft: number; fire: number } | null {
    const D = this.real
    if (!D) return null
    const t = this.noiseOut
    t.slide = t.spin = t.hard = t.gravel = t.soft = 0
    t.fire = D.burning ? 1 : 0
    let n = 0
    for (let i = 0; i < 4; i++) {
      if (!this.wIn[i].contact) continue
      n++
      // (only a tyre really sliding over the ground: past its grip peak at a real sliding speed — Drivetrain slideVis)
      t.slide = Math.max(t.slide, D.slideVis[i])
      t.spin = Math.max(t.spin, D.skidVis[i])
      const w = this.mixes[i].w
      t.hard += w[0] + w[5]
      t.gravel += w[1]
      t.soft += w[2] + w[3] + w[4]
    }
    if (n) (t.hard /= n), (t.gravel /= n), (t.soft /= n)
    else t.hard = 1
    return t
  }
  private readonly noiseOut = { slide: 0, spin: 0, hard: 1, gravel: 0, soft: 0, fire: 0 }

  /**
   * OFF-ROAD ASSIST (gameplay, Settings; off = the real machine, as the tests drive it): engine torque × 1.6, and on
   * steep ground (slope > 20°, from the contact normals) a CLIMB ASSIST — torque up to × 2.2, 4H engaged, 1st held
   * at a crawl, and the slope limiter (afterReal): the tyres never feel more than ~26°.
   */
  offroadAssist = false

  /** The drivetrain's wheel spin (Simulation handling): a locked wheel stops, a spinning one spins — Rapier's
   *  rotation only follows the ground speed, so a handbrake slide or a burnout drew rolling wheels. */
  protected drawnSpin(i: number): number | null {
    return this.mode === 'drivetrain' && this.drivetrain ? this.drivetrain.spin[i] : null
  }

  /** Which model drives the car this step. */
  private wantMode(): 'legacy' | 'drivetrain' {
    return this.drivetrain && !this.arcade && !this.hover && this.boat === 0 ? 'drivetrain' : 'legacy'
  }

  /**
   * Set Rapier up for a model: DRIVETRAIN = real gravity (9.81 via the gravity scale), the spec's mass, COM and
   * inertia, per-axle springs from the ride frequency and damping ratio (Rapier multiplies them by the chassis
   * mass: k = s_w(2πf)², c = 2ζ√(k·s_w), sag = g/(2πf)²), and NO tyre friction (the drivetrain's tyre forces
   * replace it). LEGACY = the original setup (world gravity, collider masses, Rapier friction).
   */
  private configure(mode: 'legacy' | 'drivetrain'): void {
    const vc = this.vc, body = this.body
    const prev = this.mode
    this.mode = mode
    if (mode === 'legacy') {
      this.bumpW.fill(0)
      body.setGravityScale(1, true)
      body.setLinearDamping(0.02)
      body.setAngularDamping(0.4)
      if (this.spec.shapes) this.boxMass(this.tune.mass)
      else {
        body.setAdditionalMassProperties(0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, true)
        this.colliders.forEach((c, i) => c.setMass(this.tune.mass * (this.massShare[i] ?? 0)))
      }
      const s = this.spec.suspension
      const r = this.baseRadius * this.tune.tyre
      for (let i = 0; i < 4; i++) {
        const hub = this.spec.wheels[i].hub
        const sag = (this.sagW[i] = GRAVITY / (4 * this.tune.suspension))
        this.restW[i] = s.rest
        vc.setWheelRadius(i, r)
        vc.setWheelSuspensionRestLength(i, s.rest + this.ride)
        vc.setWheelMaxSuspensionTravel(i, s.travel)
        vc.setWheelSuspensionStiffness(i, this.tune.suspension)
        vc.setWheelSuspensionCompression(i, s.compression)
        vc.setWheelSuspensionRelaxation(i, s.relaxation)
        vc.setWheelMaxSuspensionForce(i, this.tune.mass * GRAVITY * 3)
        vc.setWheelFrictionSlip(i, this.tune.grip)
        vc.setWheelSideFrictionStiffness(i, 0.55)
        vc.setWheelChassisConnectionPointCs(i, { x: hub[0], y: hub[1] - this.baseRadius + r + s.rest - sag, z: hub[2] })
      }
      return
    }
    const D = this.drivetrain!, R = D.R, M = R.mass * (this.tune.mass / this.ref.mass)
    body.setGravityScale(G_REAL / GRAVITY, true)
    // No numerical damping beyond a trace: drag and rolling resistance are simulated.
    body.setLinearDamping(0)
    body.setAngularDamping(0.05)
    // Mass, COM (spec height and front share) and inertia of the body box (mass concentrated toward the middle).
    for (const c of this.colliders) c.setMass(1e-3)
    const h = this.dims.half
    const L = 2 * h.z * 0.85, W = 2 * h.x * 0.85, H = 2 * h.y * 0.6
    body.setAdditionalMassProperties(
      M,
      { x: 0, y: R.comHeight, z: R.comZ },
      { x: (M / 12) * (H * H + L * L), y: (M / 12) * (W * W + L * L), z: (M / 12) * (W * W + H * H) },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    )
    const fScale = Math.sqrt(Math.max(0.3, this.tune.suspension / this.ref.suspension))
    D.gripScale = this.tune.grip / this.ref.grip
    D.powerScale = this.tune.power / this.ref.power
    D.boostFactor = 1 + (this.tune.boost - 1) * 0.5
    D.retuneBrakes(M)
    const r = this.baseRadius * this.tune.tyre
    for (let i = 0; i < 4; i++) {
      const ax = R.axles[i >> 1]
      ax.radius = r
      const sw = ax.share / 2
      const w = 2 * Math.PI * ax.freq * fScale
      const k = sw * w * w
      const sag = G_REAL / (w * w)
      // COMPRESSION ROOM: 70 % of the axle's travel above the static sag, a progressive rubber bump stop over the
      // last 25 % of it (2 × the corner's weight at full bump), then a HARD stop (the axle on its stops: the wheel
      // lifts the body like a rigid strut). Rapier's own travel limit sits well past it — when Rapier clamped at
      // 55 % of the travel the spring went soft at its limit and a wheel on a 25 cm rock sank into it, bounced the
      // car off its wheels and stopped it, instead of climbing it with its shock squeezed.
      const T = ax.travel
      const travel = sag + 0.7 * T
      const rest = sag + 1.3 * T + 0.1
      this.sagW[i] = sag
      this.restW[i] = rest
      this.travelW[i] = travel
      this.bumpAt[i] = sag + 0.45 * T
      this.arb[i] = ax.arb * fScale * fScale
      this.kBump[i] = (32 * sw * M * G_REAL) / (T * T)
      this.kHard[i] = (12 * sw * M * G_REAL) / T
      this.cornerW[i] = sw * M * G_REAL
      const hub = this.spec.wheels[i].hub
      vc.setWheelRadius(i, r)
      vc.setWheelSuspensionRestLength(i, rest + this.ride)
      vc.setWheelMaxSuspensionTravel(i, sag + 1.3 * T)
      vc.setWheelSuspensionStiffness(i, k)
      // Damping is ours (afterReal: on the real compression rate, digressive); per kg of chassis, like Rapier's.
      this.dampB[i] = 2 * ax.zeta[0] * Math.sqrt(k * sw)
      this.dampR[i] = 2 * ax.zeta[1] * Math.sqrt(k * sw)
      vc.setWheelSuspensionCompression(i, 0)
      vc.setWheelSuspensionRelaxation(i, 0)
      this.xPrev[i] = this.sagW[i]
      vc.setWheelMaxSuspensionForce(i, M * G_REAL * 8)
      vc.setWheelFrictionSlip(i, 0)
      vc.setWheelSideFrictionStiffness(i, 0)
      vc.setWheelEngineForce(i, 0)
      vc.setWheelBrake(i, 0)
      vc.setWheelChassisConnectionPointCs(i, { x: hub[0], y: hub[1] - this.baseRadius + r + rest - sag, z: hub[2] })
    }
    if (prev !== 'drivetrain') {
      // Taking over (start, after the boat or the flight): wheels roll with the ground, the box in gear.
      D.reset()
      for (let i = 0; i < 4; i++) D.omega[i] = this.speed / r
      // The drawn wheels carry on from Rapier's angle (no jump in the picture or the rim-speed audio).
      for (let i = 0; i < 4; i++) D.spin[i] = vc.wheelRotation(i) ?? D.spin[i]
    }
  }

  /** Drivetrain mode: the wheel rays see the ground only — a stone is in the tyre envelope, counted once. (Both saw
   *  it: the envelope, cast before the step, and Rapier's ray during it, 4–5 cm further on — for one step the stone
   *  counted twice, the shock leapt 13 cm in 1/60 s onto its hard stop: ~20 × the corner's weight, the car thrown
   *  15 cm up off a 25 cm stone at 10 km/h, wheels in the air for half a second.) */
  protected override wheelRayGroups(): number {
    return this.mode === 'drivetrain' ? GROUND_GROUPS : RAY_GROUPS
  }

  /** Drivetrain mode, before the raycast update: the wheels' steering (for their axles); Rapier drives nothing. */
  private driveReal(dt: number): void {
    const D = this.drivetrain!, vc = this.vc
    const { f, u, r: rt } = this.axes()
    for (let i = 0; i < 4; i++) {
      vc.setWheelSteering(i, -D.steer[i])
      // GROUND ROUGHNESS (drivetrain/tyre.ts): the terrain mesh is smooth at wheel scale, so each wheel rides the
      // bumps, ruts and stones of its surface here — the rest length grows by the bump height (the spring sees
      // the ground raised exactly as a taller ray hit would), the rendered wheel lifts by it, and its rate goes
      // to the damper in afterReal. The TYRE ENVELOPES it (tyreEnvelope): a round tyre rolls up a stone, a kerb
      // or a log before its hub is over it, instead of the single ray dropping onto it in one step.
      const p = vc.wheelHardPoint(i)
      const d = D.steer[i], cd = Math.cos(d), sd = Math.sin(d)
      _hd[0] = f[0] * cd + rt[0] * sd; _hd[1] = f[1] * cd + rt[1] * sd; _hd[2] = f[2] * cd + rt[2] * sd
      // (rising at most 3 m/s: the tyre's sidewall takes the first instant of a sharp hit — a stone met at speed squeezes
      // the tyre, then the wheel climbs; without it the hub leapt 25 cm in two steps and the hit threw the car)
      const h = Math.min(p ? this.tyreEnvelope(i, p, _hd, u) : this.bumpW[i] * 0.8, this.bumpW[i] + 3 * dt)
      this.bumpW[i] = h
      vc.setWheelSuspensionRestLength(i, this.restW[i] + this.ride + h)
    }
    this.steerAngle = (D.steer[0] + D.steer[1]) / 2
  }
  /**
   * TYRE ENVELOPE (m): how much higher than under its hub the ground effectively is for wheel i. A rigid circle of
   * the tyre's radius rests on the highest point of the ground along its footprint arc: sampled at 0, ± 0.35 r, ± 0.7 r and ± 0.93 r
   * along the wheel's heading, each sample counts its height (terrain and obstacle colliders by ray, plus
   * the surface roughness) minus the circle's drop there, r − √(r² − d²). Before: the one ray met a 30 cm stone in
   * a single 60 Hz step at speed — 4–10 × load spikes and wheel hop; a real tyre swallows it over its footprint.
   * ACROSS THE TREAD: with the tyre's width known (TruckDims.tyreHalfWidth) the five middle samples are also cast at
   * both tread edges (± 0.85 of the half width) — a stone under the edge of the tyre lifts it too (the centre line
   * alone drove the tyre straight through a rock beside it).
   * Cost: 8 rays per wheel per fixed step (the ground under the hub + 7 samples), 18 with the tread edges (72 per
   * step, ≈ 75–140 µs on a phone), every tier.
   */
  private tyreEnvelope(i: number, hp: { x: number; y: number; z: number }, hd: number[], u: number[]): number {
    const vc = this.vc
    const r = vc.wheelRadius(i) ?? this.baseRadius * this.tune.tyre
    const L = this.restW[i] + this.ride + r * 1.6
    const mix = this.mixes[i]
    const ray = (this.envRay ??= new this.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }))
    ray.dir.x = -u[0]; ray.dir.y = -u[1]; ray.dir.z = -u[2]
    // The axle direction (heading × up) and the tread-edge offset.
    const e = (this.dims?.tyreHalfWidth ?? 0) * 0.85 * this.tune.tyre
    const ax = hd[1] * u[2] - hd[2] * u[1], ay = hd[2] * u[0] - hd[0] * u[2], az = hd[0] * u[1] - hd[1] * u[0]
    // The ground under the hub as the wheel ray sees it (GROUND_GROUPS): everything else is lift above it.
    ray.origin.x = hp.x; ray.origin.y = hp.y; ray.origin.z = hp.z
    const h0 = this.physics.world.castRay(ray, L, true, undefined, GROUND_GROUPS, undefined, this.body)
    const g0 = h0 ? L - h0.timeOfImpact : 0
    let hub = -Infinity, best = -Infinity
    for (let k = 0; k < ENV_D.length; k++) {
      const s = ENV_D[k] * r
      for (let side = 0; side < (e > 0 && k < 5 ? 3 : 1); side++) {
        const w = side === 0 ? 0 : side === 1 ? e : -e
        const ox = hp.x + hd[0] * s + ax * w, oy = hp.y + hd[1] * s + ay * w, oz = hp.z + hd[2] * s + az * w
        ray.origin.x = ox; ray.origin.y = oy; ray.origin.z = oz
        const hit = this.physics.world.castRay(ray, L, true, undefined, RAY_GROUPS, undefined, this.body)
        // Ground height above the ray's end, along the body's up axis (no hit = at the end: nothing to climb).
        const g = hit ? L - hit.timeOfImpact : 0
        const gx = ox - u[0] * (L - g), gz = oz - u[2] * (L - g)
        const hk = g + roughness(gx, gz, mix)
        const lift = hk - (r - Math.sqrt(r * r - s * s))
        if (k < 3 && lift > hub) hub = lift
        else if (lift > best) best = lift
      }
    }
    // Under the hub (± 0.35 r) the tyre stands on what is there, however tall (a boulder: up onto it); ahead / behind
    // a wall lifts it at most 0.8 r — taller than that it's a face the tyre is pushed against, not a step it climbs.
    // (negative = a dip the tyre sinks into: the roughness's troughs, never more than they are deep)
    return Math.max(hub - g0, Math.min(0.8 * r, best - g0))
  }
  private envRay: RAPIER.Ray | null = null
  /** Damper rates per wheel at low shaft speed, bump and rebound (N·s/m per kg of chassis, Rapier's units). */
  private readonly dampB: number[] = []
  private readonly dampR: number[] = []
  /** Last step's suspension compression per wheel (m) — the damper's shaft speed. */
  private readonly xPrev = [0, 0, 0, 0]

  /**
   * Drivetrain mode, after the raycast update (fresh contacts and spring forces): per wheel the load (spring +
   * anti-roll bar + bump stop), contact frame, patch velocity and surface → Drivetrain.step → its tyre forces at
   * the contact points; aero drag at the COM.
   */
  private afterReal(dt: number): void {
    const D = this.drivetrain!, vc = this.vc, body = this.body, R = D.R
    const { f, u, r: rt } = this.axes()
    const lv = body.linvel(), w = body.angvel()
    const com = body.worldCom()
    const t = body.translation(), q = body.rotation()
    // Surfaces: one wheel per step (deterministic), its grip re-blended.
    const si = this.surfI = (this.surfI + 1) % 4
    {
      const p = vc.wheelHardPoint(si) ?? t
      this.surface(p.x, p.z, this.mixes[si])
      const gp = gripFor(TYRE_KINDS[R.axles[si >> 1].tyreKind], this.mixes[si], D.gripScale, D.grips[si])
      // SNOW / MUD / SAND GRIP (off-road assist — like fitting chains or winter tyres): the soft-ground share of the
      // tyre's grip is raised to at least μ 0.55. Real summer tyres on snow (μ ≈ 0.3) left a rear-drive van stuck on
      // any snowy slope; the assist keeps snow slippery (it slides, it needs care) but drivable.
      if (this.offroadAssist) {
        const mw = this.mixes[si].w, soft = mw[Surf.Snow] + mw[Surf.Mud] + mw[Surf.Sand]
        if (soft > 0) gp.mu += Math.max(0, 0.55 * D.gripScale - gp.mu) * soft
      }
      // The air the tyre cools in, from the ground it stands on (desert sand hot, snow / ice cold), and the wet.
      const mw = this.mixes[si].w
      D.airT[si] = 20 + 15 * mw[Surf.Sand] - 24 * mw[Surf.Snow] - 28 * mw[Surf.Ice]
      D.wetT[si] = this.mixes[si].wet
    }
    // Suspension compression → anti-roll bars + bump stops.
    const x = _x
    for (let i = 0; i < 4; i++) x[i] = this.restW[i] + this.ride + this.bumpW[i] - (vc.wheelSuspensionLength(i) ?? this.restW[i] + this.ride)
    let contacts = 0
    for (let i = 0; i < 4; i++) {
      const wi = this.wIn[i]
      wi.contact = vc.wheelIsInContact(i)
      if (!wi.contact) {
        wi.Fz = wi.vx = wi.vy = wi.gx = wi.gy = wi.sx = wi.sy = wi.hx = wi.hy = 0
        this.xPrev[i] = 0 // full droop: a landing compresses from there
        continue
      }
      contacts++
      const pair = i ^ 1
      const arbF = this.arb[i] * (x[i] - x[pair])
      const bz = Math.min(x[i], this.travelW[i]) - this.bumpAt[i], hard = x[i] - this.travelW[i]
      let bump = (bz > 0 ? this.kBump[i] * bz * bz : 0) + (hard > 0 ? this.kHard[i] * hard : 0)
      // DAMPER (ours — Rapier's is off in this mode, it only saw the body's motion, never the wheel's): on the real
      // compression rate, body AND ground (a stone, a kerb, a rut under the tyre), bump / rebound rates from the
      // spec, DIGRESSIVE like a valved damper — linear to 0.25 m/s of shaft speed, then 0.35 × the slope (the
      // blow-off). A linear damper at a pothole's 2 m/s hit the body with 2–3 × the corner's weight.
      const M = this.body.mass()
      const spring = vc.wheelSuspensionForce(i) ?? 0
      const hp = vc.wheelHardPoint(i)
      // (touching down — or the first step: the shaft moves at the body's approach speed at that corner, not by the
      // jump from full droop in one step)
      let sv: number
      if (this.xPrev[i] > 0 || !hp) sv = dt > 0 ? (x[i] - this.xPrev[i]) / dt : 0
      else {
        const rx = hp.x - com.x, ry = hp.y - com.y, rz = hp.z - com.z
        sv = -((lv.x + w.y * rz - w.z * ry) * u[0] + (lv.y + w.z * rx - w.x * rz) * u[1] + (lv.z + w.x * ry - w.y * rx) * u[2])
      }
      this.xPrev[i] = Math.max(1e-6, x[i])
      // HARD STOP, inelastic (the axle on its rubber stops): past full bump the corner's closing speed is taken out
      // over ~2 steps — the wheel carries the body up the stone, it doesn't spring it into the air (a stiff spring
      // alone stored the hit and threw the car a metre up off a 25 cm rock).
      if (hard > 0 && sv > 0) bump += Math.min(8 * this.cornerW[i], ((0.6 * this.cornerW[i]) / G_REAL) * (sv / dt))
      const av = Math.abs(sv)
      let damp = Math.sign(sv) * ((sv > 0 ? this.dampB[i] : this.dampR[i]) ?? 0) * M * (av < DAMP_KNEE ? av : DAMP_KNEE + DAMP_HIGH * (av - DAMP_KNEE))
      // A tyre only pushes: rebound damping can't pull the wheel down onto the ground.
      // (only ever a limit on the damper's pull — never a push: when the anti-roll bar already out-pulls the spring
      // on an unloading inside wheel, the damper adds nothing)
      if (damp < 0) damp = Math.min(0, Math.max(damp, -(spring + arbF + bump)))
      if (hp && (arbF !== 0 || bump > 0 || damp !== 0)) {
        const F = arbF + bump + damp
        _fv.x = u[0] * F; _fv.y = u[1] * F; _fv.z = u[2] * F
        body.addForceAtPoint(_fv, hp, true)
      }
      wi.Fz = Math.max(0, spring + arbF + bump + damp)
      // Contact frame: the wheel's heading (steered) in the ground plane, and its right.
      const n = vc.wheelContactNormal(i) ?? { x: u[0], y: u[1], z: u[2] }
      const d = D.steer[i], cd = Math.cos(d), sd = Math.sin(d)
      const fx = f[0] * cd + rt[0] * sd, fy = f[1] * cd + rt[1] * sd, fz = f[2] * cd + rt[2] * sd
      const dn = fx * n.x + fy * n.y + fz * n.z
      const fc = this.fc, lc = this.lc
      fc[0] = fx - n.x * dn; fc[1] = fy - n.y * dn; fc[2] = fz - n.z * dn
      const fl = Math.hypot(fc[0], fc[1], fc[2]) || 1
      fc[0] /= fl; fc[1] /= fl; fc[2] /= fl
      lc[0] = fc[1] * n.z - fc[2] * n.y; lc[1] = fc[2] * n.x - fc[0] * n.z; lc[2] = fc[0] * n.y - fc[1] * n.x
      const p = vc.wheelContactPoint(i) ?? t
      const rx = p.x - com.x, ry = p.y - com.y, rz = p.z - com.z
      const vx = lv.x + w.y * rz - w.z * ry, vy = lv.y + w.z * rx - w.x * rz, vz = lv.z + w.x * ry - w.y * rx
      wi.vx = vx * fc[0] + vy * fc[1] + vz * fc[2]
      wi.vy = vx * lc[0] + vy * lc[1] + vz * lc[2]
      // Travel + yaw only (ω about the ground normal), for the static hold.
      const wn = w.x * n.x + w.y * n.y + w.z * n.z
      const hx = lv.x + wn * (n.y * rz - n.z * ry), hy = lv.y + wn * (n.z * rx - n.x * rz), hz = lv.z + wn * (n.x * ry - n.y * rx)
      wi.hx = hx * fc[0] + hy * fc[1] + hz * fc[2]
      wi.hy = hx * lc[0] + hy * lc[1] + hz * lc[2]
      wi.gx = -G_REAL * fc[1]
      wi.gy = -G_REAL * lc[1]
      // Our anti-roll-bar and bump-stop forces push along the body's up axis (Rapier's springs act along the
      // contact normal): their in-plane part, for the static hold to cancel.
      const Fb = arbF + bump + damp
      wi.sx = Fb * (u[0] * fc[0] + u[1] * fc[1] + u[2] * fc[2])
      wi.sy = Fb * (u[0] * lc[0] + u[1] * lc[1] + u[2] * lc[2])
      _cf[i * 6] = fc[0]; _cf[i * 6 + 1] = fc[1]; _cf[i * 6 + 2] = fc[2]
      _cf[i * 6 + 3] = lc[0]; _cf[i * 6 + 4] = lc[1]; _cf[i * 6 + 5] = lc[2]
      _cp[i * 3] = p.x; _cp[i * 3 + 1] = p.y; _cp[i * 3 + 2] = p.z
    }
    // CLIMB ASSIST — a slope limiter (off-road assist): on ground steeper than SLOPE_EFF the steeper part of the
    // slope is cancelled at the COM — an uphill force for the extra pull, a press into the ground for the missing
    // normal load — so the tyres, diffs and gearbox meet at most a ~26° hill: any car crawls up (or down) an 80°
    // wall in 1st, holds still on it, and nothing acts below the COM to flip it.
    let steep = 0
    if (this.offroadAssist && contacts >= 2) {
      let nx = 0, ny = 0, nz = 0, nn = 0
      for (let i = 0; i < 4; i++) {
        if (!this.wIn[i].contact) continue
        const cn = vc.wheelContactNormal(i)
        if (cn) (nx += cn.x), (ny += cn.y), (nz += cn.z), nn++
      }
      if (nn) (nx /= nn), (ny /= nn), (nz /= nn)
      const slope = Math.acos(Math.max(-1, Math.min(1, ny || 1)))
      steep = Math.max(0, Math.min(1, (slope - 0.35) / 0.2))
      // The slope the tyres may feel: ≤ 26°, and no more than the DRIVEN tyres can hold here (70 % of their grip on
      // their share of the load) — a rear-drive van on road tyres on wet grass gets a gentler wall than a 4×4.
      let mu = 0, ds = 0
      for (let i = 0; i < 4; i++) if (this.wIn[i].contact) mu += D.grips[i].mu / Math.max(1, nn)
      for (let a = 0; a < R.axles.length; a++) if (D.isDrivenAxle(a)) ds += R.axles[a].share
      const eff = Math.min(SLOPE_EFF, Math.atan(0.7 * mu * Math.min(1, ds)))
      if (slope > eff) {
        const M = body.mass(), g = G_REAL
        const sinT = Math.sin(slope), cosT = Math.cos(slope)
        const sinE = Math.sin(eff), cosE = Math.cos(eff)
        const tl = Math.hypot(nx, nz) || 1
        // uphill unit vector in the slope plane
        const ux = (-nx / tl) * cosT, uy = sinT, uz = (-nz / tl) * cosT
        const lift = M * g * (sinT - sinE), press = M * g * (cosE - cosT)
        body.addForce({ x: lift * ux - press * nx, y: lift * uy - press * ny, z: lift * uz - press * nz }, true)
        // The tyres' static hold must only cancel what is left of the slope's pull.
        const k = sinE / sinT
        for (let i = 0; i < 4; i++) if (this.wIn[i].contact) (this.wIn[i].gx *= k), (this.wIn[i].gy *= k)
      }
    }
    D.torqueBoost = this.offroadAssist ? 1.6 + 0.6 * steep : 1
    D.steepClimb = steep > 0.3
    // 4WD for the climb: a part-time 4×4 into 4H, a permanent one locks its centre (what its driver would do).
    if (D.steepClimb && R.drive.lockers.includes('centre')) D.locks.add('centre')
    // Chassis state for steering, shift logic and aids.
    const ch = this.chIn
    ch.speed = lv.x * f[0] + lv.y * f[1] + lv.z * f[2]
    ch.yawRate = -(w.x * u[0] + w.y * u[1] + w.z * u[2])
    ch.latAccel = ch.speed * ch.yawRate
    ch.pitch = Math.asin(Math.max(-1, Math.min(1, f[1])))
    // Rear axle centre's sideways velocity (counter-steer help).
    rotate(q, 0, 0, R.axles[R.axles.length - 1].z, _rv)
    const ax = t.x + _rv[0] - com.x, ay = t.y + _rv[1] - com.y, az = t.z + _rv[2] - com.z
    ch.rearVy = (lv.x + w.y * az - w.z * ay) * rt[0] + (lv.y + w.z * ax - w.x * az) * rt[1] + (lv.z + w.x * ay - w.y * ax) * rt[2]
    const c = this.controls
    D.nitro = c.boost
    const din = this.din
    din.throttle = c.throttle; din.steer = c.steer; din.handbrake = c.handbrake; din.boost = c.boost; din.parked = !!c.parked
    din.brake = c.footBrake ?? 0
    D.step(dt, din, ch, this.wIn)
    // Tyre forces at the contact points.
    for (let i = 0; i < 4; i++) {
      if (!this.wIn[i].contact) continue
      const Fx = D.Fx[i], Fy = D.Fy[i]
      _fv.x = _cf[i * 6] * Fx + _cf[i * 6 + 3] * Fy
      _fv.y = _cf[i * 6 + 1] * Fx + _cf[i * 6 + 4] * Fy
      _fv.z = _cf[i * 6 + 2] * Fx + _cf[i * 6 + 5] * Fy
      _pv.x = _cp[i * 3]; _pv.y = _cp[i * 3 + 1]; _pv.z = _cp[i * 3 + 2]
      body.addForceAtPoint(_fv, _pv, true)
    }
    // Aero drag ½ρ·C_dA·v² at the COM.
    const sp = Math.hypot(lv.x, lv.y, lv.z)
    if (sp > 0.1) {
      const drag = 0.5 * 1.2 * R.cdA * sp
      body.addForce({ x: -lv.x * drag, y: -lv.y * drag, z: -lv.z * drag }, true)
    }
    if (D.aids === 'full' && contacts >= 3 && u[1] > 0.6 && !c.handbrake) this.cornerAssist(dt, f, u, rt)
    // Effects / camera / audio read these.
    this.lateral = lv.x * rt[0] + lv.y * rt[1] + lv.z * rt[2]
    const av = Math.abs(ch.speed)
    const slipAngle = Math.atan2(Math.abs(this.lateral), Math.max(av, 0.5))
    this.drifting = av > 5 && slipAngle > 0.3 && contacts >= 2
    this.drift += ((this.drifting ? Math.min(1, slipAngle / 0.6) : 0) - this.drift) * Math.min(1, dt * 8)
    for (let i = 0; i < 4; i++) this.wheelSlip[i] = D.slip[i]
    // Auto-righting (game rule, as in the legacy model).
    this.upsideDown = u[1] < 0.35 && av < 2 && this.wheels.filter((x) => x.contact).length < 2 ? this.upsideDown + dt : 0 // (on its wheels on a steep wall is not "upside down")
    if (this.upsideDown > 2) {
      this.place(t.x, t.y + 1.2, t.z, this.heading)
      this.upsideDown = 0
      D.reset()
    }
  }

  /**
   * CORNERING ASSIST (aids Full — GTA-smooth, gameplay): grip-limited steering asks only for what the tyres give,
   * ~0.5 g on dirt — a full key turned 22° in 2 s at 100 km/h, so fast A / D "did nothing". When the car turns
   * less than the key asks, the yaw rate is raised toward it and the velocity follows the nose (speed kept), up to
   * 1.6 × the surface's grip above 72 km/h (≤ 1.2 g: ice stays slippery). It never adds to oversteer (ESC and the counter-steer
   * help own that) and lets go in a real slide (> 26°). Std / Off aids = the raw machine.
   */
  private cornerAssist(dt: number, f: [number, number, number], u: [number, number, number], r: [number, number, number]): void {
    const D = this.drivetrain!, body = this.body, st = this.controls.steer
    const lv = body.linvel()
    const vf = lv.x * f[0] + lv.y * f[1] + lv.z * f[2]
    // Fades in from 43 km/h to full at 72 (slower, the tyres alone turn the car well enough).
    const k = Math.min(1, (vf - 12) / 8)
    if (k <= 0 || Math.abs(st) < 0.05) return
    const vr = lv.x * r[0] + lv.y * r[1] + lv.z * r[2], vu = lv.x * u[0] + lv.y * u[1] + lv.z * u[2]
    const slip = Math.atan2(vr, vf)
    if (Math.abs(slip) > 0.45) return
    const mu = (D.grips[0].mu + D.grips[1].mu + D.grips[2].mu + D.grips[3].mu) / 4
    const aMax = G_REAL * Math.min(1.2, mu * (1 + 0.6 * k))
    // Yaw about the body's up (+ = left; steer + = right): the key's turn, capped at the kinematic lock and aMax.
    const wuT = -st * Math.min((vf * Math.tan(D.R.steering.lock)) / D.R.wheelbase, aMax / vf)
    const w = body.angvel()
    const wu = w.x * u[0] + w.y * u[1] + w.z * u[2]
    if (wuT > 0 ? wu < wuT : wu > wuT) {
      const dwu = (wuT - wu) * Math.min(1, dt * 4)
      body.setAngvel({ x: w.x + u[0] * dwu, y: w.y + u[1] * dwu, z: w.z + u[2] * dwu }, true)
    }
    // Velocity toward the nose, at most 0.6 × aMax of extra sideways pull.
    const turn = Math.sign(slip) * Math.min(Math.abs(slip), ((0.6 * aMax) / vf) * dt)
    const ang = slip - turn, len = Math.hypot(vf, vr)
    const nf = Math.cos(ang) * len, nr = Math.sin(ang) * len
    body.setLinvel({ x: f[0] * nf + r[0] * nr + u[0] * vu, y: f[1] * nf + r[1] * nr + u[1] * vu, z: f[2] * nf + r[2] * nr + u[2] * vu }, true)
  }

  place(x: number, y: number, z: number, heading: number, pitch = 0): void {
    super.place(x, y, z, heading, pitch)
    this.drivetrain?.reset()
  }

  /** TYRE HEAT (Simulation handling; Drivetrain TYRE): wheel k's tread surface temperature (°C; 20 outside the
   *  drivetrain), its smoke 0..1 from the heat (thick white smoke when hot), and how long it has been on fire (s, 0 =
   *  not burning). Effects, HUD and audio read these. */
  tyreTemp(k: number): number {
    return this.mode === 'drivetrain' && this.drivetrain ? this.drivetrain.treadT[k] : 20
  }
  tyreSmoke(k: number): number {
    return this.mode === 'drivetrain' && this.drivetrain ? this.drivetrain.smoke(k) : 0
  }
  tyreFire(k: number): number {
    return this.mode === 'drivetrain' && this.drivetrain ? this.drivetrain.fire[k] : 0
  }

  /** Wheel k's tyre load (N) — the drivetrain's (spring + bar + bump stop + kick), else Rapier's spring force —
   *  and its static share (N), for the tyre-deformation shader (Car). */
  wheelLoad(k: number): number {
    if (this.mode === 'drivetrain') return this.wIn[k]?.Fz ?? 0
    return this.vc.wheelIsInContact(k) ? Math.max(0, this.vc.wheelSuspensionForce(k) ?? 0) * (G_REAL / GRAVITY) : 0
  }
  wheelLoadStatic(k: number): number {
    const D = this.drivetrain
    if (this.mode === 'drivetrain' && D) return (D.mass * G_REAL * D.R.axles[k >> 1].share) / 2
    return (this.tune.mass * G_REAL) / 4
  }
  /** Sideways tyre force of wheel k (N, + right) — the tyre shear on HIGH. 0 outside the drivetrain. */
  wheelSide(k: number): number {
    return this.mode === 'drivetrain' && this.drivetrain ? this.drivetrain.Fy[k] : 0
  }
  /** Surface under wheel k (weights over SURFACES, the sim's own sample — tyre marks); null outside the drivetrain
   *  (not sampled then). Reused object: read it, don't keep it. */
  wheelSurface(k: number): SurfaceMix | null {
    return this.mode === 'drivetrain' ? (this.mixes[k] ?? null) : null
  }

  /** Current tyre radius (m). */
  get wheelRadius(): number {
    return this.baseRadius * this.tune.tyre
  }

  /**
   * AIR SUSPENSION (↑ / ↓ while driving): the suspension rest length grows by `ride` (0 … RIDE_MAX m) — the wheels
   * stay on the ground, the body rises on its struts (Car draws the shock absorbers stretching). `ride` follows
   * `rideTarget` at 0.5 m/s; the anti-roll assist keeps the tall stance from tipping in corners.
   */
  ride = 0
  rideTarget = 0
  static readonly RIDE_MAX = 1.0
  private updateRide(dt: number): void {
    const l = this.controls.lift ?? 0
    if (l) this.rideTarget = Math.min(TruckSim.RIDE_MAX, Math.max(0, this.rideTarget + l * dt * 0.6))
    const d = this.rideTarget - this.ride
    if (Math.abs(d) < 1e-4) return
    this.ride += Math.sign(d) * Math.min(Math.abs(d), dt * 0.5)
    for (let i = 0; i < 4; i++) this.vc.setWheelSuspensionRestLength(i, this.restW[i] + this.ride)
    this.body.wakeUp()
  }

  /**
   * HOVER FLIGHT (Car: L, the wheels turned into jets): no wheel contact; velocity-level control like a drone —
   * W/S thrust along the heading (≈ 38 m/s, boost ≈ 60), A/D yaw (banking into the turn), ↑/↓ climb / sink
   * (≈ 9 m/s), sideways slip damped, altitude held when nothing is pressed (gravity cancelled), never below
   * `hoverFloor` (world y: Car keeps it ~0.7 m above the terrain). The colliders still hit trees and hills.
   */
  hover = false
  hoverFloor = -1e9
  private hoverYaw = 0
  private holdY = 0
  private wasHovering = false
  protected hoverStep(dt: number): boolean {
    if (!this.hover) return (this.wasHovering = false)
    this.wet = 0
    this.afloat = false
    const c = this.controls
    const lv = this.body.linvel()
    const t = this.body.translation()
    const h = this.heading
    const fx = -Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = -Math.sin(h)
    const vf = lv.x * fx + lv.z * fz, vr = lv.x * rx + lv.z * rz
    const top = c.boost ? 60 : 38
    const tvf = c.throttle > 0 ? c.throttle * top : c.throttle * 14
    const nvf = vf + (tvf - vf) * Math.min(1, dt * (Math.abs(c.throttle) > 0.01 ? 1.1 : 0.7))
    const nvr = vr * (1 - Math.min(1, dt * 3))
    // Altitude hold: ↑/↓ set the climb rate; let go and it servos back to the height where you let go.
    const lift = c.lift ?? 0
    if (!this.wasHovering || lift) this.holdY = t.y
    this.wasHovering = true
    this.holdY = Math.max(this.holdY, this.hoverFloor)
    const tvy = lift ? lift * 9 : Math.max(-6, Math.min(6, (this.holdY - t.y) * 2.5))
    // + GRAVITY·dt: the world step will take it off again (hover = weightless).
    const nvy = lv.y + (tvy - lv.y) * Math.min(1, dt * 6) + GRAVITY * dt
    this.body.setLinvel({ x: fx * nvf + rx * nvr, y: nvy, z: fz * nvf + rz * nvr }, true)
    // Attitude: yaw from the stick, bank into the turn, nose dips while accelerating; roll / pitch servoed.
    this.hoverYaw += (-c.steer * 1.6 - this.hoverYaw) * Math.min(1, dt * 5)
    const { f, r } = this.axes()
    const { roll, pitch } = this.attitude()
    const wantRoll = c.steer * 0.32 * Math.min(1, Math.abs(vf) / 8 + 0.3)
    const wantPitch = Math.max(-0.22, Math.min(0.22, -(tvf - vf) * 0.012 + (c.lift ?? 0) * 0.06))
    const wr = (wantRoll - roll) * 4, wp = (wantPitch - pitch) * 4
    this.body.setAngvel({ x: f[0] * wr + r[0] * wp, y: f[1] * wr + r[1] * wp + this.hoverYaw, z: f[2] * wr + r[2] * wp }, true)
    this.drift = this.lateral = 0
    this.drifting = false
    for (let i = 0; i < 4; i++) this.wheelSlip[i] *= 1 - Math.min(1, dt * 6)
    return true
  }

  /**
   * AMPHIBIOUS BOAT (Car: O — the hull unfolds from under the car, BoatHull). `boat` = how far the hull is out (0..1,
   * Car animates it); from 0.5 the boat handling below replaces the car's. BUOYANCY: each hull point under the water
   * (`water(x, z)` = the liquid surface there, −∞ where dry / frozen / desert; + small travelling waves) pushes up
   * by its share of the weight × depth / `hullDraft`, damped by its own vertical speed (ζ ≈ 0.55) — so the boat
   * floats `hullDraft` deep and bobs, pitches and rolls by itself; at speed a dynamic lift (+30 %) raises it onto
   * the plane. IN THE WATER: a water jet (≈ 54 km/h, boost ≈ 79) against quadratic + linear hull drag, the keel
   * kills sideways slip (a short carving slide in hard turns), the nozzle yaws the stern (authority grows with speed
   * and thrust, a little at idle), the bow rises over the planing hump (~7 m/s) and settles, banks into turns.
   * ON THE KEEL (land, shallows: the retracted wheels still carry it, raised so the keel meets the ground): a hull
   * dragged along — ≤ 16 km/h. Afloat = < 2 wheel contacts and ≥ 20 % of the hull wet. Cost: 6 surface queries +
   * 6 point forces per step while the hull is out. Tested in tests/vehicle.test.ts.
   */
  boat = 0
  /** Buoyancy points (chassis space) and the hull's resting depth (m) — set by Car from BoatHull. */
  hullPts: [number, number, number][] = []
  hullDraft = 0.36
  /** Liquid water surface at (x, z) (world y), or −Infinity where there is none. */
  water: (x: number, z: number) => number = () => -Infinity
  /** Share of the hull points in the water (0..1), floating free of the ground, and the downward speed of the
   *  last hit on the water (m/s, VehicleFx splash — the reader zeroes it). */
  wet = 0
  afloat = false
  splash = 0
  private waveT = 0

  private buoyancy(dt: number): void {
    this.waveT += dt
    const n = this.hullPts.length
    const wasWet = this.wet
    this.wet = 0
    if (!n) return
    const m = this.tune.mass
    const t = this.body.translation(), q = this.body.rotation(), lv = this.body.linvel(), w = this.body.angvel()
    const com = this.body.worldCom()
    const plane = 1 + 0.3 * Math.min(1, Math.max(0, this.speed - 3) / 10)
    // Hydrodynamic lift moves along the hull: over the planing hump (~7 m/s) it pushes the bow up (trim θ ≈
    // 0.15·trim rad), settling to ~2° on the plane; steering shifts it outboard so the boat banks INTO the turn.
    const handling = this.boat >= 0.5
    const vs = Math.max(0, this.speed)
    const trim = handling ? 0.6 * (vs / 7) * Math.exp(1 - vs / 7) + 0.15 * Math.min(1, vs / 14) : 0
    const bank = handling ? this.controls.steer * 0.06 * Math.min(1, vs / 9) : 0
    let wet = 0, hit = 0
    for (const p of this.hullPts) {
      rotate(q, p[0], p[1], p[2], _rv)
      const px = t.x + _rv[0], py = t.y + _rv[1], pz = t.z + _rv[2]
      const level = this.water(px, pz)
      if (level === -Infinity) continue
      const d = level + this.wave(px, pz) - py
      if (d <= 0) continue
      wet++
      const vy = lv.y + w.z * (px - com.x) - w.x * (pz - com.z) // (ω × r)·y
      hit = Math.min(hit, vy)
      // Weight share × depth / draft (dynamic lift at speed), minus damping c·v (c = 2ζω, ω = √(g / draft)).
      const shift = 1 + (p[2] < -0.5 ? trim : p[2] > 0.5 ? -trim : 0) + (p[0] < 0 ? bank : -bank)
      const k = Math.max(-0.5, (Math.min(d, 1.2) / this.hullDraft) * plane * shift - (8.2 / GRAVITY) * vy)
      _fv.y = ((k * m * GRAVITY) / n) * this.boat
      _pv.x = px; _pv.y = py; _pv.z = pz
      this.body.addForceAtPoint(_fv, _pv, true)
    }
    this.wet = wet / n
    if (wasWet === 0 && this.wet > 0 && hit < -2.5) this.splash = -hit
  }

  /** Small travelling waves on the water surface (m): the floating boat bobs and rocks a little at rest. */
  private wave(x: number, z: number): number {
    const t = this.waveT
    return 0.05 * Math.sin(t * 1.7 + x * 0.37 + z * 0.11) + 0.035 * Math.sin(t * 2.6 - z * 0.29 + x * 0.17)
  }

  private driveBoat(dt: number, v: number): void {
    const c = this.controls, vc = this.vc, m = this.tune.mass
    const contacts = this.wheels.filter((x) => x.contact).length
    this.afloat = contacts < 2 && this.wet > 0.2
    this.drift = this.lateral = 0
    this.drifting = this.nitroOn = false
    for (let i = 0; i < 4; i++) this.wheelSlip[i] *= 1 - Math.min(1, dt * 6)
    const av = Math.abs(v)
    // ON THE KEEL: the hidden wheels crawl it along (a hull dragged over the ground), brakes hold it on dry land.
    let engine = 0, brake = 0
    if (c.parked || (Math.abs(c.throttle) < 0.01 && av < 1)) {
      brake = 1
      if (this.wet < 0.2) this.hold()
    } else if (c.throttle > 0.01) engine = v < 4.5 ? c.throttle * m * 5 : 0
    else if (c.throttle < -0.01) {
      if (v > 0.5) brake = -c.throttle
      else engine = v > -2.5 ? c.throttle * m * 3 : 0
    }
    this.steerAngle += (c.steer * (0.55 / (1 + av * 0.12)) - this.steerAngle) * Math.min(1, dt * 5)
    for (let i = 0; i < 4; i++) {
      vc.setWheelEngineForce(i, engine / 4)
      vc.setWheelBrake(i, (brake * m * GRAVITY * 0.5 * dt) / 4)
      vc.setWheelSideFrictionStiffness(i, 0.55)
      if (i < 2) vc.setWheelSteering(i, -this.steerAngle)
    }
    const { f, u, r } = this.axes()
    // Capsized (on its side / roof at a crawl for 2 s): set back upright (game rule, as on land).
    this.upsideDown = u[1] < 0.35 && av < 2 && this.wheels.filter((x) => x.contact).length < 2 ? this.upsideDown + dt : 0 // (on its wheels on a steep wall is not "upside down")
    if (this.upsideDown > 2) {
      const t = this.body.translation()
      this.place(t.x, t.y + 1.2, t.z, this.heading)
      this.upsideDown = 0
      return
    }
    if (this.wet < 0.05) return
    // ---- IN THE WATER: jet thrust vs hull drag along the (horizontal) heading, the keel's side grip ----
    const fl = Math.hypot(f[0], f[2]) || 1
    const fx = f[0] / fl, fz = f[2] / fl, rx = -fz, rz = fx
    const lv = this.body.linvel()
    const vf = lv.x * fx + lv.z * fz, vr = lv.x * rx + lv.z * rz
    const wet = Math.min(1, this.wet * 1.5)
    let thrust = 0
    if (c.throttle > 0.01) thrust = (c.boost ? 13.5 : 7) * c.throttle // tops out ≈ 15 m/s, boost ≈ 22
    else if (c.throttle < -0.01) thrust = (vf > 1 ? 6 : 3.2) * c.throttle // the jet's reverse bucket: brake, then back up
    const drag = 0.0211 * vf * Math.abs(vf) + 0.15 * vf
    const ax = (thrust - drag) * wet, ar = -vr * 3.2 * wet
    this.body.addForce({ x: (fx * ax + rx * ar) * m, y: 0, z: (fz * ax + rz * ar) * m }, true)
    // Steering (velocity level, like the hover): the nozzle swings the stern. Trim and bank come from the
    // buoyancy (lift shifted along / across the hull); here only the water's damping of roll and pitch rates.
    const w = this.body.angvel()
    const wu = w.x * u[0] + w.y * u[1] + w.z * u[2]
    const wf = w.x * f[0] + w.y * f[1] + w.z * f[2]
    const wr = w.x * r[0] + w.y * r[1] + w.z * r[2]
    const auth = Math.min(1, 0.2 + Math.abs(vf) / 9 + Math.max(0, c.throttle) * 0.3)
    const yawT = -c.steer * 1.1 * auth * (vf < -0.5 ? -1 : 1)
    const dYaw = (yawT - wu) * Math.min(1, dt * 3) * wet
    const dRoll = -wf * 1.2 * dt * wet
    const dPitch = -wr * 1.2 * dt * wet
    this.body.setAngvel({
      x: w.x + u[0] * dYaw + f[0] * dRoll + r[0] * dPitch,
      y: w.y + u[1] * dYaw + f[1] * dRoll + r[1] * dPitch,
      z: w.z + u[2] * dYaw + f[2] * dRoll + r[2] * dPitch,
    }, true)
  }

  /** Afloat the wheels stand still — the engine note follows the jet (throttle and speed) instead. With the
   *  drivetrain the wheels show its simulated spin (∫ω), not Rapier's ground-speed rotation. */
  step(dt: number): void {
    const want = this.wantMode()
    if (want !== this.mode) this.configure(want)
    super.step(dt)
    if (this.afloat) this.wheelSpeed = Math.sign(this.speed || 1) * Math.max(Math.abs(this.speed), Math.max(0, this.controls.throttle) * 9)
    const D = this.drivetrain
    if (this.mode === 'drivetrain' && D && this.enabled) {
      let rim = 0
      for (let i = 0; i < 4; i++) {
        this.wheels[i].spin = D.spin[i]
        rim += D.omega[i] * D.R.axles[i >> 1].radius
      }
      this.wheelSpeed = rim / 4
    }
  }

  protected drive(dt: number, v: number): void {
    this.updateRide(dt)
    if (this.mode === 'drivetrain') {
      this.wet = 0
      this.afloat = false
      return this.driveReal(dt)
    }
    if (this.boat > 0) this.buoyancy(dt)
    else (this.wet = 0), (this.afloat = false)
    if (this.boat >= 0.5) return this.driveBoat(dt, v)
    this.afloat = false
    if (this.arcade) return this.driveArcade(dt, v)
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
    this.upsideDown = u[1] < 0.35 && av < 2 && this.wheels.filter((x) => x.contact).length < 2 ? this.upsideDown + dt : 0 // (on its wheels on a steep wall is not "upside down")
    if (this.upsideDown > 2) {
      const t = this.body.translation()
      this.place(t.x, t.y + 1.2, t.z, this.heading)
      this.upsideDown = 0
    }
  }
}

/** v' = q v q* (Rapier quaternion) into `out`. */
function rotate(q: { x: number; y: number; z: number; w: number }, x: number, y: number, z: number, out: number[]): void {
  const ix = q.w * x + q.y * z - q.z * y, iy = q.w * y + q.z * x - q.x * z, iz = q.w * z + q.x * y - q.y * x, iw = -q.x * x - q.y * y - q.z * z
  out[0] = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y
  out[1] = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z
  out[2] = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x
}
const _rv = [0, 0, 0]
/**
 * The truck's low frame (y 0.34–0.74 m) as boxes that leave the four wheel corners open: a spine between the tyres
 * the whole length, and full-width pieces ahead of the front wheels (bumper), between the axles (sills) and behind
 * the rear wheels. `mass` is shared by volume.
 * The bumpers start at the model's own overhang underside (`d.overhang`, less 2 cm), not the frame's 0.34 m: a
 * box hanging 25–30 cm below the visible bumper stopped the truck dead on a 45 cm stone that visibly fit under it,
 * before the tyre could climb it (approach angle ≈ 22° instead of the model's ≈ 35°).
 */
function frameBoxes(d: TruckDims, mass: number): SimSpec['boxes'] {
  const h = d.half, r = d.wheelRadius
  const zf = Math.min(d.wheelPos[0][2], d.wheelPos[1][2]), zr = Math.max(d.wheelPos[2][2], d.wheelPos[3][2])
  const inner = Math.max(0.2, Math.min(...d.wheelPos.map((p) => Math.abs(p[0]))) - 0.75 * r)
  const z0 = -h.z * 0.93, z1 = h.z * 0.93, gap = 1.05 * r
  // [half width, z from, z to, bottom y]
  const bumper = (y: number | undefined) => Math.min(FRAME_HI - 0.1, Math.max(FRAME_LO, (y ?? FRAME_LO) - 0.02))
  const parts: [number, number, number, number][] = [[inner, z0, z1, FRAME_LO]]
  for (const [a, b, lo] of [[z0, zf - gap, bumper(d.overhang?.front)], [zf + gap, zr - gap, FRAME_LO], [zr + gap, z1, bumper(d.overhang?.rear)]]) {
    if (b - a > 0.1) parts.push([h.x * 0.9, a, b, lo])
  }
  const vol = parts.reduce((s, [x, a, b, lo]) => s + x * (b - a) * (FRAME_HI - lo), 0)
  return parts.map(([x, a, b, lo]) => ({
    half: [x, (FRAME_HI - lo) / 2, (b - a) / 2] as [number, number, number],
    at: [0, (FRAME_HI + lo) / 2, (a + b) / 2] as [number, number, number],
    mass: (mass * x * (b - a) * (FRAME_HI - lo)) / vol,
  }))
}
/** Rapier collider for one shape (null: a degenerate hull — coplanar points). */
function shapeDesc(R: typeof RAPIER, s: Shape): RAPIER.ColliderDesc | null {
  if ('hull' in s) return R.ColliderDesc.convexHull(s.hull)
  if ('trimesh' in s) {
    const idx = new Uint32Array(s.trimesh.length / 3)
    for (let i = 0; i < idx.length; i++) idx[i] = i
    return R.ColliderDesc.trimesh(s.trimesh, idx)
  }
  if ('box' in s) return R.ColliderDesc.cuboid(...s.box).setTranslation(...s.at)
  // Capsule along a → b: Rapier's runs along +Y, turned onto the segment (shortest arc from +Y).
  const [a, b, r] = s.capsule
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], len = Math.hypot(dx, dy, dz)
  const ux = dx / len, uy = dy / len, uz = dz / len
  const w = 1 + uy, qn = w < 1e-6 ? null : Math.hypot(uz, ux, w)
  const q = qn ? { x: uz / qn, y: 0, z: -ux / qn, w: w / qn } : { x: 1, y: 0, z: 0, w: 0 }
  return R.ColliderDesc.capsule(len / 2, r).setTranslation((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2).setRotation(q)
}
/** The low frame's underside and top (m, truck space). */
const FRAME_LO = 0.34
const FRAME_HI = 0.74

/** Damper knee (m/s of shaft speed) and the slope past it (× the low-speed rate): a digressive valve. (0.25 / 0.35
 *  bled off most of the damping in an ordinary hit — the shaft ran into the bump stop: a 25 cm stone at 25 km/h
 *  peaked at 28 m/s² vs 9 m/s² now; a pothole's 2 m/s still meets ~60 % of the linear force.) */
const DAMP_KNEE = 0.5
const DAMP_HIGH = 0.5
/** Tyre-envelope sample offsets along the wheel's heading (× the tyre radius); the hub first. */
// (± 0.93 r: a tyre meets a stone as tall as half its radius ~0.9 r ahead of the hub — it starts climbing there)
const ENV_D = [0, 0.35, -0.35, 0.7, -0.7, 0.93, -0.93]
const _hd = [0, 0, 0]
const _x = [0, 0, 0, 0]
/** Per wheel: contact frame (forward xyz, right xyz) and contact point, reused every step (no allocations). */
const _cf = new Float64Array(24)
const _cp = new Float64Array(12)
const _fv = { x: 0, y: 0, z: 0 }
const _pv = { x: 0, y: 0, z: 0 }

/** Arcade top speed (m/s) for a setup: stock 120 kW ≈ 48 m/s (173 km/h), nitro × 1.32. */
export function arcadeTopSpeed(t: TruckTune): number {
  return Math.min(85, 30 + t.power * 0.15)
}


/** BMX dimensions (scaled bike space, gameplay/bmx/Bike). */
export interface BikeDims {
  front: [number, number, number]
  rear: [number, number, number]
  wheelRadius: number
  /** Collision shapes from the bike's parts (Bike.ts); absent: the frame + rider boxes collide. */
  shapes?: Shape[]
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
      shapes: d.shapes,
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
