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
  /** Rocks are drawn within this distance (m). */
  rockReach: number
  /** Blade segments in the nearest ring (1: one straight triangle, 2: quad + tip, curved). The rings beyond use 1. */
  grassSegments: number
  /** Specular + sheen on the ground (an ALU budget, not a look switch: LOW keeps a cheaper sheen). */
  spec: boolean
  /** Camera far plane (m): the fog has swallowed the land long before (≥ 99 % at 4.5 km) — nothing beyond is drawn. */
  far: number
  /** Bloom mip levels (0: no post pass — the scene draws straight to the screen, MSAA on the canvas). */
  bloom: number
}

export const TIERS: Record<TierName, Tier> = {
  low: { name: 'low', dpr: 1, msaa: false, terrainGrid: 16, terrainLeaf: 32, terrainNear: 80, grassRadius: 38, grassDensity: 9, grassFan: 6, rockReach: 900, treeNear: 40, treeMid: 110, treeFar: 650, treeReach: 1500, bushNear: 35, bushReach: 160, grassSegments: 1, spec: false, far: 4500, bloom: 0 },
  medium: { name: 'medium', dpr: 1.25, msaa: true, terrainGrid: 24, terrainLeaf: 48, terrainNear: 130, grassRadius: 50, grassDensity: 14, grassFan: 8, rockReach: 1300, treeNear: 55, treeMid: 140, treeFar: 850, treeReach: 1800, bushNear: 45, bushReach: 220, grassSegments: 1, spec: true, far: 5000, bloom: 4 },
  high: { name: 'high', dpr: 1.5, msaa: true, terrainGrid: 32, terrainLeaf: 64, terrainNear: 170, grassRadius: 62, grassDensity: 22, grassFan: 11, rockReach: 1600, treeNear: 65, treeMid: 170, treeFar: 1000, treeReach: 2100, bushNear: 60, bushReach: 280, grassSegments: 1, spec: true, far: 5500, bloom: 5 },
  ultra: { name: 'ultra', dpr: 2, msaa: true, terrainGrid: 32, terrainLeaf: 64, terrainNear: 300, grassRadius: 72, grassDensity: 26, grassFan: 11, rockReach: 1900, treeNear: 80, treeMid: 200, treeFar: 1200, treeReach: 2400, bushNear: 80, bushReach: 340, grassSegments: 2, spec: true, far: 6000, bloom: 6 },
}

/** `?tier=`, else ULTRA on every device (2026-10-26: the user plays it in ULTRA; `?tier=low` etc. to compare). */
export function pickTier(): Tier {
  const q = new URLSearchParams(location.search).get('tier') as TierName | null
  if (q && TIERS[q]) return TIERS[q]
  return TIERS.ultra
}
