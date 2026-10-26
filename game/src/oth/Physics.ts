import type RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { group, Groups, PhysicsWorld } from '../physics/PhysicsWorld'
import type { MapData } from './MapData'
import type { Rocks } from './Rocks'
import { TREE_STRIDE, type Trees } from './Trees'

/**
 * THE MAP'S PHYSICS for the vehicles (the game's Rapier world + its collision groups, so the game's TruckSim drives
 * on it unchanged): the ground as heightfield TILES of the box's 2 m grid (128 cells = 256 m each) streamed round
 * the car, the rocks near it as convex hulls of their drawn shapes, the bridges' decks and rails, and four walls at
 * the box's edge. Rebuilt only when the car crosses into another tile.
 */
const TILE = 128
const TILE_REACH = 1 // tiles each side of the car's tile (3 × 3 = 768 m)
const ROCK_REACH = 160
const TRUNK_REACH = 70

export class OthPhysics {
  readonly pw: PhysicsWorld
  private readonly R: typeof RAPIER
  private readonly tiles = new Map<number, RAPIER.RigidBody>()
  private readonly rocks = new Map<number, RAPIER.Collider>()
  private readonly trunks = new Map<number, RAPIER.Collider>()
  /** The forests (set once they're placed): trunks near the car become cylinders. */
  trees: Trees | null = null
  private readonly rockBody: RAPIER.RigidBody
  private lastTile = Number.NaN
  private lastRockCell = Number.NaN
  private readonly m = new THREE.Matrix4()
  private readonly v = new THREE.Vector3()

