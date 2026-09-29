/**
 * World invariants (run: npm test). No test framework — plain asserts, exit code 1 on failure.
 *  1. Determinism: same seed → bit-identical ChunkData.
 *  2. Seams: shared chunk borders have identical heights and normals.
 *  3. Physics: Rapier heightfield built by PhysicsWorld matches the render mesh (raycasts).
 */
import { group, Groups, PhysicsWorld } from '../src/physics/PhysicsWorld'
import { CHUNK_SIZE, CHUNK_VERTS } from '../src/world/constants'
import { PROP_STRIDE } from '../src/world/types'
import { Rng } from '../src/world/noise/rng'
import { sampleHeight } from '../src/world/Terrain/generateTerrain'
import { WorldGenerator } from '../src/world/WorldGenerator'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

const keys = ['heights', 'normals', 'colors', 'roadLat', 'netEdge', 'netType', 'trees', 'rocks', 'plants', 'props'] as const
const a = new WorldGenerator(1337)
const b = new WorldGenerator(1337)
let identical = true
let ms = 0
for (let cx = -2; cx <= 2; cx++) {
  for (let cz = -2; cz <= 2; cz++) {
    const d1 = a.generateChunk(cx, cz)
    const d2 = b.generateChunk(cx, cz)
    ms += d1.genMs
    for (const k of keys) if (d1[k].length !== d2[k].length || d1[k].some((v, i) => v !== d2[k][i])) identical = false
  }
}
check('determinism (25 chunks, seed 1337)', identical, `${(ms / 25).toFixed(2)} ms/chunk`)
check('different seed differs', a.generateChunk(0, 0).heights[100] !== new WorldGenerator(7).generateChunk(0, 0).heights[100])

const V = CHUNK_VERTS
const c00 = a.generateChunk(0, 0)
const c10 = a.generateChunk(1, 0)
const c01 = a.generateChunk(0, 1)
let seam = 0
for (let k = 0; k < V; k++) {
  seam = Math.max(seam, Math.abs(c00.heights[k * V + V - 1] - c10.heights[k * V]))
  seam = Math.max(seam, Math.abs(c00.heights[(V - 1) * V + k] - c01.heights[k]))
  for (let n = 0; n < 3; n++) seam = Math.max(seam, Math.abs(c00.normals[(k * V + V - 1) * 3 + n] - c10.normals[k * V * 3 + n]))
}
check('chunk seams (heights + normals)', seam === 0, `max err ${seam}`)

const R = await PhysicsWorld.load()
const phys = new PhysicsWorld(R)
const chunk = a.generateChunk(3, -2)
// Remove trunks from the probe so rays hit terrain only.
phys.addChunk('3,-2', { ...chunk, trees: new Float32Array(0) })
phys.world.step()
const rng = new Rng(99)
let maxErr = 0
for (let i = 0; i < 200; i++) {
  const lx = rng.range(0.5, CHUNK_SIZE - 0.5)
  const lz = rng.range(0.5, CHUNK_SIZE - 0.5)
  const ray = new R.Ray({ x: chunk.cx * CHUNK_SIZE + lx, y: 500, z: chunk.cz * CHUNK_SIZE + lz }, { x: 0, y: -1, z: 0 })
  const hit = phys.world.castRay(ray, 1000, true, undefined, group(0xffff, Groups.Terrain)) // heightfield only (rocks sit on it)
  const y = hit ? 500 - hit.timeOfImpact : Number.NaN
  maxErr = Math.max(maxErr, Math.abs(y - sampleHeight(chunk.heights, lx, lz)))
}
check('heightfield collider matches render mesh (200 raycasts)', maxErr < 0.01, `max err ${maxErr.toFixed(4)} m`)
// Rock colliders: a ray straight down onto each rock's centre hits the rock (above the ground, below its top).
{
  const rk = chunk.rocks
  let n = 0, ok = 0
  for (let i = 0; i < rk.length; i += PROP_STRIDE) {
    const x = chunk.cx * CHUNK_SIZE + rk[i], z = chunk.cz * CHUNK_SIZE + rk[i + 2], s = rk[i + 4]
    const hit = phys.world.castRay(new R.Ray({ x, y: 500, z }, { x: 0, y: -1, z: 0 }), 1000, true, undefined, group(0xffff, Groups.Static))
    const y = hit ? 500 - hit.timeOfImpact : -1e9
    const ground = sampleHeight(chunk.heights, rk[i], rk[i + 2])
    n++
    if (y > ground + 0.25 * s && y < ground + 1.3 * s) ok++
  }
  check(`rock colliders sit on the rocks (${n} rocks)`, n > 0 && ok === n, `${ok}/${n}`)
}
phys.dispose()

process.exit(failures ? 1 : 0)
