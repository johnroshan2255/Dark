import * as THREE from 'three'
import { ANKLE_HEIGHT, LEG_LENGTH, SEATED_HEIGHT, STAND_HIPS, type CarPose } from '../player/CharacterModel'

/**
 * GETTING IN AND OUT OF A CAR, GTA-style — a timed sequence of authored poses in CAR space (so it stays glued to
 * a car that settles or rolls), drawn by CharacterModel.carPose, with the door it uses swung by the hand that
 * holds it:
 *   approach  walk around the car to the nearest front door (locomotion, by Car)
 *   open      reach for the handle, pull the door open while stepping back out of its way
 *   climbIn   step into the gap, turn to face forward and drop into the seat, inner leg first
 *   close     reach out, pull the door shut (slam) — the car is drivable from here
 *   shuffle   came in on the passenger side: slide across to the wheel
 *   seated    hands on the (turning) steering wheel, feet on the pedals, head turning into corners
 *   openOut   push the driver's door open · climbOut  swing out and stand up · closeOut  push it shut
 * The seated body is scaled to the cab (the cartoon's head is a third of its height) and grows back while
 * climbing out. Pure arithmetic per frame (no allocation): ~0.02 ms CPU, nothing on the GPU.
 */
export type EntryPhase = 'none' | 'approach' | 'open' | 'climbIn' | 'close' | 'shuffle' | 'seated' | 'openOut' | 'climbOut' | 'closeOut'

export interface EntryDoor {
  side: -1 | 1
  hinge: THREE.Vector3
  length: number
  bottom: number
  top: number
}

export interface EntryCar {
  /** Driver's hip point (car space) and the steering wheel: centre, rim normal (down the column), radius. */
  seat: THREE.Vector3
  wheel: THREE.Vector3
  wheelAxis: THREE.Vector3
  wheelRadius: number
  /** Roof underside above the seat (m, car space y). */
  roof: number
  /** Body half width and z extent (approach path around the car). */
  halfX: number
  front: number
  rear: number
}

/** Fully open door (rad). */
export const DOOR_OPEN = 1.1
const DUR: Record<EntryPhase, number> = { none: 0, approach: 0, open: 0.8, climbIn: 1.0, close: 0.6, shuffle: 0.7, seated: 0, openOut: 0.6, climbOut: 0.95, closeOut: 0.6 }
const WALK = 2.3

