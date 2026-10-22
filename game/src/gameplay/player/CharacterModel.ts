import * as THREE from 'three'
import type { HeroAsset } from '../../assets/loadModels'

/**
 * Player character: the hero (hero.lod0.glb — scripts/blender/hero/: the AI-generated body with a rebuilt face and
 * modelled hands, auto-rigged in Mixamo: 65 bones incl. fingers, 15 k tris, one 1024² albedo) animated two ways:
 *
 *  CLIPS (Mixamo, in the GLB): idle; walk → jog → run → sprint blended by speed on ONE shared foot phase (each clip's
 *   own left-foot touchdown aligned, stride lengths measured from the clips → no foot sliding at any speed); walk
 *   backwards / strafe left / right blended in by the direction of travel relative to the facing (flashlight aiming
 *   while moving); jump → fall; a landing clip after long falls (a squash after short hops); knockdown → get up
 *   (driven by the `knock` value). Layered on top: feet on the terrain (two-bone leg IK, hips drop to let the low
 *   foot reach), the flashlight arm (right arm follows the view), footsteps from the shared phase.
 *  PROCEDURAL (the 15-bone driver rig below, unchanged from the stylized human): seated + steering + door IK in
 *   cars (`carPose`), pedalling on the BMX (`ride`), the bail tumble — RETARGETED onto the Mixamo bones every frame
 *   (per-bone rest-direction corrections, spine spread over three bones).
 * Switching between the two blends the pose over ~0.2 s. One SkinnedMesh = 1 draw call; 65 bones (bone texture).
 * Faces −Z in local space (camera convention).
 */

/** Joint landmarks (metres; final space: facing −Z, +X = the character's right, soles at y = 0), measured from the
 *  Mixamo skeleton in hero.lod0.glb at rest. The driver rig uses them in a T-pose. */
const J = {
  pelvis: new THREE.Vector3(0, 0.9807, -0.045),
  hipX: 0.107, hipY: 0.9287, hipZ: -0.046,
  chest: new THREE.Vector3(0, 1.3085, 0.005),
  neck: new THREE.Vector3(0, 1.449, 0.027),
  top: 1.774,
  shoulderX: 0.23, shoulderY: 1.49, shoulderZ: 0.027,
  upperArm: 0.2316, foreArm: 0.199,
  thigh: 0.4023, shin: 0.409,
  /** Ankle joint above the sole (the mesh's). */
  ankle: 0.124,
}
/** Ankle above the sole (m), hip→ankle leg length (m). */
const ANKLE_Y = J.ankle
const LEG = J.thigh + J.shin
/** Head: neck → top (m); its centre above the neck bone and its radius (ground contact probes). */
const HEAD_LEN = J.top - J.neck.y
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
export const STAND_HIPS = J.pelvis.y
export const ANKLE_HEIGHT = ANKLE_Y
/** Hips → top of the head (m): how much headroom a seated body needs at scale 1. */
export const SEATED_HEIGHT = J.top - J.pelvis.y
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
  /** Body scale (a seated body fits a cramped cab) and the head's own scale. */
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

/**
 * The Mixamo clips: loop cycle length (s; the jog clip holds 3 cycles), left-foot touchdown as a fraction of the
 * cycle, and the ground speed (m/s) its feet move at — measured from the foot bones in Blender (scripts/blender/hero).
 */
const LOCO = {
  walk: { cycles: 1, td: 0.237, speed: 0.98 },
  jog: { cycles: 3, td: 0.231, speed: 1.5 },
  run: { cycles: 1, td: 0.318, speed: 3.6 },
  sprint: { cycles: 1, td: 0.294, speed: 5.4 },
  walk_back: { cycles: 1, td: 0.304, speed: 0.45 },
  strafe_left: { cycles: 1, td: 0.3125, speed: 1.7 },
  strafe_right: { cycles: 1, td: 0.219, speed: 1.7 },
} as const
type Loco = keyof typeof LOCO
const FORWARD: Loco[] = ['walk', 'jog', 'run', 'sprint']
const CLIPS = ['idle', 'walk', 'jog', 'run', 'sprint', 'walk_back', 'strafe_left', 'strafe_right', 'jump', 'fall', 'land', 'knockdown', 'get_up'] as const
type Clip = (typeof CLIPS)[number]
/** Jumping Up: take-off (the crouch before it is skipped — the capsule leaves at once). Falling To Landing: the
 *  feet touch down here. Hips height held while airborne in the jump clip (its own rises 0.5 m with the body). */
const JUMP_T0 = 0.43
const LAND_T0 = 0.3
const AIR_HIPS = 0.96
/** Retarget map: Mixamo bone ← driver bone (or a blend of driver bones for the extra spine / neck / clavicles). */
type Src = BoneId | 'spine0' | 'spine1' | 'neck' | 'clavicle'
const MAP: [string, Src][] = [
  ['Hips', B.hips], ['Spine', 'spine0'], ['Spine1', 'spine1'], ['Spine2', B.chest], ['Neck', 'neck'], ['Head', B.head],
  ['LeftShoulder', 'clavicle'], ['RightShoulder', 'clavicle'],
  ['LeftArm', B.armL], ['LeftForeArm', B.foreL], ['LeftHand', B.handL],
  ['RightArm', B.armR], ['RightForeArm', B.foreR], ['RightHand', B.handR],
  ['LeftUpLeg', B.thighL], ['LeftLeg', B.shinL], ['LeftFoot', B.footL],
  ['RightUpLeg', B.thighR], ['RightLeg', B.shinR], ['RightFoot', B.footR],
]
/** Limb bone → its child, for rest-direction corrections (hands and feet keep their parent's / their own rest). */
const CHILD: Record<string, string> = {
  LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', RightArm: 'RightForeArm', RightForeArm: 'RightHand',
  LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', RightUpLeg: 'RightLeg', RightLeg: 'RightFoot',
}

