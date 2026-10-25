import * as pc from 'playcanvas'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { CHUNK_SIZE } from '../world/constants'
import { PROP_STRIDE, TREE_STRIDE, TreeSpecies, isBroadleaf, type ChunkData } from '../world/types'
import { buildInstanceAttributes, type InstanceAttributes } from '../optimization/instancing/InstanceBuilder'
import { rockPick, type PropGeometries, ROCK_VARIANTS } from '../world/Forest/propGeometries'
import { buildRoadDetailGeometry, buildTerrainGeometry } from '../world/Terrain/TerrainGeometry'
import { WorldFields } from '../world/WorldFields'
import { BIOME_COUNT, type BiomeWeights, type RegionWeights } from '../world/Biomes'
import { BIOMES, Plant, pickRegion, pickWeighted, regionRoll } from '../world/biomes/BiomeDefs'
import { RoadProp } from '../world/Road/roadProps'
import { PropType } from '../world/POI/poiLayout'
import {
  DRY_TREE, FROST_TREE, NO_TINT, ROCK_BODY, SAND_ROCK, SAND_ROCK_OTH, SNOW_ROCK, bakeInstance, biomeTint, farConiferHues, huesOf,
  regionLeafTint, speciesTreeAttrs,
} from '../world/WorldChunk'
import { packInstances, toPcMesh } from './geometry'
import type { InstEntry, InstanceBatcher } from './InstanceBatcher'
import type { RangePool } from './RangePool'
import { activeLook } from './look'
import { RibbonIndex } from '../world/Terrain/ribbonIndex'
import { buildWires } from '../world/Road/propMeshes'
import { attrSemantic } from './ThreeMirror'

/** The PlayCanvas materials the chunks draw with (one each, shared by every chunk). */
export interface PcMaterials {
  terrain: pc.StandardMaterial
  /** the road ribbon: the terrain's look, pulled toward the camera (depth bias) so it wins over the sunk grid */
  ribbon: pc.StandardMaterial
  vegetation: pc.StandardMaterial
  rock: pc.StandardMaterial
  cliffRock: pc.StandardMaterial
  /** street-lamp glows (MaterialLibrary.lampGlow through the shader port; set by the game, absent in the viewer) */
  lampGlow?: pc.Material
}

/** The world's multi-draw pools (PcWorld): one draw per material for every chunk's static meshes. */
export interface PcPools {
  terrain: RangePool
  ribbon: RangePool
  cliff: RangePool
  places: RangePool
  wires: RangePool | null
}

/** Per-tier chunk detail. */
export interface PcDetail {
  plants: boolean
  /** near trees: geometry level 0 (full) or 1 */
  treeNear: number
  farRocks: boolean
  treeCast: boolean
}

const _bw: BiomeWeights = [0, 0]
const _wn: RegionWeights = new Float32Array(BIOME_COUNT)

/**
 * One CHUNK on PlayCanvas — the three build's WorldChunk drawn with the engine's systems: its terrain (TerrainGeometry,
 * three LODs, skirts) + the road ribbon (LOD0), its trees (per species at LOD0; species merged into ≤ a few far groups
 * at LOD1 / LOD2 — the same hues, tints and stands: WorldChunk's own helpers), boulders (one instanced draw per shape:
 * fewer vertices than the merged-shape trick), the undergrowth by region, roadside poles and fences, the places baked
 * into one static mesh and the rock formations. Its STATIC meshes (terrain at the LOD, road ribbon, formations, places,
 * wires) are ranges in the world's multi-draw pools (RangePool: one draw per material for all chunks); its INSTANCED
 * content goes to the world InstanceBatcher (one draw per mesh kind). A LOD switch rewrites the terrain range (and
 * adds / drops the near-only ribbon and wires); the instanced sets are swapped in the batcher.
 */
