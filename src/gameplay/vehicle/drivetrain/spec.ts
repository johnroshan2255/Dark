/**
 * VEHICLE SPEC (skills/realistic-vehicle-system §8.4–8.5): a car is DATA — its public spec sheet plus class defaults
 * for the gaps — resolved here into the SI numbers the drivetrain simulation runs on. No per-car code anywhere: a
 * car that needs new behaviour is missing a variant, and the variant goes into the shared model.
 */

export type VehicleClass = 'city' | 'sedan' | 'sports' | 'supercar' | 'muscle' | 'suv' | 'pickup' | 'offroader' | 'van' | 'ev' | 'rally'
export type PowerKind = 'petrol' | 'turbo-petrol' | 'diesel' | 'electric'
export type GearboxKind = 'manual' | 'auto' | 'dct' | 'cvt' | 'single'
export type Layout = 'FF' | 'FR' | 'MR' | 'RR' | 'AWD-permanent' | 'AWD-on-demand' | 'part-time-4WD'
export type Diff = 'open' | 'lsd' | 'torsen' | 'viscous' | 'locked'
export type SuspensionType = 'macpherson' | 'double-wishbone' | 'multi-link' | 'torsion-beam' | 'solid-coil' | 'solid-leaf' | 'portal'
export type TyreKind = 'road' | 'performance' | 'at' | 'mt' | 'winter'
export type AidLevel = 'off' | 'std' | 'full'
export type Locker = 'front' | 'centre' | 'rear'

export interface AxleSpec {
  suspension: SuspensionType
  steered?: boolean
  driven?: boolean
  diff?: Diff
  /** '225/45R17' (metric) or '35x12.50R17' (flotation). */
  tyre: string
  tyreKind?: TyreKind
  /** Ride frequency (Hz) and damping ratio [bump, rebound]. */
  springHz?: number
  zeta?: [number, number]
  travel?: number
  brake?: 'disc' | 'drum'
}

export interface VehicleSpec {
  class: VehicleClass
  /** Published figures the universal test suite checks the simulation against: s, km/h, m. */
  published?: { zeroTo100?: number; topSpeed?: number; turningCircle?: number }
  mass: { kerb: number; frontShare?: number; comHeight?: number }
  power: {
    kind: PowerKind
    /** kW at rpm; N·m at rpm (or a plateau [from, to]). */
    peakPower: number
    powerRpm: number
    peakTorque: number
    torqueRpm: number | [number, number]
    idle?: number
    redline?: number
    inertia?: number
    turbo?: { from: number; lag: number }
    regen?: number
  }
  transmission: {
    kind: GearboxKind
    ratios?: number[]
    reverse?: number
    final?: number
    /** CVT ratio range [low, high]. */
    range?: [number, number]
    /** Shift time (s), driveline efficiency, torque converter stall speed (rpm). */
    shift?: number
    efficiency?: number
    stall?: number
  }
  drive: { layout: Layout; centre?: Diff; split?: number; low?: number; lockers?: Locker[] }
  axles: AxleSpec[]
  brakes?: { bias?: number; maxDecel?: number; abs?: boolean }
  steering?: { ratio?: number; lock?: number }
  aero?: { cd?: number; frontalArea?: number; cdA?: number }
  /** The driving aids the REAL car has (its "Car default" in Settings): a 1989 pickup or a 1972 van has none, a
   *  2015 G-Class ABS + traction + stability control. Defaults to its class's. */
  aids?: AidLevel
}

/** §8.5 class defaults (fill the gaps, then tune). */
interface ClassDefaults {
  layout: Layout
  com: number
  cdA: number
  rideHz: number
  zeta: [number, number]
  steerRatio: number
  g1: number
  gTop: number
  tyre: TyreKind
  susp: [SuspensionType, SuspensionType]
  aids: AidLevel
  /** Roll gradient target (rad per g of lateral acceleration). */
  roll: number
  wheelMass: number
}

