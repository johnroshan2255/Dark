import * as THREE from 'three'
import type { TruckModel } from '../../assets/loadModels'

/**
 * THE AMPHIBIOUS HULL (O while driving — Car.toggleBoat): a welded-aluminium jet-boat hull that unfolds from under
 * the car, modelled once in Blender (scripts/blender/boat_hull.py) in normalised hull space and FITTED here to each
 * vehicle: width from the body / tyres, keel below the tyres, floor above the floating waterline, gunwale just over
 * the door sills, bow from the front bumper forward, transom behind the rear bumper. One asset fits every car.
 *
 * DEPLOY (`pose(d)`, d 0 → 1 over Car's BOAT_TIME; retracting plays it backwards) — THE WHEELS ARE THE GADGET:
 *   0.00–0.42  (Car) each wheel folds flat, slides in under the car on its strut (spinning like a turbine disc) and
 *              spreads into a thin disc at `discY`; the car rises on its air suspension meanwhile
 *   0.34–0.70  the KEEL PACK forms out of the four discs (they sink into it, gone by 0.6) and telescopes out to full
 *              width and length
 *   0.55–0.82  the SIDES swing up about the chines from folded over the floor, overshooting a little as they lock
 *   0.58–0.92  the BOW rises out of the pack standing up in front of the grille, then lowers like a drawbridge
 *   0.65–0.90  the TRANSOM folds up off the floor; 0.88–1 the jet NOZZLE telescopes out (then yaws with the steering)
 *   0.50–1.00  LED STRIPS along both rub rails and round the bow light up: a scan sweeps bow → stern as the parts
 *              lock, then a steady cyan accent while the hull is out (modern-gadget read; additive, unlit)
 *
 * Draws: 6 parts, each a 1-instance InstancedMesh on the car's own program (vertex colours, the neutral texel, no
 * paint) → 0 new programs, + 3 additive LED-strip draws (1 small program); all only while deployed (hidden at
 * d = 0). 696 + ~140 tris. CPU: 9 matrix copies per frame while visible. Memory: ~1.6 k vertices per car (~70 KB).
 */

/** Keel below the tyre-bottom plane (m, chassis space): on land in boat mode the car rides this much higher on its
 *  (retracted) suspension so the keel, not the tyres, meets the ground. */
export const KEEL = -0.22
/** Hull floor (chassis space): above the floating waterline (KEEL + DRAFT) so no water shows inside the boat. */
const FLOOR = 0.24
/** Keel depth below the water at rest afloat (m). */
export const DRAFT = 0.36
/** Bow length ahead of the front bumper (m) and the transom's gap behind the rear bumper. */
const BOW_LEN = 1.6
const STERN_GAP = 0.25
/** Past the transom (jet pump, nozzle): hull-space units → metres (not stretched with the car's length). */
const AFT_SCALE = 2.2

type PartName = 'hull_keel' | 'hull_side_L' | 'hull_side_R' | 'hull_bow' | 'hull_stern' | 'hull_nozzle'
const PARTS: PartName[] = ['hull_keel', 'hull_side_L', 'hull_side_R', 'hull_bow', 'hull_stern', 'hull_nozzle']

interface Fit {
  /** Gunwale half-width, keel / floor / gunwale heights, bow joint (front bumper) and transom z (m, chassis space). */
  hw: number
  keel: number
  floor: number
  gun: number
  joint: number
  stern: number
  /** Formed: how far the keel pack sits from its deployed place when it forms out of the wheel discs. */
  stow: number
}

export class BoatHull {
  readonly root = new THREE.Group()
  private readonly meshes = new Map<PartName, THREE.InstancedMesh>()
  private readonly pivots = new Map<PartName, THREE.Vector3>()
  private readonly fit: Fit
  /** Buoyancy points along both bilges, bow shoulder to transom (chassis space). */
  readonly floatPoints: [number, number, number][]
  /** FX spots (chassis space): the bow shoulders at the waterline (L, R) and the jet nozzle's exit. */
  readonly bowSpray: THREE.Vector3[]
  readonly nozzleExit = new THREE.Vector3()
  /** Height (chassis space) where the folded wheels spread into discs and the keel pack forms. */
  readonly discY: number
  /** LED strips: rub rail L / R and round the bow, and their shared material (uGlow steady, uScan 0 bow … 1 stern). */
  private readonly leds: { side: THREE.Mesh[]; bow: THREE.Mesh }
  private readonly ledMat: THREE.ShaderMaterial

