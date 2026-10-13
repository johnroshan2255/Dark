import * as THREE from 'three'
import type { Car } from '../../gameplay/vehicle/Car'
import type { WorldManager } from '../../world/WorldManager'
import type { BiomeWeights } from '../../world/Biomes'
import { WorldFields } from '../../world/WorldFields'
import { SURFACES, surfaceMix, type SurfaceMix } from '../../gameplay/vehicle/drivetrain/tyre'
import { vehicleDef } from '../../gameplay/vehicle/catalogue'
import { ART } from '../artStyle'

/**
 * TYRE MARKS — skid marks on the road and tyre tracks in the ground, left by each wheel of the car.
 *
 *   - ASPHALT: dark rubber where a tyre SLIDES — a drift (slip angle), wheelspin / a burnout (a black patch at the
 *     spinning wheel that gets darker the longer it spins, then a streak as the car launches), a locked wheel under
 *     braking (cars without ABS: the 1989 pickup, the Żuk; with ABS the marks are faint and broken, the pulses).
 *     Intensity from the wheel's slip (Drivetrain κ / α, else VehicleSim `wheelSlip`) × its load.
 *   - LAND (dirt, grass, sand, snow, mud…): a TRACK even when just rolling — faint flattened grass, clear ruts in
 *     dirt, shadowed grooves with lit rims in sand and snow — and a dark torn-up mark when the wheel slides or spins
 *     (churned earth on grass / dirt, deep grooves in snow / sand). Tread lugs show while rolling, smear when sliding.
 *     The surface is the sim's own per-wheel mix (VehicleSim `wheelSurface`), so marks agree with the grip.
 *
 * ONE draw: a ring buffer of quads (tier budget `tyreMarks.segments`), each wheel a connected strip (a segment shares
 * its start edge with the previous one's end edge → no overlaps, no gaps). Every vertex is placed ON the rendered
 * terrain at its own x, z (`WorldManager.groundAt`, the chunk heights the mesh is built from — it follows slopes
 * and folds), falling back to the wheel's contact plane on anything that isn't terrain (rocks, ice decks). Segments
 * are ≤ 0.45–0.9 m so they follow the 2 m terrain triangles; a 2 cm lift + polygon offset keep them on top at
 * grazing angles without floating.
 * Drawn MULTIPLICATIVELY (dst × mark colour, no lighting of its own): the mark darkens / tints whatever the ground
 * already is — sun, shadow, night, torch, wet sheen, every art style and phase — and fades to ×1 in the fog.
 * Marks fade with age (`life`), with distance from the camera (`range`, so the far LOD terrain never shows them)
 * and before the ring overwrites them. World-space, nothing per chunk: chunk streaming can't strand them.
 * Cost: CPU ≈ 4 wheels × (2–4 height lookups + a little math) per frame, no allocation; GPU one draw of ≤ 4·N
 * vertices (marks are a few % of the screen); memory 208 B per segment (LOW 1024 → 0.2 MB, HIGH 4096 → 0.85 MB).
 */

const LIFT = 0.02
const EPS = 0.02
/** Max segment length (m) while rolling / while sliding (sliding marks change faster). */
const SEG_ROLL = 0.9
const SEG_SLIP = 0.45
const _bw: BiomeWeights = [0, 0]
const _p = new THREE.Vector3()
const _f = new THREE.Vector3()

export interface TyreMarkBudget {
  /** Ring size (quads). */
  segments: number
  /** Seconds before a mark has faded out. */
  life: number
  /** Camera distance (m) where marks have faded out (they start fading at 60 %). */
  range: number
}

/** How one surface takes a mark: alpha while rolling / at full slip, the multiply tint for each, groove rim, tread. */
interface Look {
  roll: number
  slip: number
  rollTint: [number, number, number]
  slipTint: [number, number, number]
  /** Lit groove rims (snow, sand): × (1 + 0.25·rim) at the strip's edges. */
  rim: number
  /** Soft ground: tread lugs show while rolling. */
  soft: number
}

