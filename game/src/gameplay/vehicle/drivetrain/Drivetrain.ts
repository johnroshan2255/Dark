import { curveTorque, type AidLevel, type Locker, type Resolved } from './spec'
import { TYRE_KINDS, combinedSlip, type Grip } from './tyre'

/**
 * THE DRIVETRAIN (skills/realistic-vehicle-system §8.6–8.7) — render-free, Rapier-free, deterministic. It owns
 * every number the car feels and shows: engine rpm, gear, clutch, each wheel's spin ω, slip κ / α, and the tyre
 * forces. The physics engine only does springs and contacts; TruckSim feeds this the per-wheel load, contact-patch
 * velocity and surface, and applies the forces it returns at the contact points.
 *
 * Step (fixed 60 Hz, 8 substeps): pedals → aids → per substep: power-unit torque → tyre force from each wheel's
 * slip (combined slip, overshoot-capped) → wheel ω (tyre, brakes, rolling resistance — friction that never
 * reverses ω) → differentials (friction-clutch impulses: open / LSD / Torsen / viscous / locked) → clutch or
 * torque converter (a velocity constraint between engine and gearbox output with the clutch's torque capacity —
 * locked, slipping or open — or the converter's explicit fluid torque). Forces are averaged over the substeps;
 * below ~1 m/s with no throttle the tyres hold the car still (static friction incl. the slope).
 *
 * Wheels are axle-major: wheel i = axle (i >> 1), left (i & 1 = 0) / right (1). Conventions: + vx forward,
 * + vy right, Fx + pushes the car forward, Fy + pushes it right; steer + = right.
 * Cost: ≈ 8 × (wheels × ~60 flops + a few impulses) per step — ≤ 0.03 ms (4 wheels).
 */

export const SUBSTEPS = 8
const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x)
const SIGMA = 0.4 // tyre relaxation length (m)

export interface DriverInput {
  /** −1 … 1: W/S or the stick (forward = gas in D, brake while rolling; held at a standstill → reverse). */
  throttle: number
  steer: number
  handbrake: boolean
  boost: boolean
  parked: boolean
  /** 0..1 FOOT BRAKE held TOGETHER with the gas (W + S; touch: DRIFT + stick forward at a standstill) — the
   *  throttle axis is then the gas pedal only and never selects reverse. Both pedals = left-foot braking, or at a
   *  standstill a BRAKE-STAND BURNOUT: the brakes (front-biased) hold the fronts, the engine overpowers the rear
   *  brakes and spins the driven rears. */
  brake?: number
}

/**
 * TYRE TEMPERATURE (per wheel, two lumps): the tread SURFACE (the skin in the contact patch, incl. its flash heat —
 * what smokes, loses grip and burns) on the tread BULK under it. Heat in = the tyre's share of the SLIDING power
 * at the contact, |Fx·(ω·r − vx)| + |Fy·vy| (W); out = convection to the air (rising with the air speed over the
 * tyre: the car's speed and the tread's own rim speed) and conduction into the bulk / rim / road. Sizes scale with
 * the tyre (∝ r²). Anchors (tuned in tests/drivetrain.test.ts): a brake-stand burnout of an 85 kW rear-drive car smokes
 * hard within ~2–4 s (surface ≈ 180–200 °C) and ignites after ~15–25 s (≈ 360 °C, rubber's ignition range
 * 350–400 °C); a 1 g skidpad / a 0–100 run stays under ~110 °C; a drift gets hot and smoky, not alight.
 */
export const TYRE = {
  /** Share of the sliding power that goes into the tyre (the rest heats the road), at most — the heat partition of
   *  a sliding contact favours the surface that moves THROUGH it (fresh, cold material): × (√u_tyre + 0.2) /
   *  (√u_tyre + √u_road + 0.4), u = the tread's rim speed and the ground speed. A burnout (road spot still, tread
   *  streaming through) heats the tyre; a locked wheel (the same patch dragged over fresh road) mostly the road. */
  eta: 0.72,
  /** Heat capacity at r = 0.39 m (J/K): the surface skin (~60 g of rubber — the contact patch's flash layer), the
   *  outer tread under it (~0.35 kg: the few mm a burnout cooks in tens of seconds). */
  cS: 120,
  cB: 700,
  /** Conductance surface → bulk (W/K), and to the air: base + per √(m/s) of air speed (surface; bulk). */
  gSB: 40,
  gSA: 6,
  gSAv: 9,
  gBA: 3,
  gBAv: 3,
  /** Share of the rim speed the tread feels as air speed (a spinning tyre fans itself a little). */
  fan: 0.1,
  /** Wet ground: surface → air × (1 + wetCool · wetness) — water quenches a hot tyre. */
  wetCool: 3,
  /** Grip: full to `gripFrom` °C, then down to (1 − gripLoss) at `gripTo` (overheated, greasy rubber). */
  gripFrom: 120,
  gripTo: 300,
  gripLoss: 0.3,
  /** Share of the tread heat a fully off-road surface (dirt, grass, mud, sand, snow) takes away. */
  looseHeat: 0.8,
  /** Smoke from the tread surface: starts at `smokeFrom` °C, thick at `smokeFull` (VehicleFx reads `smoke`). */
  smokeFrom: 140,
  smokeFull: 230,
  /** FIRE: ignites at `ignite` °C (rubber: 350–400 °C); burns while ≥ `out` °C. The flame feeds `fireW` W back into
   *  the surface (less as it nears `pyro`, where the rubber gasifies instead of getting hotter) while there is tread
   *  left (`fuel` s of full flame), so a stopped car's tyre keeps burning, and driving off (air) puts it out. */
  ignite: 360,
  /** …with the tread under it ≥ this hot: a thin flash-heated skin (a spin, a short wheelspin) can't feed a flame
   *  — sustained heating that cooks the tread does (the ignition criterion of a thermally thick solid). */
  igniteCore: 170,
  out: 230,
  fireW: 8000,
  pyro: 500,
  fuel: 45,
  /** Air speed (m/s) that halves the flame's heat feedback (blown off the rubber). */
  blowOff: 6,
} as const

export interface WheelIn {
  contact: boolean
  /** Normal load (N), contact-patch velocity along / across the wheel (m/s), gravity along / across (m/s²), and
   *  the in-plane part of the suspension's own push (N; the springs act along the body's up axis, which isn't the
   *  ground normal on a slope — the static hold has to cancel it too). */
  Fz: number
  vx: number
  vy: number
  gx: number
  gy: number
  sx: number
  sy: number
  /** Patch velocity from the body's travel and yaw only (no pitch / roll rate — that is the springs' business):
   *  what the static hold cancels. Cancelling the full patch velocity pivots the body about its tyres every step
   *  and it walks. */
  hx: number
  hy: number
}

export interface ChassisIn {
  /** Forward speed, yaw rate (+ = turning right), lateral acceleration (m/s²), pitch (+ = nose up). */
  speed: number
  yawRate: number
  latAccel: number
  pitch: number
  g: number
  /** Velocity of the rearmost axle's centre across the car (m/s, + right) — for counter-steer help. */
  rearVy: number
}

export type Selector = 'P' | 'R' | 'N' | 'D'

