import { CHUNK_SIZE } from '../constants'
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
  /** Top-down preview image (north up). */
  preview: string
}

/** Every playable map (the "Select map" screen). Add a folder in public/maps/ + an entry here. */
export const MAPS: MapInfo[] = [
  {
    id: 'island',
    name: 'The Island',
    blurb: 'Snow peaks and a frozen lake, red-rock mesas with a cliff road, a slot canyon and dune switchbacks, a stunt park, forest trails, a canyon with waterfalls and a sunny coast.',
    areaKm2: 5.76,
    regions: ['Forest', 'Desert', 'Snowfield', 'Coast', 'Canyon'],
    preview: '/maps/island/preview.png',
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
  roads: { name: string; class: string; halfWidth: number; closed: boolean; x: number[]; z: number[]; h: number[]; bridge: number[] }[]
}

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

/** Sea-proximity grid cell (m) and reach (m) for beach(); sand under BEACH_TOP m that close to the sea is beach. */
const SEA_CELL = 32
const SEA_NEAR_R = 224
const BEACH_TOP = 30
const _bm: [number, number] = [0, 0]

const TREE_TYPES =['pine', 'pine_snow', 'oak', 'birch', 'cherry', 'palm']
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
    this.bio = new Uint8Array(biome)
    this.bn = meta.biomeGrid.n
    this.bstep = meta.biomeGrid.step
    this.spawn = { x: meta.spawn[0], z: meta.spawn[1], yaw: meta.spawn[2] }
    // Forest density: tree count per FOREST_CELL² cell, blurred once (3 × 3), normalised.
    this.fn = Math.ceil((2 * this.half) / FOREST_CELL)
    const count = new Float32Array(this.fn * this.fn)
    for (const types of Object.values(props.placements)) {
      for (const t of TREE_TYPES) {
        const a = types[t]
        if (!a) continue
        for (let o = 0; o < a.length; o += props.stride) {
          const i = Math.floor((a[o] + this.half) / FOREST_CELL), j = Math.floor((a[o + 2] + this.half) / FOREST_CELL)
          if (i >= 0 && j >= 0 && i < this.fn && j < this.fn) count[j * this.fn + i]++
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
