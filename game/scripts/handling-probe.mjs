// Headless HANDLING PROBE (dev-only: needs `npm run dev`), on The Island:
//   STEER: from rest, full throttle along a flat open lane for 6 s (~60 km/h), then a full steering key for 2 s → how
//          far the car turned (°), its speed after, and the slip angle. (95 km/h: tests/drivetrain.test.ts)
//   CLIMB: parked nose-up on a hillside of 20…70° (dirt, sand, snow), held 1.5 s (stopped on the hill), then full
//          throttle for 8 s → metres climbed.
//   node scripts/handling-probe.mjs            env: PORT (5173), TIER (low)
// Uses the analog stick (input.touchMove: x steer, y pedal) like a phone; settings are the defaults (fresh profile).
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

// (an open lane: the mesa top and other flats have trees / rocks in the way)
const STEER = [{ name: 'beach (sand)', x: -512, z: 192, yaw: -Math.PI / 2, secs: 6 }]
// Hillsides per biome and slope (scripts/handling-spots.json: island cells whose slope holds within ±30 % over 20 m
// uphill); the first spot whose 25 m uphill lane is clear of trees / rocks / props is used.
const CLIMB = JSON.parse(fs.readFileSync(new URL('./handling-spots.json', import.meta.url), 'utf8')).filter((c) => c.spots.length)
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', protocolTimeout: 600_000, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'], defaultViewport: { width: 960, height: 540 } })
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`http://localhost:${process.env.PORT || 5173}/?map=island&tier=${process.env.TIER || 'low'}&adaptive=0&hour=11&play=1`, { waitUntil: 'load' })
await page.waitForFunction(() => window.__game && window.__game.worldReadiness() >= 1, { timeout: 120_000, polling: 250 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const prep = async (x, z) => page.evaluate(async (x, z) => {
  const g = window.__game
  if (g.car.damage.level > 20 || g.car.damage.wrecked) {
    const old = g.car
    g.respawnCar()
    for (let i = 0; i < 100 && g.car === old; i++) await new Promise((r) => setTimeout(r, 100))
  }
  g.player.teleport(new (Object.getPrototypeOf(g.player.curr).constructor)(x, g.world.fields.height(x, z) + 1, z))
  await new Promise((r) => setTimeout(r, 2500))
  return { offroadAssist: g.settings.offroadAssist, aids: g.settings.aids, handling: g.settings.handling }
}, x, z)

console.log('settings', JSON.stringify(await prep(STEER[0].x, STEER[0].z)))
for (const s of STEER) {
  await prep(s.x, s.z)
  const r = await page.evaluate(async (s) => {
    const g = window.__game, inp = g.input
    g.car.park(s.x, s.z, s.yaw)
    g.car.near = true
    if (!g.car.driving) g.car.seatNow()
    await new Promise((r) => setTimeout(r, 500))
    const t0 = performance.now()
    inp.touchMove.x = 0; inp.touchMove.y = 1
    let h0 = g.car.heading
    // hold the line while accelerating
    while (performance.now() - t0 < s.secs * 1000) {
      let d = s.yaw - g.car.heading
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      inp.touchMove.x = Math.max(-1, Math.min(1, -d * 3))
      await new Promise((r) => requestAnimationFrame(r))
    }
    const v0 = g.car.sim.speed * 3.6, t1 = performance.now()
    h0 = g.car.heading
    let turned = 0, prev = h0, maxSlip = 0
    inp.touchMove.x = 1 // full right
    while (performance.now() - t1 < 2000) {
      await new Promise((r) => requestAnimationFrame(r))
      let d = g.car.heading - prev
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      turned += d; prev = g.car.heading
      const sim = g.car.sim, lv = sim.body.linvel()
      maxSlip = Math.max(maxSlip, Math.abs(Math.atan2(sim.lateral, Math.max(1, Math.abs(sim.speed)))))
    }
    inp.touchMove.x = 0; inp.touchMove.y = 0
    return { v0: Math.round(v0), turned: Math.round((-turned * 180) / Math.PI), vEnd: Math.round(g.car.sim.speed * 3.6), slip: Math.round((maxSlip * 180) / Math.PI) }
  }, s)
  console.log(`STEER ${s.name.padEnd(18)} at ${r.v0} km/h: full key 2 s → turned ${r.turned}°, speed after ${r.vEnd} km/h, max slip ${r.slip}°`)
}
for (const { name, spots } of CLIMB) {
  let spot = null
  for (const [x, z, ux, uz] of spots) {
    await prep(x, z)
    const clear = await page.evaluate((x, z, ux, uz) => {
      const g = window.__game, R = g.physics.R, f = g.world.fields
      const yaw = Math.atan2(-ux, -uz), q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }
      for (let d = 0; d <= 24; d += 4) { // boxes along the lane, each on the ground there
        const px = x + ux * d, pz = z + uz * d
        const hit = g.physics.world.intersectionWithShape({ x: px, y: f.height(px, pz) + 1.4, z: pz }, q, new R.Cuboid(2, 1.2, 2.2), undefined, 0xffff0002, undefined, g.car.sim.body)
        if (hit) return false
      }
      return true
    }, x, z, ux, uz)
    if (clear) { spot = [x, z, ux, uz]; break }
  }
  if (!spot) { console.log(`CLIMB ${name.padEnd(11)} no clear lane among ${spots.length} spots`); continue }
  const [x, z, ux, uz] = spot
  const r = await page.evaluate(async (x, z, ux, uz) => {
    const g = window.__game, inp = g.input, f = g.world.fields
    const yaw = Math.atan2(-ux, -uz)
    const pitch = Math.atan((f.height(x + ux * 2, z + uz * 2) - f.height(x - ux * 2, z - uz * 2)) / 4)
    g.car.park(x, z, yaw)
    const y = g.car.pos.y
    g.car.sim.place(x, y + 0.15, z, yaw, pitch) // along the slope (park() sets it level: nose in the hill)
    g.car.near = true
    if (!g.car.driving) g.car.seatNow()
    await new Promise((r) => setTimeout(r, 1500))
    const p0 = { x: g.car.pos.x, y: g.car.pos.y, z: g.car.pos.z }
    const t0 = performance.now()
    inp.touchMove.y = 1
    while (performance.now() - t0 < 8000) {
      let d = yaw - g.car.heading
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      inp.touchMove.x = Math.max(-1, Math.min(1, -d * 2))
      await new Promise((r) => requestAnimationFrame(r))
    }
    inp.touchMove.x = 0; inp.touchMove.y = 0
    const p = g.car.pos
    return { up: +(p.y - p0.y).toFixed(1), along: +((p.x - p0.x) * ux + (p.z - p0.z) * uz).toFixed(1), slope: Math.round((pitch * 180) / Math.PI) }
  }, x, z, ux, uz)
  console.log(`CLIMB ${name.padEnd(11)} (ground ${r.slope}° along the car): ${r.along} m uphill, +${r.up} m height in 8 s  [${x}, ${z}]`)
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/climb-${name.replace(/[^a-z0-9]/gi, '')}.png` })
}
await browser.close()
