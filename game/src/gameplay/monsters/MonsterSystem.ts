import * as THREE from 'three'
import type { AudioSystem } from '../../audio/AudioSystem'
import { Rng } from '../../world/noise/rng'
import type { WorldFields } from '../../world/WorldFields'
import type { PlayerController } from '../player/PlayerController'
import type { Health } from '../survival/Health'
import { MonsterRig } from './MonsterRig'

/**
 * Monsters (refer/monsters, refer/nightmare): active only in MONSTER TIME (night or nightmare realm).
 *
 *  STALKER — hunched 2.5 m shadow humanoid with overlong arms and red eyes. wander → notices the player
 *    (≤ 38 m, or the flashlight pointed at it) → stalks → sprints (≤ 18 m) → attacks at 1.7 m
 *    (18 damage, knockback). Holding the flashlight on it for ~1.2 s makes it flee — the player's defence.
 *  STRIDER — 20 m four-legged giant (nightmare mostly; rarely at night). Walks slowly on planted feet far
 *    from the player; a foot landing within 5 m damages and knocks the player down.
 *
 * Spawns out of view 40–60 m away (striders 80–130 m, may be in view), despawn at dawn (sink) or if left
 * > 120 m behind. Simulation is O(monsters) per frame; all rendering is MonsterRig's 3 draw calls.
 * Ground following uses the analytic height field (no Rapier bodies for monsters — skills/physics).
 */
export interface MonsterBudget {
  stalkers: number
  striders: number
}

type StalkerState = 'wander' | 'stalk' | 'chase' | 'flee' | 'sink'

interface Stalker {
  pos: THREE.Vector3
  yaw: number
  state: StalkerState
  phase: number
  speed: number
  target: THREE.Vector3
  timer: number
  lit: number
  cooldown: number
  sink: number
  twitch: number
}

interface Foot {
  pos: THREE.Vector3
  from: THREE.Vector3
  to: THREE.Vector3
  t: number
  moving: boolean
}

interface Strider {
  pos: THREE.Vector3
  yaw: number
  feet: Foot[]
  sink: number
  bob: number
  heading: THREE.Vector3
  leaving: boolean
}

const _v = new THREE.Vector3()
const _w = new THREE.Vector3()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _f = new THREE.Vector3()
const _r = new THREE.Vector3()

export class MonsterSystem {
  readonly rig = new MonsterRig()
  readonly stalkers: Stalker[] = []
  readonly striders: Strider[] = []
  enabled = true
  budget: MonsterBudget = { stalkers: 1, striders: 0 }
  private rng = new Rng((Date.now() & 0x7fffffff) ^ 0x51f15e)
  private spawnTimer = 6
  private active = false

  constructor(
    private readonly fields: WorldFields,
    private readonly player: PlayerController,
    private readonly health: Health,
    private readonly audio: AudioSystem,
  ) {}

  get count(): number {
    return this.stalkers.length + this.striders.length
  }

  /** The solid ground near height `nearY` (Game: PhysicsWorld.groundBelow — a cave's rock floor, not the carved
   *  height field under it); null = the height field. */
  solid: ((x: number, z: number, nearY: number) => number) | null = null

  private ground(x: number, z: number): number {
    return this.fields.surface(x, z)
  }

  /** Where a walker stands: the solid ground found from its own height (follows a cave floor step by step). */
  private walkGround(x: number, z: number, nearY: number): number {
    return this.solid ? this.solid(x, z, nearY) : this.fields.surface(x, z)
  }

  /** Point `dist` from the player, avoiding the camera's forward cone (spawn out of view). */
  private spawnPoint(dist: number, avoidForward: THREE.Vector3 | null): THREE.Vector3 {
    const p = this.player.renderPosition
    for (let i = 0; i < 12; i++) {
      const a = this.rng.next() * Math.PI * 2
      _v.set(Math.cos(a), 0, Math.sin(a))
      if (avoidForward && _v.dot(avoidForward) > 0.35 && i < 11) continue
      const x = p.x + _v.x * dist
      const z = p.z + _v.z * dist
      return new THREE.Vector3(x, this.ground(x, z), z)
    }
    return new THREE.Vector3(p.x + dist, this.ground(p.x + dist, p.z), p.z)
  }

