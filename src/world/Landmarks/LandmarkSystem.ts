import { activeMap } from '../map/FixedMap'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type RAPIER from '@dimforge/rapier3d-compat'
import { group, Groups, type PhysicsWorld } from '../../physics/PhysicsWorld'
import { createLandmarkGeometries, type LandmarkGeometries } from './landmarkGeometry'
import { LANDMARK_REGION, LandmarkKind, type Landmark, type LandmarkField } from './landmarks'
import type { LandmarksRequest, LandmarksResponse } from '../Streaming/chunk.worker'
import { LAYER_REFLECT_SKYLINE } from '../../rendering/water/PlanarReflection'

/**
 * Renders the LANDMARKS (landmarks.ts) independently of the chunk ring, out to the tier's landmark distance
 * (≈ 0.45 × the horizon size: ~1.1 km on LOW … ~2.5 km on ULTRA) — they are what you see on the skyline and
 * travel toward.
 *
 * Cost: ≤ THREE draw calls (+1 per near windmill rotor): landmarks within the shadow range are baked into one
 * merged mesh that casts shadows, those to 350 m into a full-detail one, the rest into one of the FAR LOD
 * (≈ half the triangles) — all on `materials.landmark`. Range per tier: `QualitySettings.landmarkRange`. The merge is redone only when the visible set changes (crossing ~100 m, a few ms on a worker-
 * free main thread, measured below 3 ms for 20 landmarks). Physics: fixed cylinder colliders for landmarks within
 * 160 m (created / removed as you move). Memory: ~1–2 MB of merged vertex data on HIGH. PLACEMENT runs in its own
 * worker (one more worker on every tier; it idles once the regions around you are known): measured flying at
 * 59 m/s for 4.6 km, worst frame 29 ms — it froze for 1–3.6 s at a time when placement ran here.
 */
const COLLIDE_IN = 160
const COLLIDE_OUT = 220
/** Past this distance landmarks use the far LOD (≈ half the triangles, no small parts, no windmill rotor). */
const FAR_LOD = 350

export class LandmarkSystem {
  readonly group = new THREE.Group()
  private readonly geos: LandmarkGeometries
  private readonly meshes: THREE.Mesh[] = []
  private range = 0
  private readonly rotors: THREE.Mesh[] = []
  private key = ''
  private lastX = Number.NaN
  private lastZ = Number.NaN
  private readonly bodies = new Map<Landmark, RAPIER.RigidBody>()
  /** Landmarks currently drawn (HUD compass reads them). */
  visible: Landmark[] = []
  private readonly m = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly up = new THREE.Vector3(0, 1, 0)

  /** PLACEMENT WORKER (chunk.worker.ts 'landmarks'): placing a landmark checks the rock formations and road network
   *  around it (A* driveways, 0.3–2 s per new area on a phone-class core) — on the main thread that froze the game
   *  for seconds while flying, and for ~5–30 s at load (home + the first ring). The main thread's field is `remote`:
   *  it only reads regions this worker primed. */
  private readonly worker: Worker
  private nextId = 1
  private inflight = 0
  /** A response arrived: re-evaluate the visible set even without moving. */
  private fresh = false
  /** The home landmark arrived (Game turns the opening view to it). */
  onHome: ((home: Landmark | null) => void) | null = null
  private homeKnown = false

