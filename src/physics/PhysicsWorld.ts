import RAPIER from '@dimforge/rapier3d-compat'
import { CHUNK_RES, CHUNK_SIZE, CHUNK_VERTS } from '../world/constants'
import { PROP_STRIDE, TREE_STRIDE, TRUNK_RADIUS, type ChunkData } from '../world/types'
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
} as const
export const group = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff)

export const FIXED_DT = 1 / 60
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

  constructor(R: Rapier) {
    this.R = R
    this.world = new R.World({ x: 0, y: -20, z: 0 })
    this.world.timestep = FIXED_DT
  }

  /** Runs `fixedUpdate` 0..MAX_SUBSTEPS times, stepping the world after each. */
  advance(dt: number, fixedUpdate: (fdt: number) => void): void {
    this.accumulator = Math.min(this.accumulator + dt, FIXED_DT * MAX_SUBSTEPS)
    const t0 = performance.now()
    while (this.accumulator >= FIXED_DT) {
      fixedUpdate(FIXED_DT)
      this.world.step()
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
    for (let iz = 0; iz < V; iz++) for (let ix = 0; ix < V; ix++) hf[ix * V + iz] = d.heights[iz * V + ix]
    this.world.createCollider(
      R.ColliderDesc.heightfield(CHUNK_RES, CHUNK_RES, hf, { x: CHUNK_SIZE, y: 1, z: CHUNK_SIZE })
        .setCollisionGroups(group(Groups.Terrain, 0xffff))
        .setFriction(0.9),
      body,
    )
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
    // Roadside props: pole cylinders and thin fence boxes (so they block like the real thing).
    const pr = d.props
    for (let i = 0; i < pr.length; i += 6) {
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
      if (desc) this.world.createCollider(desc.setRotation(q).setCollisionGroups(group(Groups.Static, 0xffff)), body)
    }
    this.chunkBodies.set(key, body)
  }

  removeChunk(key: string): void {
    const body = this.chunkBodies.get(key)
    if (!body) return
    this.world.removeRigidBody(body) // also removes its colliders
    this.chunkBodies.delete(key)
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
