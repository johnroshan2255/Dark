// Headless-Chrome screenshot / probe harness (dev-only: needs `npm run dev` and window.__game).
//   npm run shot -- <outdir> <shots.json>        env: PORT (5173), W/H (1280×720)
// shots.json: [{ name, seed, tier, hour, look, x, z, yaw, pitch, cam: 'fpp'|'tpp', drive, keys, keysMs, wait, eval }]
//   x/z teleport the player (yaw/pitch aim; forward = (−sin yaw, −cos yaw)), `drive` parks the truck there and gets in,
//   `keys` are held for keysMs (e.g. ["KeyW"] to drive), `eval` is a JS body run with `g` = the Game (returned as info.eval).
// Prints per shot: position, ground height, chunks, tier, fps, GPU/CPU ms, draws, tris → use it to verify a
// change at a spot AND to measure its cost per tier (see skills/profiling). Uses the local Google Chrome (Metal GPU).
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'

const [outDir, shotsFile] = process.argv.slice(2)
const shots = JSON.parse(fs.readFileSync(shotsFile, 'utf8'))
fs.mkdirSync(outDir, { recursive: true })
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const W = Number(process.env.W || 1280), H = Number(process.env.H || 720)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', `--window-size=${W},${H}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('console', (m) => { const t = m.text(); if (/error|warn|GL_|WebGL/i.test(t)) console.log('[console]', t.slice(0, 300)) })

let loadedUrl = ''
for (const s of shots) {
  const url = `http://localhost:${process.env.PORT || 5173}/?seed=${s.seed ?? 7}&tier=${s.tier ?? 'high'}&adaptive=0&hour=${s.hour ?? 11}&play=1${s.look ? `&look=${s.look}` : ''}`
  if (url !== loadedUrl) {
    await page.goto(url, { waitUntil: 'load' })
    loadedUrl = url
    await page.waitForFunction(() => window.__game && window.__game.worldReadiness() >= 1, { timeout: 90_000, polling: 200 })
  }
  const t0 = Date.now()
  await page.evaluate(async (s) => {
    const g = window.__game
    const p = g.player
    if (s.hour !== undefined) { g.tod.hours = s.hour; g.tod.dayLengthMinutes = 0 }
    if (s.cam) g.updateSettings({ camera: s.cam })
    if (s.x !== undefined) {
      const y = g.world.fields.height(s.x, s.z) + 0.2
      p.teleport(new (Object.getPrototypeOf(p.curr).constructor)(s.x, y, s.z))
    }
    if (s.yaw !== undefined) p.yaw = s.yaw
    if (s.pitch !== undefined) p.pitch = s.pitch
    if (s.drive) {
      const f = g.world.fields
      g.car.park(s.x, s.z, s.yaw ?? 0)
      // enter the car (unless the previous shot left us in it)
      g.car.near = true
      if (!g.car.driving) g.car.toggle()
      g.cameraCtl.vehicle = g.car.driving ? { distance: 9, pivot: 2.9 } : null
    }
    if (s.flashlight !== undefined) g.lighting.flashlightOn = s.flashlight
    if (s.nightmare) g.tod.setNightmare(true)
  }, s)
  // wait for streaming to settle at the new spot
  await page.waitForFunction(() => window.__game.worldReadiness() >= 1 && window.__game.world.stats.pending === 0, { timeout: 60_000, polling: 100 }).catch(() => console.log('  (readiness timeout)'))
  await new Promise((r) => setTimeout(r, s.wait ?? 1200))
  if (s.keys) {
    // hold keys for a while (driving): dispatch keydown, wait, keyup
    for (const k of s.keys) await page.keyboard.down(k)
    await new Promise((r) => setTimeout(r, s.keysMs ?? 3000))
    for (const k of s.keys) await page.keyboard.up(k)
    await new Promise((r) => setTimeout(r, 300))
  }
  const info = await page.evaluate((s) => {
    const g = window.__game
    const p = g.player.curr
    const out = { pos: [p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1)], ground: g.world.fields.height(p.x, p.z).toFixed(1), chunks: g.world.stats.loaded, physics: g.world.stats.physicsChunks, tier: g.quality.name, fps: g.perf?.stats.fps, gpuMs: g.perf?.stats.gpuMs?.toFixed?.(2), cpuMs: g.perf?.stats.cpuMs?.toFixed?.(2), draws: g.perf?.stats.drawCalls, tris: g.perf?.stats.triangles }
    if (s.eval) out.eval = new Function('g', s.eval)(g)
    return out
  }, s)
  const file = path.join(outDir, `${s.name}.png`)
  await page.screenshot({ path: file })
  console.log(s.name, JSON.stringify(info), `${Date.now() - t0} ms`)
}
await browser.close()
