import { WorldFields } from '../WorldFields'

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
// Genshin meadow palette: vivid fresh green → lime → yellow-green, rare straw patches; green forest floor.
const FRESH = hex(0x5c9a36)
const OLIVE = hex(0x78ac3c)
const GOLDEN = hex(0x9cb448)
const OCHRE = hex(0xb4a856)
const EARTH = hex(0x7c6444)
const MOSS = hex(0x3f6a30)
const LITTER = hex(0x4a5c2e)
const ALPINE = hex(0x7a8c62)
const ROCK = hex(0x7e8190)
const SAND = hex(0xc4b080)
const SILT = hex(0x4a5a50)

type RGB = [number, number, number]
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
  const m = fields.colorVariation(x * 0.25, z * 0.25)
  const p = fields.colorVariation(x * 0.8 + 311, z * 0.8 - 97)
  out[0] = FRESH[0]; out[1] = FRESH[1]; out[2] = FRESH[2]
  lerp(out, OLIVE, sstep(0.25, 0.5, m))
  lerp(out, GOLDEN, sstep(0.5, 0.72, m))
  lerp(out, OCHRE, sstep(0.72, 0.9, m) * 0.8)
  lerp(out, p > 0.5 ? EARTH : MOSS, sstep(0.62, 0.85, Math.abs(p - 0.5) * 2) * 0.55)
  const fine = fields.colorVariation(x, z)
  const k = 0.9 + 0.2 * fine
  out[0] *= k; out[1] *= k; out[2] *= k
  lerp(out, fine > 0.5 ? MOSS : LITTER, fields.forestDensity(x, z) * 0.7)
  lerp(out, ALPINE, sstep(45, 110, h) * 0.6)
  // Steep but not cliff: earthy-moss; only true cliffs (> ~60°) show slate rock.
  if (slope > 0.2) lerp(out, EARTH, Math.min(1, (slope - 0.2) * 3) * 0.5)
  if (slope > 0.5) lerp(out, ROCK, Math.min(1, (slope - 0.5) * 4))
  const wl = h - WorldFields.WATER
  if (wl < 2.2) lerp(out, wl < 0 ? SILT : SAND, Math.min(1, (2.2 - wl) / 1.6))
  return out
}
