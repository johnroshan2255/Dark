import * as THREE from 'three'
import { loadVehicle, type TruckModel } from '../assets/loadModels'
import { VEHICLES, vehicleDef } from '../gameplay/vehicle/catalogue'
import { resolveSpec } from '../gameplay/vehicle/drivetrain/spec'
import { blendRoughness, Surf, type SurfaceMix } from '../gameplay/vehicle/drivetrain/tyre'
import { TruckSim } from '../gameplay/vehicle/VehicleSim'
import { ATMOS_GLSL, FRAG_OUT, type Atmosphere } from './Atmosphere'
import type { MapData } from './MapData'
import type { OthPhysics } from './Physics'
import type { Tier } from './quality'
import { SHADOW_GLSL, type TerrainShadow } from './TerrainShadow'

/**
 * THE 4×4 — the game's vehicles on this map: the same models (assets/loadModels `loadVehicle`) and the same physics
 * (gameplay/vehicle TruckSim + the realistic drivetrain from each car's spec sheet, Simulation handling with full
 * aids and the off-road assist), drawn here with this world's light (ATMOS_GLSL `shade`, the terrain's baked sun
 * shadow) and a soft contact shadow on the ground. The tyres feel this map's surfaces: dirt on the tracks, grass on
 * the meadows, sand/gravel at the water, rock on rock.
 *
 * Controls — keys: W / S gas, brake → reverse, A / D steer, Space handbrake, Shift boost, R back on the wheels, 1 / 2 /
 * 3 the car. Touch: ◀ ▶ steer, GAS / BRAKE, ⟲. Mouse / finger drag on the view orbits the chase camera.
 */
export class Vehicle {
  readonly root = new THREE.Group()
  sim!: TruckSim
  model!: TruckModel
  id = ''
  private readonly wheels: THREE.Mesh[] = []
  private readonly prevP = new THREE.Vector3()
  private readonly curP = new THREE.Vector3()
  private readonly prevQ = new THREE.Quaternion()
  private readonly curQ = new THREE.Quaternion()
  readonly pos = new THREE.Vector3()
  private readonly uniforms: Record<string, THREE.IUniform>
  private readonly shadow: THREE.Mesh
  private readonly keys = new Set<string>()
  private pedal = 0
  private steerK = 0
  private hold = 0
  /** Touch pedals / steering (−1 … 1), from the on-screen buttons. */
  readonly touch = { gas: 0, brake: 0, left: 0, right: 0 }
  private loading = false
  /** ?paint=rrggbb: the body colour (default: this world's own per car — warm, muted, like the OTH overlanders). */
  paint: string | null = null
  private readonly shadowSize = new THREE.Vector3(1, 1, 1)
  private readonly shadowBase: Float32Array

