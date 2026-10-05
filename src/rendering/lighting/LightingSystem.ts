import * as THREE from 'three'
import type { QualitySettings } from '../quality/QualityTiers'
import { configureSunShadow, followShadow, SHADOW_LIGHT_DISTANCE } from '../shadows/ShadowFollow'
import type { TimeOfDay } from './TimeOfDay'
import { globalUniforms } from '../shaders/uniforms'

/**
 * Owns the fixed light set: sun/moon (1 shadow), hemisphere fill, flashlight (spot, 1 small shadow).
 * Light COUNT never changes at runtime — lights are dimmed, not removed — so shader programs
 * compiled at startup stay valid. See skills/lighting & skills/shadows.
 */
export class LightingSystem {
  readonly root = new THREE.Group()
  readonly sun = new THREE.DirectionalLight()
  readonly hemi = new THREE.HemisphereLight()
  readonly flashlight = new THREE.SpotLight(0xfff1d6, 0, 42, 0.42, 0.5, 1.6)
  flashlightOn = false // off by default (daylight); F toggles — in the truck F toggles the headlights instead
  /** What the spot light is doing THIS frame: the torch on foot, the headlights in the truck (set by Game). */
  spotOn = false
  flashlightIntensity = 90
  /** Lightning flash 0..1 and its colour (set by Game). */
  flash = 0
  readonly flashColor = new THREE.Color(1, 0.4, 0.5)
  private readonly sunDir = new THREE.Vector3()
  private flicker = 0
  private sunShadowEvery = 1
  private frame = 0

  constructor(private readonly tod: TimeOfDay) {
    this.root.name = 'lighting'
    configureSunShadow(this.sun, 36, 2048)
    this.flashlight.castShadow = true
    this.flashlight.shadow.mapSize.set(512, 512)
    this.flashlight.shadow.camera.near = 0.3
    this.flashlight.shadow.camera.far = 42
    this.flashlight.shadow.bias = -0.0008
    this.flashlight.shadow.normalBias = 0.03
    this.root.add(this.sun, this.sun.target, this.hemi, this.flashlight, this.flashlight.target)
  }

  /**
   * Tier settings. Shadow-map size changes free the old map; flashlight castShadow changes
   * recompile lit programs once (acceptable: only on tier switches, never per frame).
   */
  setQuality(q: Pick<QualitySettings, 'shadows' | 'sunShadowSize' | 'sunShadowEvery' | 'sunShadowExtent' | 'flashlightShadow'>): void {
    const s = this.sun.shadow
    // Shadows OFF: no sun shadow pass at all (one program recompile when toggled — settings changes only).
    if (this.sun.castShadow !== q.shadows) {
      this.sun.castShadow = q.shadows
      if (!q.shadows) {
        s.map?.dispose()
        s.map = null
      }
    }
    if (s.mapSize.x !== q.sunShadowSize || s.camera.right !== q.sunShadowExtent) {
      configureSunShadow(this.sun, q.sunShadowExtent, q.sunShadowSize)
      s.map?.dispose()
      s.map = null
    }
    // World casters are static → the sun map only needs re-rendering every N frames.
    this.sunShadowEvery = Math.max(1, q.sunShadowEvery)
    s.autoUpdate = this.sunShadowEvery === 1
    s.needsUpdate = true
    if (this.flashlight.castShadow !== q.flashlightShadow) {
      this.flashlight.castShadow = q.flashlightShadow
      if (!q.flashlightShadow) {
        this.flashlight.shadow.map?.dispose()
        this.flashlight.shadow.map = null
      }
    }
  }

  toggleFlashlight(): boolean {
    this.flashlightOn = !this.flashlightOn
    return this.flashlightOn
  }

  /** Direction towards the active key light (sun by day, moon by night) — read by god rays. */
  readonly keyDir = new THREE.Vector3(0, 1, 0)
  /** 0..1 how strongly the key body lights the scene (for god-ray strength). */
  keyStrength = 0

  /**
   * @param flashOrigin world position of the flashlight (eye in FPP, hand in TPP)
   * @param flashTarget world point it aims at
   */
  update(dt: number, focus: THREE.Vector3, flashOrigin: THREE.Vector3, flashTarget: THREE.Vector3): void {
    const tod = this.tod
    const p = tod.current
    // One directional light, handed over between sun and moon at the horizon, where both are ~0
    // (the direction flip is invisible and the light count never changes).
    const sunK = THREE.MathUtils.smoothstep(tod.sunDir.y, -0.02, 0.12)
    const moonK = THREE.MathUtils.smoothstep(tod.moonDir.y, -0.02, 0.15)
    const useSun = tod.sunDir.y > -0.02
    this.sunDir.copy(useSun ? tod.sunDir : tod.moonDir)
    this.keyDir.copy(this.sunDir)
    this.sun.color.copy(useSun ? p.sunColor : p.moonColor)
    this.sun.intensity = useSun ? p.sunIntensity * sunK : p.moonIntensity * moonK
    this.keyStrength = useSun ? sunK : moonK
    // Moonlight is a broad, dim source → softer shadow edges (PCF filter radius, no extra cost per texel).
    this.sun.shadow.radius = useSun ? 2 : 4
    followShadow(this.sun, focus, this.sunDir, SHADOW_LIGHT_DISTANCE)
    if (this.sunShadowEvery > 1 && ++this.frame % this.sunShadowEvery === 0) this.sun.shadow.needsUpdate = true

    globalUniforms.uToon.value = p.toon
    this.hemi.color.copy(p.hemiSky)
    this.hemi.groundColor.copy(p.hemiGround)
    // Lightning burst: extra sky fill in the bolt's colour for a few frames.
    this.hemi.intensity = p.hemiIntensity + this.flash * 2.2
    if (this.flash > 0.01) this.hemi.color.lerp(this.flashColor, Math.min(1, this.flash * 0.7))

    const f = this.flashlight
    f.position.copy(flashOrigin)
    // The aim follows the look with a short lag: touch-look jitter otherwise wobbles the pool over the grass.
    f.target.position.lerp(flashTarget, 1 - Math.exp(-dt * 14))
    this.flicker += dt
    const flick = 1 - 0.04 * Math.max(0, Math.sin(this.flicker * 37) * Math.sin(this.flicker * 11.3))
    // In daylight a flashlight barely registers — scale it down with the sun so the beam pool doesn't glow on a
    // sunny road; full strength at dusk/night/nightmare.
    const daylight = sunK * (1 - tod.nightmare)
    f.intensity = this.spotOn ? this.flashlightIntensity * flick * (1 - 0.85 * daylight) : 0
    // No shadow re-render while off; the shadow pass is the flashlight's main cost.
    f.shadow.autoUpdate = this.flashlightOn && f.castShadow
    // But a castShadow light MUST have a map: shaders compiled with NUM_SPOT_LIGHT_SHADOWS sample it,
    // and a missing depth texture makes WebGL reject every lit draw (GL_INVALID_OPERATION → fog-only frame).
    if (f.castShadow && !f.shadow.map) f.shadow.needsUpdate = true
    if (this.sun.castShadow && !this.sun.shadow.map) this.sun.shadow.needsUpdate = true
    f.updateMatrixWorld()
    f.target.updateMatrixWorld()
  }
}
