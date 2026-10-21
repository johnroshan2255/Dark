// Rooms check in headless Chrome (needs `npm run dev` and the server: `cd ../server && cargo run -p dark-server -- --dev`).
// usage: node scripts/rooms-touch.mjs <outdir>
import puppeteer from 'puppeteer-core'
const OUT = process.argv[2]
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', protocolTimeout: 300_000, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'] })
const c = await browser.newPage()
await c.emulate({ viewport: { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36' })
await c.goto('http://localhost:5173/?map=island&play=1&tier=low', { waitUntil: 'domcontentloaded' })
await c.waitForFunction(() => window.__game && window.__game.store.get().worldReady && window.__game.store.get().net.status === 'online', { timeout: 120_000, polling: 250 })
await new Promise((r) => setTimeout(r, 2500))
await c.screenshot({ path: `${OUT}/11-touch-ingame.png` })
await c.tap('[data-testid=room-button]')
await new Promise((r) => setTimeout(r, 800))
await c.screenshot({ path: `${OUT}/12-touch-room-card.png` })
await browser.close()