  constructor(private readonly map: MapData, private readonly physics: OthPhysics, atmos: Atmosphere, shadow: TerrainShadow, tier: Tier, farGrid: THREE.Vector4) {
    this.uniforms = { ...atmos.uniforms, ...shadow.uniforms, uFarGrid: { value: farGrid }, uMap: { value: null }, uPaintMask: { value: null }, uPaint: { value: new THREE.Color(1, 1, 1) }, uSunHere: { value: 1 } }
    void tier
    // the contact shadow: a grid that follows the ground under the car, darkest under the body, soft at the edge
    const sg = new THREE.PlaneGeometry(1, 1, 14, 14).rotateX(-Math.PI / 2)
    this.shadow = new THREE.Mesh(sg, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: /* glsl */ `out vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `layout(location = 0) out highp vec4 outColor; in vec2 vUv;
        void main() { vec2 q = (vUv - 0.5) * 2.0; float d = length(q * vec2(1.0, 1.0)); outColor = vec4(0.06, 0.04, 0.05, 0.5 * (1.0 - smoothstep(0.35, 1.0, d))); }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    }))
    this.shadow.frustumCulled = false
    this.shadowBase = (sg.attributes.position.array as Float32Array).slice()
    this.shadow.renderOrder = 2
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code)
      if (e.code === 'KeyR') this.reset()
      if (e.code === 'KeyL') this.lightMode = this.lightMode === 'auto' ? 'off' : this.lightMode === 'off' ? 'on' : 'auto'
      const n = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code)
      if (n >= 0 && VEHICLES[n]) void this.setCar(VEHICLES[n].id)
    })
    window.addEventListener('keyup', (e) => this.keys.delete(e.code))
    window.addEventListener('blur', () => this.keys.clear())
  }

  /** Called when a car replaces the one driving (not the first): the sound stops one engine, starts the next. */
  onCarChange?: () => void

  /** Load car `id` and put it where the old one was (or on the map's first track at the start). */
  async setCar(id: string): Promise<void> {
    if (this.loading || id === this.id) return
    this.loading = true
    if (this.sim) this.onCarChange?.()
    const def = vehicleDef(id)
    const truck = await loadVehicle(def.id)
    let at: { x: number; z: number; heading: number }
    if (this.sim) {
      const t = this.sim.body.translation()
      at = { x: t.x, z: t.z, heading: this.sim.heading }
      this.sim.dispose()
    } else {
      const L = this.map.meta.trails.lines[0]
      const [x, z] = L[2], [x2, z2] = L[6]
      at = { x, z, heading: Math.atan2(-(x2 - x), -(z2 - z)) }
    }
    this.id = def.id
    this.model = truck
    this.sim = new TruckSim(this.physics.pw, truck, { ...def.stock })
    this.sim.setDrivetrain(resolveSpec(def.spec, { wheelPos: truck.wheelPos, half: truck.half }), { ...def.stock })
    this.sim.offroadAssist = true
    const D = this.sim.drivetrain
    if (D) D.aids = 'full'
    this.sim.surface = (x, z, out) => this.surfaceAt(x, z, out)
    this.buildMeshes(truck, this.paint ?? OTH_PAINT[def.id] ?? def.stock.paint)
    this.physics.follow(at.x, at.z)
    this.sim.place(at.x, this.map.height(at.x, at.z) + 0.6, at.z, at.heading)
    this.readPose(this.curP, this.curQ)
    this.prevP.copy(this.curP); this.prevQ.copy(this.curQ)
    this.loading = false
  }

  /** R: back on its wheels where it is, same heading. */
  reset(): void {
    if (!this.sim) return
    const t = this.sim.body.translation()
    this.physics.follow(t.x, t.z)
    this.sim.place(t.x, this.map.height(t.x, t.z) + 0.8, t.z, this.sim.heading)
  }

  /** How wet the land is (main.ts: the weather's uWet): the tyres lose grip (each surface's own `wet`), the tracks
   *  turn half to MUD in the rain. */
  wet = 0
  /** What the tyres are on: dirt on the tracks, sand / gravel at the water, rock on the rock mask, else grass. */
  private readonly mk: [number, number, number, number] = [0, 0, 0, 0]
  private surfaceAt(x: number, z: number, out: SurfaceMix): void {
    const w = out.w
    w.fill(0)
    out.wet = this.wet
    out.wash = 0
    // on a BRIDGE's planks (above the water under it): a hard, slightly rough surface
    const deck = this.map.bridgeAt(x, z)
    if (deck !== null && this.sim && this.sim.body.translation().y > deck - 0.5) {
      w[Surf.Asphalt] = 0.7; w[Surf.Dirt] = 0.3
      blendRoughness(out)
      return
    }
    const m = this.map.maskAt(x, z, this.mk)
    const track = Math.max(0, Math.min(1, (this.map.meta.trails.hw + 0.3 - this.map.trailDist(x, z)) / 0.6))
    const water = m[2] > 0.9 ? 1 : 0
    const rock = Math.min(1, m[0] * 1.5) * (1 - track)
    const rest = Math.max(0, 1 - track - water - rock)
    w[Surf.Dirt] = track * (1 - 0.5 * this.wet)
    w[Surf.Mud] = track * 0.5 * this.wet
    w[Surf.Sand] = water
    w[Surf.Asphalt] = rock * 0.6 // (bare rock grips like a hard surface; rougher, see below)
    w[Surf.Dirt] += rock * 0.4
    w[Surf.Grass] = rest
    // the MUD of the marsh, the mud holes and the banks (mud.bin): it takes over what's under it
    const mud = this.map.mudAt(x, z) * (1 - water)
    if (mud > 0.01) { for (let k = 0; k < w.length; k++) w[k] *= 1 - mud; w[Surf.Mud] += mud }
    blendRoughness(out)
    out.stones *= 1 + rock
  }

  private buildMeshes(truck: TruckModel, paint: string): void {
    for (const c of [...this.root.children]) this.root.remove(c)
    this.lampMesh = this.tailMesh = null
    this.wheels.length = 0
    const u = this.uniforms
    u.uMap.value = truck.map
    u.uPaintMask.value = truck.paintMap
    ;(u.uPaint.value as THREE.Color).set(paint)
    const defines: Record<string, string> = { OTH_SPEC: '' }
    if (truck.map) defines.USE_MAP_OTH = ''
    if (truck.paintMap) defines.USE_PAINTMAP = ''
    const vc = (g: THREE.BufferGeometry) => !!g.attributes.color
    const body = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: u, defines, vertexShader: VERT, fragmentShader: FRAG, vertexColors: vc(truck.body) })
    const glass = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: u, defines: { OTH_SPEC: '', GLASS: '' }, vertexShader: VERT, fragmentShader: FRAG, transparent: true, vertexColors: vc(truck.glass), side: THREE.DoubleSide })
    const b = new THREE.Mesh(truck.body, body)
    const g = new THREE.Mesh(truck.glass, glass)
    b.frustumCulled = g.frustumCulled = false
    g.renderOrder = 3 // (transparent: after the cabin behind it)
    this.root.add(b, g)
    // (a part with / without vertex colours gets its own copy of the body material)
    const bodyFor = (geo: THREE.BufferGeometry) => vc(geo) === vc(truck.body) ? body : new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: u, defines, vertexShader: VERT, fragmentShader: FRAG, vertexColors: vc(geo) })
    // the CABIN (dash, seats, console — seen through the windows)
    if (truck.cabin) {
      const cab = new THREE.Mesh(truck.cabin, bodyFor(truck.cabin))
      cab.frustumCulled = false
      this.root.add(cab)
    }
    // the FRONT DOORS and their windows (cut out of the body in the model: without them the cab stands open)
    for (const d of truck.doors) {
      const pivot = new THREE.Group()
      pivot.position.set(...d.hinge)
      const skin = new THREE.Mesh(d.body, bodyFor(d.body))
      skin.frustumCulled = false
      pivot.add(skin)
      if (d.glass) {
        const win = new THREE.Mesh(d.glass, vc(d.glass) === vc(truck.glass) ? glass : new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: u, defines: { OTH_SPEC: '', GLASS: '' }, vertexShader: VERT, fragmentShader: FRAG, transparent: true, vertexColors: vc(d.glass), side: THREE.DoubleSide }))
        win.frustumCulled = false
        win.renderOrder = 3
        pivot.add(win)
      }
      this.root.add(pivot)
    }
    const wheelMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: u, defines: { ...defines, WHEEL: '' }, vertexShader: VERT, fragmentShader: FRAG, vertexColors: vc(truck.wheel) })
    for (let k = 0; k < 4; k++) {
      const w = new THREE.Mesh(truck.wheel, wheelMat)
      w.frustumCulled = false
      this.wheels.push(w)
      this.root.add(w)
    }
    this.shadowSize.set(truck.half.x * 2 + 1.0, 1, truck.half.z * 2 + 1.2)
  }

  get shadowMesh(): THREE.Mesh { return this.shadow }

  /** Fixed step (60 Hz), before world.step(). */
  fixed(dt: number): void {
    if (!this.sim || this.loading) return
    const k = this.keys
    const t = this.sim.body.translation()
    this.physics.follow(t.x, t.z)
    const up = k.has('KeyW') || k.has('ArrowUp'), down = k.has('KeyS') || k.has('ArrowDown')
    const w = (up ? 1 : 0) - (down ? 1 : 0) + this.touch.gas - this.touch.brake
    const ad = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) + this.touch.right - this.touch.left
    // keys as a foot and hands (as the game does it): the gas squeezes on over 0.6 s, the brake over 0.3 s, the
    // wheel winds on over 0.45 s and centres in 0.15 s
    if (w === 0 || Math.sign(w) !== Math.sign(this.pedal)) this.pedal = 0
    this.pedal = w > 0 ? Math.min(1, this.pedal + dt / 0.6) : w < 0 ? Math.max(-1, this.pedal - dt / 0.3) : 0
    const st = this.steerK
    if (ad === 0 || (st !== 0 && Math.sign(ad) !== Math.sign(st))) {
      const d = dt / 0.15
      this.steerK = Math.abs(st) <= d ? 0 : st - Math.sign(st) * d
      this.hold = 0
    } else {
      this.hold = Math.min(1, this.hold + dt / 0.45)
      this.steerK = Math.sign(ad) * Math.max(Math.abs(st), this.hold * this.hold * (3 - 2 * this.hold))
    }
    const c = this.sim.controls
    c.throttle = this.pedal
    c.steer = this.steerK
    c.brake = down || this.touch.brake > 0
    c.handbrake = k.has('Space')
    c.boost = k.has('ShiftLeft') || k.has('ShiftRight')
    c.footBrake = 0
    c.lift = 0
    c.parked = false
    this.readPose(this.prevP, this.prevQ)
    this.sim.step(dt)
    this.sim.keepAbove(this.map.height(t.x, t.z))
    // FORDING (a river, a stream, a pond's edge): the water drags the car back by its depth (and holds it up a little
    // when it's deep) — a crossing is slow, a deep one a struggle
    const lvl = this.map.waterLevel(t.x, t.z)
    if (lvl !== null) {
      const depth = lvl - this.map.height(t.x, t.z)
      if (depth > 0.15) {
        const b = this.sim.body, v = b.linvel(), m = b.mass(), k = Math.min(1.2, depth) * 0.9
        b.applyImpulse({ x: -v.x * m * k * dt, y: m * 3 * Math.max(0, Math.min(1, depth - 0.6)) * dt, z: -v.z * m * k * dt }, true)
      }
    }
  }

  private readPose(p: THREE.Vector3, q: THREE.Quaternion): void {
    const t = this.sim.body.translation(), r = this.sim.body.rotation()
    p.set(t.x, t.y, t.z)
    q.set(r.x, r.y, r.z, r.w)
  }

  private readonly e = new THREE.Euler()
  /** Render frame: the interpolated pose, the wheels, the contact shadow. */
  update(alpha: number): void {
    if (!this.sim || this.loading) return
    this.readPose(this.curP, this.curQ)
    this.pos.lerpVectors(this.prevP, this.curP, alpha)
    this.root.position.copy(this.pos)
    this.root.quaternion.slerpQuaternions(this.prevQ, this.curQ, alpha)
    const w = this.sim.wheels, tr = this.model
    tr.wheelPos.forEach(([x, y, z], k) => {
      const right = k === 1 || k === 3
      const spin = -w[k].spin
      this.e.set(right ? -spin : spin, (right ? Math.PI : 0) - w[k].steer, 0, 'YXZ')
      const m = this.wheels[k]
      m.position.set(x, y + w[k].lift, z)
      m.quaternion.setFromEuler(this.e)
    })
    // the contact shadow: its grid laid on the ground under the body (world-space vertices, turned with the car)
    const sp = this.shadow.geometry.attributes.position as THREE.BufferAttribute
    const a = sp.array as Float32Array, base = this.shadowBase
    const h = this.sim.heading, cs = Math.cos(h), sn = Math.sin(h)
    for (let i = 0; i < sp.count; i++) {
      const lx = base[i * 3] * this.shadowSize.x, lz = base[i * 3 + 2] * this.shadowSize.z
      const x = this.pos.x + lx * cs + lz * sn, z = this.pos.z - lx * sn + lz * cs
      a[i * 3] = x; a[i * 3 + 1] = this.map.height(x, z) + 0.04; a[i * 3 + 2] = z
    }
    sp.needsUpdate = true
    this.shadow.visible = this.pos.y - this.map.height(this.pos.x, this.pos.z) < 3 // (none in the air)
  }

  /** L: headlights on / off / auto (auto = on from dusk). */
  private lightMode: 'auto' | 'on' | 'off' = 'auto'
  private lampMesh: THREE.InstancedMesh | null = null
  private tailMesh: THREE.InstancedMesh | null = null
  private beams: THREE.Mesh | null = null
  private readonly lampMat = glowMaterial(new THREE.Color(1, 0.9, 0.72))
  private readonly tailMat = glowMaterial(new THREE.Color(1, 0.07, 0.03))
  private readonly beamMat = beamMaterial()
  private brakeK = 0
  private readonly lampL = new THREE.Vector3()
  private readonly lampR = new THREE.Vector3()
  /** The car's lights (2026-10-27, the user: "the headlight comes from the centre of the front, not the headlamps; the
   *  back light should light when we brake; use a light like paint"): the shared uniforms put a painted BEAM from each
   *  lamp on every surface (Atmosphere `headlight()`) and the brake lights' red pool behind; the lenses GLOW (soft
   *  painted halos, above white: the bloom takes them), at night a faint painted cone of light in the air ahead. The
   *  BRAKE LIGHTS burn whenever the brake is on while rolling forward (S / BRAKE; S at a standstill is reverse) or the
   *  handbrake is pulled, day or night; with the headlights on the tail lamps glow dim. */
  lights(atmos: Atmosphere, dt = 1 / 60): void {
    if (!this.sim || !this.model) return
    const on = this.lightMode === 'on' || (this.lightMode === 'auto' && atmos.uniforms.uNight.value > 0.25)
    const u = atmos.uniforms, head = this.model.lamps.head, tail = this.model.lamps.tail, hz = this.model.half, q = this.root.quaternion
    const h = head ? head.c : [hz.x * 0.7, 0.9, -hz.z], t = tail ? tail.c : [hz.x * 0.75, 0.9, hz.z]
    this.lampL.set(-Math.abs(h[0]), h[1], h[2] - 0.05).applyQuaternion(q).add(this.root.position)
    this.lampR.set(Math.abs(h[0]), h[1], h[2] - 0.05).applyQuaternion(q).add(this.root.position)
    u.uHeadL.value.set(this.lampL.x, this.lampL.y, this.lampL.z, on ? 1 : 0)
    u.uHeadR.value.copy(this.lampR)
    u.uHeadDir.value.set(0, 0, -1).applyQuaternion(q)
    u.uHeadUp.value.set(0, 1, 0).applyQuaternion(q)
    const c = this.sim.controls, braking = (c.brake && this.sim.speed > 0.4) || c.handbrake
    this.brakeK = braking ? Math.min(1, this.brakeK + dt / 0.06) : Math.max(0, this.brakeK - dt / 0.12)
    const tc = new THREE.Vector3(0, t[1], t[2] + 0.1).applyQuaternion(q).add(this.root.position)
    u.uTail.value.set(tc.x, tc.y, tc.z, this.brakeK)
    if (!this.lampMesh) {
      const g = new THREE.PlaneGeometry(2, 2)
      this.lampMesh = new THREE.InstancedMesh(g, this.lampMat, 2)
      this.tailMesh = new THREE.InstancedMesh(g, this.tailMat, 2)
      this.lampMesh.frustumCulled = this.tailMesh.frustumCulled = false
      this.lampMesh.renderOrder = this.tailMesh.renderOrder = 2
      this.beams = new THREE.Mesh(beamGeometry(Math.abs(h[0]), h[1], h[2] - 0.05), this.beamMat)
      this.beams.frustumCulled = false
      this.beams.renderOrder = 3
      this.root.add(this.lampMesh, this.tailMesh, this.beams)
      const m = new THREE.Matrix4(), back = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
      for (let k = 0; k < 2; k++) {
        const sx = k ? 1 : -1
        // (each glow 3× its lens: the lens a bright core, round it a soft halo)
        const hr = (head ? Math.max(0.06, Math.min(head.w, head.h)) : 0.1) * 3
        m.compose(new THREE.Vector3(Math.abs(h[0]) * sx, h[1], h[2] - 0.03), back, new THREE.Vector3(hr, hr, 1))
        this.lampMesh.setMatrixAt(k, m)
        const tr = (tail ? Math.max(0.05, Math.min(tail.w, tail.h)) : 0.08) * 3
        m.compose(new THREE.Vector3(Math.abs(t[0]) * sx, t[1], t[2] + 0.03), new THREE.Quaternion(), new THREE.Vector3(tr, tr, 1))
        this.tailMesh!.setMatrixAt(k, m)
      }
    }
    this.lampMesh.visible = on
    this.lampMat.uniforms.uK.value = 5.5
    const tailK = Math.max(on ? 0.3 : 0, this.brakeK)
    this.tailMesh!.visible = tailK > 0.01
    this.tailMat.uniforms.uK.value = 5.0 * tailK
    this.beams!.visible = on && u.uNight.value > 0.05
    this.beamMat.uniforms.uK.value = u.uNight.value
  }

  get speedKmh(): number { return this.sim ? Math.abs(this.sim.speed) * 3.6 : 0 }
  get gear(): string { return this.sim?.real?.gearLabel ?? '' }
}

