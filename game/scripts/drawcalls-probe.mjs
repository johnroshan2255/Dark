// Draw-call breakdown in headless Chrome: which objects / passes cost the draws (needs `npm run dev`).
// usage: node scripts/drawcalls-probe.mjs [query=map=island] [tier=ultra]   env UNCAPPED=1, MOBILE=1
import puppeteer from 'puppeteer-core'
const [query = 'map=island', tier = 'ultra'] = process.argv.slice(2)
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', protocolTimeout: 600_000,
  args: [...(process.env.UNCAPPED ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []), '--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'],
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('PAGEERR', String(e).slice(0, 300)))
if (process.env.MOBILE) await page.emulate({ viewport: { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36' })
else await page.setViewport({ width: 1600, height: 900 })
await page.goto(`http://localhost:5173/?${query}&play=1&tier=${tier}&adaptive=0&hour=11`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__game?.store.get().worldReady, { timeout: 180_000, polling: 300 })
await page.waitForFunction(() => window.__game.world.stats.pending === 0, { timeout: 60_000, polling: 300 }).catch(() => {})
await new Promise((r) => setTimeout(r, Number(process.env.WAIT ?? 6) * 1000))
const out = await page.evaluate(async () => {
  const g = window.__game
  const R = g.renderer
  const counts = new Map()
  const tris = new Map()
  const orig = R.renderBufferDirect.bind(R)
  let frames = 0
  R.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    const rt = R.getRenderTarget()
    const pass = rt ? (rt.texture?.name || `${rt.width}x${rt.height}`) : 'screen'
    let o = object, path = o.name
    while (!path && o.parent) { o = o.parent; path = o.name }
    const key = `${pass} | ${path || object.type} | ${material.name || material.type}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    const idx = geometry.index ? geometry.index.count : geometry.attributes.position?.count ?? 0
    const inst = object.isInstancedMesh ? object.count : geometry.isInstancedBufferGeometry ? geometry.instanceCount : 1
    const pk = pass
    tris.set(pk, (tris.get(pk) ?? 0) + (idx / 3) * inst)
    return orig(camera, scene, geometry, material, object, group)
  }
  // shadow maps render through renderBufferDirect too (the shadow camera's pass has no render target name)
  await new Promise((res) => { const f = () => { if (++frames >= 30) res(); else requestAnimationFrame(f) }; requestAnimationFrame(f) })
  R.renderBufferDirect = orig
  const rows = [...counts.entries()].map(([k, v]) => [k, v / 30]).sort((a, b) => b[1] - a[1])
  const total = rows.reduce((s, r) => s + r[1], 0)
  return { tris: [...tris.entries()].map(([k, v]) => `${k}: ${(v / 30 / 1000).toFixed(0)}k tris`).join(' · '), total, info: g.perf.stats.drawCalls, rows: rows.slice(0, 45).map(([k, v]) => `${v.toFixed(1).padStart(6)}  ${k}`), groups: [...rows.reduce((m, [k, v]) => { const gk = k.replace(/chunk -?\d+,-?\d+/, 'chunk *').replace(/\d+$/, ''); m.set(gk, (m.get(gk) ?? 0) + v); return m }, new Map()).entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v.toFixed(1).padStart(6)}  ${k}`) }
})
console.log('draws/frame (renderBufferDirect)', out.total.toFixed(1), ' renderer.info', out.info)
console.log(out.tris)
console.log(out.groups.join('\n'))

await browser.close()
