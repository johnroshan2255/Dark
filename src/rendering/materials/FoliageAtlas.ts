import * as THREE from 'three'
import { Rng } from '../../world/noise/rng'

/**
 * Procedural foliage atlas (drawn once on a canvas at startup — no image downloads).
 * 1024² texture, 2×2 cells (512² each), all drawn in GREYSCALE luminance so instance/vertex colours give the
 * hue (one texture tints to spruce, fir, pine, birch, fern):
 *   [0,0] conifer needle spray   [1,0] broadleaf cluster
 *   [0,1] pine needle tuft       [1,1] fern frond
 * plus an opaque white block in the corner of cell [1,1] (`SOLID_UV`) so trunks and canopy cores share the
 * same material/program and draw call as the cards.
 * Used with alphaTest (not blending: no sorting, depth-correct, shadows get the cut-outs for free).
 * GPU memory: 1024² RGBA8 + mips ≈ 5.6 MB.
 */
export const ATLAS_CELLS = { spray: 0, leaves: 1, tuft: 2, fern: 3 } as const
/** UV rect of a cell: [u0, v0, u1, v1]. */
export function cellUv(cell: number): [number, number, number, number] {
  const cx = cell % 2
  const cy = Math.floor(cell / 2)
  // Inset avoids bleeding between cells at low mips.
  const e = 0.01
  return [cx * 0.5 + e, 1 - (cy + 1) * 0.5 + e, (cx + 1) * 0.5 - e, 1 - cy * 0.5 - e]
}
/**
 * Opaque texel region (for solid parts). Its exact U also picks the PAINTED SURFACE the shader draws there
 * (shaders/paint.ts: u ∈ [0.9625, 1) in 0.0075 steps, all inside the white block) — no extra attribute.
 */
export const SURFACE_UV = {
  stone: [0.966, 0.015],
  wood: [0.974, 0.015],
  bark: [0.981, 0.015],
  plain: [0.989, 0.015],
  roof: [0.996, 0.015],
} as const satisfies Record<string, readonly [number, number]>
export type SurfaceName = keyof typeof SURFACE_UV
/** Default solid texel = PLAIN painted surface. */
export const SOLID_UV: readonly [number, number] = SURFACE_UV.plain
/**
 * GLOWING solid (mystic mushrooms, spores on caps): the PLAIN surface texel, but higher in the opaque block
 * (v ∈ [0.024, 0.038)) — the vegetation shader reads that as "emissive" (stylize `vGlow`): no new attribute,
 * material or program.
 */
export const GLOW_UV: readonly [number, number] = [SURFACE_UV.plain[0], 0.031]

const SIZE = 1024
const CELL = SIZE / 2

function grey(v: number, a = 1): string {
  const c = Math.round(Math.max(0, Math.min(1, v)) * 255)
  return `rgba(${c},${c},${c},${a})`
}

/**
 * Spruce BRANCH SPRAY (cell 0): one drooping branch seen from the side — stem from the left edge (trunk end)
 * to a ragged tip on the right, dense short needles hanging down and out, a lighter top edge, gaps between
 * twig clusters. Cards of this, stacked irregularly around a trunk, give the painted spruce silhouette.
 */
