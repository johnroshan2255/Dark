import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type RAPIER from '@dimforge/rapier3d-compat'
import { group, Groups, STATIC_MESH_FILTER, type PhysicsWorld } from '../../physics/PhysicsWorld'
import { stylize } from '../../rendering/shaders/stylize'
import type { MaterialLibrary } from '../../rendering/materials/MaterialLibrary'
import type { FixedMap } from './FixedMap'
import { DROPPED, ROAD_BLOCKERS, darkPieces, mapBridge, type Piece } from './mapPieces'

/**
 * A fixed map's SET PIECES (its props.json placements that are not nature): camps, the stunt park, race-track gates,
 * cabins, the ranch, ramps, bridges, the dock, the ski lift, and Bruno Simon's crates / bricks (MIT, maps/<id>/bruno).
 * Nature (trees, rocks, bushes, grass, cacti) is NOT drawn from the map: the chunk scatter grows Dark's own where
 * the map's trees were (FixedMap.forestDensity).
 *
 * DARK'S LOOK (2026-10-21, mapPieces.ts): camp gear, cabins, fences, crates and barrels are drawn with the procedural
 * world's place props (painted wood / canvas / stone), the toy cars and flags are left out, and the BRIDGES are
 * Dark's plank suspension bridge built along the road's bridge samples (the map's plank strip is not drawn). Solid
 * pieces standing on a road bed are dropped (a desert pillar sat on a rebuilt road).
 * Drawing: THREE draws for every set piece — one BatchedMesh per material (the map's vertex-coloured props, Bruno's
 * palette props, Dark's painted pieces), every placement an instance that three frustum-culls on its own (multi-draw);
 * instances past DRAW_DIST are hidden — plus one draw per bridge in view. (Was one InstancedMesh per type per 200 m
 * tile: ~67 draws on screen, 2026-10-20.)
 * Physics: a fixed body per tile while the player is within PHYS_IN of it (released past PHYS_OUT) — boxes for
 * buildings / gear, cylinders for posts, hulls for ramps, the exact `<type>_col` trimesh for the loop, quarter-pipes,
 * wave ramp, bridges and dock (members of StaticMesh: the car's hulls meet them, like rock formations).
 */
/** Nature placements Dark grows itself (chunk scatter) — not drawn here. (palm: since 2026-10-21 a fifth of them grow
 *  as Dark's palms, FixedMap.palmCell — the map's clay palm is not drawn.) */
const NATURE = new Set(['pine', 'pine_snow', 'palm', 'rock', 'rock_snow', 'rock_red', 'bush', 'grass_tuft', 'cactus', 'log', 'stump', 'boulder', 'dead_tree', 'oak', 'birch', 'cherry'])
const TILE = 200
const DRAW_DIST = 420
const PHYS_IN = 140
const PHYS_OUT = 220
/** Bruno's models are made for a ~2.7 m car; the map is scaled for a 4.5 m jeep (as in The-Land). */
const BRUNO_SCALE = 1.5
/** (Lanterns, pole lights and benches are left out: 2026-10-20, "remove the lanterns and chairs" — their placements
 *  are skipped like any type without a shape.) */
const BRUNO: Record<string, string> = {
  b_crate: 'explosiveCrates.glb', b_brick: 'bricks.glb',
}

type Solid = 'trunk' | 'box' | 'hull' | 'mesh' | 'arch' | 'none'
const SOLID: Record<string, Solid> = {
  tent_orange: 'box', tent_red: 'box', tent_blue: 'box', caravan: 'box', campfire: 'box', fence: 'box', picnic_table: 'box',
  crate: 'box', barrel: 'trunk', signpost: 'trunk', lamp_post: 'trunk', flag: 'trunk', palm: 'trunk', pillar: 'hull',
  car_jeep: 'box', car_buggy: 'box', car_van: 'box', car_hatch: 'box', ramp: 'hull', ramp_log: 'hull', ramp_snow: 'hull',
  stunt_loop: 'mesh', quarterpipe: 'mesh', wave_ramp: 'mesh', bridge: 'mesh', dock: 'mesh', gate: 'mesh',
  ice_block: 'box', lift_station: 'box', lift_tower: 'trunk', arch: 'arch', tire_stack: 'trunk', cabin: 'box', shack: 'box',
  water_tower: 'box', windmill: 'trunk', snowman: 'trunk', igloo: 'hull',
  b_lantern: 'box', b_pole: 'box', b_bench: 'box', b_crate: 'box', b_brick: 'box',
}
/** rock_arch (The-Land island_chunks.py): pillars 3.2 × 10 × 3.4 m at x = ±6.5 — the opening stays drivable. */
const ARCH = { x: 6.5, hx: 1.6, hy: 5, hz: 1.7 }

