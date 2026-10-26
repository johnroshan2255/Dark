// OVER THE HILL — SCENERY on the baked valley (run after scripts/oth/terrain.py; plain Node, no Blender):
//
//   node scripts/oth/scenery.mjs [OUT=public/oth/valley] [BASE=node_modules/.cache/oth-valley-base] [PREVIEW=<png>]
//
// The user's reference (2026-10-26): a track squeezed between a wall of big smooth boulders (trees on the slope above)
// and a fast mountain STREAM, wooden bridges, cliffs and WATERFALLS — "lots of beautiful places like this". Over the
// baked terrain this adds:
//   STREAMS    traced downhill from hillside sources to the river / the lake / a pond (with a little inertia, so they
//              bend like water), the best few kept (long, a good drop, near the spawn and the tracks, spread apart);
//   WATERFALLS walking each stream up from its mouth the surface climbs gently (a run) — where that would leave the
//              channel cut deeper than a few metres into the hill it steps up at once: a FALL, a plunge pool at its
//              foot, the run below cut into a little gorge (steep rock walls); the steepest stream gets fewer, taller
//              falls (a grand one);
//   CHANNELS   carved into the ground (gravel bed, rock banks, gorge walls below the falls), the mask painted (water,
//              rocky banks, lush green margins, no forest in the channel, bare rock round the falls);
//   ROADS      along each stream's lower, drivable stretch on the side toward the nearest track (joined to it), carved
//              like the generator's tracks (a level bed, its shoulders blending out) and written into the trail field;
//              a WALL of big rounded boulders on its uphill side, the forest denser on the slope above;
//   BRIDGES    where a track crosses a new stream (a wooden deck over the channel); every bridge as wide as the road.
// It always starts from the pristine bake (BASE: copied from OUT on the first run, before any scenery), so running it
// again gives the same map. A new terrain.py bake → delete BASE, run this again.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ARGS = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes('=')).map((a) => a.split(/=(.*)/s).slice(0, 2)))
const OUT = ARGS.OUT ?? 'public/oth/valley'
const BASE = ARGS.BASE ?? 'node_modules/.cache/oth-valley-base'
const FILES = ['meta.json', 'height.bin', 'far.bin', 'mask.bin', 'trail.bin']
const T0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(5)}s]`, ...a)

// ------------------------------------------------------------------------------------------------- the pristine bake
if (!fs.existsSync(path.join(BASE, 'meta.json'))) {
  const m = JSON.parse(fs.readFileSync(path.join(OUT, 'meta.json'), 'utf8'))
  if (m.scenery) throw new Error(`${OUT} already has scenery and there is no pristine copy at ${BASE}: restore the bake first (git checkout ${OUT})`)
  fs.mkdirSync(BASE, { recursive: true })
  for (const f of FILES) fs.copyFileSync(path.join(OUT, f), path.join(BASE, f))
  log(`pristine bake saved to ${BASE}`)
}
const meta = JSON.parse(fs.readFileSync(path.join(BASE, 'meta.json'), 'utf8'))
const G = meta.inner, N = G.n, STEP = G.step, ORG = G.origin
const MG = meta.mask, MN = MG.n
const u16 = (f) => { const b = fs.readFileSync(path.join(BASE, f)); return new Uint16Array(b.buffer, b.byteOffset, b.length / 2) }
const hRaw = u16('height.bin'), farRaw = new Uint16Array(u16('far.bin'))
const H = new Float32Array(N * N)
for (let k = 0; k < N * N; k++) H[k] = (hRaw[k] / 65535) * G.range + G.min
const H0 = H.slice() // (the ground before any carving)
const M = new Uint8Array(fs.readFileSync(path.join(BASE, 'mask.bin')))
const TR = new Uint8Array(fs.readFileSync(path.join(BASE, 'trail.bin')))
const ROAD_HW = meta.trails.hw

// ------------------------------------------------------------------------------------------------------------ helpers
let seed = 0x5ce7e1
const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 2246822519) + 0x6d2b79f5) >>> 0) / 4294967296)
const smooth01 = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t) }
const smoothstep = (a, b, x) => smooth01((x - a) / (b - a))
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const sample = (A, n, step, org, x, z) => {
  const fx = clamp((x - org) / step, 0, n - 1.001), fz = clamp((z - org) / step, 0, n - 1.001)
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, k = j * n + i
  return (A[k] * (1 - u) + A[k + 1] * u) * (1 - v) + (A[k + n] * (1 - u) + A[k + n + 1] * u) * v
}
const height = (x, z) => sample(H, N, STEP, ORG, x, z)
const height0 = (x, z) => sample(H0, N, STEP, ORG, x, z)
const maskAt = (x, z, c) => {
  const i = clamp(Math.round((x - MG.origin) / MG.step), 0, MN - 1), j = clamp(Math.round((z - MG.origin) / MG.step), 0, MN - 1)
  return M[(j * MN + i) * 4 + c] / 255
}
const trailDist = (x, z) => {
  const i = Math.round((x - ORG) / STEP), j = Math.round((z - ORG) / STEP)
  return i < 0 || j < 0 || i >= N || j >= N ? 8 : (TR[j * N + i] / 255) * 8
}
const inBox = (x, z, m = 60) => Math.abs(x) < -ORG - m && Math.abs(z) < -ORG - m
/** Separable box blur (radius r cells), `passes` times. */
function blur(A, n, r, passes) {
  let a = A.slice(), b = new Float32Array(n * n)
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < n; j++) {
      let acc = 0
      for (let i = -r; i <= r; i++) acc += a[j * n + clamp(i, 0, n - 1)]
      for (let i = 0; i < n; i++) {
        b[j * n + i] = acc / (2 * r + 1)
        acc += a[j * n + Math.min(n - 1, i + r + 1)] - a[j * n + Math.max(0, i - r)]
      }
    }
    for (let i = 0; i < n; i++) {
      let acc = 0
      for (let j = -r; j <= r; j++) acc += b[clamp(j, 0, n - 1) * n + i]
      for (let j = 0; j < n; j++) {
        a[j * n + i] = acc / (2 * r + 1)
        acc += b[Math.min(n - 1, j + r + 1) * n + i] - b[Math.max(0, j - r) * n + i]
      }
    }
  }
  return a
}
/** Arc lengths of a polyline. */
const arcs = (P) => { const s = [0]; for (let k = 1; k < P.length; k++) s.push(s[k - 1] + Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1])); return s }
/** Resample a polyline every ~step m. */
function resample(P, step) {
  const s = arcs(P), L = s[s.length - 1], out = []
  const m = Math.max(1, Math.round(L / step))
  let k = 0
  for (let q = 0; q <= m; q++) {
    const t = (q / m) * L
    while (k < P.length - 2 && s[k + 1] < t) k++
    const f = s[k + 1] > s[k] ? (t - s[k]) / (s[k + 1] - s[k]) : 0
    out.push([P[k][0] + (P[k + 1][0] - P[k][0]) * f, P[k][1] + (P[k + 1][1] - P[k][1]) * f])
  }
  return out
}
const smoothLine = (P, k) => P.map((p, i) => {
  if (i === 0 || i === P.length - 1) return p
  let x = 0, z = 0, w = 0
  for (let d = -k; d <= k; d++) { const q = P[clamp(i + d, 0, P.length - 1)]; x += q[0]; z += q[1]; w++ }
  return [x / w, z / w]
})
/** For every 2 m cell within `reach` of the polyline P: fn(cellIndex, distance, arcLength, segment, t). The nearest
 *  segment wins (a scratch pass first). */
const _D = new Float32Array(N * N).fill(1e9), _S = new Float32Array(N * N), _K = new Float32Array(N * N)
function overLine(P, reach, fn) {
  const s = arcs(P), touched = []
  for (let k = 0; k < P.length - 1; k++) {
    const [ax, az] = P[k], [bx, bz] = P[k + 1], abx = bx - ax, abz = bz - az, l2 = abx * abx + abz * abz || 1e-9
    const i0 = clamp(Math.floor((Math.min(ax, bx) - reach - ORG) / STEP), 0, N - 1), i1 = clamp(Math.ceil((Math.max(ax, bx) + reach - ORG) / STEP), 0, N - 1)
    const j0 = clamp(Math.floor((Math.min(az, bz) - reach - ORG) / STEP), 0, N - 1), j1 = clamp(Math.ceil((Math.max(az, bz) + reach - ORG) / STEP), 0, N - 1)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = ORG + i * STEP, z = ORG + j * STEP
      const t = clamp(((x - ax) * abx + (z - az) * abz) / l2, 0, 1)
      const d = Math.hypot(x - ax - t * abx, z - az - t * abz)
      if (d > reach) continue
      const c = j * N + i
      if (_D[c] === 1e9) touched.push(c)
      if (d < _D[c]) { _D[c] = d; _S[c] = s[k] + t * Math.sqrt(l2); _K[c] = k + t }
    }
  }
  for (const c of touched) { fn(c, _D[c], _S[c], _K[c]); _D[c] = 1e9 }
}
const distToLine = (P, x, z) => {
  let best = 1e9
  for (let k = 0; k < P.length - 1; k++) {
    const [ax, az] = P[k], [bx, bz] = P[k + 1], abx = bx - ax, abz = bz - az, l2 = abx * abx + abz * abz || 1e-9
    const t = clamp(((x - ax) * abx + (z - az) * abz) / l2, 0, 1)
    best = Math.min(best, Math.hypot(x - ax - t * abx, z - az - t * abz))
  }
  return best
}

// ---------------------------------------------------------------------------------------------- water we flow into
const R = meta.water.river, LAKE = meta.water.lake, PONDS = meta.water.ponds ?? []
const RIVER = R.x.map((x, i) => [x, R.z[i]])
// (the nearest river point: an 8 m lookup grid of the nearest sample, refined over its neighbours)
const RG = 8, RN = Math.round((-2 * ORG) / RG) + 1, RIDX = new Int16Array(RN * RN)
for (let j = 0; j < RN; j++) for (let i = 0; i < RN; i++) {
  const x = ORG + i * RG, z = ORG + j * RG
  let bi = 0, bd = 1e18
  for (let q = 0; q < RIVER.length; q++) { const d = (RIVER[q][0] - x) ** 2 + (RIVER[q][1] - z) ** 2; if (d < bd) { bd = d; bi = q } }
  RIDX[j * RN + i] = bi
}
function nearestRiver(x, z) {
  const i = clamp(Math.round((x - ORG) / RG), 0, RN - 1), j = clamp(Math.round((z - ORG) / RG), 0, RN - 1), c = RIDX[j * RN + i]
  let bi = c, bd = 1e9
  for (let q = Math.max(0, c - 3); q <= Math.min(RIVER.length - 1, c + 3); q++) { const d = Math.hypot(RIVER[q][0] - x, RIVER[q][1] - z); if (d < bd) { bd = d; bi = q } }
  return { i: bi, d: bd }
}
const inEllipse = (P, x, z, k) => {
  const c = Math.cos(P.rot), s = Math.sin(P.rot), lx = (x - P.cx) * c + (z - P.cz) * s, lz = -(x - P.cx) * s + (z - P.cz) * c
  return Math.hypot(lx / (P.rx * k), lz / (P.rz * k)) < 1
}
/** Where a stream at (x, z) would end: the river, the lake or a pond (its surface level), else null. */
function mouthAt(x, z) {
  const r = nearestRiver(x, z)
  if (r.d < R.hw[r.i] * 0.8) return { kind: 'river', level: R.y[r.i] }
  if (inEllipse(LAKE, x, z, 1.25) && height0(x, z) < LAKE.level - 0.3) return { kind: 'lake', level: LAKE.level }
  for (const P of PONDS) if (inEllipse(P, x, z, 1.3) && height0(x, z) < P.level - 0.3) return { kind: 'pond', level: P.level }
  return null
}

// ----------------------------------------------------------------------------------------------------- the streams
log('streams: trace')
const HB = blur(H0, N, 3, 2) // (~12 m smoothing: the trace follows the valleys, not the 2 m bumps)
const hb = (x, z) => sample(HB, N, STEP, ORG, x, z)
const SP = meta.spawn
function trace(x, z) {
  const P = [[x, z]]
  let gx = hb(x + 4, z) - hb(x - 4, z), gz = hb(x, z + 4) - hb(x, z - 4), gl = Math.hypot(gx, gz) || 1
  let dx = -gx / gl, dz = -gz / gl, up = 0, prev = hb(x, z)
  for (let n = 0; n < 700; n++) {
    gx = hb(x + 4, z) - hb(x - 4, z); gz = hb(x, z + 4) - hb(x, z - 4); gl = Math.hypot(gx, gz)
    if (gl > 1e-3) { dx = dx * 0.62 - (gx / gl) * 0.38; dz = dz * 0.62 - (gz / gl) * 0.38 }
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l
    x += dx * 4; z += dz * 4
    if (!inBox(x, z)) return null
    P.push([x, z])
    const m = mouthAt(x, z)
    if (m) return { P, mouth: m }
    const h = hb(x, z)
    up = h > prev + 0.05 ? up + 1 : Math.max(0, up - 1)
    if (up > 8) return null // (a closed hollow: no way down)
    prev = Math.min(prev, h)
  }
  return null
}
const cands = []
for (let gz = -1880; gz <= 1880; gz += 56) for (let gx = -1880; gx <= 1880; gx += 56) {
  const x = gx + (rnd() - 0.5) * 40, z = gz + (rnd() - 0.5) * 40
  const r = nearestRiver(x, z)
  const rise = height0(x, z) - R.y[r.i]
  if (rise < 40 || rise > 170 || r.d < 220) continue
  if (maskAt(x, z, 0) > 0.6 || trailDist(x, z) < 7.5 || inEllipse(LAKE, x, z, 1.4)) continue // (the trail field tops out at 8 m)
  const t = trace(x, z)
  if (!t) continue
  const s = arcs(t.P), L = s[s.length - 1]
  if (L < 260 || L > 2400) continue
  const drop = height0(x, z) - t.mouth.level
  // steepness: the drop over the steepest 60 m (falls to come)
  let steep = 0
  for (let k = 0; k + 15 < t.P.length; k += 3) steep = Math.max(steep, (height0(...t.P[k]) - height0(...t.P[k + 15])) / 60)
  const dSpawn = Math.min(...t.P.filter((_, k) => k % 4 === 0).map((p) => Math.hypot(p[0] - SP.x, p[1] - SP.z)))
  let cross = 0, on = false
  for (const p of t.P) { const c = trailDist(p[0], p[1]) < ROAD_HW + 1; if (c && !on) cross++; on = c }
  const score = Math.min(L, 1500) / 1500 + Math.min(drop, 160) / 160 + Math.min(steep, 0.6) * 1.5 + 1.2 / (1 + dSpawn / 500) + (cross >= 1 && cross <= 3 ? 0.3 : cross > 3 ? -0.4 : 0)
  cands.push({ ...t, L, drop, steep, score })
}
cands.sort((a, b) => b.score - a.score)
const STREAMS = []
const sep = (A, B, d) => A.some((p, i) => i % 4 === 0 && B.some((q, j) => j % 4 === 0 && Math.hypot(p[0] - q[0], p[1] - q[1]) < d))
for (const c of cands) {
  if (STREAMS.length >= 7) break
  if (STREAMS.some((S) => sep(S.P, c.P, 320))) continue
  STREAMS.push(c)
}
log(`  ${cands.length} candidates → ${STREAMS.length} streams: ${STREAMS.map((S) => `${Math.round(S.L)} m / ${Math.round(S.drop)} m → ${S.mouth.kind}`).join(', ')}`)
// the steepest gets the GRAND falls
const grand = STREAMS.reduce((a, b) => (b.steep > a.steep ? b : a), STREAMS[0])

// ------------------------------------------------------------------- profile: runs and falls, mouth → source
const CUT = 0.9, DEPTH = 0.75
const streamsOut = [], fallsOut = [], bridgesNew = [], roadsOut = [], boulders = []
for (const S of STREAMS) {
  const P = smoothLine(resample(S.P, 4), 2).reverse() // (mouth first)
  const n = P.length, s = arcs(P), L = s[n - 1]
  const hw = s.map((v) => 5.0 - 1.8 * (v / L)) // (5 m half width at the mouth … 3.2 at the source)
  const g = P.map((p) => height0(p[0], p[1]))
  const gs = g.map((_, k) => { let a = 0, w = 0; for (let d = -2; d <= 2; d++) { a += g[clamp(k + d, 0, n - 1)]; w++ } return a / w })
  // where a track crosses: no fall within 18 m (a bridge goes there)
  const crossing = P.map((p) => trailDist(p[0], p[1]) < ROAD_HW + 1)
  const noFall = P.map((_, k) => crossing.some((c, j) => c && Math.abs(s[j] - s[k]) < 18))
  // RUNS climb like rapids (up to RUN of grade); where the cut would pass MAXCUT, a FALL. The grand stream climbs
  // gentler runs (taller falls); every stream at most 5 falls (MAXCUT raised until it fits)
  const RUN = S === grand ? 0.07 : 0.15
  let MAXCUT = S === grand ? 12 : 6.5, myFalls, c, lip
  for (;;) {
    c = new Float32Array(n); lip = new Uint8Array(n); myFalls = []
    c[0] = S.mouth.level
    let lastFall = -1e9
    for (let k = 1; k < n; k++) {
      const want = gs[k] - CUT
      c[k] = Math.max(c[k - 1], Math.min(c[k - 1] + RUN * (s[k] - s[k - 1]), want))
      if (want - c[k] > MAXCUT && s[k] - lastFall > 40 && !noFall[k] && s[k] > 30) {
        myFalls.push({ k, bottom: c[k], top: want, S })
        c[k] = want; lip[k] = 1; lastFall = s[k]
      }
    }
    if (myFalls.length <= 5) break
    MAXCUT *= 1.35
  }
  fallsOut.push(...myFalls)
  // the water level along the line, the falls as clean steps (a segment ending in a lip keeps its lower level)
  const levelAt = (seg) => { const k = Math.floor(seg), t = seg - k; if (k >= n - 1) return c[n - 1]; return lip[k + 1] ? c[k] : c[k] + (c[k + 1] - c[k]) * t }
  // below a lip: a little gorge (steep walls) and a plunge pool
  const sinceLip = (sv) => { let best = 1e9; for (const f of myFalls) { const d = s[f.k] - sv; if (d >= 0) best = Math.min(best, d) } return best }
  const hwAt = (seg) => hw[clamp(Math.round(seg), 0, n - 1)]
  Object.assign(S, { line: P, s, c, lip, levelAt, sinceLip, hwAt, hw, myFalls })
}

// ------------------------------------------------------------------------- roads along the streams (before carving)
log('stream roads')
const TRAIL_LINES = meta.trails.lines
function nearestTrailPoint(x, z) {
  let best = null, bd = 1e9
  for (const L of TRAIL_LINES) for (const p of L) { const d = Math.hypot(p[0] - x, p[1] - z); if (d < bd) { bd = d; best = p } }
  return { p: best, d: bd }
}
for (const S of STREAMS) {
  const P = S.line, n = P.length
  const norm = P.map((_, k) => { const a = P[Math.max(0, k - 2)], b = P[Math.min(n - 1, k + 2)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l] })
  // the side toward the nearest track at the mouth (no crossing to join it), unless that bank is water
  const t0 = nearestTrailPoint(P[0][0], P[0][1])
  let side = Math.sign((t0.p[0] - P[0][0]) * norm[3][0] + (t0.p[1] - P[0][1]) * norm[3][1]) || 1
  const off = (k) => S.hw[k] + 5.5 + ROAD_HW
  const sidePts = (sd) => P.map((p, k) => [p[0] + norm[k][0] * off(k) * sd, p[1] + norm[k][1] * off(k) * sd])
  const wet = (q) => mouthAt(q[0], q[1]) !== null || !inBox(q[0], q[1], 80)
  let pts = sidePts(side)
  if (pts.slice(4, 20).some(wet)) { side = -side; pts = sidePts(side) }
  // drivable: from the mouth up while the ground along it stays under ~22 %, never into water
  // (it starts where its bank is dry and clear of the river: not in the channel at the stream's mouth)
  const clear = (q) => !wet(q) && nearestRiver(q[0], q[1]).d > R.hw[nearestRiver(q[0], q[1]).i] * 1.9
  let start = 0
  while (start < n - 1 && !clear(pts[start])) start++
  let end = start
  // (the grade the carved road will have: the ground along it smoothed ±20 m)
  const g0 = pts.map((q) => height0(q[0], q[1])), gr = g0.map((_, k) => { let a = 0, w = 0; for (let d = -5; d <= 5; d++) { a += g0[clamp(k + d, 0, n - 1)]; w++ } return a / w })
  for (let k = start + 1; k < n; k++) {
    if (wet(pts[k])) break
    const a = Math.max(start, k - 4), grade = Math.abs(gr[k] - gr[a]) / Math.max(1, (k - a) * 4)
    if (grade > 0.25) break
    end = k
  }
  // (end a little past the foot of the first fall: a view up to it)
  const first = S.myFalls.length ? S.myFalls[0].k : n
  end = Math.min(end, first + 3)
  if (end - start < 30) { S.road = null; continue }
  let road = smoothLine(pts.slice(start, end + 1), 3)
  // join the network: a connector from the nearest track point to the road's start
  const j0 = nearestTrailPoint(road[0][0], road[0][1])
  let joined = false
  if (j0.d < 260 && j0.d > 4) {
    const conn = resample([j0.p, road[0]], 4)
    // (not through the stream, not into water)
    if (!conn.some((q) => distToLine(P, q[0], q[1]) < S.hw[0] * 1.6 || wet(q))) { road = [...conn.slice(0, -1), ...road]; joined = true }
  } else if (j0.d <= 4) joined = true
  road = resample(road, 4)
  S.road = { line: road, side, joined, wallFrom: joined ? Math.round(j0.d / 4) + 2 : 0 }
  log(`  stream ${STREAMS.indexOf(S)}: road ${Math.round(arcs(road).at(-1))} m on side ${side}${joined ? ', joined' : ' (not joined)'}`)
}

// carve the roads (a level bed from the smoothed ground, the shoulders blending out — the generator's tracks)
const ROAD_LINES = STREAMS.filter((S) => S.road).map((S) => S.road.line)
for (const Lr of ROAD_LINES) {
  const gr = Lr.map((q) => height0(q[0], q[1]))
  const k = 9, hc = gr.map((_, i) => { let a = 0, w = 0; for (let d = -k; d <= k; d++) { a += gr[clamp(i + d, 0, gr.length - 1)]; w++ } return a / w })
  const s = arcs(Lr)
  overLine(Lr, ROAD_HW + 6, (cell, d, sv, seg) => {
    const i = clamp(Math.floor(seg), 0, Lr.length - 2), t = seg - i
    const target = hc[i] + (hc[i + 1] - hc[i]) * t - 0.12 * (1 - smoothstep(0, ROAD_HW, d))
    const w = 1 - smoothstep(ROAD_HW + 0.5, ROAD_HW + 5.5, d)
    H[cell] += (target - H[cell]) * w
    TR[cell] = Math.min(TR[cell], Math.round(Math.min(1, d / 8) * 255))
    void s
  })
  TRAIL_LINES.push(Lr.filter((_, i) => i % 2 === 0).map((q) => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]))
}

// ------------------------------------------------------------------------------------------------ bridges
log('bridges')
const BW = ROAD_HW * 2 + 1
const bridges = (meta.bridges ?? []).map((b) => ({ ...b, w: Math.round(BW * 100) / 100 }))
for (const S of STREAMS) {
  const P = S.line
  let k = 0
  while (k < P.length) {
    if (trailDist(P[k][0], P[k][1]) >= ROAD_HW + 1) { k++; continue }
    let k1 = k
    while (k1 + 1 < P.length && trailDist(P[k1 + 1][0], P[k1 + 1][1]) < ROAD_HW + 1) k1++
    const m = Math.round((k + k1) / 2), [cx, cz] = P[m]
    // the track's direction there: the nearest two points of its line
    let best = null, bd = 1e9
    for (const L of TRAIL_LINES) for (let i = 0; i < L.length - 1; i++) {
      const d = Math.hypot(L[i][0] - cx, L[i][1] - cz)
      if (d < bd) { bd = d; best = [L[i], L[i + 1]] }
    }
    if (best && bd < 30) {
      let dx = best[1][0] - best[0][0], dz = best[1][1] - best[0][1]
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l
      const half = S.hw[m] * 1.8 + 4
      bridges.push({ x0: +(cx - dx * half).toFixed(2), z0: +(cz - dz * half).toFixed(2), x1: +(cx + dx * half).toFixed(2), z1: +(cz + dz * half).toFixed(2), y: +(height(cx, cz) + 0.25).toFixed(2), w: Math.round(BW * 100) / 100 })
      bridgesNew.push(bridges.at(-1))
    }
    k = k1 + 1
  }
}

// ------------------------------------------------------------------------------------------------- carve the streams
log('carve')
const HR = H.slice() // (the ground with the roads, before the streams: what the streams alone cut)
const BANK = 1.25, GORGE = 1.8 // (a V below each fall: steep, still open enough to see the fall from down the stream)
for (const S of STREAMS) {
  const P = S.line
  overLine(P, 34, (cell, d, sv, seg) => {
    const c = S.levelAt(seg), hw = S.hwAt(seg), below = S.sinceLip(sv)
    const pool = below < 10 ? 1 - below / 10 : 0
    const w = hw * (1 + 0.5 * pool), depth = DEPTH * (1 + 0.9 * pool)
    const bank = below < 28 ? GORGE : BANK
    const bed = c - depth + (depth + 0.25) * smooth01(d / w) + Math.max(0, d - w) * bank
    if (bed < H[cell]) H[cell] = bed
  })
}

// --------------------------------------------------------------------------------------------------- the mask
log('mask')
const setMask = (x, z, ch, v, mode) => {
  const i = Math.round((x - MG.origin) / MG.step), j = Math.round((z - MG.origin) / MG.step)
  if (i < 0 || j < 0 || i >= MN || j >= MN) return
  const k = (j * MN + i) * 4 + ch, q = Math.round(clamp(v, 0, 1) * 255)
  M[k] = mode === 'max' ? Math.max(M[k], q) : mode === 'min' ? Math.min(M[k], q) : q
}
for (const S of STREAMS) {
  const P = S.line, n = P.length
  for (let k = 0; k < n; k++) {
    const [x, z] = P[k], hw = S.hw[k], below = S.sinceLip(S.s[k])
    for (let dz = -40; dz <= 40; dz += 4) for (let dx = -40; dx <= 40; dx += 4) {
      const qx = Math.round((x + dx - MG.origin) / 4) * 4 + MG.origin, qz = Math.round((z + dz - MG.origin) / 4) * 4 + MG.origin
      const d = distToLine(P.slice(Math.max(0, k - 3), Math.min(n, k + 4)), qx, qz)
      if (d > 40) continue
      // (the 4 m mask: every band at least a texel wide)
      if (d < Math.max(hw * 0.8, 2.9)) setMask(qx, qz, 2, 1, 'max') // the water and its gravel
      else if (d < Math.max(hw * 1.7, 6.2)) setMask(qx, qz, 0, 0.95, 'max') // rocky banks
      if (d < hw * 4.5) { setMask(qx, qz, 1, 0.15 + 0.5 * smoothstep(hw * 1.5, hw * 4.5, d), 'min'); setMask(qx, qz, 2, 0.6, 'max') } // lush green margins
      if (d < hw * 2.2) setMask(qx, qz, 3, 0.05, 'min') // no forest in the channel
      void below
    }
  }
}
// bare ROCK where a stream cut the ground deep — the gorge walls below the falls, the cliffs at their lips — and nowhere
// else (not the roads' cuts)
for (let j = 0; j < MN; j++) for (let i = 0; i < MN; i++) {
  const c = j * 2 * N + i * 2, cut = HR[c] - H[c]
  if (cut > 1.0) { const k = (j * MN + i) * 4; M[k] = Math.max(M[k], Math.round(smoothstep(1.0, 2.6, cut) * 255)); M[k + 3] = Math.min(M[k + 3], 20) }
}

// ------------------------------------------------------------------- boulder walls and the forest above the roads
log('walls')
for (const S of STREAMS) {
  if (!S.road) continue
  const Lr = S.road.line, n = Lr.length
  for (let k = S.road.wallFrom + 1; k < n - 1; k++) {
    if (rnd() < 0.06) continue // (a gap now and then)
    const a = Lr[k - 1], b = Lr[k + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    let nx = -(b[1] - a[1]) / l, nz = (b[0] - a[0]) / l
    // the side away from the stream
    if (distToLine(S.line, Lr[k][0] + nx * 6, Lr[k][1] + nz * 6) < distToLine(S.line, Lr[k][0] - nx * 6, Lr[k][1] - nz * 6)) { nx = -nx; nz = -nz }
    const y0 = height(Lr[k][0], Lr[k][1])
    // (only where the ground rises there: a wall on the uphill cut)
    if (height0(Lr[k][0] + nx * 9, Lr[k][1] + nz * 9) < y0 + 0.3) continue
    if (bridgesNew.some((B) => Math.hypot((B.x0 + B.x1) / 2 - Lr[k][0], (B.z0 + B.z1) / 2 - Lr[k][1]) < 14)) continue
    // a continuous WALL (the reference): big rounded stones shoulder to shoulder along the road's edge, a second row
    // stacked behind and above most of the way, now and then a third
    const size = 3.5 + rnd() * 3.0, o = ROAD_HW + 1.0 + size * 0.42, j = (rnd() - 0.5) * 1.2
    const x = Lr[k][0] + nx * o + (b[0] - a[0]) / l * j, z = Lr[k][1] + nz * o + (b[1] - a[1]) / l * j
    boulders.push([+x.toFixed(2), +z.toFixed(2), +size.toFixed(2)])
    let o2 = o
    for (let row = 1; row <= 2; row++) {
      if (rnd() > (row === 1 ? 0.6 : 0.25)) break
      const s2 = 3.2 + rnd() * 3.4, j2 = (rnd() - 0.5) * 3
      o2 += size * 0.5 + s2 * 0.35
      boulders.push([+(Lr[k][0] + nx * o2 + (b[0] - a[0]) / l * j2).toFixed(2), +(Lr[k][1] + nz * o2 + (b[1] - a[1]) / l * j2).toFixed(2), +s2.toFixed(2)])
    }
    // the forest on the slope above
    for (let d = 10; d <= 40; d += 4) setMask(Lr[k][0] + nx * d, Lr[k][1] + nz * d, 3, 0.62, 'max')
  }
}
for (const S of STREAMS) {
  const P = S.line, n = P.length
  for (let k = 2; k < n - 1; k += 1) {
    if (rnd() > 0.32) continue
    const a = P[k - 1], b = P[k + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const side = rnd() < 0.5 ? -1 : 1, d = S.hw[k] * (0.55 + 0.7 * rnd()), size = 1.1 + rnd() * 2.2
    const x = P[k][0] - (b[1] - a[1]) / l * d * side, z = P[k][1] + (b[0] - a[0]) / l * d * side
    if (bridgesNew.some((B) => Math.hypot((B.x0 + B.x1) / 2 - x, (B.z0 + B.z1) / 2 - z) < 10)) continue
    boulders.push([+x.toFixed(2), +z.toFixed(2), +size.toFixed(2)])
  }
}
log(`  ${boulders.length} boulders`)

// -------------------------------------------------------------------------------------------------------- write
log('write')
const enc = (h, min, range) => clamp(Math.round(((h - min) / range) * 65535), 0, 65535)
const hOut = new Uint16Array(N * N)
for (let k = 0; k < N * N; k++) hOut[k] = enc(H[k], G.min, G.range)
// the world grid's box: the box's own heights (every 8th 2 m cell)
const F = meta.far, k0 = Math.round((ORG - F.origin) / F.step), farStride = F.step / STEP
for (let j = 0; j * farStride < N; j++) for (let i = 0; i * farStride < N; i++) farRaw[(k0 + j) * F.n + k0 + i] = enc(H[j * farStride * N + i * farStride], F.min, F.range)
const streamsMeta = [], fallsMeta = []
for (const S of STREAMS) {
  const P = S.line, n = P.length
  // one ribbon per run between falls (index 0 downstream)
  let a = 0
  const cutAt = [...S.myFalls.map((f) => f.k), n]
  for (const b of cutAt) {
    const idx = []; for (let k = a; k < b; k++) idx.push(k)
    // (a run below a fall reaches on to the cliff at its own level: the plunge pool's water right under the fall)
    const y = idx.map((k) => +S.c[k].toFixed(2)), x = idx.map((k) => +P[k][0].toFixed(1)), z = idx.map((k) => +P[k][1].toFixed(1)), hw = idx.map((k) => +S.hw[k].toFixed(2))
    if (b < n) { x.push(+P[b][0].toFixed(1)); z.push(+P[b][1].toFixed(1)); y.push(y.at(-1)); hw.push(hw.at(-1)) }
    if (x.length >= 2) streamsMeta.push({ x, z, y, hw })
    a = b
  }
  for (const f of S.myFalls) {
    const [x, z] = P[f.k], [bx, bz] = P[f.k - 1]
    fallsMeta.push({ x: +x.toFixed(1), z: +z.toFixed(1), y: +f.top.toFixed(2), bx: +bx.toFixed(1), bz: +bz.toFixed(1), by: +f.bottom.toFixed(2), hw: +(S.hw[f.k] * 0.85).toFixed(2) })
  }
}
const out = { ...meta, bridges, trails: { ...meta.trails, lines: TRAIL_LINES }, water: { ...meta.water, streams: streamsMeta, falls: fallsMeta }, scenery: { boulders } }
fs.writeFileSync(path.join(OUT, 'height.bin'), Buffer.from(hOut.buffer))
fs.writeFileSync(path.join(OUT, 'far.bin'), Buffer.from(farRaw.buffer))
fs.writeFileSync(path.join(OUT, 'mask.bin'), Buffer.from(M.buffer))
fs.writeFileSync(path.join(OUT, 'trail.bin'), Buffer.from(TR.buffer))
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(out))
log(`wrote ${OUT}: ${STREAMS.length} streams (${streamsMeta.length} runs), ${fallsMeta.length} falls (tallest ${Math.max(0, ...fallsMeta.map((f) => f.y - f.by)).toFixed(1)} m), ${ROAD_LINES.length} roads, ${bridgesNew.length} new bridges, ${boulders.length} boulders`)

// ------------------------------------------------------------------------------------------- preview (optional)
if (ARGS.PREVIEW) {
  const W = 1024, img = Buffer.alloc((W * 3 + 1) * W)
  for (let y = 0; y < W; y++) {
    img[y * (W * 3 + 1)] = 0
    for (let x = 0; x < W; x++) {
      const i = x * 2, j = y * 2, k = j * N + i
      const sx = (H[k + 1] - H[Math.max(0, k - 1)]) / 4, sz = (H[k + N < N * N ? k + N : k] - H[Math.max(0, k - N)]) / 4
      let v = clamp(0.62 - sx * 0.9 - sz * 0.6, 0, 1) * 200 + 30
      const mk = (y * MN + x) * 4, wet = M[mk + 2] / 255, rock = M[mk] / 255
      let c = [v * (0.75 + 0.2 * rock), v * (0.85 - 0.1 * rock), v * 0.7]
      if (wet > 0.9) c = [70, 140, 220]
      if (TR[k] < 90) c = [230, 190, 120]
      const o = y * (W * 3 + 1) + 1 + x * 3
      img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]
    }
  }
  const dot = (wx, wz, col, r) => {
    const px = Math.round((wx - ORG) / 4), pz = Math.round((wz - ORG) / 4)
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
      const X = px + a, Y = pz + b
      if (X < 0 || Y < 0 || X >= W || Y >= W) continue
      const o = Y * (W * 3 + 1) + 1 + X * 3; img[o] = col[0]; img[o + 1] = col[1]; img[o + 2] = col[2]
    }
  }
  for (const f of fallsMeta) dot(f.x, f.z, [255, 30, 200], 4)
  for (const b of bridgesNew) dot((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2, [140, 70, 20], 3)
  for (const b of boulders) dot(b[0], b[1], [90, 90, 110], 1)
  dot(SP.x, SP.z, [255, 0, 0], 5)
  const crcT = []; for (let q = 0; q < 256; q++) { let cc = q; for (let t = 0; t < 8; t++) cc = cc & 1 ? 0xedb88320 ^ (cc >>> 1) : cc >>> 1; crcT[q] = cc >>> 0 }
  const crc = (b) => { let r = 0xffffffff; for (const x of b) r = crcT[(r ^ x) & 0xff] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0 }
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(W, 4); ih[8] = 8; ih[9] = 2
  fs.writeFileSync(ARGS.PREVIEW, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(img)), chunk('IEND', Buffer.alloc(0))]))
  log(`preview ${ARGS.PREVIEW}`)
}