const LOOKS: Record<string, Look> = {
  // Rubber: near-black, a touch cool (reads as rubber on the blue-grey asphalt, never brown).
  asphalt: { roll: 0, slip: 0.82, rollTint: [1, 1, 1], slipTint: [0.15, 0.15, 0.17], rim: 0, soft: 0 },
  // Compacted ruts, dark wet-earth brown where the wheel digs.
  dirt: { roll: 0.6, slip: 0.85, rollTint: [0.66, 0.56, 0.46], slipTint: [0.42, 0.31, 0.22], rim: 0.15, soft: 0.8 },
  // Flattened grass: darker, slightly richer green; torn up = dark churned earth.
  grass: { roll: 0.55, slip: 0.8, rollTint: [0.6, 0.74, 0.5], slipTint: [0.46, 0.34, 0.22], rim: 0, soft: 0.55 },
  // Shadowed grooves (warm shadow) with lit rims; deeper when spinning.
  sand: { roll: 0.7, slip: 0.85, rollTint: [0.72, 0.62, 0.5], slipTint: [0.56, 0.44, 0.34], rim: 0.6, soft: 1 },
  // Blue shadow in the grooves (the sky fill), lit rims.
  snow: { roll: 0.75, slip: 0.88, rollTint: [0.62, 0.71, 0.9], slipTint: [0.48, 0.56, 0.78], rim: 0.7, soft: 1 },
  // Ice: only faint pale scuffs when sliding.
  ice: { roll: 0, slip: 0.35, rollTint: [1, 1, 1], slipTint: [0.8, 0.84, 0.9], rim: 0, soft: 0 },
  mud: { roll: 0.75, slip: 0.9, rollTint: [0.5, 0.4, 0.31], slipTint: [0.32, 0.24, 0.17], rim: 0.2, soft: 0.9 },
}
/** The main road in the snow is packed snow (stylize): compacted grey-blue ruts, not rubber. */
const PACKED_SNOW: Look = { roll: 0.3, slip: 0.7, rollTint: [0.72, 0.78, 0.9], slipTint: [0.5, 0.56, 0.68], rim: 0.3, soft: 0.6 }
/** Overland style paints the main road as a pale dirt track. */
const OVERLAND_ROAD: Look = { roll: 0.25, slip: 0.78, rollTint: [0.78, 0.7, 0.6], slipTint: [0.42, 0.33, 0.25], rim: 0.1, soft: 0.6 }

function lookFor(i: number): Look {
  const s = SURFACES[i]
  if (!s) return LOOKS.dirt
  if (i === 0 && ART.style === 'overland') return OVERLAND_ROAD
  return LOOKS[s.name] ?? (s.offroad ? LOOKS.dirt : LOOKS.asphalt) // a surface added later: generic by kind
}

/** Tyre section width (m) from a size code: metric `W/AR R D`, flotation `DxW R D`, bias `W-D` (inches). */
function tyreWidth(code: string | undefined): number {
  if (!code) return 0.24
  const metric = /^(\d+)\/\d+/.exec(code)
  if (metric) return Number(metric[1]) / 1000
  const flot = /^\d+(?:\.\d+)?\s*x\s*(\d+(?:\.\d+)?)/i.exec(code)
  if (flot) return Number(flot[1]) * 0.0254
  const bias = /^(\d+(?:\.\d+)?)-\d+/.exec(code)
  if (bias) return Number(bias[1]) * 0.0254
  return 0.24
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** One wheel's strip: the START EDGE of the segment being drawn (the previous segment's end edge when shared). */
interface Track {
  live: boolean
  shared: boolean
  sx: number; sz: number
  lx: number; ly: number; lz: number
  rx: number; ry: number; rz: number
  hw: number
  a: number
  r: number; g: number; b: number
  rim: number; tread: number
  along: number
  dx: number; dz: number
  slot: number; slotSerial: number
  patch: number; patchSerial: number; patchX: number; patchZ: number; patchY: number
  burn: number
  px: number; pz: number; seen: boolean
}

const newTrack = (): Track => ({
  live: false, shared: false, sx: 0, sz: 0, lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0, hw: 0.1, a: 0, r: 1, g: 1, b: 1, rim: 0, tread: 0,
  along: 0, dx: 0, dz: -1, slot: -1, slotSerial: 0, patch: -1, patchSerial: 0, patchX: 0, patchZ: 0, patchY: 0, burn: 0, px: 0, pz: 0, seen: false,
})

