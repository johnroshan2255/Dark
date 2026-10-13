import type { TyreKind } from './spec'

/**
 * TYRES AND SURFACES (skills/realistic-vehicle-system §8.7). Forces come from a Magic-Formula curve of slip:
 * MF(s) = sin(C·atan(B·s)), with C 1.6 longitudinal / 1.3 lateral and B set so each tyre kind peaks where it
 * should (κ ≈ 0.10; slip angle 5–10° by kind). (The published dry-tarmac set B 10 / C 1.9 / E 0.97 peaks at
 * κ ≈ 0.18, and its lateral twin with C 1.3 never peaks at all — fine for a solver, not for a car that should
 * break away.) A locked wheel keeps ~65 % of the peak; past the lateral peak it falls off a few %, so a car can
 * slide and be caught.
 */

export interface TyreKindDef {
  mu: number
  /** Peak slip angle (rad) and its off-road / snow / ice factors on μ. */
  peakAlpha: number
  offroad: number
  snow: number
  ice: number
}

const deg = Math.PI / 180
export const TYRE_KINDS: Record<TyreKind, TyreKindDef> = {
  road: { mu: 1.0, peakAlpha: 7 * deg, offroad: 1, snow: 1, ice: 1 },
  performance: { mu: 1.1, peakAlpha: 5.5 * deg, offroad: 0.85, snow: 0.8, ice: 0.9 },
  at: { mu: 0.95, peakAlpha: 8 * deg, offroad: 1.15, snow: 1.1, ice: 1 },
  mt: { mu: 0.9, peakAlpha: 10 * deg, offroad: 1.3, snow: 1.15, ice: 1 },
  winter: { mu: 0.95, peakAlpha: 7 * deg, offroad: 1, snow: 1.5, ice: 1.2 },
}

/** Surface ids (index into SURFACES). New surfaces go at the END (tyre marks / dust index by id). */
export const Surf = { Asphalt: 0, Dirt: 1, Grass: 2, Sand: 3, Snow: 4, Ice: 5, Mud: 6 } as const
export const SURFACE_COUNT = 7

export interface SurfaceDef {
  name: string
  mu: number
  /** Lateral stiffness factor (a softer surface peaks at a bigger slip angle). */
  stiff: number
  crr: number
  /** How much rain takes off μ (× wetness 0..1). */
  wet: number
  offroad: boolean
  /** Ground ROUGHNESS the springs ride over (m): rolling bumps / ruts amplitude, and stones (0..1 how stony). */
  rough: number
  stones: number
}

export const SURFACES: SurfaceDef[] = [
  { name: 'asphalt', mu: 1.0, stiff: 1.0, crr: 0.012, wet: 0.3, offroad: false, rough: 0.007, stones: 0 },
  { name: 'dirt', mu: 0.7, stiff: 0.8, crr: 0.025, wet: 0.35, offroad: true, rough: 0.035, stones: 0.7 },
  { name: 'grass', mu: 0.6, stiff: 0.75, crr: 0.04, wet: 0.3, offroad: true, rough: 0.05, stones: 0.5 },
  { name: 'sand', mu: 0.55, stiff: 0.6, crr: 0.12, wet: 0, offroad: true, rough: 0.03, stones: 0 },
  { name: 'snow', mu: 0.35, stiff: 0.6, crr: 0.05, wet: 0, offroad: true, rough: 0.025, stones: 0.2 },
  { name: 'ice', mu: 0.12, stiff: 0.5, crr: 0.01, wet: 0, offroad: false, rough: 0.004, stones: 0 },
  // MUD (the off-road tracks' wet stretches, rut bottoms, potholes, ditch bottoms — world/Road/RoadDetail): slippery
  // (μ ≈ 0.45 → ~0.37 in the rain), soft (peaks at a big slip angle) and draggy (Crr 0.08: tyres sink in), few stones.
  { name: 'mud', mu: 0.45, stiff: 0.5, crr: 0.08, wet: 0.2, offroad: true, rough: 0.022, stones: 0.1 },
]

/** A blended contact surface: weights per SURFACES entry (sum 1) and the ground wetness. */
export interface SurfaceMix {
  w: Float32Array
  wet: number
  /** Blended roughness amplitude (m) and stoniness; 0 = a perfectly smooth test ground. */
  rough: number
  stones: number
  /** WASHBOARD (gravel corrugations across the road): amplitude (m) and the road's unit direction (x, z). */
  wash?: number
  washX?: number
  washZ?: number
}

export function surfaceMix(): SurfaceMix {
  const w = new Float32Array(SURFACE_COUNT)
  w[0] = 1
  return { w, wet: 0, rough: 0, stones: 0, wash: 0, washX: 0, washZ: 1 }
}

/** Fill a mix's roughness from its weights (the world sampler calls it; tests leave it smooth). */
export function blendRoughness(s: SurfaceMix): void {
  let r = 0, st = 0
  for (let i = 0; i < SURFACE_COUNT; i++) (r += s.w[i] * SURFACES[i].rough), (st += s.w[i] * SURFACES[i].stones)
  s.rough = r
  s.stones = st
}

