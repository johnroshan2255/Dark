import { hash4 } from './noise/rng'
import { createNoise2D, fbm, ridged, type Noise2D } from './noise/simplex'
import { RoadNetwork, type RoadHit } from './Road/RoadNetwork'
import { PoiField } from './POI/pois'
import { Biome, BIOME_COUNT, BiomeField, type BiomeWeights, type RegionWeights } from './Biomes'
import { BIOMES } from './biomes/BiomeDefs'
import { ICE_SNOW } from './types'
import { FormationField } from './Formations/formations'
import { LandmarkField } from './Landmarks/landmarks'

const poiBw: BiomeWeights = [0, 0]
const sstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Global analytic fields for a seed. Any chunk can evaluate any point without its
 * neighbours — this is what makes per-chunk generation seamless and parallelisable.
 *
 * Instantiated once per seed (per worker). Pure: no allocation per call.
 *
 * TERRAIN LAYERING (`height`), each stage evaluated analytically on top of the previous one:
 *   natural (biome-shaped hills/massifs) → VALLEY (main-road corridor with slope-limited banks) → RIVER
 *   (carved below the water) → PLACES (flattened to a base measured on THAT ground) → SECONDARY ROADS
 *   (graded along the road, cut/fill embankments as wide as they are tall) → MAIN ROAD BED.
 * Every downstream stage measures its base on the stages before it (places on the valley floor, secondary
 * roads on the flattened places), so no stage can later distort another — the bug that produced cliffs
 * beside the road, walls where trails met it and trenches through farms.
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

  /** Ground palette (Terrain/groundColor.ts): 0 Genshin meadow, 1 overland straw — colours only, set from the art style. */
  palette = 0
  /** Global water level (m): lakes wherever terrain is lower; rivers are carved below it. */
  static readonly WATER = -6
  static readonly RIVER_HALF_WIDTH = 9
  static readonly RIVER_BANK = 26
  /** Secondary roads (gravel roads + dirt trails to hills, lakes, viewpoints). */
  readonly network: RoadNetwork
  /** Procedural places (farms, cabins, ruins, camps). */
  readonly pois: PoiField
  /** Biome regions (forest / desert / snow) + the snow line. */
  readonly biomes: BiomeField
  /** Voxel rock formations (arches, caves, karst pillars, outcrops). */
  readonly formations: FormationField
  /** Big landmarks on the high ground (giant trees, windmills, ruins, statues, towers, obelisks, ice spires). */
  readonly landmarks: LandmarkField
  private readonly hit: RoadHit = { dist: 0, height: 0, type: 0, halfWidth: 0 }
  private readonly bw: BiomeWeights = [0, 0]
  private readonly wn: RegionWeights = new Float32Array(BIOME_COUNT)
  static readonly NET_SHOULDER = 4
  /** Secondary-road embankments: horizontal run per metre of cut/fill (1.6 → ≤ ~43° at the steepest point). */
  static readonly NET_EMBANKMENT = 1.6

  /** Road half-width of the drivable surface (m). */
  static readonly ROAD_HALF_WIDTH = 2.7
  /** Distance over which terrain blends from road height back to the valley floor (m). */
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
    this.biomes = new BiomeField(this.seed)
    // Wandering biome borders (±150 m, ~700 m features); the spawn cells stay forest (their 3×3 ring is forest).
    const warpN = createNoise2D(hash4(seed, 18))
    const warp: [number, number] = [0, 0]
    this.biomes.warp = (x, z) => {
      warp[0] = warpN(x * 0.0014, z * 0.0014) * 150
      warp[1] = warpN(x * 0.0014 + 5.5, z * 0.0014 - 2.5) * 150
      return warp
    }
    this.pois = new PoiField({
      seed: this.seed,
      baseHeight: (x, z) => this.groundBeforePlaces(x, z),
      roadCenterX: (z) => this.roadCenterX(z),
      riverDistance: (x, z) => this.riverDistance(x, z),
      water: WorldFields.WATER,
      biome: (x, z) => this.biomes.weights(x, z, poiBw),
    })
    const fmBw: BiomeWeights = [0, 0]
    this.formations = new FormationField({
      seed: this.seed,
      height: (x, z) => this.groundBeforePlaces(x, z),
      roadDistance: (x, z) => this.roadDistance(x, z),
      riverDistance: (x, z) => this.riverDistance(x, z),
      placeNear: (x, z, m) => this.pois.near(x, z, m) !== null,
      biome: (x, z) => this.biomes.weights(x, z, fmBw),
      roadCenterX: (z) => this.roadCenterX(z),
      roadHeight: (z) => this.roadHeight(z),
      water: WorldFields.WATER,
    })
    const lmBw: BiomeWeights = [0, 0]
    this.landmarks = new LandmarkField({
      seed: this.seed,
      height: (x, z) => this.height(x, z),
      roadDistance: (x, z) => this.roadDistance(x, z),
      riverDistance: (x, z) => this.riverDistance(x, z),
      placeNear: (x, z, m) => this.pois.near(x, z, m) !== null,
      formationNear: (x, z, m) => this.formations.near(x, z, m) !== null,
      biome: (x, z) => this.biomes.weights(x, z, lmBw),
      region: (x, z) => this.biomes.dominant(x, z),
      roadCenterX: (z) => this.roadCenterX(z),
      water: WorldFields.WATER,
    })
    this.network = new RoadNetwork({
      pois: this.pois,
      seed: this.seed,
      baseHeight: (x, z) => this.poiShape(x, z, this.groundBeforePlaces(x, z)),
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
   * Biomes reshape it: deserts are flatter basins with long soft dunes; snowfields carry bigger, rounder massifs.
   */
  naturalHeight(x: number, z: number): number {
    const base = fbm(this.hills, x * 0.0021, z * 0.0021, 4) * 40
    const m = Math.max(0, fbm(this.mountN, x * 0.0008, z * 0.0008, 3) + 0.05)
    const mountains = m * m * 260
    const ridge = ridged(this.detail, x * 0.007, z * 0.007, 3) * 12
    const bumps = this.detail(x * 0.06, z * 0.06) * 0.6
    let h = base + mountains + ridge + bumps
    const wn = this.biomes.weightsN(x, z, this.wn)
    const sand = wn[Biome.Desert], snow = wn[Biome.Snow], autumn = wn[Biome.Autumn], mystic = wn[Biome.Mystic]
    // GENSHIN UPLANDS (Mondstadt / Liyue): terraced PLATEAUS — up to three grassy tiers of 12–16 m with sheer
    // layered-rock cliffs between them (a threshold of low-frequency noise: ~45–55° faces), wandering across the
    // land, so the world reads as cliffs, shelves and valleys, not a uniform hillside. Snow keeps half of it
    // (Dragonspine's ledges); the desert has its own mesas. The road's valley shaping still levels the corridor.
    const pn = fbm(this.mountN, x * 0.0022 + 31.7, z * 0.0022 - 8.3, 3)
    const tiers = sstep(0.1, 0.165, pn) * 16 + sstep(0.28, 0.335, pn) * 14 + sstep(0.46, 0.505, pn) * 12
    // AUTUMN valleys are open and rolling (fewer tiers, softer hills); the MYSTIC woods are dramatic (taller tiers,
    // sharper ridges).
    h += tiers * (1 - sand) * (1 - snow * 0.5) * (1 - 0.55 * autumn + 0.4 * mystic)
    h += ridge * 0.6 * mystic - base * 0.2 * autumn
    if (sand > 0.001) {
      const dunes = this.dunes(x, z) + this.detail(x * 0.02, z * 0.02) * 0.6
      // MESAS & BUTTES: flat-topped tables with sheer sides (a threshold of low-frequency noise → cliffs ~50°),
      // some with a second, smaller tier on top. The steep sides take the red-rock ground colour and the
      // terrain shader's sandstone strata.
      const mn = fbm(this.mountN, x * 0.0045 + 13.7, z * 0.0045 - 4.2, 2)
      const mesa = sstep(0.3, 0.38, mn) * 26 + sstep(0.5, 0.55, mn) * 16
      h += (base * 0.5 + mountains * 0.55 + dunes + mesa + bumps * 0.5 - h) * sand
    }
    if (snow > 0.001) h += (base * 1.1 + mountains * 1.3 + ridge * 0.6 + bumps + this.drifts(x, z) - h) * snow
    this.lastSnow = snow
    return h
  }

  /**
   * DESERT DUNES (Sumeru-like transverse dunes): crest lines run across a prevailing wind (from the south-west),
   * wandering with low-frequency warp. Each dune has a long gentle WINDWARD slope (concave, steepening toward
   * the top), a SHARP crest and a short steep SLIP FACE at sand's angle of repose (~34°); crest height varies along
   * the line (4–15 m). Pure arithmetic + noise → deterministic; the colliders follow the same heights.
   */
  private dunes(x: number, z: number): number {
    const along = x * 0.8 + z * 0.6, across = -x * 0.6 + z * 0.8
    const warp = this.detail(x * 0.0035 + 2.1, z * 0.0035 - 7.7) * 55 + this.detail(across * 0.011, 4.4) * 18
    const spacing = 72
    const u = (along + warp) / spacing
    const f = u - Math.floor(u)
    const crest = 0.78
    const prof = f < crest ? Math.pow(f / crest, 1.5) : Math.pow(1 - (f - crest) / (1 - crest), 2)
    const height = 9.5 + this.detail(x * 0.0042 - 5.2, z * 0.0042 + 1.9) * 5.5
    return prof * Math.max(3.5, height)
  }

  /** SNOW DRIFTS: soft, rounded wind-blown mounds (no sharp crests), 1–3 m, elongated along the wind. */
  private drifts(x: number, z: number): number {
    const along = x * 0.8 + z * 0.6, across = -x * 0.6 + z * 0.8
    const n = this.detail(along * 0.022 + 9.3, across * 0.008 - 1.7)
    return Math.max(0, n) * Math.max(0, n) * 6 + this.detail(x * 0.05 + 3.3, z * 0.05) * 0.35
  }

  /** Snow weight (region) at the last naturalHeight(x, z) call — the road's snow banks reuse it. */
  private lastSnow = 0

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
  static readonly VALLEY = 110

  /** 0 = natural terrain, 1 = fully on the road bed. */
  roadInfluence(x: number, z: number): number {
    const d = this.roadDistance(x, z) - WorldFields.ROAD_HALF_WIDTH
    if (d <= 0) return 1
    if (d >= WorldFields.ROAD_SHOULDER) return 0
    const t = 1 - d / WorldFields.ROAD_SHOULDER
    return t * t * (3 - 2 * t)
  }

  /** Final terrain height (see the class comment for the layering). */
  height(x: number, z: number): number {
    const g = this.gorge(x, z, this.groundBeforePlaces(x, z))
    const snow = this.lastSnow // naturalHeight(x, z) ran inside groundBeforePlaces
    const s = this.poiWeight(x, z)
    const h = s > 0 ? g + (this.pois.near(x, z)!.baseH - g) * s : g
    // Road embankments fade out inside a place's flattened disc (the roads there lie on its base anyway).
    const out = this.roadBed(x, z, this.netShape(x, z, h, 1 - s))
    // SNOW BANKS: the plough leaves a soft ridge of snow (~0.7 m) just outside each edge of the main road.
    if (snow > 0.05) {
      const d = this.roadDistance(x, z) - WorldFields.ROAD_HALF_WIDTH
      if (d > 0.3 && d < 4.5) {
        const t = (d - 0.3) / 4.2
        return out + Math.sin(Math.PI * Math.pow(t, 0.7)) * 0.7 * snow * (0.8 + 0.2 * this.detail(x * 0.3, z * 0.3))
      }
    }
    return out
  }

  /**
   * The SOLID surface at (x, z): the terrain, or the ice at the water level where the water is frozen (snow
   * region — the same rule as the physics heightfield, `types.solidHeight`). Use it to place / respawn things.
   */
  surface(x: number, z: number): number {
    const h = this.height(x, z)
    return h < WorldFields.WATER && this.biomes.weights(x, z, this.bw)[1] > ICE_SNOW ? WorldFields.WATER : h
  }

  /** Valley + river on the natural relief: what places and secondary roads are measured against. */
  private groundBeforePlaces(x: number, z: number): number {
    return this.riverShape(x, z, this.valleyShape(x, z, this.naturalHeight(x, z)))
  }

  /**
   * GORGES: on ~a quarter of the main road, steep rock walls (10–20 m, layered-stone cliffs in the shader) rise
   * 12–22 m off each side — the road runs through a canyon instead of an open valley (Genshin's passes; red rock
   * in the desert, icy in the snow). Added AFTER the valley's slope limit (so they can be walls), but only beyond
   * 10 m past the road's edge: the verge stays gentle (the shoulder-step test), and they fall away by ~60 m.
   * Applied in `height()` on top of the places' / secondary roads' reference ground, so a joining road's
   * embankment cuts a pass through the wall and a place's flat disc overrides it; rivers keep a clear channel.
   */
  private gorge(x: number, z: number, h: number): number {
    // Never around the spawn: the game opens on an open valley with the home landmark in view (landmarks.ts).
    const m = sstep(0.56, 0.68, this.roadN(z * 0.0011, 50.5) * 0.5 + 0.5) * sstep(450, 750, Math.abs(z))
    if (m <= 0) return h
    const d = this.roadDistance(x, z) - WorldFields.ROAD_HALF_WIDTH
    if (d < 10 || d > 70) return h
    const r = this.riverDistance(x, z) - WorldFields.RIVER_HALF_WIDTH - WorldFields.RIVER_BANK
    const wall = sstep(10, 19, d) * (1 - sstep(38, 70, d)) * sstep(0, 30, r)
    const height = 10 + 10 * (this.detail(z * 0.01, x > this.roadCenterX(z) ? 3.3 : 7.7) * 0.5 + 0.5)
    return h + wall * height * m
  }

  /**
   * Main-road VALLEY: relief is scaled toward the road level inside the corridor (12 % next to the road, full
   * relief VALLEY m out) AND the banks are slope-limited relative to the road bed (soft cap of 1 m + 0.35 m
   * per metre from the shoulder ≈ 19°, identity once the cap exceeds twice the relief) — so the road runs on
   * a valley floor even where a massif stands beside it, instead of in a trench with vertical walls.
   */
  private valleyShape(x: number, z: number, natural: number): number {
    const d = Math.max(0, this.roadDistance(x, z) - WorldFields.ROAD_HALF_WIDTH)
    const rh = this.roadHeight(z)
    const relief0 = natural - rh
    // Gentle for the first 10 m past the edge (a verge, never a wall at the shoulder), then up to ~39°: banks,
    // cliffs and plateau edges rise close beside the road (Genshin roads run between them).
    const limit = 1 + Math.min(d, 10) * 0.3 + Math.max(0, d - 10) * 0.8
    const a = Math.abs(relief0) / limit
    if (a <= 0.5 && d >= WorldFields.VALLEY + WorldFields.ROAD_SHOULDER) return natural // gentle ground far out: untouched
    const span = WorldFields.VALLEY + WorldFields.ROAD_SHOULDER
    const t = Math.min(1, d / span)
    const keep = 0.25 + 0.75 * t * t * (3 - 2 * t) // a narrower valley floor; the land's relief returns closer to the road
    const relief = relief0 * keep
    const ar = Math.abs(relief) / limit
    // Soft cap: identity below half the limit, then eases toward the limit (C1 continuous at the join).
    const f = ar <= 0.5 ? ar : 0.5 + 0.5 * (1 - Math.exp(-(ar - 0.5) * 2))
    return rh + Math.sign(relief) * limit * f
  }

  /** Flatten weight of a place at (x, z): 1 inside 60 % of its radius, smoothly 0 at the radius. */
  private poiWeight(x: number, z: number): number {
    const p = this.pois.near(x, z)
    if (!p) return 0
    const d = Math.hypot(x - p.x, z - p.z) / p.radius
    const k = d < 0.6 ? 1 : 1 - (d - 0.6) / 0.4
    return k * k * (3 - 2 * k)
  }

  /** Flatten the ground of a place to its base height (full inside 60 % of the radius, blending out to it). */
  private poiShape(x: number, z: number, h: number): number {
    const s = this.poiWeight(x, z)
    return s > 0 ? h + (this.pois.near(x, z)!.baseH - h) * s : h
  }

  /** Nearest secondary road (dist from centreline, graded height, type, half-width) or null. */
  netRoad(x: number, z: number, maxDist = 30): RoadHit | null {
    return this.network.nearest(x, z, maxDist, this.hit)
  }

  /**
   * Secondary roads: terrain meets the graded road surface across an EMBANKMENT whose width grows with the
   * cut/fill height (NET_SHOULDER + 1.3 × |Δh|) — a road across a hillside sits on a sloped bank, never on a wall.
   */
  private netShape(x: number, z: number, h: number, scale = 1): number {
    return scale > 0 ? this.network.blendHeight(x, z, h, 40, WorldFields.embankment, scale) : h
  }

  /** Embankment weight 0..1 for a point `d` m outside a road's edge whose surface is `diff` m above the ground. */
  private static embankment(d: number, diff: number): number {
    if (d <= 0) return 1
    const w = Math.min(38, WorldFields.NET_SHOULDER + Math.abs(diff) * WorldFields.NET_EMBANKMENT)
    if (d >= w) return 0
    const t = d / w
    return 1 - t * t * (3 - 2 * t)
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
    if (d >= W + B + 400) return h
    const bed = WorldFields.WATER - 2.2 - (1 - Math.min(1, d / W)) * 1.5
    if (d <= W) return Math.min(h, bed)
    // Banks widen with the depth of the cut (≤ ~40°): a river through high ground is a valley, not a slot
    // canyon — but never wide enough to reach the main road's shoulder (the road would sit on a wall above it).
    const toRoad = Math.abs(this.riverCenterX(z) - this.roadCenterX(z)) - WorldFields.ROAD_HALF_WIDTH - WorldFields.ROAD_SHOULDER - W - 4
    const bank = Math.min(Math.max(12, toRoad), B + Math.max(0, h - bed) * 1.2)
    if (d >= W + bank) return h
    const t = (d - W) / bank
    const k = t * t * (3 - 2 * t)
    return Math.min(h, bed + (h - bed) * k)
  }

  /** The main road bed itself (last stage: the surface is exactly `roadHeight` across the drivable width). */
  private roadBed(x: number, z: number, h: number): number {
    const k = this.roadInfluence(x, z)
    return k === 0 ? h : h + (this.roadHeight(z) - h) * k
  }

  /** Biome weights [desert, snow] at (x, z); pass the terrain height to include the snow line. */
  biome(x: number, z: number, out: BiomeWeights, h?: number): BiomeWeights {
    return this.biomes.weights(x, z, out, h)
  }

  /** Region weights (one per region, sum 1; world/Biomes.ts). */
  region(x: number, z: number, out: RegionWeights, h?: number): RegionWeights {
    return this.biomes.weightsN(x, z, out, h)
  }

  /**
   * Forest density 0..1: dense belts with clearings. Deserts are nearly bare, snowfields sparse, and nothing
   * grows above the treeline (~95–125 m) — pass the terrain height when known.
   */
  forestDensity(x: number, z: number, h?: number): number {
    // GROVES, not a forest wall: only the top third of the noise grows trees (dense at the heart, thinning at the
    // edge), leaving open meadows between them — Genshin's lands are mostly open grass and flowers.
    const n = fbm(this.forestN, x * 0.006, z * 0.006, 3) * 0.5 + 0.5
    let d = Math.min(1, Math.max(0, (n - 0.5) * 3.2))
    const wn = this.biomes.weightsN(x, z, this.wn, h)
    d *= 1 - wn[Biome.Desert] * 0.94 - wn[Biome.Snow] * 0.7
    // Region character: autumn valleys open up, the mystic woods close in (BiomeDefs.treeDensity).
    d = Math.min(1, d * (1 + wn[Biome.Autumn] * (BIOMES[Biome.Autumn].treeDensity - 1) + wn[Biome.Mystic] * (BIOMES[Biome.Mystic].treeDensity - 1)))
    if (h !== undefined && h > 95) d *= 1 - Math.min(1, (h - 95) / 30)
    return d
  }

  /** Low-frequency albedo variation 0..1. */
  colorVariation(x: number, z: number): number {
    return this.colorN(x * 0.02, z * 0.02) * 0.5 + 0.5
  }
}
