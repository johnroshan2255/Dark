import type { CameraMode } from '../gameplay/player/CameraController'
import type { AAMode } from '../rendering/postprocessing/PostPipeline'
import type { TierName } from '../rendering/quality/QualityTiers'
import type { ArtStyle } from '../rendering/artStyle'
import { DEFAULT_VEHICLE, type VehicleTuning } from '../gameplay/vehicle/catalogue'

/**
 * Player settings. 'auto' = use the quality tier's default (and let adaptive quality manage it).
 * Persisted per browser in localStorage (a per-viewer convenience; failure is harmless).
 */
export interface Settings {
  quality: 'auto' | TierName
  aa: 'auto' | AAMode
  sharpness: 'auto' | number
  /** Render scale of the 3D view; 'auto' lets adaptive quality choose within the tier range. */
  resolution: 'auto' | number
  /** Device-pixel-ratio cap; 'auto' = tier cap, 'native' = the display's full DPR. */
  pixelRatio: 'auto' | 'native' | number
  camera: CameraMode
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
  /** Art style (rendering/artStyle.ts): 'overland' (default), 'bright' Genshin day, or 'storybook'. Changing it reloads. */
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
  aa: 'auto',
  sharpness: 'auto',
  resolution: 'auto',
  pixelRatio: 'auto',
  camera: 'tpp',
  dayLength: 24,
  showFps: true,
  lookSensitivity: 1,
  filmGrain: true,
  painterly: false,
  painterlyForce: false,
  artStyle: 'overland',
  monsters: true,
  sound: true,
  music: true,
  garage: { vehicle: DEFAULT_VEHICLE, tuning: {} },
}

const KEY = 'dark.settings.v3'
/** v2 → v3: the default art style changed to 'overland'; a v2 save keeps everything but its style choice. */
const OLD_KEY = 'dark.settings.v2'

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