  constructor(
    private readonly field: LandmarkField,
    private readonly material: THREE.Material,
    private readonly physics: PhysicsWorld,
    private readonly seed: number,
    private readonly palette: number,
  ) {
    this.geos = createLandmarkGeometries()
    this.group.name = 'landmarks'
    field.remote = true
    this.worker = new Worker(new URL('../Streaming/chunk.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<LandmarksResponse>) => {
      this.inflight--
      // (only regions not known yet: a known region keeps its objects — the colliders are keyed by them)
      for (const [i, j, list] of e.data.regions) if (!field.has(i, j)) field.prime(i, j, list)
      if (!this.homeKnown) {
        this.homeKnown = true
        field.primeHome(e.data.home)
        this.onHome?.(e.data.home)
      }
      this.fresh = true
    }
  }

  /** Ask the worker for every landmark region within `reach` of (x, z) not known yet (one request at a time). */
  private request(x: number, z: number, reach: number): boolean {
    const R = LANDMARK_REGION
    const i0 = Math.floor((x - reach) / R), i1 = Math.floor((x + reach) / R)
    const j0 = Math.floor((z - reach) / R), j1 = Math.floor((z + reach) / R)
    let missing = !this.homeKnown
    for (let j = j0; j <= j1 && !missing; j++) for (let i = i0; i <= i1 && !missing; i++) missing = !this.field.has(i, j)
    if (!missing) return false
    if (this.inflight === 0) {
      this.inflight++
      this.worker.postMessage({ type: 'landmarks', id: this.nextId++, seed: this.seed, palette: this.palette, i0, j0, i1, j1, map: activeMap() } satisfies LandmarksRequest)
    }
    return true
  }

  /**
   * @param range draw distance (m) — the tier's `landmarkRange` (700 m LOW … 2.2 km ULTRA)
   * @param shadowRange landmarks closer than this cast shadows
   */
  update(dt: number, x: number, z: number, range: number, shadowRange: number, shadows: boolean): void {
    for (const r of this.rotors) r.rotateZ(-dt * 0.9)
    // Prefetch a region beyond the draw range (a flying car covers 700 m in ~10 s; a request takes ~0.1–2 s).
    if (this.inflight === 0) this.request(x, z, range + LANDMARK_REGION)
    if (Math.hypot(x - this.lastX, z - this.lastZ) < 60 && range === this.range && !this.fresh) return
    this.fresh = false
    this.lastX = x
    this.lastZ = z
    this.range = range
    const all = this.field.inBox(x - range, z - range, x + range, z + range).filter((l) => Math.hypot(l.x - x, l.z - z) < range)
    this.visible = all
    // Physics: colliders near the player.
    for (const l of all) if (!this.bodies.has(l) && Math.hypot(l.x - x, l.z - z) < COLLIDE_IN) this.addBody(l)
    for (const [l, b] of this.bodies) {
      if (Math.hypot(l.x - x, l.z - z) > COLLIDE_OUT) {
        this.physics.world.removeRigidBody(b)
        this.bodies.delete(l)
      }
    }
    // LEVELS OF DETAIL: near = full mesh casting shadows, mid = full mesh, far (> FAR_LOD m) = the low-poly LOD.
    const band = (l: Landmark) => {
      const d = Math.hypot(l.x - x, l.z - z)
      return d < shadowRange ? 0 : d < FAR_LOD ? 1 : 2
    }
    const key = all.map((l) => `${l.x | 0},${l.z | 0}:${band(l)}`).join(';') + shadows
    if (key === this.key) return
    this.key = key
    this.rebuild([0, 1, 2].map((b) => all.filter((l) => band(l) === b)), shadows)
  }

  private bake(list: Landmark[], lod: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
    if (!list.length) return null
    const parts = list.map((l) => {
      this.q.setFromAxisAngle(this.up, l.rot)
      this.m.compose(new THREE.Vector3(l.x, l.y, l.z), this.q, new THREE.Vector3(1, 1, 1))
      const g = lod[l.kind].clone().applyMatrix4(this.m)
      // Billboarded leaf tufts (the world tree) expand around bbCenter in the shader: move it with the landmark.
      const bc = g.getAttribute('bbCenter')
      if (bc) bc.applyMatrix4(this.m)
      // Snow cover tests the snow line at the landmark's FOOT (like an instanced tree's root), not per vertex — a
      // 40 m oak on a green hill must not wear a snow cap on its crown (stylize biomeCover, 4 B/vertex).
      g.setAttribute('aBaseY', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(l.y), 1))
      return g
    })
    // Kinds differ (some indexed, some not; the world tree alone has `bbCenter`): mergeGeometries needs one layout,
    // or it returns null and the WHOLE band (every landmark at that distance) vanished. Give non-indexed parts a
    // trivial index and zero-fill attributes only some parts have.
    const indexed = parts.some((p) => p.index)
    const names = new Map<string, THREE.BufferAttribute>()
    for (const p of parts) for (const [n, at] of Object.entries(p.attributes)) if (!names.has(n)) names.set(n, at as THREE.BufferAttribute)
    for (const p of parts) {
      const count = p.getAttribute('position').count
      for (const [n, at] of names) if (!p.getAttribute(n)) p.setAttribute(n, new THREE.BufferAttribute(new (at.array.constructor as Float32ArrayConstructor)(count * at.itemSize), at.itemSize, at.normalized))
      if (indexed && !p.index) p.setIndex([...Array(count).keys()])
    }
    const g = mergeGeometries(parts)
    parts.forEach((p) => p.dispose())
    g?.computeBoundingSphere()
    return g
  }

  private rebuild(bands: Landmark[][], shadows: boolean): void {
    for (const mesh of this.meshes) {
      mesh.removeFromParent()
      mesh.geometry.dispose()
    }
    this.meshes.length = 0
    for (const r of this.rotors) r.removeFromParent()
    this.rotors.length = 0
    bands.forEach((list, b) => {
      const g = this.bake(list, b === 2 ? this.geos.far : this.geos.body)
      if (!g) return
      const mesh = new THREE.Mesh(g, this.material)
      mesh.name = ['landmarks.near', 'landmarks.mid', 'landmarks.far'][b]
      mesh.castShadow = shadows && b === 0
      mesh.receiveShadow = b === 0
      mesh.layers.enable(LAYER_REFLECT_SKYLINE)
      this.meshes.push(mesh)
      this.group.add(mesh)
    })
    // Windmill sails: one small mesh each, spun about the hub every frame (not on the far LOD).
    for (const l of [...bands[0], ...bands[1]]) {
      if (l.kind !== LandmarkKind.Windmill) continue
      const r = new THREE.Mesh(this.geos.rotor, this.material)
      const hub = this.geos.hub.clone().applyAxisAngle(this.up, l.rot)
      r.position.set(l.x + hub.x, l.y + hub.y, l.z + hub.z)
      r.rotation.set(0, l.rot, l.variant * 6.28, 'YXZ')
      r.castShadow = shadows && bands[0].includes(l)
      r.name = 'landmark.rotor'
      this.rotors.push(r)
      this.group.add(r)
    }
  }

  private addBody(l: Landmark): void {
    const R = this.physics.R
    const b = this.physics.world.createRigidBody(
      R.RigidBodyDesc.fixed().setTranslation(l.x, l.y, l.z).setRotation({ x: 0, y: Math.sin(l.rot / 2), z: 0, w: Math.cos(l.rot / 2) }),
    )
    for (const c of this.geos.colliders[l.kind]) {
      this.physics.world.createCollider(
        R.ColliderDesc.cylinder(c.h / 2, c.r).setTranslation(c.x, c.y0 + c.h / 2, c.z).setCollisionGroups(group(Groups.Static, 0xffff)).setFriction(0.8),
        b,
      )
    }
    this.bodies.set(l, b)
  }

  dispose(): void {
    this.worker.terminate()
    for (const b of this.bodies.values()) this.physics.world.removeRigidBody(b)
    this.bodies.clear()
    this.rebuild([[], [], []], false)
    this.geos.dispose()
  }
}
