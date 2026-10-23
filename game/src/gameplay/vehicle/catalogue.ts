/**
 * THE GARAGE — every drivable vehicle, its model, its stock setup and the player's tuning ranges.
 * Models live in `src/assets/models/vehicles/<id>.lod0.glb` (credits: ASSET_LIST.md § Credits) and are baked at
 * load by `assets/loadModels.ts` (`bakeVehicle`) into the game's own materials. Tuning is per vehicle, saved in
 * Settings (`garage`), edited on the landing page and in Settings → Garage, and applied live (`Car.retune`).
 */
export interface VehicleTuning {
  /** Engine power (kW). */
  power: number
  /** Drive force cap on the flat (kN) — pull off the line and up hills. */
  force: number
  /** Boost power multiplier (Shift / BOOST). */
  boost: number
  /** Tyre grip (Rapier frictionSlip ≈ μ). */
  grip: number
  /** Suspension stiffness (spring rate per kg). */
  suspension: number
  /** Tyre size multiplier (render + physics radius; bigger tyres = more ground clearance, slower steering). */
  tyre: number
  /** Kerb mass (kg). */
  mass: number
  /** Paint colour (#rrggbb): tints the paint panels (masked per model). */
  paint: string
}

export interface TuneRange {
  key: keyof VehicleTuning
  label: string
  min: number
  max: number
  step: number
  unit: string
}

export const TUNE_RANGES: TuneRange[] = [
  { key: 'power', label: 'Engine power', min: 20, max: 400, step: 5, unit: 'kW' },
  { key: 'force', label: 'Pulling force', min: 6, max: 30, step: 0.5, unit: 'kN' },
  { key: 'boost', label: 'Boost', min: 1.2, max: 3, step: 0.1, unit: '×' },
  { key: 'grip', label: 'Tyre grip', min: 1.2, max: 4, step: 0.1, unit: 'μ' },
  { key: 'suspension', label: 'Suspension', min: 18, max: 70, step: 1, unit: '' },
  { key: 'tyre', label: 'Tyre size', min: 0.8, max: 1.4, step: 0.05, unit: '×' },
  { key: 'mass', label: 'Weight', min: 700, max: 3600, step: 50, unit: 'kg' },
]

export const PAINTS: { name: string; hex: string }[] = [
  { name: 'Stock', hex: '#ffffff' }, { name: 'Rally Red', hex: '#e83a2a' }, { name: 'Safari Orange', hex: '#e8a23a' },
  { name: 'Desert Yellow', hex: '#f2d838' }, { name: 'Lime', hex: '#c8d82a' }, { name: 'Forest Green', hex: '#3aa64a' },
  { name: 'Teal', hex: '#2aa6a0' }, { name: 'Sky Blue', hex: '#2a7ee8' }, { name: 'Navy', hex: '#1e3a78' },
  { name: 'Violet', hex: '#7a3ae8' }, { name: 'Midnight', hex: '#1b1d22' }, { name: 'Sand', hex: '#c8b28a' },
  { name: 'Mud Brown', hex: '#8a6a48' }, { name: 'Silver', hex: '#c8ccd2' }, { name: 'Gunmetal', hex: '#5a616c' }, { name: 'Cream', hex: '#f2ead8' },
]

