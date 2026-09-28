import { CHUNK_SIZE } from '../constants'
import { hashFloat } from '../noise/rng'
import { sampleHeight } from '../Terrain/generateTerrain'
import { FARM_FIELDS, PoiType, toWorld, type Poi } from './pois'

/**
 * Objects of each place, emitted into the chunk that contains them (stride 6: x, y, z, rotY, scale, type —
 * same record format as roadside props). Crops are hundreds of instances; buildings a few.
 */
export const PropType = {
  Pole: 0, Fence: 1, Barn: 2, House: 3, Hay: 4, Wheat: 5, Cabbage: 6, Cabin: 7, Tent: 8, Campfire: 9,
  RuinWall: 10, RuinPillar: 11, Woodpile: 12, Corn: 13,
} as const

export function layoutPois(pois: Poi[], cx: number, cz: number, heights: Float32Array, seed: number, out: number[]): void {
  const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE
  const emit = (p: Poi, lx: number, lz: number, rot: number, scale: number, type: number) => {
    const [wx, wz] = toWorld(p, lx, lz)
    const x = wx - x0, z = wz - z0
    if (x < 0 || x >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE) return
    out.push(x, sampleHeight(heights, x, z), z, rot + p.rot, scale, type)
  }
  for (const p of pois) {
    const h = (k: number) => hashFloat(seed, Math.floor(p.x), Math.floor(p.z), k)
    switch (p.type) {
      case PoiType.Farm: {
        emit(p, -16, 16, Math.PI, 1, PropType.House)
        emit(p, 16, 17, Math.PI * 0.5, 1, PropType.Barn)
        for (let i = 0; i < 6; i++) emit(p, 24 + h(10 + i) * 8, 6 + h(20 + i) * 10, h(30 + i) * 3, 0.9 + h(40 + i) * 0.3, PropType.Hay)
        FARM_FIELDS.forEach((f, fi) => {
          const crop = [PropType.Wheat, PropType.Cabbage, PropType.Corn][Math.floor(((p.variant + fi * 0.37) % 1) * 3)]
          const rowGap = crop === PropType.Cabbage ? 1.1 : 1.3
          const step = crop === PropType.Cabbage ? 0.9 : 0.75
          for (let lx = f[0] + 1; lx < f[2] - 0.5; lx += rowGap) {
            for (let lz = f[1] + 1; lz < f[3] - 0.5; lz += step) emit(p, lx, lz, h(Math.floor(lx * 7 + lz * 13)) * 6.28, 0.85 + h(Math.floor(lx * 3 + lz)) * 0.3, crop)
          }
          // Fence around each field (4 m segments), gate gap on the yard side.
          for (let lx = f[0] + 2; lx < f[2]; lx += 4) {
            emit(p, lx, f[1], Math.PI / 2, 1, PropType.Fence)
            if (Math.abs(lx - (f[0] + f[2]) / 2) > 3) emit(p, lx, f[3], Math.PI / 2, 1, PropType.Fence)
          }
          for (let lz = f[1] + 2; lz < f[3]; lz += 4) {
            emit(p, f[0], lz, 0, 1, PropType.Fence)
            emit(p, f[2], lz, 0, 1, PropType.Fence)
          }
        })
        break
      }
      case PoiType.Cabin:
        emit(p, 0, 0, 0, 1, PropType.Cabin)
        emit(p, 4.5, 2, 0.3, 1, PropType.Woodpile)
        emit(p, -3, 5, 0, 1, PropType.Campfire)
        break
      case PoiType.Ruins:
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2
          if (h(50 + i) < 0.25) continue
          emit(p, Math.cos(a) * 8, Math.sin(a) * 8, a + Math.PI / 2, 0.7 + h(60 + i) * 0.6, PropType.RuinWall)
        }
        for (let i = 0; i < 5; i++) emit(p, (h(70 + i) - 0.5) * 12, (h(80 + i) - 0.5) * 12, h(90 + i) * 6, 0.6 + h(95 + i) * 0.8, PropType.RuinPillar)
        break
      case PoiType.Camp:
        emit(p, -3, 0, 0.4, 1, PropType.Tent)
        emit(p, 3, -1.5, -0.6, 0.9, PropType.Tent)
        emit(p, 0, 3, 0, 1, PropType.Campfire)
        emit(p, 2.5, 4, 1.2, 0.8, PropType.Woodpile)
        break
    }
  }
}
