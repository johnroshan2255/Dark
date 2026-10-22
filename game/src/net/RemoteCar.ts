import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { VehicleModel } from '../assets/loadModels'
import { BoatHull } from '../gameplay/vehicle/BoatHull'
import { carGlass, carLamps, coilGeometry, gearCylinder, gearGeometry, jetCone, jetMaterial, smooth, truckMaterial, tyreUniforms } from '../gameplay/vehicle/Car'
import { vehicleDef } from '../gameplay/vehicle/catalogue'

/**
 * A REMOTE CAR drawn like the player's own (gameplay/vehicle/Car): the same body material, cabin, glass, closed doors,
 * brakes, dampers + springs (+ beam axles), steering wheel, lamps, jet flames and amphibious hull — posed from the
 * network state instead of a simulation: the wheels roll with the forward speed, the fronts steer by the turn rate
 * (bicycle model: atan(wheelbase · yaw rate / speed)), FLYING turns them flat into jets, BOAT folds them into the
 * keel and unfolds the hull, LIGHTS / BRAKING / reversing light the lamps.
 * RemotePlayers gives the nearest `maxCars` cars one each (pooled per model); the rest stay instanced stand-ins.
 * Cost per car: the player car's draws (~10 + glass + lamps, the hull's while it is out), no shadow pass for the
 * small parts; CPU ≈ 0.02 ms (matrices).
 */
const BOAT_TIME = 2.2
const FLY_TIME = 1.2
/** Front-wheel lock (rad) — VehicleSim's at low speed. */
const LOCK = 0.55
const WHEEL_TURN = 2.35

export class RemoteCar {
  readonly root = new THREE.Group()
  private readonly tyreU = tyreUniforms()
  private readonly paint = { value: new THREE.Color(1, 1, 1) }
  private readonly mat: THREE.MeshLambertMaterial
  private readonly bodyGeo: THREE.BufferGeometry
  private readonly wheels: THREE.InstancedMesh
  private readonly brakes: (THREE.InstancedMesh | null)[]
  private readonly steering: THREE.InstancedMesh | null
  private readonly steeringPivot: THREE.Vector3
  private readonly steeringAxis: THREE.Vector3
  private readonly axles: THREE.InstancedMesh
  private readonly rods: THREE.InstancedMesh
  private readonly springs: THREE.InstancedMesh
  private readonly hasAxles: boolean
  private readonly mounts: THREE.Vector3[]
  private readonly inboard: number
  private readonly jets: THREE.InstancedMesh
  private readonly jetMat: THREE.ShaderMaterial
  private readonly lamps: THREE.Mesh
  private readonly lampMat: THREE.ShaderMaterial
  private readonly hull: BoatHull
  private readonly owned: THREE.BufferGeometry[] = []
  private readonly hubs = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  private readonly wheelbase: number
  private spin = 0
  private steer = 0
  private fly = 0
  private boat = 0
  private turbine = 0
  private discSpin = 0
  private time = 0

  constructor(readonly model: number, private readonly vm: VehicleModel) {
    this.root.name = `remote-car-${vm.id}`
    this.tyreU.uTyreR.value = vm.wheelRadius
    this.tyreU.uDirt.value = 0.35
    this.mat = truckMaterial(vm, this.paint, this.tyreU)
    const add = (m: THREE.Mesh, shadow = false) => {
      m.frustumCulled = false
      m.castShadow = shadow
      this.root.add(m)
      return m
    }
    const one = <T extends THREE.InstancedMesh>(m: T) => (m.setMatrixAt(0, new THREE.Matrix4()), m)
    this.bodyGeo = vm.cabin ? mergeGeometries([vm.body, vm.cabin], false) ?? vm.body : vm.body
    if (this.bodyGeo !== vm.body) this.owned.push(this.bodyGeo)
    add(one(new THREE.InstancedMesh(this.bodyGeo, this.mat, 1)), true)
    add(new THREE.Mesh(vm.glass, carGlass())).renderOrder = 2
    // the doors, shut, where the hinges are
    for (const d of vm.doors) {
      const pivot = new THREE.Group()
      pivot.position.set(...d.hinge)
      const skin = one(new THREE.InstancedMesh(d.body, this.mat, 1))
      skin.frustumCulled = false
      skin.castShadow = true
      pivot.add(skin)
      if (d.glass?.getAttribute('position')) {
        const g = new THREE.Mesh(d.glass, carGlass())
        g.renderOrder = 2
        pivot.add(g)
      }
      this.root.add(pivot)
    }
    this.wheels = add(new THREE.InstancedMesh(vm.wheel, this.mat, 4), true) as THREE.InstancedMesh
    this.brakes = [vm.brakes.front, vm.brakes.rear].map((g) => (g ? (add(new THREE.InstancedMesh(g, this.mat, 2)) as THREE.InstancedMesh) : null))
    this.steering = vm.steeringWheel ? (add(new THREE.InstancedMesh(vm.steeringWheel, this.mat, 1)) as THREE.InstancedMesh) : null
    this.steeringPivot = new THREE.Vector3(...vm.steeringPivot)
    this.steeringAxis = new THREE.Vector3(...vm.steeringAxis)
    // running gear, as Car builds it
    const gear = (g: THREE.BufferGeometry, rgb: [number, number, number], n: number) => {
      const geo = gearGeometry(vm, g, rgb)
      this.owned.push(geo)
      return add(new THREE.InstancedMesh(geo, this.mat, n)) as THREE.InstancedMesh
    }
    this.hasAxles = !!vehicleDef(vm.id).axles
    this.axles = gear(gearCylinder(), [0.025, 0.025, 0.025], 9)
    this.rods = gear(gearCylinder(), [0.62, 0.64, 0.68], 4)
    this.springs = gear(coilGeometry(), [0.045, 0.045, 0.05], 4)
    for (let k = 0; k < 9; k++) this.axles.setMatrixAt(k, _zero)
    vm.wheel.computeBoundingBox()
    const wb = vm.wheel.boundingBox!
    this.inboard = (wb.max.x - wb.min.x) / 2 + 0.05
    this.mounts = vm.wheelPos.map(([x, y, z]) => new THREE.Vector3(x - Math.sign(x) * this.inboard, y + vm.wheelRadius * 1.1, z))
    this.wheelbase = Math.max(1, Math.abs(vm.wheelPos[0][2] - vm.wheelPos[2][2]))
    this.jetMat = jetMaterial()
    const cone = jetCone()
    this.owned.push(cone)
    this.jets = add(new THREE.InstancedMesh(cone, this.jetMat, 4)) as THREE.InstancedMesh
    this.jets.renderOrder = 9
    this.jets.visible = false
    const lamps = carLamps(vm)
    this.lamps = add(lamps.mesh)
    this.lampMat = lamps.mat
    this.hull = new BoatHull(vm, this.mat)
    this.root.add(this.hull.root)
  }

