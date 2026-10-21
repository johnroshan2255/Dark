import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { CharacterModel } from '../gameplay/player/CharacterModel'
import { VEHICLES } from '../gameplay/vehicle/catalogue'
import type { HeroAsset, VehicleModel } from '../assets/loadModels'
import { cmToM, cmsToMps, Flags, i16ToPitch, u16ToYaw, type EntityState } from './protocol'

/**
 * REMOTE PLAYERS: everyone else in the room, drawn from the server's snapshots ~INTERP_MS in the past (interpolated
 * between the two snapshots round the render time on the SERVER clock, extrapolated ≤ EXTRAP_MS on a late packet),
 * so they move smoothly at any network jitter.
 *
 *  * on foot: the game's own character (animated by speed / ground like the player) for the MAX_CHARACTERS nearest;
 *    farther ones a cheap silhouette (one capsule);
 *  * driving: the car they drive (catalogue model, loaded on first sight, shared geometry), body + glass + wheels;
 *  * a name tag over each.
 *
 * Cost: per remote ≤ 1 skinned character (nearest 16) or 1 capsule, ≤ 3 draws for a car, 1 sprite. No per-frame
 * allocation. Interest management on the server caps what arrives (≤ 64 players, nearest first).
 */
const INTERP_MS = 100
const EXTRAP_MS = 200
const MAX_SAMPLES = 16
const MAX_CHARACTERS = 16
/** Bike riders arrive as DRIVING with this model id (no car to draw: the character rides). */
export const BIKE_MODEL = 255

interface Sample {
  t: number
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  vx: number
  vy: number
  vz: number
  flags: number
  model: number
}

interface Remote {
  id: number
  samples: Sample[]
  root: THREE.Group
  char: CharacterModel | null
  proxy: THREE.Mesh
  car: THREE.Group | null
  carModel: number
  tag: THREE.Sprite
  name: string
  /** Interpolated now. */
  pos: THREE.Vector3
  yaw: number
  pitch: number
  speed: number
  vy: number
  flags: number
  model: number
  dist: number
  seen: boolean
}


export class RemotePlayers {
  readonly root = new THREE.Group()
  private readonly remotes = new Map<number, Remote>()
  private readonly charPool: CharacterModel[] = []
  private readonly cars = new Map<string, Promise<{ body: THREE.BufferGeometry; glass: THREE.BufferGeometry; wheels: THREE.BufferGeometry } | null>>()
  private readonly carMat: THREE.Material
  private readonly glassMat = new THREE.MeshLambertMaterial({ color: 0x1a2430, transparent: true, opacity: 0.55 })
  private readonly proxyGeo = new THREE.CapsuleGeometry(0.28, 1.1, 3, 8).translate(0, 0.83, 0)
  private readonly proxyMat = new THREE.MeshLambertMaterial({ color: 0x4a3f6b })
  private readonly names = new Map<number, string>()

  constructor(
    private readonly heroMaterial: THREE.Material,
    private readonly hero: HeroAsset,
    private readonly loadVehicle: (id: string) => Promise<VehicleModel>,
    carMaterial: THREE.Material,
    private readonly ground: (x: number, z: number) => number,
  ) {
    this.root.name = 'remote-players'
    this.carMat = carMaterial
  }

  get count(): number {
    return this.remotes.size
  }

  setName(id: number, name: string): void {
    this.names.set(id, name)
    const r = this.remotes.get(id)
    if (r && r.name !== name) this.retag(r, name)
  }

