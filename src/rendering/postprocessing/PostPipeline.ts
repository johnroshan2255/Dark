import * as THREE from 'three'
import type { LightingParams } from '../lighting/TimeOfDay'
import { createGodRaysMaterial, GOD_RAYS_MAX_SAMPLES, VOLUME_MAX_STEPS } from './GodRaysShader'
import { createGradingMaterial } from './GradingShader'
import { createBloomMaterials, createPaintMaterial } from './PaintShader'

export type AAMode = 'off' | 'fxaa' | 'msaa2' | 'msaa4'

/** Light colour × intensity (linear) — shafts scale with how bright the key light actually is. */
const _c = new THREE.Color()
function color(light: THREE.DirectionalLight): THREE.Color {
  return _c.copy(light.color).multiplyScalar(Math.min(light.intensity, 3) / 2.5)
}

/**
 * scene → HalfFloat RT (+ depth texture, optional MSAA) at renderScale × drawing buffer
 *       → god rays (depth → 1/4..1/6-res RT, only when the key light is roughly in view)
 *       → grading pass (FXAA/sharpen, rays, grade, tonemap) → canvas.
 * Cost: 1 scene render + 1 tiny pass + 1 fullscreen triangle. See skills/postprocessing.
 *
 * Memory at 1920×1080, scale 1: colour RGBA16F 16.6 MB + depth 8.3 MB; MSAA×4 adds ~66 MB of
 * renderbuffers — which is why phones use FXAA instead.
 */
export class PostPipeline {
  readonly target: THREE.WebGLRenderTarget
  readonly material = createGradingMaterial()
  readonly raysMaterial = createGodRaysMaterial()
  readonly raysTarget: THREE.WebGLRenderTarget
  private readonly quad: THREE.Mesh
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  renderScale = 1
  /** Max scene-RT pixels (tier). Caps cost on hi-DPI/4K displays regardless of DPR. */
  pixelBudget = 2.4e6
  aa: AAMode = 'fxaa'
  /** Multiplier on the phase's film grain (0 = off). */
  grainScale = 1
  /** False when the GPU can't render to half-float (some mobile drivers) → 8-bit fallback. */
  hdr = true
  /** God-ray resolution divisor and sample count (per tier); samples 0 = off. */
  raysDivisor = 4
  raysSamples = 24
  /** Volumetric shaft march steps (0 = off). */
  volumeSteps = 16
  private raysActive = false
  /** Painterly (Kuwahara) filter brush stride in pixels; 0 = off. */
  paintStride = 1.5
  /** Bloom strength; 0 = off. */
  bloom = 0.6
  readonly paintMaterial = createPaintMaterial()
  readonly paintTarget: THREE.WebGLRenderTarget
  private readonly bloomMats = createBloomMaterials()
  private readonly bloomA: THREE.WebGLRenderTarget
  private readonly bloomB: THREE.WebGLRenderTarget
  private width = 1
  private height = 1
  private maxSamples = 4
  private readonly tmp = new THREE.Vector3()
  /**
   * 1×1 comparison depth texture bound to the shafts shader's sampler2DShadow whenever the key light has
   * no shadow map yet (first frames, tier/setting changes). An unbound or non-depth texture on a shadow
   * sampler makes WebGL reject the draw (GL_INVALID_OPERATION: sampler type mismatch).
   */
  private readonly dummyShadow: THREE.WebGLRenderTarget

