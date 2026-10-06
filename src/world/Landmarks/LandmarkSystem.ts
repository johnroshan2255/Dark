import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type RAPIER from '@dimforge/rapier3d-compat'
import { group, Groups, type PhysicsWorld } from '../../physics/PhysicsWorld'
import { createLandmarkGeometries, type LandmarkGeometries } from './landmarkGeometry'
import { LandmarkKind, type Landmark, type LandmarkField } from './landmarks'

/**
 * Renders the LANDMARKS (landmarks.ts) independently of the chunk ring, out to the tier's landmark distance
 * (≈ 0.45 × the horizon size: ~1.1 km on LOW … ~2.5 km on ULTRA) — they are what you see on the skyline and
 * travel toward.
 *
 * Cost: ≤ THREE draw calls (+1 per near windmill rotor): landmarks within the shadow range are baked into one
 * merged mesh that casts shadows, those to 350 m into a full-detail one, the rest into one of the FAR LOD
 * (≈ half the triangles) — all on `materials.landmark`. Range per tier: `QualitySettings.landmarkRange`. The merge is redone only when the visible set changes (crossing ~100 m, a few ms on a worker-
 * free main thread, measured below 3 ms for 20 landmarks). Physics: fixed cylinder colliders for landmarks within
 * 160 m (created / removed as you move). Memory: ~1–2 MB of merged vertex data on HIGH.
 */
const COLLIDE_IN = 160
const COLLIDE_OUT = 220
/** Past this distance landmarks use the far LOD (≈ half the triangles, no small parts, no windmill rotor). */
const FAR_LOD = 350

export class LandmarkSystem {
  readonly group = new THREE.Group()
  private readonly geos: LandmarkGeometries
  private readonly meshes: THREE.Mesh[] = []
  private range = 0
  private readonly rotors: THREE.Mesh[] = []
  private key = ''
  private lastX = Number.NaN
  private lastZ = Number.NaN
  private readonly bodies = new Map<Landmark, RAPIER.RigidBody>()
  /** Landmarks currently drawn (HUD compass reads them). */
  visible: Landmark[] = []
  private readonly m = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly up = new THREE.Vector3(0, 1, 0)

  constructor(
    private readonly field: LandmarkField,
    private readonly material: THREE.Material,
    private readonly physics: PhysicsWorld,
  ) {
    this.geos = createLandmarkGeometries()
    this.group.name = 'landmarks'
  }

  /**
   * @param range draw distance (m) — the tier's `landmarkRange` (700 m LOW … 2.2 km ULTRA)
   * @param shadowRange landmarks closer than this cast shadows
   */
  update(dt: number, x: number, z: number, range: number, shadowRange: number, shadows: boolean): void {
    for (const r of this.rotors) r.rotateZ(-dt * 0.9)
    if (Math.hypot(x - this.lastX, z - this.lastZ) < 60 && range === this.range) return
    this.lastX = x
    this.lastZ = z
    this.range = range
    const all = this.field.inBox(x - range, z - range, x + range, z + range).filter((l) => Math.hypot(l.x - x, l.z - z) < range)
    this.visible = all
    // Physics: colliders near the player.
    for (const l of all) if (!this.bodies.has(l) && Math.hypot(l.x - x, l.z - z) < COLLIDE_IN) this.addBody(l)
    for (const [l, b] of this.bodies) {
      if (Math.hypot(l.x - x, l.z - z) > COLLIDE_OUT) {
        this.physics.world.removeRigidBody(b)
        this.bodies.delete(l)
      }
    }
    // LEVELS OF DETAIL: near = full mesh casting shadows, mid = full mesh, far (> FAR_LOD m) = the low-poly LOD.
    const band = (l: Landmark) => {
      const d = Math.hypot(l.x - x, l.z - z)
      return d < shadowRange ? 0 : d < FAR_LOD ? 1 : 2
    }
    const key = all.map((l) => `${l.x | 0},${l.z | 0}:${band(l)}`).join(';') + shadows
    if (key === this.key) return
    this.key = key
    this.rebuild([0, 1, 2].map((b) => all.filter((l) => band(l) === b)), shadows)
  }

  private bake(list: Landmark[], lod: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
    if (!list.length) return null
    const parts = list.map((l) => {
      this.q.setFromAxisAngle(this.up, l.rot)
      this.m.compose(new THREE.Vector3(l.x, l.y, l.z), this.q, new THREE.Vector3(1, 1, 1))
      const g = lod[l.kind].clone().applyMatrix4(this.m)
      // Billboarded leaf tufts (the world tree) expand around bbCenter in the shader: move it with the landmark.
      const bc = g.getAttribute('bbCenter')
      if (bc) bc.applyMatrix4(this.m)
      // Snow cover tests the snow line at the landmark's FOOT (like an instanced tree's root), not per vertex — a
      // 40 m oak on a green hill must not wear a snow cap on its crown (stylize biomeCover, 4 B/vertex).
      g.setAttribute('aBaseY', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(l.y), 1))
      return g
    })
    const g = mergeGeometries(parts)
    parts.forEach((p) => p.dispose())
    g?.computeBoundingSphere()
    return g
  }

  private rebuild(bands: Landmark[][], shadows: boolean): void {
    for (const mesh of this.meshes) {
      mesh.removeFromParent()
      mesh.geometry.dispose()
    }
    this.meshes.length = 0
    for (const r of this.rotors) r.removeFromParent()
    this.rotors.length = 0
    bands.forEach((list, b) => {
      const g = this.bake(list, b === 2 ? this.geos.far : this.geos.body)
      if (!g) return
      const mesh = new THREE.Mesh(g, this.material)
      mesh.name = ['landmarks.near', 'landmarks.mid', 'landmarks.far'][b]
      mesh.castShadow = shadows && b === 0
      mesh.receiveShadow = b === 0
      this.meshes.push(mesh)
      this.group.add(mesh)
    })
    // Windmill sails: one small mesh each, spun about the hub every frame (not on the far LOD).
    for (const l of [...bands[0], ...bands[1]]) {
      if (l.kind !== LandmarkKind.Windmill) continue
      const r = new THREE.Mesh(this.geos.rotor, this.material)
      const hub = this.geos.hub.clone().applyAxisAngle(this.up, l.rot)
      r.position.set(l.x + hub.x, l.y + hub.y, l.z + hub.z)
      r.rotation.set(0, l.rot, l.variant * 6.28, 'YXZ')
      r.castShadow = shadows && bands[0].includes(l)
      r.name = 'landmark.rotor'
      this.rotors.push(r)
      this.group.add(r)
    }
  }

  private addBody(l: Landmark): void {
    const R = this.physics.R
    const b = this.physics.world.createRigidBody(
      R.RigidBodyDesc.fixed().setTranslation(l.x, l.y, l.z).setRotation({ x: 0, y: Math.sin(l.rot / 2), z: 0, w: Math.cos(l.rot / 2) }),
    )
    for (const c of this.geos.colliders[l.kind]) {
      this.physics.world.createCollider(
        R.ColliderDesc.cylinder(c.h / 2, c.r).setTranslation(c.x, c.y0 + c.h / 2, c.z).setCollisionGroups(group(Groups.Static, 0xffff)).setFriction(0.8),
        b,
      )
    }
    this.bodies.set(l, b)
  }

  dispose(): void {
    for (const b of this.bodies.values()) this.physics.world.removeRigidBody(b)
    this.bodies.clear()
    this.rebuild([[], [], []], false)
    this.geos.dispose()
  }
}
