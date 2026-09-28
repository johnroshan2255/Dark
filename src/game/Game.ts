import * as THREE from 'three'
import { ChunkDebug } from '../debug/ChunkDebug'
import { CullingDebug } from '../debug/CullingDebug'
import { PerformanceMonitor } from '../debug/PerformanceMonitor'
import { PhysicsDebug } from '../debug/PhysicsDebug'
import { AudioSystem } from '../audio/AudioSystem'
import { Bike } from '../gameplay/bmx/Bike'
import { Car } from '../gameplay/vehicle/Car'
import { LightBeam } from '../gameplay/flashlight/LightBeam'
import { MonsterSystem } from '../gameplay/monsters/MonsterSystem'
import { Health } from '../gameplay/survival/Health'
import { Lightning } from '../gameplay/weather/Lightning'
import { AshParticles } from '../rendering/particles/AshParticles'
import { CameraController, type CameraMode } from '../gameplay/player/CameraController'
import { CharacterModel, createBlobShadow } from '../gameplay/player/CharacterModel'
import { PlayerController } from '../gameplay/player/PlayerController'
import { Input } from '../input/Input'
import { PhysicsWorld } from '../physics/PhysicsWorld'
import { LightingSystem } from '../rendering/lighting/LightingSystem'
import { TimeOfDay } from '../rendering/lighting/TimeOfDay'
import { MaterialLibrary } from '../rendering/materials/MaterialLibrary'
import { PostPipeline } from '../rendering/postprocessing/PostPipeline'
import { AdaptiveQuality, type AdaptiveDecision } from '../rendering/quality/AdaptiveQuality'
import { detectDevice, isTouchDevice, type DeviceProfile } from '../rendering/quality/DeviceProfile'
import {
  QUALITY,
  tierAbove,
  tierBelow,
  TIERS,
  type QualitySettings,
  type TierName,
} from '../rendering/quality/QualityTiers'
import { globalUniforms } from '../rendering/shaders/uniforms'
import { applyShadowEdgeFade } from '../rendering/shadows/ShadowEdgeFade'
import { SkyDome } from '../rendering/sky/SkyDome'
import { skyUniforms } from '../rendering/sky/skyShader'
import { WorldManager } from '../world/WorldManager'
import { HorizonTerrain } from '../world/Terrain/HorizonTerrain'
import { Water } from '../rendering/water/Water'
import { GameLoop } from './GameLoop'
import { createStore, type GameStateShape, type Store } from './GameState'
import { loadSettings, saveSettings, type Settings } from './Settings'

export interface GameOptions {
  seed: number
  /** Fixed starting tier from the URL (overrides the saved setting, not persisted), or 'auto'. */
  tier?: TierName | 'auto'
  /** Adaptive quality (render scale / tier) to hold ≥ 60 fps. Default true. */
  adaptive?: boolean
  /** Dev only: busy-wait this many ms per frame to simulate a slow device. */
  stressMs?: number
  /** Start hour override (tests / screenshots). */
  hour?: number
}

/**
 * Owns every system. Plain TypeScript — React only mounts its roots and drives tick()/render().
 *
 * Frame order (GameLoop): look → fixed step (player + Rapier) → time of day → camera (FPP/TPP)
 * → world (streaming, LOD, culling, physics ring) → lighting/fog/sky/god rays → debug.
 * Then R3F's render phase calls render() (Effects, useFrame priority 1).
 */