const deg = Math.PI / 180
export const CLASS_DEFAULTS: Record<VehicleClass, ClassDefaults> = {
  city: { layout: 'FF', com: 0.52, cdA: 0.62, rideHz: 1.2, zeta: [0.3, 0.5], steerRatio: 15, g1: 3.6, gTop: 0.75, tyre: 'road', susp: ['macpherson', 'torsion-beam'], aids: 'std', roll: 2.5 * deg, wheelMass: 15 },
  sedan: { layout: 'FF', com: 0.55, cdA: 0.65, rideHz: 1.2, zeta: [0.3, 0.5], steerRatio: 15, g1: 4.0, gTop: 0.7, tyre: 'road', susp: ['macpherson', 'multi-link'], aids: 'std', roll: 2.5 * deg, wheelMass: 18 },
  sports: { layout: 'FR', com: 0.46, cdA: 0.58, rideHz: 1.6, zeta: [0.35, 0.6], steerRatio: 13, g1: 3.3, gTop: 0.8, tyre: 'performance', susp: ['double-wishbone', 'multi-link'], aids: 'std', roll: 2 * deg, wheelMass: 20 },
  supercar: { layout: 'MR', com: 0.44, cdA: 0.6, rideHz: 2.0, zeta: [0.4, 0.65], steerRatio: 12, g1: 3.1, gTop: 0.75, tyre: 'performance', susp: ['double-wishbone', 'double-wishbone'], aids: 'std', roll: 1.5 * deg, wheelMass: 22 },
  muscle: { layout: 'FR', com: 0.52, cdA: 0.7, rideHz: 1.4, zeta: [0.3, 0.55], steerRatio: 16, g1: 3.0, gTop: 0.7, tyre: 'performance', susp: ['double-wishbone', 'solid-coil'], aids: 'std', roll: 3 * deg, wheelMass: 22 },
  suv: { layout: 'AWD-on-demand', com: 0.65, cdA: 0.95, rideHz: 1.4, zeta: [0.3, 0.5], steerRatio: 16, g1: 4.2, gTop: 0.7, tyre: 'road', susp: ['macpherson', 'multi-link'], aids: 'full', roll: 3.5 * deg, wheelMass: 24 },
  // (pickup / offroader / van: ζ 0.3 / 0.5 like the SUV — at 0.25 / 0.42 a kick overshot 45 % and a bump left the body
  // pitching for 4–5 swings: springy)
  pickup: { layout: 'part-time-4WD', com: 0.68, cdA: 1.2, rideHz: 1.3, zeta: [0.3, 0.5], steerRatio: 18, g1: 4.0, gTop: 0.8, tyre: 'at', susp: ['double-wishbone', 'solid-leaf'], aids: 'full', roll: 5.5 * deg, wheelMass: 28 },
  offroader: { layout: 'AWD-permanent', com: 0.75, cdA: 1.5, rideHz: 1.3, zeta: [0.3, 0.5], steerRatio: 18, g1: 4.4, gTop: 0.75, tyre: 'mt', susp: ['solid-coil', 'solid-coil'], aids: 'full', roll: 6 * deg, wheelMass: 40 },
  van: { layout: 'FR', com: 0.75, cdA: 1.3, rideHz: 1.35, zeta: [0.3, 0.5], steerRatio: 20, g1: 4.0, gTop: 0.8, tyre: 'road', susp: ['macpherson', 'solid-leaf'], aids: 'full', roll: 6 * deg, wheelMass: 22 },
  ev: { layout: 'FR', com: 0.48, cdA: 0.58, rideHz: 1.4, zeta: [0.3, 0.55], steerRatio: 14, g1: 9, gTop: 9, tyre: 'road', susp: ['double-wishbone', 'multi-link'], aids: 'std', roll: 2.5 * deg, wheelMass: 22 },
  rally: { layout: 'AWD-permanent', com: 0.48, cdA: 0.7, rideHz: 1.8, zeta: [0.35, 0.6], steerRatio: 11, g1: 3.2, gTop: 0.95, tyre: 'at', susp: ['macpherson', 'macpherson'], aids: 'off', roll: 2.5 * deg, wheelMass: 18 },
}

/** Front weight share by layout (§8.4). */
const FRONT_SHARE: Record<Layout, number> = { FF: 0.6, FR: 0.52, MR: 0.42, RR: 0.4, 'AWD-permanent': 0.55, 'AWD-on-demand': 0.58, 'part-time-4WD': 0.55 }

