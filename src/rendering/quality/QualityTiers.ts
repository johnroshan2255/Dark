import { CHUNK_SIZE } from '../../world/constants'
import type { AAMode } from '../postprocessing/PostPipeline'

/**
 * Quality PRESETS (LOW · MEDIUM · HIGH · ULTRA), like a PC game's graphics menu. Every system reads its budget
 * from the resolved `QualitySettings` (game.quality) — never from hard-coded constants.
 *
 * A preset = base budgets (resolution, AA, DPR, particles…) + a LEVEL for each graphics FEATURE (shadows,
 * reflections, ambient occlusion, volumetrics, view distance, vegetation). The player can override any feature
 * in Settings → Graphics ('auto' = the preset's level); `resolveQuality` merges the two.
 * Goal on EVERY preset the device auto-selects: ≥ 60 fps minimum, uncapped above. Auto detection and adaptive
 * quality stop at HIGH — ULTRA (and any feature set above its preset) is the player's explicit choice.
 * See skills/mobile and skills/webgl §budgets; costs per feature level in skills/art-direction §5.
 */
export type TierName = 'low' | 'medium' | 'high' | 'ultra'
export const TIERS: readonly TierName[] = ['low', 'medium', 'high', 'ultra']
/** Highest tier auto detection / adaptive quality may pick. */
export const AUTO_MAX_TIER: TierName = 'high'

export type Level = 'off' | 'low' | 'medium' | 'high' | 'ultra'
export const FEATURES = ['shadows', 'reflections', 'ao', 'volumetrics', 'grass', 'effects', 'vegetation', 'view'] as const
export type Feature = (typeof FEATURES)[number]
export type FeatureLevels = Record<Feature, Level>
/** Levels each feature offers in the menu (view distance and vegetation can't be switched off). */
export const FEATURE_LEVELS: Record<Feature, readonly Level[]> = {
  shadows: ['off', 'low', 'medium', 'high', 'ultra'],
  reflections: ['off', 'low', 'medium', 'high', 'ultra'],
  ao: ['off', 'low', 'medium', 'high', 'ultra'],
  volumetrics: ['off', 'low', 'medium', 'high', 'ultra'],
  grass: ['off', 'low', 'medium', 'high', 'ultra'],
  effects: ['off', 'low', 'medium', 'high'],
  vegetation: ['low', 'medium', 'high'],
  view: ['low', 'medium', 'high', 'ultra'],
}
export const FEATURE_LABELS: Record<Feature, string> = {
  shadows: 'Shadows',
  reflections: 'Reflections',
  ao: 'Ambient occlusion',
  volumetrics: 'Volumetric light & fog',
  grass: 'Grass',
  effects: 'Ground & weather detail',
  vegetation: 'Trees & bushes',
  view: 'View distance',
}

