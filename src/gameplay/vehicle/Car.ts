import * as THREE from 'three'
import type { PhysicsWorld } from '../../physics/PhysicsWorld'
import type { Input } from '../../input/Input'
import type { WorldFields } from '../../world/WorldFields'
import type { CharacterModel } from '../player/CharacterModel'
import { EYE_HEIGHT, type PlayerController } from '../player/PlayerController'
import type { TruckModel } from '../../assets/loadModels'
import { stylize } from '../../rendering/shaders/stylize'
import { CHUNK_SIZE } from '../../world/constants'
import { chunkKey } from '../../world/types'
import { STOCK_TRUCK, TruckSim, type TruckTune } from './VehicleSim'
import { vehicleDef, type VehicleTuning } from './catalogue'
import { CarEntry, type EntryPhase } from './CarEntry'
import { BoatHull, DRAFT, KEEL } from './BoatHull'

/**
 * A drivable car of the garage (catalogue.ts; models baked by assets/loadModels) — a SIMULATED vehicle (VehicleSim
 * TruckSim: dynamic body, raycast suspension, 4×4 engine/brakes/tyre grip, see tests/vehicle.test.ts).
 *   E within 4 m to get in / out · W throttle · S brake, then reverse · A/D steer · Shift boost · Space handbrake
 *   = DRIFT at speed (or Shift + steer for a power slide; VehicleSim) (touch: stick = throttle + steer; the
 *   JUMP button becomes DRIFT). Exhaust puffs and tyre smoke / dust come from rendering/particles/VehicleFx.
 * Getting in / out is animated (CarEntry, GTA-style): walk to the nearer front door, open it, climb in, pull it
 * shut; out the reverse. Out of a car moving faster than BAIL_SPEED the player is thrown (PlayerController.bail)
 * and the flung-open door swings on its own (free hinge: the car's acceleration and the wind, slams shut).
 * This class maps input → controls and draws the simulated pose (interpolated between 60 Hz steps): body, each
 * wheel's suspension travel / spin / steering angle, the steering wheel in the driver's hands, the doors, live beam
 * axles (models without their own), and the lamps (head, tail, brake, reverse). Parked outside the physics ring it
 * is frozen (no ground collider to rest on) and wakes when its chunk's colliders exist again.
 * BOAT (O) and JET (L): the wheels retract and the amphibious hull unfolds from under the car (BoatHull: keel pack
 * drops and telescopes out, sides swing up, the bow lowers like a drawbridge, the transom and jet nozzle fold out,
 * a clunk as each part locks) — afloat it is a jet boat (VehicleSim TruckSim.driveBoat); on land it crawls on its
 * keel. O is refused while flying; L from the boat folds the hull away as the wheels turn into jets; landing over
 * water puts the hull out first; afloat you can't drop the wheels or step out (the HUD says why).
 * Draws: body + wheels + steering wheel + 2 doors + axles (textured Lambert, all instanced → ONE program, 7 draws)
 * + glass ×3 (shared vertex-colour program, hidden in first person so you can see out) + lamps (1 additive draw)
 * + the hull's 6 parts while it is out (same program).
 * CPU per frame ≈ 0.05 ms (matrices, door hinge, entry pose IK); memory: geometry only (+ 1 small axle mesh).
 */
/** Steering-wheel turn at full lock (rad, ≈ 135° each way) — follows the driver's hands, not the speed-limited road wheels. */
const WHEEL_TURN = 2.35
/** Free door swing: the hinge stop (rad). */
const DOOR_STOP = 1.25

/** An opening door: hinge pivot (car space), its meshes and the swing state. */
interface Door {
  side: -1 | 1
  length: number
  pivot: THREE.Group
  glass: THREE.Mesh | null
  /** Open angle (rad, 0 = shut) and angular velocity; latched = shut and locked. */
  angle: number
  vel: number
  latched: boolean
}

export type CarEvent = 'doorOpen' | 'doorSlam' | 'drive' | 'out' | 'fly' | 'boat' | 'clunk' | 'hint'

/** Boat transformation time (s, each way) and the points where a hull part locks home (a clunk). */
const BOAT_TIME = 2.2
const CLUNKS = [0.3, 0.5, 0.72, 0.85, 0.96]

export class Car {
  readonly root = new THREE.Group()
  private readonly body = new THREE.Group()
  private readonly wheels: THREE.InstancedMesh
  private readonly wheelPos: [number, number, number][]
  private readonly track: number
  private readonly half: { x: number; y: number; z: number }
  private readonly wheelRadius: number
  private readonly bodyMat: THREE.MeshLambertMaterial
  private readonly glassMesh: THREE.Mesh
  private readonly steering: THREE.InstancedMesh | null
  private readonly steeringPivot: THREE.Vector3
  private readonly steeringAxis: THREE.Vector3
  private readonly doors: Door[] = []
  private readonly doorMeshes: THREE.InstancedMesh[] = []
  /** Dark running gear, one instanced draw: beam axles (front, rear) + diffs + driveshaft (instances 0–4, only on
   *  `axles` cars) and the four shock-absorber bodies (5–8). */
  private readonly axles: THREE.InstancedMesh
  private readonly hasAxles: boolean
  /** Shock absorbers: chrome piston rods and coil springs (one instanced draw each), hub → body mount. */
  private readonly rods: THREE.InstancedMesh
  private readonly springs: THREE.InstancedMesh
  /** Strut top mounts (car space, fixed to the body) and the inboard offset of a strut from its hub (m). */
  private readonly mounts: THREE.Vector3[]
  private readonly inboard: number
  /** JET FLAMES (flying): one additive cone per wheel, 1 draw, hidden on the ground. */
  private readonly jets: THREE.InstancedMesh
  private readonly jetMat: THREE.ShaderMaterial
  /** Flying (L): wanted on / off, and the transformation 0 (wheels) … 1 (jets) — fixed-step. */
  private flyOn = false
  private fly = 0
  /** Boat (O): hull wanted out, and the deployment 0 (car) … 1 (boat) — fixed-step. */
  private boatOn = false
  private boatDeploy = 0
  private rideByBoat = false
  readonly hull: BoatHull
  /** The last refusal / notice for the HUD ('hint' event). */
  hint = ''
  private turbine = 0
  private discSpin = 0
  private time = 0
  private readonly hubs = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  /** Getting in / out (GTA-style sequence) — also poses the seated driver. */
  readonly entry: CarEntry
  /** Driver's eye (car space) for first person. */
  private readonly eye = new THREE.Vector3()
  /** Paint colour (linear) for the masked panels, and the tyre size multiplier (render). */
  private readonly paint = { value: new THREE.Color(1, 1, 1) }
  private tyre = 1
  /** Catalogue id of the loaded model. */
  readonly modelId: string
  /** Headlights (F while driving; auto from the darkness when you get in). */
  lights = false
  /** Brake lights this frame (S / handbrake while rolling). */
  braking = false
  private readonly lamps: THREE.Mesh
  private readonly lampMat: THREE.ShaderMaterial
  /** Headlamp centre and aim in car space (the spot light + beam). */
  private readonly headPos = new THREE.Vector3()
  /** Arcade + touch screen: accelerate automatically (Settings → Auto accelerate, off by default). */
  autoAccel = false
  /** Driver's hands on the wheel, −1 … 1 (smoothed steer input). */
  hands = 0
  readonly sim: TruckSim
  /** Interpolation: pose before the last physics step, and the current one. */
  private readonly prevP = new THREE.Vector3()
  private readonly prevQ = new THREE.Quaternion()
  private readonly curP = new THREE.Vector3()
  private readonly curQ = new THREE.Quaternion()
  /** Rendered (interpolated) position — camera, HUD, prompts. */
  readonly pos = new THREE.Vector3()
  /** Driver at the controls (seated, door shut or shutting). */
  driving = false
  near = false
  /** Third-person view (set by Game): the tinted glass is opaque, so first person hides it to see out. */
  showDriver = false
  /** Door / engine / state events (Game: sounds, camera, HUD). */
  onEvent: ((e: CarEvent) => void) | null = null
  /** Forward acceleration (m/s², smoothed) — swings an open door. */
  private accel = 0
  private lastSpeed = 0

