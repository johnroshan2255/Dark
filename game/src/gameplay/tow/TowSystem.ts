import * as THREE from 'three'
import type RAPIER from '@dimforge/rapier3d-compat'
import type { Game } from '../../game/Game'
import { Groups } from '../../physics/PhysicsWorld'
import type { TowHook } from '../../assets/loadModels'
import { RopeKind, TowEnd, TowOp, cmToM, mToCm, type Rope } from '../../net/protocol'
import { HOOK_REACH, ROPE_MAX, ropeTension, winchIn, type End } from './rope'
import { TRUNK_RADIUS } from '../../world/types'
import { trunkGirth } from '../../world/Forest/treeFactory'
import { PILLAR_REACH } from '../../world/map/FixedMap'
import type { CharacterModel } from '../player/CharacterModel'

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
 * AS A REAL WINCH: the drum free-spools as you walk the hook out, so the line paid out is what you've walked (it
 * trails behind you on the ground, it isn't a 25 m loop in the air); a tree gets a trunk strap low on the trunk and the
 * hook goes on the strap (the line is never wrapped round the tree); hung, the line keeps a little slack until the
 * winch takes it up.
 * DRAWN: each rope a verlet chain of LINE_PTS points (gravity, an inextensible line that only resists stretching,
 * lying ON the terrain: every point kept above the ground under it) — instanced cylinder segments; the hook at its
 * far end is the car's own hook part moved there (Car / RemoteCar `placeHook`); tree straps one instanced band each.
 * Cost: per rope per fixed step a few flops; per frame LINE_PTS × LINE_ITERS constraint steps, LINE_PTS ground
 * samples and matrices; one draw for every rope, one for every strap.
 * ANIMATED (Mixamo clips, scripts/blender/hero/hero_clips_add.py): first a couple of steps up to the hook (in front of
 * the bumper / facing the trunk), then a crouch and a right-hand grab (`hook_low`, blended toward the standing
 * `hook_reach` the higher the hook is over the feet) with the hand put ON the hook by arm IK (CharacterModel
 * `playGesture`); carrying, the hook hangs from the right hand by the side. Every character — ours and the remote ones — plays them when the room's ropes
 * change (so others see it too); the hook is drawn where it was until the hand gets there.
 */
/** The two reaching clips: the moment the hand is at the hook and where to cut it off (clip s), and how soon into the
 *  gesture the grab comes (s). LOW crouches and grabs near the ground, HIGH reaches out standing at chest height. */
const LOW = { name: 'hook_low', grab: 1.6, end: 2.78, at: 1.0 }
const HIGH = { name: 'hook_reach', grab: 1.01, end: 2.15, at: 0.78 }
/** The hook's height over the feet of whoever reaches (m) where the gesture goes from all LOW to all HIGH (the two
 *  blended in between — a hook at the hip is a half crouch; on a slope a strap uphill can be at chest height). */
const LOW_TO = 0.7
const HIGH_FROM = 1.3
/** Where the feet stand for it: this far (m, flat) back from a car's hook (clear of the bumper and a spare wheel) /
 *  from the strap on a trunk. */
const STAND = 0.65
const STAND_TREE = 0.5
const LINE_PTS = 22
const LINE_ITERS = 24
const MAX_DRAWN = 16
const ROPE_RADIUS = 0.014
/** How far round the player a tree / rock / post counts as "here" (m), and the height a hook is hung on a rock / post
 *  (m over the ground). */
const ANCHOR_REACH = 1.3
const TIE_HEIGHT = 0.6
/** Trees: the strap this far up the trunk model (× the tree's scale: ~0.45–0.8 m). */
const STRAP_AT = 0.55
/** Paid out past the hand when walking the hook out (m): the bit lying slack on the ground behind. */
const PAY_SLACK = 0.6

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
const _gr = new Float32Array(LINE_PTS)