export class CharacterModel {
  readonly root = new THREE.Group()
  private readonly mesh: THREE.SkinnedMesh
  private readonly mixer: THREE.AnimationMixer
  private readonly actions = new Map<Clip, THREE.AnimationAction>()
  private readonly weights = new Map<Clip, number>()
  /** Mixamo bones by short name ('Hips', 'LeftHand', …) and in hierarchy order. */
  private readonly mx = new Map<string, THREE.Bone>()
  private readonly mxOrder: THREE.Bone[] = []
  /** Driver rig (procedural poses) — never rendered. */
  private readonly bones: THREE.Bone[] = []
  private readonly rest: THREE.Vector3[] = []
  private readonly target: THREE.Quaternion[] = []
  /** Retarget data per Mixamo bone: rest world rotation (root at identity), rest-direction correction, rest local. */
  private readonly rm0 = new Map<THREE.Bone, THREE.Quaternion>()
  private readonly corr = new Map<THREE.Bone, THREE.Quaternion>()
  private readonly restLocal = new Map<THREE.Bone, THREE.Quaternion>()
  private readonly hipsOffset = new THREE.Vector3()
  private readonly hipsRestPos = new THREE.Vector3()
  /** Eye point in the Head bone's space (FPP eye while getting in / out). */
  private readonly eyeLocal = new THREE.Vector3()
  /** Get-up clip: its hips end this far (root space, xz) from the rest — subtracted so the body stands up on the spot. */
  private readonly getUpEnd = new THREE.Vector3()
  /** TOW GESTURES (hero_tow_clips.glb, added when loaded: `addClips`): a one-shot clip over the whole body — taking a
   *  hook off a bumper, hanging it on a tree strap / another car's hook — faded in and out over the locomotion. With
   *  a REACH target the body turns to face it and the right hand is pulled onto it (arm IK) around the clip's grab
   *  moment, so the hand really meets the hook whatever its height. CARRYING (a hook in the right hand): that arm
   *  hangs by the side a little behind the hip, the line trailing back, while the legs walk on (arm IK). */
  private readonly extra = new Map<string, THREE.AnimationAction>()
  private gesture: { parts: { a: THREE.AnimationAction; scale: number; end: number; w: number }[]; real: number; len: number; reach: { target: THREE.Vector3; at: number } | null } | null = null
  private gestureW = 0
  private carryK = 0
  /** A hook in the right hand (TowSystem). */
  carrying = false
  /** Pose blend across mode switches (clips ⇄ procedural). */
  private mode: 'clip' | 'proc' = 'clip'
  private blendT = 0
  private readonly snapQ = new Map<THREE.Bone, THREE.Quaternion>()
  private readonly snapHips = new THREE.Vector3()

  private time = 0
  private air = 0
  private airTime = 0
  /** Fastest downward speed (m/s, negative) since leaving the ground. */
  private fallVy = 0
  private land = 0
  private landT = -1
  private jumpT = -1
  private fallT = 0
  private wasGrounded = true
  private moveK = 0
  private aimK = 0
  /** Shared locomotion phase (0 = left foot touchdown, 0.5 = right). */
  private phase = 0
  private readonly lastPos = new THREE.Vector3(Number.NaN, 0, 0)
  private readonly vel = new THREE.Vector2()
  /** Body yaw (smoothed toward movement / aim). */
  yaw = 0
  /** Terrain height (world) for foot placement on slopes; null = flat ground at the player's feet. */
  ground: ((x: number, z: number) => number) | null = null
  /** Foot plants so far (a foot touched down): Game plays a footstep on every new one — sound matches the feet. */
  steps = 0
  /** Each foot plant: where (world x, z) and facing (forward x, z) — footprints in snow and sand (TrailMap). */
  onStep: ((x: number, z: number, fx: number, fz: number) => void) | null = null
  /** Knockdown: 'fall' while going down, 'up' while getting up. */
  private knockMode: 'none' | 'fall' | 'up' = 'none'
  private lastKnock = 0

