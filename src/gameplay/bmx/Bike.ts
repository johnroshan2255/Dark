import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { WorldFields } from '../../world/WorldFields'
import type { CharacterModel } from '../player/CharacterModel'
import type { PlayerController } from '../player/PlayerController'

/**
 * BMX (refer/bmx): parked on the verge at spawn; E (or the BIKE touch button) mounts / dismounts within 2.5 m.
 * Riding reuses the player's Rapier character controller (collides with trees/poles, climbs slopes) with bike
 * dynamics in PlayerController (pedal / brake / steer, speed-dependent turning). This class owns the model:
 * wheels spin with distance, fork steers, bike + rider lean into turns, the rider pedals; the camera
 * auto-follows the heading when the mouse is idle. ~6 draws (shared vertex-colour material).
 */
const srgb = (h: number) => new THREE.Color().setHex(h, THREE.SRGBColorSpace)
const WHEEL_R = 0.33

function coloured(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g
  if (n !== g) g.dispose()
  n.deleteAttribute('uv')
  const c = srgb(hex)
  const col = new Float32Array(n.getAttribute('position').count * 3)
  for (let i = 0; i < col.length; i += 3) c.toArray(col, i)
  n.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return n
}

/** Cylinder tube between a and b. */
function tube(a: THREE.Vector3, b: THREE.Vector3, r: number, hex: number): THREE.BufferGeometry {
  const d = new THREE.Vector3().subVectors(b, a)
  const g = new THREE.CylinderGeometry(r, r, d.length(), 6)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()))
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  return coloured(g, hex)
}

function wheel(): THREE.BufferGeometry {
  const parts = [coloured(new THREE.TorusGeometry(WHEEL_R, 0.045, 6, 18).rotateY(Math.PI / 2), 0x1c1c1f)]
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI
    const d = new THREE.Vector3(0, Math.cos(a), Math.sin(a)).multiplyScalar(WHEEL_R)
    parts.push(tube(d.clone().negate(), d, 0.008, 0xb8b8b8))
  }
  parts.push(coloured(new THREE.CylinderGeometry(0.04, 0.04, 0.1, 8).rotateZ(Math.PI / 2), 0x888888))
  const g = mergeGeometries(parts)!
  parts.forEach((p) => p.dispose())
  return g
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

export class Bike {
  /** Bike + (when riding) placement root. Faces −Z. */
  readonly root = new THREE.Group()
  private readonly lean = new THREE.Group()
  private readonly fork = new THREE.Group()
  private readonly front: THREE.Mesh
  private readonly rear: THREE.Mesh
  private readonly geos: THREE.BufferGeometry[] = []
  readonly parked = new THREE.Vector3()
  parkedHeading = 0
  private leanAngle = 0
  private pedal = 0
  /** For the HUD prompt. */
  near = false

  constructor(
    material: THREE.Material,
    private readonly player: PlayerController,
    private readonly character: CharacterModel,
    private readonly fields: WorldFields,
  ) {
    this.root.name = 'bmx'
    this.root.add(this.lean)
    const RED = 0xb3262a
    const frame = mergeGeometries([
      tube(v(0, WHEEL_R, 0.52), v(0, 0.72, -0.05), 0.03, RED), // down/seat tube area
      tube(v(0, 0.36, 0.1), v(0, 0.78, -0.42), 0.032, RED), // down tube
      tube(v(0, 0.8, 0.12), v(0, 0.8, -0.42), 0.03, RED), // top tube
      tube(v(0, 0.36, 0.1), v(0, 0.86, 0.14), 0.03, RED), // seat tube
      tube(v(0, 0.36, 0.1), v(0.06, WHEEL_R, 0.52), 0.02, RED), // chain stays
      tube(v(0, 0.86, 0.14), v(0.06, WHEEL_R, 0.52), 0.018, RED),
      coloured(new THREE.BoxGeometry(0.12, 0.05, 0.26).translate(0, 0.9, 0.16), 0x202022), // seat
      coloured(new THREE.CylinderGeometry(0.07, 0.07, 0.03, 12).rotateZ(Math.PI / 2).translate(0, 0.36, 0.1), 0x555555), // crank
    ])!
    this.geos.push(frame)
    const frameMesh = new THREE.Mesh(frame, material)
    const forkG = mergeGeometries([
      tube(v(0, 0.2 - 0.88, 0), v(0, 0.2, 0), 0.028, RED),
      tube(v(-0.3, 0.3, 0.05), v(0.3, 0.3, 0.05), 0.02, 0x2a2a2a), // handlebar
      tube(v(0, 0.2, 0), v(0, 0.3, 0.05), 0.02, 0x2a2a2a),
      coloured(new THREE.BoxGeometry(0.1, 0.07, 0.07).translate(0, 0.22, -0.08), 0xf2eecc), // headlamp
    ])!
    this.geos.push(forkG)
    this.fork.add(new THREE.Mesh(forkG, material))
    this.fork.position.set(0, 0.8, -0.46)
    const wg = wheel()
    this.geos.push(wg)
    this.front = new THREE.Mesh(wg, material)
    this.front.position.set(0, WHEEL_R - 0.8, -0.1)
    this.fork.add(this.front)
    this.rear = new THREE.Mesh(wg, material)
    this.rear.position.set(0, WHEEL_R, 0.52)
    this.lean.add(frameMesh, this.fork, this.rear)
    for (const m of [frameMesh, this.front, this.rear, this.fork.children[0] as THREE.Mesh]) (m as THREE.Mesh).castShadow = true
  }