export class Game {
  readonly store: Store<GameStateShape>
  readonly input = new Input()
  readonly loop = new GameLoop()
  readonly tod: TimeOfDay
  readonly materials = new MaterialLibrary()
  readonly lighting: LightingSystem
  readonly post = new PostPipeline()
  readonly sky = new SkyDome()
  readonly physics: PhysicsWorld
  readonly world: WorldManager
  readonly player: PlayerController
  readonly character: CharacterModel
  readonly blobShadow = createBlobShadow()
  readonly beam = new LightBeam()
  readonly bike: Bike
  readonly car: Car
  readonly health = new Health()
  readonly audio = new AudioSystem()
  readonly ash = new AshParticles()
  readonly water = new Water()
  readonly horizon: HorizonTerrain
  readonly monsters: MonsterSystem
  readonly lightning: Lightning
  private respawnTimer = 0
  readonly cameraCtl: CameraController
  /** World-space helpers that aren't chunks: sky, character, debug. Mounted by <Environment>. */
  readonly envRoot = new THREE.Group()
  readonly chunkDebug = new ChunkDebug()
  readonly cullingDebug = new CullingDebug()
  readonly physicsDebug: PhysicsDebug
  /** Linear-range fog (three's Fog uses smoothstep(near, far)): clear near the player, closes in at distance. */
  readonly fog = new THREE.Fog(0x000000, 50, 200)
  perf: PerformanceMonitor | null = null
  readonly adaptive = new AdaptiveQuality()
  quality: QualitySettings = QUALITY.medium
  settings: Settings
  device: DeviceProfile | null = null
  /** Last adaptive decision, for the HUD. */
  lastQualityChange = 'none'
  private setDpr: ((dpr: number) => void) | null = null
  private readonly opts: GameOptions
  /** Quality as saved by the player (a ?tier= URL override is never persisted). */
  private savedQuality: Settings['quality']

  private renderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  camera: THREE.PerspectiveCamera | null = null

  static async create(opts: GameOptions): Promise<Game> {
    applyShadowEdgeFade() // global shader-chunk patch; must precede any program compile
    const R = await PhysicsWorld.load()
    return new Game(opts, new PhysicsWorld(R))
  }

  private constructor(opts: GameOptions, physics: PhysicsWorld) {
    this.physics = physics
    this.opts = opts
    this.settings = loadSettings()
    this.savedQuality = this.settings.quality
    if (opts.tier && opts.tier !== 'auto') this.settings = { ...this.settings, quality: opts.tier }
    this.adaptive.enabled = opts.adaptive !== false && this.settings.quality === 'auto'
    this.tod = new TimeOfDay(opts.hour ?? 10.5) // start on a bright Genshin morning; night still comes with the cycle
    this.tod.dayLengthMinutes = this.settings.dayLength
    this.lighting = new LightingSystem(this.tod)
    this.store = createStore<GameStateShape>({
      status: 'ready',
      error: null,
      seed: opts.seed,
      phase: this.tod.label,
      nightmare: false,
      pointerLocked: false,
      hud: this.settings.showFps,
      debugChunks: false,
      debugPhysics: false,
      cullingFrozen: false,
      flashlight: this.lighting.flashlightOn,
      tier: this.quality.name,
      adaptive: this.adaptive.enabled,
      touch: isTouchDevice(),
      settings: this.settings,
      settingsOpen: false,
      dead: false,
    })
    this.world = new WorldManager(opts.seed, this.materials, physics)

    // Spawn on the road near the origin.
    const z = 8
    const x = this.world.fields.roadCenterX(z)
    const spawn = new THREE.Vector3(x, this.world.fields.height(x, z) + 0.05, z)
    this.player = new PlayerController(physics, this.input, spawn)
    // Face down the road (+Z): forward = (-sin yaw, -cos yaw) = normalize(dx/dz, 1).
    this.player.yaw = Math.atan2(-(this.world.fields.roadCenterX(z + 1) - x), -1)
    this.player.pitch = -0.08

    this.character = new CharacterModel(this.materials.character)
    this.character.yaw = this.player.yaw
    this.cameraCtl = new CameraController(physics, this.world.fields, this.character, this.blobShadow)
    this.cameraCtl.mode = this.settings.camera
    this.horizon = new HorizonTerrain(opts.seed)
    this.bike = new Bike(this.materials.character, this.player, this.character, this.world.fields)
    this.bike.parkNear(spawn, this.player.yaw, 2.4)
    const paints = [0x3aa6b8, 0xe8a23a, 0xd9534f, 0x6cbf5a, 0xf2f0e8]
    this.car = new Car(this.materials.character, physics, this.world.fields, this.player, this.character, this.input, paints[opts.seed % paints.length])
    {
      // Parked on the verge ~14 m down the road from the spawn.
      const cz = z + 14
      const f = this.world.fields
      const cx = f.roadCenterX(cz) + 1.4 // right lane (poles stand at +5.6 m)
      this.car.park(cx, cz, Math.atan2(-(f.roadCenterX(cz + 1) - f.roadCenterX(cz)), -1)) // along the road there
      // Start looking at the car (it's what you drive first); on a bending road it would hide behind the verge.
      this.player.yaw = Math.atan2(-(cx - x), -(cz - z))
      this.character.yaw = this.player.yaw
    }
    this.monsters = new MonsterSystem(this.world.fields, this.player, this.health, this.audio)
    this.lightning = new Lightning(this.world.fields, this.player, this.health, this.audio)
    this.monsters.enabled = this.lightning.enabled = this.settings.monsters
    this.health.onDamage = (e) => {
      this.audio.hurt()
      this.cameraCtl.shake = Math.min(1, this.cameraCtl.shake + 0.4 + e.amount / 60)
    }
    this.health.onDeath = () => {
      this.player.dead = true
      this.respawnTimer = 4
      this.store.set({ dead: true })
    }

    this.physicsDebug = new PhysicsDebug(physics)
    this.envRoot.name = 'environment'
    this.envRoot.add(this.sky.mesh, this.bike.root, this.car.root, this.horizon.mesh, this.water.mesh, this.beam.mesh, this.monsters.rig.root, this.lightning.mesh, this.ash.points, this.character.root, this.blobShadow, this.chunkDebug.object, this.cullingDebug.helper, this.physicsDebug.object)

    this.bindKeys()
    this.buildLoop()
  }

