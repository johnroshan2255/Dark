import * as THREE from 'three'
import { Rng } from '../../world/noise/rng'
import { drawAcacia, drawBamboo, drawBeech, drawElm, drawFlakeSpray, drawFlakeTuft, drawFrondSpray, drawFanSpray, drawFanTuft, drawFir, drawJuniper, drawPalmateTuft, drawSpruce, type Slot } from './genshinLeaves'

/**
 * Procedural foliage atlas (drawn once on a canvas at startup — no image downloads).
 * 2048 × 1024 texture, 4 × 2 cells (512² each), all drawn in GREYSCALE luminance so instance/vertex colours give the
 * hue. Default (2026-10-25): every cell holds Genshin FAN leaves (genshinLeaves drawFanSpray / drawFanTuft) — the
 * user's reference; `?leaf=classic` keeps the older one Genshin-painted LEAF SHAPE per species family:
 *   [0] spruce sheet (2 × 2 slots)  [1] broadleaf cluster  [2] reference leaf tuft (billboards)  [3] fern frond
 *   [4] conifer sheet: fir, juniper, bamboo, spare (2 × 2 slots)  [5] beech  [6] elm  [7] acacia
 * plus an opaque white block in the bottom-right corner (cell 7, `SOLID_UV`) so trunks and canopy cores share the
 * same material/program and draw call as the cards.
 * Used with alphaTest (not blending: no sorting, depth-correct, shadows get the cut-outs for free).
 * GPU memory: 2048 × 1024 RGBA8 + mips ≈ 11 MB (was 5.6 MB at 1024²: the per-species leaves).
 */
