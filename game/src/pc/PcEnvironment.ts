import * as pc from 'playcanvas'
import * as THREE from 'three'
import { TimeOfDay } from '../rendering/lighting/TimeOfDay'
import { Weather } from '../rendering/weather/Weather'
import { applyBiomeAir, applyMapAir, dayWeight, type MapAir } from '../rendering/weather/BiomeAir'
import { globalUniforms } from '../rendering/shaders/uniforms'
import { skyUniforms } from '../rendering/sky/skyShader'
import { ART } from '../rendering/artStyle'
import { Biome, BIOME_COUNT, type BiomeWeights, type RegionWeights } from '../world/Biomes'
import type { WorldFields } from '../world/WorldFields'
import type { FixedMap } from '../world/map/FixedMap'
import { PcLighting } from './PcLighting'
import { activeLook, type Look } from './look'
import { PcSky } from './PcSky'
import { pushUniforms } from './uniformBridge'

/**
 * The ENVIRONMENT on PlayCanvas — the three build's per-frame lighting sequence (Game 'lighting' system), engine-free
 * parts reused as they are: TimeOfDay → biome air (desert / snow / autumn / mystic) → the map's own air → weather →
 * the key light + hemisphere fill (PcLighting), the fog distances, the sky (PcSky), the shared uniforms (fog cap, land
 * haze, aerial perspective, mist, wetness, wind, time, key light) pushed into the device scope once, and the grading on
 * PlayCanvas's CameraFrame (Neutral tone mapping as the three build, exposure, tint, saturation, contrast, vignette).
 * The map's LOOK (pc/look.ts) sets its shared uniforms (wrapped light, rim, leaf blur, the cel strength).
 */
export class PcEnvironment {
  readonly tod: TimeOfDay
  readonly weather: Weather
  readonly lighting: PcLighting
  readonly sky: PcSky
  readonly frame: pc.CameraFrame
  private readonly mapAir: MapAir | null
  private readonly bw: BiomeWeights = [0, 0]
  private readonly rw: RegionWeights = new Float32Array(BIOME_COUNT)
  private readonly aerialBase: number
  private readonly tint = new pc.Color()
  private readonly look: Look = activeLook()
  /** The snow weight at the focus (the water freezes over in a snow region). */
  snowHere = 0
  /** How deep in a cave the player is (0..1, set by the caller). */
  cave = 0
  /** Horizon distance (m): fog completes there; the land fog cap rim fades out at 70–96 %. */
  horizon = 2200
  /** false: the game advances its clock and weather itself (PcGame) */
  private readonly ownsClock: boolean

  constructor(private readonly app: pc.AppBase, cam: pc.Entity, private readonly fields: WorldFields, map: FixedMap | null, seed: number, hour: number, own?: { tod: TimeOfDay; weather: Weather }) {
    this.tod = own?.tod ?? new TimeOfDay(hour)
    this.tod.setStyle(ART.style)
    this.weather = own?.weather ?? new Weather(seed, globalUniforms.uWind.value)
    this.ownsClock = !own
    this.lighting = new PcLighting(app)
    this.sky = new PcSky(app)
    this.frame = new pc.CameraFrame(app, cam.camera!)
    const f = this.frame
    f.rendering.toneMapping = pc.TONEMAP_NEUTRAL
    f.rendering.samples = 1
    f.grading.enabled = true
    const lk = this.look
    globalUniforms.uWrap.value = lk.wrap
    globalUniforms.uRimK.value = lk.rimK
    globalUniforms.uDetailK.value = lk.detailK
    globalUniforms.uLeafBlur.value = lk.leafBlur
    this.lighting.key.light!.shadowIntensity = lk.shadowK
    this.lighting.moonK = lk.moonK
    this.lighting.exposureK = lk.exposureK
    this.lighting.moonSilver = lk.moonSilver
    this.lighting.fillFloor.setRGB(...lk.fillFloor)
    f.update()
    // the map's own colours and air (as Game's constructor)
    const pal = map?.palette
    if (map) globalUniforms.uSnowLine.value.set(1e5, 1e5 + 40)
    if (pal?.grass && pal.dirt) {
      globalUniforms.uPalGrass.value.set(pal.grass[0], pal.grass[1], pal.grass[2], 1)
      globalUniforms.uPalDirt.value.set(pal.dirt[0], pal.dirt[1], pal.dirt[2], 1)
    }
    if (pal?.dirt) globalUniforms.uRoadSoil.value.set(pal.dirt[0] * 0.62, pal.dirt[1] * 0.6, pal.dirt[2] * 0.6, 1)
    if (pal?.cliff) globalUniforms.uCliffStone.value.set(pal.cliff[0], pal.cliff[1], pal.cliff[2], map?.naturalStone ? 2 : 1)
    if (pal?.cliffMoss && map?.cliffMoss) globalUniforms.uCliffMoss.value.set(pal.cliffMoss[0], pal.cliffMoss[1], pal.cliffMoss[2], map.cliffMoss)
    if (pal?.skyZenith || pal?.skyHaze || map?.mist || map?.light) {
      const col = (v?: [number, number, number]) => (v ? new THREE.Color().setRGB(v[0], v[1], v[2]) : undefined)
      const hexc = (h?: string) => (h ? new THREE.Color(parseInt(h, 16)) : undefined)
      const L = map?.light
      this.mapAir = {
        zenith: col(pal?.skyZenith), haze: col(pal?.skyHaze), mist: map?.mist,
        light: L ? { sun: hexc(L.sun), fill: hexc(L.fill), bounce: hexc(L.bounce), tint: hexc(L.tint), toon: L.toon, split: L.split, saturation: L.saturation } : undefined,
      }
    } else this.mapAir = null
    if (map?.aerial) {
      globalUniforms.uAerial.value.x = map.aerial[0]
      globalUniforms.uAerial.value.y = map.aerial[1]
      globalUniforms.uAerial.value.z = map.aerial[2]
    }
    this.aerialBase = globalUniforms.uAerial.value.z
    globalUniforms.uSurfaceDetail.value = 1
  }

