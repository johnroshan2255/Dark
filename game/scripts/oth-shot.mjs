// Over-the-Hill headless screenshots + cost (dev-only: needs `npm run dev`, uses the local Google Chrome).
//   node scripts/oth-shot.mjs <outdir> <shots.json>        env: PORT (5173), W / H (1280×720), UNCAPPED=1 (vsync off:
//   GPU-ms cost measurements), PHONE=1 (a 412×915 @2.6 phone viewport)
// shots.json: [{ name, tier, hour, x, z, h (m above ground), yaw, pitch (rad; yaw 0 looks north = −z), wait (ms),
//   tm, exp, rock (m: frame the biggest rock that near x / z, `dist` × its size away) }] — x / z default to the spawn. Prints per shot: fps, CPU / GPU ms, draws, triangles, patches, blades.
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'

const [outDir, shotsFile] = process.argv.slice(2)
const shots = JSON.parse(fs.readFileSync(shotsFile, 'utf8'))
fs.mkdirSync(outDir, { recursive: true })
const CHROME = process.env.CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const ANGLE = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'gl'
const phone = process.env.PHONE === '1'
const W = Number(process.env.W || (phone ? 412 : 1280)), H = Number(process.env.H || (phone ? 915 : 720))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [...(process.env.UNCAPPED ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []), `--use-angle=${ANGLE}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--window-size=${W},${H}`, '--mute-audio'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: phone ? 2.6 : 1, isMobile: phone, hasTouch: phone },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('console', (m) => { const t = m.text(); if (/error|warn|GL_|WebGL/i.test(t)) console.log('[console]', t.slice(0, 3000)) })