  constructor(material: THREE.Material, asset: HeroAsset) {
    this.root.name = 'player-character'
    this.root.rotation.order = 'YXZ' // the tumble pitches relative to facing
    // --- the Mixamo model: faces +Z in glTF → turned to face −Z --------------------------------------------------
    const model = asset.scene
    model.rotation.y = Math.PI
    let mesh: THREE.SkinnedMesh | null = null
    model.traverse((o) => {
      const sm = o as THREE.SkinnedMesh
      if (sm.isSkinnedMesh && !mesh) mesh = sm
      const b = o as THREE.Bone
      if (b.isBone) {
        const short = b.name.replace(/^mixamorig:?/, '')
        this.mx.set(short, b)
      }
    })
    if (!mesh) throw new Error('hero.lod0.glb: no skinned mesh')
    this.mesh = mesh
    this.mesh.material = material
    this.mesh.name = 'character'
    this.mesh.frustumCulled = false // poses leave the bind-pose bounds; the player is always near the camera
    this.mesh.castShadow = false
    this.mxOrder.push(...this.mesh.skeleton.bones)
    const depth = (o: THREE.Object3D) => { let d = 0; for (let p = o.parent; p; p = p.parent) d++; return d }
    this.mxOrder.sort((a, b) => depth(a) - depth(b))
    this.root.add(model)
    // --- driver rig (T-pose, identity rotations), measured landmarks ------------------------------------------
    const at: [BoneId, BoneId | -1, THREE.Vector3][] = [
      [B.hips, -1, J.pelvis.clone()],
      [B.chest, B.hips, J.chest.clone()],
      [B.head, B.chest, J.neck.clone()],
    ]
    for (const side of [-1, 1] as const) {
      const s = new THREE.Vector3(side * J.shoulderX, J.shoulderY, J.shoulderZ)
      const e = s.clone().add(new THREE.Vector3(side * J.upperArm, 0, 0))
      const w = e.clone().add(new THREE.Vector3(side * J.foreArm, 0, 0))
      const h = new THREE.Vector3(side * J.hipX, J.hipY, J.hipZ)
      const k = h.clone().add(new THREE.Vector3(0, -J.thigh, 0))
      const a = k.clone().add(new THREE.Vector3(0, -J.shin, 0))
      const L = side < 0
      at.push([L ? B.armL : B.armR, B.chest, s], [L ? B.foreL : B.foreR, L ? B.armL : B.armR, e], [L ? B.handL : B.handR, L ? B.foreL : B.foreR, w])
      at.push([L ? B.thighL : B.thighR, B.hips, h], [L ? B.shinL : B.shinR, L ? B.thighL : B.thighR, k], [L ? B.footL : B.footR, L ? B.shinL : B.shinR, a])
    }
    const world: THREE.Vector3[] = []
    for (const [id, parent, p] of at) {
      const b = new THREE.Bone()
      b.name = 'drv-' + Object.keys(B)[id]
      world[id] = p
      b.position.copy(parent < 0 ? p : p.clone().sub(world[parent]))
      this.bones[id] = b
      this.rest[id] = b.position.clone()
      this.target[id] = new THREE.Quaternion()
      if (parent >= 0) this.bones[parent].add(b)
    }
    const drv = new THREE.Group()
    drv.name = 'driver-rig'
    drv.add(this.bones[B.hips])
    this.root.add(drv)
    this.root.updateMatrixWorld(true)
    // --- retarget data (root at identity, model in its bind pose) ---------------------------------------------
    const m = (n: string) => this.mx.get(n)!
    for (const b of this.mxOrder) {
      this.rm0.set(b, b.getWorldQuaternion(new THREE.Quaternion()))
      this.restLocal.set(b, b.quaternion.clone())
      this.snapQ.set(b, new THREE.Quaternion())
    }
    const drvDir = (id: BoneId, child: BoneId) => world[child].clone().sub(world[id]).normalize()
    const limb: [string, BoneId, BoneId][] = [
      ['LeftArm', B.armL, B.foreL], ['LeftForeArm', B.foreL, B.handL], ['RightArm', B.armR, B.foreR], ['RightForeArm', B.foreR, B.handR],
      ['LeftUpLeg', B.thighL, B.shinL], ['LeftLeg', B.shinL, B.footL], ['RightUpLeg', B.thighR, B.shinR], ['RightLeg', B.shinR, B.footR],
    ]
    for (const [name, id, child] of limb) {
      const bn = m(name), c = m(CHILD[name])
      const dm = c.getWorldPosition(new THREE.Vector3()).sub(bn.getWorldPosition(new THREE.Vector3())).normalize()
      this.corr.set(bn, new THREE.Quaternion().setFromUnitVectors(dm, drvDir(id, child)))
    }
    this.corr.set(m('LeftHand'), this.corr.get(m('LeftForeArm'))!.clone())
    this.corr.set(m('RightHand'), this.corr.get(m('RightForeArm'))!.clone())
    m('Hips').getWorldPosition(this.hipsRestPos)
    this.hipsOffset.copy(this.hipsRestPos).sub(J.pelvis)
    m('Head').worldToLocal(this.eyeLocal.set(0, 1.62, -0.1))
    // --- clips: rotations only (+ the hips position); scale and other translations are constant -----------------
    this.mixer = new THREE.AnimationMixer(model)
    const hipsTrack = m('Hips').name + '.position'
    for (const c of asset.clips) {
      const name = c.name as Clip
      if (!(CLIPS as readonly string[]).includes(name)) continue
      c.tracks = c.tracks.filter((t) => t.name.endsWith('.quaternion') || t.name === hipsTrack)
      const a = this.mixer.clipAction(c)
      a.setLoop(name === 'jump' || name === 'land' || name === 'knockdown' || name === 'get_up' ? THREE.LoopOnce : THREE.LoopRepeat, Infinity)
      a.clampWhenFinished = true
      a.timeScale = 0 // times are set explicitly every frame (shared phase, knock-driven clips)
      a.play()
      a.setEffectiveWeight(0)
      this.actions.set(name, a)
      this.weights.set(name, 0)
    }
    for (const c of CLIPS) if (!this.actions.has(c)) throw new Error(`hero.lod0.glb: missing clip "${c}"`)
    this.weights.set('idle', 1)
    // Where the get-up clip leaves the hips (so it can be anchored to the spot).
    const gu = this.actions.get('get_up')!
    this.setWeightsOnly('get_up')
    gu.time = gu.getClip().duration
    this.mixer.update(0)
    this.root.updateMatrixWorld(true)
    m('Hips').getWorldPosition(this.getUpEnd).sub(this.hipsRestPos)
    this.getUpEnd.y = 0
    this.setWeightsOnly('idle')
    this.mixer.update(0)
  }

  set castShadow(v: boolean) {
    this.mesh.castShadow = v
  }

