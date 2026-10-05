import * as THREE from 'three'
import type { MaterialLibrary } from '../rendering/materials/MaterialLibrary'
import { buildInstanceAttributes, createInstancedMesh, type InstanceAttributes } from '../optimization/instancing/InstanceBuilder'
import type { Cullable } from '../optimization/culling/ChunkVisibility'
import { CELL_SIZE, CHUNK_RES, CHUNK_SIZE, LOD_COUNT } from './constants'
import type { PropGeometries } from './Forest/propGeometries'
import { buildTerrainGeometry } from './Terrain/TerrainGeometry'
import { PROP_STRIDE, TREE_STRIDE, TreeSpecies, type ChunkData } from './types'
import { buildWires } from './Road/propMeshes'
import { RoadProp } from './Road/roadProps'
import { PropType } from './POI/poiLayout'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { WorldFields } from './WorldFields'
import type { BiomeWeights } from './Biomes'
import { isOverland } from '../rendering/artStyle'
import { LAYER_NO_REFLECT, LAYER_REFLECT_ONLY } from '../rendering/water/PlanarReflection'

const _bw: BiomeWeights = [0, 0]
/**
 * Biome instance tints (linear multipliers): cold dark blue-green conifers under the snow (the snow itself is
 * painted by the material's biome cover), sun-dried desert foliage, sandstone.
 */
const FROST_TREE = [0.55, 0.72, 0.85] as const
const DRY_TREE = [1.2, 1.0, 0.62] as const
const SNOW_ROCK = [1.6, 1.65, 1.85] as const
const SAND_ROCK = [1.45, 1.2, 0.85] as const
const NO_TINT = [1, 1, 1] as const
function biomeTint(fields: WorldFields, origin: readonly [number, number], data: Float32Array, o: number, snowT: readonly number[], sandT: readonly number[], out: [number, number, number]): void {
  const w = fields.biome(origin[0] + data[o], origin[1] + data[o + 2], _bw, data[o + 1])
  const s = w[0], n = w[1]
  out[0] = 1 + (sandT[0] - 1) * s + (snowT[0] - 1) * n
  out[1] = 1 + (sandT[1] - 1) * s + (snowT[1] - 1) * n
  out[2] = 1 + (sandT[2] - 1) * s + (snowT[2] - 1) * n
}

/**
 * Genshin-style canopy palettes (linear multipliers on the leaf albedo), picked per ~28 m stand (65 %) or per
 * tree (35 %): fresh and bright greens, deep teal conifers, lime-yellow, autumn orange, maple red and a rare
 * pink blossom among the broadleaves.
 */
