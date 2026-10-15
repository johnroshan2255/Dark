import { hash4 } from '../noise/rng'
import { RoadType, type NetRoad, type RoadRef } from './RoadNetwork'
import type { WorldFields } from '../WorldFields'
import type { BiomeWeights } from '../Biomes'
import { WATER_LEVEL } from '../types'

/**
 * ROAD DETAIL — gutters beside every road and the OFF-ROAD character of the dirt roads (skills/terrain "Road detail").
 *
 * A global, deterministic DEPRESSION field Δ(x, z) ≤ ~0.4 m added to the terrain G (the 2 m grid surface) next to the
 * roads: drainage DITCHES just outside the shoulder of the main road and of the network roads, and on the network
 * roads (gravel roads + trails = the "mud roads") two worn WHEEL RUTS with the grassy centre hump left standing,
 * POTHOLES (hashed per 7 m cell along the road), a low grader BERM at the edges and MUD (wetter, deeper ruts, puddles)
 * in the dips of the road's profile and in hashed wet stretches. Everything is a pure function of the seed + the
 * world position (hash RNG keyed by road / cell, no Math.random) → identical on every co-op client.
 *
 * Why not in the 2 m height grid: a 1 m ditch or a 0.5 m rut can't be represented by 2 m samples. The detail is
 * real geometry in a road-aligned RIBBON mesh instead (Terrain/roadSurface.ts): rows across the road (2 m apart on
 * the main road, 1 m on the tracks) with vertices exactly at the ditch / rut breakpoints, its height G + Δ, clipped
 * to each chunk (seamless) and drawn + collided (trimesh) at LOD0. The grid vertices it covers are SUNK
 * (`SINK` m) so the grid never pokes through a ditch; the ribbon covers every sunk triangle (margins below,
 * checked by tests/world.test.ts). LOD1/2 and the horizon keep the plain grid (the detail is < 0.4 m — invisible
 * past the LOD0 ring).
 *
 * Margins (grid cell 2 m, triangle radius ≤ 2√2): Δ ≠ 0 only within F of the centreline and ≥ 7 m inside a track run;
 * grid vertices within F + 3.5 (and ≥ 3.5 m inside the run) sink; the ribbon reaches W = F + 6.9 → every grid
 * triangle touching a sunk vertex lies under the ribbon, and every point with Δ ≠ 0 lies in a fully sunk triangle.
 *
 * Where it is skipped: the main road's ditch at junction mouths (a network road within ~5 m), beside places, on the
 * causeways over the water and under the snow banks; network tracks have no detail within reach of the main road,
 * another track, a place or the water (fords), and no ditch on deep cuts / fills (|graded − ground| > ~1 m) or in
 * the desert. Cost: see skills/terrain (worker ~1–3 ms per road chunk; +1 draw per road chunk at LOD0).
 */

/** Grid vertices under a ribbon are lowered this much (m) — more than the deepest detail (~0.45 m). */
export const SINK = 1.2

/** Main road (WorldFields.ROAD_HALF_WIDTH 2.7): a 0.6 m gravel shoulder, then a 1.1 m wide, ~0.32 m deep ditch. */
export const MAIN_DITCH_IN = 3.3
export const MAIN_DITCH_W = 1.1
export const MAIN_DITCH_D = 0.32
/** Main-road ribbon half-width (m): the ditch's outer edge (4.4) + the sink margins. */
export const MAIN_W = 11.5
/** Main ribbon rows every MAIN_STEP m of z (grid-aligned → chunk borders are rows). */
export const MAIN_STEP = 2
/** Lateral vertex offsets of a main-road row (one side; mirrored): road, shoulder, ditch (t = 0, .2, .5, .8, 1), verge. */
export const MAIN_U = [0, 0.45, 0.85, 1.05, 1.2, 1.35, 1.5, 1.65, 1.9, 2.3, 2.7, 2.95, 3.3, 3.52, 3.85, 4.18, 4.4, 5.5, 6.9, 8.4, 10, MAIN_W]
/**
 * BRIGHT (over the hill) main-road TRACK: the dirt road is carved, not painted — two wheel RUTS (centre ±1.35 m,
 * ~0.75 m wide, 0.1–0.2 m deep), the crown between them left standing, soft BERMS of pushed-up dirt at the edges
 * (≤ 0.22 m), and CLODS: the whole surface rises and falls ±4 cm in ~2–4 m lumps. MAIN_U has a vertex at every
 * breakpoint. Max depth 0.24 m (< SINK).
 */
