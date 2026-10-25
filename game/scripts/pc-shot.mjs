// Headless-Chrome probe of the PLAYCANVAS build (branch `playcanvas`; needs `npm run dev`): loads /pc.html, waits for
// the streaming to settle, measures the GPU (the engine's GPU timer queries, median over ~2 s of uncapped frames),
// CPU, draws and memory, and saves a screenshot — the same conditions as `npm run shot` with UNCAPPED=1 (vsync and the
// frame-rate limit off: the GPU runs at full clocks).
//   node scripts/pc-shot.mjs <outdir> [query…]      e.g.  node scripts/pc-shot.mjs out map=zhangjiajie hour=11
//   env: PORT (5173), W/H (1280×720), CHROME, GAME=1 (the whole game at /?play=1 instead of the world viewer)
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'

const [outDir, ...q] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const CHROME = process.env.CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const ANGLE = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'gl'
const W = Number(process.env.W || 1280), H = Number(process.env.H || 720)
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', `--use-angle=${ANGLE}`, '--ignore-gpu-blocklist', '--enable-gpu-rasterization', `--window-size=${W},${H}`, '--mute-audio'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('console', (m) => { const t = m.text(); if (/error|Failed/i.test(t)) console.log('[console]', t.slice(0, 1500)) })
const GAME = process.env.GAME === '1'
const url = GAME
  ? `http://localhost:${process.env.PORT || 5173}/?${['play=1', 'adaptive=0', ...q].join('&')}`
  : `http://localhost:${process.env.PORT || 5173}/pc.html?${['dpr=1', ...q].join('&')}`
const t0 = Date.now()
await page.goto(url, { waitUntil: 'load' })
if (GAME) await page.waitForFunction(() => window.__game && window.__game.store.get().worldReady && window.__game.world.pending === 0, { timeout: 120_000, polling: 200 })
else await page.waitForFunction(() => window.__pc && window.__pc.terrain.count > 0 && window.__pc.terrain.pending === 0 && window.__pc.terrain.count >= 9, { timeout: 120_000, polling: 200 })
const loadMs = Date.now() - t0
await new Promise((r) => setTimeout(r, 2500)) // (shaders compiled, cascades warm)
const info = await page.evaluate(async () => {
  const app = window.__game ? window.__game.app : window.__pc.app
  const world = window.__game ? window.__game.world : window.__pc.terrain
  const P = app.graphicsDevice.gpuProfiler
  P.enabled = true
  const gpu = [], cpu = []
  let frames = 0
  const h = () => { frames++; if (P._frameTime > 0) gpu.push(P._frameTime); cpu.push(app.stats.frame.updateTime + app.stats.frame.renderTime) }
  app.on('frameend', h)
  const t = performance.now()
  await new Promise((r) => setTimeout(r, 2000))
  app.off('frameend', h)
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : null }
  const s = app.stats
  const mem = performance.memory
  return {
    fps: +((frames * 1000) / (performance.now() - t)).toFixed(0), gpuMs: med(gpu), cpuMs: med(cpu),
    draws: s.drawCalls.total, chunks: world.count, tier: window.__game?.quality.name,
    vramMB: +((s.vram.tex + s.vram.vb + s.vram.ib) / 1048576).toFixed(1), jsMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(0) : null,
    shaderCompileMs: +(app.graphicsDevice._shaderStats?.compileTime ?? 0).toFixed(0),
  }
})
const name = q.join('_').replace(/[^\w=.-]/g, '') || 'pc'
await page.screenshot({ path: path.join(outDir, `${name}.png`) })
console.log(name, JSON.stringify({ ...info, loadMs }))
await browser.close()
