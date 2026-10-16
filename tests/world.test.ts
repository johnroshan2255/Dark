/**
 * World invariants (run: npm test). No test framework — plain asserts, exit code 1 on failure.
 *  1. Determinism: same seed → bit-identical ChunkData.
 *  2. Seams: shared chunk borders have identical heights and normals.
 *  3. Physics: Rapier heightfield built by PhysicsWorld matches the render mesh (raycasts); rock hulls
 *     contain every vertex of the rendered boulder.
 *  4. Terrain layering: no cliffs at the main road's shoulder, places are flat, secondary roads sit on banks.
 *  5. Biomes: forest at the spawn, desert + snow reachable along the road, weights well-formed; desert chunks
 *     grow desert flora (saguaro / Joshua, no forest conifers), snowfields (almost) no undergrowth.
 */
import * as THREE from 'three'
import { group, Groups, PhysicsWorld } from '../src/physics/PhysicsWorld'
import { CHUNK_SIZE, CHUNK_VERTS } from '../src/world/constants'
import { PROP_STRIDE, TREE_STRIDE, TreeSpecies } from '../src/world/types'
import { Rng } from '../src/world/noise/rng'
import { sampleHeight } from '../src/world/Terrain/generateTerrain'
import { WorldGenerator } from '../src/world/WorldGenerator'
import { formationSdf, FormationKind } from '../src/world/Formations/formations'
import { createPropGeometries } from '../src/world/Forest/propGeometries'
import { buildInstanceAttributes } from '../src/optimization/instancing/InstanceBuilder'
import { Biome, BIOME_COUNT } from '../src/world/Biomes'
import { RoadNetwork, roadHeightAt, type NetRoad as RoadNetworkRoad } from '../src/world/Road/RoadNetwork'
import { builtBridge } from '../src/world/Road/bridges'
import { campsIn } from '../src/world/Road/camps'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

const keys = ['heights', 'normals', 'colors', 'roadLat', 'netEdge', 'netType', 'biome', 'trees', 'rocks', 'plants', 'props'] as const
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
// Rock colliders match the RENDERED boulder: every vertex of the near rock mesh, placed with the same instance
// matrix the chunk uses (scale + vertical jitter + rotation), lies inside its convex hull collider.
{
  const geos = createPropGeometries()
  const attrs = buildInstanceAttributes(chunk.rocks, PROP_STRIDE, undefined, 0.12)!
  const pos = geos.rock.getAttribute('position')
  const m = new THREE.Matrix4(), v = new THREE.Vector3(), c = new THREE.Vector3()
  let outside = 0, tested = 0, worst = 0
  for (let k = 0; k < attrs.count; k++) {
    m.fromArray(attrs.matrix.array as Float32Array, k * 16)
    c.set(0, 0.2, 0).applyMatrix4(m)
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m).lerp(c, 0.03) // 3 % inside the surface (hull tolerance)
      v.x += chunk.cx * CHUNK_SIZE
      v.z += chunk.cz * CHUNK_SIZE
      const proj = phys.world.projectPoint(v, true, undefined, group(0xffff, Groups.Static))
      tested++
      if (!proj || !proj.isInside) {
        outside++
        if (proj) worst = Math.max(worst, Math.hypot(proj.point.x - v.x, proj.point.y - v.y, proj.point.z - v.z))
      }
    }
  }
  check(`rock hulls contain the rendered boulders (${tested} vertices)`, tested > 0 && outside === 0, `${outside} outside, worst ${worst.toFixed(2)} m`)
  geos.dispose()
}
phys.dispose()

