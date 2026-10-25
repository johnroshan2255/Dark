import { Buttons, DriveOpts, MAX_INPUT_FRAMES, mToCm, yawToU16, cmToM, type ClientMsg, type InputFrame, type VehicleState } from './protocol'
import type { Game } from '../game/Game'
import { wireModel } from './NetClient'

/**
 * SERVER-AUTHORITATIVE CAR (protocol v4; rooms with RoomFlags.PHYSICS — `server/docs/VEHICLE_PHYSICS.md`).
 *
 * In such a room the server simulates our car with the game's own car model; we never tell it where the car is.
 *  - INPUT: every fixed physics step (1/60 s) the car's controls become one numbered `InputFrame`; packets go out at
 *    30 Hz carrying the last INPUT_REDUNDANCY frames (a lost packet loses no input).
 *  - PREDICTION: the local car keeps running the same model immediately (steering stays instant); after each step
 *    its predicted body state is kept by frame number.
 *  - RECONCILIATION: each `VehicleState` (the server's car after frame `ack`) is compared with what we predicted for
 *    that frame. Under DEADBAND (wider with speed) nothing happens; up to SNAP_M the error is folded in over several
 *    states (BLEND of it per state: position and rotation; velocity too past VEL_FIX_M — and into the later
 *    predictions, so it is never counted twice);
 *    past SNAP_M (a crash the client didn't see, a respawn) the car jumps to the server's state plus the motion
 *    predicted since — visibly, not hidden.
 * Not here: boats, flights and arcade handling (client-simulated and validated, as before) — leaving the
 * Simulation car for one of them takes the server's copy out of the world.
 * Cost: one body-state copy per physics step, a few µs per received state.
 */
const INPUT_REDUNDANCY = 4
const HISTORY = 240
// (2026-10-24, the user: "cars shake for no reason, parked and driving — all maps"): the server's answer comes ~7 frames
// late, and folding 30 % of every 2 cm difference — VELOCITY included — into a car resting on its springs fed back into
// it: parked, the body swayed 27 cm and rocked at 1.8 rad/s, the server ~9 cm off. Now differences inside the deadband
// (6 cm parked, growing with speed: the two simulations never agree to the millimetre) are left alone, the rest is
// folded in gently (12 % per state: position and rotation only), and the velocity only on a real divergence. Parked:
// 1 cm of sway, 0.03 rad/s, the server 4–5 cm off and steady.
const DEADBAND_M = 0.06
const DEADBAND_PER_MS = 0.01
const DEADBAND_RAD = 0.03
const SNAP_M = 3
const SNAP_RAD = 0.6
const BLEND = 0.12
const VEL_FIX_M = 0.6

interface Hist {
  seq: number
  p: [number, number, number]
  q: [number, number, number, number]
  v: [number, number, number]
  w: [number, number, number]
}

export interface SyncStats {
  states: number
  /** Position error at the acked frame (m): last, mean, worst; corrections snapped. */
  err: number
  meanErr: number
  maxErr: number
  snaps: number
  /** Frames sent, frames acked behind the newest (latency in frames). */
  sent: number
  lag: number
  /** States not comparable: their frame not predicted yet (the server's clock ahead of ours) / already dropped. */
  ahead: number
  gone: number
}

export class VehicleSync {
  /** The server simulates our car (we're in it, Simulation handling, in a PHYSICS room). */
  active = false
  private model = 0
  private seq = 0
  private readonly frames: InputFrame[] = []
  private readonly hist: Hist[] = []
  /** One-shot buttons pressed since the last frame (shifts, low range, lockers). */
  private oneShot = 0
  readonly stats: SyncStats = { states: 0, err: 0, meanErr: 0, maxErr: 0, snaps: 0, sent: 0, lag: 0, ahead: 0, gone: 0 }

  constructor(
    private readonly game: Game,
    private readonly send: (m: ClientMsg) => void,
  ) {}

  /** Should the server drive our car now? (Called per frame by NetClient.) */
  private wanted(physicsRoom: boolean): boolean {
    const car = this.game.car
    return physicsRoom && car.driving && !car.sim.arcade && !car.flyMode && !car.boatMode && !car.flying
  }