export class TowSystem {
  readonly root = new THREE.Group()
  /** What H does right now (the HUD prompt and the touch button read it). */
  action: TowAction = null
  /** The prompt's words for it. */
  label = ''
  private ropes: LocalRope[] = []
  private nextId = 1
  private readonly segs: THREE.InstancedMesh
  private readonly straps: THREE.InstancedMesh
  /** The chosen target of the current action (set with `action`). */
  private target: { site?: RopeEnd; rope?: LocalRope; point?: THREE.Vector3; axis?: THREE.Vector3 } = {}
  private winching = false
  /** Rope id → its kind and holder as last seen, and (until `until`, ms) where the hook is still drawn: on the car
   *  (being taken) or in the holder's hand (being hung). */
  private readonly seen = new Map<number, { kind: number; who: number; until: number; from: 'car' | 'hand'; goal?: THREE.Vector3 }>()
  /** The car whose hook we carried at the last server update (-1 none). */
  private lastCarried = -1
  /** H pressed: walking up to the hook; `run` does it once there (or `at`, ms, for an unhook mid-gesture). */
  private pending: { run: () => void; at: number } | null = null
  /** Rope id → its drawn line: points, previous points (verlet), paid-out length while carried. */
  private readonly lines = new Map<number, { p: Float32Array; o: Float32Array; paid: number }>()
  /** Rope id → its tree strap (a band round the trunk), null = tied to a rock / post (no strap drawn). */
  private readonly strapOf = new Map<number, THREE.Matrix4 | null>()
  private lastFrame = 0