// Terrain layering: the road runs on a valley floor (no walls at its shoulder), places are flat, secondary
// roads meet the ground on banks. Three seeds × a few km each.
for (const seed of [7, 1337, 42]) {
  const f = new WorldGenerator(seed).fields
  let step = 0
  for (let z = -600; z < 3000; z += 4) {
    const x = f.roadCenterX(z), rh = f.roadHeight(z)
    step = Math.max(step, Math.abs(f.height(x + 12, z) - rh), Math.abs(f.height(x - 12, z) - rh))
    if (Math.abs(f.height(x, z) - rh) > 1e-6) step = 1e9 // the bed itself is exact
  }
  // (≤ 9.5 m: with the v2 region layout seed 1337 has a farm 12 m off the road on a hillside, levelled ~10 m above it.)
  check(`seed ${seed}: main-road shoulder step ≤ 9.5 m`, step <= 9.5, `${step.toFixed(1)} m`)
  let disc = 0, n = 0
  for (const p of f.pois.inBox(-1500, -1500, 1500, 1500)) {
    let lo = Infinity, hi = -Infinity
    for (let a = 0; a < 16; a++) {
      const h = f.height(p.x + Math.cos((a / 16) * Math.PI * 2) * p.radius * 0.55, p.z + Math.sin((a / 16) * Math.PI * 2) * p.radius * 0.55)
      lo = Math.min(lo, h); hi = Math.max(hi, h)
    }
    disc = Math.max(disc, hi - lo); n++
  }
  check(`seed ${seed}: places are flat (${n} places, relief across 55 % of the radius ≤ 0.5 m)`, n > 0 && disc <= 0.5, `${disc.toFixed(2)} m`)
  let slope = 0
  for (let z = -300; z < 1200; z += 6) {
    for (let x = -600; x < 600; x += 6) {
      if (!f.netRoad(x, z, 3)) continue
      slope = Math.max(slope, Math.abs(f.height(x + 3, z) - f.height(x + 5, z)) / 2, Math.abs(f.height(x, z + 3) - f.height(x, z + 5)) / 2)
    }
  }
  check(`seed ${seed}: ground beside secondary roads ≤ 2.2 m/m`, slope <= 2.2, `${slope.toFixed(2)} m/m`)
  // Biomes.
  const w0 = f.biome(f.roadCenterX(8), 8, [0, 0], f.height(f.roadCenterX(8), 8))
  check(`seed ${seed}: spawn is forest`, w0[0] + w0[1] < 0.02, `desert ${w0[0].toFixed(2)} snow ${w0[1].toFixed(2)}`)
  // Down the main road: forest → autumn → desert one way, forest → mystic → snow the other (cells (0, ±2), (0, ±3)).
  const road = [-3, -2, 2, 3].map((j) => f.biomes.cell(0, j).type).sort()
  check(`seed ${seed}: autumn, mystic, desert and snow all lie on the road within ~3.6 km`, road.join() === [Biome.Desert, Biome.Snow, Biome.Autumn, Biome.Mystic].sort().join())
  const dry = f.biomes.cell(0, 2).type === Biome.Autumn ? 1 : -1
  check(`seed ${seed}: the road runs autumn → desert and mystic → snow`, f.biomes.cell(0, 3 * dry).type === Biome.Desert && f.biomes.cell(0, -2 * dry).type === Biome.Mystic && f.biomes.cell(0, -3 * dry).type === Biome.Snow)
  let bad = 0
  const rng2 = new Rng(seed)
  const wn = new Float32Array(BIOME_COUNT)
  for (let i = 0; i < 2000; i++) {
    const x = rng2.range(-5000, 5000), z = rng2.range(-5000, 5000)
    const w = f.biome(x, z, [0, 0])
    if (w[0] < 0 || w[1] < 0 || w[0] + w[1] > 1 + 1e-6 || Number.isNaN(w[0] + w[1])) bad++
    f.biomes.weightsN(x, z, wn, i % 2 ? f.height(x, z) : undefined)
    let sum = 0
    for (const v of wn) { if (v < -1e-6 || Number.isNaN(v)) bad++; sum += v }
    if (Math.abs(sum - 1) > 1e-4) bad++
  }
  check(`seed ${seed}: region weights well-formed (each >= 0, sum = 1)`, bad === 0, `${bad} bad`)
  // Region shares over a 37 x 37 km map (climate table): forest ~50 %, autumn / desert / snow ~15 %, mystic ~5 %.
  const share = [0, 0, 0, 0, 0]
  for (let j = -20; j <= 20; j++) for (let i = -20; i <= 20; i++) share[f.biomes.cell(i, j).type]++
  const tot = share.reduce((a, b) => a + b)
  const pct = share.map((c) => (c / tot) * 100)
  check(`seed ${seed}: region shares (forest ${pct[0].toFixed(0)} desert ${pct[1].toFixed(0)} snow ${pct[2].toFixed(0)} autumn ${pct[3].toFixed(0)} mystic ${pct[4].toFixed(0)} %)`,
    pct[0] > 38 && pct[0] < 62 && [1, 2, 3].every((b) => pct[b] > 8 && pct[b] < 24) && pct[4] > 2 && pct[4] < 10)
  // Biome flora: chunks deep inside the desert / snow cells along the road.
  const gen = new WorldGenerator(seed)
  const deep = (want: number) => {
    const out: [number, number][] = []
    // The road runs near the x = 0 cell edge: look a little to either side of it (cells (0, j) and (−1, j)).
    for (let z = -3800; z <= 3800 && out.length < 6; z += 64) {
      for (const off of [40, 220, -220]) {
        const x = f.roadCenterX(z) + off
        if (f.biome(x, z, [0, 0])[want] > 0.97) { out.push([Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)]); break }
      }
    }
    return out
  }
  let desertTrees = 0, forestInDesert = 0, snowPlants = 0
  const sp = new Set<number>()
  for (const [cx, cz] of deep(0)) {
    const t = gen.generateChunk(cx, cz).trees
    for (let i = 0; i < t.length; i += TREE_STRIDE) {
      const id = t[i + 5]
      sp.add(id)
      if (id === TreeSpecies.Cactus || id === TreeSpecies.Joshua) desertTrees++
      if (id === TreeSpecies.Spruce || id === TreeSpecies.Fir || id === TreeSpecies.Birch) forestInDesert++
    }
  }
  const snowChunks = deep(1)
  for (const [cx, cz] of snowChunks) snowPlants += gen.generateChunk(cx, cz).plants.length / PROP_STRIDE
  check(`seed ${seed}: desert grows saguaros + Joshua trees, no forest conifers`, desertTrees > 10 && forestInDesert === 0 && sp.has(TreeSpecies.Cactus) && sp.has(TreeSpecies.Joshua), `${desertTrees} desert trees, ${forestInDesert} forest`)
  // (a chunk's far corners may sit just outside full snow: a stray bush there is fine; forest chunks have hundreds)
  // Places (farms, cabins, camps, ruins) only in the green lands.
  let badPlaces = 0
  const allPlaces = f.pois.inBox(-3000, -4000, 3000, 4000)
  for (const q of allPlaces) { const w = f.biomes.weights(q.x, q.z, [0, 0]); if (w[0] > 0.25 || w[1] > 0.25) badPlaces++ }
  check(`seed ${seed}: no places in the desert or the snow (${allPlaces.length} places)`, badPlaces === 0, `${badPlaces} misplaced`)
  check(`seed ${seed}: (almost) no undergrowth on the snowfields`, snowChunks.length > 0 && snowPlants <= 3 * snowChunks.length, `${snowPlants} plants in ${snowChunks.length} chunks`)
}