  /** Per frame: get in / out of the server car as the local one does. `left` = the car itself goes on (boat, flight). */
  update(physicsRoom: boolean): void {
    const want = this.wanted(physicsRoom)
    const model = wireModel(this.game.car.modelId, false)
    if (want && (!this.active || model !== this.model)) {
      const car = this.game.car
      this.active = true
      this.model = model
      this.hist.length = this.frames.length = 0
      this.registered = true
      this.send({ t: 'vehicle', enter: true, model, pos: [mToCm(car.pos.x), mToCm(car.pos.y), mToCm(car.pos.z)], yaw: yawToU16(car.heading) })
    } else if (!want && this.active) {
      this.active = false
      const car = this.game.car
      // on foot (E): the server parks it; into a boat / the air (the car moves on, client-simulated): out of its world
      const goesOn = car.driving
      this.send({ t: 'vehicle', enter: false, model: goesOn ? 0 : this.model, pos: [0, 0, 0], yaw: 0 })
    }
  }

  /** The server has our car (we got in once in this room): a tow rope can be put on it. */
  private registered = false

  /** Make sure the server has our car — parked where it stands — before a rope goes on it (a car never driven in
   *  this room exists only here): in and straight out again, the server parks it. */
  ensureServerCar(): void {
    if (this.registered || this.active) return
    const car = this.game.car
    const model = wireModel(car.modelId, false)
    const pos: [number, number, number] = [mToCm(car.pos.x), mToCm(car.pos.y), mToCm(car.pos.z)]
    this.send({ t: 'vehicle', enter: true, model, pos, yaw: yawToU16(car.heading) })
    this.send({ t: 'vehicle', enter: false, model, pos: [0, 0, 0], yaw: 0 })
    this.registered = true
  }

  /** A new room: it has none of our cars. */
  reset(): void {
    this.active = false
    this.registered = false
  }

  /** A one-shot driving action this frame (Buttons.SHIFT_UP …). */
  press(bits: number): void {
    if (this.active) this.oneShot |= bits
  }

  /** Fixed step, after the car's controls are set and before the world steps: this step's input frame. */
  beforeStep(): void {
    if (!this.active) return
    const c = this.game.car.sim.controls
    const q = (x: number) => Math.max(-127, Math.min(127, Math.round(x * 127)))
    const b = (c.handbrake ? Buttons.HANDBRAKE : 0) | (c.boost ? Buttons.BOOST : 0) | (c.brake ? Buttons.BRAKE : 0) | (this.game.car.lights ? Buttons.LIGHTS : 0)
    this.seq = (this.seq + 1) >>> 0
    this.frames.push({ steer: q(c.steer), throttle: q(c.throttle), footBrake: Math.max(0, Math.min(255, Math.round((c.footBrake ?? 0) * 255))), buttons: b | this.oneShot, lift: q(c.lift ?? 0) })
    this.oneShot = 0
    if (this.frames.length > MAX_INPUT_FRAMES) this.frames.shift()
  }

