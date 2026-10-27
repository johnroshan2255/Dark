import { isMobileDevice } from '../rendering/quality/DeviceProfile'

/**
 * QUALITY TIERS for the Over-the-Hill world. Every budget lives here; systems read `tier.*` and never hard-code one.
 * LOW is the ~₹15k phone (Adreno 610 / Mali-G57) and the Intel-UHD laptop; ULTRA a desktop GPU. The look is the same
 * on every tier — LOW gets the same grass coverage (wider, fewer blades), the same terrain colours and light, and
 * loses only resolution, reach and the finest vertex detail.
 */
export type TierName = 'low' | 'medium' | 'high' | 'ultra'

export interface Tier {
  name: TierName
  /** Canvas pixel ratio cap. */
  dpr: number
  /** MSAA on the canvas (the default framebuffer). */
  msaa: boolean
  /** Terrain: quads per patch edge, the finest patch size (m) and the distance (m) the finest level reaches. */
  terrainGrid: number
  terrainLeaf: number
  terrainNear: number
  /** Grass: how far it reaches (m) and the TUFT budget per m² nearest the camera (the field thins with distance and
   *  widens its blades to keep the same coverage; lower tiers widen against HIGH's). */
  grassRadius: number
  grassDensity: number
  /** Blades per tuft in the nearest ring (fewer on the lower tiers: each wider, the coverage the same). */
  grassFan: number
  /** Trees: skirts + plumes to treeNear, skirts to treeMid, impostors to treeReach (thinned beyond treeFar) (m). */
  treeNear: number
  treeMid: number
  treeFar: number
  treeReach: number
  /** Bushes: the lumpy clump to bushNear, one blob to bushReach (m); the ground's painted dots beyond. */
  bushNear: number
  bushReach: number
  /** Rocks are drawn within this distance (m); the rounded boulders full (1 280 triangles) to rockNear, 80 beyond. */
  rockReach: number
  rockNear: number
  /** Blade segments in the nearest ring (1: one straight triangle, 2: quad + tip, curved). The rings beyond use 1. */
  grassSegments: number
  /** Specular + sheen on the ground (an ALU budget, not a look switch: LOW keeps a cheaper sheen). */
  spec: boolean
  /** Camera far plane (m): the far ranges stand as layered blue silhouettes in the haze (the world is 16 km). */
  far: number
  /** THE HAZE (Atmosphere.ts): clear air to fogNear (m), then aerial perspective over `haze` m (never solid). */
  fogNear: number
  haze: number
  /** Rain streaks drawn round the camera (Rain.ts) when it rains. */
  rain: number
  /** Bloom mip levels (0: no post pass — the scene draws straight to the screen, MSAA on the canvas). */
  bloom: number
  /** The post pass's MSAA samples on its HDR target (0: none — the leaf cards alpha-test instead of alpha-to-coverage). */
  samples: number
  /** The bloom's first level: 1 = half the screen, 2 = a quarter (the mip chain starts there: one big pass fewer). */
  bloomStart: number
  /** The god rays' target: 1 / rayDiv of the screen each way. */
  rayDiv: number
  /** The rocks' crumpled 3D surface relief from noise (rockRelief.ts): HIGH / ULTRA, and only on PCs / laptops (pickTier). */
  rockRelief: boolean
}