  // ---------------------------------------------------------------- input

  private bindKeys(): void {
    const s = this.store
    const i = this.input
    i.onLockChange = (locked) => s.set({ pointerLocked: locked })
    i.onPress('F3', () => this.updateSettings({ showFps: !this.settings.showFps }))
    i.onPress('F4', () => {
      this.chunkDebug.enabled = !this.chunkDebug.enabled
      s.set({ debugChunks: this.chunkDebug.enabled })
    })
    i.onPress('F5', () => this.camera && s.set({ cullingFrozen: this.cullingDebug.toggle(this.camera) }))
    i.onPress('F6', () => {
      this.physicsDebug.enabled = !this.physicsDebug.enabled
      s.set({ debugPhysics: this.physicsDebug.enabled })
    })
    i.onPress('KeyT', () => this.toggleDayNight())
    i.onPress('KeyG', () => this.tod.nextPreset())
    i.onPress('KeyN', () => this.toggleNightmare())
    i.onPress('KeyV', () => this.toggleCamera())
    i.onPress('KeyO', () => this.openSettings(!s.get().settingsOpen))
    i.onPress('KeyF', () => s.set({ flashlight: this.lighting.toggleFlashlight() }))
    i.onPress('KeyE', () => {
      // Car takes priority when both are near; one key for everything (touch: BIKE/CAR button).
      if (this.car.driving || this.car.near) {
        this.car.toggle()
        this.cameraCtl.vehicle = this.car.driving ? { distance: 8, pivot: 2.8 } : null
      } else this.bike.toggle()
    })
    i.onPress('BracketLeft', () => this.updateSettings({ resolution: Math.max(0.5, this.post.renderScale - 0.1) }))
    i.onPress('BracketRight', () => this.updateSettings({ resolution: Math.min(1, this.post.renderScale + 0.1) }))
    // F7: cycle tier manually. F8: back to auto quality.
    i.onPress('F7', () => this.updateSettings({ quality: TIERS[(TIERS.indexOf(this.quality.name) + 1) % TIERS.length] }))
    i.onPress('F8', () => this.updateSettings({ quality: 'auto' }))
    window.addEventListener('touchstart', this.onFirstTouch, { passive: true, once: true })
  }