export class Drivetrain {
  readonly n: number
  // ---- per-wheel state / outputs ----
  readonly omega: Float64Array
  readonly spin: Float64Array
  readonly kappa: Float64Array
  readonly alpha: Float64Array
  readonly steer: Float64Array
  readonly Fx: Float64Array
  readonly Fy: Float64Array
  /** 0..1 visible slip per wheel (smoke, dust, squeal): the larger of `slideVis` / `skidVis`. */
  readonly slip: Float64Array
  /** 0..1 per wheel: the tyre SLIDING sideways / spinning or locked along — only past its grip peak AND at a real
   *  sliding speed (a tyre squeals and smokes when it slides over the ground, never while it grips: pulling away, a
   *  slow turn, a gentle stop are silent). Squeal, smoke and tyre marks read these. */
  readonly slideVis: Float64Array
  readonly skidVis: Float64Array
  readonly grips: Grip[] = []
  // ---- tyre temperature (TYRE above) ----
  /** Tread surface temperature (°C) per wheel — what smokes, grips and burns. */
  readonly treadT: Float64Array
  /** Tread bulk temperature (°C) per wheel. */
  readonly coreT: Float64Array
  /** Ambient air (°C) and ground wetness (0..1) per wheel (TruckSim sets them from the surface under it). */
  readonly airT: Float64Array
  readonly wetT: Float64Array
  /** Seconds this tyre has been burning (0 = not on fire), and its tread left to burn (s of full flame). */
  readonly fire: Float64Array
  private readonly fuel: Float64Array
  /** Sliding power into each tyre this step (W, averaged over the substeps) — and the grip factor from its heat. */
  readonly slideP: Float64Array
  private readonly heatGrip: Float64Array
  private readonly accP: Float64Array
  /** Driven wheels turning against their applied foot brake this step (a burnout): not held by the static hold. */
  private readonly free: Uint8Array
  /** Burnout launch (manual / DCT): the driver's clutch stays in while the engine revs, then is dumped. */
  private burnClutch = 0
  // ---- powertrain state / outputs ----
  /** Engine (motor) speed (rad/s). */
  we: number
  selector: Selector = 'D'
  /** Gear index: −1 reverse, 0 neutral, 1…n forward. */
  gear = 1
  /** Player shifts (true) or the shift map (false). */
  manual = false
  aids: AidLevel
  lowRange = false
  readonly locks = new Set<Locker>()
  shifting = false
  /** Engine load −1 … 1 (overrun … full), clutch 0..1, turbo boost 0..1, regen 0..1. */
  load = 0
  clutch = 1
  boost = 0
  regen = 0
  /** Driver pedals after the ramps (0..1) and the brake-lamp signal. */
  gas = 0
  brake = 0
  braking = false
  /** Aid activity this step (HUD lamps). */
  absOn = false
  tcsOn = false
  escOn = false
  /** The cornering assist's target yaw rate this step (rad/s, ch.yawRate's sign; 0 = not assisting — TruckSim):
   *  ESC steers toward it instead of the tyres' own limit, or it brakes away the turn the assist adds. */
  assistYaw = 0
  /** Off-road assist (TruckSim): the brake hold catches a car already rolling back (≤ 4 m/s, real: 0.8) and the
   *  hill-start assist keeps it from rolling back for 4 s of pulling away below 3 m/s (real: 1.5 s, 1.5 m/s) — a car
   *  that slipped on a steep climb rolled down the hill for good (2026-10-21, "the tyres just spin, it stays there"). */
  steepHold = false
  /** Gameplay torque multiplier (Settings → Off-road assist: 1.6 on the flat; TruckSim raises it on steep climbs)
   *  — 1 = the real machine. Scales the engine, the clutch's capacity and the converter together. */
  torqueBoost = 1
  /** Steep-climb mode (TruckSim, off-road assist): hold 1st at a crawl. */
  steepClimb = false
  /** Garage: power and grip multipliers, nitrous (Shift) torque factor. */
  powerScale = 1
  gripScale = 1
  boostFactor = 1.6
  /** Automatic idle creep with no pedals (a real torque converter's); off = brake hold: it waits for the gas. */
  idleCreep = false
  /** Part-time 4WD engages 4H by itself on low-grip ground (snow, mud, sand) and drops back to 2H on grip
   *  (aids Std / Full: what its driver would do). Set by the drivetrain only; a manual L press takes over. */
  auto4H = true
  private autoLocked = false
  /** Smoothed tyre grip under the car (μ, without the garage grip slider) — the auto 4H's input. */
  private muSeen = 1
  /** Rejected manual shift this step (over-rev): the audio clicks. */
  refused = false

  private readonly I: Float64Array
  private readonly Ieff: Float64Array
  private readonly a: Float64Array
  private readonly brakeMax: Float64Array
  private readonly FzStatic: Float64Array
  private readonly absRel: Uint8Array
  private readonly escBrake: Float64Array
  private readonly accFx: Float64Array
  private readonly accFy: Float64Array
  private readonly tmp = [0, 0]
  private steerAngle = 0
  private revHold = 0
  private shiftT = 0
  private shiftTo = 0
  private shiftCool = 0
  private gasSmooth = 0
  private gasHist = 0
  private limiterCut = 0
  private tcs = 1
  private lockup = false
  private cvt: number
  private Tcarrier = 0
  private centreOn = false

  constructor(readonly R: Resolved) {
    const n = (this.n = R.axles.length * 2)
    const f = () => new Float64Array(n)
    this.omega = f(); this.spin = f(); this.kappa = f(); this.alpha = f(); this.steer = f()
    this.Fx = f(); this.Fy = f(); this.slip = f(); this.slideVis = f(); this.skidVis = f(); this.I = f(); this.Ieff = f(); this.a = f()
    this.brakeMax = f(); this.FzStatic = f(); this.escBrake = f(); this.accFx = f(); this.accFy = f()
    this.treadT = f(); this.coreT = f(); this.airT = f(); this.wetT = f(); this.fire = f(); this.fuel = f()
    this.slideP = f(); this.heatGrip = f(); this.accP = f()
    this.airT.fill(20)
    this.coolDown()
    this.absRel = new Uint8Array(n)
    this.free = new Uint8Array(n)
    this.aids = R.aids
    this.mass = R.mass
    this.we = R.power.wIdle
    this.cvt = R.gearbox.range[0]
    for (let i = 0; i < n; i++) {
      const ax = R.axles[i >> 1]
      this.I[i] = ax.inertia
      this.grips.push({ mu: 1, kp: 0.1, ap: TYRE_KINDS[ax.tyreKind].peakAlpha, crr: 0.012, sand: 0, offroad: 0 })
    }
    this.retuneBrakes()
  }

  /** Mass in use (kg: the spec's kerb mass × the garage slider). */
  mass: number

  /** Per-wheel maximum brake torque from the deceleration target and the bias (§8.7), static loads. */
  retuneBrakes(mass = this.R.mass): void {
    const R = this.R, na = R.axles.length
    this.mass = mass
    for (let i = 0; i < this.n; i++) {
      const ax = R.axles[i >> 1], k = i >> 1
      this.FzStatic[i] = (mass * 9.81 * ax.share) / 2
      const share = na === 1 ? 1 : k === 0 ? R.brakes.bias : (1 - R.brakes.bias) / (na - 1)
      // ABS cars get 15 % headroom (the ABS uses it at the limit); without ABS the system is sized just under
      // lock-up (full pedal ≈ 92 % of the target — a panic stop on worse ground still locks).
      this.brakeMax[i] = ((R.brakes.abs ? 1.15 : 0.92) * R.brakes.maxDecel * 9.81 * mass * ax.radius * share) / 2
    }
  }

  /** Put the car at rest (teleport / place). */
  reset(): void {
    this.omega.fill(0); this.alpha.fill(0); this.kappa.fill(0)
    this.we = this.R.power.wIdle
    this.gear = this.selector === 'R' ? -1 : 1
    this.shifting = false
    this.gas = this.brake = 0
    this.coolDown()
  }

  /** Tyres at the air temperature, no fire, a full tread (a new placement). */
  coolDown(): void {
    for (let i = 0; i < this.n; i++) {
      this.treadT[i] = this.coreT[i] = this.airT[i]
      this.fire[i] = 0
      this.fuel[i] = TYRE.fuel
      this.heatGrip[i] = 1
      this.slideP[i] = 0
    }
  }

  /** 0..1 tyre smoke from the tread's heat (thick white smoke when hot, even while it only smoulders). */
  smoke(i: number): number {
    const t = (this.treadT[i] - TYRE.smokeFrom) / (TYRE.smokeFull - TYRE.smokeFrom)
    return t <= 0 ? 0 : t >= 1 ? 1 : t
  }

  /** Any tyre on fire. */
  get burning(): boolean {
    for (let i = 0; i < this.n; i++) if (this.fire[i] > 0) return true
    return false
  }

  // ---------------- player controls ----------------

  /** Manual mode: one gear up / down (refused if it would over-rev: `refused` → a click). */
  shiftUp(): void {
    this.requestShift(+1)
  }
  shiftDown(): void {
    this.requestShift(-1)
  }
  private requestShift(d: number): void {
    const N = this.R.gearbox.ratios.length
    if (!this.stepped || this.selector !== 'D' || this.shifting) return
    const to = this.gear + d
    if (to < 1 || to > N) return
    const wOut = Math.abs(this.outSpeed() * this.ratioOf(to))
    if (wOut > this.R.power.wRedline * 1.02) {
      this.refused = true
      return
    }
    this.beginShift(to)
  }

  get stepped(): boolean {
    const k = this.R.gearbox.kind
    return k === 'manual' || k === 'auto' || k === 'dct'
  }

  /** Low range (only ≤ 8 km/h; part-time 4WD engages 4H with it). Returns false if refused. */
  toggleLow(speed: number): boolean {
    if (this.R.drive.low <= 1 || Math.abs(speed) > 2.3) return false
    this.lowRange = !this.lowRange
    // Low range locks the centre (part-time 4WD: 4L; permanent 4×4s like the G-Class lock their centre diff with it).
    if (this.lowRange && (this.R.drive.layout === 'part-time-4WD' || this.R.drive.lockers.includes('centre'))) this.locks.add('centre')
    return true
  }