/** batch: 0 = the map's clay props, 1 = Bruno's palette props, 2 = Dark's painted pieces (`piece`). */
interface Shape { geo: THREE.BufferGeometry; col?: THREE.BufferGeometry; half: THREE.Vector3; center: THREE.Vector3; points: Float32Array; batch: 0 | 1 | 2; piece?: Piece }
interface Tile { cx: number; cz: number; items: [string, number[]][]; body: RAPIER.RigidBody | null }
/** One batch per material: the mesh, and each instance's id + x, z (for the draw-distance test). */
interface Batch { mesh: THREE.BatchedMesh; ids: number[]; xz: number[] }

export class MapProps {
  readonly root = new THREE.Group()
  private readonly tiles: Tile[] = []
  private readonly batches: Batch[] = []
  private shapes = new Map<string, Shape>()
  private ready = false
  private frame = 0

  constructor(private readonly map: FixedMap, private readonly physics: PhysicsWorld, private readonly mats: MaterialLibrary) {
    this.root.name = 'map-props'
    void this.load()
  }

  private async load(): Promise<void> {
    const base = `/maps/${this.map.id}/`
    const draco = new DRACOLoader().setDecoderPath('/maps/_draco/')
    const loader = new GLTFLoader().setDRACOLoader(draco)
    const [props, bruno, palette] = await Promise.all([
      loader.loadAsync(base + 'props.glb'),
      Promise.all(Object.entries(BRUNO).map(([type, f]) => loader.loadAsync(`${base}bruno/${f}`).then((g) => [type, g] as const).catch(() => null))),
      new THREE.TextureLoader().loadAsync(`${base}bruno/palette.png`).catch(() => null),
    ])
    draco.dispose()
    const nodes = new Map<string, THREE.Mesh>()
    props.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) nodes.set(o.name, o as THREE.Mesh) })
    const shape = (geo: THREE.BufferGeometry, batch: 0 | 1 | 2, col?: THREE.BufferGeometry, piece?: Piece): Shape => {
      geo.computeBoundingBox()
      const b = geo.boundingBox!
      return { geo, col, batch, piece, half: b.getSize(new THREE.Vector3()).multiplyScalar(0.5), center: b.getCenter(new THREE.Vector3()), points: Float32Array.from(geo.getAttribute('position').array) }
    }
    const dark = darkPieces()
    for (const [name, m] of nodes) {
      if (NATURE.has(name) || name.endsWith('_col') || name.endsWith('_far') || DROPPED.has(name) || dark.has(name) || name === 'bridge') continue
      this.shapes.set(name, shape(m.geometry, 0, nodes.get(`${name}_col`)?.geometry))
    }
    for (const entry of bruno) if (entry && !dark.has(entry[0])) this.shapes.set(entry[0], shape(brunoGeometry(entry[1].scene), 1))
    for (const [name, piece] of dark) this.shapes.set(name, shape(piece.geo, 2, undefined, piece))
    // Materials: the map's clay-style props carry vertex colours; Bruno's map a palette texture. Both get Dark's look.
    const ours = stylize(new THREE.MeshLambertMaterial({ vertexColors: true }), { key: 'mapprop', rim: 0.3, toon: 0.4 })
    if (palette) {
      palette.colorSpace = THREE.SRGBColorSpace
      palette.magFilter = palette.minFilter = THREE.NearestFilter
    }
    const brunoMat = stylize(new THREE.MeshLambertMaterial({ map: palette }), { key: 'mapprop-bruno', rim: 0.3, toon: 0.4 })
    // Dark's pieces: the place props' look (painted surfaces by the atlas UV, rim, wet, snow cover) without the
    // vegetation's billboard / dither code (it would not batch) — one program.
    const darkMat = stylize(new THREE.MeshLambertMaterial({ vertexColors: true, map: this.mats.atlas, side: THREE.DoubleSide }), { key: 'mapprop-dark', rim: 1.1, noFlip: true, surface: 'atlas', wet: true, biomeCover: 'foliage' })
    this.build([ours, brunoMat, darkMat])
    this.bridges(this.mats.cliffRock) // (the procedural bridges' material: they are part of the formation mesh)
    this.poolWater(ours)
    this.ready = true
  }

  private build(mats: THREE.Material[]): void {
    const res = this.map.props
    const byTile = new Map<string, Tile>()
    const yOff = this.map.heightOffset
    let dropped = 0
    for (const types of Object.values(res.placements)) {
      for (const [type, arr] of Object.entries(types)) {
        if (!this.shapes.has(type) || !arr.length) continue
        for (let o = 0; o < arr.length; o += res.stride) {
          if (ROAD_BLOCKERS.has(type) && this.map.onRoad(arr[o], arr[o + 2], 1)) {
            dropped++
            continue
          }
          const ci = Math.floor(arr[o] / TILE), cj = Math.floor(arr[o + 2] / TILE)
          const key = `${ci},${cj}`
          let t = byTile.get(key)
          if (!t) byTile.set(key, (t = { cx: (ci + 0.5) * TILE, cz: (cj + 0.5) * TILE, items: [], body: null }))
          let it = t.items.find((i) => i[0] === type)
          if (!it) t.items.push((it = [type, []]))
          it[1].push(arr[o], arr[o + 1] + yOff, arr[o + 2], arr[o + 3], arr[o + 4])
        }
      }
    }
    for (const t of byTile.values()) this.tiles.push(t)
    if (dropped) console.info(`map props: ${dropped} solid pieces on road beds left out`)
    // Batches: every type of one material in one BatchedMesh (its geometries need the same attributes + indexing).
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
    for (const [bi, mat] of mats.entries()) {
      const bruno = bi === 1
      const types = [...this.shapes.keys()].filter((t) => this.shapes.get(t)!.batch === bi)
      const geos = new Map(types.map((t) => [t, bi === 2 ? this.shapes.get(t)!.geo : batchable(this.shapes.get(t)!.geo, bruno)] as const))
      let instances = 0, verts = 0, indices = 0
      for (const t of this.tiles) for (const [type, list] of t.items) if (geos.has(type)) instances += list.length / 5
      if (!instances) continue
      for (const g of geos.values()) (verts += g.getAttribute('position').count), (indices += g.index?.count ?? 0)
      const mesh = new THREE.BatchedMesh(instances, verts, indices, mat)
      const geoId = new Map([...geos].map(([t, g]) => [t, mesh.addGeometry(g)] as const))
      const b: Batch = { mesh, ids: [], xz: [] }
      for (const t of this.tiles) {
        for (const [type, list] of t.items) {
          const gid = geoId.get(type)
          if (gid === undefined) continue
          for (let k = 0; k < list.length; k += 5) {
            p.set(list[k], list[k + 1], list[k + 2])
            q.setFromAxisAngle(up, list[k + 3])
            s.setScalar(list[k + 4])
            const id = mesh.addInstance(gid)
            mesh.setMatrixAt(id, m.compose(p, q, s))
            mesh.setVisibleAt(id, false)
            b.ids.push(id)
            b.xz.push(list[k], list[k + 2])
          }
        }
      }
      mesh.perObjectFrustumCulled = true
      mesh.sortObjects = true // opaque front-to-back: the near props hide what's behind them (early depth reject)
      mesh.castShadow = mesh.receiveShadow = true
      mesh.name = ['map-props.set', 'map-props.bruno', 'map-props.dark'][bi]
      this.batches.push(b)
      this.root.add(mesh)
    }
  }

  /** Per frame: tile visibility (every 8th frame) and colliders near the player. */
  update(focus: THREE.Vector3): void {
    if (!this.ready || this.frame++ % 8) return
    const r2 = DRAW_DIST * DRAW_DIST
    for (const b of this.batches) {
      for (let k = 0; k < b.ids.length; k++) {
        const dx = b.xz[k * 2] - focus.x, dz = b.xz[k * 2 + 1] - focus.z
        b.mesh.setVisibleAt(b.ids[k], dx * dx + dz * dz < r2)
      }
    }
    for (const t of this.tiles) {
      const d = Math.hypot(t.cx - focus.x, t.cz - focus.z) - TILE * 0.71
      if (!t.body && d < PHYS_IN) t.body = this.colliders(t)
      else if (t.body && d > PHYS_OUT) {
        this.physics.world.removeRigidBody(t.body)
        t.body = null
      }
    }
  }

  private colliders(t: Tile): RAPIER.RigidBody {
    const R = this.physics.R, world = this.physics.world
    const body = world.createRigidBody(R.RigidBodyDesc.fixed())
    const v = new THREE.Vector3(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0)
    const add = (d: RAPIER.ColliderDesc, mesh = false) => world.createCollider(d.setCollisionGroups(mesh ? group(Groups.Static | Groups.StaticMesh, STATIC_MESH_FILTER) : group(Groups.Static, 0xffff)).setFriction(0.7), body)
    for (const [type, list] of t.items) {
      const kind = SOLID[type] ?? 'none'
      if (kind === 'none') continue
      const sh = this.shapes.get(type)!
      for (let o = 0; o < list.length; o += 5) {
        const x = list[o], y = list[o + 1], z = list[o + 2], s = list[o + 4]
        q.setFromAxisAngle(up, list[o + 3])
        const rot = { x: q.x, y: q.y, z: q.z, w: q.w }
        if (sh.piece) {
          const c = sh.piece.collider
          if (!c) continue
          if (c.length === 2) add(R.ColliderDesc.cylinder(c[1] * s, c[0] * s).setTranslation(x, y + c[1] * s, z))
          else add(R.ColliderDesc.cuboid(c[0] * s, c[1] * s, c[2] * s).setTranslation(x, y + c[1] * s, z).setRotation(rot))
        } else if (kind === 'trunk') add(R.ColliderDesc.cylinder(1.6 * s, 0.35 * s).setTranslation(x, y + 1.6 * s, z))
        else if (kind === 'box') {
          v.copy(sh.center).multiplyScalar(s).applyQuaternion(q)
          add(R.ColliderDesc.cuboid(sh.half.x * s, sh.half.y * s, sh.half.z * s).setTranslation(x + v.x, y + v.y, z + v.z).setRotation(rot))
        } else if (kind === 'arch') {
          for (const sx of [-1, 1]) {
            v.set(sx * ARCH.x * s, ARCH.hy * s, 0).applyQuaternion(q)
            add(R.ColliderDesc.cuboid(ARCH.hx * s, ARCH.hy * s, ARCH.hz * s).setTranslation(x + v.x, y + v.y, z + v.z).setRotation(rot))
          }
        } else if (kind === 'mesh' && sh.col) {
          const pos = sh.col.getAttribute('position').array as Float32Array
          const idx = sh.col.index ? Uint32Array.from(sh.col.index.array) : Uint32Array.from({ length: pos.length / 3 }, (_, k) => k)
          add(R.ColliderDesc.trimesh(pos.map((c) => c * s), idx).setTranslation(x, y, z).setRotation(rot), true)
        } else {
          const d = R.ColliderDesc.convexHull(sh.points.map((c) => c * s))
          if (d) add(d.setTranslation(x, y, z).setRotation(rot))
        }
      }
    }
    return body
  }

  /** Dark's plank bridges along the map roads' bridge samples, on the procedural bridges' material (cliff rock,
   *  vertex colours): a mesh each (frustum-culled) and a fixed trimesh
   *  collider each, always present (2 small bodies — a car may reach a bridge from any direction). */
  private bridges(mat: THREE.Material): void {
    const R = this.physics.R, world = this.physics.world
    for (const b of this.map.bridges) {
      const { geo, tris } = mapBridge(b.xs, b.zs, b.ys, b.hw)
      geo.setAttribute('aPlain', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count).fill(1), 1)) // planks: no rock surface
      geo.computeBoundingSphere()
      const mesh = new THREE.Mesh(geo, mat)
      mesh.castShadow = mesh.receiveShadow = true
      mesh.name = 'map-bridge'
      this.root.add(mesh)
      this.bridgeMeshes.push(mesh)
      const body = world.createRigidBody(R.RigidBodyDesc.fixed())
      const idx = Uint32Array.from({ length: tris.length / 3 }, (_, k) => k)
      world.createCollider(R.ColliderDesc.trimesh(tris, idx).setCollisionGroups(group(Groups.Static | Groups.StaticMesh, STATIC_MESH_FILTER)).setFriction(0.8), body)
      this.bridgeBodies.push(body)
    }
  }
  private readonly bridgeMeshes: THREE.Mesh[] = []

  /** The desert pools' water (FixedMap.pools): a 28-sided disc each at its surface, deep teal in the middle to pale
   *  turquoise at the edge — all in one mesh (≈ 30 pools × 28 tris, one draw), on the clay props' material. */
  private poolWater(mat: THREE.Material): void {
    const pools = this.map.pools
    if (!pools.length) return
    const N = 28, pos: number[] = [], col: number[] = [], nor: number[] = []
    const deep = new THREE.Color().setHex(0x2f8ea6, THREE.SRGBColorSpace), edge = new THREE.Color().setHex(0x8fd8d2, THREE.SRGBColorSpace)
    for (const p of pools) {
      for (let k = 0; k < N; k++) {
        const a0 = (k / N) * Math.PI * 2, a1 = ((k + 1) / N) * Math.PI * 2
        // (centre, a0, a1 with z = −sin: counter-clockwise seen from above → +y faces up)
        pos.push(p.x, p.y, p.z, p.x + Math.cos(a0) * p.r, p.y, p.z - Math.sin(a0) * p.r, p.x + Math.cos(a1) * p.r, p.y, p.z - Math.sin(a1) * p.r)
        col.push(deep.r, deep.g, deep.b, edge.r, edge.g, edge.b, edge.r, edge.g, edge.b)
        for (let v = 0; v < 3; v++) nor.push(0, 1, 0)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    g.computeBoundingSphere()
    const mesh = new THREE.Mesh(g, mat)
    mesh.receiveShadow = true
    mesh.name = 'map-pools'
    this.root.add(mesh)
    this.bridgeMeshes.push(mesh) // (disposed with them)
  }
  private readonly bridgeBodies: RAPIER.RigidBody[] = []

  dispose(): void {
    for (const m of this.bridgeMeshes) m.geometry.dispose()
    for (const b of this.bridgeBodies) this.physics.world.removeRigidBody(b)
    for (const b of this.batches) b.mesh.dispose()
    this.batches.length = 0
    for (const t of this.tiles) if (t.body) this.physics.world.removeRigidBody(t.body)
    this.tiles.length = 0
  }
}

/** A copy of a prop geometry in its batch's layout: Bruno's position / normal / uv, non-indexed; ours position /
 *  normal / float RGB colour, indexed (BatchedMesh needs one attribute set and one indexing per batch). */
function batchable(src: THREE.BufferGeometry, bruno: boolean): THREE.BufferGeometry {
  const keep = bruno ? ['position', 'normal', 'uv'] : ['position', 'normal', 'color']
  let g = new THREE.BufferGeometry()
  for (const a of keep) {
    const attr = src.getAttribute(a)
    if (!attr) throw new Error(`map prop geometry without ${a}`)
    const n = attr.count, size = a === 'uv' ? 2 : 3
    const out = new Float32Array(n * size)
    for (let k = 0; k < n; k++) {
      out[k * size] = attr.getX(k)
      out[k * size + 1] = attr.getY(k)
      if (size === 3) out[k * size + 2] = attr.getZ(k)
    }
    g.setAttribute(a, new THREE.BufferAttribute(out, size))
  }
  if (src.index) g.setIndex(src.index.clone())
  if (bruno && g.index) g = g.toNonIndexed()
  if (!bruno && !g.index) g.setIndex(Array.from({ length: g.getAttribute('position').count }, (_, k) => k))
  return g
}

/** Bruno's model file → one geometry: its first instance (all its meshes merged), base centred on the origin, ×1.5. */
function brunoGeometry(scene: THREE.Object3D): THREE.BufferGeometry {
  scene.updateMatrixWorld(true)
  let first: THREE.Object3D | null = null
  scene.traverse((o) => { if (!first && (o as THREE.Mesh).isMesh) first = o })
  let root = first as unknown as THREE.Object3D
  while (root.parent && root.parent !== scene) root = root.parent
  const inv = root.matrixWorld.clone().invert()
  const parts: THREE.BufferGeometry[] = []
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry.getAttribute('uv')) return // his collision cuboids have no UVs
    let g = mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld))
    g = g.index ? g.toNonIndexed() : g
    for (const a of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(a)) g.deleteAttribute(a)
    parts.push(g)
  })
  const g = mergeGeometries(parts)!
  g.computeBoundingBox()
  const b = g.boundingBox!
  return g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2).scale(BRUNO_SCALE, BRUNO_SCALE, BRUNO_SCALE)
}
