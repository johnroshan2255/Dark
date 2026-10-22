import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { CharacterModel, createBlobShadow } from '../gameplay/player/CharacterModel'
import { DYN_LAYER } from '../rendering/shadows/DynamicShadow'
import { VEHICLES } from '../gameplay/vehicle/catalogue'
import type { HeroAsset, VehicleModel } from '../assets/loadModels'
import { RemoteCar } from './RemoteCar'
import type { RemoteCarPose } from './RemoteColliders'
import { cmToM, cmsToMps, Flags, i16ToPitch, isBot, u16ToYaw, type EntityState } from './protocol'

/**
 * REMOTE PLAYERS: everyone else in the room — people and the room's BOTS (server-run players, up to 100) — drawn
 * from the server's snapshots ~INTERP_MS in the past (interpolated between the snapshots round the render time on the
 * SERVER clock, extrapolated ≤ EXTRAP_MS on a late packet).
 *
 * Built for a crowd: draw calls do not grow with the number of players.
 *  * CARS: the nearest `maxCars` within CAR_NEAR m are drawn exactly like the player's own car (RemoteCar: doors,
 *    cabin, rolling + steering wheels, dampers, lamps, jets when flying, the hull as a boat — posed from the state);
 *    the rest a simplified model to CAR_MID and a low-poly stand-in to CAR_FAR (one InstancedMesh per model each). A
 *    car STAYS where its driver got out (parked, PARK_MS) until they drive again.
 *  * ON FOOT: the game's own animated character for the nearest `maxCharacters` (per tier: 1 draw each), an instanced
 *    silhouette for the rest (1 draw).
 *  * NAME TAGS: one instanced billboard draw from a name atlas (TagLayer).
 *  * BOTS on the ground are set on THIS client's ground (the server only knows the endless world's road): wheels and
 *    feet meet the terrain the player sees — except cars in a room whose server simulates them (`serverPhysics`):
 *    their height, pitch and ROLL are the server's physics on the same terrain grid.
 * CPU: interpolation + instance matrices, a few µs per remote; nothing allocated per frame.
 */
const INTERP_MS = 100
const EXTRAP_MS = 200
const MAX_SAMPLES = 16
/** Instances per batch (the server's interest cap is 64 per snapshot; parked cars on top). */
const CAP = 160
/** Full car model within CAR_NEAR (m), the simplified one to CAR_MID, the box stand-in to CAR_FAR, nothing beyond. */
const CAR_NEAR = 35
const CAR_MID = 110
const CAR_FAR = 900
/** A parked car stays this long after its driver walked off (ms). */
const PARK_MS = 180_000
/** Name tags within this distance (m): people / bots — the nearest MAX_TAGS of them (a crowd isn't a wall of names). */
const TAG_FAR = 260
const TAG_FAR_BOT = 30
const MAX_TAGS = 10
/** Bike riders arrive as DRIVING with this model id (no car to draw: the character rides). */
export const BIKE_MODEL = 255

interface Sample {
  t: number
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  roll: number
  vx: number
  vy: number
  vz: number
  flags: number
  model: number
}

interface CarPose {
  model: number
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  roll: number
}

interface Remote {
  id: number
  bot: boolean
  samples: Sample[]
  char: CharacterModel | null
  name: string
  tagSlot: number
  /** Interpolated now. */
  pos: THREE.Vector3
  yaw: number
  pitch: number
  roll: number
  speed: number
  /** Signed speed along the heading (m/s) and the turn rate (rad/s): the remote car's wheels roll and steer by them. */
  fwd: number
  yawRate: number
  vy: number
  flags: number
  model: number
  dist: number
  visible: boolean
  /** Last car it drove — parked there when it gets out. */
  lastCar: CarPose | null
  wasDriving: boolean
}

interface Parked extends CarPose {
  owner: number
  until: number
}

/** One car model: its baked model (the full RemoteCars), the simplified and the far stand-in. */
interface CarSet {
  vm: VehicleModel
  /** 45–160 m: body + glass simplified (vertex clustering) + 12-sided wheels, colours baked — one draw. */
  mid: THREE.InstancedMesh
  far: THREE.InstancedMesh
  midN: number
  farN: number
}

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler(0, 0, 0, 'YXZ')
const _s = new THREE.Vector3(1, 1, 1)
const _p = new THREE.Vector3()
const _sb = new THREE.Vector3()

