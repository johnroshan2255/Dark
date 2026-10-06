import * as THREE from 'three'

/**
 * Player character: the stylized human built in Blender (scripts/blender/human.py → human.lod0.glb: one smooth
 * skin-modifier body + head, hair, face, clothes by vertex colour, T-pose, joints exactly at the SRC landmarks),
 * RIGGED IN CODE — 15 bones from those landmarks, every vertex skinned by body region (smooth 2-bone blends at the
 * joints) — and animated procedurally:
 *   idle (breathing), walk ↔ jog ↔ sprint with PLANTED FEET (each foot stays put on the ground during its
 *   stance, two-bone leg IK, hips drop to let the short legs reach, flight phase when running, feet follow the
 *   terrain; footsteps fire on each touchdown — `steps`), arm swing against the legs, lean and twist,
 *   jump (take-off tuck, airborne pose, fall), landing squash, flashlight aim (right arm follows the view),
 *   knockdown (stagger → fall onto the back → lie → sit up on the hands → squat → stand, solved against the
 *   ground so the body never floats or sinks), cycling (two-bone IK: feet on the pedals, hands on the bars).
 * One SkinnedMesh = 1 draw call (the old box character was 5) on the shared vertex-colour material; skinning
 * 1.6k vertices × 16 bones is negligible on any GPU. Faces −Z in local space (camera convention).
 */

/** Source landmarks (metres, facing +Z, +X = the character's left) — = scripts/blender/human.py `L`. */
const SRC = {
  sole: 0, ankle: 0.085, knee: 0.5, hip: 0.9, pelvis: 0.96, chest: 1.26, neck: 1.5, shoulderY: 1.44,
  shoulderX: 0.19, elbowX: 0.465, wristX: 0.705, handX: 0.79, legX: 0.092, zc: 0, height: 1.78,
}
/** Skinning blend widths were tuned in the old model's units (96.67 per body height): scale them to this one. */
const SU = SRC.height / 96.67
/**
 * PROPORTIONS. The source stickman has a head a third of its height and very short legs — next to real-size cars
 * (catalogue: wheelbases match the real vehicles) it read as a 2.5 m giant. The mesh is reshaped at load
 * (`remapY` / head width): legs × LEG_K below the hip joint, the head × HEAD_K above the neck (height and width),
 * torso unchanged — then scaled to HEIGHT: a 1.78 m adult (hip joint ≈ 0.8 m, head ≈ 0.3 m), the same height as
 * the capsule and the 1.62 m first-person eye, so the world's scale is unchanged.
 */
const LEG_K = 1 // (the Blender human is modelled at real proportions — no reshaping)
const HEAD_K = 1
/** Standing height (m). */
const HEIGHT = 1.78
const remapY = (y: number) => (y < SRC.hip ? SRC.hip - (SRC.hip - y) * LEG_K : y > SRC.neck ? SRC.neck + (y - SRC.neck) * HEAD_K : y)
/** Head width factor: 1 below the neck, HEAD_K over the head (a smooth band at the neck). */
const headW = (y: number) => {
  const t = Math.min(1, Math.max(0, (y - (SRC.neck - 1)) / 5))
  return 1 + (HEAD_K - 1) * t * t * (3 - 2 * t)
}
const TOP = SRC.sole + SRC.height
const U = HEIGHT / (remapY(TOP) - remapY(SRC.sole))
/** Source point → final space (m, facing −Z, soles at y = 0), reshaped. */
const toFinal = (x: number, y: number, z: number) => {
  const w = headW(y)
  return new THREE.Vector3(-x * w * U, (remapY(y) - remapY(SRC.sole)) * U, -(z - SRC.zc) * w * U)
}
/** Height of a source landmark above the soles (m, final). */
const Y = (y: number) => (remapY(y) - remapY(SRC.sole)) * U
const BODY_COLOUR = 0xeeeae2
/** Hip joint height (m) standing, ankle above the sole (m), hip→ankle leg length (m), half the hip spacing. */
const HIP_Y = Y(SRC.hip)
const ANKLE_Y = Y(SRC.ankle)
const LEG = HIP_Y - ANKLE_Y
const FOOT_X = SRC.legX * U
/** Head: neck → top (m); its centre above the neck bone and its radius (ground contact probes, eye). */
const HEAD_LEN = Y(TOP) - Y(SRC.neck)
const HEAD_C = HEAD_LEN * 0.5
const HEAD_R = HEAD_LEN * 0.45

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

