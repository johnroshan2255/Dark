import * as THREE from 'three'
import { isMobileDevice } from '../rendering/quality/DeviceProfile'
import { installToneMap } from './toneMap'
import { Atmosphere } from './Atmosphere'
import { OthAudio } from './Audio'
import { Bridges } from './Bridges'
import { Bushes } from './Bushes'
import { Dust } from './Dust'
import { Falls } from './Falls'
import { ChaseCam } from './ChaseCam'
import { FlyCam } from './FlyCam'
import { Grass } from './Grass'
import { Horizon } from './Horizon'
import { MapData } from './MapData'
import { OthPhysics } from './Physics'
import { createPaintTexture } from './noiseTex'
import { Post } from './Post'
import { Rocks } from './Rocks'
import { pickTier } from './quality'
import { Sky } from './Sky'
import { Terrain } from './Terrain'
import { TerrainShadow } from './TerrainShadow'
import { Trees } from './Trees'
import { Vehicle } from './Vehicle'
import { Water } from './Water'

/**
 * OVER THE HILL — a new world, its own renderer: no React, no shared world code. Boot: tier → map data → paint
 * texture → atmosphere, terrain, grass, sky → the loop. `window.__oth` drives it from the headless shot harness
 * (scripts/oth-shot.mjs).
 *
 * URL: ?tier=low|medium|high|ultra  ?car=gwagen|bmw|van  ?drive=0 (start in the free camera)  ?x= &z= (m) ?h= (m above
 *      the ground) ?yaw= ?pitch= (rad) ?hour= ?tm=neutral|agx|aces ?exp= (exposure) ?stats=1
 * Keys: drive W A S D, Space handbrake, Shift boost, R reset, 1 / 2 / 3 the car, V free camera ⇄ the car, F3 stats.
 */
const q = new URLSearchParams(location.search)
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d)
const tier = pickTier()
const status = document.getElementById('status')!