  spawnStalker(pos: THREE.Vector3): void {
    this.stalkers.push({ pos, yaw: 0, state: 'wander', phase: 0, speed: 0, target: pos.clone(), timer: 0, lit: 0, cooldown: 0, sink: 0, twitch: 0 })
  }

  spawnStrider(pos: THREE.Vector3): void {
    const p = this.player.renderPosition
    const heading = new THREE.Vector3(-(pos.z - p.z), 0, pos.x - p.x).normalize() // walks across the view
    const st: Strider = { pos, yaw: Math.atan2(heading.x, heading.z), feet: [], sink: 0, bob: 0, heading, leaving: false }
    for (let i = 0; i < 4; i++) {
      const f = this.footTarget(st, i, new THREE.Vector3())
      st.feet.push({ pos: f.clone(), from: f.clone(), to: f.clone(), t: 1, moving: false })
    }
    this.striders.push(st)
  }

  clearAll(): void {
    this.stalkers.length = 0
    this.striders.length = 0
  }

  /** Push every monster out of the player's surroundings (after respawn). */
  scatter(): void {
    for (const s of this.stalkers) (s.state = 'sink'), (s.sink = 0)
  }

  /**
   * @param monsterTime night or nightmare
   * @param nightmare 0..1 realm weight (more & bigger monsters)
   * @param camFwd camera forward (xz) for out-of-view spawns
   * @param flash flashlight origin/target and whether it's on
   */
  update(dt: number, monsterTime: boolean, nightmare: number, camFwd: THREE.Vector3, flashOn: boolean, flashOrigin: THREE.Vector3, flashTarget: THREE.Vector3): void {
    const want = this.enabled && monsterTime
    if (want && !this.active) this.spawnTimer = 5 + this.rng.next() * 5
    this.active = want
    const p = this.player.renderPosition

    // Spawning.
    if (want) {
      this.spawnTimer -= dt
      const maxStalkers = this.budget.stalkers + (nightmare > 0.5 ? 2 : 0)
      const maxStriders = nightmare > 0.5 ? Math.max(1, this.budget.striders) : this.budget.striders > 1 ? 1 : 0
      if (this.spawnTimer <= 0) {
        this.spawnTimer = nightmare > 0.5 ? 3 + this.rng.next() * 5 : 8 + this.rng.next() * 12
        const alive = this.stalkers.filter((s) => s.state !== 'sink').length
        const striders = this.striders.filter((s) => !s.leaving).length
        // Giants first in the realm (they're the backdrop), otherwise fill stalkers, then giants.
        const wantStrider = striders < maxStriders && (nightmare > 0.5 ? striders === 0 || this.rng.next() < 0.35 : alive >= maxStalkers)
        if (!wantStrider && alive < maxStalkers) this.spawnStalker(this.spawnPoint(40 + this.rng.next() * 20, camFwd))
        else if (wantStrider) this.spawnStrider(this.spawnPoint(55 + this.rng.next() * 30, null))
      }
    } else {
      for (const s of this.stalkers) if (s.state !== 'sink') (s.state = 'sink'), (s.sink = 0)
      for (const s of this.striders) s.leaving = true
    }

    // Flashlight direction for the repel check.
    _f.subVectors(flashTarget, flashOrigin).normalize()

    for (let i = this.stalkers.length - 1; i >= 0; i--) {
      const m = this.stalkers[i]
      if (!this.updateStalker(m, dt, p, flashOn, flashOrigin)) this.stalkers.splice(i, 1)
    }
    for (let i = this.striders.length - 1; i >= 0; i--) {
      if (!this.updateStrider(this.striders[i], dt, p)) this.striders.splice(i, 1)
    }

    // Draw.
    this.rig.begin()
    for (const m of this.stalkers) this.drawStalker(m)
    for (const s of this.striders) this.drawStrider(s)
    this.rig.end()
  }

