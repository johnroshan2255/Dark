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
import { arcadeTopSpeed } from '../gameplay/vehicle/VehicleSim'
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
  AUTO_MAX_TIER,
  resolveQuality,
  heldLevels,
  nextHoldStep,
  type Feature,
  type QualitySettings,
  type TierName,
} from '../rendering/quality/QualityTiers'
import { globalUniforms } from '../rendering/shaders/uniforms'
import { applyShadowEdgeFade } from '../rendering/shadows/ShadowEdgeFade'
import { SkyDome } from '../rendering/sky/SkyDome'
import { skyUniforms } from '../rendering/sky/skyShader'
import { WorldManager } from '../world/WorldManager'
import { LandmarkSystem } from '../world/Landmarks/LandmarkSystem'
import { HorizonTerrain } from '../world/Terrain/HorizonTerrain'
import { Water } from '../rendering/water/Water'
import { LAYER_NO_REFLECT, PlanarReflection } from '../rendering/water/PlanarReflection'
import { WorldFields } from '../world/WorldFields'
import { Destruction } from '../gameplay/destruction/Destruction'
import { TrailMap } from '../rendering/trails/TrailMap'
import { WindDrift } from '../rendering/particles/WindDrift'
import { BiomeMap } from '../rendering/biome/BiomeMap'
import { applyBiomeAir } from '../rendering/weather/BiomeAir'
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
  /** Planar reflection of the scene in the water / ice (HIGH tier; only while water is in view). */
  readonly reflection = new PlanarReflection(WorldFields.WATER)
  /** Smashable fences, posts and farm props (debris physics; rebuilt when their chunk reloads). */
  readonly destruction: Destruction
  /** Footprints and tyre tracks in snow and sand. */
  readonly trails = new TrailMap()
  /** Blowing sand / drifting snow powder skimming over the ground. */
  readonly drift = new WindDrift()
  private readonly wheelPrev: (THREE.Vector3 | null)[] = [null, null, null, null]
  private readonly _wv = new THREE.Vector3()
  /** Region biome weights around the player as a texture (snow cover, ice, strata in the shaders). */
  readonly biomeMap: BiomeMap
  readonly horizon: HorizonTerrain
  /** Giant trees, windmills, ruins, statues, towers… on the high ground, drawn out to the skyline. */
  readonly landmarks: LandmarkSystem
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
  private readonly bwRegion: BiomeWeights = [0, 0]
  private readonly ahead = new THREE.Vector3()
  private readonly mistColor = new THREE.Color()
  private readonly fxLight = new THREE.Color()
  private readonly fxDir = new THREE.Vector3()
  private lastSteps = 0
  private baseFov = 0
  private readonly chaseV = new THREE.Vector3()
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
    this.adaptive.enabled = opts.adaptive !== false && (this.settings.quality === 'auto' || this.settings.hold60)
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
      held: null,
      fpsCap: false,
    })
    this.world = new WorldManager(opts.seed, this.materials, physics)
    this.biomeMap = new BiomeMap(this.world.fields.biomes)

    // Spawn on the road near the origin.
    const z = 8
    const x = this.world.fields.roadCenterX(z)
    const spawn = new THREE.Vector3(x, this.world.fields.surface(x, z) + 0.05, z)
    this.player = new PlayerController(physics, this.input, spawn)
    // Face down the road (+Z): forward = (-sin yaw, -cos yaw) = normalize(dx/dz, 1).
    this.player.yaw = Math.atan2(-(this.world.fields.roadCenterX(z + 1) - x), -1)
    this.player.pitch = -0.08

    this.character = new CharacterModel(this.materials.character, models.human)
    // Feet on the slope, the fallen body on the ground: the loaded chunk heights (cheap, = the rendered mesh).
    this.character.ground = (x, z) => this.world.groundAt(x, z) ?? this.world.fields.height(x, z)
    this.character.onStep = (x, z, fx, fz) => this.trails.stamp(x, z, fx, fz, 0.22, 0.12, 0.9)
    this.character.yaw = this.player.yaw
    this.cameraCtl = new CameraController(physics, this.world.fields, this.character, this.blobShadow)
    this.cameraCtl.mode = this.settings.camera
    this.horizon = new HorizonTerrain(opts.seed)
    this.landmarks = new LandmarkSystem(this.world.fields.landmarks, this.materials.landmark, physics)
    this.bike = new Bike(this.materials.character, this.player, this.character, this.world.fields, physics, this.input)
    this.bike.parkNear(spawn, this.player.yaw, 2.4)
    this.car = new Car(this.materials.character, models.truck, physics, this.world.fields, this.player, this.character, this.input, this.tuning(models.truck.id))
    this.car.sim.arcade = this.settings.handling !== 'sim' // Asphalt-style handling by default (VehicleSim)
    this.car.autoAccel = this.settings.autoAccelerate
    this.destruction = new Destruction(physics, this.materials.character)
    this.destruction.vehicle = {
      body: () => (this.car.driving ? this.car.sim.body : null),
      mass: () => this.car.tune.mass,
      preVel: () => this.car.sim.preVel,
    }
    this.destruction.onBreak = ({ ref, speed }) => {
      if (this.car.driving && this.car.sim.arcade) this.car.sim.nitro = Math.min(1, this.car.sim.nitro + 0.1) // takedowns fill the nitro
      this.world.chunks.get(ref.key)?.breakProp(ref.index)
      this.audio.crash(ref.type, speed, this.car.pos.distanceTo(this.camera?.position ?? this.car.pos))
      if (this.car.driving) this.cameraCtl.shake = Math.min(1, this.cameraCtl.shake + 0.15 + speed / 60)
    }
    {
      // Parked on the verge ~14 m down the road from the spawn.
      const cz = z + 14
      const f = this.world.fields
      const cx = f.roadCenterX(cz) + 1.4 // right lane (poles stand at +5.6 m)
      this.car.park(cx, cz, Math.atan2(-(f.roadCenterX(cz + 1) - f.roadCenterX(cz)), -1)) // along the road there
      // Start looking at the HOME LANDMARK (a giant oak in sight on the high ground — a place to go, Genshin's
      // opening vista), else at the car (it's what you drive first; the compass shows it either way).
      const home = f.landmarks.home()
      this.player.yaw = home ? Math.atan2(-(home.x - x), -(home.z - z)) : Math.atan2(-(cx - x), -(cz - z))
      if (home) this.player.pitch = 0.04
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
    this.envRoot.add(this.destruction.mesh, this.drift.points, this.sky.mesh, this.bike.root, this.car.root, this.vehicleFx.points, this.rain.points, this.horizon.mesh, this.landmarks.group, this.water.mesh, this.beam.mesh, this.monsters.rig.root, this.lightning.mesh, this.ash.points, this.character.root, this.blobShadow, this.chunkDebug.object, this.cullingDebug.helper, this.physicsDebug.object)
    // Not in the water's mirror: the water itself, near-field grass, particles, the torch beam, debug helpers.
    this.reflection.hide.push(this.water.mesh, this.world.grass.root, this.drift.points, this.vehicleFx.points, this.rain.points, this.ash.points, this.beam.mesh, this.blobShadow, this.chunkDebug.object, this.cullingDebug.helper, this.physicsDebug.object)

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

  /** The car's engine voice; in arcade the gearbox's shift points stretch to the arcade top speed. */
  private engineVoice(car: Car): { pitch: number; gears: number[] } {
    const e = vehicleDef(car.modelId).engine
    if (!car.sim.arcade) return e
    const k = arcadeTopSpeed(car.sim.tune) / Math.max(1, e.gears[e.gears.length - 2] * 1.05) // top gear near the top speed
    if (this.voiceK !== k || this.voice?.pitch !== e.pitch) {
      this.voiceK = k
      this.voice = { pitch: e.pitch, gears: e.gears.map((g) => g * k) }
    }
    return this.voice!
  }
  private voice: { pitch: number; gears: number[] } | null = null
  private voiceK = 0

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
      this.adaptive.enabled = patch.quality === 'auto' || this.settings.hold60
      this.held = [] // a new preset: start from it again
      this.holdSticky.clear()
      if (patch.quality !== 'auto') this.applyQuality(patch.quality, 'setting')
      else {
        // Back to auto from ULTRA (never an auto pick) → the detected tier; otherwise re-resolve if features reset.
        if (TIERS.indexOf(this.quality.name) > TIERS.indexOf(AUTO_MAX_TIER)) this.applyQuality(this.device?.tier ?? AUTO_MAX_TIER, 'auto')
        else if (patch.gfx !== undefined) this.applyQuality(this.quality.name, 'setting')
        this.adaptive.settle(2)
      }
      this.store.set({ adaptive: this.adaptive.enabled })
    } else if (patch.gfx !== undefined) {
      this.held = []
      this.applyQuality(this.quality.name, 'setting') // a feature changed: re-resolve the current preset
    } else {
      this.applyOverrides()
    }
    if (patch.hold60 !== undefined && patch.hold60 !== prev.hold60) {
      this.adaptive.enabled = this.opts.adaptive !== false && (this.settings.quality === 'auto' || patch.hold60)
      if (!patch.hold60 && this.held.length) {
        this.held = []
        this.applyQuality(this.quality.name, 'hold 60 off')
      }
      this.store.set({ adaptive: this.adaptive.enabled })
    }
    this.cameraCtl.mode = this.settings.camera as CameraMode
    this.car.sim.arcade = this.settings.handling !== 'sim'
    this.car.autoAccel = this.settings.autoAccelerate
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
    // The preset + the player's per-feature overrides (Settings → Graphics).
    if (this.quality.name !== name) this.held = [] // a different preset starts from its own levels
    let q = resolveQuality(name, this.settings.gfx)
    this.presetFeatures = q.features // the preset + player overrides, before Hold-60 reductions (cached: per-frame checks)
    if (this.held.length) q = resolveQuality(name, heldLevels(q.features, this.held)) // Hold 60: runtime reductions
    this.store.set({ held: this.heldSummary(name) })
    this.quality = q
    this.world.setQuality(q)
    this.lighting.setQuality(q)
    this.monsters.budget = q.monsters
    this.monsters.rig.castShadow = q.objectShadows
    this.bike.castShadow = q.objectShadows
    this.car.castShadow = q.objectShadows
    // LOW: half-size truck texture (1024² → 512², ~4 MB less GPU memory). Flat-coloured models have none.
    const map = this.models.truck.map
    if (map && this.car.modelId === this.models.truck.id) {
      this.truckMapLow ??= downscaleTexture(map, 512)
      this.car.setMap(q.name === 'low' ? this.truckMapLow : map)
    }
    this.post.setGodRays(q.godRays.divisor, q.godRays.samples, q.godRays.volumeSteps)
    this.post.banks = q.fog.banks
    this.post.setPaint(q.paint.stride, q.paint.bloom * q.fx.bloom)
    globalUniforms.uSurfaceDetail.value = q.fx.surface ? 1 : 0
    this.vehicleFx.budget = q.particles.vehicle
    this.rainBudget = q.particles.rain
    this.reflection.scale = q.reflections
    this.reflection.every = q.reflectionEvery
    this.post.setAO(q.ao.scale, q.ao.samples, q.ao.radius)
    this.horizon.configure(q.horizon)
    this.post.setPixelBudget(q.pixelBudget)
    // A new preset starts at its own scale; a Hold 60 feature step (same preset) keeps the current one.
    const samePreset = this.quality.name === name && reason.startsWith('hold 60')
    this.post.setRenderScale(samePreset ? THREE.MathUtils.clamp(this.post.renderScale, Math.min(q.renderScale.min, 0.65), q.renderScale.max) : q.renderScale.start)
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
    this.post.setPaint(st.painterly ? stride : 0, q.paint.bloom * q.fx.bloom)
    this.materials.setAlphaToCoverage(this.post.aa === 'msaa2' || this.post.aa === 'msaa4')
    if (st.resolution !== 'auto') this.post.setRenderScale(st.resolution)
    const native = window.devicePixelRatio || 1
    const dpr = st.pixelRatio === 'auto' ? Math.min(native, q.maxDpr) : st.pixelRatio === 'native' ? native : Math.min(native, st.pixelRatio)
    this.setDpr?.(dpr)
    // Real dynamic shadow for the character where the sun map re-renders every frame; blob otherwise.
    const realShadow = q.shadows && q.objectShadows && q.sunShadowEvery === 1 && ART.style !== 'storybook'
    this.character.castShadow = realShadow
    this.blobShadow.userData.enabled = !realShadow
  }

  private onAdaptive(d: AdaptiveDecision): void {
    const q = this.quality
    const s = this.post.renderScale
    switch (d.kind) {
      case 'scaleDown':
        this.post.setRenderScale(Math.max(this.holdMode ? Math.min(q.renderScale.min, 0.65) : q.renderScale.min, s - 0.1))
        break
      case 'scaleUp':
        this.post.setRenderScale(Math.min(q.renderScale.max, s + 0.1))
        break
      case 'tierDown': {
        // Chosen preset + Hold 60: lower the costliest feature one level instead of changing the preset.
        if (this.holdMode) {
          if (d.reason === 'probe reverted' && this.holdRestored) this.holdSticky.add(this.holdRestored)
          this.holdRestored = null
          this.holdStepAt = performance.now()
          const f = nextHoldStep(this.presetFeatures, this.held)
          if (f) {
            this.held.push(f)
            this.applyQuality(q.name, `hold 60: ${f} down`)
          }
          return
        }
        const t = tierBelow(q.name)
        if (t) this.applyQuality(t, d.reason)
        return
      }
      case 'tierUp': {
        // Restore Hold-60 reductions first; then (auto mode only) a real tier up.
        if (this.held.length) {
          if (!this.holdRestoreOk()) return
          const f = this.held.pop()!
          this.holdRestored = f
          this.applyQuality(q.name, `hold 60: ${f} back (${d.reason})`)
          return
        }
        if (this.settings.quality !== 'auto') return
        const t = tierAbove(q.name)
        if (t) this.applyQuality(t, d.reason)
        return
      }
    }
    this.lastQualityChange = `${d.kind} → ${this.post.renderScale.toFixed(2)} (${d.reason})`
  }

  /** Tyre tracks: a stamp per wheel on the ground along the path it rolled since the last frame. */
  private stampTyres(): void {
    const car = this.car
    for (let k = 0; k < 4; k++) {
      const w = car.sim.wheels[k]
      if (!w?.contact) {
        this.wheelPrev[k] = null
        continue
      }
      const cur = car.wheelContact(k, this._wv)
      const prev = this.wheelPrev[k]
      if (prev) {
        const dx = cur.x - prev.x, dz = cur.z - prev.z, d = Math.hypot(dx, dz)
        if (d > 3) prev.copy(cur) // teleport / park: no streak across the map
        else if (d > 0.04) {
          this.trails.stamp((cur.x + prev.x) / 2, (cur.z + prev.z) / 2, dx, dz, d / 2 + 0.12, 0.15 * car.tune.tyre, 0.95)
          prev.copy(cur)
        }
      } else this.wheelPrev[k] = cur.clone()
    }
  }

  /** Hold 60 runtime reductions on a chosen preset (each entry = one feature one level down; HOLD_ORDER). */
  private held: Feature[] = []
  /** performance.now() of the last Hold-60 step down (restores of the expensive features wait for calm). */
  private holdStepAt = 0
  /** Features whose restore had to be reverted: they stay lowered for the session (no repeating freeze). */
  private holdSticky = new Set<Feature>()
  private holdRestored: Feature | null = null
  /**
   * May Hold 60 try to restore its last reduction now? Restoring SHADOWS from off recompiles every lit program,
   * GRASS / TREES / VIEW rebuild the grass field or the chunk ring — on a phone each is a visible freeze, and a
   * probe that then fails froze twice. So those wait for 90 s of calm after the last step down, and a restore
   * that was reverted is never retried this session (cheap ones — reflections, AO, volumetrics, effects — probe
   * on the controller's own schedule).
   */
  private holdRestoreOk(): boolean {
    if (!this.held.length) return false
    const f = this.held[this.held.length - 1]
    if (this.holdSticky.has(f)) return false
    const expensive = f === 'shadows' || f === 'grass' || f === 'vegetation' || f === 'view'
    return !expensive || performance.now() - this.holdStepAt > 90_000
  }
  /** Feature levels of the current preset + overrides (no Hold-60 reductions), set by applyQuality. */
  private presetFeatures = QUALITY.medium.features
  /** Adaptive is holding 60 on an explicitly chosen preset (feature steps instead of tier changes). */
  private get holdMode(): boolean {
    // A chosen preset with Hold 60 — or AUTO already at the lowest preset (a small / old phone): keep lowering
    // features (down to HOLD_FLOOR) instead of giving up at "minimum quality".
    return (this.settings.quality !== 'auto' && this.settings.hold60) || (this.settings.quality === 'auto' && tierBelow(this.quality.name) === null)
  }
  private heldSummary(_name: TierName): string | null {
    if (!this.held.length) return null
    const base = this.presetFeatures, now = heldLevels(base, this.held)
    return [...new Set(this.held)].map((f) => `${f} ${base[f]} → ${now[f]}`).join(', ')
  }

  /**
   * 30 FPS CAP PROBE. A steady ~30 fps can be the browser / OS limiting the page (iOS Low Power Mode, Android
   * battery saver), which no quality setting can fix. When frames sit at ~33 ms for 3 s, the next 16 frames draw
   * NOTHING (the last image stays up) while their intervals and the CPU work are timed: still ~33 ms with little
   * CPU work → capped (store.fpsCap, HUD notice; quality is left alone). Re-checked every 2 minutes.
   */
  private capProbe = 0
  private capSlowS = 0
  private capNextS = 0
  private capClock = 0
  private capSum = 0
  private capN = 0
  private capTickMs = 0
  fpsCapped = false
  private updateCapProbe(frameMs: number): void {
    const dt = Math.min(0.25, frameMs / 1000)
    this.capClock += dt
    if (this.capProbe > 0) {
      if (this.capProbe <= 12) {
        this.capSum += frameMs
        this.capN++
      }
      if (--this.capProbe === 0) {
        const mean = this.capSum / Math.max(1, this.capN)
        // Capped: nothing drawn yet frames still ~30 fps, and our own per-frame work is far below that.
        this.fpsCapped = mean > 27 && this.capTickMs < 12
        this.store.set({ fpsCap: this.fpsCapped })
        this.lastQualityChange = `cap probe: ${mean.toFixed(1)} ms with nothing drawn → ${this.fpsCapped ? 'browser caps at 30 fps' : 'not capped'}`
        this.capNextS = this.capClock + 120
        this.adaptive.settle(2)
      }
      return
    }
    const thirty = frameMs > 29 && frameMs < 38
    this.capSlowS = thirty ? this.capSlowS + dt : Math.max(0, this.capSlowS - dt * 2)
    if (this.fpsCapped && !thirty && frameMs < 25) {
      this.fpsCapped = false // the cap went away (power mode changed)
      this.store.set({ fpsCap: false })
    }
    if (this.capSlowS > 3 && this.capClock >= this.capNextS && this.adaptive.enabled) {
      this.capProbe = 16
      this.capSum = this.capN = 0
      this.capTickMs = 0
      this.capSlowS = 0
    }
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
          if (p.curr.y < this.world.fields.surface(p.curr.x, p.curr.z) - 4) {
            p.teleport(p.curr.setY(this.world.fields.surface(p.curr.x, p.curr.z) + 1))
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
          const boosting = this.car.driving && (sim.arcade ? sim.nitroOn : sim.controls.boost && sim.controls.throttle > 0.1) && sim.speed > 3
          // Arcade: the view widens with speed too (≈ +12° at 170 km/h) — the Asphalt speed rush — plus the nitro kick.
          const rush = this.car.driving && sim.arcade ? Math.min(14, Math.max(0, sim.speed - 8) * 0.3) : 0
          const fov = cam.fov + ((boosting ? this.baseFov + 9 : this.baseFov) + rush - cam.fov) * Math.min(1, dt * (boosting ? 3 : 2))
          // CHASE CAMERA (arcade): when you are not looking around, the view swings back behind the car — toward
          // its direction of travel, so a drift is seen from the side like in Asphalt.
          if (this.car.driving && sim.arcade && performance.now() - this.input.lastLook > 1200) {
            const v = this.car.velocity(this.chaseV)
            const sp = Math.hypot(v.x, v.z)
            const travel = sp > 4 ? Math.atan2(-v.x, -v.z) : this.car.heading
            const want = sim.speed < -1 ? this.car.heading : travel + Math.atan2(Math.sin(this.car.heading - travel), Math.cos(this.car.heading - travel)) * 0.35
            const d = Math.atan2(Math.sin(want - p.yaw), Math.cos(want - p.yaw))
            p.yaw += d * Math.min(1, dt * (sp > 4 ? 3.5 : 1.5))
            p.pitch += (-0.12 - p.pitch) * Math.min(1, dt * 2)
          }
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
        update: (dt) => {
          this.destruction.update(dt)
          if (!this.camera) return
          // Physics look-ahead: where a moving vehicle / player will be in ~1.5 s → its chunk gets colliders early.
          const v = this.car.driving ? this.car.velocity(this.ahead) : this.ahead.copy(p.velocity)
          this.ahead.copy(v).multiplyScalar(1.5).add(p.renderPosition)
          this.world.update(p.renderPosition, this.cullingDebug.cullCamera(this.camera), this.ahead)
          {
            const q = this.quality
            this.landmarks.update(dt, p.renderPosition.x, p.renderPosition.z, q.landmarkRange, q.sunShadowExtent * 1.5, q.shadows && q.objectShadows)
          }
          this.biomeMap.update(p.renderPosition.x, p.renderPosition.z)
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
          // Biome air (cold snowfields, hot bleached desert) re-tints the phase params before the lights read them.
          const bw = this.world.fields.biome(p.renderPosition.x, p.renderPosition.z, this.bw, p.renderPosition.y)
          applyBiomeAir(this.tod.current, bw[0], bw[1])
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
          // No puddles on snow or sand: the snowfield and the desert stay dry underfoot.
          globalUniforms.uWet.value = this.weather.wet * (1 - bw[0]) * (1 - bw[1])
          this.lightning.storm = this.weather.rain
          // SOUND: the mixer follows the vehicles, weather and time of day; footsteps by stride length.
          {
            const camR = this.fxDir.set(1, 0, 0).applyQuaternion(cam.quaternion)
            const pan = (x: number, z: number) => { const dx = x - cam.position.x, dz = z - cam.position.z, l = Math.hypot(dx, dz) || 1; return ((dx * camR.x + dz * camR.z) / l) * 0.6 }
            const car = this.car, bike = this.bike, bs = bike.sim
            const sim = car.sim, slip = Math.max(...sim.wheelSlip)
            this.audio.frame({
              dt, darkness, nightmare: this.tod.nightmare, menu: this.store.get().landing, rain: this.weather.rain * (1 - bw[0]) * (1 - bw[1]),
              car: { engineOn: car.driving, distance: car.pos.distanceTo(cam.position), pan: pan(car.pos.x, car.pos.z), speed: sim.speed, wheelSpeed: sim.wheelSpeed, throttle: sim.controls.throttle, boost: sim.arcade ? sim.nitroOn : sim.controls.boost, slip, engine: this.engineVoice(car) },
              bike: { riding: bike.riding, distance: bike.root.position.distanceTo(cam.position), pan: pan(bike.root.position.x, bike.root.position.z), speed: bs.speed, throttle: Math.max(0, bs.controls.throttle) },
            })
            // Footsteps exactly when a foot plants (CharacterModel counts the touchdowns) — sound matches the feet.
            const onFoot = !car.driving && !bike.riding && !p.dead && p.grounded && !this.store.get().landing
            const steps = this.character.steps
            if (onFoot && steps !== this.lastSteps) this.audio.footstep(0.3 + 0.3 * Math.min(1, p.horizontalSpeed / 6))
            this.lastSteps = steps
          }
          // Precipitation by biome: rain in the forest, none over the desert; on the snowfields it falls as snow, and
          // a light snowfall drifts down even under a fair sky (heavier as the cloud builds).
          // (Region weights WITHOUT the altitude snow line: desert peaks carry snow caps, but it never snows on the dunes.)
          const region = this.world.fields.biome(p.renderPosition.x, p.renderPosition.z, this.bwRegion)
          const snowFall = bw[1] * (1 - region[0]) * Math.max(this.weather.rain, 0.35 + 0.5 * this.weather.cloud)
          const precip = this.weather.rain * (1 - bw[0]) * (1 - bw[1]) + snowFall
          this.rain.update(time, cam.position, precip, this.rainBudget, globalUniforms.uWind.value, this.fxLight.copy(tp.hemiSky).multiplyScalar(0.9), this.renderer?.domElement.height ?? 800, precip > 0 ? snowFall / precip : 0)
          this.drift.update(time, cam.position, p.renderPosition.y, 0, bw[1] * (1 - region[0]), this.weather.wind, this.quality.fx.drift, globalUniforms.uWind.value, this.fxLight, this.renderer?.domElement.height ?? 800)
          // Heat shimmer over distant desert ground on a sunny day (grading pass).
          this.post.material.uniforms.uHeat.value = (this.quality.fx.heat ? 1 : 0) * region[0] * this.lighting.keyStrength * Math.max(0, this.tod.sunDir.y) * (1 - this.weather.cloud) * (1 - darkness)
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
        this.car.sim.arcade = this.settings.handling !== 'sim'
        this.car.autoAccel = this.settings.autoAccelerate
        this.envRoot.add(this.car.root)
        this.car.castShadow = this.quality.objectShadows
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
    this.player.teleport(new THREE.Vector3(x, this.world.fields.surface(x, z) + 0.05, z))
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
    camera.layers.enable(LAYER_NO_REFLECT)
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
    const frameT0 = performance.now()
    const perf = this.perf
    perf?.beginFrame()
    if (perf) {
      const q = this.quality
      const s = perf.stats
      const fixedRes = this.settings.resolution !== 'auto'
      const hold = this.holdMode
      // Hold 60 on a chosen preset may drop the resolution further than the preset's own range before it
      // touches a feature (a little softer is a smaller loss than no shadows / reflections).
      const minScale = hold ? Math.min(q.renderScale.min, 0.65) : q.renderScale.min
      // 30 fps that is the BROWSER's cap (Low Power Mode / battery saver) can't be fixed by lowering quality:
      // probe it first (capProbe) and don't degrade anything while capped.
      this.updateCapProbe(s.rawFrameMs)
      const capped = this.capProbe > 0 || this.fpsCapped
      const d = capped ? null : this.adaptive.sample(s.rawFrameMs, s.gpuMs, s.cpuMs, {
        canScaleDown: !fixedRes && this.post.renderScale > minScale + 1e-3,
        canScaleUp: !fixedRes && this.post.renderScale < q.renderScale.max - 1e-3,
        canTierDown: hold ? nextHoldStep(this.presetFeatures, this.held) !== null : tierBelow(q.name) !== null,
        // Phones: never auto-upgrade past medium — sustained load causes thermal throttling minutes later.
        // Adaptive never climbs past HIGH: ULTRA is only ever the player's choice. Hold 60: restore reductions.
        canTierUp: (hold && this.held.length > 0 ? this.holdRestoreOk() : this.held.length > 0) || (this.settings.quality === 'auto' && tierAbove(q.name) !== null && TIERS.indexOf(q.name) < TIERS.indexOf(AUTO_MAX_TIER) && !(this.device?.mobile && q.name !== 'low')),
        canProbeTierUp: hold && this.holdRestoreOk(),
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
    // All of this frame's own CPU work (systems + anything before them) — what a cap probe must rule out.
    if (this.capProbe > 0) this.capTickMs = Math.max(this.capTickMs, performance.now() - frameT0)
  }

  private warmed = false
  /**
   * SHADER WARM-UP (once, when the world is ready — still behind the loading screen): every program the session
   * will need is compiled up front, in parallel where the driver supports it (KHR_parallel_shader_compile), instead
   * of the first time its object shows up mid-drive — a 50–300 ms freeze per program on phone GPUs (the "fps
   * drops" when a landmark, a rock formation, the monsters at dusk or the first snowflakes appeared). Hidden
   * objects are made visible for the compile call only; stand-ins cover what isn't in the scene yet (voxel rock
   * formations and places = non-instanced rock / vegetation, landmarks).
   */
  private warmShaders(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    this.warmed = true
    const t0 = performance.now()
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3))
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3))
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(9).fill(1), 3))
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2))
    const m = this.materials
    const stand = new THREE.Group()
    for (const mat of [m.rock, m.vegetation, m.landmark, m.terrain]) stand.add(new THREE.Mesh(g, mat))
    stand.position.copy(camera.position)
    scene.add(stand)
    const hidden: THREE.Object3D[] = []
    scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o)
        o.visible = true
      }
    })
    // Against the scene target (linear output, like every real frame — the canvas would compile the sRGB variant
    // of each program: unused duplicates, and the real ones still compiled later).
    const prevTarget = renderer.getRenderTarget()
    renderer.setRenderTarget(this.post.target)
    const done = renderer.compileAsync(scene, camera)
    renderer.setRenderTarget(prevTarget)
    for (const o of hidden) o.visible = false
    scene.remove(stand)
    done
      .then(() => (this.lastQualityChange = `shaders warmed: ${renderer.info.programs?.length ?? '?'} programs in ${(performance.now() - t0).toFixed(0)} ms`))
      .catch(() => {})
      .finally(() => g.dispose())
  }

  render(): void {
    const { renderer, scene, camera, perf } = this
    if (!renderer || !scene || !camera) return
    if (!this.warmed && this.worldReadiness() >= 1) this.warmShaders(renderer, scene, camera)
    if (this.capProbe > 0) return // cap probe: draw nothing for a few frames (the last image stays on screen)
    perf?.gpu.begin()
    if (this.quality.fx.trails) {
      this.stampTyres()
      this.trails.render(renderer, this.player.renderPosition)
    }
    globalUniforms.uTrailOn.value = this.quality.fx.trails ? 1 : 0
    this.reflection.active = this.world.stats.shoreVisible > 0
    this.sky.full() // the reflection's own camera/target: the dome draws the real sky there
    this.reflection.render(renderer, scene, camera)
    this.sky.prepare(renderer, camera, this.post.target.width, this.post.target.height, this.quality.skyScale)
    this.water.setReflection(this.reflection.target.texture, this.reflection.textureMatrix, this.reflection.valid)
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
    this.destruction.dispose()
    this.trails.dispose()
    this.drift.dispose()
    this.rain.dispose()
    this.monsters.dispose()
    this.lightning.dispose()
    this.ash.dispose()
    this.horizon.dispose()
    this.landmarks.dispose()
    this.water.dispose()
    this.reflection.dispose()
    this.biomeMap.dispose()
    this.character.dispose()
    this.materials.dispose()
    this.physics.dispose()
  }
}