export interface QualitySettings {
  name: TierName
  /** The feature levels this was resolved with (preset + player overrides). */
  features: FeatureLevels
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
  /** Volumetric fog: the analytic height mist is on every tier (~10 ALU/fragment); `banks` adds the drifting
   *  noise-density fog banks marched in the low-res shafts pass (+~0.1–0.3 ms GPU). */
  fog: { banks: boolean }
  /** Grass field around the player: fade radius (m), individual blades per m², blade segments (1 or 2). One draw call. */
  grass: { radius: number; density: number; blades: number }
  /** Trees: geometry level for near (LOD0) chunks (0 full ≈170–250 tris, 1 mid ≈50–100). */
  trees: { near: number }
  /** Sun/moon shadow map on/off (off = no shadow pass at all; characters keep their blob shadow). */
  shadows: boolean
  /** Vehicles, monsters and the character cast real shadows (else blob shadows). */
  objectShadows: boolean
  sunShadowSize: number
  /** Re-render the sun shadow map every N frames (world casters are static). */
  sunShadowEvery: number
  /** Half-width of the sun shadow frustum (m). */
  sunShadowExtent: number
  /** Flashlight shadow map. Toggling recompiles lit programs — tier changes only. */
  flashlightShadow: boolean
  /** Small plants on LOD0 chunks. */
  plants: boolean
  /** Trees & bushes detail: rocks on mid-distance chunks; `lean` = LOW's cuts (no dead snags, fewer shadow casters). */
  vegDetail: { farRocks: boolean; lean: boolean }
  /** Chunk meshes built per frame. */
  buildPerFrame: number
  /** Max view distance (m): fog is complete here and NOTHING beyond it is drawn (chunks culled, horizon
   *  terrain sized to it). The cheapest way to keep hill-top views fast on phones. */
  viewDistance: number
  /** Max rendered pixels of the 3D scene (before the final upscale). */
  pixelBudget: number
  /** Horizon terrain beyond the streamed chunks: side length (m) and grid resolution. */
  horizon: { size: number; res: number }
  /** Landmarks (world/Landmarks) are drawn out to this distance (m): full detail near, the far LOD beyond 350 m. */
  landmarkRange: number
  /** Monster count at night (the nightmare realm adds more). */
  monsters: { stalkers: number; striders: number }
  /** Particle caps: vehicle exhaust + tyre smoke/dust sprites alive at once (one draw; ~0.03 ms CPU at 320); rain = share of the 1600-drop pool. */
  particles: { vehicle: number; rain: number }
  /** Planar water reflections (trees/mountains/sky in lakes and on ice): render-target scale per axis, 0 = off
   *  (the water then mirrors the sky colour only). Rendered only on frames where water is visible. */
  reflections: number
  /** Sky shader resolution × the scene target (SkyDome.prepare): the sky is smooth, so it is drawn small and
   *  stretched — 1 = full resolution. */
  skyScale: number
  /** Re-render the reflection every N frames (the texture is reused in between). */
  reflectionEvery: number
  /** Screen-space ambient occlusion (soft contact shadows): RT scale (0 = off), samples, world radius (m). */
  ao: { scale: number; samples: number; radius: number }
  /**
   * Ground & weather detail: `surface` = snow/sand micro-relief, glints and track imprints in the terrain shader;
   * `trails` = the footprint / tyre-track map (an extra render target); `drift` = share of the blowing sand / snow
   * powder particles (transparent overdraw); `heat` = heat shimmer (a depth read per pixel); `bloom` × the preset's.
   */
  fx: { surface: boolean; trails: boolean; drift: number; heat: boolean; bloom: number }
}

type FeatureFields = {
  shadows: Pick<QualitySettings, 'shadows' | 'objectShadows' | 'sunShadowSize' | 'sunShadowEvery' | 'sunShadowExtent' | 'flashlightShadow'>
  reflections: Pick<QualitySettings, 'reflections' | 'reflectionEvery'>
  ao: Pick<QualitySettings, 'ao'>
  volumetrics: Pick<QualitySettings, 'godRays' | 'fog'>
  view: Pick<QualitySettings, 'renderRadius' | 'lodRings' | 'viewDistance' | 'horizon' | 'landmarkRange'>
  grass: Pick<QualitySettings, 'grass'>
  effects: Pick<QualitySettings, 'fx'>
  vegetation: Pick<QualitySettings, 'plants' | 'trees' | 'vegDetail'>
}

/**
 * What each feature level sets. LOW/MEDIUM/HIGH levels are exactly the old LOW/MEDIUM/HIGH tier values, so those
 * presets render as before; ULTRA levels are new. Measured costs: skills/art-direction §5, skills/mobile.
 */
