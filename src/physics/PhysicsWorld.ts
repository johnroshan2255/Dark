import RAPIER from '@dimforge/rapier3d-compat'
import { CHUNK_RES, CHUNK_SIZE, CHUNK_VERTS } from '../world/constants'
import { PROP_STRIDE, TREE_STRIDE, TRUNK_RADIUS, solidHeight, type ChunkData } from '../world/types'
import { ROCK_HULL } from '../world/Forest/propGeometries'
import { POI_COLLIDERS } from '../world/POI/poiGeometry'
import { instanceYScale } from '../optimization/instancing/InstanceBuilder'

export type Rapier = typeof RAPIER

/** Collision groups: (membership << 16) | filter. See skills/physics. */
export const Groups = {
  Terrain: 0x0001,
  Static: 0x0002,
  Player: 0x0004,
  Monster: 0x0008,
  Vehicle: 0x0010,
  /** Pieces of broken props (gameplay/destruction): collide with everything but each other's tiny shards. */
  Debris: 0x0020,
} as const
export const group = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff)

export const FIXED_DT = 1 / 60

/** A breakable prop's collider: which chunk record it came from (gameplay/destruction). */
export interface PropRef {
  key: string
  /** Record index in ChunkData.props (stride 6). */
  index: number
  type: number
  /** World position of its base. */
  x: number
  y: number
  z: number
  rot: number
  scale: number
}
const MAX_SUBSTEPS = 4

/**
 * Thin owner of the Rapier world. Fixed 60 Hz step driven by an accumulator.
 * Terrain/trunk colliders exist only for chunks inside RADIUS.physics.
 */
export class PhysicsWorld {
  static rapier: Rapier | null = null

  static async load(): Promise<Rapier> {
    if (!PhysicsWorld.rapier) {
      await RAPIER.init()
      PhysicsWorld.rapier = RAPIER
    }
    return PhysicsWorld.rapier
  }

  readonly R: Rapier
  readonly world: RAPIER.World
  private accumulator = 0
  /** 0..1 blend between previous and current fixed step, for render interpolation. */
  alpha = 0
  stepMs = 0
  private chunkBodies = new Map<string, RAPIER.RigidBody>()
  /** Breakable prop colliders (handle → record) and per chunk their handles. */
  readonly props = new Map<number, PropRef>()
  private readonly chunkProps = new Map<string, number[]>()
  /** Props broken in a chunk (record indices): skipped when its colliders are (re)built. Owned by Destruction. */
  broken: Map<string, Set<number>> = new Map()
  /** Which prop types break, and above what contact force (N) to report a possible break (Destruction decides). */
  breakable: (type: number) => boolean = () => false
  private readonly events: RAPIER.EventQueue
  /** Contact-force events of each step (collider handles, total force N). */
  onContactForce: ((h1: number, h2: number, force: number) => void) | null = null
  /** After every fixed step (and its events) — e.g. apply breaks before the next substep sees the collider. */
  afterStep: (() => void) | null = null

  constructor(R: Rapier) {
    this.R = R
    this.world = new R.World({ x: 0, y: -20, z: 0 })
    this.world.timestep = FIXED_DT
    this.events = new R.EventQueue(true)
  }

  /** Runs `fixedUpdate` 0..MAX_SUBSTEPS times, stepping the world after each. */
  advance(dt: number, fixedUpdate: (fdt: number) => void): void {
    this.accumulator = Math.min(this.accumulator + dt, FIXED_DT * MAX_SUBSTEPS)
    const t0 = performance.now()
    while (this.accumulator >= FIXED_DT) {
      fixedUpdate(FIXED_DT)
      this.world.step(this.events)
      if (this.onContactForce) this.events.drainContactForceEvents((e) => this.onContactForce!(e.collider1(), e.collider2(), e.totalForceMagnitude()))
      this.afterStep?.()
      this.accumulator -= FIXED_DT
    }
    this.alpha = this.accumulator / FIXED_DT
    this.stepMs = performance.now() - t0
  }

  hasChunk(key: string): boolean {
    return this.chunkBodies.has(key)
  }

