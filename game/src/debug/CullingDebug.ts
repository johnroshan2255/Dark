import * as THREE from 'three'

/**
 * "Freeze culling": snapshot the camera used for visibility so you can walk/look away
 * and see exactly which chunks the frozen frustum keeps (pair with ChunkDebug, F4).
 */
export class CullingDebug {
  readonly frozenCamera = new THREE.PerspectiveCamera()
  readonly helper: THREE.CameraHelper
  frozen = false

  constructor() {
    this.helper = new THREE.CameraHelper(this.frozenCamera)
    this.helper.visible = false
    this.helper.name = 'debug/frozen-frustum'
  }

  toggle(camera: THREE.PerspectiveCamera): boolean {
    this.frozen = !this.frozen
    if (this.frozen) {
      this.frozenCamera.copy(camera)
      // Shorter far plane so the helper stays readable.
      this.frozenCamera.far = Math.min(camera.far, 260)
      this.frozenCamera.updateProjectionMatrix()
      this.frozenCamera.updateMatrixWorld(true)
      this.helper.update()
    }
    this.helper.visible = this.frozen
    return this.frozen
  }

  /** The camera the culling system should test against this frame. */
  cullCamera(camera: THREE.Camera): THREE.Camera {
    return this.frozen ? this.frozenCamera : camera
  }
}
