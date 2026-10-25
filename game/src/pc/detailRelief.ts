/**
 * The SURFACE RELIEF texture (the soft look's ground, cliffs and rocks — the Over the Hill reference: flat colour, the
 * detail is small CRUMPLED relief lit by the sun): a tileable height field of ridged gradient noise (creases like
 * crumpled paper / packed gravel), baked once at load into RGBA8 — R, G = −∂h/∂u, −∂h/∂v (the surface normal's
 * tangent part, 0.5 = flat), B = the height (crevices darken), A = 1. Engine-free; pc/textures.ts uploads it with
 * mipmaps (the averaged normals flatten with distance: no far shimmer, no cost to fade it).
 * Cost: 512² ≈ 1 MB (+⅓ mips) of VRAM, ~40 ms of one-off CPU at load; 2 fetches per ground pixel.
 */
export const RELIEF_SIZE = 512

export function bakeRelief(size = RELIEF_SIZE): Uint8Array {
  // periodic 2D gradient noise: lattice period p (it tiles over the texture)
  const grads = new Float32Array(256 * 2)
  let st = 0x2545f491
  const rnd = () => ((st = (Math.imul(st, 1664525) + 1013904223) >>> 0) / 4294967296)
  for (let i = 0; i < 256; i++) {
    const a = rnd() * Math.PI * 2
    grads[i * 2] = Math.cos(a)
    grads[i * 2 + 1] = Math.sin(a)
  }
  const perm = new Uint8Array(512)
  for (let i = 0; i < 256; i++) perm[i] = i
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i]
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
  const noise = (x: number, y: number, p: number, salt: number): number => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi
    const g = (ix: number, iy: number, dx: number, dy: number) => {
      const h = perm[(perm[((ix % p) + p) % p + salt] + (((iy % p) + p) % p)) & 511] * 2
      return grads[h] * dx + grads[h + 1] * dy
    }
    const u = fade(xf), v = fade(yf)
    const a = g(xi, yi, xf, yf) + (g(xi + 1, yi, xf - 1, yf) - g(xi, yi, xf, yf)) * u
    const b = g(xi, yi + 1, xf, yf - 1) + (g(xi + 1, yi + 1, xf - 1, yf - 1) - g(xi, yi + 1, xf, yf - 1)) * u
    return a + (b - a) * v // ≈ −0.7..0.7
  }
  // RIDGED fBm: creases (1 − |n|)², 5 octaves from 6 to 96 cells across the tile, a little domain warp
  const h = new Float32Array(size * size)
  let lo = Infinity, hi = -Infinity
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size
      const wx = noise(u * 4, v * 4, 4, 11) * 0.06, wy = noise(u * 4, v * 4, 4, 37) * 0.06
      let s = 0, amp = 1, cells = 6
      for (let o = 0; o < 5; o++) {
        const n = noise((u + wx) * cells, (v + wy) * cells, cells, o * 23)
        const r = 1 - Math.abs(n) * 1.4
        s += r * r * amp
        amp *= 0.5
        cells *= 2
      }
      h[y * size + x] = s
      if (s < lo) lo = s
      if (s > hi) hi = s
    }
  }
  const out = new Uint8Array(size * size * 4)
  const k = size / 24 / (hi - lo) // gradient scale: the steepest creases reach ~|0.9|
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (i: number, j: number) => h[((j + size) % size) * size + ((i + size) % size)]
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * k
      const dy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * k
      const o = (y * size + x) * 4
      out[o] = Math.max(0, Math.min(255, Math.round((-dx * 0.5 + 0.5) * 255)))
      out[o + 1] = Math.max(0, Math.min(255, Math.round((-dy * 0.5 + 0.5) * 255)))
      out[o + 2] = Math.round(((at(x, y) - lo) / (hi - lo)) * 255)
      out[o + 3] = 255
    }
  }
  return out
}