  private onFirstTouch = () => this.store.set({ touch: true })

  toggleDayNight(): void {
    this.tod.toggleDayNight()
  }

  toggleNightmare(): void {
    const on = this.tod.nightmareTarget < 0.5
    this.tod.setNightmare(on)
    this.store.set({ nightmare: on })
  }

  toggleCamera(): void {
    this.updateSettings({ camera: this.settings.camera === 'fpp' ? 'tpp' : 'fpp' })
  }

  openSettings(open: boolean): void {
    if (open && document.pointerLockElement) document.exitPointerLock()
    this.store.set({ settingsOpen: open })
  }

  // ---------------------------------------------------------------- settings & quality

  updateSettings(patch: Partial<Settings>): void {
    const prev = this.settings
    this.settings = { ...prev, ...patch }
    if (patch.quality !== undefined) this.savedQuality = patch.quality
    saveSettings({ ...this.settings, quality: this.savedQuality })
    this.store.set({ settings: this.settings, hud: this.settings.showFps })
    if (patch.quality !== undefined && patch.quality !== prev.quality) {
      this.adaptive.enabled = patch.quality === 'auto'
      if (patch.quality !== 'auto') this.applyQuality(patch.quality, 'setting')
      else this.adaptive.settle(2)
      this.store.set({ adaptive: this.adaptive.enabled })
    } else {
      this.applyOverrides()
    }
    this.cameraCtl.mode = this.settings.camera as CameraMode
    this.monsters.enabled = this.lightning.enabled = this.settings.monsters
    this.tod.dayLengthMinutes = this.settings.dayLength
    this.player.sensitivity = 0.0022 * this.settings.lookSensitivity
  }

  /**
   * Apply a quality tier to every system. Cheap changes (scale, radius, cadence) are instant;
   * shadow-map size / MSAA reallocate once; flashlight shadow toggling recompiles lit programs once.
   */
  applyQuality(name: TierName, reason: string): void {
    const q = QUALITY[name]
    this.quality = q
    this.world.setQuality(q)
    this.lighting.setQuality(q)
    this.monsters.budget = q.monsters
    this.monsters.rig.castShadow = q.name !== 'low'
    this.bike.castShadow = q.name !== 'low'
    this.car.castShadow = q.name !== 'low'
    this.post.setGodRays(q.godRays.divisor, q.godRays.samples, q.godRays.volumeSteps)
    this.post.setPaint(q.paint.stride, q.paint.bloom)
    this.horizon.configure(q.horizon)
    this.post.setPixelBudget(q.pixelBudget)
    this.post.setRenderScale(q.renderScale.start)
    globalUniforms.uGrassFade.value.set(q.grass.radius * 0.7, q.grass.radius)
    if (this.camera) {
      this.camera.far = q.viewDistance * 1.08
      this.camera.updateProjectionMatrix()
    }
    this.applyOverrides()
    this.lastQualityChange = `${name} (${reason})`
    this.store.set({ tier: name })
  }

  /** User overrides on top of the tier defaults ('auto' = tier value). */
  private applyOverrides(): void {
    const q = this.quality
    const st = this.settings
    this.post.setAA(st.aa === 'auto' ? q.aa : st.aa)
    this.post.setSharpness(st.sharpness === 'auto' ? q.sharpen : st.sharpness)
    this.post.grainScale = st.filmGrain ? 1 : 0
    // Painterly: tier default, or the player's explicit choice (LOW defaults off — ~25 fetches/px).
    const stride = q.paint.stride || (st.painterlyForce ? 1 : 0)
    this.post.setPaint(st.painterly ? stride : 0, q.paint.bloom)
    this.materials.setAlphaToCoverage(this.post.aa === 'msaa2' || this.post.aa === 'msaa4')
    if (st.resolution !== 'auto') this.post.setRenderScale(st.resolution)
    const native = window.devicePixelRatio || 1
    const dpr = st.pixelRatio === 'auto' ? Math.min(native, q.maxDpr) : st.pixelRatio === 'native' ? native : Math.min(native, st.pixelRatio)
    this.setDpr?.(dpr)
    // Real dynamic shadow for the character where the sun map re-renders every frame; blob otherwise.
    const realShadow = q.sunShadowEvery === 1
    this.character.castShadow = realShadow
    this.blobShadow.userData.enabled = !realShadow
  }