  constructor() {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 0,
      depthBuffer: true,
      stencilBuffer: false,
    })
    this.target.texture.name = 'SceneRT'
    this.target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType)
    this.raysTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, depthBuffer: false })
    this.raysTarget.texture.name = 'GodRaysRT'
    this.paintTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
    this.paintTarget.texture.name = 'PaintRT'
    this.bloomA = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
    this.bloomB = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
    this.paintMaterial.uniforms.tScene.value = this.target.texture
    // Fullscreen triangle (3 verts) instead of a quad — avoids the diagonal seam's helper-lane waste.
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
    this.quad = new THREE.Mesh(g, this.material)
    this.quad.frustumCulled = false
    this.material.uniforms.tScene.value = this.target.texture
    this.material.uniforms.tRays.value = this.raysTarget.texture
    this.raysMaterial.uniforms.tDepth.value = this.target.depthTexture
    this.dummyShadow = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true })
    this.dummyShadow.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType)
    this.dummyShadow.depthTexture.compareFunction = THREE.LessEqualCompare
    this.raysMaterial.uniforms.tShadow.value = this.dummyShadow.depthTexture
    this.material.uniforms.tDepth.value = this.target.depthTexture
  }

  /** Pick the render-target format the device can actually render to. Call once after renderer creation. */
  configure(renderer: THREE.WebGLRenderer): void {
    const ext = renderer.extensions
    this.hdr = ext.has('EXT_color_buffer_half_float') || ext.has('EXT_color_buffer_float')
    const type = this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType
    for (const rt of [this.target, this.paintTarget, this.bloomA, this.bloomB]) {
      if (rt.texture.type !== type) {
        rt.texture.type = type
        rt.dispose()
      }
    }
    this.maxSamples = renderer.capabilities.maxSamples
    // Allocate the dummy depth texture on the GPU once.
    renderer.setRenderTarget(this.dummyShadow)
    renderer.clear()
    renderer.setRenderTarget(null)
    this.setAA(this.aa)
  }

  /** MSAA modes set RT samples (FXAA off); FXAA/off use a non-multisampled RT. */
  setAA(mode: AAMode): void {
    this.aa = mode
    const samples = mode === 'msaa4' ? 4 : mode === 'msaa2' ? 2 : 0
    const n = Math.min(samples, this.maxSamples)
    if (n !== this.target.samples) {
      this.target.samples = n
      this.target.dispose()
    }
    this.material.uniforms.uFxaa.value = mode === 'fxaa' ? 1 : 0
  }

  setSharpness(v: number): void {
    this.material.uniforms.uSharpen.value = THREE.MathUtils.clamp(v, 0, 1)
  }

  setGodRays(divisor: number, samples: number, volumeSteps: number): void {
    this.raysDivisor = Math.max(1, divisor)
    this.raysSamples = Math.min(GOD_RAYS_MAX_SAMPLES, Math.max(0, samples))
    this.raysMaterial.uniforms.uSamples.value = Math.max(1, this.raysSamples)
    this.volumeSteps = Math.min(VOLUME_MAX_STEPS, Math.max(0, volumeSteps))
    this.raysMaterial.uniforms.uSteps.value = Math.max(1, this.volumeSteps)
    this.applySize()
  }

  /** width/height are drawing-buffer pixels (CSS size × DPR). */
  setSize(width: number, height: number): void {
    this.width = width
    this.height = height
    this.applySize()
  }

  setPixelBudget(px: number): void {
    this.pixelBudget = px
    this.applySize()
  }

  setRenderScale(s: number): void {
    this.renderScale = THREE.MathUtils.clamp(Math.round(s * 100) / 100, 0.4, 1)
    this.applySize()
  }

  private applySize(): void {
    let sc = this.renderScale
    const px = this.width * this.height * sc * sc
    if (px > this.pixelBudget) sc *= Math.sqrt(this.pixelBudget / px)
    const w = Math.max(1, Math.round(this.width * sc))
    const h = Math.max(1, Math.round(this.height * sc))
    this.target.setSize(w, h)
    const rw = Math.max(1, Math.round(w / this.raysDivisor))
    const rh = Math.max(1, Math.round(h / this.raysDivisor))
    this.raysTarget.setSize(rw, rh)
    ;(this.material.uniforms.uRaysTexel.value as THREE.Vector2).set(1 / rw, 1 / rh)
    ;(this.material.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h)
    this.paintTarget.setSize(w, h)
    ;(this.paintMaterial.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h)
    const bw = Math.max(1, Math.round(w / 4))
    const bh = Math.max(1, Math.round(h / 4))
    this.bloomA.setSize(bw, bh)
    this.bloomB.setSize(bw, bh)
    ;(this.bloomMats.bright.uniforms.uTexel.value as THREE.Vector2).set(1.5 / w, 1.5 / h)
    this.bloomTexel.set(1 / bw, 1 / bh)
    this.material.uniforms.uAspect.value = w / h
    this.raysMaterial.uniforms.uAspect.value = w / h
  }

  get targetSize(): string {
    return `${this.target.width}×${this.target.height}`
  }

  /** Lightning flash 0..1 and damage vignette 0..1 (set each frame by Game). */
  flash = 0
  damage = 0

  applyGrading(p: LightingParams, time: number): void {
    const u = this.material.uniforms
    u.uFlash.value = this.flash
    u.uDamage.value = this.damage
    u.uExposure.value = p.exposure
    ;(u.uTint.value as THREE.Color).copy(p.tint)
    ;(u.uLift.value as THREE.Color).copy(p.lift)
    u.uSaturation.value = p.saturation
    u.uContrast.value = p.contrast
    u.uVignette.value = p.vignette
    u.uGrain.value = p.grain * this.grainScale
    u.uDistortion.value = p.distortion
    u.uSplit.value = p.split
    u.uTime.value = time
  }

  /**
   * Project the key light to screen space; skip the pass entirely when it's behind the camera
   * or far off-screen (most of the time at night / looking away → zero cost).
   */
  /**
   * @param light the key directional light (sun or moon) — its shadow map drives volumetric shafts
   * @param radialStrength screen-space glare strength   @param volStrength volumetric in-scatter strength
   * @param maxDist volumetric march range (≈ shadow frustum half-extent)
   * Skips the whole pass when neither effect contributes (zero cost at moonless night / tier off).
   */
  updateGodRays(
    camera: THREE.PerspectiveCamera,
    light: THREE.DirectionalLight,
    lightDir: THREE.Vector3,
    radialStrength: number,
    volStrength: number,
    fogNear: number,
    fogFar: number,
    maxDist: number,
  ): void {
    const p = this.tmp.copy(camera.position).addScaledVector(lightDir, 1000).project(camera)
    const px = p.x
    const py = p.y
    const facing = camera.getWorldDirection(this.tmp).dot(lightDir)
    const inFront = facing > 0
    const u = this.raysMaterial.uniforms
    ;(u.uLightUv.value as THREE.Vector2).set((inFront ? THREE.MathUtils.clamp(px, -4, 4) : 0) * 0.5 + 0.5, (inFront ? THREE.MathUtils.clamp(py, -4, 4) : 0) * 0.5 + 0.5)
    ;(u.uLightDir.value as THREE.Vector3).copy(lightDir)
    ;(u.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse)
    ;(u.uCamWorld.value as THREE.Matrix4).copy(camera.matrixWorld)
    u.uNear.value = camera.near
    u.uFar.value = camera.far
    ;(u.uFog.value as THREE.Vector2).set(fogNear, fogFar)
    u.uMaxDist.value = maxDist
    const g = this.material.uniforms
    g.uNear.value = camera.near
    g.uFar.value = camera.far
    ;(g.uFog.value as THREE.Vector2).set(fogNear, fogFar)

    const radial = this.raysSamples > 0 ? THREE.MathUtils.smoothstep(facing, 0.05, 0.55) * radialStrength : 0
    const map = light.castShadow ? light.shadow.map?.depthTexture ?? null : null
    const vol = this.volumeSteps > 0 && map ? volStrength : 0
    u.uRadial.value = radial > 0.01 ? 1 : 0
    u.uHasShadow.value = vol > 0.01 ? 1 : 0
    u.tShadow.value = map ?? this.dummyShadow.depthTexture
    if (map) (u.uShadowMatrix.value as THREE.Matrix4).copy(light.shadow.matrix)
    this.raysActive = radial > 0.01 || vol > 0.01
    ;(g.uRaysColor.value as THREE.Color).copy(color(light)).multiplyScalar(radial > 0.01 ? radial * 0.28 : 0)
    ;(g.uVolColor.value as THREE.Color).copy(color(light)).multiplyScalar(vol > 0.01 ? vol : 0)
  }


  private readonly bloomTexel = new THREE.Vector2(1, 1)

  setPaint(stride: number, bloom: number): void {
    this.paintStride = stride
    this.bloom = bloom
  }

  private pass(renderer: THREE.WebGLRenderer, mat: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = mat
    renderer.setRenderTarget(target)
    renderer.render(this.quad, this.quadCamera)
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    renderer.setRenderTarget(this.target)
    renderer.render(scene, camera)
    const g = this.material.uniforms
    // Painterly filter → the grading pass reads the painted image instead of the raw render.
    let src: THREE.Texture = this.target.texture
    if (this.paintStride > 0) {
      this.paintMaterial.uniforms.uStride.value = this.paintStride
      this.pass(renderer, this.paintMaterial, this.paintTarget)
      src = this.paintTarget.texture
    }
    g.tScene.value = src
    g.uPaintFx.value = this.paintStride > 0 ? 1 : 0
    g.uFxaa.value = this.paintStride > 0 ? 0 : this.aa === 'fxaa' ? 1 : 0 // the paint filter already smooths edges
    // Bloom: bright-pass at 1/4 res + separable blur.
    if (this.bloom > 0) {
      this.bloomMats.bright.uniforms.tSrc.value = src
      this.pass(renderer, this.bloomMats.bright, this.bloomA)
      const b = this.bloomMats.blur.uniforms
      b.tSrc.value = this.bloomA.texture
      ;(b.uDir.value as THREE.Vector2).set(this.bloomTexel.x, 0)
      this.pass(renderer, this.bloomMats.blur, this.bloomB)
      b.tSrc.value = this.bloomB.texture
      ;(b.uDir.value as THREE.Vector2).set(0, this.bloomTexel.y)
      this.pass(renderer, this.bloomMats.blur, this.bloomA)
    }
    g.tBloom.value = this.bloomA.texture
    g.uBloom.value = this.bloom
    if (this.raysActive) {
      this.quad.material = this.raysMaterial
      renderer.setRenderTarget(this.raysTarget)
      renderer.render(this.quad, this.quadCamera)
    }
    this.quad.material = this.material
    renderer.setRenderTarget(null)
    renderer.render(this.quad, this.quadCamera)
  }

  dispose(): void {
    this.target.depthTexture?.dispose()
    this.target.dispose()
    this.raysTarget.dispose()
    this.paintTarget.dispose()
    this.bloomA.dispose()
    this.bloomB.dispose()
    this.paintMaterial.dispose()
    this.bloomMats.bright.dispose()
    this.bloomMats.blur.dispose()
    this.dummyShadow.depthTexture?.dispose()
    this.dummyShadow.dispose()
    this.material.dispose()
    this.raysMaterial.dispose()
    this.quad.geometry.dispose()
  }
}