  constructor(private readonly game: Game) {
    this.root.name = 'tow-ropes'
    const geo = new THREE.CylinderGeometry(ROPE_RADIUS, ROPE_RADIUS, 1, 6, 1, true).translate(0, 0.5, 0)
    // (unlit-looking dark line: a Lambert on the shared lib material set would need a program of its own anyway)
    const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(0.05, 0.05, 0.055) })
    mat.name = 'lib/towRope'
    this.segs = new THREE.InstancedMesh(geo, mat, (LINE_PTS - 1) * MAX_DRAWN)
    this.segs.count = 0
    this.segs.frustumCulled = false
    this.segs.castShadow = true
    this.segs.name = 'tow-rope-segments'
    this.root.add(this.segs)
    // tree-trunk protector strap: a 7.5 cm band (unit radius, scaled to the trunk), the same program as the line
    const sMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(0.55, 0.32, 0.04), side: THREE.DoubleSide })
    sMat.name = 'lib/towStrap'
    this.straps = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 0.075, 14, 1, true), sMat, MAX_DRAWN)
    this.straps.count = 0
    this.straps.frustumCulled = false
    this.straps.name = 'tow-tree-straps'
    this.root.add(this.straps)
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
  /** A car end a new rope can use: nothing on it, and the car is ours or someone is at its wheel (the server's rule: a
   *  parked car's moves aren't sent to anyone, so nobody else hooks it). */
  private free(site: RopeEnd): boolean {
    return !this.outOf(site) && !this.hungOn(site) && (site.car === this.me || this.game.remotes.isDriving(site.car))
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
  /** A tree / rock / post within reach of the player: the point on it to tie to, or null; a tree's axis into `axis`. */
  private anchorNear(p: THREE.Vector3, out: THREE.Vector3, axis?: THREE.Vector3): THREE.Vector3 | null {
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
    if (!pr) return null
    out.set(pr.point.x, this.ground(pr.point.x, pr.point.z) + TIE_HEIGHT, pr.point.z)
    // a tree: the shackle on the strap, on the bark facing us
    const tr = this.trunkOf(best)
    if (tr) {
      _d.set(p.x - tr.x, 0, p.z - tr.z)
      if (_d.lengthSq() < 1e-6) _d.set(1, 0, 0)
      _d.normalize().multiplyScalar(tr.r + 0.03)
      out.set(tr.x + _d.x, tr.y, tr.z + _d.z)
      axis?.set(tr.x, tr.y, tr.z)
    }
    return out
  }

  /** A tree trunk: its axis, where the strap goes (STRAP_AT up the model: above the root flare, below the branches)
   *  and the DRAWN radius there (the bark, not the thinner collider), or null (rock, post, landmark). Trunk colliders
   *  are cylinders 3 × the tree's scale high (PhysicsWorld), their radius the species' TRUNK_RADIUS × scale — which
   *  names the species whose model is measured. */
  private trunkOf(c: RAPIER.Collider): { x: number; y: number; z: number; r: number } | null {
    const R = this.game.physics.R
    if (c.shapeType() !== R.ShapeType.Cylinder) return null
    const sh = c.shape as RAPIER.Cylinder, ct = c.translation()
    const s = sh.halfHeight / 3, r0 = sh.radius / s
    let r = 0
    TRUNK_RADIUS.forEach((tr, id) => {
      if (Math.abs(tr - r0) < 0.004) r = Math.max(r, (trunkGirth(id, STRAP_AT, tr) ?? 0) * s)
    })
    // not a tree of the scatter (a sandstone pillar, a post): the strap at the tie height round its outline
    if (!r) return { x: ct.x, y: ct.y - sh.halfHeight + TIE_HEIGHT, z: ct.z, r: sh.radius * (sh.radius > 2 ? PILLAR_REACH : 1.15) }
    return { x: ct.x, y: ct.y - sh.halfHeight + STRAP_AT * s, z: ct.z, r }
  }

  /** The drawn ground at (x, z): the loaded chunk's surface (road ribbon included), else the terrain field. */
  private ground(x: number, z: number): number {
    const w = this.game.world
    return w.groundAt(x, z) ?? w.fields.surface(x, z)
  }

  /** The trunk a hook tied at `p` is on: its strap's pose (a band round it at that height), null = not a trunk. */
  private strapAt(p: THREE.Vector3): THREE.Matrix4 | null {
    const ph = this.game.physics, R = ph.R
    let m: THREE.Matrix4 | null = null
    // (the tie point is on the bark: search out to the thickest flare)
    ph.world.intersectionsWithShape(p, { x: 0, y: 0, z: 0, w: 1 }, new R.Ball(0.6), (c) => {
      if (!(c.collisionGroups() >>> 16 & Groups.Static)) return true
      const tr = this.trunkOf(c)
      if (!tr) return true
      // the band hugs the bark
      m = new THREE.Matrix4().compose(_c.set(tr.x, tr.y, tr.z), _q.identity(), _s.set(tr.r + 0.01, 1, tr.r + 0.01))
      _s.set(1, 1, 1)
      return false
    })
    return m
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
      const site = this.sitesNear(p, HOOK_REACH).find((s) => s.site.car !== carried.car && this.free(s.site))?.site
      if (site) {
        this.target = { rope: carried, site }
        this.action = 'hangCar'
        this.label = site.car === me ? 'Hook to your car' : 'Hook to this car'
        return
      }
      const axis = new THREE.Vector3(NaN, 0, 0)
      const pt = this.anchorNear(p, new THREE.Vector3(), axis)
      if (pt) {
        this.target = { rope: carried, point: pt, axis: Number.isNaN(axis.x) ? undefined : axis }
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
    const site = this.sitesNear(p, HOOK_REACH).find((s) => this.free(s.site))?.site
    if (site) {
      this.target = { site }
      this.action = 'take'
      this.label = site.end === 'F' ? 'Take the front hook' : 'Take the rear hook'
    }
  }

  /** H pressed: hands-on actions walk up to the hook first (`update` runs them once there). */
  press(): void {
    const g = this.game, pl = g.player
    if (this.pending || pl.busy.to || pl.busy.hold > 0) return
    const action = this.action, t = { ...this.target }
    if (action === 'take' || action === 'hangCar' || action === 'unhook') {
      // car hooks: stand square in front of the bumper; a hung end: facing it from where we are
      const site = action === 'unhook' ? null : t.site!
      const goal = site ? this.point(site, 'eye', new THREE.Vector3()) : this.nearEnd(t.rope!, pl.curr, new THREE.Vector3())
      if (!goal) return
      if (site && this.frame(site.car, _m)) _d.set(0, 0, site.end === 'F' ? 1 : -1).transformDirection(_m) // (walking in toward the bumper)
      else _d.subVectors(goal, pl.curr)
      this.walkTo(goal, _d)
      this.pending = {
        at: 0,
        run: () => {
          if (action !== 'unhook') return this.run(action, t)
          // unhooking: the hand goes to it, the line comes off as it gets there
          const gs = this.reachFor(g.character, goal)
          pl.busy.hold = gs.len
          this.pending = { at: performance.now() + gs.at * 1000, run: () => this.run(action, t) }
        },
      }
      return
    }
    if (action === 'hangFixed') {
      // (a tree: out from the trunk's axis — some drawn trunks are wider than their collider, you can stand in the bark)
      if (t.axis) _d.subVectors(t.axis, t.point!)
      else _d.subVectors(t.point!, pl.curr)
      this.walkTo(t.point!, _d, STAND_TREE)
      this.pending = { at: 0, run: () => this.run(action, t) }
      return
    }
    this.run(action, t)
  }

  /** Feet `stand` m back from `goal` along `dir` (flat), then hold still. */
  private walkTo(goal: THREE.Vector3, dir: THREE.Vector3, stand = STAND): void {
    const b = this.game.player.busy
    dir.setY(0)
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1)
    dir.normalize()
    b.to = new THREE.Vector3(goal.x - dir.x * stand, 0, goal.z - dir.z * stand)
    b.t = 1.2
    b.d = Infinity
    b.walked = 0
    b.hold = 0.15 // (until the gesture's own hold starts)
  }

  /** The hung end of `r` nearest to `p`: its far end or the fairlead it comes out of. */
  private nearEnd(r: LocalRope, p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 | null {
    const far = this.farPoint(r, _b), fl = this.point({ car: r.car, end: endOf(r.end) }, 'fairlead', _d)
    const q = !far ? fl : !fl ? far : far.distanceToSquared(p) < fl.distanceToSquared(p) ? far : fl
    return q ? out.copy(q) : null
  }

  /** The gesture for a hand going to `target` (crouched ⇄ standing by its height over the feet), played on `ch`. */
  private reachFor(ch: CharacterModel | null, target: THREE.Vector3): { len: number; at: number } {
    if (!ch) return { len: 0, at: 0 }
    const h = target.y - ch.root.position.y
    const k = THREE.MathUtils.smoothstep(h, LOW_TO, HIGH_FROM)
    const at = LOW.at + (HIGH.at - LOW.at) * k
    const len = ch.playGesture([{ ...LOW, w: 1 - k }, { ...HIGH, w: k }], at, target)
    return { len, at: len ? at : 0 }
  }

  private run(action: TowAction, t: { site?: RopeEnd; rope?: LocalRope; point?: THREE.Vector3 }): void {
    const me = this.me
    switch (action) {
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
        if (this.serverRopes) return this.send(action === 'drop' ? TowOp.DROP : TowOp.UNHOOK, { car: r.car, end: endOf(r.end) })
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
    return this.handOf(r.who, out)
  }

  private handOf(who: number, out: THREE.Vector3): THREE.Vector3 | null {
    if (who === this.me) return this.game.character.handPosition(out)
    return this.game.remotes.handWorld(who, out)
  }

  /** Rope changes → the gestures (whoever did it) and how long the hook stays drawn where it was. */
  private animate(): void {
    const now = performance.now(), me = this.me
    const ids = new Set<number>()
    const holders = new Set<number>()
    for (const r of this.ropes) {
      ids.add(r.id)
      if (r.kind === RopeKind.HAND) holders.add(r.who)
      const s = this.seen.get(r.id)
      if (s && s.kind === r.kind) continue
      // new in a hand: taken; hand → tree / hook: hung
      const kind = !s ? (r.kind === RopeKind.HAND ? 'take' : null) : s.kind === RopeKind.HAND ? (r.kind === RopeKind.CAR ? 'hangCar' : 'hangFixed') : null
      const actor = kind === 'take' ? r.who : s?.who ?? -1
      // (the hand goes to the hook on the bumper being taken / to where it is being hung)
      const goal = kind === 'take' ? this.point({ car: r.car, end: endOf(r.end) }, 'eye', new THREE.Vector3()) : kind ? this.farPoint(r, new THREE.Vector3()) : null
      if (kind && goal) {
        const ch = actor === me ? this.game.character : this.game.remotes.characterOf(actor)
        const gs = this.reachFor(ch, goal)
        if (actor === me) this.game.player.busy.hold = Math.max(this.game.player.busy.hold, gs.len)
        this.seen.set(r.id, { kind: r.kind, who: r.kind === RopeKind.HAND ? r.who : actor, until: gs.len ? now + gs.at * 1000 : 0, from: kind === 'take' ? 'car' : 'hand', goal })
      } else this.seen.set(r.id, { kind: r.kind, who: r.who, until: 0, from: 'car' })
      if (r.kind === RopeKind.FIXED && !this.strapOf.has(r.id)) this.strapOf.set(r.id, this.strapAt(this.farPoint(r, _c)!))
    }
    for (const id of [...this.seen.keys()]) if (!ids.has(id)) this.seen.delete(id)
    for (const id of [...this.lines.keys()]) if (!ids.has(id)) this.lines.delete(id)
    for (const [id] of this.strapOf) if (!this.ropes.some((r) => r.id === id && r.kind === RopeKind.FIXED)) this.strapOf.delete(id)
    // carrying: the right arm held out while a hook is in that hand
    this.game.character.carrying = holders.has(me)
    this.game.remotes.setCarrying(holders)
  }

  /** Per frame: the prompt, the lines, the hooks at their far ends. */
  update(): void {
    const now = performance.now()
    const dt = Math.min(1 / 30, Math.max(0, (now - this.lastFrame) / 1000))
    this.lastFrame = now
    // walked up to the hook: do it (or give up if something else took over — a knock, a car)
    const pl = this.game.player
    if (this.pending && (pl.stunned > 0 || pl.inVehicle || pl.dead)) this.pending = null
    if (this.pending && !pl.busy.to && now >= this.pending.at) {
      const p = this.pending
      this.pending = null
      p.run()
    }
    this.choose()
    this.animate()
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
      // (mid-gesture: the hook still on the car / in the hand until the hand gets there)
      const sn = this.seen.get(r.id)
      const pending = sn && performance.now() < sn.until
      // (the reaching hand follows the hook while the car rocks)
      if (sn?.goal && performance.now() < sn.until + 700) (sn.from === 'car' ? this.point(site, 'eye', sn.goal) : this.farPoint(r, sn.goal))
      const b = !pending ? this.farPoint(r, _b) : sn.from === 'car' ? this.point(site, 'eye', _b) : this.handOf(sn.who, _b)
      if (!a || !b) continue
      // the hook at the far end, hanging (its eye up), turned along the line
      _d.subVectors(b, a).setY(0)
      const yaw = _d.lengthSq() > 1e-6 ? Math.atan2(_d.x, _d.z) : 0
      _m.compose(b, _q.setFromAxisAngle(_up, yaw), _s)
      if (r.car === this.me) this.game.car.placeHook(site.end, _m)
      else this.game.remotes.placeHook(r.car, site.end, _m)
      // the hook hangs below its eye: the line ends at the eye
      if (n + LINE_PTS - 1 > (LINE_PTS - 1) * MAX_DRAWN) continue
      const P = this.line(r, a, b, dt)
      for (let i = 0; i < LINE_PTS - 1; i++) {
        _c.fromArray(P, i * 3)
        _d.fromArray(P, i * 3 + 3).sub(_c)
        const len = _d.length()
        if (len < 1e-4) continue
        _q.setFromUnitVectors(_up, _d.divideScalar(len))
        this.segs.setMatrixAt(n++, _m.compose(_c, _q, _s.set(1, len, 1)))
      }
      _s.set(1, 1, 1)
    }
    this.segs.count = n
    this.segs.visible = n > 0
    if (n) this.segs.instanceMatrix.needsUpdate = true
    let k = 0
    for (const m of this.strapOf.values()) if (m && k < MAX_DRAWN) this.straps.setMatrixAt(k++, m)
    this.straps.count = k
    this.straps.visible = k > 0
    if (k) this.straps.instanceMatrix.needsUpdate = true
  }

  /**
   * The rope's drawn line from `a` (fairlead) to `b` (hook eye / hand), stepped `dt`: verlet points under gravity,
   * each segment kept no longer than its share of the line (a rope only resists stretching — slack falls and lies
   * down), every point kept on or above the ground under it, sliding little once it lies there.
   */
  private line(r: LocalRope, a: THREE.Vector3, b: THREE.Vector3, dt: number): Float32Array {
    const N = LINE_PTS, d = a.distanceTo(b)
    let L = this.lines.get(r.id)
    if (!L || Math.hypot(L.p[0] - a.x, L.p[1] - a.y, L.p[2] - a.z) > 4) {
      // new (or the car jumped): laid straight from the fairlead to the hook, then it settles
      const p = new Float32Array(N * 3)
      for (let i = 0; i < N; i++) _c.lerpVectors(a, b, i / (N - 1)).toArray(p, i * 3)
      L = { p, o: p.slice(), paid: d + PAY_SLACK }
      this.lines.set(r.id, L)
    }
    // the line out: carried, what has been walked out (the drum free-spools behind you); hung, the rope's length
    if (r.kind === RopeKind.HAND) L.paid = Math.min(ROPE_MAX, Math.max(L.paid, d + PAY_SLACK))
    else L.paid = r.lenM
    const seg = Math.max(L.paid, d) / (N - 1)
    const { p, o } = L
    const gy = -9.81 * dt * dt
    const gr = _gr
    for (let i = 1; i < N - 1; i++) {
      const j = i * 3
      const vx = (p[j] - o[j]) * 0.96, vy = (p[j + 1] - o[j + 1]) * 0.96, vz = (p[j + 2] - o[j + 2]) * 0.96
      o[j] = p[j]
      o[j + 1] = p[j + 1]
      o[j + 2] = p[j + 2]
      p[j] += vx
      p[j + 1] += vy + gy
      p[j + 2] += vz
      gr[i] = this.ground(p[j], p[j + 2]) + ROPE_RADIUS + 0.01
    }
    a.toArray(p, 0)
    b.toArray(p, (N - 1) * 3)
    for (let it = 0; it < LINE_ITERS; it++) {
      for (let i = 0; i < N - 1; i++) {
        const j = i * 3
        const dx = p[j + 3] - p[j], dy = p[j + 4] - p[j + 1], dz = p[j + 5] - p[j + 2]
        const l = Math.hypot(dx, dy, dz)
        if (l <= seg || l < 1e-6) continue
        const w0 = i === 0 ? 0 : 1, w1 = i + 1 === N - 1 ? 0 : 1
        if (!w0 && !w1) continue
        const k = (l - seg) / l / (w0 + w1)
        p[j] += dx * k * w0
        p[j + 1] += dy * k * w0
        p[j + 2] += dz * k * w0
        p[j + 3] -= dx * k * w1
        p[j + 4] -= dy * k * w1
        p[j + 5] -= dz * k * w1
      }
      for (let i = 1; i < N - 1; i++) if (p[i * 3 + 1] < gr[i]) p[i * 3 + 1] = gr[i]
    }
    // on the ground: friction (it lies where it fell instead of sliding about)
    for (let i = 1; i < N - 1; i++) {
      const j = i * 3
      if (p[j + 1] <= gr[i] + 0.005) {
        o[j] += (p[j] - o[j]) * 0.6
        o[j + 2] += (p[j + 2] - o[j + 2]) * 0.6
        o[j + 1] = p[j + 1]
      }
    }
    return p
  }

  /** Ropes in the world (tests / probes). */
  get list(): readonly Rope[] {
    return this.ropes
  }

  dispose(): void {
    this.segs.geometry.dispose()
    ;(this.segs.material as THREE.Material).dispose()
    this.segs.dispose()
    this.straps.geometry.dispose()
    ;(this.straps.material as THREE.Material).dispose()
    this.straps.dispose()
  }
}
