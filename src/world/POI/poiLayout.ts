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
  // Cozy details (bright homesteads, cabins, camps; signposts at the roads into places):
  Chair: 14, Lantern: 15, Barrel: 16, Crate: 17, Picket: 18, Mailbox: 19, Stones: 20, FlowerBed: 21, Laundry: 22,
  Stump: 23, Bench: 24, Signpost: 25, LampPost: 26, LogSeat: 27,
  // Summit lookouts:
  Viewpoint: 28,
} as const

export function layoutPois(pois: Poi[], cx: number, cz: number, heights: Float32Array, seed: number, out: number[], cozy = false): void {
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
        if (p.home) { homestead(p, emit, h); break }
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
        if (cozy) {
          // porch chairs + lantern, a chopping stump, barrels, log seats round the fire, a bench
          emit(p, -0.9, 3.3, Math.PI + 0.3, 1, PropType.Chair)
          emit(p, 0.9, 3.4, Math.PI - 0.2, 1, PropType.Chair)
          emit(p, 1.5, 2.9, 0, 1, PropType.Lantern)
          emit(p, 5.6, 0.2, 0, 1, PropType.Stump)
          emit(p, -4, -1.5, 0, 1, PropType.Barrel)
          emit(p, -4.6, -0.8, 0.6, 0.9, PropType.Barrel)
          emit(p, -4.4, 6.6, 0.2, 1, PropType.LogSeat)
          emit(p, -1.5, 6.2, 1.4, 1, PropType.LogSeat)
          emit(p, 3, 6, -0.3, 1, PropType.Crate)
        }
        break
      case PoiType.Ruins:
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2
          if (h(50 + i) < 0.25) continue
          emit(p, Math.cos(a) * 8, Math.sin(a) * 8, a + Math.PI / 2, 0.7 + h(60 + i) * 0.6, PropType.RuinWall)
        }
        for (let i = 0; i < 5; i++) emit(p, (h(70 + i) - 0.5) * 12, (h(80 + i) - 0.5) * 12, h(90 + i) * 6, 0.6 + h(95 + i) * 0.8, PropType.RuinPillar)
        break
      case PoiType.Lookout:
        // The terrace faces the view (+z = down the peak's lowest side); a bench and a log seat behind it, a lantern
        // for the walk down at dusk, a signpost naming the peak.
        emit(p, 0, 0, 0, 1, PropType.Viewpoint)
        emit(p, 0, -5.6, Math.PI, 1, PropType.Bench)
        emit(p, -3.4, -4.8, 0.9 + h(1) * 0.4, 1, PropType.LogSeat)
        emit(p, 3.6, -4.2, 0, 1, PropType.Lantern)
        emit(p, 5.2, -1.5, -Math.PI / 2 + h(2) * 0.6, 1, PropType.Signpost)
        break
      case PoiType.Camp:
        emit(p, -3, 0, 0.4, 1, PropType.Tent)
        emit(p, 3, -1.5, -0.6, 0.9, PropType.Tent)
        emit(p, 0, 3, 0, 1, PropType.Campfire)
        emit(p, 2.5, 4, 1.2, 0.8, PropType.Woodpile)
        if (cozy) {
          emit(p, -1.6, 4.4, 0.5, 1, PropType.LogSeat)
          emit(p, 1.5, 4.8, -0.6, 1, PropType.LogSeat)
          emit(p, 0, 1.2, 0.2, 1, PropType.Chair)
          emit(p, -4.5, 2.5, 0, 1, PropType.Crate)
          emit(p, -4.9, 3.2, 0.5, 0.8, PropType.Crate)
          emit(p, 4.3, 1.5, 0, 1, PropType.Barrel)
          emit(p, -2, -2, 0, 1, PropType.Lantern)
        }
        break
    }
  }
}

type Emit = (p: Poi, lx: number, lz: number, rot: number, scale: number, type: number) => void

/**
 * HOMESTEAD (bright — instead of the farm): the house in a fenced front yard, lived in. Local frame: the main road
 * lies toward −x (pois.ts: the yard's rot turns it to face the road). House at (5, 0) facing −x; a picket-fenced
 * front yard (x −9…9, z −10…10) with a gate on −x, a lamp post and the mailbox at the gate, stepping stones to the
 * porch, flower beds either side of the path, porch chairs + lantern + barrels; out back firewood, the chopping
 * stump, a laundry line, crates and a bench. ~60 props, ≈ 3–4 k tris, merged into the place mesh (0 draws).
 */
function homestead(p: Poi, emit: Emit, h: (k: number) => number): void {
  const F = -Math.PI / 2 // facing −x
  emit(p, 5, 0, F, 1, PropType.House)
  // Picket fence: front (x = −9) with a gate gap at z ∈ (−1.4, 1.4), sides z = ±10 back to x = 9.
  for (let z = -9; z <= 9; z += 2) if (Math.abs(z) > 1.4) emit(p, -9, z, Math.PI / 2, 1, PropType.Picket)
  for (let x = -8; x <= 8; x += 2) { emit(p, x, -10, 0, 1, PropType.Picket); emit(p, x, 10, Math.PI, 1, PropType.Picket) }
  emit(p, -9.4, -2, 0, 1, PropType.LampPost)
  emit(p, -10.2, 2.4, F, 1, PropType.Mailbox)
  // Stepping stones from the gate to the porch.
  for (let x = -8.5; x < -1; x += 2.7) emit(p, x, (h(200 + Math.floor(x)) - 0.5) * 0.4, F, 1, PropType.Stones)
  emit(p, -4.5, -4, 0, 1, PropType.FlowerBed)
  emit(p, -4.5, 4, 0, 1, PropType.FlowerBed)
  if (h(210) < 0.6) emit(p, -6.5, -7.5, Math.PI / 2, 1, PropType.FlowerBed)
  // Porch: chairs, a lantern, barrels at the corner.
  emit(p, 0.6, -1.4, F + 0.4, 1, PropType.Chair)
  emit(p, 0.6, 1.4, F - 0.3, 1, PropType.Chair)
  emit(p, 0.3, -2.1, 0, 1, PropType.Lantern)
  emit(p, 1.4, -4.6, 0, 1, PropType.Barrel)
  emit(p, 2.1, -5.0, 0.7, 0.9, PropType.Barrel)
  emit(p, -6.5, 6.8, 0.2, 1, PropType.Bench)
  // Back yard: firewood against the side wall, the chopping stump, a laundry line, crates.
  emit(p, 5, 4.6, 0, 1, PropType.Woodpile)
  emit(p, 6.4, 4.8, 0.4, 1, PropType.Woodpile)
  emit(p, 3.6, 6.4, 0, 1, PropType.Stump)
  emit(p, 12.5, -2, Math.PI / 2, 1, PropType.Laundry)
  emit(p, 10.5, 5.5, 0.3, 1, PropType.Crate)
  emit(p, 11.2, 6.2, -0.2, 0.85, PropType.Crate)
  emit(p, 9.8, 6.3, 0.9, 0.9, PropType.Barrel)
}
