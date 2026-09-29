import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import humanUrl from './models/characters/human.lod0.glb?url'
import truckUrl from './models/vehicles/pickup_truck.lod0.glb?url'

/**
 * Loads the GLB models once at startup (parallel with Rapier init) and bakes them into plain geometry for the
 * game's own materials — no GLTF materials, scene graphs or PBR programs survive (skills/asset-optimization).
 *
 *   human   Sketchfab "Stickman" (CC-BY-4.0, ogulcantopsakal): one static T-pose mesh, no rig → rigged and
 *           animated procedurally by CharacterModel. Returned in its baked source frame (units, facing +Z).
 *   truck   Sketchfab "Pickup Truck" (CC-BY-4.0, 00amza): body + glass; the four wheels are baked into the body
 *           mesh, so they are SPLIT OUT here (connected components) to spin and steer. Returned normalised:
 *           metres, facing −Z, origin on the ground at the wheelbase centre.
 * Credits: ASSET_LIST.md § Credits.
 */
export interface TruckModel {
  body: THREE.BufferGeometry
  glass: THREE.BufferGeometry
  /** Front-left wheel, centred on its hub (right-side wheels use it turned 180°). */
  wheel: THREE.BufferGeometry
  /** Steering wheel (rim + spokes), centred on its hub; turns about `steeringAxis` (unit, pointing forward/down
   *  the column, away from the driver) at `steeringPivot`. */
  steeringWheel: THREE.BufferGeometry
  steeringPivot: [number, number, number]
  steeringAxis: [number, number, number]
  /** Hub centres FL, FR, RL, RR (m, truck space). */
  wheelPos: [number, number, number][]
  wheelRadius: number
  /** Body half extents (m) for the collider, and the body's y range. */
  half: { x: number; y: number; z: number }
  bottom: number
  map: THREE.Texture
}

export interface GameModels {
  human: THREE.BufferGeometry
  truck: TruckModel
}

/** Truck length after normalising (m): a mid-size pickup. */
const TRUCK_LENGTH = 5.1

/** @param onProgress 0..1 over both downloads (bytes). */
export async function loadModels(onProgress?: (f: number) => void): Promise<GameModels> {
  const loader = new GLTFLoader()
  const got = [0, 0], total = [87_492, 1_725_472] // fallbacks when the server sends no Content-Length
  const track = (i: number) => (e: ProgressEvent) => {
    got[i] = e.loaded
    if (e.lengthComputable) total[i] = e.total
    onProgress?.(Math.min(1, (got[0] + got[1]) / (total[0] + total[1])))
  }
  const [h, t] = await Promise.all([loader.loadAsync(humanUrl, track(0)), loader.loadAsync(truckUrl, track(1))])
  return { human: bakeFirstMesh(h.scene), truck: bakeTruck(t.scene) }
}

function bakedMeshes(scene: THREE.Object3D): { name: string; geo: THREE.BufferGeometry; mat: THREE.Material }[] {
  scene.updateMatrixWorld(true)
  const out: { name: string; geo: THREE.BufferGeometry; mat: THREE.Material }[] = []
  scene.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    const g = m.geometry.clone().applyMatrix4(m.matrixWorld)
    out.push({ name: m.name, geo: g, mat: m.material as THREE.Material })
  })
  return out
}

function bakeFirstMesh(scene: THREE.Object3D): THREE.BufferGeometry {
  const [first] = bakedMeshes(scene)
  first.geo.deleteAttribute('uv')
  return first.geo
}

