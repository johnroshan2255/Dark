/**
 * Terrain albedo palette (sRGB hex → linear at load). Tuned against refer/roads/forest-road-evening-hero.png
 * and refer/environment/day-evening.png: saturated yellow-greens on verges, grey-blue asphalt, warm gravel.
 * Keep albedos in a readable range (sRGB ≥ ~0x30): with clear near-field fog, dark albedos read as black.
 */
const hex = (h: number): [number, number, number] => {
  const c = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return [c((h >> 16) & 255), c((h >> 8) & 255), c(h & 255)]
}

export const PALETTE = {
  grassDark: hex(0x344c2c),
  grassLight: hex(0x5e6c38),
  moss: hex(0x4e6636),
  dirt: hex(0x6e5c42),
  rock: hex(0x565a6c), // slate blue-grey rock faces (refer cliffs/boulders)
  sand: hex(0x7a6c52),
  litter: hex(0x2e2a1e),
  soil: hex(0x7a5836),
  soilDark: hex(0x523822),
  silt: hex(0x2c3430),
  road: hex(0x8c8a88),
  roadEdge: hex(0x7d725f),
}
