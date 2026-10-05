import * as THREE from 'three'

/**
 * PLANAR REFLECTION for the water plane (lakes, rivers, frozen lakes): the scene rendered once more from the
 * camera mirrored about y = level into a small HalfFloat target, then sampled by the water shader with
 * projective coordinates (+ the ripple normal as distortion) — trees, mountains, the sky with its clouds and
 * the sun all show in the lakes. Mirrors three's Reflector (oblique near plane → nothing below the surface
 * leaks into the image; no shader variants, no clipping planes).
 *
 * Budget (QualitySettings.reflections = target scale per axis, 0 = off): HIGH only (0.5 → ¼ of the pixels).
 * It renders only on frames where water is in view (`active`, from the visible shore chunks); the grass,
 * particles, the water itself and debug helpers are hidden for the pass and the shadow maps are reused (not
 * re-rendered). Cost measured with the F3 HUD / npm run shot — see skills/art-direction.
 */
/**
 * Layer of objects drawn by the main camera but NOT in the reflection (undergrowth, small rocks, crops, poles,
 * fences): invisible at reflection resolution, yet ~40 % of its draws. The main camera enables it (Game.attach).
 */
export const LAYER_NO_REFLECT = 2
/** Layer drawn ONLY in the reflection: near chunks show their merged far-LOD trees there (WorldChunk.setLod). */
export const LAYER_REFLECT_ONLY = 3

export class PlanarReflection {
  readonly target: THREE.WebGLRenderTarget
  /** World → reflection-texture projective matrix (shared with the water shader's uniform). */
  readonly textureMatrix = new THREE.Matrix4()
  private readonly cam = new THREE.PerspectiveCamera()
  private readonly plane = new THREE.Plane()
  private readonly clip = new THREE.Vector4()
  private readonly q = new THREE.Vector4()
  private readonly v = new THREE.Vector3()
  private readonly look = new THREE.Vector3()
  private readonly rot = new THREE.Matrix4()
  private readonly normal = new THREE.Vector3(0, 1, 0)
  private readonly size = new THREE.Vector2()
  /** Objects hidden while rendering the reflection. */
  readonly hide: THREE.Object3D[] = []
  scale = 0
  /** Re-render every N frames (QualitySettings.reflectionEvery); the last texture + matrix are reused between. */
  every = 1
  private frame = 0
  /** Water is in view this frame (set by the caller). */
  active = false
  /** Did the last frame render a reflection (the water shader uses it only then). */
  valid = false

  constructor(private readonly level: number) {
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true })
    this.target.texture.name = 'waterReflection'
    this.target.texture.generateMipmaps = false
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    if (this.scale <= 0 || !this.active) {
      this.valid = false
      return
    }
    // Between refreshes keep showing the last reflection (a frame of lag on the 'low' level, at half the cost).
    if (this.valid && ++this.frame % this.every !== 0) return
    this.valid = false
    // Under (or right at) the surface the mirror is meaningless.
    if (camera.position.y <= this.level + 0.05) return
    renderer.getDrawingBufferSize(this.size)
    const w = Math.max(16, Math.round(this.size.x * this.scale)), h = Math.max(16, Math.round(this.size.y * this.scale))
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h)

    // Mirror the camera about the plane (proper rotation + reflected up, as three's Reflector).
    const cam = this.cam
    const cp = camera.position
    cam.position.set(cp.x, 2 * this.level - cp.y, cp.z)
    this.rot.extractRotation(camera.matrixWorld)
    this.look.set(0, 0, -1).applyMatrix4(this.rot).add(cp)
    this.look.y = 2 * this.level - this.look.y
    cam.up.set(0, 1, 0).applyMatrix4(this.rot).reflect(this.normal)
    cam.lookAt(this.look)
    cam.near = camera.near
    cam.far = camera.far
    cam.updateMatrixWorld()
    cam.projectionMatrix.copy(camera.projectionMatrix)
    cam.layers.mask = (camera.layers.mask & ~(1 << LAYER_NO_REFLECT)) | (1 << LAYER_REFLECT_ONLY)

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
    this.textureMatrix.multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse)

    // Oblique near plane = the water surface (Lengyel): geometry below it is clipped by the projection itself.
    this.plane.setFromNormalAndCoplanarPoint(this.normal, this.v.set(0, this.level, 0)).applyMatrix4(cam.matrixWorldInverse)
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant)
    const e = cam.projectionMatrix.elements
    this.q.set((Math.sign(this.clip.x) + e[8]) / e[0], (Math.sign(this.clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14])
    this.clip.multiplyScalar(2 / this.clip.dot(this.q))
    e[2] = this.clip.x
    e[6] = this.clip.y
    e[10] = this.clip.z + 1
    e[14] = this.clip.w

    const vis: boolean[] = []
    for (let i = 0; i < this.hide.length; i++) {
      vis.push(this.hide[i].visible)
      this.hide[i].visible = false
    }
    const shadowAuto = renderer.shadowMap.autoUpdate
    renderer.shadowMap.autoUpdate = false
    const prev = renderer.getRenderTarget()
    renderer.setRenderTarget(this.target)
    renderer.clear()
    renderer.render(scene, cam)
    renderer.setRenderTarget(prev)
    renderer.shadowMap.autoUpdate = shadowAuto
    for (let i = 0; i < this.hide.length; i++) this.hide[i].visible = vis[i]
    this.valid = true
  }

  dispose(): void {
    this.target.dispose()
  }
}
