import { CHUNK_SIZE } from '../constants'
import { hashFloat, seedFromString } from '../noise/rng'
import { RoadType, type NetRoad } from '../Road/RoadNetwork'

/**
 * FIXED MAPS ("Select map" on the main menu): a finite hand-made world instead of the endless procedural one. A map is
 * a folder under `public/maps/<id>/` exported by a level tool (The Island: The-Land's Blender pipeline,
 * tools/blender/export_dark_map.py):
 *   map.json     metadata, road centrelines (x, z, graded heights, half widths, bridge flags), spawn
 *   heights.bin  Uint16 grid (n × n, row = z, column = x, `step` m apart from `origin`), m = v / 65535 · range + min
 *   biome.bin    Uint8 grid (m × m × 2): desert and snow weights 0..255 (the rest is green land)
 *   props.json   the map's prop placements (trees decide the forest density here; set pieces are drawn by the map)
 *
 * WorldFields takes a FixedMap: heights, biomes, forest and the road network come from it; the main road, the river,
 * places, formations and landmarks (all procedural) are switched off. Everything downstream — chunk meshes, the road
 * ribbon, grass, scatter, physics, the car — runs unchanged on top. Loaded once per thread (main + each chunk worker).
 */
export interface MapInfo {
  id: string
  name: string
  /** One line for the map card. */
  blurb: string
  /** Area (km²) and the regions it contains — shown on the map card. */
  areaKm2: number
  regions: string[]
  /** Bird's-eye preview image (north up, ~1.38 : 1 — the map card's box; scripts/blender/island/map_preview.py). */
  preview: string
  /** Top-down map (north up, exactly the map's 2·half square) for the in-game minimap. */
  minimap: string
}

/** Every playable map (the "Select map" screen). Add a folder in public/maps/ + an entry here. */
export const MAPS: MapInfo[] = [
  {
    id: 'island',
    name: 'The Island',
    blurb: 'An island under snow: frozen peaks and lake, icy mesas with a cliff road, a slot canyon and drifted switchbacks, a stunt park, snowy pine trails and a frozen sea.',
    areaKm2: 5.76,
    regions: ['Forest', 'Desert', 'Snowfield', 'Coast', 'Canyon'],
    preview: '/maps/island/preview.jpg',
    minimap: '/maps/island/minimap.jpg',
  },
  {
    id: 'highlands',
    name: 'The Highlands',
    blurb: 'Green plateaus and sheer grey cliffs round a turquoise lake with a wooded isle, rivers in deep valleys, a lookout on the north-east peak and a winding ring road with bridges.',
    areaKm2: 5.76,
    regions: ['Pine forest', 'Plateaus', 'Lake', 'Rivers', 'Coast'],
    preview: '/maps/highlands/preview.jpg',
    minimap: '/maps/highlands/minimap.jpg',
  },
  {
    id: 'zhangjiajie',
    name: 'Zhangjiajie & Wulingyuan',
    blurb: 'A 4 km field of towering sandstone hills, eroded and crowned with forest, flat-topped tables round the edge, a river winding through misty gorges and a scenic loop between the hills.',
    areaKm2: 16,
    regions: ['Sandstone towers', 'Mesas', 'River gorges', 'Forest'],
    preview: '/maps/zhangjiajie/preview.jpg',
    minimap: '/maps/zhangjiajie/minimap.jpg',
  },
]