/** Paint per car on this map: the G500 in rust red, the E30 in cream, the kei van in safari orange. */
const OTH_PAINT: Record<string, string> = { gwagen: '#b8452e', bmw: '#efe4cc', van: '#d98a3a' }

const VERT = /* glsl */ `
in float paintMask;
out vec3 vWorld;
out vec3 vN;
out vec2 vUv;
out vec3 vCol;
out float vPaint;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
#ifdef USE_COLOR
  vCol = color;
#else
  vCol = vec3(1.0);
#endif
  vPaint = paintMask;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

const FRAG = /* glsl */ `
${FRAG_OUT}
${ATMOS_GLSL}
uniform vec4 uFarGrid;
${SHADOW_GLSL}
uniform sampler2D uMap;
uniform sampler2D uPaintMask;
uniform vec3 uPaint;
in vec3 vWorld;
in vec3 vN;
in vec2 vUv;
in vec3 vCol;
in float vPaint;
void main() {
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uCamPos - vWorld);
  float sun = sunVisibility(vWorld.xz);
#ifdef GLASS
  // WINDOWS: lightly tinted glass — the cabin shows through, the sky reflects in it by Fresnel, the sun glints
  float F = 0.08 + 0.88 * pow(1.0 - max(dot(N, V), 0.0), 4.0);
  vec3 R = reflect(-V, N);
  vec3 sky = skyColor(normalize(vec3(R.x, abs(R.y) + 0.05, R.z)));
  vec3 c = mix(vec3(0.05, 0.065, 0.075) * (ambient(N) + uSunColor * 0.25), sky * 0.85, F);
  c += uSunColor * sun * pow(max(dot(R, uSunDir), 0.0), 220.0) * 2.5;
  gl_FragColor = vec4(applyAtmos(c, vWorld), mix(0.42, 0.95, F));
