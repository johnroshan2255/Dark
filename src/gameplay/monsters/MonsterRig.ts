import * as THREE from 'three'
import { stylize } from '../../rendering/shaders/stylize'

/**
 * Renders ALL monsters with 3 instanced draw calls (refer/monsters: black spindly silhouettes, red eyes):
 *   segments — tapered limb bones placed between two points (arms, legs, strider legs)
 *   blobs    — ellipsoids (torsos, heads)
 *   eyes     — HDR red emissive, fog-free → they pierce the fog and bloom
 * Systems call begin() each frame, add parts in world space, then end(). No per-monster objects.
 */
const MAX_SEGMENTS = 160
const MAX_BLOBS = 40
const MAX_EYES = 40

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _d = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)

export class MonsterRig {
  readonly root = new THREE.Group()
  private readonly segments: THREE.InstancedMesh
  private readonly blobs: THREE.InstancedMesh
  private readonly eyes: THREE.InstancedMesh
  private ns = 0
  private nb = 0
  private ne = 0
  readonly eyeMaterial: THREE.MeshBasicMaterial

  constructor() {
    this.root.name = 'monsters'
    const body = stylize(new THREE.MeshLambertMaterial({ color: new THREE.Color().setHex(0x120c10, THREE.SRGBColorSpace) }), { key: 'monster', rim: 2.2, fogAmount: 0.45 })
    const seg = new THREE.CylinderGeometry(0.55, 1, 1, 6, 1).translate(0, 0.5, 0) // along +Y from 0 to 1, thinner at the far end
    const blob = new THREE.IcosahedronGeometry(1, 1)
    const eye = new THREE.SphereGeometry(1, 8, 6)
    this.eyeMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.35, 0.2), fog: false })
    this.segments = this.make(seg, body, MAX_SEGMENTS, 'monster.segments')
    this.blobs = this.make(blob, body, MAX_BLOBS, 'monster.blobs')
    this.eyes = this.make(eye, this.eyeMaterial, MAX_EYES, 'monster.eyes')
    this.eyes.castShadow = false
  }

  private make(g: THREE.BufferGeometry, m: THREE.Material, n: number, name: string): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(g, m, n)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.castShadow = true
    mesh.name = name
    this.root.add(mesh)
    return mesh
  }

  set castShadow(v: boolean) {
    this.segments.castShadow = v
    this.blobs.castShadow = v
  }

  begin(): void {
    this.ns = this.nb = this.ne = 0
  }

  /** Limb from a to b with base radius r. */
  segment(a: THREE.Vector3, b: THREE.Vector3, r: number): void {
    if (this.ns >= MAX_SEGMENTS) return
    _d.subVectors(b, a)
    const len = _d.length()
    if (len < 1e-4) return
    _q.setFromUnitVectors(_up, _d.multiplyScalar(1 / len))
    _s.set(r, len, r)
    _m.compose(a, _q, _s)
    this.segments.setMatrixAt(this.ns++, _m)
  }

  blob(c: THREE.Vector3, sx: number, sy: number, sz: number, yaw: number, pitch = 0): void {
    if (this.nb >= MAX_BLOBS) return
    _q.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'))
    _s.set(sx, sy, sz)
    _m.compose(c, _q, _s)
    this.blobs.setMatrixAt(this.nb++, _m)
  }

  eye(c: THREE.Vector3, r: number): void {
    if (this.ne >= MAX_EYES) return
    _q.identity()
    _s.set(r, r, r)
    _m.compose(c, _q, _s)
    this.eyes.setMatrixAt(this.ne++, _m)
  }

  end(): void {
    for (const [mesh, n] of [[this.segments, this.ns], [this.blobs, this.nb], [this.eyes, this.ne]] as const) {
      mesh.count = n
      mesh.visible = n > 0
      if (n > 0) mesh.instanceMatrix.needsUpdate = true
    }
  }

  dispose(): void {
    for (const m of [this.segments, this.blobs, this.eyes]) {
      m.geometry.dispose()
      ;(m.material as THREE.Material).dispose()
      m.dispose()
    }
  }
}