  /** A snapshot: new samples for the entities in it, removals. `t` = its server time (ms). */
  apply(t: number, entities: EntityState[], removed: number[]): void {
    for (const e of entities) {
      const r = this.remotes.get(e.id) ?? this.add(e.id)
      const s: Sample = {
        t,
        x: cmToM(e.pos[0]),
        y: cmToM(e.pos[1]),
        z: cmToM(e.pos[2]),
        yaw: u16ToYaw(e.yaw),
        pitch: i16ToPitch(e.pitch),
        vx: cmsToMps(e.vel[0]),
        vy: cmsToMps(e.vel[1]),
        vz: cmsToMps(e.vel[2]),
        flags: e.flags,
        model: e.model,
      }
      const last = r.samples[r.samples.length - 1]
      if (last && t <= last.t) continue
      r.samples.push(s)
      if (r.samples.length > MAX_SAMPLES) r.samples.shift()
    }
    for (const id of removed) this.remove(id)
  }

  remove(id: number): void {
    const r = this.remotes.get(id)
    if (!r) return
    if (r.char) this.release(r)
    r.root.removeFromParent()
    ;(r.tag.material as THREE.SpriteMaterial).map?.dispose()
    r.tag.material.dispose()
    this.remotes.delete(id)
  }

  clear(): void {
    for (const id of [...this.remotes.keys()]) this.remove(id)
    this.names.clear()
  }

