import * as pc from 'playcanvas'
import { ChunkStreamer } from '../world/Streaming/ChunkStreamer'
import { CELL_SIZE, CHUNK_RES, CHUNK_SIZE, RADIUS } from '../world/constants'
import { chunkKey, ICE_SNOW, type ChunkData } from '../world/types'
import { sampleHeight } from '../world/Terrain/generateTerrain'
import { groundOf } from '../world/Terrain/ribbonIndex'
import { WorldFields as Fields } from '../world/WorldFields'
import type { PhysicsWorld } from '../physics/PhysicsWorld'
import { chunkDistance, selectLod } from '../optimization/lod/LodSelector'
import { createPropGeometries, type PropGeometries } from '../world/Forest/propGeometries'
import { createFoliageAtlas } from '../rendering/materials/FoliageAtlas'
import { isBright, isGenshin, isStorybook } from '../rendering/artStyle'
import type { FixedMap } from '../world/map/FixedMap'
import { createTerrainMaterial } from './materials/terrainMaterial'
import { createVegetationDepthMaterial, createVegetationMaterial } from './materials/vegetationMaterial'
import { createRockMaterial } from './materials/rockMaterial'
import { PcChunk, type PcDetail, type PcMaterials, type PcPools } from './PcChunk'
import { activeLook } from './look'
import { RangePool, type PoolAttr } from './RangePool'
import { InstanceBatcher } from './InstanceBatcher'

/**
 * The streamed WORLD on PlayCanvas: the game's chunk workers (world/Streaming — engine-free data) feed PcChunks in a
 * square of `radius` chunks round the focus; each chunk picks its LOD from its distance (the three build's
 * LodSelector rings, with hysteresis) — near: full trees, plants, rocks, props, the road ribbon; LOD1: merged far
 * trees + low rocks; LOD2: the lowest trees. Chunks beyond radius + 1 are destroyed (their GPU buffers freed). At most
 * `buildPerFrame` chunks are built per frame (no hitch when a ring of new chunks arrives).
 */
export class PcWorld {
  radius = 3
  lodRings: [number, number] = [1.2, 2.3]
  buildPerFrame = 2
  detail: PcDetail = { plants: true, treeNear: 0, farRocks: true, treeCast: true }
  readonly mats: PcMaterials
  private readonly chunks = new Map<string, PcChunk>()
  private readonly pendingBuild = new Map<string, ChunkData>()
  private readonly streamer: ChunkStreamer
  private readonly geos: PropGeometries
  readonly batcher: InstanceBatcher
  /** the leaves' depth pre-pass layer (the game's camera must render it) */
  readonly prepassLayer: pc.Layer
  /** every chunk's static meshes: one multi-draw per material (RangePool) */
  readonly pools: PcPools
  private readonly poolNode = new pc.GraphNode('worldPools')
  private cx = 1e9
  private cz = 1e9

  /** Colliders round the player (and the vehicle look-ahead point): the game's Rapier world (null: the viewer). */
  physics: PhysicsWorld | null = null
  /** chunks with colliders (stats) */
  physicsChunks = 0
  /** LOD switches so far (the shadow / stats) */
  lodSwitches = 0
  /** bumped when a chunk within 2 chunks of the focus is built, removed or switches LOD (the cached sun shadow) */
  meshStamp = 0