  /** Cycle the lockers the car has: none → centre → + rear → + front → none. Part-time 4WD: 2H ⇄ 4H. */
  cycleLockers(): void {
    const has = this.R.drive.lockers
    const order: Locker[] = (['centre', 'rear', 'front'] as Locker[]).filter((l) => has.includes(l))
    if (!order.length) return
    // The driver's own choice from here on: the auto 4H stands back.
    this.auto4H = false
    this.autoLocked = false
    const next = order.find((l) => !this.locks.has(l))
    if (next) this.locks.add(next)
    else {
      this.locks.clear()
      if (this.lowRange && this.R.drive.layout === 'part-time-4WD') this.lowRange = false // 4L needs 4H
    }
  }

  // ---------------- the step ----------------

  step(dt: number, input: DriverInput, ch: ChassisIn, w: WheelIn[]): void {
    const R = this.R, n = this.n, P = R.power, gb = R.gearbox
    const h = dt / SUBSTEPS
    const speed = ch.speed
    this.refused = false
    // GTA HANDBRAKE (aids Full): pulled with the wheel straight it is a hard stop on all four wheels (ABS) and the
    // car stays straight; pulled while steering it locks the rear — a handbrake turn. (Aids off: always the lever on
    // the rear; locked rears with straight fronts swapped ends, 1.6 turns from 60 km/h.)
    const hbStop = input.handbrake && this.aids === 'full' && Math.abs(input.steer) < 0.2 && Math.abs(speed) > 1.5
    this.handbrake = input.handbrake && !hbStop
    this.pedals(dt, input, speed)
    if (hbStop) (this.brake = Math.max(this.brake, 0.9)), (this.gas = 0)
    // ---- steering (§8.7): speed-sensitive lock, rack rate, counter-steer help, exact Ackermann ----
    this.steering(dt, input, ch)
    // ---- AUTO 4H (part-time 4WD, aids on): low-grip ground (snow, mud, sand, grass) under the tyres engages the
    // front axle; back on grip (asphalt, packed dirt) it drops to 2H. In 2H a rear-drive pickup on snow can't
    // climb an 8° slope (rear share × μ 0.37 < the slope's pull + rolling resistance). ----
    if (this.auto4H && this.aids !== 'off' && R.drive.layout === 'part-time-4WD') {
      let mu = 0, nc = 0
      for (let i = 0; i < n; i++) if (w[i].contact) (mu += this.grips[i].mu / Math.max(0.3, this.gripScale)), nc++
      if (nc) this.muSeen += (mu / nc - this.muSeen) * Math.min(1, dt * 2)
      if (!this.locks.has('centre') && this.muSeen < 0.7) (this.locks.add('centre'), (this.autoLocked = true))
      else if (this.autoLocked && this.muSeen > 0.8 && !this.lowRange) (this.locks.delete('centre'), (this.autoLocked = false))
    }
    // ---- driveline layout this step ----
    this.weights()
    const G = this.ratioNow()
    // Handbrake: the auto-clutch opens (a driver's left foot goes down with the lever) — the engine keeps its revs
    // and the locked rear isn't fighting the drive; it bites again on release, kicking the slide on.
    const declutch = this.handbrake && (gb.kind === 'manual' || gb.kind === 'dct')
    const coupled = G !== 0 && !(this.shifting && gb.kind === 'manual') && this.selector !== 'P' && this.selector !== 'N' && !declutch
    // ---- shift logic (stepped boxes, once per step) ----
    this.shiftLogic(dt, ch, w)
    // ---- aids (once per step): TCS factor, ESC brake requests ----
    this.aidsPre(dt, ch, w)
    // ---- converter lock-up (auto, CVT) ----
    if (gb.kind === 'auto' || gb.kind === 'cvt') {
      const sr = this.we > 1 ? Math.abs(G * this.carrierSpeed()) / this.we : 0
      if (!this.lockup && sr > 0.85 && (gb.kind === 'cvt' ? Math.abs(speed) > 4 : this.gear >= 2) && !this.shifting) this.lockup = true
      else if (this.lockup && (sr < 0.7 || this.shifting || this.gear < 2 && gb.kind === 'auto')) this.lockup = false
    }
    const clutchMode = coupled && (gb.kind === 'manual' || gb.kind === 'dct' || gb.kind === 'single' || this.lockup)
    // Effective inertia each wheel feels (engine reflected through a locked clutch) — for the overshoot caps.
    for (let i = 0; i < n; i++) this.Ieff[i] = this.I[i] + (clutchMode ? P.inertia * G * G * this.a[i] : 0)
    // Turbo boost lags the throttle (τ = lag).
    if (P.turbo) {
      // Boost builds from half the onset rpm to the onset, with the throttle, lagging by τ.
      const spool = Math.max(0, Math.min(1, (this.we - 0.5 * P.turbo.from) / (0.5 * P.turbo.from)))
      this.boost += (Math.min(1, this.gas * 1.5) * spool - this.boost) * Math.min(1, dt / P.turbo.lag)
    }
    this.accFx.fill(0); this.accFy.fill(0); this.accP.fill(0)
    let absActive = false
    const eff = gb.efficiency
    let sumFz = 0
    this.gripTorque = 0
    for (let i = 0; i < n; i++) {
      if (!w[i].contact) continue
      sumFz += Math.max(0, w[i].Fz)
      if (this.a[i] > 0) this.gripTorque += this.grips[i].mu * Math.max(0, w[i].Fz) * R.axles[i >> 1].radius
    }
    this.spin0.set(this.spin)
    for (let s = 0; s < SUBSTEPS; s++) {
      // ---- power unit ----
      let Te = this.engineTorque(coupled, speed, h)
      if (coupled && Te > 0) Te *= eff // driveline losses
      if (this.shifting && gb.kind !== 'manual') Te *= gb.transfer
      // ---- tyres + brakes per wheel ----
      for (let i = 0; i < n; i++) {
        const wi = w[i], ax = R.axles[i >> 1], r = ax.radius, gp = this.grips[i]
        let Fx = 0, Fy = 0
        if (wi.contact && wi.Fz > 0) {
          const vden = Math.max(Math.abs(wi.vx), 1.5)
          const k = (this.omega[i] * r - wi.vx) / vden
          const ass = Math.atan2(wi.vy, vden)
          this.alpha[i] += (ass - this.alpha[i]) * Math.min(1, ((Math.hypot(wi.vx, wi.vy) + 0.5) / SIGMA) * h)
          this.kappa[i] = k
          const mu = gp.mu * this.heatGrip[i] * Math.max(0.6, 1 - 0.1 * (wi.Fz / this.FzStatic[i] - 1))
          combinedSlip(k, this.alpha[i], gp, this.tmp)
          Fx = this.tmp[0] * mu * wi.Fz
          Fy = this.tmp[1] * mu * wi.Fz
          // Overshoot cap (§8.6): never more than would zero the slip in one substep — counting the wheel's other
          // torques (drive, brakes, diffs: last substep's) — a cap on the slip term alone starves a crawl, where
          // the drive holds the wheel at a small slip speed against a big tyre force.
          const sl = this.omega[i] * r - wi.vx, sg = sl >= 0 ? 1 : -1
          const capX = Math.max(0, sg * ((sl * this.Ieff[i]) / (r * r * h) + this.Text[i] / r))
          if (Fx * sg > capX) Fx = sg * capX
          const mShare = sumFz > 0 ? (this.mass * wi.Fz) / sumFz : this.mass / n
          const capY = (mShare * Math.abs(wi.vy)) / dt
          if (Math.abs(Fy) > capY) Fy = Math.sign(Fy) * capY
          // Sliding power at the contact (heats the tread): force × slip velocity, along and across.
          this.accP[i] += Math.abs(Fx * sl) + Math.abs(Fy * wi.vy)
        } else this.alpha[i] *= 1 - Math.min(1, 8 * h)
        this.accFx[i] += Fx
        this.accFy[i] += Fy
        // Wheel spin: tyre reaction, then brakes + rolling resistance as friction toward 0 (never reversing ω).
        this.omega[i] -= ((Fx * r) / this.I[i]) * h
        this.wTyre[i] = this.omega[i]
        let Tb = this.brake * this.brakeMax[i]
        // EBD (with ABS) / a load-sensing proportioning valve (older trucks): rear brakes follow the rear axle's
        // load — under hard braking a tall car's rear goes light, and full rear pressure would lock it and yaw.
        if (i >= 2) Tb *= Math.max(0.35, Math.min(1, wi.Fz / this.FzStatic[i]))
        // (aids Full: an assist ABS on every car — a hard stop stays straight, like the GTA brakes)
        if ((R.brakes.abs || this.aids === 'full') && this.aids !== 'off' && Math.abs(speed) > 2 && wi.contact) {
          if (this.kappa[i] < -0.15) this.absRel[i] = 1
          else if (this.kappa[i] > -0.06) this.absRel[i] = 0
          if (this.absRel[i] && this.brake > 0.05) (Tb *= 0.25), (absActive = true)
        } else this.absRel[i] = 0
        Tb += (this.escBrake[i] + this.tcsBrake[i]) * this.brakeMax[i]
        if (this.handbrake && (i >> 1) === R.axles.length - 1) Tb += 1.5 * gp.mu * this.FzStatic[i] * r + 0.6 * this.brakeMax[i]
        if (this.selector === 'P') Tb += 1e6
        const crr = gp.crr + gp.sand * 0.1 * Math.min(1, Math.abs(this.kappa[i]))
        const Tf = Tb + (wi.contact ? crr * Math.max(0, wi.Fz) * r : 0)
        const dw = (Tf / this.I[i]) * h
        this.omega[i] = Math.abs(this.omega[i]) <= dw ? 0 : this.omega[i] - Math.sign(this.omega[i]) * dw
      }
      // ---- differentials (impulses) ----
      this.diffs(h)
      // ---- engine ↔ gearbox coupling ----
      this.we += (Te / P.inertia) * h
      if (!coupled) {
        this.clutch = 0
        this.Tcarrier = 0
      } else if (clutchMode) {
        this.couple(G, h, Te)
      } else {
        // Torque converter: impeller absorbs (ω/K)² × (1 − SR²); turbine torque × TR (2.0 → 1.0 over SR 0 → 0.85).
        const wt = G * this.carrierSpeed()
        const sr = this.we > 1 ? wt / this.we : 1
        // (capacity scales with the torque boost so the stall rpm stays where it was)
        let Timp = (this.we / (gb.K / Math.sqrt(this.torqueBoost))) ** 2 * (1 - Math.min(2, sr) ** 2 * Math.sign(sr))
        const TR = sr < 0.85 ? 2 - sr / 0.85 : 1
        // Launch control (TCS on): the transmission's output torque held to what the driven tyres can take.
        if ((this.aids !== 'off' || this.steepClimb) && Timp > 0) Timp = Math.min(Timp, (0.95 * this.gripTorque) / Math.abs(TR * G))
        this.we -= (Timp / P.inertia) * h
        const Tout = Timp * TR * G
        for (let i = 0; i < n; i++) if (this.a[i]) this.omega[i] += ((Tout * this.a[i]) / this.I[i]) * h
        this.Tcarrier = Tout
        this.clutch = Math.max(0, Math.min(1, sr))
      }
      this.we = Math.max(P.kind === 'electric' ? -P.wRedline : P.wIdle * 0.3, this.we)
      // ---- integrate the visible spin; the non-tyre torque on each wheel this substep (for the caps) ----
      for (let i = 0; i < n; i++) {
        this.spin[i] += this.omega[i] * h
        this.Text[i] = ((this.omega[i] - this.wTyre[i]) * this.I[i]) / h
      }
    }
    // ---- outputs: averaged forces, low-speed static friction (hill hold) ----
    // IDLE CREEP: an automatic (torque converter / CVT) in gear with no pedals pulls at idle — it creeps at walking
    // pace, as a real one does — so nothing holds it on level ground; on a slope (> ~4°) the hold stays (the car's
    // auto-hold: it doesn't roll back off its creep).
    // (Off by default: a car that rolled off by itself when the brake or handbrake was let go felt broken — it waits
    // for the gas, like a modern automatic's brake hold.)
    const creep = this.idleCreep && (gb.kind === 'auto' || gb.kind === 'cvt') && (this.selector === 'D' || this.selector === 'R') && Math.abs(ch.pitch) < 0.07
    const hold = this.selector === 'P' || this.brake > 0.05 || input.handbrake || (this.gas < 0.05 && this.selector !== 'N' && !creep)
    // Hill-start assist: pulling away (≤ 1.5 s after the hold, still slow) the tyres won't let the car roll BACK —
    // the static force only ever pushes the way it's driving, until the drive takes over.
    if (hold) this.hillStart = 0
    else this.hillStart += dt
    const assist = !hold && this.hillStart < (this.steepHold ? 4 : 1.5) && Math.abs(speed) < (this.steepHold ? 3 : 1.5) && this.selector !== 'N'
    const dir = this.selector === 'R' ? -1 : 1
    // BOTH PEDALS (a brake-stand): a driven wheel the engine turns against its brake is FREE — its sliding tyre
    // pushes the car (Fx from the slip) and is no part of the static hold. The braked wheels that do hold react
    // that push too (static friction: whatever keeps the car still), each up to what its BRAKE can hold
    // (pedal × its brake torque / r) and its grip — past that the car creeps on.
    const burn = hold && this.gas > 0.05 && this.brake > 0.05 && this.selector !== 'P' && !input.handbrake
    let pushF = 0, pushR = 0, mHeld = 0
    for (let i = 0; i < n; i++) {
      const wi = w[i]
      this.free[i] = burn && wi.contact && wi.Fz > 0 && this.isDriven(i) && Math.abs(this.omega[i]) > 0.05 ? 1 : 0
      if (!wi.contact || wi.Fz <= 0) continue
      if (this.free[i]) {
        // its force in the car frame (forward, right)
        const fx = this.accFx[i] / SUBSTEPS, fy = this.accFy[i] / SUBSTEPS, c = Math.cos(this.steer[i]), s = Math.sin(this.steer[i])
        pushF += fx * c - fy * s
        pushR += fx * s + fy * c
      } else mHeld += sumFz > 0 ? (this.mass * wi.Fz) / sumFz : this.mass / n
    }
    for (let i = 0; i < n; i++) {
      const wi = w[i]
      let Fx = this.accFx[i] / SUBSTEPS, Fy = this.accFy[i] / SUBSTEPS
      if (wi.contact && wi.Fz > 0 && assist) {
        const mShare = sumFz > 0 ? (this.mass * wi.Fz) / sumFz : this.mass / n
        const sx = Math.max(-this.grips[i].mu * wi.Fz, Math.min(this.grips[i].mu * wi.Fz, -mShare * (wi.hx / dt + wi.gx) - wi.sx))
        if (sx * dir > Fx * dir) Fx = sx
      }
      if (wi.contact && wi.Fz > 0 && hold && !this.free[i]) {
        const v = Math.hypot(wi.vx, wi.vy)
        // full hold below 0.16 m/s, none above 0.8 (steepHold: below 0.8, none above 4)
        const k = Math.min(1, Math.max(0, 1.25 - v / (this.steepHold ? 3.2 : 0.64)))
        if (k > 0) {
          const mShare = sumFz > 0 ? (this.mass * wi.Fz) / sumFz : this.mass / n
          // All of the slope's pull and of the body's own travel (Rapier's spring impulse already acted this step).
          let sx = -mShare * (wi.hx / dt + wi.gx) - wi.sx, sy = -mShare * (wi.hy / dt + wi.gy) - wi.sy
          const cap = this.grips[i].mu * wi.Fz
          if (burn && mHeld > 0) {
            // + this wheel's share of the free wheels' push (into its own frame), held by its brake
            const share = mShare / mHeld, c = Math.cos(this.steer[i]), s = Math.sin(this.steer[i])
            sx -= share * (pushF * c + pushR * s)
            sy -= share * (-pushF * s + pushR * c)
            let Tb = this.brake * this.brakeMax[i]
            if (i >= 2) Tb *= Math.max(0.35, Math.min(1, wi.Fz / this.FzStatic[i]))
            const capB = Tb / R.axles[i >> 1].radius
            if (Math.abs(sx) > capB) sx = Math.sign(sx) * capB
          }
          const m = Math.hypot(sx, sy)
          if (m > cap) (sx *= cap / m), (sy *= cap / m)
          Fx += (sx - Fx) * k
          Fy += (sy - Fy) * k
          if (k > 0.5) {
            this.omega[i] = this.selector === 'P' || this.brake > 0.05 ? 0 : wi.vx / R.axles[i >> 1].radius
            // The held wheel turns with the ground only (the substeps' idle creep never happened).
            this.spin[i] = this.spin0[i] + this.omega[i] * dt
          }
        }
      }
      this.Fx[i] = Fx
      this.Fy[i] = Fy
      // VISIBLE SLIP: past the tyre's peak (κ / α normalised by it) AND sliding fast over the ground (m/s) — the slip
      // RATIO alone is huge at a crawl (1 m/s of slip at walking pace) and squealed / smoked on every pull-away.
      let lat = 0, lon = 0
      if (wi.contact && wi.Fz > 0) {
        const gp = this.grips[i], r = R.axles[i >> 1].radius
        const sx = Math.abs(this.omega[i] * r - wi.vx), sy = Math.abs(wi.vy)
        lon = clamp01((Math.abs(this.kappa[i]) / gp.kp - 1.25) / 1.5) * clamp01((sx - 1) / 2)
        lat = clamp01((Math.abs(Math.tan(this.alpha[i])) / Math.tan(gp.ap) - 1.15) / 1.2) * clamp01((sy - 0.8) / 1.7)
        // ABS pumping in a hard stop at speed: the tyres chirp at their limit (a panic stop is heard, a gentle one not).
        if (this.absRel[i] && this.brake > 0.5 && Math.abs(speed) > 8) lon = Math.max(lon, 0.45)
      }
      this.slideVis[i] += (lat - this.slideVis[i]) * Math.min(1, dt * 12)
      this.skidVis[i] += (lon - this.skidVis[i]) * Math.min(1, dt * 12)
      this.slip[i] = Math.max(this.slideVis[i], this.skidVis[i])
    }
    this.traction(dt, speed, w)
    this.thermal(dt, w)
    this.absOn = absActive
    const Tmax = curveTorque(P, Math.max(1, this.we), this.boost) * this.powerScale
    this.load = Tmax > 0 ? Math.max(-1, Math.min(1, this.lastTe / Tmax)) : 0
  }

