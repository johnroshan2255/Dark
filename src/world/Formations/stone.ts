import { hash4 } from '../noise/rng'

const h01 = (s: number, a: number, b: number, c: number) => hash4(s, a, b, c) / 4294967296
/** 0 over most of [0, 1), rising smoothly to 1 over the last `w` — a sharp step at the cell's upper edge. */
const edge = (f: number, w: number) => {
  const t = Math.min(1, Math.max(0, (f - (1 - w)) / w))
  return t * t * (3 - 2 * t)
}

/**
 * GENSHIN STONE — an SDF offset that turns a smooth rock volume into LAYERED, JOINTED stone (refer: Genshin's cliff
 * caves, Stone Gate, the Chasm's tunnels): horizontal BEDS `bed` m tall, each set in or out by up to ±amp/2, the
 * change between beds a sharp step → flat ledges with overhanging lips and dark undersides; plus vertical JOINTS on
 * a rotated ~5 × 4 m grid, each column set in / out by up to ±0.35·amp → blocky faces instead of noise dough. The
 * bedding is tilted (≤ 3.5°) and gently warped per seed. Positive = rock pulled in (add it to a rock SDF; added to
 * an AIR SDF it pushes the walls into the air). Arithmetic + sin only, ~8 hashes: deterministic in the workers.
 * Features are ≥ 2 voxels (1.25–1.5 m) so surface nets keeps them as chunky blocks.
 */
export function stoneOffset(seed: number, x: number, y: number, z: number, amp: number, bed = 2.6): number {
  const yy = bedY(seed, x, y, z)
  const t = yy / bed, L = Math.floor(t), w = edge(t - L, 0.18)
  const la = h01(seed, L, 77, 1), lb = h01(seed, L + 1, 77, 1)
  let off = (la + (lb - la) * w - 0.5) * amp
  const ang = h01(seed, 9, 9, 9) * Math.PI
  const c = Math.cos(ang), s = Math.sin(ang)
  const u = (x * c + z * s) / 5.2, v = (-x * s + z * c) / 4.1
  const iu = Math.floor(u), iv = Math.floor(v), wu = edge(u - iu, 0.2), wv = edge(v - iv, 0.2)
  const j00 = h01(seed, iu, iv, 5), j10 = h01(seed, iu + 1, iv, 5), j01 = h01(seed, iu, iv + 1, 5), j11 = h01(seed, iu + 1, iv + 1, 5)
  const j0 = j00 + (j10 - j00) * wu, j1 = j01 + (j11 - j01) * wu
  off += (j0 + (j1 - j0) * wv - 0.5) * amp * 0.7
  return off
}

/** The bedding height at (x, y, z): y tilted (≤ 3.5°) and gently warped per seed. */
function bedY(seed: number, x: number, y: number, z: number): number {
  const tx = (h01(seed, 1, 2, 3) - 0.5) * 0.12, tz = (h01(seed, 4, 5, 6) - 0.5) * 0.12
  return y + x * tx + z * tz + Math.sin(x * 0.05 + (seed & 63)) * 0.6 + Math.sin(z * 0.043 - (seed & 31)) * 0.6
}

/** The tone of the BED at (x, y, z) in [0, 1] (same seed / bed as the stoneOffset call): colour the layers by it. */
export function stoneBed(seed: number, x: number, y: number, z: number, bed = 2.6): number {
  return h01(seed, Math.floor(bedY(seed, x, y, z) / bed), 78, 2)
}

/**
 * CAVE WALL STONE (refer: the Chasm's Bed, Stony Halls) — a cave wall is built of big angular PLATES, not noise: an
 * SDF offset (positive = rock pulled in; add it to the cave's AIR SDF to push the walls into the air) made of
 *   - upright plates: a Voronoi pattern in plan (cells ≈ `cell` m, irregular polygons), each plate set in / out by
 *     up to ±amp/2 with a sharp step at its edges → vertical slabs with dark seams between them;
 *   - horizontal beds `bed` m tall (stoneOffset's ledges, ±0.25·amp) → ledges whose tops catch the light;
 *   - a LEAN per plate and bed: the offset changes linearly with height inside each block, so every block face is
 *     a flat plane tilted its own way → the faceted, chiselled look (each face its own shade) instead of a smooth tube.
 * ~14 hashes, arithmetic only: deterministic in the workers.
 */
export function plateOffset(seed: number, x: number, y: number, z: number, amp: number, cell = 3.4, bed = 2.6): number {
  const u = x / cell, v = z / cell
  const iu = Math.floor(u), iv = Math.floor(v)
  let d1 = 1e9, d2 = 1e9, a1 = 0, b1 = 0, a2 = 0, b2 = 0
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    const cu = iu + a, cv = iv + b
    const h = hash4(seed, cu, cv, 31)
    const px = cu + 0.1 + ((h & 0xffff) / 65536) * 0.8, pz = cv + 0.1 + ((h >>> 16) / 65536) * 0.8
    const dd = (u - px) * (u - px) + (v - pz) * (v - pz)
    if (dd < d1) (d2 = d1), (a2 = a1), (b2 = b1), (d1 = dd), (a1 = cu), (b1 = cv)
    else if (dd < d2) (d2 = dd), (a2 = cu), (b2 = cv)
  }
  const yy = bedY(seed, x, y, z)
  const t = yy / bed, L = Math.floor(t), f = t - L, e = edge(f, 0.16)
  // One block = (plate, bed): its set-in and its lean (offset per m of height, centred on the bed's middle); at the
  // top of a bed the face blends into the next bed's plane (continuous: no seam in the field).
  const block = (cu: number, cv: number) => {
    const o = (h01(seed, cu, cv, 32) - 0.5) * amp
    const l0 = (h01(seed, cu * 7 + L, cv, 33) - 0.5) * 0.5, l1 = (h01(seed, cu * 7 + L + 1, cv, 33) - 0.5) * 0.5
    return o + (l0 * (f - 0.5) + (l1 * (f - 1.5) - l0 * (f - 0.5)) * e) * bed
  }
  // Sharp step at the plate's edge (√d2 − √d1 ≈ distance to the border in cells): halfway between the two blocks.
  const w = Math.min(1, (Math.sqrt(d2) - Math.sqrt(d1)) / 0.14)
  const o1 = block(a1, b1)
  let off = o1 + (block(a2, b2) - o1) * 0.5 * (1 - w * w * (3 - 2 * w))
  // Ledges: the bed's own set-in, stepping sharply at the top of each bed.
  const la = h01(seed, L, 34, 1), lb = h01(seed, L + 1, 34, 1)
  off += (la + (lb - la) * e - 0.5) * amp * 0.5
  return off
}

/** The tone of the PLATE block (plateOffset's cell × bed) at (x, y, z) in [0, 1]: each block face its own shade. */
export function plateTone(seed: number, x: number, y: number, z: number, cell = 3.4, bed = 2.6): number {
  const u = x / cell, v = z / cell
  const iu = Math.floor(u), iv = Math.floor(v)
  let d1 = 1e9, a1 = 0, b1 = 0
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    const cu = iu + a, cv = iv + b
    const h = hash4(seed, cu, cv, 31)
    const px = cu + 0.1 + ((h & 0xffff) / 65536) * 0.8, pz = cv + 0.1 + ((h >>> 16) / 65536) * 0.8
    const dd = (u - px) * (u - px) + (v - pz) * (v - pz)
    if (dd < d1) (d1 = dd), (a1 = cu), (b1 = cv)
  }
  return h01(seed, a1 * 7 + Math.floor(bedY(seed, x, y, z) / bed), b1, 35)
}