  /** @param atlasCanvas the foliage atlas already painted (the game's MaterialLibrary has one: not painted twice) */
  constructor(private readonly app: pc.AppBase, readonly fields: Fields, map: FixedMap | null, seed: number, atlasCanvas?: HTMLCanvasElement) {
    const dev = app.graphicsDevice
    // the foliage atlas (drawn once on a canvas: no download), sRGB, mipmapped
    // (the soft look paints its own: round leaf discs on the broadleaves — the game's shared atlas has fans)
    const soft = activeLook().soft
    const atlasSrc = atlasCanvas && !soft ? null : createFoliageAtlas(isStorybook(), isGenshin(), isBright(), soft)
    // (flipY: the atlas UVs are three's — v = 0 at the canvas BOTTOM, where the opaque solid texels for trunks live)
    const atlas = new pc.Texture(dev, { name: 'foliageAtlas', format: pc.PIXELFORMAT_SRGBA8, flipY: true, mipmaps: true, anisotropy: 4, minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR, magFilter: pc.FILTER_LINEAR })
    atlas.setSource(atlasSrc ? (atlasSrc.image as HTMLCanvasElement) : atlasCanvas!)
    atlasSrc?.dispose()
    const ribbon = createTerrainMaterial()
    ribbon.name = 'roadRibbon'
    ribbon.depthBias = -1
    ribbon.slopeDepthBias = -2
    ribbon.update()
    this.mats = {
      terrain: createTerrainMaterial(),
      ribbon,
      vegetation: createVegetationMaterial(atlas),
      rock: createRockMaterial('rock'),
      cliffRock: createRockMaterial('cliff'),
    }
    this.geos = createPropGeometries({ tieredPines: !!map?.conifers, leaves: map?.leaves, autumnPines: map?.autumnPines && !activeLook().soft, softBush: activeLook().soft }) // (soft: no gold-TIPPED firs — flecks)
    // THE LEAVES' DEPTH PRE-PASS (InstanceBatcher Prepass, vegetationMaterial createVegetationDepthMaterial): a layer
    // drawn just before the world's opaque pass; the batched trees, plants and props draw their depth there first
    const comp = app.scene.layers, worldL = comp.getLayerById(pc.LAYERID_WORLD)!
    this.prepassLayer = new pc.Layer({ name: 'LeafDepth', opaqueSortMode: pc.SORTMODE_FRONT2BACK })
    comp.insertOpaque(this.prepassLayer, comp.getOpaqueIndex(worldL))
    this.batcher = new InstanceBatcher(app, { from: this.mats.vegetation, main: createVegetationMaterial(atlas, { prepassed: true }), depth: createVegetationDepthMaterial(atlas), layer: this.prepassLayer })
    // THE STATIC WORLD IN 4 DRAWS (+ wires): terrain, road ribbons, rock formations, places — each one multi-draw
    // (small first reservations: the pools grow ×1.5 to what the ring needs — memory follows the map, not a guess)
    const A = (name: string, semantic: string, components: number, kind: PoolAttr['kind'] = 'f32'): PoolAttr => ({ name, semantic, components, kind })
    const base = [A('position', pc.SEMANTIC_POSITION, 3), A('normal', pc.SEMANTIC_NORMAL, 3), A('color', pc.SEMANTIC_COLOR, 3, 'srgb8')]
    const ground = [...base, A('roadLat', pc.SEMANTIC_ATTR8, 1), A('roadNet', pc.SEMANTIC_ATTR9, 2), A('biome', pc.SEMANTIC_ATTR10, 2), A('mud', pc.SEMANTIC_ATTR7, 1)]
    app.root.addChild(this.poolNode)
    const dev2 = app.graphicsDevice
    this.pools = {
      terrain: new RangePool(dev2, this.poolNode, this.mats.terrain, ground, 1 << 15, 1 << 17),
      ribbon: new RangePool(dev2, this.poolNode, this.mats.ribbon, ground, 1 << 12, 1 << 14),
      cliff: new RangePool(dev2, this.poolNode, this.mats.cliffRock, [...base, A('aPlain', pc.SEMANTIC_ATTR10, 1), A('aInst', pc.SEMANTIC_ATTR13, 4)], 1 << 15, 1 << 17),
      places: new RangePool(dev2, this.poolNode, this.mats.vegetation, [...base, A('uv', pc.SEMANTIC_TEXCOORD0, 2), A('bbCenter', pc.SEMANTIC_ATTR8, 3), A('bbOff', pc.SEMANTIC_ATTR9, 2)], 1 << 12, 1 << 14),
      wires: null,
    }
    this.pools.ribbon.mi.castShadow = false // (it lies on the ground the terrain casts with)
    for (const pool of [this.pools.terrain, this.pools.cliff, this.pools.places]) pool.mi.castShadow = true
    app.scene.layers.getLayerById(pc.LAYERID_WORLD)!.addMeshInstances([this.pools.terrain.mi, this.pools.ribbon.mi, this.pools.cliff.mi, this.pools.places.mi])
    this.streamer = new ChunkStreamer(seed, (d) => this.pendingBuild.set(chunkKey(d.cx, d.cz), d))
  }