interface MapJson {
  id: string
  name: string
  size: number
  half: number
  heightOffset: number
  grid: { n: number; step: number; min: number; range: number; origin: [number, number] }
  biomeGrid: { n: number; step: number; origin: [number, number] }
  spawn: [number, number, number]
  /** The map's own colours (hex 'rrggbb'): ground (grass bright / dark, dirt, rock, cliff, sand), `stone` (its loose
   *  boulders, the crags to match; the cliffs are steep, mostly shaded faces, so a `cliff` that reads as the same rock
   *  is a lighter hex — Zhangjiajie: stone 74706a, cliff b8b1a6), water, the tiered
   *  pines' leaves (leafLight / leafMid / leafDark) and its air (skyZenith, skyHaze: the horizon and the far haze). */
  palette?: Partial<Record<MapColour, string>>
  /** 'conifer': the forest is spruce / fir / pine only; 'liyue': Liyue's twisted pines among broadleaves (Zhangjiajie);
   *  else the region's mix. */
  trees?: 'conifer' | 'liyue'
  /** Valley MIST: density (/ m) at its base, base height (m, world), falloff (/ m) — BiomeAir.applyMapAir. */
  mist?: [number, number, number]
  /** The horizon grid's resolution on every tier (≥ the tier's): tall narrow relief on the skyline. */
  horizonRes?: number
  /** false: no crags on the steep ground (the map's walls are its own rock). */
  crags?: boolean
  /** Natural streaked sandstone on the cliffs (the terrain shader's uCliffStone.w = 2) instead of stacked blocks. */
  naturalStone?: boolean
  /** Coarse terrain LODs keep each vertex's highest grid point (tall narrow relief keeps its tops in the distance). */
  peakLod?: boolean
  /** Loose stones and boulders: × the scatter's rock density (default 1) — Zhangjiajie's scree slopes. */
  rocks?: number
  /** Crag / tor size on the steep ground (× default 1; < 1 also caps the slope that sets their height). */
  cragScale?: number
  /** Share of the loose stones that are BIG boulders (5–11 m; default 0). */
  bigRocks?: number
  /** Share of the cliffs covered by vegetation (palette.cliffMoss) — the terrain shader's uCliffMoss. */
  cliffMoss?: number
  /** No trees above this (m, world; default 330) — Zhangjiajie's tower tops are forested at 430 m. */
  treeLine?: number
  /** Aerial perspective: start, end (m), strength — the stylize shader's uAerial (default 30, 600, 0.75). */
  aerial?: [number, number, number]
  /** The map's light (BiomeAir.applyMapAir): hex hues for the sun, sky fill, ground bounce, white balance; cel strength,
   *  split tone, saturation multiplier. */
  light?: { sun?: string; fill?: string; bounce?: string; tint?: string; toon?: number; split?: number; saturation?: number }
  /** Grass amount (× the meadow density; default 1) — Zhangjiajie's floors are forest, not meadow. */
  grass?: number
  /** Cloud sheets in the gorges: [height (m, world), density 0..1] each, lowest first (world/map/MistSheets.ts). */
  mistSheets?: [number, number][]
  roads: { name: string; class: string; halfWidth: number; closed: boolean; x: number[]; z: number[]; h: number[]; bridge: number[] }[]
  /** Sandstone PILLARS (Zhangjiajie): [x, base y (world), z, radius, height, rotation, variant] per pillar, flat. */
  pillars?: number[]
}

export type MapColour = 'grass' | 'grassDark' | 'dirt' | 'rock' | 'cliff' | 'stone' | 'cliffMoss' | 'sand' | 'water' | 'waterDeep' | 'flowers' | 'leafLight' | 'leafMid' | 'leafDark' | 'skyZenith' | 'skyHaze'

/** Values per pillar in map.json `pillars` / FixedMap.pillars, and the lookup grid's cell (m: > the widest pillar). */
export const PILLAR_STRIDE = 7
const PILLAR_CELL = 40
/** A pillar's outer reach as a share of its radius (its flutes stand out to ~1.28 r). */
export const PILLAR_REACH = 1.3

/** Below this the sea floor lies outside the map (m, before nothing: final world height). */
const SEA_FLOOR = -30
/** The land falls off to the sea floor over this distance past the map edge (m). */
const EDGE_FALLOFF = 320
/** Forest density grid cell (m) — built from the map's tree placements. */
const FOREST_CELL = 16
/** Trees per FOREST_CELL² cell that count as full forest. */
const FOREST_FULL = 2.2
/** Road sample spacing used in the game (m): the map's 4 m samples are thinned to this. */
const ROAD_STEP = 8
/** The map's roads are drawn for a 4.5 m jeep; Dark's ribbon / ruts look right a bit narrower. */
const ROAD_WIDTH_SCALE = 0.75

/**
 * DESERT POOLS (2026-10-21, "no bushes everywhere — group them round small pools"; refs: desert springs, seeps and
 * tinajas — NPS — are the desert's green spots, grass and sedge at the pool edge, shrubs clustered round it, the
 * open sand between nearly bare): ≤ 1 per POOL_CELL cell, in the cell's lowest flat hollow on open desert (no beach,
 * off roads and set pieces), with POOL_P chance. Each is carved into the grid at load (flattened to its centre
 * height, a bowl POOL_DEPTH deep — the chunks, physics and grass all see it), holds water POOL_SINK below the rim,
 * and grows a ring of grass and bushes (`poolRing`, scatter / GrassField / groundColor) and a palm or two.
 * Deterministic (hashed per cell). The water discs are MapProps'.
 */
