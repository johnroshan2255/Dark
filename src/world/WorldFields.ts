import { hash4 } from './noise/rng'
import { createNoise2D, fbm, ridged, type Noise2D } from './noise/simplex'
import { RoadNetwork, type RoadHit } from './Road/RoadNetwork'
import { PoiField } from './POI/pois'

/**
 * Global analytic fields for a seed. Any chunk can evaluate any point without its
 * neighbours — this is what makes per-chunk generation seamless and parallelisable.
 *
 * Instantiated once per seed (per worker). Pure: no allocation per call.
 */
export class WorldFields {
  readonly seed: number
  private readonly hills: Noise2D
  private readonly detail: Noise2D
  private readonly roadN: Noise2D
  private readonly forestN: Noise2D
  private readonly colorN: Noise2D
  private readonly mountN: Noise2D
  private readonly riverN: Noise2D

  /** Global water level (m): lakes wherever terrain is lower; rivers are carved below it. */
  static readonly WATER = -6
  static readonly RIVER_HALF_WIDTH = 9
  static readonly RIVER_BANK = 26
  /** Secondary roads (gravel roads + dirt trails to hills, lakes, viewpoints). */
  readonly network: RoadNetwork
  /** Procedural places (farms, cabins, ruins, camps). */
  readonly pois: PoiField
  private readonly hit: RoadHit = { dist: 0, height: 0, type: 0, halfWidth: 0 }
  static readonly NET_SHOULDER = 5

  /** Road half-width of the drivable surface (m). */
  static readonly ROAD_HALF_WIDTH = 2.7
  /** Distance over which terrain blends from road height back to natural terrain (m). */
  static readonly ROAD_SHOULDER = 9

  constructor(seed: number) {
    this.seed = seed >>> 0
    this.hills = createNoise2D(hash4(seed, 11))
    this.detail = createNoise2D(hash4(seed, 12))
    this.roadN = createNoise2D(hash4(seed, 13))
    this.forestN = createNoise2D(hash4(seed, 14))
    this.colorN = createNoise2D(hash4(seed, 15))
    this.mountN = createNoise2D(hash4(seed, 16))
    this.riverN = createNoise2D(hash4(seed, 17))
    this.pois = new PoiField({
      seed: this.seed,
      baseHeight: (x, z) => this.riverShape(x, z, this.naturalHeight(x, z)),
      roadCenterX: (z) => this.roadCenterX(z),
      riverDistance: (x, z) => this.riverDistance(x, z),
      water: WorldFields.WATER,
    })
    this.network = new RoadNetwork({
      pois: this.pois,
      seed: this.seed,
      baseHeight: (x, z) => this.riverShape(x, z, this.naturalHeight(x, z)),
      roadCenterX: (z) => this.roadCenterX(z),
      mainRoadHeight: (z) => this.roadHeight(z),
      water: WorldFields.WATER,
    })
  }

  /** Main road: runs roughly along +Z, meandering in X. */
  roadCenterX(z: number): number {
    return this.roadN(z * 0.0016, 3.7) * 110 + this.roadN(z * 0.006, 9.1) * 4 // long straight-ish runs (refs)
  }

  /** Unsigned horizontal distance to the road centreline (approximation, good for |dx/dz| < ~0.5). */
  roadDistance(x: number, z: number): number {
    return Math.abs(x - this.roadCenterX(z))
  }

  /**
   * Terrain without road/river modification (refer/environment/procedural-world-vista): big rolling
   * forested hills (±40 m), occasional tall massifs (up to ~110 m), ridged crests, low basins that hold lakes.
   */
  naturalHeight(x: number, z: number): number {
    const base = fbm(this.hills, x * 0.0021, z * 0.0021, 4) * 40
    const m = Math.max(0, fbm(this.mountN, x * 0.0008, z * 0.0008, 3) + 0.05)
    const mountains = m * m * 260
    const ridge = ridged(this.detail, x * 0.007, z * 0.007, 3) * 12
    const bumps = this.detail(x * 0.06, z * 0.06) * 0.6
    return base + mountains + ridge + bumps
  }

  /** River: winds alongside the road through its own valley, 40–100 m to one side. */
  riverCenterX(z: number): number {
    return this.roadCenterX(z) + 70 + this.riverN(z * 0.004, 21.3) * 30
  }

  riverDistance(x: number, z: number): number {
    return Math.abs(x - this.riverCenterX(z))
  }