async function boot() {
  // REVERSED-Z (the user: no Z-fighting far away): depth 1 at the near plane … 0 at the far one, in Post's 32-bit float
  // depth (Post.ts) — even precision from 0.3 m to the horizon (24-bit standard depth: ~20 cm steps at 1 km, ~7 m at
  // 6 km). three falls back to standard depth where the browser lacks EXT_clip_control. LOW draws to the canvas's
  // 24-bit depth: reversed there, no finer than before.
  const renderer = new THREE.WebGLRenderer({ antialias: tier.msaa && !tier.bloom, powerPreference: 'high-performance', stencil: false, reversedDepthBuffer: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, tier.dpr))
  renderer.setSize(innerWidth, innerHeight)
  const tm = q.get('tm') ?? 'neutral-hue'
  // (the default: Neutral with a hue-keeping toe — toneMap.ts; ?tm=neutral the original, ?tm=aces / agx)
  installToneMap()
  renderer.toneMapping = tm === 'aces' ? THREE.ACESFilmicToneMapping : tm === 'agx' ? THREE.AgXToneMapping : tm === 'neutral' ? THREE.NeutralToneMapping : THREE.CustomToneMapping
  renderer.toneMappingExposure = num('exp', 1.0)
  renderer.info.autoReset = false
  document.body.appendChild(renderer.domElement)

  status.textContent = 'Loading the valley…'
  const map = await MapData.load('/oth/valley', (f) => (status.textContent = `Loading the valley… ${Math.round(f * 100)}%`))
  const noise = createPaintTexture()
  const atmos = new Atmosphere(noise)
  atmos.uniforms.uFogRange.value.set(tier.fogNear, tier.fogEnd)
  atmos.hour = num('hour', 15.5)
  // ?time=0 stops the clock (the shot harness); [ / ] an hour back / on, T stops / starts it
  if (q.get('time') === '0') atmos.dayMinutes = 0
  const runMinutes = num('day', 24)
  if (atmos.dayMinutes) atmos.dayMinutes = runMinutes
  window.addEventListener('keydown', (e) => {
    if (e.code === 'BracketRight') atmos.hour = (atmos.hour + 1) % 24
    if (e.code === 'BracketLeft') atmos.hour = (atmos.hour + 23) % 24
    if (e.code === 'KeyT') atmos.dayMinutes = atmos.dayMinutes ? 0 : runMinutes
  })

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.3, tier.far)
  const scene = new THREE.Scene()
  const shadow = new TerrainShadow(map)
  let shadowReady = false
  shadow.onBaked = () => (shadowReady = true)
  const terrain = new Terrain(map, atmos, tier, shadow)
  const rocks = new Rocks(map, atmos, shadow, tier, terrain.uniforms.uFarGrid.value)
  const grass = new Grass(map, atmos, terrain, tier, rocks.footprint)
  const water = new Water(map, atmos, terrain, tier, rocks.footprint)
  const falls = new Falls(map, atmos)
  const sky = new Sky(atmos, !!tier.bloom) // (the sky marks itself for the god rays when Post draws)
  const trees = new Trees(map, atmos, shadow, tier, rocks)
  trees.bakeImpostors(renderer)
  const bushes = new Bushes(map, atmos, shadow, tier, rocks, trees.leafTexture)
  // OCCLUSION CULLING: what the hills hide (trees, rocks, bushes behind them are skipped); ?occlusion=0 turns it off
  const horizon = new Horizon(map, Math.max(tier.treeReach, tier.rockReach))
  horizon.enabled = q.get('occlusion') !== '0'
  trees.horizon = rocks.horizon = bushes.horizon = horizon
  const bridges = new Bridges(map, atmos, shadow, tier, terrain.uniforms.uFarGrid.value)
  scene.add(terrain.mesh, grass.group, rocks.group, trees.group, bushes.group, water.group, falls.group, bridges.group, sky.mesh)

  // THE 4×4: the game's vehicle physics on this map's ground and rocks
  status.textContent = 'Loading the 4×4…'
  const physics = await OthPhysics.create(map, rocks)
  physics.trees = trees
  const car = new Vehicle(map, physics, atmos, shadow, tier, terrain.uniforms.uFarGrid.value)
  if (q.get('paint')) car.paint = '#' + q.get('paint')!.replace('#', '')
  await car.setCar(q.get('car') ?? 'gwagen')
  scene.add(car.root, car.shadowMesh)
  // the tyres' dust and the exhaust smoke
  const dust = new Dust(map, atmos, tier)
  scene.add(dust.mesh)
  const chase = new ChaseCam(camera, map, car, renderer.domElement)
  chase.snap()
  let driving = q.get('drive') !== '0'

  const fly = new FlyCam(camera, map, renderer.domElement)
  const sp = map.meta.spawn
  fly.place(num('x', sp.x), num('z', sp.z), num('h', 1.7), num('yaw', sp.yaw), num('pitch', -0.04))
  // V: the free camera (from where the chase camera is) ⇄ back in the car
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyV') return
    driving = !driving
    if (!driving) {
      const d = camera.getWorldDirection(new THREE.Vector3())
      fly.place(camera.position.x, camera.position.z, camera.position.y - map.height(camera.position.x, camera.position.z), Math.atan2(-d.x, -d.z), Math.asin(d.y))
    } else chase.snap()
  })
  const ui = driveUi(car)
  // SOUND: the engine, the tyres, the music and the valley's ambience (starts on the first key / tap — Audio.ts)
  const audio = new OthAudio(map, car, atmos)
  fullscreenButton()
  // ZOOM buttons (+ / −): the chase camera's distance while driving, the field of view in the free camera
  zoomButtons((k) => {
    if (driving) chase.zoom(k)
    else { camera.fov = THREE.MathUtils.clamp(camera.fov * k, 18, 80); camera.updateProjectionMatrix() }
  })

  const post = tier.bloom ? new Post(tier.bloom, tier.msaa ? 4 : 0, num('bloom', 0.42), num('rays', 2.0)) : null
  const baseDpr = Math.min(devicePixelRatio, tier.dpr)
  let dprScale = 1, dprT = performance.now() + 4000
  // (phones only: on a PC / laptop the resolution never drops — the user: "don't reduce resolution automatically, turn it
  //  off on PC / laptop"; ?adaptive=1 forces it on, ?dpr=fixed / ?adaptive=0 off)
  const adaptive = q.get('adaptive') === '1' || (isMobileDevice() && q.get('dpr') !== 'fixed' && q.get('adaptive') !== '0')
  const size = () => post?.setSize(Math.round(innerWidth * renderer.getPixelRatio()), Math.round(innerHeight * renderer.getPixelRatio()))
  size()
  window.addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight)
    size()
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
  })

  // stats: frame / CPU / GPU ms (timer query where the browser has it), draws, triangles
  const gl = renderer.getContext() as WebGL2RenderingContext
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2')
  let query: WebGLQuery | null = null
  let gpuMs = 0, cpuMs = 0, frameMs = 16.7, last = performance.now()
  const hud = document.getElementById('hud')!
  let showHud = q.get('stats') === '1'
  window.addEventListener('keydown', (e) => { if (e.code === 'F3') { showHud = !showHud; e.preventDefault() } })
  let hudT = 0

  const clock = new THREE.Clock()
  const frame = () => {
    const now = performance.now()
    frameMs += (now - last - frameMs) * 0.1
    // ADAPTIVE RESOLUTION, phones (PlayCanvas guidelines: device pixel ratio at runtime): once a second, a slow frame
    // (> 19 ms ≈ under 52 fps) lowers the pixel ratio 15 % (down to half the tier's), a fast one (< 12.5 ms) raises
    // it back — the look stays, only the sharpness gives. ?dpr=fixed turns it off.
    if (adaptive && now - dprT > 1000) {
      dprT = now
      const k = frameMs > 19 ? 0.85 : frameMs < 12.5 ? 1.08 : 1
      const next = Math.min(1, Math.max(0.5, dprScale * k))
      if (Math.abs(next - dprScale) > 0.02) {
        dprScale = next
        renderer.setPixelRatio(baseDpr * dprScale)
        size()
      }
    }
    last = now
    const dt = Math.min(clock.getDelta(), 0.1)
    physics.pw.advance(dt, (fdt) => car.fixed(fdt))
    car.update(physics.pw.alpha)
    dust.update(dt, car)
    car.lights(atmos)
    if (driving) chase.update(dt)
    else fly.update(dt)
    ui.update(driving, atmos.clock)
    audio.update(dt, camera)
    atmos.tick(dt)
    atmos.update(camera.position, clock.elapsedTime)
    shadow.update(atmos.uniforms.uSunDir.value)
    const t0 = performance.now()
    horizon.update(camera.position)
    terrain.update(camera)
    grass.update(camera)
    rocks.update(camera)
    trees.update(camera)
    bushes.update(camera)
    if (timer && query) {
      const ready = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)
      if (ready && !gl.getParameter(timer.GPU_DISJOINT_EXT)) gpuMs += (gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6 - gpuMs) * 0.15
      if (ready) { gl.deleteQuery(query); query = null }
    }
    let started = false
    if (timer && !query) { query = gl.createQuery(); gl.beginQuery(timer.TIME_ELAPSED_EXT, query!); started = true }
    renderer.info.reset()
    if (post) post.render(renderer, scene, camera, atmos.uniforms.uSunDir.value)
    else renderer.render(scene, camera)
    if (started) gl.endQuery(timer!.TIME_ELAPSED_EXT)
    cpuMs += (performance.now() - t0 - cpuMs) * 0.1
    if (showHud && now - hudT > 250) {
      hudT = now
      hud.style.display = 'block'
      const p = camera.position
      hud.textContent = `${tier.name.toUpperCase()}  res ${Math.round(dprScale * 100)}%  ${(1000 / frameMs).toFixed(0)} fps  frame ${frameMs.toFixed(1)} ms  cpu ${cpuMs.toFixed(2)} ms  gpu ${timer ? gpuMs.toFixed(2) : '–'} ms\n` +
        `draws ${renderer.info.render.calls}  tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k  patches ${terrain.patches}  blades ${(grass.blades / 1000).toFixed(0)}k  trees ${trees.drawn.join('/')} of ${trees.count}  culled: trees ${trees.occluded} tiles behind hills, rocks ${rocks.culled.frustum} off-view / ${rocks.culled.occluded} hidden cells, ${rocks.culled.small} tiny\n` +
        `x ${p.x.toFixed(0)} z ${p.z.toFixed(0)} y ${p.y.toFixed(0)} (agl ${(p.y - map.height(p.x, p.z)).toFixed(1)})  yaw ${fly.yaw.toFixed(2)} pitch ${fly.pitch.toFixed(2)}  hour ${atmos.hour.toFixed(1)}`
    } else if (!showHud) hud.style.display = 'none'
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  status.remove()

  // the shot harness
  ;(window as unknown as { __oth: unknown }).__oth = {
    get ready() { return shadowReady },
    tier: tier.name,
    view: (x: number, z: number, h: number, yaw: number, pitch: number) => { driving = false; fly.place(x, z, h, yaw, pitch) },
    car,
    /** The sound's state (Audio.ts debug). */
    audio: () => audio.debug(),
    /** Drive mode on / off (the chase camera). */
    drive: (on: boolean) => { driving = on; if (on) chase.snap() },
    setHour: (h: number) => { atmos.hour = h; atmos.update(camera.position, 0) },
    sunDir: () => atmos.uniforms.uSunDir.value.toArray(),
    stats: () => ({ fps: 1000 / frameMs, cpuMs, gpuMs, draws: renderer.info.render.calls, tris: renderer.info.render.triangles, patches: terrain.patches, blades: grass.blades, rocks: rocks.count, trees: trees.drawn.slice(), bushes: bushes.drawn.slice(), culled: { treeTiles: trees.occluded, rocks: { ...rocks.culled }, horizonBuilds: horizon.builds }, pos: camera.position.toArray().map((v) => +v.toFixed(1)), ground: +map.height(camera.position.x, camera.position.z).toFixed(1) }),
    height: (x: number, z: number) => map.height(x, z),
    rockNear: (x: number, z: number, r: number) => rocks.biggestNear(x, z, r),
    treeNear: (x: number, z: number, r: number, species: number, minH: number) => trees.nearest(x, z, r, species, minH),
    /** The densest broadleaf grove within r of (x, z) (≥ n trees of species ≥ 3 within 25 m of its centre). */
    grove: (x: number, z: number, r: number, n: number) => {
      const d = trees.data, S = 8
      let best: [number, number] | null = null, bc = 0
      for (let i = 0; i < trees.count; i++) {
        const o = i * S
        if (d[o + 5] < 3 || (d[o] - x) ** 2 + (d[o + 2] - z) ** 2 > r * r) continue
        let c = 0
        for (let k = 0; k < trees.count; k++) { const q = k * S; if (d[q + 5] >= 3 && (d[q] - d[o]) ** 2 + (d[q + 2] - d[o + 2]) ** 2 < 625) c++ }
        if (c > bc) { bc = c; best = [d[o], d[o + 2]] }
      }
      return bc >= n ? { x: best![0], z: best![1], count: bc } : null
    },
    /** A camera spot near (x, z) whose ground for 4–45 m ahead (yaw) is all `kind` ('gold' / 'green' meadow): no rock,
     *  water, track or forest, no tree in the way. */
    findSpot: (kind: string, x: number, z: number, yaw: number) => {
      const mk: [number, number, number, number] = [0, 0, 0, 0]
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw)
      const ok = (px: number, pz: number) => {
        map.maskAt(px, pz, mk)
        if (mk[0] > 0.2 || mk[2] > 0.5 || mk[3] > 0.25 || map.trailDist(px, pz) < 5) return false
        return kind === 'gold' ? mk[1] > 0.72 : mk[1] < 0.25
      }
      for (let r = 0; r < 1500; r += 25) for (let a = 0; a < 16; a++) {
        const cx = x + Math.cos((a / 16) * 6.283) * r, cz = z + Math.sin((a / 16) * 6.283) * r
        let good = true
        for (let d = 0; d <= 45 && good; d += 5) for (const sd of [-12, 0, 12]) {
          if (!ok(cx + fx * d - fz * sd * (d / 45), cz + fz * d + fx * sd * (d / 45))) { good = false; break }
        }
        if (good && trees.clearLine(cx, cz, cx + fx * 60, cz + fz * 60, 9)) return [cx, cz]
      }
      return null
    },
    clearLineTrees: (ax: number, az: number, bx: number, bz: number, r: number) => trees.clearLine(ax, az, bx, bz, r),
    treeShot: (x: number, z: number, species: number, minH: number, dist: number, yaw: number) => trees.clearShot(x, z, species, minH, dist, yaw),
    rockShot: (x: number, z: number, r: number, dist: number, yaw: number) => {
      for (const k of rocks.candidates(x, z, r)) {
        const d = k.s * dist, cx = k.x + Math.sin(yaw) * d, cz = k.z + Math.cos(yaw) * d
        if (trees.clearLine(cx, cz, k.x, k.z, 7)) return { ...k, cx, cz }
      }
      return null
    },
    /** Stand on dirt track i at fraction t (0..1) of its length, looking along it. */
    trailView: (i: number, t: number, h: number, pitch: number) => {
      const L = map.meta.trails.lines[i % map.meta.trails.lines.length]
      const k = Math.min(L.length - 4, Math.max(0, Math.round(t * (L.length - 1))))
      const [x, z] = L[k], [x2, z2] = L[k + 3]
      driving = false
      fly.place(x, z, h, Math.atan2(-(x2 - x), -(z2 - z)), pitch)
    },
    map,
  }
}

