// MAIN-THREAD CPU PROFILE of the PlayCanvas game (headless Chrome, uncapped — needs `npm run dev`): warms up at a spot,
// then samples the main thread with the DevTools profiler for SECS seconds and prints the hottest functions by self
// time and by file (ms per frame).   node scripts/pc-cpuprof.mjs [map=zhangjiajie] [tier=ultra] [secs=4] [at=x,z,yaw] [rain=1] [drive=1] [noshadow=1] [hide=matA,matB]
import puppeteer from 'puppeteer-core'

const opt = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')))
const MAP = opt.map ?? 'zhangjiajie', TIER = opt.tier ?? 'ultra', SECS = +(opt.secs ?? 4), RAIN = opt.rain === '1', DRIVE = opt.drive === '1', NOSHADOW = opt.noshadow === '1', HIDE = (opt.hide ?? '').split(',').filter(Boolean)
const [AX, AZ, AYAW] = (opt.at ?? '-133,1808,-1.97').split(',').map(Number)
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 0,
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${opt.w ?? 1920},${opt.h ?? 1080}`, '--mute-audio'],
  defaultViewport: { width: +(opt.w ?? 1920), height: +(opt.h ?? 1080), deviceScaleFactor: 1 },
})
const page = await browser.newPage()
await page.goto(`http://localhost:${process.env.PORT || 5173}/?play=1&adaptive=0&hour=11&net=0&map=${MAP}&tier=${TIER}`, { waitUntil: 'load' })
await page.waitForFunction(() => window.__game?.store?.get().worldReady && window.__game.world.pending === 0, { timeout: 180_000, polling: 250 })
await page.evaluate(async (AX, AZ, AYAW, RAIN, DRIVE, NOSHADOW, HIDE) => {
  if (NOSHADOW) window.__game.app.root.findByName('keyLight').light.castShadows = false
  const g = window.__game, pl = g.player
  // (rain=1: the storm at full strength, the ground soaked)
  if (RAIN) { g.weather.force = 'rain'; g.weather.rain = 0.9; g.weather.wet = 1 }
  if (!DRIVE) {
    pl.body.setTranslation({ x: AX, y: g.world.fields.height(AX, AZ) + 1.5, z: AZ }, true)
    pl.yaw = AYAW
  }
  await new Promise((r) => setTimeout(r, 12000))
  // (drive=1: in the car at the spawn road, full throttle — streaming, the car's systems, the chase camera)
  if (DRIVE) { g.car.seatNow(); await new Promise((r) => setTimeout(r, 1500)); window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' })) }
  // per-second timeline: fps and the worst frame (hitches)
  window.__tl = []
  let sec = performance.now(), n = 0, worst = 0, last = performance.now()
  const dev = g.app.graphicsDevice, shaders = () => dev.shaders?.length ?? 0
  let sh0 = shaders(), worstAt = ''
  // (a hitch's cause: what this frame did — shaders compiled, chunks built)
  let chunks0 = g.world.chunks.size
  const tick = () => {
    const t = performance.now(), d = t - last
    last = t; n++
    if (d > worst) { worst = d; worstAt = `sh+${shaders() - sh0} ch=${g.world.chunks.size - chunks0}` }
    if (t - sec >= 1000) { const p = g.car.root.position; window.__tl.push([n, +worst.toFixed(1), worstAt, Math.round(p.x), Math.round(p.z), g.world.pending]); n = 0; worst = 0; sec = t; sh0 = shaders(); chunks0 = g.world.chunks.size }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  // SHADERS MADE DURING THE SAMPLE: name, link wait (ms) — the first use of a material variant blocks the frame
  window.__shaders = []
  {
    const dev = g.app.graphicsDevice, mk = dev.createShaderImpl.bind(dev)
    dev.createShaderImpl = (shader) => {
      const impl = mk(shader)
      const fin = impl.finalize.bind(impl)
      impl.finalize = (d, sh) => { const t = performance.now(); const r = fin(d, sh); window.__shaders.push([sh.name, +(performance.now() - t).toFixed(1)]); return r }
      return impl
    }
  }
  // HITCH BREAKDOWN: every frame over 50 ms — its systems (GameLoop timings), the world / mirror / engine parts
  window.__hitches = []
  const acc = {}
  const wrap = (obj, fn, key) => { const o = obj[fn].bind(obj); obj[fn] = (...a) => { const t = performance.now(); const r = o(...a); acc[key] = (acc[key] ?? 0) + performance.now() - t; return r } }
  for (const [k, p] of Object.entries(g.world.pools)) if (p) { wrap(p, 'growV', 'grow.' + k + '.V'); wrap(p, 'growI', 'grow.' + k + '.I') }
  wrap(g.world, 'update', 'world.update'); wrap(g.mirror, 'sync', 'mirror.sync'); wrap(g.env, 'update', 'env.update')
  const fs0 = g.app.stats.frame
  let fl = performance.now()
  // first-time drawn mesh instances (ANGLE compiles the D3D shader / input layout at a program's first draw)
  const seen = new WeakSet()
  const firsts = () => {
    const out = []
    for (const l of g.app.scene.layers.layerList) for (const mi of l.meshInstances ?? []) {
      if (!mi.visible || seen.has(mi)) continue
      seen.add(mi)
      out.push((mi.node?.name || '?').slice(0, 24) + '/' + (mi.material?.name || '?').slice(0, 28))
    }
    return out
  }
  firsts()
  g.app.on('frameend', () => {
    const t = performance.now(), d = t - fl
    fl = t
    const fresh = firsts()
    if (d > 50) {
      const parts = { fresh: fresh.slice(0, 12).join(', '), ...acc, 'engine.update': fs0.updateTime, 'engine.render': fs0.renderTime, shadersCompiled: fs0.shaders }
      if (g.loop.timings) for (const [k, v] of g.loop.timings) parts['loop.' + k] = v
      window.__hitches.push([+d.toFixed(0), Object.fromEntries(Object.entries(parts).filter(([k, v]) => k === 'fresh' || v > 2).map(([k, v]) => [k, k === 'fresh' ? v : +(+v).toFixed(1)]))])
    }
    for (const k in acc) acc[k] = 0
  })
  window.__frames = 0
  g.app.on('frameend', () => window.__frames++)
  // (hide=matA,matB: those materials' mesh instances off — what they cost, as a whole-run A/B)
  if (HIDE.length) g.app.on('update', () => { for (const l of g.app.scene.layers.layerList) for (const mi of l.meshInstances ?? []) if (HIDE.includes(mi.material?.name)) mi.visible = false })
}, AX, AZ, AYAW, RAIN, DRIVE, NOSHADOW, HIDE)
const cdp = await page.createCDPSession()
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
await page.evaluate(() => (window.__frames = 0))
await cdp.send('Profiler.start')
await new Promise((r) => setTimeout(r, SECS * 1000))
const { profile } = await cdp.send('Profiler.stop')
const frames = await page.evaluate(() => window.__frames)
const tl = await page.evaluate(() => window.__tl)
console.log('shaders made:', JSON.stringify(await page.evaluate(() => window.__shaders)))
console.log('hitches:', JSON.stringify(await page.evaluate(() => window.__hitches)))
console.log('timeline [fps, worst ms, (shaders compiled / chunks added that second), x, z, chunks pending]:', JSON.stringify(tl))
const byId = new Map(profile.nodes.map((n) => [n.id, n]))
const self = new Map()
const dt = profile.timeDeltas
for (let i = 0; i < profile.samples.length; i++) {
  const n = byId.get(profile.samples[i])
  self.set(n.id, (self.get(n.id) ?? 0) + (dt[i] ?? 0))
}
const fn = new Map(), file = new Map()
for (const [id, us] of self) {
  const n = byId.get(id), cf = n.callFrame
  const f = (cf.url || '').replace(/^.*\/(src|node_modules|@fs)\//, '$1/').replace(/\?.*$/, '')
  const k = `${cf.functionName || '(anon)'}  ${f}:${cf.lineNumber + 1}`
  fn.set(k, (fn.get(k) ?? 0) + us)
  const fk = f || cf.functionName
  file.set(fk, (file.get(fk) ?? 0) + us)
}
const per = (us) => (us / 1000 / frames).toFixed(3)
console.log(`frames ${frames} in ${SECS} s → ${(frames / SECS).toFixed(1)} fps`)
console.log('--- by file (ms / frame)')
for (const [k, v] of [...file].sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log(per(v).padStart(7), k)
console.log('--- by function (ms / frame)')
for (const [k, v] of [...fn].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(per(v).padStart(7), k)
await browser.close()