#else
  vec3 albedo = vCol;
#ifdef USE_MAP_OTH
  albedo *= texture(uMap, vUv).rgb;
#endif
  // the paint takes the panel's hue, keeps its shading; white = the model's own colours
  float m = vPaint;
#ifdef USE_PAINTMAP
  m *= texture(uPaintMask, vUv).r;
#endif
  float lum = dot(albedo, vec3(0.3, 0.59, 0.11));
  float isWhite = step(2.95, uPaint.r + uPaint.g + uPaint.b);
  albedo = mix(albedo, uPaint * (lum * 1.3 + 0.08), m * (1.0 - isWhite));
#ifdef WHEEL
  float rough = 0.8;
#else
  float rough = mix(0.75, 0.38, m);
#endif
  vec3 c = shade(albedo, N, V, rough, 0.05, 1.0, sun, 0.25);
  // a little painted rim light so the car reads against the field
  c += albedo * uSunColor * pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.12 * sun;
  gl_FragColor = vec4(applyAtmos(c, vWorld), 1.0);
#endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/** A lamp's GLOW: a camera-side quad, a bright core (the lens) and a soft painted halo round it, added above white
 *  (the bloom spreads it). uK: brightness (0 = off). */
function glowMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color }, uK: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uK;
      varying vec2 vUv;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float core = 1.0 - smoothstep(0.26, 0.34, d), halo = pow(max(1.0 - d, 0.0), 2.2) * 0.32;
        gl_FragColor = vec4(uColor * uK * (core + halo), 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    toneMapped: false,
  })
}