const MAIN_RUT_C = 1.35, MAIN_RUT_HW = 0.42
/** A main-road grid vertex sinks when it lies within this of the centre for every z within ±2 m. */
const MAIN_SINK = MAIN_W - 2.4

/** Network road profile per RoadType. */
export interface TrackProfile {
  hw: number
  /** Rut centre offset from the centreline and rut half-width (m), base rut depth (m). */
  rutC: number
  rutHW: number
  rutD: number
  /** Berm (grader windrow) height at the edge (m). */
  berm: number
  ditchIn: number
  ditchW: number
  ditchD: number
  /** Outer edge of any detail (= ditchIn + ditchW), ribbon half-width, sink radius. */
  F: number
  W: number
  R: number
  /** Lateral vertex offsets of a row (one side; mirrored). */
  u: number[]
  /** |u| range of the rut vertices — they follow the ruts' wander (`wander`). */
  rutLo: number
  rutHi: number
}

/** The wheel tracks WANDER sideways along a track (±0.1 m over ~15 m): ruts, the hump and the paint all follow it. */
export const WANDER = 0.1

function profile(hw: number, rutC: number, rutHW: number, rutD: number, berm: number, ditchIn: number, ditchW: number, ditchD: number): TrackProfile {
  const F = ditchIn + ditchW
  const W = F + 6.9
  const r = rutHW
  const bc = hw - 0.25
  const u = [0, rutC - r - 0.2, rutC - r, rutC - r * 0.7, rutC - r * 0.35, rutC, rutC + r * 0.35, rutC + r * 0.7, rutC + r, (rutC + r + bc) / 2, bc, hw, ditchIn, ditchIn + ditchW * 0.2, ditchIn + ditchW * 0.5, ditchIn + ditchW * 0.8, F]
  for (let x = F + 1.1; x < W - 0.7; x += 1.25) u.push(Math.round(x * 100) / 100)
  u.push(W)
  return { hw, rutC, rutHW, rutD, berm, ditchIn, ditchW, ditchD, F, W, R: F + 3.47, u: u.filter((v, i) => i === 0 || v > u[i - 1] + 0.05), rutLo: rutC - r - 0.2, rutHi: rutC + r }
}

/** Gravel road (half-width 2.3) and trail (1.35): RoadNetwork's two types. */
export const TRACKS: Record<number, TrackProfile> = {
  [RoadType.Gravel]: profile(2.3, 0.8, 0.33, 0.05, 0.035, 2.65, 0.9, 0.24),
  [RoadType.Trail]: profile(1.35, 0.74, 0.3, 0.07, 0.022, 1.55, 0.6, 0.14),
}
/** BRIGHT (over the hill) mud tracks: deep ruts, tall soft berms, clods (same vertex layout as TRACKS). */
export const TRACKS_OTH: Record<number, TrackProfile> = {
  [RoadType.Gravel]: profile(2.3, 0.8, 0.33, 0.13, 0.16, 2.65, 0.9, 0.24),
  [RoadType.Trail]: profile(1.35, 0.74, 0.3, 0.16, 0.13, 1.55, 0.6, 0.14),
}
const TRACK_W_MAX = Math.max(TRACKS[RoadType.Gravel].W, TRACKS[RoadType.Trail].W)
const TRACK_R_MAX = Math.max(TRACKS[RoadType.Gravel].R, TRACKS[RoadType.Trail].R)
/** Track ribbon rows every TRACK_STEP m of arclength. */
export const TRACK_STEP = 1
/** Along-road margins (m) inside a run: grid vertices sink from RUN_SINK, detail starts at RUN_FEAT (+ 4 m fade). */
const RUN_SINK = 3.5
const RUN_FEAT = 7
/** Shortest run worth a ribbon (m). */
const RUN_MIN = 30

