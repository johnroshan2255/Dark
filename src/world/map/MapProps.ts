import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type RAPIER from '@dimforge/rapier3d-compat'
import { group, Groups, type PhysicsWorld } from '../../physics/PhysicsWorld'
import { stylize } from '../../rendering/shaders/stylize'
import type { FixedMap } from './FixedMap'

/**
 * A fixed map's SET PIECES (its props.json placements that are not nature): camps, the stunt park, race-track gates,
 * cabins, the ranch, ramps, bridges, the dock, the ski lift, and Bruno Simon's lanterns / pole lights / benches /
 * crates / bricks (MIT, maps/<id>/bruno). Nature (trees, rocks, bushes, grass, cacti) is NOT drawn from the map: the
 * chunk scatter grows Dark's own where the map's trees were (FixedMap.forestDensity).
 *
 * Drawing: one InstancedMesh per prop type per 200 m TILE (frustum-culled by its bounds), hidden past DRAW_DIST.
 * Physics: a fixed body per tile while the player is within PHYS_IN of it (released past PHYS_OUT) — boxes for
 * buildings / gear, cylinders for posts, hulls for ramps, the exact `<type>_col` trimesh for the loop, quarter-pipes,
 * wave ramp, bridges and dock (members of StaticMesh too, so the car's exact body meets them, like rock formations).
 */
const NATURE = new Set(['pine', 'pine_snow', 'rock', 'rock_snow', 'rock_red', 'bush', 'grass_tuft', 'cactus', 'log', 'stump', 'boulder', 'dead_tree', 'oak', 'birch', 'cherry'])
const TILE = 200
const DRAW_DIST = 420
const PHYS_IN = 140
const PHYS_OUT = 220
/** Bruno's models are made for a ~2.7 m car; the map is scaled for a 4.5 m jeep (as in The-Land). */
const BRUNO_SCALE = 1.5
const BRUNO: Record<string, string> = {
  b_lantern: 'lanterns.glb', b_pole: 'poleLights.glb', b_bench: 'benches.glb', b_crate: 'explosiveCrates.glb', b_brick: 'bricks.glb',
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

interface Shape { geo: THREE.BufferGeometry; col?: THREE.BufferGeometry; half: THREE.Vector3; center: THREE.Vector3; points: Float32Array }
interface Tile { cx: number; cz: number; meshes: THREE.InstancedMesh[]; items: [string, number[]][]; body: RAPIER.RigidBody | null }

export class MapProps {
  readonly root = new THREE.Group()
  private readonly tiles: Tile[] = []
  private shapes = new Map<string, Shape>()
  private ready = false
  private frame = 0

  constructor(private readonly map: FixedMap, private readonly physics: PhysicsWorld) {
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
    const shape = (geo: THREE.BufferGeometry, col?: THREE.BufferGeometry): Shape => {
      geo.computeBoundingBox()
      const b = geo.boundingBox!
      return { geo, col, half: b.getSize(new THREE.Vector3()).multiplyScalar(0.5), center: b.getCenter(new THREE.Vector3()), points: Float32Array.from(geo.getAttribute('position').array) }
    }
    for (const [name, m] of nodes) if (!NATURE.has(name) && !name.endsWith('_col') && !name.endsWith('_far')) this.shapes.set(name, shape(m.geometry, nodes.get(`${name}_col`)?.geometry))
    for (const entry of bruno) if (entry) this.shapes.set(entry[0], shape(brunoGeometry(entry[1].scene)))
    // Materials: the map's clay-style props carry vertex colours; Bruno's map a palette texture. Both get Dark's look.
    const ours = stylize(new THREE.MeshLambertMaterial({ vertexColors: true }), { key: 'mapprop', rim: 0.3, toon: 0.4 })
    if (palette) {
      palette.colorSpace = THREE.SRGBColorSpace
      palette.magFilter = palette.minFilter = THREE.NearestFilter
    }
    const brunoMat = stylize(new THREE.MeshLambertMaterial({ map: palette }), { key: 'mapprop-bruno', rim: 0.3, toon: 0.4 })
    this.build(ours, brunoMat)
    this.ready = true
  }

  private build(ours: THREE.Material, brunoMat: THREE.Material): void {
    const res = this.map.props
    const byTile = new Map<string, Tile>()
    const yOff = this.map.heightOffset
    for (const types of Object.values(res.placements)) {
      for (const [type, arr] of Object.entries(types)) {
        if (!this.shapes.has(type) || !arr.length) continue
        for (let o = 0; o < arr.length; o += res.stride) {
          const ci = Math.floor(arr[o] / TILE), cj = Math.floor(arr[o + 2] / TILE)
          const key = `${ci},${cj}`
          let t = byTile.get(key)
          if (!t) byTile.set(key, (t = { cx: (ci + 0.5) * TILE, cz: (cj + 0.5) * TILE, meshes: [], items: [], body: null }))
          let it = t.items.find((i) => i[0] === type)
          if (!it) t.items.push((it = [type, []]))
          it[1].push(arr[o], arr[o + 1] + yOff, arr[o + 2], arr[o + 3], arr[o + 4])
        }
      }
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
    for (const t of byTile.values()) {
      for (const [type, list] of t.items) {
        const sh = this.shapes.get(type)!
        const n = list.length / 5
        const mesh = new THREE.InstancedMesh(sh.geo, type.startsWith('b_') ? brunoMat : ours, n)
        for (let k = 0; k < n; k++) {
          p.set(list[k * 5], list[k * 5 + 1], list[k * 5 + 2])
          q.setFromAxisAngle(up, list[k * 5 + 3])
          s.setScalar(list[k * 5 + 4])
          mesh.setMatrixAt(k, m.compose(p, q, s))
        }
        mesh.instanceMatrix.needsUpdate = true
        mesh.computeBoundingSphere()
        mesh.castShadow = mesh.receiveShadow = true
        mesh.visible = false
        t.meshes.push(mesh)
        this.root.add(mesh)
      }
      this.tiles.push(t)
    }
  }

  /** Per frame: tile visibility (every 8th frame) and colliders near the player. */
  update(focus: THREE.Vector3): void {
    if (!this.ready || this.frame++ % 8) return
    for (const t of this.tiles) {
      const d = Math.hypot(t.cx - focus.x, t.cz - focus.z) - TILE * 0.71
      const show = d < DRAW_DIST
      for (const mesh of t.meshes) mesh.visible = show
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
    const add = (d: RAPIER.ColliderDesc, mesh = false) => world.createCollider(d.setCollisionGroups(group(mesh ? Groups.Static | Groups.StaticMesh : Groups.Static, 0xffff)).setFriction(0.7), body)
    for (const [type, list] of t.items) {
      const kind = SOLID[type] ?? 'none'
      if (kind === 'none') continue
      const sh = this.shapes.get(type)!
      for (let o = 0; o < list.length; o += 5) {
        const x = list[o], y = list[o + 1], z = list[o + 2], s = list[o + 4]
        q.setFromAxisAngle(up, list[o + 3])
        const rot = { x: q.x, y: q.y, z: q.z, w: q.w }
        if (kind === 'trunk') add(R.ColliderDesc.cylinder(1.6 * s, 0.35 * s).setTranslation(x, y + 1.6 * s, z))
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

  dispose(): void {
    for (const t of this.tiles) {
      for (const mesh of t.meshes) mesh.dispose()
      if (t.body) this.physics.world.removeRigidBody(t.body)
    }
    this.tiles.length = 0
  }
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