  // ---- clip playback ------------------------------------------------------------------------------------------
  private setWeightsOnly(c: Clip): void {
    for (const k of CLIPS) {
      this.weights.set(k, k === c ? 1 : 0)
      this.actions.get(k)!.setEffectiveWeight(k === c ? 1 : 0)
    }
  }
  /** Ease every clip weight toward its target (cross-fades) and normalise to 1 (no bind-pose bleed). */
  private applyWeights(tw: Partial<Record<Clip, number>>, dt: number, rate: number): void {
    const k = 1 - Math.exp(-rate * dt)
    let sum = 0
    for (const c of CLIPS) {
      const w = this.weights.get(c)! + ((tw[c] ?? 0) - this.weights.get(c)!) * k
      this.weights.set(c, w)
      sum += w
    }
    const g = this.gestureW
    for (const c of CLIPS) {
      const w = (sum > 1e-6 ? this.weights.get(c)! / sum : c === 'idle' ? 1 : 0) * (1 - g)
      const a = this.actions.get(c)!
      a.enabled = w > 1e-3
      a.setEffectiveWeight(w)
    }
    for (const a of this.extra.values()) {
      const w = (this.gesture?.parts.find((p) => p.a === a)?.w ?? 0) * g
      a.enabled = w > 1e-3
      a.setEffectiveWeight(w)
    }
  }

  /** The tow clips (loadHeroTowClips): gestures `hook_take` / `hook_hang`, the right arm of `hook_carry`. */
  addClips(clips: THREE.AnimationClip[]): void {
    const hipsTrack = this.mx.get('Hips')!.name + '.position'
    for (const src of clips) {
      if (this.extra.has(src.name)) continue
      const c = src.clone()
      c.tracks = c.tracks.filter((t) => t.name.endsWith('.quaternion') || t.name === hipsTrack)
      if (c.name === 'hook_carry') continue // (a two-handed box walk: the hook is held by the side instead — HOLD)
      const a = this.mixer.clipAction(c)
      a.setLoop(THREE.LoopOnce, 1)
      a.clampWhenFinished = true
      a.timeScale = 0
      a.play()
      a.setEffectiveWeight(0)
      a.enabled = false
      this.extra.set(c.name, a)
    }
  }

  /**
   * Play a tow gesture once: the clips `parts` blended by their weights `w`, each time-warped so its grab moment
   * (`grab`, clip s) lands `at` s in, and cut off at its `end` (clip s) — a crouch and a standing reach mixed for a
   * hook in between. With `reach`, face `target` (world; followed live — the caller keeps it on the hook) and put the
   * right hand on it at `at`. Returns its length (s); 0 = not loaded.
   */
  playGesture(parts: { name: string; grab: number; end: number; w: number }[], at: number, reach?: THREE.Vector3): number {
    const ps = parts.filter((p) => p.w > 1e-3 && this.extra.has(p.name))
    if (!ps.length) return 0
    const sum = ps.reduce((s, p) => s + p.w, 0)
    const list = ps.map((p) => ({ a: this.extra.get(p.name)!, scale: p.grab / at, end: p.end, w: p.w / sum }))
    const len = list.reduce((s, p) => s + p.w * (p.end / p.scale), 0)
    this.gesture = { parts: list, real: 0, len, reach: reach ? { target: reach, at } : null }
    return len
  }
  private loopTime(c: Clip, phase: number): number {
    const L = LOCO[c as Loco]
    const cyc = this.actions.get(c)!.getClip().duration / L.cycles
    return (((phase + L.td) % 1) + 1) % 1 * cyc
  }