export class RemotePlayers {
  readonly root = new THREE.Group()
  private readonly remotes = new Map<number, Remote>()
  private readonly charPool: CharacterModel[] = []
  private readonly carSets = new Map<number, CarSet>()
  private readonly carLoads = new Set<number>()
  private readonly carMat: THREE.Material
  /** Full cars in use (by remote id, or −1 − owner when parked) and idle ones per model. */
  private readonly cars = new Map<number, RemoteCar>()
  private readonly idleCars = new Map<number, RemoteCar[]>()
  private readonly usedCars = new Set<number>()
  /** Night 0 … 1 (Game): remote headlights. */
  darkness = 0
  private readonly proxies: THREE.InstancedMesh
  /** Soft contact shadows under the simplified cars and the far people (they cast no sun shadow): one draw. */
  private readonly blobs: THREE.InstancedMesh
  private blobN = 0
  /** Per car model: blob footprint (width, length); the body's box (half extents, centre height). */
  private readonly footprint = new Map<number, [number, number]>()
  private readonly bodyBox = new Map<number, [number, number, number, number]>()
  private readonly tags = new TagLayer()
  private readonly names = new Map<number, string>()
  private readonly parked: Parked[] = []
  private readonly onFoot: Remote[] = []
  private pickClock = 0
  /** Animated characters (the rest are silhouettes) and full-model cars (the rest simplified) — per tier. */
  maxCharacters = 12
  maxCars = 6
  /** The room's server simulates the cars (RoomFlags.PHYSICS): their poses are physics — not set on our ground. */
  serverPhysics = false
  /** The cars (remote id, or −1 − owner when parked) drawn full this quarter second. */
  private readonly fullCars = new Set<number>()
  private readonly carDist: { id: number; d: number }[] = []
  private readonly tagged: Remote[] = []

  constructor(
    private readonly heroMaterial: THREE.Material,
    private readonly hero: HeroAsset,
    private readonly loadVehicle: (id: string) => Promise<VehicleModel>,
    carMaterial: THREE.Material,
    /** Ground for animated feet (any point). */
    private readonly ground: (x: number, z: number) => number,
    /** Cheap ground where the world is loaded (null elsewhere) — bots are set on it. */
    private readonly loadedGround: (x: number, z: number) => number | null,
  ) {
    this.root.name = 'remote-players'
    this.carMat = carMaterial
    this.proxies = new THREE.InstancedMesh(mannequin(), carMaterial, CAP)
    const blob = createBlobShadow()
    this.blobs = new THREE.InstancedMesh(blob.geometry, blob.material, CAP * 2)
    this.blobs.count = 0
    this.blobs.frustumCulled = false
    this.blobs.renderOrder = 1
    this.blobs.name = 'remote-blob-shadows'
    this.root.add(this.blobs)
    this.proxies.count = 0
    this.proxies.frustumCulled = false
    this.proxies.visible = false
    this.proxies.name = 'remote-silhouettes'
    this.root.add(this.proxies, this.tags.mesh)
  }

  get count(): number {
    return this.remotes.size
  }

  setName(id: number, name: string): void {
    this.names.set(id, name)
    const r = this.remotes.get(id)
    if (r && r.name !== name) {
      r.name = name
      this.tags.write(r.tagSlot, name, r.bot)
    }
  }

  /** A snapshot: new samples for the entities in it, removals. `t` = its server time (ms). */
  apply(t: number, entities: EntityState[], removed: number[]): void {
    for (const e of entities) {
      const r = this.remotes.get(e.id) ?? this.add(e.id)
      const last = r.samples[r.samples.length - 1]
      if (last && t <= last.t) continue
      // (the oldest sample object is reused once the ring is full)
      const s: Sample = r.samples.length >= MAX_SAMPLES ? r.samples.shift()! : ({} as Sample)
      s.t = t
      s.x = cmToM(e.pos[0])
      s.y = cmToM(e.pos[1])
      s.z = cmToM(e.pos[2])
      s.yaw = u16ToYaw(e.yaw)
      s.pitch = i16ToPitch(e.pitch)
      s.roll = i16ToPitch(e.roll)
      s.vx = cmsToMps(e.vel[0])
      s.vy = cmsToMps(e.vel[1])
      s.vz = cmsToMps(e.vel[2])
      s.flags = e.flags
      s.model = e.model
      r.samples.push(s)
    }
    for (const id of removed) this.remove(id)
  }

  remove(id: number): void {
    const r = this.remotes.get(id)
    if (!r) return
    if (r.char) this.release(r)
    this.tags.free(r.tagSlot)
    this.remotes.delete(id)
    for (let i = this.parked.length - 1; i >= 0; i--) if (this.parked[i].owner === id) this.parked.splice(i, 1)
  }

  clear(): void {
    for (const id of [...this.remotes.keys()]) this.remove(id)
    this.names.clear()
    this.parked.length = 0
  }

  private add(id: number): Remote {
    const bot = isBot(id)
    const name = this.names.get(id) ?? (bot ? 'Bot' : `Player ${id}`)
    const r: Remote = {
      id, bot, samples: [], char: null, name, tagSlot: this.tags.alloc(), pos: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0,
      speed: 0, fwd: 0, yawRate: 0, vy: 0, flags: 0, model: 0, dist: Infinity, visible: false, lastCar: null, wasDriving: false,
    }
    this.tags.write(r.tagSlot, name, bot)
    this.remotes.set(id, r)
    return r
  }

  private takeCharacter(r: Remote): void {
    const ch = this.charPool.pop() ?? (() => {
      const c = new CharacterModel(this.heroMaterial, { ...this.hero, scene: cloneSkinned(this.hero.scene) as THREE.Group })
      c.ground = (x, z) => this.ground(x, z)
      // no sun / dynamic shadow (a crowd would double its vertex cost): a blob under the feet instead
      c.root.traverse((o) => {
        o.castShadow = false
        o.layers.disable(DYN_LAYER)
      })
      return c
    })()
    ch.yaw = r.yaw
    r.char = ch
    this.root.add(ch.root)
  }

