// UNCAPPED FRAME COST BY PART (headless Chrome on the real GPU, vsync and the frame limit off — needs `npm run dev`):
// loads a map at a quality tier, stands at a spot, warms up (shaders, streaming), then measures what each part costs:
// for every part, the median GPU frame time (timer query) with it OFF vs ON, as interleaved pairs, three times (the GPU's clocks drift —
// a single before / after lies). Prints ms per part and the base frame.
//   node scripts/pc-cost.mjs [map=zhangjiajie] [tier=ultra] [at=x,z,yaw] [w=1920] [h=1080]
import puppeteer from 'puppeteer-core'

const opt = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')))
const MAP = opt.map ?? 'zhangjiajie', TIER = opt.tier ?? 'ultra'
const W = +(opt.w ?? 1920), H = +(opt.h ?? 1080)
const [AX, AZ, AYAW] = (opt.at ?? '-133,1808,-1.97').split(',').map(Number)
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 0,
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${W},${H}`, '--mute-audio'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`http://localhost:${process.env.PORT || 5173}/?play=1&adaptive=0&hour=11&net=0&map=${MAP}&tier=${TIER}&costmode=${opt.mode ?? 'gpu'}`, { waitUntil: 'load' })
await page.waitForFunction(() => window.__game?.store?.get().worldReady && window.__game.world.pending === 0, { timeout: 180_000, polling: 250 })
const res = await page.evaluate(async (AX, AZ, AYAW) => {
  const g = window.__game, app = g.app, pl = g.player
  pl.body.setTranslation({ x: AX, y: g.world.fields.height(AX, AZ) + 1.5, z: AZ }, true)
  pl.yaw = AYAW
  pl.pitch = 0
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  await wait(4000)
  await new Promise((r) => { const f = () => (g.world.pending === 0 ? r() : setTimeout(f, 200)); f() })
  await wait(8000)
  // GPU: the engine's whole-frame timer query (GpuFrame — WebGL can't nest per-pass queries); CPU: app.tick's own time
  const prof = app.graphicsDevice.gpuProfiler
  prof.enabled = true
  let cpuAcc = 0, cpuN = 0
  const tick0 = app.tick
  app.tick = (ts, xr) => { const t = performance.now(); tick0(ts, xr); cpuAcc += performance.now() - t; cpuN++ }
  const MODE = `${new URLSearchParams(location.search).get('costmode') ?? 'gpu'}`
  const pc = window.pc ?? (await import('/node_modules/.vite/deps/playcanvas.js'))
  const meas = async (n = 90) => {
    if (MODE === 'interval') {
      await wait(300)
      const t = []
      await new Promise((res) => { let k = 0; const f = (ts) => { t.push(ts); if (++k < n + 1) requestAnimationFrame(f); else res() }; requestAnimationFrame(f) })
      const d = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b)
      lastCpu = 0
      return d[d.length >> 1]
    }
    await wait(300)
    const gs = []
    cpuAcc = cpuN = 0
    await new Promise((res) => { let k = 0; const f = () => { if (prof._frameTimeValid) gs.push(prof._frameTime); if (++k < n) requestAnimationFrame(f); else res() }; requestAnimationFrame(f) })
    gs.sort((a, b) => a - b)
    lastCpu = cpuAcc / Math.max(1, cpuN)
    return gs.length ? gs[gs.length >> 1] : NaN
  }
  let lastCpu = 0
  const parts = {}
  const key = app.root.findByName('keyLight').light
  parts.shadows = (on) => (key.castShadows = on)
  const wl = app.scene.layers.layerList.find((l) => l.name === 'World')
  const groups = {}
  for (const mi of wl.meshInstances) (groups[mi.material?.name || '?'] ??= []).push(mi)
  for (const [k, v] of Object.entries(groups)) parts['mat:' + k] = (on) => v.forEach((m) => (m.visible = on))
  // SHADER EXPERIMENTS (recompiled live): a chunk swapped for a stripped one, on vs off
  const mats = {}
  for (const mi of wl.meshInstances) if (mi.material?.name) mats[mi.material.name] = mi.material
  const swap = (mat, chunk, fn) => {
    if (!mat) return null
    const ch = mat.getShaderChunks(pc.SHADERLANGUAGE_GLSL), orig = ch.get(chunk)
    const alt = fn(orig)
    return (on) => { ch.set(chunk, on ? orig : alt); mat.update() }
  }
  const noDiscard = (src) => src.split('\n').filter((l) => !l.includes('discard')).join('\n')
  for (const name of ['cliffRock', 'terrain', 'rock']) {
    const f = swap(mats[name], 'diffusePS', noDiscard)
    if (f) parts['discard:' + name] = f
  }
  const fogOff = () => 'float dBlendModeFogFactor = 1.0;\nvec3 addFog(vec3 color) { return color; }\n'
  for (const name of ['cliffRock', 'terrain']) { const f = swap(mats[name], 'fogPS', fogOff); if (f) parts['fog:' + name] = f }
  const key2 = key
  const pcf = key2.shadowType
  parts.pcf5 = (on) => (key2.shadowType = on ? pcf : pc.SHADOW_PCF1_32F)
  const spot = app.root.findByName('spot')
  if (spot) parts.spotLight = (on) => (spot.enabled = on)
  const cam = app.root.findByName('camera').camera
  const all = cam.layers.slice()
  parts.sky = (on) => (cam.layers = on ? all : all.filter((id) => app.scene.layers.getLayerById(id)?.name !== 'Skybox'))
  const out = { base: [], info: { draws: app.stats.drawCalls?.total, canvas: app.graphicsDevice.width + 'x' + app.graphicsDevice.height, groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])) } }
  const cost = {}
  for (let rep = 0; rep < 3; rep++) {
    out.base.push(await meas()); (out.cpu ??= []).push(lastCpu)
    for (const [k, set] of Object.entries(parts)) {
      set(false); await wait(700); const off = await meas(60); set(true); await wait(700); const on = await meas(60)
      ;(cost[k] ??= []).push(on - off)
    }
  }
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1]
  out.gpuMs = +med(out.base).toFixed(2)
  out.cpuMs = +med(out.cpu).toFixed(2)
  delete out.base; delete out.cpu
  out.cost = Object.fromEntries(Object.entries(cost).map(([k, v]) => [k, +med(v).toFixed(2)]).sort((a, b) => b[1] - a[1]))
  out.stats = { tris: app.stats.frame.triangles, shadowMapTime: app.stats.frame.shadowMapTime, cull: app.stats.frame.cullTime }
  return out
}, AX, AZ, AYAW)
console.log(JSON.stringify(res, null, 1))
await browser.close()