/** The headlights' BEAMS in the air: an open cone from each lamp (wide, low, 12 m), car space. Its `t` attribute: 0 at
 *  the lamp … 1 at the far rim. */
function beamGeometry(x: number, y: number, z: number): THREE.BufferGeometry {
  const pos: number[] = [], tt: number[] = [], idx: number[] = []
  const S = 14, R = 12, Lb = 12
  for (const sx of [-1, 1]) {
    const base = pos.length / 3
    for (let i = 0; i <= R; i++) {
      const f = i / R
      for (let k = 0; k < S; k++) {
        const a = (k / S) * Math.PI * 2, along = f * Lb
        pos.push(x * sx + Math.cos(a) * along * 0.4, y - along * 0.07 + Math.sin(a) * along * 0.17, z - along)
        tt.push(f)
      }
    }
    for (let i = 0; i < R; i++) for (let k = 0; k < S; k++) {
      const a0 = base + i * S + k, a1 = base + i * S + ((k + 1) % S), b0 = a0 + S, b1 = a1 + S
      idx.push(a0, b0, a1, a1, b0, b1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('t', new THREE.Float32BufferAttribute(tt, 1))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** The beams' look: warm light painted in the air — strongest by the lamp, gone by 12 m, soft at the cone's silhouette
 *  (faces seen edge-on fade), only at night (uK = the night). */
function beamMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uK: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float t;
      varying float vT;
      varying float vFace;
      void main() {
        vT = t;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFace = abs(dot(normalize(normalMatrix * normal), normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uK;
      varying float vT;
      varying float vFace;
      void main() {
        // (max: vT interpolates a hair past 1 at the rim — pow() of a negative is NaN, a dashed white ring in the bloom)
        float a = pow(max(1.0 - vT, 0.0), 2.0) * smoothstep(0.0, 0.08, vT) * smoothstep(0.1, 0.7, vFace);
        gl_FragColor = vec4(vec3(1.0, 0.86, 0.62) * a * 0.035 * uK, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
  })
}