/** Share of the map's palms kept (the scatter grows them as Dark's palms) and the tree cell they're keyed by (m). */
const PALM_KEEP = 0.2
const PALM_CELL = 4
const _palmBw: [number, number] = [0, 0]
/** 'rrggbb' → linear rgb. */
function srgbHex(h: string): [number, number, number] {
  const n = parseInt(h.replace('#', ''), 16)
  const c = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)
  return [c((n >> 16) & 255), c((n >> 8) & 255), c(n & 255)]
}
const palmKey = (gx: number, gz: number) => (gx + 32768) * 65536 + (gz + 32768)
const POOL_CELL = 120
const POOL_P = 0.55
const POOL_DEPTH = 1.1
const POOL_SINK = 0.35
export interface Pool { x: number; z: number; /** water radius (m) */ r: number; /** water surface (world y) */ y: number }

/** Sea-proximity grid cell (m) and reach (m) for beach(); sand under BEACH_TOP m that close to the sea is beach. */
const SEA_CELL = 32
const SEA_NEAR_R = 224
const BEACH_TOP = 30
const _bm: [number, number] = [0, 0]

const TREE_TYPES = ['pine', 'pine_snow', 'oak', 'birch', 'cherry', 'palm']
/** Desert plants whose sites grow the snow's conifers when the map there is snow (a map repainted snowy). */
const SNOW_TREE_SITES = ['cactus', 'dead_tree']
/** Nature placements (Dark grows its own): every other type is a SET PIECE (MapProps) and clears the forest round it. */
const NATURE = new Set([...TREE_TYPES, 'rock', 'rock_snow', 'rock_red', 'bush', 'grass_tuft', 'cactus', 'log', 'stump', 'boulder', 'dead_tree'])
/** Forest-free radius (m) round a set piece; big ones more. */
const CLEAR: Record<string, number> = { stunt_loop: 40, quarterpipe: 16, wave_ramp: 16, cabin: 14, shack: 14, caravan: 12, campfire: 20, lift_station: 14, igloo: 10, arch: 14 }

export interface MapProps {
  stride: number
  placements: Record<string, Record<string, number[]>>
}

export class FixedMap {
  readonly id: string
  readonly name: string
  readonly half: number
  /** Spawn: x, z, yaw (rad; forward = (−sin yaw, −cos yaw)). */
  readonly spawn: { x: number; z: number; yaw: number }
  readonly roads: NetRoad[]
  /** The map's prop placements (heights in map metres: add heightOffset) — MapProps draws the set pieces. */
  readonly props: MapProps
  readonly heightOffset: number
  /** The map's colours (map.json `palette`), linear rgb — groundColor / the water / the dirt roads use them. */
  readonly palette: Partial<Record<string, [number, number, number]>> = {}
  /** Conifers only (map.json `trees: 'conifer'`). */
  readonly conifers: boolean
  /** Liyue's twisted pines among broadleaves (map.json `trees: 'liyue'`). */
  readonly liyue: boolean
  /** map.json `mist`, `horizonRes`, `crags` (see MapJson). */
  readonly mist?: [number, number, number]
  readonly horizonRes?: number
  readonly crags: boolean
  readonly naturalStone: boolean
  readonly peakLod: boolean
  readonly rocks: number
  readonly cragScale?: number
  readonly bigRocks: number
  readonly cliffMoss?: number
  readonly treeLine: number
  readonly aerial?: [number, number, number]
  readonly light?: MapJson['light']
  readonly grass: number
  readonly mistSheets?: [number, number][]
  /** The tiered pines' leaf colours (sRGB hex numbers: palette leafLight / leafMid / leafDark — all three or none). */
  readonly leaves?: { light: number; mid: number; dark: number }
  /** The seed its nature grows from (the chunk scatter: trees, boulders, plants) — the same in every game and for
   *  every player on the map, so a room shares one forest, and the server's physics has the same trunks and boulders
   *  (`statics.bin`, scripts/export-statics.mjs). Not the session seed (weather, discoveries stay per game). */
  readonly seed: number
  /** The roads' BRIDGES: each run of bridge samples with the bank sample before and after (deck centre line, world
   *  heights) and the deck half width — MapProps builds Dark's plank bridge along it. */
  readonly bridges: { xs: number[]; zs: number[]; ys: number[]; hw: number }[] = []
  /** Desert pools (see POOL_CELL) and their lookup grid (cell index → pool index, −1 none). */
  readonly pools: Pool[] = []
  /** SANDSTONE PILLARS (map.json `pillars`): PILLAR_STRIDE values each — x, base y (world), z, radius, height, rotation,
   *  variant. Drawn and collided by world/map/PillarField.ts; the ground grid holds only their talus mounds, so the
   *  terrain's coarse LODs and the horizon lose nothing (a 20 m column in an 8 m grid is a cone). Nothing grows
   *  inside one (`inPillar`, scatter). */
  readonly pillars: Float32Array
  private readonly pillarGrid = new Map<number, number[]>()
  /** The map's PALMS kept (2026-10-21, "beach trees to 20 %"): a fifth of its palm placements (hashed), as 4 m
   *  tree-cell keys — the scatter grows Dark's palm in each (scatter.treeAccept); MapProps no longer draws the map's
   *  clay palms. */
  private readonly palmCells = new Set<number>()
  private readonly poolGrid: Int32Array
  private readonly pn: number
  private readonly h: Float32Array
  private readonly n: number
  private readonly step: number
  private readonly ox: number
  private readonly oz: number
  private readonly bio: Uint8Array
  private readonly bn: number
  private readonly bstep: number
  private readonly forest: Float32Array
  private readonly fn: number
  private readonly seaNear: Float32Array
  private readonly sn: number

