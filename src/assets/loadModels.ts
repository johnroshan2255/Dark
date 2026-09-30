import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import humanUrl from './models/characters/human.lod0.glb?url'
import { vehicleDef, type VehicleDef } from '../gameplay/vehicle/catalogue'

/**
 * Loads the GLB models once at startup (parallel with Rapier init) and bakes them into plain geometry for the
 * game's own materials — no GLTF materials, scene graphs or PBR programs survive (skills/asset-optimization).
 *
 *   human   Sketchfab "Stickman" (CC-BY-4.0, ogulcantopsakal): one static T-pose mesh, no rig → rigged and
 *           animated procedurally by CharacterModel. Returned in its baked source frame (units, facing +Z).
 *   vehicles the garage catalogue (gameplay/vehicle/catalogue.ts): pickup (Sketchfab, 00amza), Mercedes G500 4×4²,
 *           Żuk A06 — each baked by `bakeVehicle` (materials → vertex colours, paint mask, wheels split out or
 *           found by name, glass split off) and normalised: metres, facing −Z, origin on the ground at the
 *           wheelbase centre. Loaded on demand and cached (`loadVehicle`).
 * Credits: ASSET_LIST.md § Credits.
 */
export interface TruckModel {
  /** Catalogue id. */
  id: string
  /** Body: position / normal / uv / color (material colour baked) / paintMask (1 = takes the paint colour). */
  body: THREE.BufferGeometry
  glass: THREE.BufferGeometry
  /** Front-left wheel, centred on its hub (right-side wheels use it turned 180°). */
  wheel: THREE.BufferGeometry
  /** Steering wheel (rim + spokes), centred on its hub; turns about `steeringAxis` (unit, pointing forward/down
   *  the column, away from the driver) at `steeringPivot`. null = the model has none we can find. */
  steeringWheel: THREE.BufferGeometry | null
  steeringPivot: [number, number, number]
  steeringAxis: [number, number, number]
  /** Hub centres FL, FR, RL, RR (m, truck space). */
  wheelPos: [number, number, number][]
  wheelRadius: number
  /** Body half extents (m) for the collider, and the body's y range. */
  half: { x: number; y: number; z: number }
  bottom: number
  /** Body z extent (m): the nose (−Z) and the tail (+Z) — the body is not symmetric about the wheelbase. */
  front: number
  rear: number
  /** Body texture, or null for flat-coloured models (colour is in the vertices). */
  map: THREE.Texture | null
}
export type VehicleModel = TruckModel

export interface GameModels {
  human: THREE.BufferGeometry
  truck: TruckModel
}

const vehicleCache = new Map<string, Promise<VehicleModel>>()

/** Load (once) and bake a catalogue vehicle. */
export function loadVehicle(id: string, onProgress?: (f: number) => void): Promise<VehicleModel> {
  const def = vehicleDef(id)
  let p = vehicleCache.get(def.id)
  if (!p) {
    let total = def.bytes
    p = new GLTFLoader()
      .loadAsync(def.url, (e) => {
        if (e.lengthComputable) total = e.total
        onProgress?.(Math.min(1, e.loaded / total))
      })
      .then((g) => bakeVehicle(g.scene, def))
    vehicleCache.set(def.id, p)
  } else onProgress?.(1)
  return p
}

/** @param onProgress 0..1 over both downloads (bytes). */
export async function loadModels(onProgress?: (f: number) => void, vehicleId = 'pickup'): Promise<GameModels> {
  const loader = new GLTFLoader()
  const got = [0, 0]
  const report = () => onProgress?.(Math.min(1, (got[0] + got[1]) / 2))
  const [h, t] = await Promise.all([
    loader.loadAsync(humanUrl, (e) => ((got[0] = e.lengthComputable ? e.loaded / e.total : 0.5), report())),
    loadVehicle(vehicleId, (f) => ((got[1] = f), report())),
  ])
  return { human: bakeFirstMesh(h.scene), truck: t }
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

/** Linear material colour + texture (if any) of a baked mesh. */
function matColor(mat: THREE.Material): { color: THREE.Color; map: THREE.Texture | null; glass: boolean } {
  const m = mat as THREE.MeshStandardMaterial
  const color = (m.color ?? new THREE.Color(1, 1, 1)).clone()
  const map = (m.map as THREE.Texture | undefined) ?? null
  const glass = m.transparent || /wind|glas/i.test(mat.name)
  return { color, map, glass }
}

/** Geometry with only position/normal/uv/color/paintMask (so bodies merge), colour baked, uv kept only with a map. */
function paintGeometry(g: THREE.BufferGeometry, color: THREE.Color, keepUv: boolean, paint: number): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g.clone()
  for (const name of Object.keys(out.attributes)) if (!['position', 'normal', 'uv'].includes(name)) out.deleteAttribute(name)
  const n = out.getAttribute('position').count
  if (!out.getAttribute('normal')) out.computeVertexNormals()
  if (!keepUv) out.deleteAttribute('uv')
  if (!out.getAttribute('uv')) out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2))
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) color.toArray(col, i * 3)
  out.setAttribute('color', new THREE.BufferAttribute(col, 3))
  out.setAttribute('paintMask', new THREE.BufferAttribute(new Float32Array(n).fill(paint), 1))
  return out
}

