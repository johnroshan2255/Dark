// Bots in headless Chrome: opens a room with N bots (needs `npm run dev` + the server: `cd ../server && cargo run
// --release -p dark-server -- --dev`), then watches them — screenshots + fps / GPU ms / draws per spot.
// usage: node scripts/bots-probe.mjs <outdir> [bots=100] [tier=ultra] [mobile=0] [map=island]   env UNCAPPED=1, THROTTLE=4 (CPU ×)
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
const [out, nBots = '100', tier = 'ultra', mobile = '0', map = 'island'] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', protocolTimeout: 600_000,
  args: [...(process.env.UNCAPPED ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []), '--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--enable-gpu-rasterization'],
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('PAGEERR', String(e).slice(0, 300)))
if (mobile === '1') await page.emulate({ viewport: { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36' })
else await page.setViewport({ width: 1600, height: 900 })
if (process.env.THROTTLE) await (await page.createCDPSession()).send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE) })
await page.evaluateOnNewDocument((n) => localStorage.setItem('dark.room.setup', JSON.stringify({ name: 'Bot party', private: false, maxPlayers: 100, roadkill: true, flying: true, bots: n })), Number(nBots))
const q = map === 'world' ? 'seed=7' : `map=${map}`
await page.goto(`http://localhost:5173/?${q}&play=1&tier=${tier}&adaptive=0&hour=11`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__game?.store.get().worldReady && window.__game.store.get().net.status === 'online', { timeout: 180_000, polling: 300 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(Number(process.env.WAIT ?? 12) * 1000) // bots spawn (4 per tick), spread out, start doing things
const stats = () => page.evaluate(() => {
  const g = window.__game, s = g.perf?.stats ?? {}
  const net = g.store.get().net
  return { fps: s.fps, gpuMs: s.gpuMs?.toFixed?.(2), cpuMs: s.cpuMs?.toFixed?.(2), draws: s.drawCalls, tris: s.triangles, tier: g.quality.name, remotes: g.remotes.count, roster: net.players.length, dpr: g.post?.targetHeight }
})
const bots = () => page.evaluate(() => {
  const g = window.__game, out = []
  for (const r of g.remotes.remotes.values()) if (r.bot && r.visible) out.push({ id: r.id, name: r.name, x: r.pos.x, y: r.pos.y, z: r.pos.z, yaw: r.yaw, flags: r.flags, speed: r.speed, dist: r.dist })
  return out
})
// look at a few bots: cars on the road, someone on foot, a boat, a flyer
const all = await bots()
console.log('visible bots', all.length, 'flags histogram', all.reduce((h, b) => ((h[b.flags] = (h[b.flags] ?? 0) + 1), h), {}))
const pick = (f) => all.filter(f).sort((a, b) => a.dist - b.dist)[0]
const targets = [
  ['car', pick((b) => (b.flags & 1) && !(b.flags & 2) && !(b.flags & 128) && b.speed > 5)],
  ['foot', pick((b) => !(b.flags & 1))],
  ['boat', pick((b) => b.flags & 2)],
  ['air', pick((b) => b.flags & 128)],
  ['crowd', pick((b) => b.flags & 1)],
]
console.log('start', JSON.stringify(await stats()))
for (const [name, b] of targets) {
  if (!b) { console.log(name, 'none'); continue }
  // stand 14 m behind-left of the bot, looking at it (third person)
  await page.evaluate((b) => {
    const g = window.__game, p = g.player
    const fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw)
    const x = b.x - fx * 16 + fz * 6, z = b.z - fz * 16 - fx * 6
    const y = g.world.fields.surface(x, z)
    p.teleport(new (Object.getPrototypeOf(p.curr).constructor)(x, Math.max(y, -6) + 0.2, z))
    p.yaw = Math.atan2(-(b.x - x), -(b.z - z))
    p.pitch = b.flags & 128 ? 0.35 : -0.05
  }, b)
  await page.waitForFunction(() => window.__game.world.stats.pending === 0, { timeout: 30_000, polling: 200 }).catch(() => {})
  await sleep(1500)
  await page.screenshot({ path: `${out}/${name}.png` })
  console.log(name, b.name, `flags ${b.flags} speed ${b.speed.toFixed(1)}`, JSON.stringify(await stats()))
}
// stats over 10 s at the crowd spot
const samples = []
for (let i = 0; i < 10; i++) { await sleep(1000); samples.push(await stats()) }
const avg = (k) => (samples.reduce((s, x) => s + Number(x[k] ?? 0), 0) / samples.length).toFixed(2)
console.log(`10 s average: fps ${avg('fps')} gpu ${avg('gpuMs')} ms cpu ${avg('cpuMs')} ms draws ${avg('draws')} tris ${avg('tris')}`)
console.log('server', await (await fetch('http://localhost:7350/metrics')).text().then((t) => t.split('\n').filter((l) => /dark_bots_active|dark_tick_seconds_(sum|count)/.test(l)).join(' | ')))
await browser.close()
