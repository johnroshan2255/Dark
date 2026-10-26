import * as THREE from 'three'

/**
 * THE LEAF TEXTURE (generated at boot, no download): a 512² RGBA atlas of 4 LEAF CLUSTERS, 256² each — ~80 tiny
 * separate leaves per cluster (round-ish, a little pointed, ~16–22 px long), scattered over an irregular blob, denser
 * in its middle, sparse at its ragged edge, with GAPS between them (transparent: the sky shows through). Broadleaf
 * crowns are built from cards showing these clusters (treeGeometry `broadleafGeometry`) — OTH's crowns: many small
 * leaves, not big shapes (the user: "each leaf small and separated, the sky seen between them").
 *   R  the leaf's tone (each leaf its own, lit a little from its upper side)
 *   G  its depth in the cluster (lower toward the middle: ambient occlusion)
 *   A  coverage (antialiased edges; the shader's alpha test is mip-corrected, MSAA tiers use alpha-to-coverage)
 * The transparent texels keep a mid tone (no dark fringe when the mipmaps average them in).
 */
export const LEAF_TILES = 2 // per side

export function createLeafTexture(): THREE.DataTexture {
  const N = 512, T = N / LEAF_TILES
  const data = new Uint8Array(N * N * 4)
  for (let i = 0; i < N * N; i++) { data[i * 4] = 150; data[i * 4 + 1] = 200; data[i * 4 + 2] = 0; data[i * 4 + 3] = 0 }
  let s = 0x5eed1eaf
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x6d2b79f5) >>> 0) / 4294967296)
  for (let tile = 0; tile < LEAF_TILES * LEAF_TILES; tile++) {
    const ox = (tile % LEAF_TILES) * T, oy = Math.floor(tile / LEAF_TILES) * T
    const cx = T / 2, cy = T / 2, R = T * 0.44
    // an irregular outline: the radius wobbles round the cluster (3 harmonics)
    const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28]
    const edge = (a: number) => R * (0.82 + 0.1 * Math.sin(3 * a + ph[0]) + 0.06 * Math.sin(5 * a + ph[1]) + 0.04 * Math.sin(8 * a + ph[2]))
    const placed: [number, number][] = []
    for (let tries = 0; tries < 1400 && placed.length < 80; tries++) {
      const a = rnd() * Math.PI * 2, u = Math.sqrt(rnd()), r = u * edge(a)
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r
      const L = T * (0.062 + 0.026 * rnd()), W = L * (0.68 + 0.14 * rnd())
      // keep a clear GAP to the leaves already there (the user: "more gap between the leaves"), wider toward the edge
      const gap = L * (1.02 + 0.45 * u)
      if (placed.some(([px, py]) => (px - x) ** 2 + (py - y) ** 2 < gap * gap)) continue
      placed.push([x, y])
      // pointing outward from the cluster, drooping a little, jittered
      const ang = a + (rnd() - 0.5) * 1.6 + 0.35
      const ca = Math.cos(ang), sa = Math.sin(ang)
      const tone = 0.5 + 0.5 * rnd(), depth = 0.55 + 0.45 * u * (0.7 + 0.3 * rnd())
      const ext = L + 2
      for (let py = Math.max(0, Math.floor(y - ext)); py <= Math.min(T - 1, Math.ceil(y + ext)); py++) {
        for (let px = Math.max(0, Math.floor(x - ext)); px <= Math.min(T - 1, Math.ceil(x + ext)); px++) {
          const dx = px + 0.5 - x, dy = py + 0.5 - y
          const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca // along / across the leaf
          const w = (W / 2) * (1 - 0.32 * Math.max(0, lx / (L / 2))) // (narrower toward its tip)
          const d = Math.hypot(lx / (L / 2), ly / Math.max(0.5, w))
          const cov = Math.min(1, Math.max(0, (1 - d) * Math.min(L / 2, w) + 0.5))
          if (cov <= 0) continue
          const k = ((oy + py) * N + ox + px) * 4
          // lit from its upper side, a faint midrib
          const shade = tone * (0.86 + 0.2 * (-dy / L)) * (1 - 0.12 * Math.exp(-(ly * ly) / 1.2) * (lx < L * 0.35 ? 1 : 0))
          const r = Math.round(Math.min(1, Math.max(0, shade)) * 255), g = Math.round(depth * 255)
          const old = data[k + 3] / 255
          data[k] = Math.round(r * cov + data[k] * (1 - cov))
          data[k + 1] = Math.round(g * cov + data[k + 1] * (1 - cov))
          data[k + 3] = Math.round((cov + old * (1 - cov)) * 255)
        }
      }
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.anisotropy = 4
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}

/** A leaf card's texel (leafTexture.ts): tone (r), depth (g), coverage (a, mip-corrected). cardUv ∈ −1…1,
 *  lz = 1 + tile + tint × 0.9. Fragment shaders only (derivatives). */
