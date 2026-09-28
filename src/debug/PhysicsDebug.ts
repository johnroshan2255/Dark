import * as THREE from 'three'
import type { PhysicsWorld } from '../physics/PhysicsWorld'

/**
 * Rapier collider wireframes via world.debugRender(). Expensive (copies every collider
 * edge from WASM each frame) — debug only. Buffers grow on demand, never shrink.
 */
export class PhysicsDebug {
  readonly object: THREE.LineSegments
  private capacity = 0

  constructor(private readonly physics: PhysicsWorld) {
    this.object = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, fog: false, depthTest: true }),
    )
    this.object.frustumCulled = false
    this.object.visible = false
    this.object.name = 'debug/physics'
  }

  set enabled(v: boolean) {
    this.object.visible = v
  }
  get enabled(): boolean {
    return this.object.visible
  }

  update(): void {
    if (!this.object.visible) return
    const { vertices, colors } = this.physics.world.debugRender()
    const count = vertices.length / 3
    const g = this.object.geometry
    if (count > this.capacity) {
      this.capacity = Math.ceil(count * 1.5)
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage))
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.capacity * 4), 4).setUsage(THREE.DynamicDrawUsage))
    }
    ;(g.attributes.position.array as Float32Array).set(vertices)
    ;(g.attributes.color.array as Float32Array).set(colors)
    g.attributes.position.needsUpdate = true
    g.attributes.color.needsUpdate = true
    g.setDrawRange(0, count)
  }

  dispose(): void {
    this.object.geometry.dispose()
    ;(this.object.material as THREE.Material).dispose()
  }
}