export const FEATURE_TABLE: { [F in Feature]: Partial<Record<Level, FeatureFields[F]>> } = {
  shadows: {
    off: { shadows: false, objectShadows: false, sunShadowSize: 512, sunShadowEvery: 4, sunShadowExtent: 34, flashlightShadow: false },
    low: { shadows: true, objectShadows: false, sunShadowSize: 1024, sunShadowEvery: 3, sunShadowExtent: 34, flashlightShadow: false },
    medium: { shadows: true, objectShadows: true, sunShadowSize: 1024, sunShadowEvery: 2, sunShadowExtent: 40, flashlightShadow: false },
    high: { shadows: true, objectShadows: true, sunShadowSize: 2048, sunShadowEvery: 1, sunShadowExtent: 50, flashlightShadow: true },
    // 4096² over a 140 m box: sharper AND farther (≈ 29 texels/m vs 20 on HIGH). +48 MB shadow memory.
    ultra: { shadows: true, objectShadows: true, sunShadowSize: 4096, sunShadowEvery: 1, sunShadowExtent: 70, flashlightShadow: true },
  },
  reflections: {
    off: { reflections: 0, reflectionEvery: 1 },
    low: { reflections: 0.25, reflectionEvery: 2 },
    medium: { reflections: 0.35, reflectionEvery: 1 },
    high: { reflections: 0.5, reflectionEvery: 1 },
    ultra: { reflections: 0.75, reflectionEvery: 1 },
  },
  ao: {
    off: { ao: { scale: 0, samples: 0, radius: 0 } },
    low: { ao: { scale: 0.5, samples: 6, radius: 0.8 } },
    medium: { ao: { scale: 0.5, samples: 10, radius: 1.0 } },
    high: { ao: { scale: 0.5, samples: 14, radius: 1.2 } },
    ultra: { ao: { scale: 0.75, samples: 14, radius: 1.4 } }, // full res cost 3.1 ms @1080p (M4) for little gain
  },
  volumetrics: {
    off: { godRays: { divisor: 6, samples: 0, volumeSteps: 0 }, fog: { banks: false } },
    low: { godRays: { divisor: 6, samples: 12, volumeSteps: 8 }, fog: { banks: false } },
    medium: { godRays: { divisor: 4, samples: 20, volumeSteps: 14 }, fog: { banks: true } },
    high: { godRays: { divisor: 4, samples: 24, volumeSteps: 16 }, fog: { banks: true } },
    ultra: { godRays: { divisor: 3, samples: 32, volumeSteps: 24 }, fog: { banks: true } },
  },
  view: {
    low: { renderRadius: 2, lodRings: [0.8, 1.4], viewDistance: 230, horizon: { size: 2400, res: 40 }, landmarkRange: 700 },
    medium: { renderRadius: 3, lodRings: [0.9, 1.8], viewDistance: 330, horizon: { size: 3200, res: 52 }, landmarkRange: 1000 },
    high: { renderRadius: 3, lodRings: [1.2, 2.3], viewDistance: 420, horizon: { size: 4400, res: 72 }, landmarkRange: 1500 },
    ultra: { renderRadius: 4, lodRings: [1.5, 2.8], viewDistance: 540, horizon: { size: 5600, res: 96 }, landmarkRange: 2200 },
  },
  // Grass field around the player (GrassField: near + far layers). OFF = the painted meadow on the terrain only.
  grass: {
    off: { grass: { radius: 0, density: 0, blades: 1 } },
    low: { grass: { radius: 12, density: 18, blades: 1 } },
    medium: { grass: { radius: 15.5, density: 20, blades: 2 } },
    high: { grass: { radius: 22, density: 34, blades: 2 } },
    ultra: { grass: { radius: 30, density: 42, blades: 2 } },
  },
  // Ground & weather detail. LOW / OFF also drop bloom (3 small passes; skills/mobile: one post pass on LOW).
  effects: {
    off: { fx: { surface: false, trails: false, drift: 0, heat: false, bloom: 0 } },
    low: { fx: { surface: false, trails: false, drift: 0, heat: false, bloom: 0 } }, // LOW: one post pass (skills/mobile)
    medium: { fx: { surface: true, trails: true, drift: 0.5, heat: false, bloom: 1 } },
    high: { fx: { surface: true, trails: true, drift: 1, heat: true, bloom: 1 } },
  },
  // Trees, bushes, undergrowth and rocks.
  vegetation: {
    low: { plants: false, trees: { near: 1 }, vegDetail: { farRocks: false, lean: true } },
    medium: { plants: true, trees: { near: 0 }, vegDetail: { farRocks: false, lean: false } },
    high: { plants: true, trees: { near: 0 }, vegDetail: { farRocks: true, lean: false } },
  },
}

type FeatureKeys = { [F in Feature]: keyof FeatureFields[F] }[Feature]
type Base = Omit<QualitySettings, FeatureKeys | 'features' | 'name'>
interface Preset {
  base: Base
  features: FeatureLevels
}