  /** Engine speed in rpm. */
  get rpm(): number {
    return (this.we * 30) / Math.PI
  }

  /** Display gear: 'P' 'R' 'N', a number (manual / shift map), or 'D' for single-speed / CVT. */
  get gearLabel(): string {
    if (this.selector === 'P' || this.selector === 'N') return this.selector
    if (this.selector === 'R' || this.gear < 0) return 'R'
    if (!this.stepped) return 'D'
    return (this.manual ? 'M' : 'D') + this.gear
  }

  // ---------------- internals ----------------

  private lastTe = 0
  private slideHold = 0
  /** Handbrake held this step (the driver's clutch goes down with it; aids stand back). */
  private handbrake = false
  private tcsI = 1
  private readonly tcsBrake = new Float64Array(8)
  private readonly Text = new Float64Array(8)
  /** Σ over the driven wheels of μ·Fz·r: the most torque the tyres can take (launch control). */
  private gripTorque = 0
  private readonly wTyre = new Float64Array(8)
  /** Spin angles at the start of the step (a held wheel's are re-integrated from the ground speed). */
  private readonly spin0 = new Float64Array(8)

  /**
   * TCS (§8.7, aids std / full), two parts like a real system:
   *  - BRAKE: a driven wheel spinning faster than its axle mate (an open diff feeding a light or lifted wheel) is
   *    braked — the diff then passes the same torque to the wheel with grip.
   *  - ENGINE: when the driven wheels slip past the threshold on average (1.5 × the tyre's peak slip), a
   *    PI controller trims the engine torque and the launch clutch's capacity.
   */
  private traction(dt: number, speed: number, w: WheelIn[]): void {
    const R = this.R, n = this.n
    this.tcsBrake.fill(0)
    // (a steep climb under the off-road assist runs it whatever the aids: past the peak a spinning tyre grips less
    // than the clutch limit, so only cutting the clutch back catches the spin)
    if ((this.aids === 'off' && !this.steepClimb) || this.gas < 0.05 || this.handbrake) {
      this.tcsI = 1
      this.tcs += (1 - this.tcs) * Math.min(1, dt / 0.2)
      this.tcsOn = false
      return
    }
    // Threshold just past the tyre's peak slip (asphalt 0.15, off-road ≈ 0.2 — loose ground wants more slip).
    const thr = 1.5 * this.grips[0].kp
    let kSum = 0, kN = 0, active = false, rimMin = Infinity
    const vden = Math.max(Math.abs(speed), 1.5)
    const dir = this.selector === 'R' ? -1 : 1
    for (let i = 0; i < n; i++) if (this.isDriven(i)) rimMin = Math.min(rimMin, Math.abs(this.omega[i]) * R.axles[i >> 1].radius)
    for (let i = 0; i < n; i++) {
      if (!this.isDriven(i)) continue
      const r = R.axles[i >> 1].radius
      if (w[i].contact) (kSum += Math.max(0, (this.omega[i] * r - (this.steepClimb ? Math.max(0, speed * dir) * dir : speed)) * dir)), kN++
      // Faster than the slowest driven wheel (across the axle or the centre diff) → brake it.
      const d = (Math.abs(this.omega[i]) * r - rimMin) / vden - 0.08
      const k = w[i].contact ? this.kappa[i] - thr : d
      if (d > 0 && k > 0) {
        this.tcsBrake[i] = Math.min(0.8, Math.min(d, k) * 2.5)
        active = true
      }
    }
    // No engine cut while the car rolls BACK against its drive (a hill beating the tyres): less power only makes
    // it worse — that slip is the climb's, and the brakes on a spinning wheel still apply.
    // In slip SPEED: the slip ratio's threshold × speed, but at least 0.4 m/s — at a crawl a ratio threshold
    // allows almost no slip and the engine is cut before the tyres reach their peak.
    const thrV = Math.max(thr * Math.abs(speed), 0.4)
    const err = speed * dir < -0.1 && !this.steepClimb ? 1 : (thrV - (kN ? kSum / kN : 0)) / vden
    this.tcsI = Math.max(0, Math.min(1, this.tcsI + err * 10 * dt))
    this.tcs = Math.max(0, Math.min(1, this.tcsI + 1.5 * err))
    this.tcsOn = active || this.tcs < 0.95
  }
  private hillStart = 9
  private gasIn = 0

