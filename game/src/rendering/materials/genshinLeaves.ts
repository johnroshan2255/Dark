import { Rng } from '../../world/noise/rng'

/**
 * GENSHIN-PAINTED LEAF SPRAYS, one per species (the foliage atlas's per-species cells, FoliageAtlas): what makes the
 * trees read different is the LEAF SHAPE as much as the crown — beech ovals, elm's small round leaves, acacia's fine
 * feathery fronds, bamboo's long blades, fir's flat needle combs, juniper's scaly cords, the spruce's bottle brushes.
 * All in the Genshin manner: crisp cut-out shapes in FLAT grey tones (one per leaf, back ones darker), a thin midrib on
 * the big leaves, no speckle or gradient — the hue comes from the vertex / instance colours, the light from the crown's
 * shared normals.
 *
 * Layout = the Tree It cards' (scripts/blender/treeit_set.py, spruce_treeit.py): a spray in a square whose STEM runs
 * from the bottom-left corner (s, t = 0, 0: the branch end) towards the top-right (1, 1); s right, t UP.
 */
export interface Slot { x: number; y: number; w: number; h: number }
type Pt = readonly [number, number]

const grey = (v: number) => {
  const c = Math.round(Math.max(0, Math.min(1, v)) * 255)
  return `rgb(${c},${c},${c})`
}
/** Slot coordinates (s right, t up, 0..1) → canvas pixels. */
const at = (r: Slot, s: number, t: number): Pt => [r.x + s * r.w, r.y + (1 - t) * r.h]

/** Leaf outline: half-width (× width) along the blade, u 0 = stalk end → 1 = tip. */
const PROFILE = {
  ovate: (u: number) => Math.sin(Math.PI * Math.pow(u, 0.75)) * (1 - 0.25 * u), // beech: widest below the middle, pointed
  round: (u: number) => Math.sin(Math.PI * Math.pow(u, 0.9)) * 0.98, //             elm: broad, a short point
  lance: (u: number) => Math.sin(Math.PI * Math.pow(u, 0.5)) * (1 - u) ** 0.35, //  bamboo: long taper to a fine tip
  leaflet: (u: number) => Math.sin(Math.PI * u), //                                  acacia: tiny ellipse
  palm: (u: number) => Math.sin(Math.PI * Math.pow(u, 1.25)), //                     reference leaflets: widest above the middle
} as const
type Shape = keyof typeof PROFILE

/** One flat-toned leaf from `p` at angle `a` (canvas radians), length `len` px, width ratio `w`; `rib` adds a midrib. */
function leaf(g: CanvasRenderingContext2D, p: Pt, a: number, len: number, w: number, tone: number, shape: Shape, rib = false): void {
  const f = PROFILE[shape], ca = Math.cos(a), sa = Math.sin(a), N = 12
  const pt = (u: number, side: number): Pt => {
    const half = f(u) * w * 0.5 * len * side
    return [p[0] + ca * u * len - sa * half, p[1] + sa * u * len + ca * half]
  }
  g.fillStyle = grey(tone)
  g.beginPath()
  g.moveTo(p[0], p[1])
  for (let i = 1; i <= N; i++) g.lineTo(...pt(i / N, 1))
  for (let i = N - 1; i >= 1; i--) g.lineTo(...pt(i / N, -1))
  g.closePath()
  g.fill()
  if (rib && len > 18) {
    g.strokeStyle = grey(tone * 0.84)
    g.lineWidth = Math.max(1, len * 0.03)
    g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(...pt(0.85, 0)); g.stroke()
  }
}

function twig(g: CanvasRenderingContext2D, pts: Pt[], w0: number, w1: number, tone = 0.55): void {
  g.strokeStyle = grey(tone)
  g.lineCap = 'round'
  for (let i = 1; i < pts.length; i++) {
    g.lineWidth = Math.max(1, w0 + (w1 - w0) * (i / pts.length))
    g.beginPath(); g.moveTo(...pts[i - 1]); g.lineTo(...pts[i]); g.stroke()
  }
}

