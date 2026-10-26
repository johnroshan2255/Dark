import * as THREE from 'three'
import { vehicleDef } from '../gameplay/vehicle/catalogue'
import { ATMOS_GLSL, FRAG_OUT, type Atmosphere } from './Atmosphere'
import type { MapData } from './MapData'
import type { Tier } from './quality'
import type { Vehicle } from './Vehicle'

/**
 * DUST AND SMOKE — the car's: soft painterly puffs kicked up behind the tyres (thick orange-brown off the dirt tracks,
 * a little off the grass, grey off rock, pale off the gravel at the water — more the faster the car goes and the more
 * a tyre slips) and exhaust SMOKE from the tailpipes (the catalogue's tips: a thin haze at idle, a grey puff when the
 * gas goes down). One instanced draw of camera-facing quads fed from a ring of particles (160 LOW … 360 ULTRA), each
 * lit as a soft ball by the sun and the sky (and glowing when the low sun is behind it), fogged like everything
 * else, alpha-blended, no depth writes.
 * Cost: CPU ≈ 0.02–0.05 ms (the ring's update, one height lookup per live puff, two small attribute uploads);
 * GPU: the overdraw of the live puffs (~40–150 soft quads while driving on a track).
 */
const K = 14 // floats per particle: x y z  vx vy vz  age life  size0 size1  r g b  alpha0

export class Dust {
  readonly mesh: THREE.Mesh
  private readonly n: number
  private readonly st: Float32Array
  private readonly aP: THREE.InstancedBufferAttribute // x y z size
  private readonly aC: THREE.InstancedBufferAttribute // r g b alpha
  private next = 0
  private readonly acc = [0, 0, 0, 0, 0] // emission carried over per wheel + the exhaust
  private readonly mk: [number, number, number, number] = [0, 0, 0, 0]
  private readonly v = new THREE.Vector3()
  private readonly d = new THREE.Vector3()
  private carId = ''
  private tips: { at: THREE.Vector3; dir: THREE.Vector3 }[] = []
  private seed = 0x2545f491
  private live = 0

