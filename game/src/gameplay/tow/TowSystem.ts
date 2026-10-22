import * as THREE from 'three'
import type RAPIER from '@dimforge/rapier3d-compat'
import type { Game } from '../../game/Game'
import { Groups } from '../../physics/PhysicsWorld'
import type { TowHook } from '../../assets/loadModels'
import { RopeKind, TowEnd, TowOp, cmToM, mToCm, type Rope } from '../../net/protocol'
import { HOOK_REACH, ROPE_MAX, ropeTension, winchIn, type End } from './rope'

/**
 * TOW ROPES — every car carries a winch hook front and rear (scripts/blender/vehicle_hooks.py). On foot, next to ANY
 * car's end (yours, another player's, a bot's), H takes its hook: the line pays out of the fairlead behind you (up to
 * ROPE_MAX). With the hook in hand, H hangs it on a tree / rock / post you stand by, or on another car's hook — or
 * lets it go (it winds home). Next to a hung end, H takes it off. In the car, hold H: the winch reels every rope out
 * of your car in — a car stuck alone hooks a tree and winches itself out; a second car hooked on simply drives off.
 *
 * WHO DECIDES. In a server-physics room (RoomFlags.PHYSICS) the server owns the ropes: H sends a `tow` request, the
 * room's ropes come back in `ropes` (it pulls the cars it simulates — yours too); this side mirrors that list and runs
 * the same line physics on the car it predicts, so the prediction keeps up. Offline / elsewhere the ropes are ours
 * (our car and fixed anchors: other cars there are not physical here).
 * PHYSICS (rope.ts, the server's tow.rs the same): a line that only pulls — a stiff damped spring past its length, at
 * most MAX_TENSION — applied at the fairlead on the body each fixed step.
 * DRAWN: each rope as ROPE_SEGS instanced cylinder segments sagging with its slack; the hook at its far end is the
 * car's own hook part moved there (Car / RemoteCar `placeHook`), so no new material or program.
 * Cost: per rope per fixed step a few flops; per frame ROPE_SEGS matrices; one draw for every rope.
 * (The animations — reaching for the hook, the throw over a branch — come with Mixamo clips: TODO.)
 */
const ROPE_SEGS = 18
const MAX_DRAWN = 16
const ROPE_RADIUS = 0.016
/** How far round the player a tree / rock / post counts as "here" (m), and the hand height it is tied at. */
const ANCHOR_REACH = 1.3
const TIE_HEIGHT = 0.9

export interface RopeEnd {
  car: number
  end: End
}

interface LocalRope extends Rope {
  /** Paid-out line (m) as this side runs it (the winch reels it in between server updates). */
  lenM: number
  /** Tension (N) and fairlead → far end (m) at the last fixed step. */
  tension?: number
  span?: number
}

export type TowAction = 'take' | 'hangCar' | 'hangFixed' | 'drop' | 'unhook' | 'winch' | null

const wireEnd = (e: End): number => (e === 'F' ? TowEnd.FRONT : TowEnd.REAR)
const endOf = (w: number): End => (w === TowEnd.FRONT ? 'F' : 'R')

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3()
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1)
const _up = new THREE.Vector3(0, 1, 0)

export class TowSystem {
  readonly root = new THREE.Group()
  /** What H does right now (the HUD prompt and the touch button read it). */
  action: TowAction = null
  /** The prompt's words for it. */
  label = ''
  private ropes: LocalRope[] = []
  private nextId = 1
  private readonly segs: THREE.InstancedMesh
  /** The chosen target of the current action (set with `action`). */
  private target: { site?: RopeEnd; rope?: LocalRope; point?: THREE.Vector3 } = {}
  private winching = false
  /** The car whose hook we carried at the last server update (-1 none). */
  private lastCarried = -1