/** A gently curving branch from (s0, t0) heading `dir` (radians, slot space: 0 = +s, π/2 = +t), `n` points. */
function path(s0: number, t0: number, dir: number, len: number, bend: number, n: number): [number, number][] {
  const out: [number, number][] = [[s0, t0]]
  let s = s0, t = t0, a = dir
  for (let i = 0; i < n; i++) {
    s += Math.cos(a) * len / n; t += Math.sin(a) * len / n; a += bend / n
    out.push([s, t])
  }
  return out
}
/** Slot-space direction → canvas angle (t is up, canvas y down). */
const canvasAngle = (a: number) => -a
const inside = (s: number, t: number, m = 0.03) => s > m && s < 1 - m && t > m && t < 1 - m

/**
 * Leaves along a branch path, alternating sides: `every` leaves per segment, at `spread` from the branch
 * (radians, ± jitter), tip-ward lean `lean`, plus a terminal leaf.
 */
function leafy(g: CanvasRenderingContext2D, r: Slot, rng: Rng, br: [number, number][], o: { shape: Shape; len: [number, number]; w: number; spread: number; lean?: number; tone: [number, number]; rib?: boolean; skip?: number }): void {
  const px = r.w
  for (let i = 1; i < br.length; i++) {
    if (i <= (o.skip ?? 0)) continue
    const [s, t] = br[i], [ps, pt] = br[i - 1]
    const dir = Math.atan2(t - pt, s - ps)
    for (const side of i % 2 ? [1, -1] : [-1, 1]) {
      const len = rng.range(o.len[0], o.len[1])
      const a = dir + side * (o.spread + rng.range(-0.2, 0.2)) - side * (o.lean ?? 0)
      const es = s + Math.cos(a) * len, et = t + Math.sin(a) * len
      if (!inside(es, et)) continue
      leaf(g, at(r, s, t), canvasAngle(a), len * px, o.w, rng.range(o.tone[0], o.tone[1]), o.shape, o.rib)
    }
  }
  const [s, t] = br[br.length - 1], [ps, pt] = br[br.length - 2]
  const len = o.len[1], a = Math.atan2(t - pt, s - ps)
  if (inside(s + Math.cos(a) * len, t + Math.sin(a) * len)) leaf(g, at(r, s, t), canvasAngle(a), len * px, o.w, rng.range(o.tone[0], o.tone[1]), o.shape, o.rib)
}
const toCanvas = (r: Slot, br: [number, number][]) => br.map(([s, t]) => at(r, s, t))

/** BEECH: a flat spray of glossy ovate leaves alternating along a zig-zag twig and three side twigs. */
export function drawBeech(g: CanvasRenderingContext2D, r: Slot, rng: Rng): void {
  const main = path(0.05, 0.05, Math.PI / 4 + rng.range(-0.08, 0.08), 1.05, rng.range(-0.3, 0.3), 8)
  const sides = [2, 4, 6].map((k, i) => path(main[k][0], main[k][1], Math.PI / 4 + (i % 2 ? 0.75 : -0.75), rng.range(0.32, 0.42), (i % 2 ? -0.4 : 0.4), 4))
  for (const b of [main, ...sides]) twig(g, toCanvas(r, b), r.w * 0.012, r.w * 0.004)
  for (const b of sides) leafy(g, r, rng, b, { shape: 'ovate', len: [0.13, 0.17], w: 0.55, spread: 0.95, tone: [0.74, 0.92], rib: true })
  leafy(g, r, rng, main, { shape: 'ovate', len: [0.15, 0.2], w: 0.55, spread: 0.9, tone: [0.82, 1.0], rib: true, skip: 1 })
}

/** ELM: a branched spray, many small round-pointed leaves in two neat rows (elm's flat herring-bone sprays). */
export function drawElm(g: CanvasRenderingContext2D, r: Slot, rng: Rng): void {
  const main = path(0.05, 0.05, Math.PI / 4 + rng.range(-0.1, 0.1), 1.0, rng.range(-0.25, 0.25), 9)
  const sides = [2, 3, 5, 6].map((k, i) => path(main[k][0], main[k][1], Math.PI / 4 + (i % 2 ? 0.85 : -0.85), rng.range(0.3, 0.42), (i % 2 ? -0.3 : 0.3), 6))
  for (const b of [main, ...sides]) twig(g, toCanvas(r, b), r.w * 0.009, r.w * 0.003)
  for (const b of sides) leafy(g, r, rng, b, { shape: 'round', len: [0.065, 0.085], w: 0.72, spread: 1.05, tone: [0.72, 0.9] })
  leafy(g, r, rng, main, { shape: 'round', len: [0.075, 0.095], w: 0.72, spread: 1.0, tone: [0.8, 1.0], skip: 1 })
}