export const TIERS: Record<TierName, Tier> = {
  low: { name: 'low', dpr: 1, msaa: false, terrainGrid: 16, terrainLeaf: 32, terrainNear: 70, grassRadius: 38, grassDensity: 9, grassFan: 6, rockReach: 600, rockNear: 45, treeNear: 35, treeMid: 85, treeFar: 300, treeReach: 600, bushNear: 30, bushReach: 140, grassSegments: 1, spec: false, far: 4500, fogNear: 100, haze: 2600, rain: 1600, bloom: 0, samples: 0, bloomStart: 1, rayDiv: 4, rockRelief: false },
  medium: { name: 'medium', dpr: 1.25, msaa: true, terrainGrid: 24, terrainLeaf: 48, terrainNear: 110, grassRadius: 50, grassDensity: 14, grassFan: 8, rockReach: 720, rockNear: 60, treeNear: 45, treeMid: 100, treeFar: 360, treeReach: 720, bushNear: 40, bushReach: 190, grassSegments: 1, spec: true, far: 6000, fogNear: 110, haze: 2900, rain: 2400, bloom: 4, samples: 4, bloomStart: 1, rayDiv: 4, rockRelief: false },
  high: { name: 'high', dpr: 1.5, msaa: true, terrainGrid: 32, terrainLeaf: 64, terrainNear: 140, grassRadius: 62, grassDensity: 22, grassFan: 11, rockReach: 820, rockNear: 75, treeNear: 50, treeMid: 120, treeFar: 420, treeReach: 820, bushNear: 50, bushReach: 230, grassSegments: 1, spec: true, far: 7500, fogNear: 120, haze: 3100, rain: 3200, bloom: 5, samples: 4, bloomStart: 1, rayDiv: 4, rockRelief: true },
  ultra: { name: 'ultra', dpr: 2, msaa: true, terrainGrid: 32, terrainLeaf: 64, terrainNear: 180, grassRadius: 72, grassDensity: 26, grassFan: 9, rockReach: 900, rockNear: 90, treeNear: 60, treeMid: 140, treeFar: 450, treeReach: 900, bushNear: 60, bushReach: 260, grassSegments: 2, spec: true, far: 9000, fogNear: 130, haze: 3300, rain: 4000, bloom: 6, samples: 4, bloomStart: 1, rayDiv: 4, rockRelief: true },
}

/** `?tier=`, else ULTRA on every device (2026-10-26: the user plays it in ULTRA; `?tier=low` etc. to compare). The
 *  rock relief stays off on phones and tablets (the user: "in laptops and high-end devices") — `?relief=1` forces it on,
 *  `?relief=0` off. */
export function pickTier(): Tier {
  const p = new URLSearchParams(location.search)
  const q = p.get('tier') as TierName | null
  const t = q && TIERS[q] ? TIERS[q] : TIERS.ultra
  const relief = p.get('relief'), mobile = p.get('mobile') === '1' || (p.get('mobile') !== '0' && isMobileDevice())
  const out = { ...t, rockRelief: relief === '1' || (relief !== '0' && t.rockRelief && !mobile) }
  // NO POST PASS by default on every tier (2026-10-27, the user: "remove the post-processing, even on the laptop —
  // ~400 fps there so a small phone holds 60+"): the scene straight to the canvas with its own MSAA, the bloom and the
  // god rays painted forward (Glow.ts) — measured ULTRA 1280 × 720: 3.30 → 2.42 ms (303 → 414 fps). `?post=1`: the
  // old pass (with the phone profile above), to compare.
  if (p.get('post') !== '1') Object.assign(out, { bloom: 0 })
  if (p.get('aa') === '0') Object.assign(out, { msaa: false }) // (cost tests: no MSAA)
  // (with ?post=1) PHONES at full resolution (2026-10-27, the user: "full resolution at ULTRA on Snapdragon 600+"): measured on the
  // phone viewport (ULTRA, 824 × 1830) the post pass was most of the frame — MSAA 4× on the HDR target 3.3 ms, the
  // half-size bloom levels and their passes ~2 ms, the god rays 1 ms — the scene itself ~2. At 2× pixel density a
  // stair-step is under half a CSS pixel: no MSAA (the leaf cards alpha-test), the bloom from a quarter of the screen,
  // the god rays at an eighth — the same look, the frame ~2.5× cheaper. `?mobile=1` / `0` forces it either way.
  if (mobile && out.bloom) Object.assign(out, { msaa: false, samples: 0, bloomStart: 2, bloom: Math.min(out.bloom, 5), rayDiv: 8 })
  return out
}
