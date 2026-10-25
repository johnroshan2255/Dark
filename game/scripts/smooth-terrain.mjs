// SMOOTH TERRAIN (2026-10-25, the user: "the terrain and rocks are so sharp — we need smooth shapes, not sharp").
// The maps' heightfields (heights.bin, a 2 m grid) carry crests, cliff lips and strata steps that turn within one cell:
// the mesh draws them as straight hard edges. This rounds them in the DATA (the game and the server read the same
// file): a few passes of curvature-weighted smoothing — only where the ground bends sharply (|Laplacian| above
// ~8 cm per cell), so plains and gentle hills stay exactly as they were — with the change per cell capped.
// Locked (unchanged): every road bed (halfWidth + 1.5 m, feathered to + 5 m — the roadside cliffs round too), the map's placed props
// (non-nature placements: buildings, bridges, set pieces; 6 m round each), the spawn, and the bridges' ends.
//
//   node scripts/smooth-terrain.mjs <map> [WRITE=1] [ITERS=8] [LO=0.08] [HI=0.45] [CAP=3]
// Without WRITE=1 it only reports what it would change. Writes heights.bin in place (back it up first).
import fs from 'node:fs'
import path from 'node:path'

const MAP = process.argv[2]
const opt = Object.fromEntries(process.argv.slice(3).map((a) => a.split('=')))
const ITERS = +(opt.ITERS ?? 8), LO = +(opt.LO ?? 0.08), HI = +(opt.HI ?? 0.45), CAP = +(opt.CAP ?? 3)
const RL = +(opt.RL ?? 1.5), RF = +(opt.RF ?? 5) // road lock: bed + RL m held, feathered out to bed + RF m
const dir = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1'), '..', 'public', 'maps', MAP)
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8'))
const { n, step, min, range, origin } = meta.grid
const raw = new Uint16Array(fs.readFileSync(path.join(dir, 'heights.bin')).buffer.slice(0))
const H0 = Float64Array.from(raw, (v) => (v / 65535) * range + min)
const H = Float64Array.from(H0)

// free[i] = 0 locked … 1 free to round
const free = new Float32Array(n * n).fill(1)
const lock = (x, z, r0, r1) => {
  const i0 = Math.max(0, Math.floor((x - r1 - origin[0]) / step)), i1 = Math.min(n - 1, Math.ceil((x + r1 - origin[0]) / step))
  const j0 = Math.max(0, Math.floor((z - r1 - origin[1]) / step)), j1 = Math.min(n - 1, Math.ceil((z + r1 - origin[1]) / step))
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const d = Math.hypot(origin[0] + i * step - x, origin[1] + j * step - z)
    const f = d <= r0 ? 0 : d >= r1 ? 1 : (d - r0) / (r1 - r0)
    if (f < free[j * n + i]) free[j * n + i] = f
  }
}
// roads: sample each polyline every ~1.5 m
for (const r of meta.roads ?? []) {
  const hw = r.halfWidth ?? 4
  for (let k = 0; k + 1 < r.x.length; k++) {
    const L = Math.hypot(r.x[k + 1] - r.x[k], r.z[k + 1] - r.z[k]), m = Math.max(1, Math.ceil(L / 1.5))
    for (let s = 0; s <= m; s++) lock(r.x[k] + ((r.x[k + 1] - r.x[k]) * s) / m, r.z[k] + ((r.z[k + 1] - r.z[k]) * s) / m, hw + RL, hw + RF)
  }
}
for (const b of meta.bridges ?? []) (lock(b.a[0], b.a[1], 10, 18), lock(b.b[0], b.b[1], 10, 18))
if (meta.spawn) lock(meta.spawn[0], meta.spawn[1], 12, 20)
const NATURE = new Set(['pine', 'pine_snow', 'palm', 'rock', 'rock_snow', 'rock_red', 'bush', 'grass_tuft', 'cactus', 'log', 'stump', 'boulder', 'dead_tree', 'oak', 'birch', 'cherry'])
try {
  const props = JSON.parse(fs.readFileSync(path.join(dir, 'props.json'), 'utf8'))
  const S = props.stride ?? 5
  for (const chunk of Object.values(props.placements ?? {})) {
    for (const [type, a] of Object.entries(chunk)) {
      if (NATURE.has(type)) continue
      for (let k = 0; k + 2 < a.length; k += S) lock(a[k], a[k + 2], 6, 12)
    }
  }
} catch { /* no props */ }

// curvature-weighted smoothing (3×3, 1-2-1 weights): only where the ground bends sharply
const lap = new Float64Array(n * n)
for (let it = 0; it < ITERS; it++) {
  for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
    const c = j * n + i
    const avg = (4 * (H[c - 1] + H[c + 1] + H[c - n] + H[c + n]) + 2 * 0 + (H[c - n - 1] + H[c - n + 1] + H[c + n - 1] + H[c + n + 1]) * 2) / 24
    lap[c] = avg - H[c]
  }
  for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
    const c = j * n + i
    if (free[c] <= 0) continue
    const a = Math.abs(lap[c]), t = Math.min(1, Math.max(0, (a - LO) / (HI - LO)))
    const w = t * t * (3 - 2 * t) * free[c]
    if (w <= 0) continue
    H[c] = Math.min(H0[c] + CAP, Math.max(H0[c] - CAP, H[c] + 0.6 * w * lap[c]))
  }
}

let changed = 0, max = 0, sum = 0, lockedMoved = 0
for (let c = 0; c < n * n; c++) {
  const d = Math.abs(H[c] - H0[c])
  if (d > 0.01) (changed++, (sum += d))
  if (d > max) max = d
  if (free[c] === 0 && d > 1e-9) lockedMoved++
}
console.log(`${MAP}: ${changed} of ${n * n} cells changed (> 1 cm), mean ${(sum / Math.max(1, changed)).toFixed(3)} m, max ${max.toFixed(2)} m; locked cells moved: ${lockedMoved}`)
if (opt.WRITE === '1') {
  const out = Uint16Array.from(H, (h) => Math.round(Math.min(65535, Math.max(0, ((h - min) / range) * 65535))))
  // (locked cells: byte-identical to the original)
  for (let c = 0; c < n * n; c++) if (free[c] === 0) out[c] = raw[c]
  fs.writeFileSync(path.join(dir, 'heights.bin'), Buffer.from(out.buffer))
  console.log('wrote', path.join(dir, 'heights.bin'))
}