/** ACACIA: forking twigs carrying fine FEATHERY fronds — each frond a comb of tiny paired leaflets (bipinnate). */
export function drawAcacia(g: CanvasRenderingContext2D, r: Slot, rng: Rng): void {
  const main = path(0.05, 0.05, Math.PI / 4 + rng.range(-0.08, 0.08), 0.95, rng.range(-0.25, 0.25), 6)
  const forks = [1, 2, 3, 4, 5].map((k, i) => path(main[k][0], main[k][1], Math.PI / 4 + (i % 2 ? 0.8 : -0.8), rng.range(0.22, 0.32), (i % 2 ? -0.5 : 0.5), 4))
  for (const b of [main, ...forks]) twig(g, toCanvas(r, b), r.w * 0.01, r.w * 0.003, 0.5)
  // the fronds: each a short rachis with ~10 leaflet pairs
  const frond = (s: number, t: number, a: number, tone: number) => {
    const L = rng.range(0.11, 0.15), n = 9
    for (let k = 1; k <= n; k++) {
      const u = (k / n) * L, ps = s + Math.cos(a) * u, pt = t + Math.sin(a) * u
      for (const side of [1, -1]) {
        const la = a + side * 1.25, ll = 0.026 * (1 - 0.35 * (k / n))
        if (inside(ps + Math.cos(la) * ll, pt + Math.sin(la) * ll, 0.02)) leaf(g, at(r, ps, pt), canvasAngle(la), ll * r.w, 0.5, tone + rng.range(-0.05, 0.05), 'leaflet')
      }
    }
  }
  for (const b of [main, ...forks]) {
    for (let i = 1; i < b.length; i++) {
      const [s, t] = b[i], [ps, pt] = b[i - 1], dir = Math.atan2(t - pt, s - ps)
      for (const side of [1, -1]) frond(s, t, dir + side * rng.range(0.6, 1.1), rng.range(0.74, 0.98))
    }
  }
}

/** BAMBOO (the 2 × 2 slot sheet's slot): a thin twig, leaves in drooping FANS of long narrow blades at its nodes. */
export function drawBamboo(g: CanvasRenderingContext2D, r: Slot, rng: Rng): void {
  const main = path(0.05, 0.05, Math.PI / 4 + rng.range(-0.06, 0.06), 0.85, rng.range(-0.15, 0.15), 6)
  twig(g, toCanvas(r, main), r.w * 0.012, r.w * 0.006, 0.6)
  for (const k of [2, 4, 6]) {
    const [s, t] = main[k], n = k === 6 ? 5 : 3
    // a fan hanging down-and-out of the twig (gravity: towards −t)
    for (let j = 0; j < n; j++) {
      const a = (k === 6 ? Math.PI / 4 : -Math.PI / 4) + (j - (n - 1) / 2) * 0.42 + rng.range(-0.1, 0.1)
      const len = rng.range(0.3, 0.4)
      const es = s + Math.cos(a) * len, et = t + Math.sin(a) * len
      if (!inside(es, et, 0.02)) continue
      leaf(g, at(r, s, t), canvasAngle(a), len * r.w, 0.16, rng.range(0.78, 1.0), 'lance', true)
    }
  }
}

