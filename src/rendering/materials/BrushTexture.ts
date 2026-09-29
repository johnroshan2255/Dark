import * as THREE from 'three'
import { Rng } from '../../world/noise/rng'

/**
 * Hand-painted SURFACE texture (the refer/ "painted prop" look: brush strokes, soft blotches, wood grain,
 * ragged moss edges) — one small TILING greyscale-per-channel texture shared by every painted surface,
 * generated once at startup (deterministic, no download). Linear data, not colour: shaders use it to
 * modulate vertex colours, so one texture serves stone, wood, bark, roofs and the ground.
 *   R  short directional brush strokes (~0.5 mean)      G  soft watercolour blotches (low frequency)
 *   B  long streaks along V (wood/bark grain)           A  clumpy dabs (moss / grime mask, thresholded)
 * Built as a DataTexture (not a canvas: canvas premultiplies alpha and would crush the A channel).
 * GPU memory: 256² RGBA8 + mips ≈ 0.35 MB. One fetch per painted fragment (see shaders/paint.ts).
 */
const SIZE = 256

/** Soft elliptical dab stamped with wrap-around (tiles seamlessly). Blends `ch` toward `v` by the dab's falloff. */
function dab(buf: Float32Array, cx: number, cy: number, rx: number, ry: number, rot: number, v: number, a: number): void {
  const c = Math.cos(rot), s = Math.sin(rot)
  const r = Math.ceil(Math.max(rx, ry))
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      const u = (x * c + y * s) / rx, w = (-x * s + y * c) / ry
      const d = u * u + w * w
      if (d >= 1) continue
      const k = a * (1 - d) * (1 - d)
      const px = (((Math.round(cx) + x) % SIZE) + SIZE) % SIZE
      const py = (((Math.round(cy) + y) % SIZE) + SIZE) % SIZE
      const i = py * SIZE + px
      buf[i] += (v - buf[i]) * k
    }
  }
}

export function createBrushTexture(): THREE.DataTexture {
  const rng = new Rng(9137)
  const ch = [0, 1, 2, 3].map(() => new Float32Array(SIZE * SIZE).fill(0.5))
  const [R, G, B, A] = ch
  // R: overlapping short strokes, mostly horizontal (a painter's hatching), a few rotated.
  for (let i = 0; i < 1400; i++) {
    const len = rng.range(7, 16)
    dab(R, rng.next() * SIZE, rng.next() * SIZE, len, len * rng.range(0.22, 0.35), rng.range(-0.35, 0.35) + (rng.next() < 0.15 ? 1.2 : 0), rng.range(0.2, 0.8), 0.75)
  }
  // G: big soft blotches.
  for (let i = 0; i < 90; i++) {
    const r = rng.range(18, 50)
    dab(G, rng.next() * SIZE, rng.next() * SIZE, r, r * rng.range(0.6, 1), rng.next() * 3.14, rng.range(0.15, 0.85), 0.8)
  }
  // B: long thin streaks along V (grain / bark fibres) with occasional dark knots.
  for (let i = 0; i < 700; i++) {
    const len = rng.range(18, 60)
    dab(B, rng.next() * SIZE, rng.next() * SIZE, rng.range(1.2, 3), len, rng.range(-0.04, 0.04), rng.range(0.2, 0.8), 0.8)
  }
  for (let i = 0; i < 14; i++) dab(B, rng.next() * SIZE, rng.next() * SIZE, 4, 7, 0, 0.1, 0.9)
  // A: clumps of round dabs (moss/grime), clustered so thresholds give ragged patches with holes.
  for (let c = 0; c < 40; c++) {
    const x = rng.next() * SIZE, y = rng.next() * SIZE, v = rng.next() < 0.5 ? 0.9 : 0.12
    for (let i = 0; i < 14; i++) {
      const r = rng.range(5, 16)
      dab(A, x + rng.range(-28, 28), y + rng.range(-28, 28), r, r * rng.range(0.7, 1), 0, v * rng.range(0.85, 1.1), 0.85)
    }
  }
  const data = new Uint8Array(SIZE * SIZE * 4)
  for (let i = 0; i < SIZE * SIZE; i++) {
    for (let k = 0; k < 4; k++) data[i * 4 + k] = Math.round(Math.min(1, Math.max(0, ch[k][i])) * 255)
  }
  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  tex.colorSpace = THREE.NoColorSpace
  tex.name = 'brushTexture'
  tex.needsUpdate = true
  return tex
}