  constructor(truck: TruckModel, material: THREE.Material) {
    this.root.name = 'boatHull'
    truck.wheel.computeBoundingBox()
    const wb = truck.wheel.boundingBox!
    const tyreOuter = Math.max(...truck.wheelPos.map((p) => Math.abs(p[0]))) + (wb.max.x - wb.min.x) / 2
    // Door sills (the doors' bottoms) — the gunwale sits just above them so the doors stay clear.
    const sill = truck.doors.length ? Math.min(...truck.doors.map((d) => d.hinge[1] + d.bottom)) : truck.bottom + 0.25
    const F: Fit = (this.fit = {
      hw: Math.max(truck.half.x, tyreOuter) + 0.1,
      keel: KEEL,
      floor: FLOOR,
      gun: Math.max(sill + 0.1, FLOOR + 0.4),
      joint: truck.front - 0.04,
      stern: truck.rear + STERN_GAP,
      stow: 0,
    })
    this.discY = KEEL + 0.45 * (FLOOR - KEEL)
    F.stow = this.discY + 0.057 - FLOOR // the squashed pack (¼ height under the floor plane) centred on the discs
    const v = new THREE.Vector3()
    for (const name of PARTS) {
      const part = truck.hull.parts.get(name)
      if (!part) continue
      const g = part.geo.clone()
      const pos = g.getAttribute('position') as THREE.BufferAttribute
      for (let i = 0; i < pos.count; i++) pos.setXYZ(i, ...this.map(v.fromBufferAttribute(pos, i)).toArray())
      // One program with the car: colour as a vec3 (a vec4 would switch on vertex alphas = a second program),
      // every UV on the body texture's neutral texel — its tint divided out, so the aluminium reads the same on
      // every car — no paint.
      const src = g.getAttribute('color')
      const col = new Float32Array(pos.count * 3)
      const [nr, ng, nb] = truck.neutralColor.map((c) => 1 / Math.max(0.1, c))
      for (let i = 0; i < pos.count; i++) (col[i * 3] = src.getX(i) * nr), (col[i * 3 + 1] = src.getY(i) * ng), (col[i * 3 + 2] = src.getZ(i) * nb)
      g.setAttribute('color', new THREE.BufferAttribute(col, 3))
      const uv = new Float32Array(pos.count * 2)
      for (let i = 0; i < pos.count; i++) uv.set(truck.neutralUv, i * 2)
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
      g.setAttribute('paintMask', new THREE.BufferAttribute(new Float32Array(pos.count), 1))
      g.computeVertexNormals() // the piecewise fit bends the faces: re-derive (split vertices keep the hard edges)
      g.computeBoundingSphere()
      const mesh = new THREE.InstancedMesh(g, material, 1)
      mesh.frustumCulled = false
      mesh.castShadow = true
      mesh.name = name
      this.root.add(mesh)
      this.meshes.set(name, mesh)
      this.pivots.set(name, this.map(new THREE.Vector3(...part.pivot)))
    }
    const zc = (F.joint + F.stern) / 2
    const bilge = F.keel + (0.113 / 0.4) * (F.floor - F.keel) // the V bottom at 0.6 of the half-width
    this.floatPoints = []
    for (const z of [F.joint + 0.35, zc, F.stern - 0.3]) for (const s of [-1, 1]) this.floatPoints.push([s * 0.6 * F.hw, bilge, z])
    const wl = KEEL + DRAFT
    this.bowSpray = [new THREE.Vector3(-0.8 * F.hw, wl, F.joint + 0.15), new THREE.Vector3(0.8 * F.hw, wl, F.joint + 0.15)]
    this.map(this.nozzleExit.set(0, 0.165, 1.27))
    // LED STRIPS: a 3.5 cm ribbon just proud of each rub rail (hull space x ±1.03, y 0.905) from the bow joint to
    // the transom, and one round the bow's rail (the Blender bow loft's rail line) — `along` 0 at the stem … 1 aft.
    this.ledMat = new THREE.ShaderMaterial({
      name: 'HullLeds', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uGlow: { value: 0 }, uScan: { value: -1 } },
      vertexShader: /* glsl */ `
        attribute float along; varying float vA;
        void main() { vA = along; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uGlow, uScan; varying float vA;
        void main() {
          float scan = exp(-pow((vA - uScan) * 9.0, 2.0)) * 3.0;
          vec3 c = vec3(0.2, 0.8, 1.0) * (uGlow * 0.9 + scan) + vec3(0.8, 0.95, 1.0) * scan * 0.6;
          gl_FragColor = vec4(c, 1.0);
        }`,
    })
    const zLen = F.stern - F.joint + BOW_LEN
    const ribbon = (line: THREE.Vector3[]) => {
      const pos: number[] = [], al: number[] = [], idx: number[] = []
      line.forEach((p, i) => {
        pos.push(p.x, p.y - 0.018, p.z, p.x, p.y + 0.018, p.z)
        const a = (p.z - (F.joint - BOW_LEN)) / zLen
        al.push(a, a)
        if (i) idx.push(i * 2 - 2, i * 2 - 1, i * 2, i * 2 - 1, i * 2 + 1, i * 2)
      })
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      g.setAttribute('along', new THREE.Float32BufferAttribute(al, 1))
      g.setIndex(idx)
      const m = new THREE.Mesh(g, this.ledMat)
      m.matrixAutoUpdate = false
      m.frustumCulled = false
      m.renderOrder = 9
      this.root.add(m)
      return m
    }
    const sideLine = (sx: number) => Array.from({ length: 24 }, (_, i) => this.map(new THREE.Vector3(sx * 1.03, 0.905, -0.6 + (1.6 * i) / 23)))
    const bowLine: THREE.Vector3[] = []
    for (const sx of [-1, 1]) {
      const half: THREE.Vector3[] = []
      for (let i = 0; i <= 14; i++) {
        const t = (0.97 * i) / 14, sw = (1 - t) * (1 + 0.45 * t)
        half.push(this.map(new THREE.Vector3(sx * (0.985 * sw + 0.045 * Math.min(1, sw * 3)), 1 + 0.14 * t ** 1.6 - 0.095, -(0.6 + 0.4 * t))))
      }
      if (sx < 0) bowLine.push(...half.reverse())
      else bowLine.push(...half.slice(1))
    }
    this.leds = { side: [ribbon(sideLine(-1)), ribbon(sideLine(1))], bow: ribbon(bowLine) }
    this.root.visible = false
  }

  /** Hull space (glTF: x across ±1, y keel 0 … floor 0.4 … gunwale 1, z bow tip −1 … bow joint −0.6 … transom 1)
   *  → chassis space, piecewise per axis. */
  private map(p: THREE.Vector3): THREE.Vector3 {
    const F = this.fit
    const y = p.y <= 0.4 ? F.keel + (p.y / 0.4) * (F.floor - F.keel) : F.floor + ((p.y - 0.4) / 0.6) * (F.gun - F.floor)
    const z = p.z < -0.6 ? F.joint - ((-0.6 - p.z) / 0.4) * BOW_LEN : p.z <= 1 ? F.joint + ((p.z + 0.6) / 1.6) * (F.stern - F.joint) : F.stern + (p.z - 1) * AFT_SCALE
    return p.set(p.x * F.hw, y, z)
  }

  /** Pose the parts for deployment `d` (0 stowed … 1 deployed) and the jet nozzle's steering (−1 … 1). */
  pose(d: number, steer: number): void {
    this.root.visible = d > 0.001
    if (!this.root.visible) return
    const F = this.fit
    // KEEL PACK: forms out of the four wheel discs (a flat plate their size at disc height), then drops into place
    // and telescopes out to full width and length.
    const appear = Math.max(1e-3, smooth(0.34, 0.44, d))
    const drop = smooth(0.4, 0.62, d), wide = smooth(0.44, 0.66, d), long = smooth(0.46, 0.7, d)
    const zc = (F.joint + F.stern) / 2
    _k.makeTranslation(0, (1 - drop) * F.stow + F.floor, zc)
      .multiply(_m.makeScale(appear * (0.85 + 0.15 * wide), appear * (0.25 + 0.75 * drop), appear * (0.6 + 0.4 * long)))
      .multiply(_m.makeTranslation(0, -F.floor, -zc))
    this.set('hull_keel', _k)
    // SIDES: folded inward flat over the floor, swing up about the chine and lock with a little overshoot.
    const side = 1.62 * (1 - back(smooth(0.55, 0.82, d)))
    this.set('hull_side_L', this.hinge(_k, 'hull_side_L', _z, -side))
    this.leds.side[0].matrix.copy(_h)
    this.set('hull_side_R', this.hinge(_k, 'hull_side_R', _z, side))
    this.leds.side[1].matrix.copy(_h)
    // BOW: grows out of the pack standing up in front of the grille, then lowers forward like a drawbridge.
    const grow = smooth(0.58, 0.72, d), lower = back(smooth(0.7, 0.92, d))
    this.set('hull_bow', this.hinge(_k, 'hull_bow', _x, 1.45 * (1 - lower), 0.15 + 0.85 * grow))
    this.leds.bow.matrix.copy(_h)
    // TRANSOM folds up off the floor; the nozzle telescopes out of the pump and yaws with the steering.
    const stern = this.hinge(_k, 'hull_stern', _x, -1.5 * (1 - back(smooth(0.65, 0.9, d))))
    this.set('hull_stern', stern)
    _s.copy(stern)
    this.set('hull_nozzle', this.hinge(_s, 'hull_nozzle', _y, steer * 0.45 * smooth(0.9, 1, d), 0.2 + 0.8 * smooth(0.88, 1, d)))
    // LEDs: a scan sweeps bow → stern as the parts lock, then the steady accent.
    const u = this.ledMat.uniforms
    u.uGlow.value = smooth(0.8, 1, d)
    u.uScan.value = d > 0.5 && d < 1 ? -0.15 + 1.3 * smooth(0.5, 0.98, d) : -1
    for (const m of [...this.leds.side, this.leds.bow]) m.visible = d > 0.5
  }

  /** parent · T(pivot) · R(axis, angle) · S(1, 1, stretch) · T(−pivot) into _h. */
  private hinge(parent: THREE.Matrix4, name: PartName, axis: THREE.Vector3, angle: number, stretch = 1): THREE.Matrix4 {
    const p = this.pivots.get(name) ?? _o
    return _h.copy(parent)
      .multiply(_m.makeTranslation(p.x, p.y, p.z))
      .multiply(_m.makeRotationAxis(axis, angle))
      .multiply(_m.makeScale(1, 1, stretch))
      .multiply(_m.makeTranslation(-p.x, -p.y, -p.z))
  }

  private set(name: PartName, m: THREE.Matrix4): void {
    const mesh = this.meshes.get(name)
    if (!mesh) return
    mesh.setMatrixAt(0, m)
    mesh.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    for (const m of this.meshes.values()) (m.geometry.dispose(), m.dispose())
    for (const m of [...this.leds.side, this.leds.bow]) m.geometry.dispose()
    this.ledMat.dispose()
    this.root.removeFromParent()
  }
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
/** Ease out with a ~5 % overshoot (a panel swinging into its lock). */
const back = (t: number) => {
  const c = 1.1, u = t - 1
  return 1 + (c + 1) * u * u * u + c * u * u
}

const _k = new THREE.Matrix4()
const _h = new THREE.Matrix4()
const _s = new THREE.Matrix4()
const _m = new THREE.Matrix4()
const _o = new THREE.Vector3()
const _x = new THREE.Vector3(1, 0, 0)
const _y = new THREE.Vector3(0, 1, 0)
const _z = new THREE.Vector3(0, 0, 1)