/** FIR: a FLAT needle comb — the branchlets' short needles combed out to both sides, like a fir's flattened sprays. */
export function drawFir(g: CanvasRenderingContext2D, r: Slot, rng: Rng): void {
  const main = path(0.05, 0.05, Math.PI / 4 + rng.range(-0.06, 0.06), 1.0, rng.range(-0.15, 0.15), 10)
  const sides = [2, 3, 4, 5, 6, 7].map((k, i) => path(main[k][0], main[k][1], Math.PI / 4 + (i % 2 ? 0.95 : -0.95), rng.range(0.22, 0.32) * (1 - k / 14), (i % 2 ? -0.2 : 0.2), 5))
  g.lineCap = 'round'
  for (const b of [...sides, main]) {
    twig(g, toCanvas(r, b), r.w * 0.008, r.w * 0.004, 0.5)
    for (let i = 1; i < b.length; i++) {
      const [s, t] = b[i], [ps, pt] = b[i - 1], dir = Math.atan2(t - pt, s - ps)
      for (let k = 0; k < 3; k++) {
        const u = k / 3, cs = ps + (s - ps) * u, ct = pt + (t - pt) * u
        for (const side of [1, -1]) {
          const a = dir + side * rng.range(1.0, 1.3), len = rng.range(0.06, 0.08)
          const es = cs + Math.cos(a) * len, et = ct + Math.sin(a) * len
          if (!inside(es, et, 0.02)) continue
          g.strokeStyle = grey(rng.range(0.74, 1.0)); g.lineWidth = r.w * 0.022
          g.beginPath(); g.moveTo(...at(r, cs, ct)); g.lineTo(...at(r, es, et)); g.stroke()
        }
      }
    }
  }
}

/** JUNIPER: a dense plume of branching CORDS of overlapping scale leaves (chains of small diamonds), spiky tufts at the tips. */
export function drawJuniper(g: CanvasRenderingContext2D, r: Slot, rng: Rng): void {
  const main = path(0.05, 0.05, Math.PI / 4 + rng.range(-0.1, 0.1), 0.95, rng.range(-0.3, 0.3), 9)
  const cords: [number, number][][] = [main]
  for (let k = 1; k < 9; k++) {
    for (const side of [1, -1]) {
      const b = path(main[k][0], main[k][1], Math.PI / 4 + side * rng.range(0.5, 0.9), rng.range(0.2, 0.34) * (1 - k / 14), side * rng.range(0.2, 0.6), 5)
      cords.push(b)
      cords.push(path(b[2][0], b[2][1], Math.atan2(b[3][1] - b[2][1], b[3][0] - b[2][0]) + side * rng.range(0.4, 0.9), 0.12, 0, 3))
    }
  }
  for (const b of cords) {
    for (let i = 1; i < b.length; i++) {
      const [s, t] = b[i], [ps, pt] = b[i - 1], dir = Math.atan2(t - pt, s - ps)
      for (let k = 0; k < 3; k++) {
        const u = k / 3, cs = ps + (s - ps) * u, ct = pt + (t - pt) * u
        if (!inside(cs, ct, 0.05)) continue
        leaf(g, at(r, cs, ct), canvasAngle(dir + rng.range(-0.35, 0.35)), r.w * 0.075, 0.6, rng.range(0.72, 0.98), 'leaflet')
      }
    }
    const [s, t] = b[b.length - 1]
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + rng.range(-1.2, 1.2), len = 0.05
      if (inside(s + Math.cos(a) * len, t + Math.sin(a) * len, 0.02)) leaf(g, at(r, s, t), canvasAngle(a), len * r.w, 0.35, rng.range(0.8, 1.0), 'lance')
    }
  }
}

/**
 * SPRUCE (the 2 × 2 slot sheet of the Tree It spruce — green spray, dry spray, twigs, spare green — spruce_treeit.py's
 * SLOT layout): a drooping BOTTLE BRUSH — needles all round the branchlets, painted as dense short strokes, overlapping
 * in two tones. `kind` 'dry' is sparser, 'twig' bare twigs with a few tufts.
 */