  private updateStalker(m: Stalker, dt: number, p: THREE.Vector3, flashOn: boolean, flashOrigin: THREE.Vector3): boolean {
    _v.subVectors(p, m.pos)
    _v.y = 0
    const dist = _v.length()
    if (m.state === 'sink') {
      m.sink += dt * 0.6
      return m.sink < 1
    }
    if (dist > 120) return false
    m.cooldown -= dt
    m.timer -= dt

    // Flashlight on it → it burns and flees.
    _w.subVectors(m.pos, flashOrigin)
    _w.y += 1.5
    const fd = _w.length()
    const inBeam = flashOn && fd < 30 && _w.normalize().dot(_f) > Math.cos(0.4)
    m.lit = inBeam ? m.lit + dt : Math.max(0, m.lit - dt * 0.5)
    if (m.lit > 1.2 && m.state !== 'flee') {
      m.state = 'flee'
      m.timer = 4
      this.audio.monster('screech', dist)
    }

    let speed = 0
    switch (m.state) {
      case 'wander':
        if (_w.set(m.target.x - m.pos.x, 0, m.target.z - m.pos.z).length() < 1.5 || m.timer <= 0) {
          const a = this.rng.next() * Math.PI * 2
          m.target.set(m.pos.x + Math.cos(a) * 12, 0, m.pos.z + Math.sin(a) * 12)
          m.timer = 6
        }
        speed = 1.1
        this.face(m, m.target.x - m.pos.x, m.target.z - m.pos.z, dt, 2)
        if (dist < 38 || inBeam) {
          m.state = 'stalk'
          this.audio.monster('growl', dist)
        }
        break
      case 'stalk':
        speed = 2.3
        this.face(m, _v.x, _v.z, dt, 3)
        if (dist < 18) m.state = 'chase'
        if (dist > 60) m.state = 'wander'
        break
      case 'chase':
        speed = 5.6
        this.face(m, _v.x, _v.z, dt, 6)
        if (dist < 1.7 && m.cooldown <= 0 && !this.health.dead) {
          m.cooldown = 1.3
          this.health.damage(18, 'monster')
          _w.copy(_v).normalize()
          this.player.applyImpulse(_w.x * 6, 3, _w.z * 6, 0.35)
          this.audio.monster('screech', dist)
        }
        if (dist < 1.2) speed = 0
        if (dist > 30) m.state = 'stalk'
        break
      case 'flee':
        speed = 6.5
        this.face(m, -_v.x, -_v.z, dt, 6)
        if (m.timer <= 0) (m.state = 'stalk'), (m.lit = 0)
        break
    }
    m.speed += (speed - m.speed) * Math.min(1, dt * 4)
    m.pos.x += Math.sin(m.yaw) * m.speed * dt
    m.pos.z += Math.cos(m.yaw) * m.speed * dt
    m.pos.y = this.walkGround(m.pos.x, m.pos.z, m.pos.y)
    m.phase += dt * (1.5 + m.speed * 1.4)
    m.twitch = Math.max(0, m.twitch - dt)
    if (this.rng.next() < dt * 0.6) m.twitch = 0.25
    // Separation from other stalkers.
    for (const o of this.stalkers) {
      if (o === m) continue
      _w.subVectors(m.pos, o.pos)
      _w.y = 0
      const d = _w.length()
      if (d > 0.01 && d < 1.4) m.pos.addScaledVector(_w, ((1.4 - d) / d) * 0.5)
    }
    return true
  }

  private face(m: { yaw: number }, dx: number, dz: number, dt: number, rate: number): void {
    const target = Math.atan2(dx, dz)
    let d = target - m.yaw
    d = Math.atan2(Math.sin(d), Math.cos(d))
    m.yaw += d * Math.min(1, dt * rate)
  }