  private release(r: Remote): void {
    if (!r.char) return
    r.char.root.removeFromParent()
    this.charPool.push(r.char)
    r.char = null
  }

  /** Catalogue model `model` (1-based; out of range wraps), loaded on first sight. */
  private carSet(model: number): CarSet | null {
    const set = this.carSets.get(model)
    if (set) return set
    if (this.carLoads.has(model)) return null
    this.carLoads.add(model)
    const def = VEHICLES[(model - 1) % VEHICLES.length]
    void this.loadVehicle(def.id)
      .then((vm) => {
        vm.body.computeBoundingBox()
        const bb = vm.body.boundingBox!
        this.footprint.set(model, [(bb.max.x - bb.min.x) * 1.15, (bb.max.z - bb.min.z) * 1.1])
        this.bodyBox.set(model, [(bb.max.x - bb.min.x) / 2, (bb.max.y - bb.min.y) / 2, (bb.max.z - bb.min.z) / 2, (bb.max.y + bb.min.y) / 2])
        const mk = (g: THREE.BufferGeometry, m: THREE.Material, name: string, shadow: boolean) => {
          const im = new THREE.InstancedMesh(g, m, CAP)
          im.count = 0
          im.visible = false
          im.frustumCulled = false
          im.castShadow = shadow
          im.name = `remote-car-${def.id}-${name}`
          this.root.add(im)
          return im
        }
        this.carSets.set(model, {
          vm,
          mid: mk(midCar(vm), this.carMat, 'mid', false),
          far: mk(lowPolyCar(vm), this.carMat, 'far', false),
          midN: 0,
          farN: 0,
        })
      })
      .catch(() => {})
    return null
  }

  /** The remote cars as their newest snapshot says (server time, body-box centre, velocity) — for RemoteColliders. */
  carPoses(out: RemoteCarPose[]): RemoteCarPose[] {
    out.length = 0
    for (const r of this.remotes.values()) {
      const s = r.samples[r.samples.length - 1]
      if (!s || !(s.flags & Flags.DRIVING) || s.model === BIKE_MODEL || s.flags & (Flags.FLYING | Flags.BOAT | Flags.DEAD)) continue
      const b = this.bodyBox.get(s.model)
      if (!b) continue
      out.push({ id: r.id, t: s.t, x: s.x, y: s.y + b[3], z: s.z, yaw: s.yaw, vx: s.vx, vy: s.vy, vz: s.vz, half: [b[0], b[1], b[2]] })
    }
    return out
  }

  /** Per tier: how many people on foot get the animated character. */
  setQuality(maxCharacters: number, maxCars = this.maxCars): void {
    this.maxCharacters = maxCharacters
    this.maxCars = maxCars
  }

