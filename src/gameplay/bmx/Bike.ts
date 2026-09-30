import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { WorldFields } from '../../world/WorldFields'
import type { CharacterModel, RideRig } from '../player/CharacterModel'
import type { PlayerController } from '../player/PlayerController'
import type { PhysicsWorld } from '../../physics/PhysicsWorld'
import type { Input } from '../../input/Input'
import { BikeSim } from '../vehicle/VehicleSim'

/**
 * BMX (refer/bmx): parked on the verge at spawn; E (or the BIKE touch button) mounts / dismounts within 2.5 m.
 * SIMULATED (VehicleSim BikeSim, tests/vehicle.test.ts): a dynamic two-wheel raycast vehicle with human-power
 * pedalling, brakes, steering, tyre grip and a balancing rider — it leans INTO turns at the physical lean angle,
 * slows on hills (≈ 18° is the limit, then push it), and a hard hit (tree, wall, monster) throws the rider off and
 * the bike falls over. W pedal · S brake / walk back · A/D steer · Shift sprint. This class maps input, draws the
 * simulated pose (interpolated), spins the wheels + cranks, steers the fork, and poses the rider by IK; the camera
 * auto-follows the heading when the mouse is idle. ~7 draws (shared vertex-colour material).
 * Scaled to a small BMX (SCALE) so the stickman rider's feet reach the pedals; the crank arms turn with the
 * wheels and the rider's feet/hands follow the pedals and the steered bars by IK (CharacterModel.ride).
 */
const srgb = (h: number) => new THREE.Color().setHex(h, THREE.SRGBColorSpace)
const WHEEL_R = 0.33
const SCALE = 0.85
const CRANK_R = 0.17
/** Rider contact points in (scaled) bike space. */
export const BIKE_RIG: RideRig = {
  seat: new THREE.Vector3(0, 0.925, 0.16).multiplyScalar(SCALE),
  crank: new THREE.Vector3(0, 0.36, 0.1).multiplyScalar(SCALE),
  crankR: CRANK_R * SCALE,
  pedalX: 0.13 * SCALE,
  fork: new THREE.Vector3(0, 0.8, -0.46).multiplyScalar(SCALE),
  grip: new THREE.Vector3(0.3, 0.3, 0.05).multiplyScalar(SCALE),
}

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
const _w = new THREE.Vector3()

export class Bike {
  /** Bike + (when riding) placement root. Faces −Z. */
  readonly root = new THREE.Group()
  private readonly lean = new THREE.Group()
  private readonly fork = new THREE.Group()
  private readonly front: THREE.Mesh
  private readonly rear: THREE.Mesh
  private readonly crank = new THREE.Group()
  private readonly geos: THREE.BufferGeometry[] = []
  readonly parked = new THREE.Vector3()
  parkedHeading = 0
  private pedal = 0
  /** For the HUD prompt. */
  near = false
  readonly sim: BikeSim
  /** parked (kickstand, no physics) · riding · fallen (crashed: simulated until it settles). */
  private state: 'parked' | 'riding' | 'fallen' = 'parked'
  private fallenFor = 0
  /** Forward speed over the last ~0.15 s (crash = a sudden drop, measured over a few steps). */
  private readonly speedHist = new Float32Array(9)
  private histI = 0
  private readonly prevP = new THREE.Vector3()
  private readonly prevQ = new THREE.Quaternion()
  private readonly curP = new THREE.Vector3()
  private readonly curQ = new THREE.Quaternion()