export interface VehicleDef {
  id: string
  name: string
  maker: string
  year: string
  blurb: string
  /** Model file (Vite URL), length after normalising (m) — chosen so the WHEELBASE matches the real vehicle
   *  (G500 4×4² 2.85 m · E30 2.57 m · kei van 1.84 m: the last two are already in metres, vehicle_prep.py); the
   *  human is a 1.78 m adult (CharacterModel). */
  url: string
  length: number
  /** Which model axis points forward in the source file ('+z' = Sketchfab default; rotated to −Z in game). */
  forward: '+z' | '-z' | '+x' | '-x'
  /** Wheel meshes by node name (separate wheel parts); undefined = split wheels out of the body by shape. */
  wheelRegex?: RegExp
  /** Meshes whose material name matches take the paint colour; undefined = every body mesh — for textured models
   *  further limited per pixel to the body paint (loadModels buildPaintMap: the texture's dominant body hue). */
  paintRegex?: RegExp
  /** Look for an unnamed steering wheel to animate (a model without a `steering_wheel` part). */
  steering?: boolean
  /** Lamp lenses (car space, the RIGHT side; mirrored to the left), measured on the model: they WIN over the lamps
   *  found on the model at load (loadModels findLamps / findLampsInParts — a guess that put the G500's heads on its
   *  bumper), then a body-box guess. `head2`: a second headlamp per side (the E30's quad lamps); sizes are half
   *  extents (m). */
  lamps?: { head: [number, number, number]; tail: [number, number, number]; head2?: [number, number, number]; headSize?: [number, number]; tailSize?: [number, number] }
  /** The dash: 'twin' round speedo + tacho, 'single' speedo + lamp strip, 'screen' a wide twin screen (Cockpit). */
  dash: 'twin' | 'single' | 'screen'
  /** Paint mask for a WHITE (unsaturated) textured body: the bright neutral texels take the paint (buildPaintMap
   *  otherwise picks the body's dominant saturated hue). */
  whitePaint?: boolean
  /** Driver's cabin (measured in Blender, m): seated hip height, the roof's underside above the seat, and how far
   *  the hips sit behind the steering wheel's centre. The driver's seat x is the steering wheel's. */
  cabin: { hip: number; roof: number; behind: number }
  /** Draw live beam axles + diffs + driveshaft under the body (models without their own). */
  axles?: boolean
  /** Texture colour grade toward weathered real paint (loadModels gradeTexture): saturation and brightness factors. */
  grade?: { sat: number; gain: number }
  /** Engine voice (AudioSystem): pitch × the recorded loops (V8 low, small 4-cylinder high) and the automatic
   *  gearbox's shift speeds (m/s) — spaced to the car's own top speed so it never sits on the limiter. */
  engine: { pitch: number; gears: number[] }
  /** Exhaust tailpipe tip(s) in CAR space (m, as baked: −Z forward, +X right, ground y = 0, origin at the
   *  wheelbase centre) with each tip's HORIZONTAL outflow direction (normalised at load; the smoke rises by
   *  itself) — measured on the model where it has a pipe. The smoke puffs take turns between the tips (same total
   *  rate, so the same particle budget) and leave along `dir`. Undefined = one tip at the rear left under the
   *  bumper, blowing straight back. */
  exhaust?: { at: [number, number, number]; dir: [number, number, number] }[]
  stock: VehicleTuning
  /** The real machine (skills/realistic-vehicle-system §8.4): its public spec sheet, resolved at load against the
   *  model's measured wheelbase / track into the Simulation-handling drivetrain. The garage sliders scale it
   *  relative to `stock` (power, mass, grip, springs, tyre size). */
  spec: VehicleSpec
  /** Download size fallback for the progress bar (bytes). */
  bytes: number
}

import type { VehicleSpec } from './drivetrain/spec'
import { SPECS } from './specs'
import gwagenUrl from '../../assets/models/vehicles/mercedes_g500_4x4.lod0.glb?url'
import bmwUrl from '../../assets/models/vehicles/bmw_e30.lod0.glb?url'
import vanUrl from '../../assets/models/vehicles/carry_van.lod0.glb?url'