  private onAdaptive(d: AdaptiveDecision): void {
    const q = this.quality
    const s = this.post.renderScale
    switch (d.kind) {
      case 'scaleDown':
        this.post.setRenderScale(Math.max(q.renderScale.min, s - 0.1))
        break
      case 'scaleUp':
        this.post.setRenderScale(Math.min(q.renderScale.max, s + 0.1))
        break
      case 'tierDown': {
        const t = tierBelow(q.name)
        if (t) this.applyQuality(t, d.reason)
        return
      }
      case 'tierUp': {
        const t = tierAbove(q.name)
        if (t) this.applyQuality(t, d.reason)
        return
      }
    }
    this.lastQualityChange = `${d.kind} → ${this.post.renderScale.toFixed(2)} (${d.reason})`
  }

  // ---------------------------------------------------------------- frame

  private buildLoop(): void {
    const p = this.player
    this.loop
      .add({ name: 'look', update: () => p.look() })
      .add({
        name: 'fixed',
        update: (dt) => {
          // Hold the player until terrain colliders exist under them.
          p.frozen = !this.world.isReadyAt(p.curr.x, p.curr.z)
          this.physics.advance(dt, (fdt) => {
            p.fixedUpdate(fdt)
            this.car.fixedUpdate(fdt)
          })
          p.interpolate(this.physics.alpha)
          if (p.curr.y < this.world.fields.height(p.curr.x, p.curr.z) - 4) {
            p.teleport(p.curr.setY(this.world.fields.height(p.curr.x, p.curr.z) + 1))
          }
        },
      })
      .add({
        name: 'timeOfDay',
        update: (dt) => {
          this.tod.update(dt)
          if (this.tod.label !== this.store.get().phase) this.store.set({ phase: this.tod.label })
        },
      })
      .add({
        name: 'survival',
        update: (dt) => {
          const t = this.tod
          const monsterTime = t.isNight || t.nightmare > 0.5
          const cam = this.camera
          if (cam) {
            const fwd = cam.getWorldDirection(new THREE.Vector3()).setY(0).normalize()
            const c = this.cameraCtl
            this.monsters.update(dt, monsterTime, t.nightmare, fwd, this.lighting.flashlightOn, c.flashOrigin, c.flashTarget)
            this.lightning.update(dt, monsterTime, t.nightmare, cam)
          }
          this.health.update(dt)
          if (this.lightning.flash > 0.5) this.cameraCtl.shake = Math.max(this.cameraCtl.shake, this.lightning.lastDistance < 30 ? 0.6 : 0.1)
          if (this.health.dead) {
            this.respawnTimer -= dt
            if (this.respawnTimer <= 0) this.respawn()
          }
        },
      })
      .add({ name: 'camera', update: (dt) => this.camera && this.cameraCtl.update(dt, this.camera, p, this.lighting.flashlightOn) })
      .add({ name: 'bike', update: (dt) => this.bike.update(dt) }) // after camera: overrides the rider pose
      .add({
        name: 'car',
        update: (dt) => {
          this.car.showDriver = this.cameraCtl.mode === 'tpp'
          this.car.update(dt, this.physics.alpha, this.cameraCtl.flashOrigin, this.cameraCtl.flashTarget)
        },
      })
      .add({
        name: 'world',
        update: () => {
          if (!this.camera) return
          this.world.update(p.renderPosition, this.cullingDebug.cullCamera(this.camera))
        },
      })
      .add({
        name: 'lighting',
        update: (dt, time) => {
          const cam = this.camera
          if (!cam) return
          const c = this.cameraCtl
          this.lighting.flash = this.lightning.flash
          const nm = this.tod.nightmare
          this.lighting.flashColor.setRGB(0.9 + 0.1 * nm, 0.36 - 0.12 * nm, 0.55 - 0.25 * nm)
          skyUniforms.uSkyBolt.value = this.lightning.flash
          skyUniforms.uSkyBoltDir.value.copy(this.lightning.boltDir)
          skyUniforms.uSkyBoltColor.value.copy(this.lighting.flashColor)
          this.post.flash = this.lightning.flash
          this.post.damage = Math.max(this.health.hurt, this.health.dead ? 1 : 0, (1 - this.health.hp / this.health.max) * 0.35)
          this.lighting.update(dt, p.renderPosition, c.flashOrigin, c.flashTarget)
          this.ash.update(time, cam.position, THREE.MathUtils.smoothstep(this.tod.nightmare, 0.2, 0.9), this.renderer?.domElement.height ?? 800)
          const darkness = 1 - THREE.MathUtils.smoothstep(this.tod.sunDir.y, 0.05, 0.45) * (1 - this.tod.nightmare)
          this.beam.update(c.flashOrigin, c.flashTarget, this.lighting.flashlightOn, darkness, c.mode === 'fpp')
          const tp = this.tod.current
          this.fog.color.copy(tp.fogColor)
          // Clear up close; complete no later than the edge of this tier's loaded ring (skills/fog).
          // Fog closes in only at the horizon terrain's edge; the chunk ring edge is covered by it.
          // Fog completes at the tier's view distance; nothing beyond is drawn (see ChunkVisibility).
          const limit = this.quality.viewDistance
          this.fog.far = Math.min(tp.fogEnd, limit)
          this.fog.near = Math.min(tp.fogStart, this.fog.far * 0.55)
          if (this.scene?.background instanceof THREE.Color) this.scene.background.copy(tp.fogColor)
          this.sky.update(this.tod, cam, time)
          this.horizon.update(p.renderPosition, this.world.renderRadius)
          this.world.visibility.maxDistance = this.fog.far + 20
          this.water.update(time, cam.position, this.fog.near, this.fog.far, this.lighting.keyDir, this.lighting.sun.color)
          this.post.applyGrading(tp, time)
          const k = this.lighting.keyStrength
          this.post.updateGodRays(cam, this.lighting.sun, this.lighting.keyDir, tp.rays * k, tp.shafts * k, this.fog.near, this.fog.far, this.quality.sunShadowExtent * 1.2)
          globalUniforms.uTime.value = time
          globalUniforms.uCameraPos.value.copy(cam.position)
          globalUniforms.uPlayerPos.value.copy(p.renderPosition)
          globalUniforms.uKeyDirView.value.copy(this.lighting.keyDir).transformDirection(cam.matrixWorldInverse)
          globalUniforms.uKeyColor.value.copy(this.lighting.sun.color).multiplyScalar(Math.min(this.lighting.sun.intensity, 3) * 0.35)
          // Aerial perspective: fog toward the key light glows in its colour (strongest at low sun).
          globalUniforms.uScatterColor.value.copy(tp.fogColor).lerp(this.lighting.sun.color, 0.75).multiplyScalar(1.25)
          globalUniforms.uScatterAmount.value = this.lighting.keyStrength * (1 - Math.max(0, this.lighting.keyDir.y) * 0.8)
        },
      })
      .add({
        name: 'debug',
        update: () => {
          this.chunkDebug.update(this.world.chunks.values())
          this.physicsDebug.update()
        },
      })
  }