/** Tyre radius (m) from a size code: metric `W/AR R D` or flotation `DxW R D` (§8.4; 225/45R17 → 0.317 m). */
export function tyreRadius(code: string): number {
  const metric = /^(\d+)\/(\d+)\s*Z?R\s*(\d+(?:\.\d+)?)/i.exec(code)
  if (metric) return (Number(metric[3]) * 25.4 / 2 + Number(metric[1]) * Number(metric[2]) / 100) / 1000
  const flot = /^(\d+(?:\.\d+)?)\s*x/i.exec(code)
  if (flot) return (Number(flot[1]) * 0.0254) / 2
  const bias = /^(\d+(?:\.\d+)?)-(\d+)/.exec(code) // old bias-ply 6.50-16: section (in) + rim (in), AR ≈ 1
  if (bias) return (Number(bias[2]) * 25.4 / 2 + Number(bias[1]) * 25.4) / 1000
  throw new Error(`unknown tyre size '${code}'`)
}

/** Model geometry the spec is resolved against (normalised car space: −Z forward, ground at y = 0). */
export interface ChassisGeometry {
  /** Hub centres, ordered axle by axle front → rear, left then right. */
  wheelPos: [number, number, number][]
  /** Body extents (m). */
  half: { x: number; y: number; z: number }
}

export interface ResolvedAxle {
  steered: boolean
  driven: boolean
  diff: Diff
  suspension: SuspensionType
  radius: number
  tyreKind: TyreKind
  /** Static load share of the whole car this axle carries (0..1). */
  share: number
  freq: number
  zeta: [number, number]
  travel: number
  brake: 'disc' | 'drum'
  /** Wheel spin inertia (kg·m²). */
  inertia: number
  /** Anti-roll bar rate (N/m of left-right travel difference). */
  arb: number
  /** Axle position along the car (m) and track (m). */
  z: number
  track: number
}

export interface Resolved {
  cls: VehicleClass
  mass: number
  comHeight: number
  /** COM along the car (m, car space z). */
  comZ: number
  wheelbase: number
  power: {
    kind: PowerKind
    /** W, rad/s, N·m. */
    peakPower: number
    peakTorque: number
    wPower: number
    wTorque: [number, number]
    wIdle: number
    wRedline: number
    inertia: number
    turbo: { from: number; lag: number } | null
    regen: number
  }
  gearbox: { kind: GearboxKind; ratios: number[]; reverse: number; final: number; range: [number, number]; shift: number; efficiency: number; transfer: number; K: number }
  drive: { layout: Layout; centre: Diff; split: number; low: number; lockers: Locker[] }
  axles: ResolvedAxle[]
  brakes: { bias: number; maxDecel: number; abs: boolean }
  steering: { ratio: number; lock: number }
  cdA: number
  aids: AidLevel
  roll: number
  published: NonNullable<VehicleSpec['published']>
}

const rpm = (x: number) => (x * Math.PI) / 30

