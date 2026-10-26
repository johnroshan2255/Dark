import * as THREE from 'three'

/**
 * The map's baked data (scripts/oth/terrain.py → public/oth/<id>/): two height grids — the 4 km playable box at 2 m
 * and the 16 km world at 16 m (the box's own heights inside it) — and the box's 4 m mask (rock, dryness, wet, forest).
 * Kept on the CPU (Float32 metres: physics, grass, spawn, camera) and uploaded once as GPU textures:
 *   heights  R16UI (the terrain's vertex shader filters them itself, 4 texelFetch — exact, no half-float steps)
 *   normals  RG8, linear + mipmaps (the ground's per-pixel normal: detail the vertex grid can't hold far away)
 *   mask     RGBA8, linear + mipmaps
 */
export interface Grid { n: number; step: number; origin: number; min: number; range: number }
export interface Pond { cx: number; cz: number; rx: number; rz: number; rot: number; level: number }
export interface Bridge { x0: number; z0: number; x1: number; z1: number; y: number; w: number }
export interface MapMeta {
  id: string
  name: string
  inner: Grid
  far: Grid
  mask: { n: number; step: number; origin: number }
  water: {
    lake: Pond
    /** The ponds and small lakes (scripts/oth/terrain.py): each a flat disc of water at its level in its bowl. */
    ponds?: Pond[]
    river: { x: number[]; z: number[]; y: number[]; hw: number[] }
  }
  spawn: { x: number; z: number; yaw: number }
  /** Plank bridges over the river: deck ends (x0, z0) → (x1, z1) on the banks, deck top y, width w (m). */
  bridges?: Bridge[]
  /** The dirt tracks: half width (m) and their centre lines ([x, z] every ~8 m). */
  trails: { hw: number; lines: [number, number][][] }
}

class HeightGrid {
  readonly h: Float32Array
  readonly n: number
  readonly step: number
  readonly origin: number
  readonly tex: THREE.DataTexture
  readonly normalTex: THREE.DataTexture

  constructor(readonly g: Grid, raw: Uint16Array) {
    this.n = g.n
    this.step = g.step
    this.origin = g.origin
    this.h = new Float32Array(raw.length)
    const k = g.range / 65535
    for (let i = 0; i < raw.length; i++) this.h[i] = raw[i] * k + g.min
    this.tex = new THREE.DataTexture(raw, g.n, g.n, THREE.RedIntegerFormat, THREE.UnsignedShortType)
    this.tex.internalFormat = 'R16UI'
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter
    this.tex.generateMipmaps = false
    this.tex.unpackAlignment = 1
    this.tex.needsUpdate = true
    // normals: central differences, x / z components in 0..255 (y rebuilt in the shader)
    const n = g.n, nb = new Uint8Array(n * n * 2), s2 = 2 * g.step
    for (let j = 0; j < n; j++) {
      const j0 = Math.max(0, j - 1) * n, j1 = Math.min(n - 1, j + 1) * n, r = j * n
      for (let i = 0; i < n; i++) {
        const dx = (this.h[r + Math.min(n - 1, i + 1)] - this.h[r + Math.max(0, i - 1)]) / s2
        const dz = (this.h[j1 + i] - this.h[j0 + i]) / s2
        const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz)
        nb[(r + i) * 2] = Math.round((-dx * inv * 0.5 + 0.5) * 255)
        nb[(r + i) * 2 + 1] = Math.round((-dz * inv * 0.5 + 0.5) * 255)
      }
    }
    this.normalTex = new THREE.DataTexture(nb, n, n, THREE.RGFormat, THREE.UnsignedByteType)
    this.normalTex.minFilter = THREE.LinearMipmapLinearFilter
    this.normalTex.magFilter = THREE.LinearFilter
    this.normalTex.generateMipmaps = true
    this.normalTex.unpackAlignment = 1
    this.normalTex.wrapS = this.normalTex.wrapT = THREE.ClampToEdgeWrapping
    this.normalTex.needsUpdate = true
  }

  /** Bilinear height (m) at world x, z (clamped to the grid). */
  sample(x: number, z: number): number {
    const n = this.n
    let fx = (x - this.origin) / this.step, fz = (z - this.origin) / this.step
    fx = fx < 0 ? 0 : fx > n - 1.0001 ? n - 1.0001 : fx
    fz = fz < 0 ? 0 : fz > n - 1.0001 ? n - 1.0001 : fz
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, k = j * n + i, h = this.h
    const a = h[k] + (h[k + 1] - h[k]) * tx
    const b = h[k + n] + (h[k + n + 1] - h[k + n]) * tx
    return a + (b - a) * tz
  }
}