export function drawSpruce(g: CanvasRenderingContext2D, r: Slot, rng: Rng, kind: 'green' | 'dry' | 'twig'): void {
  const main = path(0.05, 0.05, Math.PI / 4 + rng.range(-0.05, 0.05), 1.0, rng.range(-0.35, -0.1), 10)
  const sides = [2, 3, 4, 5, 6, 7, 8].map((k, i) => path(main[k][0], main[k][1], Math.PI / 4 + (i % 2 ? 0.8 : -0.8) - 0.15, rng.range(0.2, 0.3) * (1 - k / 16), -0.3, 5))
  const density = kind === 'green' ? 7 : kind === 'dry' ? 3.5 : 0.8
  g.lineCap = 'round'
  for (const b of [...sides, main]) {
    twig(g, toCanvas(r, b), r.w * 0.01, r.w * 0.004, 0.5)
    for (let i = 1; i < b.length; i++) {
      const [s, t] = b[i], [ps, pt] = b[i - 1], dir = Math.atan2(t - pt, s - ps)
      for (let k = 0; k < density * 2; k++) {
        if (rng.next() > density / 4 && kind !== 'green') continue
        const u = rng.next(), cs = ps + (s - ps) * u, ct = pt + (t - pt) * u
        const a = dir + rng.range(-2.4, 2.4) * 0.6 + (rng.next() < 0.5 ? 0.9 : -0.9), len = rng.range(0.06, 0.09)
        const es = cs + Math.cos(a) * len, et = ct + Math.sin(a) * len
        if (!inside(es, et, 0.02)) continue
        g.strokeStyle = grey(rng.range(0.7, 1.0)); g.lineWidth = r.w * 0.024
        g.beginPath(); g.moveTo(...at(r, cs, ct)); g.lineTo(...at(r, es, et)); g.stroke()
      }
    }
  }
}

/**
 * REFERENCE BROADLEAF CLUSTER (the camera-facing tuft of the Genshin broadleaves — the user's reference: a Mondstadt
 * tree whose crown is built of PALMATE clusters, 5–7 pointed leaflets fanning from one point): ~16 clusters spread
 * through a lumpy blob, back ones darker, front ones lighter, sky between them at the edge. Centred card (billboard).
 */
export function drawPalmateTuft(g: CanvasRenderingContext2D, ox: number, oy: number, size: number, rng: Rng): void {
  const cx = ox + size / 2, cy = oy + size / 2, R = size * 0.46
  const clusters: [number, number, number][] = []
  for (let i = 0; i < 60 && clusters.length < 17; i++) {
    const a = rng.range(0, Math.PI * 2), d = Math.sqrt(rng.next()) * 0.55
    clusters.push([Math.cos(a) * d, Math.sin(a) * d * 0.9, d])
  }
  // far (outer, lower) clusters first: darker; the near ones on top: lighter
  clusters.sort((a, b) => b[2] - a[2] || a[1] - b[1])
  for (const [x, y, d] of clusters) {
    const n = 5 + Math.floor(rng.next() * 3), rot = rng.range(0, Math.PI * 2), tone = 0.7 + 0.3 * (1 - d / 0.55) + rng.range(-0.05, 0.05)
    for (let k = 0; k < n; k++) {
      const a = rot + (k / n) * Math.PI * 2 + rng.range(-0.2, 0.2), len = R * rng.range(0.24, 0.34)
      const ex = x + Math.cos(a) * len / R, ey = y + Math.sin(a) * len / R
      if (Math.abs(ex) > 0.92 || Math.abs(ey) > 0.92) continue
      leaf(g, [cx + x * R, cy + y * R], a, len, 0.36, Math.min(1, tone + rng.range(-0.06, 0.04)), 'palm', true)
    }
  }
}

/**
 * FAN LEAF (2026-10-25, the user's Genshin reference — a crown of ginkgo-like leaves): a broad FAN on a short stalk,
 * ~110° wide, its outer edge softly scalloped with a shallow notch in the middle; one flat tone, a faint lighter rim.
 * `p` is where the stalk starts, `a` the leaf's direction (canvas radians), `len` its length (stalk + blade) in px.
 */
