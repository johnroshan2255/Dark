import { WorldFields } from '../WorldFields'
import type { BiomeWeights } from '../Biomes'

/**
 * Ground albedo (linear RGB) shared by chunk terrain, horizon terrain and (through the vertex colour) grass —
 * the varied painterly patchwork of refer/environment/procedural-world-vista:
 *   large meadow patches: fresh green → olive → golden → dry ochre (≈ 80 m features)
 *   smaller brown-earth / dark-moss spots (≈ 25 m), forest floor under canopy, cooler grey-green higher up,
 *   slate rock on steep slopes, sand/silt at the water.
 */
const hex = (h: number): [number, number, number] => {
  const c = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return [c((h >> 16) & 255), c((h >> 8) & 255), c(h & 255)]
}
interface Palette {
  fresh: RGB; olive: RGB; golden: RGB; ochre: RGB; earth: RGB; moss: RGB; litter: RGB; alpine: RGB; rock: RGB; sand: RGB; silt: RGB
  /** How completely the forest floor colour replaces the meadow under canopy (green islands in the straw). */
  forest: number
}
type RGB = [number, number, number]
const PALETTES: Palette[] = [
  // 0 — Genshin meadow: vivid fresh green → lime → yellow-green, rare straw patches; green forest floor.
  {
    fresh: hex(0x5c9a36), olive: hex(0x78ac3c), golden: hex(0x9cb448), ochre: hex(0xb4a856), earth: hex(0x7c6444), moss: hex(0x3f6a30),
    litter: hex(0x4a5c2e), alpine: hex(0x7a8c62), rock: hex(0x7e8190), sand: hex(0xc4b080), silt: hex(0x4a5a50), forest: 0.7,
  },
  // 1 — OVERLAND (over the hill): golden straw meadows (olive → straw → pale gold), warm earth, saturated green
  //     under the forest islands, blue-grey rock. The straw is what the warm haze and low sun are painted onto.
  {
    fresh: hex(0xe8c458), olive: hex(0xeccc5e), golden: hex(0xf0d468), ochre: hex(0xf4dc82), earth: hex(0xb09460), moss: hex(0x5a9a3a),
    litter: hex(0x6a9a3c), alpine: hex(0xc4b868), rock: hex(0x5c667c), sand: hex(0xd8bc7c), silt: hex(0x585e50), forest: 0.85,
  },
]
// Desert (Genshin Sumeru sands): warm golden dunes, orange-ochre in the dips, red-orange rock on the slopes.
const DUNE_L = hex(0xf0c27a)
const DUNE_D = hex(0xd69a55)
const DUNE_RED = hex(0xc06a38)
const PLAYA = hex(0xdcc9a2)
// Snowfields (Dragonspine): bright blue-white snow, cooler shaded drifts, grey-blue rock where it's steep, ice at the water.
const SNOW = hex(0xf4f7fc)
const SNOW_SHADE = hex(0xcbd8ea)
const SNOW_ROCK = hex(0x6d7686)
const ICE = hex(0xbfe0ee)
const _bw: BiomeWeights = [0, 0]

const lerp = (o: RGB, t: readonly number[], k: number) => {
  o[0] += (t[0] - o[0]) * k
  o[1] += (t[1] - o[1]) * k
  o[2] += (t[2] - o[2]) * k
}
const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** @param slope 0 flat … 1 vertical (1 − normal.y) */
export function groundColor(fields: WorldFields, x: number, z: number, h: number, slope: number, out: RGB): RGB {
  const P = PALETTES[fields.palette] ?? PALETTES[0]
  const m = fields.colorVariation(x * 0.25, z * 0.25)
  const p = fields.colorVariation(x * 0.8 + 311, z * 0.8 - 97)
  out[0] = P.fresh[0]; out[1] = P.fresh[1]; out[2] = P.fresh[2]
  lerp(out, P.olive, sstep(0.25, 0.5, m))
  lerp(out, P.golden, sstep(0.5, 0.72, m))
  lerp(out, P.ochre, sstep(0.72, 0.9, m) * 0.8)
  lerp(out, p > 0.5 ? P.earth : P.moss, sstep(0.62, 0.85, Math.abs(p - 0.5) * 2) * 0.55)
  const fine = fields.colorVariation(x, z)
  const k = 0.9 + 0.2 * fine
  out[0] *= k; out[1] *= k; out[2] *= k
  lerp(out, fine > 0.5 ? P.moss : P.litter, fields.forestDensity(x, z, h) * P.forest)
  lerp(out, P.alpine, sstep(45, 110, h) * 0.6)
  // Steep but not cliff: earthy-moss; only true cliffs (> ~60°) show slate rock.
  if (slope > 0.2) lerp(out, P.earth, Math.min(1, (slope - 0.2) * 3) * 0.5)
  if (slope > 0.5) lerp(out, P.rock, Math.min(1, (slope - 0.5) * 4))
  const wl = h - WorldFields.WATER
  if (wl < 2.2) lerp(out, wl < 0 ? P.silt : P.sand, Math.min(1, (2.2 - wl) / 1.6))
  // Biomes last, so a region's own palette wins across its interior and blends over ~260 m at the border.
  const w = fields.biome(x, z, _bw, h)
  if (w[0] > 0.002) {
    const d: RGB = [DUNE_L[0], DUNE_L[1], DUNE_L[2]]
    lerp(d, DUNE_D, sstep(0.3, 0.75, m) * 0.8)
    lerp(d, DUNE_RED, sstep(0.55, 0.9, p) * 0.35)
    const kk = 0.92 + 0.16 * fine
    d[0] *= kk; d[1] *= kk; d[2] *= kk
    if (slope > 0.25) lerp(d, DUNE_RED, Math.min(1, (slope - 0.25) * 2.5) * 0.7)
    // Below the water line the desert is DRY: a pale cracked clay pan (playa) in basins and the river's bed.
    if (wl < 1.5) lerp(d, PLAYA, Math.min(1, (1.5 - wl) / 1.5) * 0.85)
    lerp(out, d, w[0])
  }
  if (w[1] > 0.002) {
    const sn: RGB = [SNOW[0], SNOW[1], SNOW[2]]
    lerp(sn, SNOW_SHADE, sstep(0.45, 0.8, p) * 0.5 + (1 - fine) * 0.12)
    if (slope > 0.4) lerp(sn, SNOW_ROCK, Math.min(1, (slope - 0.4) * 3))
    if (wl < 1.2) lerp(sn, ICE, Math.min(1, (1.2 - wl) / 1.2) * 0.8)
    lerp(out, sn, w[1])
  }
  return out
}
