import * as THREE from 'three'

/**
 * Player character: the Sketchfab "Stickman" (assets/loadModels) RIGGED IN CODE — the GLB is a single static
 * T-pose mesh with no skeleton, so we build 16 bones from measured joint landmarks, skin every vertex by body
 * region (smooth 2-bone blends at the joints) and animate procedurally:
 *   idle (breathing), walk ↔ run (stride-matched cadence, arm swing, elbow bend, lean, bob, torso twist),
 *   jump (take-off tuck, airborne pose, fall), landing squash, flashlight aim (right arm follows the view),
 *   cycling (two-bone IK: feet on the turning pedals, hands on the steering bars, leaning with the bike).
 * One SkinnedMesh = 1 draw call (the old box character was 5) on the shared vertex-colour material; skinning
 * 1.6k vertices × 16 bones is negligible on any GPU. Faces −Z in local space (camera convention).
 */

/** Source landmarks (model units, facing +Z, measured from the vertex distribution of human.glb). */
const SRC = {
  sole: -40.1, ankle: -32.5, knee: -21.5, hip: -11, pelvis: -8, chest: 10, neck: 24.5, shoulderY: 20,
  shoulderX: 12.5, elbowX: 30, wristX: 42.5, handX: 47.4, legX: 6.7, zc: -1.5, height: 96.67,
}
/** Standing height (m). Slightly tall: the cartoon head is big and the legs short (must reach BMX pedals). */
const HEIGHT = 1.85
const U = HEIGHT / SRC.height
const toFinal = (x: number, y: number, z: number) => new THREE.Vector3(-x * U, (y - SRC.sole) * U, -(z - SRC.zc) * U)
const BODY_COLOUR = 0xeeeae2

const B = {
  hips: 0, chest: 1, head: 2,
  armL: 3, foreL: 4, handL: 5, armR: 6, foreR: 7, handR: 8,
  thighL: 9, shinL: 10, footL: 11, thighR: 12, shinR: 13, footR: 14,
} as const
type BoneId = (typeof B)[keyof typeof B]