export const LEAF_GLSL = /* glsl */ `
uniform sampler2D uLeafTex;
vec4 leafCard(vec2 cardUv, float lz) {
  float tile = floor(lz) - 1.0;
  vec2 uv = (vec2(mod(tile, 2.0), floor(tile / 2.0)) + (cardUv * 0.5 + 0.5) * 0.985 + 0.0075) * 0.5;
  vec4 t = texture(uLeafTex, uv);
  vec2 px = uv * 512.0;
  float lod = max(0.0, 0.5 * log2(max(dot(dFdx(px), dFdx(px)), dot(dFdy(px), dFdy(px)))));
  t.a = clamp(t.a * (1.0 + 0.35 * lod), 0.0, 1.0);
  return t;
}
`

/**
 * THE FROND TEXTURE (generated at boot, no download): a 1024 × 512 RGBA atlas of 4 spruce BRANCH PLATES, 512 × 256
 * each — the user's references (Over the Hill's pines): every branch one solid flat PLATE, its length along x (the
 * base at the left), across y: a narrow CORE running out to a long END SPIKE, and off both its edges long thin
 * SPIKES (each "leaf" of the plate) sweeping forward toward the end — irregular in length, angle and spacing, short by
 * the trunk, longest past the middle, a pair flanking the end spike (the jagged end) — every end ROUNDED into a soft
 * lobe. Inside a smooth, softly mottled tone: dark at the plate's start by the trunk, lighter toward the end and out
 * along the spikes. The spruce's fronds show it (treeGeometry `spruceGeometry`).
 *   R  tone (mottled)   G  depth (dark at the base … 1 at the end)   A  coverage (3 × 3 supersampled, rounded:
 *   a soft ramp round the edge, cut at 0.5)
 * The transparent texels keep a mid tone (no dark fringe when the mipmaps average them in).
 */