  constructor(
    glassMaterial: THREE.Material,
    truck: TruckModel,
    private readonly physics: PhysicsWorld,
    private readonly fields: WorldFields,
    private readonly player: PlayerController,
    private readonly character: CharacterModel,
    private readonly input: Input,
    tuning: VehicleTuning | null = null,
  ) {
    this.root.name = 'car'
    this.root.add(this.body)
    this.modelId = truck.id
    // Vertex colours carry the baked material colours (white where a texture is used); the paint colour tints
    // the masked panels only (`paintMask` attribute) — the garage's colour picker.
    const mat = new THREE.MeshLambertMaterial({ ...(truck.map ? { map: truck.map } : {}), vertexColors: true })
    const paint = this.paint
    const paintMask = { value: truck.paintMap }
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uPaint = paint
      shader.uniforms.uPaintMask = paintMask
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float paintMask; varying float vPaint;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPaint = paintMask;')
      // Paint REPLACES the panel's hue (keeps its shading/luminance) so a red coat on a blue textured van is red,
      // not black; white = the model's own colours (stock look).
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform vec3 uPaint; varying float vPaint;${truck.paintMap ? '\nuniform sampler2D uPaintMask;' : ''}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        { float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
          float isWhite = step(2.95, uPaint.r + uPaint.g + uPaint.b);
          // Textured models: only the body-paint texels (paint mask from the texture's dominant body hue) — rims,
          // tyres, glass, chrome, lights, seats and rust keep their own colours.
          float m = vPaint${truck.paintMap ? ' * texture2D(uPaintMask, vMapUv).r' : ''};
          diffuseColor.rgb = mix(diffuseColor.rgb, uPaint * (lum * 1.3 + 0.08), m * (1.0 - isWhite)); }`)
    }
    mat.customProgramCacheKey = () => `truck-paint-${truck.map ? 'tex' : 'flat'}${truck.paintMap ? '-mask' : ''}`
    this.bodyMat = stylize(mat, { key: 'truck', rim: 0.45 })
    this.bodyMat.name = 'lib/truck'
    // Body as a 1-instance InstancedMesh: it then shares the wheels' (instanced) program → 1 truck program, not 2.
    const bodyMesh = new THREE.InstancedMesh(truck.body, this.bodyMat, 1)
    bodyMesh.setMatrixAt(0, new THREE.Matrix4())
    bodyMesh.frustumCulled = false
    const glassMesh = (this.glassMesh = new THREE.Mesh(truck.glass, glassMaterial))
    for (const m of [bodyMesh, glassMesh]) (m.castShadow = true), this.body.add(m)
    this.wheelPos = truck.wheelPos
    this.half = truck.half
    this.wheelRadius = truck.wheelRadius
    this.track = Math.abs(truck.wheelPos[1][0] - truck.wheelPos[0][0])
    this.wheels = new THREE.InstancedMesh(truck.wheel, this.bodyMat, 4)
    this.wheels.castShadow = true
    this.wheels.frustumCulled = false // instances move with the body; the truck is one small object
    this.body.add(this.wheels)
    // Steering wheel (split out of the body at load, when the model has one): turns with the driver's input.
    this.steering = truck.steeringWheel ? new THREE.InstancedMesh(truck.steeringWheel, this.bodyMat, 1) : null
    this.steeringPivot = new THREE.Vector3(...truck.steeringPivot)
    this.steeringAxis = new THREE.Vector3(...truck.steeringAxis)
    if (this.steering) {
      this.steering.frustumCulled = false
      this.body.add(this.steering)
    }
    // DOORS: hinge pivots in car space; door skin on the shared instanced program, its window on the glass one.
    for (const d of truck.doors) {
      const pivot = new THREE.Group()
      pivot.position.set(...d.hinge)
      const skin = new THREE.InstancedMesh(d.body, this.bodyMat, 1)
      skin.setMatrixAt(0, new THREE.Matrix4())
      skin.frustumCulled = false
      skin.castShadow = true
      pivot.add(skin)
      const glass = d.glass ? new THREE.Mesh(d.glass, glassMaterial) : null
      if (glass) pivot.add(glass)
      this.body.add(pivot)
      this.doorMeshes.push(skin)
      this.doors.push({ side: d.side, length: d.length, pivot, glass, angle: 0, vel: 0, latched: true })
    }
    const def = vehicleDef(truck.id)
    // Driver's seat: behind the steering wheel at the cab's measured hip height (catalogue `cabin`).
    const cab = def.cabin
    const seat = truck.steeringWheel
      ? new THREE.Vector3(this.steeringPivot.x, cab.hip, this.steeringPivot.z + cab.behind)
      : new THREE.Vector3(-truck.half.x * 0.48, cab.hip, 0)
    const wheelC = truck.steeringWheel ? this.steeringPivot.clone() : seat.clone().add(new THREE.Vector3(0, 0.38, -cab.behind))
    this.entry = new CarEntry(
      { seat, wheel: wheelC, wheelAxis: this.steeringAxis.clone(), wheelRadius: truck.steeringRadius, roof: cab.roof, halfX: truck.half.x, front: truck.front, rear: truck.rear },
      truck.doors.map((d) => ({ side: d.side, hinge: new THREE.Vector3(...d.hinge), length: d.length, bottom: d.bottom, top: d.top })),
    )
    // First-person eye: the seated head, under the roof.
    this.eye.set(seat.x, Math.min(seat.y + 0.66, cab.roof - 0.08), seat.z - 0.05)
    // AXLES (pickup, Żuk): a unit cylinder along X, instanced 5× — front / rear beams hub to hub (they tilt with
    // the suspension like a real solid axle), the two diff housings and the driveshaft between them.
    // Same program as the body: the gear carries its colour in the vertices and samples a neutral texel.
    const gear = (g: THREE.BufferGeometry, rgb: [number, number, number]) => {
      const n = g.getAttribute('position').count
      const col = new Float32Array(n * 3)
      const uv = new Float32Array(n * 2)
      for (let i = 0; i < n; i++) (col.set(rgb, i * 3), uv.set(truck.neutralUv, i * 2))
      g.setAttribute('color', new THREE.BufferAttribute(col, 3))
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
      g.setAttribute('paintMask', new THREE.BufferAttribute(new Float32Array(n), 1))
      return g
    }
    const inst = (g: THREE.BufferGeometry, n: number) => {
      const m = new THREE.InstancedMesh(g, this.bodyMat, n)
      m.frustumCulled = false
      m.castShadow = true
      this.body.add(m)
      return m
    }
    const cyl = () => new THREE.CylinderGeometry(1, 1, 1, 8, 1, false).rotateZ(Math.PI / 2).toNonIndexed() // unit, along X
    this.hasAxles = !!def.axles
    this.axles = inst(gear(cyl(), [0.025, 0.025, 0.025]), 9)
    this.rods = inst(gear(cyl(), [0.62, 0.64, 0.68]), 4)
    this.springs = inst(gear(coilGeometry(), [0.12, 0.42, 1.0]), 4)
    for (let k = 0; k < 9; k++) this.axles.setMatrixAt(k, _zero)
    // Struts stand just inboard of each tyre, from the hub up to a mount in the wheel arch (above the tyre).
    truck.wheel.computeBoundingBox()
    const wb = truck.wheel.boundingBox!
    this.inboard = (wb.max.x - wb.min.x) / 2 + 0.05
    this.mounts = truck.wheelPos.map(([x, y, z]) => new THREE.Vector3(x - Math.sign(x) * this.inboard, y + truck.wheelRadius * 1.1, z))
    // Jet flames: an open cone, nozzle at y = 0, tip at y = −1 (scaled per instance).
    const cone = new THREE.ConeGeometry(1, 1, 14, 1, true).rotateX(Math.PI).translate(0, -0.5, 0)
    this.jetMat = new THREE.ShaderMaterial({
      name: 'CarJets', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      uniforms: { uTime: { value: 0 }, uPower: { value: 0 } },
      vertexShader: /* glsl */ `
        varying float vH; varying float vId;
        void main() { vH = -position.y; vId = float(gl_InstanceID);
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime, uPower; varying float vH; varying float vId;
        void main() {
          // White-hot at the nozzle → blue → gone at the tip, flickering per jet.
          float core = pow(1.0 - vH, 3.0);
          float flick = 0.8 + 0.2 * sin(uTime * 57.0 + vId * 2.1 + vH * 18.0);
          vec3 c = mix(vec3(0.15, 0.45, 1.0), vec3(0.85, 0.95, 1.0), core * core) * core * (2.2 + 4.0 * uPower) * flick;
          gl_FragColor = vec4(c, 1.0);
        }`,
    })
    this.jets = new THREE.InstancedMesh(cone, this.jetMat, 4)
    this.jets.frustumCulled = false
    this.jets.renderOrder = 9
    this.jets.visible = false
    this.body.add(this.jets)
    const t = tuning ?? { ...STOCK_TRUCK, paint: '#ffffff' }
    this.sim = new TruckSim(physics, truck, t)
    // The amphibious hull, fitted to this car, on the body's program; its bilge points float the sim.
    this.hull = new BoatHull(truck, this.bodyMat)
    this.body.add(this.hull.root)
    this.sim.hullPts = this.hull.floatPoints
    this.sim.hullDraft = DRAFT
    this.applyLook(t)
    // LAMPS: two head + two tail + two reverse quads (additive, HDR when lit → bloom) ON the model's own lenses:
    // found in the texture at load (loadModels findLamps: pale lenses facing forward, red ones facing back), else the
    // catalogue, else a guess from the body box. Each quad sits 2 cm proud of its lens (so it passes the depth test).
    // Reverse lamps: the lower part of the tail cluster (white).
    const h = truck.half, b = truck.bottom
    const found = truck.lamps
    const head = found.head?.c ?? def.lamps?.head ?? [h.x * 0.62, b + h.y * 0.62, truck.front - 0.03]
    const tail = found.tail?.c ?? def.lamps?.tail ?? [h.x * 0.66, b + h.y * 0.62, truck.rear + 0.03]
    const headSize = found.head ? [found.head.w, found.head.h] : [0.17, 0.11]
    const tailSize = found.tail ? [found.tail.w, found.tail.h] : [0.2, 0.08]
    this.headPos.set(0, head[1], head[2])
    const pos: number[] = [], id: number[] = [], corner: number[] = [], idx: number[] = []
    const quad = (cx: number, cy: number, cz: number, w: number, hh: number, back: boolean, lamp: number) => {
      const base = pos.length / 3
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        pos.push(cx + u * w * (back ? -1 : 1), cy + v * hh, cz)
        id.push(lamp)
        corner.push(u, v)
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
    for (const side of [-1, 1]) {
      quad(side * head[0], head[1], head[2], headSize[0] * 1.15, headSize[1] * 1.15, false, 0)
      quad(side * tail[0], tail[1], tail[2], tailSize[0] * 1.1, tailSize[1] * 1.1, true, 1)
      quad(side * (tail[0] - tailSize[0] * 0.25), tail[1] - tailSize[1] * 0.55, tail[2] + 0.004, tailSize[0] * 0.5, tailSize[1] * 0.4, true, 2)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('lampId', new THREE.Float32BufferAttribute(id, 1))
    g.setAttribute('corner', new THREE.Float32BufferAttribute(corner, 2))
    g.setIndex(idx)
    this.lampMat = new THREE.ShaderMaterial({
      name: 'CarLamps', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      uniforms: { uHead: { value: 0 }, uTail: { value: 0 }, uBrake: { value: 0 }, uRev: { value: 0 }, uDark: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float lampId; attribute vec2 corner; varying float vId; varying vec2 vC;
        void main() { vId = lampId; vC = corner; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uHead, uTail, uBrake, uRev, uDark; varying float vId; varying vec2 vC;
        void main() {
          float d = length(vC);
          float soft = smoothstep(1.0, 0.35, d);
          // Heads: warm white, HDR when on (bloom halo), a faint lens even when off. Tails: dim red with the
          // lights, bright red under braking — always visible a little by day (a real brake light). Reverse: white.
          vec3 head = vec3(1.0, 0.93, 0.78) * (0.12 + uHead * (1.6 + 2.4 * uDark));
          vec3 tail = vec3(1.0, 0.1, 0.06) * (0.1 + uTail * 0.6 + uBrake * (1.4 + 1.6 * uDark));
          vec3 rev = vec3(1.0, 0.97, 0.92) * uRev * (1.2 + 1.8 * uDark);
          vec3 c = vId < 0.5 ? head : vId < 1.5 ? tail : rev;
          gl_FragColor = vec4(c * soft, 1.0);
        }`,
    })
    this.lamps = new THREE.Mesh(g, this.lampMat)
    this.lamps.frustumCulled = false
    this.lamps.renderOrder = 9
    this.body.add(this.lamps)
  }

  /** Headlamp origin and a point 28 m down the road (world) — the spot light and the beam when the lights are on. */
  headlamp(origin: THREE.Vector3, target: THREE.Vector3): void {
    origin.copy(this.headPos).applyMatrix4(this.root.matrixWorld)
    target.set(0, this.headPos.y - 1.2, this.headPos.z - 28).applyMatrix4(this.root.matrixWorld)
  }

  /** Lamp uniforms once per frame (darkness 0 day … 1 night). */
  updateLamps(darkness: number): void {
    const c = this.sim.controls
    const v = this.sim.speed
    this.braking = this.driving && ((c.throttle < -0.01 && v > 0.5) || (c.handbrake && Math.abs(v) > 1))
    const u = this.lampMat.uniforms
    u.uHead.value = this.lights ? 1 : 0
    u.uTail.value = this.lights ? 1 : 0
    u.uBrake.value = this.braking ? 1 : 0
    u.uRev.value = this.driving && v < -0.3 ? 1 : 0
    u.uDark.value = darkness
  }

  /** Garage: apply a setup live — physics via the sim, paint + tyre size on the meshes. */
  retune(t: Partial<VehicleTuning>): void {
    const { paint: _p, ...phys } = t
    if (Object.keys(phys).length) this.sim.retune(phys as Partial<TruckTune>)
    this.applyLook(t)
  }

  private applyLook(t: Partial<VehicleTuning>): void {
    if (t.paint) this.paint.value.setStyle(t.paint) // sRGB hex → linear (ColorManagement)
    if (t.tyre !== undefined) this.tyre = t.tyre
  }

  get tune(): TruckTune {
    return this.sim.tune
  }

  set castShadow(v: boolean) {
    this.root.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).castShadow = v) : 0))
  }

  get heading(): number {
    return this.sim.heading
  }
  get speed(): number {
    return this.sim.speed
  }
  /** World velocity of the chassis (m/s) — streaming looks ahead along it. */
  velocity(out: THREE.Vector3): THREE.Vector3 {
    const v = this.sim.body.linvel()
    return out.set(v.x, v.y, v.z)
  }

  /** Exhaust tip (world): rear left, under the bumper — through the rendered (interpolated) pose. */
  exhaustWorld(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-0.42, 0.3, this.half.z * 0.96).applyMatrix4(this.root.matrixWorld)
  }

  /** Ground contact point under wheel k (world, rendered pose). */
  wheelContact(k: number, out: THREE.Vector3): THREE.Vector3 {
    const [x, y, z] = this.wheelPos[k]
    return out.set(x, y + this.sim.wheels[k].lift - this.wheelRadius + 0.05, z).applyMatrix4(this.root.matrixWorld) // hub sits (tyre−1)·r higher, tread (tyre)·r lower: net the same
  }

  /** Chassis forward axis in world space (rendered pose). */
  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, -1).transformDirection(this.root.matrixWorld)
  }

  /** LOW tier: a smaller texture copy (GPU memory). */
  setMap(map: THREE.Texture | null): void {
    if (!map || this.bodyMat.map === map) return
    this.bodyMat.map = map
    this.bodyMat.needsUpdate = true
  }

  /** Park at (x, z) on the solid ground (a cave's rock floor too); `nearY` = a height near there (e.g. the car's own
   *  before a swap) so the ground is found under a cave roof — else from above the uncarved hill. */
  park(x: number, z: number, heading: number, nearY?: number): void {
    this.sim.place(x, this.solid(x, z, nearY ?? this.fields.heightNoCave(x, z) + 1.4), z, heading)
    this.readPose(this.curP, this.curQ)
    this.prevP.copy(this.curP)
    this.prevQ.copy(this.curQ)
    this.pos.copy(this.curP)
  }

  private readPose(p: THREE.Vector3, q: THREE.Quaternion): void {
    const t = this.sim.body.translation(), r = this.sim.body.rotation()
    p.set(t.x, t.y, t.z)
    q.set(r.x, r.y, r.z, r.w)
  }

  /** In the car or getting in / out (the player is carried, not simulated). */
  get occupied(): boolean {
    return this.driving || this.entry.phase !== 'none'
  }

  /** E: get in (walk to the door…) / get out (…or bail at speed). Returns whether anything started. */
  toggle(): boolean {
    const p = this.player
    if (this.driving) {
      if (this.sim.afloat) return this.say("You can't get out on the water — reach the shore first")
      const v = this.sim.body.linvel()
      // Fast, or up in the air: jump out (GTA bail) — the empty car comes down and lands on its own.
      if (Math.hypot(v.x, v.z) > BAIL_SPEED || (this.sim.hover && this.altitude() > 1.3)) {
        this.flyOn = false
        this.bail()
        return true
      }
      if (this.entry.phase !== 'seated') return false // still pulling the door shut / sliding over
      this.flyOn = false
      if (!this.boatOn) this.sim.rideTarget = 0 // the air suspension lets the body down to step out
      this.setDriving(false)
      this.entry.exit()
      return true
    }
    if (this.entry.phase !== 'none') return false
    if (!this.near || p.dead || p.ride.riding || p.tumbling || p.knock > 0.05) return false // not while thrown / getting up
    p.inVehicle = true
    p.collider.setEnabled(false)
    this.root.updateMatrixWorld()
    this.entry.enter(this.toLocal(_v.copy(p.curr)))
    return true
  }

  /** Instantly in the driver's seat, no animation (dev shots / tests). */
  seatNow(): void {
    if (this.driving) return
    this.player.inVehicle = true
    this.player.collider.setEnabled(false)
    this.entry.seatNow()
    this.setDriving(true)
  }

  /** Instantly out (car swapped, respawn): no animation, door shut. */
  forceOut(): void {
    if (!this.occupied) return
    const wasDriving = this.driving
    this.driving = false
    this.entry.reset()
    for (const d of this.doors) (d.angle = 0), (d.vel = 0), (d.latched = true)
    this.root.updateMatrixWorld()
    const d0 = this.doors[0]
    const feet = this.toWorld(d0 ? _v.set(d0.pivot.position.x + d0.side * 0.7, 0, d0.pivot.position.z + d0.length + 0.3) : _v.set(-this.half.x - 0.7, 0, 0))
    feet.y = this.solid(feet.x, feet.z, this.pos.y) + 0.05
    this.release(feet)
    if (wasDriving) this.onEvent?.('drive')
  }

  /** BAIL (GTA): out of a moving car you keep its momentum — thrown from the door, tumbling along the ground — the
   *  door is flung open and swings on its hinge, and the empty car rolls on until friction stops it. */
  private bail(): void {
    const p = this.player
    const h = this.heading
    const c = Math.cos(h), s = Math.sin(h)
    const x = this.pos.x - c * (this.track * 0.5 + 1.2), z = this.pos.z + s * (this.track * 0.5 + 1.2)
    this.setDriving(false)
    this.entry.reset()
    this.release(_v.set(x, this.solid(x, z, this.pos.y) + 0.2, z))
    const v = this.sim.body.linvel()
    const out = 1.6 // pushed away from the door (left side)
    p.bail(v.x * 0.85 - c * out, v.y, v.z * 0.85 + s * out)
    const d = this.doors.find((q) => q.side < 0)
    if (d) {
      d.latched = false
      d.angle = 0.3
      d.vel = 7
      this.onEvent?.('doorOpen')
    }
  }

  private setDriving(on: boolean): void {
    if (this.driving === on) return
    this.driving = on
    if (on) this.player.yaw = this.heading
    this.onEvent?.('drive')
  }

  /** The solid ground at (x, z) near height `nearY` (PhysicsWorld.groundBelow: terrain or a cave's rock floor — the
   *  height field is carved below caves, so placing by it dropped the player / car into the cave floor). */
  private solid(x: number, z: number, nearY: number): number {
    return this.physics.groundBelow(x, z, nearY + 0.6, this.fields.surface(x, z))
  }

  /** Hand control back to the player, standing at `feet` (world). */
  private release(feet: THREE.Vector3): void {
    const p = this.player
    p.collider.setEnabled(true)
    p.inVehicle = false
    p.teleport(_t.copy(feet))
    this.onEvent?.('out')
  }

  private toLocal(v: THREE.Vector3): THREE.Vector3 {
    return v.applyMatrix4(_m.copy(this.root.matrixWorld).invert())
  }
  private toWorld(v: THREE.Vector3): THREE.Vector3 {
    return v.applyMatrix4(this.root.matrixWorld)
  }

  /** Fixed step (60 Hz), called inside physics.advance before world.step(). */
  fixedUpdate(dt: number): void {
    const i = this.input
    const drive = this.driving && !this.player.dead
    const c = this.sim.controls
    c.throttle = drive ? Math.max(-1, Math.min(1, (i.down('KeyW') ? 1 : 0) - (i.down('KeyS') ? 1 : 0) + i.touchMove.y)) : 0
    // Arcade on a touch screen (Asphalt): the car accelerates by itself; pulling the stick back brakes (a pull
    // while steering at speed = drift).
    if (drive && this.autoAccel && this.sim.arcade && i.touch && i.touchMove.y > -0.35) c.throttle = 1
    c.steer = drive ? Math.max(-1, Math.min(1, (i.down('KeyD') ? 1 : 0) - (i.down('KeyA') ? 1 : 0) + i.touchMove.x)) : 0
    c.handbrake = drive && i.down('Space')
    c.brake = drive && (i.down('KeyS') || i.touchMove.y < -0.35)
    c.boost = drive && (i.down('ShiftLeft') || i.down('ShiftRight'))
    // ↑ / ↓ (touch ▲ ▼): the air suspension on the ground, climb / sink in the air.
    c.lift = drive ? (i.down('ArrowUp') ? 1 : 0) - (i.down('ArrowDown') ? 1 : 0) : 0
    if (this.boatOn && !this.flyOn) c.lift = 0 // the boat holds its own ride height
    this.flyStep(dt)
    this.boatStep(dt)
    // Nobody driving: the brakes lock only once it has (nearly) stopped — a car bailed out of keeps rolling.
    c.parked = !drive && Math.abs(this.sim.speed) < 1.5
    // Only simulate where the ground has colliders (the physics ring follows the player AND runs ahead of a
    // moving vehicle, WorldManager); frozen elsewhere — while driving too, so a fast truck waits a few frames at
    // a chunk that hasn't streamed in instead of falling through the road.
    const t = this.sim.body.translation()
    const key = chunkKey(Math.floor(t.x / CHUNK_SIZE), Math.floor(t.z / CHUNK_SIZE))
    this.sim.enabled = this.physics.hasChunk(key)
    this.readPose(this.prevP, this.prevQ)
    this.sim.step(dt)
    this.sim.keepAbove(this.fields.surface(t.x, t.z))
    if (this.driving) this.player.carryTo(this.seatWorld()) // streaming, grass, monsters follow the truck
  }

  /** Flying (or transforming / landing): the wheels are not (all) wheels. */
  get flying(): boolean {
    return this.flyOn || this.fly > 0
  }

  /** Flight wanted (L): the touch button reads LAND. */
  get flyMode(): boolean {
    return this.flyOn
  }

  /** L / touch FLY while driving: transform into the flying car (wheels → jets) or land and transform back. */
  toggleFly(): boolean {
    if (!this.driving) return false
    this.flyOn = !this.flyOn
    const wasBoat = this.boatOn
    if (this.flyOn) this.boatOn = false // boat → jet: the hull folds away while the wheels turn into jets
    else {
      // Landing over the water: the hull comes out on the way down, so it touches down as a boat.
      const t = this.sim.body.translation()
      if (this.sim.water(t.x, t.z) - this.fields.surface(t.x, t.z) > 0.8) this.boatOn = true
    }
    this.onEvent?.('fly')
    if (this.boatOn !== wasBoat) this.onEvent?.('boat')
    return true
  }

  /** Boat mode wanted (O): the touch button reads CAR. */
  get boatMode(): boolean {
    return this.boatOn
  }

  /** Floating on the water (the hull carries it, not the wheels). */
  get afloat(): boolean {
    return this.sim.afloat
  }

  /** O while driving: deploy the hull (car → boat) or fold it away (boat → car). Refused while flying (land first)
   *  and while afloat (no ground for the wheels). */
  toggleBoat(): boolean {
    if (!this.driving) return false
    if (this.flyOn || this.fly > 0) return this.say('Land first — the hull only deploys on the ground or the water')
    if (this.boatOn && this.sim.afloat) return this.say('Find shallow water or the shore to drop the wheels')
    this.boatOn = !this.boatOn
    this.onEvent?.('boat')
    return true
  }

  /** A notice for the HUD (always "nothing happened"). */
  private say(text: string): false {
    this.hint = text
    this.onEvent?.('hint')
    return false
  }

  /**
   * The boat transformation (BOAT_TIME each way, BoatHull.pose draws it): the buoyancy ramps in as the keel comes
   * out (TruckSim takes over the handling from half-way); on land the body rises on the air suspension by the
   * keel's depth so the keel, not the retracted tyres, meets the ground — and comes back down once it's folded away.
   */
  private boatStep(dt: number): void {
    const before = this.boatDeploy
    const want = this.boatOn && !this.flyOn
    this.boatDeploy = want ? Math.min(1, before + dt / BOAT_TIME) : Math.max(0, before - dt / BOAT_TIME)
    this.sim.boat = smooth(0.2, 0.5, this.boatDeploy)
    if (want || this.boatDeploy > 0) {
      if (!this.sim.hover) this.sim.rideTarget = -KEEL
      this.rideByBoat = true
    } else if (this.rideByBoat) {
      this.sim.rideTarget = 0
      this.rideByBoat = false
    }
    for (const k of CLUNKS) if ((before - k) * (this.boatDeploy - k) < 0) this.onEvent?.('clunk')
  }

  /** The ground or the water surface under (x, z), whichever is higher (world y) — what the hover keeps above. */
  private floorAt(x: number, z: number): number {
    return Math.max(this.fields.surface(x, z), this.sim.water(x, z))
  }

  /** Hull FX spots in world space (rendered pose): bow shoulder k (0 left, 1 right) at the waterline, nozzle exit. */
  bowSprayWorld(k: number, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.hull.bowSpray[k]).applyMatrix4(this.root.matrixWorld)
  }
  nozzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.hull.nozzleExit).applyMatrix4(this.root.matrixWorld)
  }

  /** Height of the car's ground plane above the terrain (m). */
  private altitude(): number {
    const t = this.sim.body.translation()
    return t.y - this.floorAt(t.x, t.z)
  }

  /**
   * The transformation (1.2 s each way) and who flies: past half-way the hover flight takes over from the wheels
   * (TruckSim.hoverStep) and lifts off to ≥ 0.8 m. Landing (L again, or nobody at the controls) sinks first and
   * folds the wheels back out only below ~1.3 m, so the car always comes down on its wheels.
   */
  private flyStep(dt: number): void {
    if (!this.driving && this.flyOn) this.flyOn = false
    const c = this.sim.controls
    const high = this.altitude() > 1.3
    if (this.flyOn) this.fly = Math.min(1, this.fly + dt / 1.2)
    else if (!(high && this.fly > 0.55)) this.fly = Math.max(0, this.fly - dt / 1.2)
    const hover = this.fly > 0.55
    this.sim.hover = hover
    const t = this.sim.body.translation()
    this.sim.hoverFloor = this.flyOn ? this.floorAt(t.x, t.z) + 0.8 : -1e9
    if (hover && !this.flyOn) c.lift = Math.min(c.lift ?? 0, high ? -0.6 : -0.3) // coming in to land
  }

  /**
   * Feet position such that the FPP eye (feet + 1.62 m) sits at the driver's head, through the body's full
   * simulated orientation (so the view stays in the cab on any slope).
   */
  seatWorld(out = new THREE.Vector3()): THREE.Vector3 {
    this.readPose(_p, _q)
    out.copy(this.eye).applyQuaternion(_q).add(_p)
    out.y -= EYE_HEIGHT
    return out
  }

  /** Render frame: interpolated simulated pose; wheels, doors, axles; the driver / entry sequence; headlights. */
  update(dt: number, alpha: number, flashOrigin: THREE.Vector3, flashTarget: THREE.Vector3): void {
    const p = this.player
    this.readPose(this.curP, this.curQ)
    this.pos.lerpVectors(this.prevP, this.curP, alpha)
    this.root.position.copy(this.pos)
    this.root.quaternion.slerpQuaternions(this.prevQ, this.curQ, alpha)
    this.near = !this.occupied && !p.tumbling && p.knock < 0.05 && Math.hypot(p.curr.x - this.pos.x, p.curr.z - this.pos.z) < 4
    const w = this.sim.wheels
    // FLYING CAR transformation (`fly` 0 → 1): each wheel turns flat (rim facing down), tucks up and in under
    // its arch, spins up like a turbine, and the jet lights under it.
    const f = this.fly
    const tilt = smooth(0, 0.45, f) * (Math.PI / 2), tuck = smooth(0.3, 0.75, f), jet = smooth(0.6, 1, f)
    // BOAT — THE WHEELS ARE THE GADGET (BoatHull.pose carries on from them): each wheel folds flat, slides in under
    // the car on its strut spinning like a turbine disc, spreads into a thin disc, and sinks into the keel pack that
    // forms out of the four discs — no tyres left showing on the boat.
    const b = this.boatDeploy
    const fold = smooth(0, 0.22, b), slide = smooth(0.12, 0.4, b), spread = smooth(0.22, 0.42, b), gone = smooth(0.42, 0.6, b)
    const flat = Math.max(tilt, fold * (Math.PI / 2))
    this.discSpin += dt * 16 * Math.sin(Math.PI * slide)
    this.time += dt
    this.turbine += dt * 28 * jet
    this.wheelPos.forEach(([x, y, z], k) => {
      const rightSide = k === 1 || k === 3
      const spin = -w[k].spin * (1 - fold) - this.turbine - this.discSpin
      // Right wheels = the left wheel turned 180° (rim faces out); their spin reverses accordingly.
      _e.set(rightSide ? -spin : spin, (rightSide ? Math.PI : 0) - w[k].steer * (1 - flat / (Math.PI / 2)), 0, 'YXZ')
      // Bigger tyres: scaled about the hub, hub raised so the tread stays on the ground (as in the sim).
      const hx = x - Math.sign(x) * tuck * 0.8 * this.inboard
      const hy = y + w[k].lift + (this.tyre - 1) * this.wheelRadius + tuck * this.wheelRadius * 0.55
      this.hubs[k].set(hx + (x * 0.42 - hx) * slide, hy + (this.hull.discY - hy) * slide, z)
      _q.setFromEuler(_e).premultiply(_q2.setFromAxisAngle(_z, rightSide ? -flat : flat))
      // Spread into a disc: thinner along the axle, wider across; then shrink away inside the keel pack.
      const sc = this.tyre * Math.max(1e-3, 1 - gone)
      _m.compose(this.hubs[k], _q, _s.set(sc * (1 - 0.65 * spread), sc * (1 + 0.45 * spread), sc * (1 + 0.45 * spread)))
      this.wheels.setMatrixAt(k, _m)
    })
    this.wheels.instanceMatrix.needsUpdate = true
    this.wheels.visible = gone < 1
    this.updateGear()
    // The struts pull the wheels in; once the wheels are gone, so is the running gear (inside the hull).
    this.rods.visible = this.springs.visible = this.axles.visible = gone < 1
    this.updateJets(jet)
    this.hull.pose(this.boatDeploy, this.hands)
    // Steering wheel: D (right) turns it clockwise as the driver sees it = +rotation about the column axis,
    // which points forward/down away from the driver (verified numerically: D moves the rim's top to +X).
    const c = this.sim.controls
    this.hands += ((this.driving ? c.steer : 0) - this.hands) * Math.min(1, dt * 7)
    if (this.steering) {
      _q.setFromAxisAngle(this.steeringAxis, this.hands * WHEEL_TURN)
      this.steering.setMatrixAt(0, _m.compose(this.steeringPivot, _q, _one))
      this.steering.instanceMatrix.needsUpdate = true
    }
    this.root.updateMatrixWorld()
    // Forward acceleration (swings an open door: braking throws it open, accelerating and the wind shut it).
    const sp = this.sim.speed
    if (dt > 0) this.accel += ((sp - this.lastSpeed) / dt - this.accel) * Math.min(1, dt * 10)
    this.lastSpeed = sp
    this.updateEntry(dt)
    this.updateDoors(dt)
    const hideGlass = this.driving && !this.showDriver
    this.glassMesh.visible = !hideGlass
    for (const d of this.doors) if (d.glass) d.glass.visible = !hideGlass
    if (this.driving) {
      if (p.lookIdle > 0.6) {
        let d = this.heading - p.yaw
        d = Math.atan2(Math.sin(d), Math.cos(d))
        p.yaw += d * Math.min(1, dt * 3)
      }
      // The spot light becomes the headlights (Game gates it by `lights`).
      this.headlamp(flashOrigin, flashTarget)
    }
  }

  /** The entry / exit sequence: walk to the door, then posed phases; door angle and events from CarEntry. */
  private updateEntry(dt: number): void {
    const e = this.entry, p = this.player, ch = this.character
    if (e.phase === 'none') return
    const M = this.root.matrixWorld
    const i = this.input
    const moveInput = i.down('KeyW') || i.down('KeyA') || i.down('KeyS') || i.down('KeyD') || Math.hypot(i.touchMove.x, i.touchMove.y) > 0.3
    // Abort getting in when the car is moving off or the player died / is hit (not yet at the wheel).
    if (!this.driving && e.phase !== 'climbOut' && e.phase !== 'openOut' && e.phase !== 'closeOut' && (p.dead || Math.abs(this.sim.speed) > 3 || (e.phase === 'approach' && moveInput))) {
      const from = e.phase === 'approach' ? e.walk : e.pose.hip
      const feet = this.toWorld(_v.set(from.x, 0, from.z))
      e.reset()
      const d = this.doors[e.door]
      if (d && d.angle > 0.02) d.latched = false
      feet.y = this.solid(feet.x, feet.z, this.pos.y) + 0.05
      this.release(feet)
      return
    }
    if (e.phase === 'approach') {
      // Walk round to the door (locomotion), carried along as the player.
      const walking = e.stepWalk(dt)
      const feet = this.toWorld(_v.set(e.walk.x, 0, e.walk.z))
      feet.y = ch.ground ? ch.ground(feet.x, feet.z) : this.fields.surface(feet.x, feet.z)
      p.carryTo(feet)
      p.renderPosition.copy(feet)
      if (this.character.root.visible) ch.animate(dt, feet, this.heading + e.walkYaw, walking ? 2.3 : 0, true, false, 0)
      if (!walking) {
        e.phase = 'open'
        e.t = 0
      }
      return
    }
    // Ground beside the door (car space) for the standing phases.
    const d = this.doors[e.door]
    _v.set(d.pivot.position.x + d.side * 0.5, 0, d.pivot.position.z + d.length + 0.2)
    this.toWorld(_v)
    _v.y = ch.ground ? ch.ground(_v.x, _v.z) : this.fields.surface(_v.x, _v.z)
    e.groundY = this.toLocal(_v).y
    const ended: EntryPhase = e.update(dt, this.hands * WHEEL_TURN, this.hands, moveInput)
    if (e.opened) this.onEvent?.('doorOpen')
    if (e.slam) this.onEvent?.('doorSlam')
    // At the wheel as soon as the driver's door starts closing (or after sliding over from the passenger side).
    if ((e.phase === 'close' && d.side < 0) || e.phase === 'seated') this.setDriving(true)
    if (ended === 'closeOut') {
      // Out: the player stands where the body stands.
      const feet = this.toWorld(_v.set(e.pose.hip.x, 0, e.pose.hip.z))
      feet.y = ch.ground ? ch.ground(feet.x, feet.z) : this.fields.surface(feet.x, feet.z)
      if (e.doorAngle === null && d.angle > 0.02) d.latched = false // walked off: the door stays open
      this.release(feet)
      return
    }
    // Pose the body in the car's frame; first person: the camera rides in the head (not while seated: seatWorld).
    ch.carPose(M, e.pose)
    ch.root.visible = this.showDriver
    if (!this.driving) {
      ch.headPosition(_v)
      _v.y -= EYE_HEIGHT
      p.carryTo(_v)
    }
  }

  /** Door hinges: held by the entry sequence, else latched, else swinging free (inertia + wind, slam shut). */
  private updateDoors(dt: number): void {
    const e = this.entry
    for (let k = 0; k < this.doors.length; k++) {
      const d = this.doors[k]
      if (e.doorAngle !== null && k === e.door && e.phase !== 'none') {
        d.angle = e.doorAngle
        d.vel = 0
        d.latched = d.angle < 0.005
      } else if (!d.latched) {
        // Rod on a hinge: the car's forward acceleration acts backward on it (closing it), the head wind (forward
        // speed²) pushes on its outer face; reversing opens it. Damped; bounces off the stop; shuts with a slam.
        const v = this.sim.speed
        const sn = Math.sin(d.angle)
        const acc = -(1.5 / Math.max(0.5, d.length)) * this.accel * sn - 0.012 * v * Math.abs(v) * sn - 1.2 * d.vel
        d.vel += acc * dt
        d.angle += d.vel * dt
        if (d.angle > DOOR_STOP) (d.angle = DOOR_STOP), (d.vel = -Math.abs(d.vel) * 0.3)
        if (d.angle <= 0) {
          if (d.vel < -0.8) this.onEvent?.('doorSlam')
          d.angle = d.vel = 0
          d.latched = true
        }
      }
      d.pivot.rotation.y = d.side * d.angle
    }
  }

  /** Running gear: shock absorbers on every car, beam axles where the model has none. */
  private updateGear(): void {
    const H = this.hubs, r = this.wheelRadius
    // SHOCK ABSORBERS: hub (just inboard of the tyre) → mount in the arch. The damper body hangs from the mount at
    // a fixed length, the chrome rod spans the whole strut, the coil spring stretches with it.
    for (let k = 0; k < 4; k++) {
      const top = this.mounts[k]
      _h.copy(H[k])
      _h.x -= Math.sign(_h.x) * this.inboard * (1 - smooth(0.3, 0.75, this.fly))
      _d.subVectors(top, _h)
      const len = Math.max(0.05, _d.length())
      _d.divideScalar(len)
      _q.setFromUnitVectors(_x, _d)
      this.rods.setMatrixAt(k, _m.compose(_c.addVectors(_h, top).multiplyScalar(0.5), _q, _s.set(len, r * 0.045, r * 0.045)))
      const body = Math.min(len * 0.9, r * 0.6)
      this.axles.setMatrixAt(5 + k, _m.compose(_c.copy(top).addScaledVector(_d, -body / 2), _q, _s.set(body, r * 0.1, r * 0.1)))
      _q.setFromUnitVectors(_y, _d)
      this.springs.setMatrixAt(k, _m.compose(_c.copy(_h).addScaledVector(_d, len * 0.08), _q, _s.set(r * 0.19, len * 0.9, r * 0.19)))
    }
    this.rods.instanceMatrix.needsUpdate = true
    this.springs.instanceMatrix.needsUpdate = true
    if (this.hasAxles) this.updateAxles()
    this.axles.instanceMatrix.needsUpdate = true
  }

  /** Jet flames under the turned wheels: length from the thrust (hover + climb + throttle). */
  private updateJets(jet: number): void {
    this.jets.visible = jet > 0.01
    if (!this.jets.visible) return
    const c = this.sim.controls
    const power = Math.min(1, 0.45 + 0.35 * Math.max(0, c.lift ?? 0) + 0.3 * Math.abs(c.throttle) + (c.boost ? 0.2 : 0)) * jet
    this.jetMat.uniforms.uTime.value = this.time
    this.jetMat.uniforms.uPower.value = power
    const r = this.wheelRadius * this.tyre
    for (let k = 0; k < 4; k++) {
      const flick = 1 + 0.08 * Math.sin(this.time * 31 + k * 1.7)
      _c.copy(this.hubs[k]).y -= r * 0.18
      this.jets.setMatrixAt(k, _m.compose(_c, _q.identity(), _s.set(r * 0.62 * jet, r * (1.2 + 2.6 * power) * flick, r * 0.62 * jet)))
    }
    this.jets.instanceMatrix.needsUpdate = true
  }

  /** Beam axles hub to hub (they tilt with the suspension), diff housings in the middle, driveshaft between. */
  private updateAxles(): void {
    const a = this.axles, H = this.hubs, r = this.wheelRadius * this.tyre
    const beam = (l: THREE.Vector3, rr: THREE.Vector3, k: number) => {
      _c.addVectors(l, rr).multiplyScalar(0.5)
      _d.subVectors(rr, l)
      const len = _d.length()
      _q.setFromUnitVectors(_x, _d.divideScalar(len))
      a.setMatrixAt(k, _m.compose(_c, _q, _s.set(len, r * 0.13, r * 0.13)))
      a.setMatrixAt(k + 2, _m.compose(_c, _q, _s.set(r * 0.62, r * 0.33, r * 0.33)))
      return _c
    }
    _f.copy(beam(H[0], H[1], 0))
    _r.copy(beam(H[2], H[3], 1))
    _d.subVectors(_r, _f)
    const len = _d.length()
    _q.setFromUnitVectors(_x, _d.divideScalar(len))
    a.setMatrixAt(4, _m.compose(_c.addVectors(_f, _r).multiplyScalar(0.5), _q, _s.set(len, r * 0.09, r * 0.09)))
    a.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    this.forceOut()
    this.root.removeFromParent()
    this.lamps.geometry.dispose()
    this.lampMat.dispose()
    this.sim.dispose()
    this.wheels.dispose()
    this.steering?.dispose()
    for (const m of this.doorMeshes) m.dispose()
    for (const m of [this.axles, this.rods, this.springs, this.jets]) (m.geometry.dispose(), m.dispose())
    this.hull.dispose()
    this.jetMat.dispose()
    this.bodyMat.dispose()
  }
}