/** Bicycle contact points in bike space (Bike.BIKE_RIG), for the riding IK. */
export interface RideRig {
  seat: THREE.Vector3
  crank: THREE.Vector3
  crankR: number
  pedalX: number
  /** Fork pivot + grip offsets in fork space (the fork steers about its Y axis). */
  fork: THREE.Vector3
  grip: THREE.Vector3
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export class CharacterModel {
  readonly root = new THREE.Group()
  private readonly mesh: THREE.SkinnedMesh
  private readonly bones: THREE.Bone[] = []
  private readonly rest: THREE.Vector3[] = []
  private readonly target: THREE.Quaternion[] = []
  private phase = 0
  private time = 0
  private air = 0
  private land = 0
  private wasGrounded = true
  private runK = 0
  private moveK = 0
  /** Body yaw (smoothed toward movement / aim). */
  yaw = 0

  constructor(material: THREE.Material, source: THREE.BufferGeometry) {
    this.root.name = 'player-character'
    this.root.rotation.order = 'YXZ' // knockdown tips relative to facing
    const geo = this.skinGeometry(source)
    // Skeleton (rest = T-pose, identity rotations; bone offsets from the landmarks).
    const S = SRC
    const at: [BoneId, BoneId | -1, THREE.Vector3][] = [
      [B.hips, -1, toFinal(0, S.pelvis, 0)],
      [B.chest, B.hips, toFinal(0, S.chest, 0)],
      [B.head, B.chest, toFinal(0, S.neck, 0)],
      [B.armL, B.chest, toFinal(S.shoulderX, S.shoulderY, 0)],
      [B.foreL, B.armL, toFinal(S.elbowX, S.shoulderY, 0)],
      [B.handL, B.foreL, toFinal(S.wristX, S.shoulderY, 0)],
      [B.armR, B.chest, toFinal(-S.shoulderX, S.shoulderY, 0)],
      [B.foreR, B.armR, toFinal(-S.elbowX, S.shoulderY, 0)],
      [B.handR, B.foreR, toFinal(-S.wristX, S.shoulderY, 0)],
      [B.thighL, B.hips, toFinal(S.legX, S.hip, 0)],
      [B.shinL, B.thighL, toFinal(S.legX, S.knee, 0)],
      [B.footL, B.shinL, toFinal(S.legX, S.ankle, 0)],
      [B.thighR, B.hips, toFinal(-S.legX, S.hip, 0)],
      [B.shinR, B.thighR, toFinal(-S.legX, S.knee, 0)],
      [B.footR, B.shinR, toFinal(-S.legX, S.ankle, 0)],
    ]
    const world: THREE.Vector3[] = []
    for (const [id, parent, p] of at) {
      const b = new THREE.Bone()
      b.name = Object.keys(B)[id]
      world[id] = p
      b.position.copy(parent < 0 ? p : p.clone().sub(world[parent]))
      this.bones[id] = b
      this.rest[id] = b.position.clone()
      this.target[id] = new THREE.Quaternion()
      if (parent >= 0) this.bones[parent].add(b)
    }
    this.mesh = new THREE.SkinnedMesh(geo, material)
    this.mesh.name = 'character'
    this.mesh.frustumCulled = false // poses leave the bind-pose bounds; the player is always near the camera
    this.mesh.add(this.bones[B.hips])
    this.mesh.updateMatrixWorld(true)
    this.mesh.bind(new THREE.Skeleton(this.bones))
    this.root.add(this.mesh)
  }

  /**
   * Baked source (units, facing +Z) → final space (m, facing −Z, feet at 0) + skin indices/weights by region.
   * Each vertex gets ≤ 2 bones; blends across ~3–5 units around every joint so bends are smooth.
   */
  private skinGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
    const g = src.clone() // keep it indexed: shared vertices keep the model's own smooth normals
    const pos = g.getAttribute('position')
    const nor = g.getAttribute('normal')
    const n = pos.count
    const si = new Uint16Array(n * 4)
    const sw = new Float32Array(n * 4)
    const col = new Float32Array(n * 3)
    const c = new THREE.Color().setHex(BODY_COLOUR, THREE.SRGBColorSpace)
    const S = SRC
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
      const ax = Math.abs(x)
      const left = x > 0 // source faces +Z → +x is the character's LEFT
      let a: number, b2: number, t: number
      if (y > S.neck + 1.5) (a = B.head), (b2 = B.head), (t = 0)
      else if (y > S.neck - 1.5 && ax < S.shoulderX) (a = B.chest), (b2 = B.head), (t = (y - (S.neck - 1.5)) / 3)
      else if (ax > S.shoulderX + 0.5 && y > S.shoulderY - 7) {
        const up = left ? B.armL : B.armR, fo = left ? B.foreL : B.foreR, ha = left ? B.handL : B.handR
        if (ax < S.shoulderX + 3.5) (a = B.chest), (b2 = up), (t = (ax - S.shoulderX - 0.5) / 3)
        else if (ax < S.elbowX - 2.5) (a = up), (b2 = up), (t = 0)
        else if (ax < S.elbowX + 2.5) (a = up), (b2 = fo), (t = (ax - (S.elbowX - 2.5)) / 5)
        else if (ax < S.wristX) (a = fo), (b2 = fo), (t = 0)
        else (a = fo), (b2 = ha), (t = Math.min(1, (ax - S.wristX) / 2))
      } else if (y < S.hip + 0.5) {
        const th = left ? B.thighL : B.thighR, sh = left ? B.shinL : B.shinR, fo = left ? B.footL : B.footR
        if (y > S.hip - 2.5) (a = B.hips), (b2 = th), (t = (S.hip + 0.5 - y) / 3)
        else if (y > S.knee + 2) (a = th), (b2 = th), (t = 0)
        else if (y > S.knee - 2) (a = th), (b2 = sh), (t = (S.knee + 2 - y) / 4)
        else if (y > S.ankle + 1) (a = sh), (b2 = sh), (t = 0)
        else (a = sh), (b2 = fo), (t = Math.min(1, (S.ankle + 1 - y) / 2))
      } else if (y < S.pelvis + 6) (a = B.hips), (b2 = B.hips), (t = 0)
      else if (y > S.chest - 2) (a = B.chest), (b2 = B.chest), (t = 0)
      else (a = B.hips), (b2 = B.chest), (t = (y - (S.pelvis + 6)) / (S.chest - 2 - (S.pelvis + 6)))
      t = smooth(0, 1, t)
      si[i * 4] = a
      si[i * 4 + 1] = b2
      sw[i * 4] = 1 - t
      sw[i * 4 + 1] = t
      const f = toFinal(x, y, z)
      pos.setXYZ(i, f.x, f.y, f.z)
      if (nor) nor.setXYZ(i, -nor.getX(i), nor.getY(i), -nor.getZ(i)) // same 180° turn as the positions
      c.toArray(col, i * 3)
    }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4))
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    if (!nor) g.computeVertexNormals()
    g.computeBoundingSphere()
    g.name = 'character'
    return g
  }

  set castShadow(v: boolean) {
    this.mesh.castShadow = v
  }

  // ---- pose helpers -------------------------------------------------------------------------------------
  private readonly _e = new THREE.Euler()
  private pose(id: BoneId, x: number, y = 0, z = 0): void {
    this.target[id].setFromEuler(this._e.set(x, y, z, 'XYZ'))
  }
  /** Arm hanging at `down` (0 = T-pose, π/2 = at the side), swung forward by `fwd`, elbow bent by `bend`. */
  private arm(side: 1 | -1, down: number, fwd: number, bend: number, out = 0): void {
    // side +1 = right (+X in final space): lowering is a −Z rotation; forearm bends about local Y.
    const up = side > 0 ? B.armR : B.armL
    const fo = side > 0 ? B.foreR : B.foreL
    this.pose(up, fwd, out * side, -side * down)
    this.pose(fo, 0, side * bend, 0)
  }
  private leg(side: 1 | -1, thigh: number, knee: number, spread = 0, ankle = 0): void {
    this.pose(side > 0 ? B.thighR : B.thighL, thigh, 0, side * spread)
    this.pose(side > 0 ? B.shinR : B.shinL, -knee)
    this.pose(side > 0 ? B.footR : B.footL, ankle)
  }
  private commit(k: number): void {
    for (let i = 0; i < this.bones.length; i++) this.bones[i].quaternion.slerp(this.target[i], k)
  }

  /**
   * @param speed horizontal m/s   @param grounded   @param aimPitch camera pitch (arm follows when aiming)
   * @param aiming flashlight on → right arm raised forward   @param vy vertical velocity (jump/fall pose)
   */
  animate(dt: number, pos: THREE.Vector3, targetYaw: number, speed: number, grounded: boolean, aiming: boolean, aimPitch: number, vy = 0): void {
    let d = targetYaw - this.yaw
    d = Math.atan2(Math.sin(d), Math.cos(d))
    this.yaw += d * (1 - Math.exp(-12 * dt))
    this.time += dt
    // Walk ↔ run blend and a stride-matched cadence (feet don't skate): stride 1.3 m walking → 2.3 m running.
    this.runK += (smooth(3.9, 6.0, speed) - this.runK) * Math.min(1, dt * 6)
    this.moveK += (smooth(0.15, 1.2, speed) - this.moveK) * Math.min(1, dt * 8)
    const stride = 1.3 + this.runK * 1.0
    this.phase += dt * (Math.PI * 2 * Math.max(speed, 0.6 * this.moveK)) / stride
    // Air / landing timers.
    this.air = grounded ? 0 : this.air + dt
    if (grounded && !this.wasGrounded && this.airTime > 0.25) this.land = 0.22
    this.airTime = grounded ? 0 : this.airTime + dt
    this.wasGrounded = grounded
    this.land = Math.max(0, this.land - dt)

    const r = this.runK, m = this.moveK, s = Math.sin(this.phase), c = Math.cos(this.phase)
    let hipsY = 0
    if (!grounded && this.air > 0.06) {
      // Airborne: rising = tucked knees, arms up/out; falling = legs reaching down, arms higher.
      const fall = smooth(1, -4, vy)
      this.leg(-1, 0.75 - fall * 0.35, 1.3 - fall * 0.6, 0.06)
      this.leg(1, 0.2 + fall * 0.1, 0.7 - fall * 0.2, 0.06)
      this.arm(1, 0.55 - fall * 0.25, 0.35, 0.5, 0.2)
      this.arm(-1, 0.55 - fall * 0.25, 0.35, 0.5, 0.2)
      this.pose(B.chest, -0.12 + fall * 0.1)
      this.pose(B.hips, -0.05)
      this.pose(B.head, 0.1)
    } else {
      // Ground locomotion (idle when m → 0).
      const ampT = (0.45 + 0.4 * r) * m
      const kneeSwing = (0.7 + 0.9 * r) * m
      this.leg(-1, ampT * s, 0.08 + kneeSwing * Math.max(0, c) + 0.12 * r * m, 0.03)
      this.leg(1, -ampT * s, 0.08 + kneeSwing * Math.max(0, -c) + 0.12 * r * m, 0.03)
      const breath = Math.sin(this.time * 2.2) * 0.03 * (1 - m)
      const armSwing = (0.35 + 0.35 * r) * m
      const elbow = 0.18 + 1.2 * r * m
      this.arm(1, 1.35 - 0.1 * r, armSwing * s, elbow, 0.05)
      this.arm(-1, 1.35 - 0.1 * r, -armSwing * s, elbow, 0.05)
      this.pose(B.hips, -0.08 * r * m, 0.1 * s * m)
      this.pose(B.chest, -0.22 * r * m - breath, -0.18 * s * m)
      this.pose(B.head, 0.12 * r * m + breath)
      hipsY = -(0.025 + 0.035 * r) * m * (0.5 - 0.5 * Math.cos(this.phase * 2))
    }
    if (this.land > 0) {
      // Landing squash: knees give, hips drop, arms swing down.
      const k = Math.sin((this.land / 0.22) * Math.PI)
      this.leg(-1, 0.55 * k, 1.1 * k)
      this.leg(1, 0.55 * k, 1.1 * k)
      this.pose(B.chest, -0.3 * k)
      hipsY -= 0.14 * k
    }
    if (aiming) this.arm(1, Math.PI / 2, Math.PI / 2 - 0.1 + aimPitch * 0.8, 0.05) // flashlight: lowered, then swung straight forward
    this.bones[B.hips].position.set(this.rest[B.hips].x, this.rest[B.hips].y + hipsY, this.rest[B.hips].z)
    this.commit(1 - Math.exp(-16 * dt))
    this.root.position.set(pos.x, pos.y, pos.z)
    this.root.rotation.set(0, this.yaw, 0)
  }
  private airTime = 0

  /**
   * Riding pose on the BMX: seated, feet ON the turning pedals and hands ON the steering bars (two-bone IK),
   * leaning forward and into turns with the bike. `pedal` = crank angle, `steer` = fork angle (rad).
   */
  ride(pos: THREE.Vector3, heading: number, pedal: number, lean: number, rig?: RideRig, steer = 0): void {
    this.yaw = heading
    this.root.position.copy(pos)
    this.root.rotation.set(0, heading, lean, 'YXZ')
    const bones = this.bones
    for (const b of bones) b.quaternion.identity()
    if (rig) bones[B.hips].position.copy(rig.seat).add(_v.set(0, 0.03, 0.02))
    bones[B.hips].quaternion.setFromEuler(this._e.set(-0.18, 0, 0))
    bones[B.chest].quaternion.setFromEuler(this._e.set(-0.42, 0, 0))
    bones[B.head].quaternion.setFromEuler(this._e.set(0.45, 0, 0))
    this.root.updateMatrixWorld(true)
    if (!rig) return
    for (const side of [1, -1] as const) {
      const a = pedal + (side > 0 ? 0 : Math.PI)
      // Pedal on the crank circle (forward pedalling = top of the stroke moves forward, −Z).
      _t.set(side * rig.pedalX, rig.crank.y + rig.crankR * Math.sin(a), rig.crank.z - rig.crankR * Math.cos(a))
      _t.y += 0.085 // ankle above the pedal (toes pointed down)
      this.root.localToWorld(_t)
      _p.set(0, 0.6, -1).transformDirection(this.root.matrixWorld) // knees bend forward/up
      this.ik(side > 0 ? B.thighR : B.thighL, side > 0 ? B.shinR : B.shinL, side > 0 ? B.footR : B.footL, _t, _p)
      bones[side > 0 ? B.footR : B.footL].quaternion.setFromEuler(this._e.set(0.35, 0, 0))
      // Grip on the (steered) handlebar.
      _t.copy(rig.grip).setX(side * Math.abs(rig.grip.x)).applyAxisAngle(_up, steer).add(rig.fork)
      this.root.localToWorld(_t)
      _p.set(side * 0.6, -1, 0.3).transformDirection(this.root.matrixWorld) // elbows out and down
      this.ik(side > 0 ? B.armR : B.armL, side > 0 ? B.foreR : B.foreL, side > 0 ? B.handR : B.handL, _t, _p)
    }
    // Keep the next ground animation blending from here.
    for (let i = 0; i < bones.length; i++) this.target[i].copy(bones[i].quaternion)
  }

  /** Two-bone IK: rotate `upper`/`lower` so the `end` joint reaches `target` (world), bending toward `pole`. */
  private ik(upper: BoneId, lower: BoneId, end: BoneId, target: THREE.Vector3, pole: THREE.Vector3): void {
    const U1 = this.bones[upper], L1 = this.bones[lower]
    const l1 = this.rest[lower].length(), l2 = this.rest[end].length()
    U1.getWorldPosition(_a)
    _d.subVectors(target, _a)
    const dist = Math.min(Math.max(_d.length(), 1e-3), (l1 + l2) * 0.999)
    _d.normalize()
    const cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA))
    _n.crossVectors(_d, pole)
    if (_n.lengthSq() < 1e-8) _n.set(1, 0, 0)
    _b.crossVectors(_n.normalize(), _d).normalize() // in the bend plane, toward the pole
    _e2.copy(_a).addScaledVector(_d, l1 * cosA).addScaledVector(_b, l1 * sinA) // elbow / knee
    const endPos = _t2.copy(_a).addScaledVector(_d, dist)
    this.aim(U1, _dir.subVectors(_e2, _a).normalize(), this.rest[lower])
    U1.updateMatrixWorld(true)
    this.aim(L1, _dir.subVectors(endPos, _e2).normalize(), this.rest[end])
    L1.updateMatrixWorld(true)
  }
  /** Minimal rotation of `bone` so its child offset `rest` (local) points along world `dir`. */
  private aim(bone: THREE.Bone, dir: THREE.Vector3, rest: THREE.Vector3): void {
    bone.parent!.getWorldQuaternion(_q).invert()
    bone.quaternion.setFromUnitVectors(_r.copy(rest).normalize(), dir.applyQuaternion(_q))
  }

  /** World position of the right hand (flashlight origin in TPP). */
  handPosition(out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true)
    return this.bones[B.handR].getWorldPosition(out)
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.mesh.skeleton.dispose()
  }
}