// Secondary roads never CROSS each other or cut across the main road's corridor (junctions at shared ends are
// fine): a crossing is two graded roads at different heights through each other — the "road intercepts".
{
  let crossings = 0, corridor = 0, roads = 0
  for (const seed of [7, 1337, 42]) {
    const f = new WorldGenerator(seed).fields
    const seen = new Set<object>()
    for (let cj = -4; cj <= 6; cj++) {
      for (let ci = -3; ci <= 3; ci++) {
        const list = f.network.roadsIn(ci, cj)
        for (let a = 0; a < list.length; a++) {
          const r = list[a]
          if (!seen.has(r)) {
            seen.add(r)
            roads++
            // Grid links (both ends off the main road) must stay out of its corridor.
            const endOnMain = Math.abs(r.xs[r.n - 1] - f.roadCenterX(r.zs[r.n - 1])) < 3
            if (!endOnMain) for (let i = 0; i < r.n; i++) if (Math.abs(r.xs[i] - f.roadCenterX(r.zs[i])) < 2.7 + 9) { corridor++; break }
          }
          for (let b = a + 1; b < list.length; b++) if (RoadNetwork.crosses(r, list[b])) { crossings++; console.log(`  crossing: seed ${seed} ${r.key} × ${list[b].key}`) }
        }
      }
    }
  }
  check(`secondary roads never cross each other (${roads} roads, 3 seeds)`, roads > 50 && crossings === 0, `${crossings} crossings`)
  check('grid links stay out of the main road corridor', corridor === 0, `${corridor} in the corridor`)
}