  /**
   * Pose it: chassis at `pos` (car origin), `yaw` / `pitch`; `fwd` = signed forward speed (m/s), `yawRate` (rad/s);
   * `flags` the protocol's (FLYING, BOAT, LIGHTS, BRAKING); `darkness` 0 day … 1 night (the lamps).
   */
  update(dt: number, pos: THREE.Vector3, yaw: number, pitch: number, roll: number, fwd: number, yawRate: number, flying: boolean, boat: boolean, lights: boolean, braking: boolean, darkness: number): void {
    const vm = this.vm
    this.root.position.copy(pos)
    this.root.rotation.set(pitch, yaw, -roll, 'YXZ') // (roll + = right side down)
    this.tyreU.uGroundY.value = pos.y
    this.time += dt
    this.fly = flying ? Math.min(1, this.fly + dt / FLY_TIME) : Math.max(0, this.fly - dt / FLY_TIME)
    this.boat = boat ? Math.min(1, this.boat + dt / BOAT_TIME) : Math.max(0, this.boat - dt / BOAT_TIME)
    // roll with the speed; steer the fronts by the turn rate (right turn: yaw falls, steer > 0 as in VehicleSim)
    this.spin += (fwd / vm.wheelRadius) * dt
    const want = Math.abs(fwd) > 0.8 ? Math.max(-LOCK, Math.min(LOCK, Math.atan((this.wheelbase * -yawRate) / fwd))) : this.steer
    this.steer += (want - this.steer) * Math.min(1, dt * 8)
    // (Car.update's wheel pose, with the suspension at rest)
    const f = this.fly
    const tilt = smooth(0, 0.45, f) * (Math.PI / 2), tuck = smooth(0.3, 0.75, f), jet = smooth(0.6, 1, f)
    const b = this.boat
    const fold = smooth(0, 0.22, b), slide = smooth(0.12, 0.4, b), spread = smooth(0.22, 0.42, b), gone = smooth(0.42, 0.6, b)
    const flat = Math.max(tilt, fold * (Math.PI / 2))
    this.discSpin += dt * 16 * Math.sin(Math.PI * slide)
    this.turbine += dt * 28 * jet
    vm.wheelPos.forEach(([x, y, z], k) => {
      const right = k === 1 || k === 3
      const steer = k < 2 ? this.steer : 0
      const spin = -this.spin * (1 - fold) - this.turbine - this.discSpin
      _e.set(right ? -spin : spin, (right ? Math.PI : 0) - steer * (1 - flat / (Math.PI / 2)), 0, 'YXZ')
      const hx = x - Math.sign(x) * tuck * 0.8 * this.inboard
      const hy = y + tuck * vm.wheelRadius * 0.55
      this.hubs[k].set(hx + (x * 0.42 - hx) * slide, hy + (this.hull.discY - hy) * slide, z)
      _q.setFromEuler(_e).premultiply(_q2.setFromAxisAngle(_z, right ? -flat : flat))
      _v.set(0, -1, 0).applyQuaternion(_q3.copy(_q).invert())
      this.tyreU.uTyre.value[k].set(_v.x, _v.y, _v.z, 0)
      const sc = Math.max(1e-3, 1 - gone)
      this.wheels.setMatrixAt(k, _m.compose(this.hubs[k], _q, _s.set(sc * (1 - 0.65 * spread), sc * (1 + 0.45 * spread), sc * (1 + 0.45 * spread))))
      const br = this.brakes[k >> 1]
      if (br) {
        _e.set(0, (right ? Math.PI : 0) - steer, 0, 'YXZ')
        br.setMatrixAt(k & 1, _m.compose(this.hubs[k], _q.setFromEuler(_e), _s.setScalar(1)))
      }
    })
    this.wheels.instanceMatrix.needsUpdate = true
    this.wheels.visible = gone < 1
    for (const br of this.brakes) if (br) (br.instanceMatrix.needsUpdate = true), (br.visible = flat < 0.02 && tuck < 0.02)
    this.updateGear()
    this.rods.visible = this.springs.visible = this.axles.visible = gone < 1
    // jets: hover thrust, more with speed
    this.jets.visible = jet > 0.01
    if (this.jets.visible) {
      const power = Math.min(1, 0.45 + 0.3 * Math.min(1, Math.abs(fwd) / 20)) * jet
      this.jetMat.uniforms.uTime.value = this.time
      this.jetMat.uniforms.uPower.value = power
      const r = vm.wheelRadius
      for (let k = 0; k < 4; k++) {
        const flick = 1 + 0.08 * Math.sin(this.time * 31 + k * 1.7)
        _c.copy(this.hubs[k]).y -= r * 0.18
        this.jets.setMatrixAt(k, _m.compose(_c, _q.identity(), _s.set(r * 0.62 * jet, r * (1.2 + 2.6 * power) * flick, r * 0.62 * jet)))
      }
      this.jets.instanceMatrix.needsUpdate = true
    }
    this.hull.pose(this.boat, this.steer / LOCK)
    if (this.steering) {
      _q.setFromAxisAngle(this.steeringAxis, (this.steer / LOCK) * WHEEL_TURN)
      this.steering.setMatrixAt(0, _m.compose(this.steeringPivot, _q, _one))
      this.steering.instanceMatrix.needsUpdate = true
    }
    const u = this.lampMat.uniforms
    u.uHead.value = u.uTail.value = lights ? 1 : 0
    u.uBrake.value = braking ? 1 : 0
    u.uRev.value = fwd < -0.3 ? 1 : 0
    u.uDark.value = darkness
  }

