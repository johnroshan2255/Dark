// WORST CASE CROWD: everyone in one place — N cars and N people on foot (as room bots) driving / walking round the
// player within ~70 m, injected straight into RemotePlayers (offline; needs `npm run dev`). Prints fps, CPU / GPU ms,
// draws and triangles averaged over 10 s.
// usage: node scripts/crowd-probe.mjs <outdir> [cars=100] [people=100] [tier=ultra] [mobile=0]   env UNCAPPED=1, THROTTLE=4, PORT (5173)
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
const [out, cars = '100', people = '100', tier = 'ultra', mobile = '0'] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', protocolTimeout: 600_000,
  args: [...(process.env.UNCAPPED ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []), '--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'],
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('PAGEERR', String(e).slice(0, 300)))
if (mobile === '1') await page.emulate({ viewport: { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36' })
else await page.setViewport({ width: 1600, height: 900 })
const cdp = await page.createCDPSession()
await page.goto(`http://localhost:${process.env.PORT || 5173}/?map=island&net=0&play=1&tier=${tier}&adaptive=0&hour=11`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__game?.store.get().worldReady, { timeout: 180_000, polling: 300 })
await page.waitForFunction(() => window.__game.world.stats.pending === 0, { timeout: 60_000, polling: 300 }).catch(() => {})
await page.evaluate((nc, np) => {
  const g = window.__game, R = g.remotes
  const p = g.player.curr
  const cx = p.x, cz = p.z
  const names = ['Aarav', 'Meera', 'Kabir', 'Isha', 'Rohan', 'Anaya', 'Vihaan', 'Diya', 'Arjun', 'Saanvi']
  for (let k = 0; k < nc + np; k++) R.setName(0xc000 + k, names[k % names.length])
  const ents = []
  const tick = () => {
    const t = performance.now(), s = t / 1000
    ents.length = 0
    for (let k = 0; k < nc + np; k++) {
      const car = k < nc
      const r = car ? 18 + (k % 6) * 9 : 6 + (k % 10) * 6
      const w = (car ? 10 : 1.4) / r * (k % 2 ? 1 : -1)
      const a = s * w + k * 2.399
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r
      const vx = -Math.sin(a) * r * w, vz = Math.cos(a) * r * w
      const yaw = Math.atan2(-vx, -vz)
      ents.push({ id: 0xc000 + k, flags: car ? 33 : 0, model: car ? 1 + (k % 3) : 0, pos: [Math.round(x * 100), Math.round(g.world.fields.height(x, z) * 100), Math.round(z * 100)], yaw: Math.round(((yaw / (Math.PI * 2)) % 1 + 1) % 1 * 65535), pitch: 0, vel: [Math.round(vx * 100), 0, Math.round(vz * 100)] })
    }
    R.apply(t, ents, [])
  }
  setInterval(tick, 33)
  window.__crowdMs = 0
  const loop = () => {
    const t0 = performance.now()
    R.update(1 / 60, performance.now() + 100, g.camera.position, g.post.targetHeight)
    window.__crowdMs = window.__crowdMs * 0.95 + (performance.now() - t0) * 0.05
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  g.player.pitch = -0.12
}, Number(cars), Number(people))
if (process.env.NOSHADOW) await page.evaluate(() => setInterval(() => { for (const s of window.__game.remotes.carSets.values()) for (const m of [s.mid, s.far]) m.castShadow = false }, 200))
if (process.env.THROTTLE) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE) })
await new Promise((r) => setTimeout(r, 5000))
await page.screenshot({ path: `${out}/crowd-${tier}${mobile === '1' ? '-mobile' : ''}.png` })
console.log(await page.evaluate(() => {
  const R = window.__game.remotes, rows = [`remotes.update ${window.__crowdMs.toFixed(2)} ms`]
  const tri = (m) => (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3
  // (full-detail cars are RemoteCars — R.cars; the batches draw the simplified and far ones)
  rows.push(`full cars ${R.cars.size}`)
  for (const [k, s] of R.carSets) rows.push(`model ${k}: mid ${s.midN}×${tri(s.mid)} far ${s.farN}×${tri(s.far)}`)
  let chars = 0
  for (const r of R.remotes.values()) if (r.char) chars++
  rows.push(`characters ${chars} silhouettes ${R.proxies.count}×${tri(R.proxies)}`)
  return rows.join('\n')
}))
if (process.env.BREAKDOWN) console.log(await page.evaluate(async () => {
  const R = window.__game.renderer, tri = new Map()
  const orig = R.renderBufferDirect.bind(R)
  R.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    const rt = R.getRenderTarget()
    const pass = rt ? (rt.texture?.name || `${rt.width}x${rt.height}`) : 'screen'
    let o = object, path = o.name
    while (!path && o.parent) { o = o.parent; path = o.name }
    const idx = (geometry.index ? geometry.index.count : geometry.attributes.position?.count ?? 0) / 3
    const inst = object.isBatchedMesh ? 0 : object.isInstancedMesh ? object.count : geometry.isInstancedBufferGeometry ? geometry.instanceCount : 1
    const k = `${pass} | ${path.replace(/chunk -?\d+,-?\d+/, 'chunk')}`
    tri.set(k, (tri.get(k) ?? 0) + idx * inst)
    return orig(camera, scene, geometry, material, object, group)
  }
  await new Promise((res) => { let f = 0; const step = () => (++f >= 20 ? res() : requestAnimationFrame(step)); requestAnimationFrame(step) })
  R.renderBufferDirect = orig
  return [...tri.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => `${(v / 20 / 1000).toFixed(0).padStart(5)}k  ${k}`).join('\n')
}))
const samples = []
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  samples.push(await page.evaluate(() => { const s = window.__game.perf.stats; return { fps: s.fps, gpu: s.gpuMs, cpu: s.cpuMs, draws: s.drawCalls, tris: s.triangles } }))
}
const avg = (k) => samples.reduce((a, x) => a + (Number.isFinite(x[k]) ? x[k] : 0), 0) / samples.length
console.log(`${tier}${mobile === '1' ? ' mobile 844×390@3x' : ' desktop 1600×900'} ${cars} cars + ${people} people${process.env.THROTTLE ? ` CPU ×${process.env.THROTTLE}` : ''}: fps ${avg('fps').toFixed(1)} · CPU ${avg('cpu').toFixed(2)} ms · GPU ${avg('gpu').toFixed(2)} ms · draws ${avg('draws').toFixed(0)} · tris ${(avg('tris') / 1000).toFixed(0)}k`)
await browser.close()