  constructor(meta: MapJson, heights: ArrayBuffer, biome: ArrayBuffer, props: MapProps) {
    this.id = meta.id
    this.seed = seedFromString(`map:${meta.id}`)
    this.props = props
    this.heightOffset = meta.heightOffset
    this.name = meta.name
    this.half = meta.half
    const g = meta.grid
    this.n = g.n
    this.step = g.step
    this.ox = g.origin[0]
    this.oz = g.origin[1]
    const raw = new Uint16Array(heights)
    this.h = new Float32Array(raw.length)
    const k = g.range / 65535, off = g.min + meta.heightOffset
    for (let i = 0; i < raw.length; i++) this.h[i] = raw[i] * k + off
    for (const [k, v] of Object.entries(meta.palette ?? {})) if (v) this.palette[k] = srgbHex(v)
    this.conifers = meta.trees === 'conifer'
    this.liyue = meta.trees === 'liyue'
    this.mist = meta.mist
    this.horizonRes = meta.horizonRes
    this.crags = meta.crags !== false
    this.naturalStone = !!meta.naturalStone
    this.peakLod = !!meta.peakLod
    this.rocks = meta.rocks ?? 1
    this.cragScale = meta.cragScale
    this.bigRocks = meta.bigRocks ?? 0
    this.cliffMoss = meta.cliffMoss
    this.treeLine = meta.treeLine ?? 330
    this.aerial = meta.aerial
    this.light = meta.light
    this.grass = meta.grass ?? 1
    this.mistSheets = meta.mistSheets
    const lp = meta.palette
    if (lp?.leafLight && lp.leafMid && lp.leafDark) this.leaves = { light: parseInt(lp.leafLight, 16), mid: parseInt(lp.leafMid, 16), dark: parseInt(lp.leafDark, 16) }
    this.pillars = new Float32Array(meta.pillars ?? [])
    for (let i = 0; i < this.pillars.length; i += PILLAR_STRIDE) {
      const k = this.pillarKey(Math.floor((this.pillars[i] + this.half) / PILLAR_CELL), Math.floor((this.pillars[i + 2] + this.half) / PILLAR_CELL))
      let list = this.pillarGrid.get(k)
      if (!list) this.pillarGrid.set(k, (list = []))
      list.push(i)
    }
    this.bio = new Uint8Array(biome)
    this.bn = meta.biomeGrid.n
    this.bstep = meta.biomeGrid.step
    this.spawn = { x: meta.spawn[0], z: meta.spawn[1], yaw: meta.spawn[2] }
    // Forest density: tree count per FOREST_CELL² cell, blurred once (3 × 3), normalised.
    this.fn = Math.ceil((2 * this.half) / FOREST_CELL)
    const count = new Float32Array(this.fn * this.fn)
    const bw: [number, number] = [0, 0]
    for (const types of Object.values(props.placements)) {
      for (const t of [...TREE_TYPES, ...SNOW_TREE_SITES]) {
        const a = types[t]
        if (!a) continue
        const snowSite = SNOW_TREE_SITES.includes(t)
        for (let o = 0; o < a.length; o += props.stride) {
          // the desert's cacti / snags where the map is snow now: sites of the snow's own conifers (the desert's
          // sparse clumps, counted double → small snowy groves, as the snowfields of the endless world)
          if (snowSite && this.biome(a[o], a[o + 2], bw)[1] < 0.5) continue
          const i = Math.floor((a[o] + this.half) / FOREST_CELL), j = Math.floor((a[o + 2] + this.half) / FOREST_CELL)
          if (i >= 0 && j >= 0 && i < this.fn && j < this.fn) count[j * this.fn + i] += snowSite ? 2 : 1
        }
      }
    }
    this.forest = new Float32Array(count.length)
    for (let j = 0; j < this.fn; j++) {
      for (let i = 0; i < this.fn; i++) {
        let s = 0
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = Math.min(this.fn - 1, Math.max(0, i + di)), jj = Math.min(this.fn - 1, Math.max(0, j + dj))
          s += count[jj * this.fn + ii] * (di === 0 && dj === 0 ? 2 : 1)
        }
        this.forest[j * this.fn + i] = Math.min(1, s / 10 / FOREST_FULL)
      }
    }
    // No forest on / round the set pieces (camps, cabins, the stunt park…): Dark's scatter would grow trees through them.
    for (const types of Object.values(props.placements)) {
      for (const [t, a] of Object.entries(types)) {
        if (NATURE.has(t)) continue
        const r = CLEAR[t] ?? 7
        for (let o = 0; o < a.length; o += props.stride) {
          const i0 = Math.floor((a[o] - r + this.half) / FOREST_CELL), i1 = Math.floor((a[o] + r + this.half) / FOREST_CELL)
          const j0 = Math.floor((a[o + 2] - r + this.half) / FOREST_CELL), j1 = Math.floor((a[o + 2] + r + this.half) / FOREST_CELL)
          for (let j = Math.max(0, j0); j <= Math.min(this.fn - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(this.fn - 1, i1); i++) this.forest[j * this.fn + i] = 0
        }
      }
    }
    // Sea nearby: the share of sea cells (h < 0) within ~SEA_NEAR_R of each SEA_CELL cell (a box sum over a coarse
    // grid) — beach() tells the low sand by the sea from the desert inland (both are the map's desert biome).
    this.sn = Math.ceil((2 * this.half) / SEA_CELL)
    const sea = new Float32Array(this.sn * this.sn)
    for (let j = 0; j < this.sn; j++) for (let i = 0; i < this.sn; i++) sea[j * this.sn + i] = this.height(-this.half + (i + 0.5) * SEA_CELL, -this.half + (j + 0.5) * SEA_CELL) < 0 ? 1 : 0
    this.seaNear = new Float32Array(sea.length)
    const R = Math.round(SEA_NEAR_R / SEA_CELL)
    for (let j = 0; j < this.sn; j++) {
      for (let i = 0; i < this.sn; i++) {
        let s = 0, c = 0
        for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
          const ii = i + di, jj = j + dj
          c++
          if (ii < 0 || jj < 0 || ii >= this.sn || jj >= this.sn) s++ // past the edge: the open sea
          else s += sea[jj * this.sn + ii]
        }
        this.seaNear[j * this.sn + i] = s / c
      }
    }
    this.roads = meta.roads.map((r) => toNetRoad(r, meta.heightOffset))
    for (const r of meta.roads) {
      for (let i = 0; i < r.bridge.length; i++) {
        if (!r.bridge[i] || (i > 0 && r.bridge[i - 1])) continue
        let j = i
        while (j + 1 < r.bridge.length && r.bridge[j + 1]) j++
        const a = Math.max(0, i - 1), b = Math.min(r.x.length - 1, j + 1)
        const idx = Array.from({ length: b - a + 1 }, (_, k) => a + k)
        this.bridges.push({ xs: idx.map((k) => r.x[k]), zs: idx.map((k) => r.z[k]), ys: idx.map((k) => r.h[k] + meta.heightOffset), hw: r.halfWidth * ROAD_WIDTH_SCALE + 0.4 })
      }
    }
    for (const types of Object.values(props.placements)) {
      const a = types.palm
      if (!a) continue
      for (let o = 0; o < a.length; o += props.stride) {
        // (no palms in the snow: a map repainted snowy keeps its placements but grows only conifers)
        if (this.biome(a[o], a[o + 2], _palmBw)[1] > 0.5) continue
        if (hashFloat(5531, Math.round(a[o] * 10), Math.round(a[o + 2] * 10)) < PALM_KEEP) this.palmCells.add(palmKey(Math.floor(a[o] / PALM_CELL), Math.floor(a[o + 2] / PALM_CELL)))
      }
    }
    this.pn = Math.ceil((2 * this.half) / POOL_CELL)
    this.poolGrid = new Int32Array(this.pn * this.pn).fill(-1)
    this.placePools(props)
  }

  /** Pick and carve the desert pools (see POOL_CELL). */
  private placePools(props: MapProps): void {
    const pieces: number[] = []
    for (const types of Object.values(props.placements)) {
      for (const [t, a] of Object.entries(types)) {
        if (NATURE.has(t)) continue
        for (let o = 0; o < a.length; o += props.stride) pieces.push(a[o], a[o + 2])
      }
    }
    const bw: [number, number] = [0, 0]
    const slope = (x: number, z: number) => Math.hypot(this.height(x + 3, z) - this.height(x - 3, z), this.height(x, z + 3) - this.height(x, z - 3)) / 6
    for (let cj = 0; cj < this.pn; cj++) {
      for (let ci = 0; ci < this.pn; ci++) {
        if (hashFloat(9173, ci, cj, 1) > POOL_P) continue
        let best: [number, number, number] | null = null
        for (let k = 0; k < 10; k++) {
          const x = -this.half + (ci + 0.15 + 0.7 * hashFloat(9173, ci, cj, 10 + k)) * POOL_CELL
          const z = -this.half + (cj + 0.15 + 0.7 * hashFloat(9173, ci, cj, 30 + k)) * POOL_CELL
          if (!this.inside(x, z, 40)) continue
          const h = this.height(x, z)
          if (h < 1 || this.biome(x, z, bw)[0] < 0.85 || this.beach(x, z, h) > 0.02 || slope(x, z) > 0.1) continue
          if (this.onRoad(x, z, 16)) continue
          let near = false
          for (let p = 0; p < pieces.length && !near; p += 2) near = Math.hypot(pieces[p] - x, pieces[p + 1] - z) < 28
          if (near) continue
          if (!best || h < best[2]) best = [x, z, h] // the lowest flat spot: water gathers in hollows
        }
        if (!best) continue
        const [x, z, h0] = best
        const r = 2.6 + 2.6 * hashFloat(9173, ci, cj, 2)
        this.pools.push({ x, z, r, y: h0 - POOL_SINK })
        this.poolGrid[cj * this.pn + ci] = this.pools.length - 1
        // carve: flatten toward the centre height out to rb + 4 m, then a smooth bowl of radius rb (the water's edge
        // where the bowl is POOL_SINK deep: rb = r / √(1 − √(SINK / DEPTH)))
        const rb = r / Math.sqrt(1 - Math.sqrt(POOL_SINK / POOL_DEPTH)), R = rb + 4
        const i0 = Math.max(0, Math.floor((x - R - this.ox) / this.step)), i1 = Math.min(this.n - 1, Math.ceil((x + R - this.ox) / this.step))
        const j0 = Math.max(0, Math.floor((z - R - this.oz) / this.step)), j1 = Math.min(this.n - 1, Math.ceil((z + R - this.oz) / this.step))
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const d = Math.hypot(this.ox + i * this.step - x, this.oz + j * this.step - z)
            if (d >= R) continue
            const t = Math.min(1, (R - d) / 4), flat = t * t * (3 - 2 * t)
            const k = j * this.n + i
            let y = this.h[k] + (h0 - this.h[k]) * flat
            if (d < rb) { const u = 1 - (d / rb) ** 2; y -= POOL_DEPTH * u * u }
            this.h[k] = y
          }
        }
      }
    }
  }

  /** 0..1 at (x, z): the green ring round a desert pool (1 from its water's edge out ~6 m, fading by ~11 m); 0 in the
   *  water and away from pools. */
  poolRing(x: number, z: number): number {
    const d = this.poolDist(x, z)
    return d < 0.4 || d > 11 ? 0 : d < 6 ? 1 : 1 - (d - 6) / 5
  }

  /** Distance (m) from (x, z) to the nearest desert pool's water edge (< 0 in the water; Infinity: none near). */
  poolDist(x: number, z: number): number {
    if (!this.pools.length) return Infinity
    const ci = Math.floor((x + this.half) / POOL_CELL), cj = Math.floor((z + this.half) / POOL_CELL)
    let best = Infinity
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const i = ci + di, j = cj + dj
      if (i < 0 || j < 0 || i >= this.pn || j >= this.pn) continue
      const pi = this.poolGrid[j * this.pn + i]
      if (pi < 0) continue
      const p = this.pools[pi]
      best = Math.min(best, Math.hypot(x - p.x, z - p.z) - p.r)
    }
    return best
  }

  /** Does tree cell (gx, gz) (PALM_CELL m: the scatter's TREE_CELL) hold one of the map's kept palms? */
  palmCell(gx: number, gz: number): boolean {
    return this.palmCells.has(palmKey(gx, gz))
  }

  /** In a desert pool's water (x, z)? */
  private pillarKey(ci: number, cj: number): number {
    return (ci + 1024) * 4096 + (cj + 1024)
  }

  /** Is (x, z) inside a sandstone pillar (its fluted outline + `pad` m)? */
  inPillar(x: number, z: number, pad = 0): boolean {
    if (!this.pillars.length) return false
    const ci = Math.floor((x + this.half) / PILLAR_CELL), cj = Math.floor((z + this.half) / PILLAR_CELL)
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const list = this.pillarGrid.get(this.pillarKey(ci + di, cj + dj))
        if (!list) continue
        for (const i of list) {
          const p = this.pillars, r = p[i + 3] * PILLAR_REACH + pad
          const dx = x - p[i], dz = z - p[i + 2]
          if (dx * dx + dz * dz < r * r) return true
        }
      }
    }
    return false
  }

  inPool(x: number, z: number): boolean {
    const ci = Math.floor((x + this.half) / POOL_CELL), cj = Math.floor((z + this.half) / POOL_CELL)
    if (ci < 0 || cj < 0 || ci >= this.pn || cj >= this.pn) return false
    const pi = this.poolGrid[cj * this.pn + ci]
    return pi >= 0 && Math.hypot(x - this.pools[pi].x, z - this.pools[pi].z) < this.pools[pi].r + 0.4
  }

  /** Is (x, z) within `margin` m of a road's drawn edge? (Linear in the map's road samples: for load-time checks.) */
  onRoad(x: number, z: number, margin = 0): boolean {
    for (const r of this.roads) {
      const m = r.halfWidth + margin
      if (x < r.minX - m || x > r.maxX + m || z < r.minZ - m || z > r.maxZ + m) continue
      for (let i = 0; i < r.n - 1; i++) {
        const ax = r.xs[i], az = r.zs[i], ex = r.xs[i + 1] - ax, ez = r.zs[i + 1] - az
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / Math.max(1e-6, ex * ex + ez * ez)))
        if (Math.hypot(ax + ex * t - x, az + ez * t - z) < m) return true
      }
    }
    return false
  }

  /** Terrain height (world y) at (x, z): bilinear on the grid; past the map edge it falls off to the sea floor. */
  height(x: number, z: number): number {
    const cx = Math.min(this.half, Math.max(-this.half, x)), cz = Math.min(this.half, Math.max(-this.half, z))
    const gx = (cx - this.ox) / this.step, gz = (cz - this.oz) / this.step
    const i = Math.min(this.n - 2, Math.floor(gx)), j = Math.min(this.n - 2, Math.floor(gz))
    const fx = gx - i, fz = gz - j
    const n = this.n, h = this.h
    const a = h[j * n + i], b = h[j * n + i + 1], c = h[(j + 1) * n + i], d = h[(j + 1) * n + i + 1]
    const y = a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
    const out = Math.max(Math.abs(x) - this.half, Math.abs(z) - this.half)
    if (out <= 0) return y
    const t = Math.min(1, out / EDGE_FALLOFF)
    return y + (SEA_FLOOR - y) * t * t * (3 - 2 * t)
  }

  /** [desert, snow] weights 0..1 at (x, z) (nearest cell; borders are already soft in the data). */
  biome(x: number, z: number, out: [number, number]): [number, number] {
    const i = Math.min(this.bn - 1, Math.max(0, Math.round((x - this.ox) / this.bstep)))
    const j = Math.min(this.bn - 1, Math.max(0, Math.round((z - this.oz) / this.bstep)))
    const k = (j * this.bn + i) * 2
    out[0] = this.bio[k] / 255
    out[1] = this.bio[k + 1] / 255
    return out
  }

  /** Forest density 0..1 (where the map's tree placements are). */
  forestDensity(x: number, z: number): number {
    const i = Math.floor((x + this.half) / FOREST_CELL), j = Math.floor((z + this.half) / FOREST_CELL)
    if (i < 0 || j < 0 || i >= this.fn || j >= this.fn) return 0
    return this.forest[j * this.fn + i]
  }

  /** BEACH 0..1: low sand by the sea (desert biome under BEACH_TOP m with sea nearby) — the scatter keeps it open
   *  (few rocks, a few palms). The desert inland and the cliff-top desert by the sea are not beach. */
  beach(x: number, z: number, h: number): number {
    if (h > BEACH_TOP) return 0
    const i = Math.floor((x + this.half) / SEA_CELL), j = Math.floor((z + this.half) / SEA_CELL)
    const sea = i < 0 || j < 0 || i >= this.sn || j >= this.sn ? 1 : this.seaNear[j * this.sn + i]
    const near = Math.min(1, Math.max(0, (sea - 0.03) / 0.12))
    const low = Math.min(1, (BEACH_TOP - h) / 10)
    return near * low * this.biome(x, z, _bm)[0]
  }

  /** Is (x, z) inside the playable map (with a margin, m)? */
  inside(x: number, z: number, margin = 0): boolean {
    return Math.abs(x) <= this.half - margin && Math.abs(z) <= this.half - margin
  }
}