/**
 * FULL SCREEN (top-left ⛶, on phones and desktop): the Fullscreen API on the page, then landscape locked where the
 * browser allows it (Android Chrome). iPhone Safari has no Fullscreen API for pages — there the button explains
 * "Share → Add to Home Screen", which opens the game full screen (oth.html is web-app capable).
 */
/** + / − (top left, under the full-screen button): zoom in / out; held down, it keeps zooming. */
function zoomButtons(zoom: (k: number) => void): void {
  const box = document.createElement('div')
  box.className = 'oth-zoom'
  for (const [label, k, title] of [['+', 0.86, 'Zoom in'], ['−', 1.16, 'Zoom out']] as const) {
    const b = document.createElement('button')
    b.textContent = label
    b.title = title
    let timer = 0
    const stop = () => { clearInterval(timer); timer = 0 }
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation()
      zoom(k)
      stop()
      timer = window.setInterval(() => zoom(Math.pow(k, 0.5)), 90)
    })
    b.addEventListener('pointerup', stop)
    b.addEventListener('pointerleave', stop)
    b.addEventListener('pointercancel', stop)
    box.appendChild(b)
  }
  document.body.appendChild(box)
}

function fullscreenButton(): void {
  const b = document.createElement('button')
  b.className = 'oth-fs'
  b.title = 'Full screen'
  b.textContent = '⛶'
  document.body.appendChild(b)
  const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void }
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void }
  const can = !!(el.requestFullscreen || el.webkitRequestFullscreen)
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone
  if (standalone) { b.remove(); return }
  b.addEventListener('click', async (e) => {
    e.stopPropagation()
    if (!can) {
      alert('On iPhone: tap Share → "Add to Home Screen", then open it from the home screen — it runs full screen.')
      return
    }
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      if (document.exitFullscreen) await document.exitFullscreen()
      else doc.webkitExitFullscreen?.()
      return
    }
    try {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' })
      else el.webkitRequestFullscreen?.()
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
      await o?.lock?.('landscape').catch(() => {})
    } catch { /* (the browser refused: nothing to do) */ }
  })
}