  /** Heightfield + trunk cylinders on one fixed body (compound, one broad-phase entry per collider). */
  addChunk(key: string, d: ChunkData): void {
    if (this.chunkBodies.has(key)) return
    const R = this.R
    const half = CHUNK_SIZE / 2
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.fixed().setTranslation(d.cx * CHUNK_SIZE + half, 0, d.cz * CHUNK_SIZE + half),
    )
    // Rapier heightfield: centred on the body, heights[ix * rows + iz] (verified by raycast,
    // see skills/physics). Our layout is heights[iz * V + ix] → transpose.
    const V = CHUNK_VERTS
    const hf = new Float32Array(V * V)
    // Frozen lakes / rivers in the snow: the collider is the ICE at the water level (walk and drive on it).
    for (let iz = 0; iz < V; iz++) for (let ix = 0; ix < V; ix++) hf[ix * V + iz] = solidHeight(d, iz * V + ix)
    this.world.createCollider(
      R.ColliderDesc.heightfield(CHUNK_RES, CHUNK_RES, hf, { x: CHUNK_SIZE, y: 1, z: CHUNK_SIZE })
        .setCollisionGroups(group(Groups.Terrain, 0xffff))
        .setFriction(0.9),
      body,
    )
    // Rock formations (arches, caves, pillars, outcrops): an exact trimesh of their voxel mesh — you can drive
    // through the cave and under the arch.
    if (d.fmIdx.length) {
      const v = new Float32Array(d.fmPos.length)
      for (let i = 0; i < v.length; i += 3) {
        v[i] = d.fmPos[i] - half
        v[i + 1] = d.fmPos[i + 1]
        v[i + 2] = d.fmPos[i + 2] - half
      }
      this.world.createCollider(R.ColliderDesc.trimesh(v, d.fmIdx).setCollisionGroups(group(Groups.Static, 0xffff)).setFriction(0.8), body)
    }
    // Rocks: a convex hull of the rock's own mesh vertices per boulder, scaled (with the instance's vertical
    // jitter, InstanceBuilder) and rotated like its instance → the collider IS the visible boulder (tested:
    // every mesh vertex lies inside it). The player steps onto small ones (autostep), is blocked by big ones; the truck the same.
    const rk = d.rocks
    const hull = new Float32Array(ROCK_HULL.length)
    for (let i = 0; i < rk.length; i += PROP_STRIDE) {
      const sc = rk[i + 4]
      const sy = sc * instanceYScale(i / PROP_STRIDE)
      for (let k = 0; k < hull.length; k += 3) {
        hull[k] = ROCK_HULL[k] * sc
        hull[k + 1] = ROCK_HULL[k + 1] * sy
        hull[k + 2] = ROCK_HULL[k + 2] * sc
      }
      const desc = R.ColliderDesc.convexHull(hull)
      if (!desc) continue
      const a = rk[i + 3] / 2
      this.world.createCollider(
        desc.setTranslation(rk[i] - half, rk[i + 1], rk[i + 2] - half).setRotation({ x: 0, y: Math.sin(a), z: 0, w: Math.cos(a) })
          .setCollisionGroups(group(Groups.Static, 0xffff)).setFriction(0.8),
        body,
      )
    }
    // Trunks: simplified cylinders. No colliders for plants/grass.
    const t = d.trees
    for (let i = 0; i < t.length; i += TREE_STRIDE) {
      const s = t[i + 4]
      const r = (TRUNK_RADIUS[t[i + 5]] ?? 0.25) * s
      const hh = 3 * s
      this.world.createCollider(
        R.ColliderDesc.cylinder(hh, r)
          .setTranslation(t[i] - half, t[i + 1] + hh, t[i + 2] - half)
          .setCollisionGroups(group(Groups.Static, 0xffff)),
        body,
      )
    }
    // Roadside props: pole cylinders and thin fence boxes (so they block like the real thing). Breakable ones
    // report contact forces (Destruction); props broken earlier in this visit are not rebuilt.
    const pr = d.props
    const broken = this.broken.get(key)
    const handles: number[] = []
    for (let i = 0; i < pr.length; i += 6) {
      if (broken?.has(i / 6)) continue
      const q = { x: 0, y: Math.sin(pr[i + 3] / 2), z: 0, w: Math.cos(pr[i + 3] / 2) }
      const t = pr[i + 5]
      const sc = pr[i + 4]
      let desc: RAPIER.ColliderDesc | null = null
      if (t === 0) desc = R.ColliderDesc.cylinder(4.8, 0.18).setTranslation(pr[i] - half, pr[i + 1] + 4.8, pr[i + 2] - half)
      else if (t === 1) desc = R.ColliderDesc.cuboid(0.08, 0.6, 2.0).setTranslation(pr[i] - half, pr[i + 1] + 0.6, pr[i + 2] - half)
      else {
        const c = POI_COLLIDERS[t]
        if (c && c.length === 3) desc = R.ColliderDesc.cuboid(c[0] * sc, c[1] * sc, c[2] * sc).setTranslation(pr[i] - half, pr[i + 1] + c[1] * sc, pr[i + 2] - half)
        else if (c) desc = R.ColliderDesc.cylinder(c[1] * sc, c[0] * sc).setTranslation(pr[i] - half, pr[i + 1] + c[1] * sc, pr[i + 2] - half)
      }
      if (!desc) continue
      desc.setRotation(q).setCollisionGroups(group(Groups.Static, 0xffff))
      const brk = this.breakable(t)
      if (brk) desc.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(2000)
      const col = this.world.createCollider(desc, body)
      if (brk) {
        this.props.set(col.handle, { key, index: i / 6, type: t, x: pr[i] - half + body.translation().x, y: pr[i + 1], z: pr[i + 2] - half + body.translation().z, rot: pr[i + 3], scale: sc })
        handles.push(col.handle)
      }
    }
    this.chunkProps.set(key, handles)
    this.chunkBodies.set(key, body)
  }

  removeChunk(key: string): void {
    const body = this.chunkBodies.get(key)
    if (!body) return
    this.world.removeRigidBody(body) // also removes its colliders
    this.chunkBodies.delete(key)
    for (const h of this.chunkProps.get(key) ?? []) this.props.delete(h)
    this.chunkProps.delete(key)
  }

  /** Remove a broken prop's collider (it stays gone until its chunk's colliders are rebuilt without it). */
  removeProp(handle: number): void {
    const c = this.world.getCollider(handle)
    if (c) this.world.removeCollider(c, true)
    this.props.delete(handle)
  }

  get bodyCount(): number {
    return this.world.bodies.len()
  }
  get colliderCount(): number {
    return this.world.colliders.len()
  }

  dispose(): void {
    this.world.free()
    this.chunkBodies.clear()
  }
}
