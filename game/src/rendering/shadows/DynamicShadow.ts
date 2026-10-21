import * as THREE from 'three'
import { globalUniforms } from '../shaders/uniforms'

/**
 * DYNAMIC SHADOWS for the moving things (car, character, bike, monsters) when the sun's shadow map is CACHED
 * (LightingSystem: the world's casters — terrain, trees, rocks — re-render only when the player has moved a quarter
 * of the map or the sun turned; a full shadow pass every frame was ~13–35 % of a HIGH / ULTRA frame).
 *
 * A small depth map (SIZE², ±EXTENT m round the player, texel-snapped) rendered EVERY frame from the sun with only
 * the meshes on DYN_LAYER (a few k tris). Receivers (stylize `treeShade` materials: ground, grass, rocks, cliffs)
 * read it with a 4-tap PCF and dim their direct light by it (stylize `stDynShadow`) — real, crisp shadows under the
 * truck and the player while the world's shadows stay cached. Cost: 1 depth pass of the dynamic meshes (~10 draws),
 * 4 texture taps per receiving fragment within EXTENT of the player, 4 MB.
 */
export const DYN_LAYER = 6
const SIZE = 1024
const EXTENT = 14
const DEPTH = 120

export class DynamicShadow {
  private readonly target: THREE.WebGLRenderTarget
  private readonly cam = new THREE.OrthographicCamera(-EXTENT, EXTENT, EXTENT, -EXTENT, 1, DEPTH)
  private readonly depthMat = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide })
  private readonly bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
  enabled = false

  constructor() {
    this.target = new THREE.WebGLRenderTarget(SIZE, SIZE, { depthBuffer: true, generateMipmaps: false })
    this.target.depthTexture = new THREE.DepthTexture(SIZE, SIZE, THREE.UnsignedIntType)
    this.target.depthTexture.minFilter = this.target.depthTexture.magFilter = THREE.NearestFilter
    this.cam.layers.set(DYN_LAYER)
    globalUniforms.uDynShadow.value = this.target.depthTexture
  }

  /**
   * Render the dynamic casters' depth from the key light (toward `sunDir`), centred on `focus`.
   * @param strength 0 = off this frame (night / cave): the receivers skip the lookup.
   * @param skip top-level subtrees with no dynamic casters (the streamed world): hidden for this pass and left out
   *   of its matrix update, so three neither re-updates nor projects every chunk, tree and prop to find ~18 meshes.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, focus: THREE.Vector3, sunDir: THREE.Vector3, strength: number, skip: readonly THREE.Object3D[] = []): void {
    const on = this.enabled && strength > 0.02
    globalUniforms.uDynShadowOn.value = on ? strength : 0
    if (!on) return
    // Light-space frame, the centre snapped to the texel grid (no shimmer as the player moves).
    const texel = (EXTENT * 2) / SIZE
    const f = _f.copy(sunDir).negate().normalize()
    const r = _r.crossVectors(f, Math.abs(f.y) > 0.99 ? _x : _y).normalize()
    const u = _u.crossVectors(r, f)
    const sr = Math.round(focus.dot(r) / texel) * texel, su = Math.round(focus.dot(u) / texel) * texel, sf = focus.dot(f)
    const c = _c.copy(r).multiplyScalar(sr).addScaledVector(u, su).addScaledVector(f, sf)
    this.cam.position.copy(c).addScaledVector(f, -DEPTH * 0.5)
    this.cam.up.copy(u)
    this.cam.lookAt(c)
    this.cam.updateMatrixWorld()
    globalUniforms.uDynShadowMat.value.multiplyMatrices(this.bias, this.cam.projectionMatrix).multiply(this.cam.matrixWorldInverse)
    const prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear, prevOverride = scene.overrideMaterial
    const prevShadow = renderer.shadowMap.autoUpdate
    renderer.shadowMap.autoUpdate = false
    renderer.autoClear = false
    renderer.setRenderTarget(this.target)
    renderer.clear(false, true, false)
    scene.overrideMaterial = this.depthMat
    for (let k = 0; k < skip.length; k++) (_vis[k] = skip[k].visible), (skip[k].visible = false)
    // render() would also re-run scene.updateMatrixWorld() over the WHOLE graph (visible or not): update only the
    // subtrees drawn here; the main pass updates the rest this frame anyway.
    const prevMW = scene.matrixWorldAutoUpdate
    scene.matrixWorldAutoUpdate = false
    for (const c of scene.children) if (!skip.includes(c)) c.updateMatrixWorld()
    renderer.render(scene, this.cam)
    scene.matrixWorldAutoUpdate = prevMW
    for (let k = 0; k < skip.length; k++) skip[k].visible = _vis[k]
    scene.overrideMaterial = prevOverride
    renderer.setRenderTarget(prevRT)
    renderer.autoClear = prevAuto
    renderer.shadowMap.autoUpdate = prevShadow
  }

  dispose(): void {
    this.target.depthTexture?.dispose()
    this.target.dispose()
    this.depthMat.dispose()
    globalUniforms.uDynShadow.value = null
    globalUniforms.uDynShadowOn.value = 0
  }
}

/** Put the meshes of a dynamic object on (or off) the dynamic-shadow layer: opaque meshes only (no lamp quads). */
export function dynamicCaster(root: THREE.Object3D, on: boolean): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material
    // small parts (pedals, wipers, dials, gear lever: < 0.45 m across) add a draw each and no visible shadow
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere()
    const big = (m.geometry.boundingSphere?.radius ?? 1) * Math.max(m.scale.x, m.scale.y, m.scale.z) > 0.45
    if (on && big && !mat.transparent && mat.blending === THREE.NormalBlending) m.layers.enable(DYN_LAYER)
    else m.layers.disable(DYN_LAYER)
  })
}

const _vis: boolean[] = []
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _c = new THREE.Vector3()
const _x = new THREE.Vector3(1, 0, 0), _y = new THREE.Vector3(0, 1, 0)