  private drawStalker(m: Stalker): void {
    const rig = this.rig
    const sinkY = -m.sink * 3
    const fx = Math.sin(m.yaw), fz = Math.cos(m.yaw)
    const rx = fz, rz = -fx
    const base = _a.copy(m.pos)
    base.y += sinkY
    const gait = Math.min(1, m.speed / 4)
    const hip = (side: number, out: THREE.Vector3) => out.set(base.x + rx * side * 0.16, base.y + 1.2, base.z + rz * side * 0.16)
    const place = (o: THREE.Vector3, from: THREE.Vector3, fwd: number, up: number, side: number) =>
      o.set(from.x + fx * fwd + rx * side, from.y + up, from.z + fz * fwd + rz * side)

    for (const side of [-1, 1]) {
      const sw = Math.sin(m.phase + (side > 0 ? 0 : Math.PI)) * 0.55 * gait
      const h = hip(side, _b)
      const knee = place(_c, h, Math.sin(sw) * 0.6 + 0.12, -Math.cos(sw) * 0.6, side * 0.03)
      const foot = place(_r, knee, Math.sin(sw - 0.4 * gait) * 0.62, -Math.cos(sw - 0.4 * gait) * 0.62, 0)
      rig.segment(h, knee, 0.07)
      rig.segment(knee, foot, 0.055)
    }
    // Hunched torso leaning forward, head jutting ahead of the shoulders.
    const chest = _b.set(base.x + fx * 0.3, base.y + 1.85, base.z + fz * 0.3)
    rig.blob(_c.set(base.x + fx * 0.15, base.y + 1.5, base.z + fz * 0.15), 0.26, 0.5, 0.2, m.yaw, 0.5)
    const tw = m.twitch > 0 ? Math.sin(m.twitch * 90) * 0.12 : 0
    const head = _r.set(base.x + fx * 0.6 + rx * tw, base.y + 2.05, base.z + fz * 0.6 + rz * tw)
    rig.blob(head, 0.15, 0.2, 0.17, m.yaw)
    for (const side of [-1, 1]) {
      const sw = Math.sin(m.phase + (side > 0 ? Math.PI : 0)) * 0.5 * gait + (m.state === 'chase' ? -0.9 : 0)
      const sh = new THREE.Vector3(chest.x + rx * side * 0.3, chest.y, chest.z + rz * side * 0.3)
      const el = new THREE.Vector3(sh.x + fx * Math.sin(sw) * 0.85 + rx * side * 0.12, sh.y - Math.cos(sw) * 0.85, sh.z + fz * Math.sin(sw) * 0.85 + rz * side * 0.12)
      const hand = new THREE.Vector3(el.x + fx * (Math.sin(sw) * 0.9 + 0.25), el.y - 0.85, el.z + fz * (Math.sin(sw) * 0.9 + 0.25))
      rig.segment(sh, el, 0.055)
      rig.segment(el, hand, 0.045)
      // Long claw fingers.
      rig.segment(hand, new THREE.Vector3(hand.x + fx * 0.2, hand.y - 0.3, hand.z + fz * 0.2), 0.02)
    }
    const flicker = m.lit > 0.3 ? 0.5 + 0.5 * Math.sin(m.lit * 40) : 1
    for (const side of [-1, 1]) {
      rig.eye(new THREE.Vector3(head.x + fx * 0.14 + rx * side * 0.06, head.y + 0.03, head.z + fz * 0.14 + rz * side * 0.06), 0.03 * flicker)
    }
  }

  // ---------------------------------------------------------------- strider

  private footTarget(s: Strider, i: number, out: THREE.Vector3): THREE.Vector3 {
    const a = s.yaw + (i * Math.PI) / 2 + Math.PI / 4
    const x = s.pos.x + Math.sin(a) * 7 + s.heading.x * 3
    const z = s.pos.z + Math.cos(a) * 7 + s.heading.z * 3
    return out.set(x, this.ground(x, z), z)
  }

