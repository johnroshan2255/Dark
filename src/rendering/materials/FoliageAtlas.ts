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
/** Opaque texel region (for solid parts). */
export const SOLID_UV: [number, number] = [0.985, 0.015]

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
 * Genshin-style LEAF CLUSTER (cell 2): ~160 individual pointed leaves fanned around a centre, back leaves
 * darker, front/top leaves lighter (light from upper-left), leaf tips forming a serrated leafy outline.
 * Billboarded around canopies (treeFactory `tuft`).
 */
function drawTuft(g: CanvasRenderingContext2D, ox: number, oy: number, rng: Rng): void {
  const cx = ox + CELL / 2, cy = oy + CELL / 2, R = CELL * 0.42
  const leaf = (x: number, y: number, a: number, len: number, wid: number, v: number) => {
    g.fillStyle = grey(v)
    g.beginPath()
    const ca = Math.cos(a), sa = Math.sin(a)
    const tx = x + ca * len, ty = y + sa * len
    const nx = -sa * wid, ny = ca * wid
    g.moveTo(x, y)
    g.quadraticCurveTo(x + ca * len * 0.5 + nx, y + sa * len * 0.5 + ny, tx, ty)
    g.quadraticCurveTo(x + ca * len * 0.5 - nx, y + sa * len * 0.5 - ny, x, y)
    g.fill()
  }
  for (let layer = 0; layer < 3; layer++) {
    const count = [70, 55, 40][layer]
    for (let i = 0; i < count; i++) {
      const a = rng.next() * Math.PI * 2
      const r = Math.sqrt(rng.next()) * R * [0.95, 0.8, 0.6][layer]
      const x = cx + Math.cos(a) * r * 0.6, y = cy + Math.sin(a) * r * 0.55
      const dir = a + rng.range(-0.5, 0.5)
      const len = rng.range(0.28, 0.45) * R * (1 - layer * 0.12)
      const lit = 0.5 - (Math.cos(a) + Math.sin(a)) * 0.12 + layer * 0.16
      leaf(x, y, dir, len, len * rng.range(0.28, 0.4), Math.min(1, Math.max(0.3, lit + rng.range(-0.08, 0.08))))
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

export function createFoliageAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const g = canvas.getContext('2d')!
  g.clearRect(0, 0, SIZE, SIZE)
  const rng = new Rng(4242)
  drawSpray(g, 0, 0, rng)
  drawLeaves(g, CELL, 0, rng)
  drawTuft(g, 0, CELL, rng)
  drawFern(g, CELL, CELL, rng)
  // Opaque white block for solids (bottom-right corner of the fern cell, outside the frond).
  g.fillStyle = '#ffffff'
  g.fillRect(SIZE - 40, SIZE - 40, 40, 40)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.name = 'foliageAtlas'
  return tex
}
