import { Biome, BIOME_COUNT, type RegionWeights } from '../Biomes'
import { hashFloat } from '../noise/rng'
import { TreeSpecies } from '../types'

/**
 * REGION DEFINITIONS — what makes each region a PLACE, in one table (world/Biomes.ts decides WHERE a region is).
 * Every system that varies by region reads these through the region weights at a point:
 *   CONTINUOUS values (ground colour, density, grass, air tint, particles) are BLENDED by the weights → gradual
 *     borders (green → yellow-green → autumn → dry → sand);
 *   DISCRETE choices (tree species, undergrowth kind, landmark kind) PICK a region by a seeded hash in proportion
 *     to the weights, then an entry from that region's weighted list → a mixed border where the share of maples
 *     rises from 0 to 100 % over the blend band.
 * Deterministic: picks hash (seed, position or cell, salt); no Math.random.
 * Region species REPLACE the forest's in their region (draw count per chunk stays flat; skills/instancing).
 */

/** Undergrowth meshes (WorldChunk plant slots). */
export const Plant = { Fern: 0, Bush: 1, Agave: 2, Shrub: 3, LeafPile: 4, GlowShroom: 5 } as const

/** A colour multiplier (linear RGB) applied to a plant's leaf colour per instance. */
export type Hue = readonly [number, number, number]

export interface BiomeDef {
  name: string
  /** Trees: weighted species list (used by scatter.pickSpecies; forest / desert / snow keep their hand-tuned
   *  stand logic there and list their mix here for reference). */
  trees: readonly (readonly [number, number])[]
  /** × the grove density (forest belts): < 1 opens the land (autumn valleys), > 1 thickens it (mystic woods). */
  treeDensity: number
  /** Undergrowth: weighted plant kinds and density × the base. */
  plants: readonly (readonly [number, number])[]
  plantDensity: number
  /** Grass field density × (meadow), and how much grass grows at all (0 = bare). */
  grass: number
  /** Leaf hue palette for SHARED species growing in this region (birch / pine / dead in autumn turn gold-red). */
  sharedHues: readonly Hue[] | null
  /** Ambient particles under the player: falling leaves / floating spores (share of the pool at full weight). */
  leaves: number
  spores: number
}

const AUTUMN_HUES: Hue[] = [[1.75, 1.2, 0.45], [2.2, 1.05, 0.4], [2.5, 0.8, 0.4], [1.6, 1.45, 0.55], [1.2, 0.85, 0.55]]

export const BIOMES: BiomeDef[] = []
BIOMES[Biome.Forest] = {
  name: 'Forest',
  trees: [[TreeSpecies.Birch, 0.4], [TreeSpecies.Spruce, 0.25], [TreeSpecies.Pine, 0.2], [TreeSpecies.Fir, 0.15]],
  treeDensity: 1,
  plants: [[Plant.Fern, 0.75], [Plant.Bush, 0.25]],
  plantDensity: 1,
  grass: 1,
  sharedHues: null,
  leaves: 0,
  spores: 0,
}
BIOMES[Biome.Desert] = {
  name: 'Desert',
  trees: [[TreeSpecies.Cactus, 0.55], [TreeSpecies.Joshua, 0.33], [TreeSpecies.Dead, 0.12]],
  treeDensity: 1,
  plants: [[Plant.Agave, 0.75], [Plant.Shrub, 0.25]],
  plantDensity: 1,
  grass: 0.04,
  sharedHues: null,
  leaves: 0,
  spores: 0,
}
BIOMES[Biome.Snow] = {
  name: 'Snowfield',
  trees: [[TreeSpecies.Spruce, 0.6], [TreeSpecies.Fir, 0.3], [TreeSpecies.Dead, 0.1]],
  treeDensity: 1,
  plants: [[Plant.Fern, 0.75], [Plant.Bush, 0.25]],
  plantDensity: 0,
  grass: 0,
  sharedHues: null,
  leaves: 0,
  spores: 0,
}
// AUTUMN VALLEY: open rolling hills with maple groves in gold, orange and red, birches turned yellow, a few dead
// trees and dark pines; leaf piles and russet bushes; golden grass; leaves drifting down; warm low light.
BIOMES[Biome.Autumn] = {
  name: 'Autumn Valley',
  trees: [[TreeSpecies.Maple, 0.66], [TreeSpecies.Birch, 0.2], [TreeSpecies.Pine, 0.12], [TreeSpecies.Dead, 0.02]],
  treeDensity: 0.8,
  plants: [[Plant.LeafPile, 0.55], [Plant.Bush, 0.45]],
  plantDensity: 1.15,
  grass: 0.95,
  sharedHues: AUTUMN_HUES,
  leaves: 0.55,
  spores: 0,
}
// MYSTIC WOOD: ancient violet giants and glowing mushroom trees over teal grass, glowing mushrooms and blue ferns,
// heavy violet mist, floating spores.
BIOMES[Biome.Mystic] = {
  name: 'Mystic Wood',
  trees: [[TreeSpecies.Ancient, 0.5], [TreeSpecies.Shroom, 0.5]],
  // Giants fill the view: fewer trees than a forest grove (measured: 16 trees/chunk at 1.15 → 18 ms projected on an
  // Adreno 610, over budget; leaf-card overdraw of the big crowns).
  treeDensity: 0.62,
  plants: [[Plant.GlowShroom, 0.45], [Plant.Fern, 0.55]],
  plantDensity: 1.2,
  grass: 1,
  sharedHues: [[0.7, 1.05, 1.35], [0.95, 0.85, 1.4], [0.6, 1.2, 1.2]],
  leaves: 0,
  spores: 0.6,
}

/** Weighted entry pick: `r` in [0, 1). */
export function pickWeighted(list: readonly (readonly [number, number])[], r: number): number {
  let total = 0
  for (const [, w] of list) total += w
  let acc = 0
  for (const [v, w] of list) {
    acc += w / total
    if (r < acc) return v
  }
  return list[list.length - 1][0]
}

/** Region picked at a point in proportion to its weights (`r` in [0, 1)) — the discrete side of a blended border. */
export function pickRegion(w: RegionWeights, r: number): number {
  let acc = 0
  for (let b = 0; b < BIOME_COUNT; b++) {
    acc += w[b]
    if (r < acc) return b
  }
  return Biome.Forest
}

/** Weighted blend of a numeric region property. */
export function blendBy(w: RegionWeights, f: (d: BiomeDef) => number): number {
  let v = 0
  for (let b = 0; b < BIOME_COUNT; b++) if (w[b] > 0) v += w[b] * f(BIOMES[b])
  return v
}

/** Deterministic region roll for an object at world (x, z) (≈ 0.25 m grid, so float32 chunk-local round-trips agree). */
export function regionRoll(seed: number, x: number, z: number, salt: number): number {
  return hashFloat(seed, Math.floor(x * 4), Math.floor(z * 4), salt)
}