/** Per-road detail, sampled per row (1 m): feature fade, ditch gate, mud, rut depth; runs = [sa, sb] pairs (m). */
export interface Track {
  road: NetRoad
  prof: TrackProfile
  L: number
  rows: number
  runs: number[]
  feat: Float32Array
  ditch: Float32Array
  mud: Float32Array
  rut: Float32Array
  /** Hash of the road's key (potholes / noise per road). */
  id: number
}

/** What a point query returns besides Δ (the vehicle surface sampler, grass, the ribbon's shading attribute). */
export interface DetailInfo {
  /** Δ (m, < 0 = below the grid surface). */
  delta: number
  /** 0 none, 1 main road, 2 network track. */
  kind: number
  /** Signed lateral offset from the road centre (m) and the road's half-width. */
  u: number
  hw: number
  /** RoadType of a track (−1 main). */
  type: number
  /** 0..1: in a wheel rut, in a pothole, in a ditch's bottom; the stretch's mud; the feature fade. */
  rut: number
  pothole: number
  ditch: number
  mud: number
  feat: number
  /** Damp / standing-water weight for the shader (ChunkData rd attribute `mud`). */
  wet: number
  /** Unit road direction (x, z) — washboard runs across it. */
  dx: number
  dz: number
}

export function detailInfo(): DetailInfo {
  return { delta: 0, kind: 0, u: 0, hw: 0, type: -1, rut: 0, pothole: 0, ditch: 0, mud: 0, feat: 0, wet: 0, dx: 0, dz: 1 }
}

const sstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
/** 1-D value noise in [0, 1) from integer hashes (deterministic everywhere). */
const vnoise1 = (seed: number, id: number, x: number): number => {
  const i = Math.floor(x), f = x - i, s = f * f * (3 - 2 * f)
  const a = hash4(seed, id, i, 71) / 4294967296, b = hash4(seed, id, i + 1, 71) / 4294967296
  return a + (b - a) * s
}
const keyHash = (k: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 0x01000193)
  return h >>> 0
}

export class RoadDetail {
  private readonly tracks = new Map<string, Track>()
  private readonly ref: RoadRef = { road: null, dist: 0, s: 0, side: 0, height: 0 }
  private readonly ref2: RoadRef = { road: null, dist: 0, s: 0, side: 0, height: 0 }
  private readonly bw: BiomeWeights = [0, 0]
  private readonly pt = [0, 0, 0]
  private readonly tan = [0, 0]

  constructor(private readonly f: WorldFields) {}

  /** Point on a road at arclength s → pt = [x, z, graded height]; returns the segment index. */
  private at(r: NetRoad, s: number, out: number[]): number {
    let i = 0
    while (i < r.n - 2 && r.cum[i + 1] < s) i++
    const l = r.cum[i + 1] - r.cum[i]
    const t = l > 0 ? Math.min(1, Math.max(0, (s - r.cum[i]) / l)) : 0
    out[0] = r.xs[i] + (r.xs[i + 1] - r.xs[i]) * t
    out[1] = r.zs[i] + (r.zs[i + 1] - r.zs[i]) * t
    out[2] = r.hs[i] + (r.hs[i + 1] - r.hs[i]) * t
    return i
  }