  /** Fixed step, after the world stepped: what we predict the server's car is after this frame. */
  afterStep(): void {
    if (!this.active || !this.frames.length) return
    const body = this.game.car.sim.body
    const t = body.translation(), r = body.rotation(), v = body.linvel(), w = body.angvel()
    const h = this.hist.length >= HISTORY ? this.hist.shift()! : ({ p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0] } as unknown as Hist)
    h.seq = this.seq
    h.p[0] = t.x; h.p[1] = t.y; h.p[2] = t.z
    h.q[0] = r.x; h.q[1] = r.y; h.q[2] = r.z; h.q[3] = r.w
    h.v[0] = v.x; h.v[1] = v.y; h.v[2] = v.z
    h.w[0] = w.x; h.w[1] = w.y; h.w[2] = w.z
    this.hist.push(h)
  }

  /** At the net send rate: the newest frames. */
  flush(): void {
    if (!this.active || !this.frames.length) return
    const settings = this.game.settings
    const aids = settings.aids === 'off' ? 0 : settings.aids === 'std' ? 1 : 2
    const opts = aids | (settings.offroadAssist ? DriveOpts.OFFROAD : 0) | (settings.gearbox === 'manual' ? DriveOpts.MANUAL : 0)
    this.send({ t: 'input', seq: this.seq, opts, frames: this.frames.slice(-INPUT_REDUNDANCY) })
    this.stats.sent++
  }

  /** The server's car after frame `ack`: reconcile the prediction. */
  onState(s: VehicleState): void {
    if (!this.active) return
    const i = this.hist.findIndex((h) => h.seq === s.ack)
    if (i < 0) {
      if (s.ack > this.seq) this.stats.ahead++
      else this.stats.gone++
      return
    }
    const h = this.hist[i]
    this.hist.splice(0, i) // (older ones are done)
    const st = this.stats
    st.states++
    st.lag = this.seq - s.ack
    const sp = [cmToM(s.pos[0]), cmToM(s.pos[1]), cmToM(s.pos[2])]
    const ex = sp[0] - h.p[0], ey = sp[1] - h.p[1], ez = sp[2] - h.p[2]
    const err = Math.hypot(ex, ey, ez)
    // rotation error: q_err = q_server · q_predicted⁻¹
    const sq = [s.rot[0] / 32767, s.rot[1] / 32767, s.rot[2] / 32767, s.rot[3] / 32767]
    const n = Math.hypot(sq[0], sq[1], sq[2], sq[3]) || 1
    for (let k = 0; k < 4; k++) sq[k] /= n
    const qe = mul(sq, [-h.q[0], -h.q[1], -h.q[2], h.q[3]])
    if (qe[3] < 0) for (let k = 0; k < 4; k++) qe[k] = -qe[k]
    const ang = 2 * Math.acos(Math.min(1, qe[3]))
    st.err = err
    st.meanErr += (err - st.meanErr) * 0.05
    st.maxErr = Math.max(st.maxErr, err)
    const sv = [s.vel[0] / 100, s.vel[1] / 100, s.vel[2] / 100], sw = [s.angvel[0] / 1000, s.angvel[1] / 1000, s.angvel[2] / 1000]
    const speed = Math.hypot(sv[0], sv[1], sv[2])
    if (err < DEADBAND_M + DEADBAND_PER_MS * speed && ang < DEADBAND_RAD) return
    const k = err > SNAP_M || ang > SNAP_RAD ? 1 : BLEND
    if (k === 1) st.snaps++
    const dp = [ex * k, ey * k, ez * k]
    const dq = slerpId(qe, k)
    // (velocities only when the two have really parted — a snap or a sizeable error; small velocity kicks are what set
    //  the delayed correction rocking)
    const kv = k === 1 ? 1 : err > VEL_FIX_M ? BLEND : 0
    const dv = [(sv[0] - h.v[0]) * kv, (sv[1] - h.v[1]) * kv, (sv[2] - h.v[2]) * kv]
    const dw = [(sw[0] - h.w[0]) * kv, (sw[1] - h.w[1]) * kv, (sw[2] - h.w[2]) * kv]
    // the car now, and every prediction after the acked frame, move by the same correction
    const body = this.game.car.sim.body
    const t = body.translation(), r = body.rotation(), v = body.linvel(), w = body.angvel()
    body.setTranslation({ x: t.x + dp[0], y: t.y + dp[1], z: t.z + dp[2] }, true)
    const nr = mul(dq, [r.x, r.y, r.z, r.w])
    body.setRotation({ x: nr[0], y: nr[1], z: nr[2], w: nr[3] }, true)
    body.setLinvel({ x: v.x + dv[0], y: v.y + dv[1], z: v.z + dv[2] }, true)
    this.game.car.velocityCorrected(dv[0], dv[1], dv[2]) // (a correction is not a crash)
    body.setAngvel({ x: w.x + dw[0], y: w.y + dw[1], z: w.z + dw[2] }, true)
    for (let j = 1; j < this.hist.length; j++) {
      const o = this.hist[j]
      for (let a = 0; a < 3; a++) (o.p[a] += dp[a]), (o.v[a] += dv[a]), (o.w[a] += dw[a])
      const oq = mul(dq, o.q)
      for (let a = 0; a < 4; a++) o.q[a] = oq[a]
    }
    if (k === 1) {
      // a snap also takes the server's drivetrain (gear, revs, wheel spins): the prediction restarts from its state
      const D = this.game.car.sim.drivetrain
      if (D) {
        D.gear = s.gear
        D.we = s.engine / 10
        for (let a = 0; a < 4; a++) D.omega[a] = s.omega[a] / 10
      }
    }
  }
}

function mul(a: number[], b: number[]): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}

/** The rotation `k` of the way from identity to q (q.w ≥ 0). */
function slerpId(q: number[], k: number): [number, number, number, number] {
  if (k >= 1) return [q[0], q[1], q[2], q[3]]
  const ang = 2 * Math.acos(Math.min(1, q[3]))
  const s = Math.sqrt(Math.max(0, 1 - q[3] * q[3]))
  if (s < 1e-6) return [0, 0, 0, 1]
  const a = (ang * k) / 2, f = Math.sin(a) / s
  return [q[0] * f, q[1] * f, q[2] * f, Math.cos(a)]
}
