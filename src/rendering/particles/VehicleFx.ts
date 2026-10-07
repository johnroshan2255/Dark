import * as THREE from 'three'
import type { Car } from '../../gameplay/vehicle/Car'
import { WorldFields } from '../../world/WorldFields'
import type { BiomeWeights } from '../../world/Biomes'

/**
 * VEHICLE EFFECTS — exhaust puffs and tyre smoke / dust, the way a 4×4 reads in over the hill:
 *   - EXHAUST: soft grey-blue puffs from the tailpipe (rear left) while the engine runs — a lazy idle trickle,
 *     a thicker stream under throttle — drifting back and up, growing as they fade.
 *   - TYRES: each wheel in contact emits by its SLIP (VehicleSim `wheelSlip`: sideways slide, a locked rear on
 *     the handbrake, a burnout) and by rolling speed off the asphalt: white tyre smoke on the road, tan dust on
 *     dirt/gravel/grass, pale gold on sand, a white powder on snow. Dust is thrown against the wheel's travel and
 *     with the slide, then rises and thins.
 *   - WATER (the boat, Car O): white SPRAY peeling off both bow shoulders with speed, the jet's ROOSTER TAIL off the
 *     nozzle under throttle, a WAKE of foam left on the water, and a SPLASH burst when the hull hits the water hard.
 *     Spray falls under gravity and turns to foam where it lands (stays on the surface, spreads, fades).
 * ONE draw call: a fixed pool of point sprites (tier budget `particles.vehicle`, ≤ 320) integrated on the CPU
 * (≈ 0.03 ms), soft-disc fragments, alpha blended (no depth write), lit by the ambient colour, fogged by the
 * scene fog. Nothing is allocated per frame. Invisible when no particle is alive.
 */
const MAX = 320
const _v = new THREE.Vector3()
const _f = new THREE.Vector3()
const _c = new THREE.Vector3()
const _bw: BiomeWeights = [0, 0]

interface Emit {
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  life: number
  size0: number; size1: number
  alpha: number
  r: number; g: number; b: number
  /** Vertical acceleration (m/s²): smoke rises (+0.6, the default), spray falls (−9.8), foam floats (0). */
  grav?: number
}

const WATER = WorldFields.WATER

export class VehicleFx {
  readonly points: THREE.Points
  /** Active particle cap (quality tier). */
  budget = MAX
  private readonly material: THREE.ShaderMaterial
  /** Particle STATE (by pool slot) — separate from the packed GPU arrays below. */
  private readonly pos = new Float32Array(MAX * 3)
  private readonly col = new Float32Array(MAX * 3)
  private readonly vel = new Float32Array(MAX * 3)
  private readonly age = new Float32Array(MAX)
  private readonly life = new Float32Array(MAX)
  private readonly size0 = new Float32Array(MAX)
  private readonly size1 = new Float32Array(MAX)
  private readonly alpha = new Float32Array(MAX)
  private readonly grav = new Float32Array(MAX)
  private alive = 0
  private readonly sprayAcc = [0, 0]
  private roosterAcc = 0
  private wakeAcc = 0
  private cursor = 0
  private exhaustAcc = 0
  private readonly wheelAcc = [0, 0, 0, 0]
  private readonly posAttr: THREE.BufferAttribute
  private readonly dataAttr: THREE.BufferAttribute
  private readonly colAttr: THREE.BufferAttribute