let loaded = ''
for (const s of shots) {
  const url = `http://localhost:${process.env.PORT || 5173}/oth.html?tier=${s.tier ?? 'high'}&hour=${s.hour ?? 16.6}${s.drive ? '' : '&drive=0'}&dpr=fixed&time=0${s.tm ? `&tm=${s.tm}` : ''}${s.exp ? `&exp=${s.exp}` : ''}${s.q ? `&${s.q}` : ''}`
  if (url !== loaded) {
    await page.goto(url, { waitUntil: 'load' })
    loaded = url
    await page.waitForFunction(() => window.__oth && window.__oth.ready, { timeout: 90_000, polling: 200 })
  }
  await page.evaluate((s) => {
    const o = window.__oth, sp = o.map.meta.spawn
    o.setHour(s.hour ?? 16.6)
    if (s.carAt) { const [x, z, hd] = s.carAt; o.car.sim.place(x, o.height(x, z) + 0.8, z, hd) } // (put the car there first)
    if (s.drive) { o.drive(true); return }
    if (s.carView) {
      // a still camera at carView = [right, up, back] m from the car (its own frame), looking at it
      const v = o.car, p = v.pos, h = v.sim.heading, [ox, oy, oz] = s.carView
      const x = p.x + ox * Math.cos(h) + oz * Math.sin(h), z = p.z - ox * Math.sin(h) + oz * Math.cos(h)
      const cy = p.y + oy, agl = cy - o.height(x, z)
      o.view(x, z, agl, Math.atan2(-(p.x - x), -(p.z - z)), Math.atan2(p.y + 0.3 - cy, Math.hypot(p.x - x, p.z - z)))
      return
    }
    if (s.sunTree) {
      // stand so the crown of a broadleaf tree (≥ 8 m, near x / z) hides the sun: the god rays through its leaves
      const [dx, dy, dz] = o.sunDir(), L = Math.hypot(dx, dz)
      const t = o.treeNear(s.x ?? sp.x, s.z ?? sp.z, s.sunTree, s.species ?? 4, 8)
      if (t) {
        const crown = t.y + t.h * 0.68, D = Math.min(60, Math.max(7, (crown - (t.y + 1.7)) / Math.tan(Math.asin(dy))))
        const cx = t.x - (dx / L) * D, cz = t.z - (dz / L) * D
        o.view(cx, cz, 1.7, Math.atan2(dx, dz) + Math.PI + (s.yaw ?? 0), Math.atan2(crown - (o.height(cx, cz) + 1.7), D) + (s.pitch ?? 0))
        return
      }
    }
    if (s.faceSun) {
      // look toward the sun from x / z (h above ground), pitched up by its elevation × faceSun (+ pitch)
      const [dx, dy, dz] = o.sunDir()
      o.view(s.x ?? sp.x, s.z ?? sp.z, s.h ?? 1.7, Math.atan2(dx, dz) + Math.PI + (s.yaw ?? 0), Math.asin(dy) * s.faceSun + (s.pitch ?? 0))
      return
    }
    if (s.spot) {
      const p = o.findSpot(s.spot, s.x ?? sp.x, s.z ?? sp.z, s.yaw ?? 0)
      if (p) { o.view(p[0], p[1], s.h ?? 1.7, s.yaw ?? 0, s.pitch ?? -0.04); return }
    }
    if (s.grove) {
      // look at the densest broadleaf grove near x / z from `dist` m away (yaw side)
      const g = o.grove(s.x ?? sp.x, s.z ?? sp.z, s.grove, 6)
      if (g) {
        const D = s.dist ?? 45, yaw = s.yaw ?? 0, cx = g.x + Math.sin(yaw) * D, cz = g.z + Math.cos(yaw) * D
        const cy = o.height(cx, cz) + (s.h ?? 2), ty = o.height(g.x, g.z) + 7
        o.view(cx, cz, s.h ?? 2, yaw, Math.atan2(ty - cy, D))
        return
      }
    }
    if (s.lookAt) {
      // stand at x / z (h above ground), look at the ground point lookAt = [tx, tz] (+ lookUp m above it)
      const [tx, tz] = s.lookAt, cy = o.height(s.x, s.z) + (s.h ?? 1.7), ty = o.height(tx, tz) + (s.lookUp ?? 0)
      const dx = tx - s.x, dz = tz - s.z
      o.view(s.x, s.z, s.h ?? 1.7, Math.atan2(-dx, -dz), Math.atan2(ty - cy, Math.hypot(dx, dz)))
      return
    }
    if (s.trail !== undefined) { o.trailView(s.trail, s.t ?? 0.5, s.h ?? 2.2, s.pitch ?? -0.18); return }
    if (s.tree !== undefined) {
      // frame the nearest tree of species s.tree (0 spruce, 1 larch, 2 snag) ≥ minH m tall near x / z: `dist` × its
      // height away on the yaw side, the camera at h m, looking at its middle (or s.pitch)
      const yaw = s.yaw ?? 0
      const t = o.treeShot(s.x ?? sp.x, s.z ?? sp.z, s.tree, s.minH ?? 0, s.dist ?? 1.2, yaw)
      if (t) {
        const d = t.h * (s.dist ?? 1.2), cx = t.cx, cz = t.cz
        const ch = o.height(cx, cz) + (s.h ?? 1.7)
        o.view(cx, cz, s.h ?? 1.7, yaw, s.pitch ?? Math.atan2(t.y + t.h * 0.5 - ch, d))
        return
      }
    }
    if (s.rock) {
      // frame the biggest rock near x / z: stand `dist` × its size away (yaw side), look at it
      const yaw = s.yaw ?? 0
      const r = o.rockShot(s.x ?? sp.x, s.z ?? sp.z, s.rock, s.dist ?? 2.5, yaw)
      if (r) {
        const cx = r.cx, cz = r.cz
        o.view(cx, cz, s.h ?? r.s * 0.8, yaw, s.pitch ?? -0.25)
        return
      }
    }
    o.view(s.x ?? sp.x, s.z ?? sp.z, s.h ?? 1.7, s.yaw ?? sp.yaw, s.pitch ?? -0.04)
  }, s)
  await new Promise((r) => setTimeout(r, s.wait ?? 1500))
  // drive: hold keys (e.g. ["KeyW", "KeyD"]) for keysMs, the shot taken while they are still held
  if (s.keys) {
    for (const k of s.keys) await page.keyboard.down(k)
    await new Promise((r) => setTimeout(r, s.keysMs ?? 3000))
  }
  await page.screenshot({ path: path.join(outDir, `${s.name}.png`) })
  if (s.keys) for (const k of s.keys) await page.keyboard.up(k)
  if (s.drive) {
    const c = await page.evaluate(() => { const v = window.__oth.car, t = v.sim.body.translation(); return { kmh: v.speedKmh, gear: v.gear, x: t.x, y: t.y, z: t.z, ground: window.__oth.height(t.x, t.z) } })
    console.log('   car', `${c.kmh.toFixed(0)} km/h  gear ${c.gear}  at ${c.x.toFixed(1)}, ${c.y.toFixed(1)}, ${c.z.toFixed(1)}  ground ${c.ground.toFixed(1)}`)
  }
  const st = await page.evaluate(() => window.__oth.stats())
  if (st.trees) console.log('   trees', st.trees.join(' / '), ' bushes', (st.bushes ?? []).join(' / '))
  console.log(s.name.padEnd(22), `${(s.tier ?? 'high').padEnd(6)} fps ${st.fps.toFixed(0)}  cpu ${st.cpuMs.toFixed(2)}  gpu ${st.gpuMs.toFixed(2)} ms  draws ${st.draws}  tris ${(st.tris / 1000).toFixed(0)}k  patches ${st.patches}  blades ${(st.blades / 1000).toFixed(0)}k  pos ${st.pos.join(',')} ground ${st.ground}`)
}
await browser.close()