/*
 * DETAIL-BOUNDED RENDERING (all art styles): streamed detail (trees, rocks, props) dithers out at the ring edge
 * (≤ `viewDistance`) and chunks past it are culled (ChunkVisibility.maxDistance). Beyond, ONE warped horizon-
 * terrain mesh (`horizon.size`, 3–10k tris) carries real hills to the skyline under a partial blue-green haze
 * (TimeOfDay fogMax/landHaze) — no white fog wall. LOD rings are tight so full-detail trees stay near the player. Measured (M4, 2560×1440, seed 7, 5 spots) before → after:
 *   HIGH draws 225–281 → 176–188, tris 815–1087k → 540–817k, GPU −0.1…1.1 ms, CPU −0.2…0.4 ms
 *   LOW  draws ≤ 68 (unchanged), tris −1…24 %, GPU −0.1…0.5 ms            (details: skills/mobile)
 */
// AA: FXAA + sharpen on EVERY tier by default. MSAA 4× made every depth reader (SSAO, volumetric light, grading)
// pay a multisampled depth RESOLVE — measured HIGH vista 1080p 14.4 → 8.0 ms GPU (AO alone 4.6 → 0.9 ms);
// tile-based phone GPUs pay it worse. MSAA stays selectable in Settings.
export const PRESETS: Record<TierName, Preset> = {
  // ~₹15k phones (Mali-G57 / Adreno 610, Snapdragon 6xx), Intel UHD laptops: no reflections, no AO.
  // (Tried 2026-10-06: canvas at 0.75 DPR + scene at 100 % → the grading pass shades ~45 % fewer pixels, but the
  // browser's upscale made edges visibly blocky on a phone. Kept DPR 1 + scene 75 %: our pass upscales smoothly.)
  low: {
    base: {
      maxDpr: 1, renderScale: { min: 0.5, max: 0.85, start: 0.75 }, aa: 'fxaa', sharpen: 0.35, paint: { stride: 0, bloom: 0.45 },
      buildPerFrame: 1, monsters: { stalkers: 1, striders: 0 }, particles: { vehicle: 110, rain: 0.35 }, pixelBudget: 0.6e6, skyScale: 0.25,
    },
    features: { shadows: 'low', reflections: 'off', ao: 'off', volumetrics: 'low', grass: 'low', effects: 'low', vegetation: 'low', view: 'low' },
  },
  // Upper mid phones (Adreno 7xx, recent iPhones), Iris Xe / Radeon iGPU: cheap reflections (¼ res, every 2nd frame).
  medium: {
    base: {
      maxDpr: 1.25, renderScale: { min: 0.6, max: 1, start: 0.85 }, aa: 'fxaa', sharpen: 0.25, paint: { stride: 1.4, bloom: 0.4 },
      buildPerFrame: 2, monsters: { stalkers: 2, striders: 1 }, particles: { vehicle: 220, rain: 0.7 }, pixelBudget: 1.4e6, skyScale: 0.33,
    },
    features: { shadows: 'medium', reflections: 'off', ao: 'off', volumetrics: 'medium', grass: 'medium', effects: 'medium', vegetation: 'medium', view: 'medium' },
  },
  // Discrete GPUs, Apple M-series.
  high: {
    base: {
      maxDpr: 1.5, renderScale: { min: 0.7, max: 1, start: 1 }, aa: 'fxaa', sharpen: 0.25, paint: { stride: 1.8, bloom: 0.45 },
      buildPerFrame: 2, monsters: { stalkers: 3, striders: 2 }, particles: { vehicle: 320, rain: 1 }, pixelBudget: 2.4e6, skyScale: 0.5,
    },
    features: { shadows: 'high', reflections: 'high', ao: 'medium', volumetrics: 'high', grass: 'high', effects: 'high', vegetation: 'high', view: 'high' },
  },
  // Strong desktop GPUs (player's choice only): everything at its best, native-ish resolution.
  ultra: {
    base: {
      maxDpr: 2, renderScale: { min: 0.8, max: 1, start: 1 }, aa: 'fxaa', sharpen: 0.22, paint: { stride: 1.8, bloom: 0.45 },
      buildPerFrame: 3, monsters: { stalkers: 3, striders: 2 }, particles: { vehicle: 420, rain: 1 }, pixelBudget: 4.2e6, skyScale: 1,
    },
    features: { shadows: 'ultra', reflections: 'ultra', ao: 'ultra', volumetrics: 'ultra', grass: 'ultra', effects: 'high', vegetation: 'high', view: 'ultra' },
  },
}