const FRESH = [1.25, 1.4, 0.8] as const
const BRIGHT = [1.45, 1.6, 0.7] as const
const TEAL = [0.8, 1.05, 1.1] as const
const DEEP = [0.85, 0.95, 0.95] as const
const LIME = [1.75, 1.7, 0.55] as const
const OLIVE = [1.3, 1.2, 0.72] as const
const ORANGE = [2.5, 1.35, 0.4] as const
const RED = [2.7, 0.75, 0.38] as const
const PINK = [2.5, 1.35, 1.55] as const
const BASE = [1, 1, 1] as const
/** Desert flora: own colours (no sun-dried tint), slight per-plant variety — sage, olive, dusty. */
const DESERT_HUES = [BASE, BASE, [0.9, 1.06, 0.98] as const, [1.08, 1.02, 0.86] as const, [0.95, 0.95, 1.0] as const]
// OVERLAND stands (over the hill): saturated greens with golden-yellow larch stands and the odd orange one.
const OVER_GREEN = [0.9, 1.1, 0.75] as const
const OVER_DEEP = [0.75, 0.95, 0.8] as const
const OVER_LARCH = [1.6, 1.55, 0.35] as const
const OVER_GOLD = [1.9, 1.5, 0.3] as const
const OVER_HUES: Record<number, readonly (readonly [number, number, number])[]> = {
  [TreeSpecies.Spruce]: [OVER_GREEN, OVER_GREEN, OVER_DEEP, OVER_GREEN, OVER_LARCH],
  [TreeSpecies.Fir]: [OVER_DEEP, OVER_GREEN, OVER_GREEN, OVER_LARCH],
  [TreeSpecies.Pine]: [OVER_GREEN, OVER_GREEN, OVER_LARCH, OVER_GOLD],
  [TreeSpecies.Birch]: [BASE, BASE, [1.15, 1.0, 0.8] as const, [0.95, 1.1, 0.6] as const, [1.2, 0.85, 0.6] as const],
  [TreeSpecies.Dead]: [BASE],
  [TreeSpecies.Cactus]: DESERT_HUES,
  [TreeSpecies.Joshua]: DESERT_HUES,
}
const GENSHIN_HUES: Record<number, readonly (readonly [number, number, number])[]> = {
  [TreeSpecies.Spruce]: [TEAL, TEAL, DEEP, FRESH, BRIGHT, OLIVE],
  [TreeSpecies.Fir]: [DEEP, TEAL, FRESH, FRESH, BRIGHT],
  [TreeSpecies.Pine]: [FRESH, BRIGHT, LIME, OLIVE, ORANGE],
  [TreeSpecies.Birch]: [FRESH, BRIGHT, LIME, LIME, ORANGE, ORANGE, RED, PINK],
  [TreeSpecies.Dead]: [BASE],
  [TreeSpecies.Cactus]: DESERT_HUES,
  [TreeSpecies.Joshua]: DESERT_HUES,
}
const HUES = isOverland() ? OVER_HUES : GENSHIN_HUES
const FAR_CONIFER_HUES = isOverland() ? ([OVER_GREEN, OVER_DEEP, OVER_GREEN, OVER_LARCH] as const) : ([TEAL, DEEP, FRESH, BRIGHT, LIME, ORANGE] as const)

/** Per-tier chunk detail switches. */
export interface ChunkDetail {
  plants: boolean
  /** Tree geometry level used for LOD0 chunks (0 full, 1 mid — LOW tier). It also casts the shadows. */
  treeNear: number
  /** Rocks on LOD1 chunks (off on LOW: saves a draw per far chunk). */
  farRocks: boolean
  /** LOW: only trees + near terrain cast (rocks and LOD2 terrain don't) — shadow-pass draw budget. */
  lean: boolean
}

interface SpeciesMeshes {
  /** Near meshes for geometry levels [0,1] (tier picks which), sharing the species' instance attributes. */
  levels: THREE.InstancedMesh[]
}

/** Far chunks merge species: all conifers → one mesh with spruce's far geometry, birches → one mesh. */
interface FarGroup {
  lod1: THREE.InstancedMesh
  lod2: THREE.InstancedMesh
}

/**
 * Render-side representation of one chunk. Imperative on purpose: chunks are created, LOD-switched and
 * destroyed by the streaming budget, not by React reconciliation.
 *
 * Draw calls:
 *   LOD0 (near): one per species present (typically 2–4 of 5) at the tier's `treeNear` level + terrain + rocks
 *                + ferns; shadows from those trees, rocks, terrain
 *   LOD1/LOD2 (far): species MERGED — conifers (spruce/fir/pine → spruce far geometry) + birches = ≤ 2 tree
 *                draws + terrain (+ rocks at LOD1 unless LOW). Dead snags hidden (thin; fog swallows them).
 * (A shadow-only low-poly proxy via layers does NOT work: three tests shadow-pass layers against the MAIN
 *  camera — WebGLShadowMap.renderObject. Budget is met by the per-tier near level instead.)
 *   LOD1: trees level 1, low-poly rocks      LOD2: trees level 2 (dead snags hidden)
 * Grass is NOT per chunk: GrassField draws it around the player in one call.
 */
export class WorldChunk implements Cullable {
  readonly key: string
  readonly group = new THREE.Group()
  readonly bounds = new THREE.Box3()
  private readonly origin: [number, number]
  ring = 0
  lod = -1
  isVisible = true
  instanceCount = 0

