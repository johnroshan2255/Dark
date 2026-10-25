import * as pc from 'playcanvas'
import * as THREE from 'three'
import { loadFixedMap, setActiveMap } from '../world/map/FixedMap'
import { WorldFields } from '../world/WorldFields'
import { CHUNK_SIZE } from '../world/constants'
import { PcWorld } from './PcWorld'
import { PcHorizon } from './PcHorizon'
import { PcWater } from './PcWater'
import { loadTreeModels } from '../assets/treeModels'
import { FlyCamera } from './FlyCamera'
import { PcEnvironment } from './PcEnvironment'
import { createSharedTextures } from './textures'

/**
 * DARK on PLAYCANVAS (branch `playcanvas`): the real maps streamed by the game's own chunk workers (engine-free data)
 * and drawn with PlayCanvas's systems — terrain on its StandardMaterial with DARK's ground in its shader chunks, its
 * directional light with cascaded shadows, its CameraFrame (HDR, tone mapping, grading), its MiniStats; the game's
 * own time of day, weather, biome / map air and procedural sky driving them (PcEnvironment).
 * Free fly camera (FlyCamera). Open /pc.html?map=zhangjiajie on the target phone.
 *
 *   ?map=island|highlands|zhangjiajie   ?radius=<chunks> (3)   ?dpr=<max pixel ratio> (2)   ?hour=<0..24> (11)
 *   ?day=<real minutes per game day> (24; 0 = paused)
 */
const q = new URLSearchParams(location.search)
const mapId = q.get('map') ?? 'zhangjiajie'
const radius = Math.max(1, Math.min(6, Number(q.get('radius') ?? 3)))
const maxDpr = Number(q.get('dpr') ?? 2)
const hour = Number(q.get('hour') ?? 11)

const canvas = document.getElementById('app') as HTMLCanvasElement
const hud = document.getElementById('hud')!

async function start(): Promise<void> {
  const device = await pc.createGraphicsDevice(canvas, {
    deviceTypes: [pc.DEVICETYPE_WEBGL2],
    antialias: false, // (CameraFrame renders into its own target; AA is its job)
    powerPreference: 'high-performance',
  })
  device.maxPixelRatio = Math.min(window.devicePixelRatio, maxDpr)

  const opts = new pc.AppOptions()
  opts.graphicsDevice = device
  opts.mouse = new pc.Mouse(document.body)
  opts.keyboard = new pc.Keyboard(window)
  opts.touch = new pc.TouchDevice(document.body)
  opts.componentSystems = [pc.RenderComponentSystem, pc.CameraComponentSystem, pc.LightComponentSystem]
  opts.resourceHandlers = []
  const app = new pc.AppBase(canvas)
  app.init(opts)
  app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW)
  app.setCanvasResolution(pc.RESOLUTION_AUTO)
  window.addEventListener('resize', () => app.resizeCanvas())
  createSharedTextures(device)
  // OPAQUE FRONT TO BACK (PlayCanvas sorts the world layer by material by default): the world shares a few heavy
  // materials, and drawn near-to-far the depth test rejects the hidden hills before their fragment shader runs —
  // measured 31.7 → 12.4 ms GPU at 1920×868 on the terrain alone
  app.scene.layers.getLayerById(pc.LAYERID_WORLD)!.opaqueSortMode = pc.SORTMODE_FRONT2BACK
  if (q.get('clustered') !== '1') app.scene.clusteredLightingEnabled = false

  const map = await loadFixedMap(mapId)
  setActiveMap(map.id) // (every chunk worker request carries it)
  const fields = new WorldFields(map.seed, map)
  const { x: sx, z: sz } = map.spawn
  const cam = new pc.Entity('camera')
  cam.addComponent('camera', { clearColor: new pc.Color(0, 0, 0), farClip: 2400, nearClip: 0.2, fov: 60 })
  app.root.addChild(cam)
  const fly = new FlyCamera(app, cam, canvas)
  fly.place(sx, map.height(sx, sz) + 3, sz)

  const env = new PcEnvironment(app, cam, fields, map, map.seed, hour)
  env.tod.dayLengthMinutes = Number(q.get('day') ?? 24)
  await loadTreeModels() // (the Blender trees, baked into the tree library before it is built)
  const terrain = new PcWorld(app, fields, map, map.seed)
  terrain.radius = radius
  cam.camera!.layers = [...cam.camera!.layers, terrain.prepassLayer.id] // (the leaves' depth pre-pass)
  const horizon = new PcHorizon(app, map.seed)
  env.horizon = horizon.size * 0.5
  const water = new PcWater(app)
  const pal = map.palette
  if (pal?.waterDeep) {
    const w = pal.water ?? pal.waterDeep, d = pal.waterDeep
    water.setDeep([w[0] * 0.55 + d[0] * 0.45, w[1] * 0.55 + d[1] * 0.45, w[2] * 0.55 + d[2] * 0.45], 0.42)
  }

  // PlayCanvas's own frame stats (its MiniStats: frame / CPU / GPU ms with graphs, draw calls, VRAM, resources).
  // Tap / click the panel to cycle its sizes; it opens on the grouped averages.
  const so = pc.MiniStats.getDefaultOptions()
  so.startSizeIndex = 1
  so.resourcesEnabled = true
  new pc.MiniStats(app, so)
  if (import.meta.env.DEV) (window as unknown as { __pc: unknown }).__pc = { pc, app, cam, terrain, fly, env, fields }

  const focus = new THREE.Vector3()
  let hudT = 0, time = 0
  app.on('update', (dt: number) => {
    time += dt
    fly.update(dt)
    const p = cam.getPosition()
    focus.set(p.x, fields.height(p.x, p.z), p.z)
    env.update(dt, focus, cam, time)
    terrain.update(p.x, p.z, cam.camera!)
    horizon.update(p.x, p.z, terrain.builtRadius)
    water.update(time, p, app.scene.fog.start, app.scene.fog.end, env.weather.rain, env.snowHere)
    hudT += dt
    if (hudT > 1) {
      hudT = 0
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      hud.textContent = `${mapId} · ${env.tod.hours.toFixed(1)} h · chunks ${terrain.count} (+${terrain.pending}) · r ${radius}×${CHUNK_SIZE} m · ${canvas.width}×${canvas.height} · js ${mem ? (mem.usedJSHeapSize / 1048576).toFixed(0) + ' MB' : 'n/a'}`
    }
  })
  app.start()
}

start().catch((e) => {
  hud.textContent = 'failed: ' + (e instanceof Error ? e.message : String(e))
  console.error(e)
})