  /** The power wires' material (the game sets it; lines, one multi-draw for the whole world). */
  setWireMaterial(m: pc.Material): void {
    if (this.pools.wires) return
    this.pools.wires = new RangePool(this.app.graphicsDevice, this.poolNode, m, [{ name: 'position', semantic: pc.SEMANTIC_POSITION, components: 3, kind: 'f32' }], 1 << 14, 1 << 14, pc.PRIMITIVE_LINES)
    this.pools.wires.mi.castShadow = false
    this.app.scene.layers.getLayerById(pc.LAYERID_WORLD)!.addMeshInstances([this.pools.wires.mi])
  }

  /** A side job on the chunk workers (horizon, landmarks): no extra worker per system. */
  side<T>(msg: object): Promise<T> {
    return this.streamer.side<T>(msg)
  }

  get count(): number {
    return this.chunks.size
  }

  /** The largest ring round the focus chunk whose chunks are all built (the horizon's hole). */
  get builtRadius(): number {
    let r = 0
    outer: for (; r <= this.radius; r++) {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) === r && !this.chunks.has(chunkKey(this.cx + dx, this.cz + dz))) break outer
      }
    }
    return r - 1
  }

  get pending(): number {
    return this.streamer.pending + this.pendingBuild.size
  }

  get chunkMap(): ReadonlyMap<string, PcChunk> {
    return this.chunks
  }

  /** The rendered (LOD0) ground from the loaded chunk data, the road ribbon included (= the colliders); null where none. */
  groundAt(x: number, z: number): number | null {
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const c = this.chunks.get(chunkKey(cx, cz))
    if (!c) return null
    const lx = x - cx * CHUNK_SIZE, lz = z - cz * CHUNK_SIZE
    const h = Math.max(groundOf(c.data, c.ribbon, lx, lz), sampleHeight(c.data.heights0, lx, lz))
    if (h >= Fields.WATER) return h
    const vi = Math.min(CHUNK_RES, Math.round(lz / CELL_SIZE)) * (CHUNK_RES + 1) + Math.min(CHUNK_RES, Math.round(lx / CELL_SIZE))
    return c.data.biome[vi * 2 + 1] > ICE_SNOW ? Fields.WATER : h
  }

  /** The LIQUID water surface at (x, z) (WorldManager.waterAt): WATER over a lake / river, -Infinity elsewhere. */
  waterAt(x: number, z: number): number {
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const c = this.chunks.get(chunkKey(cx, cz))
    let h: number, desert: number, snow: number
    if (c) {
      const lx = x - cx * CHUNK_SIZE, lz = z - cz * CHUNK_SIZE
      h = sampleHeight(c.data.heights, lx, lz)
      const vi = Math.min(CHUNK_RES, Math.round(lz / CELL_SIZE)) * (CHUNK_RES + 1) + Math.min(CHUNK_RES, Math.round(lx / CELL_SIZE))
      desert = c.data.biome[vi * 2]
      snow = c.data.biome[vi * 2 + 1]
    } else {
      h = this.fields.height(x, z)
      const bw = this.fields.biome(x, z, _wbw)
      desert = bw[0]
      snow = bw[1]
    }
    return h < Fields.WATER && snow <= ICE_SNOW && (desert < 0.4 || this.fields.palette === 0) ? Fields.WATER : -Infinity
  }

  /** Fraction of the chunks within r rings of (x, z) that are built. */
  builtNear(x: number, z: number, r: number): number {
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    let n = 0
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (this.chunks.has(chunkKey(cx + dx, cz + dz))) n++
    return n / (2 * r + 1) ** 2
  }

  /** The chunk under (x, z) is drawn and has colliders. */
  isReadyAt(x: number, z: number): boolean {
    const key = chunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE))
    return this.chunks.has(key) && (!this.physics || this.physics.hasChunk(key))
  }

  /** @param ax, az the vehicle look-ahead point: chunks within the physics ring of either point get colliders. */
  update(x: number, z: number, cam: pc.CameraComponent, ax = x, az = z): void {
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const r = this.radius
    if (cx !== this.cx || cz !== this.cz) {
      this.cx = cx
      this.cz = cz
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const key = chunkKey(cx + dx, cz + dz)
          if (!this.chunks.has(key) && !this.pendingBuild.has(key)) this.streamer.request(cx + dx, cz + dz, -(dx * dx + dz * dz))
        }
      }
      this.streamer.cancelWhere((qx, qz) => Math.max(Math.abs(qx - cx), Math.abs(qz - cz)) <= r)
      for (const [key, c] of this.chunks) {
        if (Math.max(Math.abs(c.data.cx - cx), Math.abs(c.data.cz - cz)) > r + 1) {
          c.destroy()
          this.chunks.delete(key)
          if (this.physics) {
            this.physics.removeChunk(key)
            this.physics.broken.delete(key)
          }
        }
      }
      for (const [key, d] of this.pendingBuild) if (Math.max(Math.abs(d.cx - cx), Math.abs(d.cz - cz)) > r + 1) this.pendingBuild.delete(key)
    }
    this.streamer.pump()
    // build the nearest pending chunks first, a few per frame
    if (this.pendingBuild.size) {
      const near = [...this.pendingBuild.values()].sort((a, b) => chunkDistance(x, z, a.cx, a.cz) - chunkDistance(x, z, b.cx, b.cz)).slice(0, this.buildPerFrame)
      for (const d of near) {
        this.pendingBuild.delete(chunkKey(d.cx, d.cz))
        const c = new PcChunk(this.app, d, this.mats, this.geos, this.fields, this.batcher, this.pools)
        this.chunks.set(c.key, c)
        if (Math.max(Math.abs(d.cx - cx), Math.abs(d.cz - cz)) <= 2) this.meshStamp++
      }
    }
    const acx = Math.floor(ax / CHUNK_SIZE), acz = Math.floor(az / CHUNK_SIZE)
    let pn = 0
    for (const c of this.chunks.values()) {
      const was = c.lod
      c.setLod(selectLod(c.lod, chunkDistance(x, z, c.data.cx, c.data.cz), this.lodRings), this.detail)
      if (c.lod !== was) {
        this.lodSwitches++
        if (Math.max(Math.abs(c.data.cx - cx), Math.abs(c.data.cz - cz)) <= 2) this.meshStamp++
      }
      const ph = this.physics
      if (!ph) continue
      // physics ring round the player and the look-ahead point, one ring of hysteresis (WorldManager)
      const ring = Math.max(Math.abs(c.data.cx - cx), Math.abs(c.data.cz - cz)), ringA = Math.max(Math.abs(c.data.cx - acx), Math.abs(c.data.cz - acz))
      if (Math.min(ring, ringA) <= RADIUS.physics) ph.addChunk(c.key, c.data)
      else if (ring > RADIUS.physics + 1 && ringA > RADIUS.physics + 1) ph.removeChunk(c.key)
      if (ph.hasChunk(c.key)) pn++
    }
    this.physicsChunks = pn
    this.batcher.update(cam)
    const P = this.pools
    for (const pool of [P.terrain, P.ribbon, P.cliff, P.places, P.wires]) pool?.update(cam)
  }
}

const _wbw: [number, number] = [0, 0]