  constructor(private readonly map: MapData, atmos: Atmosphere, tier: Tier) {
    this.n = tier.name === 'low' ? 160 : tier.name === 'medium' ? 220 : tier.name === 'high' ? 290 : 360
    this.st = new Float32Array(this.n * K)
    const quad = new THREE.PlaneGeometry(1, 1)
    const g = new THREE.InstancedBufferGeometry()
    g.index = quad.index
    g.setAttribute('position', quad.attributes.position)
    this.aP = new THREE.InstancedBufferAttribute(new Float32Array(this.n * 4), 4).setUsage(THREE.DynamicDrawUsage)
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(this.n * 4), 4).setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('aP', this.aP)
    g.setAttribute('aC', this.aC)
    g.instanceCount = this.n
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...atmos.uniforms },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
    })
    this.mesh = new THREE.Mesh(g, mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 6 // (after the water)
  }

  /** Live puffs (the HUD). */
  get count(): number { return this.live }

  private rnd(): number {
    let s = this.seed
    s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x6d2b79f5) >>> 0
    this.seed = s
    return s / 4294967296
  }

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, r: number, g: number, b: number, a: number): void {
    const o = this.next * K, st = this.st
    this.next = (this.next + 1) % this.n // (the ring: the oldest puff gives way)
    st[o] = x; st[o + 1] = y; st[o + 2] = z
    st[o + 3] = vx; st[o + 4] = vy; st[o + 5] = vz
    st[o + 6] = 0; st[o + 7] = life
    st[o + 8] = s0; st[o + 9] = s1
    st[o + 10] = r; st[o + 11] = g; st[o + 12] = b; st[o + 13] = a
  }

  /** One frame: the car's tyres and tailpipes emit, every puff drifts, grows and fades. */
  update(dt: number, car: Vehicle): void {
    if (dt <= 0) return
    if (car.sim && car.model) this.emit(dt, car)
    const st = this.st, P = this.aP.array as Float32Array, C = this.aC.array as Float32Array
    const drag = Math.exp(-dt * 1.6)
    let live = 0
    for (let i = 0; i < this.n; i++) {
      const o = i * K, life = st[o + 7]
      if (life <= 0) { P[i * 4 + 3] = 0; continue }
      const age = st[o + 6] + dt
      if (age >= life) { st[o + 7] = 0; P[i * 4 + 3] = 0; continue }
      live++
      st[o + 6] = age
      // air drag, and a slow rise (warm air; the dust settles less than it rises in the painterly look)
      st[o + 3] *= drag; st[o + 5] *= drag
      st[o + 4] = st[o + 4] * drag + dt * 0.22
      st[o] += st[o + 3] * dt; st[o + 1] += st[o + 4] * dt; st[o + 2] += st[o + 5] * dt
      const t = age / life, size = st[o + 8] + (st[o + 9] - st[o + 8]) * (1 - (1 - t) * (1 - t))
      // (never into the ground: the puff's middle stays a third of its size above it)
      const deck = this.map.bridgeAt(st[o], st[o + 2])
      const floor = Math.max(this.map.height(st[o], st[o + 2]), deck ?? -1e9) + size * 0.3
      if (st[o + 1] < floor) { st[o + 1] = floor; st[o + 4] = Math.max(0, st[o + 4]) }
      P[i * 4] = st[o]; P[i * 4 + 1] = st[o + 1]; P[i * 4 + 2] = st[o + 2]; P[i * 4 + 3] = size
      C[i * 4] = st[o + 10]; C[i * 4 + 1] = st[o + 11]; C[i * 4 + 2] = st[o + 12]
      C[i * 4 + 3] = st[o + 13] * Math.min(1, t * 8) * Math.pow(1 - t, 1.6) // (a quick swell, a long fade)
    }
    this.live = live
    this.aP.needsUpdate = true
    this.aC.needsUpdate = true
  }

  private emit(dt: number, car: Vehicle): void {
    const sim = car.sim, model = car.model, q = car.root.quaternion, p = car.root.position
    if (car.id !== this.carId) {
      this.carId = car.id
      const def = vehicleDef(car.id)
      const tips = def.exhaust?.length ? def.exhaust : [{ at: [-0.42, 0.3, model.half.z * 0.96] as [number, number, number], dir: [0, 0, 1] as [number, number, number] }]
      this.tips = tips.map((e) => ({ at: new THREE.Vector3(...e.at), dir: new THREE.Vector3(...e.dir).normalize() }))
    }
    const lv = sim.body.linvel()
    const speed = Math.hypot(lv.x, lv.z)
    const go = Math.max(0, Math.min(1, (speed - 1.5) / 12))
    const hw = this.map.meta.trails.hw
    // TYRES: dust from each wheel on the ground, by what it rolls on
    for (let k = 0; k < 4; k++) {
      const wk = sim.wheels[k]
      if (!wk.contact) { this.acc[k] = 0; continue }
      const [hx, hy, hz] = model.wheelPos[k]
      const c = this.v.set(hx, hy + wk.lift - model.wheelRadius * 0.85, hz).applyQuaternion(q).add(p)
      const deck = this.map.bridgeAt(c.x, c.z)
      if (deck !== null && c.y > deck - 0.6) { this.acc[k] = 0; continue } // (planks: no dust)
      const m = this.map.maskAt(c.x, c.z, this.mk)
      const track = Math.max(0, Math.min(1, (hw + 0.8 - this.map.trailDist(c.x, c.z)) / 1.2))
      const bank = m[2] > 0.75 ? 1 - track : 0
      const rock = Math.min(1, m[0] * 1.6) * (1 - track) * (1 - bank)
      const grass = Math.max(0, 1 - track - bank - rock)
      const amt = track * 1.0 + bank * 0.55 + rock * 0.3 + grass * 0.16
      const slip = sim.wheelSlip[k] ?? 0
      this.acc[k] += amt * (go * 20 + slip * 42) * dt
      if (this.acc[k] < 1) continue
      // the colour: track dust (the dirt's orange-brown, paler), gravel, rock grey, dry grass-earth
      const r = track * 0.68 + bank * 0.72 + rock * 0.56 + grass * 0.5
      const g = track * 0.47 + bank * 0.67 + rock * 0.54 + grass * 0.45
      const b = track * 0.32 + bank * 0.58 + rock * 0.5 + grass * 0.32
      const big = 0.7 + 0.6 * go + 0.5 * slip
      while (this.acc[k] >= 1) {
        this.acc[k] -= 1
        const jx = (this.rnd() - 0.5) * 0.5, jz = (this.rnd() - 0.5) * 0.5
        // thrown back and out from the tyre, carried a little with the car, lifting
        this.spawn(c.x + jx, c.y + 0.1 + this.rnd() * 0.2, c.z + jz,
          lv.x * 0.25 + jx * 3 + (this.rnd() - 0.5) * 1.2, 0.4 + this.rnd() * 1.1 + slip * 0.8, lv.z * 0.25 + jz * 3 + (this.rnd() - 0.5) * 1.2,
          1.6 + this.rnd() * 1.8, (0.5 + this.rnd() * 0.4) * big, (2.2 + this.rnd() * 2.0) * big,
          r, g, b, Math.min(0.55, 0.3 * amt + 0.12 * slip))
      }
    }
    // EXHAUST: a thin haze at idle, a grey puff on the gas, from every tip
    const thr = Math.min(1, Math.abs(sim.controls.throttle))
    this.acc[4] += (6 + 30 * thr) * dt
    while (this.acc[4] >= 1) {
      this.acc[4] -= 1
      const tip = this.tips[Math.floor(this.rnd() * this.tips.length)]
      const at = this.v.copy(tip.at).applyQuaternion(q).add(p), dir = this.d.copy(tip.dir).applyQuaternion(q)
      const out = 1.2 + 2.6 * thr, sh = 0.62 - 0.3 * thr
      this.spawn(at.x, at.y, at.z,
        dir.x * out + lv.x * 0.85 + (this.rnd() - 0.5) * 0.3, dir.y * out + lv.y * 0.85 + 0.25 + this.rnd() * 0.3, dir.z * out + lv.z * 0.85 + (this.rnd() - 0.5) * 0.3,
        0.9 + this.rnd() * 0.9, 0.12, 0.8 + 0.9 * thr + this.rnd() * 0.3,
        sh, sh + 0.01, sh + 0.04, 0.1 + 0.22 * thr)
    }
  }
}