/** Hips-bone height standing (m above the soles) and the ankle above the sole — car-seat posing (CarEntry). */
export const STAND_HIPS = Y(SRC.pelvis)
export const ANKLE_HEIGHT = ANKLE_Y
/** Hips → top of the head (m): how much headroom a seated body needs at scale 1. */
export const SEATED_HEIGHT = Y(TOP) - Y(SRC.pelvis)
/** Hip joint → ankle (m): seated feet are placed within reach. */
export const LEG_LENGTH = LEG

/** A pose inside / beside a car (CarEntry), everything in CAR space (the root takes the car's frame). */
export interface CarPose {
  /** Hips position. */
  hip: THREE.Vector3
  /** Body yaw (0 = facing the car's front, −Z). */
  yaw: number
  /** 0 standing … 1 seated: spine and (when no foot targets) the legs. */
  sit: number
  /** Chest pitch (+ = leaning back). */
  lean: number
  /** Body scale (a seated cartoon fits a cramped cab) and the head's own scale. */
  scale: number
  head: number
  /** Head turn (rad, + = left). */
  look: number
  /** Ankle / wrist targets (two-bone IK), null = a default pose. */
  footL: THREE.Vector3 | null
  footR: THREE.Vector3 | null
  handL: THREE.Vector3 | null
  handR: THREE.Vector3 | null
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
  private time = 0
  private air = 0
  private land = 0
  private wasGrounded = true
  private runK = 0
  private moveK = 0
  /** Body yaw (smoothed toward movement / aim). */
  yaw = 0
  /** Terrain height (world) for foot placement on slopes; null = flat ground at the player's feet. */
  ground: ((x: number, z: number) => number) | null = null
  /** Foot plants so far (a foot touched down): Game plays a footstep on every new one — sound matches the feet. */
  steps = 0
  /** Each foot plant: where (world x, z) and facing (forward x, z) — footprints in snow and sand (TrailMap). */
  onStep: ((x: number, z: number, fx: number, fz: number) => void) | null = null
  /** Gait cycle (0..1) and the smoothed hip height (m) of the foot-planting locomotion. */
  private cycle = 0
  private hipH = HIP_Y
  /** Knockdown: 'fall' while going down, 'up' while getting up (the pose sequences differ). */
  private knockMode: 'none' | 'fall' | 'up' = 'none'
  private lastKnock = 0

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
    const srcCol = g.getAttribute('color') // the Blender model's clothes / skin / hair (linear, RGB or RGBA)
    const S = SRC
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
      const ax = Math.abs(x)
      const left = x > 0 // source faces +Z → +x is the character's LEFT
      let a: number, b2: number, t: number
      if (y > S.neck + 1.5 * SU) (a = B.head), (b2 = B.head), (t = 0)
      else if (y > S.neck - 1.5 * SU && ax < S.shoulderX) (a = B.chest), (b2 = B.head), (t = (y - (S.neck - 1.5 * SU)) / (3 * SU))
      else if (ax > S.shoulderX + 0.5 * SU && y > S.shoulderY - 7 * SU) {
        const up = left ? B.armL : B.armR, fo = left ? B.foreL : B.foreR, ha = left ? B.handL : B.handR
        if (ax < S.shoulderX + 3.5 * SU) (a = B.chest), (b2 = up), (t = (ax - S.shoulderX - 0.5 * SU) / (3 * SU))
        else if (ax < S.elbowX - 2.5 * SU) (a = up), (b2 = up), (t = 0)
        else if (ax < S.elbowX + 2.5 * SU) (a = up), (b2 = fo), (t = (ax - (S.elbowX - 2.5 * SU)) / (5 * SU))
        else if (ax < S.wristX) (a = fo), (b2 = fo), (t = 0)
        else (a = fo), (b2 = ha), (t = Math.min(1, (ax - S.wristX) / (2 * SU)))
      } else if (y < S.hip + 0.5 * SU) {
        const th = left ? B.thighL : B.thighR, sh = left ? B.shinL : B.shinR, fo = left ? B.footL : B.footR
        if (y > S.hip - 2.5 * SU) (a = B.hips), (b2 = th), (t = (S.hip + 0.5 * SU - y) / (3 * SU))
        else if (y > S.knee + 2 * SU) (a = th), (b2 = th), (t = 0)
        else if (y > S.knee - 2 * SU) (a = th), (b2 = sh), (t = (S.knee + 2 * SU - y) / (4 * SU))
        else if (y > S.ankle + 1 * SU) (a = sh), (b2 = sh), (t = 0)
        else (a = sh), (b2 = fo), (t = Math.min(1, (S.ankle + 1 * SU - y) / (2 * SU)))
      } else if (y < S.pelvis + 6 * SU) (a = B.hips), (b2 = B.hips), (t = 0)
      else if (y > S.chest - 2 * SU) (a = B.chest), (b2 = B.chest), (t = 0)
      else (a = B.hips), (b2 = B.chest), (t = (y - (S.pelvis + 6 * SU)) / (S.chest - 2 * SU - (S.pelvis + 6 * SU)))
      t = smooth(0, 1, t)
      si[i * 4] = a
      si[i * 4 + 1] = b2
      sw[i * 4] = 1 - t
      sw[i * 4 + 1] = t
      const f = toFinal(x, y, z)
      pos.setXYZ(i, f.x, f.y, f.z)
      if (nor) nor.setXYZ(i, -nor.getX(i), nor.getY(i), -nor.getZ(i)) // same 180° turn as the positions
      if (srcCol) (col[i * 3] = srcCol.getX(i)), (col[i * 3 + 1] = srcCol.getY(i)), (col[i * 3 + 2] = srcCol.getZ(i))
      else c.toArray(col, i * 3)
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
  animate(dt: number, pos: THREE.Vector3, targetYaw: number, speed: number, grounded: boolean, aiming: boolean, aimPitch: number, vy = 0, knock = 0, tumble: { angle: number; yaw: number } | null = null): void {
    this.unscale()
    let d = targetYaw - this.yaw
    d = Math.atan2(Math.sin(d), Math.cos(d))
    this.yaw += d * (1 - Math.exp(-12 * dt))
    this.time += dt
    // Walk ↔ run blend (the cadence itself comes from the planted feet: plantFeet).
    this.runK += (smooth(3.9, 6.0, speed) - this.runK) * Math.min(1, dt * 6)
    this.moveK += (smooth(0.15, 1.2, speed) - this.moveK) * Math.min(1, dt * 8)
    // Air / landing timers.
    this.air = grounded ? 0 : this.air + dt
    if (grounded && !this.wasGrounded && this.airTime > 0.25) this.land = 0.22
    this.airTime = grounded ? 0 : this.airTime + dt
    this.wasGrounded = grounded
    this.land = Math.max(0, this.land - dt)

    const r = this.runK, m = this.moveK
    let hipsY = 0
    if (!grounded && this.air > 0.06) {
      // AIRBORNE (Genshin / GTA jump): rising = the lead knee DRIVEN UP, the other leg trailing back, arms swung out
      // to the sides and a little back, chest up; falling = both legs reaching down for the landing (lead knee
      // still bent), arms rising out for balance.
      const fall = smooth(1, -4, vy)
      this.leg(-1, 1.25 - fall * 0.7, 1.7 - fall * 0.95, 0.05, -0.25)
      this.leg(1, -0.25 + fall * 0.35, 0.95 - fall * 0.55, 0.05, 0.35 - fall * 0.2)
      this.arm(1, 0.95 - fall * 0.3, -0.25 + fall * 0.15, 0.55, 0.25)
      this.arm(-1, 0.95 - fall * 0.3, 0.15 + fall * 0.05, 0.55, 0.25)
      this.pose(B.chest, 0.08 - fall * 0.14, 0.12 * (1 - fall))
      this.pose(B.hips, -0.08, -0.08 * (1 - fall))
      this.pose(B.head, 0.12 - fall * 0.2)
    } else {
      // Upper body (legs are placed by foot IK below). WALK / RUN: the pelvis twists with the forward leg and rolls
      // over the stance leg, the chest counter-rotates, the head stays on the horizon (cancels the twist), arms
      // swing against the legs (relaxed in the walk, bent ~90° and driving in the run), forward lean when running.
      // IDLE: weight shifting from leg to leg, breathing in the chest and shoulders, relaxed slightly bent arms.
      const idle = 1 - m
      const breath = Math.sin(this.time * 2.0) * 0.025 * idle
      const shift = Math.sin(this.time * 0.7) // idle weight shift (also moves the hips sideways in plantFeet)
      const ph = this.cycle * Math.PI * 2
      const sw = Math.sin(ph)
      const armSwing = (0.55 + 0.4 * r) * m
      const elbow = (0.28 + 0.05 * shift) * idle + (0.35 + 1.15 * r) * m
      const fwd = 0.06 * idle + 0.12 * r * m // arms carried a little forward (more when running)
      this.arm(1, 1.3 - 0.12 * r + 0.03 * breath * 10, fwd + armSwing * sw, elbow, 0.04 + 0.03 * idle)
      this.arm(-1, 1.3 - 0.12 * r + 0.03 * breath * 10, fwd - armSwing * sw, elbow, 0.04 + 0.03 * idle)
      const hipYaw = -(0.13 + 0.07 * r) * sw * m
      const chestYaw = (0.2 + 0.1 * r) * sw * m
      const roll = 0.045 * sw * m * (1 - 0.5 * r) + 0.035 * shift * idle
      this.pose(B.hips, -0.05 * m - 0.07 * r * m, hipYaw, roll)
      this.pose(B.chest, -0.04 * m - 0.22 * r * m - breath, chestYaw, -roll * 0.8)
      this.pose(B.head, 0.04 * m + 0.16 * r * m + breath * 0.5, -(hipYaw + chestYaw) * 0.8, roll * 0.4 - 0.02 * shift * idle)
      this.leg(-1, 0, 0.08)
      this.leg(1, 0, 0.08)
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
    // BAIL TUMBLE: tucked body rolling forward along the slide (PlayerController.bail).
    if (tumble) {
      this.yaw = tumble.yaw
      this.knockMode = 'fall'
      this.lastKnock = 1
      this.tumblePose(tumble.angle, pos)
      return
    }
    // KNOCKDOWN / GET UP: authored human sequences (knockPose), solved against the ground (see `groundPose`).
    if (knock > 0.001) {
      if (knock > this.lastKnock + 1e-4 && this.knockMode !== 'up') this.knockMode = 'fall'
      else if (knock < this.lastKnock - 1e-4) this.knockMode = 'up'
      this.lastKnock = knock
      this.knockPose(knock)
      this.commit(1)
      this.groundPose(pos)
      return
    }
    this.knockMode = 'none'
    this.lastKnock = 0
    this.commit(1 - Math.exp(-16 * dt))
    this.root.position.copy(pos)
    this.root.rotation.set(0, this.yaw, 0)
    if (!grounded && this.air > 0.06) {
      this.bones[B.hips].position.set(this.rest[B.hips].x, this.rest[B.hips].y + hipsY, this.rest[B.hips].z)
      return
    }
    this.plantFeet(dt, pos, speed, hipsY)
  }

  /**
   * FOOT-PLANTING LOCOMOTION. Each foot is PLANTED on the ground during its stance (it moves backward under the
   * body at exactly the body's speed — no skating) and swings forward in an arc in between; two-bone IK bends
   * the leg to reach it and the hips drop just enough for the legs to reach (they are short: 0.41 m), so the
   * walk bobs and the run bounces with a flight phase. Gait from the speed: walk (stance 62 % of the cycle,
   * 0.38 m step) → jog (40 %, 0.5 m) → sprint (30 %, 0.56 m). On slopes the feet follow the terrain (`ground`).
   */
  private plantFeet(dt: number, pos: THREE.Vector3, speed: number, extraHipY: number): void {
    const m = this.moveK
    const v = Math.max(speed, 0.6 * m)
    const beta = v < 1.5 ? 0.62 : v < 3.6 ? 0.62 - (v - 1.5) / 2.1 * 0.22 : Math.max(0.3, 0.4 - (v - 3.6) / 2.9 * 0.1)
    const S = Math.min(0.95, 0.34 + v * 0.1) * m // step: how far a planted foot travels under the body (0.8 m legs: long run strides)
    const strideLen = Math.max(0.2, S / beta)
    const prevCycle = this.cycle
    this.cycle = (this.cycle + (v * dt) / strideLen) % 1
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw)
    const fwdX = -sy, fwdZ = -cy, rightX = cy, rightZ = -sy
    let hip = HIP_Y
    const targets: [number, number, number, number][] = [] // world x, y, z, swing (0 = planted)
    for (const side of [-1, 1] as const) {
      const off = side < 0 ? 0 : 0.5
      const c = (this.cycle + off) % 1
      const cPrev = (prevCycle + off) % 1
      const touchdown = c < cPrev && m > 0.35 && speed > 0.4 // a new stance begins
      let fz: number, lift = 0
      // FOOT ROLL (+ = toes down): heel strike (toes up) → flat → heel off / toe push at the end of the stance; in
      // the swing the toes trail down, then come up again to meet the ground heel first.
      let roll = 0
      if (c < beta) {
        const k = c / beta
        fz = S / 2 - S * k
        roll = (-0.32 * (1 - smooth(0, 0.22, k)) + 0.5 * smooth(0.62, 1, k)) * m
      } else {
        const t = (c - beta) / (1 - beta)
        fz = -S / 2 + S * (0.5 - 0.5 * Math.cos(Math.PI * t))
        // Swing height: a low walk step, a high run (knee drive + heel kicked up behind, early in the swing).
        lift = (0.06 * Math.sin(Math.PI * t) + 0.26 * this.runK * Math.sin(Math.PI * Math.pow(t, 0.75))) * m

        roll = (0.5 * (1 - smooth(0, 0.55, t)) - 0.32 * smooth(0.7, 1, t)) * m
      }
      // Heel up at the push-off: the foot pivots on its ball, so the ankle rises (no toes through the ground).
      lift += 0.11 * Math.sin(Math.max(0, roll)) * (c < beta ? 1 : 1 - smooth(0, 0.4, (c - beta) / (1 - beta)))
      const lx = side * FOOT_X * 0.9
      const wx = pos.x + rightX * lx + fwdX * fz, wz = pos.z + rightZ * lx + fwdZ * fz
      if (touchdown) {
        this.steps++
        this.onStep?.(wx, wz, fwdX, fwdZ)
      }
      const gy = (this.ground ? this.ground(wx, wz) : pos.y) - pos.y // terrain under the foot (root-local)
      const fy = gy + ANKLE_Y + lift
      // Highest hip that still lets this leg reach its foot (with 3 % slack so the knee keeps a little bend).
      const reach = LEG * 0.97
      hip = Math.min(hip, fy + Math.sqrt(Math.max(0, reach * reach - fz * fz)))
      targets.push([wx, pos.y + fy, wz, roll])
    }
    // Hips: never above standing; smoothed (the landing / stance compression reads as a soft bob).
    this.hipH += (hip - this.hipH) * (1 - Math.exp(-dt * 30))
    const hipsY = this.hipH - HIP_Y + extraHipY
    // Idle: the weight shifts from leg to leg (hips sway sideways over the planted feet; the IK bends the knee).
    const sway = 0.022 * Math.sin(this.time * 0.7) * (1 - m)
    this.bones[B.hips].position.set(this.rest[B.hips].x + sway, this.rest[B.hips].y + hipsY, this.rest[B.hips].z)
    this.root.updateMatrixWorld(true)
    _p.set(fwdX, 0.15, fwdZ) // knees bend forward
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1
      const [x, y, z, roll] = targets[i]
      const th = side > 0 ? B.thighR : B.thighL, sh = side > 0 ? B.shinR : B.shinL, ft = side > 0 ? B.footR : B.footL
      this.ik(th, sh, ft, _t.set(x, y, z), _p)
      // Foot flat on the ground (cancel the leg's rotation), toes dipping a little as it swings through.
      this.bones[sh].getWorldQuaternion(_q).invert()
      this.root.getWorldQuaternion(_q2)
      this.bones[ft].quaternion.copy(_q).multiply(_q2).multiply(_q3.setFromAxisAngle(_xAxis, roll))
      for (const id of [th, sh, ft]) this.target[id].copy(this.bones[id].quaternion)
    }
  }

  /**
   * Forward roll: arms wrapped in, knees tucked to the chest, chin down; the whole body pitched forward by `angle`
   * about its right axis (yaw = slide direction). Centred on the hips over `pos`, lowest point on the ground.
   * In the last quarter-turn before lying on the back the limbs open out toward the supine pose.
   */
  private tumblePose(angle: number, pos: THREE.Vector3): void {
    const S = CharacterModel.KP.supine
    const a = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
    const open = angle > Math.PI * 2 ? smooth(Math.PI * 2 - 2.6, Math.PI * 2 - 1.5, a) : 0 // unfold onto the back
    const mix = (tuck: number, sup: number) => tuck + (sup - tuck) * open
    this.pose(B.chest, mix(-0.7, S.chest))
    this.pose(B.head, mix(-0.5, S.head))
    this.pose(B.hips, mix(-0.3, S.hips))
    this.leg(-1, mix(1.9, S.thL), mix(2.2, S.knL), mix(0.08, S.spread))
    this.leg(1, mix(1.8, S.thR), mix(2.1, S.knR), mix(0.08, S.spread))
    this.arm(1, mix(0.9, S.aDown), mix(1.1, S.aFwd), mix(1.6, S.aBend), mix(0.1, S.aOut))
    this.arm(-1, mix(0.95, S.aDown), mix(1.0, S.aFwd), mix(1.6, S.aBend), mix(0.12, S.aOut))
    this.bones[B.hips].position.copy(this.rest[B.hips])
    this.commit(1)
    const R = this.root
    R.rotation.set(-angle, this.yaw, 0) // − = pitching FORWARD (head first) about the body's right axis
    R.position.copy(pos)
    R.updateMatrixWorld(true)
    // Centre the roll on the hips (not the feet), then rest the lowest part on the ground.
    this.bones[B.hips].getWorldPosition(_a)
    R.position.x += pos.x - _a.x
    R.position.z += pos.z - _a.z
    R.updateMatrixWorld(true)
    let low = Infinity
    const probe = (id: BoneId, r: number, up = 0) => {
      if (up) this.bones[id].localToWorld(_t.set(0, up, 0))
      else this.bones[id].getWorldPosition(_t)
      low = Math.min(low, _t.y - r)
    }
    probe(B.footL, ANKLE_Y); probe(B.footR, ANKLE_Y); probe(B.handL, 0.05); probe(B.handR, 0.05)
    probe(B.hips, 0.13); probe(B.chest, 0.15); probe(B.head, HEAD_R, HEAD_C)
    const g = this.ground ? this.ground(pos.x, pos.z) : pos.y
    R.position.y += Math.max(g, pos.y) - low // on the ground (in the hop out of the door: at the player's height)
    R.updateMatrixWorld(true)
  }

  /** Pose keyframes of the fall and the get-up (blended by `knockPose`). */
  private static readonly KP = {
    stand: { tilt: 0, chest: 0, head: 0, hips: 0, thL: 0, knL: 0.06, thR: 0, knR: 0.06, spread: 0.03, aDown: 1.35, aFwd: 0, aBend: 0.2, aOut: 0.05 },
    // Hit: the knees buckle, the body folds forward over the blow, arms fly up.
    stagger: { tilt: 0.3, chest: -0.45, head: -0.25, hips: -0.2, thL: 0.5, knL: 0.9, thR: 0.25, knR: 0.6, spread: 0.08, aDown: 0.55, aFwd: 1.0, aBend: 0.5, aOut: 0.3 },
    // On the back: knees raised with the feet on the ground, arms lying alongside, head resting.
    // (Angles are body-relative: a body tilted back by t points its thighs t further forward/up in the world.)
    supine: { tilt: 1.5, chest: 0.05, head: 0.15, hips: 0, thL: 0.75, knL: 1.2, thR: 0.35, knR: 0.5, spread: 0.12, aDown: 1.3, aFwd: 0.1, aOut: 0.45, aBend: 0.25 },
    // Sit up: torso raised ~35° off the ground, hands planted on the ground behind, knees drawn up, feet flat.
    sit: { tilt: 0.95, chest: -0.35, head: 0.25, hips: -0.1, thL: 1.15, knL: 1.8, thR: 1.0, knR: 1.6, spread: 0.1, aDown: 1.2, aFwd: -1.5, aBend: 0.05, aOut: 0.2 },
    // Rock forward onto the feet: a deep squat (knees ahead of the feet), arms reaching forward for balance.
    squat: { tilt: -0.3, chest: -0.35, head: 0.35, hips: -0.15, thL: 1.95, knL: 2.1, thR: 1.95, knR: 2.1, spread: 0.1, aDown: 1.1, aFwd: 0.8, aBend: 0.45, aOut: 0.1 },
    // Push up through the legs, torso still forward.
    rise: { tilt: -0.18, chest: -0.2, head: 0.2, hips: -0.05, thL: 0.9, knL: 1.15, thR: 0.9, knR: 1.15, spread: 0.06, aDown: 1.25, aFwd: 0.3, aBend: 0.3, aOut: 0.08 },
  }

  /** Current knockdown pose: fall = stand → stagger → supine (knock 0 → 1, the impact overshoot > 1 is a thump);
   *  get up = supine → sit up → squat → rise → stand (knock 1 → 0). */
  private knockPose(knock: number): void {
    const K = CharacterModel.KP
    type P = typeof K.stand
    const seq: [number, P][] = this.knockMode === 'up'
      ? [[0, K.supine], [0.3, K.sit], [0.58, K.squat], [0.82, K.rise], [1, K.stand]]
      : [[0, K.stand], [0.3, K.stagger], [1, K.supine]]
    const x = this.knockMode === 'up' ? 1 - Math.min(1, knock) : Math.min(1, knock)
    let i = 0
    while (i < seq.length - 2 && x > seq[i + 1][0]) i++
    const [x0, a] = seq[i], [x1, b] = seq[i + 1]
    const t = smooth(0, 1, (x - x0) / (x1 - x0))
    const L = (k: keyof P) => a[k] + (b[k] - a[k]) * t
    const thump = Math.max(0, knock - 1) // impact overshoot: chest and head bounce
    this.root.rotation.set(L('tilt'), this.yaw, 0) // + = tipped BACKWARD (head toward +Z, behind the facing direction)
    this.pose(B.chest, L('chest') - thump * 0.6)
    this.pose(B.head, L('head') - thump * 0.8)
    this.pose(B.hips, L('hips'))
    this.leg(-1, L('thL'), L('knL'), L('spread'), -0.3 * L('knL') * 0.3)
    this.leg(1, L('thR'), L('knR'), L('spread'), -0.3 * L('knR') * 0.3)
    this.arm(1, L('aDown'), L('aFwd'), L('aBend'), L('aOut'))
    this.arm(-1, L('aDown') + 0.08, L('aFwd') * 0.9, L('aBend'), L('aOut') * 1.1)
    this.bones[B.hips].position.copy(this.rest[B.hips])
  }

  /**
   * Put the posed body ON the ground: the lowest body part (feet, hands, pelvis, back, the big head — each with
   * its thickness) rests on the terrain, and the feet stay where the player stands (a body falling back lands
   * behind its feet; getting up, the hips come forward over them) — no floating, no sinking, no sliding.
   */
  private groundPose(pos: THREE.Vector3): void {
    const R = this.root
    R.position.copy(pos)
    R.updateMatrixWorld(true)
    const b = this.bones
    // Feet anchor: midpoint of the ankles → the player's position (horizontal).
    b[B.footL].getWorldPosition(_a)
    b[B.footR].getWorldPosition(_d)
    R.position.x += pos.x - (_a.x + _d.x) / 2
    R.position.z += pos.z - (_a.z + _d.z) / 2
    R.updateMatrixWorld(true)
    let low = Infinity
    const probe = (id: BoneId, r: number, up = 0) => {
      if (up) b[id].localToWorld(_t.set(0, up, 0))
      else b[id].getWorldPosition(_t)
      low = Math.min(low, _t.y - r)
    }
    probe(B.footL, ANKLE_Y)
    probe(B.footR, ANKLE_Y)
    probe(B.handL, 0.05)
    probe(B.handR, 0.05)
    probe(B.hips, 0.13)
    probe(B.chest, 0.15)
    probe(B.head, HEAD_R, HEAD_C)
    const g = this.ground ? this.ground(pos.x, pos.z) : pos.y
    R.position.y += g - low
    R.updateMatrixWorld(true)
  }
  private airTime = 0

  /**
   * Riding pose on the BMX: seated, feet ON the turning pedals and hands ON the steering bars (two-bone IK),
   * leaning forward and into turns with the bike. `pedal` = crank angle, `steer` = fork angle (rad).
   */
  ride(pos: THREE.Vector3, heading: number, pedal: number, lean: number, rig?: RideRig, steer = 0, bikeQ?: THREE.Quaternion): void {
    this.unscale()
    this.yaw = heading
    this.root.position.copy(pos)
    // The rider sits in the bike's frame: its full simulated orientation (lean, pitch on slopes) when given.
    if (bikeQ) this.root.quaternion.copy(bikeQ)
    else this.root.rotation.set(0, heading, lean, 'YXZ')
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

  /**
   * In / beside a car (CarEntry: open the door, climb in, sit and steer, climb out): the root takes the car's world
   * frame `carM` (and the body scale), the hips go to `o.hip` (car space) turned by `o.yaw`, the spine bends with
   * `sit`/`lean`, and hands / feet reach their car-space targets by two-bone IK (else a default arm / seated leg).
   */
  carPose(carM: THREE.Matrix4, o: CarPose): void {
    const R = this.root, b = this.bones, s = o.scale
    carM.decompose(R.position, R.quaternion, _v)
    R.scale.setScalar(s)
    for (const x of b) x.quaternion.identity()
    b[B.head].scale.setScalar(o.head)
    b[B.hips].position.copy(o.hip).divideScalar(s)
    b[B.hips].quaternion.setFromEuler(this._e.set(-0.12 * o.sit, o.yaw, 0, 'YXZ'))
    b[B.chest].quaternion.setFromEuler(this._e.set(o.lean - 0.05 * o.sit, 0, 0))
    // Leaning back: the head compensates (eyes on the road); ducking forward: it bows with the chest.
    b[B.head].quaternion.setFromEuler(this._e.set(0.08 * o.sit - Math.max(0, o.lean) * 0.6 + Math.min(0, o.lean) * 0.35, o.look, 0, 'YXZ'))
    // Default limbs: seated legs (thighs forward, shins down) / standing legs, arms hanging.
    const legs = (side: 1 | -1) => this.leg(side, 1.5 * o.sit, 1.45 * o.sit, 0.06 + 0.06 * o.sit)
    legs(-1)
    legs(1)
    this.arm(1, 1.3, 0.25 * o.sit, 0.35 + 0.5 * o.sit, 0.05)
    this.arm(-1, 1.3, 0.25 * o.sit, 0.35 + 0.5 * o.sit, 0.05)
    for (const id of [B.thighL, B.shinL, B.footL, B.thighR, B.shinR, B.footR, B.armL, B.foreL, B.armR, B.foreR]) b[id].quaternion.copy(this.target[id])
    R.updateMatrixWorld(true)
    const sy = Math.sin(o.yaw), cy = Math.cos(o.yaw)
    // Knees bend forward (and up when seated); elbows down and out.
    _p.set(-sy, 0.25 + 0.5 * o.sit, -cy).transformDirection(R.matrixWorld)
    for (const [side, t] of [[-1, o.footL], [1, o.footR]] as const) {
      if (!t) continue
      this.ik(side > 0 ? B.thighR : B.thighL, side > 0 ? B.shinR : B.shinL, side > 0 ? B.footR : B.footL, _t.copy(t).applyMatrix4(carM), _p)
      // Foot flat in the car's frame.
      b[side > 0 ? B.shinR : B.shinL].getWorldQuaternion(_q).invert()
      b[side > 0 ? B.footR : B.footL].quaternion.copy(_q).multiply(R.quaternion).multiply(_q3.setFromAxisAngle(_up, o.yaw))
    }
    for (const [side, t] of [[-1, o.handL], [1, o.handR]] as const) {
      if (!t) continue
      _p.set(side * cy * 0.25 - sy * 0.2, -1, -side * sy * 0.25 - cy * 0.2).transformDirection(R.matrixWorld) // elbows down (not out through the window)
      this.ik(side > 0 ? B.armR : B.armL, side > 0 ? B.foreR : B.foreL, side > 0 ? B.handR : B.handL, _t.copy(t).applyMatrix4(carM), _p)
    }
    // The next on-foot frame blends from here.
    for (let i = 0; i < b.length; i++) this.target[i].copy(b[i].quaternion)
    this.yaw = Math.atan2(-_v.set(-sy, 0, -cy).applyQuaternion(R.quaternion).x, -_v.z)
  }

  /** World position of the head (FPP eye while getting in / out). */
  headPosition(out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true)
    return this.bones[B.head].localToWorld(out.set(0, HEAD_C * 0.9, -HEAD_R * 0.5))
  }

  /** Back to normal size (after a car seat). */
  private unscale(): void {
    if (this.root.scale.x !== 1) this.root.scale.setScalar(1)
    this.bones[B.head].scale.setScalar(1)
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
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion()
const _up = new THREE.Vector3(0, 1, 0)
const _xAxis = new THREE.Vector3(1, 0, 0)

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