  /** Smoothed unit tangent at s (chord over ±7 m: the 14 m polyline's kinks spread over a row fan, never folding). */
  tangent(r: NetRoad, L: number, s: number, out: number[]): void {
    const p = this.pt
    this.at(r, Math.min(L, s + 7), p)
    const x1 = p[0], z1 = p[1]
    this.at(r, Math.max(0, s - 7), p)
    const dx = x1 - p[0], dz = z1 - p[1], l = Math.hypot(dx, dz) || 1
    out[0] = dx / l
    out[1] = dz / l
  }

  /** Row centre (x, z, graded height) at arclength s. */
  point(r: NetRoad, s: number, out: number[]): void {
    this.at(r, s, out)
  }

  /** The detail of one network road (cached; built on first use — ~1–2 ms for a long road). */
  track(r: NetRoad): Track {
    let t = this.tracks.get(r.key)
    if (t && t.road === r) return t
    const f = this.f
    const prof = (f.palette === 0 ? TRACKS_OTH : TRACKS)[r.type]
    const L = r.cum[r.n - 1]
    const rows = Math.floor(L / TRACK_STEP) + 1
    const id = keyHash(r.key)
    const seed = f.seed
    const p = [0, 0, 0]
    // ALLOWED rows (checked every 2 m, a row needs both neighbouring checks): no other road's ribbon in reach,
    // not in a place, not at a ford.
    const nChk = Math.floor(L / 2) + 1
    const chk = new Uint8Array(nChk)
    for (let c = 0; c < nChk; c++) {
      this.at(r, c * 2, p)
      let ok = Math.abs(p[0] - f.roadCenterX(p[1])) >= MAIN_W + prof.W + 3
      ok &&= p[2] >= WATER_LEVEL + 2.4
      ok &&= !f.pois.near(p[0], p[1], prof.W + 6)
      ok &&= !f.network.nearestRoad(p[0], p[1], prof.W + TRACK_W_MAX + 3, this.ref2, r)
      chk[c] = ok ? 1 : 0
    }
    const allowed = (k: number): boolean => {
      const s = k * TRACK_STEP, c0 = Math.floor(s / 2), c1 = Math.min(nChk - 1, Math.ceil(s / 2))
      return chk[c0] === 1 && chk[c1] === 1
    }
    const runs: number[] = []
    for (let k = 0; k < rows; ) {
      if (!allowed(k)) { k++; continue }
      let e = k
      while (e + 1 < rows && allowed(e + 1)) e++
      if ((e - k) * TRACK_STEP >= RUN_MIN) runs.push(k * TRACK_STEP, e * TRACK_STEP)
      k = e + 1
    }
    const feat = new Float32Array(rows), ditch = new Float32Array(rows), mud = new Float32Array(rows), rut = new Float32Array(rows)
    if (runs.length) {
      // The road's graded profile per row (for the dips that collect mud) and cut / fill per row.
      const hs = new Float32Array(rows), fill = new Float32Array(rows)
      for (let k = 0; k < rows; k++) {
        const i = this.at(r, k * TRACK_STEP, p)
        hs[k] = p[2]
        const l = r.cum[i + 1] - r.cum[i]
        const tt = l > 0 ? Math.min(1, Math.max(0, (k * TRACK_STEP - r.cum[i]) / l)) : 0
        fill[k] = p[2] - (r.gs[i] + (r.gs[i + 1] - r.gs[i]) * tt)
      }
      for (let q = 0; q < runs.length; q += 2) {
        const sa = runs[q], sb = runs[q + 1]
        for (let k = Math.round(sa / TRACK_STEP); k <= Math.round(sb / TRACK_STEP); k++) {
          const s = k * TRACK_STEP
          const fe = sstep(sa + RUN_FEAT, sa + RUN_FEAT + 4, s) * sstep(sb - RUN_FEAT, sb - RUN_FEAT - 4, s)
          if (fe <= 0) continue
          feat[k] = fe
          this.at(r, s, p)
          const w = f.biome(p[0], p[1], this.bw, p[2])
          const desert = w[0], snow = w[1]
          // Dips in the road's profile (the mean of ±24 m above this row) collect water → mud; plus hashed wet stretches.
          let sum = 0, n = 0
          for (let j = Math.max(0, k - 24); j <= Math.min(rows - 1, k + 24); j += 4) (sum += hs[j]), n++
          const low = sstep(0.8, 2.2, sum / n - hs[k])
          const patch = sstep(0.76, 0.9, vnoise1(seed, id, s / 16))
          mud[k] = (1 - desert) * (1 - 0.6 * snow) * Math.min(1, low + patch + (r.type === RoadType.Trail ? 0.05 : 0))
          ditch[k] = (1 - sstep(0.5, 1.15, Math.abs(fill[k]))) * (1 - desert) * (1 - 0.65 * snow)
          rut[k] = prof.rutD * (0.65 + 0.7 * vnoise1(seed, id + 1, s / 7)) * (1 - 0.5 * desert) + 0.07 * mud[k]
        }
      }
    }
    t = { road: r, prof, L, rows, runs, feat, ditch, mud, rut, id }
    if (this.tracks.size > 600) this.tracks.clear()
    this.tracks.set(r.key, t)
    return t
  }