  constructor(private readonly game: Game) {
    this.root.name = 'tow-ropes'
    const geo = new THREE.CylinderGeometry(ROPE_RADIUS, ROPE_RADIUS, 1, 6, 1, true).translate(0, 0.5, 0)
    // (unlit-looking dark line: a Lambert on the shared lib material set would need a program of its own anyway)
    const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(0.05, 0.05, 0.055) })
    mat.name = 'lib/towRope'
    this.segs = new THREE.InstancedMesh(geo, mat, ROPE_SEGS * MAX_DRAWN)
    this.segs.count = 0
    this.segs.frustumCulled = false
    this.segs.castShadow = true
    this.segs.name = 'tow-rope-segments'
    this.root.add(this.segs)
  }

  // ------------------------------------------------------------------ who's who

  /** Our entity id (our car is named by it). Offline: 0. */
  private get me(): number {
    return this.game.net.online ? this.game.store.get().net.me : 0
  }
  /** Ropes live on the server (and remote cars are physical) here. */
  private get serverRopes(): boolean {
    return this.game.net.online && this.game.net.isPhysicsRoom
  }

  /** The car's hook model (eye / fairlead, car space) for `end`, or null. */
  private hook(car: number, end: End): TowHook | null {
    const h = car === this.me ? this.game.car.hooks : this.game.remotes.carHooks(car)
    return (end === 'F' ? h?.front : h?.rear) ?? null
  }
  /** The car's rendered pose; false = not here (not drawn / not driving). */
  private frame(car: number, out: THREE.Matrix4): boolean {
    if (car === this.me) {
      const r = this.game.car.root
      r.updateMatrixWorld()
      out.copy(r.matrixWorld)
      return true
    }
    return this.game.remotes.carFrame(car, out)
  }
  /** A car end's fairlead or eye, world. */
  private point(site: RopeEnd, which: 'eye' | 'fairlead', out: THREE.Vector3): THREE.Vector3 | null {
    const h = this.hook(site.car, site.end)
    if (!h || !this.frame(site.car, _m)) return null
    return out.set(...h[which]).applyMatrix4(_m)
  }
  private outOf(site: RopeEnd): LocalRope | undefined {
    return this.ropes.find((r) => r.car === site.car && endOf(r.end) === site.end)
  }
  /** A rope whose far end is hung on this car end. */
  private hungOn(site: RopeEnd): LocalRope | undefined {
    return this.ropes.find((r) => r.kind === RopeKind.CAR && r.who === site.car && endOf(r.end2) === site.end)
  }
  /** Every car near `p` (ours and the drawn remote ones) with its two ends. */
  private sitesNear(p: THREE.Vector3, reach: number): { site: RopeEnd; d: number }[] {
    const out: { site: RopeEnd; d: number }[] = []
    const cars = [this.me, ...this.game.remotes.carIdsNear(p, reach + 4)]
    for (const car of cars) {
      if (car !== this.me && !this.serverRopes) continue // (other cars are only physical in server-physics rooms)
      for (const end of ['F', 'R'] as End[]) {
        const e = this.point({ car, end }, 'eye', _a)
        if (e) {
          const d = Math.hypot(e.x - p.x, e.z - p.z) + Math.max(0, Math.abs(e.y - (p.y + 0.6)) - 0.8)
          if (d < reach) out.push({ site: { car, end }, d })
        }
      }
    }
    return out.sort((a, b) => a.d - b.d)
  }
  /** A tree / rock / post within reach of the player: the point on it to tie to, or null. */
  private anchorNear(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 | null {
    const ph = this.game.physics, R = ph.R
    const at = _c.set(p.x, p.y + TIE_HEIGHT, p.z)
    let best: RAPIER.Collider | null = null, bd = Infinity
    ph.world.intersectionsWithShape(at, { x: 0, y: 0, z: 0, w: 1 }, new R.Ball(ANCHOR_REACH), (c) => {
      const g = c.collisionGroups() >>> 16
      if (!(g & Groups.Static) || c.isSensor() || !c.parent()?.isFixed()) return true
      const pr = c.projectPoint(at, true)
      const d = pr ? Math.hypot(pr.point.x - at.x, pr.point.z - at.z) : Infinity
      if (d < bd) (bd = d), (best = c)
      return true
    })
    if (!best) return null
    const pr = (best as RAPIER.Collider).projectPoint(at, true)
    return pr ? out.set(pr.point.x, at.y, pr.point.z) : null
  }

  // ------------------------------------------------------------------ the H key

  /** Per frame (before `press`): what H would do here. */
  private choose(): void {
    const g = this.game, me = this.me
    this.target = {}
    this.action = null
    if (g.car.driving) {
      if (this.ropes.some((r) => r.car === me && r.kind !== RopeKind.HAND)) (this.action = 'winch'), (this.label = 'Hold to winch in')
      return
    }
    if (g.bike.riding || g.player.dead) return
    const p = g.player.renderPosition
    const carried = this.ropes.find((r) => r.kind === RopeKind.HAND && r.who === me)
    if (carried) {
      const site = this.sitesNear(p, HOOK_REACH).find((s) => s.site.car !== carried.car && !this.outOf(s.site) && !this.hungOn(s.site))?.site
      if (site) {
        this.target = { rope: carried, site }
        this.action = 'hangCar'
        this.label = site.car === me ? 'Hook to your car' : 'Hook to this car'
        return
      }
      const pt = this.anchorNear(p, new THREE.Vector3())
      if (pt) {
        this.target = { rope: carried, point: pt }
        this.action = 'hangFixed'
        this.label = 'Tie the hook here'
        return
      }
      this.target = { rope: carried }
      this.action = 'drop'
      this.label = 'Let go of the hook'
      return
    }
    // a hung end in reach: its far end (tree / other car) or the car it comes out of
    let bestRope: LocalRope | undefined, bd = HOOK_REACH
    for (const r of this.ropes) {
      if (r.kind === RopeKind.HAND) continue
      const far = this.farPoint(r, _b)
      for (const q of [far, this.point({ car: r.car, end: endOf(r.end) }, 'fairlead', _d)]) {
        if (!q) continue
        const d = Math.hypot(q.x - p.x, q.z - p.z)
        if (d < bd) (bd = d), (bestRope = r)
      }
    }
    if (bestRope) {
      this.target = { rope: bestRope }
      this.action = 'unhook'
      this.label = 'Unhook the rope'
      return
    }
    const site = this.sitesNear(p, HOOK_REACH).find((s) => !this.outOf(s.site) && !this.hungOn(s.site))?.site
    if (site) {
      this.target = { site }
      this.action = 'take'
      this.label = site.end === 'F' ? 'Take the front hook' : 'Take the rear hook'
    }
  }

  /** H pressed. */
  press(): void {
    const t = this.target, me = this.me
    switch (this.action) {
      case 'take': {
        const site = t.site!
        if (this.serverRopes) {
          if (site.car === me) this.game.net.vehicle.ensureServerCar()
          return this.send(TowOp.TAKE, site)
        }
        this.ropes.push({ id: this.nextId++, car: site.car, end: wireEnd(site.end), kind: RopeKind.HAND, who: me, end2: 0, pos: [0, 0, 0], len: 0, lenM: ROPE_MAX })
        return
      }
      case 'hangCar': {
        const r = t.rope!, site = t.site!
        if (this.serverRopes) {
          if (site.car === me) this.game.net.vehicle.ensureServerCar()
          return this.send(TowOp.HANG_CAR, { car: r.car, end: endOf(r.end) }, site)
        }
        Object.assign(r, { kind: RopeKind.CAR, who: site.car, end2: wireEnd(site.end) })
        r.lenM = this.slackLen(r)
        return
      }
      case 'hangFixed': {
        const r = t.rope!, p = t.point!
        if (this.serverRopes) return this.send(TowOp.HANG_FIXED, { car: r.car, end: endOf(r.end) }, undefined, p)
        Object.assign(r, { kind: RopeKind.FIXED, pos: [mToCm(p.x), mToCm(p.y), mToCm(p.z)] })
        r.lenM = this.slackLen(r)
        return
      }
      case 'drop':
      case 'unhook': {
        const r = t.rope!
        if (this.serverRopes) return this.send(this.action === 'drop' ? TowOp.DROP : TowOp.UNHOOK, { car: r.car, end: endOf(r.end) })
        this.ropes = this.ropes.filter((q) => q !== r)
        return
      }
    }
  }

  /** The line as hung: what's out now plus a little slack (a hook hung on a taut line would yank the car). */
  private slackLen(r: LocalRope): number {
    const a = this.point({ car: r.car, end: endOf(r.end) }, 'fairlead', _a), b = this.farPoint(r, _b)
    return a && b ? Math.min(ROPE_MAX, a.distanceTo(b) + 0.3) : ROPE_MAX
  }

  private send(op: number, site: RopeEnd, site2?: RopeEnd, p?: THREE.Vector3): void {
    this.game.net.sendTow({
      op, car: site.car, end: wireEnd(site.end), car2: site2?.car ?? 0, end2: site2 ? wireEnd(site2.end) : 0,
      pos: p ? [mToCm(p.x), mToCm(p.y), mToCm(p.z)] : [0, 0, 0],
    })
  }

  /** The room's ropes from the server (server-physics rooms). */
  onRopes(list: Rope[]): void {
    const me = this.me
    const hadHand = this.ropes.some((r) => r.kind === RopeKind.HAND && r.who === me)
    const old = new Map(this.ropes.map((r) => [r.id, r]))
    this.ropes = list.map((r) => {
      const o = old.get(r.id)
      // (our winch runs ahead of the server's count while H is held: keep ours unless it drifted far)
      const lenM = r.len / 100
      return { ...r, lenM: o && this.winching && Math.abs(o.lenM - lenM) < 0.5 ? o.lenM : lenM }
    })
    // (the hook pulled from our hand: we walked past the line's length)
    const lost = hadHand && !this.ropes.some((r) => (r.kind === RopeKind.HAND && r.who === me) || (r.kind !== RopeKind.HAND && r.car === this.lastCarried))
    if (lost) this.game.notify('The rope ran out — the hook is back on the car', 2600)
    this.lastCarried = this.ropes.find((r) => r.kind === RopeKind.HAND && r.who === me)?.car ?? -1
  }

  /** Left the room / joined another: the ropes were the room's. */
  clear(): void {
    this.ropes = []
  }

  // ------------------------------------------------------------------ physics

  /** Fixed step, before the world steps: the lines pull the bodies here (our car; remote stand-ins in physics rooms). */
  fixedStep(dt: number): void {
    const g = this.game, me = this.me
    this.winching = g.car.driving && this.action === 'winch' && g.input.down('KeyH')
    if (this.serverRopes) g.net.towWinch(this.winching)
    for (const r of this.ropes) {
      if (r.kind === RopeKind.HAND) {
        // carried too far: the line runs out — the hook is pulled from the hand (offline; the server does it there)
        if (!this.serverRopes && r.who === me) {
          const a = this.point({ car: r.car, end: endOf(r.end) }, 'fairlead', _a)
          if (a && a.distanceTo(g.player.curr) > ROPE_MAX + 1) {
            r.lenM = -1 // (dropped below)
            g.notify('The rope ran out — the hook is back on the car', 2600)
          }
        }
        continue
      }
      const A = this.endBody(r.car, endOf(r.end))
      const B = r.kind === RopeKind.CAR ? this.endBody(r.who, endOf(r.end2)) : null
      if (!A && !B) continue
      const pa = A ? A.p : this.point({ car: r.car, end: endOf(r.end) }, 'fairlead', _c)
      const pb = r.kind === RopeKind.FIXED ? _d.set(cmToM(r.pos[0]), cmToM(r.pos[1]), cmToM(r.pos[2])) : B ? B.p : this.point({ car: r.who, end: endOf(r.end2) }, 'eye', _d)
      if (!pa || !pb) continue
      const dx = pb.x - pa.x, dy = pb.y - pa.y, dz = pb.z - pa.z
      const d = Math.hypot(dx, dy, dz)
      if (d < 1e-4) continue
      const ux = dx / d, uy = dy / d, uz = dz / d
      // separating speed: (vb − va) · u
      const va = A ? A.v : _a.set(0, 0, 0), vb = B ? B.v : _b.set(0, 0, 0)
      const dd = (vb.x - va.x) * ux + (vb.y - va.y) * uy + (vb.z - va.z) * uz
      const T = ropeTension(d, dd, r.lenM)
      r.tension = T
      r.span = d
      if (this.winching && r.car === me) r.lenM = winchIn(r.lenM, T, dt)
      if (T <= 0) continue
      const j = T * dt
      A?.body.applyImpulseAtPoint({ x: ux * j, y: uy * j, z: uz * j }, pa, true)
      B?.body.applyImpulseAtPoint({ x: -ux * j, y: -uy * j, z: -uz * j }, pb, true)
    }
    if (this.ropes.some((r) => r.lenM < 0)) this.ropes = this.ropes.filter((r) => r.lenM >= 0)
  }

  /** The body a car end pulls (ours; a remote car's stand-in box in a physics room), the fairlead / eye on it, its
   *  velocity there. */
  private endBody(car: number, end: End): { body: RAPIER.RigidBody; p: THREE.Vector3; v: THREE.Vector3 } | null {
    const h = this.hook(car, end)
    if (!h) return null
    let body: RAPIER.RigidBody | null = null
    if (car === this.me) body = this.game.car.sim.body
    else if (this.serverRopes) body = this.game.net.remoteBody(car)
    if (!body) return null
    const t = body.translation(), q = body.rotation()
    const p = new THREE.Vector3(...h.fairlead).applyQuaternion(_q.set(q.x, q.y, q.z, q.w))
    if (car !== this.me) p.y -= this.game.remotes.bodyBoxCentre(car) // (the stand-in box sits at the body's centre)
    p.add(_c.set(t.x, t.y, t.z))
    const lv = body.linvel(), av = body.angvel()
    const rx = p.x - t.x, ry = p.y - t.y, rz = p.z - t.z
    const v = new THREE.Vector3(lv.x + av.y * rz - av.z * ry, lv.y + av.z * rx - av.x * rz, lv.z + av.x * ry - av.y * rx)
    return { body, p, v }
  }

  // ------------------------------------------------------------------ drawing

  /** Where a rope's far end is now (world), or null. */
  private farPoint(r: LocalRope, out: THREE.Vector3): THREE.Vector3 | null {
    if (r.kind === RopeKind.FIXED) return out.set(cmToM(r.pos[0]), cmToM(r.pos[1]), cmToM(r.pos[2]))
    if (r.kind === RopeKind.CAR) return this.point({ car: r.who, end: endOf(r.end2) }, 'eye', out)
    if (r.who === this.me) return this.game.character.handPosition(out)
    return this.game.remotes.handWorld(r.who, out)
  }

  /** Per frame: the prompt, the lines, the hooks at their far ends. */
  update(): void {
    this.choose()
    const hookAction = this.action
    if (this.game.store.get().hookAction !== hookAction) this.game.store.set({ hookAction })
    // every hook back on its car first; the ones out are moved below
    this.game.car.placeHook('F', null)
    this.game.car.placeHook('R', null)
    this.game.remotes.resetHooks()
    let n = 0
    for (const r of this.ropes) {
      const site = { car: r.car, end: endOf(r.end) }
      const a = this.point(site, 'fairlead', _a)
      const b = this.farPoint(r, _b)
      if (!a || !b) continue
      // the hook at the far end, hanging (its eye up), turned along the line
      _d.subVectors(b, a).setY(0)
      const yaw = _d.lengthSq() > 1e-6 ? Math.atan2(_d.x, _d.z) : 0
      _m.compose(b, _q.setFromAxisAngle(_up, yaw), _s)
      if (r.car === this.me) this.game.car.placeHook(site.end, _m)
      else this.game.remotes.placeHook(r.car, site.end, _m)
      // the line: a parabola sagging with the slack (a taut line is straight)
      const d = a.distanceTo(b)
      const sag = Math.min(3, Math.sqrt(Math.max(0, r.lenM * r.lenM - d * d)) * 0.5)
      if (n + ROPE_SEGS > ROPE_SEGS * MAX_DRAWN) continue
      let prev = _c.copy(a)
      for (let i = 1; i <= ROPE_SEGS; i++) {
        const t = i / ROPE_SEGS
        const q = _d.lerpVectors(a, b, t)
        q.y -= 4 * sag * t * (1 - t)
        const len = prev.distanceTo(q)
        if (len > 1e-4) {
          _q.setFromUnitVectors(_up, new THREE.Vector3().subVectors(q, prev).divideScalar(len))
          this.segs.setMatrixAt(n++, _m.compose(prev, _q, _s.set(1, len, 1)))
        }
        prev = prev.copy(q)
      }
      _s.set(1, 1, 1)
    }
    this.segs.count = n
    this.segs.visible = n > 0
    if (n) this.segs.instanceMatrix.needsUpdate = true
  }

  /** Ropes in the world (tests / probes). */
  get list(): readonly Rope[] {
    return this.ropes
  }

  dispose(): void {
    this.segs.geometry.dispose()
    ;(this.segs.material as THREE.Material).dispose()
    this.segs.dispose()
  }
}