const hash2 = (x: number, z: number, k: number): number => {
  // Integer hash → [0, 1): deterministic on every client (no Math.random).
  let h = (Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + Math.imul(k, 2147483647)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
const vnoise = (x: number, z: number, k: number): number => {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz)
  const a = hash2(ix, iz, k), b = hash2(ix + 1, iz, k), c = hash2(ix, iz + 1, k), d = hash2(ix + 1, iz + 1, k)
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz
}

/**
 * GROUND ROUGHNESS height (m) at a world point: the bumps and stones the terrain mesh can't show (the gutters, wheel
 * ruts and potholes ARE geometry — the road ribbon's collider, world/Road/RoadDetail), fed into each wheel's suspension
 * (TruckSim) — the springs and dampers work on every surface, each wheel on its own. Rolling noise (2.6 m + 0.8 m wavelengths, ± amplitude) plus sparse round stones
 * (0.2–0.35 m across, up to 2.4 × the amplitude) on stony ground. Deterministic from world position.
 */
export function roughness(x: number, z: number, s: SurfaceMix): number {
  if (s.rough <= 0) return 0
  let h = ((vnoise(x / 2.6, z / 2.6, 11) - 0.5) * 1.4 + (vnoise(x / 0.8, z / 0.8, 12) - 0.5) * 0.6) * s.rough
  // Washboard: corrugations ~0.7 m apart across a gravel road (the ruts' packed surface), a smooth periodic
  // polynomial of the distance along the road (no sin: identical on every engine).
  if (s.wash) {
    const t = (x * (s.washX ?? 0) + z * (s.washZ ?? 1)) / 0.7, f = t - Math.floor(t)
    h += s.wash * (16 * f * f * (1 - f) * (1 - f) - 0.533)
  }
  if (s.stones > 0) {
    const cx = Math.floor(x / 1.6), cz = Math.floor(z / 1.6)
    if (hash2(cx, cz, 13) < 0.22 * s.stones) {
      const px = (cx + 0.2 + 0.6 * hash2(cx, cz, 14)) * 1.6, pz = (cz + 0.2 + 0.6 * hash2(cx, cz, 15)) * 1.6
      const rad = 0.2 + 0.15 * hash2(cx, cz, 16)
      const d = Math.hypot(x - px, z - pz) / rad
      if (d < 1) h += (1 - d * d) * (1 - d * d) * s.rough * 2.4 * (0.5 + hash2(cx, cz, 17))
    }
  }
  return h
}

/** Grip numbers for one tyre on a blended surface (blended by weight — never a jump at a border). */
export interface Grip {
  mu: number
  /** Peak slip ratio and peak slip angle (rad) on this surface. */
  kp: number
  ap: number
  crr: number
  /** 0..1: how much of the surface is sand (rolling resistance rises with wheel slip there). */
  sand: number
  offroad: number
}

export function grip(): Grip {
  return { mu: 1, kp: 0.1, ap: 0.12, crr: 0.012, sand: 0, offroad: 0 }
}

export function gripFor(kind: TyreKindDef, s: SurfaceMix, scale: number, out: Grip): Grip {
  let mu = 0, stiff = 0, crr = 0, off = 0
  for (let i = 0; i < SURFACE_COUNT; i++) {
    const w = s.w[i]
    if (w <= 0) continue
    const d = SURFACES[i]
    const kf = i === Surf.Snow ? kind.snow : i === Surf.Ice ? kind.ice : d.offroad ? kind.offroad : 1
    mu += w * d.mu * kf * (1 - d.wet * s.wet)
    stiff += w * d.stiff
    crr += w * d.crr
    if (d.offroad) off += w
  }
  out.mu = mu * kind.mu * scale
  out.kp = 0.1 * (1 + 0.3 * off)
  out.ap = kind.peakAlpha / Math.max(0.3, stiff)
  out.crr = crr
  out.sand = s.w[Surf.Sand]
  out.offroad = off
  return out
}

/**
 * Combined slip (Pacejka's similarity method): slip ratio κ and slip angle α are normalised by their peaks, the
 * force magnitude is the Magic Formula of the combined normalised slip ρ (peak at ρ = 1, shape C 1.6 along the
 * tyre → 1.3 across), and its direction follows the slip vector — so a locked wheel slides straight along its
 * velocity, a spinning one loses side grip, and pure cornering keeps the lateral curve. Writes [Fx, Fy] / (μ·Fz)
 * into `out` (Fy opposes the slip angle; the lateral peak is 0.95 of the longitudinal).
 */
export function combinedSlip(kappa: number, alpha: number, g: Grip, out: number[]): void {
  const rx = kappa / g.kp
  const ry = Math.tan(Math.max(-1.4, Math.min(1.4, alpha))) / Math.tan(g.ap)
  const r2 = rx * rx + ry * ry
  if (r2 < 1e-12) {
    out[0] = out[1] = 0
    return
  }
  const rho = Math.sqrt(r2)
  const C = (1.6 * rx * rx + 1.3 * ry * ry) / r2
  const B = Math.tan(Math.PI / (2 * C))
  const F = Math.sin(C * Math.atan(B * rho))
  out[0] = (F * rx) / rho
  out[1] = (-0.95 * F * ry) / rho
}