/**
 * Unit coil spring along +Y (0 … 1), radius 1: 6 turns of a 4-sided wire (240 tris). Scaled per instance to the
 * strut's length and the spring's radius — the coils spread out as the strut stretches (air-suspension lift).
 */
function coilGeometry(): THREE.BufferGeometry {
  const turns = 6, seg = 10, n = turns * seg
  const wr = 0.17, wy = 0.045 // wire: radial / vertical half thickness (relative units)
  const ring: [number, number][] = [[wr, 0], [0, wy], [-wr, 0], [0, -wy]]
  const pos: number[] = [], nor: number[] = []
  const P = (i: number, j: number) => {
    const a = (i / seg) * Math.PI * 2, y = i / n
    const [dr, dy] = ring[j % 4]
    return [Math.cos(a) * (1 + dr), y + dy, Math.sin(a) * (1 + dr), Math.cos(a) * Math.sign(dr || 0), dy ? Math.sign(dy) : 0, Math.sin(a) * Math.sign(dr || 0)]
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 4; j++) {
      const q = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)]
      for (const k of [0, 1, 2, 0, 2, 3]) (pos.push(q[k][0], q[k][1], q[k][2]), nor.push(q[k][3], q[k][4], q[k][5]))
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  return g
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Getting out faster than this (m/s ≈ 14 km/h) is a bail: the player is thrown out and tumbles. */
const BAIL_SPEED = 4

const _e = new THREE.Euler()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _v = new THREE.Vector3()
const _t = new THREE.Vector3()
const _p = new THREE.Vector3()
const _c = new THREE.Vector3()
const _d = new THREE.Vector3()
const _f = new THREE.Vector3()
const _r = new THREE.Vector3()
const _x = new THREE.Vector3(1, 0, 0)
const _y = new THREE.Vector3(0, 1, 0)
const _z = new THREE.Vector3(0, 0, 1)
const _zero = new THREE.Matrix4().makeScale(0, 0, 0)
const _q2 = new THREE.Quaternion()
const _h = new THREE.Vector3()
const _one = new THREE.Vector3(1, 1, 1)
const _s = new THREE.Vector3(1, 1, 1)
