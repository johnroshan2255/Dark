import type { CameraMode } from '../gameplay/player/CameraController'
import type { AAMode } from '../rendering/postprocessing/PostPipeline'
import type { Feature, Level, TierName } from '../rendering/quality/QualityTiers'
import { DEFAULT_VEHICLE, type VehicleTuning } from '../gameplay/vehicle/catalogue'

/**
 * Player settings. 'auto' = use the quality tier's default (and let adaptive quality manage it).
 * Persisted per browser in localStorage (a per-viewer convenience; failure is harmless).
 */
export interface Settings {
  /** Graphics preset: ULTRA by default (with Hold 60); 'auto' = detected + adaptive, never above HIGH. */
  quality: 'auto' | TierName
  /** Per-feature graphics overrides on top of the preset (missing / 'auto' = the preset's level). */
  gfx: Partial<Record<Feature, Level | 'auto'>>
  /** Hold 60 fps: on a chosen preset, lower the resolution and then the costliest features (runtime only) whenever
   *  frames run long; restore them with headroom. Off = the preset exactly as chosen, whatever the frame rate. */
  hold60: boolean
  aa: 'auto' | AAMode
  sharpness: 'auto' | number
  /** Render scale of the 3D view; 'auto' lets adaptive quality choose within the tier range. */
  resolution: 'auto' | number
  /** Device-pixel-ratio cap; 'auto' = tier cap, 'native' = the display's full DPR. */
  pixelRatio: 'auto' | 'native' | number
  camera: CameraMode
  /** Driving model: 'arcade' (Asphalt-style: grip, brake-tap drifts, nitro) or 'sim' (realistic tyres + power). */
  handling: 'arcade' | 'sim'
  /** Simulation handling: the shift map ('auto') or the player's gears ('manual': X up / Z down). */
  gearbox: 'auto' | 'manual'
  /** Simulation handling: driving aids (TCS, ABS, ESC, counter-steer, grip-limited steering, the GTA handbrake);
   *  'auto' = Full on every device (GTA-smooth, 2026-10-16); 'off' = the raw machine (skills/realistic-vehicle-system §8.7). */
  aids: 'auto' | 'off' | 'std' | 'full'
  /** Simulation handling: OFF-ROAD ASSIST (gameplay) — more engine torque, and walls up to 80° climbable in 1st
   *  (TruckSim slope limiter, 4WD / lockers, TCS on the climb). Off = the real machine. */
  offroadAssist: boolean
  /** Arcade on touch screens: the car accelerates by itself (pull the stick back to brake / drift). OFF by
   *  default (the player drives with the stick); renamed from `autoAccel` so saves holding its old default (on) reset. */
  autoAccelerate: boolean
  /** Real minutes per 24 h game day; 0 = time paused. */
  dayLength: number
  showFps: boolean
  lookSensitivity: number
  /** Film grain (part of the look; some players prefer a clean image). */
  filmGrain: boolean
  /** Painterly art filter (the concept-art look). */
  painterly: boolean
  /** Force the painterly filter on tiers where it defaults off (LOW). */
  painterlyForce: boolean
  /** Monsters and storms in monster time (off = exploration mode). */
  monsters: boolean
  /** All sound on/off (one toggle), and the warm theme music on/off. */
  sound: boolean
  music: boolean
  /** The garage: chosen vehicle and per-vehicle tuning overrides (gameplay/vehicle/catalogue.ts). */
  garage: { vehicle: string; tuning: Record<string, Partial<VehicleTuning>> }
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'ultra',
  gfx: {},
  hold60: true,
  aa: 'auto',
  sharpness: 'auto',
  resolution: 'auto',
  pixelRatio: 'auto',
  camera: 'tpp',
  handling: 'sim',
  gearbox: 'auto',
  aids: 'auto',
  offroadAssist: false,
  autoAccelerate: false,
  dayLength: 24,
  showFps: true,
  lookSensitivity: 1,
  filmGrain: true,
  painterly: false,
  painterlyForce: false,
  monsters: true,
  sound: true,
  music: true,
  garage: { vehicle: DEFAULT_VEHICLE, tuning: {} },
}

const KEY = 'dark.settings.v7'
/** v6 → v7: OFF-ROAD ASSIST became off by default (the real machine); a v6 save keeps everything else.
 *  v5 → v7: also the default handling became the realistic simulation (v5's handling is dropped too).
 *  v4 saves are no longer migrated (they get the defaults). */
const V6_KEY = 'dark.settings.v6'
const V5_KEY = 'dark.settings.v5'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
    const v6 = localStorage.getItem(V6_KEY)
    const v5 = v6 ? null : localStorage.getItem(V5_KEY)
    if (v6 || v5) {
      const { handling, offroadAssist: _oldDefault, ...rest } = JSON.parse((v6 ?? v5)!) as Partial<Settings>
      const s = { ...DEFAULT_SETTINGS, ...rest, ...(v6 && handling ? { handling } : {}) }
      saveSettings(s)
      return s
    }
  } catch {
    /* private mode / blocked storage → defaults */
  }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}