/** A preset with the player's per-feature overrides ('auto' or missing = the preset's level). */
export function resolveQuality(name: TierName, overrides: Partial<Record<Feature, Level | 'auto'>> = {}): QualitySettings {
  const p = PRESETS[name]
  const features = { ...p.features }
  for (const f of FEATURES) {
    const o = overrides[f]
    if (o && o !== 'auto' && FEATURE_LEVELS[f].includes(o)) features[f] = o
  }
  const q = { name, features, ...structuredClone(p.base) } as QualitySettings
  for (const f of FEATURES) Object.assign(q, structuredClone(FEATURE_TABLE[f][features[f]]))
  return q
}

/**
 * HOLD 60 FPS on an explicitly chosen preset: when render scale alone can't keep 60, features step down ONE level
 * at a time in order of cost (measured: reflections re-render the scene, AO is a full-res pass on ULTRA, the shadow
 * map is a second scene render…), never below these floors; they come back in reverse order with headroom.
 * The player's preset / overrides stay the ceiling — reductions are runtime only, never saved.
 */
export const HOLD_ORDER: readonly Feature[] = ['reflections', 'ao', 'effects', 'shadows', 'volumetrics', 'grass', 'vegetation', 'view']
/**
 * Floors. Above LOW they leave the look intact; at the very bottom (auto mode already on LOW at minimum render
 * scale — a small / old phone) the same steps continue down to these: no volumetrics, no grass, no effects or
 * bloom, no sun shadows, the shortest view — the game stays playable at 60 rather than looking right at 20.
 */
export const HOLD_FLOOR: Record<Feature, Level> = { reflections: 'off', ao: 'off', effects: 'off', shadows: 'off', volumetrics: 'off', grass: 'off', vegetation: 'low', view: 'low' }
/** How many of HOLD_ORDER (from the start) are lowered EVENLY (the GPU effects + grass); the rest one by one after. */
const HOLD_EVEN = 6

/** Feature levels after applying `steps` (each entry = that feature one level lower), clamped at HOLD_FLOOR. */
export function heldLevels(base: FeatureLevels, steps: readonly Feature[]): FeatureLevels {
  const out = { ...base }
  for (const f of steps) {
    const levels = FEATURE_LEVELS[f]
    const i = levels.indexOf(out[f]), floor = levels.indexOf(HOLD_FLOOR[f])
    if (i > floor) out[f] = levels[i - 1]
  }
  return out
}

/**
 * The next feature to lower, or null at the floor of everything. The GPU effects + grass (reflections, AO, shadows,
 * volumetrics, grass) step down EVENLY — always the one currently at the highest level, ties in HOLD_ORDER — so ULTRA
 * becomes "high everything" before any effect is lost; trees & bushes and view distance only after those.
 */
export function nextHoldStep(base: FeatureLevels, steps: readonly Feature[]): Feature | null {
  const cur = heldLevels(base, steps)
  const above = (f: Feature) => FEATURE_LEVELS[f].indexOf(cur[f]) > FEATURE_LEVELS[f].indexOf(HOLD_FLOOR[f])
  const rank = (f: Feature) => ['off', 'low', 'medium', 'high', 'ultra'].indexOf(cur[f])
  // Sun shadows stay at least 'low' through the even phase; switching them OFF is the very last step
  // (skills/mobile order of sacrifice: shadow casters go last — they carry the shapes of the world).
  const aboveEven = (f: Feature) => (f === 'shadows' ? rank(f) > 1 : above(f))
  let best: Feature | null = null
  for (const f of HOLD_ORDER.slice(0, HOLD_EVEN)) if (aboveEven(f) && (!best || rank(f) > rank(best))) best = f
  if (best) return best
  for (const f of HOLD_ORDER.slice(HOLD_EVEN)) if (above(f)) return f
  return above('shadows') ? 'shadows' : null
}

/** Each preset with its own feature levels (no overrides). */
export const QUALITY: Record<TierName, QualitySettings> = {
  low: resolveQuality('low'),
  medium: resolveQuality('medium'),
  high: resolveQuality('high'),
  ultra: resolveQuality('ultra'),
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
