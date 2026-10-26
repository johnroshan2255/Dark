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
  /** Camera far plane (m): just past fogEnd — nothing beyond the fog is drawn. */
  far: number
  /** THE FOG (Atmosphere.ts): clear air to fogNear (m), a solid white fog by fogEnd — the far land hidden, not drawn. */
  fogNear: number
  fogEnd: number
  /** Bloom mip levels (0: no post pass — the scene draws straight to the screen, MSAA on the canvas). */
  bloom: number
  /** The rocks' crumpled 3D surface relief from noise (rockRelief.ts): HIGH / ULTRA, and only on PCs / laptops (pickTier). */
  rockRelief: boolean
}

export const TIERS: Record<TierName, Tier> = {
  low: { name: 'low', dpr: 1, msaa: false, terrainGrid: 16, terrainLeaf: 32, terrainNear: 70, grassRadius: 38, grassDensity: 9, grassFan: 6, rockReach: 600, rockNear: 45, treeNear: 35, treeMid: 85, treeFar: 300, treeReach: 600, bushNear: 30, bushReach: 140, grassSegments: 1, spec: false, far: 640, fogNear: 100, fogEnd: 560, bloom: 0, rockRelief: false },
  medium: { name: 'medium', dpr: 1.25, msaa: true, terrainGrid: 24, terrainLeaf: 48, terrainNear: 110, grassRadius: 50, grassDensity: 14, grassFan: 8, rockReach: 720, rockNear: 60, treeNear: 45, treeMid: 100, treeFar: 360, treeReach: 720, bushNear: 40, bushReach: 190, grassSegments: 1, spec: true, far: 760, fogNear: 110, fogEnd: 680, bloom: 4, rockRelief: false },
  high: { name: 'high', dpr: 1.5, msaa: true, terrainGrid: 32, terrainLeaf: 64, terrainNear: 140, grassRadius: 62, grassDensity: 22, grassFan: 11, rockReach: 820, rockNear: 75, treeNear: 50, treeMid: 120, treeFar: 420, treeReach: 820, bushNear: 50, bushReach: 230, grassSegments: 1, spec: true, far: 860, fogNear: 120, fogEnd: 780, bloom: 5, rockRelief: true },
  ultra: { name: 'ultra', dpr: 2, msaa: true, terrainGrid: 32, terrainLeaf: 64, terrainNear: 180, grassRadius: 72, grassDensity: 26, grassFan: 11, rockReach: 900, rockNear: 90, treeNear: 60, treeMid: 140, treeFar: 450, treeReach: 900, bushNear: 60, bushReach: 260, grassSegments: 2, spec: true, far: 940, fogNear: 130, fogEnd: 850, bloom: 6, rockRelief: true },
}

/** `?tier=`, else ULTRA on every device (2026-10-26: the user plays it in ULTRA; `?tier=low` etc. to compare). The
 *  rock relief stays off on phones and tablets (the user: "in laptops and high-end devices") — `?relief=1` forces it on,
 *  `?relief=0` off. */
export function pickTier(): Tier {
  const p = new URLSearchParams(location.search)
  const q = p.get('tier') as TierName | null
  const t = q && TIERS[q] ? TIERS[q] : TIERS.ultra
  const relief = p.get('relief')
  return { ...t, rockRelief: relief === '1' || (relief !== '0' && t.rockRelief && !isMobileDevice()) }
}