function drawSpray(g: CanvasRenderingContext2D, ox: number, oy: number, rng: Rng): void {
  const x0 = ox + CELL * 0.02
  const x1 = ox + CELL * 0.98
  const stemY = (t: number) => oy + CELL * (0.3 + 0.22 * t * t) // droops toward the tip
  g.lineCap = 'round'
  // Twig clusters along the stem; each hangs a fan of needles.
  const twigs = 40
  for (let k = 0; k < twigs; k++) {
    const t = (k + rng.next() * 0.6) / twigs
    if (rng.next() < 0.12) continue // gaps
    const x = x0 + (x1 - x0) * t
    const y = stemY(t)
    const size = CELL * (0.42 - 0.22 * t) * rng.range(0.75, 1.15)
    for (let n = 0; n < 40; n++) {
      const a = Math.PI * 0.5 + rng.range(-1.25, 1.25) // mostly downward
      const len = size * rng.range(0.35, 1)
      const top = Math.sin(a) < 0.2
      g.strokeStyle = grey(top ? rng.range(0.8, 1) : rng.range(0.42, 0.78))
      g.lineWidth = rng.range(6, 11) // thick enough to survive alphaTest at low mips
      g.beginPath()
      g.moveTo(x + rng.range(-4, 4), y)
      g.lineTo(x + Math.cos(a) * len * 0.6 + size * 0.15, y + Math.sin(a) * len)
      g.stroke()
    }
    // lit upper needles
    for (let n = 0; n < 8; n++) {
      g.strokeStyle = grey(rng.range(0.85, 1))
      g.lineWidth = rng.range(5, 8)
      const a = -rng.range(0.2, 1.2)
      g.beginPath()
      g.moveTo(x, y)
      g.lineTo(x + Math.cos(a) * size * 0.4, y + Math.sin(a) * size * 0.35)
      g.stroke()
    }
  }
  g.strokeStyle = grey(0.35)
  g.lineWidth = 7
  g.beginPath()
  g.moveTo(x0, stemY(0))
  for (let t = 0; t <= 1; t += 0.05) g.lineTo(x0 + (x1 - x0) * t, stemY(t))
  g.stroke()
}

/**
 * STORYBOOK spray (cell 0, art style 'storybook' — the forest-house conifers): one drooping tier drawn as a
 * FAN of broad flat brush strokes from the stem out and down, ragged dry-brush tips, a pale lit top edge and a
 * darker underside — reads as a painted tier, not needles. Same cell/UVs as `drawSpray` → same geometry.
 */
function drawBrushSpray(g: CanvasRenderingContext2D, ox: number, oy: number, rng: Rng): void {
  const x0 = ox + CELL * 0.02
  const x1 = ox + CELL * 0.98
  const stemY = (t: number) => oy + CELL * (0.28 + 0.2 * t * t)
  g.lineCap = 'round'
  const stroke = (x: number, y: number, a: number, len: number, w: number, v: number) => {
    // A brush stroke: thick at the root, splitting into 2–4 dry-brush bristle tips.
    g.strokeStyle = grey(v)
    g.lineWidth = w
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x + Math.cos(a) * len * 0.7, y + Math.sin(a) * len * 0.7)
    g.stroke()
    const tips = 3 + Math.floor(rng.next() * 3)
    for (let k = 0; k < tips; k++) {
      const aa = a + rng.range(-0.12, 0.12)
      const l2 = len * rng.range(0.85, 1.12)
      g.lineWidth = Math.max(5, w * rng.range(0.14, 0.28))
      g.strokeStyle = grey(v * rng.range(0.92, 1.05))
      g.beginPath()
      g.moveTo(x + Math.cos(a) * len * 0.55, y + Math.sin(a) * len * 0.55)
      g.lineTo(x + Math.cos(aa) * l2, y + Math.sin(aa) * l2)
      g.stroke()
    }
  }
  // Broad overlapping strokes build a SOLID drooping fan (dark underside → body → pale lit top edge);
  // each ends in dry-brush bristles → the ragged painted tip line of the reference tiers. No visible stem.
  for (const [layer, count, v0, v1] of [[0, 26, 0.32, 0.46], [1, 34, 0.5, 0.7], [2, 18, 0.82, 1]] as const) {
    for (let i = 0; i < count; i++) {
      const t = rng.next()
      const x = x0 + (x1 - x0) * t * 0.8
      const y = stemY(t) + (layer === 2 ? -CELL * 0.015 : 0)
      const reach = CELL * (0.46 - 0.26 * t) * rng.range(0.85, 1.1)
      const a = layer === 2 ? rng.range(0.1, 0.4) : layer === 1 ? rng.range(0.35, 0.8) : rng.range(0.7, 1.1)
      const w = (layer === 2 ? rng.range(16, 26) : rng.range(34, 54)) * (1 - t * 0.45)
      stroke(x, y, a, reach * (layer === 2 ? 0.75 : 1), w, rng.range(v0, v1))
    }
  }
}

