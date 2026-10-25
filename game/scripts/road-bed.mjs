// ROAD BEDS (2026-10-25, the user: "we have a straight road but they have bumps and terrain lifts on roads"). A fixed
// map's roads lie on its 2 m heightfield (the ribbon = grid + ruts), so every crease of the baked ground — a strata
// step, a river channel the road crosses, two roads meeting at different heights — is a bump in the road. This bakes
// each road's own designed profile (map.json road `h`, lightly smoothed along the road) into heights.bin: flat across
// the drivable bed (drawn half-width + BED m), feathered back to the untouched ground by FEATHER m (smoothstep — soft
// cuts and embankments). Where roads meet, their beds are averaged by weight: no ledge at the junction. The game and
// the server read the same file — rerun export-statics.mjs and the server's tests afterwards.
//
//   node scripts/road-bed.mjs <map> [WRITE=1] [BED=1.5] [FEATHER=6] [SIGMA=6]
// Without WRITE=1 it only reports what it would change. Writes heights.bin in place (back it up first).
import fs from 'node:fs'
import path from 'node:path'

const MAP = process.argv[2]
const opt = Object.fromEntries(process.argv.slice(3).map((a) => a.split('=')))
const BED = +(opt.BED ?? 1.5), FEATHER = +(opt.FEATHER ?? 6), SIGMA = +(opt.SIGMA ?? 6)
const WIDTH_SCALE = 0.75 // (FixedMap ROAD_WIDTH_SCALE: the drawn half-width)
const dir = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1'), '..', 'public', 'maps', MAP)
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8'))
const { n, step, min, range, origin } = meta.grid
const raw = new Uint16Array(fs.readFileSync(path.join(dir, 'heights.bin')).buffer.slice(0))
const H0 = Float64Array.from(raw, (v) => (v / 65535) * range + min)

// per cell: Σ weight × bed height, Σ weight, the strongest weight (how much of the bed replaces the ground)
const sumWT = new Float64Array(n * n), sumW = new Float64Array(n * n), maxW = new Float32Array(n * n)
const smooth = (x) => x * x * (3 - 2 * x)

for (const r of meta.roads ?? []) {
  if (!r.h || r.h.length !== r.x.length) continue
  const N = r.x.length
  // arclength, then the profile smoothed by a Gaussian of SIGMA m along it (bridge stretches keep theirs exactly)
  const s = new Float64Array(N)
  for (let k = 1; k < N; k++) s[k] = s[k - 1] + Math.hypot(r.x[k] - r.x[k - 1], r.z[k] - r.z[k - 1])
  const h = new Float64Array(N)
  for (let k = 0; k < N; k++) {
    if (r.bridge?.[k]) { h[k] = r.h[k]; continue }
    let a = 0, w = 0
    for (let j = k; j >= 0 && s[k] - s[j] < 3 * SIGMA; j--) { const q = Math.exp(-(((s[k] - s[j]) / SIGMA) ** 2) / 2); a += q * r.h[j]; w += q }
    for (let j = k + 1; j < N && s[j] - s[k] < 3 * SIGMA; j++) { const q = Math.exp(-(((s[j] - s[k]) / SIGMA) ** 2) / 2); a += q * r.h[j]; w += q }
    h[k] = a / w
  }
  const bed = (r.halfWidth ?? 4) * WIDTH_SCALE + BED, R1 = bed + FEATHER
  // this road's nearest point per cell (distance, bed height there)
  const best = new Map()
  for (let k = 0; k + 1 < N; k++) {
    if (r.bridge?.[k] && r.bridge?.[k + 1]) continue // (a bridge deck spans the ground: leave what lies under it)
    const ax = r.x[k], az = r.z[k], bx = r.x[k + 1], bz = r.z[k + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - R1 - origin[0]) / step)), i1 = Math.min(n - 1, Math.ceil((Math.max(ax, bx) + R1 - origin[0]) / step))
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - R1 - origin[1]) / step)), j1 = Math.min(n - 1, Math.ceil((Math.max(az, bz) + R1 - origin[1]) / step))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = origin[0] + i * step, pz = origin[1] + j * step
      const t = Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / L2))
      const d = Math.hypot(px - ax - dx * t, pz - az - dz * t)
      if (d >= R1) continue
      const c = j * n + i, b = best.get(c)
      if (!b || d < b[0]) best.set(c, [d, h[k] + (h[k + 1] - h[k]) * t])
    }
  }
  for (const [c, [d, y]] of best) {
    const w = d <= bed ? 1 : smooth(1 - (d - bed) / FEATHER)
    if (w <= 0) continue
    sumWT[c] += w * y
    sumW[c] += w
    if (w > maxW[c]) maxW[c] = w
  }
}

const H = Float64Array.from(H0)
let changed = 0, max = 0, sum = 0, raised = 0, lowered = 0
for (let c = 0; c < n * n; c++) {
  if (maxW[c] <= 0) continue
  const y = sumWT[c] / sumW[c]
  H[c] = H0[c] + (y - H0[c]) * maxW[c]
  const d = H[c] - H0[c]
  if (Math.abs(d) > 0.01) (changed++, (sum += Math.abs(d)), d > 0 ? raised++ : lowered++)
  max = Math.max(max, Math.abs(d))
}
console.log(`${MAP}: ${changed} cells changed (${raised} raised, ${lowered} lowered), mean |Δ| ${(sum / Math.max(1, changed)).toFixed(3)} m, max ${max.toFixed(2)} m`)
if (opt.WRITE === '1') {
  const out = new Uint16Array(n * n)
  for (let c = 0; c < n * n; c++) out[c] = Math.round(Math.min(1, Math.max(0, (H[c] - min) / range)) * 65535)
  fs.writeFileSync(path.join(dir, 'heights.bin'), Buffer.from(out.buffer))
  console.log('wrote', path.join(dir, 'heights.bin'))
}