  private constructor(R: typeof RAPIER, private readonly map: MapData, private readonly rockSet: Rocks) {
    this.R = R
    this.pw = new PhysicsWorld(R)
    this.rockBody = this.pw.world.createRigidBody(R.RigidBodyDesc.fixed())
    // the box's edge: tall walls 40 m inside it (the far world beyond has no colliders)
    const h = map.half - 40, walls = this.pw.world.createRigidBody(R.RigidBodyDesc.fixed())
    for (const [x, z, hx, hz] of [[h, 0, 2, h], [-h, 0, 2, h], [0, h, h, 2], [0, -h, h, 2]] as const) {
      this.pw.world.createCollider(R.ColliderDesc.cuboid(hx, 600, hz).setTranslation(x, 300, z).setCollisionGroups(group(Groups.Static, 0xffff)), walls)
    }
    // the BRIDGES (Bridges.ts draws them): a deck box whose top is the planks, a curb log along each edge and a rail
    // on the posts — oriented along the bridge
    for (const br of map.meta.bridges ?? []) {
      const dx = br.x1 - br.x0, dz = br.z1 - br.z0, L = Math.hypot(dx, dz), yaw = Math.atan2(dx, dz)
      const rot = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }
      const mx = (br.x0 + br.x1) / 2, mz = (br.z0 + br.z1) / 2, ax = Math.cos(yaw), az = -Math.sin(yaw) // (across: local +x)
      const piece = (ox: number, y: number, hx: number, hy: number, hz: number, friction: number) => this.pw.world.createCollider(
        R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(mx + ax * ox, y, mz + az * ox).setRotation(rot)
          .setCollisionGroups(group(Groups.Static, 0xffff)).setFriction(friction), walls)
      piece(0, br.y - 0.2, br.w / 2 + 0.1, 0.2, L / 2 + 0.3, 0.95)
      for (const sd of [-1, 1]) {
        piece(sd * (br.w / 2 - 0.14), br.y + 0.1, 0.12, 0.12, L / 2 + 0.2, 0.6)
        piece(sd * (br.w / 2 + 0.18), br.y + 0.5, 0.12, 0.45, L / 2, 0.5)
      }
    }
  }

  static async create(map: MapData, rocks: Rocks): Promise<OthPhysics> {
    return new OthPhysics(await PhysicsWorld.load(), map, rocks)
  }

  /** Keep the ground and the rocks round (x, z) built. */
  follow(x: number, z: number): void {
    const g = this.map.inner
    const ti = Math.floor((x - g.origin) / (TILE * g.step)), tj = Math.floor((z - g.origin) / (TILE * g.step))
    const tkey = ti * 1024 + tj
    if (tkey !== this.lastTile) {
      this.lastTile = tkey
      const want = new Set<number>()
      const nt = Math.floor((g.n - 1) / TILE)
      for (let j = tj - TILE_REACH; j <= tj + TILE_REACH; j++) for (let i = ti - TILE_REACH; i <= ti + TILE_REACH; i++) {
        if (i < 0 || j < 0 || i >= nt || j >= nt) continue
        const k = i * 1024 + j
        want.add(k)
        if (!this.tiles.has(k)) this.tiles.set(k, this.buildTile(i, j))
      }
      for (const [k, b] of this.tiles) if (!want.has(k)) { this.pw.world.removeRigidBody(b); this.tiles.delete(k) }
    }
    const rc = Math.floor(x / 40) * 1024 + Math.floor(z / 40)
    if (rc !== this.lastRockCell) {
      this.lastRockCell = rc
      const all = this.rockSet.all
      const keep = new Set<number>()
      for (let i = 0; i < all.length; i++) {
        const r = all[i]
        if ((r.x - x) ** 2 + (r.z - z) ** 2 > ROCK_REACH * ROCK_REACH) continue
        keep.add(i)
        if (this.rocks.has(i)) continue
        const src = this.rockSet.shapes[r.v], pts = new Float32Array(src.length)
        this.rockSet.matrixOf(r, this.m)
        for (let k = 0; k < src.length; k += 3) {
          this.v.set(src[k], src[k + 1], src[k + 2]).applyMatrix4(this.m)
          pts[k] = this.v.x; pts[k + 1] = this.v.y; pts[k + 2] = this.v.z
        }
        const d = this.R.ColliderDesc.convexHull(pts)
        if (d) this.rocks.set(i, this.pw.world.createCollider(d.setCollisionGroups(group(Groups.Static, 0xffff)).setFriction(0.8), this.rockBody))
      }
      for (const [i, c] of this.rocks) if (!keep.has(i)) { this.pw.world.removeCollider(c, false); this.rocks.delete(i) }
      // tree trunks: a cylinder each (radius from the drawn trunk, as high as the lowest branches)
      const t = this.trees
      if (t) {
        const near = new Set<number>(), d = t.data
        for (let i = 0; i < t.count; i++) {
          const o = i * TREE_STRIDE
          if ((d[o] - x) ** 2 + (d[o + 2] - z) ** 2 > TRUNK_REACH * TRUNK_REACH) continue
          near.add(i)
          if (this.trunks.has(i)) continue
          const H = d[o + 3], r = Math.max(0.22, 0.022 * H * (d[o + 5] === 2 ? 1.6 : 1)), hh = H * 0.2
          this.trunks.set(i, this.pw.world.createCollider(
            this.R.ColliderDesc.cylinder(hh, r).setTranslation(d[o], d[o + 1] + hh, d[o + 2]).setCollisionGroups(group(Groups.Static, 0xffff)).setFriction(0.7),
            this.rockBody,
          ))
        }
        for (const [i, c] of this.trunks) if (!near.has(i)) { this.pw.world.removeCollider(c, false); this.trunks.delete(i) }
      }
    }
  }

  /** One tile: TILE × TILE cells of the 2 m grid, a heightfield centred on its body (Rapier: heights[ix · V + iz]). */
  private buildTile(i: number, j: number): RAPIER.RigidBody {
    const g = this.map.inner, V = TILE + 1, size = TILE * g.step
    const x0 = g.origin + i * size, z0 = g.origin + j * size
    const body = this.pw.world.createRigidBody(this.R.RigidBodyDesc.fixed().setTranslation(x0 + size / 2, 0, z0 + size / 2))
    const hf = new Float32Array(V * V)
    for (let iz = 0; iz < V; iz++) for (let ix = 0; ix < V; ix++) hf[ix * V + iz] = g.h[(j * TILE + iz) * g.n + i * TILE + ix]
    this.pw.world.createCollider(
      this.R.ColliderDesc.heightfield(TILE, TILE, hf, { x: size, y: 1, z: size })
        .setCollisionGroups(group(Groups.Terrain, 0xffff & ~Groups.VehicleMesh))
        .setFriction(0.9),
      body,
    )
    return body
  }
}