/** Connected components (vertices welded by position) → per-triangle component id + component bounds. */
function components(g: THREE.BufferGeometry): { triComp: Int32Array; boxes: Map<number, { box: THREE.Box3; tris: number }> } {
  const pos = g.getAttribute('position')
  const idx = g.index
  const tri = idx ? idx.count / 3 : pos.count / 3
  const vi = (t: number, k: number) => (idx ? idx.getX(t * 3 + k) : t * 3 + k)
  const weld = new Map<string, number>()
  const rep = new Int32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`
    let r = weld.get(k)
    if (r === undefined) weld.set(k, (r = i))
    rep[i] = r
  }
  const parent = Int32Array.from({ length: pos.count }, (_, i) => i)
  const find = (a: number) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]]
    return a
  }
  for (let t = 0; t < tri; t++) {
    const a = find(rep[vi(t, 0)]), b = find(rep[vi(t, 1)]), c = find(rep[vi(t, 2)])
    parent[b] = a
    parent[find(c)] = a
  }
  const triComp = new Int32Array(tri)
  const boxes = new Map<number, { box: THREE.Box3; tris: number }>()
  const v = new THREE.Vector3()
  for (let t = 0; t < tri; t++) {
    const c = find(rep[vi(t, 0)])
    triComp[t] = c
    let e = boxes.get(c)
    if (!e) boxes.set(c, (e = { box: new THREE.Box3(), tris: 0 }))
    e.tris++
    for (let k = 0; k < 3; k++) e.box.expandByPoint(v.fromBufferAttribute(pos, vi(t, k)))
  }
  return { triComp, boxes }
}

/** New geometry with only the triangles `keep(t)` (non-indexed, attributes copied). */
function subset(g: THREE.BufferGeometry, keep: (t: number) => boolean): THREE.BufferGeometry {
  const src = g.index ? g.toNonIndexed() : g
  const tri = src.getAttribute('position').count / 3
  const out = new THREE.BufferGeometry()
  for (const name of Object.keys(src.attributes)) {
    const a = src.getAttribute(name) as THREE.BufferAttribute
    const n = a.itemSize
    const arr: number[] = []
    for (let t = 0; t < tri; t++) {
      if (!keep(t)) continue
      for (let k = 0; k < 3; k++) for (let c = 0; c < n; c++) arr.push(a.array[(t * 3 + k) * n + c])
    }
    out.setAttribute(name, new THREE.Float32BufferAttribute(arr, n))
  }
  if (src !== g) src.dispose()
  return out
}

function bakeTruck(scene: THREE.Object3D): TruckModel {
  const meshes = bakedMeshes(scene)
  const bodyM = meshes.find((m) => /vehicle/i.test(m.name)) ?? meshes[0]
  const glassM = meshes.find((m) => m !== bodyM)
  const { triComp, boxes } = components(bodyM.geo)
  // Wheels: tyre+rim components touching the ground, round in side view (height ≈ length), thin across.
  const size = new THREE.Vector3()
  const wheels = [...boxes.entries()]
    .filter(([, e]) => {
      e.box.getSize(size)
      return e.box.min.y < 0.15 && size.y > 0.5 && Math.abs(size.y - size.z) < 0.25 * size.y && size.x < 0.6 * size.y
    })
    .map(([id, e]) => ({ id, c: e.box.getCenter(new THREE.Vector3()), r: e.box.getSize(new THREE.Vector3()).y / 2 }))
  if (wheels.length !== 4) throw new Error(`pickup truck: expected 4 wheel parts, found ${wheels.length}`)
  const cx = wheels.reduce((s, w) => s + w.c.x, 0) / 4
  const cz = wheels.reduce((s, w) => s + w.c.z, 0) / 4
  const whole = new THREE.Box3().setFromBufferAttribute(bodyM.geo.getAttribute('position') as THREE.BufferAttribute)
  const k = TRUCK_LENGTH / whole.getSize(size).z
  // Normalise: wheelbase centre at the origin, wheel bottoms on y = 0, metres, turned 180° so the front
  // (grille + bull bar, +Z in the source) faces −Z like every vehicle/camera in the game.
  const norm = new THREE.Matrix4().makeRotationY(Math.PI)
    .multiply(new THREE.Matrix4().makeScale(k, k, k))
    .multiply(new THREE.Matrix4().makeTranslation(-cx, 0, -cz))
  const isWheel = new Set(wheels.map((w) => w.id))
  // Steering wheel: the ring (+ its spoke/hub part) in front of the LEFT seat — ~0.35–0.6 m wide, thin, at
  // dashboard height, a little behind the windscreen base. Found in normalised space.
  const steer = new Set<number>()
  const nb = new THREE.Box3()
  for (const [id, e] of boxes) {
    nb.copy(e.box).applyMatrix4(norm)
    const c = nb.getCenter(new THREE.Vector3()), sz = nb.getSize(new THREE.Vector3())
    if (c.x < -0.15 && c.z > -0.8 && c.z < -0.4 && c.y > 0.8 && c.y < 1.3 && sz.x > 0.3 && sz.x < 0.65 && sz.z < 0.25) steer.add(id)
  }
  if (steer.size === 0) throw new Error('pickup truck: steering wheel not found')
  const steeringWheel = subset(bodyM.geo, (t) => steer.has(triComp[t])).applyMatrix4(norm)
  const body = subset(bodyM.geo, (t) => !isWheel.has(triComp[t]) && !steer.has(triComp[t])).applyMatrix4(norm)
  // Pivot = rim centre; axis = rim-plane normal from its extreme points (left↔right × bottom↔top), pointing forward.
  const sp = steeringWheel.getAttribute('position')
  let lx = 0, rx = 0, by = 0, ty = 0
  for (let i = 1; i < sp.count; i++) {
    if (sp.getX(i) < sp.getX(lx)) lx = i
    if (sp.getX(i) > sp.getX(rx)) rx = i
    if (sp.getY(i) < sp.getY(by)) by = i
    if (sp.getY(i) > sp.getY(ty)) ty = i
  }
  const P = (i: number) => new THREE.Vector3().fromBufferAttribute(sp, i)
  steeringWheel.computeBoundingBox()
  const pivot = steeringWheel.boundingBox!.getCenter(new THREE.Vector3())
  const axis = new THREE.Vector3().crossVectors(P(rx).sub(P(lx)), P(ty).sub(P(by))).normalize()
  if (axis.z > 0) axis.negate() // forward = −Z
  steeringWheel.translate(-pivot.x, -pivot.y, -pivot.z)
  for (const w of wheels) w.c.applyMatrix4(norm)
  const fl = wheels.reduce((a, b) => (b.c.x + b.c.z < a.c.x + a.c.z ? b : a)) // most −x (left) and −z (front)
  const wheel = subset(bodyM.geo, (t) => triComp[t] === fl.id).applyMatrix4(norm)
  const hub = fl.c.clone()
  wheel.translate(-hub.x, -hub.y, -hub.z)
  const wp = wheels.map((w) => w.c.clone())
  const pick = (sx: number, sz: number) => wp.reduce((a, b) => (b.x * sx + b.z * sz > a.x * sx + a.z * sz ? b : a))
  const wheelPos = [pick(-1, -1), pick(1, -1), pick(-1, 1), pick(1, 1)].map((p) => [p.x, p.y, p.z] as [number, number, number])
  // Glass: plain dark tint through the shared vertex-colour material (no extra program).
  const glass = (glassM ? glassM.geo : new THREE.BufferGeometry()).applyMatrix4(norm)
  glass.deleteAttribute('uv')
  const gc = new THREE.Color().setHex(0x1b2430, THREE.SRGBColorSpace)
  const gn = glass.getAttribute('position')?.count ?? 0
  const gcol = new Float32Array(gn * 3)
  for (let i = 0; i < gn; i++) gc.toArray(gcol, i * 3)
  glass.setAttribute('color', new THREE.BufferAttribute(gcol, 3))
  for (const g of [body, wheel, glass, steeringWheel]) (g.computeBoundingBox(), g.computeBoundingSphere())
  const bb = body.boundingBox!
  const map = ((bodyM.mat as THREE.MeshStandardMaterial).map ?? new THREE.Texture()) as THREE.Texture
  map.colorSpace = THREE.SRGBColorSpace
  meshes.forEach((m) => m.geo.dispose())
  return {
    body, glass, wheel, wheelPos,
    steeringWheel, steeringPivot: pivot.toArray() as [number, number, number], steeringAxis: axis.toArray() as [number, number, number],
    wheelRadius: fl.r * k,
    half: { x: (bb.max.x - bb.min.x) / 2, y: (bb.max.y - bb.min.y) / 2, z: (bb.max.z - bb.min.z) / 2 },
    bottom: bb.min.y,
    map,
  }
}

/** Downscaled copy of a texture (LOW tier: 1024² → 512² saves ~4 MB of GPU memory). */
export function downscaleTexture(tex: THREE.Texture, size: number): THREE.Texture {
  const img = tex.image as (CanvasImageSource & { width: number }) | undefined
  if (!img || !img.width || img.width <= size) return tex
  const c = document.createElement('canvas')
  c.width = c.height = size
  c.getContext('2d')!.drawImage(img, 0, 0, size, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.flipY = tex.flipY
  t.anisotropy = 4
  return t
}