  /** Per frame: interpolate at `serverNow − INTERP_MS`, place / animate. `eye` = the camera (LOD, tags);
   *  `viewH` = the drawing height in pixels (tag size). */
  update(dt: number, serverNow: number, eye: THREE.Vector3, viewH = 720): void {
    this.tags.viewH.value = viewH
    const t = serverNow - INTERP_MS
    const now = performance.now()
    for (const r of this.remotes.values()) {
      const n = r.samples.length
      if (!n) {
        r.visible = false
        continue
      }
      let a = r.samples[0], b = a
      for (let i = n - 1; i >= 0; i--) {
        if (r.samples[i].t <= t) {
          a = r.samples[i]
          b = r.samples[Math.min(n - 1, i + 1)]
          break
        }
      }
      let k = 0
      if (b !== a) k = Math.min(1, Math.max(0, (t - a.t) / Math.max(1, b.t - a.t)))
      // past the newest sample: extrapolate along its velocity (≤ EXTRAP_MS)
      const ex = b === a && t > a.t ? Math.min(EXTRAP_MS, t - a.t) / 1000 : 0
      r.pos.set(a.x + (b.x - a.x) * k + a.vx * ex, a.y + (b.y - a.y) * k + a.vy * ex, a.z + (b.z - a.z) * k + a.vz * ex)
      let dy = b.yaw - a.yaw
      dy = Math.atan2(Math.sin(dy), Math.cos(dy))
      r.yaw = a.yaw + dy * k
      r.pitch = a.pitch + (b.pitch - a.pitch) * k
      r.roll = a.roll + (b.roll - a.roll) * k
      const vx = a.vx + (b.vx - a.vx) * k, vz = a.vz + (b.vz - a.vz) * k
      r.speed = Math.hypot(vx, vz)
      r.fwd = -vx * Math.sin(r.yaw) - vz * Math.cos(r.yaw)
      r.yawRate = b !== a ? dy / Math.max(0.001, (b.t - a.t) / 1000) : 0
      r.vy = a.vy + (b.vy - a.vy) * k
      r.flags = b.flags
      r.model = b.model
      r.dist = r.pos.distanceTo(eye)
      r.visible = !(r.flags & Flags.DEAD)
      const driving = (r.flags & Flags.DRIVING) !== 0 && r.model !== BIKE_MODEL
      // bots: on our ground (wheels / feet), pitched along it — where the world is loaded
      if (r.bot && !(r.flags & (Flags.FLYING | Flags.BOAT | Flags.AIRBORNE)) && r.dist < 400 && !(this.serverPhysics && driving)) {
        const g = this.loadedGround(r.pos.x, r.pos.z)
        if (g !== null) {
          r.pos.y = g
          if (driving) {
            const fx = -Math.sin(r.yaw) * 1.8, fz = -Math.cos(r.yaw) * 1.8
            const gf = this.loadedGround(r.pos.x + fx, r.pos.z + fz), gb = this.loadedGround(r.pos.x - fx, r.pos.z - fz)
            if (gf !== null && gb !== null) r.pitch = Math.atan2(gf - gb, 3.6)
          }
        }
      }
      // parked: got out of a car → it stays there
      if (driving) {
        const c = (r.lastCar ??= { model: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 })
        c.model = r.model
        c.x = r.pos.x
        c.y = r.pos.y
        c.z = r.pos.z
        c.yaw = r.yaw
        c.pitch = r.pitch
        c.roll = r.roll
        if (!r.wasDriving) this.unpark(r.id)
      } else if (r.wasDriving && r.lastCar && r.lastCar.model) {
        this.unpark(r.id)
        this.parked.push({ owner: r.id, ...r.lastCar, until: now + PARK_MS })
      }
      r.wasDriving = driving
      // drop old samples (keep two before the render time)
      while (r.samples.length > 2 && r.samples[1].t < t - 500) r.samples.shift()
    }
    for (let i = this.parked.length - 1; i >= 0; i--) if (this.parked[i].until < now) this.parked.splice(i, 1)

    // the nearest people on foot get the animated character (re-picked 4× a second), the rest a silhouette
    if ((this.pickClock -= dt) <= 0) {
      this.pickClock = 0.25
      this.onFoot.length = 0
      for (const r of this.remotes.values()) if (r.visible && (!(r.flags & Flags.DRIVING) || r.model === BIKE_MODEL) && r.dist < 150) this.onFoot.push(r)
      this.onFoot.sort((x, y) => x.dist - y.dist)
      const keep = Math.min(this.onFoot.length, this.maxCharacters)
      for (const r of this.remotes.values()) {
        if (!r.char) continue
        const at = this.onFoot.indexOf(r)
        if (at < 0 || at >= keep) this.release(r)
      }
      for (let i = 0; i < keep; i++) if (!this.onFoot[i].char) this.takeCharacter(this.onFoot[i])
      // the nearest cars (driven or parked) within CAR_NEAR get the full model
      const cd = this.carDist
      cd.length = 0
      for (const r of this.remotes.values()) if (r.visible && r.flags & Flags.DRIVING && r.model !== BIKE_MODEL && r.dist < CAR_NEAR) cd.push({ id: r.id, d: r.dist })
      for (const c of this.parked) {
        const d = Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z)
        if (d < CAR_NEAR) cd.push({ id: -1 - c.owner, d })
      }
      cd.sort((a, b) => a.d - b.d)
      this.fullCars.clear()
      for (let i = 0; i < Math.min(cd.length, this.maxCars); i++) this.fullCars.add(cd[i].id)
    }