function fanLeaf(g: CanvasRenderingContext2D, p: Pt, a: number, len: number, tone: number, rng: Rng): void {
  const stalk = len * 0.3, R = len * 0.7, half = 0.95 + rng.range(-0.12, 0.12)
  const bx = p[0] + Math.cos(a) * stalk, by = p[1] + Math.sin(a) * stalk
  g.strokeStyle = grey(tone * 0.92); g.lineWidth = Math.max(1, len * 0.035); g.lineCap = 'round'
  g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(bx, by); g.stroke()
  const ph = rng.range(0, 6.28), N = 22
  g.beginPath()
  g.moveTo(bx, by)
  for (let i = 0; i <= N; i++) {
    const u = i / N, th = -half + 2 * half * u
    // soft scallops along the rim, a shallow notch at the middle, the sides a little shorter (a fan, not a disc)
    const r = R * (1 - 0.13 * Math.exp(-((u - 0.5) ** 2) / 0.004) + 0.035 * Math.sin(u * 28 + ph)) * (0.82 + 0.18 * Math.sin(Math.PI * u))
    g.lineTo(bx + Math.cos(a + th) * r, by + Math.sin(a + th) * r)
  }
  g.closePath()
  g.fillStyle = grey(tone)
  g.fill()
  // (no dark outline — the user: "Genshin has a lighter border or none": a faint LIGHTER rim, the leaf's lit edge)
  g.strokeStyle = grey(Math.min(1, tone * 1.1 + 0.03)); g.lineWidth = Math.max(1, len * 0.03)
  g.stroke()
}

/**
 * Separate fan leaves scattered over a region, each on its own with a GAP round it (2026-10-25, the user: "Genshin's
 * leaves are each disconnected — yours are all connected like paper"): dart-throwing — a leaf is kept only if its
 * blade centre is ≥ `gap` × its size from every other's, so the cut-outs show the deeper crown / sky between them.
 * `spot`: a candidate (canvas point, outward direction, size px) or null.
 */
function scatterFans(g: CanvasRenderingContext2D, rng: Rng, tries: number, max: number, gap: number, spot: () => [Pt, number, number] | null, tone: () => number): void {
  const kept: [number, number, number][] = []
  const leaves: [Pt, number, number, number][] = []
  for (let i = 0; i < tries && leaves.length < max; i++) {
    const c = spot()
    if (!c) continue
    const [p, a, len] = c
    const bx = p[0] + Math.cos(a) * len * 0.62, by = p[1] + Math.sin(a) * len * 0.62
    if (kept.some(([x, y, l]) => Math.hypot(x - bx, y - by) < gap * (l + len) * 0.5)) continue
    kept.push([bx, by, len])
    leaves.push([p, a, len, tone()])
  }
  // (darker ones first: the back of the spray, the light ones on top)
  leaves.sort((x, y) => x[3] - y[3])
  for (const [p, a, len, t] of leaves) fanLeaf(g, p, a, len, t, rng)
}

/** FAN SPRAY (a branch card, the Tree It slot layout: stem from the bottom-left corner): separate leaves along a twig. */
export function drawFanSpray(g: CanvasRenderingContext2D, r: Slot, rng: Rng): void {
  const main = path(0.05, 0.05, Math.PI / 4 + rng.range(-0.08, 0.08), 1.0, rng.range(-0.3, 0.3), 6)
  const sides = [2, 4].map((k, i) => path(main[k][0], main[k][1], Math.PI / 4 + (i % 2 ? 0.8 : -0.8), rng.range(0.3, 0.4), (i % 2 ? -0.3 : 0.3), 3))
  const all = [main, ...sides]
  for (const b of all) twig(g, toCanvas(r, b), r.w * 0.011, r.w * 0.004)
  scatterFans(g, rng, 600, 44, 0.72, () => {
    // a point on a twig, the leaf pointing out to one side of it on a short stalk
    const b = all[Math.floor(rng.next() * all.length)], i = 1 + Math.floor(rng.next() * (b.length - 1))
    const u = rng.next(), s0 = b[i - 1][0] + (b[i][0] - b[i - 1][0]) * u, t0 = b[i - 1][1] + (b[i][1] - b[i - 1][1]) * u
    const dir = Math.atan2(b[i][1] - b[i - 1][1], b[i][0] - b[i - 1][0])
    const a = dir + (rng.next() < 0.5 ? 1 : -1) * rng.range(0.5, 1.5)
    const len = rng.range(0.13, 0.17)
    if (!inside(s0 + Math.cos(a) * len, t0 + Math.sin(a) * len, 0.0)) return null
    return [at(r, s0, t0), canvasAngle(a), len * r.w]
  }, () => rng.range(0.62, 1.0))
}

