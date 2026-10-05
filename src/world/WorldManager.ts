import * as THREE from 'three'
import type { PhysicsWorld } from '../physics/PhysicsWorld'
import type { MaterialLibrary } from '../rendering/materials/MaterialLibrary'
import { ChunkVisibility } from '../optimization/culling/ChunkVisibility'
import { chunkDistance, selectLod } from '../optimization/lod/LodSelector'
import { CELL_SIZE, CHUNK_DATA_CACHE, CHUNK_RES, CHUNK_SIZE, RADIUS } from './constants'
import type { QualitySettings } from '../rendering/quality/QualityTiers'
import { createPropGeometries, type PropGeometries } from './Forest/propGeometries'
import { ChunkStreamer } from './Streaming/ChunkStreamer'
import { LruCache } from './Streaming/LruCache'
import { chunkKey, ICE_SNOW, type ChunkData } from './types'
import { WorldChunk, type ChunkDetail } from './WorldChunk'
import { styledGrass, GrassField } from './Forest/GrassField'
import { WorldFields } from './WorldFields'
import { groundPalette } from '../rendering/artStyle'
import { sampleHeight } from './Terrain/generateTerrain'

/** Soft time budget for chunk mesh builds per frame (count limit comes from the tier). */
const BUILD_BUDGET_MS = 3

export type WorldQuality = Pick<QualitySettings, 'name' | 'renderRadius' | 'lodRings' | 'plants' | 'buildPerFrame' | 'grass' | 'trees' | 'vegDetail'>

/**
 * Owns chunk lifecycle: request (worker) → cache → build → LOD/cull → physics → unload.
 * Everything here is O(loaded chunks) per frame (~100), never O(objects).
 */
export class WorldManager {
  readonly root = new THREE.Group()
  readonly fields: WorldFields
  readonly chunks = new Map<string, WorldChunk>()
  readonly visibility = new ChunkVisibility()
  private readonly cache = new LruCache<string, ChunkData>(CHUNK_DATA_CACHE)
  private readonly buildQueue = new Map<string, ChunkData>()
  private readonly streamer: ChunkStreamer
  private readonly geos: PropGeometries
  private centerX = Number.NaN
  private centerZ = Number.NaN
  private q: WorldQuality = {
    name: 'low', renderRadius: 2, lodRings: [1.5, 2.2], plants: false, buildPerFrame: 1,
    grass: { radius: 16, density: 1.1, blades: 5 }, trees: { near: 1 }, vegDetail: { farRocks: false, lean: true },
  }
  private detail: ChunkDetail = { plants: false, treeNear: 1, farRocks: false, lean: true }
  /** Dense grass around the player (one draw call). */
  readonly grass: GrassField
  /** Chebyshev radius (chunks) around the player inside which every chunk is built (see update). */
  builtRadius = 0

  stats = { shoreVisible: 0, loaded: 0, visible: 0, culled: 0, instances: 0, drawnInstances: 0, pending: 0, buildMs: 0, genMs: 0, physicsChunks: 0 }

  constructor(
    readonly seed: number,
    private readonly mats: MaterialLibrary,
    private readonly physics: PhysicsWorld,
  ) {
    this.root.name = 'world'
    this.root.matrixAutoUpdate = false
    this.fields = new WorldFields(seed)
    this.fields.palette = groundPalette() // main-thread copy (grass, HUD); the workers get it per request
    this.geos = createPropGeometries()
    this.grass = new GrassField(mats.grass, mats.grassFar, mats.grassNearU, mats.grassFarU, this.fields, this.chunks)
    this.root.add(this.grass.root)
    this.streamer = new ChunkStreamer(seed, (d) => {
      const key = chunkKey(d.cx, d.cz)
      this.cache.set(key, d)
      if (this.inRing(d.cx, d.cz, this.q.renderRadius)) this.buildQueue.set(key, d)
    })
  }

  /** Apply tier settings. A radius change re-evaluates the ring on the next update. */
  setQuality(q: WorldQuality): void {
    const radiusChanged = q.renderRadius !== this.q.renderRadius
    this.q = { ...q, lodRings: [...q.lodRings] as [number, number], vegDetail: { ...q.vegDetail } }
    this.detail = { plants: q.plants, treeNear: q.trees.near, farRocks: q.vegDetail.farRocks, lean: q.vegDetail.lean }
    this.grass.configure(styledGrass(q.grass))
    if (radiusChanged) this.centerX = this.centerZ = Number.NaN
  }

