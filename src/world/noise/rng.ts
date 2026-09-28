/**
 * Deterministic integer hashing and PRNG.
 *
 * Only integer ops (Math.imul, shifts) and one division — bit-identical on every
 * JS engine, which matters because all co-op clients regenerate the world from the seed.
 * Never use Math.random() in world generation.
 */

/** 32-bit avalanche hash of up to four integers. */
export function hash4(a: number, b: number, c = 0, d = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h ^= Math.imul(c | 0, 0xc2b2ae35)
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f)
  h ^= Math.imul(d | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  return (h ^ (h >>> 13)) >>> 0
}

/** Hash → float in [0, 1). */
export function hashFloat(a: number, b: number, c = 0, d = 0): number {
  return hash4(a, b, c, d) / 4294967296
}

/** mulberry32: small, fast, good enough for placement. */
export class Rng {
  private s: number
  constructor(seed: number) {
    this.s = seed >>> 0
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next()
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive)
  }
}

/** Generation layers — each gets an independent random stream per chunk/cell. */
export const Layer = {
  Terrain: 1,
  Road: 2,
  Trees: 3,
  Rocks: 4,
  Plants: 5,
  Caves: 6,
  POI: 7,
  Monsters: 8,
} as const

export function chunkRng(seed: number, cx: number, cz: number, layer: number): Rng {
  return new Rng(hash4(seed, cx, cz, layer))
}

/** Stable string → 32-bit seed (FNV-1a). */
export function seedFromString(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