export const VEHICLES: VehicleDef[] = [
  {
    id: 'gwagen',
    name: 'G500 4×4²',
    maker: 'Mercedes-Benz',
    year: '2015',
    blurb: 'Portal axles, twin-turbo V8, 45 cm of ground clearance. The mountain goat.',
    url: gwagenUrl, length: 4.68, forward: '+z', wheelRegex: /wheel_(FL|FR|RL|RR)/i, paintRegex: /CarPaint/i, bytes: 1_977_452, dash: 'screen',
    cabin: { hip: 1.35, roof: 2.2, behind: 0.49 },
    // its two round headlamps in the wings (the lens parts `glas_light`, measured) and the tail lamps at the back
    // corners — the old fallback [0.66, 1.08, −2.44] floated 30 cm ahead of the grille, at bumper height
    lamps: { head: [0.597, 1.206, -2.13], tail: [0.7, 1.0, 2.29], headSize: [0.088, 0.088], tailSize: [0.07, 0.12] },
    engine: { pitch: 0.8, gears: [0, 7, 14, 22, 31, 42, 70] },
    // Side exits, as on the real 4×4²: twin tips each side under the sill just ahead of the rear wheels, angled
    // out and back (the model's own pipes; tip mouths measured, sides alternating).
    exhaust: [
      { at: [-0.84, 0.55, 0.58], dir: [-0.88, 0, 0.47] }, { at: [0.84, 0.55, 0.58], dir: [0.88, 0, 0.47] },
      { at: [-0.84, 0.56, 0.7], dir: [-0.88, 0, 0.47] }, { at: [0.84, 0.56, 0.7], dir: [0.88, 0, 0.47] },
    ],
    stock: { power: 310, force: 18, boost: 2.0, grip: 2.8, suspension: 44, tyre: 1, mass: 3000, paint: '#c8d82a' }, // (its original lime — the key art's truck; was olive #55604a)
    spec: SPECS.gwagen,
  },
  {
    id: 'bmw',
    name: 'E30 M3',
    maker: 'BMW',
    year: '1986',
    blurb: 'The touring-car homologation special: a 2.3 L four that revs to 7250, a limited-slip rear and a box-flared body.',
    url: bmwUrl, length: 4.3185, forward: '+z', wheelRegex: /wheel_(FL|FR|RL|RR)/i, steering: true, bytes: 1_324_664, dash: 'twin',
    whitePaint: true,
    cabin: { hip: 0.42, roof: 1.3, behind: 0.42 },
    // quad round headlamps (outer + inner per side), the wide tail lamps (scripts/blender/vehicle_prep.py measure)
    lamps: { head: [0.586, 0.606, -1.99], head2: [0.41, 0.606, -1.99], headSize: [0.072, 0.072], tail: [0.51, 0.655, 2.22], tailSize: [0.148, 0.075] },
    engine: { pitch: 1.3, gears: [0, 13, 21, 30, 41, 54, 72] },
    // twin tips under the rear bumper on the left (the model's own pipes), blowing straight back
    exhaust: [{ at: [-0.4, 0.24, 2.16], dir: [0, 0, 1] }, { at: [-0.46, 0.24, 2.16], dir: [0, 0, 1] }],
    stock: { power: 147, force: 11, boost: 2.0, grip: 2.6, suspension: 40, tyre: 1, mass: 1200, paint: '#ffffff' },
    spec: SPECS.bmw,
  },
  {
    id: 'van',
    name: 'Kei Van',
    maker: 'Workhorse',
    year: '1983',
    blurb: 'A cab-over 800 cc delivery van: tiny, light, slow — and it goes anywhere a cart track goes.',
    url: vanUrl, length: 3.3777, forward: '+z', wheelRegex: /wheel_(FL|FR|RL|RR)/i, paintRegex: /^paint/i, axles: true, bytes: 3_258_788, dash: 'single',
    // (a squat cab: windscreen 1.02–1.55 m — the head at 1.38 looks out of it, not into the headliner)
    cabin: { hip: 0.72, roof: 1.5, behind: 0.38 },
    lamps: { head: [0.492, 0.752, -1.62], headSize: [0.075, 0.075], tail: [0.648, 0.758, 1.66], tailSize: [0.05, 0.068] },
    engine: { pitch: 1.35, gears: [0, 4.5, 9, 15, 22, 29, 35] },
    // under the rear on the right, ahead of the bumper, blowing straight back
    exhaust: [{ at: [0.42, 0.22, 1.55], dir: [0, 0, 1] }],
    stock: { power: 27, force: 6, boost: 2.4, grip: 2.0, suspension: 30, tyre: 1, mass: 860, paint: '#ffffff' },
    spec: SPECS.van,
  },
]

export const DEFAULT_VEHICLE = 'gwagen'

export function vehicleDef(id: string): VehicleDef {
  return VEHICLES.find((v) => v.id === id) ?? VEHICLES[0]
}

/** Stock setup with the player's saved overrides on top (clamped to the tuning ranges). */
export function tuningFor(id: string, saved?: Partial<VehicleTuning>): VehicleTuning {
  const t = { ...vehicleDef(id).stock, ...(saved ?? {}) }
  for (const r of TUNE_RANGES) (t as unknown as Record<string, number>)[r.key] = Math.min(r.max, Math.max(r.min, t[r.key] as number))
  return t
}

/** 0..1 stat bars for the cards (power-to-weight, pull, grip, tyres). */
export function vehicleStats(t: VehicleTuning): { label: string; value: number }[] {
  return [
    { label: 'Speed', value: Math.min(1, (t.power / t.mass) * 9) },
    { label: 'Torque', value: Math.min(1, t.force / 30) },
    { label: 'Grip', value: Math.min(1, (t.grip - 1) / 3) },
    { label: 'Tyres', value: Math.min(1, (t.tyre - 0.7) / 0.7) },
  ]
}

/** Overall rating 0..100 for the cards (weighted stats). */
export function vehicleRating(t: VehicleTuning): number {
  const st = vehicleStats(t)
  return Math.round((st[0].value * 0.35 + st[1].value * 0.3 + st[2].value * 0.2 + st[3].value * 0.15) * 100)
}

/** Class label for the cards. */
export function vehicleClass(t: VehicleTuning): string {
  const r = vehicleRating(t)
  return r >= 70 ? 'CLASS A' : r >= 45 ? 'CLASS B' : 'CLASS C'
}