/** The driving HUD (speed, gear, keys) and, on touch screens, the pedals and steering buttons. */
function driveUi(car: Vehicle): { update: (driving: boolean, time: string) => void } {
  const box = document.createElement('div')
  box.id = 'drive'
  box.innerHTML = '<div class="spd"><b>0</b><span>km/h</span><i></i><em></em></div><div class="help">W A S D drive · Space handbrake · Shift boost · R reset · 1 2 3 car · L lights · M sound · V free camera · + − zoom · [ ] time · T stop time · drag to look</div>'
  document.body.appendChild(box)
  const spd = box.querySelector('b')!, gear = box.querySelector('i')!, clk = box.querySelector('em')!, help = box.querySelector('.help') as HTMLElement
  const touch = navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches
  if (touch) {
    help.style.display = 'none'
    Object.assign(box.style, { top: '14px', left: '70px', right: 'auto', bottom: 'auto', textAlign: 'left' })
    const pad = document.createElement('div')
    pad.className = 'oth-touch'
    pad.innerHTML = '<button data-k="left">◀</button><button data-k="right">▶</button><button data-k="reset">⟲</button><button data-k="brake">BRAKE</button><button data-k="gas">GAS</button>'
    document.body.appendChild(pad)
    for (const b of pad.querySelectorAll('button')) {
      const k = b.dataset.k as keyof Vehicle['touch'] | 'reset'
      const on = (v: number) => (e: Event) => { e.preventDefault(); if (k === 'reset') { if (v) car.reset() } else car.touch[k] = v }
      b.addEventListener('pointerdown', on(1)); b.addEventListener('pointerup', on(0)); b.addEventListener('pointercancel', on(0)); b.addEventListener('pointerleave', on(0))
    }
  }
  return {
    update: (driving, time: string) => {
      box.style.display = driving ? 'block' : 'none'
      spd.textContent = car.speedKmh.toFixed(0)
      gear.textContent = car.gear
      clk.textContent = time
    },
  }
}

boot().catch((e) => {
  status.textContent = `Failed: ${e?.message ?? e}`
  console.error(e)
})