export class PcChunk {
  readonly key: string
  lod = -1
  private readonly origin: [number, number]
  /** the terrain LOD in the pool (-1 none) */
  private terrainLod = -1
  private nearShown = false
  /** near trees per species: [level 0, level 1] */
  private readonly near: InstEntry[][] = []
  /** far groups: [lod1, lod2] */
  private readonly far: InstEntry[][] = []
  private rocks: InstEntry[] = []
  private rocksFar: InstEntry[] = []
  private plants: InstEntry[] = []
  private props: InstEntry[] = []
  private detail: PcDetail = { plants: true, treeNear: 0, farRocks: true, treeCast: true }
  readonly shore: boolean
  readonly aabb = new pc.BoundingBox()
  /** smashed prop records (gameplay/destruction): hidden until the chunk is rebuilt */
  private readonly broken = new Set<number>()
  private ribbonIdx: RibbonIndex | null | undefined

  constructor(
    private readonly app: pc.AppBase,
    readonly data: ChunkData,
    private readonly mats: PcMaterials,
    private readonly geos: PropGeometries,
    private readonly fields: WorldFields,
    private readonly batcher: InstanceBatcher,
    private readonly pools: PcPools,
  ) {
    const dev = app.graphicsDevice
    this.key = `${data.cx},${data.cz}`
    this.origin = [data.cx * CHUNK_SIZE, data.cz * CHUNK_SIZE]
    this.shore = data.minY < WorldFields.WATER + 0.5 && data.maxY > WorldFields.WATER - 0.5
    const lo = Math.min(data.minY, data.minY0) - 8, hi = data.maxY + 30
    this.aabb.setMinMax(new pc.Vec3(this.origin[0], lo, this.origin[1]), new pc.Vec3(this.origin[0] + CHUNK_SIZE, hi, this.origin[1] + CHUNK_SIZE))

    // ROCK FORMATIONS (one merged mesh, cliff rock)
    if (data.fmIdx.length) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(data.fmPos, 3))
      g.setAttribute('normal', new THREE.BufferAttribute(data.fmNor, 3))
      g.setAttribute('color', new THREE.BufferAttribute(data.fmCol, 3))
      g.setIndex(new THREE.BufferAttribute(data.fmIdx, 1))
      const nv = data.fmPos.length / 3
      g.setAttribute('aPlain', new THREE.BufferAttribute(new Float32Array(nv).fill(1, data.fmPlain), 1))
      // (the chunk's snow on every vertex: aInst = (1, 1, 1, snow) — the instanced rocks' stream, per vertex)
      const snow = this.snowAt(CHUNK_SIZE / 2, (data.minY + data.maxY) / 2, CHUNK_SIZE / 2)
      pools.cliff.set(this.key, g, this.origin[0], this.origin[1], (name, out, n) => {
        if (name !== 'aInst') return false
        for (let k = 0; k < n; k++) out.set([1, 1, 1, snow], k * 4)
        return true
      })
      g.dispose()
      const fb = data.fmBounds
      this.aabb.setMinMax(
        new pc.Vec3(Math.min(this.aabb.getMin().x, this.origin[0] + fb[0]), Math.min(this.aabb.getMin().y, fb[1]), Math.min(this.aabb.getMin().z, this.origin[1] + fb[2])),
        new pc.Vec3(Math.max(this.aabb.getMax().x, this.origin[0] + fb[3]), Math.max(this.aabb.getMax().y, fb[4]), Math.max(this.aabb.getMax().z, this.origin[1] + fb[5])),
      )
    }

    // TREES — per species (near), merged far groups (WorldChunk's sets)
    const treeTint = (o: number, out: [number, number, number]) => {
      const sp = data.trees[o + 5]
      biomeTint(fields, this.origin, data.trees, o, FROST_TREE, sp >= TreeSpecies.Cactus ? NO_TINT : DRY_TREE, out)
      if ((isBroadleaf(sp) || sp === TreeSpecies.Pine) && !fields.map?.conifers) regionLeafTint(fields, this.origin[0] + data.trees[o], this.origin[1] + data.trees[o + 2], data.trees[o + 1], out)
    }
    const t = data.trees
    const goldLarch = activeLook().soft && !!fields.map?.autumnPines
    for (const { sp, attrs } of speciesTreeAttrs(t, this.origin, fields, geos.trees, goldLarch)) {
      const data = this.buffer(attrs, t, TREE_STRIDE, (o) => t[o + 5] === sp.id)
      this.near.push([sp.levels[0], sp.near1 ?? sp.levels[1]].map((g) => entry(toPcMesh(dev, g, BB), mats.vegetation, data, attrs.count)))
    }
    const spruce = geos.trees.find((x) => x.id === TreeSpecies.Spruce)!
    const byId = (id: number) => geos.trees.find((x) => x.id === id)
    const conifer = (o: number) => t[o + 5] === TreeSpecies.Spruce || t[o + 5] === TreeSpecies.Fir || t[o + 5] === TreeSpecies.Pine
    const sets: [(o: number) => boolean, number][] = [[conifer, TreeSpecies.Spruce]]
    for (const id of [TreeSpecies.Birch, TreeSpecies.Cactus, TreeSpecies.Joshua, TreeSpecies.Palm, TreeSpecies.WhiteBirch, TreeSpecies.Maple, TreeSpecies.Ancient, TreeSpecies.Shroom, TreeSpecies.Oak, TreeSpecies.Slender, TreeSpecies.Golden, TreeSpecies.Curvy, TreeSpecies.Beech, TreeSpecies.Elm, TreeSpecies.Juniper, TreeSpecies.Bamboo, TreeSpecies.Acacia]) sets.push([(o) => t[o + 5] === id, id])
    for (const [filter, id] of sets) {
      const sp = byId(id)
      if (!sp) continue
      const attrs = buildInstanceAttributes(t, TREE_STRIDE, filter, 0.16, 0.22, sp.id === spruce.id && !fields.map?.conifers ? farConiferHues(spruce, fields) : huesOf(sp, fields, goldLarch), this.origin, treeTint)
      if (!attrs) continue
      const data = this.buffer(attrs, t, TREE_STRIDE, filter)
      this.far.push([sp.levels[1], sp.levels[2]].map((g) => entry(toPcMesh(dev, g, BB), mats.vegetation, data, attrs.count)))
    }

    // BOULDERS: one draw per shape (each instance its rockPick), the map's stone tint
    const st = fields.map?.palette.stone
    const rockTint = (o: number, out: [number, number, number]) => {
      biomeTint(fields, this.origin, data.rocks, o, SNOW_ROCK, fields.palette === 0 ? SAND_ROCK_OTH : SAND_ROCK, out)
      if (st) for (let q = 0; q < 3; q++) out[q] *= st[q] / ROCK_BODY[q]
    }
    const rockAttrs = buildInstanceAttributes(data.rocks, PROP_STRIDE, undefined, 0.12, 0, undefined, this.origin, rockTint)
    if (rockAttrs) {
      const shapes = rockShapes(geos)
      for (let v = 0; v < ROCK_VARIANTS; v++) {
        const pick: number[] = []
        for (let k = 0; k < rockAttrs.count; k++) if (rockPick(k) === v) pick.push(k)
        if (!pick.length) continue
        const rd = this.subBuffer(rockAttrs, pick, data.rocks, PROP_STRIDE)
        this.rocks.push(entry(toPcMesh(dev, shapes.near[v]), mats.rock, rd, pick.length))
        this.rocksFar.push(entry(toPcMesh(dev, shapes.far[v]), mats.rock, rd, pick.length))
      }
    }

    // UNDERGROWTH by region (BiomeDefs.plants): one instanced draw per kind present
    const pl = data.plants
    const nPl = pl.length / PROP_STRIDE
    const kind = new Uint8Array(nPl)
    const soft = activeLook().soft
    for (let k = 0; k < nPl; k++) {
      const o = k * PROP_STRIDE
      const x = this.origin[0] + pl[o], z = this.origin[1] + pl[o + 2]
      const region = pickRegion(fields.region(x, z, _wn, pl[o + 1]), regionRoll(fields.seed, x, z, 5150))
      kind[k] = pickWeighted(BIOMES[region].plants, (pl[o] * 7.31 + pl[o + 2] * 3.17) % 1)
      if (fields.palette === 0 && kind[k] === Plant.Agave) kind[k] = Plant.Shrub
      if (soft && kind[k] === Plant.Fern) kind[k] = Plant.Bush // (the soft look: round bushes, no spiky fern cards)
    }
    const plantTint = (o: number, out: [number, number, number]) => {
      out[0] = out[1] = out[2] = 1
      const kd = kind[o / PROP_STRIDE]
      if (kd === Plant.Fern || kd === Plant.Bush) regionLeafTint(fields, this.origin[0] + pl[o], this.origin[1] + pl[o + 2], pl[o + 1], out)
    }
    const plant = (kd: number, g: THREE.BufferGeometry, tint: number, shape: number) => {
      const f = (o: number) => kind[o / PROP_STRIDE] === kd
      const attrs = buildInstanceAttributes(pl, PROP_STRIDE, f, tint, shape, undefined, this.origin, plantTint)
      if (attrs) this.plants.push(entry(toPcMesh(dev, g, BB), mats.vegetation, this.buffer(attrs, pl, PROP_STRIDE, f), attrs.count))
    }
    plant(Plant.Fern, geos.fern, 0.22, 0.2)
    plant(Plant.Bush, geos.bush, 0.25, 0.25)
    plant(Plant.Agave, geos.agave, 0.2, 0.25)
    plant(Plant.Shrub, geos.shrub, 0.2, 0.3)
    plant(Plant.LeafPile, geos.leafPile, 0.25, 0.3)
    plant(Plant.GlowShroom, geos.glowShroom, 0.15, 0.25)

    this.buildProps()
  }

  /** Roadside props and places, without the smashed ones (breakProp). */
  private buildProps(): void {
    const { geos, mats, data } = this
    const dev = this.app.graphicsDevice
    this.props = []
    const br = this.broken
    // ROADSIDE PROPS: poles, fences
    const pr = data.props
    for (const [type, g, tint] of [[RoadProp.Pole, geos.pole, 0.1], [RoadProp.Fence, geos.fence, 0.12]] as const) {
      const f = (o: number) => pr[o + 5] === type && !br.has(o / 6)
      const a = buildInstanceAttributes(pr, 6, f, tint)
      if (!a) continue
      const data = this.buffer(a, pr, 6, f)
      this.props.push(entry(toPcMesh(dev, g, BB), mats.vegetation, data, a.count))
      // the lamp on every post: its glow + light pool, the same instances (additive, no shadow)
      if (type === RoadProp.Pole && mats.lampGlow) {
        const taken = new Set<string>([pc.SEMANTIC_ATTR11, pc.SEMANTIC_ATTR12, pc.SEMANTIC_ATTR13, pc.SEMANTIC_ATTR14, pc.SEMANTIC_ATTR15])
        const extra: Record<string, string> = {}
        for (const n of ['lampKind', 'corner']) {
          const sem = attrSemantic(n, taken)
          if (sem) (extra[n] = sem), taken.add(sem)
        }
        this.props.push({ ...entry(toPcMesh(dev, geos.lampGlow, extra), mats.lampGlow, data, a.count), glow: true })
      }
    }
    // PLACES: every prop type baked into ONE static mesh (buildings, crops) — a range of the places pool
    const isSmall = (type: number) => type === PropType.Wheat || type === PropType.Cabbage || type === PropType.Corn || type === PropType.Campfire
    const parts: THREE.BufferGeometry[] = []
    for (const [type, geo] of geos.poi) {
      const small = isSmall(type)
      const a = buildInstanceAttributes(pr, 6, (o) => pr[o + 5] === type && !br.has(o / 6), small && type !== PropType.Campfire ? 0.18 : 0.05)
      if (!a) continue
      for (let k = 0; k < a.count; k++) parts.push(bakeInstance(geo, a, k))
    }
    const g = parts.length ? mergeGeometries(parts) : null
    parts.forEach((x) => x.dispose())
    this.pools.places.set(this.key, g, this.origin[0], this.origin[1])
    g?.dispose()
    if (this.nearShown) this.showWires(true)
  }

  /** The power wires between the poles (sagging catenaries — RoadProps), without the smashed poles: near chunks only. */
  private showWires(on: boolean): void {
    const pool = this.pools.wires
    if (!pool) return
    pool.remove(this.key)
    if (!on) return
    const w = buildWires(this.data, this.fields, WIRE_MAT, (o) => this.broken.has(o / 6))
    if (!w) return
    const n = w.geometry.getAttribute('position').count
    w.geometry.setIndex(Array.from({ length: n }, (_, i) => i))
    pool.set(this.key, w.geometry, this.origin[0], this.origin[1])
    w.geometry.dispose()
  }

  /** Point lookup on the road ribbon (null when the chunk has none) — PcWorld.groundAt. */
  get ribbon(): RibbonIndex | null {
    if (this.ribbonIdx === undefined) this.ribbonIdx = this.data.rdIdx.length ? new RibbonIndex(this.data) : null
    return this.ribbonIdx
  }

  /** A prop record was smashed: hidden until this chunk is rebuilt (drive away and back). */
  breakProp(index: number): void {
    if (this.broken.has(index)) return
    this.broken.add(index)
    this.buildProps()
    const lod = this.lod
    this.lod = -1
    this.setLod(lod, this.detail)
  }

  /** The snow weight at chunk-local (x, y, z). */
  private snowAt(x: number, y: number, z: number): number {
    return this.fields.biome(this.origin[0] + x, this.origin[1] + z, _bw, y)[1]
  }

  /** Instance buffer of `attrs` (its records: `filter` over `data` at `stride`) + each instance's snow weight. */
  private buffer(attrs: InstanceAttributes, data: Float32Array, stride: number, filter?: (o: number) => boolean): Float32Array {
    const snow = new Float32Array(attrs.count)
    let n = 0
    for (let o = 0; o + stride <= data.length && n < attrs.count; o += stride) if (!filter || filter(o)) snow[n++] = this.snowAt(data[o], data[o + 1], data[o + 2])
    return packInstances(attrs.matrix.array as Float32Array, attrs.color.array as Float32Array, snow, attrs.count, this.origin)
  }

  /** Instance buffer of the instances `pick` of `attrs` (records of `data`, all of them, at `stride`). */
  private subBuffer(attrs: InstanceAttributes, pick: number[], data: Float32Array, stride: number): Float32Array {
    const m = attrs.matrix.array as Float32Array, c = attrs.color.array as Float32Array
    const mm = new Float32Array(pick.length * 16), cc = new Float32Array(pick.length * 3), snow = new Float32Array(pick.length)
    pick.forEach((k, i) => {
      mm.set(m.subarray(k * 16, k * 16 + 16), i * 16)
      cc.set(c.subarray(k * 3, k * 3 + 3), i * 3)
      snow[i] = this.snowAt(data[k * stride], data[k * stride + 1], data[k * stride + 2])
    })
    return packInstances(mm, cc, snow, pick.length, this.origin)
  }

  /** Chooses what draws at `lod` (0 near … 2 far); builds that terrain LOD on first use. */
  setLod(lod: number, detail: PcDetail): void {
    const d = this.detail
    if (lod === this.lod && d.plants === detail.plants && d.treeNear === detail.treeNear && d.farRocks === detail.farRocks && d.treeCast === detail.treeCast) return
    this.lod = lod
    this.detail = { ...detail }
    // the TERRAIN at this LOD (shore chunks keep the full grid: the waterline), the near-only ribbon and wires
    const tl = this.shore ? 0 : lod
    if (tl !== this.terrainLod) {
      const g = buildTerrainGeometry(this.data, tl, !!this.fields.map?.peakLod)
      this.pools.terrain.set(this.key, g, this.origin[0], this.origin[1])
      g.dispose()
      this.terrainLod = tl
    }
    const near = lod === 0
    if (near !== this.nearShown) {
      this.nearShown = near
      const g = near ? buildRoadDetailGeometry(this.data) : null
      this.pools.ribbon.set(this.key, g, this.origin[0], this.origin[1])
      g?.dispose()
      this.showWires(near)
    }
    // the instanced content -> the world batcher (one draw per mesh kind for the whole world)
    const inst: InstEntry[] = []
    if (lod === 0) {
      for (const lv of this.near) inst.push(lv[detail.treeNear])
      inst.push(...this.rocks, ...this.props)
      if (detail.plants) inst.push(...this.plants)
    } else {
      for (const fg of this.far) inst.push(fg[lod === 1 ? 0 : 1])
      if (lod === 1 && detail.farRocks) inst.push(...this.rocksFar)
    }
    // SHADOW CASTERS: the near chunks' trees, rocks and props (the undergrowth's shade is lost in the grass; trees past the
    // near ring are beyond most of the shadow distance — the terrain still casts there)
    const plants = new Set(this.plants)
    for (const e of inst) e.castShadow = !e.glow && lod === 0 && !plants.has(e) && (detail.treeCast || e.material !== this.mats.vegetation)
    this.batcher.setChunk(this.key, inst, this.aabb)
  }

  destroy(): void {
    this.batcher.setChunk(this.key, null, this.aabb)
    const P = this.pools
    for (const pool of [P.terrain, P.ribbon, P.cliff, P.places, P.wires]) pool?.remove(this.key)
  }
}