  private add(id: number): Remote {
    const root = new THREE.Group()
    root.name = `remote-${id}`
    const proxy = new THREE.Mesh(this.proxyGeo, this.proxyMat)
    proxy.castShadow = true
    root.add(proxy)
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ depthWrite: false, transparent: true }))
    tag.renderOrder = 10
    root.add(tag)
    this.root.add(root)
    const r: Remote = {
      id, samples: [], root, char: null, proxy, car: null, carModel: 0, tag, name: '', pos: new THREE.Vector3(), yaw: 0, pitch: 0,
      speed: 0, vy: 0, flags: 0, model: 0, dist: Infinity, seen: false,
    }
    this.retag(r, this.names.get(id) ?? `Player ${id}`)
    this.remotes.set(id, r)
    return r
  }

  /** Name tag: a canvas sprite in the front end's dusk-glass look. */
  private retag(r: Remote, name: string): void {
    r.name = name
    const c = document.createElement('canvas')
    const ctx = c.getContext('2d')!
    const font = '700 34px system-ui, -apple-system, "Segoe UI", sans-serif'
    ctx.font = font
    const w = Math.min(512, Math.ceil(ctx.measureText(name).width) + 44)
    c.width = w
    c.height = 60
    ctx.font = font
    ctx.fillStyle = 'rgba(28,24,52,0.72)'
    ctx.strokeStyle = 'rgba(255,214,170,0.45)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.roundRect(2, 2, w - 4, 56, 28)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#fff4e3'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.fillText(name, w / 2, 31)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    const m = r.tag.material as THREE.SpriteMaterial
    m.map?.dispose()
    m.map = tex
    m.needsUpdate = true
    r.tag.scale.set((w / 60) * 0.32, 0.32, 1)
  }

  private takeCharacter(r: Remote): void {
    const ch = this.charPool.pop() ?? (() => {
      const c = new CharacterModel(this.heroMaterial, { ...this.hero, scene: cloneSkinned(this.hero.scene) as THREE.Group })
      c.ground = (x, z) => this.ground(x, z)
      return c
    })()
    ch.yaw = r.yaw
    r.char = ch
    r.root.add(ch.root)
  }

  private release(r: Remote): void {
    if (!r.char) return
    r.char.root.removeFromParent()
    this.charPool.push(r.char)
    r.char = null
  }

  /** The car of catalogue model `model` (1-based), loaded once and shared. */
  private carFor(model: number): Promise<{ body: THREE.BufferGeometry; glass: THREE.BufferGeometry; wheels: THREE.BufferGeometry } | null> {
    const def = VEHICLES[model - 1]
    if (!def) return Promise.resolve(null)
    let p = this.cars.get(def.id)
    if (!p) {
      p = this.loadVehicle(def.id)
        .then((vm) => {
          const wheels = mergeGeometries(
            vm.wheelPos.map(([x, y, z], i) => {
              const g = vm.wheel.clone()
              if (i % 2 === 1) g.rotateY(Math.PI) // right-side wheels face out
              return g.translate(x, y, z)
            }),
          )
          return wheels ? { body: vm.body, glass: vm.glass, wheels } : null
        })
        .catch(() => null)
      this.cars.set(def.id, p)
    }
    return p
  }

  private setCar(r: Remote, model: number): void {
    if (r.carModel === model) return
    r.carModel = model
    if (r.car) {
      r.car.removeFromParent()
      r.car = null
    }
    if (!model || model === BIKE_MODEL) return
    void this.carFor(model).then((geo) => {
      if (!geo || r.carModel !== model || !this.remotes.has(r.id)) return
      const g = new THREE.Group()
      const body = new THREE.Mesh(geo.body, this.carMat)
      const wheels = new THREE.Mesh(geo.wheels, this.carMat)
      const glass = new THREE.Mesh(geo.glass, this.glassMat)
      body.castShadow = wheels.castShadow = true
      g.add(body, wheels, glass)
      g.rotation.order = 'YXZ'
      r.car = g
      r.root.add(g)
    })
  }

  /** Per frame: interpolate at `serverNow − INTERP_MS`, place / animate. `eye` = the camera (LOD, tag scale). */
  update(dt: number, serverNow: number, eye: THREE.Vector3): void {
    const t = serverNow - INTERP_MS
    for (const r of this.remotes.values()) {
      const n = r.samples.length
      if (!n) {
        r.root.visible = false
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
      r.speed = Math.hypot(a.vx + (b.vx - a.vx) * k, a.vz + (b.vz - a.vz) * k)
      r.vy = a.vy + (b.vy - a.vy) * k
      r.flags = b.flags
      r.model = b.model
      r.dist = r.pos.distanceTo(eye)
      r.root.visible = true
      // drop old samples (keep two before the render time)
      while (r.samples.length > 2 && r.samples[1].t < t - 500) r.samples.shift()
    }
    // the nearest players on foot get the animated character, the rest a silhouette
    const onFoot = [...this.remotes.values()].filter((r) => r.root.visible && (!(r.flags & Flags.DRIVING) || r.model === BIKE_MODEL))
    onFoot.sort((x, y) => x.dist - y.dist)
    const want = new Set(onFoot.slice(0, MAX_CHARACTERS))
    for (const r of this.remotes.values()) if (r.char && !want.has(r)) this.release(r)
    for (const r of want) if (!r.char) this.takeCharacter(r)

    for (const r of this.remotes.values()) {
      if (!r.root.visible) continue
      const driving = (r.flags & Flags.DRIVING) !== 0 && r.model !== BIKE_MODEL
      this.setCar(r, driving ? r.model : 0)
      if (r.car) {
        r.car.visible = driving
        r.car.position.copy(r.pos)
        r.car.rotation.set(r.pitch, r.yaw, 0)
      }
      const dead = (r.flags & Flags.DEAD) !== 0
      if (r.char) {
        r.char.root.visible = !driving && !dead
        if (!driving) r.char.animate(dt, r.pos, r.yaw, r.speed, (r.flags & Flags.AIRBORNE) === 0, false, 0, r.vy)
      }
      r.proxy.visible = !driving && !r.char && !dead
      r.proxy.position.copy(r.pos)
      // tag: over the head / roof, a little bigger with distance (readable, never huge)
      r.tag.position.set(r.pos.x, r.pos.y + (driving ? 2.6 : 2.15), r.pos.z)
      const s = 1 + Math.min(2, r.dist / 60)
      const m = r.tag.material as THREE.SpriteMaterial
      const w = m.map ? (m.map.image as HTMLCanvasElement).width / 60 : 4
      r.tag.scale.set(w * 0.32 * s, 0.32 * s, 1)
      r.tag.visible = r.dist < 400
    }
  }

  dispose(): void {
    this.clear()
    for (const c of this.charPool) c.dispose()
    this.charPool.length = 0
    this.proxyGeo.dispose()
    this.proxyMat.dispose()
    this.glassMat.dispose()
  }
}