  /** Road surface height: very low frequency + low amplitude → long, gently graded road with far views. */
  roadHeight(z: number): number {
    const x = this.roadCenterX(z)
    // Always above water: where the valley floor dips, the road runs on a low causeway.
    return Math.max(WorldFields.WATER + 1.8, fbm(this.hills, x * 0.0016, z * 0.0016, 2) * 12 + 2)
  }

  /** Width of the valley corridor the road runs through (m beyond the shoulder). */
  static readonly VALLEY = 150

  /** 0 = natural terrain, 1 = fully on the road bed. */
  roadInfluence(x: number, z: number): number {
    const d = this.roadDistance(x, z) - WorldFields.ROAD_HALF_WIDTH
    if (d <= 0) return 1
    if (d >= WorldFields.ROAD_SHOULDER) return 0
    const t = 1 - d / WorldFields.ROAD_SHOULDER
    return t * t * (3 - 2 * t)
  }

  /**
   * Terrain = natural relief, pulled toward the road level inside a valley corridor (banks keep 30% of
   * their relief next to the road, full relief 48 m out), then flattened to the road bed on the shoulder.
   * Gives the reference's composition: road on a valley floor, forested slopes, long view down the road.
   */
  height(x: number, z: number): number {
    return this.roadShape(x, z, this.netShape(x, z, this.poiShape(x, z, this.riverShape(x, z, this.naturalHeight(x, z)))))
  }

  /** Flatten the ground of a place to its base height (full inside 70 % of the radius, blending out). */
  private poiShape(x: number, z: number, h: number): number {
    const p = this.pois.near(x, z)
    if (!p) return h
    const d = Math.hypot(x - p.x, z - p.z) / p.radius
    const k = d < 0.7 ? 1 : 1 - (d - 0.7) / 0.3
    const s = k * k * (3 - 2 * k)
    return h + (p.baseH - h) * s
  }

  /** Nearest secondary road (dist from centreline, graded height, type, half-width) or null. */
  netRoad(x: number, z: number, maxDist = 30): RoadHit | null {
    return this.network.nearest(x, z, maxDist, this.hit)
  }

  /** Flatten the terrain across secondary roads (graded along them). */
  private netShape(x: number, z: number, h: number): number {
    const r = this.network.nearest(x, z, 12, this.hit)
    if (!r) return h
    const d = r.dist - r.halfWidth
    if (d >= WorldFields.NET_SHOULDER) return h
    const k = d <= 0 ? 1 : 1 - (d / WorldFields.NET_SHOULDER) ** 2
    return h + (r.height - h) * k
  }

  /** Distance from the edge of the nearest road of any kind (m; < 0 = on the road surface). */
  anyRoadEdge(x: number, z: number): number {
    const main = this.roadDistance(x, z) - WorldFields.ROAD_HALF_WIDTH
    const r = this.network.nearest(x, z, 20, this.hit)
    return r ? Math.min(main, r.dist - r.halfWidth) : main
  }

  /** Carve the river channel (bed below water) with sloping banks. */
  private riverShape(x: number, z: number, h: number): number {
    const d = this.riverDistance(x, z)
    const W = WorldFields.RIVER_HALF_WIDTH
    const B = WorldFields.RIVER_BANK
    if (d >= W + B) return h
    const bed = WorldFields.WATER - 2.2 - (1 - Math.min(1, d / W)) * 1.5
    if (d <= W) return Math.min(h, bed)
    const t = (d - W) / B
    const k = t * t * (3 - 2 * t)
    return Math.min(h, bed + (h - bed) * k)
  }

  private roadShape(x: number, z: number, natural: number): number {
    const d = this.roadDistance(x, z) - WorldFields.ROAD_HALF_WIDTH
    if (d >= WorldFields.VALLEY + WorldFields.ROAD_SHOULDER) return natural
    const rh = this.roadHeight(z)
    const t = Math.min(1, Math.max(0, d / (WorldFields.VALLEY + WorldFields.ROAD_SHOULDER)))
    const keep = 0.12 + 0.88 * t * t * (3 - 2 * t) // wide valley floor; big hills rise beyond it
    const valley = rh + (natural - rh) * keep
    const k = this.roadInfluence(x, z)
    return k === 0 ? valley : valley + (rh - valley) * k
  }

  /** Forest density 0..1: dense belts with clearings. */
  forestDensity(x: number, z: number): number {
    const n = fbm(this.forestN, x * 0.006, z * 0.006, 3) * 0.5 + 0.5
    return Math.min(1, Math.max(0, (n - 0.28) * 1.9))
  }

  /** Low-frequency albedo variation 0..1. */
  colorVariation(x: number, z: number): number {
    return this.colorN(x * 0.02, z * 0.02) * 0.5 + 0.5
  }
}
