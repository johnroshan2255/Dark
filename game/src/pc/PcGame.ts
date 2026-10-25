import * as pc from 'playcanvas'
import * as THREE from 'three'
import { loadFixedMap, setActiveMap, type FixedMap } from '../world/map/FixedMap'
import { MapProps } from '../world/map/MapProps'
import { PillarField } from '../world/map/PillarField'
import { MistSheets } from '../world/map/MistSheets'
import { CaveSystem } from '../gameplay/caves/CaveSystem'
import { MOUTH_X } from '../world/Formations/caves'
import { ART, groundPalette } from '../rendering/artStyle'
import { downscaleTexture, loadHeroTowClips, loadModels, loadVehicle, type GameModels, type TruckModel } from '../assets/loadModels'
import { tuningFor, vehicleDef, type VehicleTuning } from '../gameplay/vehicle/catalogue'
import { AudioSystem } from '../audio/AudioSystem'
import { Bike } from '../gameplay/bmx/Bike'
import { Car, glassWeather } from '../gameplay/vehicle/Car'
import { arcadeTopSpeed } from '../gameplay/vehicle/VehicleSim'
import { MonsterSystem } from '../gameplay/monsters/MonsterSystem'
import { Health } from '../gameplay/survival/Health'
import { Lightning } from '../gameplay/weather/Lightning'
import { Weather } from '../rendering/weather/Weather'
import { Discovery } from '../gameplay/explore/Discovery'
import { CameraController, recentreGate, type CameraMode } from '../gameplay/player/CameraController'
import { CharacterModel, createBlobShadow } from '../gameplay/player/CharacterModel'
import { PlayerController } from '../gameplay/player/PlayerController'
import { Input } from '../input/Input'
import { PhysicsWorld } from '../physics/PhysicsWorld'
import { TimeOfDay } from '../rendering/lighting/TimeOfDay'
import { MaterialLibrary } from '../rendering/materials/MaterialLibrary'
import { QUALITY, TIERS, resolveQuality, type QualitySettings, type TierName } from '../rendering/quality/QualityTiers'
import { detectDevice, isTouchDevice, type DeviceProfile } from '../rendering/quality/DeviceProfile'
import { globalUniforms } from '../rendering/shaders/uniforms'
import { LandmarkSystem } from '../world/Landmarks/LandmarkSystem'
import { WorldFields } from '../world/WorldFields'
import { Destruction } from '../gameplay/destruction/Destruction'
import { GameLoop } from '../game/GameLoop'
import { createStore, type GameStateShape, type Store } from '../game/GameState'
import { NetClient, loadPlayerName, loadSetup, wireModel, type LocalPose, type RoomSetup } from '../net/NetClient'
import { RemotePlayers } from '../net/RemotePlayers'
import { TowSystem } from '../gameplay/tow/TowSystem'
import { Buttons, Flags, NO_PLAYER } from '../net/protocol'
import { loadSettings, saveSettings, type Settings } from '../game/Settings'
import { Biome, BIOME_COUNT, type BiomeWeights, type RegionWeights } from '../world/Biomes'
import { loadTreeModels } from '../assets/treeModels'
import { RainParticles } from '../rendering/particles/RainParticles'
import { VehicleFx } from '../rendering/particles/VehicleFx'
import { TyreMarks } from '../rendering/particles/TyreMarks'
import { AshParticles } from '../rendering/particles/AshParticles'
import { LightBeam } from '../gameplay/flashlight/LightBeam'
import type { WorldManager } from '../world/WorldManager'
import { BIOMES } from '../world/biomes/BiomeDefs'
import { GrassField, styledGrass } from '../world/Forest/GrassField'
import type { WorldChunk } from '../world/WorldChunk'
import type { Game, GameOptions } from '../game/Game'
import { PcWorld } from './PcWorld'
import { PcHorizon } from './PcHorizon'
import { PcWater } from './PcWater'
import { PcEnvironment } from './PcEnvironment'
import { createSharedTextures } from './textures'
import { MaterialBank, ThreeMirror } from './ThreeMirror'
import { registerGameMaterials } from './materials/gameMaterials'
import { PcStudio } from './PcStudio'
import { activeLook, lookFor, setLook } from './look'

/**
 * THE GAME ON PLAYCANVAS — the three build's Game (every gameplay system, the same store / settings / network /
 * front-end API the React UI drives), rendered by PlayCanvas:
 *  - the WORLD natively (PcWorld chunks + instance batcher, PcHorizon, PcWater, PcEnvironment: sky, time of day,
 *    weather, the key light with the engine's cascaded shadows, CameraFrame grading);
 *  - the GAMEPLAY objects (character, cars, bike, monsters, ropes, remote players, debris, landmarks, set pieces) by
 *    the render bridge (ThreeMirror): their systems keep their tested logic and their three scene graph as plain
 *    data; PlayCanvas draws them (skinning on the engine, the materials as engine materials — materials/gameMaterials).
 * Physics (Rapier: the server runs the same), input, audio and the network are engine-free and shared with the three
 * build unchanged.
 */
export class PcGame {
  readonly store: Store<GameStateShape>
  readonly input = new Input()
  readonly loop = new GameLoop()
  readonly tod: TimeOfDay
  readonly materials = new MaterialLibrary()
  readonly physics: PhysicsWorld
  readonly world: PcWorld
  readonly player: PlayerController
  readonly character: CharacterModel
  readonly blobShadow = createBlobShadow()
  readonly bike: Bike
  car: Car
  readonly net: NetClient
  readonly remotes: RemotePlayers
  readonly tow: TowSystem
  readonly health = new Health()
  readonly audio = new AudioSystem()
  readonly destruction: Destruction
  readonly landmarks: LandmarkSystem
  readonly caves: CaveSystem
  readonly monsters: MonsterSystem
  readonly lightning: Lightning
  readonly weather: Weather
  readonly discovery: Discovery
  readonly cameraCtl: CameraController
  /** Rain / snow / leaves / spores, exhaust + tyre smoke + dust, skid marks, the nightmare ash (their own GPU shaders). */
  readonly rain = new RainParticles()
  readonly vehicleFx = new VehicleFx()
  readonly tyreMarks = new TyreMarks()
  readonly ash = new AshParticles()
  /** The torch / headlight beam in the dark (its own additive cone shader) */
  readonly beam = new LightBeam()
  /** The meadow round the player (GrassField: its CPU tiles and clump masses; drawn by the engine — materials/grassMaterial) */
  readonly grass: GrassField
  private rainBudget = 1
  private readonly fxLight = new THREE.Color()
  /** The gameplay camera (CameraController poses it; copied into the engine camera every frame). */
  camera: THREE.PerspectiveCamera
  /** World-space gameplay objects, mirrored into the engine (ThreeMirror). */
  readonly envRoot = new THREE.Group()
  /** Multi-part objects drawn DYNAMICALLY BATCHED (ThreeMirror batch roots): the car, the bike, the map's set pieces, other
   *  players' cars — one draw per material for all their parts. */
  readonly parts = new THREE.Group()
  quality: QualitySettings = QUALITY.high
  settings: Settings
  device: DeviceProfile | null = null
  lastQualityChange = 'none'
  /** (three build only: the HUD reads these when present) */
  perf: null = null
  readonly post = { aa: 'none', renderScale: 1, raysSamples: 0, raysDivisor: 0, material: { uniforms: { uSharpen: { value: 0 } } } }
  readonly adaptive = { enabled: false, state: 'off', settle: (_s: number) => {} }
  readonly pillars: PillarField | null = null
  private mapProps: MapProps | null = null
  private mistSheets: MistSheets | null = null
  private readonly mistCol = new THREE.Color()

  // --- PlayCanvas
  readonly app: pc.AppBase
  readonly cam: pc.Entity
  readonly env: PcEnvironment
  readonly horizon: PcHorizon
  readonly water: PcWater
  readonly mirror: ThreeMirror
  readonly spot: pc.Entity
  private readonly savedQuality: Settings['quality']
  private readonly bw: BiomeWeights = [0, 0]
  private readonly bwRegion: BiomeWeights = [0, 0]
  private readonly rw: RegionWeights = new Float32Array(BIOME_COUNT)
  private readonly ahead = new THREE.Vector3()
  private readonly chaseV = new THREE.Vector3()
  private lastSteps = 0
  private baseFov = 0
  private darkness = 0
  private respawnTimer = 0
  private wreckClock = -1
  private time = 0
  readonly flashlight = { on: false }