    // ---- fill the batches
    for (const s of this.carSets.values()) s.midN = s.farN = 0
    this.usedCars.clear()
    let px = 0
    this.blobN = 0
    this.tags.begin()
    for (const r of this.remotes.values()) {
      const driving = (r.flags & Flags.DRIVING) !== 0 && r.model !== BIKE_MODEL
      if (r.char) {
        r.char.root.visible = r.visible && !driving
        if (!driving && r.visible) {
          r.char.animate(dt, r.pos, r.yaw, r.speed, (r.flags & Flags.AIRBORNE) === 0, false, 0, r.vy)
          this.blob(r.pos.x, r.pos.y, r.pos.z, r.yaw, 0.8, 0.8)
        }
      }
      if (!r.visible) continue
      if (driving) this.putCar(r.model, r.pos.x, r.pos.y, r.pos.z, r.yaw, r.pitch, r.roll, r.dist, this.fullCars.has(r.id) ? r : null, dt)
      else if (!r.char && px < CAP && r.dist < 400) {
        _e.set(0, r.yaw, 0)
        this.proxies.setMatrixAt(px++, _m.compose(r.pos, _q.setFromEuler(_e), _s))
        this.blob(r.pos.x, r.pos.y, r.pos.z, r.yaw, 0.75, 0.75)
      }
      if (r.dist < (r.bot ? TAG_FAR_BOT : TAG_FAR)) this.tagged.push(r)
    }
    // tags over the heads / roofs: the nearest MAX_TAGS
    if (this.tagged.length > MAX_TAGS) this.tagged.sort((a, b) => a.dist - b.dist)
    for (let i = 0; i < Math.min(MAX_TAGS, this.tagged.length); i++) {
      const r = this.tagged[i]
      const driving = (r.flags & Flags.DRIVING) !== 0 && r.model !== BIKE_MODEL
      this.tags.put(r.tagSlot, r.pos.x, r.pos.y + (driving ? 2.6 : 2.15), r.pos.z)
    }
    this.tagged.length = 0
    for (const c of this.parked) {
      _p.set(c.x, c.y, c.z)
      this.putCar(c.model, c.x, c.y, c.z, c.yaw, c.pitch, c.roll, _p.distanceTo(eye), this.fullCars.has(-1 - c.owner) ? -1 - c.owner : null, dt)
    }
    // full cars not drawn this frame go back to their model's pool
    for (const [key, car] of this.cars) {
      if (this.usedCars.has(key)) continue
      car.root.visible = false
      this.cars.delete(key)
      const idle = this.idleCars.get(car.model) ?? this.idleCars.set(car.model, []).get(car.model)!
      idle.push(car)
    }
    this.blobs.count = this.blobN
    this.blobs.visible = this.blobN > 0
    if (this.blobN) this.blobs.instanceMatrix.needsUpdate = true
    this.proxies.count = px
    this.proxies.visible = px > 0
    if (px) this.proxies.instanceMatrix.needsUpdate = true
    for (const s of this.carSets.values()) {
      s.mid.count = s.midN
      s.mid.visible = s.midN > 0
      if (s.midN) s.mid.instanceMatrix.needsUpdate = true
      s.far.count = s.farN
      s.far.visible = s.farN > 0
      if (s.farN) s.far.instanceMatrix.needsUpdate = true
    }
    this.tags.end()
  }

  private unpark(owner: number): void {
    for (let i = this.parked.length - 1; i >= 0; i--) if (this.parked[i].owner === owner) this.parked.splice(i, 1)
  }

  /** @param full the driver (a moving car) or the parked key (−1 − owner) when it gets the full model, else null */
  private putCar(model: number, x: number, y: number, z: number, yaw: number, pitch: number, roll: number, dist: number, full: Remote | number | null, dt: number): void {
    if (dist > CAR_FAR) return
    const s = this.carSet(model)
    if (!s) return
    if (full !== null && dist < CAR_NEAR) {
      const key = typeof full === 'number' ? full : full.id
      let car = this.cars.get(key)
      if (car && car.model !== model) {
        car.dispose()
        this.cars.delete(key)
        car = undefined
      }
      if (!car) {
        car = this.idleCars.get(model)?.pop() ?? new RemoteCar(model, s.vm)
        this.cars.set(key, car)
        this.root.add(car.root)
      }
      car.root.visible = true
      this.usedCars.add(key)
      const r = typeof full === 'number' ? null : full
      const f = r?.flags ?? 0
      car.update(dt, _p.set(x, y, z), yaw, pitch, roll, r?.fwd ?? 0, r?.yawRate ?? 0, (f & Flags.FLYING) !== 0, (f & Flags.BOAT) !== 0, (f & Flags.LIGHTS) !== 0, (f & Flags.BRAKING) !== 0, this.darkness)
      return
    }
    _e.set(pitch, yaw, -roll)
    _m.compose(_p.set(x, y, z), _q.setFromEuler(_e), _s)
    if (dist < CAR_MID) {
      if (s.midN < CAP) s.mid.setMatrixAt(s.midN++, _m)
      const f = this.footprint.get(model)
      if (f && dist < 90) this.blob(x, y, z, yaw, f[0], f[1])
    } else if (s.farN < CAP) s.far.setMatrixAt(s.farN++, _m)
  }

  private blob(x: number, y: number, z: number, yaw: number, w: number, l: number): void {
    if (this.blobN >= CAP * 2) return
    _e.set(0, yaw, 0)
    _p.set(x, y + 0.04, z)
    _sb.set(w / 1.1, 1, l / 1.1)
    this.blobs.setMatrixAt(this.blobN++, _m.compose(_p, _q.setFromEuler(_e), _sb))
  }

  dispose(): void {
    this.clear()
    for (const c of this.charPool) c.dispose()
    this.charPool.length = 0
    for (const s of this.carSets.values()) {
      s.far.geometry.dispose()
      s.mid.geometry.dispose()
      for (const im of [s.mid, s.far]) im.dispose()
    }
    for (const c of this.cars.values()) c.dispose()
    for (const l of this.idleCars.values()) for (const c of l) c.dispose()
    this.cars.clear()
    this.idleCars.clear()
    this.proxies.geometry.dispose()
    this.tags.dispose()
  }
}

/**
 * The FAR stand-in of a car (past CAR_NEAR m): its body's bounds as two boxes (body, cabin) and four wheel blocks,
 * coloured from the model's own average colour — ~84 triangles, the same material (no new program).
 */