function toNetRoad(r: MapJson['roads'][number], off: number): NetRoad {
  // Thin the 4 m samples to ROAD_STEP (keep the last one; closed loops repeat their first sample at the end).
  const every = Math.max(1, Math.round(ROAD_STEP / 4))
  const idx: number[] = []
  for (let i = 0; i < r.x.length; i += every) idx.push(i)
  if (idx[idx.length - 1] !== r.x.length - 1) idx.push(r.x.length - 1)
  if (r.closed) idx.push(0)
  const n = idx.length
  const xs = new Float32Array(n), zs = new Float32Array(n), hs = new Float32Array(n), cum = new Float32Array(n)
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
  idx.forEach((s, k) => {
    xs[k] = r.x[s]; zs[k] = r.z[s]; hs[k] = r.h[s] + off
    if (k) cum[k] = cum[k - 1] + Math.hypot(xs[k] - xs[k - 1], zs[k] - zs[k - 1])
    minX = Math.min(minX, xs[k]); maxX = Math.max(maxX, xs[k]); minZ = Math.min(minZ, zs[k]); maxZ = Math.max(maxZ, zs[k])
  })
  return {
    key: `map:${r.name}`,
    type: r.class === 'highway' ? RoadType.Gravel : RoadType.Trail,
    halfWidth: r.halfWidth * ROAD_WIDTH_SCALE,
    n, xs, zs, hs, gs: hs.slice(), cum, minX, minZ, maxX, maxZ,
  }
}