function drawLeaves(g: CanvasRenderingContext2D, ox: number, oy: number, rng: Rng): void {
  for (let i = 0; i < 170; i++) {
    const r = Math.sqrt(rng.next()) * CELL * 0.42
    const a = rng.next() * Math.PI * 2
    const x = ox + CELL / 2 + Math.cos(a) * r
    const y = oy + CELL / 2 + Math.sin(a) * r
    const s = rng.range(16, 30)
    g.fillStyle = grey(0.45 + 0.55 * (1 - r / (CELL * 0.42)) * rng.range(0.7, 1))
    g.beginPath()
    g.ellipse(x, y, s, s * 0.55, rng.next() * Math.PI, 0, Math.PI * 2)
    g.fill()
  }
}

/**
 * Genshin-style LEAF MASS (cell 2): a soft, rounded clump of ~300 small overlapping leaves — NOT a radial star
 * (that rosette read as a flower / ball on every tuft). Leaves sit at random points inside a lumpy blob (a few
 * overlapping lobes), hang at random angles biased downward, and the outline is a fine scallop of leaf tips.
 * Shading is painted for volume: back/lower leaves darker, front/upper leaves lighter (light from above), so
 * overlapping cards blend into one leafy mass. Billboarded over canopies (treeFactory / genshinTrees `tuft`).
 */
/**
 * GENSHIN LEAF CLUSTER (cell 2, 'genshin' style) — what Genshin's foliage cards are (studied in close-ups of the
 * Windrise oak and a Mondstadt bush): a cut-out of ~45 distinct LOBED leaves (5–7 pointed lobes, oak / maple-like)
 * filling a ragged fan, painted in FLAT tones only — back leaves darker, front leaves lighter, no gradient, no
 * speckle; crisp edges with gaps between leaves (the lacy look from under the canopy). All the light and shade come
 * from the crown's shared normals + vertex colours, not the texture.
 */
function drawTuftGenshin(g: CanvasRenderingContext2D, ox: number, oy: number, rng: Rng): void {
  const cx = ox + CELL / 2, cy = oy + CELL / 2, R = CELL * 0.46
  const leafPath = (x: number, y: number, size: number, rot: number, lobes: number) => {
    g.beginPath()
    const N = 72
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * Math.PI * 2
      // Pointed lobes: r = size × (0.55 + 0.45 |cos(lobes·t/2)|^2.5), the leaf elongated along its axis.
      const lobe = 0.55 + 0.45 * Math.pow(Math.abs(Math.cos((lobes * t) / 2)), 2.5)
      const r = size * lobe * (1 + 0.25 * Math.cos(t))
      const px = Math.cos(t) * r, py = Math.sin(t) * r * 0.8
      const xr = x + px * Math.cos(rot) - py * Math.sin(rot), yr = y + px * Math.sin(rot) + py * Math.cos(rot)
      if (i === 0) g.moveTo(xr, yr)
      else g.lineTo(xr, yr)
    }
    g.fill()
  }
  // Two flat layers (back darker, front lighter), leaves inside a ragged fan (denser at the centre).
  const layers = [[30, 0.74, 1.0], [24, 0.94, 0.82]] as const
  for (const [count, tone, spread] of layers) {
    for (let i = 0; i < count; i++) {
      const a = rng.next() * Math.PI * 2, d = Math.pow(rng.next(), 0.7) * spread
      const x = cx + Math.cos(a) * d * R * 0.78, y = cy + Math.sin(a) * d * R * 0.62
      g.fillStyle = grey(tone + rng.range(-0.03, 0.03))
      leafPath(x, y, R * rng.range(0.13, 0.19), a + rng.range(-0.8, 0.8), rng.next() < 0.5 ? 5 : 7)
    }
  }
}