const _v = new THREE.Vector3(), _t = new THREE.Vector3(), _t2 = new THREE.Vector3(), _p = new THREE.Vector3()
const _a = new THREE.Vector3(), _d = new THREE.Vector3(), _n = new THREE.Vector3(), _b = new THREE.Vector3()
const _e2 = new THREE.Vector3(), _dir = new THREE.Vector3(), _r = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _up = new THREE.Vector3(0, 1, 0)

/** Soft round blob shadow (grounds the character on tiers without real dynamic shadows). */
export function createBlobShadow(): THREE.Mesh {
  const size = 64
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) / (size / 2)
      const a = Math.max(0, 1 - r) ** 1.6
      // alphaMap is sampled from the GREEN channel (three.js convention) — write the falloff into RGB too.
      const v = Math.round(a * 255)
      data.set([v, v, v, 255], (y * size + x) * 4)
    }
  }
  const tex = new THREE.DataTexture(data, size, size)
  tex.needsUpdate = true
  const mat = new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: tex, transparent: true, opacity: 0.45, depthWrite: false, fog: true })
  mat.polygonOffset = true
  mat.polygonOffsetFactor = -2
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1).rotateX(-Math.PI / 2), mat)
  mesh.name = 'player-blob-shadow'
  mesh.renderOrder = 1
  return mesh
}