  get renderRadius(): number {
    return this.q.renderRadius
  }

  private inRing(cx: number, cz: number, r: number): boolean {
    return Math.max(Math.abs(cx - this.centerX), Math.abs(cz - this.centerZ)) <= r
  }

  private frame = 0

  /** Terrain height from the loaded chunk data (null where no chunk is loaded) — the rendered surface, and far
   *  cheaper than `fields.height` (no noise / road-network queries): per-frame consumers should use this. */
  groundAt(x: number, z: number): number | null {
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const c = this.chunks.get(chunkKey(cx, cz))
    if (!c) return null
    const lx = x - cx * CHUNK_SIZE, lz = z - cz * CHUNK_SIZE
    const h = sampleHeight(c.data.heights, lx, lz)
    if (h >= WorldFields.WATER) return h
    // Frozen water in the snow: the surface is the ice (same rule as the physics heightfield).
    const vi = Math.min(CHUNK_RES, Math.round(lz / CELL_SIZE)) * (CHUNK_RES + 1) + Math.min(CHUNK_RES, Math.round(lx / CELL_SIZE))
    return c.data.biome[vi * 2 + 1] > ICE_SNOW ? WorldFields.WATER : h
  }

  /**
   * How many visible chunks have water the camera can actually see: each submerged sample point of a visible
   * shore chunk is tested for line of sight over the loaded terrain (10 height lookups along the ray). A river
   * hidden behind a hill doesn't trigger the planar reflection. ≤ ~40 rays, chunk-array lookups only (~0.05 ms).
   */
  private waterInView(cam: THREE.Vector3): number {
    let n = 0
    for (const chunk of this.chunks.values()) {
      const pts = chunk.waterPts
      if (!pts || !chunk.isVisible) continue
      const ox = chunk.data.cx * CHUNK_SIZE, oz = chunk.data.cz * CHUNK_SIZE
      for (let k = 0; k < pts.length; k += 2) {
        const px = ox + pts[k], pz = oz + pts[k + 1], py = WorldFields.WATER
        let clear = true
        for (let t = 0.1; t < 0.95; t += 0.09) {
          const x = cam.x + (px - cam.x) * t, z = cam.z + (pz - cam.z) * t, y = cam.y + (py - cam.y) * t
          const g = this.groundAt(x, z)
          if (g !== null && g > y + 0.3) {
            clear = false
            break
          }
        }
        if (clear) {
          n++
          break
        }
      }
    }
    return n
  }

