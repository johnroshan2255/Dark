import * as THREE from 'three'
import { ART, isOverland, type ArtStyle } from '../rendering/artStyle'
import { downscaleTexture, loadModels, loadVehicle, type GameModels } from '../assets/loadModels'
import { tuningFor, vehicleDef, type VehicleTuning } from '../gameplay/vehicle/catalogue'
import { CHUNK_SIZE } from '../world/constants'
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
import { VehicleFx } from '../rendering/particles/VehicleFx'
import { RainParticles } from '../rendering/particles/RainParticles'
import { Weather } from '../rendering/weather/Weather'
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
import { styledGrass } from '../world/Forest/GrassField'
import { HorizonTerrain } from '../world/Terrain/HorizonTerrain'
import { Water } from '../rendering/water/Water'
import { GameLoop } from './GameLoop'
import { createStore, type GameStateShape, type Store } from './GameState'
import { loadSettings, saveSettings, type Settings } from './Settings'
import type { BiomeWeights } from '../world/Biomes'

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
  /** Art style override (?look=, not persisted). */
  look?: ArtStyle
  /** Vehicle override (?car=<catalogue id>, not persisted). */
  car?: string
  /** Skip the landing page (tests / screenshots). */
  play?: boolean
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
  car: Car
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

  private readonly bw: BiomeWeights = [0, 0]
  private readonly ahead = new THREE.Vector3()
  private readonly mistColor = new THREE.Color()
  private readonly fxLight = new THREE.Color()
  private readonly fxDir = new THREE.Vector3()
  private stepAcc = 0
  private baseFov = 0
  /** 0 by day … 1 at night (sun below the horizon or the nightmare), updated each frame. */
  private darkness = 0
  private lampOnAt: number | null = null
  /** Exhaust puffs + tyre smoke/dust (one draw, tier-capped pool). */
  readonly vehicleFx = new VehicleFx()
  /** Dynamic weather (clouds / rain / wind) and its rain streaks. */
  readonly weather: Weather
  readonly rain = new RainParticles()
  private rainBudget = 1
  private renderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  camera: THREE.PerspectiveCamera | null = null
  private truckMapLow: THREE.Texture | undefined

  /** @param onProgress loading-screen progress (0..1) + stage text. */
  static async create(opts: GameOptions, onProgress?: (f: number, status: string) => void): Promise<Game> {
    // Art style is fixed per session and must be known before any material/atlas/tree is built (artStyle.ts).
    ART.style = opts.look ?? loadSettings().artStyle
    applyShadowEdgeFade() // global shader-chunk patch; must precede any program compile
    // Models load in parallel with the physics wasm (both small: ~1.8 MB total).
    let phys = 0, mdl = 0
    const report = () => onProgress?.(0.12 + 0.3 * (phys * 0.5 + mdl * 0.5), mdl < 1 ? 'Loading the truck and the stranger…' : 'Waking up physics…')
    report()
    const saved = loadSettings()
    const vehicle = opts.car && vehicleDef(opts.car).id === opts.car ? opts.car : saved.garage.vehicle
    const [R, models] = await Promise.all([
      PhysicsWorld.load().then((r) => ((phys = 1), report(), r)),
      loadModels((f) => ((mdl = f), report()), vehicle),
    ])
    onProgress?.(0.45, 'Growing a new world…')
    return new Game(opts, new PhysicsWorld(R), models)
  }

  private constructor(opts: GameOptions, physics: PhysicsWorld, private readonly models: GameModels) {
    this.physics = physics
    this.opts = opts
    this.settings = loadSettings()
    this.savedQuality = this.settings.quality
    if (opts.tier && opts.tier !== 'auto') this.settings = { ...this.settings, quality: opts.tier }
    this.settings = { ...this.settings, artStyle: ART.style }
    this.adaptive.enabled = opts.adaptive !== false && this.settings.quality === 'auto'
    this.tod = new TimeOfDay(opts.hour ?? 15) // start in the warm afternoon (the garage view); night still comes with the cycle
    this.tod.dayLengthMinutes = this.settings.dayLength
    this.tod.setStyle(ART.style)
    this.lighting = new LightingSystem(this.tod)
    this.weather = new Weather(opts.seed, globalUniforms.uWind.value)
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
      driving: false,
      lights: false,
      landing: opts.play !== true,
      screen: 'menu',
      vehicle: models.truck.id,
      vehicleLoading: null,
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

    this.character = new CharacterModel(this.materials.character, models.human)
    this.character.yaw = this.player.yaw
    this.cameraCtl = new CameraController(physics, this.world.fields, this.character, this.blobShadow)
    this.cameraCtl.mode = this.settings.camera
    this.horizon = new HorizonTerrain(opts.seed)
    this.bike = new Bike(this.materials.character, this.player, this.character, this.world.fields, physics, this.input)
    this.bike.parkNear(spawn, this.player.yaw, 2.4)
    this.car = new Car(this.materials.character, models.truck, physics, this.world.fields, this.player, this.character, this.input, this.tuning(models.truck.id))
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
    this.audio.setEnabled(this.settings.sound)
    this.audio.setMusic(this.settings.music)
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
    this.envRoot.add(this.sky.mesh, this.bike.root, this.car.root, this.vehicleFx.points, this.rain.points, this.horizon.mesh, this.water.mesh, this.beam.mesh, this.monsters.rig.root, this.lightning.mesh, this.ash.points, this.character.root, this.blobShadow, this.chunkDebug.object, this.cullingDebug.helper, this.physicsDebug.object)

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
    // R: cycle the weather (auto → clear → cloudy → rain → auto) — testing / screenshots.
    i.onPress('KeyR', () => {
      const order = [null, 'clear', 'cloudy', 'rain'] as const
      this.weather.force = order[(order.indexOf(this.weather.force) + 1) % order.length]
    })
    i.onPress('KeyV', () => this.toggleCamera())
    i.onPress('KeyO', () => this.openSettings(!s.get().settingsOpen))
    i.onPress('KeyF', () => {
      // On foot / bike: the torch. In the truck: the headlights (the torch stays as it was).
      if (this.car.driving) s.set({ lights: (this.car.lights = !this.car.lights) })
      else s.set({ flashlight: this.lighting.toggleFlashlight() })
    })
    i.onPress('KeyE', () => {
      // One key for everything (touch: BIKE/CAR button). Riding → get off the bike first (the truck can't be
      // entered from the saddle); otherwise the truck takes priority when both are near.
      if (this.bike.riding) this.bike.toggle()
      else if (this.car.driving || this.car.near) {
        const wasDriving = this.car.driving
        this.car.toggle()
        // Door, then the engine catching (in) / dying (out).
        if (this.car.driving !== wasDriving) {
          this.audio.play('door', 0.7)
          this.audio.play(this.car.driving ? 'engineStart' : 'engineStop', 0.8)
        }
        this.cameraCtl.vehicle = this.car.driving ? { distance: 8, pivot: 2.3 } : null
        if (this.car.driving) this.car.lights = this.darkness > 0.5 // lights come on with the dark; off by day
        s.set({ driving: this.car.driving, lights: this.car.lights })
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
    if (patch.artStyle !== undefined && patch.artStyle !== ART.style) {
      // Shader programs, atlas and tree geometry depend on the style → apply it with a reload (artStyle.ts).
      saveSettings({ ...prev, ...patch, quality: this.savedQuality })
      const url = new URL(location.href)
      url.searchParams.delete('look')
      location.replace(url.toString())
      return
    }
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
    this.audio.setEnabled(this.settings.sound)
    this.audio.setMusic(this.settings.music)
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
    // LOW: half-size truck texture (1024² → 512², ~4 MB less GPU memory). Flat-coloured models have none.
    const map = this.models.truck.map
    if (map && this.car.modelId === this.models.truck.id) {
      this.truckMapLow ??= downscaleTexture(map, 512)
      this.car.setMap(q.name === 'low' ? this.truckMapLow : map)
    }
    this.post.setGodRays(q.godRays.divisor, q.godRays.samples, q.godRays.volumeSteps)
    this.post.banks = q.fog.banks
    this.post.setPaint(q.paint.stride, q.paint.bloom)
    this.vehicleFx.budget = q.particles.vehicle
    this.rainBudget = q.particles.rain
    this.horizon.configure(q.horizon)
    this.post.setPixelBudget(q.pixelBudget)
    this.post.setRenderScale(q.renderScale.start)
    const gr = styledGrass(q.grass).radius
    globalUniforms.uGrassFade.value.set(gr * 0.7, gr)
    if (this.camera) {
      // Far plane covers the horizon terrain (hills to the skyline); detail stops at viewDistance/the ring.
      this.camera.far = Math.max(q.viewDistance * 1.08, q.horizon.size * 0.56)
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
    // Overland: no sharpening — the unsharp mask makes thin grass blades sparkle on phones.
    this.post.setSharpness(st.sharpness === 'auto' ? (isOverland() ? 0 : q.sharpen) : st.sharpness)
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
    const realShadow = q.sunShadowEvery === 1 && ART.style !== 'storybook'
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
          // Hold the player until terrain colliders exist under them (and while the landing page is up).
          p.frozen = !this.world.isReadyAt(p.curr.x, p.curr.z) || this.store.get().landing
          this.physics.advance(dt, (fdt) => {
            p.fixedUpdate(fdt)
            this.car.fixedUpdate(fdt)
            this.bike.fixedUpdate(fdt)
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
          this.weather.update(dt, this.tod.hours, this.tod.day)
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
      .add({
        name: 'camera',
        update: (dt) => {
          if (!this.camera) return
          // Landing page: slow orbit around the parked car (the garage turntable); no look input.
          this.cameraCtl.garage = this.store.get().landing ? this.car.pos : null
          this.cameraCtl.update(dt, this.camera, p, this.lighting.flashlightOn)
          // BOOST feedback: the field of view widens (speed rush) while the boost is pushing the truck.
          const cam = this.camera
          this.baseFov ||= cam.fov
          const sim = this.car.sim
          const boosting = this.car.driving && sim.controls.boost && sim.controls.throttle > 0.1 && sim.speed > 3
          const fov = cam.fov + ((boosting ? this.baseFov + 9 : this.baseFov) - cam.fov) * Math.min(1, dt * (boosting ? 3 : 2))
          if (Math.abs(fov - cam.fov) > 0.01) {
            cam.fov = fov
            cam.updateProjectionMatrix()
          }
        },
      })
      .add({ name: 'bike', update: (dt) => this.bike.update(dt, this.physics.alpha) }) // after camera: overrides the rider pose
      .add({
        name: 'car',
        update: (dt) => {
          this.car.showDriver = this.cameraCtl.mode === 'tpp'
          this.car.update(dt, this.physics.alpha, this.cameraCtl.flashOrigin, this.cameraCtl.flashTarget)
          if (this.camera) {
            // Exhaust + tyre smoke/dust, lit by the sky fill and a share of the sun, sized in RT pixels.
            const L = this.lighting
            const sk = Math.min(L.sun.intensity, 3) * 0.22
            this.fxLight.copy(L.hemi.color).multiplyScalar(L.hemi.intensity * 0.55)
            this.fxLight.r += L.sun.color.r * sk
            this.fxLight.g += L.sun.color.g * sk
            this.fxLight.b += L.sun.color.b * sk
            this.vehicleFx.update(dt, this.car, this.world.fields, this.camera.position, globalUniforms.uWind.value, this.fxLight, this.post.targetHeight)
          }
        },
      })
      .add({
        name: 'world',
        update: () => {
          if (!this.camera) return
          // Physics look-ahead: where a moving vehicle / player will be in ~1.5 s → its chunk gets colliders early.
          const v = this.car.driving ? this.car.velocity(this.ahead) : this.ahead.copy(p.velocity)
          this.ahead.copy(v).multiplyScalar(1.5).add(p.renderPosition)
          this.world.update(p.renderPosition, this.cullingDebug.cullCamera(this.camera), this.ahead)
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
          const darkness = (this.darkness = 1 - THREE.MathUtils.smoothstep(this.tod.sunDir.y, 0.05, 0.45) * (1 - this.tod.nightmare))
          // One spot light: the torch on foot, the headlights in the truck (its own switch).
          const lit = this.car.driving ? this.car.lights : this.lighting.flashlightOn
          this.lighting.spotOn = lit
          this.beam.update(c.flashOrigin, c.flashTarget, lit, darkness, c.mode === 'fpp' && !this.car.driving)
          this.car.updateLamps(darkness)
          // Street lamps: on from dusk; `lampT` = seconds since they switched on (each post flickers to life in its own time).
          if (darkness > 0.55) this.lampOnAt ??= time
          else this.lampOnAt = null
          this.materials.setLamps(darkness, this.lampOnAt === null ? -1 : time - this.lampOnAt, time)
          const tp = this.tod.current
          // Weather on top of the phase blend: clouds dim/grey, rain washes, wind scales the shared uniform.
          this.weather.apply(tp, globalUniforms.uWind.value)
          globalUniforms.uWet.value = this.weather.wet
          this.lightning.storm = this.weather.rain
          // SOUND: the mixer follows the vehicles, weather and time of day; footsteps by stride length.
          {
            const camR = this.fxDir.set(1, 0, 0).applyQuaternion(cam.quaternion)
            const pan = (x: number, z: number) => { const dx = x - cam.position.x, dz = z - cam.position.z, l = Math.hypot(dx, dz) || 1; return ((dx * camR.x + dz * camR.z) / l) * 0.6 }
            const car = this.car, bike = this.bike, bs = bike.sim
            const sim = car.sim, slip = Math.max(...sim.wheelSlip)
            this.audio.frame({
              dt, darkness, nightmare: this.tod.nightmare, menu: this.store.get().landing, rain: this.weather.rain,
              car: { engineOn: car.driving, distance: car.pos.distanceTo(cam.position), pan: pan(car.pos.x, car.pos.z), speed: sim.speed, throttle: Math.max(0, sim.controls.throttle), boost: sim.controls.boost, slip },
              bike: { riding: bike.riding, distance: bike.root.position.distanceTo(cam.position), pan: pan(bike.root.position.x, bike.root.position.z), speed: bs.speed, throttle: Math.max(0, bs.controls.throttle) },
            })
            const onFoot = !car.driving && !bike.riding && !p.dead && p.grounded && !this.store.get().landing
            const v = onFoot ? p.horizontalSpeed : 0
            if (v > 0.6) {
              this.stepAcc += v * dt
              const stride = v > 4 ? 1.2 : 0.75 // run / walk step length (m)
              if (this.stepAcc >= stride) {
                this.stepAcc -= stride
                this.audio.footstep(0.3 + 0.3 * Math.min(1, v / 6))
              }
            } else this.stepAcc = 0.5 // the first step lands soon after you start moving
          }
          this.rain.update(time, cam.position, this.weather.rain, this.rainBudget, globalUniforms.uWind.value, this.fxLight.copy(tp.hemiSky).multiplyScalar(0.9), this.renderer?.domElement.height ?? 800)
          // Biome air: warm dusty haze over the desert, cold blue-white over the snowfields (weights under the player).
          const bw = this.world.fields.biome(p.renderPosition.x, p.renderPosition.z, this.bw, p.renderPosition.y)
          if (bw[0] > 0.001 || bw[1] > 0.001) {
            const r = 1 + 0.07 * bw[0] - 0.04 * bw[1], g = 1 - 0.02 * bw[0], b = 1 - 0.14 * bw[0] + 0.06 * bw[1]
            tp.fogColor.r *= r
            tp.fogColor.g *= g
            tp.fogColor.b *= b
          }
          this.fog.color.copy(tp.fogColor)
          // Clear up close; complete no later than the edge of this tier's loaded ring (skills/fog).
          // Fog closes in only at the horizon terrain's edge; the chunk ring edge is covered by it.
          // Fog completes at the tier's view distance; nothing beyond is drawn (see ChunkVisibility).
          // Fog is partial on land (fogMax/landHaze): hills stay hills out to the horizon mesh's rim, where they
          // dissolve into the sky. Streamed detail (trees, props) dithers out at the ring edge and is not drawn
          // past viewDistance — hidden by that fade + the forest-tinted horizon terrain, not by a white fog wall.
          const q = this.quality
          const farR = q.horizon.size * 0.5
          this.fog.far = Math.min(tp.fogEnd, farR)
          this.fog.near = Math.min(tp.fogStart, this.fog.far * 0.55)
          globalUniforms.uFogMax.value = tp.fogMax
          globalUniforms.uLandHaze.value.copy(tp.landHaze)
          globalUniforms.uFarEdge.value.set(farR * 0.7, farR * 0.96)
          const detailEdge = Math.min(q.viewDistance, q.renderRadius * CHUNK_SIZE + 24)
          globalUniforms.uCullFade.value.set(detailEdge * 0.74, detailEdge)
          // Foliage cards near the eye dissolve; in the third-person vehicle view (camera ~8 m behind, up in the
          // canopy) the band is wider so the leaves between the camera and the truck never fill the screen.
          // (Overland spruces are full to ~2.5 m up, so the band is wider: canopies between camera and truck go.)
          if (this.car.driving && c.mode === 'tpp') globalUniforms.uNearFade.value.set(isOverland() ? 3.0 : 2.5, isOverland() ? 12.0 : 7.0)
          else globalUniforms.uNearFade.value.set(1.4, 3.0)
          if (this.scene?.background instanceof THREE.Color) this.scene.background.copy(tp.fogColor)
          // Volumetric ground mist (materials + sky + water: analytic; shafts pass: drifting banks).
          skyUniforms.uSkyMist.value.set(tp.mistDensity * (1 - 0.35 * bw[0]), tp.mistBase, tp.mistFalloff, cam.position.y)
          this.mistColor.copy(tp.fogColor).lerp(this.lighting.sun.color, 0.12 * this.lighting.keyStrength).multiplyScalar(1.05)
          this.post.setMist(skyUniforms.uSkyMist.value.x, tp.mistBase, tp.mistFalloff, cam.position.y, this.mistColor, time, globalUniforms.uWind.value)
          this.sky.update(this.tod, cam, time)
          this.horizon.update(p.renderPosition, this.world.builtRadius)
          this.world.visibility.maxDistance = Math.min(q.viewDistance, q.renderRadius * CHUNK_SIZE + 24) + 20
          this.water.update(time, cam.position, this.fog.near, this.fog.far, this.lighting.keyDir, this.lighting.sun.color, this.weather.rain)
          this.post.applyGrading(tp, time)
          const k = this.lighting.keyStrength
          this.post.updateGodRays(cam, this.lighting.sun, this.lighting.keyDir, tp.rays * k, tp.shafts * k, this.fog.near, this.fog.far, this.quality.sunShadowExtent * 1.2)
          globalUniforms.uTime.value = time
          globalUniforms.uCameraPos.value.copy(cam.position)
          globalUniforms.uPlayerPos.value.copy(p.renderPosition)
          globalUniforms.uKeyDirView.value.copy(this.lighting.keyDir).transformDirection(cam.matrixWorldInverse)
          globalUniforms.uStoryAmt.value = tp.painted
          globalUniforms.uStoryLight.value.copy(tp.paintLight)
          globalUniforms.uUpView.value.set(0, 1, 0).transformDirection(cam.matrixWorldInverse)
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

  /**
   * Loading progress of the world around the player (0..1): chunks of the render ring built, the ground under
   * the player has colliders, the horizon terrain arrived. 1 = ready to show.
   */
  worldReadiness(): number {
    const R = this.world.renderRadius
    const ring = (2 * R + 1) ** 2
    const built = Math.min(1, this.world.chunks.size / ring)
    const p = this.player.curr
    const ground = this.world.isReadyAt(p.x, p.z) ? 1 : 0
    const horizon = this.horizon.mesh.visible ? 1 : 0
    return Math.min(built, 1) * 0.8 + ground * 0.1 + horizon * 0.1
  }

  // ---------------------------------------------------------------- garage

  /** The player's setup for a vehicle (stock + saved overrides). */
  tuning(id: string): VehicleTuning {
    return tuningFor(id, this.settings.garage.tuning[id])
  }

  /** Change the tuning of a vehicle; applied live when it is the one in the world. Persisted. */
  setTuning(id: string, patch: Partial<VehicleTuning>): void {
    const tuning = { ...this.settings.garage.tuning, [id]: { ...(this.settings.garage.tuning[id] ?? {}), ...patch } }
    this.settings = { ...this.settings, garage: { ...this.settings.garage, tuning } }
    saveSettings(this.settings)
    this.store.set({ settings: this.settings })
    if (this.car.modelId === id) this.car.retune(this.tuning(id))
  }

  /** Reset a vehicle to its stock setup. */
  resetTuning(id: string): void {
    const tuning = { ...this.settings.garage.tuning }
    delete tuning[id]
    this.settings = { ...this.settings, garage: { ...this.settings.garage, tuning } }
    saveSettings(this.settings)
    this.store.set({ settings: this.settings })
    if (this.car.modelId === id) this.car.retune(this.tuning(id))
  }

  private selecting: Promise<void> | null = null
  /** Put another catalogue vehicle in the world (downloads its model on first use), where the current one stands. */
  selectVehicle(id: string): Promise<void> {
    if (id === this.car.modelId || this.selecting) return this.selecting ?? Promise.resolve()
    this.store.set({ vehicleLoading: 0 })
    this.selecting = loadVehicle(id, (f) => this.store.set({ vehicleLoading: f }))
      .then((model) => {
        const pos = this.car.pos.clone(), heading = this.car.heading
        if (this.car.driving) this.car.toggle()
        this.car.dispose()
        this.car = new Car(this.materials.character, model, this.physics, this.world.fields, this.player, this.character, this.input, this.tuning(id))
        this.car.park(pos.x, pos.z, heading)
        this.envRoot.add(this.car.root)
        this.car.castShadow = this.quality.name !== 'low'
        this.car.setMap(this.quality.name === 'low' && model.map ? downscaleTexture(model.map, 512) : model.map)
        this.settings = { ...this.settings, garage: { ...this.settings.garage, vehicle: id } }
        saveSettings(this.settings)
        this.store.set({ settings: this.settings, vehicle: id, vehicleLoading: null, driving: false })
      })
      .catch((e: unknown) => {
        console.error(e)
        this.store.set({ vehicleLoading: null })
      })
      .finally(() => (this.selecting = null))
    return this.selecting
  }

  /** Front-end navigation: PLAY hands over control; GARAGE / BACK switch screens; the pause menu returns to it. */
  play(): void {
    this.store.set({ landing: false, screen: 'menu' })
  }
  showScreen(screen: 'menu' | 'garage'): void {
    if (document.pointerLockElement) document.exitPointerLock()
    this.store.set({ landing: true, screen, settingsOpen: false })
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
    this.vehicleFx.dispose()
    this.rain.dispose()
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