const VERT = /* glsl */ `
in vec4 aP;
in vec4 aC;
out vec2 vQ;
out vec2 vR;
out vec4 vC;
out vec3 vWorld;
out vec3 vRight;
out vec3 vUp;
out float vSeed;
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  // each puff turned its own way (the noise in it differs)
  float a = float(gl_InstanceID) * 2.39996;
  vec2 q = position.xy * 2.0;
  vec2 r = vec2(q.x * cos(a) - q.y * sin(a), q.x * sin(a) + q.y * cos(a));
  vec3 w = aP.xyz + (right * q.x + up * q.y) * aP.w * 0.5;
  vQ = q;
  vR = r;
  vSeed = fract(float(gl_InstanceID) * 0.618034);
  vC = aC;
  vWorld = w;
  vRight = right;
  vUp = up;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
  if (aP.w <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // (a dead puff: off screen)
}
`

const FRAG = /* glsl */ `
${FRAG_OUT}
${ATMOS_GLSL}
in vec2 vQ;
in vec2 vR;
in vec4 vC;
in vec3 vWorld;
in vec3 vRight;
in vec3 vUp;
in float vSeed;
void main() {
  float r = length(vQ);
  if (r > 1.0) discard;
  // a soft ball with a ragged, brushy edge (the paint noise, its own patch per puff)
  float nz = texture(uNoise, vR * 0.18 + vec2(vSeed, vSeed * 1.7) + uTime * 0.01).r;
  float edge = 1.0 - smoothstep(0.3, 1.0, r + (nz - 0.5) * 0.55);
  float a = vC.a * edge;
  if (a < 0.004) discard;
  vec3 V = normalize(uCamPos - vWorld);
  vec3 N = normalize(vRight * vQ.x + vUp * vQ.y + V * sqrt(max(0.0, 1.0 - r * r)));
  float diff = clamp(dot(N, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = vC.rgb * (uSunColor * (0.2 + 0.55 * diff) + ambient(N));
  // the low sun behind it: the dust glows (forward scattering)
  col += vC.rgb * uSunColor * pow(max(dot(-V, uSunDir), 0.0), 6.0) * 0.7;
  gl_FragColor = vec4(applyAtmos(col, vWorld), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
