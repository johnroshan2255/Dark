import * as THREE from 'three'

/**
 * Chunk-level frustum culling. One AABB test per loaded chunk per frame (~80 tests),
 * replacing thousands of per-object tests: children of a chunk have frustumCulled = false.
 *
 * Near chunks (ring ≤ 1) are always visible so that they keep casting sun shadows into
 * view even when behind the camera. See skills/culling.
 */
export interface Cullable {
  readonly bounds: THREE.Box3
  /** Chebyshev ring distance from the player's chunk. */
  ring: number
  setVisible(v: boolean): void
}

export class ChunkVisibility {
  private readonly frustum = new THREE.Frustum()
  private readonly projView = new THREE.Matrix4()
  visible = 0
  culled = 0

  /** Chunks whose nearest point is farther than this (m) are fully fogged → not drawn. */
  maxDistance = Infinity
  private readonly camPos = new THREE.Vector3()

  update(camera: THREE.Camera, chunks: Iterable<Cullable>): void {
    this.camPos.setFromMatrixPosition(camera.matrixWorld)
    camera.updateMatrixWorld()
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.projView)
    let v = 0
    let c = 0
    for (const chunk of chunks) {
      const vis = chunk.ring <= 1 || (chunk.bounds.distanceToPoint(this.camPos) < this.maxDistance && this.frustum.intersectsBox(chunk.bounds))
      chunk.setVisible(vis)
      if (vis) v++
      else c++
    }
    this.visible = v
    this.culled = c
  }
}