  constructor(
    material: THREE.Material,
    private readonly player: PlayerController,
    private readonly character: CharacterModel,
    private readonly fields: WorldFields,
    physics: PhysicsWorld,
    private readonly input: Input,
  ) {
    this.root.name = 'bmx'
    this.root.add(this.lean)
    this.lean.scale.setScalar(SCALE)
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
    // Crank arms + pedals (turn with the wheels; the rider's feet are IK'd onto them).
    const crankG = mergeGeometries([
      tube(v(0.1, 0, 0), v(0.1, 0, -CRANK_R), 0.014, 0x3a3a3a), tube(v(-0.1, 0, 0), v(-0.1, 0, CRANK_R), 0.014, 0x3a3a3a),
      coloured(new THREE.BoxGeometry(0.09, 0.02, 0.06).translate(0.14, 0, -CRANK_R), 0x222222),
      coloured(new THREE.BoxGeometry(0.09, 0.02, 0.06).translate(-0.14, 0, CRANK_R), 0x222222),
    ])!
    this.geos.push(crankG)
    const crankMesh = new THREE.Mesh(crankG, material)
    this.crank.add(crankMesh)
    this.crank.position.set(0, 0.36, 0.1)
    this.lean.add(frameMesh, this.fork, this.rear, this.crank)
    for (const m of [frameMesh, this.front, this.rear, crankMesh, this.fork.children[0] as THREE.Mesh]) (m as THREE.Mesh).castShadow = true
    // Wheel hubs in (scaled) bike space: front = fork pivot + wheel offset, rear = rear axle.
    const f = new THREE.Vector3(0, 0.8 + WHEEL_R - 0.8, -0.46 - 0.1).multiplyScalar(SCALE)
    this.sim = new BikeSim(physics, { front: [0, f.y, f.z], rear: [0, WHEEL_R * SCALE, 0.52 * SCALE], wheelRadius: WHEEL_R * SCALE })
    this.sim.enabled = false
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

  private readPose(p: THREE.Vector3, q: THREE.Quaternion): void {
    const t = this.sim.body.translation(), r = this.sim.body.rotation()
    p.set(t.x, t.y, t.z)
    q.set(r.x, r.y, r.z, r.w)
  }

  /** E / BIKE button. */
  toggle(): void {
    const p = this.player
    const r = p.ride
    if (r.riding) {
      this.getOff()
      // step off to the left side
      const h = this.parkedHeading
      p.teleport(new THREE.Vector3(this.parked.x - Math.cos(h) * 0.9, this.parked.y + 0.1, this.parked.z + Math.sin(h) * 0.9))
      return
    }
    if (!this.near || p.dead) return
    this.sim.enabled = true
    this.sim.balancing = true
    this.sim.place(this.parked.x, this.parked.y, this.parked.z, this.parkedHeading)
    this.readPose(this.curP, this.curQ)
    this.prevP.copy(this.curP)
    this.prevQ.copy(this.curQ)
    this.state = 'riding'
    this.speedHist.fill(0)
    r.riding = true
    r.heading = this.parkedHeading
    r.speed = 0
    r.steer = 0
    p.inVehicle = true
    p.collider.setEnabled(false)
    p.yaw = this.parkedHeading
  }

  /** Leave the saddle: the bike stays where it is, on its kickstand (physics off). */
  private getOff(): void {
    const p = this.player
    const t = this.sim.body.translation()
    this.parked.set(t.x, this.fields.height(t.x, t.z), t.z)
    this.parkedHeading = this.sim.heading
    this.state = 'parked'
    this.fallenLean = -0.28 // back on its kickstand
    this.sim.enabled = false
    p.ride.riding = false
    p.ride.speed = 0
    p.inVehicle = false
    p.collider.setEnabled(true)
  }

  /** Crash: the rider is thrown forward (knocked down), the bike falls over under physics. */
  private crash(speed: number): void {
    const p = this.player
    const h = this.sim.heading
    const t = this.sim.body.translation()
    p.ride.riding = false
    p.inVehicle = false
    p.collider.setEnabled(true)
    p.teleport(new THREE.Vector3(t.x - Math.sin(h) * 0.8, t.y + 0.3, t.z - Math.cos(h) * 0.8))
    p.applyImpulse(-Math.sin(h) * speed * 0.5, 3 + speed * 0.2, -Math.cos(h) * speed * 0.5, 1.3)
    this.sim.balancing = false
    this.state = 'fallen'
    this.fallenFor = 0
  }

  /** Fixed step (60 Hz, before world.step): input → pedals/brakes/steering; crash detection; carry the rider. */
  fixedUpdate(dt: number): void {
    const p = this.player
    const r = p.ride
    const i = this.input
    const c = this.sim.controls
    const riding = this.state === 'riding'
    const locked = p.dead || p.stunned > 0
    c.throttle = riding && !locked ? Math.max(-1, Math.min(1, (i.down('KeyW') ? 1 : 0) - (i.down('KeyS') ? 1 : 0) + i.touchMove.y)) : 0
    c.steer = riding && !locked ? Math.max(-1, Math.min(1, (i.down('KeyD') ? 1 : 0) - (i.down('KeyA') ? 1 : 0) + i.touchMove.x)) : 0
    c.boost = riding && (i.down('ShiftLeft') || i.down('ShiftRight') || Math.hypot(i.touchMove.x, i.touchMove.y) > 0.92)
    c.parked = !riding
    if (this.state === 'parked') return
    this.readPose(this.prevP, this.prevQ)
    const t = this.sim.body.translation()
    this.sim.step(dt)
    this.sim.keepAbove(this.fields.height(t.x, t.z))
    if (riding) {
      const v = this.sim.speed
      // A sudden stop (tree, wall, rock above ~20 km/h: −5.5 m/s within 0.15 s ≈ 1.9 g) or a hit (monster,
      // lightning) throws the rider off.
      const before = this.speedHist[this.histI]
      this.speedHist[this.histI] = v
      this.histI = (this.histI + 1) % this.speedHist.length
      if (before - v > 5.5 || p.stunned > 0.3 || p.dead) return this.crash(Math.max(before, 4))
      r.heading = this.sim.heading
      r.speed = v
      r.steer += (c.steer - r.steer) * Math.min(1, dt * 6)
      r.travelled = this.sim.wheels[1].spin * WHEEL_R * SCALE
      _w.set(t.x, t.y, t.z)
      p.carryTo(_w) // streaming, grass, monsters follow the bike
    } else {
      // Fallen: let it tumble and settle, then freeze it where it lies (mounting stands it back up).
      this.fallenFor += dt
      const lv = this.sim.body.linvel()
      if (this.fallenFor > 1.5 && Math.hypot(lv.x, lv.y, lv.z) < 0.3) {
        this.parked.set(t.x, this.fields.height(t.x, t.z), t.z)
        this.parkedHeading = this.sim.heading
        this.sim.enabled = false
        this.state = 'parked'
        this.fallenLean = this.sim.attitude().roll
      }
    }
  }
  /** Lean of a bike that fell and settled (drawn lying down until picked up). */
  private fallenLean = -0.28

  update(dt: number, alpha = 1): void {
    const p = this.player
    const r = p.ride
    this.near = !r.riding && Math.hypot(p.curr.x - this.parked.x, p.curr.z - this.parked.z) < 2.5
    if (this.state !== 'parked') {
      // Simulated pose, interpolated between physics steps.
      this.readPose(this.curP, this.curQ)
      this.root.position.lerpVectors(this.prevP, this.curP, alpha)
      this.root.quaternion.slerpQuaternions(this.prevQ, this.curQ, alpha)
      this.lean.rotation.z = 0
      const w = this.sim.wheels
      this.fork.rotation.y = -w[0].steer
      this.front.rotation.x = -w[0].spin
      this.rear.rotation.x = -w[1].spin
      this.front.position.y = WHEEL_R - 0.8 + w[0].lift / SCALE
      this.rear.position.y = WHEEL_R + w[1].lift / SCALE
      this.pedal = -w[1].spin * 0.55
      this.crank.rotation.x = this.pedal
      this.root.updateMatrixWorld()
      if (this.state === 'riding') {
        // Camera follows the heading when the player isn't steering the view.
        if (p.lookIdle > 0.6) {
          let d = r.heading - p.yaw
          d = Math.atan2(Math.sin(d), Math.cos(d))
          p.yaw += d * Math.min(1, dt * 4)
        }
        this.character.ride(this.root.position, r.heading, this.pedal, this.sim.lean, BIKE_RIG, this.fork.rotation.y, this.root.quaternion)
      }
    } else {
      this.root.position.copy(this.parked)
      this.root.rotation.set(0, this.parkedHeading, 0)
      this.lean.rotation.z = -this.fallenLean // on its kickstand (or lying where it fell)
      this.fork.rotation.y = 0.35
    }
    this.root.updateMatrixWorld()
  }

  dispose(): void {
    this.geos.forEach((g) => g.dispose())
  }
}