  /**
   * TYRE TEMPERATURE, GRIP AND FIRE (TYRE), once per step: the sliding power heats the tread surface, which
   * conducts into the bulk; both lose heat to the air faster the faster the air moves over the tyre (wet ground ×
   * more). Past `ignite` the tyre catches FIRE: the burning rubber adds its own heat while there is tread left, so
   * at a standstill it keeps burning (smoulders); driving fast cools it below `out` and it dies.
   */
  private thermal(dt: number, w: WheelIn[]): void {
    for (let i = 0; i < this.n; i++) {
      const wi = w[i], r = this.R.axles[i >> 1].radius
      const sz = (r / 0.39) * (r / 0.39)
      const P = this.accP[i] / SUBSTEPS
      this.slideP[i] = P
      const Ta = this.airT[i]
      // Air speed over the tread: the car's travel plus a share of its own rim speed (a spinning tyre fans itself).
      const sq = Math.sqrt(Math.hypot(wi.vx, wi.vy) + TYRE.fan * Math.abs(this.omega[i] * r))
      const wet = wi.contact ? 1 + TYRE.wetCool * this.wetT[i] : 1
      const gSA = (TYRE.gSA + TYRE.gSAv * sq) * sz * wet, gBA = (TYRE.gBA + TYRE.gBAv * sq) * sz, gSB = TYRE.gSB * sz
      let Ts = this.treadT[i], Tb = this.coreT[i]
      const ut = Math.sqrt(Math.abs(this.omega[i] * r)), ur = Math.sqrt(Math.hypot(wi.vx, wi.vy))
      // On loose ground the soil moves through the patch (it is dug and thrown, not rubbed), so the tread takes a
      // fraction of the sliding power: a wheelspin on grass dirties the tyre, it doesn't cook it to 200 °C.
      let q = TYRE.eta * Math.max(0.15, (ut + 0.2) / (ut + ur + 0.4)) * P * (1 - TYRE.looseHeat * this.grips[i].offroad)
      if (this.fire[i] > 0) {
        // Burning rubber heats its own tread; the flame dies down as the tread burns away, and the head wind of a
        // moving car blows it off the rubber (less of its heat comes back).
        const pyro = (TYRE.pyro - Ts) / 120
        q += (TYRE.fireW * sz * Math.min(1, this.fuel[i] / (0.25 * TYRE.fuel)) * (pyro <= 0 ? 0 : pyro >= 1 ? 1 : pyro)) / (1 + Math.abs(wi.vx) / TYRE.blowOff)
        this.fuel[i] = Math.max(0, this.fuel[i] - dt)
        this.fire[i] = Ts < TYRE.out || this.fuel[i] <= 0 ? 0 : this.fire[i] + dt // (burnt out: it only smokes now)
      } else if (Ts >= TYRE.ignite && Tb >= TYRE.igniteCore && this.fuel[i] > 0) this.fire[i] = dt
      // (explicit Euler: the surface time constant, cS / Σg ≥ 0.3 s even wet at speed, is ≫ the 1/60 s step)
      const flowSB = gSB * (Ts - Tb)
      Ts += ((q - flowSB - gSA * (Ts - Ta)) / (TYRE.cS * sz)) * dt
      Tb += ((flowSB - gBA * (Tb - Ta)) / (TYRE.cB * sz)) * dt
      // (past its pyrolysis range more heat only gasifies the rubber — the smoke — the surface gets no hotter)
      this.treadT[i] = Math.min(Ts, TYRE.pyro + 60)
      this.coreT[i] = Tb
      const hot = (Ts - TYRE.gripFrom) / (TYRE.gripTo - TYRE.gripFrom)
      this.heatGrip[i] = 1 - TYRE.gripLoss * (hot <= 0 ? 0 : hot >= 1 ? 1 : hot)
    }
  }