  /** `focus`: the player's feet (biomes, mist height); `camPos`: the camera; `time`: seconds. */
  update(dt: number, focus: THREE.Vector3, cam: pc.Entity, time: number): void {
    const tod = this.tod
    if (this.ownsClock) tod.update(dt)
    const bw = this.fields.biome(focus.x, focus.z, this.bw, focus.y)
    const rw = this.fields.region(focus.x, focus.z, this.rw, focus.y)
    this.snowHere = Math.min(1, Math.max(0, (bw[1] - 0.22) / 0.2))
    applyBiomeAir(tod.current, bw[0], bw[1], rw[Biome.Autumn], rw[Biome.Mystic])
    if (this.mapAir) applyMapAir(tod.current, this.mapAir, dayWeight(tod.sunDir.y))
    if (this.ownsClock) this.weather.update(dt, tod.hours, tod.day)
    const tp = tod.current
    this.weather.apply(tp, globalUniforms.uWind.value)
    // fog: clear close, complete by the horizon; partial on land (fogMax / landHaze), the rim dissolves into the sky
    const far = Math.min(tp.fogEnd, this.horizon)
    const near = Math.min(tp.fogStart, far * 0.55)
    const cave = this.cave
    this.lighting.update(tod, near + (4 - near) * cave, far + (75 - far) * cave, cave)
    const u = globalUniforms
    u.uWet.value = this.weather.wet * (1 - bw[0]) * (1 - bw[1])
    u.uFogMax.value = tp.fogMax + (1 - tp.fogMax) * cave
    u.uLandHaze.value.copy(tp.landHaze)
    u.uAerial.value.z = this.aerialBase * (1 - cave)
    u.uFarEdge.value.set(this.horizon * 0.7, this.horizon * 0.96)
    u.uToon.value = tp.toon * this.look.toonK
    u.uTime.value = time
    const cp = cam.getPosition()
    u.uCameraPos.value.set(cp.x, cp.y, cp.z)
    u.uPlayerPos.value.copy(focus)
    u.uKeyColor.value.copy(this.lighting.keyColor)
    skyUniforms.uSkyMist.value.set(tp.mistDensity * (1 - 0.35 * bw[0]) * (1 - cave), tp.mistBase, tp.mistFalloff, cp.y)
    this.sky.update(tod, cam, time)
    // grading (CameraFrame): exposure goes in the scene (PcLighting), the rest here
    const g = this.frame.grading
    g.saturation = tp.saturation
    g.contrast = tp.contrast
    g.tint = this.tint.set(tp.tint.r, tp.tint.g, tp.tint.b, 1)
    this.frame.vignette.intensity = tp.vignette
    this.frame.update()
    // the shared uniforms → the device scope (every shader reads them by name)
    const dev = this.app.graphicsDevice
    pushUniforms(dev, skyUniforms)
    pushUniforms(dev, globalUniforms)
    const sc = dev.scope
    sc.resolve('uCamPos').setValue([cp.x, cp.y, cp.z])
    const k = this.lighting.keyDir
    sc.resolve('uKeyDirW').setValue([k.x, k.y, k.z])
    const hs = this.lighting.hemiSky, hg = this.lighting.hemiGround
    // LOW LIGHT, the soft look (2026-10-25, "at evening not good", "too sharp"): a low sun or moon lays long shadows
    // over most of the ground and its shade went near black beside the lit strips — as the key nears the horizon the
    // cast shadow lightens (up to 40 %) and the sky fill rises (up to 60 %): evening shade is full of sky light
    // (2026-10-26: the 16:00 evening's sun stands ~25° — the band reached it only half; its shaded slopes still black-green)
    const lo = this.look.soft ? 1 - THREE.MathUtils.smoothstep(k.y, 0.1, 0.6) : 0
    this.lighting.key.light!.shadowIntensity = this.look.shadowK * (1 - 0.45 * lo)
    const fk = this.look.fillK * (1 + 0.9 * lo)
    sc.resolve('uHemiSky').setValue([hs.r * fk, hs.g * fk, hs.b * fk])
    // (the soft look: the ground BOUNCE is at least a share of the sky fill — sides and undersides in shade read)
    const bk = this.look.bounceK
    sc.resolve('uHemiGround').setValue([Math.max(hg.r * fk, (hs.r + hs.g + hs.b) / 3 * fk * bk * hg.r / Math.max(1e-3, (hg.r + hg.g + hg.b) / 3)), Math.max(hg.g * fk, (hs.r + hs.g + hs.b) / 3 * fk * bk * hg.g / Math.max(1e-3, (hg.r + hg.g + hg.b) / 3)), Math.max(hg.b * fk, (hs.r + hs.g + hs.b) / 3 * fk * bk * hg.b / Math.max(1e-3, (hg.r + hg.g + hg.b) / 3))])
  }
}