function drawTuft(g: CanvasRenderingContext2D, ox: number, oy: number, rng: Rng, round = false): void {
  const cx = ox + CELL / 2, cy = oy + CELL * 0.5, R = CELL * 0.4
  // Lumpy blob: union of lobes (fraction of R).
  const lobes: [number, number, number][] = [[0, 0, 0.78]]
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rng.range(-0.3, 0.3)
    lobes.push([Math.cos(a) * 0.42, Math.sin(a) * 0.36, rng.range(0.42, 0.55)])
  }
  const inside = (x: number, y: number) => lobes.some(([lx, ly, lr]) => (x - lx) ** 2 + (y - ly) ** 2 < lr * lr)
  const leaf = (x: number, y: number, a: number, len: number, wid: number, v: number) => {
    g.fillStyle = grey(v)
    g.beginPath()
    const ca = Math.cos(a), sa = Math.sin(a)
    const bx = x - ca * len * 0.5, by = y - sa * len * 0.5
    const tx = x + ca * len * 0.5, ty = y + sa * len * 0.5
    const nx = -sa * wid, ny = ca * wid
    g.moveTo(bx, by)
    g.quadraticCurveTo(x + nx, y + ny, tx, ty)
    g.quadraticCurveTo(x - nx, y - ny, bx, by)
    g.fill()
  }
  // Three depth layers, back (dark, larger area) → front (lighter, toward the upper-centre).
  // Fewer, larger leaves in a narrow value range (0.72–1): the crown's light and shade come from the vertex colours
  // (painted gradient), the texture only adds a soft leafy grain + the scalloped edge. High-contrast tiny leaves
  // read as pixel noise at game distances.
  const layers = [[90, 1.0, 0.74], [70, 0.86, 0.84], [45, 0.66, 0.93]] as const
  for (const [count, extent, base] of layers) {
    let n = 0, guard = 0
    while (n < count && guard++ < count * 20) {
      const x = rng.range(-1, 1) * extent, y = rng.range(-1, 1) * extent
      if (!inside(x / extent * 0.98, y / extent * 0.98)) continue
      n++
      const px = cx + x * R, py = cy + y * R
      // Hanging leaves: pointing down-and-out, randomised (never a radial fan).
      const a = Math.PI / 2 + Math.atan2(0, x) * 0 + (x * 0.6) + rng.range(-1.1, 1.1)
      // Genshin: broad ROUNDED leaves kept inside the blob (a soft scalloped outline, no spikes poking out).
      const len = R * (round ? rng.range(0.22, 0.3) * (1 - 0.25 * Math.hypot(x, y) / extent) : rng.range(0.2, 0.3))
      const lit = base + (-y) * 0.08 + rng.range(-0.04, 0.04) // a little lighter toward the top
      leaf(px, py, a, len, len * (round ? rng.range(0.55, 0.7) : rng.range(0.34, 0.46)), Math.min(1, Math.max(0.6, lit)))
    }
  }
}

function drawFern(g: CanvasRenderingContext2D, ox: number, oy: number, rng: Rng): void {
  // Frond: stem bottom→top with paired leaflets shrinking toward the tip.
  const x = ox + CELL / 2
  const y0 = oy + CELL * 0.97
  const y1 = oy + CELL * 0.05
  g.fillStyle = grey(0.85)
  for (let i = 0; i < 26; i++) {
    const t = i / 26
    const y = y0 + (y1 - y0) * t
    const w = CELL * 0.4 * Math.sin(Math.PI * (0.15 + t * 0.85)) * (1 - t * 0.35)
    for (const side of [-1, 1]) {
      g.fillStyle = grey(rng.range(0.65, 1))
      g.beginPath()
      g.ellipse(x + side * w * 0.5, y - w * 0.12, w * 0.5, CELL * 0.022, side * -0.35, 0, Math.PI * 2)
      g.fill()
    }
  }
  g.strokeStyle = grey(0.5)
  g.lineWidth = 5
  g.beginPath()
  g.moveTo(x, y0)
  g.lineTo(x, y1)
  g.stroke()
}

/** Draws the atlas ('storybook' art style swaps the conifer spray for brush-stroke fans). */
function drawAtlas(canvas: HTMLCanvasElement, storybook: boolean, genshin = false): void {
  const g = canvas.getContext('2d')!
  g.clearRect(0, 0, SIZE, SIZE)
  const rng = new Rng(4242)
  if (storybook) drawBrushSpray(g, 0, 0, rng)
  else drawSpray(g, 0, 0, rng)
  drawLeaves(g, CELL, 0, rng)
  if (genshin) drawTuftGenshin(g, 0, CELL, rng)
  else drawTuft(g, 0, CELL, rng)
  drawFern(g, CELL, CELL, rng)
  // Opaque white block for solids (bottom-right corner of the fern cell, outside the frond).
  g.fillStyle = '#ffffff'
  g.fillRect(SIZE - 40, SIZE - 40, 40, 40)
}

export function createFoliageAtlas(storybook = false, genshin = false): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  drawAtlas(canvas, storybook, genshin)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.name = 'foliageAtlas'
  return tex
}