  /** Ramped pedals and the P/R/N/D selector from the one throttle axis (§8.6–8.7). */
  private pedals(dt: number, c: DriverInput, v: number): void {
    let gas = 0, brake = 0
    if (c.parked) {
      this.selector = 'P'
      this.gas = 0
      this.brake = 1
      return
    }
    if (this.selector === 'P' || this.selector === 'N') {
      this.selector = 'D'
      this.gear = Math.max(1, this.gear)
    }
    const t = c.throttle
    const fb = c.brake && c.brake > 0 ? Math.min(1, c.brake) : 0
    if (fb > 0) {
      // BOTH PEDALS: the axis is the gas pedal only (W + S never selects reverse; from R at a standstill → D).
      this.revHold = 0
      if (this.selector === 'R' && v > -0.5) (this.selector = 'D'), (this.gear = 1), (this.shifting = false)
      if (this.selector === 'D') (gas = Math.max(0, t)), (brake = Math.max(fb, -t))
      else brake = Math.max(fb, Math.abs(t)) // rolling back in R: both pedals = the brake
    } else if (this.selector === 'D') {
      if (t >= 0) gas = t, (this.revHold = 0)
      else if (v > 0.5) brake = -t, (this.revHold = 0)
      else {
        brake = -t
        this.revHold += dt
        if (this.revHold > 0.3) {
          this.selector = 'R'
          this.gear = -1
          this.shifting = false
        }
      }
    } else {
      // R: S drives backwards, W brakes — then (at a standstill) W selects D.
      if (t <= 0) gas = -t, (this.revHold = 0)
      else if (v < -0.5) brake = t
      else {
        this.selector = 'D'
        this.gear = 1
        gas = t
      }
    }
    this.gasIn = gas
    // Pedal ramps (keys are 0/1; the powertrain never sees a step): gas 0.25 s up / 0.12 s down, brake 0.15 s.
    const up = dt / 0.25, down = dt / 0.12, b = dt / 0.15
    this.gas = gas > this.gas ? Math.min(gas, this.gas + up) : Math.max(gas, this.gas - down)
    this.brake = brake > this.brake ? Math.min(brake, this.brake + b) : Math.max(brake, this.brake - b)
    this.braking = this.brake > 0.05 || (this.R.power.kind === 'electric' && this.regen > 0.3)
    // BURNOUT LAUNCH (auto-clutch: manual / DCT) — what a driver does to break a modest engine's tyres loose: with
    // the brake held at a standstill and the gas floored, the clutch stays IN while the engine revs to ~75 % of the
    // redline, then is DUMPED (the normal bite logic: full capacity above the launch rpm). The flywheel's kick
    // breaks the driven tyres loose; once sliding they need far less torque to keep spinning.
    const gb = this.R.gearbox
    if (this.brake < 0.05 || this.gas < 0.05 || (gb.kind !== 'manual' && gb.kind !== 'dct')) this.burnClutch = 0
    else if (this.burnClutch === 0 && this.brake > 0.3 && this.gas > 0.3 && Math.abs(v) < 0.5 && Math.abs(this.carrierSpeed()) < 0.5) this.burnClutch = 1
    if (this.burnClutch === 1 && this.we > 0.75 * this.R.power.wRedline) this.burnClutch = 2
  }

  private steering(dt: number, c: DriverInput, ch: ChassisIn): void {
    const R = this.R, v = Math.abs(ch.speed)
    const aRear = Math.atan2(ch.rearVy, Math.max(v, 1))
    // Speed-sensitive lock for steering INTO a turn (keys are all-or-nothing); steering INTO A SLIDE (counter-
    // steer: the input's side = the way the rear is sliding) gets the full mechanical lock, as on a real car —
    // without it a slide can't be caught above walking pace.
    const slideK = Math.max(0, Math.min(1, (Math.abs(aRear) - 0.06) / 0.2)) * (c.steer * aRear > 0 ? 1 : 0)
    let lock = R.steering.lock / (1 + v * 0.06 * (1 - slideK))
    // GRIP-LIMITED steering (aids std / full — GTA-smooth keys): a full key at speed asks for about the cornering the
    // front tyres can give on this surface (δ ≈ L·μg / v², a touch of understeer), never 3× it — beyond the limit the
    // rear stepped out and a 0.5 s lane change at 60 km/h spun the truck 135°. Counter-steer keeps the full lock.
    // (+ a fifth of the front tyre's peak slip angle: the wheels visibly turn into a fast bend; more only scrubs the
    // fronts past their peak — no more grip, hot tyres)
    if (this.aids !== 'off' && v > 4 && slideK < 0.5) lock = Math.min(lock, Math.max(0.03, Math.atan((R.wheelbase * 1.05 * this.grips[0].mu * ch.g) / (v * v)) + 0.2 * this.grips[0].ap))
    let target = c.steer * lock
    // Counter-steer help (aids std / full): steer into a rear slide.
    if (this.aids !== 'off' && v > 3 && Math.abs(aRear) > 0.14) target += 0.4 * aRear
    target = Math.max(-R.steering.lock, Math.min(R.steering.lock, target))
    // Rack rate: quick at a crawl, slower at speed — but a counter-steer is a quick hand (as fast as at a crawl).
    const rate = (2.5 + (0.8 - 2.5) * Math.min(1, v / 30) * (1 - slideK)) * (c.steer === 0 ? 1.5 : 1)
    const d = target - this.steerAngle
    this.steerAngle += Math.sign(d) * Math.min(Math.abs(d), rate * dt)
    // Exact Ackermann on every steered axle about the rearmost axle.
    const last = R.axles[R.axles.length - 1].z
    for (let k = 0; k < R.axles.length; k++) {
      const ax = R.axles[k]
      const L = Math.abs(last - ax.z)
      let dl = 0, dr = 0
      if (ax.steered && L > 0.1 && Math.abs(this.steerAngle) > 1e-4) {
        const Rt = L / Math.tan(Math.abs(this.steerAngle))
        const inner = Math.atan(L / (Rt - ax.track / 2)), outer = Math.atan(L / (Rt + ax.track / 2))
        const s = Math.sign(this.steerAngle)
        // Turning right (s > 0): the right wheel is the inner one.
        dl = s * (s > 0 ? outer : inner)
        dr = s * (s > 0 ? inner : outer)
      } else if (ax.steered) dl = dr = this.steerAngle
      this.steer[k * 2] = dl
      this.steer[k * 2 + 1] = dr
    }
  }

  /** Driveline weights a[i] (gearbox output speed = Σ a[i]·ω[i]) for the layout and the lockers this step. */
  private weights(): void {
    const R = this.R, na = R.axles.length, lay = R.drive.layout
    this.a.fill(0)
    this.centreOn = false
    if (lay === 'AWD-permanent') {
      this.setAxle(0, R.drive.split)
      for (let k = 1; k < na; k++) this.setAxle(k, (1 - R.drive.split) / (na - 1))
      this.centreOn = true
    } else if (lay === 'part-time-4WD') {
      if (this.locks.has('centre') || this.lowRange) {
        for (let k = 0; k < na; k++) this.setAxle(k, 1 / na)
        this.centreOn = true
      } else for (let k = 1; k < na; k++) this.setAxle(k, 1 / (na - 1))
    } else if (lay === 'AWD-on-demand') {
      this.setAxle(0, 1)
    } else {
      let nd = 0
      for (let k = 0; k < na; k++) if (R.axles[k].driven) nd++
      for (let k = 0; k < na; k++) if (R.axles[k].driven) this.setAxle(k, 1 / nd)
    }
  }
  /** Gearbox ratio of forward gear k (1-based). Bound once (no closure per step). */
  private readonly gearRatio = (k: number): number => this.R.gearbox.ratios[k - 1]
  private setAxle(k: number, v: number): void {
    this.a[k * 2] = this.a[k * 2 + 1] = v / 2
  }
  /** Wheel i takes drive this step (through the gearbox, or the on-demand coupling). */
  private isDriven(i: number): boolean {
    return this.a[i] > 0 || (this.R.drive.layout === 'AWD-on-demand' && this.R.axles[i >> 1].driven)
  }
  /** Axle k takes drive this step. */
  isDrivenAxle(k: number): boolean {
    return this.isDriven(k * 2)
  }
  private anyContact(w: WheelIn[]): boolean {
    for (let i = 0; i < this.n; i++) if (w[i].contact) return true
    return false
  }

  private ratioOf(gear: number): number {
    const gb = this.R.gearbox
    const low = this.lowRange ? this.R.drive.low : 1
    if (gb.kind === 'single') return (gear < 0 ? -1 : 1) * gb.final * low
    if (gb.kind === 'cvt') return (gear < 0 ? -gb.range[0] : this.cvt) * gb.final * low
    if (gear === 0) return 0
    return (gear < 0 ? -gb.reverse : gb.ratios[gear - 1]) * gb.final * low
  }

  private ratioNow(): number {
    if (this.selector === 'P' || this.selector === 'N') return 0
    return this.ratioOf(this.gear)
  }