export const ATLAS_CELLS = { spray: 0, leaves: 1, tuft: 2, fern: 3, conifer: 4, beech: 5, elm: 6, acacia: 7 } as const
/** Atlas grid: cells per row / rows. */
const COLS = 4, ROWS = 2
/** UV rect of a cell: [u0, v0, u1, v1]. */
export function cellUv(cell: number): [number, number, number, number] {
  const cx = cell % COLS
  const cy = Math.floor(cell / COLS)
  // Inset (INSET px) avoids bleeding between cells at low mips.
  const eu = INSET / W, ev = INSET / H
  return [cx / COLS + eu, 1 - (cy + 1) / ROWS + ev, (cx + 1) / COLS - eu, 1 - cy / ROWS - ev]
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
/**
 * NEEDLE solid (the autumn pines' inner core and leader — foliage, not a surface): opaque like the solids — the block's top rows (v ∈ [0.039, 0.047),
 * outside the painted-surface range, so stylize's ATLAS_SURF reads it as foliage) — but LIT LIKE LEAVES: soft wrapped
 * light, a trace of the rim, the backlit glow. As a plain solid every near-horizontal spray edge caught the full warm
 * rim and the whole tree read gold. No new attribute, material or program.
 */
export const NEEDLE_UV: readonly [number, number] = [SURFACE_UV.plain[0], 0.043]

const CELL = 512
const W = CELL * COLS, H = CELL * ROWS
const INSET = 10

function grey(v: number, a = 1): string {
  const c = Math.round(Math.max(0, Math.min(1, v)) * 255)
  return `rgba(${c},${c},${c},${a})`
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
function drawAtlas(canvas: HTMLCanvasElement, storybook: boolean, genshin = false, dots = false, soft = false): void {
  const g = canvas.getContext('2d')!
  g.clearRect(0, 0, W, H)
  const rng = new Rng(4242)
  if (storybook) drawBrushSpray(g, 0, 0, rng)
  else drawSpruceSheet(g, rng)
  drawLeaves(g, CELL, 0, rng)
  // The leaf-cluster cell is the Blender trees' leaf texture (assets/treeModels.ts): the painted Genshin cluster in
  // every style but storybook (its brush look keeps its own tufts).
  // (every style but storybook: the reference's palmate leaf clusters — 2026-10-24, "all trees leafs must look like
  // this"; the bright style's round dabs retired)
  if (genshin || !storybook || dots) drawPalmateTuft(g, ...origin(ATLAS_CELLS.tuft), CELL, rng)
  else drawTuft(g, ...origin(ATLAS_CELLS.tuft), rng)
  drawFern(g, ...origin(ATLAS_CELLS.fern), rng)
  // the per-species sprays (Tree It cards: stem from the slot's bottom-left corner)
  const conifer = (i: number) => slot(ATLAS_CELLS.conifer, CONIFER_SLOTS[i])
  if (fanLeaves()) {
    // GENSHIN FAN LEAVES — every tree, every map (2026-10-25, the user's reference, "make this the default for every
    // tree in every map"): separate ginkgo-like fans with gaps between them, a faint lighter rim, no outline. The same
    // cells, slots and card geometry — only the painted leaf shape changes (same texture size, cost and draws).
    // `?leaf=classic`: the per-species leaves below.
    g.clearRect(0, 0, W, H)
    // (the soft look: the conifers keep NEEDLE fronds — the spruce sheet's green sprays — not fan leaves)
    for (const k of [0, 1, 2, 3]) {
      if (soft) drawFrondSpray(g, slot(ATLAS_CELLS.spray, SHEET_SLOTS[k]), rng)
      else drawFanSpray(g, slot(ATLAS_CELLS.spray, SHEET_SLOTS[k]), rng)
    }
    // (the SOFT look, PlayCanvas: the broadleaves, tufts and bushes as ROUND LEAF DISCS — Over the Hill's aspens; the
    //  conifer fronds stay sprays)
    if (soft) {
      drawFlakeTuft(g, CELL, 0, CELL, rng)
      drawFlakeTuft(g, ...origin(ATLAS_CELLS.tuft), CELL, rng)
    } else {
      drawFanTuft(g, CELL, 0, CELL, rng)
      drawFanTuft(g, ...origin(ATLAS_CELLS.tuft), CELL, rng)
    }
    drawFern(g, ...origin(ATLAS_CELLS.fern), rng)
    if (soft) {
      for (const k of [0, 1, 2, 3]) drawFrondSpray(g, conifer(k), rng)
    } else for (const k of [0, 1, 2, 3]) drawFanSpray(g, conifer(k), rng)
    for (const c of [ATLAS_CELLS.beech, ATLAS_CELLS.elm, ATLAS_CELLS.acacia]) (soft ? drawFlakeSpray : drawFanSpray)(g, slot(c, FULL), rng)
    const bw = Math.ceil(W * 0.047), bh = Math.ceil(H * 0.047)
    g.clearRect(W - bw - 8, H - bh - 8, bw + 8, bh + 8)
    g.fillStyle = '#ffffff'
    g.fillRect(W - bw, H - bh, bw, bh)
    return
  }
  drawFir(g, conifer(0), rng)
  drawJuniper(g, conifer(1), rng)
  drawBamboo(g, conifer(2), rng)
  drawFir(g, conifer(3), rng)
  drawBeech(g, slot(ATLAS_CELLS.beech, FULL), rng)
  drawElm(g, slot(ATLAS_CELLS.elm, FULL), rng)
  drawAcacia(g, slot(ATLAS_CELLS.acacia, FULL), rng)
  // Opaque white block for solids (the bottom-right corner — of the acacia cell, which leaves it empty); its top rows
  // (v ∈ [0.039, 0.047)) are NEEDLE_UV's; u ≥ 0.953 covers paint.ts's surfaces (u ∈ [0.9625, 1)).
  const bw = Math.ceil(W * 0.047), bh = Math.ceil(H * 0.047)
  g.clearRect(W - bw - 8, H - bh - 8, bw + 8, bh + 8)
  g.fillStyle = '#ffffff'
  g.fillRect(W - bw, H - bh, bw, bh)
}

/** The fan leaves are the default; `?leaf=classic` draws the old per-species leaves. */
const fanLeaves = () => typeof location === 'undefined' || new URLSearchParams(location.search).get('leaf') !== 'classic'

/** Canvas origin of a cell (its top-left). */
const origin = (cell: number): [number, number] => [(cell % COLS) * CELL, Math.floor(cell / COLS) * CELL]
/** A cell's sub-slot (cell-local UV rect, v up — the Blender cards' layout) → canvas pixels, inside the inset and PAD. */
const PAD = 0.012
const FULL = [0, 0, 1, 1] as const
/** 2 × 2 slot sheets (spruce_treeit.py SLOT; treeit_set.py): [s0, t0, s1, t1] — top-left, top-right, bottom-left, bottom-right. */
export const SHEET_SLOTS = [[0, 0.5, 0.5, 1], [0.5, 0.5, 1, 1], [0, 0, 0.5, 0.5], [0.5, 0, 1, 0.5]] as const
/** The conifer cell's slots: fir, juniper, bamboo, a second fir. */
const CONIFER_SLOTS = SHEET_SLOTS
function slot(cell: number, r: readonly [number, number, number, number]): Slot {
  const [x0, y0] = origin(cell), iw = CELL - 2 * INSET
  const s0 = r[0] + PAD, t0 = r[1] + PAD, s1 = r[2] - PAD, t1 = r[3] - PAD
  return { x: x0 + INSET + s0 * iw, y: y0 + INSET + (1 - t1) * iw, w: (s1 - s0) * iw, h: (t1 - t0) * iw }
}
/**
 * The SPRUCE SHEET (cell 0, the Tree It spruce's card layout — spruce_treeit.py SLOT): green spray, dry spray, twigs,
 * a spare green spray, Genshin-painted (genshinLeaves drawSpruce). The code-built sprays sample it too.
 */
function drawSpruceSheet(g: CanvasRenderingContext2D, rng: Rng): void {
  drawSpruce(g, slot(ATLAS_CELLS.spray, SHEET_SLOTS[0]), rng, 'green')
  drawSpruce(g, slot(ATLAS_CELLS.spray, SHEET_SLOTS[1]), rng, 'dry')
  drawSpruce(g, slot(ATLAS_CELLS.spray, SHEET_SLOTS[2]), rng, 'twig')
  drawSpruce(g, slot(ATLAS_CELLS.spray, SHEET_SLOTS[3]), rng, 'green')
}

/** @param soft the PlayCanvas soft look's round-disc broadleaves (pc/look.ts) */
export function createFoliageAtlas(storybook = false, genshin = false, dots = false, soft = false): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  drawAtlas(canvas, storybook, genshin, dots, soft)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.name = 'foliageAtlas'
  return tex
}