/**
 * Bake ANY catalogue vehicle: every mesh gets its material colour in the vertices (flat-coloured models need no
 * texture at all), paint panels are masked, the glass is split off, the four wheels are found by name
 * (`def.wheelRegex`) or split out of the body by shape (parts touching the ground, round in side view), and the
 * whole thing is normalised: metres (`def.length`), facing −Z, origin on the ground at the wheelbase centre.
 */
function bakeVehicle(scene: THREE.Object3D, def: VehicleDef): VehicleModel {
  const meshes = bakedMeshes(scene)
  const bodies: THREE.BufferGeometry[] = [], glasses: THREE.BufferGeometry[] = []
  const wheelParts: { geo: THREE.BufferGeometry; name: string }[] = []
  let map: THREE.Texture | null = null
  for (const m of meshes) {
    const { color, map: mm, glass } = matColor(m.mat)
    if (glass) {
      glasses.push(paintGeometry(m.geo, new THREE.Color().setHex(0x1b2430, THREE.SRGBColorSpace), false, 0))
      continue
    }
    if (mm && !map) map = mm
    const textured = !!mm
    const paint = def.paintRegex ? (def.paintRegex.test(m.mat.name) ? 1 : 0) : 1
    const g = paintGeometry(m.geo, textured ? new THREE.Color(1, 1, 1) : color, textured, paint)
    if (def.wheelRegex && def.wheelRegex.test(m.name)) wheelParts.push({ geo: g, name: m.name })
    else bodies.push(g)
  }
  let body = mergeGeometries(bodies, false)!
  const glass = glasses.length ? mergeGeometries(glasses, false)! : new THREE.BufferGeometry()
  // Normalise: forward axis → −Z, metres, wheel bottoms on y = 0, origin at the wheelbase centre.
  const size = new THREE.Vector3()
  const all = mergeGeometries([body, ...wheelParts.map((w) => w.geo)], false)!
  const whole = new THREE.Box3().setFromBufferAttribute(all.getAttribute('position') as THREE.BufferAttribute)
  whole.getSize(size)
  const fwdLen = def.forward.endsWith('z') ? size.z : size.x
  const k = def.length / fwdLen
  const rot = def.forward === '+z' ? Math.PI : def.forward === '-z' ? 0 : def.forward === '+x' ? -Math.PI / 2 : Math.PI / 2
  const norm = new THREE.Matrix4().makeRotationY(rot).multiply(new THREE.Matrix4().makeScale(k, k, k))
  // Wheels by name (centres from their bounds) or by shape (connected components of the body).
  let wheels: { c: THREE.Vector3; r: number; geo: THREE.BufferGeometry }[]
  if (wheelParts.length) {
    const byCorner = new Map<string, THREE.BufferGeometry[]>()
    for (const w of wheelParts) {
      const key = (w.name.match(def.wheelRegex!)?.[1] ?? '').toUpperCase()
      byCorner.set(key, [...(byCorner.get(key) ?? []), w.geo])
    }
    wheels = [...byCorner.values()].map((parts) => {
      const geo = mergeGeometries(parts, false)!
      const bb = new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position') as THREE.BufferAttribute)
      return { c: bb.getCenter(new THREE.Vector3()), r: bb.getSize(new THREE.Vector3()).y / 2, geo }
    })
  } else {
    const { triComp, boxes } = components(body)
    const found = [...boxes.entries()]
      .filter(([, e]) => {
        e.box.getSize(size)
        const along = def.forward.endsWith('z') ? size.z : size.x
        const across = def.forward.endsWith('z') ? size.x : size.z
        return e.box.min.y < whole.min.y + 0.15 * (whole.max.y - whole.min.y) && size.y > 0.12 * (whole.max.y - whole.min.y) && Math.abs(size.y - along) < 0.25 * size.y && across < 0.6 * size.y
      })
      .map(([id, e]) => ({ id, c: e.box.getCenter(new THREE.Vector3()), r: e.box.getSize(new THREE.Vector3()).y / 2 }))
    if (found.length !== 4) throw new Error(`${def.id}: expected 4 wheel parts, found ${found.length}`)
    const isWheel = new Set(found.map((w) => w.id))
    wheels = found.map((w) => ({ c: w.c, r: w.r, geo: subset(body, (t) => triComp[t] === w.id) }))
    body = subset(body, (t) => !isWheel.has(triComp[t]))
  }
  // Steering wheel (pickup): the ring in front of the left seat, found in normalised space.
  let steeringWheel: THREE.BufferGeometry | null = null
  let pivot = new THREE.Vector3(), axis = new THREE.Vector3(0, 0, -1)
  if (def.steering) {
    const { triComp, boxes } = components(body)
    const steer = new Set<number>()
    const nb = new THREE.Box3()
    for (const [id, e] of boxes) {
      nb.copy(e.box).applyMatrix4(norm)
      const c = nb.getCenter(new THREE.Vector3()), sz = nb.getSize(new THREE.Vector3())
      if (c.x < -0.15 && c.z > -0.8 && c.z < -0.4 && c.y > 0.8 && c.y < 1.3 && sz.x > 0.3 && sz.x < 0.65 && sz.z < 0.25) steer.add(id)
    }
    if (steer.size) {
      steeringWheel = subset(body, (t) => steer.has(triComp[t])).applyMatrix4(norm)
      body = subset(body, (t) => !steer.has(triComp[t]))
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
      pivot = steeringWheel.boundingBox!.getCenter(new THREE.Vector3())
      axis = new THREE.Vector3().crossVectors(P(rx).sub(P(lx)), P(ty).sub(P(by))).normalize()
      if (axis.z > 0) axis.negate()
      steeringWheel.translate(-pivot.x, -pivot.y, -pivot.z)
    }
  }
  body.applyMatrix4(norm)
  glass.applyMatrix4(norm)
  for (const w of wheels) (w.c.applyMatrix4(norm), (w.r *= k), w.geo.applyMatrix4(norm))
  // Ground = wheel bottoms; origin = wheelbase centre.
  const groundY = Math.min(...wheels.map((w) => w.c.y - w.r))
  const cx = wheels.reduce((a, w) => a + w.c.x, 0) / 4, cz = wheels.reduce((a, w) => a + w.c.z, 0) / 4
  const shift = new THREE.Matrix4().makeTranslation(-cx, -groundY, -cz)
  body.applyMatrix4(shift)
  glass.applyMatrix4(shift)
  for (const w of wheels) (w.c.applyMatrix4(shift), w.geo.applyMatrix4(shift))
  if (steeringWheel) pivot.applyMatrix4(shift)
  const fl = wheels.reduce((a, b) => (b.c.x + b.c.z < a.c.x + a.c.z ? b : a)) // most −x (left) and −z (front)
  const wheel = fl.geo.clone().translate(-fl.c.x, -fl.c.y, -fl.c.z)
  const pick = (sx: number, sz: number) => wheels.reduce((a, b) => (b.c.x * sx + b.c.z * sz > a.c.x * sx + a.c.z * sz ? b : a))
  const wheelPos = [pick(-1, -1), pick(1, -1), pick(-1, 1), pick(1, 1)].map((w) => [w.c.x, w.c.y, w.c.z] as [number, number, number])
  for (const g of [body, wheel, glass, steeringWheel]) if (g) (g.computeBoundingBox(), g.computeBoundingSphere())
  const bb = body.boundingBox!
  if (map) map.colorSpace = THREE.SRGBColorSpace
  meshes.forEach((m) => m.geo.dispose())
  all.dispose()
  return {
    id: def.id,
    body, glass, wheel, wheelPos,
    steeringWheel, steeringPivot: pivot.toArray() as [number, number, number], steeringAxis: axis.toArray() as [number, number, number],
    wheelRadius: fl.r,
    half: { x: (bb.max.x - bb.min.x) / 2, y: (bb.max.y - bb.min.y) / 2, z: (bb.max.z - bb.min.z) / 2 },
    bottom: bb.min.y,
    front: bb.min.z,
    rear: bb.max.z,
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