  /**
   * @param speed horizontal m/s   @param grounded   @param aimPitch camera pitch (arm follows when aiming)
   * @param aiming flashlight on → right arm raised forward   @param vy vertical velocity (jump/fall pose)
   */
  animate(dt: number, pos: THREE.Vector3, targetYaw: number, speed: number, grounded: boolean, aiming: boolean, aimPitch: number, vy = 0, knock = 0, tumble: { angle: number; yaw: number } | null = null): void {
    this.unscale()
    // a reaching gesture faces what it reaches for
    const rt = this.gesture?.reach?.target
    if (rt && Math.hypot(rt.x - pos.x, rt.z - pos.z) > 0.15) targetYaw = Math.atan2(-(rt.x - pos.x), -(rt.z - pos.z))
    let d = targetYaw - this.yaw
    d = Math.atan2(Math.sin(d), Math.cos(d))
    this.yaw += d * (1 - Math.exp(-12 * dt))
    this.time += dt
    // Travel direction (from the body's motion: the caller gives the speed and facing only).
    if (Number.isNaN(this.lastPos.x) || dt <= 0) this.lastPos.copy(pos)
    else {
      const k = 1 - Math.exp(-10 * dt)
      this.vel.x += ((pos.x - this.lastPos.x) / dt - this.vel.x) * k
      this.vel.y += ((pos.z - this.lastPos.z) / dt - this.vel.y) * k
      this.lastPos.copy(pos)
    }
    // Air / landing timers.
    const tookOff = !grounded && this.wasGrounded
    if (tookOff) this.jumpT = vy > 1.5 ? JUMP_T0 : -1
    this.air = grounded ? 0 : this.air + dt
    if (!grounded) this.fallVy = Math.min(this.fallVy, vy)
    if (grounded && !this.wasGrounded && this.airTime > 0.25) {
      this.land = 0.22
      // the landing clip (a deep crouch) only after a real drop — not a hop, a step off a kerb or the spawn settle
      this.landT = this.fallVy < -7 && speed < 1.5 ? LAND_T0 : -1
    }
    if (grounded) this.fallVy = 0
    this.airTime = grounded ? 0 : this.airTime + dt
    this.wasGrounded = grounded
    this.land = Math.max(0, this.land - dt)

    // BAIL TUMBLE: procedural (driver rig), retargeted.
    if (tumble) {
      this.yaw = tumble.yaw
      this.knockMode = 'fall'
      this.lastKnock = 1
      this.enter('proc')
      this.tumblePose(tumble.angle, pos)
      this.retarget()
      this.finishBlend(dt)
      return
    }
    this.enter('clip')
    this.root.position.copy(pos)
    this.root.rotation.set(0, this.yaw, 0)
    const tw: Partial<Record<Clip, number>> = {}
    let rate = 10
    let groundIK = false
    let airborne = false
    let stepsOn = false
    if (knock > 0.001) {
      // KNOCKDOWN / GET UP: the clips scrubbed by the knock value (fall 0 → 1, get up 1 → 0).
      // (the impact overshoot above 1 settling back is still the fall, not the get-up)
      const kc = Math.min(1, knock)
      if (kc > this.lastKnock + 1e-4 && this.knockMode !== 'up') this.knockMode = 'fall'
      else if (kc < this.lastKnock - 1e-4) this.knockMode = 'up'
      this.lastKnock = kc
      const kd = this.actions.get('knockdown')!, gu = this.actions.get('get_up')!
      if (this.knockMode === 'up') {
        tw.get_up = 1
        gu.time = (1 - Math.min(1, knock)) * gu.getClip().duration
      } else {
        tw.knockdown = 1
        kd.time = Math.min(1, knock) * kd.getClip().duration * 0.98
      }
      rate = 14
      if (this.ground) this.root.position.y = this.ground(pos.x, pos.z)
    } else {
      this.knockMode = 'none'
      this.lastKnock = 0
      if (!grounded && this.air > 0.06) {
        airborne = true
        const jump = this.actions.get('jump')!
        if (this.jumpT >= 0 && this.jumpT < jump.getClip().duration) {
          tw.jump = 1
          jump.time = this.jumpT
          this.jumpT += dt
        } else {
          tw.fall = 1
          this.fallT += dt
          const fall = this.actions.get('fall')!
          fall.time = this.fallT % fall.getClip().duration
        }
        rate = 12
      } else {
        groundIK = true
        // GROUND: idle ⇄ locomotion; forward walk → jog → run → sprint by speed, backwards / sideways by the travel
        // direction relative to the facing; one shared phase advanced by speed / stride (the active clips' blend).
        this.moveK += (smooth(0.15, 0.6, speed) - this.moveK) * Math.min(1, dt * 8)
        const m = this.moveK
        const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw)
        const vlen = this.vel.length()
        let cf = 1, cr = 0
        if (vlen > 0.3) {
          cf = (this.vel.x * fx + this.vel.y * fz) / vlen
          cr = (this.vel.x * -fz + this.vel.y * fx) / vlen // + = moving to the right
        }
        let wF = Math.max(0, cf), wB = Math.max(0, -cf) * 0.999, wS = Math.abs(cr)
        const ws = wF + wB + wS || 1
        wF /= ws; wB /= ws; wS /= ws
        // forward speed blend
        const fw: Partial<Record<Loco, number>> = {}
        const pts = FORWARD.map((c) => LOCO[c].speed)
        if (speed <= pts[0]) fw.walk = 1
        else if (speed >= pts[pts.length - 1]) fw.sprint = 1
        else for (let i = 0; i < pts.length - 1; i++) {
          if (speed >= pts[i] && speed < pts[i + 1]) {
            const t = (speed - pts[i]) / (pts[i + 1] - pts[i])
            fw[FORWARD[i]] = 1 - t
            fw[FORWARD[i + 1]] = t
          }
        }
        const side: Loco = cr < 0 ? 'strafe_left' : 'strafe_right'
        let stride = 0, wsum = 0
        const loco: [Loco, number][] = [...FORWARD.map((c) => [c, (fw[c] ?? 0) * wF] as [Loco, number]), ['walk_back', wB], [side, wS]]
        for (const [c, w] of loco) {
          if (w <= 0) continue
          const L = LOCO[c]
          stride += w * L.speed * (this.actions.get(c)!.getClip().duration / L.cycles)
          wsum += w
        }
        stride = wsum > 0 ? stride / wsum : 1.2
        const prev = this.phase
        if (m > 0.02) this.phase = (this.phase + (Math.max(speed, 0.5) * dt) / stride) % 1
        for (const [c, w] of loco) {
          tw[c] = w * m
          if (w > 0 || (this.weights.get(c) ?? 0) > 1e-3) this.actions.get(c)!.time = this.loopTime(c, this.phase)
        }
        tw.idle = 1 - m
        const idle = this.actions.get('idle')!
        idle.time = this.time % idle.getClip().duration
        // Landing after a long fall: the clip from touchdown (standing still only), else a squash.
        if (this.landT >= 0) {
          const land = this.actions.get('land')!
          if (this.landT < land.getClip().duration * 0.92 && speed < 1.5) {
            const k = 1 - smooth(land.getClip().duration * 0.7, land.getClip().duration * 0.92, this.landT)
            for (const c of CLIPS) if (tw[c]) tw[c]! *= 1 - k
            tw.land = k
            land.time = this.landT
            this.landT += dt
          } else this.landT = -1
        }
        // Footsteps: the shared phase crossing each foot's touchdown.
        stepsOn = m > 0.35 && speed > 0.4
        if (stepsOn) {
          const crossed = (p: number) => (prev <= p && this.phase > p) || (prev > this.phase && (p >= prev || p < this.phase))
          if (crossed(0)) this.footstep('LeftFoot')
          if (crossed(0.5)) this.footstep('RightFoot')
        }
      }
    }
    // a tow gesture over it all: in over 0.15 s, out over the last 0.25 s (and at once in the air / knocked down)
    const gs = this.gesture
    if (gs) {
      gs.real += dt
      for (const p of gs.parts) p.a.time = Math.min(gs.real * p.scale, p.end)
      const left = gs.len - gs.real
      const want = airborne || knock > 0.001 ? 0 : Math.min(1, gs.real / 0.15, Math.max(0, left) / 0.25)
      this.gestureW = want
      if (left <= 0) this.gesture = null
    } else this.gestureW = 0
    this.applyWeights(tw, dt, rate)
    this.mixer.update(dt)
    this.root.updateMatrixWorld(true)
    // Hips corrections (root space): the air clips held in place horizontally (they drift; the ground clips are
    // Mixamo 'in place' already and their hip sway over the planted feet must stay — pinning it slid the feet);
    // the jump's own rise held (the capsule rises instead); the get-up anchored to the spot.
    const hips = this.mx.get('Hips')!
    const hp = this.root.worldToLocal(hips.getWorldPosition(_v))
    const wj = this.weights.get('jump')!, wg = this.weights.get('get_up')!
    const inPlace = Math.min(1, wj + this.weights.get('fall')! + this.weights.get('land')! + this.gestureW)
    hp.x += (this.hipsRestPos.x - hp.x) * inPlace
    hp.z += (this.hipsRestPos.z - hp.z) * inPlace
    hp.addScaledVector(this.getUpEnd, -wg)
    if (airborne) hp.y += (AIR_HIPS - hp.y) * wj
    if (this.land > 0 && this.landT < 0) hp.y -= 0.12 * Math.sin((this.land / 0.22) * Math.PI) // short-hop squash
    this.setHips(hp)
    if (groundIK && this.ground) this.feetOnGround(pos)
    // Carrying a hook: the right hand by the side, a little behind the hip (not during a gesture: it has its own arm).
    this.carryK += ((this.carrying ? 1 : 0) - this.carryK) * (1 - Math.exp(-8 * dt))
    const ck = this.carryK * (1 - this.gestureW) * (knock > 0.001 ? 0 : 1)
    if (ck > 0.01) {
      this.root.worldToLocal(this.mx.get('RightArm')!.getWorldPosition(_hv)).add(HOLD)
      this.handTo(this.root.localToWorld(_hv), ck)
    }
    // Reaching gesture: the palm onto the target around the grab moment (in over 0.45 s, held, out as it pulls back).
    if (gs?.reach && this.gestureW > 0.01) {
      const at = gs.reach.at, t = gs.real
      const w = smooth(at - 0.45, at, t) * (1 - smooth(at + 0.15, at + 0.6, t)) * this.gestureW
      if (w > 0.01) {
        const m = this.mx.get('RightHandMiddle1'), h = this.mx.get('RightHand')!
        _hv2.copy(gs.reach.target)
        if (m) _hv2.sub(m.getWorldPosition(_hv)).add(h.getWorldPosition(_hv))
        this.handTo(_hv2, w)
      }
    }
    // Flashlight: the right arm points along the view.
    this.aimK += ((aiming ? 1 : 0) - this.aimK) * (1 - Math.exp(-10 * dt))
    if (this.aimK > 0.01 && knock <= 0.001) this.aimArm(aimPitch)
    this.finishBlend(dt)
  }

  /** Hips to a root-space position. */
  private setHips(p: THREE.Vector3): void {
    const hips = this.mx.get('Hips')!
    this.root.localToWorld(_t.copy(p))
    hips.position.copy(hips.parent!.worldToLocal(_t))
    hips.updateMatrixWorld(true)
  }

  private footstep(foot: 'LeftFoot' | 'RightFoot'): void {
    this.steps++
    if (!this.onStep) return
    this.mx.get(foot)!.getWorldPosition(_v)
    this.onStep(_v.x, _v.z, -Math.sin(this.yaw), -Math.cos(this.yaw))
  }

  /**
   * FEET ON THE TERRAIN: the clips walk on a flat floor at the player's feet; each foot is moved by the terrain
   * height under it (two-bone leg IK, knee kept in the clip's bend plane, foot keeps its clip orientation) and the
   * hips drop just enough for the lower foot to reach.
   */
  private feetOnGround(pos: THREE.Vector3): void {
    const g = this.ground!
    const L = this.mx.get('LeftFoot')!, R = this.mx.get('RightFoot')!
    L.getWorldPosition(_a)
    R.getWorldPosition(_b)
    const dL = Math.max(-0.35, Math.min(0.35, g(_a.x, _a.z) - pos.y))
    const dR = Math.max(-0.35, Math.min(0.35, g(_b.x, _b.z) - pos.y))
    if (Math.abs(dL) < 0.005 && Math.abs(dR) < 0.005) return
    const drop = Math.max(0, -Math.min(dL, dR))
    const hips = this.mx.get('Hips')!
    const hp = this.root.worldToLocal(hips.getWorldPosition(_v))
    hp.y -= drop
    _a.y += dL
    _b.y += dR
    const ta = _ta.copy(_a), tb = _tb.copy(_b)
    this.setHips(hp)
    this.legIK('LeftUpLeg', 'LeftLeg', 'LeftFoot', ta)
    this.legIK('RightUpLeg', 'RightLeg', 'RightFoot', tb)
  }

  /** Two-bone IK on Mixamo bones: `end` reaches `target` (world), bending in the current bend plane. */
  private legIK(upN: string, loN: string, endN: string, target: THREE.Vector3): void {
    const up = this.mx.get(upN)!, lo = this.mx.get(loN)!, end = this.mx.get(endN)!
    end.getWorldQuaternion(_qe)
    up.getWorldPosition(_a2)
    lo.getWorldPosition(_b2)
    end.getWorldPosition(_c2)
    const l1 = _a2.distanceTo(_b2), l2 = _b2.distanceTo(_c2)
    // bend direction: the knee's offset from the hip→ankle line
    _dir.subVectors(_c2, _a2).normalize()
    _p.subVectors(_b2, _a2)
    _p.addScaledVector(_dir, -_p.dot(_dir))
    if (_p.lengthSq() < 1e-8) _p.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
    _d.subVectors(target, _a2)
    const dist = Math.min(Math.max(_d.length(), 1e-3), (l1 + l2) * 0.999)
    _d.normalize()
    const cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA))
    _n.crossVectors(_d, _p)
    if (_n.lengthSq() < 1e-8) _n.set(1, 0, 0)
    _bb.crossVectors(_n.normalize(), _d).normalize()
    _e2.copy(_a2).addScaledVector(_d, l1 * cosA).addScaledVector(_bb, l1 * sinA)
    this.turnBone(up, _r.subVectors(_b2, _a2), _r2.subVectors(_e2, _a2), 1)
    lo.getWorldPosition(_b2)
    end.getWorldPosition(_c2)
    _t2.copy(_a2).addScaledVector(_d, dist)
    this.turnBone(lo, _r.subVectors(_c2, _b2), _r2.subVectors(_t2, _b2), 1)
    // the foot keeps its clip orientation
    end.parent!.getWorldQuaternion(_q).invert()
    end.quaternion.copy(_q.multiply(_qe))
    end.updateMatrixWorld(true)
  }

  /** The right wrist toward `target` (world) by `k`: arm IK, the elbow in its clip bend plane. */
  private handTo(target: THREE.Vector3, k: number): void {
    this.mx.get('RightHand')!.getWorldPosition(_hv3)
    this.legIK('RightArm', 'RightForeArm', 'RightHand', _hv3.lerp(target, k))
  }

  /** Rotate a bone (world) by the rotation taking `from` onto `to`, scaled by k. */
  private turnBone(b: THREE.Bone, from: THREE.Vector3, to: THREE.Vector3, k: number): void {
    _q2.setFromUnitVectors(from.normalize(), to.normalize())
    if (k < 1) _q2.slerp(_qI, 1 - k)
    b.getWorldQuaternion(_q3)
    _q3.premultiply(_q2)
    b.parent!.getWorldQuaternion(_q).invert()
    b.quaternion.copy(_q.multiply(_q3))
    b.updateMatrixWorld(true)
  }

  /** Flashlight: right upper arm + forearm straightened along the view direction (pitch-scaled), blended by aimK. */
  private aimArm(pitch: number): void {
    const p = Math.PI / 2 - 0.1 + pitch * 0.8 - Math.PI / 2 // the old pose: arm swung forward to the horizon + pitch
    _dir.set(-Math.sin(this.yaw) * Math.cos(p), Math.sin(p), -Math.cos(this.yaw) * Math.cos(p)).normalize()
    const arm = this.mx.get('RightArm')!, fore = this.mx.get('RightForeArm')!, hand = this.mx.get('RightHand')!
    arm.getWorldPosition(_a)
    fore.getWorldPosition(_b)
    this.turnBone(arm, _r.subVectors(_b, _a), _r2.copy(_dir), this.aimK)
    fore.getWorldPosition(_b)
    hand.getWorldPosition(_c)
    this.turnBone(fore, _r.subVectors(_c, _b), _r2.copy(_dir), this.aimK)
  }

  // ---- procedural poses (driver rig) → Mixamo -------------------------------------------------------------------
  /** Switching between clips and procedural poses: remember the current pose and blend from it (~0.2 s). */
  private enter(mode: 'clip' | 'proc'): void {
    if (this.mode === mode) return
    this.mode = mode
    for (const b of this.mxOrder) this.snapQ.get(b)!.copy(b.quaternion)
    this.snapHips.copy(this.mx.get('Hips')!.position)
    this.blendT = 0.22
  }
  private finishBlend(dt: number): void {
    if (this.blendT <= 0) return
    const k = smooth(0, 1, 1 - this.blendT / 0.22)
    for (const b of this.mxOrder) b.quaternion.slerpQuaternions(this.snapQ.get(b)!, b.quaternion, k)
    const h = this.mx.get('Hips')!
    h.position.lerpVectors(this.snapHips, h.position, k)
    this.blendT -= dt
    this.root.updateMatrixWorld(true)
  }

  /** Copy the driver rig's pose onto the Mixamo bones (rest-direction corrected; spine / neck / clavicles spread). */
  private retarget(): void {
    this.root.updateMatrixWorld(true)
    const dq: THREE.Quaternion[] = []
    for (let i = 0; i < this.bones.length; i++) dq[i] = this.bones[i].getWorldQuaternion(new THREE.Quaternion())
    const tgt = _tgt
    tgt.clear()
    for (const [name, src] of MAP) {
      const b = this.mx.get(name)
      if (!b) continue
      let q: THREE.Quaternion
      if (src === 'spine0') q = _qa.slerpQuaternions(dq[B.hips], dq[B.chest], 1 / 3)
      else if (src === 'spine1') q = _qa.slerpQuaternions(dq[B.hips], dq[B.chest], 2 / 3)
      else if (src === 'neck') q = _qa.slerpQuaternions(dq[B.chest], dq[B.head], 0.5)
      else if (src === 'clavicle') q = _qa.copy(dq[B.chest])
      else q = _qa.copy(dq[src])
      const c = this.corr.get(b)
      const out = new THREE.Quaternion().copy(q)
      if (c) out.multiply(c)
      out.multiply(this.rm0.get(b)!)
      tgt.set(b, out)
    }
    // locals, parents first
    const wq = _wq
    wq.clear()
    for (const b of this.mxOrder) {
      const p = b.parent!
      const pw = wq.get(p as THREE.Bone) ?? p.getWorldQuaternion(new THREE.Quaternion())
      const t = tgt.get(b)
      if (t) {
        b.quaternion.copy(pw).invert().multiply(t)
        wq.set(b, t)
      } else {
        b.quaternion.copy(this.restLocal.get(b)!)
        wq.set(b, pw.clone().multiply(b.quaternion))
      }
    }
    // hips position, the head's scale (a cramped cab)
    this.bones[B.hips].getWorldPosition(_v)
    this.root.worldToLocal(_v).add(this.hipsOffset)
    this.setHips(_v)
    this.mx.get('Head')!.scale.setScalar(this.bones[B.head].scale.x)
    this.root.updateMatrixWorld(true)
    // The spine spread over three bones puts the shoulders a few cm off the driver's single chest pivot: the hands
    // are pulled back onto the driver's (grips, steering wheel, door handle) by two-bone IK.
    this.legIK('LeftArm', 'LeftForeArm', 'LeftHand', this.bones[B.handL].getWorldPosition(_ta))
    this.legIK('RightArm', 'RightForeArm', 'RightHand', this.bones[B.handR].getWorldPosition(_tb))
  }

  // ---- driver-rig pose helpers ------------------------------------------------------------------------------------
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
   * Forward roll: arms wrapped in, knees tucked to the chest, chin down; the whole body pitched forward by `angle`
   * about its right axis (yaw = slide direction). Centred on the hips over `pos`, lowest point on the ground.
   * In the last quarter-turn before lying on the back the limbs open out toward the supine pose.
   */
  private tumblePose(angle: number, pos: THREE.Vector3): void {
    const S = CharacterModel.SUPINE
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

  /** On the back: knees raised with the feet on the ground, arms lying alongside, head resting (end of the tumble). */
  private static readonly SUPINE = { chest: 0.05, head: 0.15, hips: 0, thL: 0.75, knL: 1.2, thR: 0.35, knR: 0.5, spread: 0.12, aDown: 1.3, aFwd: 0.1, aOut: 0.45, aBend: 0.25 }

  /**
   * Riding pose on the BMX: seated, feet ON the turning pedals and hands ON the steering bars (two-bone IK),
   * leaning forward and into turns with the bike. `pedal` = crank angle, `steer` = fork angle (rad).
   */
  ride(pos: THREE.Vector3, heading: number, pedal: number, lean: number, rig?: RideRig, steer = 0, bikeQ?: THREE.Quaternion): void {
    this.unscale()
    this.enter('proc')
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
    if (rig) {
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
    }
    // Keep the next ground animation blending from here.
    for (let i = 0; i < bones.length; i++) this.target[i].copy(bones[i].quaternion)
    this.retarget()
    this.finishBlend(1 / 60)
  }

  /**
   * In / beside a car (CarEntry: open the door, climb in, sit and steer, climb out): the root takes the car's world
   * frame `carM` (and the body scale), the hips go to `o.hip` (car space) turned by `o.yaw`, the spine bends with
   * `sit`/`lean`, and hands / feet reach their car-space targets by two-bone IK (else a default arm / seated leg).
   */
  carPose(carM: THREE.Matrix4, o: CarPose): void {
    this.enter('proc')
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
    this.retarget()
    this.finishBlend(1 / 60)
  }

  /** World position of the eyes (FPP eye while getting in / out). */
  headPosition(out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true)
    return this.mx.get('Head')!.localToWorld(out.copy(this.eyeLocal))
  }

  /** Back to normal size (after a car seat). */
  private unscale(): void {
    if (this.root.scale.x !== 1) this.root.scale.setScalar(1)
    this.bones[B.head].scale.setScalar(1)
    this.mx.get('Head')!.scale.setScalar(1)
  }

  /** Two-bone IK on the driver rig: rotate `upper`/`lower` so the `end` joint reaches `target`, bending toward `pole`. */
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
    _bb.crossVectors(_n.normalize(), _d).normalize() // in the bend plane, toward the pole
    _e2.copy(_a).addScaledVector(_d, l1 * cosA).addScaledVector(_bb, l1 * sinA) // elbow / knee
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
    return (this.mx.get('RightHandMiddle1') ?? this.mx.get('RightHand')!).getWorldPosition(out)
  }

  dispose(): void {
    this.mixer.stopAllAction()
    this.mixer.uncacheRoot(this.mixer.getRoot())
    this.mesh.geometry.dispose()
    this.mesh.skeleton.dispose()
  }
}

const _v = new THREE.Vector3(), _t = new THREE.Vector3(), _t2 = new THREE.Vector3(), _p = new THREE.Vector3()
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _n = new THREE.Vector3()
const _bb = new THREE.Vector3(), _e2 = new THREE.Vector3(), _dir = new THREE.Vector3(), _r = new THREE.Vector3(), _r2 = new THREE.Vector3()
const _a2 = new THREE.Vector3(), _b2 = new THREE.Vector3(), _c2 = new THREE.Vector3(), _ta = new THREE.Vector3(), _tb = new THREE.Vector3()
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _qa = new THREE.Quaternion()
const _qe = new THREE.Quaternion(), _qI = new THREE.Quaternion()
const _hv = new THREE.Vector3(), _hv2 = new THREE.Vector3(), _hv3 = new THREE.Vector3()
/** Carrying a hook: the wrist from the right shoulder (root space: +X right, +Z back) — arm down, a little back. */
const HOLD = new THREE.Vector3(0.07, -0.43, 0.1)
const _up = new THREE.Vector3(0, 1, 0)
const _tgt = new Map<THREE.Bone, THREE.Quaternion>()
const _wq = new Map<THREE.Bone, THREE.Quaternion>()

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