/** §8.4: sheet values, derivations, then class defaults — in that order. */
export function resolveSpec(spec: VehicleSpec, geo: ChassisGeometry): Resolved {
  const C = CLASS_DEFAULTS[spec.class]
  const g = 9.81
  const M = spec.mass.kerb
  const n = spec.axles.length
  if (geo.wheelPos.length !== n * 2) throw new Error(`spec has ${n} axles, the model ${geo.wheelPos.length} wheels`)
  const axleZ = spec.axles.map((_, i) => (geo.wheelPos[i * 2][2] + geo.wheelPos[i * 2 + 1][2]) / 2)
  const track = spec.axles.map((_, i) => Math.abs(geo.wheelPos[i * 2 + 1][0] - geo.wheelPos[i * 2][0]))
  const wheelbase = axleZ[n - 1] - axleZ[0]
  const layout = spec.drive.layout
  const front = spec.mass.frontShare ?? FRONT_SHARE[layout] ?? 0.55
  const comHeight = spec.mass.comHeight ?? C.com - (spec.power.kind === 'electric' ? 0.05 : 0)
  const comZ = axleZ[n - 1] - front * wheelbase
  // Axle load shares: front axle `front`, the rest split over the other axles.
  const share = spec.axles.map((_, i) => (n === 1 ? 1 : i === 0 ? front : (1 - front) / (n - 1)))
  // ---- power unit ----
  const p = spec.power
  const peakPower = p.peakPower * 1000
  const wPower = rpm(p.powerRpm)
  const tq = Array.isArray(p.torqueRpm) ? p.torqueRpm : [p.torqueRpm, p.torqueRpm]
  const redline = p.redline ?? (p.kind === 'electric' ? 16000 : p.powerRpm * 1.08)
  const idle = p.idle ?? (p.kind === 'electric' ? 0 : p.kind === 'diesel' ? 750 : 800)
  const inertia = p.inertia ?? { petrol: 0.15, 'turbo-petrol': 0.2, diesel: 0.3, electric: 0.07 }[p.kind]
  // ---- driven wheel radius (the first driven axle) ----
  const radii = spec.axles.map((a) => tyreRadius(a.tyre))
  const drivenAxles = spec.axles.map((a, i) => a.driven ?? defaultDriven(layout, i, n))
  const rDrive = radii[drivenAxles.indexOf(true)] ?? radii[n - 1]
  // ---- gearbox ----
  const t = spec.transmission
  let ratios = t.ratios
  if (!ratios) {
    if (t.kind === 'single' || t.kind === 'cvt') ratios = [1]
    else {
      const N = t.kind === 'auto' ? 6 : 5
      ratios = Array.from({ length: N }, (_, k) => C.g1 * Math.pow(C.gTop / C.g1, k / (N - 1)) * (k >= N - 2 ? 0.95 : 1))
    }
  }
  const gTop = t.kind === 'cvt' ? (t.range?.[1] ?? 0.4) : ratios[ratios.length - 1]
  let final = t.final
  if (final === undefined) {
    const vTop = (spec.published?.topSpeed ?? 160) / 3.6
    final = (t.kind === 'single' ? rpm(redline) : wPower * 1.05) * rDrive / (vTop * gTop)
  }
  const Tpk = p.peakTorque
  const stall = t.stall ?? (Math.max(p.kind === 'diesel' ? 1700 : 2000, tq[0] * 0.75))
  // ---- axles ----
  const travelDefault = (s: SuspensionType) => (s === 'solid-coil' || s === 'solid-leaf' ? 0.28 : s === 'portal' ? 0.3 : 0.18)
  const axles: ResolvedAxle[] = spec.axles.map((a, i) => {
    const freq = (a.springHz ?? C.rideHz) * (i > 0 ? 1.1 : 1) // rear ~10 % stiffer
    const r = radii[i]
    const mw = C.wheelMass * (r > 0.38 ? 1.6 : 1)
    return {
      steered: a.steered ?? i === 0,
      driven: drivenAxles[i],
      diff: a.diff ?? 'open',
      suspension: a.suspension ?? C.susp[i === 0 ? 0 : 1],
      radius: r,
      tyreKind: a.tyreKind ?? C.tyre,
      share: share[i],
      freq,
      zeta: a.zeta ?? C.zeta,
      travel: a.travel ?? travelDefault(a.suspension),
      brake: a.brake ?? 'disc',
      inertia: 0.6 * mw * r * r,
      arb: 0,
      z: axleZ[i],
      track: track[i],
    }
  })
  // ---- anti-roll bars (§8.8): total roll stiffness for the class's roll gradient, 60 % on the front ----
  const Kroll = (M * g * comHeight) / C.roll
  axles.forEach((a, i) => {
    const kw = M * (a.share / 2) * (2 * Math.PI * a.freq) ** 2 // wheel rate (N/m)
    const want = Kroll * (n === 1 ? 1 : i === 0 ? 0.6 : 0.4 / (n - 1))
    a.arb = Math.max(0, want / (a.track * a.track) - kw / 2)
  })
  // ---- steering lock from the turning circle (§8.4), else the class's ----
  const D = spec.published?.turningCircle
  const lock = spec.steering?.lock ?? (D ? Math.asin(Math.min(0.9, wheelbase / (D / 2))) : 0.6)
  // ---- brakes ----
  const kindMu = { road: 1, performance: 1.1, at: 0.95, mt: 0.9, winter: 0.95 }[axles[0].tyreKind]
  const drums = axles.every((a) => a.brake === 'drum')
  const maxDecel = spec.brakes?.maxDecel ?? (drums ? 0.65 : kindMu * 0.95)
  // Bias for the DYNAMIC front load at that deceleration (static share + h/L × decel): sized on the static
  // share, a tall car's front brakes run out of torque before its front tyres run out of grip.
  const bias = spec.brakes?.bias ?? Math.max(0.5, Math.min(0.85, front + (comHeight / wheelbase) * maxDecel))
  // ---- aero ----
  const a = spec.aero
  const cdA = a?.cdA ?? (a?.cd && a.frontalArea ? a.cd * a.frontalArea : a?.cd ? a.cd * 0.84 * geo.half.x * 2 * geo.half.y * 2 : C.cdA)
  return {
    cls: spec.class,
    mass: M,
    comHeight,
    comZ,
    wheelbase,
    power: {
      kind: p.kind,
      peakPower,
      peakTorque: Tpk,
      wPower,
      wTorque: [rpm(tq[0]), rpm(tq[1])],
      wIdle: rpm(idle),
      wRedline: rpm(redline),
      inertia,
      turbo: p.turbo ? { from: rpm(p.turbo.from), lag: p.turbo.lag } : null,
      regen: p.regen ?? (p.kind === 'electric' ? 0.2 : 0),
    },
    gearbox: {
      kind: t.kind,
      ratios,
      reverse: t.reverse ?? ratios[0] * 1.05,
      final,
      range: t.range ?? [2.5, 0.4],
      shift: t.shift ?? { manual: 0.38, auto: 0.32, dct: 0.12, cvt: 0, single: 0 }[t.kind],
      efficiency: t.efficiency ?? (t.kind === 'manual' || t.kind === 'single' ? 0.9 : 0.86),
      transfer: { manual: 0, auto: 0.5, dct: 0.7, cvt: 1, single: 1 }[t.kind],
      // Converter capacity factor: the impeller absorbs (ω/K)² — sized so full throttle stalls at `stall` rpm.
      K: rpm(stall) / Math.sqrt(Tpk),
    },
    drive: {
      layout,
      centre: spec.drive.centre ?? (layout === 'AWD-permanent' ? 'open' : 'locked'),
      split: spec.drive.split ?? 0.5,
      low: spec.drive.low ?? 1,
      lockers: spec.drive.lockers ?? [],
    },
    axles,
    brakes: { bias, maxDecel, abs: spec.brakes?.abs ?? !drums },
    steering: { ratio: spec.steering?.ratio ?? C.steerRatio, lock },
    cdA,
    aids: spec.aids ?? C.aids,
    roll: C.roll,
    published: spec.published ?? {},
  }
}

