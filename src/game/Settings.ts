import type { CameraMode } from '../gameplay/player/CameraController'
import type { AAMode } from '../rendering/postprocessing/PostPipeline'
import type { Feature, Level, TierName } from '../rendering/quality/QualityTiers'
import type { ArtStyle } from '../rendering/artStyle'
import { DEFAULT_VEHICLE, type VehicleTuning } from '../gameplay/vehicle/catalogue'

/**
 * Player settings. 'auto' = use the quality tier's default (and let adaptive quality manage it).
 * Persisted per browser in localStorage (a per-viewer convenience; failure is harmless).
 */
export interface Settings {
  /** Graphics preset ('auto' = detected + adaptive, never above HIGH). */
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
  /** Art style (rendering/artStyle.ts): 'bright' Genshin (default), 'overland' over the hill, or 'storybook'. Changing it reloads. */
  artStyle: ArtStyle
  /** Monsters and storms in monster time (off = exploration mode). */
  monsters: boolean
  /** All sound on/off (one toggle), and the warm theme music on/off. */
  sound: boolean
  music: boolean
  /** The garage: chosen vehicle and per-vehicle tuning overrides (gameplay/vehicle/catalogue.ts). */
  garage: { vehicle: string; tuning: Record<string, Partial<VehicleTuning>> }
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'auto',
  gfx: {},
  hold60: true,
  aa: 'auto',
  sharpness: 'auto',
  resolution: 'auto',
  pixelRatio: 'auto',
  camera: 'tpp',
  handling: 'arcade',
  autoAccelerate: false,
  dayLength: 24,
  showFps: true,
  lookSensitivity: 1,
  filmGrain: true,
  painterly: false,
  painterlyForce: false,
  artStyle: 'bright',
  monsters: true,
  sound: true,
  music: true,
  garage: { vehicle: DEFAULT_VEHICLE, tuning: {} },
}

const KEY = 'dark.settings.v4'
/** v3 → v4: the default art style changed to 'bright' (Genshin); a v3 save keeps everything but its style choice. */
const OLD_KEY = 'dark.settings.v3'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
    const old = localStorage.getItem(OLD_KEY)
    if (old) {
      const { artStyle: _dropped, ...rest } = JSON.parse(old) as Partial<Settings>
      const s = { ...DEFAULT_SETTINGS, ...rest }
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
