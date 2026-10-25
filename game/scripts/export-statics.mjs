// EXPORT A FIXED MAP'S STATIC COLLIDERS for the server's physics (dev-only: needs `npm run dev`): every solid thing
// the game builds on the map — the chunk scatter's trunks and boulders (grown from FixedMap.seed, the same for every
// game), the map's set pieces (MapProps tiles) and plank bridges — built by the game's own code (PhysicsWorld.addChunk,
// MapProps) into a scratch Rapier world and written collider by collider to public/maps/<id>/statics.bin, which the
// server loads (server/crates/sim/src/statics.rs). Also writes ray probes against them (the server's parity test).
// Not exported: the terrain heightfield (the server builds it from heights.bin), the road ribbon and the rock
// formations (trimeshes of ~1.6 M + 1 M triangles — see server/docs/VEHICLE_PHYSICS.md).
// Rerun after changing the scatter, the map, a prop's collider or the seed.
//   node scripts/export-statics.mjs [map=island]        env: PORT (5173), CHROME
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const MAP = process.argv[2] || 'island'
const OUT = `public/maps/${MAP}/statics.bin`
const PROBES = `../server/crates/sim/golden/statics-probe-${MAP}.json`
const CHROME = process.env.CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 0, args: ['--use-angle=metal', '--mute-audio'] })
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`http://localhost:${process.env.PORT || 5173}/?map=${MAP}&tier=low&net=0`, { waitUntil: 'load' })
await page.waitForFunction(() => window.__game?.mapProps?.ready, { timeout: 180_000, polling: 250 })
const res = await page.evaluate(async () => {
  const g = window.__game, R = g.physics.R, map = g.map, mp = g.mapProps
  // (Vite serves the game's own modules: the generator the chunk worker runs)
  const { WorldGenerator } = await import('/src/world/WorldGenerator.ts')
  const { groundPalette } = await import('/src/rendering/artStyle.ts')
  const { CHUNK_SIZE } = await import('/src/world/constants.ts')
  const pw = new g.physics.constructor(R)
  const gen = new WorldGenerator(map.seed, groundPalette(), map)
  const c0 = Math.floor(-map.half / CHUNK_SIZE), c1 = Math.floor((map.half - 1e-3) / CHUNK_SIZE)
  for (let cz = c0; cz <= c1; cz++) for (let cx = c0; cx <= c1; cx++) pw.addChunk(`${cx},${cz}`, gen.generateChunk(cx, cz))
  const chunkBodies = new Set([...pw.chunkBodies.values()].map((b) => b.handle))
  // the set pieces: MapProps builds a tile's colliders into whichever world it is pointed at
  const real = mp.physics
  mp.physics = pw
  try { for (const t of mp.tiles) mp.colliders(t) } finally { mp.physics = real }
  // the sandstone pillars (a pillar map: world/map/PillarField.ts) — a cylinder each
  g.pillars?.addColliders(pw)

  const T = R.ShapeType
  const recs = []
  const take = (c, world, breakable) => {
    const s = c.shape, type = s.type
    if (type === T.HeightField) return
    // (the chunks' trimeshes: the road ribbon and the rock formations — not exported)
    if (type === T.TriMesh && world === pw && chunkBodies.has(c.parent()?.handle)) return
    const kind = { [T.Cuboid]: 0, [T.Cylinder]: 1, [T.Ball]: 2, [T.ConvexPolyhedron]: 3, [T.TriMesh]: 4 }[type]
    if (kind === undefined) throw new Error(`collider shape ${type} has no export`)
    recs.push({ c, kind, s, breakable })
  }
  pw.world.forEachCollider((c) => take(c, pw, pw.props.has(c.handle)))
  for (const b of mp.bridgeBodies) for (let i = 0; i < b.numColliders(); i++) take(b.collider(i), g.physics.world, false)

  // FORMAT (little-endian): "DKST" u32 version, u32 seed, u32 count; per collider: u8 kind, u8 flags (1 breakable,
  // 2 rotated), u32 groups ((member << 16) | filter), f32 friction, f32 x y z, [f32 qx qy qz qw], then by kind —
  // 0 box: hx hy hz · 1 cylinder: half height, radius · 2 ball: radius · 3 convex: u16 n, n × xyz (hull points, local)
  // · 4 trimesh: u32 nv, nv × xyz, u32 nt, nt × 3 u32.
  let size = 16
  for (const r of recs) {
    const q = r.c.rotation()
    r.rot = Math.abs(q.x) + Math.abs(q.y) + Math.abs(q.z) > 1e-7
    size += 22 + (r.rot ? 16 : 0)
    size += r.kind === 0 ? 12 : r.kind === 1 ? 8 : r.kind === 2 ? 4 : r.kind === 3 ? 2 + r.s.vertices.length * 4 : 8 + r.s.vertices.length * 4 + r.s.indices.length * 4
  }
  const buf = new ArrayBuffer(size), v = new DataView(buf)
  let o = 0
  const u8 = (x) => v.setUint8(o++, x), u16 = (x) => ((v.setUint16(o, x, true)), (o += 2)), u32 = (x) => ((v.setUint32(o, x >>> 0, true)), (o += 4)), f32 = (x) => ((v.setFloat32(o, x, true)), (o += 4))
  'DKST'.split('').forEach((ch) => u8(ch.charCodeAt(0)))
  u32(1); u32(map.seed); u32(recs.length)
  const count = {}
  for (const r of recs) {
    const c = r.c, t = c.translation(), q = c.rotation()
    u8(r.kind); u8((r.breakable ? 1 : 0) | (r.rot ? 2 : 0)); u32(c.collisionGroups()); f32(c.friction()); f32(t.x); f32(t.y); f32(t.z)
    if (r.rot) { f32(q.x); f32(q.y); f32(q.z); f32(q.w) }
    const s = r.s
    if (r.kind === 0) { f32(s.halfExtents.x); f32(s.halfExtents.y); f32(s.halfExtents.z) }
    else if (r.kind === 1) { f32(s.halfHeight); f32(s.radius) }
    else if (r.kind === 2) f32(s.radius)
    else if (r.kind === 3) { u16(s.vertices.length / 3); for (const x of s.vertices) f32(x) }
    else { u32(s.vertices.length / 3); for (const x of s.vertices) f32(x); u32(s.indices.length / 3); for (const x of s.indices) u32(x) }
    const k = ['box', 'cylinder', 'ball', 'convex', 'trimesh'][r.kind] + (r.breakable ? ' (breakable)' : '')
    count[k] = (count[k] || 0) + 1
  }
  if (o !== size) throw new Error(`wrote ${o} of ${size} bytes`)

  // PROBES: level rays at solid (non-breakable) colliders from 6 m off, at their centre's height; the first hit
  // among the exported colliders (formations / ribbon hits are dropped: the server doesn't have them).
  const all = new Map()
  for (const r of recs) all.set(r.c.handle, r)
  const probes = []
  pw.world.step() // (scene queries see colliders from the first step on)
  const solid = recs.filter((r) => !r.breakable && r.kind !== 4)
  for (let i = 0; i < solid.length && probes.length < 400; i += Math.max(1, Math.floor(solid.length / 700))) {
    const t = solid[i].c.translation(), a = (i * 2.399) % (Math.PI * 2)
    const dir = { x: -Math.sin(a), y: 0, z: -Math.cos(a) }
    const org = { x: t.x - dir.x * 6, y: t.y + 0.05, z: t.z - dir.z * 6 }
    const hit = pw.world.castRay(new R.Ray(org, dir), 12, true, undefined, (0xffff << 16) | 0x0002)
    if (hit && !all.has(hit.collider.handle)) continue
    if (hit && all.get(hit.collider.handle).breakable) continue
    // (a ray grazing a collider's edge — a trunk's bottom face 1 cm above it — flips hit / miss with float precision
    //  between the game's and the server's Rapier: keep only probes that hit the same 3 cm above and below)
    const toi = (dy) => pw.world.castRay(new R.Ray({ ...org, y: org.y + dy }, dir), 12, true, undefined, (0xffff << 16) | 0x0002)?.timeOfImpact ?? -1
    const t0 = hit ? hit.timeOfImpact : -1
    if (Math.abs(toi(0.03) - t0) > 0.01 || Math.abs(toi(-0.03) - t0) > 0.01) continue
    probes.push([org.x, org.y, org.z, dir.x, dir.y, dir.z, hit ? hit.timeOfImpact : -1])
  }
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { b64: btoa(bin), count, seed: map.seed, probes }
})
fs.writeFileSync(OUT, Buffer.from(res.b64, 'base64'))
fs.mkdirSync('../server/crates/sim/golden', { recursive: true })
fs.writeFileSync(PROBES, JSON.stringify({ note: 'generated by game/scripts/export-statics.mjs — do not edit', map: MAP, seed: res.seed, probes: res.probes }))
console.log(`${OUT}: ${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB, seed ${res.seed}`, res.count, `· ${res.probes.length} probes → ${PROBES}`)
await browser.close()