export function createFrondTexture(): THREE.DataTexture {
  const W = 1024, H = 512, TW = W / 2, TH = H / 2, SS = 3, SW = TW * SS, SH = TH * SS
  const data = new Uint8Array(W * H * 4)
  for (let i = 0; i < W * H; i++) { data[i * 4] = 180; data[i * 4 + 1] = 200; data[i * 4 + 2] = 0; data[i * 4 + 3] = 0 }
  let s = 0x0f2e57a1
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x6d2b79f5) >>> 0) / 4294967296)
  const smooth01 = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t) }
  const mask = new Uint8Array(SW * SH)
  const BLUR = 4 // (px, per box pass: the rounding of the spike ends)
  // value noise on the atlas's texel grid (scale: divide the coordinates), 0…1
  const hash = (i: number, j: number) => (((Math.imul(i, 374761393) + Math.imul(j, 668265263)) ^ 0x5bd1e995) >>> 0) % 1000 / 1000
  const noise = (x: number, y: number) => {
    const i = Math.floor(x), j = Math.floor(y), fx = smooth01(x - i), fy = smooth01(y - j)
    return (hash(i, j) * (1 - fx) + hash(i + 1, j) * fx) * (1 - fy) + (hash(i, j + 1) * (1 - fx) + hash(i + 1, j + 1) * fx) * fy
  }
  // plate space: u 0 (base) … 1 (end) along, v −1 … 1 across → the subsample grid
  const X = (u: number) => u * SW, Y = (v: number) => (v * 0.5 + 0.5) * SH
  /** Fill a triangle (plate space) into the mask. */
  const tri = (u0: number, v0: number, u1: number, v1: number, u2: number, v2: number) => {
    const ax = X(u0), ay = Y(v0), bx = X(u1), by = Y(v1), cx = X(u2), cy = Y(v2)
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (Math.abs(area) < 1e-6) return
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(SW - 1, Math.ceil(Math.max(ax, bx, cx)))
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(SH - 1, Math.ceil(Math.max(ay, by, cy)))
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5
      const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area
      const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area
      if (w0 >= 0 && w1 >= 0 && 1 - w0 - w1 >= 0) mask[y * SW + x] = 1
    }
  }
  for (let tile = 0; tile < 4; tile++) {
    mask.fill(0)
    const ox = (tile % 2) * TW, oy = Math.floor(tile / 2) * TH
    // the CORE: narrow by the trunk, widest a little past the middle, then the long END SPIKE to u = 1
    const core = (u: number) => (0.1 + 0.16 * smooth01(u / 0.5)) * Math.min(1, Math.pow(Math.max(0, (1 - u) / 0.32), 1.1))
    for (let i = 0; i < 40; i++) {
      const ua = i / 40, ub = (i + 1) / 40
      tri(ua, -core(ua), ub, -core(ub), ub, core(ub))
      tri(ua, -core(ua), ub, core(ub), ua, core(ua))
    }
    // the SPIKES off both edges: base on the core's edge, the point forward and out
    for (const side of [-1, 1]) {
      const n = 6 + Math.floor(rnd() * 3)
      for (let k = 0; k < n; k++) {
        const u = 0.08 + (0.72 * (k + 0.2 + 0.6 * rnd())) / n
        const env = 0.45 + 0.55 * Math.sin(Math.PI * Math.min(1, (u + 0.05) / 0.95)) // (short by the trunk and the end)
        const reach = (0.62 + 0.36 * rnd()) * env // how far out (of the half width)
        const fwd = (0.1 + 0.08 * rnd()) * (0.7 + 0.6 * env) // how far forward its point sits
        const base = 0.045 + 0.03 * rnd() // its base's half length along the core
        const c = core(u) * 0.85
        tri(u - base, side * c, u + base, side * c, Math.min(0.97, u + fwd), side * Math.min(0.98, reach))
      }
      // the end: a spike either side of the end spike (a jagged three-pointed end)
      const ue = 0.8 + 0.04 * rnd()
      tri(ue - 0.05, side * core(ue - 0.05) * 0.85, ue + 0.03, side * core(ue + 0.03) * 0.85, Math.min(0.97, ue + 0.13), side * (0.3 + 0.12 * rnd()))
    }
    // coverage per texel, then ROUNDED: blurred (two box passes) and cut again at one half — every spike's end and
    // the end point become soft round lobes (the user: "the end of the plates is rounded"), the edge a little ragged
    // with noise; stored as a soft ramp round the edge (the shader's test at 0.5 keeps it round and clean at any size)
    const cov = new Float32Array(TW * TH), tmp = new Float32Array(TW * TH)
    for (let py = 0; py < TH; py++) for (let px = 0; px < TW; px++) {
      let c = 0
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) c += mask[(py * SS + sy) * SW + px * SS + sx]
      cov[py * TW + px] = c / (SS * SS)
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let py = 0; py < TH; py++) for (let px = 0; px < TW; px++) {
        let a = 0
        for (let d = -BLUR; d <= BLUR; d++) a += cov[py * TW + Math.min(TW - 1, Math.max(0, px + d))]
        tmp[py * TW + px] = a / (2 * BLUR + 1)
      }
      for (let py = 0; py < TH; py++) for (let px = 0; px < TW; px++) {
        let a = 0
        for (let d = -BLUR; d <= BLUR; d++) a += tmp[Math.min(TH - 1, Math.max(0, py + d)) * TW + px]
        cov[py * TW + px] = a / (2 * BLUR + 1)
      }
    }
    for (let py = 0; py < TH; py++) for (let px = 0; px < TW; px++) {
      const x = ox + px, y = oy + py
      const a = Math.min(1, Math.max(0, (cov[py * TW + px] - 0.5 + (noise(x / 9, y / 9) - 0.5) * 0.14) * 3 + 0.5))
      if (a <= 0) continue
      const u = (px + 0.5) / TW, v = Math.abs(((py + 0.5) / TH) * 2 - 1), k = (y * W + x) * 4
      // smooth tone lighter toward the end and out along the spikes, MOTTLED (soft blotches + a fine grain: the
      // references' painted noise)
      const mottle = 0.86 + 0.2 * noise(x / 26 + 7.1, y / 26 + 3.3) + 0.08 * (noise(x / 3.5 + 1.7, y / 3.5 + 9.2) - 0.5)
      data[k] = Math.round(Math.min(1, (0.45 + 0.45 * Math.pow(u, 0.8) + 0.15 * v) * mottle) * 255)
      // depth: the plate's starting part, by the trunk, clearly darker (the user: "inside the starting part bit darker")
      data[k + 1] = Math.round((0.15 + 0.85 * smooth01((u - 0.04) / 0.62)) * 255)
      data[k + 3] = Math.round(a * 255)
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.anisotropy = 4
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}

/** A frond card's texel (createFrondTexture): tone (r), depth (g), coverage (a, mip-corrected). s 0 (the base) … 1
 *  (the tip) along it, c −1…1 across, lz = 1 + tile + tint × 0.9. Fragment shaders only (derivatives). */
export const FROND_GLSL = /* glsl */ `
uniform sampler2D uFrondTex;
vec4 frondCard(float s, float c, float lz) {
  float tile = floor(lz) - 1.0;
  vec2 uv = (vec2(mod(tile, 2.0), floor(tile / 2.0)) + vec2(s * 0.99 + 0.005, (c * 0.5 + 0.5) * 0.98 + 0.01)) * 0.5;
  vec4 t = texture(uFrondTex, uv);
  vec2 px = uv * vec2(1024.0, 512.0);
  float lod = max(0.0, 0.5 * log2(max(dot(dFdx(px), dFdx(px)), dot(dFdy(px), dFdy(px)))));
  t.a = clamp(t.a * (1.0 + 0.35 * lod), 0.0, 1.0);
  return t;
}
`