export class MapData {
  readonly inner: HeightGrid
  readonly far: HeightGrid
  readonly mask: Uint8Array
  readonly maskTex: THREE.DataTexture
  /** Distance to the nearest track's centre line (R8 on the box's 2 m grid, 0..8 m) — the ground paints the dirt, the
   *  grass keeps off it. */
  readonly trailTex: THREE.DataTexture
  /** The playable box's half size (m) and the world's. */
  readonly half: number
  readonly farHalf: number

  private constructor(readonly meta: MapMeta, inner: Uint16Array, far: Uint16Array, mask: Uint8Array, trail: Uint8Array) {
    this.inner = new HeightGrid(meta.inner, inner)
    this.far = new HeightGrid(meta.far, far)
    this.half = -meta.inner.origin
    this.farHalf = -meta.far.origin
    this.mask = mask
    const mn = meta.mask.n
    this.maskTex = new THREE.DataTexture(mask, mn, mn, THREE.RGBAFormat, THREE.UnsignedByteType)
    this.maskTex.minFilter = THREE.LinearMipmapLinearFilter
    this.maskTex.magFilter = THREE.LinearFilter
    this.maskTex.generateMipmaps = true
    this.maskTex.needsUpdate = true
    const tn = meta.inner.n
    this.trailTex = new THREE.DataTexture(trail, tn, tn, THREE.RedFormat, THREE.UnsignedByteType)
    this.trailTex.minFilter = THREE.LinearMipmapLinearFilter
    this.trailTex.magFilter = THREE.LinearFilter
    this.trailTex.generateMipmaps = true
    this.trailTex.unpackAlignment = 1
    this.trailTex.needsUpdate = true
  }

  static async load(base: string, onProgress?: (f: number) => void): Promise<MapData> {
    const meta = (await (await fetch(`${base}/meta.json`)).json()) as MapMeta
    let done = 0
    const get = async (f: string) => {
      const b = await (await fetch(`${base}/${f}`)).arrayBuffer()
      onProgress?.(++done / 4)
      return b
    }
    const [h, f, m, t] = await Promise.all([get('height.bin'), get('far.bin'), get('mask.bin'), get('trail.bin')])
    return new MapData(meta, new Uint16Array(h), new Uint16Array(f), new Uint8Array(m), new Uint8Array(t))
  }

  /** Inside the playable box's 2 m grid (with a cell of margin). */
  inBox(x: number, z: number): boolean {
    const e = this.half - this.inner.step
    return x > -e && x < e && z > -e && z < e
  }

  /** Ground height (m) — the box's 2 m grid inside it, the world's 16 m grid outside (they agree at the rim). */
  height(x: number, z: number): number {
    return this.inBox(x, z) ? this.inner.sample(x, z) : this.far.sample(x, z)
  }