  static async create(opts: GameOptions, canvas: HTMLCanvasElement, onProgress?: (f: number, status: string) => void): Promise<PcGame> {
    ART.style = 'bright'
    let phys = 0, mdl = 0
    const report = () => onProgress?.(0.12 + 0.3 * (phys * 0.5 + mdl * 0.5), mdl < 1 ? 'Loading the truck and the stranger…' : 'Waking up physics…')
    report()
    const saved = loadSettings()
    const vehicle = opts.car && vehicleDef(opts.car).id === opts.car ? opts.car : saved.garage.vehicle
    const device = await pc.createGraphicsDevice(canvas, {
      deviceTypes: [pc.DEVICETYPE_WEBGL2],
      antialias: false,
      powerPreference: 'high-performance',
    })
    const [R, models, map] = await Promise.all([
      PhysicsWorld.load().then((r) => ((phys = 1), report(), r)),
      loadModels((f) => ((mdl = f), report()), vehicle),
      opts.map ? loadFixedMap(opts.map) : loadFixedMap('zhangjiajie'),
      loadTreeModels(),
    ])
    setActiveMap(map ? map.id : null)
    onProgress?.(0.45, map ? `Loading ${map.name}…` : 'Growing a new world…')
    return new PcGame(opts, device, canvas, new PhysicsWorld(R), models, map)
  }