  /** Gearbox output (carrier) speed. */
  private carrierSpeed(): number {
    let s = 0
    for (let i = 0; i < this.n; i++) s += this.a[i] * this.omega[i]
    return s
  }

  private outSpeed(): number {
    return this.carrierSpeed()
  }

  private engineTorque(coupled: boolean, speed: number, h: number): number {
    const P = this.R.power
    const we = this.we
    if (P.kind === 'electric') {
      const aw = Math.abs(we)
      let T = this.gas * this.tcs * curveTorque(P, aw) * this.powerScale * this.torqueBoost * (this.boostOn ? this.boostFactor : 1)
      if (aw > P.wRedline * 0.95) T *= Math.max(0, (P.wRedline - aw) / (P.wRedline * 0.05))
      // Lift-off regen, faded out 2 → 0.5 m/s so it never reverses the car (§8.6).
      const fade = Math.max(0, Math.min(1, (Math.abs(speed) - 0.5) / 1.5))
      const rg = coupled && this.gas < 0.02 ? P.regen * P.peakTorque * this.powerScale * fade * (1 + this.brake) : 0
      this.regen = P.peakTorque > 0 ? rg / (P.regen * P.peakTorque * 2 || 1) : 0
      T -= rg * Math.sign(we || 1)
      this.lastTe = T
      return T
    }
    // Idle control (never stalls) and the rev limiter (50 ms fuel cut).
    const idleThr = Math.max(0, Math.min(1, 0.12 + ((P.wIdle - we) / P.wIdle) * 3))
    // Progressive pedal map (drive-by-wire): half pedal ≈ 75 % torque demand, like a real throttle map.
    const demand = 1 - (1 - this.gas) * (1 - this.gas)
    let thr = Math.max(demand * this.tcs, idleThr)
    // A manual shift (clutch open): off the gas on an upshift, a rev-matching blip on a downshift.
    if (this.shifting && this.R.gearbox.kind === 'manual') {
      const target = Math.abs(this.carrierSpeed() * this.ratioOf(this.shiftTo))
      thr = this.shiftTo > this.gear || we > target ? idleThr : 1
    }
    if (we > P.wRedline) this.limiterCut = 0.05
    if (this.limiterCut > 0) (this.limiterCut -= h), (thr = 0)
    const Tfric = (0.05 + 0.15 * (we / P.wRedline)) * P.peakTorque * this.powerScale
    const T = thr * curveTorque(P, we, this.boost) * this.powerScale * this.torqueBoost * (this.boostOn ? this.boostFactor : 1) - (1 - thr) * Tfric
    this.lastTe = T
    return T
  }

  private get boostOn(): boolean {
    return this.nitro && this.gas > 0.5
  }
  /** Shift / BOOST held (nitrous: engine torque × boostFactor). */
  nitro = false

  /** Clutch (or locked converter / EV motor): velocity constraint ωe = G·Σa·ω with a torque capacity. */
  private couple(G: number, h: number, Te: number): void {
    const P = this.R.power, gb = this.R.gearbox, n = this.n
    let cap: number
    if (gb.kind === 'single') cap = Infinity
    else if (this.lockup) cap = 1.5 * P.peakTorque * this.powerScale * this.torqueBoost * this.boostFactor
    else {
      // Auto-clutch: bites over a narrow band just under the launch rpm (≈ 0.75 × torque rpm at full throttle,
      // just over idle when creeping) — the engine is held at the launch rpm while it slips, like a driver's foot.
      // (full throttle launches at the torque peak — where a driver slips the clutch on a hill; 0.75 × left a 1989
      // pickup unable to pull away on 26°)
      const launch = P.wIdle * 1.25 + (Math.max(P.wIdle * 1.6, P.wTorque[0]) - P.wIdle * 1.25) * this.gas
      const e = Math.max(0, Math.min(1, (this.we - 0.85 * launch) / (0.15 * launch)))
      // TCS limits what the slipping clutch passes on (launch control) as well as the engine torque — cutting only
      // the engine drops it out of the bite band and the clutch snatches, cycling the wheelspin.
      cap = e * 1.3 * P.peakTorque * this.powerScale * this.torqueBoost * (this.boostOn ? this.boostFactor : 1) * this.tcs
      // Launch control (TCS on): never more through the slipping clutch than the driven tyres can put down.
      // (and on a steep climb under the off-road assist, whatever the aids)
      if (this.aids !== 'off' || this.steepClimb) cap = Math.min(cap, (0.95 * this.gripTorque) / Math.abs(G))
      this.clutch = e
      // Burnout launch: the clutch held in while the engine revs (then dumped: pedals()).
      if (this.burnClutch === 1) (cap = 0), (this.clutch = 0)
    }
    let inv = 1 / P.inertia, cs = 0
    for (let i = 0; i < n; i++) {
      if (!this.a[i]) continue
      const ga = G * this.a[i]
      inv += (ga * ga) / this.I[i]
      cs += this.a[i] * this.omega[i]
    }
    const C = this.we - G * cs
    let lam = C / inv
    const lim = cap * h
    if (Math.abs(lam) > lim) lam = Math.sign(lam) * lim
    else if (gb.kind !== 'single' && !this.lockup) this.clutch = 1
    this.we -= lam / P.inertia
    for (let i = 0; i < n; i++) if (this.a[i]) this.omega[i] += (lam * G * this.a[i]) / this.I[i]
    this.Tcarrier = (lam / h) * G
    void Te
  }

  /** Differentials as friction-clutch impulses between the two sides (axles) and between axles (centre). */
  private diffs(h: number): void {
    const R = this.R, na = R.axles.length
    for (let k = 0; k < na; k++) {
      const ax = R.axles[k]
      if (!ax.driven && !(this.centreOn || R.drive.layout === 'AWD-on-demand')) continue
      const L = k * 2, Rr = L + 1
      const locked = (k === 0 && this.locks.has('front')) || (k > 0 && this.locks.has('rear')) || ax.diff === 'locked' || this.steepClimb // (climb assist: an open diff would spin one wheel)
      const Ta = Math.abs(this.Tcarrier) * (this.a[L] + this.a[Rr])
      this.pair(L, Rr, locked ? 'locked' : ax.diff, Ta, h)
    }
    if (na < 2) return
    const lay = R.drive.layout
    if (lay === 'AWD-permanent' || (lay === 'part-time-4WD' && this.centreOn)) {
      const mode = this.locks.has('centre') || lay === 'part-time-4WD' ? 'locked' : R.drive.centre
      this.centre(mode, Math.abs(this.Tcarrier), h)
    } else if (lay === 'AWD-on-demand') {
      // Haldex-like: the rear engages by front slip — transfer ∝ speed difference, ≤ 50 % of the drive.
      const dw = this.axleSpeed(0) - this.rearSpeed()
      this.centre('viscous-cap', Math.abs(this.Tcarrier) * 0.5 * Math.min(1, Math.abs(dw) / 2), h)
    }
  }

  private pair(L: number, Rr: number, mode: string, Tin: number, h: number): void {
    if (mode === 'open') return
    const IL = this.I[L], IR = this.I[Rr]
    const dw = this.omega[L] - this.omega[Rr]
    const Peq = dw / (1 / IL + 1 / IR)
    let P = Peq
    const r = this.R.axles[L >> 1].radius
    if (mode === 'lsd') {
      const cap = (0.03 * this.mass * 9.81 * r + 0.4 * Tin) * h
      P = Math.max(-cap, Math.min(cap, Peq))
    } else if (mode === 'torsen') {
      const cap = 0.5 * Tin * h // torque-bias ratio 3
      P = Math.max(-cap, Math.min(cap, Peq))
    } else if (mode === 'viscous') {
      const c = (0.01 * this.mass * 9.81 * r) * dw * h
      P = Math.sign(Peq) * Math.min(Math.abs(Peq), Math.abs(c))
    }
    this.omega[L] -= P / IL
    this.omega[Rr] += P / IR
  }

  private axleSpeed(k: number): number {
    return (this.omega[k * 2] + this.omega[k * 2 + 1]) / 2
  }
  private rearSpeed(): number {
    let s = 0
    const na = this.R.axles.length
    for (let k = 1; k < na; k++) s += this.axleSpeed(k)
    return s / (na - 1)
  }

  /** Centre coupling between the front axle and the rear axle(s). `capT` = torque capacity where it applies. */
  private centre(mode: string, capT: number, h: number): void {
    const na = this.R.axles.length
    const IF = this.I[0] + this.I[1]
    let IR = 0
    for (let i = 2; i < this.n; i++) IR += this.I[i]
    const dw = this.axleSpeed(0) - this.rearSpeed()
    const Peq = dw / (1 / IF + 1 / IR)
    let P = 0
    if (mode === 'locked') P = Peq
    else if (mode === 'lsd' || mode === 'torsen') {
      const cap = (mode === 'torsen' ? 0.5 : 0.4) * capT * h
      P = Math.max(-cap, Math.min(cap, Peq))
    } else if (mode === 'viscous') {
      const c = 0.02 * this.mass * 9.81 * this.R.axles[0].radius * dw * h
      P = Math.sign(Peq) * Math.min(Math.abs(Peq), Math.abs(c))
    } else if (mode === 'viscous-cap') {
      const cap = capT * h
      P = Math.max(-cap, Math.min(cap, Peq))
    }
    if (!P) return
    this.omega[0] -= P / IF
    this.omega[1] -= P / IF
    for (let i = 2; i < this.n; i++) this.omega[i] += P / IR
    void na
  }

