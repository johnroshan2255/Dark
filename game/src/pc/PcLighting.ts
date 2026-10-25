import * as pc from 'playcanvas'
import * as THREE from 'three'
import type { TimeOfDay } from '../rendering/lighting/TimeOfDay'

/**
 * LIGHTING on PlayCanvas, driven by the game's TimeOfDay (engine-free), as the three build's LightingSystem:
 *  - ONE directional KEY light with the engine's cascaded shadows (its cascades follow the camera — no shadow-follow
 *    code), handed over between the sun and the moon at the horizon where both are ~0 (the light set — part of every
 *    shader's key — never changes);
 *  - the HEMISPHERE fill (sky above, ground bounce below) — PlayCanvas has no hemisphere light: the world materials'
 *    ambient chunk (materials/common.ts HEMI_AMBIENT_PS) blends uHemiSky / uHemiGround by the normal; scene.ambientLight holds their
 *    average for any plain engine material;
 *  - the engine's FOG distances (linear: fog_start / fog_end — the colour comes from the sky, materials/common.ts) and
 *    EXPOSURE.
 * PlayCanvas takes light colours in sRGB (TimeOfDay's are linear) and its lights carry no 1/π (three's Lambert BRDF
 * does): converted here. The shared uniforms (uKeyDirW, uKeyColor, uToon) are set into globalUniforms-style values
 * the caller pushes with the rest.
 */
export class PcLighting {
  readonly key: pc.Entity
  /** Direction TO the key light (world) and its strength 0..1 (sun / moon above the horizon). */
  readonly keyDir = new THREE.Vector3(0, 1, 0)
  keyStrength = 0
  /** Linear key colour × three-style intensity (the rim / translucency / sheen terms use it). */
  readonly keyColor = new THREE.Color()
  readonly hemiSky = new THREE.Color()
  readonly hemiGround = new THREE.Color()
  flash = 0
  /** The map's look (pc/look.ts): × the moon's strength, how far its colour is pulled to silver (0..1), and the sky
   *  fill's floor (linear, ÷ π — nights and dusks stay readable; the day's fill is far above it). */
  moonK = 1
  /** × the time of day's exposure (the soft look: high-key, as theirs) */
  exposureK = 1
  moonSilver = 0
  readonly fillFloor = new THREE.Color(0, 0, 0)
  readonly flashColor = new THREE.Color(1, 0.4, 0.5)
  private readonly tmp = new THREE.Color()
  private readonly tmp2 = new THREE.Color()
  private readonly q = new pc.Quat()
  private readonly up = new pc.Vec3(0, 1, 0)
  private readonly d = new pc.Vec3()
  private readonly ax = new pc.Vec3()

  constructor(private readonly app: pc.AppBase, shadowDistance = 90, shadowResolution = 2048) {
    this.key = new pc.Entity('keyLight')
    this.key.addComponent('light', {
      type: 'directional',
      castShadows: true,
      shadowDistance,
      numCascades: 2,
      cascadeDistribution: 0.6,
      shadowResolution,
      shadowBias: 0.25,
      normalOffsetBias: 0.06,
      shadowType: pc.SHADOW_PCF3_32F,
    })
    app.root.addChild(this.key)
    app.scene.fog.type = pc.FOG_LINEAR
  }

  private toSrgb(c: THREE.Color): pc.Color {
    this.tmp.copy(c).convertLinearToSRGB()
    return new pc.Color(this.tmp.r, this.tmp.g, this.tmp.b, 1)
  }

  /** The light's +Y onto `dir` (PlayCanvas directional lights shine down their −Y): it shines FROM `dir`. */
  private aim(dir: THREE.Vector3): void {
    this.d.set(dir.x, dir.y, dir.z).normalize()
    const dot = this.up.dot(this.d)
    if (dot < -0.9999) this.q.setFromAxisAngle(pc.Vec3.RIGHT, 180)
    else {
      this.ax.cross(this.up, this.d)
      this.q.set(this.ax.x, this.ax.y, this.ax.z, 1 + dot).normalize()
    }
    this.key.setRotation(this.q)
  }