  /** Linear interpolation of a per-row array at arclength s. */
  private row(a: Float32Array, s: number): number {
    const x = Math.min(a.length - 1, Math.max(0, s / TRACK_STEP))
    const i = Math.min(a.length - 2, Math.floor(x))
    if (i < 0) return a[0]
    const t = x - i
    return a[i] + (a[i + 1] - a[i]) * t
  }

  /**
   * Detail of a network track at arclength s, signed lateral u → Δ + info (out). Shared by the ribbon vertices
   * (exact u, s of the row) and point queries (u, s of the nearest point on the polyline).
   */
  trackDetail(t: Track, s: number, u: number, out: DetailInfo): number {
    const pr = t.prof
    out.kind = 2
    out.u = u
    out.hw = pr.hw
    out.type = t.road.type
    out.rut = out.pothole = out.ditch = out.wet = out.delta = 0
    const fe = this.row(t.feat, s)
    out.feat = fe
    out.mud = 0
    if (fe <= 0) return 0
    const mud = this.row(t.mud, s)
    out.mud = mud
    const au = Math.abs(u)
    if (au >= pr.F) return 0
    // Ruts: a rounded U ~0.6 m wide (flat over the middle third, sloping walls), both wandering sideways by w.
    const w = this.wander(t, s)
    const q = Math.min(Math.abs(u - w - pr.rutC), Math.abs(u - w + pr.rutC)) / pr.rutHW
    const rutW = q < 1 ? 1 - sstep(0.35, 1, q) : 0
    const rutD = this.row(t.rut, s) * rutW
    // Potholes: one chance per 7 m cell, in a rut or the centre, 1.1–2.3 m long, 0.6–1 m wide, 0.07–0.23 m deep.
    let ph = 0, phD = 0
    const seed = this.f.seed
    const c0 = Math.floor(s / 7)
    for (let c = c0 - 1; c <= c0 + 1; c++) {
      const h0 = hash4(seed, t.id, c, 91)
      if (h0 / 4294967296 >= 0.18 + 0.4 * mud) continue
      const sc = (c + 0.15 + 0.7 * (hash4(seed, t.id, c, 92) / 4294967296)) * 7
      const lane = hash4(seed, t.id, c, 93) % 3
      const uc = (lane === 0 ? -pr.rutC : lane === 1 ? pr.rutC : 0) + w
      const a = 0.55 + 0.6 * (hash4(seed, t.id, c, 94) / 4294967296)
      const b = 0.3 + 0.2 * (hash4(seed, t.id, c, 95) / 4294967296)
      const e = ((s - sc) / a) ** 2 + ((u - uc) / b) ** 2
      if (e >= 1) continue
      const pw = (1 - e) * (1 - e)
      const d = (0.07 + 0.11 * (hash4(seed, t.id, c, 96) / 4294967296) + 0.05 * mud) * pw
      if (d > phD) (phD = d), (ph = pw)
    }
    // Ditch (rounded V) just outside the edge.
    let dd = 0, dw = 0
    const td = (au - pr.ditchIn) / pr.ditchW
    if (td > 0 && td < 1) {
      dw = (1 - (2 * td - 1) ** 2) * this.row(t.ditch, s)
      dd = pr.ditchD * dw * (0.85 + 0.3 * vnoise1(seed, t.id + 2, s / 11))
    }
    // Grader berm (the windrow of loose material) at the edges.
    const qb = Math.abs(au - (pr.hw - 0.25)) / 0.4
    const berm = qb < 1 ? pr.berm * (1 - qb * qb) * (1 - qb * qb) : 0
    // Bright: CLODS — the whole track surface rises and falls ±5 cm in ~1.5–3 m lumps (their rough dirt).
    const clod = this.f.palette === 0 && au < pr.hw + 0.3 ? (vnoise1(seed, t.id + 4, s / 1.7 + u * 1.3) - 0.5) * 0.1 : 0
    // A pothole digs into whatever it is in (a rut, the hump); the ditch is separate (outside the edge).
    const delta = fe * (berm * (1 - rutW) + clod - Math.max(rutD + phD, dd))
    out.rut = rutW * fe
    out.pothole = ph * fe
    out.ditch = dw * fe
    // Damp weight (shader `mud`; standing water above ~0.6, +0.3 in the rain): dry ruts stay packed earth, muddy ones
    // turn dark and fill only in the rain; potholes hold water in muddy stretches; gutters fill when it rains.
    out.wet = fe * Math.min(1, Math.max(rutW * (0.08 + 0.4 * mud), ph * (0.42 + 0.45 * mud), dw * 0.52))
    out.delta = delta
    return delta
  }