function defaultDriven(layout: Layout, i: number, n: number): boolean {
  if (layout === 'FF') return i === 0
  if (layout === 'FR' || layout === 'MR' || layout === 'RR') return i === n - 1
  return true
}

/**
 * Full-throttle torque (N·m) at engine speed w (rad/s) for a power unit (§8.3): a smooth curve through
 * (torque rpm, peak torque) and (power rpm, peak power / ω), shaped by kind. Turbo engines pass `boost` 0..1.
 */
export function curveTorque(P: Resolved['power'], w: number, boost = 1): number {
  const Tp = P.peakPower / P.wPower
  if (P.kind === 'electric') return Math.min(P.peakTorque, P.peakPower / Math.max(w, 1))
  const [t0, t1] = P.wTorque
  let T: number
  if (w <= t0) {
    // Rises from the idle torque to the peak (diesel and turbo: from boost onset).
    // (A turbo engine's off-boost deficit comes from the boost factor below, not a weaker base curve.)
    const lowFrac = P.kind === 'diesel' ? 0.55 : 0.62
    const k = smooth(Math.max(0, Math.min(1, (w - P.wIdle * 0.5) / Math.max(1, t0 - P.wIdle * 0.5))))
    T = P.peakTorque * (lowFrac + (1 - lowFrac) * k)
  } else if (w <= t1) T = P.peakTorque
  else if (w <= P.wPower) {
    const k = smooth((w - t1) / Math.max(1, P.wPower - t1))
    T = P.peakTorque + (Math.min(Tp, P.peakTorque) - P.peakTorque) * k
  } else {
    // Past peak power: falls off to ~80 % of the peak-power torque at the redline (and beyond, steeply).
    const k = (w - P.wPower) / Math.max(1, P.wRedline - P.wPower)
    T = Math.min(Tp, P.peakTorque) * (1 - 0.2 * k * k)
  }
  if (P.turbo) {
    // Below boost onset the turbo engine is a small NA engine; boost (lagged) fills the plateau.
    const on = smooth(Math.max(0, Math.min(1, (w - P.turbo.from * 0.6) / (P.turbo.from * 0.4))))
    T *= 1 - 0.45 * (1 - boost * on)
  }
  return Math.max(0, T)
}

function smooth(x: number): number {
  return x * x * (3 - 2 * x)
}