const entry = (mesh: pc.Mesh, material: pc.Material, data: Float32Array, count: number): InstEntry => ({ mesh, material, data, count, castShadow: true })

/** Billboard attributes of the vegetation geometries (tufts). */
const BB: Record<string, string> = { bbCenter: pc.SEMANTIC_ATTR8, bbOff: pc.SEMANTIC_ATTR9 }

/** The boulder library split per shape (the merged geometry tags each vertex with its rockVar). */
const shapeCache = new WeakMap<PropGeometries, { near: THREE.BufferGeometry[]; far: THREE.BufferGeometry[] }>()
function rockShapes(geos: PropGeometries): { near: THREE.BufferGeometry[]; far: THREE.BufferGeometry[] } {
  let s = shapeCache.get(geos)
  if (!s) shapeCache.set(geos, (s = { near: splitByVar(geos.rock), far: splitByVar(geos.rockFar) }))
  return s
}
function splitByVar(g: THREE.BufferGeometry): THREE.BufferGeometry[] {
  const v = g.getAttribute('rockVar')
  const out: THREE.BufferGeometry[] = []
  for (let r = 0; r < ROCK_VARIANTS; r++) {
    const keep: number[] = []
    for (let i = 0; i < v.count; i++) if (v.getX(i) === r) keep.push(i)
    const sub = new THREE.BufferGeometry()
    for (const name of ['position', 'normal', 'color']) {
      const a = g.getAttribute(name)
      const arr = new Float32Array(keep.length * a.itemSize)
      keep.forEach((i, j) => { for (let c = 0; c < a.itemSize; c++) arr[j * a.itemSize + c] = a.getComponent(i, c) })
      sub.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize))
    }
    out.push(sub)
  }
  return out
}

/** (buildWires wants a three line material; the engine draws them with PcMaterials.wire) */
const WIRE_MAT = new THREE.LineBasicMaterial()