  /** Park the bike on the verge `side` m to the right of the player, facing along its yaw. */
  parkNear(p: THREE.Vector3, yaw: number, side = 2.2): void {
    this.parked.set(p.x + Math.cos(yaw) * side, 0, p.z - Math.sin(yaw) * side)
    this.parked.y = this.fields.height(this.parked.x, this.parked.z)
    this.parkedHeading = yaw
  }

  set castShadow(v: boolean) {
    this.root.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).castShadow = v) : 0))
  }

  get riding(): boolean {
    return this.player.ride.riding
  }

  /** E / BIKE button. */
  toggle(): void {
    const p = this.player
    const r = p.ride
    if (r.riding) {
      r.riding = false
      this.parked.copy(p.curr)
      this.parkedHeading = r.heading
      // step off to the left side
      p.teleport(new THREE.Vector3(p.curr.x - Math.cos(r.heading) * 0.9, p.curr.y + 0.1, p.curr.z + Math.sin(r.heading) * 0.9))
      r.speed = 0
      return
    }
    if (!this.near || p.dead) return
    p.teleport(new THREE.Vector3(this.parked.x, this.parked.y + 0.1, this.parked.z))
    r.riding = true
    r.heading = this.parkedHeading
    r.speed = 0
    r.steer = 0
    p.yaw = this.parkedHeading
  }

  update(dt: number): void {
    const p = this.player
    const r = p.ride
    // Knocked down (monster, lightning) → thrown off the bike.
    if (r.riding && (p.knock > 0.2 || p.dead)) {
      r.riding = false
      this.parked.copy(p.curr)
      this.parkedHeading = r.heading
      r.speed = 0
    }
    this.near = !r.riding && Math.hypot(p.curr.x - this.parked.x, p.curr.z - this.parked.z) < 2.5
    if (r.riding) {
      const pos = p.renderPosition
      this.root.position.set(pos.x, pos.y, pos.z)
      this.root.rotation.set(0, r.heading, 0)
      const targetLean = -r.steer * Math.min(1, Math.abs(r.speed) / 7) * 0.35
      this.leanAngle += (targetLean - this.leanAngle) * Math.min(1, dt * 5)
      this.lean.rotation.z = this.leanAngle
      this.fork.rotation.y = -r.steer * 0.45
      const spin = -r.travelled / WHEEL_R
      this.front.rotation.x = spin
      this.rear.rotation.x = spin
      this.pedal = spin * 0.55
      // Camera follows the heading when the player isn't steering the view.
      if (p.lookIdle > 0.6) {
        let d = r.heading - p.yaw
        d = Math.atan2(Math.sin(d), Math.cos(d))
        p.yaw += d * Math.min(1, dt * 4)
      }
      this.character.ride(pos, r.heading, this.pedal, this.leanAngle)
    } else {
      this.root.position.copy(this.parked)
      this.root.rotation.set(0, this.parkedHeading, 0)
      this.lean.rotation.z = 0.28 // leaning on its kickstand
      this.fork.rotation.y = 0.35
    }
    this.root.updateMatrixWorld()
  }

  dispose(): void {
    this.geos.forEach((g) => g.dispose())
  }
}
