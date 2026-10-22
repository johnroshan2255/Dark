import type RAPIER from '@dimforge/rapier3d-compat'
import { group, Groups, type PhysicsWorld } from '../physics/PhysicsWorld'

/**
 * REMOTE CAR COLLIDERS (rooms whose server simulates the cars): boxes in OUR physics world where the nearest remote
 * cars (people and bots) are, so the locally predicted car meets them where the server's car will — without them it
 * drives through a bot that stops the server's car, and the reconciliation yanks it back.
 * Each box is a DYNAMIC body with a car's mass (no gravity, upright, its height held) whose velocity is steered along
 * the remote's track: a contact exchanges momentum like the server's two cars do. (Kinematic boxes have infinite mass:
 * a head-on reversed our car — twice the server's velocity change, and twice the crash damage.)
 *
 * WHEN: the remote is drawn ~100 ms in the past, but our predicted frame runs AHEAD of the server (applied half a
 * round trip + the server's jitter buffer later); each box is the remote's newest snapshot extrapolated along its
 * velocity to that time. MOTION: a box never jumps (a jumping box hits like a hammer): its velocity is the remote's
 * plus a pull toward the target (≤ CATCH_UP m/s), and it is placed outright only where it can't land on us. SIZE: the
 * model's body bounds as one box. GROUPS: a Vehicle member that meets vehicles' body colliders (our car's exact mesh)
 * and the player (on foot you can't walk through someone's car), not the ground. PARKED cars (a driver who got out, a
 * bot gone for a walk) stand in too, still — the server's car is there and solid. Driving, the boxes are timed for our
 * predicted car; on foot, for now.
 * Cost: ≤ MAX dynamic boxes (one velocity set per frame each).
 */
const MAX = 8
const RANGE = 40
/** Speed a box may close a gap to its target at, on top of the car's own (m/s); farther off than JUMP m it is placed
 *  outright — unless that is within CLEAR m of our car. */
const CATCH_UP = 4
/** A stand-in car's mass (kg) and how hard it is pulled back onto its track (1/s). */
const MASS = 1800
const PULL = 4
const JUMP = 6
const CLEAR = 8

interface Slot {
  body: RAPIER.RigidBody
  collider: RAPIER.Collider
  id: number
  half: [number, number, number]
}

export interface RemoteCarPose {
  id: number
  /** Newest snapshot: server time (ms), the body box's centre (m), yaw, velocity (m/s), the box's half extents. */
  t: number
  x: number
  y: number
  z: number
  yaw: number
  vx: number
  vy: number
  vz: number
  half: [number, number, number]
}

export class RemoteColliders {
  private readonly slots: Slot[] = []

  constructor(private readonly physics: PhysicsWorld) {}

  /** Move a box toward each of the nearest `cars` (≤ RANGE m from `near`) as at server time `t` (ms); `dt` = frame (s). */
  update(cars: RemoteCarPose[], near: { x: number; z: number }, t: number, dt: number): void {
    const R = this.physics.R
    const pick = cars
      .map((c) => ({ c, d: Math.hypot(c.x - near.x, c.z - near.z) }))
      .filter((e) => e.d < RANGE)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX)
    for (let i = 0; i < MAX; i++) {
      const e = pick[i]
      let s = this.slots[i]
      if (!e) {
        if (s) s.body.setEnabled(false)
        continue
      }
      const c = e.c
      if (!s) {
        const body = this.physics.world.createRigidBody(
          R.RigidBodyDesc.dynamic().setGravityScale(0).lockRotations().setLinearDamping(0).setCanSleep(false).enabledTranslations(true, false, true),
        )
        const collider = this.physics.world.createCollider(
          R.ColliderDesc.cuboid(...c.half).setMass(MASS).setCollisionGroups(group(Groups.Vehicle, Groups.Vehicle | Groups.VehicleMesh | Groups.Player)).setFriction(0.35),
          body,
        )
        s = this.slots[i] = { body, collider, id: -1, half: [...c.half] }
      }
      if (s.half[0] !== c.half[0] || s.half[1] !== c.half[1] || s.half[2] !== c.half[2]) {
        s.collider.setHalfExtents({ x: c.half[0], y: c.half[1], z: c.half[2] })
        s.collider.setMass(MASS)
        s.half = [...c.half]
      }
      const lead = Math.max(0, Math.min(0.4, (t - c.t) / 1000))
      const tx = c.x + c.vx * lead, ty = c.y + c.vy * lead, tz = c.z + c.vz * lead
      const h = c.yaw / 2
      const rot = { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) }
      const fresh = !s.body.isEnabled() || s.id !== c.id
      const at = s.body.translation()
      const gap = Math.hypot(tx - at.x, tz - at.z)
      // (a standing car only has to be clear of us by its own size; a moving one by CLEAR)
      const clear = Math.hypot(c.vx, c.vz) < 0.1 ? Math.hypot(c.half[0], c.half[2]) + 1 : CLEAR
      if ((fresh || gap > JUMP) && Math.hypot(tx - near.x, tz - near.z) > clear) {
        // (placed outright: a new car in this slot, or far off — never on top of us)
        s.body.setEnabled(true)
        s.body.setTranslation({ x: tx, y: ty, z: tz }, true)
        s.body.setLinvel({ x: c.vx, y: 0, z: c.vz }, true)
      } else if (fresh) {
        // a new car right by us: no box until it can be placed clear of us (the server still has it)
        s.body.setEnabled(false)
        continue
      } else {
        // its own velocity + a pull toward the track; its height follows the track (it doesn't fall or ride up)
        const k = Math.min(CATCH_UP, gap * PULL) / Math.max(gap, 1e-6)
        s.body.setLinvel({ x: c.vx + (tx - at.x) * k, y: 0, z: c.vz + (tz - at.z) * k }, true)
        if (Math.abs(at.y - ty) > 0.02) s.body.setTranslation({ x: at.x, y: at.y + (ty - at.y) * Math.min(1, dt * 8), z: at.z }, true)
      }
      s.id = c.id
      s.body.setRotation(rot, true)
    }
  }

  /** The box standing in for remote car `id` (a tow rope pulls it), or null. */
  bodyOf(id: number): RAPIER.RigidBody | null {
    const s = this.slots.find((q) => q.id === id && q.body.isEnabled())
    return s ? s.body : null
  }

  /** Not in a server-physics room any more: all boxes off. */
  clear(): void {
    for (const s of this.slots) s.body.setEnabled(false)
  }

  dispose(): void {
    for (const s of this.slots) this.physics.world.removeRigidBody(s.body)
    this.slots.length = 0
  }
}