/** FAN TUFT (the camera-facing cluster card): separate fan leaves through a lumpy blob, gaps between them. */
export function drawFanTuft(g: CanvasRenderingContext2D, ox: number, oy: number, size: number, rng: Rng): void {
  const cx = ox + size / 2, cy = oy + size / 2, R = size * 0.46
  scatterFans(g, rng, 800, 56, 0.72, () => {
    const a0 = rng.range(0, Math.PI * 2), d = Math.sqrt(rng.next()) * 0.7
    const x = Math.cos(a0) * d, y = Math.sin(a0) * d * 0.9, len = R * rng.range(0.22, 0.28)
    const a = a0 + rng.range(-0.7, 0.7)
    if (Math.abs(x + Math.cos(a) * len / R) > 0.95 || Math.abs(y + Math.sin(a) * len / R) > 0.95) return null
    return [[cx + x * R, cy + y * R], a, len]
  }, () => rng.range(0.62, 1.0))
}

/**
 * SOLID PINE FRONDS (the soft look — Over the Hill's spruces: big flat serrated fronds, no needles): every twig of the
 * spray is one smooth blade with a jagged edge, its upper half lighter than its lower — the fronds stack into layered,
 * cleanly shaded branches.
 */
export function drawFrondSpray(g: CanvasRenderingContext2D, r: Slot, rng: Rng): void {
  const main = path(0.05, 0.05, Math.PI / 4 + rng.range(-0.06, 0.06), 1.0, rng.range(-0.2, 0.2), 10)
  const sides = [2, 3, 4, 5, 6, 7].map((k, i) => path(main[k][0], main[k][1], Math.PI / 4 + (i % 2 ? 0.75 : -0.75), rng.range(0.3, 0.42) * (1 - k * 0.05), (i % 2 ? -0.2 : 0.2), 6))
  const blade = (b: [number, number][], wMax: number) => {
    const n = b.length, L: Pt[] = [], R: Pt[] = []
    for (let i = 0; i < n; i++) {
      const p0 = b[Math.max(0, i - 1)], p1 = b[Math.min(n - 1, i + 1)]
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1], l = Math.hypot(dx, dy) || 1
      const nx = -dy / l, ny = dx / l, u = i / (n - 1)
      const w = wMax * Math.sin(Math.PI * Math.min(1, Math.pow(u, 0.6) * 0.98 + 0.02)) * (1 - 0.35 * u)
      const tooth = i % 2 ? 1 : 0.62 // (the serrated edge)
      L.push(at(r, b[i][0] + nx * w * tooth, b[i][1] + ny * w * tooth))
      R.push(at(r, b[i][0] - nx * w * (i % 2 ? 0.62 : 1), b[i][1] - ny * w * (i % 2 ? 0.62 : 1)))
    }
    const mid = b.map(([s, t]) => at(r, s, t))
    const fill = (pts: Pt[], tone: number) => {
      g.fillStyle = grey(tone)
      g.beginPath()
      pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)))
      g.closePath()
      g.fill()
    }
    fill([...L, ...R.slice().reverse()], rng.range(0.6, 0.66)) // the lower (shaded) half
    fill([...L, ...mid.slice().reverse()], rng.range(0.92, 1.0)) // the upper (lit) half
  }
  for (const b of sides) blade(b, 0.14)
  blade(main, 0.2)
}