export class TyreMarks {
  readonly mesh: THREE.Mesh
  private readonly material: THREE.ShaderMaterial
  private budget: TyreMarkBudget = { segments: 0, life: 60, range: 70 }
  private pos = new Float32Array(0)
  private mark = new Float32Array(0)
  private tint = new Float32Array(0)
  private life = new Float32Array(0)
  private cursor = 0
  private serial = 0
  private clock = 0
  private lastWrite = -1e9
  private dirtyLo = Infinity
  private dirtyHi = -1
  private readonly tracks: Track[] = [newTrack(), newTrack(), newTrack(), newTrack()]
  private car: Car | null = null
  private carKey = ''
  private tyreW = 0.24
  private readonly looks: Look[] = []
  private readonly fallback: SurfaceMix[] = [surfaceMix(), surfaceMix(), surfaceMix(), surfaceMix()]
  private fallbackI = 0
  // current-edge look (filled by `look`)
  private cA = 0
  private cR = 1
  private cG = 1
  private cB = 1
  private cRim = 0
  private cTread = 0
  private cSoft = 0
  private cSlip = 0
  private refY = 0

  constructor() {
    this.material = new THREE.ShaderMaterial({
      name: 'TyreMarks',
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
      // dst × src colour: the mark only darkens / tints the ground as it is already lit; dst alpha kept.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uTime: { value: 0 }, uLife: { value: 60 }, uSerial: { value: 0 }, uBudget: { value: 1 }, uRange: { value: new THREE.Vector2(40, 70) } },
      ]),
      vertexShader: /* glsl */ `
        attribute vec4 aMark; attribute vec4 aTint; attribute vec2 aLife;
        uniform float uTime, uLife, uSerial, uBudget; uniform vec2 uRange;
        varying vec4 vMark; varying vec4 vTint; varying float vFade;
        #include <fog_pars_vertex>
        void main() {
          // Age and ring position are per SEGMENT (all 4 vertices agree) → a dead segment collapses whole.
          float keep = (1.0 - smoothstep(uLife * 0.55, uLife, uTime - aLife.x)) * (1.0 - smoothstep(0.75, 1.0, (uSerial - aLife.y) / uBudget));
          vMark = aMark;
          vTint = aTint;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vFade = keep * (1.0 - smoothstep(uRange.x, uRange.y, length(mvPosition.xyz)));
          gl_Position = keep > 0.002 ? projectionMatrix * mvPosition : vec4(0.0, 0.0, 2.0, 1.0);
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vMark; varying vec4 vTint; varying float vFade;
        #include <fog_pars_fragment>
        float tm_hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        void main() {
          float ac = vMark.x, ax = abs(ac), along = vMark.y;
          float edge = 1.0 - smoothstep(0.72, 1.0, ax);
          // Rubber / smear: lengthwise striations (the tread grooves drawn out), varying along the strip.
          float lane = floor((ac * 0.5 + 0.5) * 7.0);
          float y = along * 1.4, fy = fract(y);
          float streak = 0.7 + 0.3 * mix(tm_hash(vec2(lane, floor(y))), tm_hash(vec2(lane, floor(y) + 1.0)), fy * fy * (3.0 - 2.0 * fy));
          // Rolling on soft ground: staggered tread lugs across the track.
          float lug = smoothstep(0.35, 0.5, fract(along * 5.5 + step(0.0, ac) * 0.5)) * (1.0 - smoothstep(0.85, 1.0, fract(along * 5.5 + step(0.0, ac) * 0.5)));
          float pattern = mix(streak, 0.6 + 0.4 * lug, vMark.w);
          float a = clamp(vMark.z * vFade * edge * pattern, 0.0, 1.0);
          vec3 f = mix(vec3(1.0), vTint.rgb, a);
          // Groove rims (snow / sand): the lip of pushed-up ground catches the light.
          float rim = smoothstep(0.62, 0.9, ax) * (1.0 - smoothstep(0.9, 1.0, ax));
          f *= 1.0 + vTint.a * rim * 0.25 * clamp(vMark.z, 0.0, 1.0) * vFade;
          #ifdef USE_FOG
            #ifdef FOG_EXP2
              float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
            #else
              float fogF = smoothstep(fogNear, fogFar, vFogDepth);
            #endif
            f = mix(f, vec3(1.0), fogF);
          #endif
          gl_FragColor = vec4(f, 1.0);
        }`,
    })
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material)
    this.mesh.name = 'tyreMarks'
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    this.mesh.renderOrder = -1 // first of the transparent pass: under the water, smoke and spray
    for (let i = 0; i < SURFACES.length; i++) this.looks.push(lookFor(i))
  }

  /** Tier budget (`QualitySettings.tyreMarks`). A new ring size rebuilds the buffers (marks are cleared). */
  setBudget(b: TyreMarkBudget): void {
    const resize = b.segments !== this.budget.segments
    this.budget = { ...b }
    const u = this.material.uniforms
    u.uLife.value = b.life
    u.uBudget.value = Math.max(1, b.segments)
    ;(u.uRange.value as THREE.Vector2).set(b.range * 0.6, b.range)
    if (!resize) return
    const n = b.segments
    this.pos = new Float32Array(n * 12)
    this.mark = new Float32Array(n * 16)
    this.tint = new Float32Array(n * 16)
    this.life = new Float32Array(n * 8).fill(-1e9)
    const idx = new Uint32Array(n * 6)
    for (let s = 0; s < n; s++) {
      const v = s * 4, i = s * 6
      idx[i] = v; idx[i + 1] = v + 2; idx[i + 2] = v + 1
      idx[i + 3] = v + 1; idx[i + 4] = v + 2; idx[i + 5] = v + 3
    }
    const g = new THREE.BufferGeometry()
    g.setIndex(new THREE.BufferAttribute(n * 4 > 65535 ? idx : new Uint16Array(idx), 1))
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aMark', new THREE.BufferAttribute(this.mark, 4).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aTint', new THREE.BufferAttribute(this.tint, 4).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aLife', new THREE.BufferAttribute(this.life, 2).setUsage(THREE.DynamicDrawUsage))
    this.mesh.geometry.dispose()
    this.mesh.geometry = g
    this.cursor = 0
    this.serial = 0
    this.lastWrite = -1e9
    for (const t of this.tracks) Object.assign(t, newTrack())
    this.mesh.visible = false
  }

  /** Remove every mark (new world, teleport across the map…). */
  clear(): void {
    this.life.fill(-1e9)
    this.dirtyLo = 0
    this.dirtyHi = this.budget.segments - 1
    for (const t of this.tracks) Object.assign(t, newTrack())
  }

  /** Once per frame after the car's rendered pose is set (Game 'car' system). */
  update(dt: number, car: Car, world: WorldManager, camPos: THREE.Vector3): void {
    const n = this.budget.segments
    if (n <= 0) return
    this.clock += dt
    if (car !== this.car || car.modelId + car.tune.tyre !== this.carKey) {
      if (car !== this.car) for (const t of this.tracks) this.end(t)
      this.car = car
      this.carKey = car.modelId + car.tune.tyre
      let code: string | undefined
      try {
        code = vehicleDef(car.modelId).spec?.axles[0]?.tyre
      } catch {
        code = undefined
      }
      this.tyreW = tyreWidth(code) * car.tune.tyre
    }
    const sim = car.sim
    const range = this.budget.range
    const off = !sim.enabled || sim.boat > 0.01 || car.flying || car.pos.distanceToSquared(camPos) > range * range * 0.8
    const D = sim.real
    let snowRoad = 0
    if (!off) {
      snowRoad = world.fields.biome(car.pos.x, car.pos.z, _bw, car.pos.y)[1]
      car.forward(_f)
    }
    const fl = Math.hypot(_f.x, _f.z) || 1
    const fx = _f.x / fl, fz = _f.z / fl
    const radius = sim.wheelRadius
    // A burnout scrubs a patch longer than the contact patch (the wheel squirms on its tyre and the axle shakes).
    const patchHalf = Math.max(0.2, radius * 0.75)
    for (let k = 0; k < 4; k++) {
      const t = this.tracks[k]
      const w = sim.wheels[k]
      if (off || !w || !w.contact) {
        this.end(t)
        t.seen = false
        continue
      }
      car.wheelContact(k, _p)
      // Under liquid water: nothing (the bed is hidden, and the mark would draw over the water).
      if (_p.y < WorldFields.WATER + 0.15 && world.waterAt(_p.x, _p.z) > -Infinity) {
        this.end(t)
        t.seen = false
        continue
      }
      let moved = 0
      if (t.seen) {
        moved = Math.hypot(_p.x - t.px, _p.z - t.pz)
        if (moved > 3) {
          this.end(t) // teleport / respawn: no streak across the map
          moved = 0
        }
      }
      t.px = _p.x
      t.pz = _p.z
      t.seen = true
      this.refY = _p.y - 0.05
      // --- surface under this wheel (the sim's own sample; else our own, one wheel per frame)
      let m = sim.wheelSurface(k)
      if (!m) {
        m = this.fallback[k]
        if (this.fallbackI === k) sim.surface(_p.x, _p.z, m)
      }
      // --- slip: slide angle, wheelspin, lock (ABS: faint, broken by the pulses)
      const along = t.live ? t.along + Math.hypot(_p.x - t.sx, _p.z - t.sz) : 0
      let slip: number, spin = 0
      if (D) {
        const kap = D.kappa[k]
        const slide = smooth(0.1, 0.4, Math.abs(D.alpha[k]))
        spin = kap > 0 ? smooth(0.15, 0.8, kap) : 0
        // Braking: a tyre at / past its peak (κ ≈ −0.1: the sim's threshold stop without ABS) lays dark rubber, locked
        // (κ → −1) a solid black line. ABS keeps releasing at κ ≈ −0.15: faint, broken by its pulses (~1 m apart).
        let lock = kap < 0 ? smooth(0.03, 0.14, -kap) : 0
        if (D.R.brakes.abs && D.aids !== 'off') lock = Math.min(lock, 0.3) * ((along / 1.1) % 1 < 0.45 ? 1 : 0.12)
        slip = Math.max(slide, spin, lock)
      } else {
        slip = sim.wheelSlip[k]
      }
      const st = sim.wheelLoadStatic(k)
      const lf = st > 0 ? Math.min(1.5, sim.wheelLoad(k) / st) : 1
      slip = Math.min(1, slip * Math.min(1.15, 0.3 + 0.7 * lf))
      this.look(m, slip, Math.min(1, lf), snowRoad)
      // --- wheel heading (steered) and travel
      const sa = w.steer, cs = Math.cos(sa), sn = Math.sin(sa)
      const hx = fx * cs - fz * sn, hz = fz * cs + fx * sn // f·cos + right·sin, right = (−fz, fx)
      // --- BURNOUT: a nearly stationary wheel spinning → a patch under it, darker the longer it spins
      const v = dt > 0 ? moved / dt : 0
      if (v < 0.8 && spin > 0.25 && this.cA > EPS) {
        t.burn = Math.min(1, t.burn + dt * spin * 0.4)
        if (t.patch < 0 || this.serial - t.patchSerial > n - 8) {
          t.patch = this.reserve()
          t.patchSerial = this.serial
          t.patchX = _p.x
          t.patchZ = _p.z
        }
        this.writePatch(t, world, hx, hz, patchHalf, Math.min(1, this.cA * 0.5 + t.burn))
      } else {
        if (t.patch >= 0 && Math.hypot(_p.x - t.patchX, _p.z - t.patchZ) > patchHalf) t.patch = -1
        t.burn = Math.max(0, t.burn - dt * 0.6)
      }
      // --- STRIP
      if (!t.live) {
        this.setStart(t, world, _p.x, _p.z, hx, hz, this.halfWidth(hx, hz, hx, hz), false, 0)
        continue
      }
      const dx = _p.x - t.sx, dz = _p.z - t.sz, len = Math.hypot(dx, dz)
      if (this.cA < EPS && t.a < EPS) {
        // Invisible: drop any head segment, slide the start edge along with the wheel.
        if (t.slot >= 0) this.collapse(t.slot)
        t.slot = -1
        if (len > 0.05) this.setStart(t, world, _p.x, _p.z, dx / len, dz / len, this.halfWidth(hx, hz, dx / len, dz / len), false, along)
        continue
      }
      if (len < 0.03) continue
      const ux = dx / len, uz = dz / len
      const hw = this.halfWidth(hx, hz, ux, uz)
      if (!t.shared) this.startEdge(t, world, ux, uz)
      if (t.slot < 0 || this.serial - t.slotSerial > n - 8) {
        t.slot = this.reserve()
        t.slotSerial = this.serial
      }
      // End edge on the ground at the wheel.
      const ax = -uz * hw, az = ux * hw
      const lx = _p.x - ax, lz = _p.z - az, rx = _p.x + ax, rz = _p.z + az
      const ly = this.groundY(world, lx, lz), ry = this.groundY(world, rx, rz)
      this.writeSeg(t, lx, ly, lz, rx, ry, rz, along)
      const bend = Math.abs(ux * t.dz - uz * t.dx)
      const segMax = Math.max(this.cA, t.a) > 0.5 && slip > 0.2 ? SEG_SLIP : SEG_ROLL
      if (len >= segMax || (len > 0.12 && (bend > 0.14 || Math.abs(this.cA - t.a) > 0.25)) || this.cA < EPS) {
        // Commit: this segment stays; its end edge is the next one's start edge.
        t.slot = -1
        t.shared = true
        t.sx = _p.x; t.sz = _p.z
        t.lx = lx; t.ly = ly; t.lz = lz
        t.rx = rx; t.ry = ry; t.rz = rz
        t.hw = hw
        t.dx = ux; t.dz = uz
        t.along = along
        this.keepLook(t)
      }
    }
    this.fallbackI = (this.fallbackI + 1) % 4
    this.flush()
  }

  /** Blend the current wheel's mark look over its surface weights → cA (alpha), cR/G/B (multiply tint), rim, tread. */
  private look(m: SurfaceMix, slip: number, load: number, snowRoad: number): void {
    let A = 0, r = 0, g = 0, b = 0, rim = 0, soft = 0
    const w = m.w
    for (let i = 0; i < w.length; i++) {
      const wi = w[i]
      if (wi < 0.01) continue
      let L = this.looks[i] ?? (this.looks[i] = lookFor(i))
      if (i === 0 && snowRoad > 0.5) L = PACKED_SNOW
      const a = (L.roll * load + (L.slip - L.roll * load) * slip) * wi
      const tr = L.rollTint[0] + (L.slipTint[0] - L.rollTint[0]) * slip
      const tg = L.rollTint[1] + (L.slipTint[1] - L.rollTint[1]) * slip
      const tb = L.rollTint[2] + (L.slipTint[2] - L.rollTint[2]) * slip
      A += a
      r += a * tr; g += a * tg; b += a * tb
      rim += wi * L.rim
      soft += wi * L.soft
    }
    this.cA = Math.min(1, A)
    if (A > 1e-4) (this.cR = r / A), (this.cG = g / A), (this.cB = b / A)
    else this.cR = this.cG = this.cB = 1
    this.cRim = rim
    this.cTread = soft * (1 - slip)
    this.cSoft = soft
    this.cSlip = slip
  }

  private keepLook(t: Track): void {
    t.a = this.cA
    t.r = this.cR; t.g = this.cG; t.b = this.cB
    t.rim = this.cRim
    t.tread = this.cTread
  }

  /** Mark half-width: the tyre's footprint seen across the direction of travel (wider when sliding sideways). */
  private halfWidth(hx: number, hz: number, ux: number, uz: number): number {
    const c = Math.abs(hx * ux + hz * uz), s = Math.abs(hx * uz - hz * ux)
    const patchLen = (this.car?.sim.wheelRadius ?? 0.35) * 0.55
    // A wheel spinning / sliding in soft ground digs and throws it aside: a wider, torn-up mark.
    return 0.5 * (this.tyreW * c + patchLen * s) * (1 + 0.4 * this.cSoft * this.cSlip)
  }

  /** Ground height for a mark vertex: the rendered terrain there, unless the wheel is on something else. */
  private groundY(world: WorldManager, x: number, z: number): number {
    const g = world.groundAt(x, z)
    return (g === null || Math.abs(g - this.refY) > 0.35 ? this.refY : g) + LIFT
  }

  private setStart(t: Track, world: WorldManager, x: number, z: number, ux: number, uz: number, hw: number, shared: boolean, along: number): void {
    t.live = true
    t.shared = shared
    t.sx = x; t.sz = z
    t.dx = ux; t.dz = uz
    t.hw = hw
    t.along = along
    this.keepLook(t)
    this.startEdge(t, world, ux, uz)
  }

  /** (Re)build an unshared start edge across the direction (ux, uz). */
  private startEdge(t: Track, world: WorldManager, ux: number, uz: number): void {
    const ax = -uz * t.hw, az = ux * t.hw
    t.lx = t.sx - ax; t.lz = t.sz - az
    t.rx = t.sx + ax; t.rz = t.sz + az
    t.ly = this.groundY(world, t.lx, t.lz)
    t.ry = this.groundY(world, t.rx, t.rz)
  }

  /** End a strip: the head segment (if any) stays as it is. */
  private end(t: Track): void {
    t.live = false
    t.shared = false
    t.slot = -1
    t.patch = -1
    t.burn = 0
  }

  private reserve(): number {
    const s = this.cursor
    this.cursor = (this.cursor + 1) % this.budget.segments
    this.serial++
    return s
  }

  private collapse(slot: number): void {
    const o = slot * 8
    for (let v = 0; v < 4; v++) this.life[o + v * 2] = -1e9
    this.dirty(slot)
  }

  private dirty(slot: number): void {
    if (slot < this.dirtyLo) this.dirtyLo = slot
    if (slot > this.dirtyHi) this.dirtyHi = slot
    this.lastWrite = this.clock
  }

  private writeVertex(slot: number, v: number, x: number, y: number, z: number, across: number, along: number, a: number, tread: number, r: number, g: number, b: number, rim: number, serial: number): void {
    const i = slot * 4 + v
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z
    this.mark[i * 4] = across; this.mark[i * 4 + 1] = along; this.mark[i * 4 + 2] = a; this.mark[i * 4 + 3] = tread
    this.tint[i * 4] = r; this.tint[i * 4 + 1] = g; this.tint[i * 4 + 2] = b; this.tint[i * 4 + 3] = rim
    this.life[i * 2] = this.clock; this.life[i * 2 + 1] = serial
  }

  /** The head segment of track t: its start edge → the end edge given (current look). */
  private writeSeg(t: Track, lx: number, ly: number, lz: number, rx: number, ry: number, rz: number, along: number): void {
    const s = t.slot, ser = t.slotSerial
    this.writeVertex(s, 0, t.lx, t.ly, t.lz, -1, t.along, t.a, t.tread, t.r, t.g, t.b, t.rim, ser)
    this.writeVertex(s, 1, t.rx, t.ry, t.rz, 1, t.along, t.a, t.tread, t.r, t.g, t.b, t.rim, ser)
    this.writeVertex(s, 2, lx, ly, lz, -1, along, this.cA, this.cTread, this.cR, this.cG, this.cB, this.cRim, ser)
    this.writeVertex(s, 3, rx, ry, rz, 1, along, this.cA, this.cTread, this.cR, this.cG, this.cB, this.cRim, ser)
    this.dirty(s)
  }

  /** The burnout patch under a spinning wheel: a contact-patch-sized quad along the wheel's heading. */
  private writePatch(t: Track, world: WorldManager, hx: number, hz: number, half: number, a: number): void {
    const s = t.patch, ser = t.patchSerial
    const hw = this.tyreW * 0.6
    const ax = -hz * hw, az = hx * hw, bx = hx * half, bz = hz * half
    const cx = t.patchX, cz = t.patchZ
    const pts = [cx - bx - ax, cz - bz - az, cx - bx + ax, cz - bz + az, cx + bx - ax, cz + bz - az, cx + bx + ax, cz + bz + az]
    for (let v = 0; v < 4; v++) {
      const x = pts[v * 2], z = pts[v * 2 + 1]
      // a burnout smears the rubber: no tread, streaks across the whole patch
      this.writeVertex(s, v, x, this.groundY(world, x, z) + 0.002, z, v & 1 ? 1 : -1, v < 2 ? -half : half, a, 0, this.cR, this.cG, this.cB, this.cRim, ser)
    }
    this.dirty(s)
  }

  private flush(): void {
    const u = this.material.uniforms
    u.uTime.value = this.clock
    u.uSerial.value = this.serial
    this.mesh.visible = this.serial > 0 && this.clock - this.lastWrite < this.budget.life + 1
    if (this.dirtyHi < 0) return
    const g = this.mesh.geometry
    const lo = this.dirtyLo, hi = this.dirtyHi
    const attrs: [string, number][] = [['position', 12], ['aMark', 16], ['aTint', 16], ['aLife', 8]]
    for (const [name, per] of attrs) {
      const a = g.getAttribute(name) as THREE.BufferAttribute
      a.clearUpdateRanges()
      a.addUpdateRange(lo * per, (hi - lo + 1) * per)
      a.needsUpdate = true
    }
    this.dirtyLo = Infinity
    this.dirtyHi = -1
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
