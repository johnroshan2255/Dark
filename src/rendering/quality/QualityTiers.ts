import { CHUNK_SIZE } from '../../world/constants'
import type { AAMode } from '../postprocessing/PostPipeline'

/**
 * Quality tiers. Every system reads its budget from here — never from hard-coded constants.
 * Goal on EVERY tier: ≥ 60 fps minimum, uncapped above (runs at display refresh).
 * See skills/mobile and skills/webgl §budgets.
 */
export type TierName = 'low' | 'medium' | 'high'
export const TIERS: readonly TierName[] = ['low', 'medium', 'high']

export interface QualitySettings {
  name: TierName
  /** Rendered chunk ring (Chebyshev radius). View distance ≈ radius × 64 m. */
  renderRadius: number
  /** LOD ring boundaries in chunk units. */
  lodRings: [number, number]
  /** Device-pixel-ratio cap. */
  maxDpr: number
  /** Dynamic resolution range for the scene render target. */
  renderScale: { min: number; max: number; start: number }
  /** Default anti-aliasing (user setting can override). FXAA ≈ 0.3 ms; MSAA×4 costs bandwidth + ~66 MB at 1080p. */
  aa: AAMode
  /** Default sharpening (counteracts bilinear upscale softness when renderScale < 1). */
  sharpen: number
  /** Painterly filter brush stride (px; 0 = off) and bloom strength (0 = off). */
  paint: { stride: number; bloom: number }
  /** Light shafts: RT divisor, screen-space glare samples, volumetric (shadow-map) march steps (0 = off). */
  godRays: { divisor: number; samples: number; volumeSteps: number }
  /** Grass field around the player: fade radius (m), individual blades per m², blade segments (1 or 2). One draw call. */
  grass: { radius: number; density: number; blades: number }
  /** Trees: geometry level for near (LOD0) chunks (0 full ≈170–250 tris, 1 mid ≈50–100). */
  trees: { near: number }
  sunShadowSize: number
  /** Re-render the sun shadow map every N frames (world casters are static). */
  sunShadowEvery: number
  /** Half-width of the sun shadow frustum (m). */
  sunShadowExtent: number
  /** Flashlight shadow map. Toggling recompiles lit programs — tier changes only. */
  flashlightShadow: boolean
  /** Small plants on LOD0 chunks. */
  plants: boolean
  /** Chunk meshes built per frame. */
  buildPerFrame: number
  /** Max view distance (m): fog is complete here and NOTHING beyond it is drawn (chunks culled, horizon
   *  terrain sized to it). The cheapest way to keep hill-top views fast on phones. */
  viewDistance: number
  /** Max rendered pixels of the 3D scene (before the final upscale). */
  pixelBudget: number
  /** Horizon terrain beyond the streamed chunks: side length (m) and grid resolution. */
  horizon: { size: number; res: number }
  /** Monster count at night (the nightmare realm adds more). */
  monsters: { stalkers: number; striders: number }
}

export const QUALITY: Record<TierName, QualitySettings> = {
  // ~₹15k phones (Mali-G57 / Adreno 610), Intel UHD laptops.
  low: {
    name: 'low', renderRadius: 2, lodRings: [0.9, 1.6], maxDpr: 1,
    renderScale: { min: 0.5, max: 0.85, start: 0.75 }, aa: 'fxaa', sharpen: 0.35,
    godRays: { divisor: 6, samples: 12, volumeSteps: 8 }, paint: { stride: 0, bloom: 0.45 }, grass: { radius: 12, density: 18, blades: 1 }, trees: { near: 1 },
    sunShadowSize: 1024, sunShadowEvery: 3, sunShadowExtent: 34, flashlightShadow: false,
    plants: false, buildPerFrame: 1, monsters: { stalkers: 1, striders: 0 }, horizon: { size: 640, res: 32 }, pixelBudget: 0.6e6, viewDistance: 280,
  },
  // Upper mid phones (Adreno 7xx, recent iPhones), Iris Xe / Radeon iGPU.
  medium: {
    name: 'medium', renderRadius: 3, lodRings: [1.0, 1.9], maxDpr: 1.25,
    renderScale: { min: 0.6, max: 1, start: 0.85 }, aa: 'fxaa', sharpen: 0.25,
    godRays: { divisor: 4, samples: 20, volumeSteps: 14 }, paint: { stride: 1.4, bloom: 0.4 }, grass: { radius: 15.5, density: 20, blades: 2 }, trees: { near: 0 },
    sunShadowSize: 1024, sunShadowEvery: 2, sunShadowExtent: 40, flashlightShadow: false,
    plants: true, buildPerFrame: 2, monsters: { stalkers: 2, striders: 1 }, horizon: { size: 1000, res: 44 }, pixelBudget: 1.4e6, viewDistance: 440,
  },
  // Discrete GPUs, Apple M-series.
  high: {
    name: 'high', renderRadius: 4, lodRings: [1.5, 3.5], maxDpr: 1.5,
    renderScale: { min: 0.7, max: 1, start: 1 }, aa: 'msaa4', sharpen: 0.15,
    godRays: { divisor: 4, samples: 24, volumeSteps: 16 }, paint: { stride: 1.8, bloom: 0.45 }, grass: { radius: 28, density: 34, blades: 2 }, trees: { near: 0 },
    sunShadowSize: 2048, sunShadowEvery: 1, sunShadowExtent: 50, flashlightShadow: true,
    plants: true, buildPerFrame: 2, monsters: { stalkers: 3, striders: 2 }, horizon: { size: 2200, res: 80 }, pixelBudget: 2.4e6, viewDistance: 1000,
  },
}

/**
 * Distance where fog must be complete: the nearest edge of the loaded ring (player standing on its chunk
 * border: radius × CHUNK_SIZE). Fog is clear near the player and only closes in toward this distance, so a
 * smaller ring on low tiers hides its edge without hazing what's close. See skills/fog.
 */
export function fogLimit(renderRadius: number): number {
  return renderRadius * CHUNK_SIZE - 4
}

/** Camera far plane: just past the loaded ring. */
export function cameraFar(horizonSize: number): number {
  return horizonSize * 0.55
}

export function tierBelow(t: TierName): TierName | null {
  const i = TIERS.indexOf(t)
  return i > 0 ? TIERS[i - 1] : null
}

export function tierAbove(t: TierName): TierName | null {
  const i = TIERS.indexOf(t)
  return i < TIERS.length - 1 ? TIERS[i + 1] : null
}