const sm = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export class CarEntry {
  phase: EntryPhase = 'none'
  /** Seconds into the phase. */
  t = 0
  /** Door in use (index into the car's doors) and its scripted angle this frame (null = not held). */
  door = 0
  doorAngle: number | null = null
  /** Body scale seated in this cab. */
  readonly seatScale: number
  /** Approach: walking position (car space, y unused) and the waypoints left. */
  readonly walk = new THREE.Vector3()
  private readonly path: THREE.Vector3[] = []
  readonly pose: CarPose = {
    hip: new THREE.Vector3(), yaw: 0, sit: 0, lean: 0, scale: 1, head: 1, look: 0,
    footL: new THREE.Vector3(), footR: new THREE.Vector3(), handL: new THREE.Vector3(), handR: new THREE.Vector3(),
  }
  private readonly fL = new THREE.Vector3()
  private readonly fR = new THREE.Vector3()
  private readonly hL = new THREE.Vector3()
  private readonly hR = new THREE.Vector3()
  /** Events for Car this frame. */
  slam = false
  opened = false
  /** Ground height (car space) beside the door in use — set by Car before update(). */
  groundY = 0
  /** Dev / screenshots: freeze the phase at this time (s). */
  hold: number | null = null

  constructor(private readonly car: EntryCar, private readonly doors: EntryDoor[]) {
    // Seated height, slightly reclined; a cramped cab tucks the body in a little (never below 75 %).
    const need = SEATED_HEIGHT * 0.98
    this.seatScale = Math.min(1, Math.max(0.75, (car.roof - 0.05 - car.seat.y) / need))
  }

  get busy(): boolean {
    return this.phase !== 'none' && this.phase !== 'seated'
  }

  /** Start getting in: walk from `from` (car space) to the nearer front door. */
  enter(from: THREE.Vector3): void {
    if (!this.doors.length) return
    let best = 0
    for (let i = 1; i < this.doors.length; i++) if (this.doors[i].side * from.x > this.doors[best].side * from.x) best = i
    this.door = best
    const d = this.doors[best]
    const s = d.side
    const c = this.car
    this.walk.set(from.x, 0, from.z)
    this.path.length = 0
    const hx = c.halfX + 0.5, f = c.front - 0.55, r = c.rear + 0.55
    // Not clear of the body on the door side: go round the nearer end (both corners if on the far side).
    if (from.x * s < hx - 0.1) {
      const zc = from.z < (f + r) / 2 ? f : r
      if (from.x * s < -(hx - 0.3)) this.path.push(new THREE.Vector3(-s * hx, 0, zc))
      if (from.z < f || from.z > r || from.x * s < -(hx - 0.3)) this.path.push(new THREE.Vector3(s * hx, 0, zc))
    }
    this.path.push(this.standPoint(0.42, d.length + 0.06, new THREE.Vector3()))
    this.go('approach')
  }

  /** Start getting out of the driver's door (the car is slow enough). */
  exit(): void {
    this.door = this.doors.findIndex((d) => d.side < 0)
    if (this.door < 0) this.door = 0
    this.go('openOut')
  }

  /** Straight into the driver's seat (tests, dev shots). */
  seatNow(): void {
    this.door = Math.max(0, this.doors.findIndex((d) => d.side < 0))
    this.go('seated')
    this.doorAngle = null
  }

  /** Abort everything (car swapped, player died): nothing scripted any more. */
  reset(): void {
    this.phase = 'none'
    this.doorAngle = null
  }

  private go(p: EntryPhase): void {
    this.phase = p
    this.t = 0
  }

  /** Point beside the door in use: `out` metres outside the skin, `back` metres behind the hinge (car space). */
  private standPoint(out: number, back: number, v: THREE.Vector3): THREE.Vector3 {
    const d = this.doors[this.door]
    return v.set(d.hinge.x + d.side * out, 0, d.hinge.z + back)
  }

  /** Door-space point → car space with the door open by `a`. */
  doorPoint(x: number, y: number, z: number, a: number, out: THREE.Vector3): THREE.Vector3 {
    const d = this.doors[this.door]
    const r = d.side * a
    const c = Math.cos(r), s = Math.sin(r)
    return out.set(d.hinge.x + x * c + z * s, d.hinge.y + y, d.hinge.z - x * s + z * c)
  }

  /** Steering-wheel grip (car space) for a hand, the wheel turned by `turn` rad. */
  grip(side: -1 | 1, turn: number, out: THREE.Vector3): THREE.Vector3 {
    const c = this.car
    const a = c.wheelAxis
    _u.set(1, 0, 0).addScaledVector(a, -a.x).normalize()
    _w.crossVectors(a, _u)
    if (_w.y < 0) _w.negate()
    const phi = side > 0 ? 0.42 : Math.PI - 0.42 // 2 and 10 o'clock
    out.copy(_u).multiplyScalar(Math.cos(phi)).addScaledVector(_w, Math.sin(phi)).multiplyScalar(c.wheelRadius * 0.95)
    out.applyAxisAngle(a, turn).add(c.wheel).addScaledVector(a, -0.03)
    return out
  }

  /** Passenger seat = the driver's mirrored. */
  private seatFor(side: number, v: THREE.Vector3): THREE.Vector3 {
    const s = this.car.seat
    return v.set(side < 0 ? s.x : -s.x, s.y, s.z)
  }

  /**
   * Advance the walk (approach) — returns false when arrived. Car moves the player / locomotion along `walk`.
   */
  stepWalk(dt: number): boolean {
    const target = this.path[0]
    if (!target) return false
    const dx = target.x - this.walk.x, dz = target.z - this.walk.z
    const d = Math.hypot(dx, dz)
    const step = WALK * dt
    if (d <= step) {
      this.walk.set(target.x, 0, target.z)
      this.path.shift()
      return this.path.length > 0
    }
    this.walk.x += (dx / d) * step
    this.walk.z += (dz / d) * step
    return true
  }

  /** Walking direction (car space yaw) toward the next waypoint. */
  get walkYaw(): number {
    const t = this.path[0]
    return t ? Math.atan2(-(t.x - this.walk.x), -(t.z - this.walk.z)) : 0
  }

  /**
   * One frame of the posed phases. `turn` = steering-wheel angle (rad), `steer` −1..1, `inputMove` = the player
   * pushed a movement key (aborts the closing push outside). Returns the phase that just ENDED ('none' if none).
   */
  update(dt: number, turn: number, steer: number, inputMove: boolean): EntryPhase {
    this.slam = this.opened = false
    if (this.phase === 'none' || this.phase === 'approach') return 'none'
    if (this.hold !== null) (this.t = this.hold), (dt = 0)
    else this.t += dt
    const d = this.doors[this.door]
    const s = d.side
    const T = this.t, D = DUR[this.phase]
    const o = this.pose
    const yawIn = s * (Math.PI / 2) // facing the car side, from outside
    const handleY = d.bottom + (d.top - d.bottom) * 0.4
    const sitting = this.seatFor(s, _seat)
    const g = this.groundY
    const sc = this.seatScale
    // Shared defaults.
    o.lean = 0
    o.look = 0
    o.head = 1
    o.scale = 1
    o.handL = o.handR = null
    // Outer hand = the one on the door's side.
    const outerHand = (v: THREE.Vector3 | null) => (s < 0 ? (o.handL = v) : (o.handR = v))
    switch (this.phase) {
      case 'open': {
        // Reach (0–0.25 s), then pull the door open while stepping back out of its sweep.
        const k = sm(0.25, 0.8, T)
        this.doorAngle = DOOR_OPEN * k
        if (T >= 0.25 && T - dt < 0.25) this.opened = true
        this.standPoint(lerp(0.42, 0.62, k), lerp(d.length + 0.06, d.length + 0.4, k), _a)
        this.stand(_a, yawIn - s * 0.35 * k, g)
        outerHand(T < 0.75 ? this.doorPoint(s * 0.04, handleY, d.length * 0.82, this.doorAngle, this.hL) : null)
        o.lean = -0.12 * sm(0, 0.25, T)
        break
      }
      case 'climbIn': {
        this.doorAngle = DOOR_OPEN
        // 0–0.35: step into the gap; 0.3–0.9: up / down into the seat, turning to face forward.
        const k1 = sm(0, 0.35, T), k2 = sm(0.3, 0.9, T)
        this.standPoint(lerp(0.62, 0.22, k1), lerp(d.length + 0.4, d.length * 0.62, k1), _a)
        _a.y = g + STAND_HIPS
        _b.copy(_a).lerp(sitting, k2)
        _b.y += Math.sin(k2 * Math.PI) * Math.max(0.08, sitting.y - _a.y) * 0.35 // a little hop up onto the sill
        o.hip.copy(_b)
        o.yaw = lerp(yawIn - s * 0.35 + s * 0.85 * k1, 0, k2)
        o.sit = k2
        o.scale = lerp(1, sc, sm(0.25, 0.65, T))
        o.head = 1
        o.lean = -0.75 * Math.sin(k2 * Math.PI) // duck under the roof line
        // Feet: the inner foot steps onto the floor first, the outer one follows.
        this.feetStanding(_a, o.yaw, g)
        this.feetSeated(sitting, sc, _c, _d)
        const inner = s < 0 ? this.fR : this.fL, outer = s < 0 ? this.fL : this.fR
        const kIn = sm(0.25, 0.6, T), kOut = sm(0.5, 0.92, T)
        inner.lerp(s < 0 ? _d : _c, kIn).y += Math.sin(kIn * Math.PI) * 0.25
        outer.lerp(s < 0 ? _c : _d, kOut).y += Math.sin(kOut * Math.PI) * 0.25
        o.footL = this.fL
        o.footR = this.fR
        // Hands: the outer one on the door frame while climbing, then both to the wheel (driver side).
        if (k2 > 0.7 && s < 0) {
          o.handL = this.grip(-1, turn, this.hL)
          o.handR = this.grip(1, turn, this.hR)
        }
        break
      }
      case 'close': {
        // Reach out to the door's inside handle and pull it shut (slam at 0.5 s).
        const k = sm(0.12, 0.5, T)
        const a = DOOR_OPEN * (1 - k * k) // accelerates as it swings
        this.doorAngle = a
        if (T >= 0.5 && T - dt < 0.5) this.slam = true
        this.seatedPose(sitting, turn, steer, s < 0)
        if (T < 0.48) outerHand(this.doorPoint(-s * 0.1, handleY, d.length * 0.55, a, s < 0 ? this.hL : this.hR))
        o.lean = 0.1 - 0.25 * Math.sin(Math.min(1, T / 0.48) * Math.PI) // lean out to reach it
        break
      }
      case 'shuffle': {
        this.doorAngle = 0
        const k = sm(0, 1, T / D)
        this.seatFor(1, _a)
        this.seatFor(-1, _b)
        o.hip.copy(_a).lerp(_b, k)
        o.hip.y += Math.sin(k * Math.PI) * 0.05
        o.yaw = 0
        o.sit = 1
        o.scale = sc
        o.head = 1
        o.lean = 0.12
        this.feetSeated(o.hip, sc, this.fL, this.fR)
        o.footL = this.fL
        o.footR = this.fR
        if (k > 0.75) (o.handL = this.grip(-1, turn, this.hL)), (o.handR = this.grip(1, turn, this.hR))
        break
      }
      case 'seated':
        this.doorAngle = null
        this.seatedPose(this.car.seat, turn, steer, true)
        return 'none'
      case 'openOut': {
        const k = sm(0.15, 0.55, T)
        this.doorAngle = DOOR_OPEN * k
        if (T >= 0.15 && T - dt < 0.15) this.opened = true
        this.seatedPose(sitting, turn, steer, true)
        outerHand(this.doorPoint(-s * 0.1, handleY, d.length * 0.55, this.doorAngle, s < 0 ? this.hL : this.hR))
        o.lean = 0.1 - 0.2 * k
        break
      }
      case 'climbOut': {
        this.doorAngle = DOOR_OPEN
        // Reverse of climbIn: legs swing out, stand up beside the door, turn to face it.
        const k2 = sm(0, 0.6, T), k1 = sm(0.55, 0.95, T)
        this.standPoint(lerp(0.22, 0.62, k1), lerp(d.length * 0.62, d.length + 0.4, k1), _a)
        _a.y = g + STAND_HIPS
        _b.copy(sitting).lerp(_a, k2)
        _b.y += Math.sin(k2 * Math.PI) * Math.max(0.06, sitting.y - _a.y) * 0.3
        o.hip.copy(_b)
        o.yaw = lerp(0, yawIn + s * 0.5, k2) - s * 0.85 * k1 // ends where closeOut starts (yawIn − 0.35 s)
        o.sit = 1 - k2
        o.scale = lerp(sc, 1, sm(0.3, 0.7, T))
        o.head = 1
        o.lean = -0.75 * Math.sin(k2 * Math.PI)
        this.feetSeated(sitting, sc, _c, _d)
        this.feetStanding(_a, o.yaw, g)
        // The outer foot reaches the ground first.
        const inner = s < 0 ? this.fR : this.fL, outer = s < 0 ? this.fL : this.fR
        const kOut = sm(0.05, 0.45, T), kIn = sm(0.3, 0.7, T)
        _e.copy(s < 0 ? _c : _d).lerp(outer, kOut)
        _e.y += Math.sin(kOut * Math.PI) * 0.25
        outer.copy(_e)
        _e.copy(s < 0 ? _d : _c).lerp(inner, kIn)
        _e.y += Math.sin(kIn * Math.PI) * 0.25
        inner.copy(_e)
        o.footL = this.fL
        o.footR = this.fR
        break
      }
      case 'closeOut': {
        // Step in and push the door shut by its rear edge (slam at 0.45 s). Moving away cancels it (door left open).
        if (inputMove && T > 0.15) {
          this.doorAngle = null
          this.phase = 'none'
          return 'closeOut'
        }
        const k = sm(0.08, 0.45, T)
        const a = DOOR_OPEN * (1 - k * k)
        this.doorAngle = a
        if (T >= 0.45 && T - dt < 0.45) this.slam = true
        this.standPoint(lerp(0.62, 0.45, k), lerp(d.length + 0.4, d.length + 0.12, k), _a)
        this.stand(_a, yawIn - s * 0.35 * (1 - k), g)
        if (T < 0.47) outerHand(this.doorPoint(s * 0.06, handleY + 0.1, d.length * 0.92, a, s < 0 ? this.hL : this.hR))
        o.lean = -0.15 * Math.sin(Math.min(1, T / 0.47) * Math.PI)
        break
      }
    }
    if (this.t >= D && this.hold === null) {
      const ended = this.phase
      const next: Partial<Record<EntryPhase, EntryPhase>> = {
        open: 'climbIn', climbIn: 'close', close: s < 0 ? 'seated' : 'shuffle', shuffle: 'seated',
        openOut: 'climbOut', climbOut: 'closeOut', closeOut: 'none',
      }
      const to = next[ended] ?? 'none'
      this.go(to)
      if (to === 'none') this.doorAngle = 0
      else if (to === 'seated') this.doorAngle = null
      return ended
    }
    return 'none'
  }

  /** Standing at `p` (car space xz; hips at standing height above `g`), facing `yaw`, feet under the hips. */
  private stand(p: THREE.Vector3, yaw: number, g: number): void {
    const o = this.pose
    o.hip.set(p.x, g + STAND_HIPS - 0.02, p.z)
    o.yaw = yaw
    o.sit = 0
    this.feetStanding(o.hip, yaw, g)
    o.footL = this.fL
    o.footR = this.fR
  }

  private feetStanding(hip: THREE.Vector3, yaw: number, g: number): void {
    const cx = Math.cos(yaw), sx = Math.sin(yaw) // body right = (cos, 0, −sin)
    this.fL.set(hip.x - cx * 0.12, g + ANKLE_HEIGHT, hip.z + sx * 0.12)
    this.fR.set(hip.x + cx * 0.12, g + ANKLE_HEIGHT, hip.z - sx * 0.12)
  }

  /** Feet on the floor in front of a seated hip (facing −Z), scaled with the body. */
  private feetSeated(hip: THREE.Vector3, sc: number, l: THREE.Vector3, r: THREE.Vector3): void {
    // Ankles ~80 % of the leg's reach down and forward: knees bent, soles on the floor / pedals.
    const d = LEG_LENGTH * sc
    l.set(hip.x - 0.12 * sc, hip.y - 0.5 * d, hip.z - 0.62 * d)
    r.set(hip.x + 0.12 * sc, hip.y - 0.5 * d, hip.z - 0.62 * d)
  }

  /** Seated at `hip`, facing forward; hands on the wheel when `wheel` (driver), feet on the pedals. */
  private seatedPose(hip: THREE.Vector3, turn: number, steer: number, wheel: boolean): void {
    const o = this.pose, sc = this.seatScale
    o.hip.copy(hip)
    o.yaw = 0
    o.sit = 1
    o.scale = sc
    o.head = 1
    o.lean = 0.12
    o.look = -steer * 0.35
    this.feetSeated(hip, sc, this.fL, this.fR)
    o.footL = this.fL
    o.footR = this.fR
    if (wheel) {
      o.handL = this.grip(-1, turn, this.hL)
      o.handR = this.grip(1, turn, this.hR)
    } else o.handL = o.handR = null
  }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3()
const _u = new THREE.Vector3(), _w = new THREE.Vector3()
const _seat = new THREE.Vector3()