  constructor() {
    const g = new THREE.BufferGeometry()
    // Packed GPU arrays: live particles compacted to the front each frame (t, size, alpha, kind per point).
    this.posAttr = new THREE.BufferAttribute(new Float32Array(MAX * 3), 3).setUsage(THREE.DynamicDrawUsage)
    this.dataAttr = new THREE.BufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage)
    this.colAttr = new THREE.BufferAttribute(new Float32Array(MAX * 3), 3).setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('position', this.posAttr)
    g.setAttribute('pdata', this.dataAttr)
    g.setAttribute('pcolor', this.colAttr)
    g.setDrawRange(0, 0)
    this.material = new THREE.ShaderMaterial({
      name: 'VehicleFx',
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 400 }, uLight: { value: new THREE.Color(1, 1, 1) } }]),
      vertexShader: /* glsl */ `
        attribute vec4 pdata; attribute vec3 pcolor;
        uniform float uScale;
        varying float vAlpha; varying vec3 vColor;
        #include <fog_pars_vertex>
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float t = pdata.x;
          // Quick fade in, long fade out; puffs grow as they thin.
          vAlpha = pdata.z * smoothstep(0.0, 0.08, t) * (1.0 - t) * (1.0 - t);
          vColor = pcolor;
          gl_PointSize = clamp(pdata.y * uScale / max(-mvPosition.z, 0.5), 1.0, 220.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uLight;
        varying float vAlpha; varying vec3 vColor;
        #include <fog_pars_fragment>
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float d = length(q) * 2.0;
          if (d > 1.0) discard;
          // Soft disc with a slightly denser core (reads as a puff, not a flat dot).
          float a = smoothstep(1.0, 0.25, d) * (0.6 + 0.4 * (1.0 - d)) * vAlpha;
          gl_FragColor = vec4(vColor * uLight, a);
          #include <fog_fragment>
        }`,
    })
    this.points = new THREE.Points(g, this.material)
    this.points.frustumCulled = false
    this.points.name = 'vehicleFx'
    this.points.visible = false
    this.points.renderOrder = 5
  }

  private spawn(e: Emit): void {
    if (this.alive >= Math.min(this.budget, MAX)) return
    // Ring cursor over the pool; a slot whose particle is still alive is skipped (bounded scan).
    for (let tries = 0; tries < MAX; tries++) {
      const i = this.cursor
      this.cursor = (this.cursor + 1) % MAX
      if (this.age[i] < this.life[i]) continue
      this.pos[i * 3] = e.x; this.pos[i * 3 + 1] = e.y; this.pos[i * 3 + 2] = e.z
      this.vel[i * 3] = e.vx; this.vel[i * 3 + 1] = e.vy; this.vel[i * 3 + 2] = e.vz
      this.age[i] = 0
      this.life[i] = e.life
      this.size0[i] = e.size0
      this.size1[i] = e.size1
      this.alpha[i] = e.alpha
      this.grav[i] = e.grav ?? 0.6
      this.col[i * 3] = e.r; this.col[i * 3 + 1] = e.g; this.col[i * 3 + 2] = e.b
      this.alive++
      return
    }
  }

  /**
   * @param light ambient light colour for the smoke (hemi sky × intensity + a share of the sun)
   * @param rtHeight height of the render target in pixels (point sizes are in RT pixels)
   */
  update(dt: number, car: Car, fields: WorldFields, camPos: THREE.Vector3, wind: THREE.Vector2, light: THREE.Color, rtHeight: number): void {
    const sim = car.sim
    const near = car.pos.distanceToSquared(camPos) < 90 * 90
    const wx = wind.x * 0.35, wz = wind.y * 0.35
    // --- emit
    if (near && sim.enabled) {
      car.forward(_f)
      const speed = Math.abs(sim.speed)
      if (car.driving) {
        // Exhaust: 5 puffs/s at idle, ~34/s flat out; a little faster and thicker under boost.
        const th = Math.abs(sim.controls.throttle)
        this.exhaustAcc += dt * (5 + 29 * th) * (sim.controls.boost ? 1.3 : 1)
        car.exhaustWorld(_v)
        while (this.exhaustAcc >= 1) {
          this.exhaustAcc -= 1
          const j = 0.35
          this.spawn({
            x: _v.x + (Math.random() - 0.5) * 0.12, y: _v.y + (Math.random() - 0.5) * 0.08, z: _v.z + (Math.random() - 0.5) * 0.12,
            vx: -_f.x * (1.2 + th) + (Math.random() - 0.5) * j + wx, vy: 0.5 + Math.random() * 0.5, vz: -_f.z * (1.2 + th) + (Math.random() - 0.5) * j + wz,
            life: 1.3 + Math.random() * 0.6 + th * 0.4, size0: 0.22, size1: 1.0 + th * 0.6, alpha: 0.3 + th * 0.2 + (sim.controls.boost ? 0.1 : 0),
            r: 0.62, g: 0.64, b: 0.68,
          })
        }
      }
      if (sim.boat > 0.5 && sim.wet > 0.05) this.water(dt, car)
      for (let k = 0; k < 4; k++) {
        const w = sim.wheels[k]
        if (!w.contact) {
          this.wheelAcc[k] = 0
          continue
        }
        car.wheelContact(k, _c)
        const road = fields.roadDistance(_c.x, _c.z) < WorldFields.ROAD_HALF_WIDTH + 0.3
        const slip = sim.wheelSlip[k]
        // Rolling dust off the asphalt at speed; smoke / dust from slip on any surface.
        const roll = road ? 0 : Math.max(0, speed - 4) / 22
        const rate = roll * 10 + slip * 42
        if (rate < 0.5) continue
        this.wheelAcc[k] += dt * rate
        if (this.wheelAcc[k] < 1) continue
        const bw = fields.biome(_c.x, _c.z, _bw, _c.y)
        let r = 0.6, g = 0.5, b = 0.36 // dirt / dry grass
        let s1 = 2.4, life = 1.7, a = 0.26
        if (road) {
          r = 0.82; g = 0.82; b = 0.85 // tyre smoke
          s1 = 2.2; life = 1.5; a = 0.3 * Math.min(1, slip * 1.5)
        } else if (bw[1] > 0.5) {
          r = 0.9; g = 0.93; b = 1.0 // snow powder
          s1 = 2.0; life = 1.3; a = 0.32
        } else if (bw[0] > 0.5) {
          r = 0.8; g = 0.68; b = 0.44 // sand
          s1 = 3.0; life = 2.0; a = 0.3
        }
        // Thrown against the wheel's travel and along the slide, low and outward, then it rises and thins.
        const lat = sim.lateral
        const rx = -_f.z, rz = _f.x // chassis right (world, horizontal)
        const dir = sim.speed >= 0 ? -1 : 1
        while (this.wheelAcc[k] >= 1) {
          this.wheelAcc[k] -= 1
          const sp = Math.min(6, speed * 0.25 + slip * 3)
          this.spawn({
            x: _c.x + (Math.random() - 0.5) * 0.4, y: _c.y + 0.1, z: _c.z + (Math.random() - 0.5) * 0.4,
            vx: _f.x * dir * sp + rx * lat * 0.5 + (Math.random() - 0.5) * 1.2 + wx, vy: 0.6 + Math.random() * 0.9 + slip * 0.8, vz: _f.z * dir * sp + rz * lat * 0.5 + (Math.random() - 0.5) * 1.2 + wz,
            life: life * (0.8 + Math.random() * 0.4), size0: 0.35 + slip * 0.3, size1: s1 * (0.8 + slip * 0.5), alpha: a * (0.7 + Math.random() * 0.5),
            r, g, b,
          })
        }
      }
    } else {
      this.exhaustAcc = 0
    }
    sim.splash = 0
    // --- integrate + pack
    let n = 0
    if (this.alive > 0) {
      const drag = Math.exp(-dt * 1.4)
      for (let i = 0; i < MAX; i++) {
        if (this.age[i] >= this.life[i]) continue
        this.age[i] += dt
        if (this.age[i] >= this.life[i]) {
          this.alive--
          continue
        }
        const t = this.age[i] / this.life[i]
        const o = i * 3
        // Slows in the air, keeps a slow rise (buoyant), drifts on the wind (already in the velocity).
        this.vel[o] *= drag
        this.vel[o + 1] = this.vel[o + 1] * drag + dt * this.grav[i]
        this.vel[o + 2] *= drag
        this.pos[o] += this.vel[o] * dt
        this.pos[o + 1] += this.vel[o + 1] * dt
        this.pos[o + 2] += this.vel[o + 2] * dt
        // Falling spray lands on the water and becomes foam: stays on the surface, slows, spreads, fades.
        if (this.grav[i] < 0 && this.pos[o + 1] < WATER + 0.03 && this.vel[o + 1] < 0) {
          this.pos[o + 1] = WATER + 0.03
          this.vel[o] *= 0.3
          this.vel[o + 1] = 0
          this.vel[o + 2] *= 0.3
          this.grav[i] = 0
        }
        // Compact into the front of the draw range (points draw the first n slots).
        const d = n * 3, q = n * 4
        const P = this.posAttr.array as Float32Array, C = this.colAttr.array as Float32Array, D = this.dataAttr.array as Float32Array
        P[d] = this.pos[o]; P[d + 1] = this.pos[o + 1]; P[d + 2] = this.pos[o + 2]
        C[d] = this.col[o]; C[d + 1] = this.col[o + 1]; C[d + 2] = this.col[o + 2]
        D[q] = t
        D[q + 1] = this.size0[i] + (this.size1[i] - this.size0[i]) * Math.sqrt(t)
        D[q + 2] = this.alpha[i]
        D[q + 3] = 0
        n++
      }
    }
    this.points.geometry.setDrawRange(0, n)
    this.points.visible = n > 0
    if (n > 0) {
      this.posAttr.addUpdateRange(0, n * 3)
      this.colAttr.addUpdateRange(0, n * 3)
      this.dataAttr.addUpdateRange(0, n * 4)
      this.posAttr.needsUpdate = this.colAttr.needsUpdate = this.dataAttr.needsUpdate = true
    }
    const u = this.material.uniforms
    u.uScale.value = rtHeight * 0.714 // 1 / (2·tan(35°)) for the 70° camera
    ;(u.uLight.value as THREE.Color).copy(light)
  }

  /** The boat on the water (`_f` = its forward axis): bow spray, rooster tail, wake foam, the splash of a hard hit.
   *  Rates scale with the tier's particle budget; ~110 live particles flat out on HIGH. */
  private water(dt: number, car: Car): void {
    const sim = car.sim
    const lv = sim.body.linvel()
    const k0 = Math.min(this.budget, MAX) / MAX
    const sp = Math.abs(sim.speed)
    const rx = -_f.z, rz = _f.x // chassis right (world, horizontal)
    const white = { r: 0.92, g: 0.95, b: 0.97 }
    // BOW SPRAY: peels off both shoulders with speed, thrown out and up, falls back as foam.
    const sprayRate = Math.max(0, sp - 2) * 3 * k0
    for (let k = 0; k < 2; k++) {
      this.sprayAcc[k] += dt * sprayRate
      if (this.sprayAcc[k] < 1) continue
      car.bowSprayWorld(k, _c)
      const side = k === 0 ? -1 : 1
      while (this.sprayAcc[k] >= 1) {
        this.sprayAcc[k] -= 1
        const out = 1.2 + sp * 0.14 + Math.random() * 1.2, back = Math.random() * 1.5
        this.spawn({
          x: _c.x + (Math.random() - 0.5) * 0.3, y: WATER + 0.05, z: _c.z + (Math.random() - 0.5) * 0.3,
          vx: lv.x * 0.55 + rx * side * out - _f.x * back, vy: 1.4 + sp * 0.12 + Math.random() * 1.2, vz: lv.z * 0.55 + rz * side * out - _f.z * back,
          life: 0.9 + Math.random() * 0.5, size0: 0.25, size1: 1.1 + sp * 0.04, alpha: 0.55, ...white, grav: -9.8,
        })
      }
    }
    // ROOSTER TAIL: the jet under throttle throws a plume up and back off the nozzle.
    const thr = Math.max(0, sim.controls.throttle)
    this.roosterAcc += dt * thr * (12 + sp * 1.2) * k0
    if (this.roosterAcc >= 1) car.nozzleWorld(_v)
    while (this.roosterAcc >= 1) {
      this.roosterAcc -= 1
      const kick = 3 + sp * 0.35 + Math.random() * 1.5
      this.spawn({
        x: _v.x, y: Math.max(_v.y, WATER + 0.05), z: _v.z,
        vx: lv.x * 0.4 - _f.x * kick + (Math.random() - 0.5) * 0.8, vy: 2.2 + thr * 2.5 + sp * 0.1 + Math.random() * 1.2, vz: lv.z * 0.4 - _f.z * kick + (Math.random() - 0.5) * 0.8,
        life: 1.0 + Math.random() * 0.4, size0: 0.3, size1: 1.6, alpha: 0.5, ...white, grav: -9.8,
      })
    }
    // WAKE: foam left on the water off both stern corners, spreading and fading behind the boat.
    this.wakeAcc += dt * Math.max(0, sp - 1) * 1.5 * k0
    if (this.wakeAcc >= 1) car.nozzleWorld(_v)
    while (this.wakeAcc >= 1) {
      this.wakeAcc -= 1
      const side = Math.random() < 0.5 ? -1 : 1
      this.spawn({
        x: _v.x + rx * side * (0.6 + Math.random() * 0.4), y: WATER + 0.03, z: _v.z + rz * side * (0.6 + Math.random() * 0.4),
        vx: rx * side * 0.6, vy: 0, vz: rz * side * 0.6,
        life: 2.6, size0: 0.5, size1: 2.4, alpha: 0.32, r: 0.86, g: 0.91, b: 0.93, grav: 0,
      })
    }
    // SPLASH: the hull hitting the water (from a jump, a drop off the bank, landing from the air).
    if (sim.splash > 0) {
      const n = Math.round(Math.min(36, sim.splash * 5) * k0)
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, out = 1.5 + Math.random() * 2.5
        const along = (Math.random() - 0.5) * 4, across = (Math.random() - 0.5) * 2
        this.spawn({
          x: car.pos.x + _f.x * along + rx * across, y: WATER + 0.05, z: car.pos.z + _f.z * along + rz * across,
          vx: Math.cos(a) * out + lv.x * 0.3, vy: 2.5 + Math.random() * 3.5 + sim.splash * 0.2, vz: Math.sin(a) * out + lv.z * 0.3,
          life: 1.1 + Math.random() * 0.3, size0: 0.4, size1: 1.8, alpha: 0.6, ...white, grav: -9.8,
        })
      }
    }
  }

  dispose(): void {
    this.points.geometry.dispose()
    this.material.dispose()
  }
}