  /** True once the chunk under (x, z) has both a mesh and colliders. */
  isReadyAt(x: number, z: number): boolean {
    const key = chunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE))
    return this.chunks.has(key) && this.physics.hasChunk(key)
  }

  /**
   * @param ahead where the player will be in ~1.5 s (vehicle look-ahead): chunks within the physics ring of
   *   EITHER point get colliders, so a fast truck never reaches ground that has no collider yet.
   */
  update(focus: THREE.Vector3, camera: THREE.Camera, ahead: THREE.Vector3 = focus): void {
    const pcx = Math.floor(focus.x / CHUNK_SIZE)
    const pcz = Math.floor(focus.z / CHUNK_SIZE)
    const acx = Math.floor(ahead.x / CHUNK_SIZE)
    const acz = Math.floor(ahead.z / CHUNK_SIZE)
    if (pcx !== this.centerX || pcz !== this.centerZ) {
      this.centerX = pcx
      this.centerZ = pcz
      this.recenter()
    }
    this.streamer.pump()
    this.buildPending(focus)

    let instances = 0
    let physicsChunks = 0
    for (const chunk of this.chunks.values()) {
      const { cx, cz } = chunk.data
      chunk.ring = Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz))
      chunk.setLod(selectLod(chunk.lod, chunkDistance(focus.x, focus.z, cx, cz), this.q.lodRings), this.detail)
      instances += chunk.instanceCount
      // Physics ring (around the player and the look-ahead point) with one ring of hysteresis.
      const ringAhead = Math.max(Math.abs(cx - acx), Math.abs(cz - acz))
      if (Math.min(chunk.ring, ringAhead) <= RADIUS.physics) this.physics.addChunk(chunk.key, chunk.data)
      else if (chunk.ring > RADIUS.physics + 1 && ringAhead > RADIUS.physics + 1) this.physics.removeChunk(chunk.key)
      if (this.physics.hasChunk(chunk.key)) physicsChunks++
    }
    this.visibility.update(camera, this.chunks.values())
    // Water in view (planar reflections render only then), re-tested every 4th frame.
    if ((this.frame++ & 3) === 0) this.stats.shoreVisible = this.waterInView(camera.position)
    this.grass.update(focus)

    // Largest ring around the player whose chunks are ALL built: the horizon terrain only discards inside it,
    // so an unbuilt chunk shows the (slightly sunken) horizon hills, never a hole into the sky.
    let r = 0
    outer: for (; r < this.q.renderRadius; r++) {
      const n = r + 1
      for (let dz = -n; dz <= n; dz++) {
        for (let dx = -n; dx <= n; dx++) if (!this.chunks.has(chunkKey(pcx + dx, pcz + dz))) break outer
      }
    }
    this.builtRadius = r

    let drawn = 0
    for (const chunk of this.chunks.values()) drawn += chunk.drawnInstances
    const s = this.stats
    s.loaded = this.chunks.size
    s.visible = this.visibility.visible
    s.culled = this.visibility.culled
    s.instances = instances
    s.drawnInstances = drawn
    s.pending = this.streamer.pending + this.buildQueue.size
    s.genMs = this.streamer.genMsAvg
    s.physicsChunks = physicsChunks
  }

  private recenter(): void {
    const R = this.q.renderRadius
    // Request missing chunks, nearest first.
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const cx = this.centerX + dx
        const cz = this.centerZ + dz
        const key = chunkKey(cx, cz)
        if (this.chunks.has(key) || this.buildQueue.has(key)) continue
        const cached = this.cache.get(key)
        const priority = -Math.max(Math.abs(dx), Math.abs(dz)) * 10 - (Math.abs(dx) + Math.abs(dz))
        if (cached) this.buildQueue.set(key, cached)
        else this.streamer.request(cx, cz, priority)
      }
    }
    // Unload with one ring of hysteresis; drop stale queued work.
    const keepR = R + RADIUS.unloadMargin
    for (const [key, chunk] of this.chunks) {
      if (!this.inRing(chunk.data.cx, chunk.data.cz, keepR)) {
        this.physics.removeChunk(key)
        this.physics.broken.delete(key) // smashed props are rebuilt when you come back
        chunk.dispose()
        this.chunks.delete(key)
      }
    }
    for (const [key, d] of this.buildQueue) if (!this.inRing(d.cx, d.cz, R)) this.buildQueue.delete(key)
    this.streamer.cancelWhere((cx, cz) => this.inRing(cx, cz, R))
  }

  private buildPending(focus: THREE.Vector3): void {
    if (this.buildQueue.size === 0) {
      this.stats.buildMs = 0
      return
    }
    const t0 = performance.now()
    const ordered = [...this.buildQueue.values()].sort(
      (a, b) => chunkDistance(focus.x, focus.z, a.cx, a.cz) - chunkDistance(focus.x, focus.z, b.cx, b.cz),
    )
    let built = 0
    for (const d of ordered) {
      if (built >= this.q.buildPerFrame || (built > 0 && performance.now() - t0 > BUILD_BUDGET_MS)) break
      const key = chunkKey(d.cx, d.cz)
      this.buildQueue.delete(key)
      const chunk = new WorldChunk(d, this.mats, this.geos, this.fields)
      chunk.setLod(selectLod(-1, chunkDistance(focus.x, focus.z, d.cx, d.cz), this.q.lodRings), this.detail)
      this.root.add(chunk.group)
      this.chunks.set(key, chunk)
      built++
    }
    this.stats.buildMs = performance.now() - t0
  }

  dispose(): void {
    this.streamer.dispose()
    for (const [key, c] of this.chunks) {
      this.physics.removeChunk(key)
      c.dispose()
    }
    this.chunks.clear()
    this.geos.dispose()
    this.grass.dispose()
  }
}
