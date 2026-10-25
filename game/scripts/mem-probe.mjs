// MEMORY PROBE (needs `npm run dev`): loads the game headless, lets the world stream in, then reports where the RAM is —
// the page's JS heap, every worker's JS heap (chunk streaming, horizon, landmarks…), the large ArrayBuffers / wasm
// memories reachable from the page, the GPU memory PlayCanvas tracks, and Chrome's own per-process memory (browser,
// renderer, GPU process) from the system. `engine=three` measures the three build.
//   node scripts/mem-probe.mjs [query…]      e.g.  node scripts/mem-probe.mjs map=zhangjiajie tier=high
import puppeteer from 'puppeteer-core'
import { execSync } from 'node:child_process'

const q = process.argv.slice(2)
const CHROME = process.env.CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const ANGLE = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'gl'
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', `--use-angle=${ANGLE}`, '--ignore-gpu-blocklist', '--window-size=1280,720', '--mute-audio', '--enable-precise-memory-info'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`http://localhost:${process.env.PORT || 5173}/?${['play=1', 'adaptive=0', 'hour=11', ...q].join('&')}`, { waitUntil: 'load' })
await page.waitForFunction(() => window.__game && window.__game.store.get().worldReady, { timeout: 180_000, polling: 250 })
await new Promise((r) => setTimeout(r, Number(process.env.SETTLE ?? 15000)))
const MB = (b) => +(b / 1048576).toFixed(1)
const main = await page.createCDPSession()
await main.send('HeapProfiler.collectGarbage')
const mh = await main.send('Runtime.getHeapUsage')
console.log(`page JS heap: used ${MB(mh.usedSize)} MB  total ${MB(mh.totalSize)} MB  embedder ${MB(mh.embedderHeapUsedSize ?? 0)} MB  backingStorage ${MB(mh.backingStorageSize ?? 0)} MB`)
let wsum = 0
for (const w of page.workers()) {
  try {
    const s = await w.client.send('Runtime.getHeapUsage')
    wsum += s.usedSize + (s.backingStorageSize ?? 0)
    console.log(`worker ${w.url().replace(/^.*\/src\//, 'src/').slice(0, 60)}: used ${MB(s.usedSize)} MB  total ${MB(s.totalSize)} MB  backingStorage ${MB(s.backingStorageSize ?? 0)} MB`)
  } catch (e) {
    console.log('worker', w.url(), 'n/a', e.message)
  }
}
console.log(`workers: ${page.workers().length}, JS+buffers ${MB(wsum)} MB`)
const extra = await page.evaluate(() => {
  const g = window.__game
  const out = {}
  const app = g.app
  if (app) {
    const v = app.stats.vram
    out.vramMB = +((v.tex + v.vb + v.ib) / 1048576).toFixed(1)
    out.vramTexMB = +(v.tex / 1048576).toFixed(1)
    out.vramGeoMB = +((v.vb + v.ib) / 1048576).toFixed(1)
  }
  const R = g.physics?.R
  // the Rapier wasm memory
  try {
    const mem = Object.values(R).find((x) => x && x.memory instanceof WebAssembly.Memory)?.memory
    if (mem) out.rapierWasmMB = +(mem.buffer.byteLength / 1048576).toFixed(1)
  } catch { /* */ }
  return out
})
console.log('engine / wasm:', JSON.stringify(extra))
// Chrome's processes (Windows: working set per chrome.exe launched by this probe)
if (process.platform === 'win32') {
  try {
    const pid = browser.process().pid
    const ps = execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} -or $_.ProcessId -eq ${pid} } | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, [math]::Round($_.WorkingSetSize/1MB,1), (($_.CommandLine -split '--type=')[1] -split ' ')[0] }"`, { encoding: 'utf8' })
    let total = 0
    for (const line of ps.trim().split(/\r?\n/)) {
      const [, mb, type] = line.trim().split(/\s+/)
      total += Number(mb)
      console.log(`  process ${type || 'browser'}: ${mb} MB`)
    }
    console.log(`Chrome total working set: ${total.toFixed(0)} MB`)
  } catch (e) {
    console.log('process list failed', e.message)
  }
}
await browser.close()