  private terrain: (THREE.Mesh | null)[] = new Array(LOD_COUNT).fill(null)
  /** The chunk's ground crosses the water level (a lake or river shore): terrain stays at LOD0 (see setLod). */
  readonly shore: boolean
  /** Submerged sample points (chunk-local x, z pairs) or null — WorldManager.waterInView. */
  readonly waterPts: Float32Array | null = null
  private species: { id: number; m: SpeciesMeshes }[] = []
  private far: FarGroup[] = []
  private rocks: THREE.InstancedMesh | null = null
  /** LOD1 rocks: low-poly geometry, same instances. */
  private rocksFar: THREE.InstancedMesh | null = null
  private ferns: THREE.InstancedMesh | null = null
  private bushes: THREE.InstancedMesh | null = null
  private agaves: THREE.InstancedMesh | null = null
  private shrubs: THREE.InstancedMesh | null = null
  private poles: THREE.InstancedMesh | null = null
  private lamps: THREE.InstancedMesh | null = null
  private fences: THREE.InstancedMesh | null = null
  private wires: THREE.LineSegments | null = null
  /** Voxel rock formations centred in this chunk (one mesh), or null. */
  private formation: THREE.Mesh | null = null
  /** Place objects (houses, barns, crops, tents…), one InstancedMesh per type present. */
  private places: { mesh: THREE.Mesh; small: boolean }[] = []
  private detail: ChunkDetail = { plants: true, treeNear: 0, farRocks: true, lean: false }
  /** Smashed prop records (gameplay/destruction) and the pole / fence instance slot of each record. */
  private readonly broken = new Set<number>()
  private readonly propSlot = new Map<number, { attr: THREE.InstancedBufferAttribute; k: number }>()

  constructor(
    readonly data: ChunkData,
    private readonly mats: MaterialLibrary,
    private readonly geos: PropGeometries,
    private readonly fields: WorldFields,
  ) {
    this.key = `${data.cx},${data.cz}`
    this.shore = data.minY < WorldFields.WATER + 0.5 && data.maxY > WorldFields.WATER - 0.5
    // Up to 4 submerged points (one per quadrant, chunk-local x, z) for the water line-of-sight test.
    if (data.minY < WorldFields.WATER - 0.2) {
      const pts: number[] = []
      const V = CHUNK_RES + 1, half = CHUNK_RES / 2
      for (let q = 0; q < 4; q++) {
        const i0 = (q & 1) * half, j0 = (q >> 1) * half
        search: for (let j = j0; j <= j0 + half; j += 2) {
          for (let i = i0; i <= i0 + half; i += 2) {
            // Real water only: not the desert (dry — no water drawn there). Ice in the snow still mirrors.
            if (data.heights[j * V + i] < WorldFields.WATER - 0.2 && fields.biome(data.cx * CHUNK_SIZE + i * CELL_SIZE, data.cz * CHUNK_SIZE + j * CELL_SIZE, _bw)[0] < 0.4) {
              pts.push(i * CELL_SIZE, j * CELL_SIZE)
              break search
            }
          }
        }
      }
      this.waterPts = new Float32Array(pts)
    }
    this.origin = [data.cx * CHUNK_SIZE, data.cz * CHUNK_SIZE]
    this.group.name = `chunk ${this.key}`
    this.group.position.set(data.cx * CHUNK_SIZE, 0, data.cz * CHUNK_SIZE)
    this.group.updateMatrix()
    this.group.matrixAutoUpdate = false
    this.bounds.min.set(data.cx * CHUNK_SIZE, data.minY - 8, data.cz * CHUNK_SIZE)
    this.bounds.max.set((data.cx + 1) * CHUNK_SIZE, data.maxY + 12, (data.cz + 1) * CHUNK_SIZE)
    // Rock formations: their own mesh (stone material); the chunk's culling box grows to hold them.
    if (data.fmIdx.length) {
      const fb = data.fmBounds
      this.bounds.min.set(Math.min(this.bounds.min.x, this.origin[0] + fb[0]), Math.min(this.bounds.min.y, fb[1]), Math.min(this.bounds.min.z, this.origin[1] + fb[2]))
      this.bounds.max.set(Math.max(this.bounds.max.x, this.origin[0] + fb[3]), Math.max(this.bounds.max.y, fb[4]), Math.max(this.bounds.max.z, this.origin[1] + fb[5]))
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(data.fmPos, 3))
      g.setAttribute('normal', new THREE.BufferAttribute(data.fmNor, 3))
      g.setAttribute('color', new THREE.BufferAttribute(data.fmCol, 3))
      g.setIndex(new THREE.BufferAttribute(data.fmIdx, 1))
      g.computeBoundingSphere()
      this.formation = this.add(new THREE.Mesh(g, mats.rock))
      this.formation.name = 'formation'
      this.formation.receiveShadow = true
    }