  /**
   * CACHED SUN SHADOWS (2026-10-25: "use images for shadows" — the real-time pass cost a third of every frame and
   * stalled 0.2–0.5 s whenever ANGLE met a new caster): the cascades are an IMAGE rendered only when it no longer
   * fits — the near cascade when the camera moved ~4 m / turned ~8°, the far one at 3× that, both when the sun moved
   * 0.4° or the world's meshes changed (`worldStamp`: chunks built / LOD switched). Every other frame samples the
   * stored image with its stored matrices (the engine skips the cull and render: SHADOWUPDATE_NONE). Moving things
   * (cars, people) don't cast into it — they keep their blob shadows (PcGame). `cached` false: real-time.
   */
  cached = true
  private readonly sPos = [new pc.Vec3(1e9, 0, 0), new pc.Vec3(1e9, 0, 0)]
  private readonly sFwd = [new pc.Vec3(), new pc.Vec3()]
  private readonly sSun = new pc.Vec3()
  private sStamp = -1
  /** the next updateShadowCache re-renders every cascade */
  invalidateShadows(): void {
    this.sStamp = -2
  }
  updateShadowCache(camPos: pc.Vec3, camFwd: pc.Vec3, worldStamp: number): void {
    const L = this.key.light!
    if (!this.cached || !L.castShadows) {
      if (L.shadowUpdateMode !== pc.SHADOWUPDATE_REALTIME) L.shadowUpdateMode = pc.SHADOWUPDATE_REALTIME
      L.shadowUpdateOverrides = null
      return
    }
    const sun = this.d.set(this.keyDir.x, this.keyDir.y, this.keyDir.z)
    const all = worldStamp !== this.sStamp || sun.dot(this.sSun) < Math.cos((0.4 * Math.PI) / 180)
    const n = L.numCascades
    const over: number[] = []
    let any = false
    for (let c = 0; c < n; c++) {
      const k = c === 0 ? 1 : 3 // (the far cascade's texels are coarser: it tolerates more)
      const moved = camPos.distance(this.sPos[c]) > 4 * k || camFwd.dot(this.sFwd[c]) < Math.cos((8 * k * Math.PI) / 180)
      const up = all || moved
      over.push(up ? pc.SHADOWUPDATE_THISFRAME : pc.SHADOWUPDATE_NONE)
      if (up) {
        any = true
        this.sPos[c].copy(camPos)
        this.sFwd[c].copy(camFwd)
      }
    }
    if (!any) {
      L.shadowUpdateMode = pc.SHADOWUPDATE_NONE
      return
    }
    this.sStamp = worldStamp
    this.sSun.copy(sun)
    L.shadowUpdateOverrides = over
    L.shadowUpdateMode = pc.SHADOWUPDATE_THISFRAME
  }

  /** `cave` 0..1: how deep in a cave (the sky fill gives way to a dim cool cave fill). */
  update(tod: TimeOfDay, fogNear: number, fogFar: number, cave = 0): void {
    const p = tod.current
    const sunK = THREE.MathUtils.smoothstep(tod.sunDir.y, -0.02, 0.12)
    const moonK = THREE.MathUtils.smoothstep(tod.moonDir.y, -0.02, 0.15)
    const useSun = tod.sunDir.y > -0.02
    this.keyDir.copy(useSun ? tod.sunDir : tod.moonDir)
    this.keyStrength = useSun ? sunK : moonK
    const col = useSun ? p.sunColor : this.tmp2.copy(p.moonColor).lerp(SILVER, this.moonSilver)
    const intensity = (useSun ? p.sunIntensity * sunK : p.moonIntensity * moonK * this.moonK) * (1 - cave)
    this.aim(this.keyDir)
    const L = this.key.light!
    L.color = this.toSrgb(col)
    L.intensity = intensity / Math.PI
    this.keyColor.copy(col).multiplyScalar(Math.min(intensity, 3) * 0.35)
    // hemisphere fill (× its intensity, + the lightning burst), linear, ÷ π
    const hi = ((p.hemiIntensity + this.flash * 2.2) * (1 - cave) + cave) / Math.PI
    this.hemiSky.copy(p.hemiSky).lerp(CAVE_SKY, cave).multiplyScalar(hi)
    const ff = 1 - cave
    this.hemiSky.setRGB(Math.max(this.hemiSky.r, this.fillFloor.r * ff), Math.max(this.hemiSky.g, this.fillFloor.g * ff), Math.max(this.hemiSky.b, this.fillFloor.b * ff))
    if (this.flash > 0) this.hemiSky.lerp(this.tmp.copy(this.flashColor).multiplyScalar(hi), this.flash * 0.5)
    this.hemiGround.copy(p.hemiGround).lerp(CAVE_GROUND, cave).multiplyScalar(hi)
    this.app.scene.ambientLight = this.toSrgb(this.tmp.copy(this.hemiSky).lerp(this.hemiGround, 0.35))
    const fog = this.app.scene.fog
    fog.start = fogNear
    fog.end = fogFar
    this.app.scene.exposure = p.exposure * this.exposureK * (1 + 0.55 * cave)
  }
}

const CAVE_SKY = new THREE.Color(0x7aa0d8)
/** the soft look's moonlight hue (linear): a silvery blue */
const SILVER = new THREE.Color(0.62, 0.7, 0.95)
const CAVE_GROUND = new THREE.Color(0x0a0f18)
