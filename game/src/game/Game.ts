import { loadFixedMap, setActiveMap, type FixedMap } from '../world/map/FixedMap'
import { MapProps } from '../world/map/MapProps'
import { PillarField } from '../world/map/PillarField'
import { MistSheets } from '../world/map/MistSheets'
import * as THREE from 'three'
import { CaveSystem } from '../gameplay/caves/CaveSystem'
import { MOUTH_X } from '../world/Formations/caves'
import { ART, groundPalette, isGenshin, isOverland } from '../rendering/artStyle'
import { downscaleTexture, loadHeroTowClips, loadModels, loadVehicle, type GameModels, type TruckModel } from '../assets/loadModels'
import { tuningFor, vehicleDef, type VehicleTuning } from '../gameplay/vehicle/catalogue'
import { CHUNK_SIZE } from '../world/constants'
import { ChunkDebug } from '../debug/ChunkDebug'
import { CullingDebug } from '../debug/CullingDebug'
import { PerformanceMonitor } from '../debug/PerformanceMonitor'
import { PhysicsDebug } from '../debug/PhysicsDebug'
import { AudioSystem } from '../audio/AudioSystem'
import { Bike } from '../gameplay/bmx/Bike'
import { Car, glassWeather } from '../gameplay/vehicle/Car'
import { arcadeTopSpeed } from '../gameplay/vehicle/VehicleSim'
import { LightBeam } from '../gameplay/flashlight/LightBeam'
import { MonsterSystem } from '../gameplay/monsters/MonsterSystem'
import { Health } from '../gameplay/survival/Health'
import { Lightning } from '../gameplay/weather/Lightning'
import { AshParticles } from '../rendering/particles/AshParticles'
import { VehicleFx } from '../rendering/particles/VehicleFx'
import { TyreMarks } from '../rendering/particles/TyreMarks'
import { RainParticles } from '../rendering/particles/RainParticles'
import { Weather } from '../rendering/weather/Weather'
import { Discovery } from '../gameplay/explore/Discovery'
import { TreeShadows } from '../rendering/shadows/TreeShadows'
import { DynamicShadow, dynamicCaster } from '../rendering/shadows/DynamicShadow'
import { CameraController, recentreGate, type CameraMode } from '../gameplay/player/CameraController'
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
import { applyBiomeAir, applyMapAir, type MapAir } from '../rendering/weather/BiomeAir'
import { GameLoop } from './GameLoop'
import { bakeImpostors, useImpostorAtlas, type ImpostorAtlas } from '../rendering/impostors/Impostors'
import { TREE_FADE } from '../world/WorldManager'
import { createStore, type GameStateShape, type Store } from './GameState'
import { NetClient, loadPlayerName, loadSetup, wireModel, type LocalPose, type RoomSetup } from '../net/NetClient'
import { RemotePlayers } from '../net/RemotePlayers'
import { TowSystem } from '../gameplay/tow/TowSystem'
import { Buttons, Flags, NO_PLAYER } from '../net/protocol'
import { loadSettings, saveSettings, type Settings } from './Settings'
import { Biome, BIOME_COUNT, type BiomeWeights, type RegionWeights } from '../world/Biomes'
import { BIOMES } from '../world/biomes/BiomeDefs'

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
  /** Vehicle override (?car=<catalogue id>, not persisted). */
  car?: string
  /** Skip the landing page (tests / screenshots). */
  play?: boolean
  /** Start somewhere else than the road spawn: 'cave' = outside the nearest hillside cave mouth (?at=). */
  at?: string
  /** A fixed map (world/map/FixedMap.ts MAPS id, ?map=) instead of the endless world. */
  map?: string
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
  /** Image tree shadows (the LOW shadow level: no shadow map — rendering/shadows/TreeShadows). */
  readonly treeShadows = new TreeShadows()
  /** The moving things' shadows while the sun map is cached (rendering/shadows/DynamicShadow). */
  readonly dynShadow = new DynamicShadow()
  private lastChunkN = -1
  private lastLodSwitches = -1
  readonly beam = new LightBeam()
  readonly bike: Bike
  car: Car
  /** Multiplayer rooms (net/NetClient) and everyone else in the room (net/RemotePlayers). */
  readonly net: NetClient
  readonly remotes: RemotePlayers
  /** Tow ropes: the winch hooks on every car (gameplay/tow/TowSystem). */
  readonly tow: TowSystem
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
  /** Hillside caves: crystals, pools, sunbeams, chests and the in-the-dark factor (gameplay/caves). */
  readonly caves: CaveSystem
  private readonly caveFog = new THREE.Color(0.02, 0.045, 0.085) // the Chasm's blue haze (sRGB ≈ 32, 57, 84 in the refs)
  private aerialBase = globalUniforms.uAerial.value.z
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
  /** Scene subtrees without dynamic shadow casters (DynamicShadow skips them). */
  private get dynSkip(): readonly THREE.Object3D[] {
    return (this._dynSkip ??= [this.world.root])
  }
  private _dynSkip: THREE.Object3D[] | null = null
  private readonly opts: GameOptions
  /** Quality as saved by the player (a ?tier= URL override is never persisted). */
  private savedQuality: Settings['quality']

  private readonly bw: BiomeWeights = [0, 0]
  private readonly bwRegion: BiomeWeights = [0, 0]
  /** All region weights under the player (air, ambient particles). */
  private readonly rw: RegionWeights = new Float32Array(BIOME_COUNT)
  /** A fixed map's own sky (map.json palette skyZenith / skyHaze), applied after the biome air. */
  private mapAir: MapAir | null = null
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
  /** Skid marks on the road, tyre tracks in the ground (one draw, tier budget `tyreMarks`). */
  readonly tyreMarks = new TyreMarks()
  /** Dynamic weather (clouds / rain / wind) and its rain streaks. */
  readonly weather: Weather
  /** Summit lookouts found in this world (the HUD's exploration loop: gameplay/explore/Discovery). */
  readonly discovery: Discovery
  readonly rain = new RainParticles()
  private rainBudget = 1
  private renderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  camera: THREE.PerspectiveCamera | null = null
  private truckMapLow: THREE.Texture | undefined

  /** @param onProgress loading-screen progress (0..1) + stage text. */
  static async create(opts: GameOptions, onProgress?: (f: number, status: string) => void): Promise<Game> {
    // Art style: always BRIGHT (artStyle.ts) — set before any material/atlas/tree is built.
    ART.style = 'bright'
    applyShadowEdgeFade() // global shader-chunk patch; must precede any program compile
    // Models load in parallel with the physics wasm (both small: ~1.8 MB total).
    let phys = 0, mdl = 0
    const report = () => onProgress?.(0.12 + 0.3 * (phys * 0.5 + mdl * 0.5), mdl < 1 ? 'Loading the truck and the stranger…' : 'Waking up physics…')
    report()
    const saved = loadSettings()
    const vehicle = opts.car && vehicleDef(opts.car).id === opts.car ? opts.car : saved.garage.vehicle
    const [R, models, map] = await Promise.all([
      PhysicsWorld.load().then((r) => ((phys = 1), report(), r)),
      loadModels((f) => ((mdl = f), report()), vehicle),
      opts.map ? loadFixedMap(opts.map) : Promise.resolve(null),
    ])
    setActiveMap(map ? map.id : null) // before any world system: every worker request carries it
    onProgress?.(0.45, map ? `Loading ${map.name}…` : 'Growing a new world…')
    return new Game(opts, new PhysicsWorld(R), models, map)
  }

  /** A fixed map's set pieces (camps, stunt park, cabins…; null in the endless world). */
  private mapProps: MapProps | null = null
  /** A pillar map's sandstone columns (world/map/PillarField.ts). */
  readonly pillars: PillarField | null = null
  /** A map's cloud sheets in its gorges (world/map/MistSheets.ts, map.json `mistSheets`). */
  private mistSheets: MistSheets | null = null
  private readonly mistCol = new THREE.Color()

  private constructor(opts: GameOptions, physics: PhysicsWorld, private readonly models: GameModels, readonly map: FixedMap | null = null) {
    this.physics = physics
    this.opts = opts
    this.settings = loadSettings()
    this.savedQuality = this.settings.quality
    if (opts.tier && opts.tier !== 'auto') this.settings = { ...this.settings, quality: opts.tier }
    // EVERY device plays ULTRA with Hold 60 (2026-10-20: "always ultra at 60+"); saves from before that default still
    // hold 'auto' and are played the same way (this session; the saved setting is untouched). The preset stays ULTRA
    // and only a device that can't hold 60 fps lowers resolution, then the costliest features, one at a time.
    else if (this.settings.quality === 'auto') this.settings = { ...this.settings, quality: 'ultra', hold60: true }
    this.adaptive.enabled = opts.adaptive !== false && (this.settings.quality === 'auto' || this.settings.hold60)
    this.tod = new TimeOfDay(opts.hour ?? 15) // start in the warm afternoon (the garage view); night still comes with the cycle
    this.tod.dayLengthMinutes = this.settings.dayLength
    this.tod.setStyle(ART.style)
    this.lighting = new LightingSystem(this.tod)
    this.weather = new Weather(opts.seed, globalUniforms.uWind.value)
    this.discovery = new Discovery(opts.seed)
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
      dpr: 1,
      adaptive: this.adaptive.enabled,
      touch: isTouchDevice(),
      settings: this.settings,
      settingsOpen: false,
      dead: false,
      driving: false,
      flying: false,
      boat: false,
      lights: false,
      wipers: false,
      landing: opts.play !== true,
      screen: 'menu',
      worldReady: false,
      vehicle: models.truck.id,
      vehicleLoading: null,
      net: { status: 'off', message: null, room: null, me: NO_PLAYER, owner: NO_PLAYER, players: [] },
      roomSetup: loadSetup(),
      playerName: loadPlayerName(),
      held: null,
      fpsCap: false,
    })
    // (a fixed map grows the same nature for everyone — FixedMap.seed; the endless world is the session's)
    this.world = new WorldManager(map?.seed ?? opts.seed, this.materials, physics, map)
    if (map) {
      this.mapProps = new MapProps(map, physics, this.materials)
      this.world.root.add(this.mapProps.root)
      if (map.pillars.length) {
        ;(this as { pillars: PillarField | null }).pillars = new PillarField(map, physics)
        this.world.root.add(this.pillars!.root)
      }
      if (map.mistSheets?.length) {
        this.mistSheets = new MistSheets(map, map.mistSheets.map(([y, density]) => ({ y, density })), new THREE.Color(0xe8eef4))
        this.world.root.add(this.mistSheets.root)
      }
    }
    this.biomeMap = new BiomeMap(this.world.fields.biomes)

    // Spawn on the road near the origin (a fixed map: at its start point).
    const z = map ? map.spawn.z : 8
    const x = map ? map.spawn.x : this.world.fields.roadCenterX(z)
    // (provisional height: the ground WITHOUT the secondary roads — `surface` here ran the whole road network's A*
    // round the spawn on the main thread (driveways, summit trails: 3–12 s before the menu could open). The exact
    // placement waits for the first chunk, whose worker built those roads and hands them over — `pendingSpawn`.)
    const spawn = new THREE.Vector3(x, this.world.fields.heightNoNet(x, z) + 0.05, z)
    this.player = new PlayerController(physics, this.input, spawn)
    // Face down the road (+Z): forward = (-sin yaw, -cos yaw) = normalize(dx/dz, 1).
    this.player.yaw = map ? map.spawn.yaw : Math.atan2(-(this.world.fields.roadCenterX(z + 1) - x), -1)
    this.player.pitch = -0.08

    this.materials.hero.map = models.hero.map
    this.materials.hero.needsUpdate = true
    this.character = new CharacterModel(this.materials.hero, models.hero)
    // Feet on the slope, the fallen body on the ground: the loaded chunk heights (cheap, = the rendered mesh).
    // The ground under the feet as the colliders see it: the terrain, or a cave's rock floor (the height field is
    // carved 2+ m below it there — feet IK on that pulled the body into the cave floor). Cast from just above the
    // player (below any tunnel roof); the height field where nothing is streamed in.
    this.character.ground = (x, z) => this.physics.groundBelow(x, z, this.player.curr.y + 0.6, this.world.groundAt(x, z) ?? this.world.fields.height(x, z))
    this.character.onStep = (x, z, fx, fz) => this.trails.stamp(x, z, fx, fz, 0.22, 0.12, 0.9)
    this.character.yaw = this.player.yaw
    this.cameraCtl = new CameraController(physics, this.world.fields, this.character, this.blobShadow)
    this.cameraCtl.mode = this.settings.camera
    this.horizon = new HorizonTerrain(opts.seed)
    this.world.farForest.ground = this.horizon // far trees stand on the drawn horizon hills
    this.landmarks = new LandmarkSystem(this.world.fields.landmarks, this.materials.landmark, physics, this.world.seed, groundPalette())
    this.caves = new CaveSystem(this.world.fields)
    this.bike = new Bike(this.materials.character, this.player, this.character, this.world.fields, physics, this.input)
    this.car = new Car(this.materials.character, models.truck, physics, this.world.fields, this.player, this.character, this.input, this.tuning(models.truck.id))
    this.car.sim.arcade = this.settings.handling === 'arcade' // realistic simulation by default (VehicleSim); arcade = Asphalt-style option
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
      if (this.car.driving && this.car.sim.arcade) this.car.sim.nitro = Math.min(1, this.car.sim.nitro + 0.1) // takedowns fill the nitro
      this.world.chunks.get(ref.key)?.breakProp(ref.index)
      this.audio.crash(ref.type, speed, this.car.pos.distanceTo(this.camera?.position ?? this.car.pos))
      if (this.car.driving) this.cameraCtl.shake = Math.min(1, this.cameraCtl.shake + 0.15 + speed / 60)
    }
    {
      // Parked on the verge ~14 m down the road from the spawn (on a map: 14 m ahead along its start road).
      const f = this.world.fields
      const ahead = map ? this.roadPoint(x - Math.sin(map.spawn.yaw) * 14, z - Math.cos(map.spawn.yaw) * 14) : null
      const cz = ahead ? ahead.z : z + 14
      const cx = ahead ? ahead.x : f.roadCenterX(cz) + 1.4 // right lane (poles stand at +5.6 m)
      const yawP = this.player.yaw
      this.pendingSpawn = { x: cx, z: cz, place: () => {
        this.player.teleport(spawn.setY(f.surface(x, z) + 0.05))
        this.bike.parkNear(spawn, yawP, 2.4)
        this.car.park(cx, cz, ahead ? ahead.yaw : Math.atan2(-(f.roadCenterX(cz + 1) - f.roadCenterX(cz)), -1)) // along the road there
        if (opts.at === 'cave') this.spawnAtCave()
      } }
      // Start looking at the car (it's what you drive first; the compass shows it either way), then — once the
      // landmark worker has placed it (~0.5–3 s, LandmarkSystem) — at the HOME LANDMARK (a giant oak in sight on the
      // high ground — a place to go, Genshin's opening vista), unless the player has already taken control.
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
    this.monsters = new MonsterSystem(this.world.fields, this.player, this.health, this.audio)
    this.monsters.solid = (x, z, nearY) => this.physics.groundBelow(x, z, nearY + 0.6, this.world.fields.surface(x, z))
    this.lightning = new Lightning(this.world.fields, this.player, this.health, this.audio)
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

    this.physicsDebug = new PhysicsDebug(physics)
    this.envRoot.name = 'environment'
    this.envRoot.add(this.caves.group, this.destruction.mesh, this.drift.points, this.sky.mesh, this.bike.root, this.car.root, this.vehicleFx.points, this.rain.points, this.horizon.mesh, this.landmarks.group, this.water.mesh, this.beam.mesh, this.monsters.rig.root, this.lightning.mesh, this.ash.points, this.character.root, this.blobShadow, this.chunkDebug.object, this.cullingDebug.helper, this.physicsDebug.object)
    this.remotes = new RemotePlayers(this.materials.hero, models.hero, (id) => loadVehicle(id), this.materials.characterInstanced, (x, z) => this.world.groundAt(x, z) ?? this.world.fields.height(x, z), (x, z) => this.world.groundAt(x, z))
    this.remotes.setQuality(this.quality.remoteCharacters, this.quality.remoteCars)
    // a fixed map's snow is its biome map's alone (no altitude snow line: Zhangjiajie's 250 m tables and spire crowns
    // went white under it)
    if (map) globalUniforms.uSnowLine.value.set(1e5, 1e5 + 40)
    // a fixed map's own colours: its water and its dirt roads (the ground takes the rest: groundColor)
    const pal = map?.palette
    if (pal?.waterDeep) {
      const w = pal.water ?? pal.waterDeep, d = pal.waterDeep
      this.water.setDeep([w[0] * 0.55 + d[0] * 0.45, w[1] * 0.55 + d[1] * 0.45, w[2] * 0.55 + d[2] * 0.45], 0.42)
    }
    if (pal?.dirt) globalUniforms.uRoadSoil.value.set(pal.dirt[0] * 0.62, pal.dirt[1] * 0.6, pal.dirt[2] * 0.6, 1)
    if (pal?.cliff) globalUniforms.uCliffStone.value.set(pal.cliff[0], pal.cliff[1], pal.cliff[2], map?.naturalStone ? 2 : 1) // (2: natural streaked stone)
    if (pal?.cliffMoss && map?.cliffMoss) globalUniforms.uCliffMoss.value.set(pal.cliffMoss[0], pal.cliffMoss[1], pal.cliffMoss[2], map.cliffMoss)
    // ... and its air (sky, horizon haze): BiomeAir.applyMapAir, every frame after the biome air
    if (pal?.skyZenith || pal?.skyHaze || map?.mist || map?.light) {
      const col = (v?: [number, number, number]) => (v ? new THREE.Color().setRGB(v[0], v[1], v[2]) : undefined)
      const hexc = (h?: string) => (h ? new THREE.Color(parseInt(h, 16)) : undefined)
      const L = map?.light
      this.mapAir = {
        zenith: col(pal?.skyZenith), haze: col(pal?.skyHaze), mist: map?.mist,
        light: L ? { sun: hexc(L.sun), fill: hexc(L.fill), bounce: hexc(L.bounce), tint: hexc(L.tint), toon: L.toon, split: L.split, saturation: L.saturation } : undefined,
      }
    }
    // ... and its aerial perspective (map.json `aerial`: start, end m, strength — Zhangjiajie's towers are the view:
    // the default 30 → 600 m at 0.75 turned every hill past a few hundred metres grey-blue)
    if (map?.aerial) {
      globalUniforms.uAerial.value.x = map.aerial[0]
      globalUniforms.uAerial.value.y = map.aerial[1]
      this.aerialBase = map.aerial[2]
    }
    this.envRoot.add(this.remotes.root)
    this.tow = new TowSystem(this)
    // (the tow gestures: loaded after the start — nothing needs them before someone takes a hook)
    void loadHeroTowClips().then((c) => (this.character.addClips(c), this.remotes.addClips(c))).catch(() => {})
    this.envRoot.add(this.tow.root)
    this.net = new NetClient(this)
    // (after Destruction's: every fixed step's predicted car state for the server-simulated car)
    {
      const prev = physics.afterStep
      physics.afterStep = () => {
        prev?.()
        this.net.vehicle.afterStep()
      }
    }
    // Not in the water's mirror: the water itself, near-field grass, particles, the torch beam, debug helpers.
    this.envRoot.add(this.tyreMarks.mesh)
    this.reflection.hide.push(this.tyreMarks.mesh, this.water.mesh, this.world.grass.root, this.drift.points, this.vehicleFx.points, this.rain.points, this.ash.points, this.beam.mesh, this.blobShadow, this.chunkDebug.object, this.cullingDebug.helper, this.physicsDebug.object)

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
    // R: driving — RESPAWN the car where it is (stuck, wedged, rolled; also the toolbar / touch ⟲ button). On foot:
    // cycle the weather (auto → clear → cloudy → rain → auto) — testing / screenshots.
    i.onPress('KeyR', () => {
      if (this.car.driving) return this.respawnHere()
      const order = [null, 'clear', 'cloudy', 'rain'] as const
      this.weather.force = order[(order.indexOf(this.weather.force) + 1) % order.length]
    })
    i.onPress('KeyV', () => this.toggleCamera())
    // O: while driving the BOAT (the hull unfolds — Car.toggleBoat); otherwise the settings (also the toolbar ⚙).
    i.onPress('KeyO', () => {
      if (this.car.driving && !s.get().settingsOpen) this.car.toggleBoat()
      else this.openSettings(!s.get().settingsOpen)
    })
    i.onPress('KeyF', () => {
      // On foot / bike: the torch. In the truck: the headlights (the torch stays as it was).
      if (this.car.driving) s.set({ lights: (this.car.lights = !this.car.lights) })
      else s.set({ flashlight: this.lighting.toggleFlashlight() })
    })
    // J: the windscreen WIPERS on / off — only from the driver's seat (they park when you get out)
    i.onPress('KeyJ', () => {
      if (this.car.driving) s.set({ wipers: (this.car.wiperOn = !this.car.wiperOn) })
    })
    i.onPress('KeyE', () => {
      // A cave chest in reach (on foot) opens first: full heal + a treasure.
      if (!this.car.driving && !this.bike.riding && this.caves.tryOpen(this.player.renderPosition)) {
        this.health.revive()
        return
      }
      // One key for everything (touch: BIKE/CAR button). Riding → get off the bike first (the truck can't be
      // entered from the saddle); otherwise the truck takes priority when both are near.
      // The car animates getting in / out itself (CarEntry); its events below play the door and engine.
      if (this.bike.riding) this.bike.toggle()
      else if (this.car.occupied || this.car.near) this.car.toggle()
      else this.bike.toggle()
    })
    // L (touch FLY / LAND): the flying car — wheels turn into jets; ↑ / ↓ climb and sink (on the ground: lift the body).
    // From the boat too (the hull folds away); landing over water puts the hull out.
    i.onPress('KeyL', () => {
      if (!this.net.flyingAllowed && !this.car.flyMode) return this.notify('Flying is off in this room', 2000)
      this.car.toggleFly()
    })
    // Simulation handling: X / Z gears (manual gearbox), Q low range, K locking differentials.
    // H: the tow hooks — take / hang / let go / unhook on foot; held in the car, the winch (gameplay/tow/TowSystem).
    i.onPress('KeyH', () => this.tow.press())
    i.onPress('KeyX', () => (this.car.shift(1), this.net.vehicle.press(Buttons.SHIFT_UP)))
    i.onPress('KeyZ', () => (this.car.shift(-1), this.net.vehicle.press(Buttons.SHIFT_DOWN)))
    i.onPress('KeyQ', () => (this.car.toggleLowRange(), this.net.vehicle.press(Buttons.LOW_RANGE)))
    i.onPress('KeyK', () => (this.car.cycleLockers(), this.net.vehicle.press(Buttons.LOCKERS)))
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

  /** Night ghosts come out when the setting is on — and always in the nightmare; storms strike either way, but only
   *  hurt (a strike by the player) when the ghosts are out. */
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

  // ---------------------------------------------------------------- settings & quality

  /** The car's engine voice; in arcade the gearbox's shift points stretch to the arcade top speed. */
/** The car's events: door sounds (open / slam), engine start / stop and the driving camera + HUD when the driver
   *  takes / leaves the wheel (Car + CarEntry animate the getting in and out). */
  private wireCar(): void {
    const car = this.car
    // The boat floats on the liquid water (none where it's dry, frozen or desert) — loaded chunk data, cheap.
    car.sim.water = (x, z) => this.world.waterAt(x, z)
    car.onEvent = (e) => {
      if (car !== this.car) return
      if (e === 'doorOpen') this.audio.play('door', 0.35, 1.25)
      else if (e === 'doorSlam') this.audio.play('door', 0.75)
      else if (e === 'drive') {
        this.audio.play(car.driving ? 'engineStart' : 'engineStop', 0.8)
        this.cameraCtl.vehicle = car.driving ? { distance: 8, pivot: 2.3 } : null
        if (car.driving) car.lights = this.darkness > 0.5 // lights come on with the dark; off by day
        this.store.set({ driving: car.driving, lights: car.lights, flying: car.driving && car.flyMode, boat: car.boatMode })
      } else if (e === 'fly') {
        this.audio.play('boost', 0.6, 0.8)
        this.store.set({ flying: car.flyMode })
      } else if (e === 'boat') {
        this.audio.play('boost', 0.35, 0.6) // hydraulics
        this.store.set({ boat: car.boatMode })
      } else if (e === 'clunk') this.audio.play('door', 0.5, 0.55) // a hull part locking home
      else if (e === 'hint') this.notify(car.hint)
      else if (e === 'explode') {
        // 100 %: the fireball. Anyone close is hurt (the driver, just thrown out, the most); the camera jolts.
        const at = car.engineWorld(new THREE.Vector3())
        this.vehicleFx.explode(at)
        this.audio.explosion(this.camera ? this.camera.position.distanceTo(at) : 10)
        this.cameraCtl.shake = 1
        const d = this.player.curr.distanceTo(at)
        if (d < 9) this.health.damage(Math.round(90 * (1 - d / 9) + 10), 'explosion')
        this.store.set({ carDamage: 100, driving: false })
        this.notify('The car blew up!', 3500)
        this.wreckClock = 12
      }
    }
    // CRASH DAMAGE (Car / Damage): the crunch, a jolt, and the warnings as it gets worse.
    car.onDamage = (amount, at, sev) => {
      if (car !== this.car) return
      const before = this.store.get().carDamage ?? 0, now = Math.round(car.damageLevel * 100)
      this.audio.crash(10, 6 + sev * 2.5, this.camera ? this.camera.position.distanceTo(at) : 6)
      if (car.driving) this.cameraCtl.shake = Math.min(1, this.cameraCtl.shake + 0.2 + sev / 14)
      this.store.set({ carDamage: now })
      if (before < 50 && now >= 50 && now < 90) this.notify('The engine is smoking — the car is badly damaged', 3200)
      else if (before < 90 && now >= 90 && now < 100) this.notify('The engine is on FIRE — get out!', 3500)
      void amount
    }
  }

  /** A short notice in the HUD toast (refused actions: "Land first", …). Read per frame by GameHud. */
  readonly notice = { text: '', until: 0 }
  notify(text: string, ms = 2600): void {
    this.notice.text = text
    this.notice.until = performance.now() + ms
  }

  /** The drivetrain's engine for the sound (Simulation handling on the wheels), reused object — no allocation. */
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
    this.settings = { ...prev, ...patch }
    if (patch.quality !== undefined) this.savedQuality = patch.quality
    // a newly chosen fixed resolution applies as is (applyOverrides only ever lowers the scale under Hold 60)
    if (typeof patch.resolution === 'number') this.post.setRenderScale(patch.resolution)
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
    this.syncImpostors()
    this.lighting.setQuality(q)
    // (a map whose trees shade with images on every tier: map.json imageTreeShadows — they never cast into the sun map)
    this.treeShadows.enabled = q.imageShadows || (!!this.map?.imageTreeShadows && q.features.shadows !== 'off')
    this.monsters.budget = q.monsters
    this.applyCasters()
    this.car.tyreShear = q.name === 'high' || q.name === 'ultra' // tread shear in corners (a few ALU per tyre vertex)
    this.car.gloss = q.name !== 'low'
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
    // phones: a crowd is the vertex load that matters most (a ₹15k GPU) — fewer full models on every preset
    this.remotes?.setQuality(this.device?.mobile ? Math.min(q.remoteCharacters, 6) : q.remoteCharacters, this.device?.mobile ? Math.min(q.remoteCars, 3) : q.remoteCars)
    this.tyreMarks.setBudget(q.tyreMarks)
    this.rainBudget = q.particles.rain
    this.caves.fxShare = q.particles.rain
    this.reflection.scale = q.reflections
    this.reflection.every = q.reflectionEvery
    this.reflection.skyline = q.reflectionSkyline
    this.post.setAO(q.ao.scale, q.ao.samples, q.ao.radius)
    // (a map's own horizon grid on every tier, map.json horizonRes — Zhangjiajie's towers: past LOW's short chunk ring
    // a 48² grid left slivers of sky between the chunks' cliffs and its own, and the towers melted into cones)
    this.horizon.configure(this.map?.horizonRes ? { size: q.horizon.size, res: Math.max(q.horizon.res, this.map.horizonRes) } : q.horizon)
    // Phones: the scene at ≤ 1.5 MP on every preset (2× canvas at full scale). ULTRA's desktop budget (4.2 MP) let a
    // 3.25× phone shade 2.3 MP (Mali-G720, 2026-10-20: 23–40 fps with every feature already down).
    this.post.setPixelBudget(this.device?.mobile ? Math.min(q.pixelBudget, MOBILE_PIXEL_BUDGET) : q.pixelBudget)
    // A new preset starts at its own scale (or the player's fixed one); a Hold 60 feature step (same preset) keeps the current one.
    const samePreset = this.quality.name === name && reason.startsWith('hold 60')
    const fixed = this.settings.resolution
    this.post.setRenderScale(samePreset ? THREE.MathUtils.clamp(this.post.renderScale, Math.min(q.renderScale.min, 0.65), this.maxRenderScale(q)) : fixed !== 'auto' ? fixed : q.renderScale.start)
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
  /**
   * Who casts into which shadow map. CACHED sun map (MEDIUM+): the car, bike, monsters and the player cast into the
   * per-frame dynamic map (their meshes on DYN_LAYER), not the sun's — it re-renders only when the player moved a
   * quarter of it. Otherwise into the sun's map as before (objectShadows).
   */
  private applyCasters(): void {
    const q = this.quality
    // (with a cached sun map, or with IMAGE tree shadows and no map at all — MEDIUM / HIGH)
    const dyn = q.objectShadows && (q.shadows ? q.shadowCache : q.imageShadows)
    this.dynShadow.enabled = dyn
    this.monsters.rig.castShadow = q.objectShadows && !dyn
    this.bike.castShadow = q.objectShadows && !dyn
    this.car.castShadow = q.objectShadows && !dyn
    for (const root of [this.monsters.rig.root, this.bike.root, this.car.root, this.character.root]) dynamicCaster(root, dyn)
  }

  private applyOverrides(): void {
    const q = this.quality
    const st = this.settings
    this.post.setAA(st.aa === 'auto' ? q.aa : st.aa)
    // Overland: no sharpening — the unsharp mask makes thin grass blades sparkle on phones.
    // Overland: no sharpening (thin grass sparkles on phones). Genshin: none either — its image is soft and painterly.
    this.post.setSharpness(st.sharpness === 'auto' ? (isOverland() || isGenshin() ? 0 : q.sharpen) : st.sharpness)
    this.post.grainScale = st.filmGrain ? 1 : 0
    // Painterly: tier default, or the player's explicit choice (LOW defaults off — ~25 fetches/px).
    const stride = q.paint.stride || (st.painterlyForce ? 1 : 0)
    this.post.setPaint(st.painterly ? stride : 0, q.paint.bloom * q.fx.bloom)
    this.materials.setAlphaToCoverage(this.post.aa === 'msaa2' || this.post.aa === 'msaa4')
    // A fixed resolution is exact — or, with Hold 60, the ceiling Hold 60 may lower the scene from (never above it).
    if (st.resolution !== 'auto') this.post.setRenderScale(this.holdMode ? Math.min(this.post.renderScale, st.resolution) : st.resolution)
    const native = window.devicePixelRatio || 1
    let dpr = st.pixelRatio === 'auto' ? Math.min(native, q.maxDpr) : st.pixelRatio === 'native' ? native : Math.min(native, st.pixelRatio)
    // Phones holding 60: no canvas past 2× — a sharper one can't be seen at arm's length, but every pixel of it is
    // shaded by the grading / FXAA pass (3.25× = 2.6× the pixels of 2×).
    if (this.device?.mobile && this.holdMode) dpr = Math.min(dpr, MOBILE_MAX_DPR)
    this.setDpr?.(dpr)
    this.store.set({ dpr })
    // Real dynamic shadow for the character where the sun map re-renders every frame; blob otherwise.
    const dyn = q.objectShadows && (q.shadows ? q.shadowCache : q.imageShadows) // (it casts into the dynamic map — applyCasters)
    const realShadow = (dyn || (q.shadows && q.objectShadows && q.sunShadowEvery === 1)) && ART.style !== 'storybook'
    this.character.castShadow = realShadow && !dyn
    this.blobShadow.userData.enabled = !realShadow
  }

  private onAdaptive(d: AdaptiveDecision): void {
    const q = this.quality
    const s = this.post.renderScale
    switch (d.kind) {
      case 'scaleDown':
        this.post.setRenderScale(Math.max(this.holdMode ? Math.min(q.renderScale.min, 0.65) : q.renderScale.min, s - 0.1 * (d.steps ?? 1)))
        break
      case 'scaleUp':
        this.post.setRenderScale(Math.min(this.maxRenderScale(q), s + 0.1))
        break
      case 'tierDown': {
        // Chosen preset + Hold 60: lower the costliest feature one level instead of changing the preset.
        if (this.holdMode) {
          if (d.reason === 'probe reverted' && this.holdRestored) this.holdSticky.add(this.holdRestored)
          this.holdRestored = null
          this.holdStepAt = performance.now()
          // (far over budget: 2–3 features at once — one applyQuality, one recompile)
          const down: string[] = []
          for (let k = 0; k < (d.steps ?? 1); k++) {
            const f = nextHoldStep(this.presetFeatures, this.held)
            if (!f) break
            this.held.push(f)
            down.push(f)
          }
          if (down.length) this.applyQuality(q.name, `hold 60: ${down.join(' + ')} down`)
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
  /** Highest scene scale adaptive may climb to: the preset's, or the player's fixed resolution (Hold 60's ceiling). */
  private maxRenderScale(q: QualitySettings): number {
    const r = this.settings.resolution
    return r === 'auto' ? q.renderScale.max : r
  }
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
            this.tow.fixedStep(fdt)
            this.net.vehicle.beforeStep()
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
          this.cameraCtl.ignoreBody = this.car.occupied ? this.car.sim.body : null
          // Simulation handling: the chassis-attached first person / weighted chase view (arcade keeps its chase below).
          this.cameraCtl.car = this.car.driving && !this.car.sim.arcade ? this.car : null
          this.cameraCtl.zoomBy(this.input.consumeZoom())
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
            // Crawling (rocks, tight spots): no swing back — look around freely.
            const gate = recentreGate(sim.speed)
            p.yaw += d * Math.min(1, dt * 3.5) * gate
            p.pitch += (-0.12 - p.pitch) * Math.min(1, dt * 2) * gate
          }
          if (Math.abs(fov - cam.fov) > 0.01) {
            cam.fov = fov
            cam.updateProjectionMatrix()
          }
        },
      })
      .add({ name: 'bike', update: (dt) => this.bike.update(dt, this.physics.alpha) }) // after camera: overrides the rider pose
      .add({
        name: 'net',
        update: (dt) => {
          // multiplayer: this frame's pose out (30 Hz), everyone else placed at the interpolated server time
          this.net.update(dt)
          const t = this.net.serverNow()
          if (t !== null && this.camera) this.remotes.update(dt, t, this.camera.position, this.post.targetHeight)
        },
      })
      .add({
        name: 'car',
        update: (dt) => {
          this.car.showDriver = this.cameraCtl.mode === 'tpp'
          // (the driver's switch: J — faster in heavy rain or snow; parked when off or out of the car)
          if (!this.car.driving && this.car.wiperOn) this.store.set({ wipers: (this.car.wiperOn = false) })
          this.car.wipers = this.car.wiperOn ? Math.max(0.35, Math.min(1, (this.weather.rain + glassWeather.uSnowG.value) * 1.4)) : 0
          if (this.wreckClock > 0 && (this.wreckClock -= dt) <= 0) this.respawnCar()
          this.car.update(dt, this.physics.alpha, this.cameraCtl.flashOrigin, this.cameraCtl.flashTarget)
          this.tow.update() // (after the cars are posed: the ropes run between their hooks)
          if (this.camera) {
            // Exhaust + tyre smoke/dust, lit by the sky fill and a share of the sun, sized in RT pixels.
            const L = this.lighting
            const sk = Math.min(L.sun.intensity, 3) * 0.22
            this.fxLight.copy(L.hemi.color).multiplyScalar(L.hemi.intensity * 0.55)
            this.fxLight.r += L.sun.color.r * sk
            this.fxLight.g += L.sun.color.g * sk
            this.fxLight.b += L.sun.color.b * sk
            this.vehicleFx.update(dt, this.car, this.world.fields, this.camera.position, globalUniforms.uWind.value, this.fxLight, this.post.targetHeight)
            this.tyreMarks.update(dt, this.car, this.world, this.camera.position)
          }
        },
      })
      .add({
        name: 'world',
        update: (dt, time) => {
          this.destruction.update(dt)
          if (!this.camera) return
          // Physics look-ahead: where a moving vehicle / player will be in ~1.5 s → its chunk gets colliders early.
          const v = this.car.driving ? this.car.velocity(this.ahead) : this.ahead.copy(p.velocity)
          this.ahead.copy(v).multiplyScalar(1.5).add(p.renderPosition)
          this.world.update(p.renderPosition, this.cullingDebug.cullCamera(this.camera), this.ahead)
          this.mapProps?.update(p.renderPosition)
          this.pillars?.update(p.renderPosition, this.quality.viewDistance * 1.05)
          if (this.mistSheets) {
            // the cloud takes the sky's haze, lifted toward white (by day) — dimmed with the light at night
            this.mistCol.copy(this.tod.current.fogColor).lerp(this.tod.current.sunColor, 0.15).multiplyScalar(1.05)
            this.mistSheets.update(time, this.camera.position.y, this.quality.name === 'low' ? 1 : this.quality.name === 'medium' ? 2 : 3, this.mistCol)
          }
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
          const rw = this.world.fields.region(p.renderPosition.x, p.renderPosition.z, this.rw, p.renderPosition.y)
          applyBiomeAir(this.tod.current, bw[0], bw[1], rw[Biome.Autumn], rw[Biome.Mystic])
          if (this.mapAir) applyMapAir(this.tod.current, this.mapAir)
          // CAVES: how deep in the dark the player stands → the lights dim (sky fill, sun on tiers without shadows),
          // the torch works at full strength; fog / exposure / haze below.
          this.caves.update(dt, time, p.renderPosition, this.lighting.keyStrength * (1 - this.tod.nightmare) * THREE.MathUtils.smoothstep(this.tod.sunDir.y, 0.0, 0.25))
          this.lighting.cave = this.caves.inside
          // Cached sun map: re-render it only when the casters changed — chunks built / dropped round the player or a
          // chunk switched LOD (it was every 2 s as well: a full 4096² caster pass every 120 frames standing still, a
          // periodic hitch on weak GPUs).
          if (this.world.chunks.size !== this.lastChunkN || this.world.stats.lodSwitches !== this.lastLodSwitches) {
            this.lastChunkN = this.world.chunks.size
            this.lastLodSwitches = this.world.stats.lodSwitches
            this.lighting.invalidateShadow()
          }
          if (this.car.driving) this.car.headlamp2(this.lighting.headlight2Origin, this.lighting.headlight2Target)
          this.lighting.update(dt, p.renderPosition, c.flashOrigin, c.flashTarget)
          // Image tree shadows follow the key light and take away its direct light like the real shadow would (its
          // shadow.intensity), less as it fades (dusk, overcast), none in a cave.
          this.treeShadows.update(this.renderer, this.world, p.renderPosition, this.lighting.keyDir, THREE.MathUtils.clamp(this.lighting.sun.intensity / 1.2, 0, 1) * this.lighting.sun.shadow.intensity * (1 - this.caves.inside))
          this.ash.update(time, cam.position, THREE.MathUtils.smoothstep(this.tod.nightmare, 0.2, 0.9), this.renderer?.domElement.height ?? 800)
          const darkness = (this.darkness = 1 - THREE.MathUtils.smoothstep(this.tod.sunDir.y, 0.05, 0.45) * (1 - this.tod.nightmare))
          // One spot light: the torch on foot, the headlights in the truck (its own switch).
          const lit = this.car.driving ? this.car.lights : this.lighting.flashlightOn
          this.lighting.spotOn = lit
          this.lighting.spotIsHeadlights = this.car.driving
          this.beam.update(c.flashOrigin, c.flashTarget, lit, darkness, c.mode === 'fpp' && !this.car.driving)
          this.car.updateLamps(darkness)
          if (this.remotes) this.remotes.darkness = darkness
          // Street lamps: on from dusk; `lampT` = seconds since they switched on (each post flickers to life in its own time).
          if (darkness > 0.55) this.lampOnAt ??= time
          else this.lampOnAt = null
          this.materials.setLamps(darkness, this.lampOnAt === null ? -1 : time - this.lampOnAt, time)
          const tp = this.tod.current
          // Weather on top of the phase blend: clouds dim/grey, rain washes, wind scales the shared uniform.
          this.weather.apply(tp, globalUniforms.uWind.value)
          // No puddles on snow or sand: the snowfield and the desert stay dry underfoot.
          globalUniforms.uWet.value = this.weather.wet * (1 - bw[0]) * (1 - bw[1])
          this.car.wetness = globalUniforms.uWet.value // wet asphalt / mud / grass grip less (drivetrain tyres)
          this.lightning.storm = this.weather.rain
          // SOUND: the mixer follows the vehicles, weather and time of day; footsteps by stride length.
          {
            const camR = this.fxDir.set(1, 0, 0).applyQuaternion(cam.quaternion)
            const pan = (x: number, z: number) => { const dx = x - cam.position.x, dz = z - cam.position.z, l = Math.hypot(dx, dz) || 1; return ((dx * camR.x + dz * camR.z) / l) * 0.6 }
            const car = this.car, bike = this.bike, bs = bike.sim
            const sim = car.sim, slip = Math.max(...sim.wheelSlip)
            this.audio.frame({
              dt, darkness, nightmare: this.tod.nightmare, menu: this.store.get().landing, rain: this.weather.rain * (1 - bw[0]) * (1 - bw[1]),
              car: { engineOn: car.driving, distance: car.pos.distanceTo(cam.position), pan: pan(car.pos.x, car.pos.z), speed: sim.speed, wheelSpeed: sim.wheelSpeed, throttle: sim.controls.throttle, boost: (sim.arcade ? sim.nitroOn : sim.controls.boost) || car.flying || (car.afloat && Math.abs(sim.speed) > 3), slip, engine: this.engineVoice(car), sim: this.engineSim(car), tyres: car.sim.tyreNoise() ?? undefined },
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
          // Region ambience in the same pool: drifting leaves in the autumn valleys, glowing spores in the mystic woods
          // (BiomeDefs.leaves / spores × the region weight under the player; spores glow brighter at night).
          const leafAmt = rw[Biome.Autumn] * BIOMES[Biome.Autumn].leaves * (1 - 0.5 * this.weather.rain)
          const sporeAmt = rw[Biome.Mystic] * BIOMES[Biome.Mystic].spores * (0.6 + 0.4 * this.darkness)
          const allP = precip + leafAmt + sporeAmt
          this.rain.update(time, cam.position, Math.min(1, allP), this.rainBudget, globalUniforms.uWind.value, this.fxLight.copy(tp.hemiSky).multiplyScalar(0.9), this.renderer?.domElement.height ?? 800,
            allP > 0 ? snowFall / allP : 0, allP > 0 ? leafAmt / allP : 0, allP > 0 ? sporeAmt / allP : 0)
          // Rain / snow on the car glass (Car carGlass: beads, running drops, flecks, the wipers) — none in a cave
          glassWeather.uRainG.value = this.weather.rain * (1 - bw[0]) * (1 - bw[1]) * (1 - this.caves.inside)
          glassWeather.uSnowG.value = Math.min(1, snowFall) * (1 - this.caves.inside)
          glassWeather.uTimeG.value = time
          glassWeather.uSpeedG.value = this.car.driving ? Math.abs(this.car.sim.speed) : 0
          glassWeather.uLightG.value.copy(this.fxLight)
          // (no snow powder either, 2026-10-24: "remove the white things — natural snowfall is there"; its streaks
          //  skimming the road read as white litter beside the RainParticles snowfall)
          this.drift.update(time, cam.position, p.renderPosition.y, 0, 0, this.weather.wind, this.quality.fx.drift, globalUniforms.uWind.value, this.fxLight, this.renderer?.domElement.height ?? 800)
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
          // In a cave: a dark, close fog (the far end of the chamber fades into black) and no aerial haze.
          const cave = this.caves.inside
          if (cave > 0.001) {
            this.fog.color.lerp(this.caveFog, cave)
            this.fog.near += (4 - this.fog.near) * cave
            this.fog.far += (75 - this.fog.far) * cave
            globalUniforms.uFogMax.value += (1 - globalUniforms.uFogMax.value) * cave
          }
          globalUniforms.uAerial.value.z = this.aerialBase * (1 - cave)
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
          skyUniforms.uSkyMist.value.set(tp.mistDensity * (1 - 0.35 * bw[0]) * (1 - this.caves.inside), tp.mistBase, tp.mistFalloff, cam.position.y)
          this.mistColor.copy(tp.fogColor).lerp(this.lighting.sun.color, 0.12 * this.lighting.keyStrength).multiplyScalar(1.05)
          this.post.setMist(skyUniforms.uSkyMist.value.x, tp.mistBase, tp.mistFalloff, cam.position.y, this.mistColor, time, globalUniforms.uWind.value)
          this.sky.update(this.tod, cam, time)
          this.horizon.update(p.renderPosition, this.world.builtRadius)
          this.world.visibility.maxDistance = Math.min(q.viewDistance, q.renderRadius * CHUNK_SIZE + 24) + 20
          this.water.update(time, cam.position, this.fog.near, this.fog.far, this.lighting.keyDir, this.lighting.sun.color, this.weather.rain)
          this.post.applyGrading(tp, time)
          // Eye adaptation in the dark of a cave (Genshin opens the exposure in caves: dark, but readable).
          this.post.material.uniforms.uExposure.value *= 1 + 0.55 * this.caves.inside
          const k = this.lighting.keyStrength
          this.post.updateGodRays(cam, this.lighting.sun, this.lighting.keyDir, tp.rays * k * (1 - this.caves.inside), tp.shafts * k * (1 - this.caves.inside), this.fog.near, this.fog.far, this.quality.sunShadowExtent * 1.2)
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

  /**
   * Enough world to hand over control (0..1; 1 = go): the 5 × 5 chunks round the player (~160 m) and colliders under
   * them. The rest of the ring (and the horizon) streams in while you play — waiting for all 81 chunks of an ULTRA
   * ring was most of the old load. PLAY shows the "Entering the world" screen until this reaches 1.
   */
  playReadiness(): number {
    const p = this.player.curr
    return this.world.builtNear(p.x, p.z, 2) * 0.9 + (this.world.isReadyAt(p.x, p.z) ? 0.1 : 0)
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

  /** Put `model` in the world parked at (x, z) facing `heading` (the old car goes). */
  private swapCar(model: TruckModel, x: number, z: number, heading: number, nearY?: number): void {
    // The new car first: if building it throws, the old one is still whole and in the world (disposing it first
    // left a freed physics body that every frame then read — "null pointer passed to rust" each step).
    const next = new Car(this.materials.character, model, this.physics, this.world.fields, this.player, this.character, this.input, this.tuning(model.id))
    this.car.dispose() // (forceOut: an occupant is put beside it, no animation)
    this.car = next
    this.car.park(x, z, heading, nearY)
    this.car.sim.arcade = this.settings.handling === 'arcade'
    this.car.driveSettings(this.settings.gearbox, this.settings.aids, this.input.touch, this.settings.offroadAssist)
    this.car.autoAccel = this.settings.autoAccelerate
    this.wireCar()
    this.envRoot.add(this.car.root)
    this.applyCasters()
    this.car.tyreShear = this.quality.name === 'high' || this.quality.name === 'ultra'
    this.car.gloss = this.quality.name !== 'low'
    this.car.setMap(this.quality.name === 'low' && model.map ? downscaleTexture(model.map, 512) : model.map)
    this.store.set({ carDamage: 0 })
  }

  /** After a car blew up: a fresh one of the same model waits on the road ahead of the player (GTA's "get a new
   *  ride"), the wreck is cleared. */
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
  private wreckClock = -1

  /** R / ⟲ while driving: the car back on its wheels, still, where it is (Car.respawnHere). */
  respawnHere(): void {
    if (this.car.respawnHere()) {
      this.net.respawned()
      this.notify('Car respawned', 1500)
    }
  }

  /** Front-end navigation: PLAY hands over control; GARAGE / BACK switch screens; the pause menu returns to it. */
  play(): void {
    this.store.set({ landing: false, screen: 'menu' })
    void this.net.ensureRoom() // every game is a room (offline: plays on alone)
  }

  /** Menu: the settings the next room opens with (persisted). */
  setRoomSetup(patch: Partial<RoomSetup>): void {
    const roomSetup = { ...this.store.get().roomSetup, ...patch }
    this.store.set({ roomSetup })
    try {
      localStorage.setItem('dark.room.setup', JSON.stringify(roomSetup))
    } catch {
      /* private mode */
    }
  }

  /** The name other players see (persisted; the next session token carries it). */
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
  /** The local player's pose for the server: the car's when driving, the bike's rider, else the player's feet. */
  localPose(): LocalPose {
    const o = this.pose
    const car = this.car
    let flags = this.lighting.flashlightOn ? Flags.LIGHTS : 0
    if (car.driving) {
      const v = car.sim.body.linvel(), q = car.sim.body.rotation()
      o.x = car.pos.x; o.y = car.pos.y; o.z = car.pos.z
      o.vx = v.x; o.vy = v.y; o.vz = v.z
      o.yaw = car.heading
      // nose-up pitch from the chassis forward axis (−Z rotated by q)
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

  /** The server put us somewhere (joining a room: beside its owner / at a map spawn). The world streams in round the
   *  spot first (DEFERRED SPAWN), then the player and the car are placed there. */
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

  /** The server rejected our pose: snap to its. */
  netCorrect(x: number, y: number, z: number, yaw: number): void {
    if (this.car.driving) this.car.park(x, z, yaw, y + 2)
    else this.player.teleport(new THREE.Vector3(x, y, z))
  }
  showScreen(screen: 'menu' | 'garage' | 'maps'): void {
    if (document.pointerLockElement) document.exitPointerLock()
    this.store.set({ landing: true, screen, settingsOpen: false })
  }

  private photo: { rt: THREE.WebGLRenderTarget; scene: THREE.Scene; cam: THREE.PerspectiveCamera; key: THREE.DirectionalLight; fill: THREE.DirectionalLight } | null = null
  /**
   * GARAGE PHOTO: the current car alone — studio lights, transparent background, clean (no dirt coat), 3/4 front
   * view — rendered ONCE into a small target and returned as an image URL. The garage shows it over the key art and
   * re-shoots it when the car, its paint or its tyres change: no 3D frame runs behind the front end. One render of the
   * car's ~15 draws + a pixel read (~2–6 ms per shot, only on a change); the first shot compiles the studio variant of
   * the truck program (no fog, studio lights). null = not yet: no renderer, or the car is not placed / posed yet
   * (before the spawn chunk arrives its wheels and struts are in their unposed rest state).
   */
  carPhoto(width: number, height: number): string | null {
    const r = this.renderer
    if (!r || this.pendingSpawn) return null
    const p = (this.photo ??= (() => {
      const rt = new THREE.WebGLRenderTarget(width, height, { samples: 4, colorSpace: THREE.SRGBColorSpace })
      const scene = new THREE.Scene()
      const key = new THREE.DirectionalLight(0xfff0dc, 2.6), fill = new THREE.DirectionalLight(0xc8d4ff, 0.9)
      scene.add(new THREE.HemisphereLight(0xfff4e6, 0x4a4050, 1.25), key, key.target, fill, fill.target)
      return { rt, scene, cam: new THREE.PerspectiveCamera(26, width / height, 0.1, 100), key, fill }
    })())
    if (p.rt.width !== width || p.rt.height !== height) p.rt.setSize(width, height)
    const car = this.car.root, parent = car.parent
    car.updateMatrixWorld(true)
    const box = new THREE.Box3()
    car.traverseVisible((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh || (m.material as THREE.Material).transparent) return
      m.geometry.computeBoundingBox()
      box.union(_pb.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld))
    })
    if (box.isEmpty()) return null
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3())
    // 3/4 front view from a little above (the car faces its local −Z), framed to the box's bounding sphere.
    const q = car.getWorldQuaternion(new THREE.Quaternion())
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q), right = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
    const dir = fwd.clone().multiplyScalar(0.82).addScaledVector(right, -0.62).add(new THREE.Vector3(0, 0.3, 0)).normalize()
    const cam = p.cam
    cam.aspect = width / height
    const rad = size.length() * 0.5, fit = rad / Math.sin(THREE.MathUtils.degToRad(cam.fov * 0.5)) * Math.max(1, 1.15 / cam.aspect)
    cam.position.copy(c).addScaledVector(dir, fit * 0.7)
    cam.lookAt(c.x, c.y - size.y * 0.06, c.z)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
    p.key.position.copy(c).addScaledVector(fwd, 4).addScaledVector(right, -3).add(_up.set(0, 6, 0))
    p.key.target.position.copy(c)
    p.fill.position.copy(c).addScaledVector(fwd, 2).addScaledVector(right, 5).add(_up.set(0, 2, 0))
    p.fill.target.position.copy(c)
    // The stylized shading reads the game's key light (rim / terminator): the studio key's for this shot.
    const u = globalUniforms
    const keep = { dir: u.uKeyDirView.value.clone(), col: u.uKeyColor.value.clone(), toon: u.uToon.value, ts: u.uTreeShadeOn.value, ds: u.uDynShadowOn.value, wet: u.uWet.value }
    u.uKeyDirView.value.copy(p.key.position).sub(c).normalize().transformDirection(cam.matrixWorldInverse)
    u.uKeyColor.value.set(0xfff0dc).multiplyScalar(1.6)
    u.uToon.value = 1
    u.uTreeShadeOn.value = u.uDynShadowOn.value = u.uWet.value = 0
    const prevRT = r.getRenderTarget(), prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha()
    const px = new Uint8Array(width * height * 4)
    try {
      p.scene.add(car)
      r.setRenderTarget(p.rt)
      r.setClearColor(0x000000, 0)
      r.clear()
      this.car.clean(() => r.render(p.scene, cam))
      r.readRenderTargetPixels(p.rt, 0, 0, width, height, px)
    } finally {
      parent?.add(car)
      r.setRenderTarget(prevRT)
      r.setClearColor(prevClear, prevAlpha)
      u.uKeyDirView.value.copy(keep.dir)
      u.uKeyColor.value.copy(keep.col)
      u.uToon.value = keep.toon
      u.uTreeShadeOn.value = keep.ts
      u.uDynShadowOn.value = keep.ds
      u.uWet.value = keep.wet
    }
    // (rows bottom-up in GL → flip into the canvas)
    const cv = document.createElement('canvas')
    cv.width = width
    cv.height = height
    const ctx = cv.getContext('2d')!
    const img = ctx.createImageData(width, height), row = width * 4
    for (let y = 0; y < height; y++) img.data.set(px.subarray((height - 1 - y) * row, (height - y) * row), y * row)
    ctx.putImageData(img, 0, 0)
    return cv.toDataURL('image/png')
  }

  /** Back on the road near where you fell, full health; nearby monsters retreat. */
  /** ?at=cave: start 16 m outside the nearest hillside cave mouth (to the origin), looking in. */
  private spawnAtCave(): void {
    const f = this.world.fields
    const cave = f.formations.cavesNear(0, 0, 3000).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0]
    if (!cave) return
    const c = Math.cos(cave.rot), s = Math.sin(cave.rot) // local +x = into the hill
    const x = cave.x + (MOUTH_X - 16) * c, z = cave.z + (MOUTH_X - 16) * s
    this.player.teleport(new THREE.Vector3(x, f.surface(x, z) + 0.05, z))
    this.player.yaw = this.character.yaw = Math.atan2(-c, -s)
    this.player.pitch = 0
  }

  /**
   * FIXED MAP: the road point nearest (x, z) (its samples), moved `ahead` m along the road, + the yaw facing along it
   * (forward = (−sin yaw, −cos yaw)), 1.4 m into the right lane. Spawns, car swaps and respawns use it instead of the
   * endless world's main road.
   */
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

  private impostorAtlas: ImpostorAtlas | null = null
  private impostorAtlasSize = 0
  /**
   * Octahedral impostors (rendering/impostors): bake the tree atlas at the tier's size (once; again only if the
   * size changes — ~30–80 ms GPU), pick the 1- or 3-view shader, set the per-tree LOD distances and turn the
   * per-tree LOD + far forest on.
   */
  private syncImpostors(): void {
    const r = this.renderer
    if (!r) return
    const q = this.quality, im = q.impostors
    const mat = this.materials.impostor
    if (mat.userData.blend !== im.blend) {
      mat.userData.blend = im.blend
      mat.needsUpdate = true
    }
    if (!this.impostorAtlas || this.impostorAtlasSize !== im.atlas) {
      this.impostorAtlas?.dispose()
      this.impostorAtlas = bakeImpostors(r, this.world.treeSpecies.map((s) => ({ id: s.id, geometry: s.levels[0] })), this.materials.atlas, im.atlas)
      this.impostorAtlasSize = im.atlas
      useImpostorAtlas(mat, this.impostorAtlas)
    }
    const l1 = Math.min(q.trees.lod1, im.start) // ≥ start: near mesh → impostor directly
    globalUniforms.uTreeLod.value.set(l1, l1 + TREE_FADE, im.start, im.start + TREE_FADE)
    globalUniforms.uImpFar.value.set(im.far * 0.6, im.far) // the forest thins out across the last 40 %
    this.world.setImpostors(true)
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
      const hold = this.holdMode
      // A fixed resolution stays put — unless Hold 60 is on: then it is the ceiling and frames that run long lower
      // the scene below it first (2026-10-20: a saved 100 % pinned the scale, so Hold 60 dropped every feature instead).
      const fixedRes = this.settings.resolution !== 'auto' && !hold
      // Hold 60 on a chosen preset may drop the resolution further than the preset's own range before it
      // touches a feature (a little softer is a smaller loss than no shadows / reflections).
      const minScale = hold ? Math.min(q.renderScale.min, 0.65) : q.renderScale.min
      // 30 fps that is the BROWSER's cap (Low Power Mode / battery saver) can't be fixed by lowering quality:
      // probe it first (capProbe) and don't degrade anything while capped.
      this.updateCapProbe(s.rawFrameMs)
      const capped = this.capProbe > 0 || this.fpsCapped
      const d = capped ? null : this.adaptive.sample(s.rawFrameMs, s.gpuMs, s.cpuMs, {
        canScaleDown: !fixedRes && this.post.renderScale > minScale + 1e-3,
        canScaleUp: !fixedRes && this.post.renderScale < this.maxRenderScale(q) - 1e-3,
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
    if (this.pendingSpawn && !this.spawnNow()) return
    this.loop.tick(dt)
    // All of this frame's own CPU work (systems + anything before them) — what a cap probe must rule out.
    if (this.capProbe > 0) this.capTickMs = Math.max(this.capTickMs, performance.now() - frameT0)
  }

  /**
   * DEFERRED SPAWN: the exact placement of the player, bike and truck (and every system's frame) waits until the
   * chunks under the spawn and the truck exist — their worker built the road network there and the main thread
   * imported it, so the `surface` queries are cache hits instead of seconds of A* in a frame. Until then only the
   * world streams (behind the menu's key art / "Entering the world"). True = spawned, run the frame.
   */
  private pendingSpawn: { x: number; z: number; place: () => void } | null = null
  private spawnNow(): boolean {
    const s = this.pendingSpawn!, p = this.player.renderPosition
    if (this.world.isReadyAt(p.x, p.z) && this.world.isReadyAt(s.x, s.z)) {
      this.pendingSpawn = null
      s.place()
      return true
    }
    if (this.camera) this.world.update(p, this.camera, p)
    return false
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
    if (!this.warmed && this.playReadiness() >= 1) {
      this.warmShaders(renderer, scene, camera)
      this.store.set({ worldReady: true })
    }
    // The FRONT END (main menu, garage) is a still KEY-ART image over the canvas (ui/KeyArt): no 3D frame behind it —
    // the GPU idles while the world streams in, the shaders above compile under cover. The garage shows the car as a
    // studio photo shot on demand (carPhoto), not the live world.
    if (this.store.get().landing) return
    if (this.capProbe > 0) return // cap probe: draw nothing for a few frames (the last image stays on screen)
    perf?.gpu.begin()
    if (this.quality.fx.trails) {
      this.stampTyres()
      this.trails.render(renderer, this.player.renderPosition)
    }
    globalUniforms.uTrailOn.value = this.quality.fx.trails ? 1 : 0
    // (not on a frame where the sun just got its shadow back without a map yet: the mirror reuses the shadow maps,
    // and a lit draw with no map bound is rejected — GL_INVALID_OPERATION sampler mismatch — until the main pass makes it)
    const { sun, flashlight } = this.lighting
    const mapless = (sun.castShadow && !sun.shadow.map) || (flashlight.castShadow && !flashlight.shadow.map)
    this.reflection.active = this.world.stats.shoreVisible > 0 && !mapless
    this.sky.full() // the reflection's own camera/target: the dome draws the real sky there
    this.reflection.render(renderer, scene, camera)
    this.sky.prepare(renderer, camera, this.post.target.width, this.post.target.height, this.quality.skyScale)
    this.water.setReflection(this.reflection.target.texture, this.reflection.textureMatrix, this.reflection.valid)
    this.dynShadow.render(renderer, scene, this.player.renderPosition, this.lighting.keyDir, THREE.MathUtils.clamp(this.lighting.sun.intensity / 1.2, 0, 1) * this.lighting.sun.shadow.intensity * (1 - this.caves.inside), this.dynSkip)
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
    this.mapProps?.dispose()
    this.pillars?.dispose()
    this.mistSheets?.dispose()
    window.removeEventListener('touchstart', this.onFirstTouch)
    this.world.dispose()
    this.treeShadows.dispose()
    this.dynShadow.dispose()
    this.tow.dispose()
    this.physicsDebug.dispose()
    this.post.dispose()
    this.sky.dispose()
    this.beam.dispose()
    this.bike.dispose()
    this.car.dispose()
    this.vehicleFx.dispose()
    this.tyreMarks.dispose()
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
    this.photo?.rt.dispose()
    this.materials.dispose()
    this.physics.dispose()
  }
}

const _pb = new THREE.Box3(), _up = new THREE.Vector3()
/** Phones: scene pixels and canvas DPR caps (see applyQuality / applyOverrides). */
const MOBILE_PIXEL_BUDGET = 1.5e6 // a landscape phone at 2× (≈ 1.3 MP) renders at full scale
const MOBILE_MAX_DPR = 2