  private updateStrider(s: Strider, dt: number, p: THREE.Vector3): boolean {
    if (s.leaving) s.sink += dt * 0.15
    if (s.sink >= 1) return false
    s.pos.addScaledVector(s.heading, 1.6 * dt)
    s.pos.y = this.ground(s.pos.x, s.pos.z)
    s.bob += dt
    if (s.pos.distanceTo(p) > 190) s.leaving = true
    // Step one leg at a time when its foot falls too far behind its rest target.
    const anyMoving = s.feet.some((f) => f.moving)
    s.feet.forEach((f, i) => {
      if (f.moving) {
        f.t = Math.min(1, f.t + dt / 1.1)
        f.pos.lerpVectors(f.from, f.to, f.t)
        f.pos.y += Math.sin(f.t * Math.PI) * 4
        if (f.t >= 1) {
          f.moving = false
          // Foot slam: near the player → damage + knockdown.
          _w.subVectors(p, f.to)
          _w.y = 0
          const d = _w.length()
          if (d < 5 && !this.health.dead) {
            this.health.damage(d < 2.5 ? 35 : 15, 'monster')
            _w.normalize()
            this.player.applyImpulse(_w.x * 9, 5, _w.z * 9, 1.4)
          }
          if (d < 40) this.audio.thunder(d * 4) // heavy thud
        }
      } else if (!anyMoving) {
        this.footTarget(s, i, _v)
        if (_v.distanceTo(f.pos) > 5.5) {
          f.moving = true
          f.t = 0
          f.from.copy(f.pos)
          f.to.copy(_v)
        }
      }
    })
    return true
  }

  private drawStrider(s: Strider): void {
    const rig = this.rig
    const sink = s.sink * 24
    const body = _a.set(s.pos.x, s.pos.y + 19 + Math.sin(s.bob * 1.3) * 0.5 - sink, s.pos.z)
    const fx = s.heading.x, fz = s.heading.z
    rig.blob(body, 2.6, 4.0, 2.0, s.yaw, 0.2)
    const head = _b.set(body.x + fx * 2.2, body.y + 4.2, body.z + fz * 2.2)
    rig.blob(head, 1.3, 1.8, 1.3, s.yaw)
    s.feet.forEach((f, i) => {
      const a = s.yaw + (i * Math.PI) / 2 + Math.PI / 4
      const hip = new THREE.Vector3(body.x + Math.sin(a) * 1.2, body.y - 0.8, body.z + Math.cos(a) * 1.2)
      const foot = _c.copy(f.pos)
      foot.y -= sink
      // Knee high above and outside the hip→foot line (spider-like).
      const knee = new THREE.Vector3().lerpVectors(hip, foot, 0.4)
      knee.x += Math.sin(a) * 3.5
      knee.z += Math.cos(a) * 3.5
      knee.y += 5
      rig.segment(hip, knee, 0.75)
      rig.segment(knee, foot, 0.5)
    })
    // Dangling arms under the body (refer/nightmare silhouette).
    for (const side of [-1, 1]) {
      const sh = new THREE.Vector3(body.x - fz * side * 1.0, body.y + 0.8, body.z + fx * side * 1.0)
      const hand = new THREE.Vector3(sh.x - fz * side * 1.5 + fx * Math.sin(s.bob + side) * 1.5, sh.y - 9, sh.z + fx * side * 1.5 + fz * Math.sin(s.bob + side) * 1.5)
      rig.segment(sh, hand, 0.35)
    }
    for (const side of [-1, 1]) rig.eye(new THREE.Vector3(head.x + fx * 1.15 - fz * side * 0.5, head.y + 0.2, head.z + fz * 1.15 + fx * side * 0.5), 0.6)
  }

  dispose(): void {
    this.rig.dispose()
  }
}