  /** Coarse distance fields (4 m cells over the box, Float32 m, capped): to the nearest TRACK centre line (≤ 48 m) and
   *  to the RIVER / lake shore (≤ 80 m) — the woods, bushes and boulders line the tracks and the banks with them. */
  private trackFar: Float32Array | null = null
  private riverFar: Float32Array | null = null
  private farN = 0
  private buildFar(): void {
    const half = this.half, C = 4, n = (this.farN = Math.ceil((2 * half) / C) + 1)
    const stamp = (out: Float32Array, pts: [number, number][], cap: number) => {
      out.fill(cap)
      const r = Math.ceil(cap / C)
      for (const [x, z] of pts) {
        const ci = Math.round((x + half) / C), cj = Math.round((z + half) / C)
        for (let j = Math.max(0, cj - r); j <= Math.min(n - 1, cj + r); j++) for (let i = Math.max(0, ci - r); i <= Math.min(n - 1, ci + r); i++) {
          const d = Math.hypot(i * C - half - x, j * C - half - z)
          if (d < out[j * n + i]) out[j * n + i] = d
        }
      }
    }
    // the polylines resampled every 4 m
    const dense = (xs: number[], zs: number[]) => {
      const out: [number, number][] = []
      for (let k = 0; k < xs.length - 1; k++) {
        const L = Math.hypot(xs[k + 1] - xs[k], zs[k + 1] - zs[k]), m = Math.max(1, Math.ceil(L / 4))
        for (let s = 0; s < m; s++) out.push([xs[k] + ((xs[k + 1] - xs[k]) * s) / m, zs[k] + ((zs[k + 1] - zs[k]) * s) / m])
      }
      return out
    }
    this.trackFar = new Float32Array(n * n)
    stamp(this.trackFar, this.meta.trails.lines.flatMap((l) => dense(l.map((p) => p[0]), l.map((p) => p[1]))), 48)
    this.riverFar = new Float32Array(n * n)
    const r = this.meta.water.river, L = this.meta.water.lake
    const shore: [number, number][] = dense(r.x, r.z)
    for (let a = 0; a < 200; a++) { // the lake's ellipse
      const t = (a / 200) * Math.PI * 2, c = Math.cos(L.rot), s = Math.sin(L.rot), ex = Math.cos(t) * L.rx, ez = Math.sin(t) * L.rz
      shore.push([L.cx + ex * c - ez * s, L.cz + ex * s + ez * c])
    }
    for (const P of this.meta.water.ponds ?? []) { // (and every pond's and small lake's shore)
      const c = Math.cos(P.rot), s = Math.sin(P.rot), rx = P.rx / 1.16, rz = P.rz / 1.16
      const m = Math.max(24, Math.ceil((2 * Math.PI * Math.max(rx, rz)) / 6))
      for (let a = 0; a < m; a++) {
        const t = (a / m) * Math.PI * 2, ex = Math.cos(t) * rx, ez = Math.sin(t) * rz
        shore.push([P.cx + ex * c - ez * s, P.cz + ex * s + ez * c])
      }
    }
    stamp(this.riverFar, shore, 80)
  }

  /** The bridge deck under (x, z): its top (m), or null off every bridge (the tyres, the dust). */
  bridgeAt(x: number, z: number): number | null {
    for (const b of this.meta.bridges ?? []) {
      const dx = b.x1 - b.x0, dz = b.z1 - b.z0, L2 = dx * dx + dz * dz
      const t = ((x - b.x0) * dx + (z - b.z0) * dz) / L2
      if (t < -0.02 || t > 1.02) continue
      const ox = x - b.x0 - t * dx, oz = z - b.z0 - t * dz
      if (ox * ox + oz * oz <= (b.w * 0.5 + 0.3) ** 2) return b.y
    }
    return null
  }
  /** Distance (m, ≤ 48) to the nearest track centre line. */
  trackDist(x: number, z: number): number {
    if (!this.trackFar) this.buildFar()
    const i = Math.round((x + this.half) / 4), j = Math.round((z + this.half) / 4)
    return i < 0 || j < 0 || i >= this.farN || j >= this.farN ? 48 : this.trackFar![j * this.farN + i]
  }
  /** Distance (m, ≤ 80) to the river's centre line / the lake's and the ponds' shores. */
  riverDist(x: number, z: number): number {
    if (!this.riverFar) this.buildFar()
    const i = Math.round((x + this.half) / 4), j = Math.round((z + this.half) / 4)
    return i < 0 || j < 0 || i >= this.farN || j >= this.farN ? 80 : this.riverFar![j * this.farN + i]
  }

  /** Distance (m, ≤ 8) from x, z to the nearest dirt track's centre line (8 outside the box). */
  trailDist(x: number, z: number): number {
    const g = this.inner
    const i = Math.round((x - g.origin) / g.step), j = Math.round((z - g.origin) / g.step)
    if (i < 0 || j < 0 || i >= g.n || j >= g.n) return 8
    return ((this.trailTex.image.data as Uint8Array)[j * g.n + i] / 255) * 8
  }

  /** The box's mask at x, z (0..1 each: rock, dryness, wet, forest), nearest 4 m cell; zeros outside the box. */
  maskAt(x: number, z: number, out: [number, number, number, number]): [number, number, number, number] {
    const g = this.meta.mask
    const i = Math.round((x - g.origin) / g.step), j = Math.round((z - g.origin) / g.step)
    if (i < 0 || j < 0 || i >= g.n || j >= g.n) { out[0] = out[1] = out[2] = out[3] = 0; return out }
    const k = (j * g.n + i) * 4
    out[0] = this.mask[k] / 255; out[1] = this.mask[k + 1] / 255; out[2] = this.mask[k + 2] / 255; out[3] = this.mask[k + 3] / 255
    return out
  }
}
