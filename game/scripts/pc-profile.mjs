// Headless CPU PROFILE of the PlayCanvas game (needs `npm run dev`): loads /?play=1, waits for the world, then for ~3 s
// averages every frame's CPU by part — each GameLoop system, the environment, the render bridge's sync, the engine's
// own update / cull / render — and prints a table (ms per frame). Also walks / drives during the sample when
// MOVE=walk|drive (streaming, grass refills, the car's systems).
//   node scripts/pc-profile.mjs [query…]      e.g.  MOVE=drive node scripts/pc-profile.mjs map=zhangjiajie tier=high
import puppeteer from 'puppeteer-core'

const q = process.argv.slice(2)
const CHROME = process.env.CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const ANGLE = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'gl'
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', `--use-angle=${ANGLE}`, '--ignore-gpu-blocklist', '--window-size=1280,720', '--mute-audio'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`http://localhost:${process.env.PORT || 5173}/?${['play=1', 'adaptive=0', 'hour=11', ...q].join('&')}`, { waitUntil: 'load' })
await page.waitForFunction(() => window.__game && window.__game.store.get().worldReady && window.__game.world.pending === 0, { timeout: 120_000, polling: 200 })
await new Promise((r) => setTimeout(r, 3000))
const out = await page.evaluate(async (move) => {
  const g = window.__game
  const acc = new Map()
  const add = (k, ms) => acc.set(k, (acc.get(k) ?? 0) + ms)
  const wrap = (obj, fn, key) => {
    const o = obj[fn].bind(obj)
    obj[fn] = (...a) => { const t = performance.now(); const r = o(...a); add(key, performance.now() - t); return r }
    return () => (obj[fn] = o)
  }
  const undo = [wrap(g.mirror, 'sync', 'mirror.sync'), wrap(g.env, 'update', 'env.update'), wrap(g.world, 'update', 'world.update'), wrap(g.grass, 'update', 'grass.update'), wrap(g.world.batcher, 'update', 'batcher.update')]
  let frames = 0
  const s = g.app.stats.frame
  const onEnd = () => {
    frames++
    for (const [k, v] of g.loop.timings) add('loop.' + k, v)
    add('engine.update(total)', s.updateTime)
    add('engine.render', s.renderTime)
    add('engine.cull', s.cullTime ?? 0)
  }
  g.app.on('frameend', onEnd)
  if (move === 'drive') {
    g.car.seatNow()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }))
  } else if (move === 'walk') window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }))
  await new Promise((r) => setTimeout(r, 3000))
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w' }))
  g.app.off('frameend', onEnd)
  undo.forEach((f) => f())
  return { frames, rows: [...acc].map(([k, v]) => [k, +(v / frames).toFixed(3)]).sort((a, b) => b[1] - a[1]) }
}, process.env.MOVE ?? '')
console.log(`frames ${out.frames}`)
for (const [k, v] of out.rows) console.log(k.padEnd(28), v.toFixed(3))
await browser.close()
