// HAIRPIN BAYS (2026-10-22, "make every road drivable"): a car turns no tighter than ~5 m (wheelbase / tan(lock)), so a
// hairpin bent to a 5 m centre radius throws it off the outside. At every bend of a map road tighter than R_MIN the
// flat bed is widened to the road's half width + BAY m — each cell there takes the height of the nearest road sample of
// that hairpin (never a cell nearer to another part of the road network), blended back into the ground over BLEND m.
// Data only (heights.bin); the ribbon is unchanged. Re-running is a no-op.
//   node scripts/hairpin-bays.mjs public/maps/<id> [ROADS=a,b]    env: R_MIN (9), BAY (6), BLEND (4)
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const only = process.env.ROADS ? new Set(process.env.ROADS.split(',')) : null
const R_MIN = Number(process.env.R_MIN || 9), BAY = Number(process.env.BAY || 6), BLEND = Number(process.env.BLEND || 4)
const m = JSON.parse(fs.readFileSync(path.join(dir, 'map.json')))
const g = m.grid, N = g.n, ST = g.step, HALF = m.half, OFF = m.heightOffset
const file = path.join(dir, 'heights.bin')
const buf = fs.readFileSync(file)
const raw = new Uint16Array(buf.buffer, buf.byteOffset, buf.length / 2)
const get = (i, j) => (raw[j * N + i] / 65535) * g.range + g.min + OFF
const set = (i, j, h) => (raw[j * N + i] = Math.max(0, Math.min(65535, Math.round(((h - OFF - g.min) / g.range) * 65535))))
// every road sample (for "nearest part of the network")
const all = []
for (const r of m.roads) for (let k = 0; k < r.x.length; k++) all.push({ r, k, x: r.x[k], z: r.z[k] })
let bays = 0, cells = 0
for (const r of m.roads) {
  if (only && !only.has(r.name)) continue
  const n = r.x.length, S = [0]
  for (let k = 1; k < n; k++) S.push(S[k - 1] + Math.hypot(r.x[k] - r.x[k - 1], r.z[k] - r.z[k - 1]))
  const ang = (k) => Math.atan2(r.x[k + 1] - r.x[k], r.z[k + 1] - r.z[k])
  const tight = new Set()
  for (let k = 2; k < n - 3; k++) {
    let d = ang(k + 2) - ang(k - 2)
    d = Math.atan2(Math.sin(d), Math.cos(d))
    if ((S[k + 2] - S[k - 2]) / Math.max(1e-6, Math.abs(d)) < R_MIN && !r.bridge[k]) for (let q = k - 3; q <= k + 3; q++) tight.add(q)
  }
  if (!tight.size) continue
  const ks = [...tight].filter((k) => k >= 0 && k < n).sort((a, b) => a - b)
  // WIDEN THE LINE (a keyhole): each hairpin's samples move out onto a circle of R_NEW round its apex's centre of
  // curvature, blended back over the cluster's ends — the ribbon then shows a bend the car can make.
  const R_NEW = Number(process.env.R_NEW || 10)
  const clusters = []
  for (const k of ks) (clusters.length && k === clusters[clusters.length - 1].at(-1) + 1 ? clusters[clusters.length - 1].push(k) : clusters.push([k]))
  for (const cl of clusters) {
    let apex = cl[0], aR = Infinity, cx = 0, cz = 0
    for (const k of cl) {
      if (k < 2 || k > n - 4) continue
      let d = ang(k + 2) - ang(k - 2)
      d = Math.atan2(Math.sin(d), Math.cos(d))
      const R = (S[k + 2] - S[k - 2]) / Math.max(1e-6, Math.abs(d))
      if (R < aR) {
        aR = R
        apex = k
        // the centre of curvature: R off the apex, on the side whose distance to the neighbours k ± 2 is nearest R
        const t = ang(k)
        let bestE = Infinity
        for (const sgn of [-1, 1]) {
          const ccx = r.x[k] + Math.cos(t) * sgn * R, ccz = r.z[k] - Math.sin(t) * sgn * R
          const e = Math.abs(Math.hypot(r.x[k - 2] - ccx, r.z[k - 2] - ccz) - R) + Math.abs(Math.hypot(r.x[k + 2] - ccx, r.z[k + 2] - ccz) - R)
          if (e < bestE) (bestE = e), (cx = ccx), (cz = ccz)
        }
      }
    }
    if (process.env.DEBUG) console.log(`  cluster ${cl[0]}-${cl.at(-1)} apex ${apex} R ${aR.toFixed(1)} centre ${cx.toFixed(1)},${cz.toFixed(1)} apexPt ${r.x[apex]},${r.z[apex]}`)
    if (aR >= R_NEW) continue
    const half = Math.max(apex - cl[0], cl.at(-1) - apex) + 6
    for (let k = Math.max(1, apex - half); k <= Math.min(n - 2, apex + half); k++) {
      const dx = r.x[k] - cx, dz = r.z[k] - cz, d = Math.hypot(dx, dz) || 1
      if (d >= R_NEW) continue
      const w = 0.5 + 0.5 * Math.cos((Math.PI * (k - apex)) / (half + 1)) // smooth: full at the apex, 0 past the window
      const push = (R_NEW - d) * w
      r.x[k] = +(r.x[k] + (dx / d) * push).toFixed(2)
      r.z[k] = +(r.z[k] + (dz / d) * push).toFixed(2)
    }
    for (const p of all) if (p.r === r) (p.x = r.x[p.k]), (p.z = r.z[p.k])
  }
  bays += ks.filter((k, i) => i === 0 || k !== ks[i - 1] + 1).length
  const hw = r.halfWidth * 0.75, reach = hw + BAY + BLEND
  const mine = new Set(ks)
  const done = new Set()
  for (const k of ks) {
    const i0 = Math.round((r.x[k] + HALF) / ST), j0 = Math.round((r.z[k] + HALF) / ST), rc = Math.ceil(reach / ST)
    for (let j = j0 - rc; j <= j0 + rc; j++) {
      for (let i = i0 - rc; i <= i0 + rc; i++) {
        if (i < 0 || j < 0 || i >= N || j >= N || done.has(j * N + i)) continue
        const x = -HALF + i * ST, z = -HALF + j * ST
        // the nearest sample of the whole network must be one of this hairpin's
        let best = null, bd = Infinity
        for (const p of all) {
          const d = Math.hypot(p.x - x, p.z - z)
          if (d < bd) (bd = d), (best = p)
        }
        if (bd > reach || best.r !== r || !mine.has(best.k)) continue
        done.add(j * N + i)
        if (bd <= hw + 1) continue // the bed is already flat (roads.py)
        const roadH = r.h[best.k] + OFF
        const w = bd <= hw + BAY ? 1 : 1 - (bd - hw - BAY) / BLEND
        const h0 = get(i, j)
        set(i, j, h0 + (roadH - h0) * w * w * (3 - 2 * w))
        cells++
      }
    }
  }
  console.log(`${r.name}: ${ks.length} hairpin samples`)
}
fs.writeFileSync(file, buf)
fs.writeFileSync(path.join(dir, 'map.json'), JSON.stringify(m))
console.log(`bays ${bays}, cells reshaped ${cells}`)