const loaded = new Map<string, Promise<FixedMap>>()

/** Load map `id` (cached per thread). Works on the main thread and in workers (absolute URLs). */
export function loadFixedMap(id: string): Promise<FixedMap> {
  let p = loaded.get(id)
  if (p) return p
  const base = new URL(`/maps/${id}/`, self.location.origin)
  const get = (f: string) => fetch(new URL(f, base)).then((r) => {
    if (!r.ok) throw new Error(`map ${id}: ${f} ${r.status}`)
    return r
  })
  p = Promise.all([
    get('map.json').then((r) => r.json() as Promise<MapJson>),
    get('heights.bin').then((r) => r.arrayBuffer()),
    get('biome.bin').then((r) => r.arrayBuffer()),
    get('props.json').then((r) => r.json()),
  ]).then(([meta, h, b, props]) => new FixedMap(meta, h, b, props))
  loaded.set(id, p)
  return p
}

/** The map this session plays (null = the endless world). Set once by Game before any world system starts, and
 *  sent with every worker request (workers load the same map). */
let active: string | null = null
export const activeMap = (): string | null => active
export function setActiveMap(id: string | null): void {
  active = id
}

/** Chunks covering the map plus its sea margin (e.g. to prefetch). */
export function mapChunkRange(m: FixedMap): [number, number] {
  const r = Math.ceil((m.half + EDGE_FALLOFF) / CHUNK_SIZE)
  return [-r, r]
}
