// DRIVE PROBE (dev-only: needs `npm run dev`): an autopilot drives the car along a fixed map's roads (and
// straight off-road) through the analog stick, and logs every time it gets STUCK (under throttle, < 0.5 m/s for
// 2.5 s) or is thrown OFF the road (> half width + 3 m from the centre line for 1.5 s) — then is set down further
// along the road and goes on. It also logs the frame rate every second (where it drops: FPS < FPS_LOW).
//   node scripts/drive-probe.mjs [outdir] [runs.json]
//   env: PORT (5173), MAP (island), TIER (low; '' = the map's default), SPEED (km/h, 35), FULL=1 (every road of the
//        map end to end, instead of runs.json / the default mix), HEADLESS=0 (a visible Chrome window — it is never
//        throttled in the background), CHROME (the browser), STOP=1 (stop a run at its first stuck), FPS_LOW (50)
// runs.json: [{ road: '<map road name>', from: 0..1, to?: 0..1, secs }, { offroad: true, x, z, yaw, secs }] (default:
// a mix of every biome). Prints per run: distance, stuck / off-road events (x, z); writes <outdir>/probe.json (runs +
// fps samples) + a shot per stuck run.
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const outDir = process.argv[2] || 'probe-out'
fs.mkdirSync(outDir, { recursive: true })
const DEFAULT = [
  { road: 'summit_road', from: 0.0, secs: 40 }, { road: 'summit_west', from: 0.55, secs: 40 }, { road: 'lake_road', from: 0.2, secs: 40 },
  { road: 'snow_north', from: 0.1, secs: 30 }, { road: 'mesa_trail', from: 0.3, secs: 35 }, { road: 'canyon_road', from: 0.1, secs: 35 },
  { road: 'dune_dome_switchbacks', from: 0.05, secs: 35 }, { road: 'forest_far', from: 0.0, secs: 35 }, { road: 'forest_to_desert', from: 0.4, secs: 35 },
  { road: 'coast_highway', from: 0.5, secs: 30 }, { road: 'mesa_cliff_road', from: 0.2, secs: 35 },
  { offroad: true, x: 520, z: 520, yaw: 0.8, secs: 25 }, { offroad: true, x: 600, z: -380, yaw: 2.2, secs: 25 },
  { offroad: true, x: -600, z: -700, yaw: -0.6, secs: 25 }, { offroad: true, x: -200, z: 500, yaw: 1.2, secs: 25 },
]
const MAP = process.env.MAP || 'island'
const SPEED = Number(process.env.SPEED || 35)
const FULL = process.env.FULL === '1'
const FPS_LOW = Number(process.env.FPS_LOW || 50)
const CHROME = process.env.CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const headless = process.env.HEADLESS === '0' ? false : 'new'
const browser = await puppeteer.launch({
  executablePath: CHROME, headless, protocolTimeout: 0,
  args: [...(process.platform === 'darwin' ? ['--use-angle=metal'] : []), '--ignore-gpu-blocklist', '--window-size=1280,760', '--mute-audio',
    // a visible window keeps full speed when another window has the focus
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  defaultViewport: headless ? { width: 960, height: 540 } : null,
})
const page = (await browser.pages())[0] ?? (await browser.newPage())
const errors = new Map()
page.on('pageerror', (e) => { if (errors.size === 0 && !errors.first) { errors.first = true; console.log('[first pageerror]', e.message, '\n', e.stack) } const k = e.message + ' @ ' + (e.stack || '').split('\n').slice(1, 4).join(' | '); errors.set(k, (errors.get(k) ?? 0) + 1) })
const tier = process.env.TIER ?? 'low'
await page.goto(`http://localhost:${process.env.PORT || 5173}/?map=${MAP}${tier ? `&tier=${tier}` : ''}&net=0&adaptive=0&hour=11&play=1`, { waitUntil: 'load' })
await page.waitForFunction(() => window.__game && window.__game.worldReadiness() >= 1, { timeout: 180_000, polling: 250 })
page.on('console', (m) => { if (m.type() === 'error' && process.env.VERBOSE) console.log('[console.error]', m.text().slice(0, 600)) })
const runs = FULL
  ? (await page.evaluate(() => window.__game.map.roads.map((r) => ({ road: r.key.replace(/^map:/, ''), len: r.cum[r.n - 1] }))))
    .map((r) => ({ road: r.road, from: 0, to: 1, secs: Math.round((r.len / (SPEED / 3.6)) * 2.5 + 60) }))
  : process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : DEFAULT
const results = []
const fpsAll = []
for (const [ri, run] of runs.entries()) {
  console.log(`-> ${run.road ?? 'offroad'} (${run.secs} s max)`)
  const res = await page.evaluate(async (run, speedKmh, stopAtStuck) => {
    const g = window.__game, f = g.world.fields
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const V = Object.getPrototypeOf(g.player.curr).constructor
    const roads = g.map?.roads ?? []
    const road = run.road ? roads.find((r) => r.key === `map:${run.road}`) : null
    if (run.road && !road) return { error: `no road ${run.road}` }
    const L = road ? road.cum[road.n - 1] : 0
    const at = (s) => { // point + tangent at arclength s
      s = Math.max(0, Math.min(L, s))
      let i = 0
      while (i < road.n - 2 && road.cum[i + 1] < s) i++
      const l = road.cum[i + 1] - road.cum[i], t = l > 0 ? Math.min(1, Math.max(0, (s - road.cum[i]) / l)) : 0
      return { x: road.xs[i] + (road.xs[i + 1] - road.xs[i]) * t, z: road.zs[i] + (road.zs[i + 1] - road.zs[i]) * t, dx: road.xs[i + 1] - road.xs[i], dz: road.zs[i + 1] - road.zs[i] }
    }
    // put the car down at (x, z, yaw): a fresh car if it is damaged (a wreck swaps the car — always read g.car)
    const place = async (x, z, yaw) => {
      // Let the chunks round it stream in (physics only runs where colliders exist).
      g.player.teleport(new V(x, f.height(x, z) + 1, z))
      await sleep(2500)
      if (g.car.damage.level > 40 || g.car.damage.wrecked) {
        const old = g.car
        g.respawnCar() // (async: loads the model, then swaps the car)
        for (let i = 0; i < 100 && g.car === old; i++) await sleep(100)
      }
      const car = g.car
      car.park(x, z, yaw)
      car.near = true
      if (!car.driving) car.seatNow()
      g.cameraCtl.vehicle = { distance: 9, pivot: 2.9 }
      await sleep(600)
    }
    const placeOnRoad = (s) => { const p = at(s); return place(p.x, p.z, Math.atan2(-p.dx, -p.dz)) }
    let s = road ? L * run.from : 0
    const sEnd = road ? L * (run.to ?? 1) : 0
    if (road) await placeOnRoad(s)
    else await place(run.x, run.z, run.yaw)
    const target = speedKmh / 3.6
    const inp = g.input
    let stall = 0, offT = 0, dist = 0, last = null, t0 = performance.now(), prev = t0, frames = 0, fpsT = t0
    const stuck = [], off = [], fps = []
    let respawns = 0
    await new Promise((done) => {
      const tick = () => { step().catch((e) => { console.error('probe', e && e.stack); done() }) }
      const step = async () => {
        let car = g.car
        const now = performance.now(), dt = Math.min(0.1, (now - prev) / 1000)
        prev = now
        frames++
        const p = car.pos, v = car.sim.speed
        if (last) dist += Math.hypot(p.x - last.x, p.z - last.z)
        last = { x: p.x, z: p.z }
        if (now - fpsT >= 1000) {
          const info = g.renderer.info.render
          fps.push({ s: Math.round(s), x: Math.round(p.x), z: Math.round(p.z), fps: Math.round((frames * 1000) / (now - fpsT)), calls: info.calls, tris: info.triangles })
          frames = 0
          fpsT = now
        }
        let steer = 0, bd = 0
        if (road) {
          // progress: the nearest road point near the last s (a window, so switchbacks don't jump legs)
          let best = s
          bd = Infinity
          for (let q = s - 15; q <= s + 25; q += 1) {
            const a = at(q), d = Math.hypot(a.x - p.x, a.z - p.z)
            if (d < bd) (bd = d), (best = q)
          }
          s = Math.max(0, best)
          const look = at(s + 4 + Math.abs(v) * 0.6) // (a driver looks closer in a slow tight bend)
          const want = Math.atan2(-(look.x - p.x), -(look.z - p.z))
          let d = want - car.heading
          while (d > Math.PI) d -= 2 * Math.PI
          while (d < -Math.PI) d += 2 * Math.PI
          steer = Math.max(-1, Math.min(1, -d * 2.2)) // (+ steer = right; heading + = left)
          if (s >= sEnd - 6) return done()
          // thrown off the road (over an edge, round a bend it couldn't hold): set down 10 m on
          offT = bd > road.halfWidth + 3 ? offT + dt : 0
          if (offT > 1.5) {
            off.push({ s: Math.round(s), x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1), d: +bd.toFixed(1) })
            if (stopAtStuck) return done()
            offT = stall = 0
            s += 10
            await placeOnRoad(s)
            last = null
            prev = fpsT = performance.now()
            frames = 0
            return requestAnimationFrame(tick)
          }
        }
        // slow for the bends ahead like a driver would (≤ 3.5 m/s² sideways): the tightest radius in the next 30 m
        let want = target
        if (road) {
          for (let q = s + 2; q < s + 30; q += 4) {
            const a = at(q - 4), b = at(q + 4)
            let dA = Math.atan2(b.dx, b.dz) - Math.atan2(a.dx, a.dz)
            dA = Math.atan2(Math.sin(dA), Math.cos(dA))
            if (Math.abs(dA) > 1e-3) want = Math.min(want, Math.max(3, Math.sqrt(3.5 * (8 / Math.abs(dA)))))
          }
        }
        const pedal = Math.max(-1, Math.min(1, (want - v) * 0.35 + 0.25))
        inp.touchMove.x = steer
        inp.touchMove.y = pedal
        stall = pedal > 0.3 && Math.abs(v) < 0.5 ? stall + dt : 0
        if (stall > 2.5) {
          // what holds it: wheels on the ground, tilt, damage, and the colliders each body collider touches
          const sim = car.sim, w = g.physics.world, b = sim.body, touch = []
          for (let ci = 0; ci < b.numColliders(); ci++) {
            const c = b.collider(ci), mine = c.collisionGroups() >>> 16, hits = []
            w.contactPairsWith(c, (o) => hits.push(o))
            for (const o of hits) {
              let n = 0
              w.contactPair(c, o, (m) => { n += m.numContacts() })
              if (n) touch.push(`${mine.toString(16)}→${(o.collisionGroups() >>> 16).toString(16)}:${o.shape.type}×${n}`)
            }
          }
          const r = b.rotation(), upY = 1 - 2 * (r.x * r.x + r.z * r.z)
          stuck.push({ s: Math.round(s), x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1), ground: +f.height(p.x, p.z).toFixed(1), t: +((now - t0) / 1000).toFixed(1),
            wheels: sim.wheels.map((q) => (q.contact ? 1 : 0)).join(''), upY: +upY.toFixed(2), dmg: Math.round(car.damage.level), touch })
          if (stopAtStuck) return done()
          stall = 0
          respawns++
          // on a road: past the spot (a respawn in place would stick again); off-road: back on its wheels here
          if (road) {
            s += 20
            await placeOnRoad(s)
            last = null
            prev = fpsT = performance.now()
            frames = 0
          } else car.respawnHere()
        }
        if (now - t0 > run.secs * 1000) return done()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    inp.touchMove.x = 0
    inp.touchMove.y = 0
    return { run: run.road ?? `offroad ${run.x},${run.z}`, len: Math.round(L), reached: Math.round(s), dist: Math.round(dist), stuck, off, respawns, fps, end: { x: +g.car.pos.x.toFixed(1), z: +g.car.pos.z.toFixed(1) } }
  }, run, SPEED, !!process.env.STOP)
  results.push(res)
  if (res.fps) for (const q of res.fps) fpsAll.push({ run: res.run, ...q })
  const lowN = res.fps?.filter((q) => q.fps < FPS_LOW).length ?? 0
  console.log(`${String(ri).padStart(2)} ${res.error ?? `${res.run.padEnd(24)} ${String(res.dist).padStart(5)} m  reached ${res.reached}/${res.len}  stuck ${res.stuck.length}  off ${res.off.length}  low-fps s ${lowN}${[...res.stuck.map((q) => 'STUCK ' + JSON.stringify(q)), ...res.off.map((q) => 'OFF   ' + JSON.stringify(q))].map((l) => '\n     ' + l).join('')}`}`)
  if (res.stuck?.length) await page.screenshot({ path: `${outDir}/stuck-${ri}.png` })
  fs.writeFileSync(`${outDir}/probe.json`, JSON.stringify({ results, fps: fpsAll }, null, 1))
}
const total = results.reduce((a, r) => a + (r.stuck?.length ?? 0), 0), offs = results.reduce((a, r) => a + (r.off?.length ?? 0), 0), km = results.reduce((a, r) => a + (r.dist ?? 0), 0) / 1000
for (const [k, n] of errors) console.log(`[pageerror ×${n}] ${k}`)
const fpsSorted = fpsAll.map((q) => q.fps).sort((a, b) => a - b)
if (fpsSorted.length) console.log(`FPS median ${fpsSorted[fpsSorted.length >> 1]}, p5 ${fpsSorted[Math.floor(fpsSorted.length * 0.05)]}, min ${fpsSorted[0]}; below ${FPS_LOW}: ${fpsAll.filter((q) => q.fps < FPS_LOW).length} s`)
for (const q of fpsAll.filter((q) => q.fps < FPS_LOW)) console.log(`  low fps ${q.fps} at ${q.x},${q.z} (${q.run} s ${q.s}) draws ${q.calls} tris ${q.tris}`)
console.log(`TOTAL ${km.toFixed(2)} km, stuck ${total}, off-road ${offs} (${((total + offs) / Math.max(0.01, km)).toFixed(2)} per km)`)
await browser.close()