function lowPolyCar(vm: VehicleModel): THREE.BufferGeometry {
  const body = vm.body
  body.computeBoundingBox()
  const bb = body.boundingBox!
  const col = bakedColors(vm)
  const avg = new THREE.Color(0.5, 0.5, 0.5)
  if (col) {
    let r = 0, g = 0, b = 0, n = 0
    const step = Math.max(1, Math.floor(col.length / 3 / 400))
    for (let i = 0; i < col.length / 3; i += step) {
      r += col[i * 3]
      g += col[i * 3 + 1]
      b += col[i * 3 + 2]
      n++
    }
    avg.setRGB(r / n, g / n, b / n)
  }
  const sx = bb.max.x - bb.min.x, sy = bb.max.y - bb.min.y, sz = bb.max.z - bb.min.z
  const cx = (bb.max.x + bb.min.x) / 2, cz = (bb.max.z + bb.min.z) / 2
  const base = bb.min.y + sy * 0.12
  const lower = new THREE.BoxGeometry(sx, sy * 0.45, sz).translate(cx, base + sy * 0.225, cz)
  const cabin = new THREE.BoxGeometry(sx * 0.86, sy * 0.4, sz * 0.5).translate(cx, base + sy * 0.65, cz + sz * 0.05)
  const parts = [paint(lower, avg), paint(cabin, avg.clone().multiplyScalar(0.55))]
  const wr = vm.wheelRadius
  for (const [x, y, z] of vm.wheelPos) parts.push(paint(new THREE.BoxGeometry(wr * 0.8, wr * 2, wr * 2).translate(x, y, z), new THREE.Color(0.06, 0.06, 0.07)))
  const g = mergeGeometries(parts)!
  for (const p of parts) p.dispose()
  return g
}

/** Per-vertex colour of the body with its texture (if any) baked in: vertex colour × the texel at its uv. */
const baked = new WeakMap<VehicleModel, Float32Array>()
function bakedColors(vm: VehicleModel): Float32Array {
  const hit = baked.get(vm)
  if (hit) return hit
  const g = vm.body
  const n = g.getAttribute('position').count
  const out = new Float32Array(n * 3).fill(0.7)
  const col = g.getAttribute('color'), uv = g.getAttribute('uv')
  if (col) for (let i = 0; i < n; i++) (out[i * 3] = col.getX(i)), (out[i * 3 + 1] = col.getY(i)), (out[i * 3 + 2] = col.getZ(i))
  const img = vm.map?.image as (CanvasImageSource & { width: number; height: number }) | undefined
  if (img && uv && img.width) {
    const W = Math.min(256, img.width), H = Math.min(256, img.height)
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(img, 0, 0, W, H)
    const px = ctx.getImageData(0, 0, W, H).data
    const flip = vm.map!.flipY
    const lin = (v: number) => Math.pow(v / 255, 2.2)
    for (let i = 0; i < n; i++) {
      const u = ((uv.getX(i) % 1) + 1) % 1, v = ((uv.getY(i) % 1) + 1) % 1
      const x = Math.min(W - 1, Math.floor(u * W)), y = Math.min(H - 1, Math.floor((flip ? 1 - v : v) * H))
      const k = (y * W + x) * 4
      out[i * 3] *= lin(px[k])
      out[i * 3 + 1] *= lin(px[k + 1])
      out[i * 3 + 2] *= lin(px[k + 2])
    }
  }
  baked.set(vm, out)
  return out
}

/**
 * VERTEX CLUSTERING: vertices snapped to a `cell` grid (and to the facing of their normal — hard edges stay hard) are
 * merged; triangles that collapse are dropped. ~5–8× fewer triangles on the car bodies at 2–3 cm/px, built once per
 * model in a few ms. Keeps position / normal / color only.
 */
