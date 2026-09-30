import { useSyncExternalStore } from 'react'
import type { TimeLabel } from '../rendering/lighting/TimeOfDay'
import type { TierName } from '../rendering/quality/QualityTiers'
import type { Settings } from './Settings'

/**
 * Low-frequency game state for UI (changes a few times per minute at most).
 * High-frequency state (positions, velocities, stats) lives in plain objects on systems
 * and is NEVER put here — that would re-render React every frame. See skills/react-three-fiber.
 */
export interface GameStateShape {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  seed: number
  phase: TimeLabel
  nightmare: boolean
  pointerLocked: boolean
  hud: boolean
  debugChunks: boolean
  debugPhysics: boolean
  cullingFrozen: boolean
  flashlight: boolean
  tier: TierName
  adaptive: boolean
  /** Touch controls shown (coarse pointer detected, or a touch happened). */
  touch: boolean
  settings: Settings
  settingsOpen: boolean
  /** Player is dead (death screen shown). */
  dead: boolean
  /** Driving the truck (touch HUD: the JUMP button reads DRIFT). */
  driving: boolean
  /** Headlights on (HUD label while driving). */
  lights: boolean
  /** Front end open (the world idles behind it, camera orbiting the car): the main menu or the garage. */
  landing: boolean
  screen: 'menu' | 'garage'
  /** Catalogue id of the vehicle in the world, and a model download in progress (0..1, or null). */
  vehicle: string
  vehicleLoading: number | null
}

export interface Store<T> {
  get(): T
  set(patch: Partial<T>): void
  subscribe(fn: () => void): () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const subs = new Set<() => void>()
  return {
    get: () => state,
    set(patch) {
      let changed = false
      for (const k in patch) if (!Object.is(patch[k], state[k])) changed = true
      if (!changed) return
      state = { ...state, ...patch }
      subs.forEach((fn) => fn())
    },
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
  }
}

export function useStore<T, S>(store: Store<T>, selector: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()))
}
