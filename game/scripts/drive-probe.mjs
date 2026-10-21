// Headless DRIVE PROBE (dev-only: needs `npm run dev`): an autopilot drives the car along a fixed map's roads (and
// straight off-road) through the analog stick, and logs every time it gets STUCK (under throttle, < 0.5 m/s for
// 2.5 s) — then presses Respawn and goes on, like a player would.
//   node scripts/drive-probe.mjs [outdir] [runs.json]        env: PORT (5173), MAP (island), TIER (low), SPEED (km/h, 35)
// runs.json: [{ road: '<map road name>', from: 0..1, secs }, { offroad: true, x, z, yaw, secs }] (default: a mix of
// every biome). Prints per run: distance, stuck events (x, z), respawns; writes <outdir>/probe.json + a shot per stuck.
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
const runs = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : DEFAULT
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 600_000, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--window-size=960,540', '--mute-audio'], defaultViewport: { width: 960, height: 540 } })
const page = await browser.newPage()
const errors = new Map()
page.on('pageerror', (e) => { if (errors.size === 0 && !errors.first) { errors.first = true; console.log('[first pageerror]', e.message, '\n', e.stack) } const k = e.message + ' @ ' + (e.stack || '').split('\n').slice(1, 4).join(' | '); errors.set(k, (errors.get(k) ?? 0) + 1) })
await page.goto(`http://localhost:${process.env.PORT || 5173}/?map=${process.env.MAP || 'island'}&tier=${process.env.TIER || 'low'}&adaptive=0&hour=11&play=1`, { waitUntil: 'load' })
await page.waitForFunction(() => window.__game && window.__game.worldReadiness() >= 1, { timeout: 120_000, polling: 250 })
page.on('console', (m) => { if (m.type() === 'error' && process.env.VERBOSE) console.log('[console.error]', m.text().slice(0, 600)) })
const results = []
for (const [ri, run] of runs.entries()) {
  const res = await page.evaluate(async (run, speedKmh, stopAtStuck) => {
    const g = window.__game, f = g.world.fields
    // a fresh car per run (damage carries over otherwise; a wreck swaps the car — always read g.car, never keep it)
    if (g.car.damage.level > 40 || g.car.damage.wrecked) {
      const old = g.car
      g.respawnCar() // (async: loads the model, then swaps the car)
      for (let i = 0; i < 100 && g.car === old; i++) await new Promise((r) => setTimeout(r, 100))
    }
    let car = g.car
    const roads = g.map?.roads ?? []
    const road = run.road ? roads.find((r) => r.key === `map:${run.road}`) : null
    if (run.road && !road) return { error: `no road ${run.road}` }
    const at = (s) => { // point + tangent at arclength s
      let i = 0
      while (i < road.n - 2 && road.cum[i + 1] < s) i++
      const l = road.cum[i + 1] - road.cum[i], t = l > 0 ? Math.min(1, Math.max(0, (s - road.cum[i]) / l)) : 0
      return { x: road.xs[i] + (road.xs[i + 1] - road.xs[i]) * t, z: road.zs[i] + (road.zs[i + 1] - road.zs[i]) * t, dx: road.xs[i + 1] - road.xs[i], dz: road.zs[i + 1] - road.zs[i] }
    }
    let x, z, yaw
    if (road) {
      const p = at(road.cum[road.n - 1] * run.from)
      x = p.x; z = p.z; yaw = Math.atan2(-p.dx, -p.dz)
    } else ({ x, z, yaw } = run)
    // Let the chunks round the start stream in (physics only runs where colliders exist).
    g.player.teleport(new (Object.getPrototypeOf(g.player.curr).constructor)(x, f.height(x, z) + 1, z))
    await new Promise((r) => setTimeout(r, 2500))
    car.park(x, z, yaw)
    car.near = true
    if (!car.driving) car.seatNow()
    g.cameraCtl.vehicle = { distance: 9, pivot: 2.9 }
    await new Promise((r) => setTimeout(r, 600))
    const target = speedKmh / 3.6
    const inp = g.input
    let s = road ? road.cum[road.n - 1] * run.from : 0
    let stall = 0, dist = 0, last = null, t0 = performance.now(), prev = t0
    const stuck = []
    let respawns = 0
    await new Promise((done) => {
      const tick = () => { try { step() } catch (e) { console.error('probe', e && e.stack); done() } }
      const step = () => {
        car = g.car
        const now = performance.now(), dt = Math.min(0.1, (now - prev) / 1000)
        prev = now
        const p = car.pos, v = car.sim.speed
        if (last) dist += Math.hypot(p.x - last.x, p.z - last.z)
        last = { x: p.x, z: p.z }
        let steer = 0
        if (road) {
          // progress: the nearest road point near the last s (a window, so switchbacks don't jump legs)
          let best = s, bd = Infinity
          for (let q = s - 15; q <= s + 25; q += 1) {
            const a = at(Math.max(0, Math.min(road.cum[road.n - 1], q))), d = Math.hypot(a.x - p.x, a.z - p.z)
            if (d < bd) (bd = d), (best = q)
          }
          s = Math.max(0, best)
          const look = at(Math.min(road.cum[road.n - 1], s + 9 + Math.abs(v) * 0.6))
          const want = Math.atan2(-(look.x - p.x), -(look.z - p.z))
          let d = want - car.heading
          while (d > Math.PI) d -= 2 * Math.PI
          while (d < -Math.PI) d += 2 * Math.PI
          steer = Math.max(-1, Math.min(1, -d * 2.2)) // (+ steer = right; heading + = left)
          if (s >= road.cum[road.n - 1] - 6) return done()
        }
        const pedal = Math.max(-1, Math.min(1, (target - v) * 0.35 + 0.25))
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
          stuck.push({ x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1), t: +((now - t0) / 1000).toFixed(1),
            wheels: sim.wheels.map((q) => (q.contact ? 1 : 0)).join(''), upY: +upY.toFixed(2), dmg: Math.round(car.damage.level), touch })
          if (stopAtStuck) return done()
          stall = 0
          window.__probeShot = stuck.length
          car.respawnHere()
          respawns++
        }
        if (now - t0 > run.secs * 1000) return done()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    inp.touchMove.x = 0
    inp.touchMove.y = 0
    if (stopAtStuck && stuck.length) g.cameraCtl.vehicle = { distance: 9, pivot: 2.9 }
    return { run: run.road ?? `offroad ${run.x},${run.z}`, dist: Math.round(dist), stuck, respawns, end: { x: +car.pos.x.toFixed(1), z: +car.pos.z.toFixed(1) } }
  }, run, Number(process.env.SPEED || 35), !!process.env.STOP)
  results.push(res)
  console.log(`${String(ri).padStart(2)} ${res.error ?? `${res.run.padEnd(24)} ${String(res.dist).padStart(5)} m  stuck ${res.stuck.length}${res.stuck.length ? '\n     ' + res.stuck.map((q) => JSON.stringify(q)).join('\n     ') : ''}`}`)
  if (res.stuck?.length) await page.screenshot({ path: `${outDir}/stuck-${ri}.png` })
}
const total = results.reduce((a, r) => a + (r.stuck?.length ?? 0), 0), km = results.reduce((a, r) => a + (r.dist ?? 0), 0) / 1000
for (const [k, n] of errors) console.log(`[pageerror ×${n}] ${k}`)
console.log(`TOTAL ${km.toFixed(2)} km, stuck ${total} (${(total / Math.max(0.01, km)).toFixed(2)} per km)`)
fs.writeFileSync(`${outDir}/probe.json`, JSON.stringify(results, null, 1))
await browser.close()
