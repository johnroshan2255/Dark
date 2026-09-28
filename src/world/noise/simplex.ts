import { Rng } from './rng'

/**
 * Seeded 2D simplex noise (Gustavson). Arithmetic + floor only → deterministic across engines.
 * Output range ≈ [-1, 1].
 */
export type Noise2D = (x: number, y: number) => number

const F2 = 0.5 * (Math.sqrt(3) - 1)
const G2 = (3 - Math.sqrt(3)) / 6
const GRAD = new Float64Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1])

export function createNoise2D(seed: number): Noise2D {
  const rng = new Rng(seed)
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  for (let i = 255; i > 0; i--) {
    const j = rng.int(i + 1)
    const t = p[i]
    p[i] = p[j]
    p[j] = t
  }
  const perm = new Uint8Array(512)
  const permGrad = new Uint8Array(512)
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255]
    permGrad[i] = (perm[i] % 8) * 2
  }

  return (xin: number, yin: number): number => {
    const s = (xin + yin) * F2
    const i = Math.floor(xin + s)
    const j = Math.floor(yin + s)
    const t = (i + j) * G2
    const x0 = xin - (i - t)
    const y0 = yin - (j - t)
    const i1 = x0 > y0 ? 1 : 0
    const j1 = 1 - i1
    const x1 = x0 - i1 + G2
    const y1 = y0 - j1 + G2
    const x2 = x0 - 1 + 2 * G2
    const y2 = y0 - 1 + 2 * G2
    const ii = i & 255
    const jj = j & 255

    let n = 0
    let t0 = 0.5 - x0 * x0 - y0 * y0
    if (t0 > 0) {
      const g = permGrad[ii + perm[jj]]
      t0 *= t0
      n += t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0)
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1
    if (t1 > 0) {
      const g = permGrad[ii + i1 + perm[jj + j1]]
      t1 *= t1
      n += t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1)
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2
    if (t2 > 0) {
      const g = permGrad[ii + 1 + perm[jj + 1]]
      t2 *= t2
      n += t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2)
    }
    return 70 * n
  }
}

/** Fractal Brownian motion. */
export function fbm(noise: Noise2D, x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let amp = 1
  let freq = 1
  let sum = 0
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq)
    norm += amp
    amp *= gain
    freq *= lacunarity
  }
  return sum / norm
}

/** Ridged multifractal — sharp crests for hills/ravines. Range [0, 1]. */
export function ridged(noise: Noise2D, x: number, y: number, octaves: number): number {
  let amp = 0.5
  let freq = 1
  let sum = 0
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(noise(x * freq, y * freq))
    sum += amp * n * n
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  return sum / norm
}