  /** Sideways wander of the wheel tracks at arclength s (m, ±WANDER). */
  wander(t: Track, s: number): number {
    return WANDER * (2 * vnoise1(this.f.seed, t.id + 3, s / 15) - 1)
  }

  /** Main-road ditch gate at (x, z): junction mouths, places, causeways, snow banks, the desert. */
  private mainGate(x: number, z: number): number {
    const f = this.f
    let g = sstep(WATER_LEVEL + 1.9, WATER_LEVEL + 2.6, f.roadHeight(z))
    if (g <= 0) return 0
    const n = f.network.nearestRoad(x, z, 9, this.ref2)
    if (n) g *= sstep(1.5, 5, n.dist - n.road!.halfWidth)
    if (g <= 0) return 0
    const p = f.pois.near(x, z, 10)
    if (p) g *= sstep(2, 10, Math.hypot(x - p.x, z - p.z) - p.radius)
    if (g <= 0) return 0
    const w = f.biome(x, z, this.bw)
    // (Bright: gutters in the desert too — their canyon tracks are lined by them.)
    return g * (1 - sstep(0.05, 0.45, w[1])) * (1 - (f.palette === 0 ? 0 : 0.75) * w[0])
  }

  /** Main-road detail (the ditches) at lateral u (= x − roadCenterX(z)). */
  mainDetail(x: number, z: number, u: number, out: DetailInfo): number {
    out.kind = 1
    out.u = u
    out.hw = 2.7
    out.type = -1
    out.rut = out.pothole = out.ditch = out.mud = out.wet = out.delta = 0
    out.feat = 1
    if (this.f.palette === 0 && Math.abs(u) < MAIN_DITCH_IN) return this.mainTrack(x, z, u, out)
    const t = (Math.abs(u) - MAIN_DITCH_IN) / MAIN_DITCH_W
    if (t <= 0 || t >= 1) return 0
    const g = this.mainGate(x, z)
    if (g <= 0) return 0
    const prof = 1 - (2 * t - 1) ** 2
    out.ditch = prof * g
    out.wet = 0.55 * prof * g
    out.delta = -MAIN_DITCH_D * (0.85 + 0.3 * vnoise1(this.f.seed, 7, z / 23)) * prof * g
    return out.delta
  }