// ROAD GRAPH (RoadNetwork: spanning tree + loops + leaf closures + pruning; A* connectors for places, camps and
// bridges): every road reaches the main road; NO road ends in the middle of nowhere (each end is on the main road,
// on another road = a junction, at a place, a camp or a bridge deck); every place and camp has a road; a bridge is
// built only when both its ends lead to roads. Junction-aware union–find over 4 seeds (window edges excluded).
{
  let cut = 0, dead = 0, checked = 0, noRoad = 0, places = 0, campsNo = 0, bridgesBad = 0, bridges = 0
  for (const seed of [7, 1337, 42, 6]) {
    const f = new WorldGenerator(seed).fields
    const set = new Set<RoadNetworkRoad>()
    // (Collected over a wider window than checked: a chain may leave the checked window on its way to the main road.)
    for (let cj = -11; cj <= 13; cj++) for (let ci = -8; ci <= 8; ci++) for (const r of f.network.roadsIn(ci, cj)) set.add(r)
    const list = [...set]
    const near = (r: RoadNetworkRoad, x: number, z: number) => {
      if (x < r.minX - 4 || x > r.maxX + 4 || z < r.minZ - 4 || z > r.maxZ + 4) return false
      for (let i = 0; i < r.n - 1; i++) {
        const vx = r.xs[i + 1] - r.xs[i], vz = r.zs[i + 1] - r.zs[i], l2 = vx * vx + vz * vz || 1
        const t = Math.min(1, Math.max(0, ((x - r.xs[i]) * vx + (z - r.zs[i]) * vz) / l2))
        if (Math.hypot(r.xs[i] + vx * t - x, r.zs[i] + vz * t - z) < 3) return true
      }
      return false
    }
    const onMain = (x: number, z: number) => Math.abs(x - f.roadCenterX(z)) < 4
    const parent = new Map<RoadNetworkRoad | 'main', RoadNetworkRoad | 'main'>()
    const find = (k: RoadNetworkRoad | 'main'): RoadNetworkRoad | 'main' => { let r = k; while (parent.get(r) !== r) r = parent.get(r)!; return r }
    parent.set('main', 'main')
    for (const r of list) parent.set(r, r)
    const join = (a: RoadNetworkRoad | 'main', b: RoadNetworkRoad | 'main') => parent.set(find(a), find(b))
    const inner = (x: number, z: number) => x > -4 * 380 && x < 5 * 380 && z > -5 * 380 && z < 7 * 380
    for (const r of list) {
      if (r.key.startsWith('br') && r.key.endsWith('a')) { const o = list.find((q) => q.key === r.key.slice(0, -1) + 'b'); if (o) join(r, o) } // the deck joins a bridge's two roads
      for (const e of [0, r.n - 1]) {
        const x = r.xs[e], z = r.zs[e]
        let ok = false
        if (onMain(x, z)) (join(r, 'main'), (ok = true))
        for (const q of list) if (q !== r && near(q, x, z)) (join(r, q), (ok = true))
        if (!ok && inner(x, z) && !f.pois.near(x, z, 5) && !(e === 0 && (r.key.startsWith('camp:') || r.key.startsWith('br')))) { dead++; console.log(`  dead end: seed ${seed} ${r.key}`) }
      }
    }
    for (const r of list) {
      if (!inner(r.xs[0], r.zs[0])) continue
      checked++
      if (find(r) !== find('main')) { cut++; console.log(`  cut off: seed ${seed} ${r.key}`) }
    }
    for (const p of f.pois.inBox(-1500, -1900, 1900, 2600)) {
      if (Math.abs(p.x - f.roadCenterX(p.z)) > 2400 || Math.abs(p.x - f.roadCenterX(p.z)) < p.radius + 15) continue
      places++
      if (!f.network.nearest(p.x, p.z, p.radius + 25)) { noRoad++; console.log(`  place without a road: seed ${seed} ${p.x | 0},${p.z | 0}`) }
    }
    for (const c of campsIn(f, -1900, 2600)) if (!f.network.nearest(c.x, c.z, 10)) campsNo++
    for (let k = -4; k <= 5; k++) if (builtBridge(f, k)) { bridges++; if (!f.network.bridgeLinks(k)) bridgesBad++ }
  }
  check(`every secondary road reaches the main road (${checked} roads, 4 seeds)`, checked > 100 && cut === 0, `${cut} cut off`)
  check('no road ends in the middle of nowhere (junction / main road / place / camp / bridge at every end)', dead === 0, `${dead} dead ends`)
  check(`every place and camp has a road (${places} places)`, places > 20 && noRoad === 0 && campsNo === 0, `${noRoad} places, ${campsNo} camps without`)
  check(`every built bridge leads to roads at both ends (${bridges} bridges)`, bridgesBad === 0, `${bridgesBad} bad`)
}

