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