  /** Bright main road: ruts, crown, berms and clods (see MAIN_U). Off over causeways / in the snow banks. */
  private mainTrack(x: number, z: number, u: number, out: DetailInfo): number {
    const f = this.f
    const g = sstep(WATER_LEVEL + 1.9, WATER_LEVEL + 2.6, f.roadHeight(z)) * (1 - sstep(0.3, 0.7, f.biome(x, z, this.bw)[1]))
    if (g <= 0) return 0
    const seed = f.seed
    const au = Math.abs(u)
    const q = Math.abs(au - MAIN_RUT_C) / MAIN_RUT_HW
    const rutW = q < 1 ? 1 - sstep(0.55, 1, q) : 0 // flat-bottomed, steep-walled (hard, like the mud tracks)
    const rutD = (0.15 + 0.09 * vnoise1(seed, 31, z / 9)) * rutW
    const bq = Math.abs(au - 2.85) / 0.5
    const berm = bq < 1 ? (0.12 + 0.1 * vnoise1(seed, u > 0 ? 33 : 34, z / 3.1)) * (1 - bq * bq) * (1 - bq * bq) : 0
    const clod = (vnoise1(seed, 35, z / 2.1 + u * 1.1) - 0.5) * 0.12 * (1 - sstep(2.9, 3.3, au))
    const mud = 0.3 * sstep(0.7, 0.9, vnoise1(seed, 36, z / 18)) // damp stretches: darker ruts
    out.rut = rutW * g
    out.mud = mud * g
    out.wet = rutW * (0.1 + 0.4 * mud) * g
    out.delta = g * (berm + clod - rutD)
    return out.delta
  }

  /**
   * Δ at any world point (+ info in `out`): the main road's ditch where within its ribbon, else the nearest network
   * track's detail. ≈ the ribbon mesh (which samples this same function at its vertices).
   */
  query(x: number, z: number, out: DetailInfo): number {
    const f = this.f
    const u = x - f.roadCenterX(z)
    out.dx = 0
    out.dz = 1
    if (Math.abs(u) < MAIN_W) return this.mainDetail(x, z, u, out)
    const ref = f.network.nearestRoad(x, z, TRACK_W_MAX, this.ref)
    if (!ref) {
      out.kind = 0
      out.delta = out.rut = out.pothole = out.ditch = out.mud = out.wet = out.feat = 0
      out.u = 0
      out.type = -1
      return 0
    }
    const r = ref.road!
    const t = this.track(r)
    const s = ref.s
    const d = this.trackDetail(t, s, ref.side, out)
    this.tangent(r, t.L, s, this.tan)
    out.dx = this.tan[0]
    out.dz = this.tan[1]
    return d
  }

  /**
   * Is the grid vertex at world (x, z) SUNK under a ribbon? Main road: within MAIN_SINK of the centre for every z
   * within ±2 m. Track: within its sink radius and ≥ RUN_SINK m inside a run.
   */
  sunk(x: number, z: number): boolean {
    const f = this.f
    let main = true
    for (let dz = -2; dz <= 2 && main; dz++) if (Math.abs(x - f.roadCenterX(z + dz)) > MAIN_SINK) main = false
    if (main) return true
    const ref = f.network.nearestRoad(x, z, TRACK_R_MAX, this.ref)
    if (!ref) return false
    const t = this.track(ref.road!)
    if (ref.dist > t.prof.R) return false
    return this.inRun(t, ref.s, RUN_SINK)
  }

  /** Is arclength s at least `margin` m inside one of the track's runs? */
  inRun(t: Track, s: number, margin: number): boolean {
    for (let q = 0; q < t.runs.length; q += 2) if (s >= t.runs[q] + margin && s <= t.runs[q + 1] - margin) return true
    return false
  }
}
