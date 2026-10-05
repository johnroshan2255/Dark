import type RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import type { PhysicsWorld } from '../../physics/PhysicsWorld'
import type { WorldFields } from '../../world/WorldFields'
import type { CharacterModel } from './CharacterModel'
import { EYE_HEIGHT, type PlayerController } from './PlayerController'

export type CameraMode = 'fpp' | 'tpp'

const TPP_DISTANCE = 4.4
const TPP_SHOULDER = 0.55
const TPP_PIVOT = 2.3

/**
 * First/third-person camera. TPP: over-the-shoulder orbit around a pivot above the player, pulled in
 * by a Rapier ray cast (terrain + trunks) so it never goes through the world; fast in, slow out.
 * Also decides where the flashlight sits and aims (eye in FPP, hand in TPP → aims at the view centre).
 */
export class CameraController {
  mode: CameraMode = 'fpp'
  /** Vehicle view: farther and higher behind (car). null = on foot / bike. */
  vehicle: { distance: number; pivot: number } | null = null
  /** Garage turntable: orbit this point (the parked car) slowly; the player and look input are ignored. */
  garage: THREE.Vector3 | null = null
  private orbit = 0
  /** Dev / screenshot vista: first-person eye raised this many metres above the player (0 = normal). */
  lift = 0
  readonly flashOrigin = new THREE.Vector3()
  readonly flashTarget = new THREE.Vector3()
  private dist = TPP_DISTANCE
  private bob = 0
  /** 0..1 screen shake, set by hits and lightning. */
  shake = 0
  private readonly fwd = new THREE.Vector3()
  private readonly right = new THREE.Vector3()
  private readonly pivot = new THREE.Vector3()
  private readonly desired = new THREE.Vector3()
  private readonly ray: RAPIER.Ray

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly fields: WorldFields,
    private readonly character: CharacterModel,
    private readonly blob: THREE.Mesh,
  ) {
    this.ray = new physics.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })
  }

  update(dt: number, cam: THREE.PerspectiveCamera, p: PlayerController, flashlightOn: boolean): void {
    if (this.garage) {
      // Turntable: 7 m out, 2.2 m up, a slow lap every ~40 s, looking at the car's roofline.
      this.orbit += dt * 0.16
      const g = this.garage
      const ground = this.fields.surface(g.x + Math.sin(this.orbit) * 7, g.z + Math.cos(this.orbit) * 7)
      cam.position.set(g.x + Math.sin(this.orbit) * 7, Math.max(g.y + 2.2, ground + 1.2), g.z + Math.cos(this.orbit) * 7)
      // Look past the car's left so it sits in the open RIGHT half of the screen (the garage panel is on the left).
      const dx = g.x - cam.position.x, dz = g.z - cam.position.z, l = Math.hypot(dx, dz)
      cam.lookAt(g.x + (dz / l) * 1.7, g.y + 1.0, g.z - (dx / l) * 1.7)
      cam.updateMatrixWorld()
      this.character.root.visible = false
      this.blob.visible = false
      this.flashOrigin.copy(cam.position)
      this.flashTarget.copy(g)
      return
    }
    const pos = p.renderPosition
    const cy = Math.cos(p.yaw)
    const sy = Math.sin(p.yaw)
    const cp = Math.cos(p.pitch)
    this.fwd.set(-sy * cp, Math.sin(p.pitch), -cy * cp)
    this.right.set(cy, 0, -sy)
    const tpp = this.mode === 'tpp'

    // Screen shake (hits, near lightning) decays; knockdown drops the view to the ground and rolls it.
    this.shake = Math.max(0, this.shake - dt * 2.5)
    const sh = this.shake * this.shake
    const shx = (Math.random() - 0.5) * sh * 0.25
    const shy = (Math.random() - 0.5) * sh * 0.25
    const k = p.knock
    if (!tpp) {
      const speed = p.grounded ? p.horizontalSpeed : 0
      this.bob += dt * speed * 1.9
      const bobY = Math.sin(this.bob * 2) * 0.035 * Math.min(1, speed / 3)
      cam.position.set(pos.x, pos.y + EYE_HEIGHT * (1 - k * 0.8) + bobY + this.lift, pos.z)
      cam.rotation.set(p.pitch * (1 - k) + k * 0.25 + shy, p.yaw + shx, k * 1.2, 'YXZ')
      cam.updateMatrixWorld()
      this.flashOrigin.set(0.18, -0.2, 0).applyMatrix4(cam.matrixWorld)
      this.flashTarget.copy(cam.position).addScaledVector(this.fwd, 10)
    } else {
      const vd = this.vehicle
      this.pivot.set(pos.x, pos.y + (vd ? vd.pivot : TPP_PIVOT), pos.z).addScaledVector(this.right, vd ? 0 : TPP_SHOULDER * 0.35)
      this.desired.copy(this.pivot).addScaledVector(this.fwd, -(vd ? vd.distance : TPP_DISTANCE)).addScaledVector(this.right, vd ? 0 : TPP_SHOULDER * 0.65)
      // Pull in on collision (exclude the player's own capsule).
      const dx = this.desired.x - this.pivot.x
      const dy = this.desired.y - this.pivot.y
      const dz = this.desired.z - this.pivot.z
      const len = Math.hypot(dx, dy, dz)
      this.ray.origin = { x: this.pivot.x, y: this.pivot.y, z: this.pivot.z }
      this.ray.dir = { x: dx / len, y: dy / len, z: dz / len }
      const hit = this.physics.world.castRay(this.ray, len, true, undefined, undefined, p.collider)
      const target = hit ? Math.max(0.35, hit.timeOfImpact - 0.3) : len
      // (named `pull`, NOT `k`: shadowing the knockdown amount made the camera roll ~0.5° and wobble every frame)
      const pull = target < this.dist ? 1 - Math.exp(-30 * dt) : 1 - Math.exp(-4 * dt)
      this.dist += (target - this.dist) * pull
      const t = this.dist / len
      cam.position.set(this.pivot.x + dx * t, this.pivot.y + dy * t, this.pivot.z + dz * t)
      const ground = this.fields.surface(cam.position.x, cam.position.z) + 0.3
      if (cam.position.y < ground) cam.position.y = ground
      cam.rotation.set(p.pitch + shy, p.yaw + shx, k * 0.15, 'YXZ')
      cam.updateMatrixWorld()
    }

    // Character: visible in TPP only. Faces the view when aiming the flashlight, else the move direction.
    this.character.root.visible = tpp
    this.blob.visible = tpp && this.blob.userData.enabled !== false
    if (tpp) {
      const moving = p.horizontalSpeed > 0.4
      const targetYaw = flashlightOn || !moving ? (flashlightOn ? p.yaw : this.character.yaw) : Math.atan2(-p.velocity.x, -p.velocity.z)
      this.character.animate(dt, pos, targetYaw, p.horizontalSpeed, p.grounded, flashlightOn, p.pitch, p.velocity.y, k) // knockdown / get-up posed inside
      this.blob.position.set(pos.x, this.fields.surface(pos.x, pos.z) + 0.03, pos.z)
      this.character.handPosition(this.flashOrigin)
      this.flashTarget.copy(cam.position).addScaledVector(this.fwd, 28)
    }
  }
}