  /** Back on the road near where you fell, full health; nearby monsters retreat. */
  respawn(): void {
    const p = this.player.curr
    const z = p.z
    const x = this.world.fields.roadCenterX(z)
    this.player.teleport(new THREE.Vector3(x, this.world.fields.height(x, z) + 0.05, z))
    this.player.dead = false
    this.player.stunned = 0
    this.health.revive()
    this.monsters.scatter()
    this.store.set({ dead: false })
  }

  /** Called once R3F has created renderer/scene/camera. Returns a detach function. */
  attach(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, setDpr: (dpr: number) => void): () => void {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this.setDpr = setDpr
    this.perf = new PerformanceMonitor(renderer)
    this.device = detectDevice(renderer.getContext() as WebGL2RenderingContext)
    this.post.configure(renderer)
    const q = this.settings.quality
    this.applyQuality(q === 'auto' ? this.device.tier : q, q === 'auto' ? this.device.reason : 'setting')
    this.player.sensitivity = 0.0022 * this.settings.lookSensitivity
    this.adaptive.settle(3)
    scene.fog = this.fog
    scene.background = new THREE.Color()
    this.input.attach(renderer.domElement)
    return () => {
      this.input.detach()
      this.setDpr = null
      scene.fog = null
      this.perf?.dispose()
      this.perf = null
      this.renderer = this.scene = this.camera = null
    }
  }