  private constructor(opts: GameOptions, device: pc.GraphicsDevice, readonly canvas: HTMLCanvasElement, physics: PhysicsWorld, private readonly models: GameModels, readonly map: FixedMap | null) {
    this.physics = physics
    setLook(lookFor(map)) // (the map's look: before any material or the CameraFrame is made)
    this.settings = loadSettings()
    this.savedQuality = this.settings.quality
    if (opts.tier && opts.tier !== 'auto') this.settings = { ...this.settings, quality: opts.tier }
    else if (this.settings.quality === 'auto') this.settings = { ...this.settings, quality: 'ultra', hold60: true }

    // --- the engine
    const ao = new pc.AppOptions()
    ao.graphicsDevice = device
    ao.componentSystems = [pc.RenderComponentSystem, pc.CameraComponentSystem, pc.LightComponentSystem]
    ao.resourceHandlers = []
    const app = new pc.AppBase(canvas)
    app.init(ao)
    app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW)
    app.setCanvasResolution(pc.RESOLUTION_AUTO)
    window.addEventListener('resize', this.onResize)
    // (phones: the browser's bars slide in / out and the screen turns without a reliable window resize — the canvas kept
    //  its old height, a black band under the game; the visual viewport reports both, the turn settles a moment later)
    window.visualViewport?.addEventListener('resize', this.onResize)
    window.addEventListener('orientationchange', this.onTurn)
    this.app = app
    createSharedTextures(device)
    app.scene.layers.getLayerById(pc.LAYERID_WORLD)!.opaqueSortMode = pc.SORTMODE_FRONT2BACK
    app.scene.clusteredLightingEnabled = false
    this.cam = new pc.Entity('camera')
    this.cam.addComponent('camera', { clearColor: new pc.Color(0, 0, 0), farClip: 2400, nearClip: 0.1, fov: 70 })
    app.root.addChild(this.cam)
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2400)

    const seed = map?.seed ?? opts.seed
    this.tod = new TimeOfDay(opts.hour ?? 15)
    this.tod.dayLengthMinutes = this.settings.dayLength
    this.tod.setStyle(ART.style)
    this.weather = new Weather(opts.seed, globalUniforms.uWind.value)
    this.discovery = new Discovery(opts.seed)
    const fields = new WorldFields(seed, map)
    this.env = new PcEnvironment(app, this.cam, fields, map, seed, this.tod.hours, { tod: this.tod, weather: this.weather })
    this.store = createStore<GameStateShape>({
      status: 'ready', error: null, seed: opts.seed, phase: this.tod.label, nightmare: false, pointerLocked: false,
      hud: this.settings.showFps, debugChunks: false, debugPhysics: false, cullingFrozen: false, flashlight: false,
      tier: this.quality.name, dpr: 1, adaptive: false, touch: isTouchDevice(), settings: this.settings, settingsOpen: false,
      dead: false, driving: false, flying: false, boat: false, lights: false, wipers: false, landing: opts.play !== true,
      screen: 'menu', worldReady: false, vehicle: models.truck.id, vehicleLoading: null,
      net: { status: 'off', message: null, room: null, me: NO_PLAYER, owner: NO_PLAYER, players: [] },
      roomSetup: loadSetup(), playerName: loadPlayerName(), held: null, fpsCap: false,
    })

    this.world = new PcWorld(app, fields, map, seed, this.materials.atlas.image as HTMLCanvasElement)
    this.world.physics = physics
    this.cam.camera!.layers = [...this.cam.camera!.layers, this.world.prepassLayer.id] // (the leaves' depth pre-pass)
    this.horizon = new PcHorizon(app, seed, (msg) => this.world.side(msg))
    this.env.horizon = this.horizon.size * 0.5
    this.water = new PcWater(app)
    const pal = map?.palette
    if (pal?.waterDeep) {
      const w = pal.water ?? pal.waterDeep, d = pal.waterDeep
      this.water.setDeep([w[0] * 0.55 + d[0] * 0.45, w[1] * 0.55 + d[1] * 0.45, w[2] * 0.55 + d[2] * 0.45], 0.42)
    }
    const bank = new MaterialBank(device)
    registerGameMaterials(bank, this.materials, this.world.mats)
    this.mirror = new ThreeMirror(app, bank)
    this.bank = bank
    this.studio = new PcStudio(app)
    // street lamps (the library's glow shader, ported) and the power wires: drawn by the chunks
    this.world.mats.lampGlow = bank.get(this.materials.lampGlow).material
    const wire = new pc.StandardMaterial()
    wire.useLighting = false
    wire.diffuse = new pc.Color(0, 0, 0)
    wire.emissive = new pc.Color(0.06, 0.06, 0.065)
    wire.update()
    this.world.setWireMaterial(wire)
    const L = this.materials
    this.grass = new GrassField(L.grass, L.grassMid, L.grassFar, L.grassNearU, L.grassMidU, L.grassFarU, fields, this.world.chunkMap as unknown as Map<string, WorldChunk>)
    this.grass.meadow = activeLook().soft // (the soft look: Over the Hill's dense soft meadows)
    this.mirror.add(this.grass.root, false)

    if (map) {
      this.mapProps = new MapProps(map, physics, this.materials)
      this.parts.add(this.mapProps.root)
      if (map.pillars.length) {
        ;(this as { pillars: PillarField | null }).pillars = new PillarField(map, physics)
        this.envRoot.add(this.pillars!.root)
      }
      if (map.mistSheets?.length) {
        this.mistSheets = new MistSheets(map, map.mistSheets.map(([y, density]) => ({ y, density })), new THREE.Color(0xe8eef4))
        this.envRoot.add(this.mistSheets.root)
      }
    }

    // --- the player, spawned as the three build (on the map's start point / the road near the origin)
    const z = map ? map.spawn.z : 8
    const x = map ? map.spawn.x : fields.roadCenterX(z)
    const spawn = new THREE.Vector3(x, fields.heightNoNet(x, z) + 0.05, z)
    this.player = new PlayerController(physics, this.input, spawn)
    this.player.yaw = map ? map.spawn.yaw : Math.atan2(-(fields.roadCenterX(z + 1) - x), -1)
    this.player.pitch = -0.08
    this.materials.hero.map = models.hero.map
    this.materials.hero.needsUpdate = true
    this.character = new CharacterModel(this.materials.hero, models.hero)
    this.character.ground = (x, z) => this.physics.groundBelow(x, z, this.player.curr.y + 0.6, this.world.groundAt(x, z) ?? fields.height(x, z))
    this.character.yaw = this.player.yaw
    this.cameraCtl = new CameraController(physics, fields, this.character, this.blobShadow)
    this.cameraCtl.mode = this.settings.camera
    this.landmarks = new LandmarkSystem(fields.landmarks, this.materials.landmark, physics, seed, groundPalette(), (msg) => this.world.side(msg))
    this.caves = new CaveSystem(fields)
    this.bike = new Bike(this.materials.character, this.player, this.character, fields, physics, this.input)
    this.car = new Car(this.materials.character, models.truck, physics, fields, this.player, this.character, this.input, this.tuning(models.truck.id))
    this.car.sim.arcade = this.settings.handling === 'arcade'
    this.car.driveSettings(this.settings.gearbox, this.settings.aids, this.input.touch, this.settings.offroadAssist)
    this.car.autoAccel = this.settings.autoAccelerate
    this.wireCar()
    this.destruction = new Destruction(physics, this.materials.debris)
    this.destruction.vehicle = {
      body: () => (this.car.driving ? this.car.sim.body : null),
      mass: () => this.car.tune.mass,
      preVel: () => this.car.sim.preVel,
    }
    this.destruction.onBreak = ({ ref, speed }) => {
      if (this.car.driving && this.car.sim.arcade) this.car.sim.nitro = Math.min(1, this.car.sim.nitro + 0.1)
      this.world.chunkMap.get(ref.key)?.breakProp(ref.index)
      this.audio.crash(ref.type, speed, this.car.pos.distanceTo(this.camera.position))
      if (this.car.driving) this.cameraCtl.shake = Math.min(1, this.cameraCtl.shake + 0.15 + speed / 60)
    }
    {
      const ahead = map ? this.roadPoint(x - Math.sin(map.spawn.yaw) * 14, z - Math.cos(map.spawn.yaw) * 14) : null
      const cz = ahead ? ahead.z : z + 14
      const cx = ahead ? ahead.x : fields.roadCenterX(cz) + 1.4
      const yawP = this.player.yaw
      this.pendingSpawn = { x: cx, z: cz, place: () => {
        this.player.teleport(spawn.setY(fields.surface(x, z) + 0.05))
        this.bike.parkNear(spawn, yawP, 2.4)
        this.car.park(cx, cz, ahead ? ahead.yaw : Math.atan2(-(fields.roadCenterX(cz + 1) - fields.roadCenterX(cz)), -1))
        if (opts.at === 'cave') this.spawnAtCave()
      } }
      this.player.yaw = Math.atan2(-(cx - x), -(cz - z))
      this.character.yaw = this.player.yaw
      const yaw0 = this.player.yaw
      this.landmarks.onHome = (home) => {
        if (!home || opts.at === 'cave' || this.player.yaw !== yaw0) return
        this.player.yaw = Math.atan2(-(home.x - x), -(home.z - z))
        this.player.pitch = 0.04
        this.character.yaw = this.player.yaw
      }
    }
    this.monsters = new MonsterSystem(fields, this.player, this.health, this.audio)
    this.monsters.solid = (x, z, nearY) => this.physics.groundBelow(x, z, nearY + 0.6, fields.surface(x, z))
    this.lightning = new Lightning(fields, this.player, this.health, this.audio)
    this.applyNightGhosts()
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
    this.envRoot.add(this.caves.group, this.destruction.mesh, this.landmarks.group, this.monsters.rig.root, this.lightning.mesh, this.character.root, this.blobShadow, this.rain.points, this.vehicleFx.points, this.tyreMarks.mesh, this.ash.points, this.beam.mesh)
    const asGame = this as unknown as Game
    this.remotes = new RemotePlayers(this.materials.hero, models.hero, (id) => loadVehicle(id), this.materials.characterInstanced, (x, z) => this.world.groundAt(x, z) ?? fields.height(x, z), (x, z) => this.world.groundAt(x, z))
    this.remotes.setQuality(this.quality.remoteCharacters, this.quality.remoteCars)
    this.parts.add(this.remotes.root, this.bike.root, this.car.root)
    this.tow = new TowSystem(asGame)
    void loadHeroTowClips().then((c) => (this.character.addClips(c), this.remotes.addClips(c))).catch(() => {})
    this.envRoot.add(this.tow.root)
    this.net = new NetClient(asGame)
    {
      const prev = physics.afterStep
      physics.afterStep = () => {
        prev?.()
        this.net.vehicle.afterStep()
      }
    }
    this.mirror.add(this.envRoot)
    this.mirror.add(this.parts, true, true)

    // the torch / the headlights: ONE engine spot light, always in the light set (0 when off: no recompiles)
    this.spot = new pc.Entity('spot')
    this.spot.addComponent('light', { type: 'spot', castShadows: false, range: 45, innerConeAngle: 4, outerConeAngle: 30, intensity: 0, color: new pc.Color(1, 0.93, 0.8), falloffMode: pc.LIGHTFALLOFF_INVERSESQUARED })
    app.root.addChild(this.spot)

    this.device = detectDevice((device as unknown as { gl: WebGL2RenderingContext }).gl)
    const q = this.settings.quality
    this.applyQuality(q === 'auto' ? this.device.tier : q, 'setting')
    this.player.sensitivity = 0.0022 * this.settings.lookSensitivity
    this.input.attach(canvas)
    this.input.onLockChange = (locked) => this.store.set({ pointerLocked: locked })

    // PlayCanvas's own frame stats (MiniStats) on F3 (the HUD setting)
    const so = pc.MiniStats.getDefaultOptions()
    so.startSizeIndex = 1
    so.resourcesEnabled = true
    // (frames per second first: the engine counts them in app.stats.frame.fps; MiniStats only lists frame ms)
    so.stats.unshift({ name: 'FPS', stats: ['frame.fps'], watermark: 60 })
    this.stats = new pc.MiniStats(app, so)
    this.stats.enabled = this.settings.showFps
    this.applyPost(this.quality) // (anti-aliasing, sharpening, resolution)

    this.bindKeys()
    this.buildLoop()
    app.on('update', this.frame)
    app.start()
  }

  private readonly stats: pc.MiniStats
  private readonly bank: MaterialBank
  private readonly studio: PcStudio
  private lampOnAt: number | null = null
  private readonly onResize = () => this.app.resizeCanvas()
  private readonly onTurn = () => { this.onResize(); setTimeout(this.onResize, 250); setTimeout(this.onResize, 700) }

  // ---------------------------------------------------------------- input

  private bindKeys(): void {
    const s = this.store
    const i = this.input
    i.onPress('F3', () => this.updateSettings({ showFps: !this.settings.showFps }))
    i.onPress('KeyT', () => this.toggleDayNight())
    i.onPress('KeyG', () => this.tod.nextPreset())
    i.onPress('KeyN', () => this.toggleNightmare())
    i.onPress('KeyR', () => {
      if (this.car.driving) return this.respawnHere()
      const order = [null, 'clear', 'cloudy', 'rain'] as const
      this.weather.force = order[(order.indexOf(this.weather.force) + 1) % order.length]
    })
    i.onPress('KeyV', () => this.toggleCamera())
    i.onPress('KeyO', () => {
      if (this.car.driving && !s.get().settingsOpen) this.car.toggleBoat()
      else this.openSettings(!s.get().settingsOpen)
    })
    i.onPress('KeyF', () => {
      if (this.car.driving) s.set({ lights: (this.car.lights = !this.car.lights) })
      else s.set({ flashlight: (this.flashlight.on = !this.flashlight.on) })
    })
    i.onPress('KeyJ', () => {
      if (this.car.driving) s.set({ wipers: (this.car.wiperOn = !this.car.wiperOn) })
    })
    i.onPress('KeyE', () => {
      if (!this.car.driving && !this.bike.riding && this.caves.tryOpen(this.player.renderPosition)) {
        this.health.revive()
        return
      }
      if (this.bike.riding) this.bike.toggle()
      else if (this.car.occupied || this.car.near) this.car.toggle()
      else this.bike.toggle()
    })
    i.onPress('KeyL', () => {
      if (!this.net.flyingAllowed && !this.car.flyMode) return this.notify('Flying is off in this room', 2000)
      this.car.toggleFly()
    })
    i.onPress('KeyH', () => this.tow.press())
    i.onPress('KeyX', () => (this.car.shift(1), this.net.vehicle.press(Buttons.SHIFT_UP)))
    i.onPress('KeyZ', () => (this.car.shift(-1), this.net.vehicle.press(Buttons.SHIFT_DOWN)))
    i.onPress('KeyQ', () => (this.car.toggleLowRange(), this.net.vehicle.press(Buttons.LOW_RANGE)))
    i.onPress('KeyK', () => (this.car.cycleLockers(), this.net.vehicle.press(Buttons.LOCKERS)))
    i.onPress('F7', () => this.updateSettings({ quality: TIERS[(TIERS.indexOf(this.quality.name) + 1) % TIERS.length] }))
    window.addEventListener('touchstart', this.onFirstTouch, { passive: true, once: true })
  }

  private onFirstTouch = () => this.store.set({ touch: true })

  toggleDayNight(): void {
    this.tod.toggleDayNight()
  }

  private applyNightGhosts(): void {
    const on = this.settings.nightGhosts || this.tod.nightmareTarget > 0.5
    this.monsters.enabled = on
    this.lightning.harmful = on
  }

  toggleNightmare(): void {
    const on = this.tod.nightmareTarget < 0.5
    this.tod.setNightmare(on)
    this.store.set({ nightmare: on })
    this.applyNightGhosts()
  }

  toggleCamera(): void {
    this.updateSettings({ camera: this.settings.camera === 'fpp' ? 'tpp' : 'fpp' })
  }

  openSettings(open: boolean): void {
    if (open && document.pointerLockElement) document.exitPointerLock()
    this.store.set({ settingsOpen: open })
  }

  private wireCar(): void {
    const car = this.car
    car.sim.water = (x, z) => this.world.waterAt(x, z)
    car.onEvent = (e) => {
      if (car !== this.car) return
      if (e === 'doorOpen') this.audio.play('door', 0.35, 1.25)
      else if (e === 'doorSlam') this.audio.play('door', 0.75)
      else if (e === 'drive') {
        this.audio.play(car.driving ? 'engineStart' : 'engineStop', 0.8)
        this.cameraCtl.vehicle = car.driving ? { distance: 8, pivot: 2.3 } : null
        if (car.driving) car.lights = this.darkness > 0.5
        this.store.set({ driving: car.driving, lights: car.lights, flying: car.driving && car.flyMode, boat: car.boatMode })
      } else if (e === 'fly') {
        this.audio.play('boost', 0.6, 0.8)
        this.store.set({ flying: car.flyMode })
      } else if (e === 'boat') {
        this.audio.play('boost', 0.35, 0.6)
        this.store.set({ boat: car.boatMode })
      } else if (e === 'clunk') this.audio.play('door', 0.5, 0.55)
      else if (e === 'hint') this.notify(car.hint)
      else if (e === 'explode') {
        const at = car.engineWorld(new THREE.Vector3())
        this.vehicleFx.explode(at)
        this.audio.explosion(this.camera.position.distanceTo(at))
        this.cameraCtl.shake = 1
        const d = this.player.curr.distanceTo(at)
        if (d < 9) this.health.damage(Math.round(90 * (1 - d / 9) + 10), 'explosion')
        this.store.set({ carDamage: 100, driving: false })
        this.notify('The car blew up!', 3500)
        this.wreckClock = 12
      }
    }
    car.onDamage = (_amount, at, sev) => {
      if (car !== this.car) return
      const before = this.store.get().carDamage ?? 0, now = Math.round(car.damageLevel * 100)
      this.audio.crash(10, 6 + sev * 2.5, this.camera.position.distanceTo(at))
      if (car.driving) this.cameraCtl.shake = Math.min(1, this.cameraCtl.shake + 0.2 + sev / 14)
      this.store.set({ carDamage: now })
      if (before < 50 && now >= 50 && now < 90) this.notify('The engine is smoking — the car is badly damaged', 3200)
      else if (before < 90 && now >= 90 && now < 100) this.notify('The engine is on FIRE — get out!', 3500)
    }
  }

  readonly notice = { text: '', until: 0 }
  notify(text: string, ms = 2600): void {
    this.notice.text = text
    this.notice.until = performance.now() + ms
  }

  private readonly simVoice = { rpm: 0, load: 0, shifting: false, electric: false }
  private engineSim(car: Car): typeof this.simVoice | undefined {
    const D = car.sim.real
    if (!D) return undefined
    const P = D.R.power, v = this.simVoice
    v.rpm = (D.we - P.wIdle) / Math.max(1, P.wRedline - P.wIdle)
    v.load = D.load
    v.shifting = D.shifting
    v.electric = P.kind === 'electric'
    return v
  }

  private voice: { pitch: number; gears: number[] } | null = null
  private voiceK = 0
  private engineVoice(car: Car): { pitch: number; gears: number[] } {
    const e = vehicleDef(car.modelId).engine
    if (!car.sim.arcade) return e
    const k = arcadeTopSpeed(car.sim.tune) / Math.max(1, e.gears[e.gears.length - 2] * 1.05)
    if (this.voiceK !== k || this.voice?.pitch !== e.pitch) {
      this.voiceK = k
      this.voice = { pitch: e.pitch, gears: e.gears.map((g) => g * k) }
    }
    return this.voice!
  }

  // ---------------------------------------------------------------- settings & quality

  updateSettings(patch: Partial<Settings>): void {
    const prev = this.settings
    this.settings = { ...prev, ...patch }
    saveSettings({ ...this.settings, quality: patch.quality ?? this.savedQuality })
    this.store.set({ settings: this.settings, hud: this.settings.showFps })
    if ((patch.quality !== undefined && patch.quality !== prev.quality) || patch.gfx !== undefined) {
      const q = this.settings.quality
      this.applyQuality(q === 'auto' ? (this.device?.tier ?? 'high') : q, 'setting')
    }
    this.stats.enabled = this.settings.showFps
    this.cameraCtl.mode = this.settings.camera as CameraMode
    this.car.sim.arcade = this.settings.handling === 'arcade'
    this.car.driveSettings(this.settings.gearbox, this.settings.aids, this.input.touch, this.settings.offroadAssist)
    this.car.autoAccel = this.settings.autoAccelerate
    this.audio.setEnabled(this.settings.sound)
    this.audio.setMusic(this.settings.music)
    this.applyNightGhosts()
    this.tod.dayLengthMinutes = this.settings.dayLength
    this.player.sensitivity = 0.0022 * this.settings.lookSensitivity
  }

  /**
   * A quality tier on the PlayCanvas systems: the chunk ring and LOD rings, plants / far rocks / near tree level,
   * the sun's shadow map size and range, object shadows, the pixel ratio, the monster and remote budgets.
   */
  applyQuality(name: TierName, reason: string): void {
    const q = resolveQuality(name, this.settings.gfx)
    this.quality = q
    const w = this.world
    w.radius = Math.max(2, Math.min(4, q.renderRadius))
    w.lodRings = q.lodRings
    w.buildPerFrame = Math.max(1, q.buildPerFrame)
    // (the soft look: Over the Hill's FUR-dense meadow — 2.5× the tier's blades, taller and wider: a continuous sheet)
    const gs = styledGrass(q.grass)
    this.grass.configure(activeLook().soft ? { ...gs, density: Math.round(gs.density * 2.5), tall: (gs.tall ?? 1) * 1.25, wide: (gs.wide ?? 1) * 1.3 } : gs)
    w.detail = { plants: q.plants, treeNear: q.trees.near, farRocks: q.vegDetail.farRocks, treeCast: !q.vegDetail.lean }
    const key = this.env.lighting.key.light!
    key.castShadows = q.shadows || q.imageShadows
    key.shadowResolution = Math.min(2048, Math.max(1024, q.sunShadowSize))
    // (one cascade on LOW / MEDIUM: half the shadow draws; two near-far cascades on HIGH / ULTRA)
    key.numCascades = q.name === 'high' || q.name === 'ultra' ? 2 : 1
    // (the soft look: wider soft shadow edges where the GPU has room — PCF5, ~2× PCF3's shadow taps)
    key.shadowType = activeLook().softShadows && (q.name === 'high' || q.name === 'ultra') ? pc.SHADOW_PCF5_32F : pc.SHADOW_PCF3_32F
    key.shadowDistance = Math.max(60, Math.min(120, q.sunShadowExtent * 1.6))
    // (the cached sun shadow is an image of the still world: moving things would smear across it — they take their
    //  blob shadows instead)
    const objShadows = q.objectShadows && !this.env.lighting.cached
    this.car.castShadow = objShadows
    this.parts.userData.castShadow = objShadows // (the batched parts: one flag)
    this.bike.castShadow = objShadows
    this.monsters.rig.castShadow = objShadows
    this.character.castShadow = objShadows
    this.blobShadow.userData.enabled = !objShadows
    this.blobShadow.visible = !objShadows
    this.monsters.budget = q.monsters
    this.vehicleFx.budget = q.particles.vehicle
    this.tyreMarks.setBudget(q.tyreMarks)
    this.rainBudget = q.particles.rain
    this.caves.fxShare = q.particles.rain
    this.remotes?.setQuality(this.device?.mobile ? Math.min(q.remoteCharacters, 6) : q.remoteCharacters, this.device?.mobile ? Math.min(q.remoteCars, 3) : q.remoteCars)
    this.car.tyreShear = q.name === 'high' || q.name === 'ultra'
    this.car.gloss = q.name !== 'low'
    const map = this.models.truck.map
    if (map && this.car.modelId === this.models.truck.id) {
      this.truckMapLow ??= downscaleTexture(map, 512)
      this.car.setMap(q.name === 'low' ? this.truckMapLow : map)
    }
    const native = window.devicePixelRatio || 1
    const st = this.settings
    let dpr = st.pixelRatio === 'auto' ? Math.min(native, q.maxDpr) : st.pixelRatio === 'native' ? native : Math.min(native, st.pixelRatio)
    if (this.device?.mobile) dpr = Math.min(dpr, 2)
    this.app.graphicsDevice.maxPixelRatio = dpr
    this.app.resizeCanvas()
    this.store.set({ dpr, tier: name })
    this.cam.camera!.farClip = Math.max(q.viewDistance * 1.08, this.horizon.size * 0.56)
    this.applyPost(q)
    this.lastQualityChange = `${name} (${reason})`
  }
  private truckMapLow: THREE.Texture | undefined

  /**
   * POST on PlayCanvas's CameraFrame (its built-in passes), per tier — the three build's PostPipeline features:
   *  - render scale: the tier's start scale (or the player's fixed resolution), phones capped to the pixel budget;
   *  - anti-aliasing: MSAA 2 / 4 on the scene target ('fxaa' → the engine's sharpen-free 1×: CameraFrame has no FXAA;
   *    MEDIUM+ get TAA instead — the engine's temporal AA, ~0.2 ms);
   *  - sharpening (the upscale), BLOOM (HDR: the lamps, headlights, spores, lightning — MEDIUM+),
   *    SSAO (lighting-only: soft contact shade under the cars, rocks and trees — the tier's AO samples).
   * Cost: TAA ≈ one full-screen pass + a history target; bloom ≈ a mip chain of small passes; SSAO ≈ ½-res samples.
   */
  private applyPost(q: QualitySettings): void {
    const f = this.env.frame
    const st = this.settings
    const fixed = st.resolution !== 'auto' ? st.resolution : null
    let scale = fixed ?? q.renderScale.start
    if (this.device?.mobile) {
      const px = this.canvas.width * this.canvas.height
      if (px > 0) scale = Math.min(scale, Math.sqrt(1.5e6 / px))
    }
    f.rendering.renderTargetScale = Math.max(0.5, Math.min(1, scale))
    const aa = st.aa === 'auto' ? q.aa : st.aa
    f.rendering.samples = aa === 'msaa4' ? 4 : aa === 'msaa2' ? 2 : 1
    f.taa.enabled = aa === 'fxaa' && q.name !== 'low'
    f.rendering.sharpness = st.sharpness === 'auto' ? Math.min(1, q.sharpen) : st.sharpness
    const bloom = q.paint.bloom * q.fx.bloom
    f.bloom.intensity = bloom > 0 ? 0.012 * bloom / 0.45 : 0
    f.bloom.threshold = 1.2
    f.bloom.blurLevel = 5 // (5 halvings: the lamps' and headlights' glow; the default 16 was ~10 more tiny passes)
    // (LIGHTING: the AO shades only the ambient light. COMBINE — no extra depth prepass, ~6 ms less on a Mali-G720 —
    //  multiplied the whole lit colour: the dense grass and the sunlit ground under the crowns went black, 2026-10-26)
    f.ssao.type = q.ao.samples > 0 ? pc.SSAOTYPE_LIGHTING : pc.SSAOTYPE_NONE
    f.ssao.samples = Math.max(4, q.ao.samples)
    f.ssao.radius = 12 + q.ao.radius * 10
    f.ssao.intensity = 0.45
    f.ssao.scale = 0.5
    f.ssao.randomize = f.taa.enabled
    f.update()
    // COTTON-CANDY EDGES (the soft look, with TAA): the foliage's blurred cut-out is DITHERED (the engine's blue-noise
    // opacity dither) instead of a hard alpha test — TAA resolves it into a fuzzy, soft edge on every frond (Over the
    // Hill's crowns); the alpha test stays below it (the shadow cut-out, the empty card margins). LOW (no TAA): the
    // hard cut-out. (A tier change recompiles the vegetation programs once.)
    const veg = this.world.mats.vegetation
    const dither = activeLook().soft && f.taa.enabled ? pc.DITHER_BLUENOISE : pc.DITHER_NONE
    if (veg.opacityDither !== dither) {
      veg.opacityDither = dither
      veg.alphaTest = dither === pc.DITHER_NONE ? (activeLook().soft ? 0.3 : 0.42) : 0.12
      veg.update()
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
          p.frozen = !this.world.isReadyAt(p.curr.x, p.curr.z) || this.store.get().landing
          this.physics.advance(dt, (fdt) => {
            p.fixedUpdate(fdt)
            this.car.fixedUpdate(fdt)
            this.tow.fixedStep(fdt)
            this.net.vehicle.beforeStep()
            this.bike.fixedUpdate(fdt)
          })
          p.interpolate(this.physics.alpha)
          const f = this.world.fields
          if (p.curr.y < f.surface(p.curr.x, p.curr.z) - 4) p.teleport(p.curr.setY(f.surface(p.curr.x, p.curr.z) + 1))
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
          const fwd = cam.getWorldDirection(new THREE.Vector3()).setY(0).normalize()
          const c = this.cameraCtl
          this.monsters.update(dt, monsterTime, t.nightmare, fwd, this.flashlight.on, c.flashOrigin, c.flashTarget)
          this.lightning.update(dt, monsterTime, t.nightmare, cam)
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
          const cam = this.camera
          const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight)
          if (Math.abs(cam.aspect - aspect) > 1e-3) {
            cam.aspect = aspect
            cam.updateProjectionMatrix()
          }
          this.cameraCtl.garage = this.store.get().landing ? this.car.pos : null
          this.cameraCtl.ignoreBody = this.car.occupied ? this.car.sim.body : null
          this.cameraCtl.car = this.car.driving && !this.car.sim.arcade ? this.car : null
          this.cameraCtl.zoomBy(this.input.consumeZoom())
          this.cameraCtl.update(dt, cam, p, this.flashlight.on)
          this.baseFov ||= cam.fov
          const sim = this.car.sim
          const boosting = this.car.driving && (sim.arcade ? sim.nitroOn : sim.controls.boost && sim.controls.throttle > 0.1) && sim.speed > 3
          const rush = this.car.driving && sim.arcade ? Math.min(14, Math.max(0, sim.speed - 8) * 0.3) : 0
          const fov = cam.fov + ((boosting ? this.baseFov + 9 : this.baseFov) + rush - cam.fov) * Math.min(1, dt * (boosting ? 3 : 2))
          if (this.car.driving && sim.arcade && performance.now() - this.input.lastLook > 1200) {
            const v = this.car.velocity(this.chaseV)
            const sp = Math.hypot(v.x, v.z)
            const travel = sp > 4 ? Math.atan2(-v.x, -v.z) : this.car.heading
            const want = sim.speed < -1 ? this.car.heading : travel + Math.atan2(Math.sin(this.car.heading - travel), Math.cos(this.car.heading - travel)) * 0.35
            const d = Math.atan2(Math.sin(want - p.yaw), Math.cos(want - p.yaw))
            const gate = recentreGate(sim.speed)
            p.yaw += d * Math.min(1, dt * 3.5) * gate
            p.pitch += (-0.12 - p.pitch) * Math.min(1, dt * 2) * gate
          }
          if (Math.abs(fov - cam.fov) > 0.01) {
            cam.fov = fov
            cam.updateProjectionMatrix()
          }
          cam.updateMatrixWorld() // (the grass and the world read its frustum this frame)
        },
      })
      .add({ name: 'bike', update: (dt) => this.bike.update(dt, this.physics.alpha) })
      .add({
        name: 'net',
        update: (dt) => {
          this.net.update(dt)
          const t = this.net.serverNow()
          if (t !== null) this.remotes.update(dt, t, this.camera.position, this.canvas.height)
        },
      })
      .add({
        name: 'car',
        update: (dt) => {
          this.car.showDriver = this.cameraCtl.mode === 'tpp'
          if (!this.car.driving && this.car.wiperOn) this.store.set({ wipers: (this.car.wiperOn = false) })
          this.car.wipers = this.car.wiperOn ? Math.max(0.35, Math.min(1, (this.weather.rain + glassWeather.uSnowG.value) * 1.4)) : 0
          if (this.wreckClock > 0 && (this.wreckClock -= dt) <= 0) this.respawnCar()
          this.car.update(dt, this.physics.alpha, this.cameraCtl.flashOrigin, this.cameraCtl.flashTarget)
          this.tow.update()
          // exhaust + tyre smoke / dust lit by the sky fill and a share of the key light; skid marks / tyre tracks
          const L = this.env.lighting
          this.fxLight.copy(L.hemiSky).multiplyScalar(Math.PI * 0.55)
          this.fxLight.r += L.keyColor.r * 0.63
          this.fxLight.g += L.keyColor.g * 0.63
          this.fxLight.b += L.keyColor.b * 0.63
          this.vehicleFx.update(dt, this.car, this.world.fields, this.camera.position, globalUniforms.uWind.value, this.fxLight, this.canvas.height)
          this.tyreMarks.update(dt, this.car, this.world as unknown as WorldManager, this.camera.position)
        },
      })
      .add({
        name: 'world',
        update: (dt, time) => {
          this.destruction.update(dt)
          const v = this.car.driving ? this.car.velocity(this.ahead) : this.ahead.copy(p.velocity)
          this.ahead.copy(v).multiplyScalar(1.5).add(p.renderPosition)
          const rp = p.renderPosition
          this.world.update(rp.x, rp.z, this.cam.camera!, this.ahead.x, this.ahead.z)
          this.horizon.update(rp.x, rp.z, this.world.builtRadius)
          this.grass.update(rp, this.camera)
          this.mapProps?.update(rp)
          this.pillars?.update(rp, this.quality.viewDistance * 1.05)
          if (this.mistSheets) {
            this.mistCol.copy(this.tod.current.fogColor).lerp(this.tod.current.sunColor, 0.15).multiplyScalar(1.05)
            this.mistSheets.update(time, this.camera.position.y, this.quality.name === 'low' ? 1 : this.quality.name === 'medium' ? 2 : 3, this.mistCol)
          }
          const q = this.quality
          this.landmarks.update(dt, rp.x, rp.z, q.landmarkRange, q.sunShadowExtent * 1.5, q.shadows && q.objectShadows)
        },
      })
      .add({
        name: 'lighting',
        update: (dt, time) => {
          const cam = this.camera
          const c = this.cameraCtl
          const rp = p.renderPosition
          const bw = this.world.fields.biome(rp.x, rp.z, this.bw, rp.y)
          const rw = this.world.fields.region(rp.x, rp.z, this.rw, rp.y)
          this.caves.update(dt, time, rp, this.env.lighting.keyStrength * (1 - this.tod.nightmare) * THREE.MathUtils.smoothstep(this.tod.sunDir.y, 0.0, 0.25))
          this.env.cave = this.caves.inside
          const darkness = (this.darkness = 1 - THREE.MathUtils.smoothstep(this.tod.sunDir.y, 0.05, 0.45) * (1 - this.tod.nightmare))
          // the torch on foot, the headlights in the car: the engine spot light
          const lit = this.car.driving ? this.car.lights : this.flashlight.on
          const sl = this.spot.light!
          sl.intensity = lit ? (this.car.driving ? 6 : 3.5) * (0.35 + 0.65 * darkness) : 0
          sl.range = this.car.driving ? 60 : 38
          // (a soft-edged pool: the cone fades from its axis to the rim — no hard disc)
          sl.innerConeAngle = this.car.driving ? 8 : 4
          sl.outerConeAngle = this.car.driving ? 40 : 32
          const o = c.flashOrigin, tg = c.flashTarget
          this.spot.setPosition(o.x, o.y, o.z)
          this.spot.lookAt(tg.x, tg.y, tg.z)
          // (an engine spot light points down its −Y; lookAt aims −Z at the target: +90° about X turns −Y onto −Z — the
          //  −90 here pointed the torch and the headlights exactly BACKWARD, a pool of light behind the car)
          this.spot.rotateLocal(90, 0, 0)
          // (the torch's visible cone is the torch's: never drawn from the car — the headlamps have their own glow)
          this.beam.update(c.flashOrigin, c.flashTarget, lit && !this.car.driving, darkness, c.mode === 'fpp' && !this.car.driving)
          this.car.updateLamps(darkness)
          // street lamps: on from dusk, each post flickering to life in its own time
          if (darkness > 0.55) this.lampOnAt ??= time
          else this.lampOnAt = null
          this.materials.setLamps(darkness, this.lampOnAt === null ? -1 : time - this.lampOnAt, time)
          this.bank.get(this.materials.lampGlow) // (its uniforms synced this frame)
          if (this.remotes) this.remotes.darkness = darkness
          this.car.wetness = globalUniforms.uWet.value
          this.lightning.storm = this.weather.rain
          // SOUND (as the three build)
          {
            const camR = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion)
            const pan = (x: number, z: number) => { const dx = x - cam.position.x, dz = z - cam.position.z, l = Math.hypot(dx, dz) || 1; return ((dx * camR.x + dz * camR.z) / l) * 0.6 }
            const car = this.car, bike = this.bike, bs = bike.sim
            const sim = car.sim, slip = Math.max(...sim.wheelSlip)
            this.audio.frame({
              dt, darkness, nightmare: this.tod.nightmare, menu: this.store.get().landing, rain: this.weather.rain * (1 - bw[0]) * (1 - bw[1]),
              car: { engineOn: car.driving, distance: car.pos.distanceTo(cam.position), pan: pan(car.pos.x, car.pos.z), speed: sim.speed, wheelSpeed: sim.wheelSpeed, throttle: sim.controls.throttle, boost: (sim.arcade ? sim.nitroOn : sim.controls.boost) || car.flying || (car.afloat && Math.abs(sim.speed) > 3), slip, engine: this.engineVoice(car), sim: this.engineSim(car), tyres: car.sim.tyreNoise() ?? undefined },
              bike: { riding: bike.riding, distance: bike.root.position.distanceTo(cam.position), pan: pan(bike.root.position.x, bike.root.position.z), speed: bs.speed, throttle: Math.max(0, bs.controls.throttle) },
            })
            const onFoot = !car.driving && !bike.riding && !p.dead && p.grounded && !this.store.get().landing
            const steps = this.character.steps
            if (onFoot && steps !== this.lastSteps) this.audio.footstep(0.3 + 0.3 * Math.min(1, p.horizontalSpeed / 6))
            this.lastSteps = steps
          }
          const region = this.world.fields.biome(rp.x, rp.z, this.bwRegion)
          const snowFall = bw[1] * (1 - region[0]) * Math.max(this.weather.rain, 0.35 + 0.5 * this.weather.cloud)
          // precipitation + region ambience in one pool (as the three build): rain, snow, autumn leaves, mystic spores
          {
            const precip = this.weather.rain * (1 - bw[0]) * (1 - bw[1]) + snowFall
            const leafAmt = rw[Biome.Autumn] * BIOMES[Biome.Autumn].leaves * (1 - 0.5 * this.weather.rain)
            const sporeAmt = rw[Biome.Mystic] * BIOMES[Biome.Mystic].spores * (0.6 + 0.4 * darkness)
            const allP = precip + leafAmt + sporeAmt
            const hs = this.env.lighting.hemiSky
            this.rain.update(time, cam.position, Math.min(1, allP), this.rainBudget, globalUniforms.uWind.value, this.fxLight.copy(hs).multiplyScalar(Math.PI * 0.9), this.canvas.height,
              allP > 0 ? snowFall / allP : 0, allP > 0 ? leafAmt / allP : 0, allP > 0 ? sporeAmt / allP : 0)
            glassWeather.uLightG.value.copy(this.fxLight)
            this.ash.update(time, cam.position, THREE.MathUtils.smoothstep(this.tod.nightmare, 0.2, 0.9), this.canvas.height)
          }
          glassWeather.uRainG.value = this.weather.rain * (1 - bw[0]) * (1 - bw[1]) * (1 - this.caves.inside)
          glassWeather.uSnowG.value = Math.min(1, snowFall) * (1 - this.caves.inside)
          glassWeather.uTimeG.value = time
          glassWeather.uSpeedG.value = this.car.driving ? Math.abs(this.car.sim.speed) : 0
          if (this.car.driving && c.mode === 'tpp') globalUniforms.uNearFade.value.set(2.5, 7.0)
          else globalUniforms.uNearFade.value.set(1.4, 3.0)
          const q = this.quality
          const detailEdge = Math.min(q.viewDistance, this.world.radius * 64 + 24)
          globalUniforms.uCullFade.value.set(detailEdge * 0.74, detailEdge)
        },
      })
  }

  /** One engine frame: the game's systems, the camera into the engine, the environment, the mirrored objects. */
  private readonly frame = (dt: number): void => {
    const d = Math.min(0.1, dt)
    this.time += d
    if (this.pendingSpawn && !this.spawnNow()) {
      this.syncCamera()
      this.env.update(d, this.player.renderPosition, this.cam, this.time)
      return
    }
    if (this.unwarm) {
      // (the warm-up frame was drawn: everything back as it was, then the loading screen lifts)
      this.unwarm()
      this.unwarm = null
      this.store.set({ worldReady: true })
    } else if (!this.warmed && this.playReadiness() >= 1) {
      this.warmed = true
      this.unwarm = this.warmUp()
    }
    this.loop.tick(d)
    this.syncCamera()
    const rp = this.player.renderPosition
    this.env.update(d, rp, this.cam, this.time)
    // (the sun's shadow image: re-rendered only when it no longer fits — PcLighting.updateShadowCache)
    this.env.lighting.updateShadowCache(this.cam.getPosition(), this.cam.forward, this.world.meshStamp)
    // (the surfaces' fine relief × the key light's height: a low sun / moon rakes it into hard grain — 2026-10-25,
    //  "the night and evening light too sharp, leaves and ground feel sharpened")
    this.app.graphicsDevice.scope.resolve('uDetailLight').setValue(0.35 + 0.65 * THREE.MathUtils.smoothstep(this.env.lighting.keyDir.y, 0.08, 0.5))
    const cp = this.cam.getPosition()
    this.water.update(this.time, cp, this.app.scene.fog.start, this.app.scene.fog.end, this.weather.rain, this.env.snowHere)
    this.mirror.sync()
    // the FRONT END (menu, garage) is key art over the canvas: no world frame behind it (the GPU idles)
    const landing = this.store.get().landing
    if (this.cam.camera!.enabled === landing) this.cam.camera!.enabled = !landing
    if (this.studio.wanted) this.studio.prepare(this.mirror.instancesOf(this.car.root), this.car.root)
    if (this.studio.active) {
      // the studio light for this frame (the world look reads the key light / sky fill from these)
      const sc = this.app.graphicsDevice.scope, k = this.studio.keyDir
      sc.resolve('uKeyDirW').setValue([k.x, k.y, k.z])
      sc.resolve('uKeyColor').setValue([1.6, 1.5, 1.38])
      sc.resolve('uHemiSky').setValue([0.4, 0.38, 0.36])
      sc.resolve('uHemiGround').setValue([0.12, 0.1, 0.13])
      sc.resolve('uToon').setValue(1)
      sc.resolve('uWet').setValue(0)
      sc.resolve('uFogMax').setValue(0)
      this.app.scene.fog.start = 1e5
      this.app.scene.fog.end = 2e5
      this.app.scene.exposure = 1
    }
  }
  private warmed = false
  private unwarm: (() => void) | null = null

  /**
   * SHADER WARM-UP (once, when the world is ready — still behind the loading screen; the three build's warmShaders,
   * the PlayCanvas way): ANGLE builds a program's Direct3D shader at its FIRST DRAW, so every on-demand thing — the
   * crash debris, tyre marks, dust, rain, ash, lightning, the monsters, the torch beam, remote players — froze the
   * frame 0.2–0.6 s the first time it showed mid-drive. For ONE frame every hidden object is shown: an empty
   * InstancedMesh draws one speck in front of the camera, an empty particle range a few points, and the sun's shadow
   * image is re-rendered (the casters' shadow variants). Returns the undo, run on the next frame.
   */
  private warmUp(): () => void {
    const undo: (() => void)[] = []
    const cp = this.cam.getPosition(), f = this.cam.forward
    const speck = new THREE.Matrix4().compose(new THREE.Vector3(cp.x + f.x * 4, cp.y + f.y * 4, cp.z + f.z * 4), new THREE.Quaternion(), new THREE.Vector3(0.01, 0.01, 0.01))
    const slot0 = new THREE.Matrix4()
    for (const root of [this.envRoot, this.parts]) root.traverse((o) => {
      if (!o.visible) {
        o.visible = true
        undo.push(() => (o.visible = false))
      }
      const im = o as THREE.InstancedMesh
      if (im.isInstancedMesh && im.count === 0 && im.instanceMatrix.count > 0) {
        im.getMatrixAt(0, slot0)
        const keep = slot0.clone()
        im.setMatrixAt(0, speck)
        im.count = 1
        im.instanceMatrix.needsUpdate = true
        undo.push(() => {
          im.count = 0
          im.setMatrixAt(0, keep)
          im.instanceMatrix.needsUpdate = true
        })
      }
      const pts = o as THREE.Points
      if (((pts as unknown as THREE.Mesh).isMesh || pts.isPoints) && !im.isInstancedMesh && pts.geometry.drawRange.count === 0) {
        pts.geometry.setDrawRange(0, 3)
        undo.push(() => pts.geometry.setDrawRange(0, 0))
      }
    })
    this.env.lighting.invalidateShadows()
    return () => {
      for (let i = undo.length - 1; i >= 0; i--) undo[i]()
    }
  }

  private syncCamera(): void {
    const c = this.camera
    c.updateMatrixWorld()
    this.cam.setPosition(c.position.x, c.position.y, c.position.z)
    this.cam.setRotation(c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w)
    const cc = this.cam.camera!
    if (Math.abs(cc.fov - c.fov) > 1e-3) cc.fov = c.fov
    if (Math.abs(cc.nearClip - c.near) > 1e-4) cc.nearClip = c.near
  }

  /** Progress of the world round the player (0..1). */
  worldReadiness(): number {
    const p = this.player.curr
    return this.world.builtNear(p.x, p.z, this.world.radius) * 0.9 + (this.world.isReadyAt(p.x, p.z) ? 0.1 : 0)
  }

  playReadiness(): number {
    const p = this.player.curr
    return this.world.builtNear(p.x, p.z, 2) * 0.9 + (this.world.isReadyAt(p.x, p.z) ? 0.1 : 0)
  }

  private pendingSpawn: { x: number; z: number; place: () => void } | null = null
  private spawnNow(): boolean {
    const s = this.pendingSpawn!, p = this.player.renderPosition
    if (this.world.isReadyAt(p.x, p.z) && this.world.isReadyAt(s.x, s.z)) {
      this.pendingSpawn = null
      s.place()
      return true
    }
    this.camera.position.set(p.x, p.y + 1.7, p.z)
    this.world.update(p.x, p.z, this.cam.camera!)
    this.horizon.update(p.x, p.z, this.world.builtRadius)
    return false
  }

  // ---------------------------------------------------------------- garage

  tuning(id: string): VehicleTuning {
    return tuningFor(id, this.settings.garage.tuning[id])
  }

  setTuning(id: string, patch: Partial<VehicleTuning>): void {
    const tuning = { ...this.settings.garage.tuning, [id]: { ...(this.settings.garage.tuning[id] ?? {}), ...patch } }
    this.settings = { ...this.settings, garage: { ...this.settings.garage, tuning } }
    saveSettings(this.settings)
    this.store.set({ settings: this.settings })
    if (this.car.modelId === id) this.car.retune(this.tuning(id))
  }

  resetTuning(id: string): void {
    const tuning = { ...this.settings.garage.tuning }
    delete tuning[id]
    this.settings = { ...this.settings, garage: { ...this.settings.garage, tuning } }
    saveSettings(this.settings)
    this.store.set({ settings: this.settings })
    if (this.car.modelId === id) this.car.retune(this.tuning(id))
  }

  private selecting: Promise<void> | null = null
  selectVehicle(id: string): Promise<void> {
    if (id === this.car.modelId || this.selecting) return this.selecting ?? Promise.resolve()
    this.store.set({ vehicleLoading: 0 })
    this.selecting = loadVehicle(id, (f) => this.store.set({ vehicleLoading: f }))
      .then((model) => {
        this.swapCar(model, this.car.pos.x, this.car.pos.z, this.car.heading, this.car.pos.y)
        this.settings = { ...this.settings, garage: { ...this.settings.garage, vehicle: id } }
        saveSettings(this.settings)
        this.store.set({ settings: this.settings, vehicle: id, vehicleLoading: null, driving: false, flying: false, boat: false })
      })
      .catch((e: unknown) => {
        console.error(e)
        this.store.set({ vehicleLoading: null })
      })
      .finally(() => (this.selecting = null))
    return this.selecting
  }

  private swapCar(model: TruckModel, x: number, z: number, heading: number, nearY?: number): void {
    const next = new Car(this.materials.character, model, this.physics, this.world.fields, this.player, this.character, this.input, this.tuning(model.id))
    this.parts.remove(this.car.root)
    this.car.dispose()
    this.car = next
    this.car.park(x, z, heading, nearY)
    this.car.sim.arcade = this.settings.handling === 'arcade'
    this.car.driveSettings(this.settings.gearbox, this.settings.aids, this.input.touch, this.settings.offroadAssist)
    this.car.autoAccel = this.settings.autoAccelerate
    this.wireCar()
    this.parts.add(this.car.root)
    this.car.castShadow = this.quality.objectShadows
    this.car.tyreShear = this.quality.name === 'high' || this.quality.name === 'ultra'
    this.car.gloss = this.quality.name !== 'low'
    this.car.setMap(this.quality.name === 'low' && model.map ? downscaleTexture(model.map, 512) : model.map)
    this.store.set({ carDamage: 0 })
  }

  private respawnCar(): void {
    const id = this.car.modelId
    void loadVehicle(id, () => {}).then((model) => {
      const f = this.world.fields, p = this.player.curr
      const on = this.map ? this.roadPoint(p.x, p.z, 12) : null
      const z = on ? on.z : p.z + 12, x = on ? on.x : f.roadCenterX(z) + 1.4
      this.swapCar(model, x, z, on ? on.yaw : Math.atan2(-(f.roadCenterX(z + 1) - f.roadCenterX(z)), -1))
      this.notify(`A new ${vehicleDef(id).name} is waiting on the road`, 4000)
    })
  }

  respawnHere(): void {
    if (this.car.respawnHere()) {
      this.net.respawned()
      this.notify('Car respawned', 1500)
    }
  }

  play(): void {
    this.store.set({ landing: false, screen: 'menu' })
    void this.net.ensureRoom()
  }

  setRoomSetup(patch: Partial<RoomSetup>): void {
    const roomSetup = { ...this.store.get().roomSetup, ...patch }
    this.store.set({ roomSetup })
    try {
      localStorage.setItem('dark.room.setup', JSON.stringify(roomSetup))
    } catch {
      /* private mode */
    }
  }

  setPlayerName(name: string): void {
    const n = name.replace(/\s+/g, ' ').trim().slice(0, 20)
    if (!n) return
    this.store.set({ playerName: n })
    try {
      localStorage.setItem('dark.player.name', n)
    } catch {
      /* private mode */
    }
  }

  private readonly pose: LocalPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, flags: 0, model: 0 }
  localPose(): LocalPose {
    const o = this.pose
    const car = this.car
    let flags = this.flashlight.on ? Flags.LIGHTS : 0
    if (car.driving) {
      const v = car.sim.body.linvel(), q = car.sim.body.rotation()
      o.x = car.pos.x; o.y = car.pos.y; o.z = car.pos.z
      o.vx = v.x; o.vy = v.y; o.vz = v.z
      o.yaw = car.heading
      const fy = 2 * (q.y * q.z - q.w * q.x) * -1
      o.pitch = Math.asin(Math.max(-1, Math.min(1, fy)))
      flags |= Flags.DRIVING | (car.flyMode ? Flags.FLYING : 0) | (car.boatMode ? Flags.BOAT : 0) | (car.lights ? Flags.LIGHTS : 0)
      if (car.sim.controls.brake) flags |= Flags.BRAKING
      o.model = wireModel(car.modelId, false)
    } else {
      const p = this.player
      o.x = p.curr.x; o.y = p.curr.y; o.z = p.curr.z
      o.vx = p.velocity.x; o.vy = p.velocity.y; o.vz = p.velocity.z
      o.yaw = this.character.yaw
      o.pitch = 0
      if (!p.grounded) flags |= Flags.AIRBORNE
      const bike = this.bike.riding
      if (bike) flags |= Flags.DRIVING
      o.model = wireModel(null, bike)
    }
    o.flags = flags
    return o
  }

  netRelocate(x: number, y: number, z: number, yaw: number): void {
    if (this.car.driving) this.car.forceOut()
    const at = new THREE.Vector3(x, this.world.fields.heightNoNet(x, z) + 0.05, z)
    this.player.teleport(at)
    this.pendingSpawn = {
      x, z, place: () => {
        const f = this.world.fields
        this.player.teleport(at.setY(Math.max(f.surface(x, z), y - 1) + 0.05))
        this.player.yaw = yaw
        this.character.yaw = yaw
        this.car.park(x - Math.cos(yaw) * 4, z + Math.sin(yaw) * 4, yaw)
      },
    }
  }

  netCorrect(x: number, y: number, z: number, yaw: number): void {
    if (this.car.driving) this.car.park(x, z, yaw, y + 2)
    else this.player.teleport(new THREE.Vector3(x, y, z))
  }

  showScreen(screen: 'menu' | 'garage' | 'maps'): void {
    if (document.pointerLockElement) document.exitPointerLock()
    this.store.set({ landing: true, screen, settingsOpen: false })
  }

  /** The garage's studio photo of the car (PcStudio: one offscreen render, read back as a PNG). */
  carPhoto(width: number, height: number): Promise<string | null> {
    if (this.pendingSpawn) return Promise.resolve(null)
    return this.studio.request(width, height)
  }

  private spawnAtCave(): void {
    const f = this.world.fields
    const cave = f.formations.cavesNear(0, 0, 3000).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0]
    if (!cave) return
    const c = Math.cos(cave.rot), s = Math.sin(cave.rot)
    const x = cave.x + (MOUTH_X - 16) * c, z = cave.z + (MOUTH_X - 16) * s
    this.player.teleport(new THREE.Vector3(x, f.surface(x, z) + 0.05, z))
    this.player.yaw = this.character.yaw = Math.atan2(-c, -s)
    this.player.pitch = 0
  }

  private roadPoint(x: number, z: number, ahead = 0): { x: number; z: number; yaw: number } {
    let best = Infinity, br = this.map!.roads[0], bi = 0
    for (const r of this.map!.roads) {
      for (let i = 0; i < r.n; i++) {
        const d = (r.xs[i] - x) ** 2 + (r.zs[i] - z) ** 2
        if (d < best) (best = d), (br = r), (bi = i)
      }
    }
    while (ahead > 0 && bi < br.n - 2 && br.cum[bi + 1] - br.cum[bi] > 0) (ahead -= br.cum[bi + 1] - br.cum[bi]), bi++
    const j = Math.min(br.n - 1, bi + 1), i = j - 1
    const dx = br.xs[j] - br.xs[i], dz = br.zs[j] - br.zs[i], l = Math.hypot(dx, dz) || 1
    return { x: br.xs[bi] - (dz / l) * 1.4, z: br.zs[bi] + (dx / l) * 1.4, yaw: Math.atan2(-dx, -dz) }
  }

  respawn(): void {
    const p = this.player.curr
    const on = this.map ? this.roadPoint(p.x, p.z) : null
    const z = on ? on.z : p.z
    const x = on ? on.x : this.world.fields.roadCenterX(z)
    this.player.teleport(new THREE.Vector3(x, this.world.fields.surface(x, z) + 0.05, z))
    this.player.dead = false
    this.player.stunned = 0
    this.health.revive()
    this.monsters.scatter()
    this.store.set({ dead: false })
  }

  dispose(): void {
    this.app.off('update', this.frame)
    window.removeEventListener('resize', this.onResize)
    window.visualViewport?.removeEventListener('resize', this.onResize)
    window.removeEventListener('orientationchange', this.onTurn)
    window.removeEventListener('touchstart', this.onFirstTouch)
    this.input.detach()
    this.mapProps?.dispose()
    this.pillars?.dispose()
    this.mistSheets?.dispose()
    this.tow.dispose()
    this.bike.dispose()
    this.car.dispose()
    this.destruction.dispose()
    this.rain.dispose()
    this.vehicleFx.dispose()
    this.tyreMarks.dispose()
    this.ash.dispose()
    this.grass.dispose()
    this.monsters.dispose()
    this.lightning.dispose()
    this.landmarks.dispose()
    this.character.dispose()
    this.mirror.dispose()
    this.physics.dispose()
    this.app.destroy()
  }
}
