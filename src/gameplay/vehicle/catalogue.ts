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
  { key: 'power', label: 'Engine power', min: 40, max: 400, step: 5, unit: 'kW' },
  { key: 'force', label: 'Pulling force', min: 6, max: 30, step: 0.5, unit: 'kN' },
  { key: 'boost', label: 'Boost', min: 1.2, max: 3, step: 0.1, unit: '×' },
  { key: 'grip', label: 'Tyre grip', min: 1.2, max: 4, step: 0.1, unit: 'μ' },
  { key: 'suspension', label: 'Suspension', min: 18, max: 70, step: 1, unit: '' },
  { key: 'tyre', label: 'Tyre size', min: 0.8, max: 1.4, step: 0.05, unit: '×' },
  { key: 'mass', label: 'Weight', min: 900, max: 3600, step: 50, unit: 'kg' },
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
  /** Model file (Vite URL), length after normalising (m). */
  url: string
  length: number
  /** Which model axis points forward in the source file ('+z' = Sketchfab default; rotated to −Z in game). */
  forward: '+z' | '-z' | '+x' | '-x'
  /** Wheel meshes by node name (separate wheel parts); undefined = split wheels out of the body by shape. */
  wheelRegex?: RegExp
  /** Meshes whose material name matches take the paint colour; undefined = the whole body (textured models). */
  paintRegex?: RegExp
  /** Look for a steering wheel to animate (the pickup has one). */
  steering?: boolean
  /** Lamp positions (right side; mirrored): head [x, y, z] at the nose, tail at the rear. Default: from the body box. */
  lamps?: { head: [number, number, number]; tail: [number, number, number] }
  stock: VehicleTuning
  /** Download size fallback for the progress bar (bytes). */
  bytes: number
}

import pickupUrl from '../../assets/models/vehicles/pickup_truck.lod0.glb?url'
import gwagenUrl from '../../assets/models/vehicles/mercedes_g500_4x4.lod0.glb?url'
import zukUrl from '../../assets/models/vehicles/zuk_a06.lod0.glb?url'

export const VEHICLES: VehicleDef[] = [
  {
    id: 'pickup',
    name: 'Ranger Pickup',
    maker: 'Workhorse',
    year: '1989',
    blurb: 'The farm truck. Tough, simple, climbs anything in low range.',
    url: pickupUrl, length: 5.1, forward: '+z', steering: true, bytes: 1_725_472,
    stock: { power: 120, force: 12, boost: 2.2, grip: 2.4, suspension: 36, tyre: 1, mass: 1750, paint: '#ffffff' },
  },
  {
    id: 'gwagen',
    name: 'G500 4×4²',
    maker: 'Mercedes-Benz',
    year: '2015',
    blurb: 'Portal axles, twin-turbo V8, 45 cm of ground clearance. The mountain goat.',
    url: gwagenUrl, length: 4.8, forward: '+z', wheelRegex: /wheel(FL|FR|BL|BR)/i, paintRegex: /CarPaint/i, bytes: 2_266_000,
    lamps: { head: [0.66, 1.08, -2.44], tail: [0.72, 1.22, 2.43] },
    stock: { power: 310, force: 18, boost: 2.0, grip: 2.8, suspension: 44, tyre: 1.15, mass: 3000, paint: '#c8d82a' },
  },
  {
    id: 'zuk',
    name: 'Żuk A06',
    maker: 'FSC Lublin',
    year: '1972',
    blurb: 'A Polish delivery van with a lawnmower engine. Slow, light, oddly capable.',
    url: zukUrl, length: 4.4, forward: '+z', bytes: 3_886_884,
    stock: { power: 55, force: 8, boost: 2.4, grip: 2.0, suspension: 28, tyre: 0.9, mass: 1400, paint: '#ffffff' },
  },
]

export const DEFAULT_VEHICLE = 'pickup'

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
