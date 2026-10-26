import * as THREE from 'three'

/**
 * The PAINT texture: one tileable 256² RGBA8 noise generated at boot (no download), sampled in world space at a few
 * scales by the ground, grass and later the rocks / trees — the brush-like breakup of the painterly style:
 *   R  soft blotches (fbm, 5 octaves)          G  a second, independent fbm
 *   B  brush strokes (fbm stretched 1 : 6)       A  cells (Worley F1: rock facets, pebbles)
 * Linear filtering + mipmaps + repeat, so far samples average out to grey (no shimmer).
 */
const N = 256

function hash(ix: number, iy: number, s: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(s, 144665)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Periodic gradient noise (period px × py cells), ~[-1, 1]. */
function gnoise(x: number, y: number, px: number, py: number, s: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy
  const g = (dx: number, dy: number) => {
    const a = hash(((ix + dx) % px + px) % px, ((iy + dy) % py + py) % py, s) * Math.PI * 2
    return Math.cos(a) * (fx - dx) + Math.sin(a) * (fy - dy)
  }
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
  const a = g(0, 0) + (g(1, 0) - g(0, 0)) * ux
  const b = g(0, 1) + (g(1, 1) - g(0, 1)) * ux
  return (a + (b - a) * uy) * 1.4
}

function fbm(u: number, v: number, p0: number, oct: number, s: number, sx = 1, sy = 1): number {
  let t = 0, amp = 1, norm = 0, p = p0
  for (let o = 0; o < oct; o++) {
    t += amp * gnoise(u * p * sx, v * p * sy, p * sx, p * sy, s + o * 31)
    norm += amp
    amp *= 0.5
    p *= 2
  }
  return t / norm
}

function worley(u: number, v: number, cells: number, s: number): number {
  const x = u * cells, y = v * cells, ix = Math.floor(x), iy = Math.floor(y)
  let d = 9
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = ix + i, cy = iy + j, wx = ((cx % cells) + cells) % cells, wy = ((cy % cells) + cells) % cells
    const px = cx + hash(wx, wy, s), py = cy + hash(wx, wy, s + 7)
    d = Math.min(d, Math.hypot(px - x, py - y))
  }
  return Math.min(1, d)
}

export function createPaintTexture(): THREE.DataTexture {
  const data = new Uint8Array(N * N * 4)
  const to8 = (v: number) => Math.max(0, Math.min(255, Math.round((v * 0.5 + 0.5) * 255)))
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N, k = (y * N + x) * 4
      data[k] = to8(fbm(u, v, 4, 5, 1) * 1.6)
      data[k + 1] = to8(fbm(u, v, 4, 5, 2) * 1.6)
      data[k + 2] = to8(fbm(u, v, 2, 4, 3, 1, 6) * 1.7)
      data[k + 3] = Math.round(worley(u, v, 16, 4) * 255)
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  t.generateMipmaps = true
  t.anisotropy = 4
  t.needsUpdate = true
  return t
}