  private lastUp = -9
  private lastDown = -9
  private clock = 0
  private sinceShift(dir: number): number {
    return this.clock - (dir > 0 ? this.lastUp : this.lastDown)
  }

  private beginShift(to: number): void {
    const gb = this.R.gearbox
    if (to > this.gear) this.lastUp = this.clock
    else this.lastDown = this.clock
    this.shiftTo = to
    this.shiftT = gb.shift
    this.shifting = true
    this.shiftCool = 0.8
    if (gb.shift <= 0) this.endShift()
  }
  private endShift(): void {
    this.gear = this.shiftTo
    this.shifting = false
  }

  /** §8.6 shift map with hysteresis, holds, kickdown, climb / descent gears. Runs once per step. */
  private shiftLogic(dt: number, ch: ChassisIn, w: WheelIn[]): void {
    const R = this.R, gb = R.gearbox, P = R.power
    this.clock += dt
    this.shiftCool = Math.max(0, this.shiftCool - dt)
    // Ratio swap at the end of a manual shift, half-way for auto / DCT (torque keeps flowing).
    if (this.shifting) {
      this.shiftT -= dt
      const swapAt = gb.kind === 'manual' ? 0 : gb.shift / 2
      if (this.shiftT <= swapAt && this.gear !== this.shiftTo) this.gear = this.shiftTo
      if (this.shiftT <= 0) this.endShift()
      return
    }
    const gasJump = this.gasIn - this.gasHist
    this.gasHist += (this.gas - this.gasHist) * Math.min(1, dt / 0.2)
    this.gasSmooth += (this.gas - this.gasSmooth) * Math.min(1, dt / 0.3)
    if (gb.kind === 'cvt') {
      // Hold a target rpm from the throttle; the ratio slews ≤ 1 ratio/s.
      const wTarget = 1.3 * P.wIdle + (0.9 * P.wPower - 1.3 * P.wIdle) * this.gasSmooth
      const out = Math.abs(this.carrierSpeed()) * gb.final * (this.lowRange ? R.drive.low : 1)
      const want = out > 0.5 ? Math.max(gb.range[1], Math.min(gb.range[0], wTarget / out)) : gb.range[0]
      this.cvt += Math.sign(want - this.cvt) * Math.min(Math.abs(want - this.cvt), dt)
      return
    }
    if (!this.stepped || this.selector !== 'D' || this.manual) return
    const N = gb.ratios.length
    const red = P.wRedline * (P.kind === 'diesel' ? 0.85 : 1)
    const thr = Math.pow(Math.max(0, this.gasSmooth), 0.8)
    const upW = (0.42 + (0.93 - 0.42) * thr) * red
    // Down points sit below where an upshift lands (W56 1→2 at full throttle lands at 0.50 × redline).
    let downW = (0.24 + (0.42 - 0.24) * this.gasSmooth) * red
    const pitchDeg = (ch.pitch * 180) / Math.PI
    if (pitchDeg > 12) downW *= 1.25
    const wIn = Math.abs(this.carrierSpeed() * this.ratioOf(this.gear))
    const airborne = !this.anyContact(w)
    let spinning = false
    for (let i = 0; i < this.n; i++) if (this.isDriven(i) && Math.abs(this.kappa[i]) > 0.25) spinning = true
    // Sliding (rear slip angle > 9°) or the handbrake pulled: no shifts for 1.2 s — a gearbox controller (and a
    // driver) never kicks down into 1st mid-drift: the extra torque only spins the car round.
    const vAbs = Math.max(3, Math.abs(ch.speed))
    if (Math.abs(ch.rearVy) / vAbs > 0.16 || this.handbrake) this.slideHold = 1.2
    else this.slideHold = Math.max(0, this.slideHold - dt)
    const hold = Math.abs(ch.latAccel) > 0.4 * ch.g || airborne || spinning || this.shiftCool > 0 || this.slideHold > 0
    const g = this.gear
    const ratioAt = this.gearRatio
    // Kickdown: a quick stab of throttle drops 1–2 gears if the result stays < 0.85 × redline (not mid-slide).
    if (gasJump > 0.5 && g > 1 && !airborne && this.slideHold <= 0) {
      for (const d of [2, 1]) {
        const to = g - d
        if (to >= 1 && (wIn * ratioAt(to)) / ratioAt(g) < 0.85 * P.wRedline) return this.beginShift(to)
      }
    }
    // Steep climb at a crawl (off-road assist): 1st, and stay there.
    if (this.steepClimb && Math.abs(ch.speed) < 14) {
      if (g > 1 && (wIn * ratioAt(1)) / ratioAt(g) < 0.9 * P.wRedline) return this.beginShift(1)
      return
    }
    if (hold) return
    // Anti-hunting: no part-throttle upshift for 2.5 s after a downshift, no downshift for 1.5 s after an upshift
    // (unless the revs demand it: near the redline / near stalling).
    const sinceDown = this.sinceShift(-1), sinceUp = this.sinceShift(1)
    // Load check: the next gear needs more torque for the same pull (× the ratio step, and the curve where it
    // lands) — upshift only if, at the pedal THAT takes, the revs still clear its own downshift point. Without it
    // a truck on a grade hunts: 3rd needs 60 % pedal → down; 2nd needs 25 % → up; repeat.
    if (g < N && wIn > upW) {
      const wNew = (wIn * ratioAt(g + 1)) / ratioAt(g)
      const T0 = curveTorque(P, wIn, this.boost), T1 = curveTorque(P, wNew, this.boost)
      const demand = 1 - (1 - this.gasSmooth) * (1 - this.gasSmooth)
      const need = Math.min(1, (demand * (ratioAt(g) / ratioAt(g + 1)) * T0) / Math.max(1, T1))
      const pedalNew = 1 - Math.sqrt(1 - need)
      const downNew = (0.24 + (0.42 - 0.24) * pedalNew) * red
      if (need < 0.95 && wNew > downNew + 0.1 * red && (sinceDown > 2.5 || wIn > 0.9 * red)) return this.beginShift(g + 1)
      if (wIn > 0.93 * red && wNew > downW) return this.beginShift(g + 1) // at the limiter: always up
    }
    if (g > 1 && wIn < downW && (wIn * ratioAt(g - 1)) / ratioAt(g) < 0.9 * P.wRedline && (sinceUp > 1.5 || wIn < 0.25 * red)) return this.beginShift(g - 1)
    // Engine-braking gear downhill (pitch < −8°, off the throttle).
    if (g > 1 && pitchDeg < -8 && this.gas < 0.02 && (wIn * ratioAt(g - 1)) / ratioAt(g) < 0.7 * P.wRedline) this.beginShift(g - 1)
  }

  /** ESC (Full aids): brake single wheels toward the reference yaw rate (§8.7). */
  private aidsPre(dt: number, ch: ChassisIn, w: WheelIn[]): void {
    this.escBrake.fill(0)
    this.escOn = false
    if (this.aids !== 'full' || this.n < 4 || this.handbrake) return
    const v = ch.speed
    if (v < 5 || !this.anyContact(w)) return
    const L = this.R.wheelbase
    const d = (this.steer[0] + this.steer[1]) / 2
    let rRef = (v * Math.tan(d)) / (L * (1 + 0.003 * v * v))
    const lim = (this.grips[0].mu * ch.g) / v
    rRef = Math.max(-lim, Math.min(lim, rRef))
    if (this.assistYaw !== 0 && Math.abs(this.assistYaw) > Math.abs(rRef) && (rRef === 0 || Math.sign(this.assistYaw) === Math.sign(rRef))) rRef = this.assistYaw
    const err = ch.yawRate - rRef
    if (Math.abs(err) < 0.08) return
    const amt = Math.min(0.6, (Math.abs(err) - 0.08) * 2)
    const over = Math.abs(ch.yawRate) > Math.abs(rRef) && Math.sign(ch.yawRate) === Math.sign(rRef || ch.yawRate)
    const right = (rRef || ch.yawRate) > 0
    const last = this.n - 2
    if (over) this.escBrake[right ? 0 : 1] = amt // outer front
    else {
      this.escBrake[last + (right ? 1 : 0)] = amt // inner rear
      this.tcs = Math.min(this.tcs, 1 - amt * 0.5)
    }
    this.escOn = true
    void dt
  }
}