  tick(dt: number): void {
    const perf = this.perf
    perf?.beginFrame()
    if (perf) {
      const q = this.quality
      const s = perf.stats
      const fixedRes = this.settings.resolution !== 'auto'
      const d = this.adaptive.sample(s.rawFrameMs, s.gpuMs, s.cpuMs, {
        canScaleDown: !fixedRes && this.post.renderScale > q.renderScale.min + 1e-3,
        canScaleUp: !fixedRes && this.post.renderScale < q.renderScale.max - 1e-3,
        canTierDown: tierBelow(q.name) !== null,
        // Phones: never auto-upgrade past medium — sustained load causes thermal throttling minutes later.
        canTierUp: tierAbove(q.name) !== null && !(this.device?.mobile && q.name !== 'low'),
      })
      if (d) this.onAdaptive(d)
    }
    if (import.meta.env.DEV && this.opts.stressMs) {
      const end = performance.now() + this.opts.stressMs
      while (performance.now() < end) {
        /* simulated slow device */
      }
    }
    this.loop.tick(dt)
  }

  render(): void {
    const { renderer, scene, camera, perf } = this
    if (!renderer || !scene || !camera) return
    perf?.gpu.begin()
    this.post.render(renderer, scene, camera)
    perf?.gpu.end()
    if (perf) {
      perf.endFrame()
      const s = perf.stats
      const w = this.world.stats
      s.chunksLoaded = w.loaded
      s.chunksVisible = w.visible
      s.chunksCulled = w.culled
      s.chunksPending = w.pending
      s.physicsChunks = w.physicsChunks
      s.instancesTotal = w.instances
      s.instancesDrawn = w.drawnInstances
      s.instancesCulled = w.instances - w.drawnInstances
      s.genMs = w.genMs
      s.buildMs = w.buildMs
      s.physicsBodies = this.physics.bodyCount
      s.physicsColliders = this.physics.colliderCount
      s.physicsMs = this.physics.stepMs
      s.monstersActive = this.monsters.count
      s.renderScale = this.post.renderScale
      s.renderTarget = this.post.targetSize
      s.canvas = `${renderer.domElement.width}×${renderer.domElement.height}`
    }
  }

  dispose(): void {
    window.removeEventListener('touchstart', this.onFirstTouch)
    this.world.dispose()
    this.physicsDebug.dispose()
    this.post.dispose()
    this.sky.dispose()
    this.beam.dispose()
    this.bike.dispose()
    this.car.dispose()
    this.monsters.dispose()
    this.lightning.dispose()
    this.ash.dispose()
    this.horizon.dispose()
    this.water.dispose()
    this.character.dispose()
    this.materials.dispose()
    this.physics.dispose()
  }
}