  /** Dampers + springs hub → arch mount, beam axles hub to hub (Car.updateGear / updateAxles). */
  private updateGear(): void {
    const H = this.hubs, r = this.vm.wheelRadius
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
    if (this.hasAxles) {
      const a = this.axles
      const beam = (l: THREE.Vector3, rr: THREE.Vector3, k: number, out: THREE.Vector3) => {
        out.addVectors(l, rr).multiplyScalar(0.5)
        _d.subVectors(rr, l)
        const len = _d.length()
        _q.setFromUnitVectors(_x, _d.divideScalar(len))
        a.setMatrixAt(k, _m.compose(out, _q, _s.set(len, r * 0.13, r * 0.13)))
        a.setMatrixAt(k + 2, _m.compose(out, _q, _s.set(r * 0.62, r * 0.33, r * 0.33)))
      }
      beam(H[0], H[1], 0, _f)
      beam(H[2], H[3], 1, _r)
      _d.subVectors(_r, _f)
      const len = _d.length()
      _q.setFromUnitVectors(_x, _d.divideScalar(len))
      a.setMatrixAt(4, _m.compose(_c.addVectors(_f, _r).multiplyScalar(0.5), _q, _s.set(len, r * 0.09, r * 0.09)))
    }
    this.rods.instanceMatrix.needsUpdate = true
    this.springs.instanceMatrix.needsUpdate = true
    this.axles.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    this.root.removeFromParent()
    this.root.traverse((o) => (o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).dispose())
    for (const g of this.owned) g.dispose()
    this.lamps.geometry.dispose()
    this.lampMat.dispose()
    this.jetMat.dispose()
    this.hull.dispose()
    this.mat.dispose()
  }
}

const _e = new THREE.Euler()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _q3 = new THREE.Quaternion()
const _v = new THREE.Vector3()
const _c = new THREE.Vector3()
const _d = new THREE.Vector3()
const _f = new THREE.Vector3()
const _r = new THREE.Vector3()
const _h = new THREE.Vector3()
const _x = new THREE.Vector3(1, 0, 0)
const _y = new THREE.Vector3(0, 1, 0)
const _z = new THREE.Vector3(0, 0, 1)
const _s = new THREE.Vector3(1, 1, 1)
const _one = new THREE.Vector3(1, 1, 1)
const _zero = new THREE.Matrix4().makeScale(0, 0, 0)