    const treeTint = (o: number, out: [number, number, number]) => biomeTint(fields, this.origin, data.trees, o, FROST_TREE, data.trees[o + 5] >= TreeSpecies.Cactus ? NO_TINT : DRY_TREE, out)
    const rockTint = (o: number, out: [number, number, number]) => biomeTint(fields, this.origin, data.rocks, o, SNOW_ROCK, SAND_ROCK, out)
    for (const sp of geos.trees) {
      const attrs = buildInstanceAttributes(data.trees, TREE_STRIDE, (o) => data.trees[o + 5] === sp.id, 0.16, 0.22, HUES[sp.id] ?? HUES[0], this.origin, treeTint)
      if (!attrs) continue
      const levels = [0, 1].map((l) => this.add(createInstancedMesh(sp.levels[l], mats.vegetation, attrs, `${sp.name}.lod${l}`)))
      levels.forEach((m) => m.layers.set(LAYER_NO_REFLECT)) // the reflection draws the merged far trees instead
      this.species.push({ id: sp.id, m: { levels } })
      this.instanceCount += attrs.count
    }
    const t = data.trees
    const spruce = geos.trees.find((x) => x.id === TreeSpecies.Spruce)!
    const birch = geos.trees.find((x) => x.id === TreeSpecies.Birch)!
    const conifer = (o: number) => t[o + 5] === TreeSpecies.Spruce || t[o + 5] === TreeSpecies.Fir || t[o + 5] === TreeSpecies.Pine
    const only = (id: number) => (o: number) => t[o + 5] === id
    const byId = (id: number) => geos.trees.find((x) => x.id === id)!
    // Desert species keep their own far meshes (a saguaro and a Joshua tree read differently on the skyline); a
    // desert chunk has no conifers or birches, so its far draws stay at ≤ 2 like a forest chunk's.
    const farSets = [[conifer, spruce], [only(TreeSpecies.Birch), birch], [only(TreeSpecies.Cactus), byId(TreeSpecies.Cactus)], [only(TreeSpecies.Joshua), byId(TreeSpecies.Joshua)]] as const
    for (const [filter, sp] of farSets) {
      const attrs = buildInstanceAttributes(t, TREE_STRIDE, filter, 0.16, 0.22, sp.id === spruce.id ? FAR_CONIFER_HUES : HUES[sp.id] ?? HUES[0], this.origin, treeTint)
      if (!attrs) continue
      this.far.push({
        lod1: this.add(createInstancedMesh(sp.levels[1], mats.vegetation, attrs, `far.${sp.name}.lod1`)),
        lod2: this.add(createInstancedMesh(sp.levels[2], mats.vegetation, attrs, `far.${sp.name}.lod2`)),
      })
    }
    const rockAttrs = buildInstanceAttributes(data.rocks, PROP_STRIDE, undefined, 0.12, 0, undefined, this.origin, rockTint)
    if (rockAttrs) {
      this.rocks = this.add(createInstancedMesh(geos.rock, mats.rock, rockAttrs, 'rocks'))
      this.rocksFar = this.add(createInstancedMesh(geos.rockFar, mats.rock, rockAttrs, 'rocks.far'))
      this.instanceCount += rockAttrs.count
    }
    // Undergrowth (refer/forest): ferns + leafy bushes, split deterministically by record (2 draws per near chunk).
    // On sand the same two slots hold agaves + dry shrubs (desert flora), picked by the biome at each plant.
    const pl = data.plants
    const sandy = new Uint8Array(pl.length / PROP_STRIDE)
    for (let k = 0; k < sandy.length; k++) {
      const o = k * PROP_STRIDE
      sandy[k] = fields.biome(this.origin[0] + pl[o], this.origin[1] + pl[o + 2], _bw, pl[o + 1])[0] > 0.5 ? 1 : 0
    }
    // Mostly low ferns; the leafy bush mesh only for ~1 in 4 (small bushes — the big mounds were too many).
    const isFern = (o: number) => ((pl[o] * 7.31 + pl[o + 2] * 3.17) % 1) < 0.75
    const isDesert = (o: number) => sandy[o / PROP_STRIDE] === 1
    const fernAttrs = buildInstanceAttributes(pl, PROP_STRIDE, (o) => isFern(o) && !isDesert(o), 0.22, 0.2)
    const bushAttrs = buildInstanceAttributes(pl, PROP_STRIDE, (o) => !isFern(o) && !isDesert(o), 0.25, 0.25)
    const agaveAttrs = buildInstanceAttributes(pl, PROP_STRIDE, (o) => isFern(o) && isDesert(o), 0.2, 0.25)
    const shrubAttrs = buildInstanceAttributes(pl, PROP_STRIDE, (o) => !isFern(o) && isDesert(o), 0.2, 0.3)
    if (fernAttrs) this.ferns = this.addPlant(geos.fern, fernAttrs, 'ferns')
    if (bushAttrs) this.bushes = this.addPlant(geos.bush, bushAttrs, 'bushes')
    if (agaveAttrs) this.agaves = this.addPlant(geos.agave, agaveAttrs, 'agaves')
    if (shrubAttrs) this.shrubs = this.addPlant(geos.shrub, shrubAttrs, 'shrubs')
    // Roadside props (only chunks the road passes through have any).
    const pr = data.props
    const poleAttrs = buildInstanceAttributes(pr, 6, (o) => pr[o + 5] === RoadProp.Pole, 0.1)
    const fenceAttrs = buildInstanceAttributes(pr, 6, (o) => pr[o + 5] === RoadProp.Fence, 0.12)
    // Record → instance slot of the pole / fence meshes (breakProp hides one; the lamp glow shares the poles').
    let np = 0, nf = 0
    for (let o = 0; o < pr.length; o += 6) {
      if (pr[o + 5] === RoadProp.Pole && poleAttrs) this.propSlot.set(o / 6, { attr: poleAttrs.matrix, k: np++ })
      else if (pr[o + 5] === RoadProp.Fence && fenceAttrs) this.propSlot.set(o / 6, { attr: fenceAttrs.matrix, k: nf++ })
    }
    if (poleAttrs) {
      this.poles = this.add(createInstancedMesh(geos.pole, mats.vegetation, poleAttrs, 'poles'))
      // Street lamps on every post: glow halo + light pool, same instances (one additive draw per road chunk).
      this.lamps = this.add(createInstancedMesh(geos.lampGlow, mats.lampGlow, poleAttrs, 'lamps'))
      this.lamps.castShadow = false
      this.lamps.renderOrder = 8
    }
    if (fenceAttrs) this.fences = this.add(createInstancedMesh(geos.fence, mats.vegetation, fenceAttrs, 'fences'))
    this.buildPlaces()
    const wires = buildWires(data, fields, geos.wire)
    if (wires) this.wires = this.add(wires)
    // Too small to read in the water's mirror: main camera only (PlanarReflection).
    for (const m of [this.rocks, this.ferns, this.bushes, this.agaves, this.shrubs, this.poles, this.lamps, this.fences, this.wires]) m?.layers.set(LAYER_NO_REFLECT)
  }


  /**
   * Places: every prop type baked into two static meshes per chunk (buildings, small crops) → 2 draws, not ~14.
   * Rebuilt without the broken ones when a building / hay bale / tent is smashed (breakProp).
   */
  private buildPlaces(onlyBig = false): void {
    // Crops (small) have no colliders and never break: a smash rebuilds only the buildings mesh.
    for (const p of this.places) {
      if (onlyBig && p.small) continue
      p.mesh.removeFromParent()
      p.mesh.geometry.dispose()
    }
    this.places = onlyBig ? this.places.filter((p) => p.small) : []
    const pr = this.data.props
    const isSmall = (type: number) => type === PropType.Wheat || type === PropType.Cabbage || type === PropType.Corn || type === PropType.Campfire
    for (const small of onlyBig ? [false] : [false, true]) {
      const parts: THREE.BufferGeometry[] = []
      for (const [type, geo] of this.geos.poi) {
        if (isSmall(type) !== small) continue
        const a = buildInstanceAttributes(pr, 6, (o) => pr[o + 5] === type && !this.broken.has(o / 6), small && type !== PropType.Campfire ? 0.18 : 0.05)
        if (!a) continue
        for (let k = 0; k < a.count; k++) parts.push(bakeInstance(geo, a, k))
        if (!onlyBig) this.instanceCount += a.count
      }
      if (!parts.length) continue
      const g = mergeGeometries(parts)
      parts.forEach((x) => x.dispose())
      if (!g) continue
      const mesh = new THREE.Mesh(g, this.mats.vegetation)
      mesh.name = small ? 'place.small' : 'place.big'
      this.places.push({ mesh: this.add(mesh), small })
      if (small) mesh.layers.set(LAYER_NO_REFLECT) // crops: too small for the water's mirror
    }
  }

  /** A prop record was smashed (gameplay/destruction): hide it until this chunk is rebuilt (drive away and back). */
  breakProp(index: number): void {
    if (this.broken.has(index)) return
    this.broken.add(index)
    const slot = this.propSlot.get(index)
    const type = this.data.props[index * 6 + 5]
    if (slot) {
      // Pole / fence instance: zero scale (the street-lamp glow shares the pole's matrices → it goes with it).
      ;(slot.attr.array as Float32Array).fill(0, slot.k * 16, slot.k * 16 + 16)
      slot.attr.needsUpdate = true
      if (type === RoadProp.Pole && this.wires) {
        this.wires.removeFromParent()
        this.wires.geometry.dispose()
        this.wires = null
        const w = buildWires(this.data, this.fields, this.geos.wire, (i) => this.broken.has(i / 6))
        if (w) this.wires = this.add(w)
      }
    } else this.buildPlaces(true)
    const lod = this.lod
    this.lod = -1
    this.setLod(lod, this.detail)
  }

  private addPlant(g: THREE.BufferGeometry, attrs: InstanceAttributes, name: string): THREE.InstancedMesh {
    this.instanceCount += attrs.count
    return this.add(createInstancedMesh(g, this.mats.vegetation, attrs, name))
  }

  private add<T extends THREE.Object3D>(o: T): T {
    o.matrixAutoUpdate = false
    // Static child: its world matrix is computed once on the next traversal, then never again.
    o.matrixWorldNeedsUpdate = true
    o.visible = false
    this.group.add(o)
    return o
  }

  /** @param detail tier switches — applied together with LOD. */
  setLod(lod: number, detail: ChunkDetail = this.detail): void {
    const d = this.detail
    if (lod === this.lod && detail.plants === d.plants && detail.treeNear === d.treeNear && detail.farRocks === d.farRocks && detail.lean === d.lean) return
    this.lod = lod
    this.detail = { ...detail }
    // SHORE CHUNKS keep the full-detail terrain at every LOD: the water is one flat plane, so a coarser bed mesh
    // moves the waterline — 1.4 % (LOD1) to 5 % (LOD2) of the lake area flipped wet ↔ dry at the moment a chunk
    // switched (measured over 190 shore chunks × 3 seeds): patches of lake popping in and out as you move.
    // A LOD0 terrain is 2 k triangles; ~15 % of chunks touch water. Trees/props still use `lod`.
    const tl = this.shore ? 0 : lod
    if (!this.terrain[tl]) {
      const mesh = new THREE.Mesh(buildTerrainGeometry(this.data, tl), this.mats.terrain)
      mesh.receiveShadow = true // constant: receiveShadow is part of the program key
      mesh.frustumCulled = true // bounding sphere set by buildTerrainGeometry; lets shadow passes cull
      this.terrain[tl] = this.add(mesh)
    }
    this.terrain.forEach((m, i) => m && (m.visible = i === tl))
    // Terrain casts at EVERY LOD: with only LOD0 casting, low sun/moon hill shadows end in straight lines at
    // chunk borders. Cheap now that shadow passes cull to the light frustum.
    this.terrain[tl]!.castShadow = !(detail.lean && lod === 2)

    const near = lod === 0
    for (const { id, m } of this.species) {
      const skip = detail.lean && id === TreeSpecies.Dead // LOW: rare snags cost a draw per chunk → hidden
      m.levels.forEach((mesh, l) => {
        mesh.visible = near && l === detail.treeNear && !skip
        mesh.castShadow = mesh.visible
      })
    }
    for (const f of this.far) {
      // Near chunks: the merged LOD1 trees stand in for the per-species near trees in the water's reflection
      // only (≤ 2 draws, ~¼ of the triangles); the main camera and the shadow pass never see them there.
      f.lod1.visible = lod <= 1
      f.lod1.layers.set(lod === 0 ? LAYER_REFLECT_ONLY : 0)
      f.lod2.visible = lod === 2
      // LOD1 trees can sit inside the shadow box on LOW/MEDIUM (small LOD0 ring): let them cast so tree
      // shadows don't stop at a chunk border. The shadow frustum culls the far ones.
      f.lod1.castShadow = lod === 1
    }
    if (this.rocks) (this.rocks.visible = near), (this.rocks.castShadow = near && !detail.lean)
    if (this.rocksFar) this.rocksFar.visible = lod === 1 && detail.farRocks
    if (this.ferns) this.ferns.visible = near && detail.plants
    if (this.bushes) this.bushes.visible = near && detail.plants
    if (this.agaves) this.agaves.visible = near && detail.plants
    if (this.shrubs) this.shrubs.visible = near && detail.plants
    if (this.poles) (this.poles.visible = lod <= 1), (this.poles.castShadow = near)
    if (this.lamps) this.lamps.visible = lod <= 1
    if (this.fences) (this.fences.visible = lod <= 1), (this.fences.castShadow = near && !detail.lean)
    if (this.wires) this.wires.visible = lod <= 1
    if (this.formation) {
      this.formation.visible = true // landmarks: every LOD (they dither out at the streamed-detail edge)
      this.formation.castShadow = lod <= 1
    }
    for (const { mesh, small } of this.places) {
      mesh.visible = small ? lod <= 1 : lod <= 1 || !detail.lean // buildings are far landmarks (not on LOW: draw budget)
      mesh.castShadow = near && !small // crops are low and dense: their shadows cost a draw per chunk for little
    }
  }

  setVisible(v: boolean): void {
    if (v === this.isVisible) return
    this.isVisible = v
    this.group.visible = v
  }

  /** Instances drawn by the main camera this frame (stats). */
  get drawnInstances(): number {
    if (!this.isVisible) return 0
    let n = 0
    for (const m of this.group.children) {
      if (m.visible && !m.layers.isEnabled(LAYER_REFLECT_ONLY) && (m as THREE.InstancedMesh).isInstancedMesh) n += (m as THREE.InstancedMesh).count
    }
    return n
  }

  dispose(): void {
    this.group.removeFromParent()
    for (const m of this.terrain) m?.geometry.dispose()
    // Shared geometries/materials belong to the libraries; only per-chunk buffers are freed.
    for (const { m } of this.species) m.levels.forEach((x) => x.dispose())
    for (const f of this.far) (f.lod1.dispose(), f.lod2.dispose())
    for (const m of [this.rocks, this.rocksFar, this.ferns, this.bushes, this.agaves, this.shrubs, this.poles, this.lamps, this.fences]) m?.dispose()
    for (const { mesh } of this.places) mesh.geometry.dispose()
    this.formation?.geometry.dispose()
    this.wires?.geometry.dispose()
  }
}

const _bm = new THREE.Matrix4()
const _bc = new THREE.Color()
/** One instance of `geo` with its matrix and tint applied to the vertices (for static merging). */
function bakeInstance(geo: THREE.BufferGeometry, a: InstanceAttributes, k: number): THREE.BufferGeometry {
  const g = geo.clone()
  _bm.fromArray(a.matrix.array as Float32Array, k * 16)
  g.applyMatrix4(_bm)
  _bc.fromArray(a.color.array as Float32Array, k * 3)
  const c = g.getAttribute('color') as THREE.BufferAttribute
  for (let i = 0; i < c.count; i++) c.setXYZ(i, c.getX(i) * _bc.r, c.getY(i) * _bc.g, c.getZ(i) * _bc.b)
  return g
}