/** TINY LEAF FLAKES (the soft look's aspens and bushes): thousands of small irregular chips, one flat tone each. */
/** Flakes kept apart (each leaf separate, gaps between — never a plate): a coarse grid of the placed flakes. */
class Spacer {
  private readonly cells = new Map<number, [number, number, number][]>()
  constructor(private readonly cell: number) {}
  ok(x: number, y: number, r: number, gap: number): boolean {
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell)
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const [px, py, pr] of this.cells.get((cx + i) * 65536 + cy + j) ?? []) if (Math.hypot(px - x, py - y) < (pr + r) * gap) return false
    }
    const k = cx * 65536 + cy
    const l = this.cells.get(k) ?? []
    l.push([x, y, r])
    this.cells.set(k, l)
    return true
  }
}
function flake(g: CanvasRenderingContext2D, x: number, y: number, rad: number, a: number, tone: number): void {
  g.fillStyle = grey(tone)
  g.beginPath()
  g.ellipse(x, y, rad, rad * 0.72, a, 0, Math.PI * 2)
  g.fill()
}
export function drawFlakeSpray(g: CanvasRenderingContext2D, r: Slot, rng: Rng): void {
  const main = path(0.05, 0.05, Math.PI / 4 + rng.range(-0.08, 0.08), 1.0, rng.range(-0.3, 0.3), 6)
  const sides = [2, 4].map((k, i) => path(main[k][0], main[k][1], Math.PI / 4 + (i % 2 ? 0.8 : -0.8), rng.range(0.3, 0.4), (i % 2 ? -0.3 : 0.3), 3))
  const all = [main, ...sides]
  const sp = new Spacer(r.w * 0.04)
  for (let n = 0, k = 0; n < 6000 && k < 1400; n++) {
    const b = all[Math.floor(rng.next() * all.length)], i = 1 + Math.floor(rng.next() * (b.length - 1))
    const u = rng.next(), s0 = b[i - 1][0] + (b[i][0] - b[i - 1][0]) * u, t0 = b[i - 1][1] + (b[i][1] - b[i - 1][1]) * u
    const a = rng.range(0, Math.PI * 2), d = Math.sqrt(rng.next()) * 0.2
    const s = s0 + Math.cos(a) * d, t = t0 + Math.sin(a) * d, rad = rng.range(0.009, 0.016)
    if (!inside(s, t, rad + 0.02)) continue
    const [x, y] = at(r, s, t)
    if (!sp.ok(x, y, rad * r.w, 1.25)) continue
    flake(g, x, y, rad * r.w, rng.range(0, Math.PI), rng.range(0.6, 1.0) * (0.85 + 0.15 * t))
    k++
  }
}
export function drawFlakeTuft(g: CanvasRenderingContext2D, ox: number, oy: number, size: number, rng: Rng): void {
  // LOOSE leaf clusters, not a filled disc: 5–7 sub-clumps; each leaf kept with a chance that falls with its distance
  // from its clump's centre — dense hearts, scattered leaves and sky gaps at the rim (a ragged, airy outline).
  // (2026-10-25: ~1100 tiny flakes of random tone read as pencil stipple — "paper and pencil drawn". Now ~260 LARGER
  //  leaves in a calm tone range: the card's ball normal — vegetationMaterial SOFT_NORMAL_PS — shades the clump.)
  const cx = ox + size / 2, cy = oy + size / 2, R = size * 0.46
  const clumps: [number, number, number][] = []
  const nc = 5 + Math.floor(rng.next() * 3)
  for (let k = 0; k < nc; k++) {
    const a = rng.range(0, Math.PI * 2), d = k === 0 ? 0 : rng.range(0.25, 0.48)
    clumps.push([Math.cos(a) * d, Math.sin(a) * d * 0.85, rng.range(0.34, 0.46)])
  }
  // (2026-10-26, "remove its border from each leaf": the sky between the spaced leaves drew a dark ring round every one
  //  — each clump now has a SOLID painted heart and its leaves overlap; only the clump's outer edge stays ragged)
  for (const [qx, qy, qr] of clumps) {
    g.fillStyle = grey(0.68)
    g.beginPath()
    g.ellipse(cx + qx * R, cy + qy * R, qr * R * 0.72, qr * R * 0.64, rng.range(0, Math.PI), 0, Math.PI * 2)
    g.fill()
  }
  const sp = new Spacer(R * 0.16)
  for (let n = 0, k = 0; n < 9000 && k < 260; n++) {
    const [qx, qy, qr] = clumps[Math.floor(rng.next() * clumps.length)]
    const a = rng.range(0, Math.PI * 2), d = rng.next()
    const x = qx + Math.cos(a) * d * qr, y = qy + Math.sin(a) * d * qr, rad = rng.range(0.05, 0.075)
    if (Math.hypot(x, y) + rad > 0.97) continue
    if (rng.next() > 1.2 - d * d * 1.1) continue // (thinning toward the clump's rim)
    if (!sp.ok(cx + x * R, cy + y * R, rad * R, 0.7)) continue
    // (a deep calm tone: the ball-lit clumps read lime-bright at 0.84–1)
    flake(g, cx + x * R, cy + y * R, rad * R, rng.range(0, Math.PI), rng.range(0.64, 0.78))
    k++
  }
}