function cluster(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, nor: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined, col: Float32Array, index: ArrayLike<number> | null, cell: number): THREE.BufferGeometry {
  const n = pos.count
  const ids = new Int32Array(n)
  const map = new Map<string, number>()
  const P: number[] = [], N: number[] = [], C: number[] = [], W: number[] = []
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    let face = 0
    if (nor) {
      const ax = nor.getX(i), ay = nor.getY(i), az = nor.getZ(i)
      const m = Math.max(Math.abs(ax), Math.abs(ay), Math.abs(az))
      face = m === Math.abs(ax) ? (ax > 0 ? 1 : 2) : m === Math.abs(ay) ? (ay > 0 ? 3 : 4) : az > 0 ? 5 : 6
    }
    const key = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)},${face}`
    let id = map.get(key)
    if (id === undefined) {
      id = W.length
      map.set(key, id)
      P.push(0, 0, 0)
      N.push(nor ? nor.getX(i) : 0, nor ? nor.getY(i) : 1, nor ? nor.getZ(i) : 0)
      C.push(col[i * 3], col[i * 3 + 1], col[i * 3 + 2])
      W.push(0)
    }
    P[id * 3] += x
    P[id * 3 + 1] += y
    P[id * 3 + 2] += z
    W[id]++
    ids[i] = id
  }
  for (let k = 0; k < W.length; k++) (P[k * 3] /= W[k]), (P[k * 3 + 1] /= W[k]), (P[k * 3 + 2] /= W[k])
  const tris = index ? index.length : n
  const I: number[] = []
  for (let t = 0; t < tris; t += 3) {
    const a = ids[index ? index[t] : t], b = ids[index ? index[t + 1] : t + 1], c = ids[index ? index[t + 2] : t + 2]
    if (a !== b && b !== c && a !== c) I.push(a, b, c)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3))
  g.setIndex(I)
  return g
}

/** The MID car: simplified body + glass (dark, opaque) + four 12-sided wheels, one geometry. */
function midCar(vm: VehicleModel): THREE.BufferGeometry {
  // coarser until the body is ≤ ~2 k triangles (the models range from 4 k to 22 k)
  let cell = 0.12
  let body = cluster(vm.body.getAttribute('position'), vm.body.getAttribute('normal'), bakedColors(vm), vm.body.index ? vm.body.index.array : null, cell)
  for (let k = 0; k < 8 && body.index!.count / 3 > 2000; k++) {
    body.dispose()
    cell *= 1.3
    body = cluster(vm.body.getAttribute('position'), vm.body.getAttribute('normal'), bakedColors(vm), vm.body.index ? vm.body.index.array : null, cell)
  }
  const gp = vm.glass.getAttribute('position')
  const glass = cluster(gp, vm.glass.getAttribute('normal'), new Float32Array(gp.count * 3).fill(0.03), vm.glass.index ? vm.glass.index.array : null, 0.12)
  const parts = [body, glass]
  const wr = vm.wheelRadius, ww = vm.tyreHalfWidth * 2
  for (const [x, y, z] of vm.wheelPos) parts.push(paint(new THREE.CylinderGeometry(wr, wr, ww, 12, 1).rotateZ(Math.PI / 2).translate(x, y, z), new THREE.Color(0.05, 0.05, 0.055)))
  for (const p of parts) {
    p.deleteAttribute('uv')
    if (!p.index) p.setIndex([...Array(p.getAttribute('position').count).keys()])
  }
  const g = mergeGeometries(parts)!
  for (const p of parts) p.dispose()
  return g
}

/** A person far off (past the animated ones): legs, jacket, arms, head in the hero's colours — ~300 triangles. */
function mannequin(): THREE.BufferGeometry {
  const skin = new THREE.Color(0.55, 0.36, 0.26), jacket = new THREE.Color(0.2, 0.22, 0.12), trousers = new THREE.Color(0.06, 0.06, 0.07)
  const parts = [
    paint(new THREE.CapsuleGeometry(0.09, 0.62, 2, 6).translate(-0.11, 0.42, 0), trousers),
    paint(new THREE.CapsuleGeometry(0.09, 0.62, 2, 6).translate(0.11, 0.42, 0), trousers),
    paint(new THREE.CapsuleGeometry(0.21, 0.42, 2, 8).scale(1, 1, 0.7).translate(0, 1.12, 0), jacket),
    paint(new THREE.CapsuleGeometry(0.065, 0.5, 2, 6).translate(-0.3, 1.08, 0), jacket),
    paint(new THREE.CapsuleGeometry(0.065, 0.5, 2, 6).translate(0.3, 1.08, 0), jacket),
    paint(new THREE.SphereGeometry(0.12, 8, 6).translate(0, 1.6, 0), skin),
  ]
  for (const p of parts) p.deleteAttribute('uv')
  const g = mergeGeometries(parts)!
  for (const p of parts) p.dispose()
  return g
}

function paint(g: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const n = g.getAttribute('position').count
  const a = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r
    a[i * 3 + 1] = c.g
    a[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3))
  return g
}

/**
 * NAME TAGS for everyone in ONE draw: each name is painted once into a slot of an atlas (canvas → texture); every
 * visible tag is an instance of a camera-facing quad (position + slot). The front end's dusk-glass pill; bots get a
 * lime edge.
 */
class TagLayer {
  readonly mesh: THREE.Mesh
  private static readonly W = 1024
  private static readonly H = 1024
  private static readonly SW = 256
  private static readonly SH = 32
  private readonly cols = TagLayer.W / TagLayer.SW
  private readonly canvas = document.createElement('canvas')
  private readonly ctx: CanvasRenderingContext2D
  private readonly tex: THREE.CanvasTexture
  private readonly freeSlots: number[] = []
  private readonly widths: Float32Array
  private readonly iPos: THREE.InstancedBufferAttribute
  private readonly iSlot: THREE.InstancedBufferAttribute
  private readonly geo: THREE.InstancedBufferGeometry
  private n = 0
  private dirty = false
  /** View height in pixels (tags are sized on screen). */
  readonly viewH = { value: 720 }

  constructor() {
    this.canvas.width = TagLayer.W
    this.canvas.height = TagLayer.H
    this.ctx = this.canvas.getContext('2d')!
    const slots = this.cols * (TagLayer.H / TagLayer.SH)
    for (let i = slots - 1; i >= 0; i--) this.freeSlots.push(i)
    this.widths = new Float32Array(slots)
    this.tex = new THREE.CanvasTexture(this.canvas)
    this.tex.colorSpace = THREE.SRGBColorSpace
    this.tex.generateMipmaps = false
    this.tex.minFilter = THREE.LinearFilter
    const base = new THREE.PlaneGeometry(1, 1)
    this.geo = new THREE.InstancedBufferGeometry()
    this.geo.index = base.index
    this.geo.setAttribute('position', base.getAttribute('position'))
    this.geo.setAttribute('uv', base.getAttribute('uv'))
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3).setUsage(THREE.DynamicDrawUsage)
    // per instance: the slot's uv corner (x, y) and the used width fraction
    this.iSlot = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3).setUsage(THREE.DynamicDrawUsage)
    this.geo.setAttribute('iPos', this.iPos)
    this.geo.setAttribute('iSlot', this.iSlot)
    this.geo.instanceCount = 0
    const mat = new THREE.ShaderMaterial({
      name: 'NameTags',
      transparent: true,
      depthWrite: false,
      uniforms: { uMap: { value: this.tex }, uSlot: { value: new THREE.Vector2(TagLayer.SW / TagLayer.W, TagLayer.SH / TagLayer.H) }, uViewH: this.viewH },
      vertexShader: /* glsl */ `
        attribute vec3 iPos; attribute vec3 iSlot;
        uniform vec2 uSlot; uniform float uViewH;
        varying vec2 vUv;
        void main() {
          vec4 clip = projectionMatrix * viewMatrix * vec4(iPos, 1.0);
          // a size on SCREEN: ~20 px tall near, shrinking to 12 px far (× the view height / 720) — never huge up close
          float px = clamp(500.0 / max(clip.w, 1.0), 12.0, 20.0) * uViewH / 720.0;
          vec2 ndc = position.xy * vec2(iSlot.z * ${(TagLayer.SW / TagLayer.SH).toFixed(1)}, 1.0) * px * 2.0 / uViewH;
          clip.xy += ndc * vec2(projectionMatrix[0][0] / projectionMatrix[1][1], 1.0) * clip.w; // (x: pixels → NDC across the width)
          vUv = iSlot.xy + vec2(uv.x * iSlot.z, uv.y) * uSlot;
          gl_Position = clip;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(uMap, vUv);
          if (c.a < 0.02) discard;
          gl_FragColor = c;
          #include <colorspace_fragment>
        }`,
    })
    this.mesh = new THREE.Mesh(this.geo, mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 10
    this.mesh.visible = false
    this.mesh.name = 'name-tags'
  }

  alloc(): number {
    return this.freeSlots.pop() ?? 0
  }

  free(slot: number): void {
    if (!this.freeSlots.includes(slot)) this.freeSlots.push(slot)
  }

  /** Paint `name` into its slot. */
  write(slot: number, name: string, bot: boolean): void {
    const x0 = (slot % this.cols) * TagLayer.SW, y0 = Math.floor(slot / this.cols) * TagLayer.SH
    const g = this.ctx
    g.clearRect(x0, y0, TagLayer.SW, TagLayer.SH)
    g.font = '700 19px system-ui, -apple-system, "Segoe UI", sans-serif'
    let label = name
    while (label.length > 1 && g.measureText(label).width > TagLayer.SW - 30) label = label.slice(0, -1)
    if (label !== name) label = label.slice(0, -1) + '…'
    const w = Math.min(TagLayer.SW, Math.ceil(g.measureText(label).width) + 26)
    g.fillStyle = 'rgba(28,24,52,0.72)'
    g.strokeStyle = bot ? 'rgba(205,232,74,0.7)' : 'rgba(255,214,170,0.5)'
    g.lineWidth = 1.5
    g.beginPath()
    g.roundRect(x0 + 1, y0 + 1, w - 2, TagLayer.SH - 2, (TagLayer.SH - 2) / 2)
    g.fill()
    g.stroke()
    g.fillStyle = bot ? '#e9f5b8' : '#fff4e3'
    g.textBaseline = 'middle'
    g.textAlign = 'center'
    g.fillText(label, x0 + w / 2, y0 + TagLayer.SH / 2 + 1)
    this.widths[slot] = w / TagLayer.SW
    this.dirty = true
  }

  begin(): void {
    this.n = 0
  }

  put(slot: number, x: number, y: number, z: number): void {
    if (this.n >= CAP) return
    const i = this.n++
    const P = this.iPos.array as Float32Array, S = this.iSlot.array as Float32Array
    P[i * 3] = x
    P[i * 3 + 1] = y
    P[i * 3 + 2] = z
    // (uv origin bottom-left: canvas rows count from the top; flipY uploads row 0 at v = 1)
    S[i * 3] = ((slot % this.cols) * TagLayer.SW) / TagLayer.W
    S[i * 3 + 1] = 1 - ((Math.floor(slot / this.cols) + 1) * TagLayer.SH) / TagLayer.H
    S[i * 3 + 2] = this.widths[slot]
  }

  end(): void {
    this.geo.instanceCount = this.n
    this.mesh.visible = this.n > 0
    if (this.n) {
      this.iPos.clearUpdateRanges()
      this.iSlot.clearUpdateRanges()
      this.iPos.addUpdateRange(0, this.n * 3)
      this.iSlot.addUpdateRange(0, this.n * 3)
      this.iPos.needsUpdate = this.iSlot.needsUpdate = true
    }
    if (this.dirty) {
      this.tex.needsUpdate = true
      this.dirty = false
    }
  }

  dispose(): void {
    this.tex.dispose()
    this.geo.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}