// Landmarks (giant trees, windmills, ruins, towers…): deterministic, dry, off the road; the home one in view.
{
  let total = 0, bad = 0, same = true, homeSeen = 0
  for (const seed of [7, 1337, 42]) {
    const fa = new WorldGenerator(seed).fields, fb = new WorldGenerator(seed).fields
    const la = fa.landmarks.inBox(-2000, -2000, 2000, 2000), lb = fb.landmarks.inBox(-2000, -2000, 2000, 2000)
    same &&= JSON.stringify(la) === JSON.stringify(lb)
    total += la.length
    for (const l of la) if (l.y < -6 + 1 || fa.roadDistance(l.x, l.z) < l.radius + 10) bad++
    const h = fa.landmarks.home()
    if (h) {
      const sx = fa.roadCenterX(8), sy = fa.height(sx, 8) + 1.7, n = Math.ceil(Math.hypot(h.x - sx, h.z - 8) / 10)
      let ok = true
      for (let i = 1; i < n; i++) { const t = i / n; if (fa.height(sx + (h.x - sx) * t, 8 + (h.z - 8) * t) > sy + (h.y + 50 - sy) * t - 2) ok = false }
      if (ok) homeSeen++
    }
  }
  check('landmarks are deterministic', same)
  check(`landmarks stand on dry ground off the road (${total} in 3 × 16 km²)`, total > 40 && bad === 0, `${bad} misplaced`)
  check('the home landmark is in view of the spawn (3 seeds)', homeSeen === 3, `${homeSeen}/3`)
}

// DRIVABLE network: steep straight links between hilltops are re-routed along the terrain (RoadNetwork.drivable) —
// before, 45–90 % pitches (no car climbs them) summed to 360–1070 m per seed over 7 × 7 regions.
{
  let steep = 0, total = 0
  for (const seed of [7, 1337]) {
    const f = new WorldGenerator(seed).fields
    const seen = new Set<string>()
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) for (const r of f.network.roadsIn(i, j)) {
      if (seen.has(r.key)) continue
      seen.add(r.key)
      const L = r.cum[r.n - 1]
      const hAt = (s: number) => { let i = 0; while (i < r.n - 2 && r.cum[i + 1] < s) i++; const l = r.cum[i + 1] - r.cum[i]; return roadHeightAt(r, i, l > 0 ? Math.min(1, Math.max(0, (s - r.cum[i]) / l)) : 0) }
      for (let s = 0; s + 4 <= L; s += 2) { total += 2; if (Math.abs(hAt(s + 4) - hAt(s)) / 4 > 0.45) steep += 2 }
    }
  }
  check(`secondary roads are drivable: ≤ 2.5 % of their length steeper than 45 % (2 seeds, ${(total / 1000).toFixed(1)} km)`, steep <= total * 0.025, `${steep} m`)
}

// Road tunnels: the bore follows the main road through the hill (bends and grade) — no rock within the road's
// width + a car's half-width (a straight bore left rock 0.3 m from the centre where the road bent).
{
  let tunnels = 0, tight = 1e9
  for (const seed of [7, 1337]) {
    const f = new WorldGenerator(seed).fields
    for (let k = -30; k <= 30; k++) {
      const F = f.formations.roadFormation(k)
      if (!F || F.kind !== FormationKind.Cave) continue
      tunnels++
      const sdf = formationSdf(F), c = Math.cos(F.rot), sn = Math.sin(F.rot)
      for (let z = F.z - 40; z <= F.z + 40; z += 2) {
        const cx = f.roadCenterX(z), ry = f.roadHeight(z)
        const dir = f.roadCenterX(z + 1) - f.roadCenterX(z - 1), L = Math.hypot(dir, 2), px = 2 / L, pz = -dir / L
        for (const side of [-1, 1]) for (let d = 0; d <= 4.2; d += 0.2) {
          let hit = false
          for (const hy of [0.3, 1.0, 1.8]) {
            const dx = cx + side * px * d - F.x, dz = z + side * pz * d - F.z
            if (sdf(dx * c + dz * sn, ry + hy - F.y, -dx * sn + dz * c) < 0) hit = true
          }
          if (hit) { tight = Math.min(tight, d); break }
        }
      }
    }
  }
  check(`road tunnels leave the road clear (${tunnels} tunnels, 2 seeds)`, tunnels > 10 && tight > 3.7, tight < 1e8 ? `rock ${tight.toFixed(1)} m from the centre` : "no rock within 4.2 m")
}

process.exit(failures ? 1 : 0)
